// Stage 6 of the guided flow (docs/SPEC_v3_GUIDED.md): the storyboard and the gaps. Pure functions, no DOM and no Node
// APIs: the page (tabs/storyboard.js, js/columns.js) and the data layer (lib/store.mjs) import the same code.
//
// storyboard.json  {rev, current: "v3", versions: [{id, n, created, by, via, message, from?, script?, shots: [Shot]}],
//                   notes: [Note]}
//   Shot  {id "sh03", scene: "sc02" | null, t0, t1, kind, title, text, camera, sketch: id | null, beats: [beat ids],
//          cast: [entity ids], locations: [ids], props: [ids], variants: {<entity id>: <variant / look id> | null},
//          gen: "still" | "video" | null, clips: [clip use ids], thumb?, section?}
//          t0 < t1 are integer ms of the song; the shots of a scene TILE it (the first starts with the scene, each next one
//          where the previous ends, the last ends with the scene); boundaries snap to the beat grid (song.json grid).
//          kind: wide | medium | close | insert | performance | xp-desktop (or any short lower-case word: older shots.json
//          kinds such as screen / world / split stay). sketch = the frame sketch (sketches/<id>.json|.png). The asset
//          chips name entities; the variant each needs is the scene's (the director's pick in the Scenery / Characters
//          stage, entity `uses`), unless the shot overrides it in `variants` (null = the root: identity / base).
//          gen = what the shot needs generated (default from the kind: insert / xp-desktop = a still, else a video).
//   Note  {id "sbn01", shot: id | null, scene?: id, text, by, via, to?: "agent", kind?: request | storyboard | fill_gaps,
//          gaps?: {...}, status: open | resolved, at, version, replies: [{id, text, by, via, at}]}
//   A version is immutable: a save appends one and moves `current`; a restore appends a copy. A project without the file
//   reads as v1 derived from shots.json (its shots keep their ids, thumbs and clip uses); shots.json is never rewritten
//   and its readers keep working. The shot's approval lives in approvals.json ("shot:<id>": draft / review / changes /
//   approved / locked; approved and locked only from the page).
import { currentScript, gaps as scriptGaps, span } from './scenes.js';
import { currentBreakdown } from './breakdown.js';
import * as A from './assets.js';

export const SHOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const SCENE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const ENT_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export const SKETCH_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const KINDS = ['wide', 'medium', 'close', 'insert', 'performance', 'xp-desktop'];
export const KIND_RE = /^[a-z][a-z0-9-]{0,23}$/;
export const GENS = ['still', 'video'];
export const SNAPS = ['beats', 'bars', 'off'];
export const FIELD = { character: 'cast', location: 'locations', prop: 'props' };
const CLIP_RE = /^[\w@.:-]{1,80}$/, BEAT_RE = /^[A-Za-z0-9_-]{1,40}$/, THUMB_RE = /^[\w./-]{1,300}$/;
const num = (v) => Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN;
const maxN = (list, re) => list.reduce((m, x) => Math.max(m, Number(re.exec(String(x?.id))?.[1]) || 0), 0);
const sum = (a) => +a.reduce((s, x) => s + (Number(x) || 0), 0).toFixed(2);
export const byTime = (a, b) => a.t0 - b.t0 || a.t1 - b.t1;

// ------------------------------------------------------------------ the beat grid
// nearest beat / downbeat (mode beats | bars) of the song grid, 0 and the end included; off = rounded ms
export function snapGrid(t, song, mode = 'beats') {
  if (!mode || mode === 'off' || !song) return Math.round(t);
  const g = song.grid || {}, c = mode === 'bars' ? g.downbeats || [] : g.beats || [];
  let best = Math.round(t), d = Infinity;
  for (const x of [0, song.duration_ms || 0, ...c]) { const e = Math.abs(x - t); if (e < d) { d = e; best = x; } }
  return best;
}
export const beatMs = (song) => Math.round(song?.beat_ms || (song?.bpm ? 60000 / song.bpm : 500));
export const barMs = (song) => Math.round(song?.bar_ms || beatMs(song) * (song?.beats_per_bar || 4));
export const bars = (song, t0, t1) => +((t1 - t0) / barMs(song)).toFixed(1);

