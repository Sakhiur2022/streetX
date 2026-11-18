// Factory: every log type is described once here. Forms, payloads and table columns
// are all generated from these definitions (see buildPayload and app.js).
import { docStatus } from './strategies.js';

export const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

const MAINT = [
  ['oil_change', 'Oil change (mobil)'], ['engine', 'Engine work'],
  ['engine_air_filter', 'Engine air filter'], ['cabin_ac_filter', 'Cabin AC filter'],
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

// Field helpers. `default` may be a value or a function(ctx).
const date = (name = 'logged_on', lbl = 'Date') => ({ name, label: lbl, type: 'date', required: true, default: today });
const odo = (required = true) => ({
  name: 'odometer_km', label: 'Odometer (km)', type: 'number', step: 1, required,
  default: required ? ctx => ctx.odometer || '' : undefined,
});
const money = (name, lbl, required = true) => ({ name, label: lbl, type: 'number', step: 0.01, required, default: required ? 0 : undefined });
const text = (name, lbl, required = false) => ({ name, label: lbl, type: 'text', required });
const notes = () => ({ name: 'notes', label: 'Notes', type: 'textarea' });

export const TYPES = {
  fuel: {
    table: 'fuel_logs', title: 'Fuel', icon: '⛽', dateField: 'logged_on', attach: true, scan: true,
    fields: [
      date(), odo(),
      { name: 'fuel_type', label: 'Fuel', type: 'select', options: [['octane', 'Octane'], ['petrol', 'Petrol']], default: 'octane' },
      { name: 'liters', label: 'Liters', type: 'number', step: 0.01, required: true },
      { name: 'total_cost_bdt', label: 'Total cost (৳)', type: 'number', step: 0.01, required: true },
      { name: 'is_full_tank', label: 'Filled to full (pump auto-stop)', type: 'checkbox', default: true },
      text('station', 'Station'), notes(),
    ],
    cols: [
      ['Date', r => r.logged_on], ['Odo', r => r.odometer_km], ['Fuel', r => r.fuel_type],
      ['Liters', r => r.liters], ['৳', r => r.total_cost_bdt], ['৳/L', r => r.price_per_liter],
      ['Full', r => (r.is_full_tank ? 'Yes' : 'No')], ['Station', r => r.station ?? ''],
    ],
    cost: r => r.total_cost_bdt,
  },

  maintenance: {
    table: 'maintenance_logs', title: 'Service', icon: '🔧', dateField: 'logged_on', attach: true, scan: true,
    items: true, itemsBefore: 'notes', // one visit = several services, each with its own cost
    fields: [date(), odo(), text('vendor', 'Workshop / shop'), notes()],
    cols: [
      ['Date', r => r.logged_on], ['Odo', r => r.odometer_km], ['Shop', r => r.vendor ?? ''],
      ['Services', r => itemsOf(r).map(i => `${i.title} ৳${i.cost_bdt}`).join(' · '), 'wrap'],
      ['Total ৳', r => visitTotal(r)],
    ],
    cost: r => visitTotal(r),
  },

  expense: {
    table: 'expenses', title: 'Expenses', icon: '🧾', dateField: 'logged_on', attach: true, scan: true,
    fields: [
      date(), odo(false),
      { name: 'category', label: 'Category', type: 'select', options: EXP, required: true },
      money('amount_bdt', 'Amount (৳)'), notes(),
    ],
    cols: [
      ['Date', r => r.logged_on], ['Type', r => label(EXP, r.category)],
      ['৳', r => r.amount_bdt], ['Notes', r => r.notes ?? ''],
    ],
    cost: r => r.amount_bdt,
  },

  incident: {
    table: 'incidents', title: 'Incidents', icon: '⚠️', dateField: 'occurred_on', attach: true,
    fields: [
      date('occurred_on', 'Date'), odo(false), text('location', 'Location'),
      { name: 'description', label: 'What happened', type: 'textarea', required: true },
      money('repair_cost_bdt', 'Repair cost (৳)'),
      { name: 'claim_status', label: 'Insurance claim', type: 'select', default: 'none',
        options: [['none', 'None'], ['filed', 'Filed'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['paid', 'Paid']] },
      notes(),
    ],
    cols: [
      ['Date', r => r.occurred_on], ['Where', r => r.location ?? ''], ['What', r => r.description],
      ['৳', r => r.repair_cost_bdt], ['Claim', r => r.claim_status],
    ],
    cost: r => r.repair_cost_bdt,
  },

  document: {
    table: 'documents', title: 'Documents', icon: '📄', dateField: 'expires_on', attach: true, scan: true,
    fields: [
      { name: 'doc_type', label: 'Document', type: 'select', options: DOCS, required: true, default: 'tax_token' },
      { name: 'issued_on', label: 'Issued on', type: 'date' },
      { name: 'expires_on', label: 'Expires on', type: 'date', required: true },
      money('cost_bdt', 'Cost (৳)', false), notes(),
    ],
    cols: [
      ['Document', r => label(DOCS, r.doc_type)], ['Issued', r => r.issued_on ?? ''],
      ['Expires', r => r.expires_on], ['Status', r => docStatus(r).when], ['৳', r => r.cost_bdt ?? ''],
    ],
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
