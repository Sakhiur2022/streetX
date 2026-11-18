// UI layer: routing, views, and one shared form flow for every log type (Template Method).
import { db, ai } from './db.js';
import { applyScan, itemHtml } from './scan.js';
import { esc } from './util.js';
import { bus } from './events.js';
import { TYPES, OPTS, label, today, buildPayload, itemsOf } from './models.js';
import { ruleStatus, docStatus } from './strategies.js';

const $ = s => document.querySelector(s);
const bdt = n => '৳' + Math.round(Number(n) || 0).toLocaleString('en-BD');
const state = { vehicle: null };

const PAGES = [
  ['home', 'Home'], ['fuel', 'Fuel'], ['maintenance', 'Service'], ['expense', 'Expenses'],
  ['incident', 'Incidents'], ['document', 'Documents'], ['reminders', 'Reminders'], ['advice', '✨ Advice'],
];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---------- auth + first-run ----------
function showLogin() {
  $('#bar').hidden = true;
  $('#view').innerHTML = `
    <form class="card narrow" id="lf">
      <h2>Car Tracker</h2>
      <label>Email<input type="email" name="email" required autocomplete="username"></label>
      <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
      <button>Sign in</button>
      <p class="err" id="lerr"></p>
    </form>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { await db.signIn(fd.get('email'), fd.get('password')); boot(); }
    catch (err) { $('#lerr').textContent = err.message; }
  };
}

function showSetup() {
  $('#bar').hidden = true;
  $('#view').innerHTML = `
    <form class="card narrow" id="sf">
      <h2>Add your car</h2>
      <label>Nickname<input name="name" value="Fielder" required></label>
      <label>Make<input name="make" value="Toyota"></label>
      <label>Model<input name="model" value="Corolla Fielder Hybrid"></label>
      <label>Year<input name="year" type="number" value="2017"></label>
      <label>Plate<input name="plate"></label>
      <button>Create</button>
      <p class="err" id="serr"></p>
    </form>`;
  $('#sf').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await db.createVehicle({
        name: fd.get('name'), make: fd.get('make') || null, model: fd.get('model') || null,
        year: fd.get('year') ? Number(fd.get('year')) : null, plate: fd.get('plate') || null,
      });
      boot();
    } catch (err) { $('#serr').textContent = err.message; }
  };
}

// ---------- routing ----------
async function route() {
  if (!state.vehicle) return;
  const page = location.hash.slice(1) || 'home';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.p === page));
  const view = $('#view');
  try {
    if (page === 'home') await viewHome(view);
    else if (page === 'reminders') await viewReminders(view);
    else if (page === 'advice') await viewAdvice(view);
    else if (TYPES[page]) await viewLog(view, page);
    else location.hash = 'home';
  } catch (e) { view.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

// ---------- views ----------
async function viewHome(view) {
  const v = state.vehicle.id;
  const [odo, eco, rem, monthly, docs, first] = await Promise.all([
    db.odometer(v), db.fuelEconomy(v), db.reminders(v), db.monthly(v), db.list('document', v, 200), db.firstOdometer(v),
  ]);

  const km = eco.reduce((a, r) => a + Number(r.km), 0);
  const liters = eco.reduce((a, r) => a + Number(r.liters), 0);
  const avg = liters ? (km / liters).toFixed(1) : '–';
  const last = eco[0]?.km_per_l ?? '–';
  const thisMonth = today().slice(0, 7) + '-01';
  const mTotal = monthly.filter(m => m.month === thisMonth).reduce((a, m) => a + Number(m.total_bdt), 0);
  const allTotal = monthly.reduce((a, m) => a + Number(m.total_bdt), 0);
  const perKm = first != null && odo > first ? (allTotal / (odo - first)).toFixed(1) : '–';

  // Documents: latest of each type. Tax token and fitness always shown, even if not logged yet.
  const latest = {};
  docs.forEach(d => { latest[d.doc_type] ??= d; }); // list is sorted by expiry, newest first
  const docRows = OPTS.DOCS.map(o => o[0])
    .filter(k => latest[k] || k === 'tax_token' || k === 'fitness')
    .map(k => {
      const d = latest[k];
      if (!d) return `<li class="never"><span>${label(OPTS.DOCS, k)}</span><span class="mut">Not logged</span></li>`;
      const s = docStatus(d);
      return `<li class="${s.level}"><span>${label(OPTS.DOCS, k)}</span><span>${esc(s.text)}</span></li>`;
    }).join('');

  const due = rem.map(r => ({ r, s: ruleStatus(r) })).filter(x => x.s.level !== 'ok').sort((a, b) => a.s.rank - b.s.rank);
  const dueRows = due.map(({ r, s }) =>
    `<li class="${s.level}"><span>${esc(r.title)}</span><span>${esc(s.text)}</span></li>`).join('');

  const months = [...new Set(monthly.map(m => m.month))].slice(0, 6);
  const cats = [['fuel', 'Fuel'], ['maintenance', 'Service'], ['expense', 'Other'], ['incident', 'Incidents'], ['document', 'Docs']];
  const cell = (m, c) => monthly.filter(x => x.month === m && x.category === c).reduce((a, x) => a + Number(x.total_bdt), 0);

  view.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${Number(odo).toLocaleString()} km</b><span>Odometer</span></div>
      <div class="stat"><b>${last}</b><span>Last km/L</span></div>
      <div class="stat"><b>${avg}</b><span>Average km/L</span></div>
      <div class="stat"><b>${bdt(mTotal)}</b><span>This month</span></div>
      <div class="stat"><b>${perKm === '–' ? '–' : '৳' + perKm}</b><span>All-in per km</span></div>
    </div>
    <div class="row">
      ${['fuel', 'maintenance', 'expense', 'incident', 'document'].map(t => `<button data-add="${t}">${TYPES[t].icon} ${TYPES[t].title}</button>`).join('')}
    </div>
    <h2>Documents</h2>
    <ul class="list">${docRows}</ul>
    <h2>Service due</h2>
    ${dueRows ? `<ul class="list">${dueRows}</ul>` : '<p class="mut">Nothing due.</p>'}
    <h2>Monthly spend</h2>
    <div class="tbl"><table>
      <thead><tr><th>Month</th>${cats.map(c => `<th>${c[1]}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody>${months.map(m => `<tr><td>${m.slice(0, 7)}</td>${cats.map(c => `<td>${bdt(cell(m, c[0]))}</td>`).join('')}<td><b>${bdt(cats.reduce((a, c) => a + cell(m, c[0]), 0))}</b></td></tr>`).join('') || '<tr><td colspan="7" class="mut">No data yet.</td></tr>'}</tbody>
    </table></div>`;
  view.querySelectorAll('[data-add]').forEach(b => b.onclick = () => openForm(b.dataset.add));
}

async function viewLog(view, type) {
  const t = TYPES[type], v = state.vehicle.id;
  const [rows, att] = await Promise.all([db.list(type, v), db.attachmentMap(v, type)]);
  const total = rows.reduce((a, r) => a + Number(t.cost(r) || 0), 0);

  view.innerHTML = `
    <div class="head"><h2>${t.icon} ${t.title}</h2>
      <div class="row"><button class="ghost" id="csv">CSV</button><button id="add">+ Add</button></div></div>
    <p class="mut">${rows.length} entries · ${bdt(total)}</p>
    <div class="tbl"><table>
      <thead><tr>${t.cols.map(c => `<th>${esc(c[0])}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.map(r => `<tr>${t.cols.map(c => `<td${c[2] ? ` class="${c[2]}"` : ''}>${esc(c[1](r))}</td>`).join('')}
        <td class="act">${att[r.id] ? `<button class="link" data-att="${r.id}">📎${att[r.id].length}</button>` : ''}<button class="link" data-edit="${r.id}">✎</button><button class="link danger" data-del="${r.id}">✕</button></td></tr>`).join('')
        || '<tr><td colspan="9" class="mut">No entries yet.</td></tr>'}</tbody>
    </table></div>`;

  $('#add').onclick = () => openForm(type);
  $('#csv').onclick = () => exportCsv(type, rows);
  view.querySelectorAll('[data-att]').forEach(b => b.onclick = () => showFiles(att[b.dataset.att]));
  view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openForm(type, rows.find(r => r.id === b.dataset.edit)));
  view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this entry and its files?')) return;
    try { await db.remove(type, rows.find(r => r.id === b.dataset.del)); toast('Deleted'); }
    catch (e) { toast(e.message); }
  });
}

