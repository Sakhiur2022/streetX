// Supabase Edge Function: gemini
// Keeps the Gemini API key on the server. Two modes:
//   extract : invoice / paperwork photo  -> structured fields for the forms
//   explain : facts the app computed     -> optional summary, order, why / next step (numbers checked)
//
// Deploy (run from the car-tracker folder, needs the Supabase CLI):
//   supabase login
//   supabase link --project-ref YOUR_PROJECT_REF
//   supabase secrets set GEMINI_API_KEY=your_key_from_aistudio
//   supabase functions deploy gemini --no-verify-jwt
// --no-verify-jwt is intentional: requireUser() below checks the signed-in user itself,
// so the gateway check is redundant (and can conflict with newer Supabase API keys).
//
// Optional secrets: GEMINI_MODEL (default gemini-3.5-flash-lite), ALLOWED_ORIGIN (your site URL).

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const BASE = Deno.env.get('GEMINI_BASE') ?? 'https://generativelanguage.googleapis.com/v1beta';
const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------- allowed values (keep in sync with schema.sql) ----------
const MAINT = ['oil_change', 'engine', 'engine_air_filter', 'engine_air_filter_clean', 'cabin_ac_filter', 'cabin_ac_filter_clean', 'ac_service', 'tyre_change',
  'tyre_rotation', 'tyre_pressure', 'battery_12v', 'hybrid_system', 'brake', 'electrical', 'lights',
  'coolant', 'transmission', 'other'];
const EXP = ['parking', 'toll', 'fine', 'wash', 'accessory', 'other'];
const DOCS = ['tax_token', 'fitness', 'insurance', 'registration', 'other'];

// ---------- auth: only a signed-in user may spend the Gemini quota ----------
async function requireUser(req: Request) {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) throw new HttpError(401, 'Not signed in');
  const key = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, key, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data, error } = await sb.auth.getUser(auth.slice(7));
  if (error || !data.user) throw new HttpError(401, 'Not signed in');
  return { user: data.user, sb };
}

// ---------- tiny sanitisers: never trust model output ----------
const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null);
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const pick = (v: unknown, list: string[]) => (typeof v === 'string' && list.includes(v) ? v : null);

// ---------- extraction ----------
const N = { type: ['number', 'null'] };
const S = { type: ['string', 'null'] };
const D = { type: ['string', 'null'], description: 'YYYY-MM-DD, or null if not visible' };
const obj = (properties: Record<string, unknown>) => ({
  type: 'object', properties, required: Object.keys(properties),
});

const COMMON =
  'You read photos of vehicle receipts and paperwork from Bangladesh. Text may be English, Bangla or mixed; ' +
  'convert Bangla digits to 0-9. Money is BDT (Taka, ৳, Tk). Dates on Bangladeshi paperwork are day-first ' +
  '(DD/MM/YYYY); output them as YYYY-MM-DD. Return only what is printed or written on the image. ' +
  'If a value is missing or unreadable, return null. Never guess, estimate or calculate missing values.';

const KINDS: Record<string, { prompt: string; schema: unknown; clean: (r: any) => unknown }> = {
  fuel: {
    prompt: 'This is a fuel station receipt. liters = fuel quantity. total_cost_bdt = total amount paid. ' +
      'station = station or brand name. fuel_type = "octane" if it says Octane, "petrol" if it says Petrol, else null.',
    schema: obj({ date: D, liters: N, total_cost_bdt: N, station: S, fuel_type: S }),
    clean: r => ({
      date: date(r.date), liters: num(r.liters), total_cost_bdt: num(r.total_cost_bdt),
      station: str(r.station), fuel_type: pick(r.fuel_type, ['octane', 'petrol']),
    }),
  },
  maintenance: {
    prompt: 'This is a workshop invoice or job card. List every separate service or part line as its own item ' +
      'with its own price. category must be one of: ' + MAINT.join(', ') + ' (use "other" if unsure). ' +
      'Use engine_air_filter_clean or cabin_ac_filter_clean when the line says the filter was cleaned or blown with air; ' +
      'use engine_air_filter or cabin_ac_filter only when it was replaced. ' +
      'title = short description as written. vendor = workshop name. odometer_km = mileage if written. ' +
      'total_cost_bdt = the printed grand total, if any.',
    schema: obj({
      date: D, vendor: S, odometer_km: N, total_cost_bdt: N,
      items: { type: 'array', items: obj({ category: { type: 'string' }, title: { type: 'string' }, cost_bdt: N }) },
    }),
    clean: r => ({
      date: date(r.date), vendor: str(r.vendor), odometer_km: num(r.odometer_km), total_cost_bdt: num(r.total_cost_bdt),
      items: (Array.isArray(r.items) ? r.items : []).slice(0, 20).map((i: any) => ({
        category: pick(i?.category, MAINT) ?? 'other', title: str(i?.title) ?? '', cost_bdt: num(i?.cost_bdt) ?? 0,
      })),
    }),
  },
  expense: {
    prompt: 'This is a parking ticket, toll receipt, fine notice, car wash or accessory purchase. category must be ' +
      'one of: ' + EXP.join(', ') + '. amount_bdt = total paid. notes = short description.',
    schema: obj({ date: D, category: S, amount_bdt: N, notes: S }),
    clean: r => ({ date: date(r.date), category: pick(r.category, EXP), amount_bdt: num(r.amount_bdt), notes: str(r.notes) }),
  },
  document: {
    prompt: 'This is a vehicle tax token, fitness certificate, insurance or registration paper. doc_type must be one of: ' +
      DOCS.join(', ') + ' (road tax token = tax_token, fitness certificate = fitness). issued_on = issue date. ' +
      'expires_on = last day of validity. cost_bdt = fee paid.',
    schema: obj({ doc_type: S, issued_on: D, expires_on: D, cost_bdt: N }),
    clean: r => ({
      doc_type: pick(r.doc_type, DOCS), issued_on: date(r.issued_on), expires_on: date(r.expires_on), cost_bdt: num(r.cost_bdt),
    }),
  },
};

