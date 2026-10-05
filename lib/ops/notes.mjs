// Notes: ONE model for every stage and the timeline (notes.json v2, js/notes.js; docs/SPEC_v4_NOTES_ROUNDS.md §1).
// notesDoc() reads notes.json and, the first time, migrates the old stores into it without loss: the v1 notes.json
// (kept as notes.v1.json), and the `notes` of lyrics.json, scenes.json, breakdown.json, storyboard.json and every
// entity's iter.notes (those files are never written by this). A note added to an old store later (an older page, a
// hand edit) is imported on the next read; one already imported is never imported twice (legacy_seen).
// Tools: notes_get / notes_add / notes_status (the one model), and the old ones as aliases that write v2:
// notes_list / note_add / note_resolve (the timeline) here, lyrics_note_*, scene_note_*, breakdown_note_*, shot_note_*,
// asset_note_add / character_note_add in their domains (through the helpers exported below).
// Rules: notes written here are via "agent"; an agent may reply, mark a note absorbed (it did what the note asks) or
// reopen it, and dismiss only its own notes: the director's notes are dismissed by the director, in the page (403).
import fs from 'node:fs';
import path from 'node:path';
import * as N from '../../js/notes.js';
import * as F from '../../js/flow.js';
import * as SC from '../../js/scenes.js';
import * as BD from '../../js/breakdown.js';
import * as SB from '../../js/storyboard.js';
import * as A from '../../js/assets.js';
import { WbError, fail, ms, nowIso, ops, projDir, read, readJSON, tc, writeJSON } from './_shared.mjs';
import { lyricsDoc } from './lyrics.mjs';
import { scenesDoc } from './scenes.mjs';
import { breakdownDoc } from './breakdown.mjs';
import { boardDoc } from './storyboard.mjs';
import { readAsset } from './assets.mjs';

// ------------------------------------------------------------------ the doc (migrated on first read)
const ENT_PATH = /^entities\/(characters|locations|props)\/[A-Za-z0-9_][A-Za-z0-9_-]{0,63}\.json$/;
const OLD = ['lyrics.json', 'scenes.json', 'breakdown.json', 'storyboard.json', 'entities/index.json'];
const checked = new Map();   // project dir -> the mtimes of notes.json and the old stores when last imported
function entityPaths(d) { return (readJSON(path.join(d, 'entities', 'index.json'), []) || []).map(e => e?.path).filter(x => typeof x === 'string' && ENT_PATH.test(x)); }
function signature(d) {
  const st = (f) => { try { return fs.statSync(path.join(d, f)).mtimeMs; } catch (e) { return 0; } };
  return ['notes.json', ...OLD, ...entityPaths(d)].map(st).join(',');
}
// the old stores, raw (only their notes matter); notes = the v1 notes.json or null
export function legacyStores(p, notesRaw = null) {
  const d = projDir(p), j = (f) => readJSON(path.join(d, f), null);
  const idx = readJSON(path.join(d, 'entities', 'index.json'), []) || [];
  const entities = idx.filter(e => typeof e?.path === 'string' && ENT_PATH.test(e.path)).map(e => { const x = j(e.path); return x && typeof x === 'object' ? { ...x, id: x.id || e.id, kind: x.kind || e.kind } : null; }).filter(Boolean);
  return { notes: N.isV2(notesRaw) ? null : notesRaw, lyrics: j('lyrics.json'), scenes: j('scenes.json'), breakdown: j('breakdown.json'), board: j('storyboard.json'), entities };
}
export function notesDoc(p) {
  const d = projDir(p), file = path.join(d, 'notes.json');
  const raw = readJSON(file, null, true);
  if (N.isV2(raw)) {
    raw.legacy_seen ||= []; raw.round ||= 1;
    const sig = signature(d); if (checked.get(d) === sig) return raw;
    const added = N.importLegacy(raw, legacyStores(p, raw));
    if (Object.keys(added).length) { raw.rev = (raw.rev || 0) + 1; writeJSON(file, raw); }
    checked.set(d, signature(d));
    return raw;
  }
  // first read: the old stores -> v2 (rev moves past the v1 file's, so a stale page gets 409 and re-reads)
  const doc = N.migrate(legacyStores(p, raw));
  if (raw && (raw.notes || []).length && !fs.existsSync(path.join(d, 'notes.v1.json'))) writeJSON(path.join(d, 'notes.v1.json'), raw);   // (an empty v1 list needs no copy)
  writeJSON(file, doc);
  checked.set(d, signature(d));
  return doc;
}
export function mutateNotes(p, fn) {
  const d = notesDoc(p); const r = fn(d);
  d.rev = (d.rev || 0) + 1; writeJSON(path.join(projDir(p), 'notes.json'), d);
  return r === undefined ? d : r;
}
const code = (e) => { if (e instanceof N.NoteError) throw new WbError(e.code, e.message); throw e; };

