// E4 render jobs and E8 contact sheets + second opinions (ROADMAP_v4). Shapes: js/renders.js. renders.json is the server's
// (not a page save). Nothing here calls a paid API: a render runs the DIRECTOR'S command on this machine ($0), and a sheet is
// ffmpeg (lib/contact.mjs).
//   renders_get     read only: the render settings (the command as the director set it), the machine lock, free RAM now, the
//                   render jobs (requests of kind render: spec, status, phase, outputs, the log's tail), the etiquette's order
//                   (chapters not rendered yet), the sheets with their reviews and open second-opinion asks
//   render_propose  a render job as a DRAFT request of kind "render" ({scope: excerpt | chapter | full, t0, t1, chapter, why}):
//                   an agent proposes, only the director starts it. A request never carries a command
//   render_config   PAGE ONLY: the director's render command (an argv list with {placeholders}, no shell), its folder, the
//                   warm-up, the RAM floor and wait, workers, size, fps, the excerpt limit
//   render_start    PAGE ONLY (the director's click, after a confirm in the page): one render at a time on the machine (a lock
//                   in the data folder), only with more free RAM than the floor (else it waits and retries, then fails), the
//                   full film only after every chapter was rendered (unless the director says so), the warm-up first; the
//                   log goes to renders/<id>/render.log; the MP4, a contact sheet and a seams sheet are registered as media and
//                   linked to the request and the current revision
//   render_cancel   PAGE ONLY: stop a running render
//   sheet_make      a contact sheet (agent or page): of a done render (a time range, one frame every N s), of a request's
//                   takes, or of the storyboard (one tile per shot: its picked take, frame or placeholder); written to
//                   sheets/<generated id>.jpg (private/sheets/ when a source is private), never a path the caller names
//   sheet_ask       a "second opinion" ask for the agent on a sheet (a note to: agent, ask "review", about "sheet:<id>")
//   sheets_get      read only: the sheets with absolute files and, per frame, the script / storyboard / lyric at its time and
//                   the constants of the characters on screen (what a review checks against)
//   sheet_review    the agent's review of a sheet (verdict ok | issues | fail, items, note): renders.json only, never an
//                   approval or a pick; absorbs the open second-opinion asks on that sheet
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as RN from '../../js/renders.js';
import * as CH from '../../js/chapters.js';
import * as SC from '../../js/scenes.js';
import * as SB from '../../js/storyboard.js';
import * as T from '../../js/takes.js';
import * as CK from '../../js/checks.js';
import * as A from '../../js/assets.js';
import { DATA_ROOT, IMAGE, VIDEO, fail, isFlaggedPrivate, isPrivate, nowIso, ops, projDir, read, readJSON, resolveMedia, withFileLock, write, writeJSON } from './_shared.mjs';
import { scenesDoc } from './scenes.mjs';
import { boardDoc } from './storyboard.mjs';
import { revDoc } from './rounds.mjs';
import { addNote, notesDoc, setStatus } from './notes.mjs';
import { readAsset } from './assets.mjs';
import { sniff } from './media.mjs';
import * as C from '../contact.mjs';

const FILE = 'renders.json';
const TEST = process.env.WB_TEST === '1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export function rendersDoc(p) { return RN.normRenders(readJSON(path.join(projDir(p), FILE), null, true)); }
function mutateRenders(p, fn) {
  return withFileLock(path.join(projDir(p), FILE), () => { const d = rendersDoc(p); const r = fn(d); d.rev = (d.rev || 0) + 1; write(p, FILE, d); return r === undefined ? d : r; });
}
const pageOnly = (via, what) => { if (via !== 'page') fail(403, `${what} is the director's, in the page (Final › Renders, Review › Queue): an agent proposes a render with render_propose and never starts one`); };
const freeMb = () => Math.round(os.freemem() / 1048576);
const ctxOf = (p) => { const bd = boardDoc(p), scenes = SC.currentScript(scenesDoc(p))?.scenes || [], shots = SB.boardShots(bd); return { bd, scenes, shots, song: read(p, 'song.json') }; };
const chaptersOf = (p, c = ctxOf(p)) => CH.chaptersView(c.bd, { scenes: c.scenes, shots: c.shots, approvals: read(p, 'approvals.json'), requests: read(p, 'requests.json') });
const renderReq = (p, id) => {
  if (typeof id !== 'string' || !RN.RENDER_ID.test(id)) fail(400, 'id: a render request id (renders_get lists them)');
  const r = (read(p, 'requests.json').items || []).find(x => x.id === id); if (!r) fail(404, `no request "${id}"`);
  if (!RN.isRender(r)) fail(400, `request ${id} is not a render (kind ${String(r.kind).slice(0, 30)})`);
  return r;
};
// a request in requests.json changed by the workbench itself (the job): under the file's lock (never an op: not on the HTTP surface)
function setReq(p, id, fn) {
  return withFileLock(path.join(projDir(p), 'requests.json'), () => {
    const d = read(p, 'requests.json'), x = (d.items || []).find(i => i.id === id); if (!x) return null;
    fn(x); x.at = nowIso(); d.rev = (d.rev || 0) + 1; write(p, 'requests.json', d); return x;
  });
}

// ------------------------------------------------------------------ the machine lock: one render at a time (all projects)
const LOCK = () => path.join(DATA_ROOT, '.render.lock');   // a dot-file: never served
const RUNNING = new Map();   // request id -> {child, cancel}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function lockInfo() {
  let j = null; try { j = JSON.parse(fs.readFileSync(LOCK(), 'utf8')); } catch (e) { return null; }
  const stale = !j || !alive(j.pid) || Date.now() - Date.parse(j.heartbeat || j.at || 0) > 120000 || (j.pid === process.pid && !RUNNING.has(j.id));
  return stale ? { ...j, stale: true } : j;
}
function takeLock(p, id, kind = 'render') {
  const cur = lockInfo();
  if (cur && !cur.stale) fail(409, `a heavy job is running (${cur.project}/${cur.id}${cur.kind === 'package' ? ', an HTML package' : ', a render'}, since ${String(cur.at).replace('T', ' ')}): one render at a time on this machine, an HTML package export counting as one (PRODUCTION.md); wait for it or cancel it`);
  if (cur?.stale) fs.rmSync(LOCK(), { force: true });
  const rec = { pid: process.pid, project: p, id, kind, at: nowIso(), heartbeat: new Date().toISOString() };
  try { const fd = fs.openSync(LOCK(), 'wx'); fs.writeSync(fd, JSON.stringify(rec)); fs.closeSync(fd); }
  catch (e) { fail(409, 'a render is starting (the machine lock was just taken): try again in a moment'); }
  const beat = setInterval(() => { try { const j = JSON.parse(fs.readFileSync(LOCK(), 'utf8')); if (j.id === id && j.pid === process.pid) fs.writeFileSync(LOCK(), JSON.stringify({ ...j, heartbeat: new Date().toISOString() })); } catch (e) { /* gone */ } }, 10000);
  beat.unref?.();
  return () => { clearInterval(beat); try { const j = JSON.parse(fs.readFileSync(LOCK(), 'utf8')); if (j.id === id && j.pid === process.pid) fs.rmSync(LOCK(), { force: true }); } catch (e) { /* gone */ } };
}
// a render request left "running" by a server that stopped: failed (interrupted), so the director can start it again
function reconcile(p) {
  const L = lockInfo(), items = read(p, 'requests.json').items || [];
  for (const r of items) if (RN.isHeavy(r) && r.status === 'running' && !RUNNING.has(r.id) && !(L && !L.stale && L.project === p && L.id === r.id)) {
    const k = RN.isPackage(r) ? 'package_run' : 'render_run';
    setReq(p, r.id, (x) => { x.status = 'failed'; x.why = `interrupted: the server stopped during the ${RN.isPackage(r) ? 'export' : 'render'}`; x[k] = { ...(x[k] || {}), phase: 'failed', ended: nowIso(), why: x.why }; (x.log ||= []).push({ at: nowIso(), by: 'workbench', via: 'agent', status: 'failed', why: x.why }); });
  }
}

