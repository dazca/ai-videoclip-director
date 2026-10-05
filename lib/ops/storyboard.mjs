// Stage 6: the storyboard (storyboard.json: versions, shots tiled on the scenes, notes, the gaps) and the importer's
// shots / clip uses in shots.json (shots_list, shot_get, shot_update).
import path from 'node:path';
import * as F from '../../js/flow.js';
import * as SC from '../../js/scenes.js';
import * as A from '../../js/assets.js';
import * as SB from '../../js/storyboard.js';
import { DEFAULTS, DIRECTOR_STATES, directorGate, fail, ms, mutate, nowIso, ops, overlaps, projDir, read, readJSON, shotsDoc, stateOf, tc, write } from './_shared.mjs';
import { costSummary } from './requests.mjs';
import { startStage } from './lyrics.mjs';
import { scenesDoc, sketchFiles } from './scenes.mjs';
import { breakdownDoc } from './breakdown.mjs';
import { refFile, sketchInfo } from './assets.mjs';
import { addNote, notesDoc, notesInTime, replyNote, setStatus, stageAsks, stageNotes } from './notes.mjs';
import { legacyView } from '../../js/notes.js';

Object.assign(ops, {
  // ---------------- shots and clip uses
  shots_list(p, { section, state, t0, t1 } = {}) {
    const sh = shotsDoc(p), A = read(p, 'approvals.json'); const a = ms(t0) ?? -Infinity, b = ms(t1) ?? Infinity;
    return sh.shots.filter(x => (!section || x.section === section) && overlaps(x.t0, x.t1, a, b)).map(x => ({ id: x.id, t0: x.t0, t1: x.t1, time: `${tc(x.t0)}–${tc(x.t1)}`, section: x.section, kind: x.kind, title: x.title, cast: x.cast, locations: x.locations, clips: x.clips, state: stateOf(A, 'shot:' + x.id) }))
      .filter(x => !state || x.state === state);
  },
  shot_get(p, { id }) {
    const sh = shotsDoc(p), A = read(p, 'approvals.json');
    const shot = sh.shots.find(x => x.id === id), use = sh.uses.find(u => u.id === id);
    if (!shot && !use) fail(404, `no shot or clip use "${id}" (shots_list lists them; clip-use ids look like G05@20158)`);
    const t0 = (shot || use).t0, t1 = (shot || use).t1, key = shot ? 'shot:' + id : 'use:' + id;
    const media = read(p, 'media.json').items || [];
    const uses = shot ? sh.uses.filter(u => shot.clips?.includes(u.id)) : [use];
    return { kind: shot ? 'shot' : 'use', ...(shot || use), key, state: A.items?.[key] || { state: 'draft' },
      uses: uses.map(u => ({ ...u, state: stateOf(A, 'use:' + u.id), takes: media.filter(m => m.kind === 'clip' && m.job === u.clip).map(m => ({ take: m.take, path: m.path })) })),
      notes: [...new Map([...notesDoc(p).notes.filter(n => n.about === key || (n.target.kind === 'shot' && n.target.id === id)), ...notesInTime(p, t0, t1 - 1)].map(n => [n.id, n])).values()],
      requests: (read(p, 'requests.json').items || []).filter(r => r.target === key || uses.some(u => r.target === 'use:' + u.id)),
      media: media.filter(m => (shot && m.shots?.includes(id)) || (use && m.uses?.includes(id))).map(m => ({ id: m.id, path: m.path, kind: m.kind, label: m.label })).slice(0, 40) };
  },
  // status -> approvals.json; note -> notes.json; take / in_ms / file (clip uses) and title (shots) -> shots.json
  shot_update(p, { id, status, comment, take, in_ms, file, title, note, by = 'agent' }) {
    const sh = shotsDoc(p);
    if (status && DIRECTOR_STATES.includes(status)) directorGate();   // before any write: 403, the page's
    const shot = sh.shots.find(x => x.id === id), use = sh.uses.find(u => u.id === id);
    if (!shot && !use) fail(404, `no shot or clip use "${id}"`);
    const key = shot ? 'shot:' + id : 'use:' + id, changed = [];
    if (take != null || in_ms != null || file) {
      if (!use) fail(400, 'take / in_ms / file belong to a clip use (ids like G05@20158): call shot_get on the shot to list its uses');
      if (take != null) {
        const m = (read(p, 'media.json').items || []).find(x => x.kind === 'clip' && x.job === use.clip && x.take === Number(take));
        const f = file || m?.path || (use.file && use.file.replace(/_(\d+)(\.\w+)$/, `_${Number(take)}$2`));
        if (!f) fail(400, 'cannot find the file of that take: pass file');
        use.take = Number(take); use.file = f; changed.push('take', 'file');
      } else if (file) { use.file = file; changed.push('file'); }
      if (in_ms != null) { use.in_ms = ms(in_ms, 'in_ms'); changed.push('in_ms'); }
    }
    if (title != null) { if (!shot) fail(400, 'title belongs to a shot'); shot.title = String(title); changed.push('title'); }
    if (changed.length) write(p, 'shots.json', sh);
    if (status) {
      const states = read(p, 'approvals.json').states || DEFAULTS['approvals.json'].states;
      if (!states.includes(status)) fail(400, `status must be one of ${states.join(', ')}`);
      mutate(p, 'approvals.json', (d) => { d.items[key] = { ...(d.items[key] || {}), state: status, by, via: 'agent', at: nowIso(), ...(comment ? { comment } : {}) }; });
      changed.push('status');
    }
    let added = null;
    if (note) added = ops.note_add(p, { t: (shot || use).t0, text: note, about: key, by });
    return { id, key, changed, ...(added ? { note: added.id } : {}), ...(shot ? { shot } : { use }) };
  },
});

