// Pure DOM helpers for the "Fill from invoice" feature (kept apart from app.js so they can be tested).
import { OPTS, label } from './models.js';
import { esc } from './util.js';

// One service line inside a service visit (category, details, cost, warranty).
export function itemHtml(it = {}) {
  const auto = it.category ? label(OPTS.MAINT, it.category) : '';
  return `
    <div class="item">
      <div class="row2">
        <select name="i_category">${OPTS.MAINT.map(([v, l]) => `<option value="${v}" ${v === it.category ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <input name="i_title" placeholder="Details (optional)" value="${esc(it.title && it.title !== auto ? it.title : '')}">
      </div>
      <div class="row2">
        <label class="sm">Cost (৳)<input name="i_cost" type="number" step="0.01" min="0" inputmode="decimal" value="${esc(it.cost_bdt ?? '')}"></label>
        <label class="sm">Warranty until<input name="i_warranty" type="date" value="${esc(it.warranty_until ?? '')}"></label>
        <button type="button" class="link danger" data-rm title="Remove">✕</button>
      </div>
    </div>`;
}

const RENAME = { fuel: { date: 'logged_on' }, maintenance: { date: 'logged_on' }, expense: { date: 'logged_on' }, document: {} };
const CATS = new Set(OPTS.MAINT.map(o => o[0]));

// Copy scanned values into the open form. Returns the names of fields that were filled.
// Missing or invalid values never overwrite what is already in the form.
export function applyScan(form, type, data) {
  const filled = [];
  const set = (name, v) => {
    const el = form.elements[name];
    if (!el || v == null || v === '' || el.type === 'checkbox' || el.type === 'file') return;
    if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === String(v))) return;
    if (el.type === 'number') { v = Number(v); if (!Number.isFinite(v) || v < 0) return; }
    if (el.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return;
    el.value = v;
    filled.push(name);
  };

  for (const [k, v] of Object.entries(data ?? {})) {
    if (k === 'items' || (type === 'maintenance' && k === 'total_cost_bdt')) continue;
    set(RENAME[type]?.[k] ?? k, v);
  }

  if (type === 'maintenance') {
    let items = (Array.isArray(data?.items) ? data.items : [])
      .filter(i => i && (i.title || Number(i.cost_bdt) > 0))
      .map(i => ({
        category: CATS.has(i.category) ? i.category : 'other',
        title: String(i.title ?? '').trim(),
        cost_bdt: Number.isFinite(Number(i.cost_bdt)) ? Number(i.cost_bdt) : 0,
      }));
    if (!items.length && Number(data?.total_cost_bdt) > 0) {
      items = [{ category: 'other', title: 'Service', cost_bdt: Number(data.total_cost_bdt) }];
    }
    const box = form.querySelector('#items');
    if (items.length && box) {
      box.innerHTML = items.map(itemHtml).join('');
      form.dispatchEvent(new Event('input')); // refresh the running total
      filled.push('items');
    }
  }
  return filled;
}