// ------------------------------------------------------------------ documents
export function emptyBoard() { return { rev: 0, current: null, versions: [], notes: [] }; }
const sceneAt = (scenes, t) => (scenes || []).find(s => s.t0 <= t && t < s.t1) || null;
const ids = (v) => (Array.isArray(v) ? v : []).map(String).filter(x => ENT_ID.test(x));
// shots.json -> board shots (ids, times, kinds, titles, cast, locations, clip uses and thumbs kept; scene by midpoint)
export function boardFromShots(shotsJson, scenes) {
  const list = Array.isArray(shotsJson) ? shotsJson : shotsJson?.shots || [];
  return list.filter(s => s && Number.isFinite(s.t0) && Number.isFinite(s.t1) && s.t1 > s.t0 && SHOT_ID.test(String(s.id))).sort(byTime).map(s => ({
    id: String(s.id), scene: sceneAt(scenes, (s.t0 + s.t1) / 2)?.id || null, t0: Math.round(s.t0), t1: Math.round(s.t1),
    kind: KIND_RE.test(String(s.kind || '')) ? s.kind : 'medium', title: String(s.title || ''), text: '', camera: '', sketch: null, beats: [],
    cast: ids(s.cast), locations: ids(s.locations), props: ids(s.props), variants: {}, gen: null,
    clips: (Array.isArray(s.clips) ? s.clips : []).map(String).filter(x => CLIP_RE.test(x)),
    ...(typeof s.thumb === 'string' && THUMB_RE.test(s.thumb) && !s.thumb.split('/').includes('..') ? { thumb: s.thumb } : {}), ...(s.section ? { section: String(s.section).slice(0, 60) } : {}),
  }));
}
// any storyboard.json (or none) -> a usable doc; a missing / empty one derives v1 from shots.json
export function normBoard(doc, shotsJson, scenesDoc) {
  const d = doc && typeof doc === 'object' && Array.isArray(doc.versions) ? { ...emptyBoard(), ...doc } : { ...emptyBoard(), ...(doc && typeof doc === 'object' ? { rev: doc.rev || 0 } : {}) };
  if (!Array.isArray(d.notes)) d.notes = [];
  if (!d.versions.length) {
    const sh = boardFromShots(shotsJson, currentScript(scenesDoc)?.scenes || []);
    if (sh.length) { d.versions = [{ id: 'v1', n: 1, created: null, by: 'import', via: 'import', message: 'from shots.json', shots: sh }]; d.current = 'v1'; d.derived = true; }
  }
  if (d.versions.length && !d.versions.some(v => v.id === d.current)) d.current = d.versions[d.versions.length - 1].id;
  return d;
}
export const currentBoard = (doc) => doc?.versions?.find(v => v.id === doc.current) || null;
export const boardShots = (doc) => [...(currentBoard(doc)?.shots || [])].sort(byTime);
export const sameShots = (a, b) => JSON.stringify(a?.shots || a || []) === JSON.stringify(b?.shots || b || []);
export function addBoardVersion(doc, shots, { by = 'director', via, message = '', from, created, script } = {}) {
  const n = Math.max(0, ...doc.versions.map(v => v.n || Number(String(v.id).replace(/\D/g, '')) || 0)) + 1;
  const v = { id: `v${n}`, n, created: created || new Date().toISOString().slice(0, 19), by, ...(via ? { via } : {}), message: String(message || ''), ...(from ? { from } : {}), ...(script ? { script } : {}), shots: structuredClone(shots) };
  doc.versions.push(v); doc.current = v.id; delete doc.derived;
  return v;
}
export const nextShotId = (doc, draft) => `sh${String(Math.max(maxN((doc?.versions || []).flatMap(v => v.shots || []), /^sh(\d+)$/), maxN(draft || [], /^sh(\d+)$/)) + 1).padStart(2, '0')}`;
export const nextNoteId = (doc) => `sbn${String(maxN(doc?.notes || [], /^sbn(\d+)$/) + 1).padStart(2, '0')}`;
export const NEW_SHOT = () => ({ scene: null, title: '', text: '', camera: '', sketch: null, beats: [], cast: [], locations: [], props: [], variants: {}, gen: null, clips: [] });

