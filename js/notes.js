// ONE notes model for every stage and the timeline (docs/SPEC_v4_NOTES_ROUNDS.md §1). Pure functions, no DOM, no Node
// APIs and no imports: the page (js/store.js, core/notescol.js, the stage tabs, the timeline notes column) and the data
// layer (lib/ops/notes.mjs, serve.mjs) use the same code.
//
// notes.json v2  {v: 2, rev, round, notes: [Note], legacy_seen: ["<store>:<id>", ...], migrated?: {at, from: {...}}}
//   Note    {id "ln03", target: Target, text, by, via: page | agent | import, status: open | absorbed | dismissed,
//            round, replies: [{id "ln03.1", text, by, via, at}], absorbed_in: <revision id> | null, created,
//            to?: "agent", ask?: request | fill_gaps | extract | storyboard | round (an ask for the agent; "round" = the
//            one ask a sent review round writes, js/revisions.js), gaps?, version?
//            (the stage version it was written on), marker?: true (a timeline marker), about? (an item key),
//            closed_by?, closed_via?, closed_at?, legacy?: {store, id} (where a migrated note came from),
//            change?: {stage, file?, version?, summary, at, by} (what the agent changed for it: round_absorb)}
//   Target  {stage, kind, id, w?, quote?, t?, pin?, line?, scene?}
//     stage  lyrics | script | breakdown | characters | scenery | storyboard | final | timeline
//     kind   per stage (KINDS): "stage" = the whole stage (id null); lyrics line / section; script scene / beat
//            (id "sc02/b1"); breakdown item / scene; characters / scenery asset (id = entity id), tree ("ada/identity"),
//            node ("ada/n03"), use ("ada/sc02": the asset in a scene); storyboard scene / shot; final shot; timeline
//            time (id null, t required, line = the lyric line there)
//     w      [first, last] word index on a lyric line (+ quote, the words); t ms (a time); pin {x, y} 0..1 on an image
//            (a node, an asset sheet, a shot frame)
//   `round` is the review round the note was written in (B6 rounds build on it); "absorbed" = handled (by the agent in a
//   round, or marked done by the director), "dismissed" = dropped (only the director dismisses the director's notes).
// The old per-stage stores (notes.json v1, lyrics.json / scenes.json / breakdown.json / storyboard.json `notes`, entity
// `iter.notes`) are read once into v2 (migrate / importLegacy) and never written again; the old MCP note tools are
// aliases that write v2 and answer in the old shapes (legacyView).

export const STAGES = ['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'final', 'timeline'];
export const KINDS = {
  lyrics: ['stage', 'section', 'line'],
  script: ['stage', 'scene', 'beat'],
  breakdown: ['stage', 'item', 'scene'],
  characters: ['stage', 'asset', 'tree', 'node', 'use'],
  scenery: ['stage', 'asset', 'tree', 'node', 'use'],
  storyboard: ['stage', 'scene', 'shot'],
  final: ['stage', 'shot'],
  timeline: ['time'],
};
export const STATUSES = ['open', 'absorbed', 'dismissed'];
export const ASKS = ['request', 'fill_gaps', 'extract', 'storyboard', 'round'];
export const PREFIX = { lyrics: 'ln', script: 'sn', breakdown: 'bn', characters: 'cn', scenery: 'an', storyboard: 'sbn', final: 'fn', timeline: 'n' };
export const STAGE_TITLE = { lyrics: 'Lyrics', script: 'Script', breakdown: 'Breakdown', characters: 'Characters', scenery: 'Scenery', storyboard: 'Storyboard', final: 'Final', timeline: 'Timeline' };
export const TEXT_MAX = 8000;
export const NOTE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;
// a target id: a line ("verse/0"), a beat ("sc02/b1"), a node ("ada/n03"), a tree ("ada/look:night-out")
export const TARGET_ID = /^[A-Za-z0-9_][A-Za-z0-9_:/.-]{0,127}$/;
const PIN_KINDS = new Set(['asset', 'node', 'shot', 'scene']);

export const emptyNotes = () => ({ v: 2, rev: 0, round: 1, notes: [], legacy_seen: [] });
export const isV2 = (d) => !!d && typeof d === 'object' && d.v === 2 && Array.isArray(d.notes);
const nowIso = () => new Date().toISOString().slice(0, 19);
const str = (v, n) => String(v ?? '').slice(0, n);
const words = (text) => String(text || '').split(/\s+/).filter(Boolean);

// characters / scenery: the stage of an asset kind
export const assetStage = (kind) => kind === 'character' ? 'characters' : 'scenery';
// "ada/n03" -> ["ada", "n03"]; a beat "sc02/b1" -> ["sc02", "b1"]; a tree "ada/look:x" -> ["ada", "look:x"]
export const splitId = (id) => { const s = String(id || ''), i = s.indexOf('/'); return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)]; };

