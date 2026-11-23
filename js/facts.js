// Fact engine. Every claim on the Advice page is computed here, from the owner's own records.
// Pure functions: no network, no DOM. Gemini never creates facts; it can only comment on these.
//
// A fact: { key, fp, kind, severity, title, detail, evidence[{type,id,label}], checks?, snapshot? }
//   key = stable identity ("svc:brake"), fp = fingerprint of the situation. Feedback is remembered per
//   key and stays valid only while fp is unchanged, so a dismissed item returns if things get worse.
import { itemsOf, OPTS, label } from './models.js';
import { ruleStatus } from './strategies.js';
import { monthLong, niceDate as nice } from './util.js';

const n0 = v => Number(v).toLocaleString('en-US');
const one = v => (Math.round(Number(v) * 10) / 10).toFixed(1);
const dayword = n => `${n0(n)} ${n === 1 ? 'day' : 'days'}`;
const diffDays = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5); // both 'YYYY-MM-DD': UTC, so exact
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const localDay = iso => new Date(iso).toLocaleDateString('en-CA');

const SEV = { high: 0, medium: 1, low: 2, info: 3 };
const KINDS = ['service', 'document', 'economy', 'spend', 'price', 'data', 'duplicate', 'outcome'];
export const SEVERITY_LABEL = { high: 'Urgent', medium: 'Soon', low: 'Heads up', info: 'FYI' };

const visitTotal = v => itemsOf(v).reduce((a, i) => a + Number(i.cost_bdt || 0), 0);
const visitKey = v => `${v.logged_on}|${String(v.odometer_km).padStart(9, '0')}`;
const visitEv = v => ({ type: 'maintenance', id: v.id, label: nice(v.logged_on) });

function lastVisitWith(maintenance, cats) {
  let best = null;
  for (const v of maintenance) {
    if (itemsOf(v).some(i => cats.includes(i.category)) && (!best || visitKey(v) > visitKey(best))) best = v;
  }
  return best;
}

// ---------- services (from the reminder_status view) ----------
function serviceFacts(rem, maintenance) {
  const out = [], never = [];
  for (const r of rem) {
    const s = ruleStatus(r);
    if (s.level === 'never') { never.push(r.title); continue; }
    if (s.level === 'ok') continue;
    const last = lastVisitWith(maintenance, [r.category]);
    const evidence = last ? [visitEv(last)] : [];
    const lastDone = r.last_odometer_km != null ? `Last done at ${n0(r.last_odometer_km)} km on ${nice(r.last_done_on)}.` : '';
    if (s.level === 'overdue') {
      const parts = [];
      if (r.km_remaining != null && r.km_remaining < 0) parts.push(`${n0(-r.km_remaining)} km`);
      if (r.days_remaining != null && r.days_remaining < 0) parts.push(dayword(-r.days_remaining));
      out.push({ key: `svc:${r.category}`, fp: 'overdue', kind: 'service', severity: 'high', title: `${r.title} is overdue`,
        detail: `${parts.join(' and ')} past due. ${lastDone}`.trim(), evidence });
    } else {
      const left = [];
      if (r.km_remaining != null && r.km_remaining <= 500) left.push(`${n0(r.km_remaining)} km`);
      if (r.days_remaining != null && r.days_remaining <= 14) left.push(dayword(r.days_remaining));
      out.push({ key: `svc:${r.category}`, fp: 'soon', kind: 'service', severity: 'medium', title: `${r.title} is due soon`,
        detail: `${left.join(' or ')} left, whichever comes first. ${lastDone}`.trim(), evidence });
    }
  }
  if (never.length) {
    out.push({ key: 'svc_never', fp: String(never.length), kind: 'service', severity: 'low',
      title: `${never.length} service ${never.length === 1 ? 'interval has' : 'intervals have'} no record yet`,
      detail: `${never.slice(0, 6).join(', ')}${never.length > 6 ? ` and ${never.length - 6} more` : ''}. Log the last time each was done so the reminders can work.`,
      evidence: [] });
  }
  return out;
}