async function viewReminders(view) {
  const v = state.vehicle.id;
  const [rules, status] = await Promise.all([db.rules(v), db.reminders(v)]);
  const st = Object.fromEntries(status.map(s => [s.rule_id, ruleStatus(s)]));
  view.innerHTML = `
    <h2>⏰ Service intervals</h2>
    <p class="mut">Counted from the last matching Service entry. Edit a value to change it.</p>
    <div class="tbl"><table>
      <thead><tr><th>Item</th><th>Status</th><th>Every km</th><th>Every days</th><th>On</th></tr></thead>
      <tbody>${rules.map(r => `<tr>
        <td>${esc(r.title)}</td>
        <td class="${st[r.id]?.level ?? 'never'}">${esc(st[r.id]?.text ?? 'Off')}</td>
        <td><input type="number" min="1" data-r="${r.id}" data-f="every_km" value="${r.every_km ?? ''}"></td>
        <td><input type="number" min="1" data-r="${r.id}" data-f="every_days" value="${r.every_days ?? ''}"></td>
        <td><input type="checkbox" data-r="${r.id}" data-f="active" ${r.active ? 'checked' : ''}></td></tr>`).join('')}</tbody>
    </table></div>`;
  view.querySelectorAll('[data-r]').forEach(el => el.onchange = async () => {
    const val = el.type === 'checkbox' ? el.checked : (el.value === '' ? null : Number(el.value));
    try { await db.updateRule(el.dataset.r, { [el.dataset.f]: val }); toast('Updated'); }
    catch (e) { toast(e.message); }
    route();
  });
}