async function extract(b: any) {
  const k = KINDS[b.kind];
  if (!k) throw new HttpError(400, 'Unknown kind');
  const mime = String(b.mime_type ?? '');
  if (!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(mime)) throw new HttpError(400, 'Unsupported file type');
  const data = String(b.image_base64 ?? '');
  if (!data || data.length > 7_000_000) throw new HttpError(400, 'Missing or too large file');
  const raw = await callGemini([{ inlineData: { mimeType: mime, data } }, { text: 'Extract the fields.' }], k.schema, COMMON + ' ' + k.prompt);
  return k.clean(raw ?? {});
}

// ---------- explain: Gemini comments on facts the app already verified ----------
// The app computes every fact from the owner's records. Gemini may only add "why" / "next step" text and an order,
// and any text that quotes a number which is not in the facts is thrown away before it reaches the owner.
const EXPLAIN_SCHEMA = obj({
  summary: { type: 'string' },
  order: { type: 'array', items: { type: 'string' } },
  items: { type: 'array', items: obj({ fact_id: { type: 'string' }, why: { type: 'string' }, action: { type: 'string' } }) },
});

const EXPLAIN_PROMPT =
  'You comment on verified facts about one owner\'s Toyota Corolla Fielder Hybrid, driven mainly in Dhaka: heavy stop-and-go ' +
  'traffic, dust, heat and monsoon waterlogging. The app computed every fact from the owner\'s own records. Rules: ' +
  '(1) Never state a number, date, price or percentage that is not written in a fact; copy numbers exactly as written, ' +
  'and never calculate new ones. (2) Never invent causes. Where a fact lists things to check, say "could be", not "is". ' +
  '(3) For brakes, hybrid battery, 12V battery, cooling or anything safety-related, tell the owner to confirm with a workshop. ' +
  '(4) summary: at most 2 short sentences telling the owner what to do first and why, as direct instructions. (5) items: for facts worth commenting on, give why (one sentence ' +
  'on why it matters for this car and these roads) and action (one concrete next step). Skip facts that need no comment. ' +
  '(6) order: fact ids, most urgent first. Use fact ids exactly as given. Plain English.';

// Every number in a string, normalised ("1,230" -> "1230", "13.0" -> "13").
const BN = '০১২৩৪৫৬৭৮৯';
const ascii = (t: string) => t.replace(/[০-৯]/g, d => String(BN.indexOf(d)));
const numbersIn = (t: string) => new Set((ascii(t).match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
  .map(n => n.replace(/,/g, '')).map(n => (n.includes('.') ? n.replace(/0+$/, '').replace(/\.$/, '') : n)));
const SMALL = /^(?:\d|1[0-2]|100)$/; // counts like "2 items" and "100%" are fine

async function explain(b: any) {
  const facts = (Array.isArray(b.facts) ? b.facts : []).slice(0, 25)
    .map((f: any) => ({ id: str(f?.id, 80), kind: str(f?.kind, 30), severity: pick(f?.severity, ['high', 'medium', 'low', 'info']),
      title: str(f?.title, 160), detail: str(f?.detail, 500) }))
    .filter((f: any) => f.id && f.title);
  if (!facts.length) throw new HttpError(400, 'No facts to explain');
  const car = { make: str(b.car?.make, 40), model: str(b.car?.model, 60), year: typeof b.car?.year === 'number' ? b.car.year : null };
  const input = JSON.stringify({ car, facts });
  if (input.length > 20_000) throw new HttpError(400, 'Too many facts');

  const raw = await callGemini([{ text: 'Verified facts (JSON):\n' + input }], EXPLAIN_SCHEMA, EXPLAIN_PROMPT) ?? {};

  const allowed = numbersIn(input);
  const clean = (t: unknown) => {
    const text = str(t, 500);
    return text && [...numbersIn(text)].every(n => allowed.has(n) || SMALL.test(n)) ? text : null;
  };
  const ids = new Set(facts.map((f: any) => f.id));
  const seen = new Set<string>(), items: { fact_id: string; why: string | null; action: string | null }[] = [];
  let dropped = 0;
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    if (!ids.has(it?.fact_id) || seen.has(it.fact_id)) { dropped++; continue; }
    seen.add(it.fact_id);
    const why = clean(it.why), action = clean(it.action);
    if ((str(it.why) && !why) || (str(it.action) && !action)) dropped++;
    if (why || action) items.push({ fact_id: it.fact_id, why, action });
  }
  const summary = clean(raw.summary);
  if (str(raw.summary) && !summary) dropped++;
  const order = [...new Set((Array.isArray(raw.order) ? raw.order : []).filter((x: unknown) => typeof x === 'string' && ids.has(x)))];
  return { summary, order, items, dropped };
}