// ---------- documents ----------
function docFacts(docs, today) {
  const latest = {};
  [...docs].sort((a, b) => String(b.expires_on).localeCompare(String(a.expires_on))).forEach(d => { latest[d.doc_type] ??= d; });
  const out = [];
  for (const [type, d] of Object.entries(latest)) {
    const n = diffDays(d.expires_on, today), name = label(OPTS.DOCS, type);
    const evidence = [{ type: 'document', id: d.id, label: nice(d.expires_on) }];
    if (n < 0) {
      out.push({ key: `doc:${type}`, fp: 'expired', kind: 'document', severity: 'high', title: `${name} has expired`,
        detail: `It expired on ${nice(d.expires_on)}, ${dayword(-n)} ago. Renew it and log the new one.`, evidence });
    } else if (n <= 30) {
      out.push({ key: `doc:${type}`, fp: 'soon', kind: 'document', severity: 'medium', title: `${name} expires in ${dayword(n)}`,
        detail: `It runs out on ${nice(d.expires_on)}. Renew it before then and log the new one.`, evidence });
    }
  }
  for (const type of ['tax_token', 'fitness']) {
    if (!latest[type]) {
      out.push({ key: `doc_missing:${type}`, fp: 'missing', kind: 'document', severity: 'medium',
        title: `No ${label(OPTS.DOCS, type).toLowerCase()} on record`, detail: 'Add its expiry date so you get a warning before it lapses.', evidence: [] });
    }
  }
  return out;
}

// ---------- fuel economy ----------
const sortedFuel = fuel => [...fuel].sort((a, b) => String(a.logged_on).localeCompare(String(b.logged_on)) || Number(a.odometer_km) - Number(b.odometer_km));