// ------------------------------------------------------------------ the log of a job (renders/<id>/render.log, capped)
const LOG_MAX = 2 * 1024 * 1024;
function logger(file) {
  let size = 0; try { size = fs.statSync(file).size; } catch (e) { /* new */ }
  return (line) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${String(line).replace(/\s+$/, '')}\n`; if (size > LOG_MAX) return; size += s.length; try { fs.appendFileSync(file, size > LOG_MAX ? s + '[log truncated: over 2 MB]\n' : s); } catch (e) { /* disk */ } };
}
// a job's files are always named from its id (never from a stored path: a forged render_run cannot point elsewhere)
const jobRel = (id, what) => (RN.RENDER_ID.test(String(id)) ? `renders/${id}/${what === 'log' ? 'render.log' : what === 'out' ? `${id}.mp4` : ''}` : null);
export function logTail(p, r, n = 40) {
  const rel = r?.render_run && jobRel(r.id, 'log'), f = rel && path.join(projDir(p), rel); if (!f) return [];
  try { const b = fs.readFileSync(f, 'utf8'); return b.split(/\r?\n/).filter(Boolean).slice(-n); } catch (e) { return []; }
}
// run one argv (no shell) with its output into the log; -> exit code. RAM is sampled while it runs (watch)
function runLogged(argv, { cwd, log, timeoutMs, watch, onChild }) {
  return new Promise((resolve) => {
    let child; try { child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { log(`could not start ${argv[0]}: ${e.message}`); return resolve({ code: -1, error: e.message }); }
    onChild?.(child);
    let buf = { out: '', err: '' };
    const feed = (k) => (d) => { buf[k] += d.toString(); const parts = buf[k].split(/\r?\n|\r(?!\n)/); buf[k] = parts.pop(); for (const l of parts) if (l.trim()) log(`${k === 'err' ? '! ' : ''}${l}`); };
    child.stdout.on('data', feed('out')); child.stderr.on('data', feed('err'));
    const t = setTimeout(() => { log(`timeout after ${Math.round(timeoutMs / 60000)} min: stopping it`); kill(child); }, timeoutMs);
    const w = watch ? setInterval(() => watch(child), 2000) : null;
    child.on('error', (e) => { log(`could not start ${argv[0]}: ${e.message}`); });
    child.on('close', (code, sig) => { clearTimeout(t); if (w) clearInterval(w); for (const k of ['out', 'err']) if (buf[k].trim()) log(buf[k]); resolve({ code: code ?? -1, signal: sig }); });
  });
}
function kill(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
}

// ------------------------------------------------------------------ registering outputs
function register(p, rel, kind, label, links) {
  const m = ops.media_add(p, { path: rel, kind, label, request: links.request || undefined, ...(links.private ? { private: true } : {}) }).media;
  withFileLock(path.join(projDir(p), 'media.json'), () => {
    const doc = read(p, 'media.json'), x = (doc.items || []).find(i => i.id === m.id); if (!x) return;
    Object.assign(x, { ...(links.render ? { render: links.render } : {}), ...(links.sheet ? { sheet: links.sheet } : {}), revision: links.revision || 'R0' });
    write(p, 'media.json', doc);
  });
  return m;
}
const newSheetId = (d) => { let id; do id = `sh${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; while (d.sheets.some(s => s.id === id)); return id; };
function addSheet(p, rec) { return mutateRenders(p, (d) => { d.sheets.push(rec); if (d.sheets.length > 500) d.sheets.splice(0, d.sheets.length - 500); return rec; }); }

// the memory guard every heavy job shares (a render, a package): free RAM above the floor, else wait and retry, then fail
async function waitRam(cfg, ram, state, log, phase, failJob) {
  for (let i = 1; ; i++) {
    const f = freeMb(); ram.min_mb = Math.min(ram.min_mb, f); ram.samples++;
    log(`free RAM ${f} MB (the floor: ${cfg.min_free_mb} MB) · check ${i}/${cfg.ram_tries}`);
    if (f > cfg.min_free_mb) return;
    if (i >= cfg.ram_tries) failJob(`not enough free RAM: ${f} MB after ${i} checks (needs more than ${cfg.min_free_mb} MB); close something and start it again`);
    phase('waiting_ram', { waiting_ram: { free_mb: f, check: i, of: cfg.ram_tries } });
    for (let k = 0; k < cfg.ram_wait_s * 10 && !state.cancelled; k++) await sleep(100);
    if (state.cancelled) failJob('cancelled by the director');
  }
}

// ------------------------------------------------------------------ the job
async function runJob(p, id, cfg, spec, { revision, release }) {
  const pd = projDir(p), dirRel = `renders/${id}`, dir = path.join(pd, 'renders', id);
  fs.mkdirSync(dir, { recursive: true });
  const logRel = `${dirRel}/render.log`, log = logger(path.join(pd, logRel)), outRel = `${dirRel}/${id}.mp4`, out = path.join(pd, outRel);
  const state = { cancelled: false, child: null }; RUNNING.set(id, state);
  const ram = { start_mb: freeMb(), min_mb: freeMb(), samples: 0 };
  const phase = (ph, extra = {}) => setReq(p, id, (x) => { x.render_run = { ...(x.render_run || {}), phase: ph, ram: { ...ram }, ...extra }; });
  const failJob = (why) => { const e = new Error(why); e.job = true; throw e; };
  try {
    fs.rmSync(out, { force: true });
    log(`render ${id} · ${RN.specLabel({ render: spec })} · ${(spec.t1 - spec.t0) / 1000} s · ${cfg.width}x${cfg.height} · ${cfg.workers} worker${cfg.workers > 1 ? 's' : ''} · revision ${revision}`);
    // 1. free RAM above the floor, else wait and retry (PRODUCTION.md: "only when Windows reports more than 1.5 GB of free RAM ... otherwise wait 60 s and retry")
    await waitRam(cfg, ram, state, log, phase, failJob);
    const vals = { out, from: (spec.t0 / 1000).toFixed(3), to: (spec.t1 / 1000).toFixed(3), duration: ((spec.t1 - spec.t0) / 1000).toFixed(3), from_ms: spec.t0, to_ms: spec.t1,
      scope: spec.scope, chapter: spec.chapter || '', chapter_file: spec.chapter_file || '', width: cfg.width, height: cfg.height, fps: cfg.fps, workers: cfg.workers, id, project: p, project_dir: pd };
    const cwd = cfg.cwd || pd, timeoutMs = cfg.timeout_min * 60000;
    const watch = () => { const f = freeMb(); ram.samples++; if (f < ram.min_mb) ram.min_mb = f; if (cfg.abort_below_mb && f < cfg.abort_below_mb && state.child) { log(`free RAM fell to ${f} MB (below ${cfg.abort_below_mb} MB): stopping the render`); state.ramAbort = f; kill(state.child); } };
    // 2. warm the cache (the director's warm-up command, e.g. the chapter cut pages first)
    if (cfg.warm) {
      phase('warming'); log(`warm-up: ${RN.fillArgv(cfg.warm, vals).join(' ')}`);
      const w = await runLogged(RN.fillArgv(cfg.warm, vals), { cwd, log, timeoutMs, watch, onChild: (c) => { state.child = c; } });
      if (state.cancelled) failJob('cancelled by the director');
      log(w.code === 0 ? 'warm-up done' : `warm-up exited ${w.code}: rendering anyway`);
    }
    // 3. the render
    const argv = RN.fillArgv(cfg.command, vals);
    phase('rendering', { cmd: argv.map(a => a.length > 200 ? a.slice(0, 199) + '…' : a) });
    log(`render: ${argv.join(' ')}`);
    const r = await runLogged(argv, { cwd, log, timeoutMs, watch, onChild: (c) => { state.child = c; } });
    if (state.cancelled) failJob('cancelled by the director');
    if (state.ramAbort) failJob(`stopped: free RAM fell to ${state.ramAbort} MB (below ${cfg.abort_below_mb} MB)`);
    if (r.code !== 0) failJob(`the render command exited with ${r.code}${r.error ? ` (${r.error})` : ''}: see the log`);
    let head = null; try { const fd = fs.openSync(out, 'r'); head = Buffer.alloc(32); fs.readSync(fd, head, 0, 32, 0); fs.closeSync(fd); } catch (e) { failJob(`the command wrote no ${path.basename(out)} (it must write {out})`); }
    if (sniff(head)?.type !== 'video') failJob(`${path.basename(out)} is not a video file`);
    const pr = C.probe(out); log(`output: ${(fs.statSync(out).size / 1048576).toFixed(1)} MB · ${pr.dur?.toFixed(2)} s · ${pr.w}x${pr.h} · ${pr.fps?.toFixed(2)} fps`);
    // 4. the sheets (the contact sheet every N s, the seams around each chapter start inside the range)
    phase('sheets');
    const t0s = spec.t0 / 1000, songLabel = (s) => RN.tc(spec.t0 + s * 1000);
    const every = spec.scope === 'excerpt' ? Math.min(cfg.sheet_every_s, 1) : cfg.sheet_every_s;
    const sheetRel = `${dirRel}/${id}-sheet.jpg`, seamsRel = `${dirRel}/${id}-seams.jpg`;
    const cs = C.videoSheet(out, path.join(pd, sheetRel), { every, cols: 6, label: songLabel });
    const seams = RN.seamsIn(chaptersOf(p), spec.t0, spec.t1);
    const ss = seams.length ? C.seamsSheet(out, path.join(pd, seamsRel), seams.map(x => ({ t: (x.t - spec.t0) / 1000, label: x.label })), { fps: pr.fps || cfg.fps, label: (s, f) => `${(t0s + s).toFixed(3)} f${Math.round((t0s + s) * (pr.fps || cfg.fps))}` }) : null;
    log(`contact sheet: ${cs.tiles} frames every ${cs.every} s${ss ? ` · seams sheet: ${seams.length} seam${seams.length > 1 ? 's' : ''}` : ' · no chapter seam inside the range: no seams sheet'}`);
    // 5. register (media, linked to the request and the revision) and record the sheets
    const links = { request: id, render: id, revision };
    const mv = register(p, outRel, 'render', `render ${RN.specLabel({ render: spec })} · ${id}`, links);
    const sheets = [];
    const sid1 = `${id}-sheet`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const m1 = register(p, sheetRel, 'sheet', `contact sheet · ${RN.specLabel({ render: spec })}`, { ...links, sheet: sid1 });
    sheets.push(addSheet(p, { id: sid1, kind: 'contact', from: 'render', source: id, file: sheetRel, media: m1.id, t0: spec.t0, t1: spec.t1, every: cs.every, cols: cs.cols,
      frames: cs.times.map(s => ({ t: Math.round(spec.t0 + s * 1000), label: songLabel(s) })), revision, by: 'workbench', via: 'page', at: nowIso(), asks: [], reviews: [] }).id);
    if (ss) {
      const sid2 = `${id}-seams`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const m2 = register(p, seamsRel, 'sheet', `seams sheet · ${RN.specLabel({ render: spec })}`, { ...links, sheet: sid2 });
      sheets.push(addSheet(p, { id: sid2, kind: 'seams', from: 'render', source: id, file: seamsRel, media: m2.id, t0: spec.t0, t1: spec.t1, cols: 5, seams: seams.map(x => ({ t: x.t, label: x.label })),
        frames: ss.times.map(s => ({ t: Math.round(spec.t0 + s * 1000), label: `${(t0s + s).toFixed(3)} f${Math.round((t0s + s) * ss.fps)}` })), revision, by: 'workbench', via: 'page', at: nowIso(), asks: [], reviews: [] }).id);
    }
    const outputs = [outRel, sheetRel, ...(ss ? [seamsRel] : [])];
    log(`done: ${outputs.join(', ')}`);
    setReq(p, id, (x) => {
      x.status = 'done'; x.outputs = outputs; x.actual_cost_usd = 0; delete x.why;
      x.render_run = { ...(x.render_run || {}), phase: 'done', ended: nowIso(), ram: { ...ram }, out: outRel, media: mv.id, sheets, revision, duration_s: pr.dur };
      (x.log ||= []).push({ at: nowIso(), by: 'workbench', via: 'page', status: 'done' });
    });
  } catch (e) {
    const why = String(e.job ? e.message : `render failed: ${e.message}`).slice(0, 500);
    log(why);
    setReq(p, id, (x) => { x.status = 'failed'; x.why = why; x.render_run = { ...(x.render_run || {}), phase: state.cancelled ? 'cancelled' : 'failed', ended: nowIso(), ram: { ...ram }, why }; (x.log ||= []).push({ at: nowIso(), by: 'workbench', via: 'page', status: 'failed', why }); });
  } finally { RUNNING.delete(id); release(); }
}

// ------------------------------------------------------------------ C5: the interactive HTML package (File › Export)
// The programs are the workbench's own exporter and checker (node + a fixed script path); the composition folder, its entry and the
// HyperFrames folder come from the director's render settings only; the output folders are named from the request id.
const WB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPORTER = path.join(WB_DIR, 'exporters', 'hyperframes-html', 'export.mjs'), VERIFIER = path.join(WB_DIR, 'exporters', 'hyperframes-html', 'verify.mjs');
const pkgRel = (id, what) => (RN.RENDER_ID.test(String(id)) ? `exports/package/${id}${what === 'verify' ? '-verify' : what === 'log' ? '.log' : ''}` : null);
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } };
const packageReq = (p, id) => {
  if (typeof id !== 'string' || !RN.RENDER_ID.test(id)) fail(400, 'id: a package request id (renders_get lists them under exports)');
  const r = (read(p, 'requests.json').items || []).find(x => x.id === id); if (!r) fail(404, `no request "${id}"`);
  if (!RN.isPackage(r)) fail(400, `request ${id} is not an HTML package (kind ${String(r.kind).slice(0, 30)})`);
  return r;
};
// the composition of the director's render settings (never a caller's): an absolute folder with its entry HTML
function compositionOf(cfg) {
  const dir = cfg.composition || cfg.cwd, entry = cfg.entry || RN.DEFAULT_CONFIG.entry;
  if (!dir) fail(409, 'no composition folder yet: set it in Render settings… (Composition)');
  if (!path.isAbsolute(dir) || !isDir(dir)) fail(409, `the composition folder "${String(dir).slice(0, 200)}" is not a folder on this machine (Render settings…)`);
  if (!RN.ENTRY_RE.test(entry) || !fs.existsSync(path.join(dir, entry))) fail(409, `no ${String(entry).slice(0, 80)} in the composition folder (Render settings… › Entry)`);
  if (cfg.hyperframes && (!path.isAbsolute(cfg.hyperframes) || !isDir(cfg.hyperframes))) fail(409, 'the HyperFrames folder of the render settings is missing');
  return { dir, entry };
}
async function runPackage(p, id, cfg, comp, against, { revision, release }) {
  const pd = projDir(p), outRel = pkgRel(id), out = path.join(pd, outRel), repRel = pkgRel(id, 'verify'), rep = path.join(pd, repRel);
  fs.mkdirSync(path.join(pd, 'exports', 'package'), { recursive: true });
  const log = logger(path.join(pd, pkgRel(id, 'log')));
  const state = { cancelled: false, child: null }; RUNNING.set(id, state);
  const ram = { start_mb: freeMb(), min_mb: freeMb(), samples: 0 };
  const phase = (ph, extra = {}) => setReq(p, id, (x) => { x.package_run = { ...(x.package_run || {}), phase: ph, ram: { ...ram }, ...extra }; });
  const failJob = (why) => { const e = new Error(why); e.job = true; throw e; };
  const watch = () => { const f = freeMb(); ram.samples++; if (f < ram.min_mb) ram.min_mb = f; if (cfg.abort_below_mb && f < cfg.abort_below_mb && state.child) { log(`free RAM fell to ${f} MB (below ${cfg.abort_below_mb} MB): stopping`); state.ramAbort = f; kill(state.child); } };
  const run = (args) => runLogged([process.execPath, ...args], { cwd: WB_DIR, log, timeoutMs: cfg.timeout_min * 60000, watch, onChild: (c) => { state.child = c; } });
  const stop = () => { if (state.cancelled) failJob('cancelled by the director'); if (state.ramAbort) failJob(`stopped: free RAM fell to ${state.ramAbort} MB (below ${cfg.abort_below_mb} MB)`); };
  try {
    for (const d of [out, rep]) fs.rmSync(d, { recursive: true, force: true });
    log(`HTML package ${id} · composition ${comp.dir} (${comp.entry}) · revision ${revision}${against ? ` · checked against ${against.id} (${RN.specLabel(against)})` : ' · no done render to check against'}`);
    await waitRam(cfg, ram, state, log, phase, failJob);
    // 1. the exporter: the composition itself, packaged 1:1, with the interactive layer and lazy media
    phase('exporting');
    const ex = [EXPORTER, comp.dir, out, '--interactive', '--entry', comp.entry, '--project', pd, '--sample-fps', String(cfg.sample_fps), ...(cfg.hyperframes ? ['--hyperframes', cfg.hyperframes] : [])];
    log(`export: node ${ex.join(' ')}`);
    const e = await run(ex); stop();
    if (e.code === 3) failJob('the composition uses a private file: nothing was packaged (the log names it); a private file never leaves this machine');
    if (e.code !== 0) failJob(`the exporter exited with ${e.code}${e.error ? ` (${e.error})` : ''}: see the log`);
    const man = readJSON(path.join(out, 'manifest.json'), null);
    if (!man) failJob('the exporter wrote no manifest.json');
    // 2. the frame check against the render (an excerpt or a chapter: compared inside its range)
    let report = null, ag = null;
    if (against) {
      const mp4 = path.join(pd, jobRel(against.id, 'out'));
      if (!fs.existsSync(mp4)) log(`${jobRel(against.id, 'out')} is gone: the package is not checked`);
      else {
        phase('verifying', { against: against.id });
        const sp = against.render || {}, ranged = sp.scope !== 'full' || sp.t0 > 0;
        const vf = [VERIFIER, out, '--against', mp4, '--n', String(cfg.verify_n), '--report', rep, '--play', '0', ...(ranged ? ['--from', (sp.t0 / 1000).toFixed(3), '--to', (sp.t1 / 1000).toFixed(3)] : [])];
        log(`verify: node ${vf.join(' ')}`);
        const v = await run(vf); stop();
        const vj = readJSON(path.join(rep, 'verify.json'), null);
        if (!vj) failJob(`the frame check could not run (exit ${v.code}): see the log`);
        report = RN.packageReport(vj);
        ag = { render: against.id, scope: sp.scope, t0: sp.t0, t1: sp.t1, ...(sp.chapter ? { chapter: sp.chapter } : {}) };
        log(`frame match: ${report.pass} of ${report.frames} frames (${RN.pctOf(report)}) · ${report.verdict}${report.problems.length ? ` · ${report.problems.length} problem(s)` : ''}`);
      }
    } else log('no done render to check against: the package is not verified (render, then export again)');
    // 3. register the package as an export of the revision (renders.json packages[]), the request done
    const rec = { id, dir: outRel, entry: 'index.html', composition: comp.dir, against: ag, report, ...(report ? { verify_dir: repRel } : {}),
      manifest: { assets: (man.assets || []).length, bytes: man.totals?.all?.bytes ?? null, system_fonts: man.fonts?.system_fonts || [] }, revision, by: 'director', via: 'page', at: nowIso() };
    mutateRenders(p, (d) => { d.packages = (d.packages || []).filter(x => x.id !== id); d.packages.push(rec); if (d.packages.length > 100) d.packages.splice(0, d.packages.length - 100); });
    const outputs = [`${outRel}/index.html`, ...(report ? [`${repRel}/verify.json`] : [])];
    log(`done: ${outputs.join(', ')}`);
    setReq(p, id, (x) => {
      x.status = 'done'; x.outputs = outputs; x.actual_cost_usd = 0; delete x.why;
      x.package_run = { ...(x.package_run || {}), phase: 'done', ended: nowIso(), ram: { ...ram }, dir: outRel, report, against: ag, revision };
      (x.log ||= []).push({ at: nowIso(), by: 'workbench', via: 'page', status: 'done' });
    });
  } catch (e) {
    const why = String(e.job ? e.message : `export failed: ${e.message}`).slice(0, 500);
    log(why);
    setReq(p, id, (x) => { x.status = 'failed'; x.why = why; x.package_run = { ...(x.package_run || {}), phase: state.cancelled ? 'cancelled' : 'failed', ended: nowIso(), ram: { ...ram }, why }; (x.log ||= []).push({ at: nowIso(), by: 'workbench', via: 'page', status: 'failed', why }); });
  } finally { RUNNING.delete(id); release(); }
}
const pkgView = (p, r, n) => ({ id: r.id, status: r.status, label: RN.pkgLabel(r), package: r.package, by: r.by, at: r.at, ...(r.why ? { why: r.why } : {}), ...(r.package_run ? { run: r.package_run } : {}), outputs: r.outputs || [],
  ...(r.status === 'running' || n ? { log_tail: (() => { try { return fs.readFileSync(path.join(projDir(p), pkgRel(r.id, 'log')), 'utf8').split(/\r?\n/).filter(Boolean).slice(-(n || 40)); } catch (e) { return []; } })() } : {}),
  ...(r.package_run ? { log_file: path.join(projDir(p), pkgRel(r.id, 'log')) } : {}) });

