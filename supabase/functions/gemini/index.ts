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
  return data.user;
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
const numbersIn = (t: string) => new Set((t.match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
  .map(n => n.replace(/,/g, '')).map(n => (n.includes('.') ? n.replace(/0+$/, '').replace(/\.$/, '') : n)));
const SMALL = /^(?:\d|1[0-2])$/; // counts like "2 items" are fine

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
  console.error('Gemini error', status, detail);
  if (status === 429) throw new HttpError(429, 'Gemini rate limit reached. Wait a minute and try again.');
  if ([400, 403, 404].includes(status)) throw new HttpError(502, `Gemini rejected the request (${status}). Check GEMINI_API_KEY and GEMINI_MODEL.`);
  throw new HttpError(502, `Gemini is unavailable (${status}). Try again shortly.`);
}

// ---------- entry ----------
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    await requireUser(req);
    const body = await req.json();
    if (body.mode === 'extract') return json({ result: await extract(body) });
    if (body.mode === 'explain') return json({ result: await explain(body) });
    return json({ error: 'Unknown mode' }, 400);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Server error' }, 500);
  }
});
