// UI layer: routing, views, and one shared form flow for every log type (Template Method).
import { db, ai } from './db.js';
import { bus } from './events.js';
import { TYPES, OPTS, label, today, buildPayload, itemsOf } from './models.js';
import { docStatus } from './strategies.js';
import { estimateUsage, ruleOutlook, niceShort } from './usage.js';
import { applyScan, itemHtml } from './scan.js';
import { esc, bdt, dateParts, monthLong, niceDate } from './util.js';
import { icon } from './icons.js';
import { gauge, odometer, sparkline, spendBars } from './viz.js';
import { detailHtml } from './detail.js';
import { computeFacts, outcomeFacts, applyFeedback, staleFeedbackKeys, countBySeverity, signature, severityRank, SEVERITY_LABEL } from './facts.js';

const $ = s => document.querySelector(s);
const state = { vehicle: null, advice: null };

// [key, nav label, icon, secondary?]  Secondary pages live behind "More" on phones.
const PAGES = [
  ['home', 'Home', 'home'], ['fuel', 'Fuel', 'fuel'], ['maintenance', 'Service', 'wrench'], ['document', 'Docs', 'doc'],
  ['expense', 'Expenses', 'receipt', true], ['incident', 'Incidents', 'alert', true],
  ['reminders', 'Service intervals', 'clock', true], ['advice', 'Advice', 'spark', true],
];
const STAMP = { overdue: 'Overdue', soon: 'Due soon', ok: 'OK', never: 'Not logged' };

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}

// A bottom sheet on phones, a centred panel on desktop.
function openSheet(html, { dismiss = true } = {}) {
  const dlg = $('#dlg');
  dlg.className = 'sheet';
  dlg.innerHTML = `<div class="grab" tabindex="-1"></div>${html}`;
  dlg.onclick = dismiss ? e => {
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  } : null;
  dlg.showModal();
  return dlg;
}