// a shot from the page or an agent -> the stored shape (ints, strings, checked ids); throws a message on what cannot be fixed
export function cleanShot(s, song, { snap } = {}) {
  if (!s || typeof s !== 'object') throw new Error('a shot must be an object');
  const id = String(s.id ?? '');
  if (!SHOT_ID.test(id)) throw new Error(`shot id "${id.slice(0, 60)}": letters, digits, _ and - (up to 40)`);
  const dur = song?.duration_ms || Infinity;
  let t0 = num(s.t0), t1 = num(s.t1);
  if (snap && snap !== 'off') { t0 = snapGrid(t0, song, snap); t1 = snapGrid(t1, song, snap); }
  if (!(t0 >= 0 && t1 > t0 && t1 <= dur)) throw new Error(`shot ${id}: needs 0 <= t0 < t1 <= ${dur} ms (got ${s.t0}, ${s.t1})`);
  const scene = s.scene == null || s.scene === '' ? null : String(s.scene);
  if (scene && !SCENE_ID.test(scene)) throw new Error(`shot ${id}: scene "${scene.slice(0, 60)}" is not a scene id`);
  const kind = s.kind == null || s.kind === '' ? 'medium' : String(s.kind).trim().toLowerCase();
  if (!KIND_RE.test(kind)) throw new Error(`shot ${id}: kind "${kind.slice(0, 40)}": a short lower-case word (${KINDS.join(', ')})`);
  const sketch = s.sketch == null || s.sketch === '' ? null : String(s.sketch);
  if (sketch && !SKETCH_ID.test(sketch)) throw new Error(`shot ${id}: sketch id "${sketch.slice(0, 60)}" (lower-case letters, digits, _ and -)`);
  const list = (k, re, max) => {
    const v = s[k] == null ? [] : s[k];
    if (!Array.isArray(v)) throw new Error(`shot ${id}: ${k} must be a list`);
    const out = [...new Set(v.map(String))];
    for (const x of out) if (!re.test(x)) throw new Error(`shot ${id}: ${k} "${x.slice(0, 60)}" is not a valid id`);
    if (out.length > max) throw new Error(`shot ${id}: at most ${max} ${k}`);
    return out;
  };
  const variants = {};
  if (s.variants != null) {
    if (typeof s.variants !== 'object' || Array.isArray(s.variants)) throw new Error(`shot ${id}: variants must be {<entity id>: <variant id> | null}`);
    for (const [k, v] of Object.entries(s.variants)) {
      if (!ENT_ID.test(k)) throw new Error(`shot ${id}: variants key "${k.slice(0, 60)}" is not an entity id`);
      if (v != null && !ENT_ID.test(String(v))) throw new Error(`shot ${id}: variants.${k} "${String(v).slice(0, 60)}" is not a variant id`);
      variants[k] = v == null ? null : String(v);
    }
  }
  const gen = s.gen == null || s.gen === '' ? null : String(s.gen);
  if (gen && !GENS.includes(gen)) throw new Error(`shot ${id}: gen is still or video`);
  const thumb = typeof s.thumb === 'string' && THUMB_RE.test(s.thumb) && !s.thumb.split('/').includes('..') ? s.thumb : null;
  return { id, scene, t0, t1, kind, title: String(s.title ?? '').slice(0, 300), text: String(s.text ?? '').slice(0, 8000), camera: String(s.camera ?? '').slice(0, 2000), sketch,
    beats: list('beats', BEAT_RE, 200), cast: list('cast', ENT_ID, 40), locations: list('locations', ENT_ID, 40), props: list('props', ENT_ID, 40), variants, gen,
    clips: list('clips', CLIP_RE, 100), ...(thumb ? { thumb } : {}), ...(s.section ? { section: String(s.section).slice(0, 60) } : {}) };
}
// the shots of each scene tile it: sorted by start; the first starts with the scene, each one ends where the next starts,
// the last ends with the scene. Shots of an unknown scene (or none) are left as they are. Returns warnings; throws when a
// shot is left without length.
export function tileShots(shots, scenes) {
  const warnings = [];
  for (const sc of scenes || []) {
    const g = shots.filter(s => s.scene === sc.id).sort(byTime);
    if (!g.length) continue;
    const moved = [];
    g.forEach((s, i) => {
      const a = i ? g[i - 1].t1 : sc.t0, b = i + 1 < g.length ? g[i + 1].t0 : sc.t1;
      if (Math.abs(s.t0 - a) > 1 || Math.abs(s.t1 - b) > 1) moved.push(s.id);
      s.t0 = a; s.t1 = Math.max(b, a);
    });
    // a second pass so a shot's end follows its neighbour's (already tiled) start
    for (let i = 0; i < g.length; i++) g[i].t1 = i + 1 < g.length ? g[i + 1].t0 : sc.t1;
    for (const s of g) if (!(s.t1 > s.t0)) throw new Error(`shot ${s.id}: no length left in ${sc.id} after tiling (two shots start at the same time?)`);
    if (moved.length) warnings.push(`${sc.id}: ${moved.join(', ')} moved to tile the scene (${span(sc.t0, sc.t1)})`);
  }
  return warnings;
}
// a storyboard.json from the page or an agent: the shape the tools rely on (throws a message on a bad file)
export function checkBoard(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.versions)) throw new Error('storyboard.json: {versions[], notes[]} expected');
  if (d.notes != null && !Array.isArray(d.notes)) throw new Error('storyboard.json: notes must be a list');
  const vids = new Set();
  for (const v of d.versions) {
    if (!v || typeof v.id !== 'string' || vids.has(v.id) || !Array.isArray(v.shots)) throw new Error('storyboard.json: every version needs a unique id and shots[]');
    vids.add(v.id); const S = new Set();
    for (const s of v.shots) {
      if (!s || typeof s.id !== 'string' || !SHOT_ID.test(s.id) || S.has(s.id)) throw new Error(`storyboard.json: ${v.id}: every shot needs a unique id (letters, digits, _ -)`);
      S.add(s.id);
      if (!Number.isInteger(s.t0) || !Number.isInteger(s.t1) || s.t0 < 0 || s.t1 <= s.t0) throw new Error(`storyboard.json: ${v.id}/${s.id}: integer t0 < t1 expected`);
      if (s.scene != null && (typeof s.scene !== 'string' || !SCENE_ID.test(s.scene))) throw new Error(`storyboard.json: ${v.id}/${s.id}: bad scene id`);
      if (typeof s.kind !== 'string' || !KIND_RE.test(s.kind)) throw new Error(`storyboard.json: ${v.id}/${s.id}: bad kind`);
      for (const k of ['title', 'text', 'camera']) if (s[k] != null && typeof s[k] !== 'string') throw new Error(`storyboard.json: ${v.id}/${s.id}: ${k} must be text`);
      if (s.sketch != null && (typeof s.sketch !== 'string' || !SKETCH_ID.test(s.sketch))) throw new Error(`storyboard.json: ${v.id}/${s.id}: bad sketch id`);
      for (const k of ['cast', 'locations', 'props']) if (s[k] != null && (!Array.isArray(s[k]) || s[k].some(x => typeof x !== 'string' || !ENT_ID.test(x)))) throw new Error(`storyboard.json: ${v.id}/${s.id}: ${k} must list entity ids`);
      if (s.clips != null && (!Array.isArray(s.clips) || s.clips.some(x => typeof x !== 'string' || !CLIP_RE.test(x)))) throw new Error(`storyboard.json: ${v.id}/${s.id}: clips must list clip use ids`);
      if (s.beats != null && (!Array.isArray(s.beats) || s.beats.some(x => typeof x !== 'string' || !BEAT_RE.test(x)))) throw new Error(`storyboard.json: ${v.id}/${s.id}: beats must list beat ids`);
      if (s.variants != null && (typeof s.variants !== 'object' || Array.isArray(s.variants) || Object.entries(s.variants).some(([k, x]) => !ENT_ID.test(k) || (x != null && (typeof x !== 'string' || !ENT_ID.test(x)))))) throw new Error(`storyboard.json: ${v.id}/${s.id}: variants must be {<entity id>: <variant id> | null}`);
      if (s.gen != null && !GENS.includes(s.gen)) throw new Error(`storyboard.json: ${v.id}/${s.id}: gen is still or video`);
      if (s.thumb != null && (typeof s.thumb !== 'string' || !THUMB_RE.test(s.thumb) || s.thumb.split('/').includes('..'))) throw new Error(`storyboard.json: ${v.id}/${s.id}: bad thumb path`);
    }
  }
  if (d.versions.length && !vids.has(d.current)) throw new Error('storyboard.json: current must name a version');
  return d;
}

