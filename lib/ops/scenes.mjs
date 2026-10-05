// Stage 2: the script (scenes.json: versions, scene statuses, notes, intake) and the sketch files (sketches/, private/sketches/).
import fs from 'node:fs';
import path from 'node:path';
import * as F from '../../js/flow.js';
import * as SC from '../../js/scenes.js';
import { fail, isFlaggedPrivate, isPrivate, ms, nowIso, ops, projDir, read, readJSON, write, writeAtomic, writeJSON } from './_shared.mjs';
import { costSummary } from './requests.mjs';
import { addNote, replyNote, setStatus, stageAsks, stageNotes } from './notes.mjs';
import { legacyView } from '../../js/notes.js';
import { eventsList } from '../../js/events.js';

// ------------------------------------------------------------------ stage 2: the script draft (scenes.json) and sketches
// Formats and the shared logic live in js/scenes.js. Rules: every scenes_update is a NEW version (nothing is
// overwritten; restore copies an old one); a scene's status "ok" is the director's (page only); intake answers and
// notes written here are stamped via "agent". Sketches are files: sketches/<id>.json (vector strokes, pins, metadata),
// <id>.png (flattened) and <id>.mask.png (the edit mask, when there is one), registered in media.json as kind
// "sketch"; a sketch drawn over a PRIVATE underlay is stored under private/sketches/ instead (local only, never exported).
export function scenesDoc(p) { return SC.normScenes(readJSON(path.join(projDir(p), 'scenes.json'), null, true), read(p, 'song.json'), read(p, 'script.json')); }
function mutateScenes(p, fn) {
  const d = scenesDoc(p); const r = fn(d); delete d.derived;
  try { SC.checkScenes(d); } catch (e) { fail(400, e.message); }
  d.rev = (d.rev || 0) + 1; write(p, 'scenes.json', d); return r === undefined ? d : r;
}
const SKETCH_DIRS = ['sketches', 'private/sketches'];
export const sketchId = (id) => { if (typeof id !== 'string' || !SC.SKETCH_ID.test(id)) fail(400, 'sketch id: 1-64 lower-case letters, digits, _ and - (starting with a letter or digit)'); return id; };
// where a sketch's files are now: {dir, json, png, mask} (relative to the project) or null
export function sketchFiles(p, id) {
  const pd = projDir(p);
  for (const dir of SKETCH_DIRS) if (fs.existsSync(path.join(pd, dir, `${id}.json`))) return { dir, json: `${dir}/${id}.json`, png: `${dir}/${id}.png`, mask: fs.existsSync(path.join(pd, dir, `${id}.mask.png`)) ? `${dir}/${id}.mask.png` : null };
  return null;
}
// base64 (or a data: URL) -> a PNG buffer, checked by its signature and IHDR chunk
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngBytes(v, name) {
  if (typeof v !== 'string' || !v) fail(400, `${name}: a base64 PNG (or a data:image/png;base64 URL) is required`);
  const b64 = v.replace(/^data:image\/png;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) fail(400, `${name}: not base64`);
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') fail(400, `${name}: not a PNG file (bad signature)`);
  if (buf.length > 20e6) fail(413, `${name}: over 20 MB`);
  return { buf, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
// the sketch JSON as stored: the fields the tool writes, checked; nothing else
function cleanSketch(s, id) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail(400, 'sketch: the sketch JSON object (core/sketch/sketch.js format) is required');
  const w = Math.round(Number(s.w)), h = Math.round(Number(s.h));
  if (!(w >= 1 && w <= 8192 && h >= 1 && h <= 8192)) fail(400, 'sketch: w and h are 1-8192 px');
  for (const k of ['strokes', 'mask', 'pins']) if (s[k] != null && !Array.isArray(s[k])) fail(400, `sketch.${k} must be a list`);
  const pins = (s.pins || []).map((x, i) => {
    if (!x || typeof x !== 'object' || !Number.isFinite(Number(x.x)) || !Number.isFinite(Number(x.y))) fail(400, `sketch.pins[${i}]: {n, x, y, text}`);
    return { n: Math.round(Number(x.n)) || i + 1, x: Number(x.x), y: Number(x.y), text: String(x.text ?? '').slice(0, 4000) };
  });
  const ul = s.underlay && typeof s.underlay === 'object' && typeof s.underlay.src === 'string' && s.underlay.src
    ? { src: s.underlay.src.slice(0, 2000), opacity: Math.max(0, Math.min(1, Number(s.underlay.opacity ?? 1))), fit: ['contain', 'cover', 'stretch'].includes(s.underlay.fit) ? s.underlay.fit : 'contain' } : null;
  return { id, w, h, paper: typeof s.paper === 'string' ? s.paper.slice(0, 32) : null, underlay: ul, strokes: s.strokes || [], mask: s.mask || [], pins,
    ...(typeof s.title === 'string' ? { title: s.title.slice(0, 300) } : {}), created: typeof s.created === 'string' ? s.created.slice(0, 19) : nowIso() };
}
export const sketchUse = (p) => { const v = SC.currentScript(scenesDoc(p)), m = new Map(); for (const s of v?.scenes || []) for (const k of s.sketches) (m.get(k) || m.set(k, []).get(k)).push(s.id); return m; };
export function sketchView(p, id, { full = false, uses } = {}) {
  const f = sketchFiles(p, id); if (!f) fail(404, `no sketch "${id}" (sketch_list lists them)`);
  const pd = projDir(p), s = readJSON(path.join(pd, f.json), {}, true) || {};
  const abs = (r) => r ? path.join(pd, r) : null;
  return { id, w: s.w, h: s.h, title: s.title || null, png: f.png, mask_png: f.mask, json: f.json, files: { png: abs(f.png), mask: abs(f.mask), json: abs(f.json) },
    url: `/data/${p}/${f.png}`, private: f.dir !== 'sketches', underlay: s.underlay || null, pins: s.pins || [], strokes: (s.strokes || []).length, mask_strokes: (s.mask || []).length,
    scenes: (uses || sketchUse(p)).get(id) || [], updated: s.updated || null, by: s.by || null, via: s.via || null, ...(full ? { sketch: s } : {}) };
}
function scenesView(p, v, doc) {
  const song = read(p, 'song.json'), L = new Map(song.lines.map(l => [l.id, l])), uses = sketchUse(p);
  const notes = stageNotes(p, 'script', 'scenes', { status: 'open' });
  return (v?.scenes || []).map(s => ({ ...s, time: SC.span(s.t0, s.t1), status: SC.sceneStatus(doc, s.id),
    lines: s.line_ids.map(id => L.get(id)).filter(Boolean).map(l => ({ id: l.id, t0: l.t0, t1: l.t1, text: l.text })),
    sketches: s.sketches.map(k => { try { const x = sketchView(p, k, { uses }); return { id: k, png: x.png, files: x.files, pins: x.pins, private: x.private }; } catch (e) { return { id: k, missing: true }; } }),
    open_notes: notes.filter(n => n.scene === s.id).length }));
}
function sceneNoteView(n, v) { const s = (v?.scenes || []).find(x => x.id === n.scene); return { ...n, scene_title: s?.title ?? null, ...(s || !n.scene ? {} : { detached: 'the scene is not in the current version' }) }; }

Object.assign(ops, {
  script_get(p, { version, diff, notes = 'open' } = {}) {
    const doc = scenesDoc(p);
    if (diff) {
      if (!Array.isArray(diff) || diff.length !== 2) fail(400, 'diff: [older version id, newer version id]');
      const [a, b] = diff.map(x => doc.versions.find(v => v.id === x)); if (!a || !b) fail(404, `no such version: ${diff.join(', ')}`);
      const d = F.wordDiff(SC.scriptText(a), SC.scriptText(b));
      const show = d.map(o => o.w === '\n' ? (o.op === '-' ? '' : '\n') : o.op === '=' ? o.w : o.op === '-' ? `[-${o.w}-]` : `{+${o.w}+}`).join(' ').replace(/ ?\n ?/g, '\n');
      return { a: a.id, b: b.id, ...F.diffStats(d), scenes: SC.sceneChanges(a, b), diff: show };
    }
    const v = version ? doc.versions.find(x => x.id === version) : SC.currentScript(doc);
    if (version && !v) fail(404, `no version "${version}" (script_get lists the versions)`);
    const song = read(p, 'song.json'), g = SC.gaps(v?.scenes || [], song.duration_ms);
    const ns = stageNotes(p, 'script', 'scenes', { status: notes });
    return { current: doc.current, derived: !!doc.derived, version: v ? { id: v.id, created: v.created, by: v.by, via: v.via, message: v.message, from: v.from } : null,
      duration_ms: song.duration_ms, coverage: +SC.coverage(v?.scenes || [], song.duration_ms).toFixed(3),
      gaps: g.map(([a, b]) => ({ t0: a, t1: b, time: SC.span(a, b), lines: SC.linesIn(song, a, b).map(l => ({ id: l.id, text: l.text })) })),
      scenes: scenesView(p, v, doc),
      intake: { unanswered: SC.intakeOpen(doc), answered: SC.INTAKE.length - SC.intakeOpen(doc).length, of: SC.INTAKE.length, note: 'intake_get for the questions and answers' },
      notes: ns.map(n => sceneNoteView(n, v)),
      asks_for_agent: stageAsks(p, 'script').map(n => legacyView(n, 'scenes')).map(n => ({ id: n.id, scene: n.scene, kind: n.kind || 'request', text: n.text, ...(n.gaps ? { gaps: n.gaps } : {}), replies: n.replies?.length || 0 })),
      versions: doc.versions.map(x => ({ id: x.id, created: x.created, by: x.by, via: x.via, message: x.message, from: x.from, scenes: x.scenes.length, current: x.id === doc.current })),
      legacy_script_lines: (read(p, 'script.json').lines || []).length,
      rules: 'scenes_update writes a NEW version (never destructive); status ok is the director\'s (page); fill the gaps = add scenes covering the gaps listed here' };
  },
  // a new version of the whole script: scenes = the full list; or upsert (merge by id, a scene without id is new) and
  // remove (ids); or restore = an old version id. status sets per-scene statuses (draft / needs_you; ok is the
  // director's). snap ("lines" | "bars" | "sections" | "events") snaps t0 / t1 of the scenes written; anchors {t0?, t1?: event id}
  // tie a boundary to a named event (it takes the event's time; snap "events" anchors the edges it snaps; E1).
  scenes_update(p, { scenes, upsert, remove, restore, status, snap, message = '', by = 'agent' } = {}) {
    const modes = [scenes != null, upsert != null || remove != null, restore != null].filter(Boolean).length;
    if (modes > 1 || (!modes && status == null)) fail(400, 'give one of scenes (the full list), upsert / remove, or restore; or only status');
    if (snap != null && !SC.SNAPS.includes(snap)) fail(400, `snap: one of ${SC.SNAPS.join(', ')}`);
    if (status != null) {
      if (typeof status !== 'object' || Array.isArray(status)) fail(400, 'status: {<scene id>: "draft" | "needs_you"}');
      for (const [k, v] of Object.entries(status)) {
        if (v === 'ok') fail(403, `only the director marks a scene ok, in the page; set "needs_you" and say why in a scene note (${k})`);
        if (!SC.SCENE_STATUSES.includes(v)) fail(400, `status of ${k}: draft or needs_you`);
      }
    }
    const song = read(p, 'song.json'), events = eventsList(read(p, 'events.json')), anchorWarn = [];   // E1: anchors follow the named events
    let r = {};
    mutateScenes(p, (d) => {
      const prev = SC.currentScript(d);
      let body = null;
      if (restore != null) { const old = d.versions.find(v => v.id === restore); if (!old) fail(404, `no version "${restore}"`); body = structuredClone(old.scenes); }
      else if (scenes != null || upsert != null || remove != null) {
        if (scenes != null && !Array.isArray(scenes)) fail(400, 'scenes: [{id?, t0, t1, title, text, beats: [{t, text}], sketches: [ids]}]');
        if (upsert != null && !Array.isArray(upsert)) fail(400, 'upsert: a list of scenes (partial: only the fields to change; no id = a new scene)');
        if (remove != null && (!Array.isArray(remove) || remove.some(x => typeof x !== 'string'))) fail(400, 'remove: a list of scene ids');
        const base = scenes != null ? [] : structuredClone(prev?.scenes || []), draft = [...base];
        const byId = new Map(base.map(s => [s.id, s]));
        for (const id of remove || []) { if (!byId.has(id)) fail(404, `no scene "${id}" in the current version`); draft.splice(draft.indexOf(byId.get(id)), 1); byId.delete(id); }
        for (const x of scenes || upsert || []) {
          if (!x || typeof x !== 'object') fail(400, 'every scene is an object');
          for (const k of ['t0', 't1']) if (x[k] != null) x[k] = ms(x[k], k);   // ms or "m:ss.mmm"
          if (Array.isArray(x.beats)) x.beats = x.beats.map(b => (b && typeof b === 'object' && b.t != null ? { ...b, t: ms(b.t, 'beat t') } : b));
          const old = x.id != null ? byId.get(String(x.id)) : null;
          if (upsert && x.id != null && !old) fail(404, `no scene "${x.id}" to update (leave id out for a new scene)`);
          const id = old?.id ?? (x.id != null ? String(x.id) : SC.nextSceneId(d, draft));
          if (!old && byId.has(id)) fail(400, `duplicate scene id "${id}"`);
          let c; try { c = SC.cleanScene({ ...(old || { title: '', text: '', beats: [], sketches: [] }), ...x, id }, song, { snap, events, warnings: anchorWarn }); } catch (e) { fail(400, e.message); }
          if (old) draft[draft.indexOf(old)] = c; else draft.push(c);
          byId.set(id, c);
        }
        body = draft.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
      }
      if (body) {
        if (prev && SC.sameScenes(prev.scenes, body)) r = { version: prev.id, unchanged: true };
        else { const v = SC.addScriptVersion(d, body, { by, via: 'agent', message: restore ? (message || `restore ${restore}`) : message, ...(restore ? { from: restore } : {}) }); r = { version: v.id, scenes: v.scenes.length }; }
      }
      for (const [k, v] of Object.entries(status || {})) d.states[k] = { status: v, by, via: 'agent', at: nowIso() };
      if (status) r.status = status;
      const cur = SC.currentScript(d), warnings = [...anchorWarn];
      const sorted = [...(cur?.scenes || [])].sort((a, b) => a.t0 - b.t0);
      for (let i = 1; i < sorted.length; i++) if (sorted[i].t0 < sorted[i - 1].t1) warnings.push(`${sorted[i - 1].id} and ${sorted[i].id} overlap (${SC.span(sorted[i].t0, Math.min(sorted[i].t1, sorted[i - 1].t1))})`);
      for (const s of cur?.scenes || []) for (const k of s.sketches) if (!sketchFiles(p, k)) warnings.push(`${s.id}: sketch "${k}" has no files yet (sketch_save)`);
      for (const k of Object.keys(status || {})) if (!cur?.scenes.some(s => s.id === k)) warnings.push(`status for "${k}": no such scene in the current version`);
      r.gaps = SC.gaps(cur?.scenes || [], song.duration_ms).map(([a, b]) => SC.span(a, b));
      if (warnings.length) r.warnings = warnings;
    });
    return r;
  },
  // a note on a scene (or a beat of it), with no scene for the whole script, a reply in a thread (reply_to), or an ask
  // for the agent (to "agent"): written to notes.json v2 (target {stage: "script", kind: scene | beat, id}), old shape back
  scene_note_add(p, { scene, beat, text, reply_to, to, by = 'agent' } = {}) {
    if (!text || typeof text !== 'string') fail(400, 'text required');
    if (reply_to) { const r = replyNote(p, reply_to, text, { by }); return { note: r.note.id, reply: r.reply }; }
    const d = scenesDoc(p), v = SC.currentScript(d), S = scene ? v?.scenes.find(x => x.id === scene) : null;
    if (scene && !S) fail(404, `no scene "${scene}" in the current version (script_get lists them)`);
    if (beat && !S?.beats.some(b => b.id === beat)) fail(404, `no beat "${beat}" in scene ${scene}`);
    const target = S ? (beat ? { stage: 'script', kind: 'beat', id: `${scene}/${beat}` } : { stage: 'script', kind: 'scene', id: scene }) : { stage: 'script', kind: 'stage' };
    return sceneNoteView(legacyView(addNote(p, { target, text, to, version: d.current, by }), 'scenes'), v);
  },
  scene_note_resolve(p, { id, reply, reopen = false, by = 'agent' } = {}) {
    return legacyView(setStatus(p, id, reopen ? 'open' : 'absorbed', { reply, by }).note, 'scenes');
  },
  intake_get(p) {
    const doc = scenesDoc(p);
    return { questions: SC.INTAKE.map(q => { const a = doc.intake[q.id] || {}; return { id: q.id, q: q.q, hint: q.hint, answer: a.text || null, by: a.by || null, via: a.via || null, at: a.at || null, asked_in_chat: a.asked || null }; }),
      unanswered: SC.intakeOpen(doc), costs: costSummary(p),
      rules: 'answer with intake_answer only with the director\'s own words (by "director" when you relay them) or mark a question asked_in_chat when you asked it in the conversation' };
  },
  // answers: {<question id>: text} (several at once), or key + text; asked_in_chat: true marks key (or every key in
  // answers) as asked in a chat
  intake_answer(p, { key, text, answers, asked_in_chat, by = 'agent' } = {}) {
    const all = { ...(answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {}), ...(key != null ? { [key]: text } : {}) };
    const keys = Object.keys(all);
    if (!keys.length) fail(400, `give key (+ text) or answers {<id>: text}; ids: ${SC.INTAKE.map(q => q.id).join(', ')}`);
    for (const k of keys) if (!SC.INTAKE.some(q => q.id === k)) fail(400, `no intake question "${k}" (ids: ${SC.INTAKE.map(q => q.id).join(', ')})`);
    return mutateScenes(p, (d) => {
      for (const k of keys) {
        const a = { ...(d.intake[k] || {}) }, t = all[k];
        if (t != null) { if (typeof t !== 'string' || t.length > 8000) fail(400, `${k}: text up to 8000 characters`); Object.assign(a, { text: t, by, via: 'agent', at: nowIso() }); }
        if (asked_in_chat) a.asked = { by, via: 'agent', at: nowIso() };
        d.intake[k] = a;
      }
      return { updated: keys, unanswered: SC.intakeOpen(d) };
    });
  },
  // the sketch tool's save: {id, sketch (JSON), png (base64), mask (base64) | null, links?: {scenes, entities, shots}}.
  // via: serve.mjs sets it ("page" for a same-origin browser request, else "agent"); provenance only, not a permission
  sketch_save(p, { id, sketch, png, mask = null, links, label, private: priv, via = 'agent', by } = {}) {
    sketchId(id);
    const s = cleanSketch(sketch, id), img = pngBytes(png, 'png'), mk = mask == null ? null : pngBytes(mask, 'mask');
    if (links != null && (typeof links !== 'object' || Array.isArray(links))) fail(400, 'links: {scenes?: [], entities?: [], shots?: []}');
    const pd = projDir(p), ul = s.underlay?.src || '';
    const isPriv = priv === true || (!!ul && (isPrivate(ul) || isFlaggedPrivate(ul, [p])));
    const dir = isPriv ? 'private/sketches' : 'sketches', prevF = sketchFiles(p, id);
    const out = { json: `${dir}/${id}.json`, png: `${dir}/${id}.png`, mask: mk ? `${dir}/${id}.mask.png` : null };
    const old = prevF ? readJSON(path.join(pd, prevF.json), {}) || {} : {};
    const stored = { ...s, created: old.created || s.created, updated: nowIso(), via: via === 'page' ? 'page' : 'agent', by: via === 'page' ? 'director' : String(by || 'agent').slice(0, 60) };
    writeAtomic(path.join(pd, out.png), img.buf);
    if (mk) writeAtomic(path.join(pd, out.mask), mk.buf); else fs.rmSync(path.join(pd, dir, `${id}.mask.png`), { force: true });
    writeJSON(path.join(pd, out.json), stored);
    if (prevF && prevF.dir !== dir) for (const f of [prevF.json, prevF.png, prevF.mask]) if (f) fs.rmSync(path.join(pd, f), { force: true });   // moved in or out of private/
    // media.json: one item per sketch (the flattened PNG), kind "sketch", with its links
    const doc = read(p, 'media.json'); doc.items ||= [];
    const mid = `sketch-${id}`, i = doc.items.findIndex(m => m.id === mid || m.path === prevF?.png || m.path === out.png);
    const was = i >= 0 ? doc.items[i] : {}, un = (k) => [...new Set([...(was[k] || []), ...((links || {})[k] || []).map(String)])].sort();
    const m = { ...was, id: mid, path: out.png, kind: 'sketch', label: String(label || stored.title || was.label || `sketch ${id}`).slice(0, 300), sketch: out.json, mask: out.mask, entities: un('entities'), shots: un('shots'), uses: was.uses || [], scenes: un('scenes'),
      size: img.buf.length, w: img.w, h: img.h, duration_ms: null, private: isPriv, status: isPriv ? 'private' : (was.status && was.status !== 'private' ? was.status : 'unused'), pins: stored.pins.length,
      thumb: isPriv ? null : out.png, added: was.added || nowIso(), updated: stored.updated, via: stored.via };
    if (i >= 0) doc.items[i] = m; else doc.items.push(m);
    doc.count = doc.items.length; doc.by_kind = doc.items.reduce((o, x) => (o[x.kind] = (o[x.kind] || 0) + 1, o), {});
    write(p, 'media.json', doc);
    return { id, ...out, private: isPriv, w: img.w, h: img.h, pins: stored.pins.length, media: mid, updated: stored.updated };
  },
  sketch_get(p, { id, full = false } = {}) { sketchId(id); return sketchView(p, id, { full }); },
  sketch_list(p, { scene } = {}) {
    const pd = projDir(p), uses = sketchUse(p), ids = new Set();
    for (const dir of SKETCH_DIRS) { try { for (const f of fs.readdirSync(path.join(pd, dir))) { const m = /^([a-z0-9][a-z0-9_-]{0,63})\.json$/.exec(f); if (m) ids.add(m[1]); } } catch (e) { /* no folder yet */ } }
    return [...ids].map(id => { const v = sketchView(p, id, { uses }); delete v.underlay; return v; }).filter(v => !scene || v.scenes.includes(scene)).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  },
});
