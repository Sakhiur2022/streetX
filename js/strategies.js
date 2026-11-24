// Document status (tax token, fitness, insurance). Service due dates live in usage.js.
import { dateParts } from './util.js';

const DAY = 864e5;
const n0 = v => Number(v).toLocaleString('en-US');
const days = v => `${n0(v)} ${v === 1 ? 'day' : 'days'}`;
const nice = iso => { const p = dateParts(iso); return `${p.d} ${p.m} ${p.y}`; };

export const daysUntil = iso =>
  Math.round((new Date(iso + 'T00:00:00') - new Date(new Date().toDateString())) / DAY);

const RANK = { overdue: 0, soon: 1, never: 2, ok: 3 };

// Row from the documents table (tax token, fitness, insurance...). Warns 30 days ahead.
export function docStatus(d) {
  const n = daysUntil(d.expires_on);
  const level = n < 0 ? 'overdue' : n <= 30 ? 'soon' : 'ok';
  const when = n < 0 ? `expired ${days(-n)} ago` : `${days(n)} left`;
  const text = n < 0 ? `Expired ${nice(d.expires_on)} (${days(-n)} ago)` : `Expires ${nice(d.expires_on)} (${days(n)} left)`;
  return { level, when, text, rank: RANK[level] };
}
