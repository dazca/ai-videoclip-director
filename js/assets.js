// The asset workspace logic shared by stage 4 (characters) and stage 5 (scenery: locations and props) of the guided flow
// (docs/SPEC_v3_GUIDED.md). Pure functions, no DOM and no Node APIs: the page (tabs/assetws.js) and the data layer
// (lib/store.mjs) import the same code. js/characters.js keeps the character names on top of it.
//
// Every asset entity (entities/{characters,locations,props}/<id>.json) can carry, next to its own fields:
//   base  {text, refs: [Ref], at, by, via}        what the first sheet starts from (the director's choice, page only)
//     Ref  {path, source: catalog | openverse | photo | sketch | media, title?, private?, licence?, licence_url?,
//           creator?, url?, original?, attribution?, catalog_id?, openverse_id?}
//          catalog paths are relative to the workbench folder; every other path to the project folder. A photo is
//          always under private/ and flagged private: local only, never exported.
//   iter  {nodes: [Node], trees: {<tree>: Tree}, notes: [Note], log: [Entry]}     append-only iteration trees
//     tree   the ROOT tree ("identity" for a character, "base" for a location or a prop) or one tree per VARIANT
//            ("look:<id>" for a character's look, "variant:<id>" for a location / prop variant), each variant tree
//            starting from the approved root
//     Node   {id "n03", tree, parent: id | null, from_identity?: id (a variant's root grows from the approved root node),
//             image, request, kind: identity | base | edit | look | variant, edit: {text, sketch?, mask?, png?, pins} |
//             null, choice: null | kept | branch | reverted, private?, at, by, via, note?}
//            never changed once written except `choice` (the director's keep / branch / revert)
//     Tree   {head, approved?, approved_at?, approved_by?, via?}      approved = locked: page only
//     Note   {id "cn01" | "an01", tree?, node?, scene?, text, by, via, to?: "agent", status, at, replies: [...]}
//     Entry  {at, by, via, act, tree?, node?, detail?}
//   looks[] (characters) / variants[] (locations, props): {id, name, status: draft | review | approved, from?: page |
//            agent | breakdown, notes?, images[], ...}; a variant adds axes {angle?, tod?, weather?, state?} and
//            scenes?: [scene ids] (where the agent proposes it); status approved only from the page
//   uses  {<scene id>: {variant: <variant / look id> | null (the root), by, via, at, note?}}   which variant each scene
//            needs: the director's pick (page only). Without a pick: the variant the agent proposed for that scene,
//            else the root. The storyboard reads it (sceneUses).
// A generation is always a request in requests.json (draft -> approved in the page -> run by an agent) carrying
//   asset {type: character | location | prop, id, tree, from: node id | null, kind, text?, sketch?, png?, mask?, pins?}
// (a character's request also carries the same link as `char` {id, tree, from, kind, ...}, the stage-4 name: readers
// take `asset` first, then `char`).
import * as P from './prices.js';
export const TYPES = ['character', 'location', 'prop'];
const ID = '[A-Za-z0-9_][A-Za-z0-9_-]{0,63}';
export const TREE_RE = new RegExp(`^(identity|base|look:${ID}|variant:${ID})$`);
export const NODE_RE = /^n\d{1,5}$/;
export const CHOICES = ['kept', 'branch', 'reverted'];
export const REF_SOURCES = ['catalog', 'openverse', 'photo', 'sketch', 'media'];
export const GEN_KINDS = ['identity', 'base', 'edit', 'look', 'variant'];