// ---------- Gemini call ----------
async function callGemini(parts: unknown[], schema: unknown, system: string) {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new HttpError(500, 'GEMINI_API_KEY is not set on the server');
  const url = `${BASE}/models/${Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite'}:generateContent`;
  const configs = [
    { responseFormat: { text: { mimeType: 'application/json', schema } } },  // current docs
    { responseMimeType: 'application/json', responseJsonSchema: schema },     // older field names
  ];
  let status = 0, detail = '';
  for (const generationConfig of configs) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig }),
    });
    if (res.ok) {
      const j = await res.json();
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
      try { return JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')); }
      catch { throw new HttpError(502, 'Gemini returned unreadable output. Try again.'); }
    }
    status = res.status;
    detail = (await res.text()).slice(0, 400);
    if (status !== 400) break; // only a 400 can mean "unknown field": retry once with the older names
  }
  throwGeminiError(status, detail);
}

function throwGeminiError(status: number, detail: string): never {
  console.error('Gemini error', status, detail);
  if (status === 429) throw new HttpError(429, 'Gemini rate limit reached. Wait a minute and try again.');
  if ([400, 403, 404].includes(status)) throw new HttpError(502, `Gemini rejected the request (${status}). Check GEMINI_API_KEY and GEMINI_MODEL.`);
  throw new HttpError(502, `Gemini is unavailable (${status}). Try again shortly.`);
}

// ---------- ask: Gemini answers by calling read-only tools on the owner's own records ----------
// Safety, in layers: (1) tools read through the caller's own login, so row level security applies; (2) tools can only
// SELECT, with fixed enums instead of free-form SQL; (3) every number in the final answer must come from a tool result,
// the question, or the calc tool, otherwise the model is asked to rewrite it once and then the answer is withheld;
// (4) charts and tables are built here from tool results, never from numbers the model typed.
type Row = Record<string, any>;
const TABLES: Record<string, { table: string; date: string; cols: string }> = {
  fuel: { table: 'fuel_logs', date: 'logged_on', cols: 'id,logged_on,odometer_km,fuel_type,liters,total_cost_bdt,price_per_liter,is_full_tank,station,notes' },
  maintenance: { table: 'maintenance_logs', date: 'logged_on', cols: 'id,logged_on,odometer_km,vendor,notes,maintenance_items(category,title,cost_bdt,warranty_until)' },
  expense: { table: 'expenses', date: 'logged_on', cols: 'id,logged_on,odometer_km,category,amount_bdt,notes' },
  incident: { table: 'incidents', date: 'occurred_on', cols: 'id,occurred_on,odometer_km,location,description,repair_cost_bdt,claim_status,notes' },
  document: { table: 'documents', date: 'issued_on', cols: 'id,doc_type,issued_on,expires_on,cost_bdt,notes' },
};
const TYPE_NAME: Record<string, string> = { fuel: 'fuel', maintenance: 'service', expense: 'expense', incident: 'incident', document: 'document' };
const ALLOWED_CAT: Record<string, string[]> = {
  fuel: ['octane', 'petrol'], maintenance: MAINT, expense: EXP, incident: ['none', 'filed', 'approved', 'rejected', 'paid'], document: DOCS,
};
const DATA_TOOLS = new Set(['list_entries', 'aggregate', 'fuel_economy', 'vehicle_summary', 'current_facts']);
const round2 = (v: number) => Math.round(v * 100) / 100;
const n = (v: unknown) => Number(v ?? 0);
const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

interface Ctx {
  sb: any; facts: unknown[]; toolRuns: number;
  calls: { name: string; args: any }[]; results: { name: string; result: any }[];
  refs: Map<string, string>; visuals: any[]; sources: { type: string; id: string; label: string }[]; allowed: Set<string>;
}

// Numbers the answer may use. A decimal also allows its rounded forms (59.74 -> 60 and 59.7).
function addAllowed(ctx: Ctx, text: string) {
  for (const x of numbersIn(text)) {
    ctx.allowed.add(x);
    if (x.includes('.')) { ctx.allowed.add(String(Math.round(Number(x)))); ctx.allowed.add(Number(x).toFixed(1).replace(/\.0$/, '')); }
  }
}
const unknownNumbers = (text: string, allowed: Set<string>) => [...numbersIn(text)].filter(x => !allowed.has(x) && !SMALL.test(x));

