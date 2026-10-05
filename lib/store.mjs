// Node-side data layer shared by serve.mjs (HTTP API) and mcp/server.mjs (MCP tools, offline fallback).
// Every function works on the project folders in DATA_ROOT (default workbench/data/, env WORKBENCH_DATA) and writes
// with temp file + rename. Nothing here talks to the network or to a paid API.
//
// Configuration (all optional): workbench.config.json next to serve.mjs (local, gitignored; see
// workbench.config.example.json) and environment variables, which win:
//   WORKBENCH_DATA        project folders                         (config data_dir, default ./data)
//   WB_PROJECT            default project                         (config default_project, default "demo")
//   WORKBENCH_MEDIA_BASE  folder that base-relative media live in (config media_base, default the workbench's parent)
//   config media_roots    path prefixes under media_base served read-only at /media/<path> (default none)
//   config private_media  extra regex (string) of PRIVATE paths: local only, never exported
//   config agent_approvals / WB_AGENT_APPROVALS=1   let an agent's director_approved:true approve (default: only the
//                         page approves; see README "Security model")
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as F from '../js/flow.js';
import * as SC from '../js/scenes.js';
import * as BD from '../js/breakdown.js';
import * as CH from '../js/characters.js';
import * as A from '../js/assets.js';
import * as SB from '../js/storyboard.js';

export const WB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ------------------------------------------------------------------ files
export class WbError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new WbError(code, msg); };
// a missing file reads as the default d; with strict, an unreadable / unparsable file throws instead of reading as the
// default (so a read-modify-write never overwrites a hand-broken file with the default plus one change)
export function readJSON(file, d, strict = false) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (!strict || e.code === 'ENOENT') return d;
    throw new WbError(500, `${path.basename(file)} is not valid JSON (${e.message}); fix it by hand or restore a snapshot`);
  }
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function writeJSON(file, data) { writeAtomic(file, JSON.stringify(data, null, 1)); }
// write a temp file and rename it over the target; Windows refuses the rename while another process (indexer,
// antivirus, a reader) has the file open for a moment: retry, then fall back to copying over it.
// The temp name is unique per writer, so two processes never rename each other's partial data.
export function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, bytes);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { fs.rmSync(tmp, { force: true }); throw e; }
      if (i >= 12) { fs.copyFileSync(tmp, file); fs.rmSync(tmp, { force: true }); return; }
      sleep(15 + i * 10);
    }
  }
}
export function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r)); else out.push(r);
  }
  return out;
}
export function inside(root, p) { const r = path.resolve(root, p); return r === root || r.startsWith(root + path.sep) ? r : null; }

// ------------------------------------------------------------------ configuration
export function loadConfig() {
  const file = process.env.WORKBENCH_CONFIG || path.join(WB_DIR, 'workbench.config.json');
  const c = readJSON(file, {}) || {};
  const dataRoot = path.resolve(WB_DIR, process.env.WORKBENCH_DATA || c.data_dir || 'data');
  const mediaBase = path.resolve(WB_DIR, process.env.WORKBENCH_MEDIA_BASE || c.media_base || '..');
  const privateSrc = ['(^|/)thumbs/priv_', '(^|/)private/', ...(c.private_media ? [c.private_media] : [])].join('|');
  let def = process.env.WB_PROJECT || c.default_project;
  if (!def) def = fs.existsSync(path.join(dataRoot, 'demo', 'song.json')) ? 'demo' : '_template';
  // privateRe ignores case: Windows and macOS file systems do, so Thumbs/Priv_x.jpg is the same file as thumbs/priv_x.jpg
  return { file: fs.existsSync(file) ? file : null, dataRoot, mediaBase, mediaRoots: c.media_roots || [], privateSrc,
    privateRe: new RegExp(privateSrc, 'i'), defaultProject: def, allowRemoteOps: !!(process.env.WB_ALLOW_REMOTE_OPS || c.allow_remote_ops),
    agentApprovals: !!(Number(process.env.WB_AGENT_APPROVALS) || c.agent_approvals === true),
    host: process.env.WB_HOST || c.host || null };
}
export const CFG = loadConfig();
export const DATA_ROOT = CFG.dataRoot;
export const isPrivate = (p) => typeof p === 'string' && CFG.privateRe.test(p.replace(/\\/g, '/'));
export const isMediaRootPath = (p) => typeof p === 'string' && CFG.mediaRoots.some(r => p.startsWith(r));
// a relative path from a URL or a caller: no backslash, NUL, "." or ".." segment (an encoded %2F.. would otherwise
// pass a prefix check and then resolve somewhere else)
export const cleanRel = (p) => typeof p === 'string' && !/[\\\0]/.test(p) && !p.split('/').some(s => s === '..' || s === '.');
// abs -> its path relative to root with "/" separators (what the PRIVATE rule and the media roots are written against)
export const relTo = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
// a base-relative path under a media root -> absolute file, checked after normalising; null when it escapes
export function mediaRootFile(p) {
  if (!cleanRel(p) || !isMediaRootPath(p)) return null;
  const abs = inside(CFG.mediaBase, p);
  return abs && isMediaRootPath(relTo(CFG.mediaBase, abs)) ? abs : null;
}
// a stored media path -> absolute file: base-relative under a media root, else relative to the project folder
export function resolveMedia(project, p) {
  if (!p || typeof p !== 'string') return null;
  return isMediaRootPath(p) ? mediaRootFile(p) : inside(projDir(project), p);
}
// paths flagged private:true in media.json (any project), lower-cased; cached per media.json mtime
const privCache = new Map();
export function flaggedPrivate(project) {
  const f = path.join(DATA_ROOT, project, 'media.json');
  let mt = 0; try { mt = fs.statSync(f).mtimeMs; } catch (e) { return new Set(); }
  const c = privCache.get(project); if (c && c.mt === mt) return c.set;
  const set = new Set(((readJSON(f, {}) || {}).items || []).filter(m => m.private && typeof m.path === 'string').map(m => m.path.replace(/\\/g, '/').toLowerCase()));
  privCache.set(project, { mt, set }); return set;
}
export const isFlaggedPrivate = (rel, projects) => projects.some(p => flaggedPrivate(p).has(String(rel).toLowerCase()));
export const projectIds = () => { try { return fs.readdirSync(DATA_ROOT, { withFileTypes: true }).filter(e => e.isDirectory() && validId(e.name)).map(e => e.name); } catch (e) { return []; } };

