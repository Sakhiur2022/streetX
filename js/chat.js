// Rendering for the Ask tab. Pure string building from the function's answer: charts and tables come from
// database results on the server, never from numbers the model typed.
import { esc, bdt, monthShort, niceDate } from './util.js';
import { sparkline } from './viz.js';

const TYPE_LABEL = { fuel: 'Fuel', maintenance: 'Service', expense: 'Expense', incident: 'Incident', document: 'Document' };
const MONTH = /^\d{4}-\d{2}$/, DAY = /^\d{4}-\d{2}-\d{2}$/;
const cap = s => s[0].toUpperCase() + s.slice(1);
const pretty = l => MONTH.test(l) ? monthShort(l) : DAY.test(l) ? niceDate(l).replace(/ \d{4}$/, '') : cap(String(l).replace(/_/g, ' '));
const show = (v, unit) => unit === '৳' ? bdt(v) : unit === 'L' ? `${Number(v).toLocaleString('en-US')} L` : unit === 'km/L' ? `${Number(v).toFixed(1)} km/L` : Number(v).toLocaleString('en-US');

function barChart(v) {
  const max = Math.max(1, ...v.points.map(p => Number(p.value) || 0));
  return `<figure class="vis"><figcaption>${esc(v.title)}</figcaption><div class="hbars">${v.points.map(p => `
    <div class="hb"><span class="hb-l">${esc(pretty(p.label))}</span><div class="hb-bar"><i style="width:${Math.max(2, (Number(p.value) || 0) / max * 100).toFixed(1)}%"></i></div><b>${esc(show(p.value, v.unit))}</b></div>`).join('')}</div></figure>`;
}

function lineChart(v) {
  const first = v.points[0], last = v.points[v.points.length - 1];
  return `<figure class="vis"><figcaption>${esc(v.title)}</figcaption>${sparkline(v.points.map(p => Number(p.value)), { w: 300, h: 88, label: v.title, unit: v.unit, digits: v.unit === 'km/L' ? 1 : 0 })}
    <div class="vaxis"><span>${esc(pretty(first.label))}: ${esc(show(first.value, v.unit))}</span><span>${esc(pretty(last.label))}: ${esc(show(last.value, v.unit))}</span></div></figure>`;
}

function tableVis(v) {
  const cell = c => (DAY.test(c) ? niceDate(c) : c);
  return `<figure class="vis"><figcaption>${esc(v.title)}</figcaption><div class="tbl"><table>
    <thead><tr>${v.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${v.rows.map((r, i) => `<tr>${r.map((c, j) => `<td>${j === 0 && v.refs?.[i] ? `<button type="button" class="link tbtn" data-ev="${esc(v.refs[i])}">${esc(cell(c))}</button>` : esc(cell(c))}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div></figure>`;
}

export const visualHtml = v => (v.kind === 'bar' ? barChart(v) : v.kind === 'line' ? lineChart(v) : v.kind === 'table' ? tableVis(v) : '');

// An answer bubble: text, any charts or tables, tappable records, and what was looked at.
export function answerHtml(m) {
  if (m.error) return `<div class="msg bot err-msg"><p>${esc(m.text)}</p></div>`;
  return `<div class="msg bot${m.verified === false ? ' unverified' : ''}">
    <span class="aitag">AI</span>
    <p>${esc(m.text)}</p>
    ${(m.visuals ?? []).map(visualHtml).join('')}
    ${m.sources?.length ? `<div class="evid"><span>Records</span>${m.sources.map(s => `<button type="button" class="chip ev" data-ev="${esc(s.type)}:${esc(s.id)}">${esc(TYPE_LABEL[s.type] ?? s.type)}, ${esc(niceDate(s.label))}</button>`).join('')}</div>` : ''}
    ${m.checked?.length ? `<p class="checked">Checked: ${m.checked.map(esc).join('; ')}</p>` : ''}
  </div>`;
}