// ------------------------------------------------------------------ targets: shape (js/notes.js) + the thing exists
const words = (s) => String(s || '').split(/\s+/).filter(Boolean);
export function checkTarget(p, target) {
  let t; try { t = N.cleanTarget(target, { duration: read(p, 'song.json').duration_ms }); } catch (e) { code(e); }
  if (t.kind === 'stage' || t.kind === 'time') return t;
  const [a, b] = N.splitId(t.id);
  const scenes = () => SC.currentScript(scenesDoc(p))?.scenes || [];
  if (t.stage === 'lyrics') {
    const v = F.currentVersion(lyricsDoc(p));
    if (t.kind === 'section') { if (!(v?.sections || []).some(s => s.id === t.id)) fail(404, `no section "${t.id}" in the current lyrics (lyrics_get)`); return t; }
    const L = F.flatLines(v).find(l => l.id === t.id); if (!L) fail(404, `no line "${t.id}" in the current lyrics (lyrics_get lists the line ids)`);
    if (t.w && t.w[1] >= words(L.text).length) fail(400, `target.w: word indexes on line ${t.id} are 0..${words(L.text).length - 1}`);
    if (t.quote && !t.w) { const at = F.anchorWords(L.text, { w: [-1, -1], quote: t.quote }); if (!at) fail(404, `"${t.quote}" is not on line ${t.id}`); t.w = at; }
    if (t.w && !t.quote) t.quote = words(L.text).slice(t.w[0], t.w[1] + 1).join(' ');
    return t;
  }
  if (t.stage === 'script') {
    const s = scenes().find(x => x.id === a); if (!s) fail(404, `no scene "${a}" in the current script (script_get)`);
    if (t.kind === 'beat' && !s.beats.some(x => x.id === b)) fail(404, `no beat "${b}" in scene ${a}`);
    return t;
  }
  if (t.stage === 'breakdown') {
    if (t.kind === 'item' && !(BD.currentBreakdown(breakdownDoc(p))?.items || []).some(i => i.id === t.id)) fail(404, `no item "${t.id}" in the current breakdown (breakdown_get)`);
    if (t.kind === 'scene' && !scenes().some(s => s.id === t.id)) fail(404, `no scene "${t.id}" in the current script`);
    return t;
  }
  if (t.stage === 'characters' || t.stage === 'scenery') {
    const e = read(p, 'entities/index.json').find(x => x.id === a);
    if (!e || N.assetStage(e.kind) !== t.stage) fail(404, `no ${t.stage === 'characters' ? 'character' : 'location or prop'} "${a}" (asset_get lists them)`);
    if (t.kind === 'node' && !A.nodeById(readAsset(p, e.kind, a).ent.iter, b)) fail(404, `no node "${b}" on ${a}`);
    if (t.kind === 'tree' && !A.treeOk(e.kind, b)) fail(400, `target.id: "${a}/<tree>": "${A.TYPE[e.kind].root}" or "${A.TYPE[e.kind].vprefix}:<id>"`);
    if (t.kind === 'use' && !scenes().some(s => s.id === b)) fail(404, `no scene "${b}" in the current script`);
    return t;
  }
  // storyboard / final (a Queue row: a request of requests.json)
  if (t.kind === 'request' && !(read(p, 'requests.json').items || []).some(r => r.id === t.id)) fail(404, `no request "${t.id}" (requests_list)`);
  if (t.kind === 'shot' && !SB.boardShots(boardDoc(p)).some(s => s.id === t.id)) fail(404, `no shot "${t.id}" in the storyboard (storyboard_get)`);
  if (t.kind === 'scene' && !scenes().some(s => s.id === t.id)) fail(404, `no scene "${t.id}" in the current script`);
  return t;
}