// ------------------------------------------------------------------ assets: what a scene needs, what a shot gets
// the entities a scene needs: breakdown items made entities (with the beats the link names, null = the whole scene),
// entities whose breakdown info names the scene, and entities the director picked a variant for in that scene
export function sceneAssets(sceneId, bd, entities) {
  const v = currentBreakdown(bd), byId = new Map((entities || []).map(e => [e.id, e])), out = new Map(), linked = new Set();
  for (const it of v?.items || []) {
    const eid = bd?.states?.[it.id]?.entity_id, e = eid && byId.get(eid);
    if (!e || !A.TYPES.includes(e.kind) || it.kind !== e.kind) continue;
    linked.add(e.id);
    if (it.dropped) continue;
    const l = (it.links || []).find(x => x.scene === sceneId);
    if (l) out.set(e.id, { type: e.kind, id: e.id, beats: l.beats?.length ? [...l.beats] : null });
  }
  for (const e of entities || []) {
    if (!A.TYPES.includes(e.kind) || out.has(e.id)) continue;
    if ((!linked.has(e.id) && (e.breakdown?.scenes || []).includes(sceneId)) || (e.uses && typeof e.uses === 'object' && Object.hasOwn(e.uses, sceneId))) out.set(e.id, { type: e.kind, id: e.id, beats: null });
  }
  return [...out.values()].sort((a, b) => A.TYPES.indexOf(a.type) - A.TYPES.indexOf(b.type) || a.id.localeCompare(b.id));
}
// the variant a scene needs of an asset (the director's pick, else the agent's proposal, else the root), as sceneUses
export function useFor(ent, sceneId) {
  const uses = ent?.uses && typeof ent.uses === 'object' && !Array.isArray(ent.uses) ? ent.uses : {}, vs = A.variants(ent, ent?.kind);
  const u = sceneId ? uses[sceneId] : null;
  if (u) return { variant: u.variant && vs.some(v => v.id === u.variant) ? u.variant : null, source: u.via === 'page' ? 'director' : 'agent' };
  const p = sceneId && vs.find(v => Array.isArray(v.scenes) && v.scenes.includes(sceneId));
  return p ? { variant: p.id, source: 'agent' } : { variant: null, source: 'default' };
}
const DONE = ['approved', 'locked'];
// one asset of a shot, resolved: the variant (the shot's override, else the scene's), its image, approved or not
export function resolveAsset(ent, shot, approvals) {
  const T = A.TYPE[ent.kind];
  const ov = shot?.variants && Object.hasOwn(shot.variants, ent.id) ? shot.variants[ent.id] : undefined;
  let variant, source;
  if (ov !== undefined) { variant = ov && A.variants(ent, ent.kind).some(v => v.id === ov) ? ov : null; source = 'shot'; } else ({ variant, source } = useFor(ent, shot?.scene));
  const it = A.normIter(ent.iter), tree = variant ? A.variantTree(ent.kind, variant) : T.root, v = variant ? A.variants(ent, ent.kind).find(x => x.id === variant) : null;
  const apN = A.approvedNode(it, tree), head = A.headNode(it, tree);
  const legacy = !variant && (ent.status === 'approved' || DONE.includes(approvals?.items?.[`${ent.kind}:${ent.id}`]?.state));
  const approved = !!apN || (v ? v.status === 'approved' && !!(v.images || []).length : legacy);
  const image = apN?.image || head?.image || (v ? (v.images || [])[0] : ent.identity_sheet || ent.sheet || ent.face || ent.establishing || ent.hero || (typeof ent.thumb === 'string' ? ent.thumb : null)) || null;
  const why = approved ? null : !image ? `no ${variant ? T.vWord + ' sheet' : T.sheetWord} yet` : `${variant ? T.vWord : T.rootWord} not approved`;
  return { type: ent.kind, id: ent.id, name: ent.name || ent.id, variant, variant_name: variant ? v?.name || variant : T.rootWord, source, approved, image, ...(why ? { why } : {}) };
}
// every asset chip of a shot, resolved (an id that is no entity: a location letter of an old shots.json, else missing)
export function shotAssets(shot, entities, approvals) {
  const out = [];
  for (const [type, f] of Object.entries(FIELD)) for (const id of shot?.[f] || []) {
    const e = (entities || []).find(x => x.id === id && x.kind === type) || (type === 'location' ? (entities || []).find(x => x.kind === 'location' && x.letter === id) : null);
    out.push(e ? resolveAsset(e, shot, approvals) : { type, id, name: id, variant: null, variant_name: '', source: 'default', approved: false, image: null, missing: true, why: `no ${type} "${id}"` });
  }
  return out;
}