function normalize(type: string, r: Row): Row {
  const ref = `${type}:${r.id}`;
  if (type === 'fuel') return { ref, date: r.logged_on, cost: n(r.total_cost_bdt), fuel_type: r.fuel_type, liters: n(r.liters), price_per_liter: n(r.price_per_liter), odometer_km: r.odometer_km, station: r.station, full_tank: r.is_full_tank, notes: r.notes };
  if (type === 'maintenance') {
    const services = (r.maintenance_items ?? []).map((i: Row) => ({ category: i.category, title: i.title, cost: n(i.cost_bdt) }));
    return { ref, date: r.logged_on, cost: services.reduce((a: number, s: Row) => a + s.cost, 0), odometer_km: r.odometer_km, shop: r.vendor, services, notes: r.notes };
  }
  if (type === 'expense') return { ref, date: r.logged_on, cost: n(r.amount_bdt), category: r.category, odometer_km: r.odometer_km, notes: r.notes };
  if (type === 'incident') return { ref, date: r.occurred_on, cost: n(r.repair_cost_bdt), location: r.location, description: r.description, claim: r.claim_status, odometer_km: r.odometer_km, notes: r.notes };
  return { ref, date: r.issued_on ?? r.expires_on, cost: n(r.cost_bdt), doc_type: r.doc_type, issued_on: r.issued_on, expires_on: r.expires_on, notes: r.notes };
}

function dateRange(a: Row) {
  for (const k of ['from', 'to']) if (a[k] != null && !isDate(a[k])) throw new HttpError(400, `${k} must be a date like 2026-01-31`);
  return { from: a.from as string | undefined, to: a.to as string | undefined };
}

async function fetchRows(sb: any, type: string, from?: string, to?: string) {
  const t = TABLES[type];
  let q = sb.from(t.table).select(t.cols);
  if (type !== 'document') { if (from) q = q.gte(t.date, from); if (to) q = q.lte(t.date, to); }
  const { data, error } = await q.order(t.date, { ascending: false }).limit(1000);
  if (error) throw new HttpError(502, `Could not read your ${TYPE_NAME[type]} records (${error.message})`);
  let rows: Row[] = (data ?? []).map((r: Row) => normalize(type, r));
  if (type === 'document') rows = rows.filter(r => r.date && (!from || r.date >= from) && (!to || r.date <= to));
  return { rows, truncated: (data ?? []).length >= 1000 };
}

function matches(type: string, r: Row, category?: string, text?: string) {
  if (category) {
    const hit = type === 'fuel' ? r.fuel_type === category : type === 'maintenance' ? r.services.some((s: Row) => s.category === category)
      : type === 'document' ? r.doc_type === category : type === 'expense' ? r.category === category : r.claim === category;
    if (!hit) return false;
  }
  return !text || JSON.stringify(r).toLowerCase().includes(text.toLowerCase());
}

function checkFilters(type: string, a: Row) {
  if (a.category && !ALLOWED_CAT[type]?.includes(a.category)) return `category for ${type} must be one of: ${ALLOWED_CAT[type].join(', ')}`;
  return null;
}

async function toolList(ctx: Ctx, a: Row) {
  if (!TABLES[a.type]) return { error: `type must be one of: ${Object.keys(TABLES).join(', ')}` };
  const bad = checkFilters(a.type, a); if (bad) return { error: bad };
  const { from, to } = dateRange(a);
  const { rows, truncated } = await fetchRows(ctx.sb, a.type, from, to);
  const matched = rows.filter(r => matches(a.type, r, a.category, a.text));
  const sort = a.sort ?? 'newest';
  matched.sort(sort === 'oldest' ? (x, y) => x.date.localeCompare(y.date) : sort === 'highest_cost' ? (x, y) => y.cost - x.cost : (x, y) => y.date.localeCompare(x.date));
  const out = matched.slice(0, Math.min(Math.max(Math.floor(n(a.limit)) || 10, 1), 25));
  out.forEach(r => ctx.refs.set(r.ref, r.date));
  return { type: a.type, matching: matched.length, returned: out.length, truncated, rows: out };
}