// ------------------------------------------------------------------ validation
class NoteError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
const bad = (msg) => { throw new NoteError(msg); };
// a target as stored: the known fields, checked; anything else dropped. duration (ms) bounds t when given.
export function cleanTarget(t, { duration } = {}) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) bad('target: {stage, kind, id?, w?, t?, pin?} expected');
  if (!STAGES.includes(t.stage)) bad(`target.stage: one of ${STAGES.join(', ')}`);
  const kinds = KINDS[t.stage];
  const kind = t.kind ?? (t.stage === 'timeline' ? 'time' : null);
  if (!kinds.includes(kind)) bad(`target.kind for ${t.stage}: one of ${kinds.join(', ')}`);
  const out = { stage: t.stage, kind, id: null };
  if (kind !== 'stage' && kind !== 'time') {
    if (typeof t.id !== 'string' || !TARGET_ID.test(t.id) || t.id.split('/').some(s => s === '' || s === '.' || s === '..')) bad(`target.id: the ${kind} id (letters, digits, _ - : . /)`);
    if ((kind === 'beat' || kind === 'node' || kind === 'tree' || kind === 'use') && !splitId(t.id)[1]) bad(`target.id for a ${kind}: "<${kind === 'beat' ? 'scene' : 'asset'}>/<${kind === 'use' ? 'scene' : kind}>"`);
    out.id = t.id;
  }
  if (t.t != null) {
    const v = Number(t.t);
    if (!Number.isFinite(v) || v < 0 || (duration != null && v > duration + 1)) bad(`target.t: ms inside the song (0..${duration ?? '…'})`);
    out.t = Math.round(v);
  } else if (kind === 'time') bad('target.t: the time in ms is required for a timeline note');
  if (t.w != null) {
    if (t.stage !== 'lyrics' || kind !== 'line') bad('target.w: a word range is only for a lyric line');
    const w = Array.isArray(t.w) ? t.w.map(Number) : [];
    if (w.length !== 2 || !w.every(Number.isInteger) || w[0] < 0 || w[1] < w[0] || w[1] > 400) bad('target.w: [first, last] word index');
    out.w = w;
  }
  if (t.quote != null && t.quote !== '') { if (typeof t.quote !== 'string') bad('target.quote: the words'); out.quote = str(t.quote, 300); }
  if (t.pin != null) {
    if (!PIN_KINDS.has(kind)) bad(`target.pin: only on an ${[...PIN_KINDS].join(' / ')}`);
    const x = Number(t.pin?.x), y = Number(t.pin?.y);
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) bad('target.pin: {x, y} fractions 0..1 of the image');
    out.pin = { x: +x.toFixed(4), y: +y.toFixed(4) };
  }
  if (t.line != null && t.line !== '') { if (typeof t.line !== 'string' || !TARGET_ID.test(t.line)) bad('target.line: a lyric line id'); out.line = t.line; }
  if (t.scene != null && t.scene !== '') { if (typeof t.scene !== 'string' || !TARGET_ID.test(t.scene) || t.scene.includes('/')) bad('target.scene: a scene id'); out.scene = t.scene; }
  return out;
}
export function cleanText(text) {
  if (typeof text !== 'string' || !text.trim()) bad('text: the note (a non-empty string)');
  if (text.length > TEXT_MAX) bad(`text: up to ${TEXT_MAX} characters`);
  return text;
}
// a whole notes.json v2 (a page save): shape only (the server stamps authors; lib/ops/notes.mjs checks targets exist)
export function checkNotes(d, opts = {}) {
  if (!isV2(d)) bad('notes.json: {v: 2, notes: [...]} expected (reload the page: the notes moved to one list)');
  const ids = new Set();
  for (const n of d.notes) {
    if (!n || typeof n !== 'object') bad('notes.json: every note is an object');
    if (typeof n.id !== 'string' || !NOTE_ID.test(n.id) || ids.has(n.id)) bad(`notes.json: a unique note id (letters, digits, _ . -): ${JSON.stringify(n.id)}`);
    ids.add(n.id);
    try { n.target = cleanTarget(n.target, opts); cleanText(n.text); } catch (e) { bad(`notes.json ${n.id}: ${e.message}`); }
    if (!STATUSES.includes(n.status)) bad(`notes.json ${n.id}: status one of ${STATUSES.join(', ')}`);
    if (n.replies != null && (!Array.isArray(n.replies) || n.replies.some(r => !r || typeof r !== 'object' || typeof r.text !== 'string' || r.text.length > TEXT_MAX))) bad(`notes.json ${n.id}: replies [{id, text}]`);
  }
  if (d.legacy_seen != null && !Array.isArray(d.legacy_seen)) bad('notes.json: legacy_seen must be a list');
  return d;
}
export { NoteError };

