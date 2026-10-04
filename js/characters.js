// Stage 4 of the guided flow (docs/SPEC_v3_GUIDED.md): characters. Pure functions, no DOM and no Node APIs: the page
// (tabs/charstage.js) and the data layer (lib/store.mjs) import the same code.
//
// A character entity (entities/characters/<id>.json) gains, next to its existing fields (name, role, looks[], breakdown
// {item, scenes} when it came from the breakdown):
//   base  {text, refs: [Ref], at, by, via}        what the identity sheet starts from (the director's choice, page only)
//     Ref  {path, source: catalog | openverse | photo | sketch | media, title?, private?, licence?, licence_url?,
//           creator?, url? (landing page), original? (full image URL), attribution?, catalog_id?, openverse_id?}
//          catalog paths are relative to the workbench folder ("catalog/body/x.jpg"); every other path is relative to the
//          project folder. A photo of a real person is always under private/ and flagged private: local only, never exported.
//   iter  {nodes: [Node], trees: {<tree>: Tree}, notes: [Note], log: [Entry]}     the iteration trees (append-only)
//     tree   "identity" or "look:<look id>" (one tree per look, each starting from the approved identity)
//     Node   {id "n03", tree, parent: id | null, from_identity?: id (a look's root), image, request, kind: identity | edit |
//             look, edit: {text, sketch?, mask?, png?, pins: [{n, x, y, text}]} | null, choice: null | kept | branch |
//             reverted, private?, at, by, via, note?}
//            A node is never changed or removed once written, except `choice` (the director's keep / branch / revert).
//            An agent adds nodes (character_iteration_add) from the output of an approved, done request; the first node
//            of a tree becomes its head; any later one waits for the director: keep (head = it), branch (kept on the
//            side, head unchanged), revert (dropped, head unchanged).
//     Tree   {head: node id, approved?: node id, approved_at?, approved_by?, via?}   approved = locked: page only
//     Note   {id "cn01", tree?, node?, text, by, via, to?: "agent", status, at, replies: [{id, text, by, via, at}]}
//     Entry  {at, by, via, act, tree?, node?, detail?}    every act (base, add, keep, branch, revert, approve, unlock,
//            look) is logged: the history of the tree, like the versions of the script and the breakdown
//   looks[i] gains {status: draft | review | approved, from?: breakdown | agent | page}; status approved only from the page.
// A generation is always a request in requests.json (draft -> approved in the page -> run by an agent) carrying
//   char {id, tree, from: node id | null, kind: identity | edit | look, text, sketch?, png?, mask?, pins?}
export const TREE_RE = /^(identity|look:[A-Za-z0-9_][A-Za-z0-9_-]{0,63})$/;
export const NODE_RE = /^n\d{1,5}$/;
export const CHOICES = ['kept', 'branch', 'reverted'];
export const REF_SOURCES = ['catalog', 'openverse', 'photo', 'sketch', 'media'];
// honest per-image estimates (USD, list prices of the image-edit models the agent would use; the agent corrects
// est_cost with request_update before the director approves when its tool costs differ)
export const EST = {
  identity: { tool: 'fal-ai/flux-pro/kontext/max/multi', usd: 0.08, why: 'one identity sheet (4 views + head) from the references, Kontext Max multi-image $0.08' },
  edit: { tool: 'fal-ai/flux-pro/kontext', usd: 0.04, why: 'one edited image, Kontext Pro $0.04' },
  edit_mask: { tool: 'fal-ai/flux-pro/v1/fill', usd: 0.05, why: 'one masked inpaint (~1 MP), FLUX.1 Fill Pro $0.05 per megapixel' },
  look: { tool: 'fal-ai/flux-pro/kontext/max/multi', usd: 0.08, why: 'one look sheet from the approved identity + the garment refs, Kontext Max multi-image $0.08' },
};
export const estimate = (kind, { mask = false, n = 1 } = {}) => {
  const e = EST[kind === 'edit' && mask ? 'edit_mask' : kind] || EST.edit;
  return { tool: e.tool, usd: +(e.usd * Math.max(1, n)).toFixed(2), why: e.why + (n > 1 ? ` x ${n} candidates` : '') };
};

