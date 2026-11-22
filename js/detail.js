// Detail sheet for one list entry: full fields, services, invoice-photo slot, and history of the same item.
// Pure string building (no DOM, no network) so it can be tested on its own.
import { TYPES, OPTS, label, itemsOf } from './models.js';
import { esc, bdt, dateParts } from './util.js';
import { sparkline } from './viz.js';

const nice = iso => { const p = dateParts(iso); return `${p.d} ${p.m} ${p.y}`; };
const longDate = iso => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const km = n => `${Number(n).toLocaleString('en-US')} km`;
const gapDays = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
const has = v => v !== null && v !== undefined && v !== '';
const cap = s => (has(s) ? s[0].toUpperCase() + s.slice(1) : s);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const FIELDS = {
  fuel: r => [
    ['Fuel', r.fuel_type === 'petrol' ? 'Petrol' : 'Octane'], ['Liters', `${r.liters} L`], ['Total cost', bdt(r.total_cost_bdt)],
    ['Price per litre', `৳${Number(r.price_per_liter)}`], ['Odometer', km(r.odometer_km)],
    ['Tank', r.is_full_tank ? 'Filled to full' : 'Partial fill'], ['Station', r.station], ['Notes', r.notes],
  ],
  maintenance: r => [['Workshop', r.vendor], ['Odometer', km(r.odometer_km)], ['Notes', r.notes]],
  expense: r => [
    ['Category', label(OPTS.EXP, r.category)], ['Amount', bdt(r.amount_bdt)],
    ['Odometer', has(r.odometer_km) ? km(r.odometer_km) : null], ['Notes', r.notes],
  ],
  incident: r => [
    ['Location', r.location], ['What happened', r.description], ['Repair cost', bdt(r.repair_cost_bdt)],
    ['Insurance claim', cap(r.claim_status)], ['Odometer', has(r.odometer_km) ? km(r.odometer_km) : null], ['Notes', r.notes],
  ],
  document: r => [
    ['Document', label(OPTS.DOCS, r.doc_type)], ['Issued', has(r.issued_on) ? nice(r.issued_on) : null],
    ['Expires', nice(r.expires_on)], ['Cost', has(r.cost_bdt) ? bdt(r.cost_bdt) : null], ['Notes', r.notes],
  ],
};

const li = (iso, text, amount) =>
  `<li><div><b>${esc(nice(iso))}</b><span>${esc(text)}</span></div>${has(amount) ? `<span class="hamt">${bdt(amount)}</span>` : ''}</li>`;
const list = items => (items.length ? `<ul class="hist">${items.join('')}</ul>` : '');

// Entries in time order, and the ones before this entry (most recent first).
function around(type, row, rows) {
  const asc = [...rows].sort(TYPES[type].sorts.find(s => s.key === 'oldest').cmp);
  const idx = asc.findIndex(r => r.id === row.id);
  return { asc, idx, before: asc.slice(0, Math.max(idx, 0)).reverse() };
}

const trend = (series, opts, caption) =>
  series.length > 1 ? `<div class="trend">${sparkline(series, { w: 300, h: 56, ...opts })}<p class="mut">${esc(caption)}</p></div>` : '';