// ------------------------------------------------------------------ "shots from beats": the page's heuristic
export function guessKind(text, i = 1) {
  const t = String(text || '').toLowerCase();
  if (/\b(desktop|screen|xp|cursor|icon|monitor|browser|folder|pixel|taskbar)\b/.test(t)) return 'xp-desktop';
  if (/\b(sings?|singing|sung|performs?|performing|plays?|playing|dances?|dancing|band|mic|chorus)\b/.test(t)) return 'performance';
  if (/\b(hands?|letter|detail|ring|phone|key|keys|insert|object|note|photo|cup|lantern)\b/.test(t)) return 'insert';
  if (/\b(face|eyes?|tears?|lips|whispers?|close|smiles?|looks? at)\b/.test(t)) return 'close';
  if (i === 0 || /\b(arrives?|enters?|walks?|city|street|landscape|wide|establish\w*|skyline|coast|road)\b/.test(t)) return 'wide';
  return 'medium';
}
export const defaultGen = (kind) => (['insert', 'xp-desktop'].includes(kind) ? 'still' : 'video');
// one shot per scene beat, or per group of beats closer than minMs (default one bar), cut on the beat grid; a stretch
// longer than maxMs (default four bars) is cut again on the grid. Assets: those the scene needs (sceneAssets), limited
// to the shots holding the beats a breakdown link names. -> shots without ids (the caller numbers them)
export function shotsFromBeats(scene, song, { assets = [], snap = 'beats', minMs, maxMs } = {}) {
  const lo = scene.t0, hi = scene.t1;
  minMs ??= Math.max(1000, barMs(song)); maxMs ??= Math.max(minMs * 2, barMs(song) * 4);
  const into = (t) => Math.max(lo, Math.min(hi, snapGrid(t, song, snap)));
  const cuts = [];
  for (const t of [...new Set((scene.beats || []).map(b => into(b.t)))].sort((a, b) => a - b)) if (t - lo >= minMs && hi - t >= minMs && (!cuts.length || t - cuts[cuts.length - 1] >= minMs)) cuts.push(t);
  const bounds = [lo];
  for (const b of [...cuts, hi]) {
    const a = bounds[bounds.length - 1], n = Math.ceil((b - a) / maxMs);
    for (let k = 1; k < n; k++) { const t = into(a + (b - a) * k / n); if (t - bounds[bounds.length - 1] >= minMs && b - t >= minMs) bounds.push(t); }
    bounds.push(b);
  }
  const out = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i], b = bounds[i + 1], last = i + 2 === bounds.length;
    // a beat belongs to the stretch its snapped time falls in (the scene end belongs to the last one)
    const bs = (scene.beats || []).filter(x => { const t = into(x.t); return t >= a && (t < b || (last && t <= b)); });
    // the action: the beats it holds; a scene without beats gives its text to its first shot
    const text = bs.map(x => x.text).filter(Boolean).join('; ') || (!(scene.beats || []).length && i === 0 ? String(scene.text || '').slice(0, 2000) : '');
    const kind = guessKind(text, i), bids = bs.map(x => x.id);
    const pick = (type) => assets.filter(x => x.type === type && (!x.beats || x.beats.some(id => bids.includes(id)))).map(x => x.id);
    out.push({ scene: scene.id, t0: a, t1: b, kind, title: '', text, camera: '', sketch: null, beats: bids,
      cast: pick('character'), locations: pick('location'), props: pick('prop'), variants: {}, gen: defaultGen(kind), clips: [] });
  }
  return out;
}

