// Stages 4 and 5: entities (characters, locations, props: entities_list / entity_get / entity_upsert) and the asset
// workspace on one code path (iteration trees, base, variants / looks, the variant per scene, proposals, imports), the
// page-only acts (asset_act / character_act, ref_upload).
import fs from 'node:fs';
import path from 'node:path';
import * as SC from '../../js/scenes.js';
import * as BD from '../../js/breakdown.js';
import * as CH from '../../js/characters.js';
import * as A from '../../js/assets.js';
import { DIRECTOR_STATES, IMAGE, WB_DIR, approvalOk, cleanRel, fail, inside, isFlaggedPrivate, isPrivate, makeThumbs, nowIso, ops, projDir, read, readJSON, resolveMedia, shotsDoc, tc, validId, write, writeAtomic, writeJSON } from './_shared.mjs';
import { falgenSource } from './requests.mjs';
import { startStage } from './lyrics.mjs';
import { scenesDoc, sketchId, sketchView } from './scenes.mjs';
import { breakdownDoc } from './breakdown.mjs';
import { addNote, notesDoc, replyNote, setStatus } from './notes.mjs';
import * as N from '../../js/notes.js';
// the notes on one asset (notes.json v2: target id = the entity id or "<entity>/<node | tree | scene>") in the old
// iter.notes shape {id, tree?, node?, scene?, pin?, text, by, via, to?, status open | resolved, replies}
function assetNotes(p, ent, it, status = 'all') {
  const st = N.assetStage(ent.kind), mine = (n) => n.target.stage === st && (n.target.id === ent.id || String(n.target.id || '').startsWith(ent.id + '/'));
  return notesDoc(p).notes.filter(mine).map(n => ({ ...N.legacyView(n, 'asset', { nodeTree: (x) => A.nodeById(it, x)?.tree }), _v2: n }))
    .filter(n => status === 'all' || n.status === status);
}
const assetTarget = (type, id, { node, tree, scene, pin } = {}) => ({ stage: N.assetStage(type), ...(node ? { kind: 'node', id: `${id}/${node}` } : tree ? { kind: 'tree', id: `${id}/${tree}` } : scene ? { kind: 'use', id: `${id}/${scene}` } : { kind: 'asset', id }), ...(pin ? { pin } : {}) });
const noV2 = ({ _v2, ...n }) => n;

// a look's colours are rendered into a style attribute (a swatch): hex only (#rgb, #rgba, #rrggbb, #rrggbbaa), else 400
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export function hexColors(list, where = 'colors') {
  if (list == null) return [];
  const a = Array.isArray(list) ? list : [list];
  const bad = a.find(c => typeof c !== 'string' || !HEX_COLOR.test(c.trim()));
  if (bad !== undefined) fail(400, `${where}: hex colours only (#rgb or #rrggbb), got ${JSON.stringify(String(bad)).slice(0, 60)}`);
  return a.map(c => c.trim()).slice(0, 40);
}

Object.assign(ops, {
  // ---------------- entities: characters (with looks), locations, props
  entities_list(p, { kind } = {}) {
    const idx = read(p, 'entities/index.json');
    return idx.filter(e => !kind || e.kind === kind).map(e => { const x = readJSON(path.join(projDir(p), e.path), {}) || {};
      return { id: e.id, kind: e.kind, name: e.name, status: x.status, role: x.role || x.description, thumb: x.thumb, face: x.face, looks: (x.looks || []).map(l => l.id), images: (x.images || x.refs || []).length }; });
  },
  entity_get(p, { id }) {
    const e = read(p, 'entities/index.json').find(x => x.id === id);
    if (!e) fail(404, `no entity "${id}" (entities_list)`);
    const x = readJSON(path.join(projDir(p), e.path), {});
    const shots = shotsDoc(p).shots.filter(s => s.cast?.includes(id) || s.locations?.includes(x.letter)).map(s => ({ id: s.id, t0: s.t0, time: tc(s.t0) }));
    return { ...x, path: e.path, used_in_shots: shots, state: read(p, 'approvals.json').items?.[`${e.kind}:${id}`]?.state || 'draft' };
  },
  // import_ok: a local script building a project (tools/make_demo.mjs) may write approved looks; serve.mjs strips it
  // from every HTTP call and the MCP tool has no such field
  entity_upsert(p, { kind, id, name, fields = {}, look, thumb_src, import_ok = false }) {
    // look colours end up in a style attribute: hex only (an old stored colour stays; the page renders hex only)
    if (look?.colors != null) look = { ...look, colors: hexColors(look.colors, 'look.colors') };
    if (Array.isArray(fields?.looks)) { const old = readJSON(path.join(projDir(p), `entities/${kind}s/${validId(id) ? id : '_'}.json`), {}, true) || {};
      for (const l of fields.looks) if (l?.colors != null) { const was = (old.looks || []).find(x => x?.id === l.id)?.colors || []; hexColors((Array.isArray(l.colors) ? l.colors : [l.colors]).filter(c => !was.includes(c)), 'looks[].colors'); } }
    if (!['character', 'location', 'prop'].includes(kind)) fail(400, 'kind must be character, location or prop');
    if (!validId(id)) fail(400, 'id: letters, digits, _ and - only');
    const idx = read(p, 'entities/index.json'), rel = `entities/${kind}s/${id}.json`, file = path.join(projDir(p), rel);
    const prev = idx.find(e => e.id === id);
    if (prev && prev.kind !== kind) fail(409, `"${id}" is already a ${prev.kind}`);
    const stored = readJSON(file, {}, true) || {}, warnings = [];
    // the iteration trees, the base and the per-scene picks are the asset tools' (asset_* / character_*, the page): never
    // through a plain merge
    fields = { ...(fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}) };
    for (const k of ['iter', 'base', 'uses']) if (k in fields) { warnings.push(`${k} ignored: the ${kind === 'character' ? 'Characters' : 'Scenery'} stage writes it (${kind === 'character' ? 'character_iteration_add' : 'asset_iteration_add'}, the page)`); delete fields[k]; }
    // an approved look is the director's (Characters stage, page only)
    const wasApproved = (lid) => (stored.looks || []).some(l => l?.id === lid && DIRECTOR_STATES.includes(l.status));
    if (!import_ok) {
      if (look && DIRECTOR_STATES.includes(look.status) && !wasApproved(look.id)) fail(403, 'only the director approves a look, in the page (Characters stage); use status "review" and say why (character_note_add)');
      if (Array.isArray(fields.looks) && fields.looks.some(l => DIRECTOR_STATES.includes(l?.status) && !wasApproved(l?.id))) fail(403, 'only the director approves a look, in the page (Characters stage)');
      const wasVApproved = (vid) => (Array.isArray(stored.variants) ? stored.variants : []).some(v => v?.id === vid && DIRECTOR_STATES.includes(v.status));
      if (Array.isArray(fields.variants) && fields.variants.some(v => DIRECTOR_STATES.includes(v?.status) && !wasVApproved(v?.id))) fail(403, 'only the director approves a variant, in the page (Scenery stage); variant_create proposes one in "review"');
    }
    const e = { id, kind, status: 'draft', refs: [], ...stored, ...fields, ...(name ? { name } : {}), id, kind };   // fields never change id / kind
    e.name ||= id;
    if (look) {
      if (!look.id || !validId(look.id)) fail(400, 'look.id required (letters, digits, _ and -)');
      e.looks ||= []; const i = e.looks.findIndex(l => l.id === look.id);
      const merged = { images: [], garments: [], colors: [], status: 'draft', ...(i >= 0 ? e.looks[i] : {}), ...look };
      if (i >= 0) e.looks[i] = merged; else e.looks.push(merged);
    }
    if (thumb_src) {
      const abs = resolveMedia(p, thumb_src);
      if (abs && fs.existsSync(abs)) { const r = makeThumbs(abs, path.join(projDir(p), 'thumbs'), id, { name: 'ent_' + id, priv: isPrivate(thumb_src) || isFlaggedPrivate(thumb_src, [p]) }); if (r.thumb) e.thumb = r.thumb; e.thumb_src = thumb_src; }
    }
    writeJSON(file, e);
    if (!prev) idx.push({ id, kind, name: e.name, path: rel }); else prev.name = e.name;
    write(p, 'entities/index.json', idx);
    return { created: !prev, entity: e, ...(warnings.length ? { warnings } : {}) };
  },
});