// ------------------------------------------------------------------ ids, lookups, counts
export function nextNoteId(doc, stage) {
  const px = PREFIX[stage] || 'n', re = new RegExp(`^${px}(\\d+)$`);
  let m = 0; for (const n of doc?.notes || []) { const x = re.exec(n.id); if (x) m = Math.max(m, Number(x[1])); }
  for (const k of doc?.legacy_seen || []) { const x = re.exec(String(k).split(':').pop()); if (x) m = Math.max(m, Number(x[1])); }
  return `${px}${String(m + 1).padStart(2, '0')}`;
}
export const nextReplyId = (n) => `${n.id}.${(n.replies || []).reduce((m, r) => Math.max(m, Number(String(r.id).split('.').pop()) || 0), 0) + 1}`;
// a note by its id, or by the id it had in its old store (lyrics_note_resolve "ln02" keeps working)
export const findNote = (doc, id) => (doc?.notes || []).find(n => n.id === id) || (doc?.notes || []).find(n => n.legacy?.id === id) || null;
export const isOpen = (n) => n.status === 'open';
export const sameTarget = (a, b) => a.stage === b.stage && a.kind === b.kind && (a.id || null) === (b.id || null);
// the notes on one row (stage + kind + id), or a whole stage
export function notesOn(doc, { stage, kind, id, status } = {}) {
  return (doc?.notes || []).filter(n => (!stage || n.target.stage === stage) && (!kind || n.target.kind === kind) && (id === undefined || (n.target.id || null) === (id || null)) && (!status || status === 'all' || n.status === status));
}
// open notes per stage and in all: {total, stages: {lyrics: n, ...}, asks (open asks for the agent)}; the ask a sent
// round writes (ask "round") is counted as an ask only, never as a note on a stage
export function openCounts(doc) {
  const stages = Object.fromEntries(STAGES.map(s => [s, 0])); let total = 0, asks = 0;
  for (const n of doc?.notes || []) if (n.status === 'open') { if (n.to === 'agent') asks++; if (n.ask === 'round') continue; stages[n.target.stage] = (stages[n.target.stage] || 0) + 1; total++; }
  return { total, asks, stages };
}
export const openAsks = (doc, stage) => (doc?.notes || []).filter(n => n.status === 'open' && n.to === 'agent' && n.target.stage === stage);