const HISTORY = {
  fuel(row, rows) {
    const { asc, idx, before } = around('fuel', row, rows);
    const ppl = r => Number(r.price_per_liter);
    const series = asc.slice(Math.max(0, idx - 11), idx + 1).map(ppl);
    const prev = before[0], recent = before.slice(0, 10);
    const avg = recent.length ? recent.reduce((a, r) => a + ppl(r), 0) / recent.length : null;
    const d = prev ? ppl(row) - ppl(prev) : null;
    const move = d === null ? 'First refill logged.'
      : Math.abs(d) < 0.005 ? `Same price per litre as the previous refill (${nice(prev.logged_on)}).`
      : `${d > 0 ? 'Up' : 'Down'} ৳${Math.abs(d).toFixed(1)} a litre from the previous refill (${nice(prev.logged_on)}).`;
    return `${trend(series, { label: 'Price per litre trend', unit: 'taka', digits: 0 }, `Price per litre, last ${series.length} refills.`)}
      <p class="hnote">${esc(move)}${avg !== null && recent.length > 1 ? ` Average of the previous ${recent.length}: ৳${avg.toFixed(1)}.` : ''}</p>
      ${before.length ? `<h4>Previous refills</h4>${list(before.slice(0, 5).map(r => li(r.logged_on, `${r.liters} L at ৳${ppl(r)}`, r.total_cost_bdt)))}` : ''}`;
  },

  maintenance(row, rows) {
    const { before } = around('maintenance', row, rows);
    return itemsOf(row).map(it => {
      const name = label(OPTS.MAINT, it.category);
      const prevs = before.flatMap(v => itemsOf(v).filter(i => i.category === it.category).map(i => ({ v, i }))).slice(0, 4);
      if (!prevs.length) return `<div class="hgroup"><h4>${esc(name)}</h4><p class="hnote">First time this was logged.</p></div>`;
      const p = prevs[0].v, dk = Number(row.odometer_km) - Number(p.odometer_km), dd = gapDays(row.logged_on, p.logged_on);
      const gap = [dk >= 0 ? km(dk) : null, dd >= 0 ? plural(dd, 'day') : null].filter(Boolean).join(' and ');
      return `<div class="hgroup"><h4>${esc(name)}</h4>${gap ? `<p class="hnote">${esc(gap)} since the previous one.</p>` : ''}
        ${list(prevs.map(({ v, i }) => li(v.logged_on, `${km(v.odometer_km)}${v.vendor ? `, ${v.vendor}` : ''}`, i.cost_bdt)))}</div>`;
    }).join('');
  },

  expense(row, rows) {
    const { before } = around('expense', row, rows);
    const same = rows.filter(r => r.category === row.category);
    const total = same.reduce((a, r) => a + Number(r.amount_bdt || 0), 0);
    const prev = before.filter(r => r.category === row.category).slice(0, 5);
    return `<p class="hnote">${plural(same.length, 'entry', 'entries')} in ${esc(label(OPTS.EXP, row.category).toLowerCase())}, ${bdt(total)} in total.</p>
      ${list(prev.map(r => li(r.logged_on, r.notes || label(OPTS.EXP, r.category), r.amount_bdt)))}`;
  },

  incident(row, rows) {
    const { before } = around('incident', row, rows);
    const total = rows.reduce((a, r) => a + Number(r.repair_cost_bdt || 0), 0);
    return `<p class="hnote">${plural(rows.length, 'incident')} logged, ${bdt(total)} in repairs.</p>
      ${list(before.slice(0, 5).map(r => li(r.occurred_on, String(r.description).slice(0, 80), r.repair_cost_bdt)))}`;
  },

  document(row, rows) {
    const { asc, idx, before } = around('document', row, rows.filter(r => r.doc_type === row.doc_type));
    const costs = asc.slice(Math.max(0, idx - 7), idx + 1).map(r => r.cost_bdt).filter(has).map(Number);
    return `${trend(costs, { label: 'Renewal cost trend', unit: 'taka', digits: 0 }, `Renewal cost, last ${costs.length} renewals.`)}
      ${before.length ? list(before.slice(0, 5).map(r => li(r.expires_on, `Expiry${r.issued_on ? `, issued ${nice(r.issued_on)}` : ''}`, r.cost_bdt)))
        : '<p class="hnote">First time this was logged.</p>'}`;
  },
};

function servicesHtml(row) {
  return `<h3 class="sub">Services done</h3><ul class="lines big">${itemsOf(row).map(i => {
    const cat = label(OPTS.MAINT, i.category);
    const small = [i.title !== cat ? cat : null, i.warranty_until ? `warranty until ${nice(i.warranty_until)}` : null].filter(Boolean).join(', ');
    return `<li><span>${esc(i.title)}${small ? `<small>${esc(small)}</small>` : ''}</span><span>${bdt(i.cost_bdt)}</span></li>`;
  }).join('')}</ul>`;
}

// rows = every entry of this type (the history is worked out from them, no extra queries).
export function detailHtml(type, row, rows, nPhotos = 0) {
  const t = TYPES[type], c = t.card(row);
  const fields = FIELDS[type](row).filter(([, v]) => has(v));
  return `
    <article class="detail">
      <header class="dhead">
        <div>
          <h2 class="dtitle">${esc(c.title)}</h2>
          <p class="dsub">${esc(longDate(row[t.dateField]))}${t.dateLabel ? ` (${esc(t.dateLabel.toLowerCase())})` : ''}</p>
          ${c.tag ? `<span class="stamp ${c.tag.level}">${esc(c.tag.text)}</span>` : ''}
        </div>
        ${has(c.amount) ? `<span class="amt">${bdt(c.amount)}</span>` : ''}
      </header>
      <dl class="dl">${fields.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${type === 'maintenance' ? servicesHtml(row) : ''}
      ${nPhotos ? `<h3 class="sub">Invoice ${nPhotos > 1 ? 'photos' : 'photo'}</h3><div class="photos" id="photos"><p class="mut">Loading…</p></div>` : ''}
      <h3 class="sub">History</h3>
      ${HISTORY[type](row, rows)}
    </article>
    <div class="fbar one"><button type="button" class="ghost" id="cancel">Close</button></div>`;
}
