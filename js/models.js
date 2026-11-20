// Factory: every log type is described once here. Forms, payloads and list cards
// are all generated from these definitions (see buildPayload and app.js).
import { docStatus } from './strategies.js';
import { bdt, dateParts } from './util.js';

export const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

const MAINT = [
  ['oil_change', 'Oil change (mobil)'], ['engine', 'Engine work'],
  ['engine_air_filter', 'Engine air filter: replaced'], ['engine_air_filter_clean', 'Engine air filter: cleaned (air)'],
  ['cabin_ac_filter', 'Cabin AC filter: replaced'], ['cabin_ac_filter_clean', 'Cabin AC filter: cleaned (air)'],
  ['ac_service', 'AC service'], ['tyre_change', 'Tyre change'],
  ['tyre_rotation', 'Tyre rotation'], ['tyre_pressure', 'Tyre air (front/back)'],
  ['battery_12v', '12V battery'], ['hybrid_system', 'Hybrid system'],
  ['brake', 'Brakes'], ['electrical', 'Electrical fix'],
  ['lights', 'Lights (fog etc.)'], ['coolant', 'Coolant'],
  ['transmission', 'Transmission'], ['other', 'Other'],
];
const EXP = [
  ['parking', 'Parking'], ['toll', 'Toll'], ['fine', 'Fine'],
  ['wash', 'Car wash'], ['accessory', 'Accessory'], ['other', 'Other'],
];
const DOCS = [
  ['tax_token', 'Tax token'], ['fitness', 'Fitness certificate'],
  ['insurance', 'Insurance'], ['registration', 'Registration'], ['other', 'Other'],
];
export const OPTS = { MAINT, EXP, DOCS };
export const label = (opts, v) => opts.find(o => o[0] === v)?.[1] ?? v;
export const itemsOf = r => [...(r.maintenance_items ?? [])].sort((a, b) => a.position - b.position);
const visitTotal = r => itemsOf(r).reduce((a, i) => a + Number(i.cost_bdt || 0), 0);
const km = n => `${Number(n).toLocaleString('en-US')} km`;

// Field helpers. `default` may be a value or a function(ctx). `half` = half-width on the form grid.
const date = (name = 'logged_on', lbl = 'Date') => ({ name, label: lbl, type: 'date', required: true, default: today, half: true });
const odo = (required = true) => ({
  name: 'odometer_km', label: 'Odometer (km)', type: 'number', step: 1, required, half: true,
  default: required ? ctx => ctx.odometer || '' : undefined,
});
const money = (name, lbl, required = true, half = false) => ({ name, label: lbl, type: 'number', step: 0.01, required, half, default: required ? 0 : undefined });
const text = (name, lbl, required = false) => ({ name, label: lbl, type: 'text', required });
const notes = () => ({ name: 'notes', label: 'Notes', type: 'textarea' });