// ---------- auth + first-run ----------
function showLogin() {
  $('#side').hidden = true;
  $('#view').innerHTML = `
    <form class="login" id="lf">
      <h1>Car tracker</h1>
      <p class="sum">Sign in to your garage.</p>
      <label class="f">Email<input type="email" name="email" required autocomplete="username"></label>
      <label class="f">Password<input type="password" name="password" required autocomplete="current-password"></label>
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
  $('#side').hidden = true;
  $('#view').innerHTML = `
    <form class="login" id="sf">
      <h1>Add your car</h1>
      <p class="sum">You can change these later in Supabase.</p>
      <label class="f">Nickname<input name="name" value="Fielder" required></label>
      <label class="f">Make<input name="make" value="Toyota"></label>
      <label class="f">Model<input name="model" value="Corolla Fielder Hybrid"></label>
      <label class="f">Year<input name="year" type="number" value="2017"></label>
      <label class="f">Number plate (optional)<input name="plate"></label>
      <button>Add car</button>
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
  $('#more')?.classList.toggle('on', PAGES.some(p => p[0] === page && p[3]));
  const view = $('#view');
  try {
    if (page === 'home') await viewHome(view);
    else if (page === 'reminders') await viewReminders(view);
    else if (page === 'advice') await viewAdvice(view);
    else if (TYPES[page]) await viewLog(view, page);
    else location.hash = 'home';
  } catch (e) { view.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

function openMore() {
  const dlg = openSheet(`
    <nav class="morelist">
      ${PAGES.filter(p => p[3]).map(([p, l, ic]) => `<a href="#${p}">${icon(ic)}<span>${l}</span></a>`).join('')}
      <button type="button" class="ghost" id="mout">${icon('out')}<span>Sign out</span></button>
    </nav>`);
  dlg.querySelectorAll('a').forEach(a => a.onclick = () => dlg.close());
  $('#mout').onclick = () => db.signOut();
}

// ---------- Home ----------
async function viewHome(view) {
  const v = state.vehicle.id;
  const [odo, eco, rem, monthly, docs, first, readings] = await Promise.all([
    db.odometer(v), db.fuelEconomy(v), db.reminders(v), db.monthly(v), db.list('document', v, 200), db.firstOdometer(v), db.odometerReadings(v),
  ]);
  const octx = { usage: estimateUsage(readings, today()), today: today() }; // km per day -> due dates

  const kmTotal = eco.reduce((a, r) => a + Number(r.km), 0);
  const liters = eco.reduce((a, r) => a + Number(r.liters), 0);
  const avg = liters ? kmTotal / liters : null;
  const last = eco[0] ? Number(eco[0].km_per_l) : null;
  const thisMonth = today().slice(0, 7) + '-01';
  const sum = pred => monthly.filter(pred).reduce((a, m) => a + Number(m.total_bdt), 0);
  const mTotal = sum(m => m.month === thisMonth), allTotal = sum(() => true);
  const perKm = first != null && odo > first ? allTotal / (odo - first) : null;

  // Oil dial: how much of the oil interval is left (full = just changed).
  const oil = rem.find(r => r.category === 'oil_change');
  const oilOk = oil && oil.last_done_on != null && oil.km_remaining != null && oil.every_km;
  const oilLeft = oilOk ? Number(oil.km_remaining) : null;
  const oilOut = oil ? ruleOutlook(oil, octx) : null;
  const oilNote = oilLeft == null ? 'No oil change logged yet' : oilLeft < 0 ? 'Overdue'
    : oilOut?.by === 'km' && oilOut.dueOn ? `km left, due around ${niceShort(oilOut.dueOn, today())}` : 'km left';

  // Due and expiring: documents plus any service that is not comfortably ok.
  const latest = {};
  docs.forEach(d => { latest[d.doc_type] ??= d; }); // sorted by expiry, newest first
  const items = [];
  OPTS.DOCS.map(o => o[0]).forEach(k => {
    const d = latest[k];
    if (d) { const s = docStatus(d); items.push({ title: label(OPTS.DOCS, k), text: s.text, level: s.level, rank: s.rank, log: s.level === 'ok' ? null : k }); }
    else if (k === 'tax_token' || k === 'fitness') items.push({ title: label(OPTS.DOCS, k), text: 'Not logged yet', level: 'never', rank: 2, log: k });
  });
  rem.forEach(r => { const s = ruleOutlook(r, octx); if (s.level !== 'ok') items.push({ title: r.title, text: s.text, level: s.level, rank: s.rank, dueIn: s.dueIn, svc: r.category }); });
  items.sort((a, b) => a.rank - b.rank || (a.dueIn ?? 1e6) - (b.dueIn ?? 1e6));
  const shown = items.slice(0, 8);

  const cats = [['fuel', 'Fuel'], ['maintenance', 'Service'], ['expense', 'Other'], ['incident', 'Incidents'], ['document', 'Documents']];
  const months = [...new Set(monthly.map(m => m.month))].slice(0, 6);
  const rows = months.map(m => ({
    month: m.slice(0, 7),
    ...Object.fromEntries(cats.map(([k]) => [k, sum(x => x.month === m && x.category === k)])),
  }));
  const trend = [...eco].reverse().slice(-12).map(r => Number(r.km_per_l));
  const spark = sparkline(trend, { label: 'Fuel economy trend', unit: 'km per litre' });

  view.innerHTML = `
    <div class="quick">
      ${[['fuel', 'Fuel'], ['maintenance', 'Service'], ['expense', 'Expense'], ['document', 'Document'], ['incident', 'Incident']]
        .map(([t, l]) => `<button type="button" data-add="${t}">${icon(TYPES[t].icon, 26)}<span>${l}</span></button>`).join('')}
    </div>

    <section class="cluster">
      <div class="odo-wrap">${odometer(odo)}<span class="odo-cap">Odometer</span></div>
      <div class="dials">
        <figure class="dial">
          ${gauge({ value: last, min: 0, max: 30, display: last == null ? '–' : last.toFixed(1), unit: 'km per litre', title: 'Fuel economy',
            labels: [0, 10, 20, 30].map(n => ({ v: n, text: String(n) })) })}
          <figcaption>Fuel economy<small>${last == null ? 'Needs two full tanks' : 'km per litre'}</small></figcaption>
        </figure>
        <figure class="dial">
          ${gauge({ value: oilLeft == null ? null : Math.max(0, oilLeft), min: 0, max: oilOk ? Number(oil.every_km) : 1,
            display: oilLeft == null ? '–' : oilLeft < 0 ? 'Overdue' : oilLeft.toLocaleString('en-US'), unit: 'km left', title: 'Oil change',
            zones: [[0, .1, 'z-red'], [.1, .3, 'z-amber'], [.3, 1, 'z-green']],
            labels: [{ v: 0, text: 'E' }, { v: oilOk ? Number(oil.every_km) : 1, text: 'F' }] })}
          <figcaption>Oil change<small>${oilNote}</small></figcaption>
        </figure>
      </div>
      <div class="readouts">
        <div><b>${avg == null ? '–' : avg.toFixed(1)}</b><span>Average km/L</span></div>
        <div><b>${bdt(mTotal)}</b><span>This month</span></div>
        <div><b>${perKm == null ? '–' : '৳' + perKm.toFixed(1)}</b><span>All-in per km</span></div>
      </div>
    </section>

    ${odo === 0 && !monthly.length ? `
      <div class="empty"><p>Nothing logged yet. Add your next refill and the dials start moving. The fuel dial needs two full tanks.</p>
      <button type="button" data-add="fuel">Add a refill</button></div>` : ''}

    <h2>Due and expiring</h2>
    <ul class="tickets">${shown.map(it => `
      <li class="tk ${it.level}">
        <div><b>${esc(it.title)}</b><span>${esc(it.text)}</span></div>
        <div class="tk-r">
          ${it.log && it.level === 'never' ? '' : `<span class="stamp ${it.level}">${STAMP[it.level]}</span>`}
          ${it.log ? `<button type="button" class="mini" data-log="${it.log}">${it.level === 'never' ? 'Log it' : 'Renew'}</button>`
            : it.svc ? `<button type="button" class="mini" data-svc="${it.svc}">Log it</button>` : ''}
        </div>
      </li>`).join('')}</ul>
    ${items.length > shown.length ? `<a class="more-link" href="#reminders">See all service intervals</a>` : ''}

    <h2>Spending by month</h2>
    ${rows.length ? spendBars(rows, cats, bdt) : '<p class="mut">Spending appears here once you log something.</p>'}

    ${spark ? `<h2>Fuel economy trend</h2><div class="spark-card">${spark}<p class="mut">Last ${trend.length} full tanks, newest on the right.</p></div>` : ''}`;

  view.querySelectorAll('[data-add]').forEach(b => b.onclick = () => openForm(b.dataset.add));
  view.querySelectorAll('[data-log]').forEach(b => b.onclick = () => openForm('document', null, { doc_type: b.dataset.log }));
  view.querySelectorAll('[data-svc]').forEach(b => b.onclick = () => openForm('maintenance', null, { items: [{ category: b.dataset.svc }] }));
  // The one orchestrated moment: needles sweep to their readings.
  requestAnimationFrame(() => requestAnimationFrame(() => view.querySelector('.cluster')?.classList.add('live')));
}

// ---------- log pages ----------
const loadSort = type => { try { return localStorage.getItem(`sort:${type}`); } catch { return null; } };
const saveSort = (type, key) => { try { localStorage.setItem(`sort:${type}`, key); } catch { /* storage blocked: sort just won't be remembered */ } };
async function viewLog(view, type) {
  const t = TYPES[type], v = state.vehicle.id;
  const [rows, att] = await Promise.all([db.list(type, v), db.attachmentMap(v, type)]);
  const sort = t.sorts.find(x => x.key === loadSort(type)) ?? t.sorts[0];
  const sorted = [...rows].sort(sort.cmp);
  const total = rows.reduce((a, r) => a + Number(t.cost(r) || 0), 0);

  // Date sorts keep month headers; other sorts show one flat list.
  let groups = [];
  if (sort.group) {
    sorted.forEach(r => {
      const key = String(r[t.dateField]).slice(0, 7);
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) { g = { key, title: monthLong(key), rows: [], sum: 0 }; groups.push(g); }
      g.rows.push(r);
      g.sum += Number(t.cost(r) || 0);
    });
  } else if (sorted.length) groups = [{ title: sort.label, rows: sorted, sum: total }];

  const card = r => {
    const c = t.card(r), p = dateParts(r[t.dateField]), n = att[r.id]?.length;
    return `
      <article class="job">
        <div class="jdate">${t.dateLabel ? `<small>${t.dateLabel}</small>` : ''}<b>${p.d}</b><span>${p.m} ${p.y}</span></div>
        <div class="jbody">
          <div class="jtop"><h3><button type="button" class="jopen" data-open="${r.id}">${esc(c.title)}</button></h3>${c.amount != null && c.amount !== '' ? `<span class="amt">${bdt(c.amount)}</span>` : ''}</div>
          ${c.facts?.length ? `<p class="facts">${c.facts.map(f => `<span>${esc(f)}</span>`).join('')}</p>` : ''}
          ${c.lines?.length ? `<ul class="lines">${c.lines.map(l => `<li><span>${esc(l.text)}</span><span>${bdt(l.amount)}</span></li>`).join('')}</ul>` : ''}
          <div class="jfoot">
            ${c.tag ? `<span class="stamp ${c.tag.level}">${esc(c.tag.text)}</span>` : '<span></span>'}
            <span class="jact">
              ${n ? `<button type="button" class="ib" data-att="${r.id}" aria-label="View ${n} attached file${n > 1 ? 's' : ''}">${icon('clip', 18)}<small>${n}</small></button>` : ''}
              <button type="button" class="ib" data-edit="${r.id}" aria-label="Edit">${icon('edit', 18)}</button>
              <button type="button" class="ib danger" data-del="${r.id}" aria-label="Delete">${icon('trash', 18)}</button>
            </span>
          </div>
        </div>
      </article>`;
  };

  view.innerHTML = `
    <div class="head">
      <div class="ttl"><h1>${t.title}</h1><p class="sum">${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}, ${bdt(total)} in total</p>
        <button type="button" class="link csv" id="csv">${icon('download', 16)}<span>Download CSV</span></button></div>
      <div class="tools">
        <select class="sort" id="sort" aria-label="Sort entries">${t.sorts.map(x => `<option value="${x.key}" ${x.key === sort.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
      </div>
    </div>
    ${groups.map(g => `<section><h2 class="mh"><span>${esc(g.title)}</span><b>${g.sum ? bdt(g.sum) : ''}</b></h2>${g.rows.map(card).join('')}</section>`).join('')
      || `<div class="empty"><p>Nothing here yet. Tap the + button to add your first ${t.noun}.</p></div>`}
    <button type="button" class="fab" id="add" aria-label="Add ${t.noun}">${icon('plus', 28)}</button>`;

  $('#sort').onchange = e => { saveSort(type, e.target.value); route(); };
  $('#add').onclick = () => openForm(type);
  $('#csv').onclick = () => exportCsv(type, sorted);
  view.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openDetail(type, rows.find(r => r.id === b.dataset.open), rows, att[b.dataset.open] ?? []));
  view.querySelectorAll('[data-att]').forEach(b => b.onclick = () => showFiles(att[b.dataset.att]));
  view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openForm(type, rows.find(r => r.id === b.dataset.edit)));
  view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this entry and its files?')) return;
    try { await db.remove(type, rows.find(r => r.id === b.dataset.del)); toast('Deleted'); }
    catch (e) { toast(e.message); }
  });
}

// Read-only detail sheet. Photos load after it opens (signed URLs need a round trip).
async function openDetail(type, row, rows, paths) {
  const dlg = openSheet(detailHtml(type, row, rows, paths.length));
  $('#cancel').onclick = () => dlg.close();
  if (!paths.length) return;
  try {
    const items = await db.signedUrls(paths);
    const box = $('#photos');
    if (box) box.innerHTML = `<div class="files">${filesHtml(items, paths, false)}</div>`;
  } catch (e) {
    const box = $('#photos');
    if (box) box.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

async function viewReminders(view) {
  const v = state.vehicle.id, t0 = today();
  const [rules, status, readings] = await Promise.all([db.rules(v), db.reminders(v), db.odometerReadings(v)]);
  const usage = estimateUsage(readings, t0), ctx = { usage, today: t0 };
  const st = Object.fromEntries(status.map(s => [s.rule_id, ruleOutlook(s, ctx)]));
  // Most urgent first: overdue, then by predicted date; never-logged and paused last.
  const order = r => !r.active ? 4e6 : !st[r.id] ? 3e6 : st[r.id].level === 'never' ? 2e6 : st[r.id].level === 'overdue' ? -1e6 : (st[r.id].dueIn ?? 1e6);
  const usageCard = usage.kmPerDay
    ? `<div class="usage"><b>About ${Math.round(usage.kmPerDay)} km a day</b><span>${usage.low != null ? `Typical range ${Math.round(usage.low)} to ${Math.round(usage.high)}. ` : ''}Worked out from ${usage.n} odometer readings over ${usage.spanDays} days, and used for the due dates below.</span></div>`
    : `<div class="usage"><b>No date predictions yet</b><span>Log refills with the odometer for about two weeks and due dates will appear here.</span></div>`;
  view.innerHTML = `
    <h1>Service intervals</h1>
    ${usageCard}
    ${[...rules].sort((a, b) => order(a) - order(b)).map(r => {
      const s = st[r.id], lvl = r.active ? (s?.level ?? 'never') : 'never';
      const facts = [r.active ? (s?.text ?? 'Not logged') : 'Paused'];
      if (r.active && s?.window) facts.push(`Likely between ${niceShort(s.window[0], t0)} and ${niceShort(s.window[1], t0)}`);
      return `
        <article class="rule${r.active ? '' : ' off'}">
          <div class="rtop"><h3>${esc(r.title)}</h3><span class="stamp ${lvl}">${r.active ? STAMP[lvl] : 'Paused'}</span></div>
          <p class="facts">${facts.map(f => `<span>${esc(f)}</span>`).join('')}</p>
          <div class="rfields">
            <label class="f">Every (km)<input type="number" min="1" inputmode="numeric" data-r="${r.id}" data-f="every_km" value="${r.every_km ?? ''}"></label>
            <label class="f">Every (days)<input type="number" min="1" inputmode="numeric" data-r="${r.id}" data-f="every_days" value="${r.every_days ?? ''}"></label>
            <label class="switch"><input type="checkbox" data-r="${r.id}" data-f="active" ${r.active ? 'checked' : ''}><em>Active</em></label>
          </div>
        </article>`;
    }).join('')}`;
  view.querySelectorAll('[data-r]').forEach(el => el.onchange = async () => {
    const val = el.type === 'checkbox' ? el.checked : (el.value === '' ? null : Number(el.value));
    try { await db.updateRule(el.dataset.r, { [el.dataset.f]: val }); toast('Interval updated'); }
    catch (e) { toast(e.message); }
    route();
  });
}

// ---------- advice: facts worked out from your records, optional AI comments on top ----------
const SEV_STAMP = { high: 'overdue', medium: 'soon', low: 'never', info: 'ok' };

async function loadAdviceData() {
  const v = state.vehicle.id;
  const [odo, eco, rem, monthly, docs, fuel, maintenance, expenses, incidents, feedback, readings] = await Promise.all([
    db.odometer(v), db.fuelEconomy(v), db.reminders(v), db.monthly(v), db.list('document', v, 500), db.list('fuel', v, 500),
    db.list('maintenance', v, 500), db.list('expense', v, 500), db.list('incident', v, 500), db.feedback(v), db.odometerReadings(v),
  ]);
  return { odo, eco, rem, monthly, docs, fuel, maintenance, expenses, incidents, feedback, readings };
}

function adviceModel() {
  const d = state.advData, t = today();
  const base = computeFacts({ today: t, odometer: d.odo, usage: estimateUsage(d.readings, t), eco: d.eco, rem: d.rem, docs: d.docs, fuel: d.fuel,
    maintenance: d.maintenance, expenses: d.expenses, incidents: d.incidents, monthly: d.monthly });
  const all = [...base, ...outcomeFacts({ eco: d.eco, feedback: d.feedback, today: t })];
  return { all, ...applyFeedback(all, d.feedback, t) };
}

const evChips = ev => (ev ?? []).map(e => `<button type="button" class="chip ev" data-ev="${esc(e.type)}:${esc(e.id)}">${esc(e.label)}</button>`).join('');

function factHtml(f, ai) {
  const note = ai?.byId?.[f.key];
  return `
    <li class="fact ${f.severity}">
      <div class="fhead"><h3>${esc(f.title)}</h3><span class="stamp ${SEV_STAMP[f.severity]}">${SEVERITY_LABEL[f.severity]}</span></div>
      <p>${esc(f.detail)}</p>
      ${f.reopened ? '<p class="fnote">Changed since you hid it.</p>' : ''}
      ${note && (note.why || note.action) ? `<div class="ai"><span class="aitag">AI</span>${note.why ? `<p>${esc(note.why)}</p>` : ''}${note.action ? `<p><b>Next:</b> ${esc(note.action)}</p>` : ''}</div>` : ''}
      ${f.checks?.length ? `<h4>Worth checking (possible causes, not proven)</h4><ul class="checks">${f.checks.map(c => `<li><span>${esc(c.text)}</span>${c.evidence?.length ? `<div class="evid">${evChips(c.evidence)}</div>` : ''}</li>`).join('')}</ul>` : ''}
      ${f.evidence?.length ? `<div class="evid"><span>Evidence</span>${evChips(f.evidence)}</div>` : ''}
      <div class="factbar">
        <button type="button" class="ghost sm" data-fb="done" data-key="${esc(f.key)}">Done</button>
        <button type="button" class="ghost sm" data-fb="dismissed" data-key="${esc(f.key)}">Not relevant</button>
      </div>
    </li>`;
}

// An evidence chip opens the same read-only detail sheet as tapping the card in its list.
async function openEvidence(type, id) {
  const d = state.advData;
  const rows = { fuel: d.fuel, maintenance: d.maintenance, expense: d.expenses, incident: d.incidents, document: d.docs }[type];
  const row = rows?.find(r => r.id === id);
  if (!row) return toast('That entry no longer exists');
  try {
    const att = await db.attachmentMap(state.vehicle.id, type);
    openDetail(type, row, rows, att[id] ?? []);
  } catch (e) { toast(e.message); }
}

function paintAdvice(view) {
  const v = state.vehicle.id;
  const { visible, hidden } = adviceModel();
  const ai = state.ai && state.ai.sig === signature(visible) ? state.ai : null; // AI text is only shown while it still matches the facts
  const idx = f => { const i = ai?.order?.indexOf(f.key) ?? -1; return i < 0 ? 999 : i; };
  const sorted = [...visible].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || idx(a) - idx(b));
  const counts = countBySeverity(visible);

  view.innerHTML = `
    <h1>Advice</h1>
    ${sorted.length
      ? `<div class="statusrow">${['high', 'medium', 'low', 'info'].filter(k => counts[k]).map(k => `<span class="stamp ${SEV_STAMP[k]}">${counts[k]} ${SEVERITY_LABEL[k].toLowerCase()}</span>`).join('')}</div>`
      : '<p class="calm">Nothing needs attention right now.</p>'}
    ${ai && (ai.summary || ai.dropped) ? `<div class="ai ai-sum"><span class="aitag">AI</span>${ai.summary ? `<b class="aititle">What to do</b><p>${esc(ai.summary)}</p>` : ''}${ai.dropped ? `<p class="fnote">${ai.dropped === 1 ? '1 AI note was left out because it quoted a number that is not in your records.' : `${ai.dropped} AI notes were left out because they quoted numbers that are not in your records.`}</p>` : ''}</div>` : ''}
    <div class="row"><button type="button" id="explain" ${sorted.length ? '' : 'disabled'}>${ai ? 'Refresh advice' : 'Get advice'}</button></div>
    <p class="err" id="ai-msg"></p>
    <ul class="facts-list">${sorted.map(f => factHtml(f, ai)).join('')}</ul>
    ${hidden.length ? `
      <details class="hidden-facts" id="hidden-facts" ${state.hiddenOpen ? 'open' : ''}>
        <summary>Hidden (${hidden.length})</summary>
        <ul class="hidden-list">${hidden.map(h => `
          <li><div><b>${esc(h.title)}</b><span>${h.status === 'done' ? `Marked done on ${niceDate(h.since)}` : 'Marked not relevant'}</span></div>
          <button type="button" class="ghost sm" data-restore="${esc(h.key)}">Restore</button></li>`).join('')}</ul>
      </details>` : ''}`;

  $('#hidden-facts')?.addEventListener('toggle', e => { state.hiddenOpen = e.target.open; });
  view.querySelectorAll('[data-ev]').forEach(b => b.onclick = () => { const [type, ...rest] = b.dataset.ev.split(':'); openEvidence(type, rest.join(':')); });

  view.querySelectorAll('[data-fb]').forEach(b => b.onclick = async () => {
    const f = visible.find(x => x.key === b.dataset.key);
    if (!f) return;
    try {
      await db.setFeedback(v, f.key, f.fp, b.dataset.fb, f.snapshot ?? {});
      state.advData.feedback = await db.feedback(v);
      toast(b.dataset.fb === 'done' ? 'Marked done. Hidden for 30 days, or until it changes.' : 'Hidden. It returns only if the situation changes.');
      paintAdvice(view);
    } catch (e) { toast(e.message); }
  });
  view.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => {
    try {
      await db.clearFeedback(v, b.dataset.restore);
      state.advData.feedback = await db.feedback(v);
      paintAdvice(view);
    } catch (e) { toast(e.message); }
  });

  $('#explain').onclick = async () => {
    const btn = $('#explain');
    btn.disabled = true;
    btn.textContent = 'Thinking…';
    $('#ai-msg').textContent = '';
    try {
      const facts = sorted.slice(0, 20).map(f => ({
        id: f.key, kind: f.kind, severity: f.severity, title: f.title,
        detail: f.detail + (f.checks?.length ? ` Things to check: ${f.checks.map(c => c.text).join(' ')}` : ''),
      }));
      const r = await ai_explain(facts);
      state.ai = { sig: signature(visible), summary: r.summary, order: r.order, byId: Object.fromEntries(r.items.map(i => [i.fact_id, i])), dropped: r.dropped };
      paintAdvice(view);
    } catch (e) {
      $('#ai-msg').textContent = e.message === 'Unknown mode'
        ? 'Redeploy the gemini function to get advice. The facts above do not need it.' : e.message;
      btn.disabled = false;
      btn.textContent = ai ? 'Refresh advice' : 'Get advice';
    }
  };
}
const ai_explain = facts => ai.explain(facts, { make: state.vehicle.make, model: state.vehicle.model, year: state.vehicle.year });

async function viewAdvice(view) {
  view.innerHTML = '<h1>Advice</h1><p class="mut">Loading…</p>';
  state.advData = await loadAdviceData();
  // Feedback for situations that no longer exist is dropped, so a problem that returns next year is not pre-dismissed.
  const stale = staleFeedbackKeys(adviceModel().all, state.advData.feedback);
  if (stale.length) {
    try { await Promise.all(stale.map(k => db.clearFeedback(state.vehicle.id, k))); } catch { /* harmless: retried next visit */ }
    state.advData.feedback = state.advData.feedback.filter(f => !stale.includes(f.fact_key));
  }
  paintAdvice(view);
}

// ---------- shared form flow: render -> validate -> save -> upload -> notify ----------
function fieldHtml(f, ctx, row) {
  const def = row ? row[f.name]
    : (f.name in ctx.preset ? ctx.preset[f.name] : (typeof f.default === 'function' ? f.default(ctx) : f.default));
  const req = f.required ? 'required' : '';
  const lbl = esc(f.label);
  const cls = `f${f.half ? ' half' : ''}`;
  const af = f.autofocus && !row ? 'autofocus' : '';
  if (f.type === 'select') {
    return `<label class="${cls}">${lbl}<select name="${f.name}" ${req}>${f.options.map(([v, l]) => `<option value="${v}" ${v === def ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  }
  if (f.type === 'textarea') return `<label class="${cls}">${lbl}<textarea name="${f.name}" rows="2" ${req}>${esc(row ? (def ?? '') : '')}</textarea></label>`;
  if (f.type === 'checkbox') return `<label class="switch"><input type="checkbox" name="${f.name}" ${def ? 'checked' : ''}><em>${lbl}</em></label>`;
  const num = f.type === 'number' ? `step="${f.step ?? 'any'}" min="0" inputmode="${f.step === 1 ? 'numeric' : 'decimal'}"` : '';
  return `<label class="${cls}">${lbl}<input type="${f.type}" name="${f.name}" value="${esc(def ?? '')}" ${num} ${req} ${af}></label>`;
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

async function openForm(type, row = null, preset = {}) {
  const t = TYPES[type];
  const ctx = { odometer: row ? 0 : await db.odometer(state.vehicle.id), preset };
  const items = t.items ? (row ? (itemsOf(row).length ? itemsOf(row) : [{}]) : (preset.items?.length ? preset.items : [{}])) : [];
  const itemsBlock = t.items
    ? `<h3 class="sub">Services done</h3><div id="items">${items.map(itemHtml).join('')}</div>
       <div class="row"><button type="button" class="ghost sm" id="addItem">${icon('plus', 18)}<span>Add another service</span></button></div>
       <div class="chips">
         <button type="button" class="chip" data-quick="engine_air_filter_clean">${icon('plus', 16)}<span>Engine filter cleaned</span></button>
         <button type="button" class="chip" data-quick="cabin_ac_filter_clean">${icon('plus', 16)}<span>Cabin filter cleaned</span></button>
       </div>
       <p class="hint">Cleaned with compressed air: blow from the clean side outward at low pressure. Replace the filter if it is torn, oily or still dirty.</p>
       <p class="total" id="itotal"></p>`
    : '';
  const dlg = openSheet(`
    <form id="f" class="form">
      <h2 class="ftitle">${icon(t.icon, 24)}<span>${row ? 'Edit' : 'Add'} ${esc(t.noun)}</span></h2>
      <div class="fields">
        ${t.fields.map(f => (f.name === t.itemsBefore ? itemsBlock : '') + fieldHtml(f, ctx, row)).join('')}
      </div>
      ${t.attach ? `<label class="f file">${row ? 'Add more invoice photos or PDF' : 'Invoice photos or PDF'}<input type="file" name="_files" accept="image/*,application/pdf" multiple></label>` : ''}
      ${t.scan ? `<button type="button" class="ghost" id="scan">Fill from invoice</button>` : ''}
      <p class="err" id="ferr"></p>
      <div class="fbar"><button type="button" class="ghost" id="cancel">Cancel</button><button id="save">${row ? 'Save changes' : `Save ${esc(t.noun)}`}</button></div>
    </form>`, { dismiss: false });
  const form = $('#f');
  $('#cancel').onclick = () => dlg.close();

  if (t.items) {
    const refresh = () => {
      const sum = [...form.querySelectorAll('[name="i_cost"]')].reduce((a, el) => a + Number(el.value || 0), 0);
      $('#itotal').textContent = `Total ${bdt(sum)}`;
    };
    refresh();
    form.addEventListener('input', refresh);
    $('#addItem').onclick = () => $('#items').insertAdjacentHTML('beforeend', itemHtml());
    form.addEventListener('click', e => {
      const q = e.target.closest('[data-quick]');
      if (q) { // chip: add a pre-filled line, reusing the first line if it is still empty
        const box = $('#items'), rows = box.querySelectorAll('.item');
        const blank = rows.length === 1 && !rows[0].querySelector('[name=i_title]').value && !rows[0].querySelector('[name=i_cost]').value;
        const html = itemHtml({ category: q.dataset.quick, cost_bdt: 0 });
        if (blank) box.innerHTML = html; else box.insertAdjacentHTML('beforeend', html);
        refresh();
        return;
      }
      const rm = e.target.closest('[data-rm]');
      if (!rm) return;
      const item = rm.closest('.item');
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
      btn.textContent = 'Reading invoice…';
      $('#ferr').textContent = '';
      try {
        const filled = applyScan(form, type, await ai.extract(type, file));
        toast(filled.length ? 'Filled from invoice. Check every value before saving.' : 'Nothing readable found on that image');
      } catch (e) { $('#ferr').textContent = e.message; }
      finally { btn.disabled = false; btn.textContent = 'Fill from invoice'; }
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
      toast(uploadError ? `Saved, but the upload failed: ${uploadError.message}` : (row ? 'Changes saved' : `${t.noun[0].toUpperCase()}${t.noun.slice(1)} saved`));
    } catch (err) {
      $('#ferr').textContent = err.message;
      btn.disabled = false;
    }
  };
}

const filesHtml = (items, paths, removable) => items.map((d, i) => {
  const p = d.path ?? paths[i];
  const shown = /\.pdf$/i.test(p)
    ? `<a href="${esc(d.signedUrl)}" target="_blank" rel="noopener">Open PDF ${i + 1}</a>`
    : `<a href="${esc(d.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(d.signedUrl)}" alt="Invoice ${i + 1}" loading="lazy"></a>`;
  return `<div>${shown}${removable ? `<button type="button" class="link danger" data-rmf="${esc(p)}">Remove file</button>` : ''}</div>`;
}).join('');

async function showFiles(paths) {
  try {
    const items = await db.signedUrls(paths);
    const dlg = openSheet(`<div class="files">${filesHtml(items, paths, true)}</div><div class="row"><button type="button" class="ghost" id="cancel">Close</button></div>`);
    $('#cancel').onclick = () => dlg.close();
    dlg.querySelectorAll('[data-rmf]').forEach(b => b.onclick = async () => {
      if (!confirm('Remove this file?')) return;
      try { await db.removeFile(b.dataset.rmf); dlg.close(); toast('File removed'); }
      catch (e) { toast(e.message); }
    });
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
  const v = state.vehicle;
  $('#app').classList.add('authed');
  $('#side').hidden = false;
  $('#plate').innerHTML = `<span class="plate">${esc(v.plate || v.name)}</span><span class="plate-sub">${esc([v.make, v.model, v.year].filter(Boolean).join(' '))}</span>`;
  $('#nav').innerHTML = PAGES.map(([p, l, ic, sec]) => `<a href="#${p}" data-p="${p}"${sec ? ' class="sec"' : ''}>${icon(ic)}<span>${l}</span></a>`).join('')
    + `<button type="button" class="more" id="more">${icon('more')}<span>More</span></button>`;
  $('#more').onclick = openMore;
  route();
}

$('#signout').onclick = () => db.signOut();
db.onAuth(evt => { if (evt === 'SIGNED_OUT') location.reload(); });
window.addEventListener('hashchange', route);
bus.on('data:changed', route);
boot().catch(e => { $('#view').innerHTML = `<p class="err">${esc(e.message)}</p>`; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
