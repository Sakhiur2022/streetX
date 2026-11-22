// Instrument-cluster pieces: gauge dial, odometer drums, sparkline, stacked spend bars.
// All functions return HTML/SVG strings. Colours come from CSS classes, not from here.
import { esc, monthShort } from './util.js';

const CX = 100, CY = 100;
const f = n => n.toFixed(1);
// t runs 0..1 from the left end of the dial, over the top, to the right end.
const pt = (t, r) => { const a = Math.PI * (1 - t); return [CX + r * Math.cos(a), CY - r * Math.sin(a)]; };
const arc = (t0, t1, r) => {
  const [x0, y0] = pt(t0, r), [x1, y1] = pt(t1, r);
  return `M${f(x0)} ${f(y0)}A${r} ${r} 0 0 1 ${f(x1)} ${f(y1)}`;
};

// value=null parks the needle at the left stop. zones: [[from, to, 'z-red'], ...] as 0..1 fractions.
// labels: [{ v, text }] placed inside the ticks, v in value units.
export function gauge({ value, min = 0, max = 1, display = '–', unit = '', title = '', zones = [], labels = [] }) {
  const span = max - min || 1;
  const t = value == null || !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, (value - min) / span));
  const deg = -90 + 180 * t;

  let ticks = '';
  for (let i = 0; i <= 40; i++) {
    const u = i / 40, major = i % 4 === 0;
    const [x0, y0] = pt(u, 74), [x1, y1] = pt(u, major ? 60 : 67);
    ticks += `<line class="g-tick${major ? ' maj' : ''}" x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}"/>`;
  }
  const zs = zones.map(([a, b, c]) => `<path class="g-zone ${c}" d="${arc(a, b, 80)}"/>`).join('');
  const nums = labels.map(l => {
    const [x, y] = pt((l.v - min) / span, 46);
    return `<text class="g-num" x="${f(x)}" y="${f(y + 3)}">${esc(l.text)}</text>`;
  }).join('');

  return `<svg class="gauge" viewBox="0 0 200 134" role="img" aria-label="${esc(title)}: ${esc(display)} ${esc(unit)}">
    <path class="g-face" d="M4 100A96 96 0 0 1 196 100V118a12 12 0 0 1-12 12H16a12 12 0 0 1-12-12Z"/>
    <path class="g-track" d="${arc(0, 1, 80)}"/>${zs}${ticks}${nums}
    <g class="g-needle" style="--to:${deg.toFixed(1)}deg"><path d="M97.5 100L100 30L102.5 100Z"/></g>
    <circle class="g-hub" cx="100" cy="100" r="8"/><circle class="g-pin" cx="100" cy="100" r="2.5"/>
    <text class="g-val" x="100" y="124">${esc(display)}</text>
  </svg>`;
}

// Mechanical odometer: dark drums, last digit inverted like a real tenths wheel.
export function odometer(km, digits = 6) {
  const n = Math.max(0, Math.round(Number(km) || 0));
  const s = String(n).padStart(digits, '0').slice(-digits);
  return `<div class="odo" role="img" aria-label="Odometer: ${n.toLocaleString('en-US')} kilometres">${
    [...s].map(d => `<span class="drum" aria-hidden="true">${d}</span>`).join('')
  }<span class="odo-unit" aria-hidden="true">km</span></div>`;
}

// values: oldest -> newest. Returns '' when there is nothing to draw.
export function sparkline(values, { w = 300, h = 64, label = 'Trend', unit = '', digits = 1 } = {}) {
  if (values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values), pad = 8;
  const x = i => pad + i * (w - 2 * pad) / (values.length - 1);
  const y = v => (max === min ? h / 2 : h - pad - (v - min) * (h - 2 * pad) / (max - min));
  const pts = values.map((v, i) => `${f(x(i))},${f(y(v))}`);
  const lastX = x(values.length - 1), lastY = y(values[values.length - 1]);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}, latest ${values[values.length - 1].toFixed(digits)} ${esc(unit)}">
    <polygon class="spark-area" points="${f(pad)},${h - pad} ${pts.join(' ')} ${f(lastX)},${h - pad}"/>
    <polyline class="spark-line" points="${pts.join(' ')}"/>
    <circle class="spark-dot" cx="${f(lastX)}" cy="${f(lastY)}" r="4.5"/>
  </svg>`;
}

// rows: [{ month:'2026-10', fuel: 4200, ... }]  cats: [[key, label], ...]
export function spendBars(rows, cats, fmt) {
  const totals = rows.map(r => cats.reduce((a, [k]) => a + (r[k] || 0), 0));
  const max = Math.max(1, ...totals);
  const bars = rows.map((r, i) => `
    <div class="spend-row">
      <span class="spend-m">${monthShort(r.month)}</span>
      <div class="spend-bar" style="width:${Math.max(3, totals[i] / max * 100).toFixed(1)}%">${
        cats.map(([k, l]) => (r[k] ? `<i class="c-${k}" style="flex:${r[k]}" title="${esc(l)}"></i>` : '')).join('')
      }</div>
      <b class="spend-t">${fmt(totals[i])}</b>
    </div>`).join('');
  const legend = cats.map(([k, l]) => `<span><i class="c-${k}"></i>${esc(l)}</span>`).join('');
  return `<div class="spend">${bars}</div><div class="legend">${legend}</div>`;
}