// ------------------------------------------------------------------ estimates (honest list prices; the agent corrects est_cost before approval)
const KONTEXT_MULTI = 'fal-ai/flux-pro/kontext/max/multi', KLING = 'fal-ai/kling-video/v2.1/standard/image-to-video';
export const SHOT_EST = {
  still: { kind: 'shot-still', tool: KONTEXT_MULTI, usd: 0.08, why: 'one 16:9 frame from the approved sheets + the frame sketch, Kontext Max multi-image $0.08' },
  video: { kind: 'shot-video', tool: KLING, usd_per_s: 0.05, min_s: 5, max_s: 10, why: 'image-to-video from the shot\'s approved still, Kling 2.1 Standard ~$0.05 a second (5 s minimum, 10 s a clip)' },
};
// what a shot costs to generate: a still (one frame) or a video (its start frame + image-to-video clips of up to 10 s)
export function shotEstimate(shot, { haveStill = false } = {}) {
  const gen = shot?.gen || defaultGen(shot?.kind), still = { ...SHOT_EST.still };
  if (gen === 'still') return { gen, items: [still], usd: still.usd };
  const V = SHOT_EST.video, clips = []; let left = Math.max(0, (shot.t1 - shot.t0) / 1000);
  do { const s = Math.min(V.max_s, left); clips.push(+(V.usd_per_s * Math.max(V.min_s, Math.ceil(s - 1e-6))).toFixed(2)); left -= s; } while (left > 0.05);
  const video = { kind: V.kind, tool: V.tool, usd: sum(clips), clips: clips.length, why: `${clips.length} clip${clips.length > 1 ? 's' : ''} for ${((shot.t1 - shot.t0) / 1000).toFixed(1)} s: ${V.why}` };
  const items = haveStill ? [video] : [{ ...still, why: 'the start frame: ' + still.why }, video];
  return { gen, items, usd: sum(items.map(x => x.usd)) };
}
// spent / committed / drafts / cap from costs.json + requests.json (the same sums as lib/store.mjs costSummary)
export function costView(costs, requests) {
  const R = requests?.items || requests || [], est = (st) => sum(R.filter(r => st.includes(r.status)).map(r => r.est_cost));
  return { cap: Number(costs?.cap_usd) || 0, spent: sum((costs?.items || []).map(x => x.usd)), committed: est(['approved', 'queued', 'running']), drafts: est(['draft']) };
}
export const shotRequests = (requests, id) => (requests?.items || requests || []).filter(r => r.target === `shot:${id}`);
const OPEN = ['draft', 'approved', 'queued', 'running', 'done'];