const maxN = (list, re) => list.reduce((m, x) => Math.max(m, Number(re.exec(String(x?.id))?.[1]) || 0), 0);
export const emptyIter = () => ({ nodes: [], trees: {}, notes: [], log: [] });
export function normIter(it) {
  const d = it && typeof it === 'object' && !Array.isArray(it) ? { ...emptyIter(), ...it } : emptyIter();
  for (const k of ['nodes', 'notes', 'log']) if (!Array.isArray(d[k])) d[k] = [];
  if (!d.trees || typeof d.trees !== 'object' || Array.isArray(d.trees)) d.trees = {};
  return d;
}
export const nextNodeId = (iter) => `n${String(maxN(iter?.nodes || [], /^n(\d+)$/) + 1).padStart(2, '0')}`;
export const nextCharNoteId = (iter) => `cn${String(maxN(iter?.notes || [], /^cn(\d+)$/) + 1).padStart(2, '0')}`;
export const lookTree = (lookId) => `look:${lookId}`;
export const treeLook = (tree) => (String(tree || '').startsWith('look:') ? tree.slice(5) : null);
export const treeNodes = (iter, tree) => (iter?.nodes || []).filter(n => n.tree === tree);
export const nodeById = (iter, id) => (iter?.nodes || []).find(n => n.id === id) || null;
export const treeState = (iter, tree) => iter?.trees?.[tree] || {};
export const headNode = (iter, tree) => nodeById(iter, treeState(iter, tree).head);
export const approvedNode = (iter, tree) => nodeById(iter, treeState(iter, tree).approved);
export const identityApproved = (ent) => !!approvedNode(normIter(ent?.iter), 'identity');
// a node the director has not decided on yet (not the head, no choice)
export const pending = (iter, n) => !!n && !n.choice && treeState(iter, n.tree).head !== n.id;

// the tree as horizontal strips, one per branch: the first strip is the path from the root to the newest leaf of the
// main line; each further strip starts at a fork ({fork: the node it grows from, nodes}). Children in id order.
export function branches(iter, tree) {
  const ns = treeNodes(iter, tree), kids = new Map();
  for (const n of ns) { const k = ns.some(x => x.id === n.parent) ? n.parent : null; (kids.get(k) || kids.set(k, []).get(k)).push(n); }
  for (const l of kids.values()) l.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const out = [];
  const walk = (start, fork) => {
    const strip = { fork, nodes: [] }; out.push(strip);
    let n = start;
    while (n) {
      strip.nodes.push(n);
      const ch = kids.get(n.id) || [];
      // the main line follows the kept child (else the first); the others become strips of their own
      const main = ch.find(c => c.choice === 'kept') || ch.find(c => !c.choice) || ch[0];
      for (const c of ch) if (c !== main) walk(c, n.id);
      n = main;
    }
  };
  for (const r of kids.get(null) || []) walk(r, null);
  // the strip holding the head first, then by the id of their first node
  const head = treeState(iter, tree).head;
  return out.sort((a, b) => (b.nodes.some(n => n.id === head) - a.nodes.some(n => n.id === head)) || Number(a.nodes[0].id.slice(1)) - Number(b.nodes[0].id.slice(1)));
}
// the path root -> node (for "revert to")
export function pathTo(iter, id) { const out = []; let n = nodeById(iter, id); const seen = new Set(); while (n && !seen.has(n.id)) { seen.add(n.id); out.unshift(n); n = nodeById(iter, n.parent); } return out; }