// ------------------------------------------------------------------ projects
export const WRITABLE = new Set(['approvals.json', 'notes.json', 'requests.json', 'settings.json', 'overrides.json', 'lyrics.json', 'stages.json', 'scenes.json', 'breakdown.json', 'storyboard.json']);
const DEFAULTS = {
  'approvals.json': { rev: 0, states: ['draft', 'review', 'changes', 'approved', 'locked', 'archived'], items: {} },
  'notes.json': { rev: 0, notes: [] }, 'requests.json': { rev: 0, items: [] },
  'overrides.json': { rev: 0, sections: {} }, 'settings.json': { rev: 0, keybindings: {} },
  'costs.json': { cap_usd: 0, items: [], pre_production: [], ledger: [] }, 'media.json': { items: [] },
  'shots.json': { shots: [], uses: [] }, 'events.json': [], 'entities/index.json': [], 'script.json': { stages: [], lines: [] },
};
// snapshots keep the small JSON content files only (sketches/ are files the immutable script versions point at: a
// restore must not delete them)
const SNAP_SKIP = /^(peaks|_src|thumbs|media|sketches|private\/sketches|\.snapshots)\/|^settings\.json$/;
export const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(id);
export function projDir(id, mustExist = true) {
  if (!validId(id)) fail(400, 'bad project id: ' + id);
  const d = path.join(DATA_ROOT, id);
  if (mustExist && !fs.existsSync(path.join(d, 'song.json'))) fail(404, 'no such project: ' + id);
  return d;
}
export const read = (project, file) => readJSON(path.join(projDir(project), file), structuredClone(DEFAULTS[file] ?? null), true) ?? structuredClone(DEFAULTS[file] ?? null);
export const write = (project, file, data) => writeJSON(path.join(projDir(project), file), data);
// read-modify-write a {rev} file: bump rev so the page's next save (base_rev) gets 409 and re-applies on top
export function mutate(project, file, fn) {
  const d = read(project, file); const r = fn(d); d.rev = (d.rev || 0) + 1; write(project, file, d); return r === undefined ? d : r;
}
const nowIso = () => new Date().toISOString().slice(0, 19);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'snapshot';

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
  fs.cpSync(src, dst, { recursive: true, filter: (s) => !s.includes(`${path.sep}.snapshots`) && !s.endsWith('.tmp') });
  const meta = readJSON(path.join(src, 'project.json'), {}) || {};
  writeJSON(path.join(dst, 'project.json'), { ...meta, title: to, created: nowIso(), from });
  if (resetState) for (const f of ['notes.json', 'approvals.json', 'requests.json']) writeJSON(path.join(dst, f), { ...DEFAULTS[f], rev: 1 });
  else {   // one director approval pays for one run: the copy's approved / queued / running requests go back to draft
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
const snapFiles = (dir) => walk(dir).filter(f => f.endsWith('.json') && !SNAP_SKIP.test(f));
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
const RAN = ['running', 'done', 'rejected'], LIVE = ['approved', 'queued', 'running'];
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
  } else if (f === 'approvals.json' && agent && !CFG.agentApprovals) {
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

// ------------------------------------------------------------------ helpers for the ops
// times: integer ms, or "m:ss(.mmm)" / "h:mm:ss" strings
export function ms(v, name = 'time') {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) fail(400, `${name}: expected ms or m:ss.mmm, got ${JSON.stringify(v)}`);
  return Math.round((Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}
export const tc = (t) => { const s = Math.max(0, t) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };
const overlaps = (a0, a1, t0, t1) => a0 < Math.max(t1, t0 + 1) && (a1 ?? a0 + 1) > t0;
const sum = (a, f) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const shotsDoc = (p) => read(p, 'shots.json');
const stateOf = (A, k) => A.items?.[k]?.state || 'draft';
function nextId(list, prefix) { const n = list.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, '')) || 0), 0) + 1; return `${prefix}${String(n).padStart(2, '0')}`; }
function timeOfKey(project, key) {
  if (!key) return null;
  const i = key.indexOf(':'), k = i < 0 ? '' : key.slice(0, i), id = i < 0 ? key : key.slice(i + 1);
  const sh = shotsDoc(project), song = read(project, 'song.json');
  if (k === 'shot') return sh.shots.find(s => s.id === id)?.t0 ?? null;
  if (k === 'use') return sh.uses.find(u => u.id === id)?.t0 ?? null;
  if (k === 'section') return song.sections.find(s => s.id === id)?.t0 ?? null;
  if (k === 'line') return song.lines.find(l => l.id === id)?.t0 ?? null;
  return sh.shots.find(s => s.id === id)?.t0 ?? sh.uses.find(u => u.id === id)?.t0 ?? null;
}
function ffmpeg(args) { try { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore', timeout: 60000 }); return r.status === 0; } catch (e) { return false; } }
function ffprobe(file) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_type:format=duration', '-of', 'json', file], { encoding: 'utf8', timeout: 30000 });
    const j = JSON.parse(r.stdout || '{}'); const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
    const d = Number(j.format?.duration);
    return { w: v.width || null, h: v.height || null, dur: Number.isFinite(d) ? d : null };
  } catch (e) { return { w: null, h: null, dur: null }; }
}
const VIDEO = /\.(mp4|webm|mov|mkv)$/i, AUDIO = /\.(wav|mp3|m4a|flac|ogg)$/i, IMAGE = /\.(png|jpe?g|webp|gif)$/i;
// thumbnail (max `size` px) + an 8-frame hover-scrub strip for videos, as the importer makes them
export function makeThumbs(absSrc, outDir, id, { priv = false, size = 240, durMs = null, name = null } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  // a thumbnail of a private source is private too, whatever name the caller gives it (thumbs/priv_* is the PRIVATE rule)
  const nm = name ? (priv && !/^priv_/i.test(name) ? 'priv_' + name : name) : (priv ? 'priv_' : 'm_') + id;
  const thumb = `thumbs/${nm}.jpg`, o = path.join(path.dirname(outDir), thumb);
  const box = `scale=${size}:${size}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  let ok = false, strip = null;
  if (AUDIO.test(absSrc)) ok = ffmpeg(['-i', absSrc, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=240x48:colors=#6aa9ff', '-frames:v', '1', '-q:v', '5', o]);
  else if (VIDEO.test(absSrc)) {
    ok = ffmpeg(['-ss', (Math.min(1, (durMs || 0) / 2000)).toFixed(2), '-i', absSrc, '-frames:v', '1', '-vf', box, '-q:v', '5', o]);
    if (ok && durMs && !priv) {
      const s = `thumbs/s_${id}.jpg`, dur = durMs / 1000;
      if (ffmpeg(['-i', absSrc, '-vf', `fps=${(8 / dur).toFixed(4)},scale=-2:68,tile=8x1`, '-frames:v', '1', '-q:v', '6', path.join(path.dirname(outDir), s)])) strip = s;
    }
  } else if (IMAGE.test(absSrc)) ok = ffmpeg(['-i', absSrc, '-frames:v', '1', '-vf', box, '-q:v', '5', o]);
  return { thumb: ok ? thumb : null, strip };
}

// ------------------------------------------------------------------ ops (one per MCP tool; also POST /api/op/<name>)
// Each op is (project, args) -> plain JSON. Writes go through mutate()/write(); the server's file watcher pushes the
// change to every open page.
export const REQUEST_STATUSES = ['draft', 'approved', 'queued', 'running', 'done', 'rejected'];
const DIRECTOR_STATES = ['approved', 'locked'];   // item states only the director sets
const DIRECTOR_ONLY = 'only the director approves or locks items: ask them; pass director_approved:true only when they said so in this conversation';
const PAGE_ONLY = 'agent approvals are off: the director approves in the open page (click the chip, or A on the selection; requests in Review > Queue). '
  + 'Show it with ui_focus. (workbench.config.json "agent_approvals": true lets director_approved:true from an agent count)';
// the agent surface (ops, MCP) may approve only when the director said so AND the owner allowed agent approvals
const directorGate = (director_approved) => { if (!director_approved) fail(403, DIRECTOR_ONLY); if (!CFG.agentApprovals) fail(403, PAGE_ONLY); };
// a request may be queued / run only on a director approval recorded after its last draft: one the page made (serve.mjs
// stamps via:"page" on /api/save) or, with agent_approvals, an agent's director_approved:true. A status typed into
// requests.json by hand has no such entry and is refused.
export function approvalOk(r) {
  const log = r.log || [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i] || {};
    if (e.status === 'draft' || e.status === 'rejected') return false;
    if (e.status === 'approved' && (e.via === 'page' || (e.via === 'agent' && e.director_approved && CFG.agentApprovals))) return true;
  }
  return false;
}
const NEXT = {   // allowed status moves; "approved" from draft needs director_approved (the human said so)
  draft: ['approved', 'rejected'], approved: ['draft', 'queued', 'running', 'rejected'], queued: ['running', 'approved', 'rejected'],
  running: ['done', 'queued', 'rejected'], done: [], rejected: ['draft'],
};
export function costSummary(project) {
  const C = read(project, 'costs.json'), R = read(project, 'requests.json').items || [];
  const spent = +sum(C.items || [], x => x.usd).toFixed(2);
  const committed = +sum(R.filter(r => ['approved', 'queued', 'running'].includes(r.status)), r => r.est_cost).toFixed(2);
  const drafts = +sum(R.filter(r => r.status === 'draft'), r => r.est_cost).toFixed(2);
  const cap = Number(C.cap_usd) || 0;
  return { cap_usd: cap, spent_usd: spent, committed_usd: committed, drafts_usd: drafts, remaining_usd: cap ? +(cap - spent - committed).toFixed(2) : null,
    other_usd: +sum(C.pre_production || [], x => x.usd).toFixed(2), ...(C.fal_total_usd != null ? { provider_total_usd: C.fal_total_usd } : {}),
    jobs: (C.items || []).length, recent: (C.items || []).slice(-10) };
}

export const ops = {
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
    const s = read(p, 'song.json'), sh = shotsDoc(p), A = read(p, 'approvals.json'), N = read(p, 'notes.json'), S = read(p, 'script.json');
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
      notes: N.notes.filter(n => n.t >= a && n.t <= Math.max(b, a)),
      requests: R.filter(r => keys.has(r.target)).map(r => ({ id: r.id, kind: r.kind, target: r.target, status: r.status, est_cost: r.est_cost })),
      costs: (C.items || []).filter(x => x.t >= a && x.t <= b) };
  },
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
      notes: read(p, 'notes.json').notes.filter(n => n.about === key || (n.t >= t0 && n.t < t1)),
      requests: (read(p, 'requests.json').items || []).filter(r => r.target === key || uses.some(u => r.target === 'use:' + u.id)),
      media: media.filter(m => (shot && m.shots?.includes(id)) || (use && m.uses?.includes(id))).map(m => ({ id: m.id, path: m.path, kind: m.kind, label: m.label })).slice(0, 40) };
  },
  // status -> approvals.json; note -> notes.json; take / in_ms / file (clip uses) and title (shots) -> shots.json
  shot_update(p, { id, status, comment, take, in_ms, file, title, note, by = 'agent', director_approved = false }) {
    const sh = shotsDoc(p);
    if (status && DIRECTOR_STATES.includes(status)) directorGate(director_approved);   // before any write
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
  // ---------------- media
  media_list(p, { kind, entity, status, shot, q, limit = 100, offset = 0 } = {}) {
    const all = read(p, 'media.json').items || [];
    const ql = q ? String(q).toLowerCase() : '';
    const hit = all.filter(m => (!kind || m.kind === kind) && (!entity || m.entities?.includes(entity)) && (!status || m.status === status) && (!shot || m.shots?.includes(shot))
      && (!ql || `${m.id} ${m.label} ${m.path} ${m.job || ''}`.toLowerCase().includes(ql)));
    return { total: hit.length, offset, items: hit.slice(offset, offset + limit).map(m => ({ id: m.id, path: m.path, kind: m.kind, label: m.label, entities: m.entities, shots: m.shots, take: m.take, job: m.job, status: m.status, private: m.private, duration_ms: m.duration_ms, w: m.w, h: m.h, thumb: m.thumb, cost_usd: m.cost_usd })) };
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
      size: fs.statSync(abs).size, w: pr.w, h: pr.h, duration_ms: durMs, private: isPriv, status: isPriv ? 'private' : status, cost_usd: cost_usd ?? null,
      thumb: th.thumb || (IMAGE.test(stored) && !isPriv ? stored : null), ...(th.strip ? { strip: th.strip, strip_n: 8 } : {}), ...(request ? { request } : {}), added: nowIso() };
    doc.items.push(m);
    doc.count = doc.items.length; doc.by_kind = doc.items.reduce((o, x) => (o[x.kind] = (o[x.kind] || 0) + 1, o), {});
    write(p, 'media.json', doc);
    return { added: true, media: m, thumbnails: th.thumb ? 'made' : 'not made (ffmpeg missing or unsupported file)' };
  },
  // ---------------- notes
  notes_list(p, { status, t0, t1, by } = {}) {
    const a = ms(t0) ?? -Infinity, b = ms(t1) ?? Infinity;
    return read(p, 'notes.json').notes.filter(n => (!status || n.status === status) && (!by || n.by === by) && n.t >= a && n.t <= b).map(n => ({ ...n, time: tc(n.t) }));
  },
  note_add(p, { t, text, line_id, about, by = 'agent', reply_to }) {
    if (!text) fail(400, 'text required');
    const tm = ms(t, 't'); if (tm == null) fail(400, 't required (ms or m:ss.mmm)');
    let line = line_id;
    if (!line) { const L = read(p, 'song.json').lines.filter(l => l.t0 <= tm).pop(); line = L && tm <= L.t1 + 2000 ? L.id : null; }
    return mutate(p, 'notes.json', (d) => {
      // via:"agent": written through the agent surface, whatever `by` says (the page's own notes have no via)
      const n = { id: nextId(d.notes, 'n'), t: tm, line_id: line || null, by, via: 'agent', text: String(text), status: 'open', at: nowIso(), ...(about ? { about } : {}), ...(reply_to ? { reply_to } : {}) };
      d.notes.push(n); d.notes.sort((x, y) => x.t - y.t); return n;
    });
  },
  note_resolve(p, { id, reply, by = 'agent', reopen = false }) {
    const r = mutate(p, 'notes.json', (d) => {
      const n = d.notes.find(x => x.id === id); if (!n) fail(404, `no note "${id}"`);
      n.status = reopen ? 'open' : 'resolved'; n.resolved_by = by; n.resolved_at = nowIso(); return { ...n };
    });
    const answer = reply ? ops.note_add(p, { t: r.t, text: reply, line_id: r.line_id, about: r.about, by, reply_to: id }) : null;
    if (answer && !reopen) mutate(p, 'notes.json', (d) => { const n = d.notes.find(x => x.id === answer.id); if (n) n.status = 'resolved'; });
    return { note: r, ...(answer ? { reply: answer.id } : {}) };
  },
  // ---------------- approvals
  approvals_get(p, { keys, prefix, state } = {}) {
    const A = read(p, 'approvals.json');
    const items = Object.entries(A.items || {}).filter(([k, v]) => (!keys || keys.includes(k)) && (!prefix || k.startsWith(prefix)) && (!state || v.state === state));
    const counts = {}; for (const v of Object.values(A.items || {})) counts[v.state] = (counts[v.state] || 0) + 1;
    return { states: A.states, counts, items: Object.fromEntries(items), ...(keys ? { missing_are_draft: keys.filter(k => !A.items?.[k]) } : {}) };
  },
  set_states(p, { keys, state, comment, by = 'agent', director_approved = false }) {
    if (!Array.isArray(keys) || !keys.length) fail(400, 'keys: a non-empty list like ["shot:c1-desk", "use:G05@20158"]');
    for (const k of keys) if (typeof k !== 'string' || !/^[a-z-]+:.+/.test(k)) fail(400, `bad key "${k}" (kind:id)`);
    const states = read(p, 'approvals.json').states || DEFAULTS['approvals.json'].states;
    if (!states.includes(state)) fail(400, `state must be one of ${states.join(', ')}`);
    if (DIRECTOR_STATES.includes(state)) directorGate(director_approved);
    mutate(p, 'approvals.json', (d) => { for (const k of keys) d.items[k] = { ...(d.items[k] || {}), state, by, via: 'agent', at: nowIso(), ...(comment ? { comment } : {}) }; });
    return { state, keys };
  },
  // ---------------- generation requests
  requests_list(p, { status, target } = {}) {
    return (read(p, 'requests.json').items || []).filter(r => (!status || r.status === status) && (!target || r.target === target));
  },
  request_create(p, { kind, target, prompt, refs = [], est_cost, look, tool, by = 'agent', extra, char, asset }) {
    if (!kind) fail(400, 'kind required');
    if (est_cost == null || !(Number(est_cost) >= 0)) fail(400, 'est_cost (USD, a number >= 0) is required: the director approves against the cap');
    // an asset generation (stages 4 and 5) names the tree it grows (asset_iteration_add reads it back): `asset` {type, id,
    // tree, from, kind}, or the stage-4 `char` {id, ...} for a character; a character's link is stored under both names
    const ln = asset ?? extra?.asset, lc = char ?? extra?.char;
    if (ln != null || lc != null) {
      const type = ln != null ? assetType(ln?.type) : 'character', link = checkAssetLink(p, ln ?? lc, type);
      const { char: _c, asset: _a, ...ex } = (extra && typeof extra === 'object') ? extra : {};
      target ||= `${type}:${link.id}`; extra = { ...ex, asset: { type, ...link }, ...(type === 'character' ? { char: link } : {}) };
    }
    // extra goes first and never carries lifecycle fields: a new request is always a draft
    const { id: _i, status: _s, log: _l, by: _b, at: _a, est_cost: _e, outputs: _o, actual_cost_usd: _c, why: _w, ...rest } = (extra && typeof extra === 'object') ? extra : {};
    const item = { ...rest, id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`, kind, target: target || null, prompt: prompt || '', refs, est_cost: Number(est_cost),
      status: 'draft', by, at: nowIso(), ...(tool ? { tool } : {}), ...(look ? { look } : {}), log: [{ at: nowIso(), by, via: 'agent', status: 'draft' }] };
    mutate(p, 'requests.json', (d) => { d.items.push(item); });
    return item;
  },
  request_update(p, { id, status, prompt, refs, est_cost, outputs, actual_cost_usd, why, tool, by = 'agent', director_approved = false, register_media = true, media_kind }) {
    const cur = (read(p, 'requests.json').items || []).find(r => r.id === id);
    if (!cur) fail(404, `no request "${id}"`);
    // the tool/model is part of what the director approved; at done, `tool` only names what ran (recorded in costs.json)
    const toolEdit = tool != null && tool !== cur.tool && status !== 'done';
    const patch = {}, edits = prompt != null || refs != null || est_cost != null || toolEdit;
    if (edits) {
      if (!['draft', 'approved'].includes(cur.status)) fail(409, `request ${id} is ${cur.status}: only draft or approved requests can be edited`);
      if (est_cost != null && !(Number(est_cost) >= 0)) fail(400, 'est_cost: a number >= 0');
      if (prompt != null) patch.prompt = prompt; if (refs != null) patch.refs = refs; if (est_cost != null) patch.est_cost = Number(est_cost); if (toolEdit) patch.tool = tool;
      if (cur.status === 'approved') {     // an edit voids the approval, whatever status the same call asks for
        if (status && status !== 'draft') fail(409, `request ${id} is approved: an edit (prompt/refs/est_cost/tool) voids the approval and sends it back to draft; ask the director to approve it again`);
        status = 'draft';
      }
    }
    if (status && status !== cur.status) {
      if (!REQUEST_STATUSES.includes(status)) fail(400, `status must be one of ${REQUEST_STATUSES.join(', ')}`);
      if (!NEXT[cur.status].includes(status)) fail(409, `cannot move a ${cur.status} request to ${status} (allowed: ${NEXT[cur.status].join(', ') || 'none'})`);
      if (status === 'approved' && cur.status === 'draft') {
        if (!director_approved) fail(403, 'only the director approves requests: ask them (or they click the chip in Review > Queue); pass director_approved:true only when they said so in this conversation');
        directorGate(true);
      }
      if ((status === 'queued' || status === 'running') && !approvalOk(cur)) fail(403, `request ${id} has no director approval on record (approved in the page${CFG.agentApprovals ? ' or by director_approved:true' : ''}): ask the director to approve it in Review > Queue`);
      if (status === 'queued' || status === 'running') {
        const c = costSummary(p), est = Number(patch.est_cost ?? cur.est_cost) || 0;
        const others = ['approved', 'queued', 'running'].includes(cur.status) ? c.committed_usd - (Number(cur.est_cost) || 0) : c.committed_usd;
        if (c.spent_usd + others + est > c.cap_usd + 1e-9) fail(402, `over the cap: spent $${c.spent_usd} + committed $${others.toFixed(2)} + this $${est} > cap $${c.cap_usd}; ask the director to raise costs.json cap_usd or reject something`);
      }
      if (status === 'done') {
        if (!Array.isArray(outputs) || !outputs.length) fail(400, 'done needs outputs: [paths of the generated files]');
        if (actual_cost_usd == null || !(Number(actual_cost_usd) >= 0)) fail(400, 'done needs actual_cost_usd (what the provider charged, 0 if free)');
      }
      if (status === 'rejected' && !why && cur.status !== 'draft') fail(400, 'rejected needs why (what failed)');
      patch.status = status;
    }
    if (outputs) patch.outputs = outputs;
    if (actual_cost_usd != null) patch.actual_cost_usd = Number(actual_cost_usd);
    if (why) patch.why = why;
    let registered = [];
    if (patch.status === 'done') {
      const usd = Number(actual_cost_usd), t = timeOfKey(p, cur.target) ?? 0;
      const C = read(p, 'costs.json'); C.items ||= [];
      C.items.push({ id: cur.id, t, usd, tool: tool || cur.tool || cur.kind, date: nowIso().slice(0, 10), request: cur.id });
      C.items.sort((a, b) => a.t - b.t); write(p, 'costs.json', C);
      if (register_media) for (const [i, o] of outputs.entries()) {
        try { const r = ops.media_add(p, { path: o, kind: media_kind || (VIDEO.test(o) ? 'clip' : AUDIO.test(o) ? 'audio' : 'still'), label: `${cur.kind} ${cur.target || ''} · ${cur.id}`.trim(), job: cur.id, take: i, cost_usd: +(usd / outputs.length).toFixed(3), request: cur.id,
          ...((cur.refs || []).some(x => isPrivate(x) || isFlaggedPrivate(x, [p])) ? { private: true } : {}),   // made from a private photo: private too
          entities: /^(character|location|prop):/.test(cur.target || '') ? [cur.target.split(':')[1]] : [] }); registered.push(r.media.path); }
        catch (e) { registered.push(`(not indexed: ${o}: ${e.message})`); }
      }
      if (registered.length) patch.outputs = registered.map((r, i) => r.startsWith('(') ? outputs[i] : r);
    }
    const item = mutate(p, 'requests.json', (d) => {
      const r = d.items.find(x => x.id === id);
      Object.assign(r, patch, { at: nowIso() });
      if (patch.status) (r.log ||= []).push({ at: nowIso(), by, via: 'agent', status: patch.status, ...(patch.status === 'approved' && cur.status === 'draft' ? { director_approved: true } : {}), ...(why ? { why } : {}) });
      return { ...r };
    });
    return { request: item, ...(patch.status === 'done' ? { cost_recorded_usd: Number(actual_cost_usd), media: registered, costs: costSummary(p) } : {}) };
  },
  costs_get(p) { return costSummary(p); },
};

