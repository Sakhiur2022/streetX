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
    return ok(sb.from(t.table).select('*').eq('vehicle_id', vehicleId)
      .order(t.dateField, { ascending: false }).order('created_at', { ascending: false }).limit(limit));
  },
  async add(type, payload, files = []) {
    const [row] = await ok(sb.from(TYPES[type].table).insert(payload).select());
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

  // ---- reminder rules ----
  rules: vid => ok(sb.from('reminder_rules').select('*').eq('vehicle_id', vid).order('title')),
  updateRule: (id, patch) => ok(sb.from('reminder_rules').update(patch).eq('id', id)),
};