// ------------------------------------------------------------------ stages 4 and 5: assets (characters, locations, props)
// One code path for every asset kind. Formats and the shared logic live in js/assets.js (js/characters.js keeps the
// stage-4 names). The trees live in the entity file (iter{}), next to its base{}, its variants (looks[] for a
// character, variants[] for a location or a prop) and uses{} (the variant each scene needs). Rules: every generation is
// a request (requests.json, `asset` link; a character's also as `char`); an agent adds a node only from the output of a
// request the director approved and that ran (asset_iteration_add); the director's acts (the base, keep / branch /
// revert, approve / unlock the root or a variant, new variants, the variant per scene, notes from the page) go through
// asset_act (character_act for a character), which serve.mjs lets through only for a same-origin browser request (via
// "page"); the MCP server has no such tool. Reference uploads (ref_upload, page only) must be real images; a photo goes
// to private/refs/<id>/ and is flagged private (local only, never exported).
const CATALOG_DIR = path.join(WB_DIR, 'catalog');
export const assetType = (t) => { const x = t == null || t === '' ? 'character' : String(t); if (!Object.hasOwn(A.TYPE, x)) fail(400, 'type: character, location or prop'); return x; };
const treeHint = (type) => `"${A.TYPE[type].root}" or "${A.TYPE[type].vprefix}:<${A.TYPE[type].vWord} id>"`;
function assetEntry(p, type, id) {
  if (!validId(id)) fail(400, `id: a ${type} entity id`);
  const e = read(p, 'entities/index.json').find(x => x.id === id);
  if (!e || e.kind !== type) fail(404, type === 'character' ? `no character "${id}" (character_get without id lists them; the director makes one from the breakdown)` : `no ${type} "${id}" (asset_get {type: "${type}"} lists them; the director makes one from the breakdown)`);
  return e;
}
export function readAsset(p, type, id) { const e = assetEntry(p, type, id); const ent = readJSON(path.join(projDir(p), e.path), {}, true) || {}; ent.iter = A.normIter(ent.iter); return { rel: e.path, ent }; }
function mutateAsset(p, type, id, fn) {
  const { rel, ent } = readAsset(p, type, id); const r = fn(ent, ent.iter);
  writeJSON(path.join(projDir(p), rel), ent); return r === undefined ? ent : r;
}
const logAct = (it, x) => { it.log.push({ at: nowIso(), ...x }); if (it.log.length > 2000) it.log.splice(0, it.log.length - 2000); };
// a ref path -> absolute file: catalog/... under the workbench's catalogue, else the project / a media root
export function refFile(p, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  if (/^catalog\//i.test(rel)) { if (!cleanRel(rel)) return null; const abs = inside(CATALOG_DIR, rel.slice(8)); return abs && fs.existsSync(abs) ? abs : null; }
  const abs = resolveMedia(p, rel); return abs && fs.existsSync(abs) ? abs : null;
}
const refPrivate = (p, rel) => isPrivate(rel) || isFlaggedPrivate(rel, [p]);
// a request's link to a tree, checked: {id, tree, from, kind, text?, sketch?, png?, mask?, pins?}
export function checkAssetLink(p, c, type) {
  const T = A.TYPE[type], name = type === 'character' ? 'char' : 'asset';
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail(400, `${name}: {${type === 'character' ? '' : 'type, '}id, tree: ${treeHint(type)}, from: node id | null, kind}`);
  const { ent } = readAsset(p, type, String(c.id || ''));
  const tree = String(c.tree || T.root);
  if (!A.treeOk(type, tree)) fail(400, `${name}.tree: ${treeHint(type)}`);
  const vid = A.treeVariant(tree);
  if (vid && !A.variants(ent, type).some(v => v.id === vid)) fail(404, `no ${T.vWord} "${vid}" on ${ent.id} (${type === 'character' ? 'look_create' : 'variant_create'})`);
  const from = c.from == null || c.from === '' ? null : String(c.from);
  if (from && !A.nodeById(ent.iter, from)) fail(404, `${name}.from: no node "${from}" on ${ent.id}`);
  const kinds = type === 'character' ? ['identity', 'edit', 'look'] : ['base', 'edit', 'variant'];
  const kind = kinds.includes(c.kind) ? c.kind : (from ? 'edit' : vid ? T.gen.variant : T.gen.root);
  if (c.sketch != null) sketchId(String(c.sketch));
  return { id: ent.id, tree, from, kind, ...(c.text ? { text: String(c.text).slice(0, 4000) } : {}), ...(c.sketch ? { sketch: String(c.sketch) } : {}),
    ...(typeof c.png === 'string' ? { png: c.png.slice(0, 300) } : {}), ...(typeof c.mask === 'string' ? { mask: c.mask.slice(0, 300) } : {}), pins: A.cleanPins(c.pins) };
}
export function sketchInfo(p, id) { if (!id) return null; try { const v = sketchView(p, id); return { id, png: v.png, mask: v.mask_png, files: v.files, pins: v.pins, private: v.private }; } catch (e) { return { id, missing: true }; } }
function nodeView(p, n) { return { ...n, file: refFile(p, n.image) }; }
// the breakdown item an entity came from (the director's "Create entity") and the scenes it links
function assetItem(bd, ent) {
  const id = Object.entries(bd?.states || {}).find(([k, s]) => s?.entity_id === ent.id && BD.currentBreakdown(bd)?.items.find(i => i.id === k)?.kind === ent.kind)?.[0]
    || Object.entries(bd?.states || {}).find(([, s]) => s?.entity_id === ent.id)?.[0];
  return id ? { id, item: BD.currentBreakdown(bd)?.items.find(i => i.id === id) || null } : { id: null, item: null };
}
const assetScenes = (bd, ent) => { const { item } = assetItem(bd, ent); return item ? BD.itemScenes(item) : ent.breakdown?.scenes || []; };
function assetSummary(p, type, idxE, requests, bd) {
  const ent = readJSON(path.join(projDir(p), idxE.path), {}) || {}; ent.iter = A.normIter(ent.iter);
  const st = A.assetStatus(ent, requests, type), { id: item } = assetItem(bd, ent);
  return { id: ent.id, name: ent.name, status: st.key, label: st.label, scenes: assetScenes(bd, ent), breakdown_item: item || ent.breakdown?.item || null,
    base: { refs: (ent.base?.refs || []).length, text: !!ent.base?.text }, nodes: ent.iter.nodes.length, waiting_for_director: st.waiting, open_requests: st.open,
    ...(type === 'character' ? { looks: st.variants, looks_approved: st.variants_approved } : { variants: st.variants, variants_approved: st.variants_approved }) };
}
const sceneIdOk = (s) => typeof s === 'string' && BD.ITEM_ID.test(s);
// base refs (the director's act, or an agent's proposal): [{path, source, ...}] checked; a photo must be private
function cleanBaseRefs(p, list, name = 'base.refs') {
  return (Array.isArray(list) ? list : []).slice(0, 24).map((r0, i) => {
    const r = typeof r0 === 'string' ? { path: r0, source: /^catalog\//i.test(r0) ? 'catalog' : 'media' } : r0;
    if (!r || typeof r.path !== 'string' || !cleanRel(r.path) || r.path.length > 300) fail(400, `${name}[${i}].path`);
    if (!A.REF_SOURCES.includes(r.source)) fail(400, `${name}[${i}].source: one of ${A.REF_SOURCES.join(', ')}`);
    if (!refFile(p, r.path)) fail(404, `${name}[${i}]: no such file ${r.path}`);
    const priv = refPrivate(p, r.path);
    if (r.source === 'photo' && !priv) fail(400, `${name}[${i}]: a photo must be uploaded as private (ref_upload)`);
    const s = (k, n = 500) => (typeof r[k] === 'string' && r[k] ? { [k]: r[k].slice(0, n) } : {});
    return { path: r.path, source: r.source, ...(priv ? { private: true } : {}), ...s('title', 200), ...s('licence', 60), ...s('licence_url'), ...s('creator', 200), ...s('url'), ...s('original'), ...s('attribution', 1000), ...s('catalog_id', 80), ...s('openverse_id', 80) };
  });
}
// a registered image (media.json, by id or path) -> {m, abs}; only images, only files that exist
function mediaImage(p, media) {
  if (typeof media !== 'string' || !media) fail(400, 'media: a media id or path from media_list');
  const items = read(p, 'media.json').items || [], key = media.replace(/\\/g, '/').toLowerCase();
  const m = items.find(x => x.id === media) || items.find(x => String(x.path).toLowerCase() === key);
  if (!m) fail(404, `no registered media "${media}" (media_list; register a file with media_add first)`);
  if (!IMAGE.test(m.path)) fail(400, `${m.id} is not an image (${m.path})`);
  if (!refFile(p, m.path)) fail(404, `${m.id}: the file ${m.path} is missing`);
  return m;
}
// where an imported image's money went: the workbench cost item of its job / request, else the falgen ledger row
function provenanceOf(p, m) {
  const C = read(p, 'costs.json'), keys = [m.job, m.request].filter(Boolean);
  const item = (C.items || []).find(x => keys.includes(x.id) || keys.includes(x.job) || keys.includes(x.request));
  let cost = item ? { source: 'workbench', id: item.id, usd: item.usd, via: item.via || null, date: item.date || null } : null;
  if (!cost && m.job) { try { const r = falgenSource(p)?.rows.find(x => x.job === m.job); if (r) cost = { source: 'falgen', job: r.job, usd: r.usd, date: r.date }; } catch (e) { /* no ledger */ } }
  // a job's cost covers all its takes: an image from one take carries its share (usd = the job / takes), so summing the
  // provenance of a job's takes gives the job once. Takes = the job's registered images (or the highest take + 1, or the
  // takes cost_record was told), whichever is more
  if (cost && m.take != null && (item ? item.take == null : true)) {
    const job = m.job ?? m.request, mine = (read(p, 'media.json').items || []).filter(x => x.job === job && IMAGE.test(String(x.path)));
    const n = Math.max(Number(item?.takes) || 1, new Set(mine.map(x => x.take ?? x.path)).size, ...mine.map(x => (Number.isInteger(x.take) ? x.take + 1 : 1)));
    if (n > 1) cost = { ...cost, usd: +(cost.usd / n).toFixed(4), job_usd: cost.usd, takes: n, take: m.take, share: `take ${m.take} of ${n}: the job's $${cost.usd} split per take` };
  }
  return { media: m.id, path: m.path, ...(m.job ? { job: m.job } : {}), ...(m.take != null ? { take: m.take } : {}), ...(m.request ? { request: m.request } : {}), cost };
}
// the director imports a registered image as a node (no request, nothing paid): origin "imported" + its provenance
function importNode(p, type, ent, it, { tree, media, why, proposal }, stamp) {
  const T = A.TYPE[type];
  if (!A.treeOk(type, tree)) fail(400, `tree: ${treeHint(type)}`);
  const vid = A.treeVariant(tree);
  if (vid && !A.variants(ent, type).some(v => v.id === vid)) fail(404, `no ${T.vWord} "${vid}" on ${ent.id}`);
  if (A.treeState(it, tree).approved) fail(409, `${tree} is approved (locked): unlock it first`);
  const rn = A.approvedNode(it, T.root);
  if (vid && !rn) fail(409, `${ent.id}: approve the ${T.rootWord} first (or import an image as it): a ${T.vWord} starts from the approved ${T.rootWord}`);
  const m = mediaImage(p, media);
  const dup = it.nodes.find(n => n.tree === tree && n.origin === 'imported' && n.image.toLowerCase() === m.path.toLowerCase());
  if (dup) fail(409, `${m.id} is already node ${dup.id} of ${tree}`);
  const priv = !!m.private || refPrivate(p, m.path);
  const head = A.treeState(it, tree).head;
  const n = { id: A.nextNodeId(it), tree, parent: null, ...(vid ? { from_identity: rn.id } : {}), image: m.path, request: null, kind: 'import', origin: 'imported', provenance: provenanceOf(p, m),
    edit: null, choice: 'kept', ...(priv ? { private: true } : {}), at: nowIso(), ...stamp, ...(why ? { note: String(why).slice(0, 2000) } : {}), ...(proposal ? { proposal: proposal.id, proposed_by: proposal.by } : {}) };
  it.nodes.push(n); it.trees[tree] ||= {}; it.trees[tree].head = n.id;
  logAct(it, { ...stamp, act: 'import', tree, node: n.id, detail: `${m.id}${head ? ` (head was ${head})` : ''}${proposal ? ` · proposal ${proposal.id}` : ''}` });
  return n;
}
Object.assign(ops, {
  // without id: every asset of the type(s) (status, scenes, open requests) and the breakdown items not yet entities; with
  // id: the whole workspace: base (refs with files), the trees (nodes with image files, branches, head, approved), the
  // variants, the variant each scene needs, the requests (pending edits with the sketch PNG / mask paths and the pins),
  // notes, asks
  asset_get(p, { type, id, notes = 'open' } = {}) {
    const R = read(p, 'requests.json'), bd = breakdownDoc(p), cur = BD.currentBreakdown(bd);
    if (!id) {
      const types = type ? [assetType(type)] : A.TYPES, idx = read(p, 'entities/index.json');
      const out = {};
      for (const t of types) out[A.TYPE[t].plural] = idx.filter(e => e.kind === t).map(e => assetSummary(p, t, e, R, bd));
      out.not_entities_yet = (cur?.items || []).filter(i => types.includes(i.kind) && !i.dropped && !bd.states?.[i.id]?.entity_id).map(i => ({ item: i.id, kind: i.kind, name: i.name, scenes: BD.itemScenes(i) }));
      out.rules = 'the director makes an entity in the page (Breakdown: Create entity); every generation is a request_create draft with asset {type, id, tree, from, kind}; run approved ones only, then asset_iteration_add. The director sets the base in the page (propose one: base_propose). An image that already exists (a legacy look, an output made outside the queue): node_import_propose';
      return out;
    }
    if (!type) { const e = read(p, 'entities/index.json').find(x => x.id === id); type = e?.kind; }
    type = assetType(type);
    const T = A.TYPE[type], { ent } = readAsset(p, type, id), it = ent.iter, vs = A.variants(ent, type);
    const trees = [T.root, ...vs.map(v => A.variantTree(type, v.id))].map(t => ({ tree: t, ...A.treeState(it, t), nodes: A.treeNodes(it, t).map(n => nodeView(p, n)), branches: A.branches(it, t).map(b => ({ fork: b.fork, nodes: b.nodes.map(n => n.id) })) }));
    const reqs = A.assetRequests(R, type, id).map(r => { const L = A.linkOf(r); return { id: r.id, kind: r.kind, status: r.status, est_cost: r.est_cost, tool: r.tool, prompt: r.prompt, refs: r.refs, ref_files: (r.refs || []).map(x => refFile(p, x)),
      tree: L.tree, from: L.from, [type === 'character' ? 'char_kind' : 'gen_kind']: L.kind, text: L.text || null, pins: L.pins || [], sketch: sketchInfo(p, L.sketch), mask_png: L.mask || null,
      outputs: r.outputs || [], nodes: it.nodes.filter(n => n.request === r.id).map(n => n.id), approved_by_director: approvalOk(r) }; });
    const ns = assetNotes(p, ent, it, notes).map(noV2);
    const script = SC.currentScript(scenesDoc(p))?.scenes || [];
    const vView = (v) => { const t = A.variantTree(type, v.id); return { id: v.id, name: v.name, status: v.status || 'draft', from: v.from || null, notes: v.notes || '', tree: t, head: A.treeState(it, t).head || null, approved: A.treeState(it, t).approved || null, breakdown: v.breakdown || null,
      ...(type === 'character' ? { garments: v.garments || [], colors: v.colors || [] } : { axes: v.axes || {}, scenes: v.scenes || [] }) }; };
    const vname = (vid) => vid ? (vs.find(v => v.id === vid)?.name || vid) : T.rootWord;
    return { type, id: ent.id, name: ent.name, ...(type === 'character' ? { role: ent.role || null, constants: Array.isArray(ent.constants) ? ent.constants : [] } : { description: ent.description || null }), breakdown: ent.breakdown || null,
      status: type === 'character' ? CH.charStatus(ent, R) : A.assetStatus(ent, R, type),
      base: ent.base ? { ...ent.base, refs: (ent.base.refs || []).map(r => ({ ...r, file: refFile(p, r.path) })) } : null,
      base_proposal: it.base_proposal ? { ...it.base_proposal, refs: (it.base_proposal.refs || []).map(r => ({ ...r, file: refFile(p, r.path) })) } : null,
      import_proposals: (Array.isArray(it.proposals) ? it.proposals : []).filter(x => x.status === 'open'),
      root_tree: T.root, root_approved: A.treeState(it, T.root).approved || null, ...(type === 'character' ? { identity_approved: A.treeState(it, 'identity').approved || null } : {}),
      [T.vfield]: vs.map(vView), trees, requests: reqs,
      scenes: A.sceneUses(ent, assetScenes(bd, ent), script, type).map(u => ({ ...u, variant_name: vname(u.variant), image: A.variantImage(ent, u.variant, type) })),
      to_run: reqs.filter(r => ['approved', 'queued', 'running'].includes(r.status) && r.approved_by_director).map(r => r.id),
      to_register: reqs.filter(r => r.status === 'done' && !r.nodes.length).map(r => r.id),
      waiting_for_director: it.nodes.filter(n => A.pending(it, n)).map(n => n.id),
      notes: ns, asks_for_agent: assetNotes(p, ent, it, 'open').filter(n => n.to === 'agent').map(n => ({ id: n.id, tree: n.tree || null, node: n.node || null, scene: n.scene || null, text: n.text, replies: n.replies?.length || 0 })),
      log: it.log.slice(-20),
      next: !ent.base && !it.base_proposal ? `no base yet: the director sets it in the page; propose one with base_propose {type: "${type}", id: "${ent.id}", text, refs}` : !A.approvedNode(it, T.root) && !A.treeNodes(it, T.root).length ? `no ${T.rootWord} node yet: request the ${T.sheetWord} (request_create asset {tree: "${T.root}", from: null}) or, if an image already exists, node_import_propose {tree: "${T.root}", media, why}` : null,
      rules: `propose generations with request_create (asset {type: "${type}", id, tree, from, kind}, refs, tool, honest est_cost); run only approved ones (request_update queued -> running -> done with outputs + actual cost), then asset_iteration_add {type, id, request}; keep / branch / revert, approving the ${T.rootWord} or a ${T.vWord} and the ${T.vWord} each scene uses are the director's, in the page` };
  },
  character_get(p, { id, notes } = {}) {
    if (id) return ops.asset_get(p, { type: 'character', id, notes });
    const r = ops.asset_get(p, { type: 'character' });
    return { characters: r.characters, not_entities_yet: r.not_entities_yet.map(({ kind: _k, ...x }) => x), rules: 'the director makes a character an entity in the page (Breakdown: Create entity); every generation is a request_create draft with asset {type: "character", id, tree, from, kind}; run approved ones only, then character_iteration_add. No base: base_propose. An existing image (a legacy look, an output made outside the queue): node_import_propose' };
  },
  // register the output of an approved request that ran as a new node of its tree; never approves, never chooses
  asset_iteration_add(p, { type, id, request, image, note, by = 'agent' } = {}) {
    if (typeof request !== 'string' || !request) fail(400, 'request: the id of the request that made the image');
    const R = read(p, 'requests.json'), r = (R.items || []).find(x => x.id === request);
    if (!r) fail(404, `no request "${request}"`);
    const link = A.linkOf(r);
    type = assetType(type ?? link?.type);
    if (!link || link.id !== id || (link.type || 'character') !== type) fail(400, `request ${request} is not a generation for ${type} ${id} (its link names ${link ? `${link.type || 'character'} ${link.id}` : 'nothing'})`);
    if (!approvalOk(r)) fail(403, `request ${request} has no director approval on record: ask the director to approve it in the page`);
    if (r.status !== 'done') fail(409, `request ${request} is ${r.status}: run it first and record it (request_update done with outputs and actual_cost_usd)`);
    const outs = r.outputs || [], img = image == null ? outs[0] : String(image).replace(/\\/g, '/');
    if (!img || !outs.some(o => String(o).replace(/\\/g, '/').toLowerCase() === img.toLowerCase())) fail(400, `image must be one of the request's outputs: ${outs.join(', ') || '(none)'}`);
    if (!refFile(p, img)) fail(404, `no such file: ${img}`);
    const T = A.TYPE[type];
    let res;
    mutateAsset(p, type, id, (ent, it) => {
      const tree = link.tree, vid = A.treeVariant(tree);
      if (!A.treeOk(type, tree)) fail(400, 'the request names a bad tree');
      if (vid && !A.variants(ent, type).some(v => v.id === vid)) fail(404, `no ${T.vWord} "${vid}" on ${id}`);
      if (vid && !A.treeState(it, T.root).approved) fail(409, `${id}: the ${T.rootWord} is not approved yet; a ${T.vWord} starts from the approved ${T.rootWord}`);
      if (A.treeState(it, tree).approved) fail(409, `${id} ${tree} is approved (locked): the director unlocks it in the page before it can change`);
      const dup = it.nodes.find(n => n.request === request && n.image.toLowerCase() === img.toLowerCase());
      if (dup) { res = { node: dup, head: A.treeState(it, tree).head, duplicate: true }; return; }
      let parent = link.from && A.nodeById(it, link.from) ? link.from : null, fromId = null;
      if (parent && A.nodeById(it, parent).tree !== tree) { fromId = parent; parent = null; }   // a variant's first node grows from the root
      // a variant request drafted before the root was approved (from: null): its node grows from the approved root now
      if (vid && !parent && !fromId) fromId = A.approvedNode(it, T.root)?.id || null;
      // made from anything private (a photo, a private parent): the node is private too, its image under private/
      const priv = (r.refs || []).some(x => refPrivate(p, x)) || !!(parent && A.nodeById(it, parent).private) || !!(fromId && A.nodeById(it, fromId).private) || refPrivate(p, img);
      let stored = img;
      if (priv && !isPrivate(img)) {
        const dir = path.join(projDir(p), 'private', T.dir, id); fs.mkdirSync(dir, { recursive: true });
        let name = path.basename(img), k = 2; while (fs.existsSync(path.join(dir, name))) name = path.basename(img).replace(/(\.\w+)?$/, `-${k++}$1`);
        fs.copyFileSync(refFile(p, img), path.join(dir, name)); stored = `private/${T.dir}/${id}/${name}`;
        try { ops.media_add(p, { path: stored, kind: 'still', label: `${id} ${tree} (private)`, entities: [id], private: true, request }); } catch (e) { /* indexed later */ }
      }
      const n = { id: A.nextNodeId(it), tree, parent, ...(fromId ? { from_identity: fromId } : {}), image: stored, request, kind: link.kind || (parent ? 'edit' : vid ? T.gen.variant : T.gen.root),
        edit: parent || fromId ? { text: link.text || '', ...(link.sketch ? { sketch: link.sketch } : {}), ...(link.png ? { png: link.png } : {}), ...(link.mask ? { mask: link.mask } : {}), pins: link.pins || [] } : null,
        choice: null, ...(priv ? { private: true } : {}), at: nowIso(), by: String(by || 'agent').slice(0, 60), via: 'agent', ...(note ? { note: String(note).slice(0, 2000) } : {}) };
      it.trees[tree] ||= {};
      if (!it.trees[tree].head) { it.trees[tree].head = n.id; n.choice = 'kept'; }
      it.nodes.push(n);
      logAct(it, { by: n.by, via: 'agent', act: 'add', tree, node: n.id, detail: request });
      res = { node: n, head: it.trees[tree].head, waiting_for_director: A.pending(it, n) };
    });
    startStage(p, T.stage);
    return res;
  },
  character_iteration_add(p, a = {}) { return ops.asset_iteration_add(p, { ...a, type: 'character' }); },
  // a note on the asset, a tree, a node or a scene's use of it; a reply in a thread (reply_to); resolve: true closes it.
  // Written to notes.json v2 (target {stage: characters | scenery, kind: asset | tree | node | use, id}), old shape back
  asset_note_add(p, { type, id, text, tree, node, scene, pin, reply_to, resolve = false, to, by = 'agent' } = {}) {
    type = assetType(type);
    if (!reply_to && (!text || typeof text !== 'string')) fail(400, 'text required');
    if (tree != null && !A.treeOk(type, String(tree))) fail(400, `tree: ${treeHint(type)}`);
    if (scene != null && !sceneIdOk(scene)) fail(400, 'scene: a scene id (sc03)');
    const { ent } = readAsset(p, type, id), view = (n) => N.legacyView(n, 'asset', { nodeTree: (x) => A.nodeById(ent.iter, x)?.tree });
    if (reply_to) {
      const n0 = N.findNote(notesDoc(p), reply_to); if (!n0 || !(n0.target.id === id || String(n0.target.id || '').startsWith(id + '/'))) fail(404, `no ${type} note "${reply_to}"`);
      let n = n0;
      if (text) n = replyNote(p, reply_to, String(text).slice(0, 8000), { by }).note;
      if (resolve) n = setStatus(p, reply_to, 'absorbed', { by }).note;
      return view(n);
    }
    if (node != null && !A.nodeById(ent.iter, String(node))) fail(404, `no node "${node}" on ${id}`);
    return view(addNote(p, { target: assetTarget(type, id, { node: node != null ? String(node) : null, tree, scene, pin }), text: String(text).slice(0, 8000), to, by }));
  },
  character_note_add(p, a = {}) { return ops.asset_note_add(p, { ...a, type: 'character' }); },
  // the agent proposes a base (text + refs); the director accepts it in one click in the page (it becomes the base) or
  // dismisses it. One proposal at a time per asset (a new one replaces it). Never sets the base itself.
  base_propose(p, { type, id, text = '', refs = [], why, by = 'agent' } = {}) {
    if (!id) fail(400, 'id: the asset (character, location, prop) id');
    if (type == null) type = read(p, 'entities/index.json').find(x => x.id === id)?.kind;
    type = assetType(type);
    if (typeof text !== 'string') fail(400, 'text: the description');
    const clean = cleanBaseRefs(p, refs, 'refs');
    if (!text.trim() && !clean.length) fail(400, 'text or refs required: what the first sheet starts from');
    let replaced = false;
    const out = mutateAsset(p, type, id, (ent, it) => {
      replaced = !!it.base_proposal;
      it.base_proposal = { text: text.slice(0, 8000), refs: clean, ...(why ? { why: String(why).slice(0, 2000) } : {}), by: String(by).slice(0, 60), via: 'agent', at: nowIso() };
      logAct(it, { by, via: 'agent', act: 'base_propose', detail: `${clean.length} refs` });
      return { type, id, base_proposal: it.base_proposal, replaced, current_base: ent.base ? { text: ent.base.text, refs: (ent.base.refs || []).length } : null };
    });
    startStage(p, A.TYPE[type].stage);
    return { ...out, note: `the director accepts it in the page (${type === 'character' ? 'Characters' : 'Scenery'} stage > ${A.TYPE[type].rootWord} tab: "Accept base") or dismisses it; show it with ui_focus view "stage"` };
  },
  // the agent proposes to import a registered image (media_list) as a node of a tree: e.g. an already approved legacy
  // look as the identity head, or an output made outside the queue. The director accepts (the node is made, origin
  // "imported", with its provenance) or dismisses it, in the page. Nothing is spent or approved by this.
  node_import_propose(p, { type, id, tree, media, why, by = 'agent' } = {}) {
    if (!id) fail(400, 'id: the asset id');
    if (type == null) type = read(p, 'entities/index.json').find(x => x.id === id)?.kind;
    type = assetType(type);
    const T = A.TYPE[type], tr = String(tree || T.root);
    if (!A.treeOk(type, tr)) fail(400, `tree: ${treeHint(type)}`);
    if (!why || typeof why !== 'string') fail(400, 'why: say what the image is and where it came from (the director reads it)');
    const m = mediaImage(p, media), warnings = [];
    const out = mutateAsset(p, type, id, (ent, it) => {
      const vid = A.treeVariant(tr);
      if (vid && !A.variants(ent, type).some(v => v.id === vid)) fail(404, `no ${T.vWord} "${vid}" on ${id} (${type === 'character' ? 'look_create' : 'variant_create'})`);
      if (A.treeState(it, tr).approved) fail(409, `${id} ${tr} is approved (locked): the director unlocks it first`);
      if (vid && !A.approvedNode(it, T.root)) warnings.push(`${id} has no approved ${T.rootWord} yet: the director can accept this only after approving the ${T.rootWord} (propose the ${T.rootWord} import too)`);
      it.proposals = Array.isArray(it.proposals) ? it.proposals : [];
      const dup = it.proposals.find(x => x.status === 'open' && x.tree === tr && x.media === m.id);
      if (dup) return { type, id, proposal: dup, duplicate: true };
      const n = it.proposals.reduce((k, x) => Math.max(k, Number(/^ip(\d+)$/.exec(x.id)?.[1]) || 0), 0) + 1;
      const pr = { id: `ip${String(n).padStart(2, '0')}`, kind: 'import', tree: tr, media: m.id, path: m.path, why: why.slice(0, 2000), provenance: provenanceOf(p, m), ...(m.private ? { private: true } : {}), by: String(by).slice(0, 60), via: 'agent', at: nowIso(), status: 'open' };
      it.proposals.push(pr);
      logAct(it, { by, via: 'agent', act: 'import_propose', tree: tr, detail: `${pr.id}: ${m.id}` });
      return { type, id, proposal: pr };
    });
    startStage(p, T.stage);
    return { ...out, ...(warnings.length ? { warnings } : {}), note: `the director accepts or dismisses it in the page (${type === 'character' ? 'Characters' : 'Scenery'} stage, the tree's tab); show it with ui_focus view "stage". Nothing was spent or approved` };
  },
  // a new look (costume) proposed by an agent: always status "review" (the director approves looks in the page)
  look_create(p, { id, look_id, name, garments = [], colors = [], description = '', from_item, by = 'agent' } = {}) {
    if (!name || typeof name !== 'string') fail(400, 'name required');
    const lid = look_id || BD.slug(name);
    if (!validId(lid)) fail(400, 'look_id: letters, digits, _ and -');
    if (from_item != null && !BD.ITEM_ID.test(String(from_item))) fail(400, 'from_item: a breakdown item id');
    const { ent } = readAsset(p, 'character', id);
    if ((ent.looks || []).some(l => l.id === lid)) fail(409, `${id} already has a look "${lid}"`);
    const arr = (v) => (Array.isArray(v) ? v : []).map(x => String(x).slice(0, 200)).slice(0, 40);
    ops.entity_upsert(p, { kind: 'character', id, look: { id: lid, name: name.slice(0, 200), garments: arr(garments), colors: hexColors(colors, 'colors'), images: [], notes: String(description).slice(0, 4000), status: 'review', from: 'agent', by, via: 'agent', at: nowIso(), ...(from_item ? { breakdown: { item: String(from_item) } } : {}) } });
    mutateAsset(p, 'character', id, (e, it) => { logAct(it, { by, via: 'agent', act: 'look', tree: CH.lookTree(lid) }); });
    return { id, look: lid, tree: CH.lookTree(lid), status: 'review', note: `the director approves looks in the page; a look sheet needs the approved identity and a request (asset {type: "character", id: "${id}", tree: "look:${lid}", from: <the approved identity node>, kind: "look"}); an existing image of the look: node_import_propose` };
  },
  // a variant proposed by an agent (a location: angle / time of day / weather; a prop: angle / state; a character: a
  // look): always status "review"; scenes = the scenes it is meant for (a proposal: the director picks per scene)
  variant_create(p, { type, id, name, axes, variant_id, description = '', scenes, from_item, garments, colors, by = 'agent' } = {}) {
    type = assetType(type);
    if (type === 'character') return { type, ...ops.look_create(p, { id, look_id: variant_id, name, garments, colors, description, from_item, by }) };
    const T = A.TYPE[type], ax = A.cleanAxes(type, axes);
    if (axes != null && (typeof axes !== 'object' || Array.isArray(axes))) fail(400, `axes: {${T.axes.join(', ')}}`);
    for (const [k, v] of Object.entries(axes || {})) if (!T.axes.includes(k) || (v != null && v !== '' && !ax[k])) fail(400, `axes.${k}: one of ${T.axes.join(', ')}, a short word or two (${T.axes.map(a => `${a}: ${A.AXES[a].opts.join(' / ')}`).join('; ')})`);
    const nm = String(name || A.axesName(ax)).trim(); if (!nm) fail(400, `name or axes {${T.axes.join(', ')}} required`);
    const vid = variant_id || A.axesId(ax) || BD.slug(nm);
    if (!validId(vid)) fail(400, 'variant_id: letters, digits, _ and -');
    if (from_item != null && !BD.ITEM_ID.test(String(from_item))) fail(400, 'from_item: a breakdown item id');
    if (scenes != null && (!Array.isArray(scenes) || scenes.some(s => !sceneIdOk(s)))) fail(400, 'scenes: scene ids (sc03)');
    const known = new Set((SC.currentScript(scenesDoc(p))?.scenes || []).map(s => s.id)), warnings = (scenes || []).filter(s => !known.has(s)).map(s => `${s}: not a scene of the current script`);
    const out = mutateAsset(p, type, id, (ent, it) => {
      const vs = (ent.variants = Array.isArray(ent.variants) ? ent.variants : []);
      if (vs.some(v => v?.id === vid)) fail(409, `${id} already has a variant "${vid}"`);
      vs.push({ id: vid, name: nm.slice(0, 200), axes: ax, notes: String(description).slice(0, 4000), images: [], status: 'review', from: 'agent', by: String(by).slice(0, 60), via: 'agent', at: nowIso(),
        ...(scenes?.length ? { scenes: [...new Set(scenes)].slice(0, 200) } : {}), ...(from_item ? { breakdown: { item: String(from_item) } } : {}) });
      logAct(it, { by, via: 'agent', act: 'variant', tree: A.variantTree(type, vid) });
      return { type, id, variant: vid, name: nm, axes: ax, tree: A.variantTree(type, vid), status: 'review', ...(scenes?.length ? { scenes } : {}),
        note: `the director approves variants and picks the variant each scene uses in the page; a variant sheet needs the approved base and a request (asset {type: "${type}", id: "${id}", tree: "${A.variantTree(type, vid)}", from: <approved base node>, kind: "variant"})` };
    });
    startStage(p, T.stage);
    return warnings.length ? { ...out, warnings } : out;
  },
  // the director's acts (page only: serve.mjs passes via "page" for a same-origin browser request)
  asset_act(p, { type, id, act, via = 'agent', ...a } = {}) {
    type = assetType(type);
    const T = A.TYPE[type];
    if (via !== 'page') fail(403, `only the director does this, in the page (${type === 'character' ? 'Characters' : 'Scenery'} stage): the base, keep / branch / revert, approving the ${T.rootWord} or a ${T.vWord}, the ${T.vWord} a scene uses. Ask with ${type === 'character' ? 'character_note_add' : 'asset_note_add'} and show it with ui_focus view "stage"`);
    const stamp = { by: 'director', via: 'page' };
    if (act === 'note' || act === 'reply' || act === 'resolve') {   // the director's notes: notes.json v2
      const { ent } = readAsset(p, type, id), view = (n) => N.legacyView(n, 'asset', { nodeTree: (x) => A.nodeById(ent.iter, x)?.tree });
      if (act === 'note') {
        if (!a.text) fail(400, 'text required');
        if (a.tree != null && !A.treeOk(type, String(a.tree))) fail(400, `tree: ${treeHint(type)}`);
        if (a.node && !A.nodeById(ent.iter, String(a.node))) fail(404, `no node "${a.node}"`);
        if (a.scene != null && !sceneIdOk(a.scene)) fail(400, 'scene: a scene id');
        const r = view(addNote(p, { target: assetTarget(type, id, { node: a.node ? String(a.node) : null, tree: a.tree, scene: a.scene, pin: a.pin }), text: String(a.text).slice(0, 8000), to: a.to === 'agent' ? 'agent' : undefined, by: 'director', via: 'page' }));
        startStage(p, T.stage); return r;
      }
      const n = N.findNote(notesDoc(p), a.note); if (!n) fail(404, `no note "${a.note}"`);
      if (act === 'reply') return view(replyNote(p, a.note, String(a.text || '').slice(0, 8000), stamp).note);
      return view(setStatus(p, a.note, n.status === 'open' ? 'absorbed' : 'open', stamp).note);
    }
    const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean).slice(0, 40);
    const out = mutateAsset(p, type, id, (ent, it) => {
      const tree = a.tree == null ? null : String(a.tree);
      if (tree && !A.treeOk(type, tree)) fail(400, `tree: ${treeHint(type)}`);
      const locked = (t) => { if (A.treeState(it, t).approved) fail(409, `${t} is approved (locked): unlock it first`); };
      const vOf = (t) => { const vid = A.treeVariant(t); return vid ? A.variants(ent, type).find(x => x.id === vid) || null : null; };
      if (act === 'base') {
        const b = a.base && typeof a.base === 'object' ? a.base : {};
        const refs = cleanBaseRefs(p, b.refs);
        ent.base = { text: String(b.text || '').slice(0, 8000), refs, at: nowIso(), ...stamp };
        logAct(it, { ...stamp, act: 'base', detail: `${refs.length} refs` });
        return { base: ent.base };
      }
      // the agent's base proposal (base_propose): accepted in one click (it becomes the base) or dismissed
      if (act === 'base_accept' || act === 'base_dismiss') {
        const bp = it.base_proposal; if (!bp) fail(404, 'no base proposal');
        delete it.base_proposal;
        if (act === 'base_dismiss') { logAct(it, { ...stamp, act: 'base_dismiss', detail: `from ${bp.by || 'agent'}` }); return { dismissed: true }; }
        const refs = cleanBaseRefs(p, bp.refs);
        ent.base = { text: String(bp.text || '').slice(0, 8000), refs, at: nowIso(), ...stamp, proposed_by: bp.by || 'agent', proposed_at: bp.at || null };
        logAct(it, { ...stamp, act: 'base_accept', detail: `${refs.length} refs, proposed by ${bp.by || 'agent'}` });
        return { base: ent.base };
      }
      // import a registered image as a node (no request, nothing paid): the director's own (act "import"), or an agent's
      // proposal accepted (act "import_accept" {proposal}); "import_dismiss" drops a proposal
      if (act === 'import') {
        const n = importNode(p, type, ent, it, { tree: tree || T.root, media: a.media, why: a.note }, stamp);
        return { node: n.id, tree: n.tree, head: n.id, provenance: n.provenance };
      }
      if (act === 'import_accept' || act === 'import_dismiss') {
        const pr = (it.proposals || []).find(x => x.id === a.proposal && x.status === 'open'); if (!pr) fail(404, `no open proposal "${a.proposal}"`);
        if (act === 'import_dismiss') { pr.status = 'dismissed'; pr.decided_at = nowIso(); logAct(it, { ...stamp, act: 'import_dismiss', tree: pr.tree, detail: pr.id }); return { proposal: pr.id, status: pr.status }; }
        const n = importNode(p, type, ent, it, { tree: pr.tree, media: pr.media, why: pr.why, proposal: pr }, stamp);
        pr.status = 'accepted'; pr.node = n.id; pr.decided_at = nowIso();
        return { proposal: pr.id, node: n.id, tree: n.tree, head: n.id, provenance: n.provenance };
      }
      if (act === 'choose') {
        const n = A.nodeById(it, String(a.node || '')); if (!n) fail(404, `no node "${a.node}"`);
        if (!A.CHOICES.includes(a.choice)) fail(400, `choice: ${A.CHOICES.join(', ')}`);
        locked(n.tree);
        n.choice = a.choice; n.chosen_at = nowIso();
        it.trees[n.tree] ||= {};
        if (a.choice === 'kept') it.trees[n.tree].head = n.id;
        logAct(it, { ...stamp, act: a.choice === 'kept' ? 'keep' : a.choice === 'branch' ? 'branch' : 'revert', tree: n.tree, node: n.id });
        return { node: n.id, choice: n.choice, head: it.trees[n.tree].head };
      }
      if (act === 'head') {   // revert to (or continue from) any node of the tree
        const n = A.nodeById(it, String(a.node || '')); if (!n) fail(404, `no node "${a.node}"`);
        locked(n.tree);
        it.trees[n.tree] ||= {}; it.trees[n.tree].head = n.id; if (!n.choice || n.choice === 'reverted') n.choice = 'kept';
        logAct(it, { ...stamp, act: 'head', tree: n.tree, node: n.id });
        return { head: n.id };
      }
      if (act === 'approve') {
        const t = tree || T.root, st = (it.trees[t] ||= {}), n = A.nodeById(it, String(a.node || st.head || ''));
        if (!n || n.tree !== t) fail(404, `no node to approve in ${t}`);
        Object.assign(st, { head: n.id, approved: n.id, approved_at: nowIso(), approved_by: 'director', via: 'page' });
        if (n.choice !== 'kept') n.choice = 'kept';
        const v = vOf(t);
        if (v) { v.status = 'approved'; v.images = [n.image, ...(v.images || []).filter(x => x !== n.image)]; }
        else if (type === 'character') { ent.identity_sheet = n.image; if (!ent.face && !n.private) ent.face = n.image; }
        else { ent.sheet = n.image; const k = type === 'location' ? 'establishing' : 'hero'; if (!ent[k] && !n.private) ent[k] = n.image; }
        logAct(it, { ...stamp, act: 'approve', tree: t, node: n.id });
        return { tree: t, approved: n.id };
      }
      if (act === 'unlock') {
        const t = tree || T.root, st = it.trees[t];
        if (!st?.approved) fail(409, `${t} is not approved`);
        delete st.approved; delete st.approved_at; delete st.approved_by; delete st.via;
        const v = vOf(t); if (v) v.status = 'draft';
        logAct(it, { ...stamp, act: 'unlock', tree: t });
        return { tree: t, unlocked: true };
      }
      if (act === 'look_new' || act === 'variant_new') {
        const ax = A.cleanAxes(type, a.axes), name = String(a.name || A.axesName(ax)).trim(); if (!name) fail(400, type === 'character' ? 'name required' : 'name or axes required');
        const list = (ent[T.vfield] = Array.isArray(ent[T.vfield]) ? ent[T.vfield] : []), used = new Set(list.map(l => l?.id));
        const stem = (type !== 'character' && A.axesId(ax)) || BD.slug(name); let vid = stem; for (let k = 2; used.has(vid); k++) vid = `${stem}-${k}`;
        list.push(type === 'character'
          ? { id: vid, name: name.slice(0, 200), garments: arr(a.garments), colors: hexColors(arr(a.colors), 'colors'), images: [], notes: String(a.notes || '').slice(0, 4000), status: 'draft', from: 'page', at: nowIso() }
          : { id: vid, name: name.slice(0, 200), axes: ax, images: [], notes: String(a.notes || '').slice(0, 4000), status: 'draft', from: 'page', at: nowIso() });
        logAct(it, { ...stamp, act: T.vWord, tree: A.variantTree(type, vid) });
        return type === 'character' ? { look: vid } : { variant: vid, tree: A.variantTree(type, vid) };
      }
      if (act === 'look_status' || act === 'variant_status') {
        const vid = a.look ?? a.variant, v = A.variants(ent, type).find(x => x.id === vid); if (!v) fail(404, `no ${T.vWord} "${vid}"`);
        if (!['draft', 'review'].includes(a.status)) fail(400, 'status: draft or review (approve: act "approve")');
        v.status = a.status; return { [type === 'character' ? 'look' : 'variant']: v.id, status: v.status };
      }
      if (act === 'use') {   // the variant a scene needs (null = the root); clear: forget the pick
        if (!sceneIdOk(a.scene)) fail(400, 'scene: a scene id (sc03)');
        const uses = (ent.uses = ent.uses && typeof ent.uses === 'object' && !Array.isArray(ent.uses) ? ent.uses : {});
        if (a.clear) { delete uses[a.scene]; logAct(it, { ...stamp, act: 'use', detail: `${a.scene}: cleared` }); return { scene: a.scene, cleared: true }; }
        const vid = a.variant == null || a.variant === '' ? null : String(a.variant);
        if (vid && !A.variants(ent, type).some(v => v.id === vid)) fail(404, `no ${T.vWord} "${vid}"`);
        uses[a.scene] = { variant: vid, ...stamp, at: nowIso(), ...(a.note ? { note: String(a.note).slice(0, 1000) } : {}) };
        logAct(it, { ...stamp, act: 'use', tree: vid ? A.variantTree(type, vid) : T.root, detail: `${a.scene}: ${vid || T.rootWord}` });
        return { scene: a.scene, variant: vid };
      }
      fail(400, `act: base, base_accept, base_dismiss, import, import_accept, import_dismiss, choose, head, approve, unlock, ${type === 'character' ? 'look_new, look_status' : 'variant_new, variant_status'}, use, note, reply, resolve`);
    });
    startStage(p, T.stage);   // an empty stage is in progress once the director works on one
    return out;
  },
  character_act(p, a = {}) { return ops.asset_act(p, { ...a, type: 'character' }); },
  // a reference image for an asset (page only): an upload (base64 data) or a file on this machine (path). Only real
  // images (PNG / JPEG / WebP / GIF by their signature). kind "photo" (a person, a real place: always
  // private/refs/<id>/, flagged private) or "openverse" (a free-licence image: refs/<id>/, with its licence, creator and
  // URL recorded)
  ref_upload(p, { type, id, kind = 'photo', name = 'ref', data, path: src, meta = {}, via = 'agent' } = {}) {
    if (via !== 'page') fail(403, 'reference uploads are the director\'s, in the page (Characters / Scenery stage > base)');
    if (!['photo', 'openverse'].includes(kind)) fail(400, 'kind: photo or openverse');
    assetEntry(p, assetType(type), id);
    let buf;
    if (data != null) {
      if (typeof data !== 'string') fail(400, 'data: base64');
      const b64 = data.replace(/^data:image\/[a-z+]+;base64,/, '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) fail(400, 'data: not base64');
      buf = Buffer.from(b64, 'base64');
    } else if (typeof src === 'string' && path.isAbsolute(src)) {
      if (kind !== 'photo') fail(400, 'path: only for photos');
      let st = null; try { st = fs.statSync(src); } catch (e) { fail(404, 'no such file: ' + src); }
      if (!st.isFile() || st.size > 20e6) fail(400, 'path: a file up to 20 MB');
      buf = fs.readFileSync(src);
    } else fail(400, 'give data (base64) or path (an absolute path on this machine)');
    if (buf.length > 20e6) fail(413, 'over 20 MB');
    const ext = imageExt(buf); if (!ext) fail(400, 'not an image (PNG, JPEG, WebP or GIF by its signature)');
    const top = kind === 'photo' ? `private/refs/${id}` : `refs/${id}`, dir = path.join(projDir(p), ...top.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    const base = String(name).replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'ref';
    let file = `${base}.${ext}`; for (let k = 2; fs.existsSync(path.join(dir, file)); k++) file = `${base}-${k}.${ext}`;
    writeAtomic(path.join(dir, file), buf);
    const rel = `${top}/${file}`, priv = kind === 'photo';
    const s = (k, n = 500) => (typeof meta?.[k] === 'string' && meta[k] ? { [k]: meta[k].slice(0, n) } : {});
    const info = kind === 'openverse' ? { ...s('title', 200), ...s('licence', 60), ...s('licence_url'), ...s('creator', 200), ...s('url'), ...s('original'), ...s('attribution', 1000), ...s('openverse_id', 80) } : {};
    let media = null; try { media = ops.media_add(p, { path: rel, kind: 'ref', label: `${id} ${kind}${info.title ? ': ' + info.title : ''}`, entities: [id], private: priv }).media; } catch (e) { /* indexed later */ }
    if (media && Object.keys(info).length) { const doc = read(p, 'media.json'), m = doc.items.find(x => x.id === media.id); if (m) { m.provenance = info; write(p, 'media.json', doc); } }
    return { ref: { path: rel, source: kind, ...(priv ? { private: true } : {}), ...info }, media: media?.id || null, private: priv, bytes: buf.length };
  },
});

function imageExt(b) {
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  return null;
}
