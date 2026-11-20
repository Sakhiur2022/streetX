// Supabase Edge Function: gemini
// Keeps the Gemini API key on the server. Two modes:
//   extract : invoice / paperwork photo  -> structured fields for the forms
//   advice  : aggregated car stats       -> alerts, savings tips, odd data points
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

// ---------- advice ----------
const ITEM = obj({ title: { type: 'string' }, detail: { type: 'string' } });
const ADVICE_SCHEMA = obj({
  summary: { type: 'string' },
  alerts: { type: 'array', maxItems: 5, items: obj({ level: { type: 'string', enum: ['high', 'medium', 'low'] }, title: { type: 'string' }, detail: { type: 'string' } }) },
  savings: { type: 'array', maxItems: 4, items: ITEM },
  anomalies: { type: 'array', maxItems: 3, items: ITEM },
});

const ADVICE_PROMPT =
  'You are a careful car-cost analyst for one owner of a Toyota Corolla Fielder Hybrid driven mainly in Dhaka: ' +
  'heavy stop-and-go traffic, dust, heat and monsoon waterlogging. You receive a JSON summary of their own records ' +
  '(money in BDT, distance in km, fuel economy in km/L). Rules: use only facts present in the JSON; never invent ' +
  'numbers, prices or dates. If data is too thin for a point, say what to log next instead. Look for: overdue or ' +
  'soon-due services, expiring documents (tax token, fitness certificate, insurance), falling km/L and likely causes ' +
  'to check (tyre pressure, dirty air filter, AC use, traffic), unusual spending spikes, fuel price changes. Savings ' +
  'tips must be practical and tied to the data. You are not a mechanic: for brakes, hybrid battery or anything ' +
  'safety-related, tell the owner to confirm with a workshop. Be concise: summary 2-3 sentences; each detail 1-2 sentences. ' +
  'Plain English.';

async function advice(b: any) {
  const text = JSON.stringify(b.summary ?? {});
  if (text.length > 30_000) throw new HttpError(400, 'Summary too large');
  const r = await callGemini([{ text: 'Vehicle data (JSON):\n' + text }], ADVICE_SCHEMA, ADVICE_PROMPT) ?? {};
  const items = (a: unknown, max: number) => (Array.isArray(a) ? a : []).slice(0, max)
    .map((x: any) => ({ title: str(x?.title, 120) ?? '', detail: str(x?.detail, 400) ?? '', level: pick(x?.level, ['high', 'medium', 'low']) ?? 'low' }))
    .filter(x => x.title || x.detail);
  return {
    summary: str(r.summary, 800) ?? 'No summary returned.',
    alerts: items(r.alerts, 5), savings: items(r.savings, 4), anomalies: items(r.anomalies, 3),
  };
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
    if (body.mode === 'advice') return json({ result: await advice(body) });
    return json({ error: 'Unknown mode' }, 400);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Server error' }, 500);
  }
});
