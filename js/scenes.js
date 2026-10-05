// Stage 2 of the guided flow (docs/SPEC_v3_GUIDED.md): the script draft. Pure functions, no DOM and no Node APIs:
// the page (tabs/script.js, js/columns.js) and the data layer (lib/store.mjs) import the same code.
//
// scenes.json  {rev, current: "v3", versions: [{id, n, created, by, via, message, from?, scenes: [Scene]}],
//               states: {<scene id>: {status, by, via, at}}, notes: [Note], intake: {<question id>: Answer}}
//   Scene   {id "sc03", t0, t1, title, text, line_ids[], beats: [{id "b1", t, text}], sketches: [sketch ids],
//            anchors?: {t0?: event id, t1?: event id}, context?: world}   anchors: the boundary follows a named event
//            (js/events.js, E1); context: the scene's WORLD (E6, js/worlds.js): its shots' cast wear their look for it
//           t0 < t1 are integer ms of the song; beats lie inside [t0, t1]; line_ids = the song.json lines that start
//           inside the scene; sketches name files in sketches/<id>.json|.png|.mask.png (see lib/store.mjs sketch_*)
//   states  per-scene status outside the versions: draft | needs_you | ok; only the page sets ok (the director)
//   Note    {id "sn01", scene: id | null, beat?: id, text, by, via, to?: "agent", kind?: "request" | "fill_gaps",
//            gaps?: [[t0, t1]], status: open | resolved, at, version, replies: [{id, text, by, via, at}]}
//   Answer  {text, by, via, at, asked?: {by, via, at}}   asked = the agent asked this question in a chat
//   A version is immutable: a save appends one and moves `current`; a restore appends a copy. A project without the
//   file reads as v1 derived from the old script.json (its `stages` become scenes, its `lines` their beats), so a
//   project scripted before the guided flow opens with its script; script.json itself is never rewritten.
import { snapToEvent, anchorsOf, checkAnchors, settleAnchors } from './events.js';
import { cleanWorld } from './worlds.js';
export const INTAKE = [
  { id: 'mood', q: 'Genre and mood', hint: 'e.g. dream-pop, melancholic but warm; what should it feel like' },
  { id: 'kind', q: 'Story, performance or concept?', hint: 'or a mix: which one carries the video' },
  { id: 'who', q: 'Who appears?', hint: 'the singer, friends, actors, nobody; how many' },
  { id: 'where', q: 'Where does it happen?', hint: 'places, interiors, one room, a city at night' },
  { id: 'era', q: 'Era and look', hint: 'period, palette, film stock, lighting' },
  { id: 'refs', q: 'References', hint: 'videos, films, photographers, links' },
  { id: 'must', q: 'Must-haves', hint: 'moments, images, props that have to be in it' },
  { id: 'mustnot', q: 'Must-nots', hint: 'what to avoid' },
  { id: 'budget', q: 'Budget / cost cap', hint: 'how much generation spend is fine (the cap lives in Review > Costs)' },
];
export const SCENE_STATUSES = ['draft', 'needs_you', 'ok'];
export const SCENE_STATUS_LABEL = { draft: 'draft', needs_you: 'needs you', ok: 'ok' };
export const SKETCH_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SCENE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const SNAPS = ['off', 'lines', 'bars', 'sections', 'events'];

const clock = (ms) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
export const span = (a, b) => `${clock(a)}–${clock(b)}`;
const num = (v) => Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN;
const maxN = (list, re) => list.reduce((m, x) => Math.max(m, Number(re.exec(String(x?.id))?.[1]) || 0), 0);