async function toolAggregate(ctx: Ctx, a: Row) {
  const types = a.type === 'all' ? Object.keys(TABLES) : [a.type];
  if (!types.every(t => TABLES[t])) return { error: `type must be one of: all, ${Object.keys(TABLES).join(', ')}` };
  const metric = a.metric ?? 'cost', groupBy = a.group_by ?? 'none';
  if (!['cost', 'count', 'liters'].includes(metric)) return { error: 'metric must be cost, count or liters' };
  if (metric === 'liters' && a.type !== 'fuel') return { error: 'liters only works with type fuel' };
  if (!['none', 'month', 'year', 'category', 'type', 'shop'].includes(groupBy)) return { error: 'group_by must be none, month, year, category, type or shop' };
  if (a.category && a.type === 'all') return { error: 'category needs one type, not all' };
  if (a.category) { const bad = checkFilters(a.type, a); if (bad) return { error: bad }; }
  const { from, to } = dateRange(a);

  const groups = new Map<string, { value: number; count: number }>();
  const add = (key: string, value: number) => { const g = groups.get(key) ?? { value: 0, count: 0 }; g.value += value; g.count += 1; groups.set(key, g); };
  let considered = 0, truncated = false;
  for (const type of types) {
    const res = await fetchRows(ctx.sb, type, from, to);
    truncated ||= res.truncated;
    for (const r of res.rows.filter(x => matches(type, x, a.category, a.text))) {
      considered++;
      const lines = type === 'maintenance' && a.category ? r.services.filter((s: Row) => s.category === a.category) : r.services;
      if (type === 'maintenance' && groupBy === 'category') { for (const s of lines) add(s.category, metric === 'cost' ? s.cost : 1); continue; }
      const key = groupBy === 'none' ? 'total' : groupBy === 'month' ? String(r.date).slice(0, 7) : groupBy === 'year' ? String(r.date).slice(0, 4)
        : groupBy === 'type' ? TYPE_NAME[type] : groupBy === 'shop' ? (r.shop ?? r.station ?? '(none)') : (r.fuel_type ?? r.category ?? r.doc_type ?? r.claim ?? type);
      const cost = type === 'maintenance' && a.category ? lines.reduce((x: number, s: Row) => x + s.cost, 0) : r.cost;
      add(key, metric === 'cost' ? cost : metric === 'liters' ? n(r.liters) : 1);
    }
  }
  const list = [...groups].map(([key, g]) => ({ key, value: round2(g.value), entries: g.count }));
  list.sort(groupBy === 'month' || groupBy === 'year' ? (x, y) => x.key.localeCompare(y.key) : (x, y) => y.value - x.value);
  return { metric, unit: metric === 'cost' ? '৳' : metric === 'liters' ? 'L' : 'entries', group_by: groupBy, from: from ?? null, to: to ?? null,
    total: round2(list.reduce((s, g) => s + g.value, 0)), entries_considered: considered, groups: list.slice(0, 60), truncated };
}

async function toolEconomy(ctx: Ctx, a: Row) {
  const { from, to } = dateRange(a);
  let q = ctx.sb.from('fuel_economy').select('end_date,end_odo,km,liters,km_per_l');
  if (from) q = q.gte('end_date', from);
  if (to) q = q.lte('end_date', to);
  const { data, error } = await q.order('end_date', { ascending: false }).limit(200);
  if (error) throw new HttpError(502, `Could not read fuel economy (${error.message})`);
  const rows: Row[] = (data ?? []).map((r: Row) => ({ end_date: r.end_date, km: n(r.km), liters: n(r.liters), km_per_l: n(r.km_per_l) }));
  if (!rows.length) return { fills: 0, note: 'No full-tank-to-full-tank readings in that period.' };
  const km = rows.reduce((x, r) => x + r.km, 0), liters = rows.reduce((x, r) => x + r.liters, 0), kpl = rows.map(r => r.km_per_l);
  return { fills: rows.length, average_km_per_l: round2(km / liters), best_km_per_l: round2(Math.max(...kpl)), worst_km_per_l: round2(Math.min(...kpl)),
    rows: rows.slice(0, 24).reverse().map(r => ({ end_date: r.end_date, km: r.km, km_per_l: round2(r.km_per_l) })) };
}

async function toolVehicle(ctx: Ctx) {
  const v = (await ctx.sb.from('vehicles').select('name,make,model,year').order('created_at').limit(1)).data?.[0] ?? null;
  const odo = (await ctx.sb.from('vehicle_odometer').select('odometer_km').limit(1)).data?.[0]?.odometer_km ?? null;
  const entries: Record<string, number> = {}; let first: string | null = null, last: string | null = null;
  for (const [type, t] of Object.entries(TABLES)) {
    const { data } = await ctx.sb.from(t.table).select(`id,${t.date}`).limit(1000);
    entries[TYPE_NAME[type]] = (data ?? []).length;
    for (const r of data ?? []) { const d = r[t.date]; if (d && (!first || d < first)) first = d; if (d && (!last || d > last)) last = d; }
  }
  return { car: v, current_odometer_km: odo, entries, first_entry: first, last_entry: last };
}

