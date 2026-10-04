// Undo / redo for every page edit (per session; snapshots are the durable history).
// store.mutate() reports {file, field, label, before, after}; we keep only the keyed differences (approval items,
// notes by id, requests by id, section overrides), so undo re-applies just those entries through store.mutate on the
// CURRENT file: an agent's unrelated edits made in between are kept.
import { store, toast } from '../js/store.js';

// a keyed view of each writable file's collection
const COLL = {
  approvals: { get: (d) => d.items, map: true },
  overrides: { get: (d) => (d.sections ||= {}), map: true },
  notes: { get: (d) => d.notes, sort: (a, b) => a.t - b.t },
  requests: { get: (d) => d.items },
};
function entries(field, d) {
  const C = COLL[field], c = C.get(d);
  return C.map ? new Map(Object.entries(c)) : new Map(c.map(x => [x.id, x]));
}
function diff(field, a, b) {
  const A = entries(field, a), B = entries(field, b), out = [];
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const x = A.get(k), y = B.get(k);
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ key: k, before: x === undefined ? undefined : structuredClone(x), after: y === undefined ? undefined : structuredClone(y) });
  }
  return out;
}
function apply(field, d, changes, side) {
  const C = COLL[field], c = C.get(d);
  for (const ch of changes) {
    const v = ch[side];
    if (C.map) { if (v === undefined) delete c[ch.key]; else c[ch.key] = structuredClone(v); continue; }
    const i = c.findIndex(x => x.id === ch.key);
    if (v === undefined) { if (i >= 0) c.splice(i, 1); }
    else if (i >= 0) c[i] = structuredClone(v); else c.push(structuredClone(v));
  }
  if (C.sort) c.sort(C.sort);
}

export const history = {
  undoStack: [], redoStack: [], limit: 200,
  record({ file, field, label, before, after }) {
    if (!COLL[field]) return;
    const changes = diff(field, before, after);
    if (!changes.length) return;
    this.undoStack.push({ file, field, label, changes });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    document.dispatchEvent(new CustomEvent('wb:history'));
  },
  async step(from, to, side, verb) {
    const e = from.pop(); if (!e) { toast(`nothing to ${verb}`); return false; }
    await store.mutate(e.file, (d) => apply(e.field, d, e.changes, side), { record: false });
    to.push(e); toast(`${verb}: ${e.label}`);
    document.dispatchEvent(new CustomEvent('wb:history'));
    return true;
  },
  undo() { return this.step(this.undoStack, this.redoStack, 'before', 'undo'); },
  redo() { return this.step(this.redoStack, this.undoStack, 'after', 'redo'); },
  peek() { return { undo: this.undoStack.at(-1)?.label, redo: this.redoStack.at(-1)?.label }; },
};
store.onMutate = (e) => history.record(e);
