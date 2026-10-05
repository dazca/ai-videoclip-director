// Core ops: the code version (a stale server says so), projects (list / create / duplicate / delete), snapshots
// (save / list / restore with carry-forward of spend and approvals), the song and the timeline (song_get, timeline_query),
// the media index (media_list, media_add, media_update) and what a remote (LAN) client may read (scrubPrivate).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as F from '../../js/flow.js';
import * as A from '../../js/assets.js';
import * as SB from '../../js/storyboard.js';
import { AUDIO, CFG, DATA_ROOT, DEFAULTS, DIRECTOR_STATES, IMAGE, RUNNABLE, VIDEO, WB_DIR, WRITABLE, fail, ffprobe, inside, isFlaggedPrivate, isMediaRootPath, isPrivate, makeThumbs, ms, nowIso, ops, overlaps, projDir, read, readJSON, relTo, resolveMedia, shotsDoc, slug, stamp, stateOf, tc, validId, walk, write, writeAtomic, writeJSON } from './_shared.mjs';
import { boardDoc } from './storyboard.mjs';
import { legacyStores, notesInTime } from './notes.mjs';
import * as N from '../../js/notes.js';

// ------------------------------------------------------------------ the code version (a stale server says so)
// The server records the hash of its code at start (serve.mjs, lib/, js/ and the page's tabs/, core/, app.js); /api/status
// and every /api response carry it (header x-wb-code), the MCP server and the page compare it with the files on disk and
// say "restart the server" when they differ. Per-file hashes are cached by mtime + size, so a check is cheap.
const CODE_DIRS = [['', /^(serve\.mjs|app\.js|index\.html)$/], ['lib', /\.mjs$/], ['lib/ops', /\.mjs$/], ['generators', /\.mjs$/], ['js', /\.js$/], ['tabs', /\.js$/], ['core', /\.js$/], ['core/sketch', /\.js$/], ['exporters', /^composition-data\.mjs$/]];
const codeCache = new Map();
// { mcp: true } adds mcp/server.mjs (the MCP server checks its own code too)
export function codeState({ mcp = false } = {}) {
  const files = {};
  for (const [d, re] of mcp ? [...CODE_DIRS, ['mcp', /^server\.mjs$/], ['mcp/tools', /\.mjs$/]] : CODE_DIRS) {
    let names = []; try { names = fs.readdirSync(path.join(WB_DIR, d)).filter(n => re.test(n)); } catch (e) { continue; }
    for (const n of names) {
      const rel = d ? `${d}/${n}` : n, abs = path.join(WB_DIR, rel);
      let st; try { st = fs.statSync(abs); } catch (e) { continue; }
      if (!st.isFile()) continue;
      const k = `${st.mtimeMs}:${st.size}`, c = codeCache.get(rel);
      if (c?.k === k) { files[rel] = c.h; continue; }
      const h = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 12);
      codeCache.set(rel, { k, h }); files[rel] = h;
    }
  }
  const names = Object.keys(files).sort();
  return { hash: crypto.createHash('sha1').update(names.map(n => `${n}:${files[n]}`).join('\n')).digest('hex').slice(0, 12), files };
}

// what changed between two codeState()s (file names), for "restart the server: lib/store.mjs, js/assets.js changed"
export const codeDiff = (a, b) => [...new Set([...Object.keys(a?.files || {}), ...Object.keys(b?.files || {})])].filter(f => a?.files?.[f] !== b?.files?.[f]).sort();

// snapshots keep the small JSON content files only (sketches/ are files the immutable script versions point at: a
// restore must not delete them); revisions.json (the index of the revisions, lib/ops/rounds.mjs) and the optional git
// mirror .history/ live outside them, so a restore never rolls the index back
const SNAP_SKIP = /^(peaks|_src|thumbs|media|sketches|private\/sketches|\.snapshots|\.history)\/|^(settings|revisions)\.json$/;