// A tiny arithmetic parser (numbers, + - * / and brackets). No eval.
function evaluate(src: string): number {
  const s = src.replace(/[,৳\s]/g, '');
  if (!s || s.length > 120 || /[^0-9+\-*/().]/.test(ascii(s))) throw new Error('Only numbers and + - * / ( ) are allowed');
  const t = ascii(s); let i = 0;
  const expr = (): number => { let v = term(); while (t[i] === '+' || t[i] === '-') { const op = t[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; };
  const term = (): number => { let v = factor(); while (t[i] === '*' || t[i] === '/') { const op = t[i++]; const r = factor(); if (op === '/' && r === 0) throw new Error('Division by zero'); v = op === '*' ? v * r : v / r; } return v; };
  const factor = (): number => {
    if (t[i] === '-') { i++; return -factor(); }
    if (t[i] === '+') { i++; return factor(); }
    if (t[i] === '(') { i++; const v = expr(); if (t[i] !== ')') throw new Error('Missing )'); i++; return v; }
    const m = /^\d+(?:\.\d+)?/.exec(t.slice(i)); if (!m) throw new Error('Expected a number'); i += m[0].length; return Number(m[0]);
  };
  const v = expr();
  if (i !== t.length) throw new Error('Unexpected character');
  if (!isFinite(v)) throw new Error('Not a finite number');
  return round2(v);
}

function toolCalc(ctx: Ctx, a: Row) {
  const expression = String(a.expression ?? '');
  let value: number;
  try { value = evaluate(expression); } catch (e) { return { error: (e as Error).message }; }
  const bad = [...numbersIn(expression)].filter(x => !ctx.allowed.has(x) && !SMALL.test(x));
  if (bad.length) return { error: `These numbers are not from tool results or the question: ${bad.join(', ')}. Use numbers from tool results.` };
  return { expression, value };
}

// ----- presentation tools: build visuals from stored tool results -----
const resultOf = (ctx: Ctx, k: unknown) => { const i = Number(k); return Number.isInteger(i) ? ctx.results[i - 1] : undefined; };
const fmtVal = (v: number, unit: string) => (unit === '৳' ? `৳${n(v).toLocaleString('en-US')}` : unit === 'L' ? `${v} L` : String(v));

function toolChart(ctx: Ctx, a: Row) {
  if (ctx.visuals.length >= 3) return { error: 'Enough visuals for one answer.' };
  const r = resultOf(ctx, a.from_call), kind = a.kind === 'line' ? 'line' : 'bar', title = str(a.title, 80) ?? 'Chart';
  let points: { label: string; value: number }[], unit: string;
  if (r?.name === 'aggregate' && r.result.groups?.length >= 2) {
    if (kind === 'line' && !['month', 'year'].includes(r.result.group_by)) return { error: 'Line charts need group_by month or year. Use a bar chart for categories.' };
    points = r.result.groups.map((g: Row) => ({ label: g.key, value: g.value })); unit = r.result.unit;
  } else if (r?.name === 'fuel_economy' && r.result.rows?.length >= 2) {
    points = r.result.rows.map((x: Row) => ({ label: x.end_date, value: x.km_per_l })); unit = 'km/L';
  } else return { error: 'from_call must point to an aggregate result with 2 or more groups, or a fuel_economy result.' };
  ctx.visuals.push({ kind, title, unit, points: kind === 'line' ? points.slice(-24) : points.slice(0, 24) });
  return { ok: true };
}

function describeRow(type: string, x: Row) {
  if (type === 'fuel') return `${x.liters} L ${x.fuel_type}${x.station ? ` at ${x.station}` : ''}`;
  if (type === 'maintenance') return `${x.services.map((s: Row) => s.title).join(', ')}${x.shop ? ` at ${x.shop}` : ''}`;
  if (type === 'expense') return `${x.category}${x.notes ? `: ${x.notes}` : ''}`;
  if (type === 'incident') return String(x.description ?? '');
  return `${x.doc_type}, expires ${x.expires_on}`;
}

function toolTable(ctx: Ctx, a: Row) {
  if (ctx.visuals.length >= 3) return { error: 'Enough visuals for one answer.' };
  const r = resultOf(ctx, a.from_call), title = str(a.title, 80) ?? 'Table';
  if (r?.name === 'list_entries' && r.result.rows?.length) {
    const rows = r.result.rows.slice(0, 15);
    ctx.visuals.push({ kind: 'table', title, columns: ['Date', 'What', 'Cost'], rows: rows.map((x: Row) => [x.date, describeRow(r.result.type, x), x.cost ? fmtVal(x.cost, '৳') : '']), refs: rows.map((x: Row) => x.ref) });
  } else if (r?.name === 'aggregate' && r.result.groups?.length) {
    const head: Record<string, string> = { month: 'Month', year: 'Year', category: 'Category', type: 'Type', shop: 'Shop', none: 'Total' };
    ctx.visuals.push({ kind: 'table', title, columns: [head[r.result.group_by] ?? 'Group', r.result.metric === 'cost' ? 'Cost' : r.result.metric === 'liters' ? 'Liters' : 'Count', 'Entries'],
      rows: r.result.groups.slice(0, 15).map((g: Row) => [g.key, fmtVal(g.value, r.result.unit), String(g.entries)]) });
  } else return { error: 'from_call must point to a list_entries result with rows, or an aggregate result.' };
  return { ok: true };
}

function toolCite(ctx: Ctx, a: Row) {
  const refs = (Array.isArray(a.refs) ? a.refs : []).filter((x: unknown) => typeof x === 'string' && ctx.refs.has(x)).slice(0, 6);
  if (!refs.length) return { error: 'cite needs refs exactly as returned by list_entries.' };
  for (const ref of refs) {
    if (ctx.sources.some(s => `${s.type}:${s.id}` === ref)) continue;
    const [type, ...rest] = ref.split(':');
    ctx.sources.push({ type, id: rest.join(':'), label: ctx.refs.get(ref) ?? '' });
  }
  return { ok: true };
}

const TOOL_NAMES = ['list_entries', 'aggregate', 'fuel_economy', 'vehicle_summary', 'current_facts', 'calc', 'show_chart', 'show_table', 'cite'];
async function runTool(ctx: Ctx, name: string, a: Row) {
  if (!TOOL_NAMES.includes(name)) return { error: `Unknown tool "${name}". Tools are read-only: ${TOOL_NAMES.join(', ')}.` };
  if (++ctx.toolRuns > 10) return { error: 'Too many tool calls for one question. Answer with what you have.' };
  try {
    if (name === 'show_chart') return toolChart(ctx, a);
    if (name === 'show_table') return toolTable(ctx, a);
    if (name === 'cite') return toolCite(ctx, a);
    let out: Row;
    if (name === 'list_entries') out = await toolList(ctx, a);
    else if (name === 'aggregate') out = await toolAggregate(ctx, a);
    else if (name === 'fuel_economy') out = await toolEconomy(ctx, a);
    else if (name === 'vehicle_summary') out = await toolVehicle(ctx);
    else if (name === 'current_facts') out = { facts: ctx.facts };
    else out = toolCalc(ctx, a);
    if (out.error) return out;
    if (DATA_TOOLS.has(name)) { ctx.calls.push({ name, args: a }); ctx.results.push({ name, result: out }); out = { call: ctx.results.length, ...out }; }
    addAllowed(ctx, JSON.stringify(out));
    return out;
  } catch (e) {
    return { error: e instanceof HttpError ? e.message : String((e as Error).message ?? e).slice(0, 200) };
  }
}

const dateProps = { from: { type: 'string', description: 'Start date, YYYY-MM-DD' }, to: { type: 'string', description: 'End date, YYYY-MM-DD' } };
const TYPE_ENUM = ['fuel', 'maintenance', 'expense', 'incident', 'document'];
const DECLS = [
  { name: 'list_entries', description: 'List the owner\'s individual records (newest first by default). Use for "when was the last...", "show my...".',
    parameters: { type: 'object', properties: { type: { type: 'string', enum: TYPE_ENUM }, ...dateProps,
      category: { type: 'string', description: 'fuel: octane|petrol. maintenance: a service category such as oil_change, tyre_change, brake, battery_12v. expense: parking|toll|fine|wash|accessory|other. document: tax_token|fitness|insurance|registration|other. incident: claim status.' },
      text: { type: 'string', description: 'Word to look for in notes, shop, station or description' },
      sort: { type: 'string', enum: ['newest', 'oldest', 'highest_cost'] }, limit: { type: 'integer', description: 'Max 25' } }, required: ['type'] } },
  { name: 'aggregate', description: 'Totals and counts computed in code. Always use this for sums, never add rows yourself. Documents are dated by issue date.',
    parameters: { type: 'object', properties: { type: { type: 'string', enum: ['all', ...TYPE_ENUM] }, metric: { type: 'string', enum: ['cost', 'count', 'liters'] },
      group_by: { type: 'string', enum: ['none', 'month', 'year', 'category', 'type', 'shop'] }, ...dateProps, category: { type: 'string' }, text: { type: 'string' } }, required: ['type'] } },
  { name: 'fuel_economy', description: 'Fuel economy (km per litre) per full-tank-to-full-tank fill, with average, best and worst.',
    parameters: { type: 'object', properties: { ...dateProps } } },
  { name: 'vehicle_summary', description: 'The car, current odometer, how many entries of each kind exist, and the first and last entry dates.' },
  { name: 'current_facts', description: 'The app\'s verified Advice items right now: service due dates, document expiry, fuel economy trend, spending spikes. Use for "what is urgent?" questions.' },
  { name: 'calc', description: 'Arithmetic on numbers taken from tool results: + - * / and brackets. Use for differences, percentages, averages.',
    parameters: { type: 'object', properties: { expression: { type: 'string', description: 'e.g. (12300 - 7700) / 7700 * 100' } }, required: ['expression'] } },
  { name: 'show_chart', description: 'Show a small chart built from an earlier aggregate (2+ groups) or fuel_economy result. Use bar for categories, line for months or years.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['bar', 'line'] }, title: { type: 'string' }, from_call: { type: 'integer', description: 'The "call" number of that earlier result' } }, required: ['kind', 'title', 'from_call'] } },
  { name: 'show_table', description: 'Show a small table built from an earlier list_entries or aggregate result.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, from_call: { type: 'integer' } }, required: ['title', 'from_call'] } },
  { name: 'cite', description: 'Attach the specific records your answer mentions, as tappable links. Refs are the "ref" values from list_entries rows.',
    parameters: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } } }, required: ['refs'] } },
];