// ------------------------------------------------------------------ the old stores -> v2 (once, without loss)
const legacyStatus = (s) => s === 'resolved' ? 'absorbed' : s === 'dismissed' || s === 'absorbed' ? s : 'open';
// an old note without via: the page's own (the old stores stamped every note an agent wrote via "agent"), or an import
const viaOf = (x) => x.via || (x.by === 'import' ? 'import' : 'page');
const replyOf = (r, pid, k) => ({ id: typeof r.id === 'string' && r.id ? str(r.id, 60) : `${pid}.${k + 1}`, text: str(r.text, TEXT_MAX), by: str(r.by || 'director', 60), via: viaOf(r), at: r.at || null });
// one note of an old store -> its v2 note (id chosen by the caller)
function fromLegacy(x, target, extra = {}) {
  const ask = x.to === 'agent' ? (ASKS.includes(x.kind) ? x.kind : 'request') : null;
  return {
    id: x.id, target, text: str(x.text, TEXT_MAX) || '(empty)', by: str(x.by || 'director', 60), via: viaOf(x), status: legacyStatus(x.status),
    round: 1, replies: (Array.isArray(x.replies) ? x.replies : []).filter(r => r && typeof r === 'object').map((r, k) => replyOf(r, x.id, k)),
    absorbed_in: null, created: x.at || x.created || null,
    ...(x.to ? { to: str(x.to, 20) } : {}), ...(ask ? { ask } : {}), ...(x.gaps != null ? { gaps: x.gaps } : {}), ...(x.version ? { version: x.version } : {}),
    ...(x.kind === 'marker' ? { marker: true } : {}), ...(x.about ? { about: str(x.about, 120) } : {}),
    ...(x.resolved_by ? { closed_by: str(x.resolved_by, 60) } : {}), ...(x.resolved_at ? { closed_at: x.resolved_at } : {}),
    ...extra,
  };
}
const idOk = (s) => typeof s === 'string' && TARGET_ID.test(s);
// each old store: [store key, notes, x -> target | null]
function legacySources({ notes, lyrics, scenes, breakdown, board, entities } = {}) {
  const out = [];
  if (notes && !isV2(notes) && Array.isArray(notes.notes)) out.push(['notes', notes.notes, (x) => ({ stage: 'timeline', kind: 'time', id: null, t: Math.max(0, Math.round(Number(x.t) || 0)), ...(idOk(x.line_id) ? { line: x.line_id } : {}) })]);
  if (Array.isArray(lyrics?.notes)) out.push(['lyrics', lyrics.notes, (x) => idOk(x.line)
    ? { stage: 'lyrics', kind: 'line', id: x.line, ...(Array.isArray(x.w) && x.w.length === 2 ? { w: x.w.map(Number) } : {}), ...(x.quote ? { quote: str(x.quote, 300) } : {}) }
    : { stage: 'lyrics', kind: 'stage', id: null }]);
  if (Array.isArray(scenes?.notes)) out.push(['scenes', scenes.notes, (x) => idOk(x.scene)
    ? (idOk(x.beat) ? { stage: 'script', kind: 'beat', id: `${x.scene}/${x.beat}` } : { stage: 'script', kind: 'scene', id: x.scene })
    : { stage: 'script', kind: 'stage', id: null }]);
  if (Array.isArray(breakdown?.notes)) out.push(['breakdown', breakdown.notes, (x) => idOk(x.item) ? { stage: 'breakdown', kind: 'item', id: x.item }
    : idOk(x.scene) ? { stage: 'breakdown', kind: 'scene', id: x.scene } : { stage: 'breakdown', kind: 'stage', id: null }]);
  if (Array.isArray(board?.notes)) out.push(['storyboard', board.notes, (x) => idOk(x.shot) ? { stage: 'storyboard', kind: 'shot', id: x.shot, ...(idOk(x.scene) ? { scene: x.scene } : {}) }
    : idOk(x.scene) ? { stage: 'storyboard', kind: 'scene', id: x.scene } : { stage: 'storyboard', kind: 'stage', id: null }]);
  for (const e of entities || []) {
    const it = e?.iter; if (!e || !idOk(e.id) || !Array.isArray(it?.notes)) continue;
    const stage = assetStage(e.kind);
    out.push([`entity:${e.id}`, it.notes, (x) => idOk(x.node) ? { stage, kind: 'node', id: `${e.id}/${x.node}` }
      : idOk(x.tree) ? { stage, kind: 'tree', id: `${e.id}/${x.tree}` }
      : idOk(x.scene) ? { stage, kind: 'use', id: `${e.id}/${x.scene}` } : { stage, kind: 'asset', id: e.id }]);
  }
  return out;
}
// add every note of the old stores that is not in doc yet (by "<store>:<id>"); returns how many were added per store.
// A note the director deleted from v2 stays seen (legacy_seen), so it is never brought back.
export function importLegacy(doc, stores) {
  doc.legacy_seen ||= [];
  const seen = new Set(doc.legacy_seen), used = new Set(doc.notes.map(n => n.id)), added = {};
  for (const [store, list, tgt] of legacySources(stores)) {
    const byOld = new Map();   // v1 replies (reply_to) fold into their note
    const items = list.filter(x => x && typeof x === 'object' && typeof x.id === 'string' && x.id);
    for (const x of items) {
      const key = `${store}:${x.id}`; if (seen.has(key)) continue;
      if (store === 'notes' && x.reply_to) {
        const p = byOld.get(x.reply_to) || doc.notes.find(n => n.legacy?.store === 'notes' && n.legacy.id === x.reply_to);
        if (p) { p.replies.push(replyOf({ ...x, id: null }, p.id, p.replies.length)); seen.add(key); doc.legacy_seen.push(key); added[store] = (added[store] || 0) + 1; continue; }
      }
      let target; try { target = cleanTarget(tgt(x)); } catch (e) { target = { stage: store === 'notes' ? 'timeline' : (tgt(x)?.stage || 'timeline'), kind: store === 'notes' ? 'time' : 'stage', id: null, ...(store === 'notes' ? { t: 0 } : {}) }; }
      let id = NOTE_ID.test(x.id) ? x.id : `${PREFIX[target.stage] || 'n'}x`;
      for (let k = 2; used.has(id); k++) id = `${NOTE_ID.test(x.id) ? x.id : PREFIX[target.stage] || 'n'}-${k}`;
      used.add(id);
      const n = fromLegacy({ ...x, id }, target, { legacy: { store, id: x.id } });
      n.round = doc.round || 1;
      if (store === 'notes' && x.reply_to) n.reply_to = x.reply_to;
      doc.notes.push(n); byOld.set(x.id, n);
      seen.add(key); doc.legacy_seen.push(key); added[store] = (added[store] || 0) + 1;
    }
  }
  return added;
}
// a new v2 doc from the old stores (stores.notes = the v1 notes.json, or null); rev moves past the v1 file's
export function migrate(stores, { at = nowIso() } = {}) {
  const d = emptyNotes();
  d.rev = (stores?.notes && !isV2(stores.notes) ? Number(stores.notes.rev) || 0 : 0) + 1;
  const from = importLegacy(d, stores || {});
  d.migrated = { at, from };
  return d;
}
export const legacyKeys = (stores) => legacySources(stores).flatMap(([store, list]) => list.filter(x => x && typeof x.id === 'string').map(x => `${store}:${x.id}`));