// ------------------------------------------------------------------ song helpers
// the song lines that start inside [t0, t1)
export const linesIn = (song, t0, t1) => (song?.lines || []).filter(l => l.t0 >= t0 && l.t0 < t1);
// nearest boundary of the given kind (lines: line starts and ends + section bounds; bars: downbeats; sections: section
// bounds; events: the named events (js/events.js), given as `events`), always including 0 and the end of the song
export function snapTime(t, song, mode, events) {
  if (!mode || mode === 'off' || !song) return Math.round(t);
  if (mode === 'events') return snapToEvent(t, song, events || []).t;
  const dur = song.duration_ms || 0, secs = (song.sections || []).flatMap(s => [s.t0, s.t1]);
  const c = mode === 'lines' ? [...(song.lines || []).flatMap(l => [l.t0, l.t1]), ...secs] : mode === 'bars' ? (song.grid?.downbeats || []) : secs;
  let best = Math.round(t), d = Infinity;
  for (const x of [0, dur, ...c]) { const e = Math.abs(x - t); if (e < d) { d = e; best = x; } }
  return best;
}
// unscripted ranges of [0, dur] (scenes may overlap); gaps shorter than min are ignored
export function gaps(scenes, dur, min = 1000) {
  const s = [...(scenes || [])].sort((a, b) => a.t0 - b.t0), out = [];
  let at = 0;
  for (const x of s) { if (x.t0 - at >= min) out.push([at, x.t0]); at = Math.max(at, x.t1); }
  if (dur - at >= min) out.push([at, dur]);
  return out;
}
export const coverage = (scenes, dur) => dur > 0 ? Math.max(0, Math.min(1, 1 - gaps(scenes, dur, 1).reduce((a, [x, y]) => a + y - x, 0) / dur)) : 0;

// ------------------------------------------------------------------ documents
export function emptyScenes() { return { rev: 0, current: null, versions: [], states: {}, notes: [], intake: {} }; }
// the old script.json -> scenes: its `stages` [{name, t0, t1, text}] become scenes and its lines [{t0, action, lyric}]
// the beats inside them; a script with lines only gets one scene per song section that has lines
export function scenesFromScript(script, song) {
  const lines = [...(script?.lines || [])].filter(l => Number.isFinite(l?.t0)).sort((a, b) => a.t0 - b.t0);
  let ranges = (script?.stages || []).filter(s => Number.isFinite(s?.t0) && Number.isFinite(s?.t1) && s.t1 > s.t0).map(s => ({ t0: s.t0, t1: s.t1, title: String(s.name || ''), text: String(s.text || '') }));
  if (!ranges.length && lines.length) ranges = (song?.sections || []).filter(s => lines.some(l => l.t0 >= s.t0 && l.t0 < s.t1)).map(s => ({ t0: s.t0, t1: s.t1, title: String(s.label || s.id), text: '' }));
  return ranges.sort((a, b) => a.t0 - b.t0).map((r, i) => ({
    id: `sc${String(i + 1).padStart(2, '0')}`, t0: r.t0, t1: r.t1, title: r.title, text: r.text, line_ids: linesIn(song, r.t0, r.t1).map(l => l.id),
    beats: lines.filter(l => l.t0 >= r.t0 && l.t0 < r.t1).map((l, k) => ({ id: `b${k + 1}`, t: l.t0, text: String(l.action || l.lyric || '') + (l.mode ? ` (${l.mode})` : '') })),
    sketches: [],
  }));
}
// any scenes.json (or none) -> a usable doc; a missing / empty one derives v1 from script.json
export function normScenes(doc, song, script) {
  const d = doc && typeof doc === 'object' && Array.isArray(doc.versions) ? { ...emptyScenes(), ...doc } : { ...emptyScenes(), ...(doc && typeof doc === 'object' ? { rev: doc.rev || 0 } : {}) };
  if (!Array.isArray(d.notes)) d.notes = [];
  if (!d.states || typeof d.states !== 'object' || Array.isArray(d.states)) d.states = {};
  if (!d.intake || typeof d.intake !== 'object' || Array.isArray(d.intake)) d.intake = {};
  if (!d.versions.length) {
    const sc = scenesFromScript(script, song);
    if (sc.length) { d.versions = [{ id: 'v1', n: 1, created: null, by: 'import', via: 'import', message: 'from script.json', scenes: sc }]; d.current = 'v1'; d.derived = true; }
  }
  if (d.versions.length && !d.versions.some(v => v.id === d.current)) d.current = d.versions[d.versions.length - 1].id;
  return d;
}
export const currentScript = (doc) => doc?.versions?.find(v => v.id === doc.current) || null;
export const sameScenes = (a, b) => JSON.stringify(a?.scenes || a || []) === JSON.stringify(b?.scenes || b || []);
export function addScriptVersion(doc, scenes, { by = 'director', via, message = '', from, created } = {}) {
  const n = Math.max(0, ...doc.versions.map(v => v.n || Number(String(v.id).replace(/\D/g, '')) || 0)) + 1;
  const v = { id: `v${n}`, n, created: created || new Date().toISOString().slice(0, 19), by, ...(via ? { via } : {}), message: String(message || ''), ...(from ? { from } : {}), scenes: structuredClone(scenes) };
  doc.versions.push(v); doc.current = v.id; delete doc.derived;
  return v;
}
export const nextSceneId = (doc, draft) => `sc${String(Math.max(maxN((doc?.versions || []).flatMap(v => v.scenes || []), /^sc(\d+)$/), maxN(draft || [], /^sc(\d+)$/)) + 1).padStart(2, '0')}`;
export const nextBeatId = (scene) => `b${maxN(scene?.beats || [], /^b(\d+)$/) + 1}`;
export const nextNoteId = (doc) => `sn${String(maxN(doc?.notes || [], /^sn(\d+)$/) + 1).padStart(2, '0')}`;

