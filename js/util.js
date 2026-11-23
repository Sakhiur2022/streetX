export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const bdt = n => '৳' + Math.round(Number(n) || 0).toLocaleString('en-BD');

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// 'YYYY-MM-DD' -> parts, parsed by hand so time zones can never shift the day.
export const dateParts = iso => {
  const [y, m, d] = String(iso ?? '').split('-');
  return { y: y ?? '', m: SHORT[Number(m) - 1] ?? '', d: d ? String(Number(d)) : '' };
};
export const monthShort = ym => { const [y, m] = String(ym).split('-'); return `${SHORT[Number(m) - 1] ?? ''} ${String(y).slice(2)}`; };
export const monthLong = ym => { const [y, m] = String(ym).split('-'); return `${LONG[Number(m) - 1] ?? ''} ${y}`; };

export const niceDate = iso => { const p = dateParts(iso); return `${p.d} ${p.m} ${p.y}`; };