function economyChecks({ maintenance, fuel, odometer, today }) {
  const checks = [];
  const tyre = lastVisitWith(maintenance, ['tyre_pressure']);
  if (!tyre) checks.push({ text: 'No tyre-air entry on record. Low pressure raises fuel use.' });
  else if (diffDays(today, tyre.logged_on) > 30) checks.push({ text: `Tyre air was last logged ${dayword(diffDays(today, tyre.logged_on))} ago.`, evidence: [visitEv(tyre)] });

  const filt = lastVisitWith(maintenance, ['engine_air_filter', 'engine_air_filter_clean']);
  if (!filt) checks.push({ text: 'No engine air filter entry on record.' });
  else {
    const km = Math.max(0, Number(odometer) - Number(filt.odometer_km)), d = diffDays(today, filt.logged_on);
    if (km > 3000 || d > 60) checks.push({ text: `Engine air filter was last cleaned or replaced ${n0(km)} km and ${dayword(d)} ago.`, evidence: [visitEv(filt)] });
  }

  const asc = sortedFuel(fuel), last3 = asc.slice(-3), prev = asc.slice(-8, -3);
  const major = arr => { const c = {}; arr.forEach(f => { c[f.fuel_type] = (c[f.fuel_type] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0]; };
  if (last3.length === 3 && prev.length >= 3 && major(last3) !== major(prev)) {
    checks.push({ text: `Recent refills were mostly ${major(last3)}; before that, mostly ${major(prev)}.`, evidence: [{ type: 'fuel', id: last3[2].id, label: nice(last3[2].logged_on) }] });
  }
  return checks;
}

function economyFacts(d) {
  const segs = [...d.eco].sort((a, b) => String(b.end_date).localeCompare(String(a.end_date)) || Number(b.end_odo) - Number(a.end_odo));
  const recent = segs.slice(0, 3), base = segs.slice(3, 11);
  if (segs.length < 6 || base.length < 3) return [];
  const r = median(recent.map(s => Number(s.km_per_l))), b = median(base.map(s => Number(s.km_per_l)));
  const pct = (b - r) / b * 100;
  const evidence = recent.map(s => d.fuel.find(f => f.logged_on === s.end_date && Number(f.odometer_km) === Number(s.end_odo)))
    .filter(Boolean).map(f => ({ type: 'fuel', id: f.id, label: nice(f.logged_on) }));
  const common = { key: 'kml', kind: 'economy', evidence, snapshot: { kml: Number(one(r)), date: d.today } };
  if (pct >= 10) {
    const severity = pct >= 20 ? 'high' : 'medium';
    return [{ ...common, severity, fp: `${severity}:${Math.round(pct / 5) * 5}`, title: `Fuel economy has dropped ${Math.round(pct)}%`,
      detail: `Your last 3 fills have a median of ${one(r)} km/L, against ${one(b)} km/L over the ${base.length} fills before them.`,
      checks: economyChecks({ ...d, odometer: d.odometer }) }];
  }
  if (pct <= -10) {
    return [{ ...common, severity: 'info', fp: 'up', title: `Fuel economy has improved ${Math.round(-pct)}%`,
      detail: `Your last 3 fills have a median of ${one(r)} km/L, up from ${one(b)} km/L before.` }];
  }
  return [{ ...common, severity: 'info', fp: 'steady', title: 'Fuel economy is steady',
    detail: `Your last 3 fills have a median of ${one(r)} km/L, in line with your usual ${one(b)} km/L.` }];
}

// ---------- spending spikes (last complete month vs the 3 months before it) ----------
const CAT_NAME = { fuel: 'Fuel', maintenance: 'Service', expense: 'Other expense', incident: 'Incident', document: 'Document' };

function spendFacts({ monthly, fuel, maintenance, expenses, incidents, docs, today }) {
  const cur = today.slice(0, 7);
  const months = [...new Set(monthly.map(m => String(m.month).slice(0, 7)))].filter(m => m < cur).sort();
  if (months.length < 4) return [];
  const last = months[months.length - 1], prior = months.slice(-4, -1);
  const amount = (m, c) => monthly.filter(x => String(x.month).slice(0, 7) === m && x.category === c).reduce((a, x) => a + Number(x.total_bdt), 0);
  const SRC = {
    fuel: { rows: fuel, date: r => r.logged_on, cost: r => Number(r.total_cost_bdt) },
    maintenance: { rows: maintenance, date: r => r.logged_on, cost: visitTotal },
    expense: { rows: expenses, date: r => r.logged_on, cost: r => Number(r.amount_bdt) },
    incident: { rows: incidents, date: r => r.occurred_on, cost: r => Number(r.repair_cost_bdt) },
    document: { rows: docs, date: r => r.issued_on ?? '', cost: r => Number(r.cost_bdt || 0) },
  };
  const out = [];
  for (const c of Object.keys(SRC)) {
    const l = amount(last, c), base = median(prior.map(m => amount(m, c)));
    const spike = l - base >= 2000 && (base === 0 ? l >= 5000 : l >= base * 1.5);
    if (!spike) continue;
    const src = SRC[c];
    const evidence = src.rows.filter(r => String(src.date(r)).slice(0, 7) === last).sort((a, b) => src.cost(b) - src.cost(a)).slice(0, 3)
      .map(r => ({ type: c, id: r.id, label: `${nice(src.date(r))}, ৳${n0(src.cost(r))}` }));
    out.push({ key: `spend:${c}:${last}`, fp: 'spike', kind: 'spend', severity: base > 0 && l >= base * 2 ? 'medium' : 'low',
      title: `${CAT_NAME[c]} spending was high in ${monthLong(last)}`,
      detail: base > 0
        ? `৳${n0(l)} against a usual ৳${n0(base)} (the median of the 3 months before), ${Math.round((l / base - 1) * 100)}% higher.`
        : `৳${n0(l)}, when the 3 months before had a median of ৳0.`,
      evidence });
  }
  return out;
}

// ---------- fuel price ----------
function priceFacts(fuel) {
  const asc = sortedFuel(fuel);
  if (!asc.length) return [];
  const latest = asc[asc.length - 1];
  const same = asc.slice(0, -1).filter(f => f.fuel_type === latest.fuel_type).slice(-5);
  if (same.length < 4) return [];
  const base = median(same.map(f => Number(f.price_per_liter))), p = Number(latest.price_per_liter);
  const pct = (p - base) / base * 100;
  if (Math.abs(pct) < 5) return [];
  const up = pct > 0, kind = latest.fuel_type === 'petrol' ? 'Petrol' : 'Octane';
  return [{ key: `price:${latest.fuel_type}`, fp: `${up ? 'up' : 'down'}${Math.round(Math.abs(pct) / 5) * 5}`, kind: 'price', severity: up ? 'low' : 'info',
    title: `${kind} price is ${up ? 'up' : 'down'} ${Math.round(Math.abs(pct))}%`,
    detail: `৳${one(p)} a litre on ${nice(latest.logged_on)}, against a usual ৳${one(base)} (the median of your last ${same.length} ${latest.fuel_type} refills).`,
    evidence: [{ type: 'fuel', id: latest.id, label: nice(latest.logged_on) }] }];
}

// ---------- data gaps and duplicates ----------
function gapFacts(fuel, today) {
  if (!fuel.length) return [];
  const latest = sortedFuel(fuel).pop(), days = diffDays(today, latest.logged_on);
  if (days <= 35) return [];
  return [{ key: 'gap:fuel', fp: String(Math.floor(days / 15)), kind: 'data', severity: 'low', title: `No refill logged for ${dayword(days)}`,
    detail: `Your last refill was on ${nice(latest.logged_on)}. Fuel economy and cost per km can't update until you log the next one. If you have refuelled since, add it.`,
    evidence: [{ type: 'fuel', id: latest.id, label: nice(latest.logged_on) }] }];
}

const NOUN = { fuel: 'refill', maintenance: 'service', expense: 'expense', incident: 'incident' };
function duplicateFacts({ fuel, maintenance, expenses, incidents }) {
  const groups = {};
  const add = (type, rows, date, cost) => rows.forEach(r => {
    const c = cost(r), dt = date(r);
    if (c > 0) (groups[`${type}|${dt}|${c}`] ??= []).push({ type, id: r.id, dt, c });
  });
  add('fuel', fuel, r => r.logged_on, r => Number(r.total_cost_bdt));
  add('maintenance', maintenance, r => r.logged_on, visitTotal);
  add('expense', expenses, r => r.logged_on, r => Number(r.amount_bdt));
  add('incident', incidents, r => r.occurred_on, r => Number(r.repair_cost_bdt));
  return Object.values(groups).filter(g => g.length > 1).map(g => ({
    key: `dup:${g[0].type}:${g[0].dt}:${g[0].c}`, fp: String(g.length), kind: 'duplicate', severity: 'low',
    title: `Possible duplicate on ${nice(g[0].dt)}`,
    detail: `${g.length} ${NOUN[g[0].type]} entries on the same day, each ৳${n0(g[0].c)}. If one was entered twice, delete the extra.`,
    evidence: g.map(x => ({ type: x.type, id: x.id, label: nice(x.dt) })),
  }));
}

// d = { today, odometer, eco, rem, docs, fuel, maintenance, expenses, incidents, monthly }
export function computeFacts(d) {
  const x = { ...d, eco: d.eco ?? [], rem: d.rem ?? [], docs: d.docs ?? [], fuel: d.fuel ?? [], maintenance: d.maintenance ?? [],
    expenses: d.expenses ?? [], incidents: d.incidents ?? [], monthly: d.monthly ?? [] };
  return [
    ...serviceFacts(x.rem, x.maintenance), ...docFacts(x.docs, x.today), ...economyFacts(x), ...spendFacts(x),
    ...priceFacts(x.fuel), ...gapFacts(x.fuel, x.today), ...duplicateFacts(x),
  ].sort((a, b) => SEV[a.severity] - SEV[b.severity] || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.title.localeCompare(b.title));
}

// ---------- feedback loop ----------
// After the owner marks the fuel-economy item done, report what the km/L did since.
export function outcomeFacts({ eco, feedback, today }) {
  const fb = (feedback ?? []).find(f => f.fact_key === 'kml' && f.status === 'done' && f.snapshot?.kml);
  if (!fb) return [];
  const since = localDay(fb.created_at);
  const fresh = eco.filter(s => String(s.end_date) > since);
  if (fresh.length < 2) return [];
  const now = median(fresh.map(s => Number(s.km_per_l))), was = Number(fb.snapshot.kml), pct = (now - was) / was * 100;
  return [{ key: 'outcome:kml', fp: String(fresh.length), kind: 'outcome', severity: 'info',
    title: pct >= 0 ? 'Fuel economy after your fix: better' : 'Fuel economy after your fix: not better yet',
    detail: `Since you marked the fuel-economy item done on ${nice(since)}, the median of ${fresh.length} new fills is ${one(now)} km/L (it was ${one(was)}, ${pct >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(pct))}%).`,
    evidence: [] }];
}

// Dismissed: hidden until the fingerprint changes. Done: hidden until it changes or 30 days pass.
export function applyFeedback(facts, feedback, today) {
  const by = Object.fromEntries((feedback ?? []).map(f => [f.fact_key, f]));
  const visible = [], hidden = [];
  for (const f of facts) {
    const fb = by[f.key];
    if (!fb) { visible.push(f); continue; }
    const since = localDay(fb.created_at);
    if (fb.fingerprint !== f.fp || (fb.status === 'done' && diffDays(today, since) >= 30)) visible.push({ ...f, reopened: true });
    else hidden.push({ ...f, status: fb.status, since });
  }
  return { visible, hidden };
}

// Feedback for situations that no longer exist is dropped, so a problem that comes back next year isn't pre-dismissed.
export const staleFeedbackKeys = (facts, feedback) =>
  (feedback ?? []).filter(f => !facts.some(x => x.key === f.fact_key)).map(f => f.fact_key);

export const countBySeverity = facts => facts.reduce((c, f) => ({ ...c, [f.severity]: (c[f.severity] || 0) + 1 }), {});
export const signature = facts => facts.map(f => `${f.key}=${f.fp}`).join('|');
export const severityRank = s => SEV[s];
