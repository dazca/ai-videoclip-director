// "An output landed": the runner finished a request, a file was imported, a node joined an iteration tree. The places
// that land outputs call landed(p, items); a domain that wants to know registers with onLanded (lib/ops/checks.mjs: the
// "identity check" ask of ROADMAP_v4 D7). batchLanded(fn) collects what lands inside fn (synchronous) and hands it over
// once at the end, merged per project, so a run that registers 3 outputs and adds 3 nodes makes one ask, not six.
// A handler never breaks what landed the output: its errors are swallowed.
//   item {file, request?, entity?, node?, media?, shot?, source: runner | import | iteration, from? (the output a node was made from)}
const handlers = [];
let depth = 0, pending = [];
export const onLanded = (fn) => { handlers.push(fn); };
function fire(p, items) { for (const h of handlers) { try { h(p, items); } catch (e) { /* an ask never breaks a run or an import */ } } }
export function landed(p, items) {
  const list = (items || []).filter(x => x && typeof x.file === 'string' && x.file);
  if (!list.length) return;
  if (depth) pending.push([p, list]); else fire(p, list);
}
export function batchLanded(fn) {
  depth++;
  try { return fn(); } finally {
    if (--depth === 0 && pending.length) {
      const q = pending; pending = [];
      const byP = new Map(); for (const [p, l] of q) byP.set(p, [...(byP.get(p) || []), ...l]);
      for (const [p, l] of byP) fire(p, l);
    }
  }
}