// the generation requests a shot would need (the page drafts them; gaps_get gives them to the agent): prompts, refs =
// the approved variant / look images (+ the frame sketch as the composition guide), honest estimates
export function shotProposal(shot, scene, assets, { sketchPng = null, haveStill = null } = {}) {
  const est = shotEstimate(shot, { haveStill: !!haveStill }), refs = [];
  const ok = assets.filter(a => a.approved && a.image);
  for (const a of ok) if (!refs.includes(a.image)) refs.push(a.image);
  if (sketchPng) refs.push(sketchPng);
  const nm = (a) => `${a.name}${a.variant ? ` (${a.type === 'character' ? 'look' : 'variant'} "${a.variant_name}")` : ''}`;
  const by = (t) => assets.filter(a => a.type === t).map(nm);
  const what = String(shot.text || shot.title || '').trim() || scene?.text || '';
  const still = `Film still, 16:9, a ${shot.kind} shot${scene?.title ? ` in the scene "${scene.title}"` : ''}: ${what}.`
    + (by('character').length ? ` With ${by('character').join(', ')}.` : '') + (by('location').length ? ` At ${by('location').join(', ')}.` : '') + (by('prop').length ? ` Props: ${by('prop').join(', ')}.` : '')
    + (shot.camera ? ` Camera: ${shot.camera}.` : '') + (ok.length ? ` Keep every character, place and object exactly as in its reference sheet (images 1-${ok.length}).` : '')
    + (sketchPng ? ` Follow the composition of the frame sketch (image ${refs.length}).` : '') + ' Photographic, cinematic light.';
  const secs = ((shot.t1 - shot.t0) / 1000).toFixed(1);
  const video = `${shot.camera || 'Subtle camera movement'}; ${what || 'the action of the shot'}. Start from the shot's approved still (the start frame), ${secs} s; keep the faces, costumes, the place and the light unchanged.`;
  return {
    requests: est.items.map(x => ({ kind: x.kind, target: `shot:${shot.id}`, tool: x.tool, est_cost: x.usd, why: x.why,
      prompt: x.kind === 'shot-video' ? video : still, refs: x.kind === 'shot-video' ? (haveStill ? [haveStill] : ['(the output of the still request)']) : refs })),
    est_usd: est.usd, gen: est.gen, missing: assets.filter(a => !a.approved).map(a => ({ type: a.type, id: a.id, variant: a.variant, why: a.why })),
  };
}

