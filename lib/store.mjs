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
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ------------------------------------------------------------------ files
export class WbError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new WbError(code, msg); };
export function readJSON(file, d) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return d; } }
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function writeJSON(file, data) { writeAtomic(file, JSON.stringify(data, null, 1)); }
// write a temp file and rename it over the target; Windows refuses the rename while another process (indexer,
// antivirus, a reader) has the file open for a moment: retry, then fall back to copying over it
export function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', bytes);
  for (let i = 0; ; i++) {
    try { fs.renameSync(file + '.tmp', file); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      if (i >= 12) { fs.copyFileSync(file + '.tmp', file); fs.rmSync(file + '.tmp', { force: true }); return; }
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
  return { file: fs.existsSync(file) ? file : null, dataRoot, mediaBase, mediaRoots: c.media_roots || [], privateSrc,
    privateRe: new RegExp(privateSrc), defaultProject: def, allowRemoteOps: !!(process.env.WB_ALLOW_REMOTE_OPS || c.allow_remote_ops) };
}
export const CFG = loadConfig();
export const DATA_ROOT = CFG.dataRoot;
export const isPrivate = (p) => typeof p === 'string' && CFG.privateRe.test(p);
export const isMediaRootPath = (p) => typeof p === 'string' && CFG.mediaRoots.some(r => p.startsWith(r));
// a stored media path -> absolute file: base-relative under a media root, else relative to the project folder
export function resolveMedia(project, p) {
  if (!p || typeof p !== 'string') return null;
  return isMediaRootPath(p) ? inside(CFG.mediaBase, p) : inside(projDir(project), p);
}

// ------------------------------------------------------------------ projects
export const WRITABLE = new Set(['approvals.json', 'notes.json', 'requests.json', 'settings.json', 'overrides.json']);
const DEFAULTS = {
  'approvals.json': { rev: 0, states: ['draft', 'review', 'changes', 'approved', 'locked'], items: {} },
  'notes.json': { rev: 0, notes: [] }, 'requests.json': { rev: 0, items: [] },
  'overrides.json': { rev: 0, sections: {} }, 'settings.json': { rev: 0, keybindings: {} },
  'costs.json': { cap_usd: 0, items: [], pre_production: [], ledger: [] }, 'media.json': { items: [] },
  'shots.json': { shots: [], uses: [] }, 'events.json': [], 'entities/index.json': [], 'script.json': { stages: [], lines: [] },
};
const SNAP_SKIP = /^(peaks|_src|thumbs|media|\.snapshots)\/|^settings\.json$/;   // snapshots keep the small JSON content files only
export const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(id);
export function projDir(id, mustExist = true) {
  if (!validId(id)) fail(400, 'bad project id: ' + id);
  const d = path.join(DATA_ROOT, id);
  if (mustExist && !fs.existsSync(path.join(d, 'song.json'))) fail(404, 'no such project: ' + id);
  return d;
}
export const read = (project, file) => readJSON(path.join(projDir(project), file), structuredClone(DEFAULTS[file] ?? null)) ?? structuredClone(DEFAULTS[file] ?? null);
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
    for (const f of Object.keys(DEFAULTS)) if (f !== 'settings.json') writeJSON(path.join(d, f), { ...DEFAULTS[f], ...(DEFAULTS[f].rev === 0 ? { rev: 1 } : {}) });
    for (const [f, v] of Object.entries(files)) writeJSON(path.join(d, f), v);
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
// restore = the current state is snapshotted first ("auto"), then byte-identical copies; files the snapshot did not have are removed
export function restore(id, sid) {
  const d = projDir(id);
  const sd = inside(path.join(d, '.snapshots'), String(sid || ''));
  if (!sd || !fs.existsSync(path.join(sd, '.meta.json'))) fail(404, 'no such snapshot: ' + sid);
  const meta = readJSON(path.join(sd, '.meta.json'), {});
  const before = snapshot(id, `before restore of ${meta.message || sid}`, true);
  const keep = new Set(walk(sd).filter(f => f !== '.meta.json'));
  const gone = snapFiles(d).filter(f => !keep.has(f));
  for (const f of gone) fs.rmSync(path.join(d, f));
  const changed = [];
  for (const f of keep) {
    const b = fs.readFileSync(path.join(sd, f)), cur = fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f)) : null;
    if (!cur || !cur.equals(b)) { writeAtomic(path.join(d, f), b); changed.push(f); }
  }
  return { restored: sid, previous: before.id, changed, removed: gone };
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
  const thumb = `thumbs/${name || (priv ? 'priv_' : 'm_') + id}.jpg`, o = path.join(path.dirname(outDir), thumb);
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
  shot_update(p, { id, status, comment, take, in_ms, file, title, note, by = 'agent' }) {
    const sh = shotsDoc(p);
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
      mutate(p, 'approvals.json', (d) => { d.items[key] = { ...(d.items[key] || {}), state: status, by, at: nowIso(), ...(comment ? { comment } : {}) }; });
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
  entity_upsert(p, { kind, id, name, fields = {}, look, thumb_src }) {
    if (!['character', 'location', 'prop'].includes(kind)) fail(400, 'kind must be character, location or prop');
    if (!validId(id)) fail(400, 'id: letters, digits, _ and - only');
    const idx = read(p, 'entities/index.json'), rel = `entities/${kind}s/${id}.json`, file = path.join(projDir(p), rel);
    const prev = idx.find(e => e.id === id);
    if (prev && prev.kind !== kind) fail(409, `"${id}" is already a ${prev.kind}`);
    const e = { id, kind, status: 'draft', refs: [], ...(readJSON(file, {}) || {}), ...fields, ...(name ? { name } : {}) };
    e.name ||= id;
    if (look) {
      if (!look.id || !validId(look.id)) fail(400, 'look.id required (letters, digits, _ and -)');
      e.looks ||= []; const i = e.looks.findIndex(l => l.id === look.id);
      const merged = { images: [], garments: [], colors: [], status: 'draft', ...(i >= 0 ? e.looks[i] : {}), ...look };
      if (i >= 0) e.looks[i] = merged; else e.looks.push(merged);
    }
    if (thumb_src) {
      const abs = resolveMedia(p, thumb_src);
      if (abs && fs.existsSync(abs)) { const r = makeThumbs(abs, path.join(projDir(p), 'thumbs'), id, { name: 'ent_' + id, priv: isPrivate(thumb_src) }); if (r.thumb) e.thumb = r.thumb; e.thumb_src = thumb_src; }
    }
    writeJSON(file, e);
    if (!prev) idx.push({ id, kind, name: e.name, path: rel }); else prev.name = e.name;
    write(p, 'entities/index.json', idx);
    return { created: !prev, entity: e };
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
    const pd = projDir(p);
    let stored, abs;
    const asGiven = path.isAbsolute(src) ? path.resolve(src) : null;
    if (asGiven) {
      if (!fs.existsSync(asGiven)) fail(404, 'no such file: ' + src);
      const relP = path.relative(pd, asGiven), relBase = path.relative(CFG.mediaBase, asGiven).replace(/\\/g, '/');
      if (!relP.startsWith('..') && !path.isAbsolute(relP)) { stored = relP.replace(/\\/g, '/'); abs = asGiven; }
      else if (!relBase.startsWith('..') && isMediaRootPath(relBase)) { stored = relBase; abs = asGiven; }
      else if (copy) {
        const dir = path.join(pd, 'media', kind); fs.mkdirSync(dir, { recursive: true });
        let name = path.basename(asGiven), n = 2; while (fs.existsSync(path.join(dir, name))) name = path.basename(asGiven).replace(/(\.\w+)?$/, `-${n++}$1`);
        fs.copyFileSync(asGiven, path.join(dir, name)); abs = path.join(dir, name); stored = `media/${kind}/${name}`;
      } else fail(400, 'file is outside the project and the media roots; pass copy:true to copy it into data/<project>/media/');
    } else {
      stored = src.replace(/\\/g, '/'); abs = resolveMedia(p, stored);
      if (!abs || !fs.existsSync(abs)) fail(404, `no such file: ${src} (give an absolute path, a path relative to the project folder, or one under a media root: ${CFG.mediaRoots.join(', ') || 'none configured'})`);
    }
    const doc = read(p, 'media.json'); doc.items ||= [];
    const dup = doc.items.find(m => m.path === stored);
    if (dup) return { added: false, reason: 'already indexed', media: dup };
    const ids = new Set(doc.items.map(m => m.id));
    const base = path.basename(stored).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'media';
    let id = base; for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    const pr = ffprobe(abs), isPriv = priv === true || isPrivate(stored);
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
      const n = { id: nextId(d.notes, 'n'), t: tm, line_id: line || null, by, text: String(text), status: 'open', at: nowIso(), ...(about ? { about } : {}), ...(reply_to ? { reply_to } : {}) };
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
  set_states(p, { keys, state, comment, by = 'agent' }) {
    if (!Array.isArray(keys) || !keys.length) fail(400, 'keys: a non-empty list like ["shot:c1-desk", "use:G05@20158"]');
    for (const k of keys) if (!/^[a-z-]+:.+/.test(k)) fail(400, `bad key "${k}" (kind:id)`);
    mutate(p, 'approvals.json', (d) => { for (const k of keys) d.items[k] = { ...(d.items[k] || {}), state, by, at: nowIso(), ...(comment ? { comment } : {}) }; });
    return { state, keys };
  },
  // ---------------- generation requests
  requests_list(p, { status, target } = {}) {
    return (read(p, 'requests.json').items || []).filter(r => (!status || r.status === status) && (!target || r.target === target));
  },
  request_create(p, { kind, target, prompt, refs = [], est_cost, look, tool, by = 'agent', extra }) {
    if (!kind) fail(400, 'kind required');
    if (est_cost == null || !(Number(est_cost) >= 0)) fail(400, 'est_cost (USD, a number >= 0) is required: the director approves against the cap');
    const item = { id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`, kind, target: target || null, prompt: prompt || '', refs, est_cost: Number(est_cost),
      status: 'draft', by, at: nowIso(), ...(tool ? { tool } : {}), ...(look ? { look } : {}), ...(extra || {}), log: [{ at: nowIso(), by, status: 'draft' }] };
    mutate(p, 'requests.json', (d) => { d.items.push(item); });
    return item;
  },
  request_update(p, { id, status, prompt, refs, est_cost, outputs, actual_cost_usd, why, tool, by = 'agent', director_approved = false, register_media = true, media_kind }) {
    const cur = (read(p, 'requests.json').items || []).find(r => r.id === id);
    if (!cur) fail(404, `no request "${id}"`);
    const patch = {}, edits = prompt != null || refs != null || est_cost != null;
    if (edits) {
      if (!['draft', 'approved'].includes(cur.status)) fail(409, `request ${id} is ${cur.status}: only draft or approved requests can be edited`);
      if (prompt != null) patch.prompt = prompt; if (refs != null) patch.refs = refs; if (est_cost != null) patch.est_cost = Number(est_cost);
      if (cur.status === 'approved' && !status) patch.status = 'draft';     // an edit voids the approval
    }
    if (status && status !== cur.status) {
      if (!REQUEST_STATUSES.includes(status)) fail(400, `status must be one of ${REQUEST_STATUSES.join(', ')}`);
      if (!NEXT[cur.status].includes(status)) fail(409, `cannot move a ${cur.status} request to ${status} (allowed: ${NEXT[cur.status].join(', ') || 'none'})`);
      if (status === 'approved' && cur.status === 'draft' && !director_approved) fail(403, 'only the director approves requests: ask them (or they click the chip in Review > Queue); pass director_approved:true only when they said so in this conversation');
      if (status === 'queued' || status === 'running') {
        const c = costSummary(p), est = Number(patch.est_cost ?? cur.est_cost) || 0;
        const others = ['approved', 'queued', 'running'].includes(cur.status) ? c.committed_usd - (Number(cur.est_cost) || 0) : c.committed_usd;
        if (c.cap_usd && c.spent_usd + others + est > c.cap_usd + 1e-9) fail(402, `over the cap: spent $${c.spent_usd} + committed $${others.toFixed(2)} + this $${est} > cap $${c.cap_usd}; ask the director to raise costs.json cap_usd or reject something`);
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
    if (why) patch.why = why; if (tool) patch.tool = tool;
    let registered = [];
    if (patch.status === 'done') {
      const usd = Number(actual_cost_usd), t = timeOfKey(p, cur.target) ?? 0;
      const C = read(p, 'costs.json'); C.items ||= [];
      C.items.push({ id: cur.id, t, usd, tool: tool || cur.tool || cur.kind, date: nowIso().slice(0, 10), request: cur.id });
      C.items.sort((a, b) => a.t - b.t); write(p, 'costs.json', C);
      if (register_media) for (const [i, o] of outputs.entries()) {
        try { const r = ops.media_add(p, { path: o, kind: media_kind || (VIDEO.test(o) ? 'clip' : AUDIO.test(o) ? 'audio' : 'still'), label: `${cur.kind} ${cur.target || ''} · ${cur.id}`.trim(), job: cur.id, take: i, cost_usd: +(usd / outputs.length).toFixed(3), request: cur.id,
          entities: /^(character|location|prop):/.test(cur.target || '') ? [cur.target.split(':')[1]] : [] }); registered.push(r.media.path); }
        catch (e) { registered.push(`(not indexed: ${o}: ${e.message})`); }
      }
      if (registered.length) patch.outputs = registered.map((r, i) => r.startsWith('(') ? outputs[i] : r);
    }
    const item = mutate(p, 'requests.json', (d) => {
      const r = d.items.find(x => x.id === id);
      Object.assign(r, patch, { at: nowIso() });
      if (patch.status) (r.log ||= []).push({ at: nowIso(), by, status: patch.status, ...(why ? { why } : {}) });
      return { ...r };
    });
    return { request: item, ...(patch.status === 'done' ? { cost_recorded_usd: Number(actual_cost_usd), media: registered, costs: costSummary(p) } : {}) };
  },
  costs_get(p) { return costSummary(p); },
};