// a scene from the page or an agent -> the stored shape (ints, strings, sorted beats, line ids from the song); throws
// a message on what cannot be fixed
// with `events` (the named events) an anchored edge takes its event's time and snap "events" anchors the edges it snaps
// (warnings into `warnings`); without them the anchors are kept as given
export function cleanScene(s, song, { snap, events, warnings } = {}) {
  if (!s || typeof s !== 'object') throw new Error('a scene must be an object');
  if (!SCENE_ID.test(String(s.id || ''))) throw new Error(`scene id "${s.id}": letters, digits, _ and - (up to 40)`);
  const dur = song?.duration_ms || Infinity;
  let t0 = num(s.t0), t1 = num(s.t1), anchors = anchorsOf(s);
  checkAnchors(s.anchors, `scene ${s.id}`);
  if (events) { const x = { t0, t1, ...(anchors ? { anchors } : {}) }; const w = settleAnchors(x, events, { snap, song, what: `scene ${s.id}` }); warnings?.push(...w); ({ t0, t1 } = x); anchors = x.anchors || null; if (snap === 'events') snap = null; }
  if (snap && snap !== 'off') { if (!anchors?.t0) t0 = snapTime(t0, song, snap); if (!anchors?.t1) t1 = snapTime(t1, song, snap); }
  if (!(t0 >= 0 && t1 > t0 && t1 <= dur)) throw new Error(`scene ${s.id}: needs 0 <= t0 < t1 <= ${dur} ms (got ${s.t0}, ${s.t1})`);
  const beats = (Array.isArray(s.beats) ? s.beats : []).map((b, i) => {
    const t = num(b?.t);
    if (!(t >= t0 && t <= t1)) throw new Error(`scene ${s.id}: beat ${b?.id || i + 1} at ${b?.t} is outside the scene (${t0}-${t1})`);
    return { id: String(b?.id || ''), t, text: String(b?.text ?? '').slice(0, 4000) };
  }).sort((a, b) => a.t - b.t);
  const used = new Set(), seq = { n: maxN(beats, /^b(\d+)$/) };
  for (const b of beats) { if (!/^b\d+$/.test(b.id) || used.has(b.id)) b.id = `b${++seq.n}`; used.add(b.id); }
  const sketches = [...new Set((Array.isArray(s.sketches) ? s.sketches : []).map(String))];
  for (const k of sketches) if (!SKETCH_ID.test(k)) throw new Error(`scene ${s.id}: sketch id "${k}" (lower-case letters, digits, _ and -)`);
  const lines = song?.lines ? linesIn(song, t0, t1).map(l => l.id) : (Array.isArray(s.line_ids) ? s.line_ids.map(String) : []);
  let context = null; try { context = cleanWorld(s.context); } catch (e) { throw new Error(`scene ${s.id}: ${e.message}`); }
  return { id: String(s.id), t0, t1, title: String(s.title ?? '').slice(0, 300), text: String(s.text ?? '').slice(0, 20000), line_ids: lines, beats, sketches, ...(anchors ? { anchors } : {}), ...(context ? { context } : {}) };
}
// a scenes.json from the page or an agent: the shape the tools rely on (throws a message on a bad file)
export function checkScenes(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.versions)) throw new Error('scenes.json: {versions[], notes[], states{}, intake{}} expected');
  if (d.notes != null && !Array.isArray(d.notes)) throw new Error('scenes.json: notes must be a list');
  for (const k of ['states', 'intake']) if (d[k] != null && (typeof d[k] !== 'object' || Array.isArray(d[k]))) throw new Error(`scenes.json: ${k} must be an object`);
  const ids = new Set();
  for (const v of d.versions) {
    if (!v || typeof v.id !== 'string' || ids.has(v.id) || !Array.isArray(v.scenes)) throw new Error('scenes.json: every version needs a unique id and scenes[]');
    ids.add(v.id); const S = new Set();
    for (const s of v.scenes) {
      if (!s || typeof s.id !== 'string' || !SCENE_ID.test(s.id) || S.has(s.id)) throw new Error(`scenes.json: ${v.id}: every scene needs a unique id (letters, digits, _ -)`);
      S.add(s.id);
      if (!Number.isInteger(s.t0) || !Number.isInteger(s.t1) || s.t0 < 0 || s.t1 <= s.t0) throw new Error(`scenes.json: ${v.id}/${s.id}: integer t0 < t1 expected`);
      if (typeof s.title !== 'string' || typeof s.text !== 'string' || !Array.isArray(s.beats) || !Array.isArray(s.sketches)) throw new Error(`scenes.json: ${v.id}/${s.id}: title, text, beats[], sketches[] expected`);
      for (const b of s.beats) if (!b || typeof b.id !== 'string' || !Number.isFinite(b.t) || typeof b.text !== 'string') throw new Error(`scenes.json: ${v.id}/${s.id}: every beat needs id, t, text`);
      for (const k of s.sketches) if (typeof k !== 'string' || !SKETCH_ID.test(k)) throw new Error(`scenes.json: ${v.id}/${s.id}: bad sketch id`);
      checkAnchors(s.anchors, `scenes.json: ${v.id}/${s.id}`);
      if (s.context != null) { let w; try { w = cleanWorld(s.context); } catch (e) { throw new Error(`scenes.json: ${v.id}/${s.id}: ${e.message}`); } if (w !== s.context) throw new Error(`scenes.json: ${v.id}/${s.id}: context must be a world name in lower case`); }
    }
  }
  if (d.versions.length && !ids.has(d.current)) throw new Error('scenes.json: current must name a version');
  for (const [k, v] of Object.entries(d.states || {})) if (!v || !SCENE_STATUSES.includes(v.status)) throw new Error(`scenes.json: states.${k}.status must be one of ${SCENE_STATUSES.join(', ')}`);
  return d;
}
export const sceneStatus = (doc, id) => doc?.states?.[id]?.status || 'draft';
export const intakeOpen = (doc) => INTAKE.filter(q => !String(doc?.intake?.[q.id]?.text || '').trim()).map(q => q.id);

// the whole script as text (for word diffs of two versions)
export function scriptText(v) {
  return (v?.scenes || []).map(s => [`[${span(s.t0, s.t1)}] ${s.title || '(untitled)'}`, ...(s.text ? [s.text] : []), ...(s.context ? [`world: ${s.context}`] : []), ...s.beats.map(b => `· ${clock(b.t)} ${b.text}`), ...(s.sketches.length ? [`sketches: ${s.sketches.join(', ')}`] : [])].join('\n')).join('\n\n');
}
// which scenes were added / removed / changed between two versions
export function sceneChanges(a, b) {
  const A = new Map((a?.scenes || []).map(s => [s.id, s])), B = new Map((b?.scenes || []).map(s => [s.id, s]));
  return { added: [...B.keys()].filter(k => !A.has(k)), removed: [...A.keys()].filter(k => !B.has(k)), changed: [...B.keys()].filter(k => A.has(k) && JSON.stringify(A.get(k)) !== JSON.stringify(B.get(k))) };
}
