// Small stroke icons, drawn to sit with the heavy condensed type.
const P = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h13"/><path d="M7 8h5"/><path d="M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V9l-3-3"/>',
  wrench: '<circle cx="8" cy="8" r="4"/><path d="M11 11l9 9"/><path d="M17 20l3-3"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  more: '<circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5"/><circle cx="12" cy="18" r=".6" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  spark: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  chat: '<path d="M4 5h16v11H10l-5 4v-4H4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  clip: '<path d="M20 11l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  out: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
};

export const icon = (name, size = 22) =>
  `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