export function listProjects() {
  if (!fs.existsSync(DATA_ROOT)) return [];
  return fs.readdirSync(DATA_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && validId(e.name) && fs.existsSync(path.join(DATA_ROOT, e.name, 'song.json')) && (!e.name.startsWith('_') || e.name === CFG.defaultProject))
    .map(e => {
      const d = path.join(DATA_ROOT, e.name), meta = readJSON(path.join(d, 'project.json'), {}) || {};
      const snaps = fs.existsSync(path.join(d, '.snapshots')) ? fs.readdirSync(path.join(d, '.snapshots')).length : 0;
      const modified = Math.max(...['approvals.json', 'notes.json', 'requests.json', 'song.json'].map(f => { try { return fs.statSync(path.join(d, f)).mtimeMs; } catch (er) { return 0; } }));
      return { id: e.name, title: meta.title || e.name, modified: new Date(modified).toISOString().slice(0, 19), snapshots: snaps, default: e.name === CFG.defaultProject };
    });
}
// a new empty project: a copy of data/_template/ (or a minimal one when the template is missing)
export function createProject(id, title, { durationMs } = {}) {
  const d = projDir(id, false);
  if (fs.existsSync(d)) fail(409, 'exists: ' + id);
  const tpl = path.join(DATA_ROOT, '_template');
  if (fs.existsSync(path.join(tpl, 'song.json'))) fs.cpSync(tpl, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}.snapshots`) && !s.endsWith('.tmp') });
  else {
    const dur = 120000, beats = [], downbeats = [];
    for (let t = 0; t <= dur; t += 500) { beats.push(t); if (t % 2000 === 0) downbeats.push(t); }
    const files = {
      'song.json': { title: title || id, duration_ms: dur, bpm: 120, beat_ms: 500, bar_ms: 2000, beats_per_bar: 4, grid: { beats, downbeats }, audio: { mix: null, render: null, stems: [] },
        sections: [{ id: 'intro', label: 'intro', t0: 0, t1: dur, energy: 0, world_pct: 0, overload: [0, 0], transitions: '' }], lines: [] },
      'energy.json': { fps: 24, rms: [], onset: [] },
    };
    for (const f of Object.keys(DEFAULTS)) if (f !== 'settings.json') writeJSON(path.join(d, f), Array.isArray(DEFAULTS[f]) ? DEFAULTS[f] : { ...DEFAULTS[f], ...(DEFAULTS[f].rev === 0 ? { rev: 1 } : {}) });
    for (const [f, v] of Object.entries(files)) writeJSON(path.join(d, f), v);
    writeJSON(path.join(d, 'stages.json'), { rev: 1, stages: F.STAGES.map(x => ({ id: x.id, status: 'empty', blockers: [] })) });
  }
  writeJSON(path.join(d, 'project.json'), { title: title || id, created: nowIso() });
  if (durationMs) { const s = readJSON(path.join(d, 'song.json')); s.duration_ms = durationMs; writeJSON(path.join(d, 'song.json'), s); }
  return { id, title: title || id };
}
export function duplicateProject(from, to, resetState) {
  const src = projDir(from), dst = projDir(to, false);
  if (fs.existsSync(dst)) fail(409, 'exists: ' + to);
  // not copied: the snapshots, the git mirror (.history: its hooks / config must never travel with a project) and temp files
  fs.cpSync(src, dst, { recursive: true, filter: (s) => !s.includes(`${path.sep}.snapshots`) && !s.includes(`${path.sep}.history`) && !s.endsWith('.tmp') });
  // the revisions point at snapshots the copy does not have (Compare / Restore would 404): the copy starts its own history
  if (fs.existsSync(path.join(dst, 'revisions.json'))) fs.rmSync(path.join(dst, 'revisions.json'));
  const meta = readJSON(path.join(src, 'project.json'), {}) || {};
  writeJSON(path.join(dst, 'project.json'), { ...meta, title: to, created: nowIso(), from });
  if (resetState) {
    for (const f of ['approvals.json', 'requests.json']) writeJSON(path.join(dst, f), { ...DEFAULTS[f], rev: 1 });
    // notes start empty: every note of the old stores counts as seen (never imported into the copy)
    writeJSON(path.join(dst, 'notes.json'), { ...N.emptyNotes(), rev: 1, legacy_seen: N.legacyKeys(legacyStores(to, readJSON(path.join(dst, 'notes.json'), null))) });
  }
  else {   // one director approval pays for one run: the copy's runnable requests (approved / failed / queued / running) go back to draft
    const R = readJSON(path.join(dst, 'requests.json'), null);
    if (R?.items?.some(r => LIVE.includes(r.status))) {
      R.items = R.items.map(r => LIVE.includes(r.status) ? { ...r, status: 'draft', log: [...(r.log || []), { at: nowIso(), by: 'duplicate', status: 'draft', why: `copied from ${from}: approve again` }] } : r);
      writeJSON(path.join(dst, 'requests.json'), R);
    }
  }
  return { id: to, from };
}
export function deleteProject(id) {
  if (id === CFG.defaultProject || id === '_template' || id === 'demo') fail(403, 'refusing to delete the default project, the template or the demo');
  fs.rmSync(projDir(id), { recursive: true, force: true });
  return { deleted: id };
}

// ------------------------------------------------------------------ snapshots
// (the walk does not enter the skipped top folders: .snapshots / .history / media can be large)
const SNAP_TOP = new Set(['peaks', '_src', 'thumbs', 'media', 'sketches', '.snapshots', '.history']);
const walkSnap = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(e => { const r = rel ? `${rel}/${e.name}` : e.name; return e.isDirectory() ? (rel === '' && SNAP_TOP.has(e.name) ? [] : walkSnap(dir, r)) : [r]; });
export const snapFiles = (dir) => walkSnap(dir).filter(f => f.endsWith('.json') && !SNAP_SKIP.test(f));
export function snapshot(id, message, auto = false) {
  const d = projDir(id); let sid = `${stamp()}-${slug(message)}`;
  for (let n = 2; fs.existsSync(path.join(d, '.snapshots', sid)); n++) sid = `${stamp()}-${slug(message)}-${n}`;
  const sd = path.join(d, '.snapshots', sid), files = snapFiles(d);
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(sd, f)), { recursive: true }); fs.copyFileSync(path.join(d, f), path.join(sd, f)); }
  const meta = { id: sid, at: nowIso(), message: message || '', auto, files: files.length };
  writeJSON(path.join(sd, '.meta.json'), meta);
  return meta;
}
export function listSnapshots(id) {
  const sd = path.join(projDir(id), '.snapshots');
  if (!fs.existsSync(sd)) return [];
  return fs.readdirSync(sd).map(s => readJSON(path.join(sd, s, '.meta.json'), { id: s, at: '', message: '?' })).sort((a, b) => b.id.localeCompare(a.id));
}
// spend is never rolled back: every cost recorded now stays, and a request that already ran (running / done /
// rejected now) keeps its current state; a restored approval that is not exactly the current one goes back to draft,
// so one director approval never pays for two runs
const ASSET_FILE = /^entities\/(characters|locations|props)\//;
const RAN = ['running', 'done', 'rejected', 'failed'], LIVE = RUNNABLE;   // failed is runnable too (lib/run.mjs)
const sameAsk = (a, b) => ['prompt', 'est_cost', 'tool'].every(k => a[k] === b[k]) && JSON.stringify(a.refs || []) === JSON.stringify(b.refs || []);
function carryForward(f, old, cur, kept, agent) {
  if (f === 'costs.json') {
    if (cur.cap_usd !== undefined && old.cap_usd !== cur.cap_usd) { old.cap_usd = cur.cap_usd; kept.push('cap_usd'); }   // the cap is the director's current setting
    const key = (x) => JSON.stringify(x), have = new Set((old.items || []).map(key));
    const add = (cur.items || []).filter(x => !have.has(key(x)));
    if (add.length) { old.items = [...(old.items || []), ...add].sort((a, b) => (a.t || 0) - (b.t || 0)); kept.push(...add.map(x => `cost ${x.id}`)); }
  } else if (f === 'requests.json') {
    const now = new Map((cur.items || []).map(r => [r.id, r])), out = [];
    for (const r of old.items || []) {
      const c = now.get(r.id); now.delete(r.id);
      if (c && RAN.includes(c.status)) { out.push(c); if (c.status !== r.status) kept.push(`request ${c.id} ${c.status}`); }
      else if (LIVE.includes(r.status) && !(c && c.status === r.status && sameAsk(c, r))) {
        out.push({ ...r, status: 'draft', log: [...(r.log || []), { at: nowIso(), by: 'restore', status: 'draft', why: 'approval not carried over by a snapshot restore' }] });
        kept.push(`request ${r.id} back to draft`);
      } else out.push(r);
    }
    for (const c of now.values()) if (RAN.includes(c.status)) { out.push(c); kept.push(`request ${c.id} ${c.status}`); }
    old.items = out;
  } else if (f === 'stages.json' && agent) {
    // only the page marks a stage done: an agent's restore brings a done stage that is not done now back as needs_you
    const now = new Map((cur.stages || []).map(x => [x.id, x]));
    for (const x of old.stages || []) if (x?.status === 'done' && now.get(x.id)?.status !== 'done') { x.status = 'needs_you'; delete x.done_by; delete x.via; kept.push(`stage ${x.id} needs_you`); }
  } else if (f === 'scenes.json' && agent) {
    // a scene marked ok is the director's: an agent's restore brings an ok that is not ok now back as needs_you
    for (const [k, v] of Object.entries(old.states || {})) if (v?.status === 'ok' && cur.states?.[k]?.status !== 'ok') { old.states[k] = { status: 'needs_you', by: 'restore', via: 'agent', at: nowIso() }; kept.push(`scene ${k} needs_you`); }
  } else if (f === 'breakdown.json' && agent) {
    // an item ok is the director's: an agent's restore brings an ok that is not ok now back as review (entities are files
    // the restore rolls back too, so an entity link goes back with them)
    for (const [k, v] of Object.entries(old.states || {})) if (v?.status === 'ok' && cur.states?.[k]?.status !== 'ok') { old.states[k] = { ...v, status: 'review', by: 'restore', via: 'agent', at: nowIso() }; kept.push(`item ${k} review`); }
  } else if (ASSET_FILE.test(f)) {
    // stages 4 and 5: nodes are outputs that were paid for: the ones made since the snapshot stay (undecided again); an
    // agent's restore brings back no root / look / variant approval that is not the current one
    const ci = cur.iter;
    if (ci && Array.isArray(ci.nodes)) {
      old.iter = A.normIter(old.iter);
      const have = new Set(old.iter.nodes.map(n => n.id));
      for (const n of ci.nodes) if (n && !have.has(n.id)) { old.iter.nodes.push({ ...n, choice: null }); kept.push(`node ${old.id || ''}/${n.id}`); }
    }
    if (agent) {
      for (const [t, x] of Object.entries(old.iter?.trees || {})) if (x?.approved && ci?.trees?.[t]?.approved !== x.approved) { delete x.approved; delete x.approved_at; delete x.approved_by; kept.push(`${old.id}/${t} approval not restored`); }
      for (const k of ['looks', 'variants']) for (const l of Array.isArray(old[k]) ? old[k] : []) if (DIRECTOR_STATES.includes(l?.status) && !(Array.isArray(cur[k]) ? cur[k] : []).some(x => x?.id === l.id && x.status === l.status)) { l.status = 'review'; kept.push(`${old.id}/${k === 'looks' ? 'look' : 'variant'} ${l.id} review`); }
      // the variant each scene uses is the director's pick: an agent's restore keeps the current picks
      if (cur.uses || old.uses) { if (cur.uses) old.uses = cur.uses; else delete old.uses; }
    }
  } else if (f === 'approvals.json' && agent) {
    // an agent's restore cannot approve: an approved / locked state that is not the current one comes back as review
    for (const [k, v] of Object.entries(old.items || {})) {
      const c = cur.items?.[k];
      if (v && DIRECTOR_STATES.includes(v.state) && c?.state !== v.state) { old.items[k] = { ...v, state: 'review', by: 'restore', via: 'agent', comment: `was ${v.state} in the snapshot: approve again` }; kept.push(`${k} review`); }
    }
  }
  return old;
}
// restore = the current state is snapshotted first ("auto"), then the snapshot's JSON files are copied back; files the
// snapshot did not have are removed. Costs and requests that ran since are carried forward (see carryForward).
export function restore(id, sid, { agent = false } = {}) {
  const d = projDir(id);
  const sd = inside(path.join(d, '.snapshots'), String(sid || ''));
  if (!sd || !fs.existsSync(path.join(sd, '.meta.json'))) fail(404, 'no such snapshot: ' + sid);
  const meta = readJSON(path.join(sd, '.meta.json'), {});
  const before = snapshot(id, `before restore of ${meta.message || sid}`, true);
  // only what snapshot() writes: regular .json files outside the skipped folders
  const keep = new Set(snapFiles(sd).filter(f => f !== '.meta.json' && fs.lstatSync(path.join(sd, f)).isFile()));
  const gone = snapFiles(d).filter(f => !keep.has(f)), changed = [], kept = [];
  for (const f of gone) {
    // a snapshot without costs / requests: only what ran since stays
    const c = (f === 'costs.json' || f === 'requests.json') ? carryForward(f, { items: [] }, readJSON(path.join(d, f), {}) || {}, kept) : null;
    if (c?.items.length) { if (f === 'requests.json') c.rev = (readJSON(path.join(d, f), {})?.rev || 0) + 1; writeJSON(path.join(d, f), c); changed.push(f); }
    else fs.rmSync(path.join(d, f));
  }
  for (const f of keep) {
    const b = fs.readFileSync(path.join(sd, f)), cur = fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f)) : null;
    if (cur && cur.equals(b)) continue;
    let out = b;
    try {
      let j = JSON.parse(b); const c = cur ? JSON.parse(cur) : {};
      if (f === 'costs.json' || f === 'requests.json' || f === 'approvals.json' || f === 'stages.json' || f === 'scenes.json' || f === 'breakdown.json' || ASSET_FILE.test(f)) j = carryForward(f, j, c, kept, agent);
      // a shared {rev} file gets a rev above both, so a page still holding the pre-restore rev gets 409, never a silent overwrite
      if (WRITABLE.has(f)) j.rev = Math.max(c.rev || 0, j.rev || 0) + 1;
      if (WRITABLE.has(f) || f === 'costs.json' || f === 'requests.json' || ASSET_FILE.test(f)) out = JSON.stringify(j, null, 1);
    } catch (e) { /* not JSON: copy as is */ }
    if (cur && cur.equals(Buffer.from(out))) continue;
    writeAtomic(path.join(d, f), out); changed.push(f);
  }
  return { restored: sid, previous: before.id, changed, removed: gone.filter(f => !changed.includes(f)), ...(kept.length ? { kept_since_snapshot: kept } : {}) };
}

Object.assign(ops, {
  // ---------------- song
  song_get(p, { words = true, grid = false, section } = {}) {
    const s = read(p, 'song.json'), ov = read(p, 'overrides.json').sections || {};
    const sections = s.sections.map(x => ({ ...x, label: ov[x.id]?.label || x.label, ...(ov[x.id]?.color ? { color: ov[x.id].color } : {}) }));
    let lines = s.lines; const sec = section ? s.sections.find(x => x.id === section) : null;
    if (section && !sec) fail(404, `no section "${section}" (sections: ${s.sections.map(x => x.id).join(', ')})`);
    if (section) lines = lines.filter(l => l.section === section);
    if (!words) lines = lines.map(({ words: w, ...l }) => ({ ...l, n_words: w?.length || 0 }));
    const g = s.grid || { beats: [], downbeats: [] };
    return { title: s.title, duration_ms: s.duration_ms, duration: tc(s.duration_ms), bpm: s.bpm, beat_ms: s.beat_ms, bar_ms: s.bar_ms, beats_per_bar: s.beats_per_bar,
      audio: s.audio, sections: section ? sections.filter(x => x.id === section) : sections, lines,
      grid: grid ? g : { beats: g.beats.length, downbeats: g.downbeats.length, first_downbeats: g.downbeats.slice(0, 8), note: 'pass grid:true for every beat time' },
      events: read(p, 'events.json').filter(e => !sec || (e.t >= sec.t0 && e.t < sec.t1)) };
  },
  timeline_query(p, { t0, t1, words = false } = {}) {
    let a = ms(t0, 't0') ?? 0, b = ms(t1, 't1'); if (b == null) b = a;
    if (b < a) [a, b] = [b, a];
    const s = read(p, 'song.json'), sh = shotsDoc(p), A = read(p, 'approvals.json'), S = read(p, 'script.json');
    const R = read(p, 'requests.json').items || [], C = read(p, 'costs.json');
    const shots = sh.shots.filter(x => overlaps(x.t0, x.t1, a, b)).map(x => ({ id: x.id, t0: x.t0, t1: x.t1, kind: x.kind, title: x.title, cast: x.cast, locations: x.locations, clips: x.clips, state: stateOf(A, 'shot:' + x.id) }));
    const uses = sh.uses.filter(u => overlaps(u.t0, u.t1, a, b)).map(u => ({ id: u.id, clip: u.clip, take: u.take, in_ms: u.in_ms, t0: u.t0, t1: u.t1, file: u.file, location: u.location, label: u.label, state: stateOf(A, 'use:' + u.id) }));
    const keys = new Set([...shots.map(x => 'shot:' + x.id), ...uses.map(u => 'use:' + u.id), ...s.sections.filter(x => overlaps(x.t0, x.t1, a, b)).map(x => 'section:' + x.id)]);
    const g = s.grid || { beats: [], downbeats: [] };
    const bars = g.downbeats.map((t, i) => ({ bar: i + 1, t })).filter(x => x.t >= a && x.t <= b);
    return { t0: a, t1: b, range: `${tc(a)}–${tc(b)}`,
      sections: s.sections.filter(x => overlaps(x.t0, x.t1, a, b)).map(x => ({ id: x.id, label: x.label, t0: x.t0, t1: x.t1, energy: x.energy })),
      bars: bars.length > 64 ? { count: bars.length, first: bars[0], last: bars[bars.length - 1] } : bars,
      beats: g.beats.filter(t => t >= a && t <= b).length,
      lines: s.lines.filter(l => overlaps(l.t0, l.t1, a, b)).map(l => words ? l : { id: l.id, t0: l.t0, t1: l.t1, text: l.text, voice: l.voice }),
      events: read(p, 'events.json').filter(e => e.t >= a && e.t <= Math.max(b, a)),
      script: S.lines.filter(x => overlaps(x.t0, x.t_end ?? x.t0 + 1, a, b)).map(x => ({ ...x, state: stateOf(A, 'script:' + x.id) })),
      shots, uses,
      // the storyboard's shots (storyboard.json; without it the same shots as above)
      board: SB.boardShots(boardDoc(p)).filter(x => overlaps(x.t0, x.t1, a, b)).map(x => ({ id: x.id, scene: x.scene, t0: x.t0, t1: x.t1, kind: x.kind, title: x.title, text: x.text, camera: x.camera, sketch: x.sketch, cast: x.cast, locations: x.locations, props: x.props, state: stateOf(A, 'shot:' + x.id) })),
      cast: [...new Set(shots.flatMap(x => x.cast || []))],
      notes: notesInTime(p, a, Math.max(b, a)),   // every note with a song time (timeline notes, lines, scenes, beats, shots)
      requests: R.filter(r => keys.has(r.target)).map(r => ({ id: r.id, kind: r.kind, target: r.target, status: r.status, est_cost: r.est_cost })),
      costs: (C.items || []).filter(x => x.t >= a && x.t <= b) };
  },
});

Object.assign(ops, {
  // ---------------- media
  // linked: "linked" = used somewhere (an entity / shot / clip-use link, a request, a "use as", an asset node's image), "unlinked" = not
  media_list(p, { kind, entity, status, shot, q, linked, private: priv, limit = 100, offset = 0 } = {}) {
    const all = read(p, 'media.json').items || [];
    const ql = q ? String(q).toLowerCase() : '';
    let isLinked = null;
    if (linked === 'linked' || linked === 'unlinked') {
      const nodes = new Set();
      for (const e of read(p, 'entities/index.json')) { const x = readJSON(path.join(projDir(p), e.path), null); for (const n of x?.iter?.nodes || []) if (n?.image) nodes.add(String(n.image).toLowerCase()); }
      isLinked = (m) => !!((m.entities || []).length || (m.shots || []).length || (m.uses || []).length || m.request || (m.use_as || []).length || nodes.has(String(m.path).toLowerCase()));
    }
    const hit = all.filter(m => (!kind || m.kind === kind) && (!entity || m.entities?.includes(entity)) && (!status || m.status === status) && (!shot || m.shots?.includes(shot))
      && (!isLinked || isLinked(m) === (linked === 'linked')) && (priv == null || !!m.private === !!priv)
      && (!ql || `${m.id} ${m.label} ${m.path} ${m.job || ''}`.toLowerCase().includes(ql)));
    return { total: hit.length, offset, items: hit.slice(offset, offset + limit).map(m => ({ id: m.id, path: m.path, kind: m.kind, label: m.label, entities: m.entities, shots: m.shots, take: m.take, job: m.job, status: m.status, private: m.private, duration_ms: m.duration_ms, w: m.w, h: m.h, thumb: m.thumb, cost_usd: m.cost_usd,
      ...(m.request ? { request: m.request } : {}), ...(m.use_as?.length ? { use_as: m.use_as } : {}), ...(m.imported ? { imported: m.imported } : {}) })) };
  },
  media_add(p, { path: src, kind = 'still', label, entities = [], shots = [], uses = [], job, take, status = 'unused', cost_usd, private: priv, copy = true, request }) {
    if (!src) fail(400, 'path required');
    if (typeof kind !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(kind)) fail(400, 'kind: 1-32 lower-case letters, digits, _ and - (e.g. still, clip, audio)');
    const pd = projDir(p);
    let stored, abs;
    const asGiven = path.isAbsolute(src) ? path.resolve(src) : null;
    if (asGiven) {
      if (!fs.existsSync(asGiven)) fail(404, 'no such file: ' + src);
      const relP = path.relative(pd, asGiven), relBase = path.relative(CFG.mediaBase, asGiven).replace(/\\/g, '/');
      if (!relP.startsWith('..') && !path.isAbsolute(relP)) { stored = relP.replace(/\\/g, '/'); abs = asGiven; }
      else if (!relBase.startsWith('..') && isMediaRootPath(relBase)) { stored = relBase; abs = asGiven; }
      else if (copy) {
        // a copy of a private file (flagged, or from a path the PRIVATE rule matches) goes under private/ so the PRIVATE
        // path rule keeps it local wherever it is served from
        const srcPriv = priv === true || isPrivate(asGiven) || (!relBase.startsWith('..') && isPrivate(relBase));
        const top = srcPriv ? 'private' : 'media', dir = inside(pd, path.join(top, kind)); if (!dir) fail(400, 'bad kind');
        fs.mkdirSync(dir, { recursive: true });
        let name = path.basename(asGiven), n = 2; while (fs.existsSync(path.join(dir, name))) name = path.basename(asGiven).replace(/(\.\w+)?$/, `-${n++}$1`);
        fs.copyFileSync(asGiven, path.join(dir, name)); abs = path.join(dir, name); stored = `${top}/${kind}/${name}`;
      } else fail(400, 'file is outside the project and the media roots; pass copy:true to copy it into data/<project>/media/');
    } else {
      stored = src.replace(/\\/g, '/'); abs = resolveMedia(p, stored);
      if (abs) stored = isMediaRootPath(stored) ? relTo(CFG.mediaBase, abs) : relTo(pd, abs);   // canonical: no ./ or a/../
      if (!abs || !fs.existsSync(abs)) fail(404, `no such file: ${src} (give an absolute path, a path relative to the project folder, or one under a media root: ${CFG.mediaRoots.join(', ') || 'none configured'})`);
    }
    const doc = read(p, 'media.json'); doc.items ||= [];
    const dup = doc.items.find(m => String(m.path).toLowerCase() === stored.toLowerCase());   // Windows / macOS ignore case
    if (dup) return { added: false, reason: 'already indexed', media: dup };
    const ids = new Set(doc.items.map(m => m.id));
    const base = path.basename(stored).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'media';
    let id = base; for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    const pr = ffprobe(abs), isPriv = priv === true || isPrivate(stored) || isFlaggedPrivate(stored, [p]);
    const durMs = pr.dur && (VIDEO.test(abs) || AUDIO.test(abs)) ? Math.round(pr.dur * 1000) : null;
    const th = makeThumbs(abs, path.join(pd, 'thumbs'), id, { priv: isPriv, durMs, size: kind === 'sheet' ? 600 : 240 });
    const m = { id, path: stored, kind, label: label || path.basename(stored), entities: [...new Set(entities)].sort(), shots, uses, take: take ?? null, job: job ?? null, group: job || kind,
      size: fs.statSync(abs).size, w: pr.w, h: pr.h, duration_ms: durMs, ...(VIDEO.test(abs) && pr.fps ? { fps: pr.fps } : {}), private: isPriv, status: isPriv ? 'private' : status, cost_usd: cost_usd ?? null,
      thumb: th.thumb || (IMAGE.test(stored) && !isPriv ? stored : null), ...(th.strip ? { strip: th.strip, strip_n: 8 } : {}), ...(request ? { request } : {}), added: nowIso() };
    doc.items.push(m);
    doc.count = doc.items.length; doc.by_kind = doc.items.reduce((o, x) => (o[x.kind] = (o[x.kind] || 0) + 1, o), {});
    write(p, 'media.json', doc);
    return { added: true, media: m, thumbnails: th.thumb ? 'made' : 'not made (ffmpeg missing or unsupported file)' };
  },
});

Object.assign(ops, {
  // relabel / re-kind / re-link a registered file; a private flag only moves toward more private
  media_update(p, { id, path: mp, label, kind, entities, shots, uses, job, take, status, private: priv } = {}) {
    const doc = read(p, 'media.json'); doc.items ||= [];
    const m = doc.items.find(x => (id != null && x.id === id) || (mp != null && String(x.path).toLowerCase() === String(mp).replace(/\\/g, '/').toLowerCase()));
    if (!m) fail(404, `no media ${id != null ? `"${id}"` : `with path "${mp}"`} (media_list)`);
    const changed = [], ids = (v, n) => { if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || x.length > 120)) fail(400, `${n}: a list of ids`); return [...new Set(v)]; };
    if (label != null) { m.label = String(label).slice(0, 300); changed.push('label'); }
    if (kind != null) { if (typeof kind !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(kind)) fail(400, 'kind: 1-32 lower-case letters, digits, _ and -'); m.kind = kind; changed.push('kind'); }
    if (entities != null) { m.entities = ids(entities, 'entities').sort(); changed.push('entities'); }
    if (shots != null) { m.shots = ids(shots, 'shots'); changed.push('shots'); }
    if (uses != null) { m.uses = ids(uses, 'uses'); changed.push('uses'); }
    if (job !== undefined) { if (job !== null && (typeof job !== 'string' || job.length > 120)) fail(400, 'job: a request / job id or null'); m.job = job; changed.push('job'); }
    if (take !== undefined) { if (take !== null && !Number.isInteger(take)) fail(400, 'take: an integer or null'); m.take = take; changed.push('take'); }
    if (priv === false && m.private) fail(403, `${m.id} is private: a private flag only moves toward more private (it stays local, never exported)`);
    if (priv === true && !m.private) {
      m.private = true; m.status = 'private'; changed.push('private');
      // the old public thumbnail / strip goes; a private one replaces it (thumbs/priv_*)
      for (const k of ['thumb', 'strip']) if (m[k] && /^thumbs\//.test(m[k]) && !isPrivate(m[k])) { try { fs.rmSync(path.join(projDir(p), m[k]), { force: true }); } catch (e) { /* gone */ } delete m[k]; delete m.strip_n; }
      if (m.thumb === m.path) delete m.thumb;
      const abs = resolveMedia(p, m.path); if (abs && fs.existsSync(abs)) { const th = makeThumbs(abs, path.join(projDir(p), 'thumbs'), m.id, { priv: true, durMs: m.duration_ms }); if (th.thumb) m.thumb = th.thumb; }
    }
    if (status != null) {
      if (!['used', 'picked', 'unused'].includes(status)) fail(400, 'status: used, picked or unused');
      if (m.private) fail(403, `${m.id} is private: its status stays "private"`);
      m.status = status; changed.push('status');
    }
    if (!changed.length) fail(400, 'nothing to change: label, kind, entities, shots, uses, job, take, status, private: true');
    doc.by_kind = doc.items.reduce((o, x) => (o[x.kind] = (o[x.kind] || 0) + 1, o), {});
    write(p, 'media.json', doc);
    return { media: m, changed };
  },
});

// what a remote (LAN) client may read of a project JSON file: no private path, no item flagged private
export function scrubPrivate(v, projects) {
  const priv = (s) => typeof s === 'string' && (isPrivate(s) || isFlaggedPrivate(s, projects));
  if (Array.isArray(v)) return v.filter(x => !priv(x) && !(x && typeof x === 'object' && (x.private === true || priv(x.path) || priv(x.image)))).map(x => scrubPrivate(x, projects));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { if (k === 'private_refs' || k === 'private_media' || priv(x)) continue; o[k] = scrubPrivate(x, projects); } return o; }
  return v;
}