// ---------- advice (Gemini) ----------
const LEVEL = { high: 'overdue', medium: 'soon', low: 'ok' };

// Only totals and history go to Gemini: no plate, email, photos or notes.
async function buildAdviceInput() {
  const v = state.vehicle.id;
  const [odo, eco, rem, monthly, docs, fuel, incidents] = await Promise.all([
    db.odometer(v), db.fuelEconomy(v), db.reminders(v), db.monthly(v),
    db.list('document', v, 50), db.list('fuel', v, 40), db.list('incident', v, 30),
  ]);
  const months = [...new Set(monthly.map(m => m.month))].slice(0, 6);
  const spend = months.map(m => ({
    month: m.slice(0, 7),
    ...Object.fromEntries(monthly.filter(x => x.month === m).map(x => [x.category, Math.round(Number(x.total_bdt))])),
  }));
  const asc = [...fuel].reverse();
  const first = asc[0], last = asc[asc.length - 1];
  const span = first && last ? (new Date(last.logged_on) - new Date(first.logged_on)) / 864e5 : 0;
  return {
    today: today(),
    car: { make: state.vehicle.make, model: state.vehicle.model, year: state.vehicle.year },
    odometer_km: odo,
    avg_km_per_month: span >= 30 ? Math.round((last.odometer_km - first.odometer_km) / span * 30) : null,
    km_per_l_recent: eco.slice(0, 12).map(r => ({ date: r.end_date, km_per_l: Number(r.km_per_l), km: r.km })),
    fuel_price_per_l_recent: fuel.slice(0, 12).map(r => ({ date: r.logged_on, bdt: Number(r.price_per_liter), type: r.fuel_type })),
    monthly_spend_bdt: spend,
    service_status: rem.map(r => ({ item: r.title, last_done_km: r.last_odometer_km, last_done_on: r.last_done_on, status: ruleStatus(r).text })),
    documents: docs.slice(0, 10).map(d => ({ type: d.doc_type, expires_on: d.expires_on, status: docStatus(d).when })),
    incidents_recent: incidents.slice(0, 10).map(i => ({ date: i.occurred_on, what: String(i.description).slice(0, 120), repair_bdt: Number(i.repair_cost_bdt) })),
  };
}

function renderAdvice(r) {
  const list = arr => `<ul class="list">${arr.map(a =>
    `<li class="${LEVEL[a.level] ?? 'never'}"><span><b>${esc(a.title)}</b><br><span class="mut">${esc(a.detail)}</span></span></li>`).join('')}</ul>`;
  return `<p>${esc(r.summary)}</p>
    ${r.alerts.length ? `<h2>Needs attention</h2>${list(r.alerts)}` : ''}
    ${r.savings.length ? `<h2>Ways to spend less</h2>${list(r.savings.map(s => ({ ...s, level: 'low' })))}` : ''}
    ${r.anomalies.length ? `<h2>Odd things in your data</h2>${list(r.anomalies.map(s => ({ ...s, level: 'medium' })))}` : ''}
    <p class="mut">Generated ${esc(r.at)}</p>`;
}