// ------------------------------------------------------------------ gaps: what is still missing, across the stages
// -> {unscripted, no_shots, no_frame, assets, no_request, counts, estimate {shots, usd}}; each row says where to go
export function boardGaps({ song, scenes = [], shots = [], entities = [], approvals, requests }) {
  const dur = song?.duration_ms || 0, sc = new Map(scenes.map(s => [s.id, s]));
  const unscripted = scriptGaps(scenes, dur).map(([t0, t1]) => ({ t0, t1, time: span(t0, t1) }));
  const no_shots = scenes.filter(s => !shots.some(x => x.scene === s.id)).map(s => ({ scene: s.id, title: s.title, time: span(s.t0, s.t1), beats: (s.beats || []).length }));
  const no_frame = shots.filter(s => !s.sketch && !s.thumb).map(s => ({ shot: s.id, scene: s.scene, time: span(s.t0, s.t1) }));
  const am = new Map(), no_request = [];
  for (const s of shots) {
    for (const a of shotAssets(s, entities, approvals)) {
      if (a.approved) continue;
      const k = `${a.type}:${a.id}:${a.variant || ''}`;
      (am.get(k) || am.set(k, { type: a.type, id: a.id, name: a.name, variant: a.variant, variant_name: a.variant_name, why: a.why, missing: !!a.missing, shots: [] }).get(k)).shots.push(s.id);
    }
    const reqs = shotRequests(requests, s.id).filter(r => OPEN.includes(r.status));
    if (!(s.clips || []).length && !reqs.length) { const e = shotEstimate(s); no_request.push({ shot: s.id, scene: s.scene, time: span(s.t0, s.t1), kind: s.kind, gen: e.gen, usd: e.usd, scene_title: sc.get(s.scene)?.title || null }); }
  }
  const assets = [...am.values()];
  const counts = { unscripted: unscripted.length, no_shots: no_shots.length, no_frame: no_frame.length, assets: assets.length, no_request: no_request.length };
  return { unscripted, no_shots, no_frame, assets, no_request, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), estimate: { shots: no_request.length, usd: sum(no_request.map(x => x.usd)) } };
}

// ------------------------------------------------------------------ text (for word diffs of two versions)
const clock = (ms) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
export function boardText(v) {
  return [...(v?.shots || [])].sort(byTime).map(s => [`[${s.scene || '-'} ${s.id} ${clock(s.t0)}–${clock(s.t1)} ${s.kind}${s.gen ? ' ' + s.gen : ''}] ${s.title || ''}`, ...(s.text ? [s.text] : []), ...(s.camera ? [`camera: ${s.camera}`] : []),
    ...([...s.cast || [], ...s.locations || [], ...s.props || []].length ? [`with: ${[...s.cast || [], ...s.locations || [], ...s.props || []].map(x => x + (s.variants && Object.hasOwn(s.variants, x) ? `(${s.variants[x] || 'root'})` : '')).join(', ')}`] : []),
    ...(s.sketch ? [`frame: ${s.sketch}`] : [])].join('\n')).join('\n\n');
}
export function shotChanges(a, b) {
  const X = new Map((a?.shots || []).map(s => [s.id, s])), Y = new Map((b?.shots || []).map(s => [s.id, s]));
  return { added: [...Y.keys()].filter(k => !X.has(k)), removed: [...X.keys()].filter(k => !Y.has(k)), changed: [...Y.keys()].filter(k => X.has(k) && JSON.stringify(X.get(k)) !== JSON.stringify(Y.get(k))) };
}
