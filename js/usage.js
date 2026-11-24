// Usage model: how many km a day the car really does, and what that means for due dates.
// Pure functions (no network, no DOM). Dates are 'YYYY-MM-DD'.
const DAY = 864e5;
const CAP_DAYS = 3650;                     // a prediction more than ten years out is meaningless
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const tDay = iso => Date.parse(iso) / DAY;
const diffDays = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / DAY);
const n0 = v => Number(v).toLocaleString('en-US');
const days = v => `${n0(v)} ${v === 1 ? 'day' : 'days'}`;
export const addDays = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);

// 'YYYY-MM-DD' -> '12 Dec' (adds the year only when it is not this year)
export const niceShort = (iso, today) => {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${SHORT[Number(m) - 1]}${today && y === today.slice(0, 4) ? '' : ` ${y}`}`;
};

const quantile = (sorted, q) => {
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

// One reading per day (the highest), then drop impossible ones: odometers going backwards or >1,000 km in a day.
function filterPass(pts, backward) {
  const seq = backward ? [...pts].reverse() : pts, keep = [];
  for (const p of seq) {
    const prev = keep[keep.length - 1];
    if (!prev) { keep.push(p); continue; }
    const dKm = backward ? prev.o - p.o : p.o - prev.o, dT = Math.abs(p.t - prev.t);
    if (dKm < 0 || dKm / Math.max(1, dT) > 1000) continue;
    keep.push(p);
  }
  return backward ? keep.reverse() : keep;
}

export function cleanReadings(readings) {
  const byDay = new Map();
  for (const r of readings ?? []) {
    const d = String(r.read_on ?? '').slice(0, 10), o = Number(r.odometer_km);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(o) && o >= 0) byDay.set(d, Math.max(byDay.get(d) ?? 0, o));
  }
  const pts = [...byDay].sort((a, b) => a[0].localeCompare(b[0])).map(([d, o]) => ({ d, o, t: tDay(d) }));
  // A typo in the very first reading would wipe out everything after it going forwards, so also try backwards.
  const fwd = filterPass(pts, false), bwd = filterPass(pts, true);
  return bwd.length > fwd.length ? bwd : fwd;
}

// Theil-Sen: the median of slopes between pairs of readings at least 3 days apart. One bad reading barely moves it.
function slopeOf(win) {
  if (win.length < 2) return null;
  const slopes = [];
  for (let i = 0; i < win.length; i++) {
    for (let j = i + 1; j < win.length; j++) {
      const dt = win[j].t - win[i].t;
      if (dt >= 3) slopes.push((win[j].o - win[i].o) / dt);
    }
  }
  const first = win[0], last = win[win.length - 1];
  const span = last.t - first.t, dist = last.o - first.o;
  if (!slopes.length) return null;
  slopes.sort((a, b) => a - b);
  const few = slopes.length < 3;
  return { rate: few ? dist / span : quantile(slopes, .5), low: few ? null : quantile(slopes, .25), high: few ? null : quantile(slopes, .75), n: win.length, span, dist };
}

// readings: [{ read_on, odometer_km }] from any logs. Returns the typical km a day and how far to trust it.
export function estimateUsage(readings, today) {
  const all = cleanReadings(readings);
  const lastDate = all.length ? all[all.length - 1].d : null;
  const none = { kmPerDay: null, low: null, high: null, confidence: 'none', n: all.length, spanDays: 0, lastDate, shift: null };
  if (all.length < 2) return none;
  const now = tDay(today);

  let win = all.filter(p => p.t >= now - 120);        // recent driving matters most
  if (win.length < 3) win = all.filter(p => p.t >= now - 365);
  if (win.length < 2) win = all.slice(-4);
  const est = slopeOf(win);
  if (!est || !(est.rate > 0.1)) return { ...none, n: win.length };

  const confidence = win.length >= 4 && est.span >= 30 && est.dist >= 100 ? 'good'
    : win.length >= 2 && est.span >= 14 && est.dist >= 30 ? 'rough' : 'none';
  if (confidence === 'none') return { ...none, n: win.length };

  // Has driving changed lately? Last 30 days against the 90 before.
  const before = all.filter(p => p.t < now - 30), anchor = before[before.length - 1];
  const rec = slopeOf([...(anchor ? [anchor] : []), ...all.filter(p => p.t >= now - 30)]);
  const pri = slopeOf(all.filter(p => p.t >= now - 120 && p.t < now - 30));
  const sturdy = s => s && s.n >= 3 && s.span >= 10 && s.dist >= 30 && s.rate > 0;
  const shift = sturdy(rec) && sturdy(pri) ? { recent: rec.rate, prior: pri.rate, pct: (rec.rate - pri.rate) / pri.rate * 100 } : null;

  return { kmPerDay: est.rate, low: est.low, high: est.high, confidence, n: win.length, spanDays: Math.round(est.span), lastDate, shift };
}

// Where a service stands. r is a row of the reminder_status view (km_remaining / days_remaining are as of the
// last logged odometer, so we also account for the days that have passed since that reading).
export function ruleOutlook(r, { usage, today }) {
  if (r.last_done_on == null) return { level: 'never', text: 'Never logged', rank: 2, dueIn: null, dueOn: null, by: null, basis: 'none', window: null };
  const kmLeft = r.km_remaining ?? null, daysLeft = r.days_remaining ?? null;
  const rate = usage && usage.confidence !== 'none' && usage.kmPerDay > 0 ? usage.kmPerDay : null;

  if ((kmLeft != null && kmLeft < 0) || (daysLeft != null && daysLeft < 0)) {
    const parts = [];
    if (kmLeft != null && kmLeft < 0) parts.push(`${n0(-kmLeft)} km overdue`);
    if (daysLeft != null && daysLeft < 0) parts.push(`${days(-daysLeft)} overdue`);
    return { level: 'overdue', text: parts.join(', '), rank: 0, kmLeft, daysLeft, dueIn: null, dueOn: null, by: null, basis: 'fixed', window: null };
  }

  const elapsed = rate && usage.lastDate ? Math.max(0, diffDays(today, usage.lastDate)) : 0;
  const kmDays = kmLeft != null && rate ? Math.ceil(kmLeft / rate - elapsed) : null;
  const cands = [
    kmDays != null && kmDays <= CAP_DAYS ? { by: 'km', days: kmDays } : null,
    daysLeft != null ? { by: 'days', days: daysLeft } : null,
  ].filter(Boolean).sort((a, b) => a.days - b.days);
  const best = rate ? cands[0] ?? null : null;

  const soon = rate ? (best ? best.days <= 14 : kmLeft != null && kmLeft <= 500)
    : (kmLeft != null && kmLeft <= 500) || (daysLeft != null && daysLeft <= 14);

  let text;
  if (best) {
    text = best.days <= 0 ? (best.by === 'km' ? 'Probably due now' : 'Due today')
      : `${best.by === 'km' ? 'Due around' : 'Due'} ${niceShort(addDays(today, best.days), today)} (in ${days(best.days)})`;
  } else {
    const parts = [];
    if (kmLeft != null) parts.push(`${n0(kmLeft)} km left`);
    if (daysLeft != null) parts.push(`${days(daysLeft)} left`);
    text = parts.join(', ') || 'OK';
  }

  let window = null;
  if (best?.by === 'km' && usage.confidence === 'good' && usage.low > 0 && usage.high > 0) {
    const fast = Math.max(0, Math.ceil(kmLeft / usage.high - elapsed)), slow = Math.max(0, Math.ceil(kmLeft / usage.low - elapsed));
    if (slow - fast >= 3) window = [addDays(today, fast), addDays(today, slow)];
  }
  const dueIn = best ? Math.max(0, best.days) : null;
  return { level: soon ? 'soon' : 'ok', text, rank: soon ? 1 : 3, kmLeft, daysLeft, dueIn, dueOn: best ? addDays(today, dueIn) : null,
    by: best?.by ?? null, basis: rate ? 'usage' : 'fixed', window };
}