// ------------------------------------------------------------------ writes (the aliases in the other domains use these)
// a note (or a reply, with reply_to) written through the agent surface (via "agent") or a page act (via "page")
export function addNote(p, { target, text, to, ask, gaps, about, marker, version, reply_to, by = 'agent', via = 'agent' } = {}) {
  try { N.cleanText(text); } catch (e) { code(e); }
  by = String(by || 'agent').slice(0, 60);
  if (reply_to) return replyNote(p, reply_to, text, { by, via });
  const t = checkTarget(p, target);
  return mutateNotes(p, (d) => { const n = N.makeNote(d, { target: t, text, by, via, to, ask, gaps, version, about, marker }); d.notes.push(n); return n; });
}
export function replyNote(p, id, text, { by = 'agent', via = 'agent' } = {}) {
  try { N.cleanText(text); } catch (e) { code(e); }
  return mutateNotes(p, (d) => {
    const n = N.findNote(d, id); if (!n) fail(404, `no note "${id}" (notes_get lists them)`);
    const r = N.makeReply(n, { text, by: String(by || 'agent').slice(0, 60), via }); (n.replies ||= []).push(r);
    return { note: { ...n }, reply: r };
  });
}
// status open | absorbed | dismissed; the agent surface may not dismiss (or reopen a dismissed) note of the director's
export function setStatus(p, id, status, { reply, by = 'agent', via = 'agent' } = {}) {
  if (!N.STATUSES.includes(status)) fail(400, `status: one of ${N.STATUSES.join(', ')}`);
  if (reply != null) { try { N.cleanText(reply); } catch (e) { code(e); } }
  return mutateNotes(p, (d) => {
    const n = N.findNote(d, id); if (!n) fail(404, `no note "${id}" (notes_get lists them)`);
    if (via !== 'page' && n.via !== 'agent') {
      if (status === 'dismissed') fail(403, `only the director dismisses their own notes (in the page). Answer ${n.id} with a reply, or mark it absorbed once you did what it asks`);
      if (status === 'open' && n.status === 'dismissed') fail(403, `the director dismissed ${n.id}: only they reopen it`);
    }
    const r = reply ? N.makeReply(n, { text: reply, by: String(by || 'agent').slice(0, 60), via }) : null;
    if (r) (n.replies ||= []).push(r);
    n.status = status;
    if (status === 'open') { delete n.closed_by; delete n.closed_via; delete n.closed_at; }
    else Object.assign(n, { closed_by: String(by || via).slice(0, 60), closed_via: via, closed_at: nowIso() });
    return { note: { ...n }, ...(r ? { reply: r } : {}) };
  });
}

// ------------------------------------------------------------------ reads
// the notes of a stage in the old shape of its store (lyrics_get, script_get, ... keep answering as before)
export function stageNotes(p, stage, store, { status = 'all', nodeTree } = {}) {
  return N.notesOn(notesDoc(p), { stage }).map(n => N.legacyView(n, store, { nodeTree })).filter(n => status === 'all' || n.status === status);
}
export const stageAsks = (p, stage) => N.openAsks(notesDoc(p), stage);
function timeCtx(p) {
  let scenes = [], shots = []; try { scenes = SC.currentScript(scenesDoc(p))?.scenes || []; } catch (e) { /* no script */ }
  try { shots = SB.boardShots(boardDoc(p)); } catch (e) { /* no board */ }
  return { song: read(p, 'song.json'), scenes, shots };
}
export function noteView(n, ctx) { const t = N.noteTime(n, ctx); return { ...n, where: `${n.target.stage}: ${N.targetLabel(n.target)}`, ...(t != null ? { t, time: tc(t) } : {}) }; }
// every note with a song time in [a, b] (timeline_query, shot_get)
export function notesInTime(p, a, b) { const ctx = timeCtx(p); return notesDoc(p).notes.map(n => noteView(n, ctx)).filter(n => n.t != null && n.t >= a && n.t <= b && n.status !== 'dismissed'); }
export function notesCounts(p) { const d = notesDoc(p); return { round: d.round || 1, ...N.openCounts(d) }; }

