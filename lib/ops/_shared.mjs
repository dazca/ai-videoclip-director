// Shared by every lib/ops/<domain>.mjs: files (atomic JSON writes), configuration (workbench.config.json + env, see
// lib/store.mjs), media paths and the PRIVATE rule, project folders (projDir, read, write, mutate), time helpers, thumbnails
// (ffmpeg), the director gates (approvals are the page's unless agent_approvals) and the `ops` object every domain fills.
// Nothing here talks to the network or to a paid API. Imports no other lib/ops module.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WB_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// ------------------------------------------------------------------ files
export class WbError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
export const fail = (code, msg) => { throw new WbError(code, msg); };
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
    host: process.env.WB_HOST || c.host || null,
    // the fal key's file (D3a runner): a path OUTSIDE the workbench and the data folder (lib/run.mjs refuses anything
    // else); the env var FAL_KEY wins. Only the runner reads it; it is never logged, returned or written.
    falKeyFile: typeof c.fal_key_file === 'string' && c.fal_key_file ? c.fal_key_file : null };
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
export const DEFAULTS = {
  'approvals.json': { rev: 0, states: ['draft', 'review', 'changes', 'approved', 'locked', 'archived'], items: {} },
  'notes.json': { v: 2, rev: 0, round: 1, notes: [], legacy_seen: [] }, 'requests.json': { rev: 0, items: [] },
  'overrides.json': { rev: 0, sections: {} }, 'settings.json': { rev: 0, keybindings: {} },
  'costs.json': { cap_usd: 0, items: [], pre_production: [], ledger: [] }, 'media.json': { items: [] },
  'shots.json': { shots: [], uses: [] }, 'events.json': [], 'entities/index.json': [], 'script.json': { stages: [], lines: [] },
};

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
export const nowIso = () => new Date().toISOString().slice(0, 19);
export const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'snapshot';

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
export const overlaps = (a0, a1, t0, t1) => a0 < Math.max(t1, t0 + 1) && (a1 ?? a0 + 1) > t0;
export const sum = (a, f) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
export const shotsDoc = (p) => read(p, 'shots.json');
export const stateOf = (A, k) => A.items?.[k]?.state || 'draft';
export function nextId(list, prefix) { const n = list.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, '')) || 0), 0) + 1; return `${prefix}${String(n).padStart(2, '0')}`; }
export function timeOfKey(project, key) {
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
export function ffprobe(file) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_type:format=duration', '-of', 'json', file], { encoding: 'utf8', timeout: 30000 });
    const j = JSON.parse(r.stdout || '{}'); const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
    const d = Number(j.format?.duration);
    return { w: v.width || null, h: v.height || null, dur: Number.isFinite(d) ? d : null };
  } catch (e) { return { w: null, h: null, dur: null }; }
}
export const VIDEO = /\.(mp4|webm|mov|mkv)$/i, AUDIO = /\.(wav|mp3|m4a|flac|ogg)$/i, IMAGE = /\.(png|jpe?g|webp|gif)$/i;
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
// change to every open page. Every lib/ops/<domain>.mjs adds its ops with Object.assign(ops, {...}); ops call each other
// through this object (ops.media_add, ops.entity_upsert, ...), never by importing another domain's op.
export const ops = {};
export const REQUEST_STATUSES = ['draft', 'approved', 'queued', 'running', 'done', 'failed', 'rejected'];
export const DIRECTOR_STATES = ['approved', 'locked'];   // item states only the director sets
const DIRECTOR_ONLY = 'only the director approves or locks items: ask them; pass director_approved:true only when they said so in this conversation';
const PAGE_ONLY = 'agent approvals are off: the director approves in the open page (click the chip, or A on the selection; requests in Review > Queue). '
  + 'Show it with ui_focus. (workbench.config.json "agent_approvals": true lets director_approved:true from an agent count)';
// the agent surface (ops, MCP) may approve only when the director said so AND the owner allowed agent approvals
export const directorGate = (director_approved) => { if (!director_approved) fail(403, DIRECTOR_ONLY); if (!CFG.agentApprovals) fail(403, PAGE_ONLY); };
// a request may be queued / run only on a director approval recorded after its last draft: one the page made (serve.mjs
// stamps via:"page" on /api/save) or, with agent_approvals, an agent's director_approved:true. A status typed into
// requests.json by hand has no such entry and is refused.
export function approvalOk(r) {
  const log = r.log || [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i] || {};
    if (e.status === 'draft' || e.status === 'rejected') return false;   // (a failed run keeps its approval: it may be retried)
    if (e.status === 'approved' && (e.via === 'page' || (e.via === 'agent' && e.director_approved && CFG.agentApprovals))) return true;
  }
  return false;
}
