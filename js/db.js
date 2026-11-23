// Facade: the only file that talks to Supabase. The UI never sees table or bucket details.
import { sb } from './supabase.js';
import { TYPES } from './models.js';
import { BUCKET } from './config.js';
import { bus } from './events.js';

const ok = async q => {
  const { data, error } = await q;
  if (error) throw error;
  return data;
};

// Shrink photos before upload (keeps the free storage quota going a long way).
async function compress(file) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.72)) || file;
  } catch { return file; }
}

const toB64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = () => rej(new Error('Could not read the file'));
  r.readAsDataURL(blob);
});

async function callGemini(body) {
  const { data, error } = await sb.functions.invoke('gemini', { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data.result;
}

// Gemini, via the `gemini` Supabase Edge Function (the API key stays on the server).
export const ai = {
  async extract(kind, file) {
    const blob = await compress(file);
    const data = await toB64(blob);
    if (data.length > 7_000_000) throw new Error('File too large (keep it under about 5 MB)');
    return callGemini({ mode: 'extract', kind, mime_type: blob.type || file.type, image_base64: data });
  },
  explain: (facts, car) => callGemini({ mode: 'explain', facts, car }),
};

export const db = {
  // ---- auth ----
  session: async () => (await sb.auth.getSession()).data.session,
  signIn: (email, password) => ok(sb.auth.signInWithPassword({ email, password })),
  signOut: () => sb.auth.signOut(),
  onAuth: fn => sb.auth.onAuthStateChange((evt, s) => fn(evt, s)),

  // ---- vehicle ----
  async vehicle() {
    const rows = await ok(sb.from('vehicles').select('*').order('created_at').limit(1));
    return rows[0] ?? null;
  },
  async createVehicle(v) {
    const [row] = await ok(sb.from('vehicles').insert(v).select());
    await ok(sb.rpc('seed_default_rules', { p_vehicle: row.id }));
    return row;
  },

  // ---- generic log CRUD (fuel, maintenance, expense, incident, document) ----
  list: (type, vehicleId, limit = 500) => {
    const t = TYPES[type];
    return ok(sb.from(t.table).select(t.items ? '*, maintenance_items(*)' : '*').eq('vehicle_id', vehicleId)
      .order(t.dateField, { ascending: false }).order('created_at', { ascending: false }).limit(limit));
  },
  // Create or edit. Service visits go through one RPC so header + items save atomically.
  async save(type, { id = null, payload, items = [], files = [] }) {
    const t = TYPES[type];
    let row;
    if (type === 'maintenance') {
      const newId = await ok(sb.rpc('save_service_visit', {
        p_id: id, p_vehicle: payload.vehicle_id, p_logged_on: payload.logged_on,
        p_odometer_km: payload.odometer_km, p_vendor: payload.vendor ?? null,
        p_notes: payload.notes ?? null, p_items: items,
      }));
      row = { id: newId, vehicle_id: payload.vehicle_id };
    } else if (id) {
      [row] = await ok(sb.from(t.table).update(payload).eq('id', id).select());
    } else {
      [row] = await ok(sb.from(t.table).insert(payload).select());
    }
    if (!row) throw new Error('Entry not found');
    let uploadError = null;
    if (files.length) {
      try { await db.attach(type, row, files); } catch (e) { uploadError = e; }
    }
    bus.emit('data:changed', { type });
    return { row, uploadError };
  },
  async remove(type, row) {
    const table = TYPES[type].table;
    const atts = await ok(sb.from('attachments').select('id,storage_path').eq('parent_table', table).eq('parent_id', row.id));
    if (atts.length) {
      await ok(sb.storage.from(BUCKET).remove(atts.map(a => a.storage_path)));
      await ok(sb.from('attachments').delete().in('id', atts.map(a => a.id)));
    }
    await ok(sb.from(table).delete().eq('id', row.id));
    bus.emit('data:changed', { type });
  },

  // ---- invoice files ----
  async attach(type, row, files) {
    const uid = (await db.session()).user.id;
    const table = TYPES[type].table;
    for (const [i, f] of [...files].entries()) {
      const blob = await compress(f);
      const ext = blob.type === 'image/jpeg' ? 'jpg' : (f.name.split('.').pop() || 'bin');
      const path = `${uid}/${table}/${row.id}/${Date.now()}-${i}.${ext}`;
      await ok(sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type }));
      await ok(sb.from('attachments').insert({
        vehicle_id: row.vehicle_id, parent_table: table, parent_id: row.id,
        storage_path: path, mime_type: blob.type,
      }));
    }
  },
  async attachmentMap(vehicleId, type) {
    const rows = await ok(sb.from('attachments').select('parent_id,storage_path')
      .eq('vehicle_id', vehicleId).eq('parent_table', TYPES[type].table));
    const m = {};
    rows.forEach(r => (m[r.parent_id] ??= []).push(r.storage_path));
    return m;
  },
  signedUrls: paths => ok(sb.storage.from(BUCKET).createSignedUrls(paths, 3600)),
  async removeFile(path) {
    await ok(sb.storage.from(BUCKET).remove([path]));
    await ok(sb.from('attachments').delete().eq('storage_path', path));
    bus.emit('data:changed', {});
  },

  // ---- views ----
  async odometer(vid) {
    const r = await ok(sb.from('vehicle_odometer').select('odometer_km').eq('vehicle_id', vid));
    return r[0]?.odometer_km ?? 0;
  },
  async firstOdometer(vid) {
    const r = await ok(sb.from('fuel_logs').select('odometer_km').eq('vehicle_id', vid).order('odometer_km').limit(1));
    return r[0]?.odometer_km ?? null;
  },
  fuelEconomy: vid => ok(sb.from('fuel_economy').select('*').eq('vehicle_id', vid).order('end_date', { ascending: false })),
  reminders: vid => ok(sb.from('reminder_status').select('*').eq('vehicle_id', vid)),
  monthly: vid => ok(sb.from('monthly_costs').select('*').eq('vehicle_id', vid).order('month', { ascending: false }).limit(1000)),

  // ---- advice feedback ("Done" / "Not relevant") ----
  feedback: vid => ok(sb.from('advice_feedback').select('*').eq('vehicle_id', vid)),
  setFeedback: (vid, key, fp, status, snapshot = {}) => ok(sb.from('advice_feedback').upsert(
    { vehicle_id: vid, fact_key: key, fingerprint: fp, status, snapshot, created_at: new Date().toISOString() },
    { onConflict: 'vehicle_id,fact_key' })),
  clearFeedback: (vid, key) => ok(sb.from('advice_feedback').delete().eq('vehicle_id', vid).eq('fact_key', key)),

  // ---- reminder rules ----
  rules: vid => ok(sb.from('reminder_rules').select('*').eq('vehicle_id', vid).order('title')),
  updateRule: (id, patch) => ok(sb.from('reminder_rules').update(patch).eq('id', id)),
};