// card(r) -> { title, facts[], amount, tag?, lines? } drives the list cards.
export const TYPES = {
  fuel: {
    table: 'fuel_logs', title: 'Fuel', noun: 'refill', icon: 'fuel', dateField: 'logged_on', attach: true, scan: true,
    fields: [
      { name: 'liters', label: 'Liters', type: 'number', step: 0.01, required: true, half: true, autofocus: true },
      { name: 'total_cost_bdt', label: 'Total cost (৳)', type: 'number', step: 0.01, required: true, half: true },
      odo(), date(),
      { name: 'fuel_type', label: 'Fuel', type: 'select', options: [['octane', 'Octane'], ['petrol', 'Petrol']], default: 'octane' },
      { name: 'is_full_tank', label: 'Filled to full (pump auto-stop)', type: 'checkbox', default: true },
      text('station', 'Station'), notes(),
    ],
    card: r => ({
      title: `${r.liters} L ${r.fuel_type === 'petrol' ? 'petrol' : 'octane'}`,
      facts: [r.station, km(r.odometer_km), `৳${r.price_per_liter} a litre`].filter(Boolean),
      amount: r.total_cost_bdt,
      tag: r.is_full_tank ? null : { text: 'Partial fill', level: 'never' },
    }),
    cost: r => r.total_cost_bdt,
  },

  maintenance: {
    table: 'maintenance_logs', title: 'Service', noun: 'service', icon: 'wrench', dateField: 'logged_on', attach: true, scan: true,
    items: true, itemsBefore: 'notes', // one visit = several services, each with its own cost
    fields: [date(), odo(), text('vendor', 'Workshop / shop'), notes()],
    card: r => {
      const items = itemsOf(r);
      return {
        title: items.length > 1 ? `${items.length} services` : (items[0]?.title ?? 'Service'),
        facts: [r.vendor, km(r.odometer_km)].filter(Boolean),
        amount: visitTotal(r),
        lines: items.length > 1 ? items.map(i => ({ text: i.title, amount: i.cost_bdt })) : [],
      };
    },
    cost: r => visitTotal(r),
  },

  expense: {
    table: 'expenses', title: 'Expenses', noun: 'expense', icon: 'receipt', dateField: 'logged_on', attach: true, scan: true,
    fields: [
      date(), odo(false),
      { name: 'category', label: 'Category', type: 'select', options: EXP, required: true },
      money('amount_bdt', 'Amount (৳)'), notes(),
    ],
    card: r => ({ title: label(EXP, r.category), facts: [r.notes].filter(Boolean), amount: r.amount_bdt }),
    cost: r => r.amount_bdt,
  },

  incident: {
    table: 'incidents', title: 'Incidents', noun: 'incident', icon: 'alert', dateField: 'occurred_on', attach: true,
    fields: [
      date('occurred_on', 'Date'), odo(false), text('location', 'Location'),
      { name: 'description', label: 'What happened', type: 'textarea', required: true },
      money('repair_cost_bdt', 'Repair cost (৳)', true, true),
      { name: 'claim_status', label: 'Insurance claim', type: 'select', default: 'none', half: true,
        options: [['none', 'None'], ['filed', 'Filed'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['paid', 'Paid']] },
      notes(),
    ],
    card: r => ({
      title: r.description,
      facts: [r.location, r.claim_status !== 'none' ? `Claim ${r.claim_status}` : null].filter(Boolean),
      amount: r.repair_cost_bdt,
    }),
    cost: r => r.repair_cost_bdt,
  },

  document: {
    table: 'documents', title: 'Documents', noun: 'document', icon: 'doc', dateField: 'expires_on', dateLabel: 'Expires', attach: true, scan: true,
    fields: [
      { name: 'doc_type', label: 'Document', type: 'select', options: DOCS, required: true, default: 'tax_token' },
      { name: 'issued_on', label: 'Issued on', type: 'date', half: true },
      { name: 'expires_on', label: 'Expires on', type: 'date', required: true, half: true },
      money('cost_bdt', 'Cost (৳)', false), notes(),
    ],
    card: r => {
      const s = docStatus(r);
      return {
        title: label(DOCS, r.doc_type),
        facts: [r.issued_on ? (({ d, m, y }) => `Issued ${d} ${m} ${y}`)(dateParts(r.issued_on)) : null].filter(Boolean),
        amount: r.cost_bdt,
        tag: { text: s.when, level: s.level },
      };
    },
    cost: r => r.cost_bdt,
  },
};

// Form data -> DB row. New rows omit empty values so DB defaults apply;
// edits send null for cleared fields so they really get cleared.
export function buildPayload(type, fd, vehicleId, edit = false) {
  const out = { vehicle_id: vehicleId };
  for (const f of TYPES[type].fields) {
    if (f.type === 'checkbox') { out[f.name] = fd.get(f.name) === 'on'; continue; }
    const v = fd.get(f.name);
    if (v === null || v === '') { if (edit) out[f.name] = null; continue; }
    out[f.name] = f.type === 'number' ? Number(v) : v;
  }
  return out;
}