const ASK_PROMPT =
  'You answer questions about one owner\'s Toyota Corolla Fielder Hybrid, driven mainly in Dhaka, using ONLY your tools, which read the owner\'s own records (read-only). ' +
  'Rules: (1) Never state a number, date or fact that did not come from a tool result, the question, or today\'s date. Copy numbers exactly as returned. ' +
  '(2) Use aggregate for every total or count, and calc for every difference, percentage or average. Never add rows yourself. ' +
  '(3) Resolve words like "this year" or "last month" into from/to dates yourself, using today\'s date, and say which dates you used. ' +
  '(4) If the records do not contain the answer, say so plainly. Do not guess, and do not use general knowledge about prices or service intervals. ' +
  '(5) For brakes, hybrid battery, 12V battery, cooling or any safety matter, tell the owner to confirm with a workshop. ' +
  '(6) Money is BDT: write ৳ before amounts. Use digits 0-9. ' +
  '(7) Reply in the language the user wrote in (English or Bangla). Keep it short: one to four sentences, no lists unless asked. ' +
  '(8) When a visual helps (totals over months, a breakdown, a short list of entries), call show_chart or show_table once, and cite the specific entries you mention. Do not repeat a table\'s contents in your text.';

function describeCall(c: { name: string; args: Row }) {
  const a = c.args ?? {}, span = a.from || a.to ? ` (${a.from ?? 'start'} to ${a.to ?? 'today'})` : '';
  if (c.name === 'list_entries') return `Listed ${a.type} entries${a.category ? ` in ${a.category}` : ''}${span}`;
  if (c.name === 'aggregate') return `Added up ${a.metric ?? 'cost'} for ${a.type}${a.group_by && a.group_by !== 'none' ? `, by ${a.group_by}` : ''}${span}`;
  if (c.name === 'fuel_economy') return `Read fuel economy per fill${span}`;
  if (c.name === 'vehicle_summary') return 'Read your car summary';
  return 'Read your current Advice items';
}

