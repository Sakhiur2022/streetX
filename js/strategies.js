// Strategy: each measure (km, days) judges "how close is this due" on its own.
// Add a new measure (e.g. engine hours) by adding one function to `strategies`.
import { dateParts } from './util.js';

const DAY = 864e5;
const n0 = v => Number(v).toLocaleString('en-US');
const days = v => `${n0(v)} ${v === 1 ? 'day' : 'days'}`;
const nice = iso => { const p = dateParts(iso); return `${p.d} ${p.m} ${p.y}`; };

export const daysUntil = iso =>
  Math.round((new Date(iso + 'T00:00:00') - new Date(new Date().toDateString())) / DAY);

const byKm = r => r.km_remaining == null ? null : {
  v: r.km_remaining, soon: 500,
  txt: v => v < 0 ? `${n0(-v)} km overdue` : `${n0(v)} km left`,
};
const byDays = r => r.days_remaining == null ? null : {
  v: r.days_remaining, soon: 14,
  txt: v => v < 0 ? `${days(-v)} overdue` : `${days(v)} left`,
};
const strategies = [byKm, byDays];

const RANK = { overdue: 0, soon: 1, never: 2, ok: 3 };

// Row from the reminder_status view.
export function ruleStatus(r) {
  const parts = strategies.map(s => s(r)).filter(Boolean);
  if (!parts.length) return { level: 'never', text: 'Never logged', rank: RANK.never };
  const level = parts.some(p => p.v < 0) ? 'overdue' : parts.some(p => p.v <= p.soon) ? 'soon' : 'ok';
  const text = parts.map(p => p.txt(p.v)).join(', ');
  return { level, text: text[0].toUpperCase() + text.slice(1), rank: RANK[level] };
}

// Row from the documents table (tax token, fitness, insurance...). Warns 30 days ahead.
export function docStatus(d) {
  const n = daysUntil(d.expires_on);
  const level = n < 0 ? 'overdue' : n <= 30 ? 'soon' : 'ok';
  const when = n < 0 ? `expired ${days(-n)} ago` : `${days(n)} left`;
  const text = n < 0 ? `Expired ${nice(d.expires_on)} (${days(-n)} ago)` : `Expires ${nice(d.expires_on)} (${days(n)} left)`;
  return { level, when, text, rank: RANK[level] };
}