// ------------------------------------------------------------------ sheets (E8)
const takeTile = (p, file, kind, text, t) => { const abs = resolveMedia(p, file); return abs && fs.existsSync(abs) ? { src: abs, kind, t, text } : { kind: 'blank', text: `${text} (missing)` }; };
const privSrc = (p, file) => isPrivate(file) || isFlaggedPrivate(file, [p]);
function sheetTiles(p, { from, id, t0, t1, every }) {
  const media = read(p, 'media.json').items || [], requests = read(p, 'requests.json').items || [];
  if (from === 'render') {
    const r = renderReq(p, id);
    if (r.status !== 'done' || !r.render_run?.out) fail(409, `render ${id} is ${r.status}: a sheet is made from a done render`);
    const abs = path.join(projDir(p), jobRel(r.id, 'out')); if (!fs.existsSync(abs)) fail(404, `${jobRel(r.id, 'out')} is gone`);
    const rt0 = r.render.t0, rt1 = r.render.t1, a = Math.max(rt0, t0 ?? rt0), b = Math.min(rt1, t1 ?? rt1);
    if (!(b > a)) fail(400, `t0 / t1: a range inside the render (${RN.tc(rt0)}–${RN.tc(rt1)})`);
    let step = Math.max(0.1, Number(every) || 1) * 1000; while ((b - a) / step > 120) step *= 2;
    const fps = r.render_run.fps || 30, tiles = [];
    for (let t = a; t < b - 1; t += step) tiles.push({ src: abs, kind: 'video', t: Math.max(0, (t - rt0) / 1000 - 0.5 / fps), text: RN.tc(t), frame: { t: Math.round(t), label: RN.tc(t) } });
    return { tiles, t0: a, t1: b, priv: false, source: id };
  }
  if (from === 'request') {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail(400, 'id: a request id');
    const r = requests.find(x => x.id === id); if (!r) fail(404, `no request "${id}"`);
    const takes = T.takesForRequest(id, { media, requests });
    const files = takes.length ? takes.map(t => ({ file: t.file, kind: t.kind, take: t.take })) : (r.outputs || []).filter(f => IMAGE.test(f) || VIDEO.test(f)).map((f, i) => ({ file: f, kind: VIDEO.test(f) ? 'video' : 'image', take: i }));
    if (!files.length) fail(409, `request ${id} has no takes yet`);
    const tiles = files.map(f => { const m = media.find(x => x.path === f.file), d = (m?.duration_ms || 0) / 2000; return { ...takeTile(p, f.file, f.kind, `${id} · take ${f.take ?? '?'}`, f.kind === 'video' ? d : undefined), frame: { take: f.take ?? null, file: f.file, label: `take ${f.take ?? '?'}` } }; });
    return { tiles, priv: files.some(f => privSrc(p, f.file)), source: id };
  }
  if (from === 'storyboard') {
    const c = ctxOf(p), a = t0 ?? 0, b = t1 ?? c.song.duration_ms;
    const shots = c.shots.filter(s => s.t1 > a && s.t0 < b);
    if (!shots.length) fail(409, 'no storyboard shots in that range');
    let priv = false;
    const tiles = shots.map(s => {
      const text = `${s.id} ${RN.tc(s.t0)}`, frame = { t: s.t0, shot: s.id, label: text };
      const cl = s.clip?.file; if (cl) { priv ||= privSrc(p, cl); return { ...takeTile(p, cl, VIDEO.test(cl) ? 'video' : 'image', text, VIDEO.test(cl) ? (s.clip.in_ms || 0) / 1000 + 0.04 : undefined), frame }; }
      const sk = s.sketch && SB.SKETCH_ID.test(s.sketch) ? `sketches/${s.sketch}.png` : null;
      for (const f of [sk, s.thumb].filter(Boolean)) { const abs = resolveMedia(p, f); if (abs && fs.existsSync(abs) && IMAGE.test(abs)) { priv ||= privSrc(p, f); return { src: abs, kind: 'image', text, frame }; } }
      return { kind: 'blank', text: `${s.id} · ${s.kind || 'shot'} · ${RN.tc(s.t0)} (no frame)`, frame };
    });
    return { tiles, t0: a, t1: b, priv, source: 'storyboard' };
  }
  fail(400, 'from: render | request | storyboard');
}
// what a frame shows, from the files: the scene, the shot (and its cast's constants), the lyric line at its time
function frameContext(p, c, t) {
  const sc = c.scenes.find(s => s.t0 <= t && t < s.t1), sh = c.shots.find(s => s.t0 <= t && t < s.t1), ln = (c.song.lines || []).find(l => l.t0 <= t && t < l.t1);
  return { ...(sc ? { scene: { id: sc.id, title: sc.title || '', text: String(sc.text || '').slice(0, 300) } } : {}), ...(sh ? { shot: { id: sh.id, title: sh.title || '', kind: sh.kind || '', text: String(sh.text || '').slice(0, 300), cast: sh.cast || [] } } : {}), ...(ln ? { lyric: { line: ln.id, text: ln.text } } : {}) };
}
function constantsFor(p, ids) {
  const out = {};
  for (const id of [...new Set(ids)].slice(0, 20)) {
    try { const { ent } = readAsset(p, 'character', id), n = A.approvedNode(ent.iter, 'identity');
      out[id] = { name: ent.name || id, constants: CK.checklist(ent).map(x => ({ text: x.text, ...(x.label ? { label: x.label } : {}) })), identity: n?.image ? { node: n.id, file: n.image, abs: resolveMedia(p, n.image) } : null };
    } catch (e) { /* not a character */ }
  }
  return out;
}
const sheetById = (d, id) => { if (typeof id !== 'string' || !RN.SHEET_ID.test(id)) fail(400, 'sheet: a sheet id (sheets_get lists them)'); const s = d.sheets.find(x => x.id === id); if (!s) fail(404, `no sheet "${id}"`); return s; };
const openAsks = (p, sheet) => { try { return notesDoc(p).notes.filter(n => n.status === 'open' && n.to === 'agent' && n.ask === 'review' && n.about === `sheet:${sheet}`); } catch (e) { return []; } };
const ITEM_NOTE = 500, NOTE_MAX = 2000;