// ------------------------------------------------------------------ the guided flow: stages + lyrics (docs/SPEC_v3_GUIDED.md)
// Formats and the shared logic live in js/flow.js (the page imports the same file). Rules: an agent may set a stage to
// empty / in_progress / needs_you and write blockers; only the page marks a stage done (serve.mjs stamps done_by/via
// "page" on /api/save/stages.json) and an agent cannot move a done stage. Every lyrics save is a new version; the song's
// lines follow the current version (syncLyrics), keeping the timings of lines that still exist.
export function projectFacts(p) {
  const d = projDir(p), idx = readJSON(path.join(d, 'entities', 'index.json'), []) || [];
  let scenes = null; try { scenes = scenesDoc(p); } catch (e) { /* a broken scenes.json: the facts read as no script */ }
  const breakdown = readJSON(path.join(d, 'breakdown.json'), null);
  let storyboard = null; try { storyboard = SB.normBoard(readJSON(path.join(d, 'storyboard.json'), null), read(p, 'shots.json'), scenes); } catch (e) { /* read as no storyboard */ }
  return F.projectFacts({ song: read(p, 'song.json'), script: read(p, 'script.json'), shots: read(p, 'shots.json').shots, entities: idx, lyrics: readJSON(path.join(d, 'lyrics.json'), null), scenes, breakdown, storyboard });
}
const sectionLabels = (p) => Object.fromEntries(Object.entries(read(p, 'overrides.json').sections || {}).filter(([, v]) => v?.label).map(([k, v]) => [k, v.label]));
export function lyricsDoc(p) { return F.normLyrics(readJSON(path.join(projDir(p), 'lyrics.json'), null, true), read(p, 'song.json'), sectionLabels(p)); }
// read-modify-write lyrics.json (a derived doc is written the first time anything changes)
function mutateLyrics(p, fn) {
  const d = lyricsDoc(p); const r = fn(d); delete d.derived;
  F.checkLyrics(d); d.rev = (d.rev || 0) + 1; write(p, 'lyrics.json', d); return r === undefined ? d : r;
}
// an empty stage becomes in_progress once its file holds something (a project without stages.json stays derived)
function startStage(p, id) {
  const cur = readJSON(path.join(projDir(p), 'stages.json'), null);
  if (!cur || F.normStages(cur, projectFacts(p)).stages.find(s => s.id === id)?.status !== 'empty') return;
  mutateStages(p, (d) => { const s = d.stages.find(x => x.id === id); s.status = 'in_progress'; s.updated = nowIso(); });
}
function mutateStages(p, fn) {
  const cur = readJSON(path.join(projDir(p), 'stages.json'), null, true);
  const d = F.normStages(cur, projectFacts(p)); delete d.derived;
  const r = fn(d); d.rev = (cur?.rev || 0) + 1; write(p, 'stages.json', d); return r === undefined ? d : r;
}
// song.json lines <- the current lyrics version; writes only when something changed. An empty lyrics stage becomes
// in_progress once there is a poem.
export function syncLyrics(p, { reestimate = false } = {}) {
  const doc = lyricsDoc(p), v = F.currentVersion(doc); if (!v) return { changed: false };
  const song = read(p, 'song.json'), next = F.syncSong(song, v, { reestimate });
  if (next !== song) write(p, 'song.json', next);
  const st = readJSON(path.join(projDir(p), 'stages.json'), null);
  if (F.flatLines(v).length && F.normStages(st, projectFacts(p)).stages[0].status === 'empty') mutateStages(p, (d) => { d.stages[0].status = 'in_progress'; d.stages[0].updated = nowIso(); });
  return { changed: next !== song, lines: next.lines.length, timing: next.timing || null, duration_ms: next.duration_ms, has_audio: !!next.audio?.mix };
}
// the page saved a shared file (serve.mjs calls this after the write)
export function afterPageSave(p, name, data, cur) {
  if (name === 'breakdown.json' && (data.versions || []).length) startStage(p, 'breakdown');
  if (name === 'storyboard.json' && (data.versions || []).some(v => v.via === 'page')) startStage(p, 'storyboard');
  if (name === 'lyrics.json') {
    const a = (cur.versions || []).find(v => v.id === cur.current), b = (data.versions || []).find(v => v.id === data.current);
    if (!a || !F.sameBody(a, b)) syncLyrics(p);
  }
}
const lineIndex = (v) => { const m = new Map(); for (const l of F.flatLines(v)) m.set(l.id, l); return m; };
function noteView(n, v) {
  const l = lineIndex(v).get(n.line);
  return { ...n, line_text: l?.text ?? null, section: l?.label ?? null, words_now: l ? F.anchorWords(l.text, n) : null, ...(l || !n.line ? {} : { detached: 'the line is not in the current version' }) };
}
Object.assign(ops, {
  stages_get(p) {
    const f = projectFacts(p);
    return { ...F.stagesView(readJSON(path.join(projDir(p), 'stages.json'), null, true), f), facts: f,
      rules: 'agents may set empty / in_progress / needs_you and blockers (stage_update); only the director marks a stage done, in the page (stage rail or the stage workspace)' };
  },
  stage_update(p, { stage, status, blockers, note, by = 'agent' } = {}) {
    if (!F.stageById(stage)) fail(400, `stage must be one of ${F.STAGES.map(s => s.id).join(', ')}`);
    if (status != null && !F.STAGE_STATUSES.includes(status)) fail(400, `status must be one of ${F.STAGE_STATUSES.join(', ')}`);
    if (status === 'done') fail(403, 'only the director marks a stage done, in the page (stage rail or the stage workspace). Set needs_you and say why (note); show it with ui_focus view "stage"');
    if (blockers != null && (!Array.isArray(blockers) || blockers.some(b => typeof b !== 'string'))) fail(400, 'blockers: a list of short strings');
    return mutateStages(p, (d) => {
      const s = d.stages.find(x => x.id === stage);
      if (s.status === 'done' && status && status !== 'done') fail(409, `stage ${stage} is done (the director marked it): ask them to reopen it in the page`);
      if (status) s.status = status;
      if (blockers) s.blockers = blockers.map(String).slice(0, 12);
      if (note != null) s.note = String(note);
      Object.assign(s, { updated: nowIso(), updated_by: by });
      if (s.status !== 'done') s.via = 'agent';
      return { stage: { ...s }, next: F.stagesView(d, projectFacts(p)).next };
    });
  },
  lyrics_get(p, { version, notes = 'open' } = {}) {
    const doc = lyricsDoc(p), v = version ? doc.versions.find(x => x.id === version) : F.currentVersion(doc);
    if (version && !v) fail(404, `no version "${version}" (lyrics_versions lists them)`);
    const song = read(p, 'song.json'), timing = new Map(song.lines.map(l => [l.id, l]));
    const ns = doc.notes.filter(n => notes === 'all' || n.status === notes);
    return { current: doc.current, version: v ? { id: v.id, created: v.created, by: v.by, via: v.via, message: v.message } : null, derived: !!doc.derived,
      text: F.versionText(v),
      sections: (v?.sections || []).map(s => ({ id: s.id, label: s.label, lines: s.lines.map(l => { const t = timing.get(l.id); return { id: l.id, text: l.text, ...(t ? { t0: t.t0, t1: t.t1, ...(t.timing ? { timing: t.timing } : {}) } : {}) }; }) })),
      song: { has_audio: !!song.audio?.mix, duration_ms: song.duration_ms, placeholder_duration: !!song.placeholder_duration, timing: song.timing || null },
      versions: doc.versions.length, notes: ns.map(n => noteView(n, v)),
      asks_for_agent: doc.notes.filter(n => n.status === 'open' && n.to === 'agent').map(n => ({ id: n.id, line: n.line, quote: n.quote, text: n.text, replies: n.replies?.length || 0 })) };
  },
  // a new version from text (with [Section] tags) or from sections [{label, lines: [{id?, text}]}], or a copy of an
  // older version (restore); ids of unchanged / reworded lines are kept; the song's lines follow
  lyrics_update(p, { text, sections, restore, message = '', by = 'agent' } = {}) {
    if ([text, sections, restore].filter(x => x != null).length !== 1) fail(400, 'give exactly one of text, sections or restore');
    let r;
    mutateLyrics(p, (d) => {
      const prev = F.currentVersion(d);
      let body;
      if (restore != null) { const old = d.versions.find(v => v.id === restore); if (!old) fail(404, `no version "${restore}"`); body = structuredClone(old.sections); }
      else if (text != null) { if (typeof text !== 'string' || text.length > 200000) fail(400, 'text: a string up to 200 kB'); body = F.assignIds(F.parseText(text), prev, d).sections; }
      else {
        if (!Array.isArray(sections)) fail(400, 'sections: [{label, lines: [{id?, text}]}]');
        const blocks = sections.map(s => ({ label: String(s?.label || 'Part'), lines: (s?.lines || []).map(l => ({ text: String(typeof l === 'string' ? l : l?.text || '').replace(/\s*\n\s*/g, ' ').trim() })).filter(l => l.text) }));
        body = F.assignIds(blocks, prev, d).sections;
      }
      if (prev && F.sameBody(prev.sections, body)) { r = { version: prev.id, unchanged: true }; return; }
      const v = F.addVersion(d, body, { by, via: 'agent', message: restore ? (message || `restore ${restore}`) : message, ...(restore ? { from: restore } : {}) });
      r = { version: v.id, lines: F.flatLines(v).length, sections: v.sections.length };
    });
    return { ...r, song: syncLyrics(p) };
  },
  lyrics_versions(p, { diff, id } = {}) {
    const doc = lyricsDoc(p);
    if (diff) {
      if (!Array.isArray(diff) || diff.length !== 2) fail(400, 'diff: [older version id, newer version id]');
      const [a, b] = diff.map(x => doc.versions.find(v => v.id === x)); if (!a || !b) fail(404, `no such version: ${diff.join(', ')}`);
      const d = F.wordDiff(F.versionText(a), F.versionText(b));
      const show = d.map(o => o.w === '\n' ? (o.op === '-' ? '' : '\n') : o.op === '=' ? o.w : o.op === '-' ? `[-${o.w}-]` : `{+${o.w}+}`).join(' ').replace(/ ?\n ?/g, '\n');
      return { a: a.id, b: b.id, ...F.diffStats(d), diff: show };
    }
    if (id) { const v = doc.versions.find(x => x.id === id); if (!v) fail(404, `no version "${id}"`); return { ...v, text: F.versionText(v), current: v.id === doc.current }; }
    return { current: doc.current, derived: !!doc.derived, versions: doc.versions.map(v => ({ id: v.id, created: v.created, by: v.by, via: v.via, message: v.message, from: v.from, lines: F.flatLines(v).length, current: v.id === doc.current })) };
  },
  // a note on a line (or a word range of it), a reply in a thread (reply_to), or an ask for the agent (to "agent")
  lyrics_note_add(p, { line, words, quote, text, reply_to, to, by = 'agent' } = {}) {
    if (!text || typeof text !== 'string') fail(400, 'text required');
    return mutateLyrics(p, (d) => {
      if (reply_to) {
        const n = d.notes.find(x => x.id === reply_to); if (!n) fail(404, `no lyrics note "${reply_to}"`);
        const r = { id: `${n.id}.${(n.replies?.length || 0) + 1}`, text, by, via: 'agent', at: nowIso() };
        (n.replies ||= []).push(r); return { note: n.id, reply: r };
      }
      const v = F.currentVersion(d), L = line ? lineIndex(v).get(line) : null;
      if (line && !L) fail(404, `no line "${line}" in the current version (lyrics_get lists the line ids)`);
      let w = null, q = '';
      if (L && (words || quote)) {
        const ws = F.words(L.text);
        if (words) { const [a, b] = (Array.isArray(words) ? words : []).map(Number); if (!(a >= 0 && b >= a && b < ws.length)) fail(400, `words: [first, last] word index on the line (0..${ws.length - 1})`); w = [a, b]; }
        else { const at = F.anchorWords(L.text, { w: [-1, -1], quote }); if (!at) fail(404, `"${quote}" is not on line ${line}`); w = at; }
        q = ws.slice(w[0], w[1] + 1).join(' ');
      }
      const n = { id: nextId(d.notes, 'ln'), line: L ? line : null, w, quote: q, text, by, via: 'agent', ...(to ? { to: String(to) } : {}), status: 'open', at: nowIso(), version: d.current, replies: [] };
      d.notes.push(n); return noteView(n, v);
    });
  },
  lyrics_note_resolve(p, { id, reply, reopen = false, by = 'agent' } = {}) {
    return mutateLyrics(p, (d) => {
      const n = d.notes.find(x => x.id === id); if (!n) fail(404, `no lyrics note "${id}"`);
      if (reply) (n.replies ||= []).push({ id: `${n.id}.${(n.replies?.length || 0) + 1}`, text: String(reply), by, via: 'agent', at: nowIso() });
      n.status = reopen ? 'open' : 'resolved'; n.resolved_by = by; n.resolved_at = nowIso();
      return { ...n };
    });
  },
  // add (or replace) the song file: decode, waveform peaks, energy, beat grid, duration; the lyric lines get timings
  // (LRC tags when the lyrics had them, else estimated, as the importer does)
  async song_attach(p, { path: src, bpm, beats_per_bar, offset } = {}) {
    const I = await import('../importers/new_project.mjs');
    return I.attachSong(p, src, { bpm, beatsPerBar: beats_per_bar, offset });
  },
});
// a new project from the wizard (page) or the projects tool: lyrics text (optional) and a song file (optional, a path
// on this machine); without a song the project has a placeholder duration and estimated timings until one is added
export async function createGuidedProject({ id, title, lyrics = '', song, bpm } = {}) {
  if (typeof lyrics !== 'string' || lyrics.length > 200000) fail(400, 'lyrics: text up to 200 kB');
  if (song != null && (typeof song !== 'string' || !AUDIO.test(song))) fail(400, 'song: path of an audio file (wav, mp3, m4a, flac, ogg)');
  createProject(id, title);
  try {
    write(id, 'stages.json', { rev: 1, stages: F.STAGES.map(x => ({ id: x.id, status: 'empty', blockers: [] })) });
    const s = read(id, 'song.json');
    write(id, 'song.json', { ...s, ...(bpm ? F.beatGrid(s.duration_ms, Number(bpm) || 120, s.beats_per_bar || 4) : {}), title: title || id });
    if (lyrics.trim()) {
      const doc = F.emptyLyrics(); const body = F.assignIds(F.parseText(lyrics), null, doc).sections;
      F.addVersion(doc, body, { by: 'director', via: 'page', message: 'first draft' }); doc.rev = 1;
      write(id, 'lyrics.json', doc);
      syncLyrics(id);
    }
    const attached = song ? await ops.song_attach(id, { path: song, bpm }) : null;
    return { id, title: title || id, lines: read(id, 'song.json').lines.length, song: attached };
  } catch (e) { fs.rmSync(projDir(id, false), { recursive: true, force: true }); throw e; }
}

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
const sketchId = (id) => { if (typeof id !== 'string' || !SC.SKETCH_ID.test(id)) fail(400, 'sketch id: 1-64 lower-case letters, digits, _ and - (starting with a letter or digit)'); return id; };
// where a sketch's files are now: {dir, json, png, mask} (relative to the project) or null
function sketchFiles(p, id) {
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
const sketchUse = (p) => { const v = SC.currentScript(scenesDoc(p)), m = new Map(); for (const s of v?.scenes || []) for (const k of s.sketches) (m.get(k) || m.set(k, []).get(k)).push(s.id); return m; };
function sketchView(p, id, { full = false, uses } = {}) {
  const f = sketchFiles(p, id); if (!f) fail(404, `no sketch "${id}" (sketch_list lists them)`);
  const pd = projDir(p), s = readJSON(path.join(pd, f.json), {}, true) || {};
  const abs = (r) => r ? path.join(pd, r) : null;
  return { id, w: s.w, h: s.h, title: s.title || null, png: f.png, mask_png: f.mask, json: f.json, files: { png: abs(f.png), mask: abs(f.mask), json: abs(f.json) },
    url: `/data/${p}/${f.png}`, private: f.dir !== 'sketches', underlay: s.underlay || null, pins: s.pins || [], strokes: (s.strokes || []).length, mask_strokes: (s.mask || []).length,
    scenes: (uses || sketchUse(p)).get(id) || [], updated: s.updated || null, by: s.by || null, via: s.via || null, ...(full ? { sketch: s } : {}) };
}
function scenesView(p, v, doc) {
  const song = read(p, 'song.json'), L = new Map(song.lines.map(l => [l.id, l])), uses = sketchUse(p);
  const notes = doc.notes.filter(n => n.status === 'open');
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
    const ns = doc.notes.filter(n => notes === 'all' || n.status === notes);
    return { current: doc.current, derived: !!doc.derived, version: v ? { id: v.id, created: v.created, by: v.by, via: v.via, message: v.message, from: v.from } : null,
      duration_ms: song.duration_ms, coverage: +SC.coverage(v?.scenes || [], song.duration_ms).toFixed(3),
      gaps: g.map(([a, b]) => ({ t0: a, t1: b, time: SC.span(a, b), lines: SC.linesIn(song, a, b).map(l => ({ id: l.id, text: l.text })) })),
      scenes: scenesView(p, v, doc),
      intake: { unanswered: SC.intakeOpen(doc), answered: SC.INTAKE.length - SC.intakeOpen(doc).length, of: SC.INTAKE.length, note: 'intake_get for the questions and answers' },
      notes: ns.map(n => sceneNoteView(n, v)),
      asks_for_agent: doc.notes.filter(n => n.status === 'open' && n.to === 'agent').map(n => ({ id: n.id, scene: n.scene, kind: n.kind || 'request', text: n.text, ...(n.gaps ? { gaps: n.gaps } : {}), replies: n.replies?.length || 0 })),
      versions: doc.versions.map(x => ({ id: x.id, created: x.created, by: x.by, via: x.via, message: x.message, from: x.from, scenes: x.scenes.length, current: x.id === doc.current })),
      legacy_script_lines: (read(p, 'script.json').lines || []).length,
      rules: 'scenes_update writes a NEW version (never destructive); status ok is the director\'s (page); fill the gaps = add scenes covering the gaps listed here' };
  },
  // a new version of the whole script: scenes = the full list; or upsert (merge by id, a scene without id is new) and
  // remove (ids); or restore = an old version id. status sets per-scene statuses (draft / needs_you; ok is the
  // director's). snap ("lines" | "bars" | "sections") snaps t0 / t1 of the scenes written.
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
    const song = read(p, 'song.json');
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
          let c; try { c = SC.cleanScene({ ...(old || { title: '', text: '', beats: [], sketches: [] }), ...x, id }, song, { snap }); } catch (e) { fail(400, e.message); }
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
      const cur = SC.currentScript(d), warnings = [];
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
  // for the agent (to "agent")
  scene_note_add(p, { scene, beat, text, reply_to, to, by = 'agent' } = {}) {
    if (!text || typeof text !== 'string') fail(400, 'text required');
    return mutateScenes(p, (d) => {
      if (reply_to) {
        const n = d.notes.find(x => x.id === reply_to); if (!n) fail(404, `no scene note "${reply_to}"`);
        const r = { id: `${n.id}.${(n.replies?.length || 0) + 1}`, text, by, via: 'agent', at: nowIso() };
        (n.replies ||= []).push(r); return { note: n.id, reply: r };
      }
      const v = SC.currentScript(d), S = scene ? v?.scenes.find(x => x.id === scene) : null;
      if (scene && !S) fail(404, `no scene "${scene}" in the current version (script_get lists them)`);
      if (beat && !S?.beats.some(b => b.id === beat)) fail(404, `no beat "${beat}" in scene ${scene}`);
      const n = { id: SC.nextNoteId(d), scene: S ? scene : null, ...(beat ? { beat } : {}), text, by, via: 'agent', ...(to ? { to: String(to) } : {}), status: 'open', at: nowIso(), version: d.current, replies: [] };
      d.notes.push(n); return sceneNoteView(n, v);
    });
  },
  scene_note_resolve(p, { id, reply, reopen = false, by = 'agent' } = {}) {
    return mutateScenes(p, (d) => {
      const n = d.notes.find(x => x.id === id); if (!n) fail(404, `no scene note "${id}"`);
      if (reply) (n.replies ||= []).push({ id: `${n.id}.${(n.replies?.length || 0) + 1}`, text: String(reply), by, via: 'agent', at: nowIso() });
      n.status = reopen ? 'open' : 'resolved'; n.resolved_by = by; n.resolved_at = nowIso();
      return { ...n };
    });
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

// ------------------------------------------------------------------ stage 3: the breakdown (breakdown.json)
// Formats and the shared logic live in js/breakdown.js. Rules: every breakdown_update is a NEW version (nothing is
// overwritten; restore copies an old one); an item's status "ok" is the director's (page only; an agent sets "review"
// to ask); turning an item into an entity (breakdown_promote) is the page's act only: serve.mjs passes via "page" for a
// same-origin browser request, the MCP server has no such tool, and nothing is generated or spent by it.
export function breakdownDoc(p) { return BD.normBreakdown(readJSON(path.join(projDir(p), 'breakdown.json'), null, true)); }
function mutateBreakdown(p, fn) {
  const d = breakdownDoc(p); const r = fn(d);
  try { BD.checkBreakdown(d); } catch (e) { fail(400, e.message); }
  d.rev = (d.rev || 0) + 1; write(p, 'breakdown.json', d); return r === undefined ? d : r;
}
function bdNoteView(n, v) { const it = (v?.items || []).find(x => x.id === n.item); return { ...n, item_name: it?.name ?? null, ...(it || !n.item ? {} : { detached: 'the item is not in the current version' }) }; }
// what an agent may not write on an item (the page's own fields)
const BD_PAGE_FIELDS = ['status', 'entity_id', 'look_id', 'source'];
Object.assign(ops, {
  breakdown_get(p, { version, diff, notes = 'open', kind, scene, with_script = true } = {}) {
    const doc = breakdownDoc(p);
    if (diff) {
      if (!Array.isArray(diff) || diff.length !== 2) fail(400, 'diff: [older version id, newer version id]');
      const [a, b] = diff.map(x => doc.versions.find(v => v.id === x)); if (!a || !b) fail(404, `no such version: ${diff.join(', ')}`);
      const d = F.wordDiff(BD.breakdownText(a), BD.breakdownText(b));
      const show = d.map(o => o.w === '\n' ? (o.op === '-' ? '' : '\n') : o.op === '=' ? o.w : o.op === '-' ? `[-${o.w}-]` : `{+${o.w}+}`).join(' ').replace(/ ?\n ?/g, '\n');
      return { a: a.id, b: b.id, ...F.diffStats(d), items: BD.itemChanges(a, b), diff: show };
    }
    if (kind != null && !BD.KINDS.includes(kind)) fail(400, `kind: one of ${BD.KINDS.join(', ')}`);
    const v = version ? doc.versions.find(x => x.id === version) : BD.currentBreakdown(doc);
    if (version && !v) fail(404, `no version "${version}" (breakdown_get lists the versions)`);
    const sdoc = scenesDoc(p), sv = SC.currentScript(sdoc), scenes = sv?.scenes || [], sIds = new Map(scenes.map(s => [s.id, s]));
    const all = (v?.items || []).map(it => {
      const st = doc.states[it.id] || {}, missing = it.links.filter(l => !sIds.has(l.scene)).map(l => l.scene);
      return { ...it, status: st.status || 'draft', ...(st.entity_id ? { entity_id: st.entity_id } : {}), ...(st.look_id ? { look_id: st.look_id } : {}), ...(missing.length ? { missing_scenes: missing } : {}) };
    });
    const items = all.filter(i => (!kind || i.kind === kind) && (!scene || i.links.some(l => l.scene === scene)));
    const live = all.filter(i => !i.dropped);
    const ns = doc.notes.filter(n => notes === 'all' || n.status === notes);
    const uses = with_script ? sketchUse(p) : null, I = sdoc.intake || {};
    return { current: doc.current, version: v ? { id: v.id, created: v.created, by: v.by, via: v.via, message: v.message, from: v.from, script: v.script || null } : null,
      script_current: sdoc.current, ...(v?.script && v.script !== sdoc.current ? { script_changed: `this breakdown was made from script ${v.script}; the script is now ${sdoc.current}: check new or changed scenes` } : {}),
      counts: Object.fromEntries(BD.KINDS.map(k => [k, live.filter(i => i.kind === k).length])), dropped: all.length - live.length,
      items,
      scenes: scenes.map(s => ({ id: s.id, time: SC.span(s.t0, s.t1), title: s.title, items: live.filter(i => i.links.some(l => l.scene === s.id)).map(i => i.id) })),
      scenes_without_characters: scenes.filter(s => !live.some(i => i.kind === 'character' && i.links.some(l => l.scene === s.id))).map(s => s.id),
      entities: read(p, 'entities/index.json').map(e => ({ id: e.id, kind: e.kind, name: e.name })),
      notes: ns.map(n => bdNoteView(n, v)),
      asks_for_agent: doc.notes.filter(n => n.status === 'open' && n.to === 'agent').map(n => ({ id: n.id, item: n.item, scene: n.scene || null, kind: n.kind || 'request', text: n.text, replies: n.replies?.length || 0 })),
      versions: doc.versions.map(x => ({ id: x.id, created: x.created, by: x.by, via: x.via, message: x.message, from: x.from, script: x.script, items: x.items.length, current: x.id === doc.current })),
      ...(with_script ? {
        script: { version: sdoc.current, scenes: scenes.map(s => ({ id: s.id, time: SC.span(s.t0, s.t1), title: s.title, text: s.text, beats: s.beats.map(b => ({ id: b.id, t: b.t, text: b.text })),
          sketches: s.sketches.map(k => { try { const x = sketchView(p, k, { uses }); return { id: k, png: x.files.png, pins: x.pins }; } catch (e) { return { id: k, missing: true }; } }) })) },
        intake: Object.fromEntries(['who', 'where', 'era', 'must', 'mustnot'].map(k => [k, I[k]?.text || null])),
      } : {}),
      rules: 'breakdown_update writes a NEW version (never destructive); item status ok is the director\'s (page); only the page turns an item into an entity (set status "review" and say why in a note to ask); nothing here generates or spends' };
  },
  // a new version of the whole breakdown: items = the full list; or upsert (merge by id, an item without id is new) and
  // remove (ids); or restore = an old version id. status sets per-item statuses (draft / review; ok is the director's).
  breakdown_update(p, { items, upsert, remove, restore, status, message = '', by = 'agent' } = {}) {
    const modes = [items != null, upsert != null || remove != null, restore != null].filter(Boolean).length;
    if (modes > 1 || (!modes && status == null)) fail(400, 'give one of items (the full list), upsert / remove, or restore; or only status');
    if (status != null) {
      if (typeof status !== 'object' || Array.isArray(status)) fail(400, 'status: {<item id>: "draft" | "review"}');
      for (const [k, v] of Object.entries(status)) {
        if (!BD.ITEM_ID.test(k)) fail(400, `status: bad item id "${k}"`);
        if (v === 'ok') fail(403, `only the director marks an item ok, in the page; set "review" and say why in a note (breakdown_note_add) (${k})`);
        if (!BD.ITEM_STATUSES.includes(v)) fail(400, `status of ${k}: draft or review`);
      }
    }
    const sdoc = scenesDoc(p), scenes = SC.currentScript(sdoc)?.scenes || [], sIds = new Map(scenes.map(s => [s.id, s]));
    let r = {}; const warnings = [];
    mutateBreakdown(p, (d) => {
      const prev = BD.currentBreakdown(d);
      let body = null;
      if (restore != null) { const old = d.versions.find(v => v.id === restore); if (!old) fail(404, `no version "${restore}"`); body = structuredClone(old.items); }
      else if (items != null || upsert != null || remove != null) {
        if (items != null && !Array.isArray(items)) fail(400, 'items: [{id?, kind, name, description, links: [{scene, beats?, note?}], aliases?, for?, dropped?}]');
        if (upsert != null && !Array.isArray(upsert)) fail(400, 'upsert: a list of items (partial: only the fields to change; no id = a new item)');
        if (remove != null && (!Array.isArray(remove) || remove.some(x => typeof x !== 'string' || !BD.ITEM_ID.test(x)))) fail(400, 'remove: a list of item ids');
        const base = items != null ? [] : structuredClone(prev?.items || []), draft = [...base];
        const old = new Map((prev?.items || []).map(s => [s.id, s])), byId = new Map(base.map(s => [s.id, s]));
        for (const id of remove || []) { if (!byId.has(id)) fail(404, `no item "${id}" in the current version`); draft.splice(draft.indexOf(byId.get(id)), 1); byId.delete(id); }
        for (const x0 of items || upsert || []) {
          if (!x0 || typeof x0 !== 'object') fail(400, 'every item is an object');
          const x = { ...x0 };
          if (x.id != null && !BD.ITEM_ID.test(String(x.id))) fail(400, `item id "${String(x.id).slice(0, 60)}": letters, digits, _ and - (up to 40)`);
          for (const k of BD_PAGE_FIELDS) if (k in x) { if (k !== 'source') warnings.push(`${x.id || x.name}: ${k} ignored (${k === 'status' ? 'use status {}' : 'set by the page'})`); delete x[k]; }
          const cur = x.id != null ? byId.get(String(x.id)) : null;
          if (upsert && x.id != null && !cur) fail(404, `no item "${x.id}" to update (leave id out for a new item)`);
          const id = cur?.id ?? (x.id != null ? String(x.id) : BD.nextItemId(d, draft));
          if (!cur && byId.has(id)) fail(400, `duplicate item id "${id}"`);
          const was = cur || old.get(id);
          let c; try { c = BD.cleanItem({ ...(cur || { description: '', links: [] }), ...x, id, source: was?.source || 'agent' }); } catch (e) { fail(400, e.message); }
          if (cur) draft[draft.indexOf(cur)] = c; else draft.push(c);
          byId.set(id, c);
        }
        body = draft;
      }
      if (body) {
        if (prev && BD.sameItems(prev.items, body)) r = { version: prev.id, unchanged: true };
        else { const v = BD.addBreakdownVersion(d, body, { by, via: 'agent', message: restore ? (message || `restore ${restore}`) : message, ...(restore ? { from: restore } : {}), script: sdoc.current || undefined }); r = { version: v.id, items: v.items.length }; }
      }
      for (const [k, v] of Object.entries(status || {})) d.states[k] = { ...(d.states[k] || {}), status: v, by, via: 'agent', at: nowIso() };
      if (status) r.status = status;
      const cur = BD.currentBreakdown(d)?.items || [], names = new Map();
      for (const it of cur) {
        for (const l of it.links) {
          const s = sIds.get(l.scene);
          if (!s) warnings.push(`${it.id}: scene "${l.scene}" is not in the current script`);
          else for (const b of l.beats) if (!s.beats.some(x => x.id === b)) warnings.push(`${it.id}: beat "${b}" is not in ${l.scene}`);
        }
        if (it.kind === 'wardrobe' && it.for && !cur.some(x => x.id === it.for && x.kind === 'character')) warnings.push(`${it.id}: for "${it.for}" is not a character item`);
        const key = `${it.kind}:${it.name.toLowerCase()}`; if (names.has(key) && !it.dropped) warnings.push(`${it.id} and ${names.get(key)}: the same ${it.kind} name (merge them?)`); else names.set(key, it.id);
      }
      for (const k of Object.keys(status || {})) if (!cur.some(i => i.id === k)) warnings.push(`status for "${k}": no such item in the current version`);
    });
    if (warnings.length) r.warnings = [...new Set(warnings)];
    if (r.version && !r.unchanged) startStage(p, 'breakdown');
    return r;
  },
  // a note on an item (or a scene), with neither for the whole breakdown, a reply in a thread (reply_to), or an ask for
  // the agent (to "agent")
  breakdown_note_add(p, { item, scene, text, reply_to, to, by = 'agent' } = {}) {
    if (!text || typeof text !== 'string') fail(400, 'text required');
    if (scene != null && (typeof scene !== 'string' || !SC.SCENE_ID.test(scene))) fail(400, 'scene: a scene id');
    return mutateBreakdown(p, (d) => {
      if (reply_to) {
        const n = d.notes.find(x => x.id === reply_to); if (!n) fail(404, `no breakdown note "${reply_to}"`);
        const r = { id: `${n.id}.${(n.replies?.length || 0) + 1}`, text, by, via: 'agent', at: nowIso() };
        (n.replies ||= []).push(r); return { note: n.id, reply: r };
      }
      const v = BD.currentBreakdown(d), it = item ? v?.items.find(x => x.id === item) : null;
      if (item && !it) fail(404, `no item "${item}" in the current version (breakdown_get lists them)`);
      if (scene && !SC.currentScript(scenesDoc(p))?.scenes.some(s => s.id === scene)) fail(404, `no scene "${scene}" in the current script`);
      const n = { id: BD.nextBdNoteId(d), item: it ? item : null, ...(scene ? { scene } : {}), text, by, via: 'agent', ...(to ? { to: String(to) } : {}), status: 'open', at: nowIso(), version: d.current, replies: [] };
      d.notes.push(n); return bdNoteView(n, v);
    });
  },
  breakdown_note_resolve(p, { id, reply, reopen = false, by = 'agent' } = {}) {
    return mutateBreakdown(p, (d) => {
      const n = d.notes.find(x => x.id === id); if (!n) fail(404, `no breakdown note "${id}"`);
      if (reply) (n.replies ||= []).push({ id: `${n.id}.${(n.replies?.length || 0) + 1}`, text: String(reply), by, via: 'agent', at: nowIso() });
      n.status = reopen ? 'open' : 'resolved'; n.resolved_by = by; n.resolved_at = nowIso();
      return { ...n };
    });
  },
  // "Create entity" (the page only): a character / location / prop item becomes an entity in entities/ (a draft, no
  // images: nothing is generated or spent), or is linked to an existing one (entity_id); a wardrobe item becomes a look
  // on a character (character = its entity id, default the entity of the character the item is for). unlink: forget
  // the link (the entity stays). via: set by serve.mjs ("page" for a same-origin browser request, else "agent").
  breakdown_promote(p, { item, entity_id, character, unlink = false, via = 'agent' } = {}) {
    if (via !== 'page') fail(403, 'only the director turns a breakdown item into an entity, in the page (Breakdown stage: Create entity). Ask with breakdown_update status {<item>: "review"} and a note (breakdown_note_add); show it with ui_focus view "stage"');
    if (typeof item !== 'string' || !BD.ITEM_ID.test(item)) fail(400, 'item: an item id');
    for (const [k, v] of [['entity_id', entity_id], ['character', character]]) if (v != null && !validId(v)) fail(400, `${k}: an entity id`);
    const doc = breakdownDoc(p), it = BD.currentBreakdown(doc)?.items.find(x => x.id === item);
    if (!it) fail(404, `no item "${item}" in the current version (save your edits first)`);
    const stamp = { by: 'director', via: 'page', at: nowIso() };
    if (unlink) {
      return mutateBreakdown(p, (d) => { const s = d.states[item]; if (!s?.entity_id) fail(409, `${item} is not linked to an entity`); delete s.entity_id; delete s.look_id; Object.assign(s, stamp); return { item, unlinked: true }; });
    }
    if (it.dropped) fail(409, `${item} is dropped: restore it first`);
    if (!BD.PROMOTABLE.includes(it.kind)) fail(400, 'FX items stay in the breakdown (they become shots and requests later); only characters, locations, props and wardrobe become entities');
    if (doc.states[item]?.entity_id) fail(409, `${item} is already ${doc.states[item].entity_id}${doc.states[item].look_id ? ' / ' + doc.states[item].look_id : ''}`);
    const idx = read(p, 'entities/index.json'), info = { item: it.id, scenes: BD.itemScenes(it), at: stamp.at };
    const desc = /^suggested from /.test(it.description) ? '' : it.description;
    let res;
    if (it.kind === 'wardrobe') {
      const cid = character || (it.for && doc.states[it.for]?.entity_id);
      if (!cid) fail(400, 'wardrobe becomes a look on a character: choose the character (an entity), or turn the character it is for into an entity first');
      const ce = idx.find(e => e.id === cid);
      if (!ce || ce.kind !== 'character') fail(404, `no character entity "${cid}"`);
      const ent = readJSON(path.join(projDir(p), ce.path), {}, true) || {}, used = new Set((ent.looks || []).map(l => l.id));
      let lid = BD.slug(it.name); for (let n = 2; used.has(lid); n++) lid = `${BD.slug(it.name)}-${n}`;
      ops.entity_upsert(p, { kind: 'character', id: cid, look: { id: lid, name: it.name, garments: [it.name], colors: [], images: [], notes: desc, status: 'draft', breakdown: info } });
      res = { entity_id: cid, look_id: lid, created: 'look' };
    } else if (entity_id) {
      const e = idx.find(x => x.id === entity_id);
      if (!e) fail(404, `no entity "${entity_id}"`);
      if (e.kind !== it.kind) fail(409, `${entity_id} is a ${e.kind}, the item a ${it.kind}`);
      res = { entity_id, created: false };
    } else {
      const taken = new Set(idx.map(e => e.id.toLowerCase()));
      let id = BD.slug(it.name); for (let n = 2; taken.has(id); n++) id = `${BD.slug(it.name)}-${n}`;
      ops.entity_upsert(p, { kind: it.kind, id, name: it.name, fields: { status: 'draft', refs: [], [it.kind === 'character' ? 'role' : 'description']: desc, ...(it.kind === 'character' ? { looks: [] } : {}), ...(it.aliases?.length ? { aliases: it.aliases } : {}), breakdown: info } });
      res = { entity_id: id, created: true };
    }
    mutateBreakdown(p, (d) => { d.states[item] = { ...(d.states[item] || {}), status: 'ok', entity_id: res.entity_id, ...(res.look_id ? { look_id: res.look_id } : {}), ...stamp }; });
    return { item, kind: it.kind, ...res };
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
const assetType = (t) => { const x = t == null || t === '' ? 'character' : String(t); if (!Object.hasOwn(A.TYPE, x)) fail(400, 'type: character, location or prop'); return x; };
const treeHint = (type) => `"${A.TYPE[type].root}" or "${A.TYPE[type].vprefix}:<${A.TYPE[type].vWord} id>"`;
function assetEntry(p, type, id) {
  if (!validId(id)) fail(400, `id: a ${type} entity id`);
  const e = read(p, 'entities/index.json').find(x => x.id === id);
  if (!e || e.kind !== type) fail(404, type === 'character' ? `no character "${id}" (character_get without id lists them; the director makes one from the breakdown)` : `no ${type} "${id}" (asset_get {type: "${type}"} lists them; the director makes one from the breakdown)`);
  return e;
}
function readAsset(p, type, id) { const e = assetEntry(p, type, id); const ent = readJSON(path.join(projDir(p), e.path), {}, true) || {}; ent.iter = A.normIter(ent.iter); return { rel: e.path, ent }; }
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
function checkAssetLink(p, c, type) {
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
function sketchInfo(p, id) { if (!id) return null; try { const v = sketchView(p, id); return { id, png: v.png, mask: v.mask_png, files: v.files, pins: v.pins, private: v.private }; } catch (e) { return { id, missing: true }; } }
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
      out.rules = 'the director makes an entity in the page (Breakdown: Create entity); every generation is a request_create draft with asset {type, id, tree, from, kind} (char for a character); run approved ones only, then asset_iteration_add';
      return out;
    }
    if (!type) { const e = read(p, 'entities/index.json').find(x => x.id === id); type = e?.kind; }
    type = assetType(type);
    const T = A.TYPE[type], { ent } = readAsset(p, type, id), it = ent.iter, vs = A.variants(ent, type);
    const trees = [T.root, ...vs.map(v => A.variantTree(type, v.id))].map(t => ({ tree: t, ...A.treeState(it, t), nodes: A.treeNodes(it, t).map(n => nodeView(p, n)), branches: A.branches(it, t).map(b => ({ fork: b.fork, nodes: b.nodes.map(n => n.id) })) }));
    const reqs = A.assetRequests(R, type, id).map(r => { const L = A.linkOf(r); return { id: r.id, kind: r.kind, status: r.status, est_cost: r.est_cost, tool: r.tool, prompt: r.prompt, refs: r.refs, ref_files: (r.refs || []).map(x => refFile(p, x)),
      tree: L.tree, from: L.from, [type === 'character' ? 'char_kind' : 'gen_kind']: L.kind, text: L.text || null, pins: L.pins || [], sketch: sketchInfo(p, L.sketch), mask_png: L.mask || null,
      outputs: r.outputs || [], nodes: it.nodes.filter(n => n.request === r.id).map(n => n.id), approved_by_director: approvalOk(r) }; });
    const ns = it.notes.filter(n => notes === 'all' || n.status === notes);
    const script = SC.currentScript(scenesDoc(p))?.scenes || [];
    const vView = (v) => { const t = A.variantTree(type, v.id); return { id: v.id, name: v.name, status: v.status || 'draft', from: v.from || null, notes: v.notes || '', tree: t, head: A.treeState(it, t).head || null, approved: A.treeState(it, t).approved || null, breakdown: v.breakdown || null,
      ...(type === 'character' ? { garments: v.garments || [], colors: v.colors || [] } : { axes: v.axes || {}, scenes: v.scenes || [] }) }; };
    const vname = (vid) => vid ? (vs.find(v => v.id === vid)?.name || vid) : T.rootWord;
    return { type, id: ent.id, name: ent.name, ...(type === 'character' ? { role: ent.role || null } : { description: ent.description || null }), breakdown: ent.breakdown || null,
      status: type === 'character' ? CH.charStatus(ent, R) : A.assetStatus(ent, R, type),
      base: ent.base ? { ...ent.base, refs: (ent.base.refs || []).map(r => ({ ...r, file: refFile(p, r.path) })) } : null,
      root_tree: T.root, root_approved: A.treeState(it, T.root).approved || null, ...(type === 'character' ? { identity_approved: A.treeState(it, 'identity').approved || null } : {}),
      [T.vfield]: vs.map(vView), trees, requests: reqs,
      scenes: A.sceneUses(ent, assetScenes(bd, ent), script, type).map(u => ({ ...u, variant_name: vname(u.variant), image: A.variantImage(ent, u.variant, type) })),
      to_run: reqs.filter(r => ['approved', 'queued', 'running'].includes(r.status) && r.approved_by_director).map(r => r.id),
      to_register: reqs.filter(r => r.status === 'done' && !r.nodes.length).map(r => r.id),
      waiting_for_director: it.nodes.filter(n => A.pending(it, n)).map(n => n.id),
      notes: ns, asks_for_agent: it.notes.filter(n => n.status === 'open' && n.to === 'agent').map(n => ({ id: n.id, tree: n.tree || null, node: n.node || null, scene: n.scene || null, text: n.text, replies: n.replies?.length || 0 })),
      log: it.log.slice(-20),
      rules: `propose generations with request_create (${type === 'character' ? 'char {id, tree, from, kind}' : `asset {type: "${type}", id, tree, from, kind}`}, refs, tool, honest est_cost); run only approved ones (request_update queued -> running -> done with outputs + actual cost), then asset_iteration_add {type, id, request}; keep / branch / revert, approving the ${T.rootWord} or a ${T.vWord} and the ${T.vWord} each scene uses are the director's, in the page` };
  },
  character_get(p, { id, notes } = {}) {
    if (id) return ops.asset_get(p, { type: 'character', id, notes });
    const r = ops.asset_get(p, { type: 'character' });
    return { characters: r.characters, not_entities_yet: r.not_entities_yet.map(({ kind: _k, ...x }) => x), rules: 'the director makes a character an entity in the page (Breakdown: Create entity); every generation is a request_create draft with char {id, tree, from, kind}; run approved ones only, then character_iteration_add' };
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
  // a note on the asset, a tree, a node or a scene's use of it; a reply in a thread (reply_to); resolve: true closes it
  asset_note_add(p, { type, id, text, tree, node, scene, reply_to, resolve = false, to, by = 'agent' } = {}) {
    type = assetType(type);
    if (!reply_to && (!text || typeof text !== 'string')) fail(400, 'text required');
    if (tree != null && !A.treeOk(type, String(tree))) fail(400, `tree: ${treeHint(type)}`);
    if (scene != null && !sceneIdOk(scene)) fail(400, 'scene: a scene id (sc03)');
    return mutateAsset(p, type, id, (ent, it) => {
      if (reply_to) {
        const n = it.notes.find(x => x.id === reply_to); if (!n) fail(404, `no ${type} note "${reply_to}"`);
        if (text) (n.replies ||= []).push({ id: `${n.id}.${(n.replies?.length || 0) + 1}`, text: String(text).slice(0, 8000), by, via: 'agent', at: nowIso() });
        if (resolve) { n.status = 'resolved'; n.resolved_by = by; n.resolved_at = nowIso(); }
        return { ...n };
      }
      if (node != null && !A.nodeById(it, String(node))) fail(404, `no node "${node}" on ${id}`);
      const n = { id: A.nextNoteId(it, type), ...(tree ? { tree } : {}), ...(node ? { node: String(node), tree: A.nodeById(it, String(node)).tree } : {}), ...(scene ? { scene } : {}),
        text: String(text).slice(0, 8000), by, via: 'agent', ...(to ? { to: String(to) } : {}), status: 'open', at: nowIso(), replies: [] };
      it.notes.push(n); return n;
    });
  },
  character_note_add(p, a = {}) { return ops.asset_note_add(p, { ...a, type: 'character' }); },
  // a new look (costume) proposed by an agent: always status "review" (the director approves looks in the page)
  look_create(p, { id, look_id, name, garments = [], colors = [], description = '', from_item, by = 'agent' } = {}) {
    if (!name || typeof name !== 'string') fail(400, 'name required');
    const lid = look_id || BD.slug(name);
    if (!validId(lid)) fail(400, 'look_id: letters, digits, _ and -');
    if (from_item != null && !BD.ITEM_ID.test(String(from_item))) fail(400, 'from_item: a breakdown item id');
    const { ent } = readAsset(p, 'character', id);
    if ((ent.looks || []).some(l => l.id === lid)) fail(409, `${id} already has a look "${lid}"`);
    const arr = (v) => (Array.isArray(v) ? v : []).map(x => String(x).slice(0, 200)).slice(0, 40);
    ops.entity_upsert(p, { kind: 'character', id, look: { id: lid, name: name.slice(0, 200), garments: arr(garments), colors: arr(colors), images: [], notes: String(description).slice(0, 4000), status: 'review', from: 'agent', by, via: 'agent', at: nowIso(), ...(from_item ? { breakdown: { item: String(from_item) } } : {}) } });
    mutateAsset(p, 'character', id, (e, it) => { logAct(it, { by, via: 'agent', act: 'look', tree: CH.lookTree(lid) }); });
    return { id, look: lid, tree: CH.lookTree(lid), status: 'review', note: `the director approves looks in the page; a look sheet needs the approved identity and a request (char {tree: "look:${lid}", from: <identity node>, kind: "look"})` };
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
    const arr = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean).slice(0, 40);
    const out = mutateAsset(p, type, id, (ent, it) => {
      const tree = a.tree == null ? null : String(a.tree);
      if (tree && !A.treeOk(type, tree)) fail(400, `tree: ${treeHint(type)}`);
      const locked = (t) => { if (A.treeState(it, t).approved) fail(409, `${t} is approved (locked): unlock it first`); };
      const vOf = (t) => { const vid = A.treeVariant(t); return vid ? A.variants(ent, type).find(x => x.id === vid) || null : null; };
      if (act === 'base') {
        const b = a.base && typeof a.base === 'object' ? a.base : {};
        const refs = (Array.isArray(b.refs) ? b.refs : []).slice(0, 24).map((r, i) => {
          if (!r || typeof r.path !== 'string' || !cleanRel(r.path) || r.path.length > 300) fail(400, `base.refs[${i}].path`);
          if (!A.REF_SOURCES.includes(r.source)) fail(400, `base.refs[${i}].source: one of ${A.REF_SOURCES.join(', ')}`);
          if (!refFile(p, r.path)) fail(404, `base.refs[${i}]: no such file ${r.path}`);
          const priv = refPrivate(p, r.path);
          if (r.source === 'photo' && !priv) fail(400, `base.refs[${i}]: a photo must be uploaded as private (ref_upload)`);
          const s = (k, n = 500) => (typeof r[k] === 'string' && r[k] ? { [k]: r[k].slice(0, n) } : {});
          return { path: r.path, source: r.source, ...(priv ? { private: true } : {}), ...s('title', 200), ...s('licence', 60), ...s('licence_url'), ...s('creator', 200), ...s('url'), ...s('original'), ...s('attribution', 1000), ...s('catalog_id', 80), ...s('openverse_id', 80) };
        });
        ent.base = { text: String(b.text || '').slice(0, 8000), refs, at: nowIso(), ...stamp };
        logAct(it, { ...stamp, act: 'base', detail: `${refs.length} refs` });
        return { base: ent.base };
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
          ? { id: vid, name: name.slice(0, 200), garments: arr(a.garments), colors: arr(a.colors), images: [], notes: String(a.notes || '').slice(0, 4000), status: 'draft', from: 'page', at: nowIso() }
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
      if (act === 'note') {
        if (!a.text) fail(400, 'text required');
        const node = a.node ? A.nodeById(it, String(a.node)) : null; if (a.node && !node) fail(404, `no node "${a.node}"`);
        if (a.scene != null && !sceneIdOk(a.scene)) fail(400, 'scene: a scene id');
        const n = { id: A.nextNoteId(it, type), ...(tree ? { tree } : {}), ...(node ? { node: node.id, tree: node.tree } : {}), ...(a.scene ? { scene: a.scene } : {}), text: String(a.text).slice(0, 8000), ...stamp, ...(a.to === 'agent' ? { to: 'agent' } : {}), status: 'open', at: nowIso(), replies: [] };
        it.notes.push(n); return n;
      }
      if (act === 'reply' || act === 'resolve') {
        const n = it.notes.find(x => x.id === a.note); if (!n) fail(404, `no note "${a.note}"`);
        if (act === 'reply') (n.replies ||= []).push({ id: `${n.id}.${(n.replies?.length || 0) + 1}`, text: String(a.text || '').slice(0, 8000), ...stamp, at: nowIso() });
        else { n.status = n.status === 'open' ? 'resolved' : 'open'; n.resolved_by = 'director'; n.resolved_at = nowIso(); }
        return { ...n };
      }
      fail(400, `act: base, choose, head, approve, unlock, ${type === 'character' ? 'look_new, look_status' : 'variant_new, variant_status'}, use, note, reply, resolve`);
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
    const ns = doc.notes.filter(n => notes === 'all' || n.status === notes);
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
      asks_for_agent: doc.notes.filter(n => n.status === 'open' && n.to === 'agent').map(n => ({ id: n.id, shot: n.shot || null, scene: n.scene || null, kind: n.kind || 'request', text: n.text, ...(n.gaps ? { gaps: n.gaps } : {}), replies: n.replies?.length || 0 })),
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
  // a note on a shot (or a scene), with neither for the whole storyboard, a reply in a thread (reply_to), or an ask
  shot_note_add(p, { shot, scene, text, reply_to, to, by = 'agent' } = {}) {
    if (!text || typeof text !== 'string') fail(400, 'text required');
    if (shot != null && (typeof shot !== 'string' || !SB.SHOT_ID.test(shot))) fail(400, 'shot: a shot id');
    if (scene != null && (typeof scene !== 'string' || !SC.SCENE_ID.test(scene))) fail(400, 'scene: a scene id');
    return mutateBoard(p, (d) => {
      if (reply_to) {
        const n = d.notes.find(x => x.id === reply_to); if (!n) fail(404, `no storyboard note "${reply_to}"`);
        const r = { id: `${n.id}.${(n.replies?.length || 0) + 1}`, text: String(text).slice(0, 8000), by, via: 'agent', at: nowIso() };
        (n.replies ||= []).push(r); return { note: n.id, reply: r };
      }
      const v = SB.currentBoard(d), s = shot ? v?.shots.find(x => x.id === shot) : null;
      if (shot && !s) fail(404, `no shot "${shot}" in the current version (storyboard_get lists them)`);
      if (scene && !SC.currentScript(scenesDoc(p))?.scenes.some(x => x.id === scene)) fail(404, `no scene "${scene}" in the current script`);
      const n = { id: SB.nextNoteId(d), shot: s ? shot : null, ...(scene || s?.scene ? { scene: scene || s.scene } : {}), text: String(text).slice(0, 8000), by, via: 'agent', ...(to ? { to: String(to) } : {}), status: 'open', at: nowIso(), version: d.current, replies: [] };
      d.notes.push(n); return boardNoteView(n, v);
    });
  },
  shot_note_resolve(p, { id, reply, reopen = false, by = 'agent' } = {}) {
    return mutateBoard(p, (d) => {
      const n = d.notes.find(x => x.id === id); if (!n) fail(404, `no storyboard note "${id}"`);
      if (reply) (n.replies ||= []).push({ id: `${n.id}.${(n.replies?.length || 0) + 1}`, text: String(reply).slice(0, 8000), by, via: 'agent', at: nowIso() });
      n.status = reopen ? 'open' : 'resolved'; n.resolved_by = by; n.resolved_at = nowIso();
      return { ...n };
    });
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
      asks_for_agent: doc.notes.filter(n => n.status === 'open' && n.to === 'agent' && n.kind === 'fill_gaps').map(n => ({ id: n.id, text: n.text, gaps: n.gaps || null })),
      rules: 'propose each generation with request_create (draft; target "shot:<id>", the prompt, refs, tool and an honest est_cost from proposals; the start frame before its video); approved assets first (asset_get / request_create with asset); the director approves in the page; run only approved requests; then answer the ask (shot_note_resolve)' };
  },
});
function imageExt(b) {
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  return null;
}
// what a remote (LAN) client may read of a project JSON file: no private path, no item flagged private
export function scrubPrivate(v, projects) {
  const priv = (s) => typeof s === 'string' && (isPrivate(s) || isFlaggedPrivate(s, projects));
  if (Array.isArray(v)) return v.filter(x => !priv(x) && !(x && typeof x === 'object' && (x.private === true || priv(x.path) || priv(x.image)))).map(x => scrubPrivate(x, projects));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { if (k === 'private_refs' || k === 'private_media' || priv(x)) continue; o[k] = scrubPrivate(x, projects); } return o; }
  return v;
}