async function viewAdvice(view) {
  view.innerHTML = `
    <h2>✨ Advice</h2>
    <p class="mut">Sends only totals and service history to Gemini. It is not a mechanic: confirm anything safety-related with your workshop.</p>
    <div class="row"><button id="run">Analyse my car</button></div>
    <div id="out"></div>`;
  const out = $('#out');
  if (state.advice) out.innerHTML = renderAdvice(state.advice); // kept in memory so tab switches don't spend quota
  $('#run').onclick = async () => {
    const btn = $('#run');
    btn.disabled = true;
    btn.textContent = 'Analysing…';
    try {
      const r = await ai.advice(await buildAdviceInput());
      state.advice = { ...r, at: new Date().toLocaleString() };
      out.innerHTML = renderAdvice(state.advice);
    } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    finally { btn.disabled = false; btn.textContent = 'Analyse my car'; }
  };
}

// ---------- shared form flow: render -> validate -> save -> upload -> notify ----------
function fieldHtml(f, ctx, row) {
  const def = row ? row[f.name] : (typeof f.default === 'function' ? f.default(ctx) : f.default);
  const req = f.required ? 'required' : '';
  const lbl = esc(f.label);
  if (f.type === 'select') {
    return `<label>${lbl}<select name="${f.name}" ${req}>${f.options.map(([v, l]) => `<option value="${v}" ${v === def ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  }
  if (f.type === 'textarea') return `<label>${lbl}<textarea name="${f.name}" rows="2" ${req}>${esc(row ? (def ?? '') : '')}</textarea></label>`;
  if (f.type === 'checkbox') return `<label class="chk"><input type="checkbox" name="${f.name}" ${def ? 'checked' : ''}> ${lbl}</label>`;
  const num = f.type === 'number' ? `step="${f.step ?? 'any'}" min="0" inputmode="${f.step === 1 ? 'numeric' : 'decimal'}"` : '';
  return `<label>${lbl}<input type="${f.type}" name="${f.name}" value="${esc(def ?? '')}" ${num} ${req}></label>`;
}

function collectItems(form) {
  return [...form.querySelectorAll('.item')].map(el => {
    const g = n => el.querySelector(`[name="${n}"]`).value;
    const category = g('i_category');
    return {
      category, title: g('i_title').trim() || label(OPTS.MAINT, category),
      cost_bdt: Number(g('i_cost') || 0), warranty_until: g('i_warranty') || null,
    };
  });
}

async function openForm(type, row = null) {
  const t = TYPES[type], dlg = $('#dlg');
  const ctx = { odometer: row ? 0 : await db.odometer(state.vehicle.id) };
  const items = t.items ? (row && itemsOf(row).length ? itemsOf(row) : [{}]) : [];
  const itemsBlock = t.items
    ? `<h3>Services done</h3><div id="items">${items.map(itemHtml).join('')}</div>
       <div class="row"><button type="button" class="ghost" id="addItem">+ Add another service</button></div>
       <p class="total" id="itotal"></p>`
    : '';
  dlg.innerHTML = `
    <form id="f">
      <h3>${t.icon} ${row ? 'Edit' : 'Add'} ${esc(t.title)}</h3>
      ${t.fields.map(f => (f.name === t.itemsBefore ? itemsBlock : '') + fieldHtml(f, ctx, row)).join('')}
      ${t.attach ? `<label>${row ? 'Add more invoice photos / PDF' : 'Invoice photos / PDF'}<input type="file" name="_files" accept="image/*,application/pdf" multiple></label>` : ''}
      ${t.scan ? '<div class="row"><button type="button" class="ghost" id="scan">✨ Fill from invoice</button></div>' : ''}
      <div class="row"><button type="button" class="ghost" id="cancel">Cancel</button><button id="save">Save</button></div>
      <p class="err" id="ferr"></p>
    </form>`;
  const form = $('#f');
  $('#cancel').onclick = () => dlg.close();

  if (t.items) {
    const refresh = () => {
      const sum = [...form.querySelectorAll('[name="i_cost"]')].reduce((a, el) => a + Number(el.value || 0), 0);
      $('#itotal').textContent = `Total ৳${sum.toLocaleString('en-BD')}`;
    };
    refresh();
    form.addEventListener('input', refresh);
    $('#addItem').onclick = () => $('#items').insertAdjacentHTML('beforeend', itemHtml());
    form.addEventListener('click', e => {
      if (!e.target.matches('[data-rm]')) return;
      const item = e.target.closest('.item');
      if (form.querySelectorAll('.item').length > 1) item.remove();
      else item.querySelectorAll('input').forEach(i => { i.value = ''; }); // keep at least one line
      refresh();
    });
  }

  if (t.scan) {
    $('#scan').onclick = async () => {
      const file = form.elements['_files'].files[0];
      if (!file) return toast('Choose an invoice photo first');
      const btn = $('#scan');
      btn.disabled = true;
      btn.textContent = 'Scanning…';
      $('#ferr').textContent = '';
      try {
        const filled = applyScan(form, type, await ai.extract(type, file));
        toast(filled.length ? 'Filled from invoice. Check every value before saving.' : 'Nothing readable found on that image');
      } catch (e) { $('#ferr').textContent = e.message; }
      finally { btn.disabled = false; btn.textContent = '✨ Fill from invoice'; }
    };
  }

  form.onsubmit = async e => {
    e.preventDefault();
    const btn = $('#save');
    btn.disabled = true;
    try {
      const fd = new FormData(form);
      const files = fd.getAll('_files').filter(x => x.size);
      const payload = buildPayload(type, fd, state.vehicle.id, !!row);
      const { uploadError } = await db.save(type, { id: row?.id, payload, items: t.items ? collectItems(form) : [], files });
      dlg.close();
      toast(uploadError ? `Saved, but upload failed: ${uploadError.message}` : 'Saved');
    } catch (err) {
      $('#ferr').textContent = err.message;
      btn.disabled = false;
    }
  };
  dlg.showModal();
}

async function showFiles(paths) {
  const dlg = $('#dlg');
  try {
    const items = await db.signedUrls(paths);
    dlg.innerHTML = `<div class="files">${items.map((d, i) => {
      const p = d.path ?? paths[i];
      const shown = /\.pdf$/i.test(p)
        ? `<a href="${esc(d.signedUrl)}" target="_blank" rel="noopener">Open PDF ${i + 1}</a>`
        : `<a href="${esc(d.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(d.signedUrl)}" alt="Invoice ${i + 1}"></a>`;
      return `<div>${shown}<button class="link danger" data-rmf="${esc(p)}">Remove file</button></div>`;
    }).join('')}</div>
      <div class="row"><button class="ghost" id="cancel">Close</button></div>`;
    $('#cancel').onclick = () => dlg.close();
    dlg.querySelectorAll('[data-rmf]').forEach(b => b.onclick = async () => {
      if (!confirm('Remove this file?')) return;
      try { await db.removeFile(b.dataset.rmf); dlg.close(); toast('File removed'); }
      catch (e) { toast(e.message); }
    });
    dlg.showModal();
  } catch (e) { toast(e.message); }
}

function exportCsv(type, rows) {
  // Service visits export one line per service.
  const data = TYPES[type].items
    ? rows.flatMap(r => itemsOf(r).map(i => ({
        logged_on: r.logged_on, odometer_km: r.odometer_km, vendor: r.vendor,
        category: i.category, title: i.title, cost_bdt: i.cost_bdt, warranty_until: i.warranty_until, notes: r.notes,
      })))
    : rows;
  if (!data.length) return toast('Nothing to export');
  const keys = Object.keys(data[0]);
  const cell = v => `"${String(v !== null && typeof v === 'object' ? JSON.stringify(v) : v ?? '').replace(/"/g, '""')}"`;
  const csv = '\uFEFF' + [keys.join(','), ...data.map(r => keys.map(k => cell(r[k])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${TYPES[type].table}-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- boot ----------
async function boot() {
  const s = await db.session();
  if (!s) return showLogin();
  state.vehicle = await db.vehicle();
  if (!state.vehicle) return showSetup();
  $('#bar').hidden = false;
  $('#vname').textContent = state.vehicle.name;
  $('#nav').innerHTML = PAGES.map(([p, l]) => `<a href="#${p}" data-p="${p}">${l}</a>`).join('');
  route();
}

$('#logout').onclick = () => db.signOut();
db.onAuth(evt => { if (evt === 'SIGNED_OUT') location.reload(); });
window.addEventListener('hashchange', route);
bus.on('data:changed', route);
boot().catch(e => { $('#view').innerHTML = `<p class="err">${esc(e.message)}</p>`; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