// ------------------------------------------------------------------ stage 6: the storyboard (storyboard.json) and the gaps
// Formats and the shared logic live in js/storyboard.js. Rules: every shots_update is a NEW version (nothing is
// overwritten; restore copies an old one); the shots of a scene tile it (shots_update re-tiles unless tile:false); a
// shot's approval is approvals.json "shot:<id>": an agent may set draft / review / changes, never approved or locked
// (the director approves a shot in the page). A project without storyboard.json reads its shots from shots.json (never
// rewritten). Nothing here generates or spends: gaps_get drafts the requests an agent proposes with request_create.
export function boardDoc(p) { return SB.normBoard(readJSON(path.join(projDir(p), 'storyboard.json'), null, true), read(p, 'shots.json'), scenesDoc(p)); }
function mutateBoard(p, fn) {
  const d = boardDoc(p); const r = fn(d); delete d.derived;
  try { SB.checkBoard(d); } catch (e) { fail(400, e.message); }
  d.rev = (d.rev || 0) + 1; write(p, 'storyboard.json', d); return r === undefined ? d : r;
}
const entitiesAll = (p) => read(p, 'entities/index.json').map(e => { const x = readJSON(path.join(projDir(p), e.path), null); return x && typeof x === 'object' ? { ...x, id: e.id, kind: e.kind } : null; }).filter(Boolean);
const SHOT_DIRECTOR = 'only the director approves or locks a shot, in the page (Storyboard stage, or the timeline status chips); set "review" and say why in a note (shot_note_add); show it with ui_focus view "stage"';
function boardCtx(p) {
  const sdoc = scenesDoc(p), scenes = SC.currentScript(sdoc)?.scenes || [];
  return { song: read(p, 'song.json'), sdoc, scenes, ents: entitiesAll(p), approvals: read(p, 'approvals.json'), requests: read(p, 'requests.json'), bd: breakdownDoc(p) };
}
function shotView(p, s, c) {
  const assets = SB.shotAssets(s, c.ents, c.approvals).map(a => ({ ...a, file: a.image ? refFile(p, a.image) : null }));
  const sk = s.sketch ? sketchInfo(p, s.sketch) : null, reqs = SB.shotRequests(c.requests, s.id);
  const still = reqs.find(r => r.kind === 'shot-still' && r.status === 'done' && r.outputs?.length)?.outputs[0] || null;
  return { ...s, time: SC.span(s.t0, s.t1), bars: SB.bars(c.song, s.t0, s.t1), status: stateOf(c.approvals, 'shot:' + s.id),
    frame: sk ? (sk.missing ? { sketch: s.sketch, missing: true } : { sketch: sk.id, png: sk.png, file: sk.files?.png || null, pins: sk.pins, private: sk.private }) : s.thumb ? { thumb: s.thumb, file: refFile(p, s.thumb) } : null,
    assets, requests: reqs.map(r => ({ id: r.id, kind: r.kind, status: r.status, est_cost: r.est_cost, tool: r.tool || null, outputs: r.outputs || [] })), estimate: SB.shotEstimate(s, { haveStill: !!still }) };
}
const boardNoteView = (n, v) => { const s = (v?.shots || []).find(x => x.id === n.shot); return { ...n, ...(n.shot && !s ? { detached: 'the shot is not in the current version' } : {}) }; };
Object.assign(ops, {
  // the storyboard: the script's scenes in song time, each with its shots (time, kind, text, camera, frame sketch with
  // image paths + pins, the assets with the variant each needs and whether it is approved, status, requests, estimate)
  storyboard_get(p, { version, diff, scene, notes = 'open' } = {}) {
    const doc = boardDoc(p);
    if (diff) {
      if (!Array.isArray(diff) || diff.length !== 2) fail(400, 'diff: [older version id, newer version id]');
      const [a, b] = diff.map(x => doc.versions.find(v => v.id === x)); if (!a || !b) fail(404, `no such version: ${diff.join(', ')}`);
      const d = F.wordDiff(SB.boardText(a), SB.boardText(b));
      const show = d.map(o => o.w === '\n' ? (o.op === '-' ? '' : '\n') : o.op === '=' ? o.w : o.op === '-' ? `[-${o.w}-]` : `{+${o.w}+}`).join(' ').replace(/ ?\n ?/g, '\n');
      return { a: a.id, b: b.id, ...F.diffStats(d), shots: SB.shotChanges(a, b), diff: show };
    }
    const v = version ? doc.versions.find(x => x.id === version) : SB.currentBoard(doc);
    if (version && !v) fail(404, `no version "${version}" (storyboard_get lists the versions)`);
    if (scene != null && (typeof scene !== 'string' || !SC.SCENE_ID.test(scene))) fail(400, 'scene: a scene id');
    const c = boardCtx(p), shots = [...(v?.shots || [])].sort(SB.byTime), view = shots.map(s => shotView(p, s, c)), ids = new Set(c.scenes.map(s => s.id));
    const g = SB.boardGaps({ song: c.song, scenes: c.scenes, shots, entities: c.ents, approvals: c.approvals, requests: c.requests });
    const ns = stageNotes(p, 'storyboard', 'storyboard', { status: notes });
    return { current: doc.current, derived: !!doc.derived, version: v ? { id: v.id, created: v.created, by: v.by, via: v.via, message: v.message, from: v.from, script: v.script || null } : null,
      script_current: c.sdoc.current, ...(v?.script && v.script !== c.sdoc.current ? { script_changed: `this storyboard was made on script ${v.script}; the script is now ${c.sdoc.current}: check new or changed scenes` } : {}),
      grid: { bpm: c.song.bpm, beat_ms: SB.beatMs(c.song), bar_ms: SB.barMs(c.song), beats_per_bar: c.song.beats_per_bar || 4, note: 'song_get grid:true lists every beat; shots_update snap "beats" / "bars" cuts on it' },
      kinds: SB.KINDS, gens: SB.GENS,
      scenes: c.scenes.filter(s => !scene || s.id === scene).map(s => ({ id: s.id, time: SC.span(s.t0, s.t1), t0: s.t0, t1: s.t1, title: s.title, text: s.text, status: SC.sceneStatus(c.sdoc, s.id),
        beats: s.beats.map(b => ({ id: b.id, t: b.t, text: b.text })),
        needs: SB.sceneAssets(s.id, c.bd, c.ents).map(a => { const e = c.ents.find(x => x.id === a.id); const u = SB.useFor(e, s.id); return { ...a, name: e?.name || a.id, variant: u.variant, source: u.source }; }),
        shots: view.filter(x => x.scene === s.id) })),
      outside_script: scene ? [] : view.filter(x => !ids.has(x.scene)),
      gaps: { ...g.counts, total: g.total, estimate: g.estimate, note: 'gaps_get for the rows and the draft requests' },
      notes: ns.map(n => boardNoteView(n, v)),
      asks_for_agent: stageAsks(p, 'storyboard').map(n => legacyView(n, 'storyboard')).map(n => ({ id: n.id, shot: n.shot || null, scene: n.scene || null, kind: n.kind || 'request', text: n.text, ...(n.gaps ? { gaps: n.gaps } : {}), replies: n.replies?.length || 0 })),
      versions: doc.versions.map(x => ({ id: x.id, created: x.created, by: x.by, via: x.via, message: x.message, from: x.from, script: x.script, shots: x.shots.length, current: x.id === doc.current })),
      rules: 'shots_update writes a NEW version (never destructive); a scene\'s shots tile it; shot status approved / locked is the director\'s (page): you may set draft, review or changes; generations are request_create drafts (target "shot:<id>"; gaps_get drafts them)' };
  },
  // a new version of the storyboard: shots = the full list; or upsert (merge by id, a shot without id is new) and remove
  // (ids); or restore = an old version id. snap ("beats" | "bars") snaps the times written; tile (default true) re-tiles
  // every scene. status = {<shot id>: "draft" | "review" | "changes"} (approved / locked are the director's: 403).
  shots_update(p, { shots, upsert, remove, restore, status, snap, tile = true, message = '', by = 'agent' } = {}) {
    const modes = [shots != null, upsert != null || remove != null, restore != null].filter(Boolean).length;
    if (modes > 1 || (!modes && status == null)) fail(400, 'give one of shots (the full list), upsert / remove, or restore; or only status');
    if (snap != null && !SB.SNAPS.includes(snap)) fail(400, `snap: one of ${SB.SNAPS.join(', ')}`);
    if (status != null) {
      if (typeof status !== 'object' || Array.isArray(status)) fail(400, 'status: {<shot id>: "draft" | "review" | "changes"}');
      for (const [k, v] of Object.entries(status)) {
        if (!SB.SHOT_ID.test(k)) fail(400, `status: bad shot id "${k.slice(0, 60)}"`);
        if (DIRECTOR_STATES.includes(v)) fail(403, `${SHOT_DIRECTOR} (${k})`);
        if (!['draft', 'review', 'changes'].includes(v)) fail(400, `status of ${k}: draft, review or changes`);
      }
    }
    const song = read(p, 'song.json'), sdoc = scenesDoc(p), scenes = SC.currentScript(sdoc)?.scenes || [], sIds = new Map(scenes.map(s => [s.id, s]));
    const warnings = []; let r = {};
    mutateBoard(p, (d) => {
      const prev = SB.currentBoard(d);
      let body = null;
      if (restore != null) { const old = d.versions.find(v => v.id === restore); if (!old) fail(404, `no version "${restore}"`); body = structuredClone(old.shots); }
      else if (shots != null || upsert != null || remove != null) {
        if (shots != null && !Array.isArray(shots)) fail(400, 'shots: [{id?, scene, t0, t1, kind, title, text, camera, sketch, cast, locations, props, variants, gen, beats}]');
        if (upsert != null && !Array.isArray(upsert)) fail(400, 'upsert: a list of shots (partial: only the fields to change; no id = a new shot)');
        if (remove != null && (!Array.isArray(remove) || remove.some(x => typeof x !== 'string' || !SB.SHOT_ID.test(x)))) fail(400, 'remove: a list of shot ids');
        const base = shots != null ? [] : structuredClone(prev?.shots || []), draft = [...base], byId = new Map(base.map(s => [s.id, s]));
        for (const id of remove || []) { if (!byId.has(id)) fail(404, `no shot "${id}" in the current version`); draft.splice(draft.indexOf(byId.get(id)), 1); byId.delete(id); }
        for (const x0 of shots || upsert || []) {
          if (!x0 || typeof x0 !== 'object' || Array.isArray(x0)) fail(400, 'every shot is an object');
          const x = { ...x0 };
          if (Object.hasOwn(x, 'clip')) { delete x.clip; warnings.push(`${x.id ?? 'a new shot'}: clip ignored: the picked take is the director's (take_propose proposes one)`); }
          if (Object.hasOwn(x, 'lyrics')) { delete x.lyrics; warnings.push(`${x.id ?? 'a new shot'}: lyrics ignored: the lyric surfaces are the director's (surface_propose proposes one)`); }
          if (x.id != null && !SB.SHOT_ID.test(String(x.id))) fail(400, `shot id "${String(x.id).slice(0, 60)}": letters, digits, _ and - (up to 40)`);
          for (const k of ['t0', 't1']) if (x[k] != null) x[k] = ms(x[k], k);
          const old = x.id != null ? byId.get(String(x.id)) : null;
          if (upsert && x.id != null && !old) fail(404, `no shot "${x.id}" to update (leave id out for a new shot)`);
          const id = old?.id ?? (x.id != null ? String(x.id) : SB.nextShotId(d, draft));
          if (!old && byId.has(id)) fail(400, `duplicate shot id "${id}"`);
          const merged = { ...(old || SB.NEW_SHOT()), ...x, id };
          if (!old && x.scene === undefined && Number.isFinite(merged.t0) && Number.isFinite(merged.t1)) merged.scene = scenes.find(s => s.t0 <= (merged.t0 + merged.t1) / 2 && (merged.t0 + merged.t1) / 2 < s.t1)?.id || null;
          let c; try { c = SB.cleanShot(merged, song, { snap }); } catch (e) { fail(400, e.message); }
          if (old) draft[draft.indexOf(old)] = c; else draft.push(c);
          byId.set(id, c);
        }
        body = draft;
      }
      if (body) {
        // the picked take (shot.clip) is the director's: every agent version carries the current picks forward, as they are
        const picks = new Map((prev?.shots || []).filter(x => x.clip).map(x => [x.id, x.clip]));
        for (const x of body) { if (picks.has(x.id)) x.clip = structuredClone(picks.get(x.id)); else delete x.clip; }
        // the lyric surfaces (shot.lyrics, E2) are the director's too: carried forward the same way
        const surf = new Map((prev?.shots || []).filter(x => x.lyrics?.length).map(x => [x.id, x.lyrics]));
        for (const x of body) { if (surf.has(x.id)) x.lyrics = structuredClone(surf.get(x.id)); else delete x.lyrics; }
        if (tile) { try { warnings.push(...SB.tileShots(body, scenes)); } catch (e) { fail(400, e.message); } }
        body.sort(SB.byTime);
        if (prev && SB.sameShots([...prev.shots].sort(SB.byTime), body)) r = { version: prev.id, unchanged: true };
        else { const v = SB.addBoardVersion(d, body, { by, via: 'agent', message: restore ? (message || `restore ${restore}`) : message, ...(restore ? { from: restore } : {}), script: sdoc.current || undefined }); r = { version: v.id, shots: v.shots.length }; }
      }
      // what the director will see: unknown scenes, entities, variants, sketches; overlaps of shots left untiled
      const cur = SB.currentBoard(d)?.shots || [], ents = entitiesAll(p);
      for (const s of cur) {
        if (s.scene && !sIds.has(s.scene)) warnings.push(`${s.id}: scene "${s.scene}" is not in the current script`);
        const sc = sIds.get(s.scene); if (sc && (s.t0 < sc.t0 || s.t1 > sc.t1)) warnings.push(`${s.id}: ${SC.span(s.t0, s.t1)} runs outside ${sc.id} (${SC.span(sc.t0, sc.t1)})`);
        for (const [type, f] of Object.entries(SB.FIELD)) for (const id of s[f] || []) {
          const e = ents.find(x => x.id === id && x.kind === type) || (type === 'location' ? ents.find(x => x.kind === 'location' && x.letter === id) : null);
          if (!e) warnings.push(`${s.id}: no ${type} "${id}" (asset_get lists them)`);
          else if (Object.hasOwn(s.variants || {}, id) && s.variants[id] && !A.variants(e, type).some(v => v.id === s.variants[id])) warnings.push(`${s.id}: ${id} has no ${A.TYPE[type].vWord} "${s.variants[id]}"`);
        }
        for (const k of Object.keys(s.variants || {})) if (![...s.cast, ...s.locations, ...s.props].includes(k)) warnings.push(`${s.id}: variants.${k} names no asset of the shot`);
        if (s.sketch && !sketchFiles(p, s.sketch)) warnings.push(`${s.id}: sketch "${s.sketch}" has no files yet (sketch_save)`);
        if (sc) for (const b of s.beats || []) if (!sc.beats.some(x => x.id === b)) warnings.push(`${s.id}: beat "${b}" is not in ${sc.id}`);
      }
      if (!tile) { const o = [...cur].sort(SB.byTime); for (let i = 1; i < o.length; i++) if (o[i].t0 < o[i - 1].t1) warnings.push(`${o[i - 1].id} and ${o[i].id} overlap`); }
      for (const k of Object.keys(status || {})) if (!cur.some(s => s.id === k)) warnings.push(`status for "${k}": no such shot in the current version`);
      const g = SB.boardGaps({ song, scenes, shots: cur, entities: ents, approvals: read(p, 'approvals.json'), requests: read(p, 'requests.json') });
      r.gaps = { ...g.counts, total: g.total, estimate: g.estimate };
    });
    if (status && Object.keys(status).length) {
      const cur = SB.boardShots(boardDoc(p)), ok = Object.entries(status).filter(([k]) => cur.some(s => s.id === k));
      if (ok.length) mutate(p, 'approvals.json', (A_) => { for (const [k, v] of ok) A_.items[`shot:${k}`] = { ...(A_.items[`shot:${k}`] || {}), state: v, by, via: 'agent', at: nowIso() }; });
      r.status = Object.fromEntries(ok);
    }
    if (warnings.length) r.warnings = [...new Set(warnings)];
    if (r.version && !r.unchanged) startStage(p, 'storyboard');
    return r;
  },
  // a note on a shot (or a scene), with neither for the whole storyboard, a reply in a thread (reply_to), or an ask:
  // written to notes.json v2 (target {stage: "storyboard", kind: shot | scene, id}), answered in the old shape
  shot_note_add(p, { shot, scene, text, reply_to, to, by = 'agent' } = {}) {
    if (!text || typeof text !== 'string') fail(400, 'text required');
    if (shot != null && (typeof shot !== 'string' || !SB.SHOT_ID.test(shot))) fail(400, 'shot: a shot id');
    if (scene != null && (typeof scene !== 'string' || !SC.SCENE_ID.test(scene))) fail(400, 'scene: a scene id');
    if (reply_to) { const r = replyNote(p, reply_to, String(text).slice(0, 8000), { by }); return { note: r.note.id, reply: r.reply }; }
    const d = boardDoc(p), v = SB.currentBoard(d), s = shot ? v?.shots.find(x => x.id === shot) : null;
    if (shot && !s) fail(404, `no shot "${shot}" in the current version (storyboard_get lists them)`);
    if (scene && !SC.currentScript(scenesDoc(p))?.scenes.some(x => x.id === scene)) fail(404, `no scene "${scene}" in the current script`);
    const target = s ? { stage: 'storyboard', kind: 'shot', id: shot, ...(scene || s.scene ? { scene: scene || s.scene } : {}) } : scene ? { stage: 'storyboard', kind: 'scene', id: scene } : { stage: 'storyboard', kind: 'stage' };
    return boardNoteView(legacyView(addNote(p, { target, text: String(text).slice(0, 8000), to, version: d.current, by }), 'storyboard'), v);
  },
  shot_note_resolve(p, { id, reply, reopen = false, by = 'agent' } = {}) {
    return legacyView(setStatus(p, id, reopen ? 'open' : 'absorbed', { reply: reply == null ? reply : String(reply).slice(0, 8000), by }).note, 'storyboard');
  },
  // everything still missing across the stages (unscripted time, scenes without shots, shots without a frame, assets the
  // shots need that are not approved, shots without a request or clip), the draft requests to propose for the last
  // group (prompt, refs = approved variant / look images + the frame sketch, tool, honest est_cost) and the total
  // against the cost cap
  gaps_get(p) {
    const doc = boardDoc(p), v = SB.currentBoard(doc), c = boardCtx(p), shots = [...(v?.shots || [])].sort(SB.byTime);
    const g = SB.boardGaps({ song: c.song, scenes: c.scenes, shots, entities: c.ents, approvals: c.approvals, requests: c.requests });
    const proposals = g.no_request.map(x => {
      const s = shots.find(y => y.id === x.shot), assets = SB.shotAssets(s, c.ents, c.approvals), sk = s.sketch ? sketchInfo(p, s.sketch) : null;
      const pr = SB.shotProposal(s, c.scenes.find(y => y.id === s.scene), assets, { sketchPng: sk && !sk.missing ? sk.png : null });
      return { shot: s.id, scene: s.scene, time: x.time, kind: s.kind, gen: pr.gen, est_usd: pr.est_usd, requests: pr.requests.map(q => ({ ...q, ref_files: q.refs.map(f => f.startsWith('(') ? null : refFile(p, f)) })), ...(pr.missing.length ? { not_approved: pr.missing } : {}) };
    });
    const cs = costSummary(p), total = +(cs.spent_usd + cs.committed_usd + g.estimate.usd).toFixed(2);
    return { version: doc.current, derived: !!doc.derived, counts: g.counts, total: g.total,
      unscripted: g.unscripted, no_shots: g.no_shots, no_frame: g.no_frame, assets: g.assets, no_request: g.no_request, proposals,
      estimate: { ...g.estimate, cap_usd: cs.cap_usd, spent_usd: cs.spent_usd, committed_usd: cs.committed_usd, drafts_usd: cs.drafts_usd, total_usd: total, over_cap: total > cs.cap_usd + 1e-9, ...(cs.cap_usd ? {} : { note: 'the cap is 0: nothing paid can run until the director sets one' }) },
      asks_for_agent: stageAsks(p, 'storyboard').filter(n => n.ask === 'fill_gaps').map(n => ({ id: n.id, text: n.text, gaps: n.gaps || null })),
      rules: 'propose each generation with request_create (draft; target "shot:<id>", the prompt, refs, tool and an honest est_cost from proposals; the start frame before its video); approved assets first (asset_get / request_create with asset); the director approves in the page; run only approved requests; then answer the ask (shot_note_resolve)' };
  },
});