async function geminiRaw(body: unknown) {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new HttpError(500, 'GEMINI_API_KEY is not set on the server');
  const model = Deno.env.get('GEMINI_ASK_MODEL') ?? Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite';
  const res = await fetch(`${BASE}/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throwGeminiError(res.status, (await res.text()).slice(0, 400));
  return await res.json();
}

async function ask(sb: any, b: any) {
  if (JSON.stringify(b).length > 80_000) throw new HttpError(400, 'Request too large');
  const msgs = (Array.isArray(b.messages) ? b.messages : [])
    .map((m: Row) => ({ role: m?.role === 'model' ? 'model' : m?.role === 'user' ? 'user' : null, text: str(m?.text, 1500) }))
    .filter((m: Row) => m.role && m.text).slice(-12) as { role: 'user' | 'model'; text: string }[];
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new HttpError(400, 'Ask a question first');
  const today = isDate(b.today) ? b.today : new Date().toISOString().slice(0, 10);
  const facts = (Array.isArray(b.facts) ? b.facts : []).slice(0, 20)
    .map((f: Row) => ({ id: str(f?.id, 80), severity: pick(f?.severity, ['high', 'medium', 'low', 'info']), title: str(f?.title, 160), detail: str(f?.detail, 500) })).filter((f: Row) => f.id && f.title);

  const ctx: Ctx = { sb, facts, toolRuns: 0, calls: [], results: [], refs: new Map(), visuals: [], sources: [], allowed: new Set() };
  addAllowed(ctx, `${today} ${msgs.map(m => m.text).join(' ')} ${JSON.stringify(facts)}`);

  const car = [b.car?.make, b.car?.model, b.car?.year].filter(Boolean).join(' ');
  const contents: Row[] = msgs.map(m => ({ role: m.role, parts: [{ text: m.text }] }));
  const system = { parts: [{ text: `${ASK_PROMPT} Today is ${today}.${car ? ` The car is a ${car}.` : ''}` }] };
  let repaired = false, text = '', bad: string[] = [];

  for (let step = 0; step < 8; step++) {
    const res = await geminiRaw({ systemInstruction: system, contents, tools: [{ functionDeclarations: DECLS }] });
    const content = res.candidates?.[0]?.content;
    if (!content?.parts?.length) throw new HttpError(502, 'Gemini returned no answer. Try again.');
    contents.push(content); // verbatim: Gemini 3+ needs its thought signatures passed back exactly
    const calls = content.parts.filter((p: Row) => p.functionCall);
    if (calls.length) {
      const parts: Row[] = [];
      for (const p of calls) parts.push({ functionResponse: { name: p.functionCall.name, response: await runTool(ctx, p.functionCall.name, p.functionCall.args ?? {}) } });
      contents.push({ role: 'user', parts });
      continue;
    }
    text = content.parts.filter((p: Row) => !p.thought).map((p: Row) => p.text ?? '').join('').trim();
    bad = unknownNumbers(text, ctx.allowed);
    if (bad.length && !repaired) {
      repaired = true;
      contents.push({ role: 'user', parts: [{ text: `Your answer used numbers that are not in the tool results: ${bad.join(', ')}. Rewrite it using only numbers from tool results (use calc for arithmetic), or say you could not find it.` }] });
      continue;
    }
    break;
  }
  const verified = !!text && !bad.length;
  return {
    text: verified ? text : text ? 'I could not verify the numbers in that answer, so I am not showing it. The records I looked at are below.' : 'I could not work that out. Try asking in a more specific way.',
    verified, visuals: ctx.visuals, sources: ctx.sources, checked: [...new Set(ctx.calls.map(describeCall))],
  };
}

// ---------- entry ----------
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const { sb } = await requireUser(req);
    const body = await req.json();
    if (body.mode === 'extract') return json({ result: await extract(body) });
    if (body.mode === 'explain') return json({ result: await explain(body) });
    if (body.mode === 'ask') return json({ result: await ask(sb, body) });
    return json({ error: 'Unknown mode' }, 400);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Server error' }, 500);
  }
});