Object.assign(ops, {
  // ---------------- the one notes model
  notes_get(p, { stage, kind, id, note, status = 'open', to, by, round } = {}) {
    if (stage != null && !N.STAGES.includes(stage)) fail(400, `stage: one of ${N.STAGES.join(', ')}`);
    if (status != null && status !== 'all' && !N.STATUSES.includes(status)) fail(400, `status: ${N.STATUSES.join(', ')} or all`);
    const d = notesDoc(p), ctx = timeCtx(p);
    if (note) { const n = N.findNote(d, note); if (!n) fail(404, `no note "${note}"`); return { round: d.round || 1, notes: [noteView(n, ctx)] }; }
    const list = d.notes.filter(n => (!stage || n.target.stage === stage) && (!kind || n.target.kind === kind) && (id == null || n.target.id === id)
      && (status === 'all' || n.status === status) && (!to || n.to === to) && (!by || n.by === by || n.via === by) && (round == null || n.round === Number(round)));
    return { round: d.round || 1, open: N.openCounts(d), notes: list.map(n => noteView(n, ctx)),
      rules: 'open notes by the director (via page) are your to-do list; answer with notes_add reply_to, mark one absorbed with notes_status when you did what it asks (with a reply saying what changed); only the director dismisses their notes' };
  },
  notes_add(p, { target, text, to, ask, reply_to, by = 'agent' } = {}) {
    if (!reply_to && !target) fail(400, 'target {stage, kind, id, w?, t?, pin?} or reply_to required');
    if (target && typeof target === 'object' && target.t != null) target = { ...target, t: ms(target.t, 'target.t') };
    const r = addNote(p, { target, text, to, ask, reply_to, by, via: 'agent' });
    return r.reply ? { note: r.note.id, reply: r.reply } : noteView(r, timeCtx(p));
  },
  notes_status(p, { id, status, reply, by = 'agent' } = {}) {
    const r = setStatus(p, id, status, { reply, by, via: 'agent' });
    return { note: noteView(r.note, timeCtx(p)), ...(r.reply ? { reply: r.reply.id } : {}) };
  },
  // ---------------- the old timeline tools (notes.json v1 shapes; v2 underneath)
  notes_list(p, { status, t0, t1, by } = {}) {
    const a = ms(t0) ?? -Infinity, b = ms(t1) ?? Infinity, out = [];
    for (const n of N.notesOn(notesDoc(p), { stage: 'timeline' })) {
      const v = N.legacyView(n, 'notes');
      const rows = [{ ...v, time: tc(v.t) }, ...(n.replies || []).map(r => ({ id: r.id, t: v.t, time: tc(v.t), line_id: v.line_id, by: r.by, via: r.via, text: r.text, status: v.status === 'open' ? 'open' : 'resolved', at: r.at, reply_to: n.id }))];
      for (const x of rows) if ((!status || x.status === status) && (!by || x.by === by) && x.t >= a && x.t <= b) out.push(x);
    }
    return out.sort((x, y) => x.t - y.t);
  },
  note_add(p, { t, text, line_id, about, by = 'agent', reply_to }) {
    if (!text) fail(400, 'text required');
    if (reply_to) { const r = replyNote(p, reply_to, String(text), { by }); return { id: r.reply.id, reply_to: r.note.id, text: r.reply.text, by: r.reply.by, via: 'agent' }; }
    const tm = ms(t, 't'); if (tm == null) fail(400, 't required (ms or m:ss.mmm)');
    let line = line_id;
    if (!line) { const L = read(p, 'song.json').lines.filter(l => l.t0 <= tm).pop(); line = L && tm <= L.t1 + 2000 ? L.id : null; }
    const n = addNote(p, { target: { stage: 'timeline', kind: 'time', t: tm, ...(line ? { line } : {}) }, text: String(text), about, by });
    return { ...N.legacyView(n, 'notes'), time: tc(tm) };
  },
  note_resolve(p, { id, reply, by = 'agent', reopen = false }) {
    const r = setStatus(p, id, reopen ? 'open' : 'absorbed', { reply, by });
    return { note: N.legacyView(r.note, 'notes'), ...(r.reply ? { reply: r.reply.id } : {}) };
  },
});
