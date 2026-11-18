// Observer: tiny pub/sub. db.js emits 'data:changed'; app.js re-renders.
const subs = new Map();

export const bus = {
  on(evt, fn) {
    if (!subs.has(evt)) subs.set(evt, new Set());
    subs.get(evt).add(fn);
    return () => subs.get(evt).delete(fn);
  },
  emit(evt, data) {
    subs.get(evt)?.forEach(fn => fn(data));
  },
};