Object.assign(ops, {
  renders_get(p, { id, log_lines = 40 } = {}) {
    reconcile(p);
    const d = rendersDoc(p), cfg = RN.configOf(d), items = (read(p, 'requests.json').items || []).filter(RN.isRender), L = lockInfo();
    const chapters = chaptersOf(p), n = Math.max(1, Math.min(400, Number(log_lines) || 40));
    const view = (r) => ({ id: r.id, status: r.status, label: RN.specLabel(r), render: r.render, by: r.by, at: r.at, ...(r.why ? { why: r.why } : {}), ...(r.render_run ? { run: r.render_run } : {}), outputs: r.outputs || [],
      ...((id ? r.id === id : r.status === 'running') ? { log_tail: logTail(p, r, n) } : {}), ...(r.render_run ? { log_file: path.join(projDir(p), jobRel(r.id, 'log')) } : {}) });
    const all = read(p, 'requests.json').items || [];
    const pkAbs = (k) => ({ ...k, abs: RN.RENDER_ID.test(String(k.id)) ? path.join(projDir(p), pkgRel(k.id)) : null });   // named from the id, never the stored dir
    if (id != null) { const x = all.find(r => r.id === id); if (RN.isPackage(x)) return { exports: [pkgView(p, x, n)], packages: d.packages.filter(k => k.id === id).map(pkAbs) }; renderReq(p, id); }
    return { exports: all.filter(RN.isPackage).map(r => pkgView(p, r)), packages: d.packages.slice(-20).map(pkAbs), against: (() => { const a = RN.againstRender(all); return a ? { id: a.id, label: RN.specLabel(a), t0: a.render?.t0, t1: a.render?.t1 } : null; })(),
      composition: { dir: cfg.composition || cfg.cwd || null, entry: cfg.entry, hyperframes: cfg.hyperframes || null },
      config: d.config ? { ...cfg, set: true } : { ...RN.DEFAULT_CONFIG, set: false, how: 'the director sets the render command in the page (Final › Renders › Render settings…); an agent cannot' },
      placeholders: RN.PLACEHOLDERS, machine: { free_ram_mb: freeMb(), floor_mb: cfg.min_free_mb, lock: L && !L.stale ? { project: L.project, id: L.id, since: L.at } : null },
      renders: (id ? items.filter(r => r.id === id) : items).map(view), order: { chapters: chapters.map(c => ({ id: c.id, name: c.name, t0: c.t0, t1: c.t1 })), not_rendered: RN.orderGaps(chapters, items) },
      sheets: d.sheets.map(s => ({ id: s.id, kind: s.kind, from: s.from, source: s.source, file: s.file, revision: s.revision, at: s.at, frames: s.frames?.length || 0, review: RN.lastReview(s)?.verdict || null, asks_open: openAsks(p, s.id).length })),
      rules: 'renders are local ($0) but heavy: an agent proposes one (render_propose) and the director starts it with a click in the page (never an agent); one at a time, only with enough free RAM, chapters before the full film. Sheets: sheet_make; reviews: sheets_get + sheet_review' };
  },
  render_propose(p, { scope, t0, t1, chapter, why, by = 'agent', via = 'agent' } = {}) {
    const d = rendersDoc(p), cfg = RN.configOf(d), c = ctxOf(p), chapters = chaptersOf(p, c);
    let spec; try { spec = RN.checkSpec({ scope, t0, t1, chapter, why }, { song: c.song, chapters, excerptMaxS: cfg.excerpt_max_s }); } catch (e) { fail(400, e.message); }
    const fromPage = via === 'page', who = fromPage ? 'director' : String(by || 'agent').slice(0, 40);
    const item = { id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`, kind: 'render', target: spec.chapter ? `chapter:${spec.chapter}` : null,
      prompt: `${RN.specLabel({ render: spec })}${spec.why ? ` · ${spec.why}` : ''}`, refs: [], est_cost: 0, status: 'draft', by: who, at: nowIso(), render: spec,
      log: [{ at: nowIso(), by: who, via: fromPage ? 'page' : 'agent', status: 'draft' }] };
    withFileLock(path.join(projDir(p), 'requests.json'), () => { const R = read(p, 'requests.json'); R.items ||= []; R.items.push(item); R.rev = (R.rev || 0) + 1; write(p, 'requests.json', R); });
    const warnings = [];
    if (spec.scope === 'full') { const g = RN.orderGaps(chapters, read(p, 'requests.json').items); if (g.length) warnings.push(`chapters not rendered yet (${g.join(', ')}): the etiquette renders chapters before the full film; the director may still start it`); }
    if (!d.config) warnings.push('no render command yet: the director sets it in the page (Final › Renders › Render settings…)');
    return { request: item, ...(warnings.length ? { warnings } : {}), note: fromPage ? 'a draft render: press Render… to start it' : 'a draft render job: only the director starts it, in the page (Final › Renders or Review › Queue: Render…). Tell them what it is for' };
  },
  render_config(p, { config, via } = {}) {
    pageOnly(via, 'setting the render command');
    if (config === null) return mutateRenders(p, (d) => { d.config = null; return { config: null }; });
    let c; try { c = RN.checkConfig(config, { test: TEST }); } catch (e) { fail(400, e.message); }
    if (c.cwd) { if (!path.isAbsolute(c.cwd)) fail(400, 'cwd: an absolute folder (or empty: the project folder)'); let st = null; try { st = fs.statSync(c.cwd); } catch (e) { /* missing */ } if (!st?.isDirectory()) fail(400, `cwd: no folder "${c.cwd}"`); }
    for (const k of ['composition', 'hyperframes']) if (c[k] && (!path.isAbsolute(c[k]) || !isDir(c[k]))) fail(400, `${k}: an absolute folder on this machine (or empty)`);   // C5
    return mutateRenders(p, (d) => { d.config = { ...c, by: 'director', via: 'page', at: nowIso() }; return { config: d.config }; });
  },
  async render_start(p, { id, force_order = false, via } = {}) {
    pageOnly(via, 'starting a render');
    reconcile(p);
    const r = renderReq(p, id), d = rendersDoc(p), cfg = RN.configOf(d);
    if (!['draft', 'approved', 'failed'].includes(r.status)) fail(409, `render ${id} is ${r.status}${r.status === 'done' ? ': propose a new render to render it again' : ''}`);
    if (!d.config?.command) fail(409, 'no render command yet: set it first (Render settings…)');
    const c = ctxOf(p), chapters = chaptersOf(p, c);
    let spec; try { spec = RN.checkSpec(r.render, { song: c.song, chapters, excerptMaxS: cfg.excerpt_max_s }); } catch (e) { fail(400, e.message); }
    if (spec.chapter) { const ch = (c.bd.chapters || []).find(x => x.id === spec.chapter); if (ch?.file) spec.chapter_file = ch.file; }
    if (spec.scope === 'full' && !force_order) { const g = RN.orderGaps(chapters, read(p, 'requests.json').items); if (g.length) fail(409, `chapters before the full film (PRODUCTION.md): ${g.join(', ')} not rendered yet. Render them first, or confirm "render the full film anyway"`); }
    const release = takeLock(p, id);
    const revision = RN.currentRevision(revDoc(p));
    try {
      setReq(p, id, (x) => {
        x.render = { ...x.render, t0: spec.t0, t1: spec.t1 }; delete x.why; delete x.outputs;
        (x.log ||= []).push({ at: nowIso(), by: 'director', via: 'page', status: 'approved', render: true }, { at: nowIso(), by: 'director', via: 'page', status: 'running' });
        x.status = 'running'; x.render_run = { phase: 'waiting_ram', started: nowIso(), log: `renders/${id}/render.log`, revision, by: 'director', via: 'page', fps: cfg.fps };
      });
      try { fs.rmSync(path.join(projDir(p), 'renders', id, 'render.log'), { force: true }); } catch (e) { /* none */ }
    } catch (e) { release(); throw e; }
    runJob(p, id, cfg, spec, { revision, release }).catch((e) => console.error('render:', e.message));
    return { started: id, label: RN.specLabel({ render: spec }), revision, etiquette: { free_ram_mb: freeMb(), floor_mb: cfg.min_free_mb, workers: cfg.workers, size: `${cfg.width}x${cfg.height}` }, note: 'running: the page shows the phase and the log (renders_get)' };
  },
  // C5: an export of the interactive HTML package. An agent proposes one (a draft; it names nothing to run and no path: the
  // composition, the exporter and the folders are the workbench's and the director's); only the page starts it
  package_propose(p, { why, against, by = 'agent', via = 'agent' } = {}) {
    const fromPage = via === 'page', who = fromPage ? 'director' : String(by || 'agent').slice(0, 40), items = read(p, 'requests.json').items || [];
    if (against != null && against !== '') { if (typeof against !== 'string' || !RN.RENDER_ID.test(against)) fail(400, 'against: a render request id (renders_get)'); if (!RN.againstRender(items, against)) fail(409, `render ${against} is not a done render`); }
    const w = why != null ? String(why).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 400) : '';
    const item = { id: `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`, kind: 'package', target: null, prompt: `interactive HTML package${w ? ` · ${w}` : ''}`, refs: [], est_cost: 0, status: 'draft', by: who, at: nowIso(),
      package: { ...(w ? { why: w } : {}), ...(against ? { against } : {}) }, log: [{ at: nowIso(), by: who, via: fromPage ? 'page' : 'agent', status: 'draft' }] };
    withFileLock(path.join(projDir(p), 'requests.json'), () => { const R = read(p, 'requests.json'); R.items ||= []; R.items.push(item); R.rev = (R.rev || 0) + 1; write(p, 'requests.json', R); });
    const warnings = [], cfg = RN.configOf(rendersDoc(p));
    if (!(cfg.composition || cfg.cwd)) warnings.push('no composition folder in the render settings yet: the director sets it (Render settings… › Composition)');
    if (!RN.againstRender(items, against || null)) warnings.push('no done render yet: the package would not be checked frame by frame (propose a render first: render_propose)');
    return { request: item, ...(warnings.length ? { warnings } : {}), note: fromPage ? 'a draft export: File › Export › Interactive HTML package… starts it' : 'a draft export: only the director starts it, in the page (File › Export › Interactive HTML package…). Tell them what it is for' };
  },
  async package_start(p, { id, against, via } = {}) {
    if (via !== 'page') fail(403, 'exporting the HTML package is the director\'s, in the page (File › Export › Interactive HTML package…): an agent proposes one with package_propose and never starts it');
    let r = id != null ? packageReq(p, id) : null;   // the ids first (400), then the settings (409)
    if (against != null && against !== '' && (typeof against !== 'string' || !RN.RENDER_ID.test(against))) fail(400, 'against: a render request id');
    reconcile(p);
    const d = rendersDoc(p), cfg = RN.configOf(d), comp = compositionOf(cfg);
    if (r && !['draft', 'approved', 'failed'].includes(r.status)) fail(409, `export ${r.id} is ${r.status}${r.status === 'done' ? ': export again to make a new package' : ''}`);
    const items = read(p, 'requests.json').items || [], named = (against != null && against !== '' ? against : null) ?? r?.package?.against ?? null;
    if (named != null && (typeof named !== 'string' || !RN.RENDER_ID.test(named))) fail(400, 'against: a render request id');
    const ag = RN.againstRender(items, named);
    if (named && !ag) fail(409, `render ${named} is not a done render: pick another (or none: the newest)`);
    if (!r) { const L = lockInfo(); if (L && !L.stale) takeLock(p, '-', 'package'); r = ops.package_propose(p, { via: 'page', ...(named ? { against: named } : {}) }).request; }   // busy: the 409 before a draft is made
    const release = takeLock(p, r.id, 'package');
    const revision = RN.currentRevision(revDoc(p));
    try {
      setReq(p, r.id, (x) => {
        delete x.why; delete x.outputs; if (ag) x.package = { ...(x.package || {}), against: ag.id };
        (x.log ||= []).push({ at: nowIso(), by: 'director', via: 'page', status: 'approved', package: true }, { at: nowIso(), by: 'director', via: 'page', status: 'running' });
        x.status = 'running'; x.package_run = { phase: 'waiting_ram', started: nowIso(), log: pkgRel(r.id, 'log'), revision, by: 'director', via: 'page', ...(ag ? { against: ag.id } : {}) };
      });
    } catch (e) { release(); throw e; }
    runPackage(p, r.id, cfg, comp, ag, { revision, release }).catch((e) => console.error('package:', e.message));
    return { started: r.id, composition: comp.dir, entry: comp.entry, against: ag ? { id: ag.id, label: RN.specLabel(ag) } : null, revision, out: pkgRel(r.id), note: 'running: the page shows the phase, then the frame-match report (renders_get)' };
  },
  package_cancel(p, { id, via } = {}) {
    if (via !== 'page') fail(403, 'cancelling an export is the director\'s, in the page');
    const r = packageReq(p, id), st = RUNNING.get(r.id);
    if (!st) { reconcile(p); return { cancelled: false, why: `export ${id} is not running here` }; }
    st.cancelled = true; kill(st.child);
    return { cancelled: true, id };
  },
  render_cancel(p, { id, via } = {}) {
    pageOnly(via, 'cancelling a render');
    const r = renderReq(p, id), st = RUNNING.get(r.id);
    if (!st) { reconcile(p); return { cancelled: false, why: `render ${id} is not running here` }; }
    st.cancelled = true; kill(st.child);
    return { cancelled: true, id };
  },
  sheet_make(p, { from, id, t0, t1, every = 1, cols = 6, title, by = 'agent', via = 'agent' } = {}) {
    if (!RN.SHEET_FROM.includes(from)) fail(400, 'from: render | request | storyboard');
    const c = ctxOf(p), dur = c.song.duration_ms;
    const tm = (v, n) => { if (v == null || v === '') return undefined; const x = Math.round(Number(v)); if (!Number.isFinite(x) || x < 0 || x > dur) fail(400, `${n}: song ms inside 0-${dur}`); return x; };
    const a = tm(t0, 't0'), b = tm(t1, 't1'); if (a != null && b != null && b <= a) fail(400, 't0 < t1');
    if (!(Number.isInteger(Number(cols)) && cols >= 1 && cols <= 12)) fail(400, 'cols: 1-12');
    const S = sheetTiles(p, { from, id, t0: a, t1: b, every });
    const d0 = rendersDoc(p), sid = newSheetId(d0), dirRel = S.priv ? 'private/sheets' : 'sheets', rel = `${dirRel}/${sid}.jpg`;
    const res = C.sheet(S.tiles, path.join(projDir(p), rel), { cols: Number(cols) });
    const revision = RN.currentRevision(revDoc(p)), label = title ? String(title).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 120) : `contact sheet · ${from}${S.source && S.source !== 'storyboard' ? ' ' + S.source : ''}`;
    const m = register(p, rel, 'sheet', label, { request: from === 'request' || from === 'render' ? S.source : null, render: from === 'render' ? S.source : null, sheet: sid, revision, private: S.priv });
    const rec = addSheet(p, { id: sid, kind: 'contact', from, source: S.source, file: rel, media: m.id, ...(S.t0 != null ? { t0: S.t0, t1: S.t1 } : {}), cols: res.cols, title: label, ...(S.priv ? { private: true } : {}),
      frames: S.tiles.map(x => x.frame || { label: x.text }), revision, by: via === 'page' ? 'director' : String(by || 'agent').slice(0, 40), via: via === 'page' ? 'page' : 'agent', at: nowIso(), asks: [], reviews: [] });
    return { sheet: rec.id, file: rel, abs: path.join(projDir(p), rel), media: m.id, tiles: res.tiles, revision, ...(S.priv ? { private: true } : {}), note: 'look at it (abs), then a review: sheet_review; the director may ask you for a second opinion (a note, ask "review")' };
  },
  sheet_ask(p, { sheet, text, via = 'agent' } = {}) {
    const d = rendersDoc(p), s = sheetById(d, sheet);
    const extra = typeof text === 'string' && text.trim() ? `\n${text.trim().slice(0, 2000)}` : '';
    const n = addNote(p, { target: { stage: 'final', kind: 'stage' }, to: 'agent', ask: 'review', about: `sheet:${s.id}`, by: via === 'page' ? 'director' : 'agent', via: via === 'page' ? 'page' : 'agent',
      text: `Second opinion: review the contact sheet ${s.id} (${s.kind}, ${s.file}) against the script and the characters' constants. sheets_get {sheet: "${s.id}"} gives the file and what each frame should show; answer with sheet_review.${extra}` });
    mutateRenders(p, (dd) => { const x = dd.sheets.find(y => y.id === s.id); (x.asks ||= []).push(n.id); });
    return { note: n.id, sheet: s.id };
  },
  sheets_get(p, { sheet } = {}) {
    const d = rendersDoc(p), c = ctxOf(p);
    const list = sheet != null ? [sheetById(d, sheet)] : d.sheets.slice(-50);
    return { sheets: list.map(s => {
      const frames = (s.frames || []).map(f => ({ ...f, ...(f.t != null ? { time: RN.tc(f.t), ...frameContext(p, c, f.t) } : {}) }));
      const cast = frames.flatMap(f => f.shot?.cast || []);
      return { ...s, abs: path.join(projDir(p), s.file), frames, constants: constantsFor(p, cast), asks_open: openAsks(p, s.id).map(n => ({ id: n.id, text: n.text })) };
    }), how: 'open abs and compare each frame with what it should show (scene, shot, lyric) and with the constants of the characters on screen; answer with sheet_review {sheet, verdict: ok | issues | fail, items: [{t, shot?, constant?, ok, note}], note}' };
  },
  sheet_review(p, { sheet, verdict, items = [], note = '', by = 'agent' } = {}) {
    const d = rendersDoc(p), s = sheetById(d, sheet), c = ctxOf(p);
    if (!RN.VERDICTS.includes(verdict)) fail(400, 'verdict: ok | issues | fail');
    if (!Array.isArray(items) || items.length > 60) fail(400, 'items: a list (at most 60) of {t?, shot?, constant?, ok, note}');
    const clean = items.map((x, i) => {
      if (!x || typeof x !== 'object' || typeof x.ok !== 'boolean') fail(400, `items[${i}]: {t?, shot?, constant?, ok: true | false, note}`);
      const o = { ok: x.ok, note: String(x.note ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, ITEM_NOTE) };
      if (x.t != null) { const t = Math.round(Number(x.t)); if (!Number.isFinite(t) || t < 0 || t > c.song.duration_ms) fail(400, `items[${i}].t: song ms`); o.t = t; }
      if (x.shot != null) { if (typeof x.shot !== 'string' || !SB.SHOT_ID.test(x.shot) || !c.shots.some(sh => sh.id === x.shot)) fail(404, `items[${i}].shot: no shot "${String(x.shot).slice(0, 40)}"`); o.shot = x.shot; }
      if (x.constant != null) o.constant = String(x.constant).replace(/[\u0000-\u001f]/g, ' ').slice(0, 200);
      return o;
    });
    if (verdict === 'ok' && clean.some(x => !x.ok)) fail(400, 'verdict ok with a failed item: say "issues" (or "fail")');
    const nt = String(note ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, NOTE_MAX);
    const rec = mutateRenders(p, (dd) => { const x = dd.sheets.find(y => y.id === s.id); const r = { id: `sr${String((x.reviews || []).length + 1).padStart(2, '0')}`, verdict, items: clean, note: nt, by: String(by || 'agent').slice(0, 40), via: 'agent', at: nowIso() }; (x.reviews ||= []).push(r); return r; });
    const absorbed = [];
    for (const n of openAsks(p, s.id)) { try { setStatus(p, n.id, 'absorbed', { reply: `second opinion on ${s.id}: ${verdict}${nt ? ` · ${nt.slice(0, 300)}` : ''}${clean.filter(x => !x.ok).length ? ` · ${clean.filter(x => !x.ok).length} issue(s)` : ''}`, by: rec.by, via: 'agent' }); absorbed.push(n.id); } catch (e) { /* gone */ } }
    return { sheet: s.id, review: rec, absorbed, note: 'a review is advice: it never approves, rejects or picks anything' };
  },
});