// the variant axes (locations: angle, time of day, weather; props: angle, state); `custom` = free text allowed
export const AXES = {
  angle: { label: 'angle', opts: ['wide', 'medium', 'reverse'], custom: true },
  tod: { label: 'time of day', opts: ['dawn', 'day', 'dusk', 'night'] },
  weather: { label: 'weather', opts: ['clear', 'overcast', 'rain', 'fog', 'snow'], custom: true },
  state: { label: 'state', opts: ['broken', 'lit', 'wet', 'open'], custom: true },
};
export const AXIS_RE = /^[\p{L}\p{N} _'’-]{1,40}$/u;

// per type: the root tree, the variant prefix and field, the words the page and the tools use
export const TYPE = {
  character: { root: 'identity', vprefix: 'look', vfield: 'looks', dir: 'characters', plural: 'characters', title: 'Character', Titles: 'Characters', stage: 'characters',
    rootWord: 'identity', sheetWord: 'identity sheet', vWord: 'look', vWords: 'looks', notePrefix: 'cn', axes: [], catKind: 'body',
    req: { root: 'identity-sheet', edit: 'character-edit', variant: 'look-sheet' }, gen: { root: 'identity', variant: 'look' },
    status: { root: 'identity', rootLabel: 'identity approved', variants: 'looks', vLabel: 'looks' } },
  location: { root: 'base', vprefix: 'variant', vfield: 'variants', dir: 'locations', plural: 'locations', title: 'Location', Titles: 'Locations', stage: 'scenery',
    rootWord: 'base', sheetWord: 'base plate', vWord: 'variant', vWords: 'variants', notePrefix: 'an', axes: ['angle', 'tod', 'weather'], catKind: 'location',
    req: { root: 'location-plate', edit: 'location-edit', variant: 'location-variant' }, gen: { root: 'base', variant: 'variant' },
    status: { root: 'approved', rootLabel: 'base approved', variants: 'variants', vLabel: 'variants' } },
  prop: { root: 'base', vprefix: 'variant', vfield: 'variants', dir: 'props', plural: 'props', title: 'Prop', Titles: 'Props', stage: 'scenery',
    rootWord: 'base', sheetWord: 'prop sheet', vWord: 'variant', vWords: 'variants', notePrefix: 'an', axes: ['angle', 'state'], catKind: 'prop',
    req: { root: 'prop-sheet', edit: 'prop-edit', variant: 'prop-variant' }, gen: { root: 'base', variant: 'variant' },
    status: { root: 'approved', rootLabel: 'base approved', variants: 'variants', vLabel: 'variants' } },
};
export const typeOf = (t) => TYPE[t] || null;

// honest per-image estimates (USD) from the one price table, js/prices.js (list prices with the day they were read);
// the agent corrects est_cost with request_update before the director approves when its tool costs differ
const sheet = (what) => { const e = P.estimateWith('sheet'); return { ...e, why: `${what}: ${e.why}` }; };
export const EST = {
  identity: sheet('one identity sheet (4 views + head) from the references'),
  edit: P.estimateWith('edit'),
  edit_mask: P.estimateWith('edit_mask'),
  look: sheet('one look sheet from the approved identity + the garment refs'),
  'location:base': sheet('one establishing plate (wide, empty of people) from the references'),
  'location:variant': sheet('one plate of the same place (new angle / light / weather) from the approved base'),
  'prop:base': sheet('one prop sheet (front, three-quarter, side, detail) from the references'),
  'prop:variant': sheet('one sheet of the same object (new angle / state) from the approved base'),
};
// estimate(kind) for characters (identity | edit | look); estimate(kind, {type}) for the others (base | variant | edit)
export const estimate = (kind, { mask = false, n = 1, type = 'character' } = {}) => {
  const k = kind === 'edit' ? (mask ? 'edit_mask' : 'edit') : type === 'character' ? kind : `${type}:${kind}`;
  const e = EST[k] || EST.edit;
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
export const nextNoteId = (iter, type = 'character') => { const px = TYPE[type]?.notePrefix || 'an'; return `${px}${String(maxN(iter?.notes || [], new RegExp(`^${px}(\\d+)$`)) + 1).padStart(2, '0')}`; };
// trees
export const rootTree = (type) => TYPE[type]?.root || 'identity';
export const variantTree = (type, vid) => `${TYPE[type]?.vprefix || 'look'}:${vid}`;
export const treeVariant = (tree) => { const m = /^(?:look|variant):(.+)$/.exec(String(tree || '')); return m ? m[1] : null; };
export const isRoot = (tree) => tree === 'identity' || tree === 'base';
// a tree name that belongs to this type ("identity" / "look:x" for characters, "base" / "variant:x" otherwise)
export const treeOk = (type, tree) => { const T = TYPE[type]; return !!T && TREE_RE.test(String(tree)) && (tree === T.root || String(tree).startsWith(T.vprefix + ':')); };
export const treeNodes = (iter, tree) => (iter?.nodes || []).filter(n => n.tree === tree);
export const nodeById = (iter, id) => (iter?.nodes || []).find(n => n.id === id) || null;
export const treeState = (iter, tree) => iter?.trees?.[tree] || {};
export const headNode = (iter, tree) => nodeById(iter, treeState(iter, tree).head);
export const approvedNode = (iter, tree) => nodeById(iter, treeState(iter, tree).approved);
export const rootApproved = (ent, type = ent?.kind) => !!approvedNode(normIter(ent?.iter), rootTree(type));
// a node the director has not decided on yet (not the head, no choice)
export const pending = (iter, n) => !!n && !n.choice && treeState(iter, n.tree).head !== n.id;
// the variants of an entity (looks for a character), objects only
export const variants = (ent, type = ent?.kind) => (Array.isArray(ent?.[TYPE[type]?.vfield || 'looks']) ? ent[TYPE[type]?.vfield || 'looks'] : []).filter(v => v && typeof v === 'object' && v.id);

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
      // the main line follows the kept child (else an undecided one, else any not kept as a branch); the others, and
      // every child kept as a branch, become strips of their own
      const main = ch.find(c => c.choice === 'kept') || ch.find(c => !c.choice) || ch.find(c => c.choice !== 'branch');
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

// a request's link to an asset tree: `asset` (any type), else the stage-4 `char` (a character)
export const linkOf = (r) => (r?.asset && typeof r.asset === 'object' ? r.asset : r?.char && typeof r.char === 'object' ? { type: 'character', ...r.char } : null);
export const assetRequests = (requests, type, id) => (requests?.items || requests || []).filter(r => { const l = linkOf(r); return l && (l.type || 'character') === type && l.id === id; });
export const OPEN_REQ = ['draft', 'approved', 'queued', 'running'];

// where an asset stands: base (no root node yet) -> iterating -> root approved -> variants
export function assetStatus(ent, requests, type = ent?.kind || 'character') {
  const T = TYPE[type] || TYPE.character, it = normIter(ent?.iter), rn = treeNodes(it, T.root);
  const reqs = assetRequests(requests, type, ent?.id), open = reqs.filter(r => OPEN_REQ.includes(r.status));
  const vs = variants(ent, type), vapp = vs.filter(v => v.status === 'approved').length;
  const waiting = it.nodes.filter(n => pending(it, n)).length;
  let key, label;
  if (!rn.length) { key = 'base'; label = ent?.base?.refs?.length || ent?.base?.text ? (open.some(r => linkOf(r)?.tree === T.root) ? 'base · requested' : 'base chosen') : 'needs a base'; }
  else if (!approvedNode(it, T.root)) { key = 'iterating'; label = `${T.rootWord} · ${rn.length} node${rn.length > 1 ? 's' : ''}`; }
  else if (!vs.some(v => treeNodes(it, variantTree(type, v.id)).length)) { key = T.status.root; label = T.status.rootLabel; }
  else { key = T.status.variants; label = `${T.status.vLabel} ${vapp}/${vs.length} approved`; }
  return { key, label, open: open.length, waiting, variants: vs.length, variants_approved: vapp };
}

// pins from a sketch (or a caller): [{n, x, y, text}], text trimmed
export const cleanPins = (pins) => (Array.isArray(pins) ? pins : []).filter(p => p && typeof p === 'object').slice(0, 50)
  .map((p, i) => ({ n: Math.round(Number(p.n)) || i + 1, x: Number(p.x) || 0, y: Number(p.y) || 0, text: String(p.text ?? '').slice(0, 1000) }));
export const pinText = (pins) => pins.length ? ' Callouts on the sketch: ' + pins.map(p => `${p.n}. ${p.text || '(no text)'}`).join('; ') + '.' : '';

// ------------------------------------------------------------------ variants: axes -> name / id
export function cleanAxes(type, axes) {
  const out = {};
  for (const k of TYPE[type]?.axes || []) { const v = String(axes?.[k] ?? '').trim().toLowerCase(); if (v && AXIS_RE.test(v)) out[k] = v.slice(0, 40); }
  return out;
}
export const axesName = (axes) => Object.values(axes || {}).filter(Boolean).join(' · ');
export const axesId = (axes) => Object.values(axes || {}).filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
export const axesText = (axes) => {
  const a = axes || {}, bits = [];
  if (a.angle) bits.push(`${a.angle} ${/^(wide|medium|reverse)$/.test(a.angle) ? (a.angle === 'reverse' ? 'angle (the reverse view)' : 'shot') : 'view'}`);
  if (a.tod) bits.push(`at ${a.tod === 'day' ? 'midday, daylight' : a.tod === 'night' ? 'night, practical lights only' : a.tod}`);
  if (a.weather) bits.push(a.weather === 'clear' ? 'clear weather' : a.weather);
  if (a.state) bits.push(`state: ${a.state}`);
  return bits.join(', ');
};

// ------------------------------------------------------------------ scenes: which variant each scene needs
// scenes = the asset's scene ids (breakdown links) + any scene with a pick; script = the current scenes (for times,
// titles). -> [{scene, t0, t1, title, variant: id | null, source: director | agent | default, missing?}]
export function sceneUses(ent, sceneIds, script = [], type = ent?.kind) {
  const uses = ent?.uses && typeof ent.uses === 'object' && !Array.isArray(ent.uses) ? ent.uses : {};
  const vs = variants(ent, type), ids = [...new Set([...(sceneIds || []), ...Object.keys(uses)])];
  const pos = (id) => { const s = script.find(x => x.id === id); return s ? s.t0 : Infinity; };
  return ids.sort((a, b) => pos(a) - pos(b) || a.localeCompare(b)).map(id => {
    const s = script.find(x => x.id === id), u = uses[id], prop = vs.find(v => Array.isArray(v.scenes) && v.scenes.includes(id));
    const variant = u ? (u.variant && vs.some(v => v.id === u.variant) ? u.variant : null) : prop ? prop.id : null;
    return { scene: id, ...(s ? { t0: s.t0, t1: s.t1, title: s.title } : { missing: true }), variant, source: u ? (u.via === 'page' ? 'director' : 'agent') : prop ? 'agent' : 'default', ...(u?.note ? { note: u.note } : {}) };
  });
}
// the image a variant (or the root) stands for right now: approved, else head
export function variantImage(ent, vid, type = ent?.kind) {
  const it = normIter(ent?.iter), t = vid ? variantTree(type, vid) : rootTree(type);
  return (approvedNode(it, t) || headNode(it, t))?.image || null;
}

// ------------------------------------------------------------------ the prompts the page drafts (the agent may refine them)
const refList = (base, person) => (base?.refs || []).map((r, i) => `image ${i + 1}: ${r.title || r.source}${r.source === 'photo' ? (person ? ' (the person\'s own photo: likeness)' : ' (a photo of the real place / object)') : r.source === 'sketch' ? ' (the director\'s sketch)' : r.source === 'catalog' || r.source === 'openverse' ? (person ? ' (body / pose guide)' : ' (reference)') : ''}`);
export function rootPrompt(type, ent, base) {
  const refs = refList(base, type === 'character'), d = base?.text ? ` Description: ${base.text.trim()}` : '', r = refs.length ? ` References: ${refs.join('; ')}.` : '';
  if (type === 'character') return `Character identity sheet of ${ent?.name || ent?.id}: front, three-quarter, side and back full-body views and a head close-up, the same person in every view, photographic, neutral grey background, even studio light.`
    + d + (ent?.role ? ` Role: ${ent.role}.` : '') + r;
  if (type === 'location') return `Establishing plate of the location "${ent?.name || ent?.id}": a wide, photographic view of the place, empty of people, natural light, the layout readable, eye-level camera.`
    + d + (ent?.description && !base?.text ? ` ${ent.description}.` : '') + r;
  return `Prop sheet of "${ent?.name || ent?.id}": front, three-quarter, side and a close detail of the same object, photographic, neutral grey background, even studio light, true scale cues.`
    + d + (ent?.description && !base?.text ? ` ${ent.description}.` : '') + r;
}
export function editPromptFor(type, ent, node, { text, pins = [], mask = false } = {}) {
  const keep = type === 'character' ? 'Keep the face, body, pose, framing and light unchanged elsewhere.' : type === 'location' ? 'Keep the architecture, layout, camera, light and materials unchanged elsewhere.' : 'Keep the object\'s shape, materials, framing and light unchanged elsewhere.';
  return `Edit ${node?.id || 'the image'} of ${ent?.name || ent?.id} (image 1): ${String(text || '').trim() || 'see the sketch'}.${pinText(pins)}`
    + (mask ? ' Change only the masked region (white in the mask).' : ' Image 2 is the director\'s sketch drawn over it: follow its marks.') + ' ' + keep;
}
export function variantPrompt(type, ent, v, rootNode, { text = '', pins = [] } = {}) {
  if (type === 'character') return `${ent?.name || ent?.id} wearing the look "${v?.name || v?.id}"${(v?.garments || []).length ? ': ' + v.garments.join(', ') : ''}${(v?.colors || []).length ? ' (colours ' + v.colors.join(', ') + ')' : ''}. `
    + `The same person as image 1 (the approved identity ${rootNode?.id || ''}): keep the face, body and proportions exactly; same sheet layout (front, three-quarter, side, back, head).`
    + (text ? ` ${String(text).trim()}` : '') + pinText(pins);
  const what = axesText(v?.axes) || v?.name || v?.id, notes = v?.notes ? ` ${String(v.notes).trim()}` : '';
  if (type === 'location') return `The location "${ent?.name || ent?.id}" (image 1, the approved base ${rootNode?.id || ''}), ${what}. The same place: keep the architecture, layout, materials and set dressing exactly; change only the camera and the light / weather as asked; photographic, empty of people.`
    + notes + (text ? ` ${String(text).trim()}` : '') + pinText(pins);
  return `The prop "${ent?.name || ent?.id}" (image 1, the approved base ${rootNode?.id || ''}), ${what}. The same object: keep its shape, proportions, materials and markings; change only the view and the state as asked; photographic, neutral background.`
    + notes + (text ? ` ${String(text).trim()}` : '') + pinText(pins);
}