// ------------------------------------------------------------------ new notes and replies
export function makeNote(doc, { target, text, by = 'director', via = 'page', to, ask, gaps, version, about, marker, at = nowIso() }) {
  const n = { id: nextNoteId(doc, target.stage), target, text, by, via, status: 'open', round: doc.round || 1, replies: [], absorbed_in: null, created: at };
  if (to === 'agent') { n.to = 'agent'; n.ask = ASKS.includes(ask) ? ask : 'request'; }
  if (gaps != null) n.gaps = gaps;
  if (version) n.version = version;
  if (about) n.about = str(about, 120);
  if (marker) n.marker = true;
  return n;
}
export const makeReply = (n, { text, by = 'director', via = 'page', at = nowIso() }) => ({ id: nextReplyId(n), text, by, via, at });

// ------------------------------------------------------------------ the old shapes (the old MCP tools answer in them)
const oldStatus = (s) => s === 'open' ? 'open' : 'resolved';
const oldReplies = (n) => (n.replies || []).map(r => ({ id: r.id, text: r.text, by: r.by, via: r.via, at: r.at }));
const common = (n) => ({ id: n.id, text: n.text, by: n.by, via: n.via, ...(n.to ? { to: n.to } : {}), ...(n.ask ? { kind: n.ask } : {}), ...(n.gaps != null ? { gaps: n.gaps } : {}),
  status: oldStatus(n.status), v2_status: n.status, at: n.created, ...(n.version ? { version: n.version } : {}), replies: oldReplies(n),
  ...(n.closed_by ? { resolved_by: n.closed_by } : {}), ...(n.closed_at ? { resolved_at: n.closed_at } : {}) });