// requests of a character (from requests.json): {id, status, char, est_cost, ...}
export const charRequests = (requests, id) => (requests?.items || requests || []).filter(r => r?.char?.id === id);
export const OPEN_REQ = ['draft', 'approved', 'queued', 'running'];
// where a character stands: base (no identity node yet) -> iterating -> identity approved -> looks
export function charStatus(ent, requests) {
  const it = normIter(ent?.iter), idn = treeNodes(it, 'identity');
  const reqs = charRequests(requests, ent?.id), open = reqs.filter(r => OPEN_REQ.includes(r.status));
  const looks = Array.isArray(ent?.looks) ? ent.looks : [], lapp = looks.filter(l => l.status === 'approved').length;
  const waiting = it.nodes.filter(n => pending(it, n)).length;
  let key, label;
  if (!idn.length) { key = 'base'; label = ent?.base?.refs?.length || ent?.base?.text ? (open.some(r => r.char?.tree === 'identity') ? 'base · requested' : 'base chosen') : 'needs a base'; }
  else if (!identityApproved(ent)) { key = 'iterating'; label = `identity · ${idn.length} node${idn.length > 1 ? 's' : ''}`; }
  else if (!looks.some(l => treeNodes(it, lookTree(l.id)).length)) { key = 'identity'; label = 'identity approved'; }
  else { key = 'looks'; label = `looks ${lapp}/${looks.length} approved`; }
  return { key, label, open: open.length, waiting, looks: looks.length, looks_approved: lapp };
}

// pins from a sketch (or a caller): [{n, x, y, text}], text trimmed
export const cleanPins = (pins) => (Array.isArray(pins) ? pins : []).filter(p => p && typeof p === 'object').slice(0, 50)
  .map((p, i) => ({ n: Math.round(Number(p.n)) || i + 1, x: Number(p.x) || 0, y: Number(p.y) || 0, text: String(p.text ?? '').slice(0, 1000) }));
const pinText = (pins) => pins.length ? ' Callouts on the sketch: ' + pins.map(p => `${p.n}. ${p.text || '(no text)'}`).join('; ') + '.' : '';
// the prompts the page drafts (the agent may refine them before the director approves)
export function identityPrompt(ent, base) {
  const refs = (base?.refs || []).map((r, i) => `image ${i + 1}: ${r.title || r.source}${r.source === 'photo' ? ' (the person\'s own photo: likeness)' : r.source === 'sketch' ? ' (the director\'s sketch)' : r.source === 'catalog' || r.source === 'openverse' ? ' (body / pose guide)' : ''}`);
  return `Character identity sheet of ${ent?.name || ent?.id}: front, three-quarter, side and back full-body views and a head close-up, the same person in every view, photographic, neutral grey background, even studio light.`
    + (base?.text ? ` Description: ${base.text.trim()}` : '') + (ent?.role ? ` Role: ${ent.role}.` : '') + (refs.length ? ` References: ${refs.join('; ')}.` : '');
}
export function editPrompt(ent, node, { text, pins = [], mask = false } = {}) {
  return `Edit ${node?.id || 'the image'} of ${ent?.name || ent?.id} (image 1): ${String(text || '').trim() || 'see the sketch'}.${pinText(pins)}`
    + (mask ? ' Change only the masked region (white in the mask).' : ' Image 2 is the director\'s sketch drawn over it: follow its marks.')
    + ' Keep the face, body, pose, framing and light unchanged elsewhere.';
}
export function lookPrompt(ent, look, idNode, { text = '', pins = [] } = {}) {
  return `${ent?.name || ent?.id} wearing the look "${look?.name || look?.id}"${(look?.garments || []).length ? ': ' + look.garments.join(', ') : ''}${(look?.colors || []).length ? ' (colours ' + look.colors.join(', ') + ')' : ''}. `
    + `The same person as image 1 (the approved identity ${idNode?.id || ''}): keep the face, body and proportions exactly; same sheet layout (front, three-quarter, side, back, head).`
    + (text ? ` ${String(text).trim()}` : '') + pinText(pins);
}