export function legacyView(n, store, { nodeTree } = {}) {
  const t = n.target, c = common(n);
  if (store === 'lyrics') return { ...c, line: t.kind === 'line' ? t.id : null, w: t.w || null, quote: t.quote || '' };
  if (store === 'scenes') { const [sc, b] = splitId(t.id); return { ...c, scene: t.kind === 'scene' || t.kind === 'beat' ? sc : null, ...(t.kind === 'beat' ? { beat: b } : {}) }; }
  if (store === 'breakdown') return { ...c, item: t.kind === 'item' ? t.id : null, ...(t.kind === 'scene' ? { scene: t.id } : {}) };
  if (store === 'storyboard') return { ...c, shot: t.kind === 'shot' ? t.id : null, ...(t.kind === 'scene' ? { scene: t.id } : t.scene ? { scene: t.scene } : {}) };
  if (store === 'asset') {
    const [, sub] = splitId(t.id);
    return { ...c, ...(t.kind === 'node' ? { node: sub, ...(nodeTree?.(sub) ? { tree: nodeTree(sub) } : {}) } : t.kind === 'tree' ? { tree: sub } : t.kind === 'use' ? { scene: sub } : {}), ...(t.pin ? { pin: t.pin } : {}) };
  }
  // notes.json v1 (the timeline)
  return { id: n.id, t: t.t ?? 0, line_id: t.line || null, by: n.by, via: n.via, text: n.text, status: oldStatus(n.status), v2_status: n.status, at: n.created,
    ...(n.about ? { about: n.about } : {}), ...(n.marker ? { kind: 'marker' } : {}), ...(n.reply_to ? { reply_to: n.reply_to } : {}), replies: oldReplies(n) };
}

// ------------------------------------------------------------------ time and words for a target
// the song time of a note, when its target has one: ctx {song, scenes (current script scenes), shots (storyboard shots)}
export function noteTime(n, { song, scenes, shots } = {}) {
  const t = n.target; if (t.t != null) return t.t;
  if (t.stage === 'lyrics' && t.kind === 'line') return song?.lines?.find(l => l.id === t.id)?.t0 ?? null;
  if (t.stage === 'lyrics' && t.kind === 'section') { const L = song?.lines?.find(l => l.id.startsWith(t.id + '/')); return L?.t0 ?? song?.sections?.find(s => s.id === t.id)?.t0 ?? null; }
  if (t.kind === 'scene' && t.stage !== 'characters' && t.stage !== 'scenery') return scenes?.find(s => s.id === t.id)?.t0 ?? null;
  if (t.kind === 'beat') { const [sc, b] = splitId(t.id); return scenes?.find(s => s.id === sc)?.beats?.find(x => x.id === b)?.t ?? null; }
  if (t.kind === 'shot') return shots?.find(s => s.id === t.id)?.t0 ?? null;
  return null;
}
// the words of a word-range note on a line's current text: [first, last] or null when they are gone
export function wordsNow(lineText, t) {
  const ws = words(lineText); if (!t?.w) return null;
  const [a, b] = t.w, q = t.quote ? words(t.quote) : null;
  if (q?.length) {
    const at = (i) => q.every((x, k) => ws[i + k] === x);
    if (at(a)) return [a, a + q.length - 1];
    for (let i = 0; i + q.length <= ws.length; i++) if (at(i)) return [i, i + q.length - 1];
    return null;
  }
  return b < ws.length ? [a, b] : null;
}
// a short human label of a target ("line verse/2 “night bus”", "node ada/n03 📍", "0:12.000")
export function targetLabel(t) {
  const tc = (ms) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };
  if (t.kind === 'stage') return `the whole ${t.stage}`;
  if (t.kind === 'time') return tc(t.t ?? 0) + (t.line ? ` (${t.line})` : '');
  return `${t.kind} ${t.id}${t.quote ? ` “${t.quote}”` : ''}${t.pin ? ' 📍' : ''}`;
}
