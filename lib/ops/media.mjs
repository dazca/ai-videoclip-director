// D8: importing existing images and video (ROADMAP_v4 D8, A4, A6). Three ways in, all ending in media.json:
//   media_scan    (read only) a file or folder under a configured media root: the media files in it (sniffed by their
//                 bytes), which are registered already, which are PRIVATE, and, for a generation output tree (falgen's
//                 out/<id>/job.json, or the workbench runner's gen/<request>/job.json), each job's prompt, model, refs,
//                 takes and cost, with where that cost stands (recorded in costs.json, counted from the linked falgen
//                 ledger, or not counted yet: a ledger row next to the tree, the job's own numbers, or an estimate from
//                 js/prices.js)
//   media_import  registers files under a media root IN PLACE (never copied): kind, label, private, job / take from
//                 job.json, a link to a request. The agent's tool too. A private flag is never lowered: a path the
//                 PRIVATE rule matches or a file already flagged private refuses private:false (403)
//   media_upload  (page only) the files the director drops on the page, in chunks: at most 200 MB a file, sniffed by
//                 their first bytes (PNG / JPEG / WebP / GIF / MP4 / MOV / WebM; anything else 415), written to
//                 data/<p>/media/<kind>/ (private/<kind>/ when private) and registered
// and "use as" (media_use, page only): a registered file becomes an identity / look / base / variant node (asset_act
// "import": no request, nothing paid, provenance kept) or a shot's take / start frame (linkShotMedia below). An agent
// proposes these instead: node_import_propose for a node, a note on the shot for a take or start frame.
// Recording a recovered cost is cost_record (the page calls it; the same job is recorded once, and a job the linked
// falgen ledger already counts is not offered).
import fs from 'node:fs';
import path from 'node:path';
import * as SB from '../../js/storyboard.js';
import * as T from '../../js/takes.js';
import { modelOf, price } from '../../js/prices.js';
import { CFG, IMAGE, VIDEO, cleanRel, fail, inside, isFlaggedPrivate, isMediaRootPath, isPrivate, makeThumbs, nowIso, ops, projDir, read, readJSON, relTo, withFileLock, write } from './_shared.mjs';
import { falgenSource } from './requests.mjs';
import { boardDoc } from './storyboard.mjs';
import { landed } from './_hooks.mjs';

export const UPLOAD_MAX = 200 * 1024 * 1024;   // bytes per uploaded file
const UPLOAD_SPARE = (process.env.WB_TEST === '1' && Number(process.env.WB_UPLOAD_SPARE)) || 1024 * 1024 * 1024;   // free disk kept after an upload
export const CHUNK_MAX = 6 * 1024 * 1024;      // bytes per upload chunk (the page sends 4 MB)
const KIND_RE = /^[a-z0-9_-]{1,32}$/, JOB_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$/;

// ------------------------------------------------------------------ type sniffing: the bytes decide, not the name
// -> {type: image|video, ext} or null. An ISO-BMFF file is video unless its brand says audio (M4A / M4B).
export function sniff(b) {
  if (!b || b.length < 12) return null;
  const s = (a, z) => b.toString('latin1', a, z);
  if (b[0] === 0x89 && s(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return { type: 'image', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image', ext: 'jpg' };
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return { type: 'image', ext: 'webp' };
  if (/^GIF8[79]a$/.test(s(0, 6))) return { type: 'image', ext: 'gif' };
  if (s(4, 8) === 'ftyp') { const brand = s(8, 12); if (/^M4[AB] /.test(brand)) return null; return { type: 'video', ext: /^qt/.test(brand) ? 'mov' : 'mp4' }; }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { type: 'video', ext: 'webm' };
  return null;
}
function sniffFile(abs) {
  let fd; try { fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(32); const n = fs.readSync(fd, b, 0, 32, 0); return sniff(b.subarray(0, n)); }
  catch (e) { return null; } finally { if (fd != null) fs.closeSync(fd); }
}
const extType = (p) => (IMAGE.test(p) ? 'image' : VIDEO.test(p) ? 'video' : null);
const NOT_MEDIA = 'not an image or a video (PNG, JPEG, WebP, GIF, MP4, MOV, WebM, judged by the file\'s bytes)';

// ------------------------------------------------------------------ paths under the media roots
// a path the caller gives (base-relative "project/gen/out/A1", or absolute) -> {abs, rel} under a media root, else 403 /
// 400. The real path (symlinks resolved) must be under a media root too.
const roots = () => CFG.mediaRoots.join(', ') || 'none configured (workbench.config.json media_roots)';
export function rootPath(given) {
  if (typeof given !== 'string' || !given.trim() || given.length > 1000 || /\0/.test(given)) fail(400, 'path: a file or folder under a media root');
  let rel = given.trim();
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) {
    const r = path.relative(CFG.mediaBase, path.resolve(rel));
    if (!r || r.startsWith('..') || path.isAbsolute(r)) fail(403, `${given}: outside the media base and its media roots (${roots()})`);
    rel = r.split(path.sep).join('/');
  } else if (!cleanRel(rel.replace(/\/+$/, ''))) fail(400, `${given}: a relative path without "..", "." or "\\"`);
  rel = rel.replace(/\/+$/, '');
  const under = (r, dir) => isMediaRootPath(r) || (dir && isMediaRootPath(r + '/'));
  const abs = inside(CFG.mediaBase, rel);
  if (!abs || !fs.existsSync(abs)) { if (!abs || !under(rel, true)) fail(403, `${given}: not under a media root (${roots()})`); fail(404, `${given}: no such file or folder`); }
  let real; try { real = fs.realpathSync(abs); } catch (e) { fail(404, `${given}: no such file or folder`); }
  const realRel = relTo(fs.realpathSync(CFG.mediaBase), real), dir = fs.statSync(real).isDirectory();
  if (realRel.startsWith('..') || !under(realRel, dir) || !under(rel, dir)) fail(403, `${given}: not under a media root (${roots()})`);
  return { abs: real, rel: relTo(CFG.mediaBase, abs), dir };
}
const privOf = (p, rel) => isPrivate(rel) || isFlaggedPrivate(rel, [p]);

// ------------------------------------------------------------------ generation jobs (job.json) and their cost
const same = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
// falgen's ledger next to its tree (<root>/LEDGER.md for <root>/gen/out/<id>/), read only, inside the media base
function nearbyLedger(jobDir) {
  const f = path.join(path.dirname(path.dirname(path.dirname(jobDir))), 'LEDGER.md');
  if (!inside(CFG.mediaBase, path.relative(CFG.mediaBase, f))) return null;
  let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return null; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const c = line.split('|').slice(1, -1).map(x => x.trim());
    if (c.length < 5 || !/^\d{4}-\d{2}-\d{2}$/.test(c[0]) || !/via falgen/i.test(c[2])) continue;
    const usd = Number(String(c[4]).replace(/[$~,\s]/g, '')); if (Number.isFinite(usd)) rows.push({ date: c[0], job: c[1], usd });
  }
  return { file: relTo(CFG.mediaBase, f), rows };
}
// an estimate from the one price table for a job made outside the queue (the closest model to its endpoint)
function estimateJob(info) {
  const m = modelOf({ tool: info.endpoint || info.model || '', kind: info.kind === 'video' ? 'shot-video' : '' });
  const tier = m === 'nb2' ? (/^1k$/i.test(info.resolution || '') ? '1K' : '2K') : undefined;
  const pr = price(m, tier, { date: info.date });
  if (!pr) return null;
  const n = Math.max(1, info.files.length || (info.n || 1) * (info.takes || 1));
  const units = pr.unit === 's' ? n * Math.max(1, Number(info.duration) || 5) : n;
  return { usd: +(pr.usd * units).toFixed(3), why: `estimate: ${pr.name} $${pr.usd}${pr.unit === 's' ? '/s' : ''} x ${units}${pr.unit === 's' ? ' s' : ''} (js/prices.js list price, verified ${pr.verified}; the closest model to ${info.endpoint || info.model || 'its endpoint'})` };
}
// where a job's money stands: recorded (costs.json), counted (the linked falgen ledger: already in the total), or not
// counted yet (a ledger row next to the tree, the job's own per-take numbers, an estimate); `offer` = cost_record args
export function jobCost(p, info, jobDir) {
  const C = read(p, 'costs.json'), items = (C.items || []).filter(x => same(x.job, info.id) || (!x.job && same(x.id, info.id)) || same(x.request, info.id));
  if (items.length) return { status: 'recorded', usd: +items.reduce((s, x) => s + (Number(x.usd) || 0), 0).toFixed(3), source: 'workbench', items: items.map(x => x.id), why: 'in costs.json already' };
  let fg = null; try { fg = falgenSource(p); } catch (e) { /* not linked */ }
  const row = fg?.rows?.find(r => same(r.job, info.id));
  if (row) return { status: 'counted', usd: row.usd, source: 'falgen', date: row.date, why: `in the linked falgen ledger (${fg.ledger}): already in the total` };
  const takes = Math.max(1, info.files.length);
  const offer = (usd, note) => ({ usd, via: info.runner === 'workbench' ? 'retro' : 'falgen', job: info.id, ...(takes > 1 ? { takes } : {}), ...(info.endpoint ? { tool: info.endpoint } : {}), note });
  const near = nearbyLedger(jobDir), nr = near?.rows.filter(r => same(r.job, info.id));
  if (nr?.length) { const usd = +nr.reduce((s, r) => s + r.usd, 0).toFixed(3); return { status: 'not_counted', usd, source: 'ledger', date: nr[0].date, ledger: near.file, why: `a falgen ledger row (${near.file}) the project does not count`, offer: offer(usd, `${info.id}: from ${near.file} (D8 import)`) }; }
  if (info.takes_usd != null) return { status: 'not_counted', usd: info.takes_usd, source: 'job.json', why: 'the per-take costs in its job.json', offer: offer(info.takes_usd, `${info.id}: from its job.json (D8 import)`) };
  const e = estimateJob(info);
  return e ? { status: 'not_counted', usd: e.usd, source: 'estimate', why: e.why, offer: offer(e.usd, `${info.id}: ${e.why} (D8 import)`) } : { status: 'unknown', usd: null, source: null, why: 'no ledger row and no price for its model' };
}
// a folder's job.json -> {id, runner, kind, model, endpoint, prompt, refs[{path, private}], files[], takes, ...} or null.
// falgen: {job: {id, kind, model, prompt, refs | image, n, takes, resolution, duration, notes}, endpoint, log[], files[]};
// the workbench runner: {request, generator, model, endpoint, refs, takes: [{take, status, file, usd}]}. The refs are
// names only: never opened (they are often private photos).
export function readJob(p, dirAbs) {
  const j = readJSON(path.join(dirAbs, 'job.json'), null);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const wb = !j.job && (j.request || Array.isArray(j.takes)), job = wb ? j : (j.job && typeof j.job === 'object' ? j.job : j);
  const id = String((wb ? j.request : job.id) || path.basename(dirAbs));
  if (!JOB_RE.test(id)) return { id: path.basename(dirAbs), error: `job id "${id.slice(0, 40)}" is not usable` };
  const base = (f) => typeof f === 'string' && f && !/[\\/]|^\.\.?$/.test(f) && f.length <= 200;
  let files = wb ? j.takes.filter(t => t?.status === 'done').flatMap(t => t.files || [t.file]) : Array.isArray(j.files) ? j.files : [];
  files = files.filter(base);
  if (!files.length) files = fs.readdirSync(dirAbs).filter(f => base(f) && extType(f) && f.startsWith(id + '_')).sort();
  const refs = (Array.isArray(job.refs) ? job.refs : job.image ? [job.image] : []).filter(r => typeof r === 'string').slice(0, 30).map(r => ({ path: r.slice(0, 300), private: privOf(p, r) }));
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v == null ? null : String(v).slice(0, n));
  const takesUsd = wb ? j.takes.reduce((s, t) => s + (t?.status === 'done' ? Number(t.usd) || 0 : 0), 0) : null;
  let mtime = null; try { mtime = fs.statSync(path.join(dirAbs, 'job.json')).mtime.toISOString().slice(0, 10); } catch (e) { /* none */ }
  const info = { id, runner: wb ? 'workbench' : 'falgen', kind: str(job.kind, 20) || (files.some(f => VIDEO.test(f)) ? 'video' : 'image'), model: str(job.model, 60), endpoint: str(j.endpoint || job.endpoint, 120),
    prompt: str(job.prompt, 8000) || '', notes: str(job.notes, 2000), resolution: str(job.resolution, 12), duration: Number(job.duration) || null, aspect: str(job.aspect, 12),
    n: Number(job.n) || null, takes: Number(wb ? j.takes.length : job.takes) || null, refs, files, ok: wb ? files.length : (Array.isArray(j.log) ? j.log.filter(x => x?.ok).length : null),
    ...(takesUsd != null ? { takes_usd: +takesUsd.toFixed(3) } : {}), ...(Array.isArray(job.after) ? { after: job.after.map(String).slice(0, 20) } : {}), date: mtime };
  info.cost = jobCost(p, info, dirAbs);
  return info;
}
// the take of a file in its job: its place in the job's file list (falgen A1_0_1.png = the 2nd image), else its _<n> suffix
const takeOf = (info, name) => { const i = info.files.indexOf(name); if (i >= 0) return i; const m = /_(\d+)\.\w+$/.exec(name); return m ? Number(m[1]) : null; };
const short = (s, n = 70) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ------------------------------------------------------------------ registered media, under the lock of media.json
const mediaFile = (p) => path.join(projDir(p), 'media.json');
function mutateMedia(p, fn) {
  return withFileLock(mediaFile(p), () => {
    const doc = read(p, 'media.json'); doc.items ||= []; const r = fn(doc);
    doc.count = doc.items.length; doc.by_kind = doc.items.reduce((o, x) => (o[x.kind] = (o[x.kind] || 0) + 1, o), {});
    write(p, 'media.json', doc); return r;
  });
}
const findMedia = (p, key) => {
  const items = read(p, 'media.json').items || [], k = String(key || '').replace(/\\/g, '/').toLowerCase();
  return items.find(x => x.id === key) || items.find(x => String(x.path).toLowerCase() === k) || null;
};

// ------------------------------------------------------------------ a shot's take / start frame (D6 reads these)
// The director's "use as shot take / start frame" is recorded on the media item: `shots` gets the shot, `use_as[]` gets
// {shot, as: take | start_frame, by, via, at} (one start frame per shot: the previous one loses it). A start frame also
// becomes the shot's `thumb` in a new storyboard version (an image; a private one shows its private thumbnail).
// shotMediaLinks(p, shot) -> {takes: [...], start_frame} is what the take picker (D6, takes_*) reads.
export const shotMediaLinks = (p, shot) => T.shotLinks(read(p, 'media.json').items || [], shot);
export function linkShotMedia(p, { shot, media, as, by = 'director', via = 'page' } = {}) {
  if (!['take', 'start_frame'].includes(as)) fail(400, 'as: take or start_frame');
  if (typeof shot !== 'string' || !SB.SHOT_ID.test(shot)) fail(400, 'shot: a storyboard shot id');
  const s = SB.boardShots(boardDoc(p)).find(x => x.id === shot); if (!s) fail(404, `no shot "${shot}" in the current storyboard`);
  const m0 = findMedia(p, media); if (!m0) fail(404, `no registered media "${media}" (import it first)`);
  if (as === 'start_frame' && !IMAGE.test(m0.path)) fail(400, `${m0.id} is not an image: a start frame is a still`);
  if (as === 'take' && !IMAGE.test(m0.path) && !VIDEO.test(m0.path)) fail(400, `${m0.id} is not an image or a video`);
  const at = nowIso();
  const m = mutateMedia(p, (doc) => {
    if (as === 'start_frame') for (const x of doc.items) if (x.id !== m0.id && x.use_as) x.use_as = x.use_as.filter(u => !(u.shot === shot && u.as === 'start_frame'));
    const x = doc.items.find(y => y.id === m0.id);
    x.shots = [...new Set([...(x.shots || []), shot])];
    x.use_as = [...(x.use_as || []).filter(u => !(u.shot === shot && u.as === as)), { shot, as, by, via, at }];
    if (!x.private && x.status !== 'used') x.status = 'picked';
    return x;
  });
  let version = null;
  if (as === 'start_frame') {
    const thumb = m.private ? (m.thumb && isPrivate(m.thumb) ? m.thumb : null) : m.path;
    if (thumb && thumb !== s.thumb) {
      const f = path.join(projDir(p), 'storyboard.json');
      version = withFileLock(f, () => {
        const d = boardDoc(p), cur = SB.currentBoard(d);
        const shots = structuredClone(cur?.shots || SB.boardShots(d)).map(x => (x.id === shot ? { ...x, thumb } : x));
        const v = SB.addBoardVersion(d, shots, { by, via, message: `start frame of ${shot}: ${m.id}` });
        delete d.derived; try { SB.checkBoard(d); } catch (e) { fail(400, e.message); }
        d.rev = (d.rev || 0) + 1; write(p, 'storyboard.json', d); return v.id;
      });
    }
  }
  return { shot, as, media: m.id, path: m.path, ...(version ? { storyboard_version: version } : {}), links: shotMediaLinks(p, shot) };
}

Object.assign(ops, {
  // read only: what is in a file or folder under a media root, and the generation jobs it holds
  media_scan(p, { path: given, recursive = true, limit = 500 } = {}) {
    projDir(p);
    const { abs, rel, dir } = rootPath(given), max = Math.min(Math.max(1, Number(limit) || 500), 2000);
    const items = read(p, 'media.json').items || [], byPath = new Map(items.map(m => [String(m.path).toLowerCase(), m]));
    const files = [], skipped = [], jobs = {}, jobOfDir = new Map();
    let seen = 0, more = false;
    const job = (d) => { if (!jobOfDir.has(d)) { let j = null; try { j = fs.existsSync(path.join(d, 'job.json')) ? readJob(p, d) : null; } catch (e) { j = { id: path.basename(d), error: e.message }; } jobOfDir.set(d, j); if (j && !j.error) jobs[j.id] = j; } return jobOfDir.get(d); };
    const add = (f) => {
      const r = relTo(CFG.mediaBase, f), name = path.basename(f);
      if (name === 'job.json') return;
      if (!extType(name)) { if (skipped.length < 200) skipped.push({ path: r, why: 'not a media file name' }); return; }
      if (!isMediaRootPath(r)) { if (skipped.length < 200) skipped.push({ path: r, why: 'not under a media root' }); return; }
      const sn = sniffFile(f);
      if (!sn || sn.type !== extType(name)) { if (skipped.length < 200) skipped.push({ path: r, why: sn ? `its bytes say ${sn.ext}, its name says otherwise` : NOT_MEDIA }); return; }
      if (files.length >= max) { more = true; return; }
      const j = job(path.dirname(f)), reg = byPath.get(r.toLowerCase()), st = fs.statSync(f), take = j && !j.error ? takeOf(j, name) : null;
      files.push({ path: r, name, type: sn.type, ext: sn.ext, size: st.size, private: privOf(p, r), registered: reg ? reg.id : null, ...(reg ? { registered_kind: reg.kind, registered_private: !!reg.private } : {}),
        kind: reg?.kind || (sn.type === 'video' ? 'clip' : 'still'), ...(j && !j.error ? { job: j.id, take, label: `${j.id}${take != null ? '.' + take : ''} · ${short(j.prompt || j.notes || name, 60)}` } : { label: name }) });
    };
    const walkDir = (d, depth) => {
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      ents.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
      for (const e of ents) {
        if (e.name.startsWith('.') || ++seen > 20000) continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) { if (recursive && depth < 4) walkDir(f, depth + 1); }
        else if (e.isFile()) add(f);   // (a symlink is neither: skipped)
      }
    };
    if (dir) walkDir(abs, 0); else add(abs);
    const privs = files.filter(f => f.private).length;
    return { path: rel, folder: dir, files, jobs: Object.values(jobs), skipped: skipped.slice(0, 50), skipped_count: skipped.length, ...(more ? { more: true, note: `only the first ${max} files (limit)` } : {}),
      counts: { files: files.length, registered: files.filter(f => f.registered).length, private: privs, jobs: Object.keys(jobs).length, costs_not_counted: Object.values(jobs).filter(j => j.cost?.status === 'not_counted').length },
      rules: 'media_import registers these in place (never copied). private is forced for a PRIVATE path (and never lowered). A job\'s cost: cost_record its `cost.offer` when status is not_counted (recorded / counted: already in the total).' };
  },

  // register files under a media root, in place; the agent's tool and the page's "Import" for a path / folder
  media_import(p, { paths, items, kind, label, private: priv, entities, request, job_links = true, by = 'agent', via = 'agent' } = {}) {
    projDir(p);
    const list = Array.isArray(items) ? items : Array.isArray(paths) ? paths.map(x => ({ path: x })) : null;
    if (!list || !list.length) fail(400, 'paths: [file or folder paths under a media root] (or items: [{path, kind?, label?, private?}])');
    if (list.length > 500) fail(400, 'at most 500 files per call');
    if (kind != null && !KIND_RE.test(kind)) fail(400, 'kind: 1-32 lower-case letters, digits, _ and - (still, clip, sheet, ref…)');
    if (priv != null && typeof priv !== 'boolean') fail(400, 'private: true or false');
    if (entities != null && (!Array.isArray(entities) || entities.some(x => typeof x !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(x)))) fail(400, 'entities: a list of entity ids');
    if (request != null && !(read(p, 'requests.json').items || []).some(r => r.id === request)) fail(404, `no request "${request}" (requests_list)`);
    // expand folders, check every file first: nothing is registered unless all of them pass
    const plan = [], jobs = new Map(), registered = new Map((read(p, 'media.json').items || []).map(m => [String(m.path).toLowerCase(), m]));
    for (const [i, it0] of list.entries()) {
      const it = typeof it0 === 'string' ? { path: it0 } : it0;
      if (!it || typeof it !== 'object') fail(400, `items[${i}]: {path, kind?, label?, private?}`);
      if (it.kind != null && !KIND_RE.test(it.kind)) fail(400, `items[${i}].kind: 1-32 lower-case letters, digits, _ and -`);
      if (it.private != null && typeof it.private !== 'boolean') fail(400, `items[${i}].private: true or false`);
      const rp = rootPath(it.path);
      const filesOf = rp.dir ? ops.media_scan(p, { path: rp.rel, limit: 2000 }).files.map(f => ({ abs: path.join(CFG.mediaBase, f.path), rel: f.path })) : [{ abs: rp.abs, rel: rp.rel }];
      for (const f of filesOf) {
        const sn = sniffFile(f.abs);
        if (!sn) fail(415, `${f.rel}: ${NOT_MEDIA}`);
        if (sn.type !== extType(f.rel)) fail(415, `${f.rel}: its bytes say ${sn.ext}, its name says otherwise`);
        const forced = privOf(p, f.rel), reg = registered.get(f.rel.toLowerCase()), want = it.private ?? priv;
        if (want === false && (forced || reg?.private)) fail(403, `${f.rel} is private (${forced ? 'the PRIVATE rule' : 'flagged private'}): a private flag only moves toward more private`);
        const d = path.dirname(f.abs);
        if (job_links && !jobs.has(d)) { let j = null; try { j = fs.existsSync(path.join(d, 'job.json')) ? readJob(p, d) : null; } catch (e) { j = null; } jobs.set(d, j?.error ? null : j); }
        const j = job_links ? jobs.get(d) : null, take = j ? takeOf(j, path.basename(f.rel)) : null;
        plan.push({ rel: f.rel, type: sn.type, reg, private: want === true || forced, kind: it.kind || kind || (sn.type === 'video' ? 'clip' : 'still'),
          label: it.label || (list.length === 1 && !rp.dir ? label : null) || (j ? `${j.id}${take != null ? '.' + take : ''} · ${short(j.prompt || j.notes || path.basename(f.rel), 60)}` : path.basename(f.rel)),
          job: j?.id ?? null, take, cost: j && j.cost?.usd != null && j.files.length ? +(j.cost.usd / j.files.length).toFixed(4) : null });
      }
    }
    const imported = [], already = [];
    for (const x of plan) {
      if (x.reg) {
        let m = x.reg; const changed = [];
        if (x.private && !m.private) { m = ops.media_update(p, { id: m.id, private: true }).media; changed.push('private'); }
        // review #2 N9: an agent links a registered file to a request only when it has none yet (never re-links a take), logged
        if (request && !m.request) { m = mutateMedia(p, (doc) => { const y = doc.items.find(z => z.id === m.id); y.request = request; y.request_linked = { by: via === 'page' ? 'director' : String(by).slice(0, 60), via: via === 'page' ? 'page' : 'agent', at: nowIso() }; return y; }); changed.push('request'); }
        else if (request && m.request !== request) changed.push(`request kept: ${m.request} (a file already linked to a request is not re-linked)`);
        already.push({ id: m.id, path: m.path, kind: m.kind, private: !!m.private, ...(changed.length ? { changed } : {}) });
        continue;
      }
      const r = ops.media_add(p, { path: x.rel, copy: false, kind: x.kind, label: x.label, private: x.private, entities: entities || [], ...(x.job ? { job: x.job, take: x.take } : {}), ...(x.cost != null ? { cost_usd: x.cost } : {}), ...(request ? { request } : {}) });
      const m = r.media;
      if (r.added) mutateMedia(p, (doc) => { const y = doc.items.find(z => z.id === m.id); if (y) Object.assign(y, { imported: { by: via === 'page' ? 'director' : String(by).slice(0, 60), via: via === 'page' ? 'page' : 'agent', at: nowIso(), from: 'in place' } }); });
      (r.added ? imported : already).push({ id: m.id, path: m.path, kind: m.kind, private: !!m.private, job: m.job, take: m.take, thumb: m.thumb || null });
    }
    const js = [...jobs.values()].filter(Boolean);
    landed(p, imported.map(x => ({ file: x.path, media: x.id, ...(request ? { request } : {}), source: 'import' })));   // D7: the identity check ask (checks.mjs)
    return { imported, already, jobs: js.map(j => ({ id: j.id, model: j.model, endpoint: j.endpoint, files: j.files.length, cost: j.cost })),
      ...(js.some(j => j.cost?.status === 'not_counted') ? { costs_not_counted: js.filter(j => j.cost?.status === 'not_counted').map(j => j.cost.offer), next: 'record each with cost_record (the same job is recorded once); propose a "use as" with node_import_propose (a node) or a note on the shot (a take / start frame): the director decides in the page' } : {}) };
  },

  // the page's drag and drop: one file in chunks (base64). Page only (serve.mjs sets via from the Origin).
  media_upload(p, { upload, name, size, offset, data, done = false, kind, label, private: priv, entities, request, via = 'agent' } = {}) {
    if (via !== 'page') fail(403, 'uploading files is the director\'s, in the page (File › Import media…, or drop files on the page); an agent registers files under a media root with media_import');
    if (typeof upload !== 'string' || !/^[a-z0-9]{8,40}$/.test(upload)) fail(400, 'upload: an id of 8-40 lower-case letters and digits');
    if (!Number.isInteger(size) || size <= 0) fail(400, 'size: the file\'s size in bytes');
    if (size > UPLOAD_MAX) fail(413, `${String(name || 'the file').slice(0, 80)}: ${(size / 1048576).toFixed(0)} MB, over the ${UPLOAD_MAX / 1048576} MB a file`);
    // review #2 N7: room on the disk for this file (+ 1 GB to spare) before the first chunk lands
    if (offset === 0) { try { const st = fs.statfsSync(projDir(p)), free = Number(st.bavail) * Number(st.bsize); if (free < size + UPLOAD_SPARE) fail(507, `not enough free disk space for ${String(name || 'the file').slice(0, 80)}: ${(free / 1048576).toFixed(0)} MB free, ${((size + UPLOAD_SPARE) / 1048576).toFixed(0)} MB needed`); } catch (e) { if (e.code === 507) throw e; } }
    if (!Number.isInteger(offset) || offset < 0) fail(400, 'offset: where this chunk starts');
    if (request != null && !(read(p, 'requests.json').items || []).some(r => r.id === request)) fail(404, `no request "${String(request).slice(0, 60)}"`);
    if (typeof data !== 'string' || data.length > Math.ceil(CHUNK_MAX / 3) * 4 + 4) fail(413, `a chunk is at most ${CHUNK_MAX / 1048576} MB`);
    const buf = Buffer.from(data, 'base64'), dir = path.join(projDir(p), '.uploads'), part = path.join(dir, upload + '.part');
    fs.mkdirSync(dir, { recursive: true });
    if (offset === 0) {
      for (const f of fs.readdirSync(dir)) { try { if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 864e5) fs.rmSync(path.join(dir, f), { force: true }); } catch (e) { /* gone */ } }
      if (!sniff(buf)) fail(415, `${String(name || 'the file').slice(0, 80)}: ${NOT_MEDIA}`);
      fs.writeFileSync(part, Buffer.alloc(0));
    }
    let have = 0; try { have = fs.statSync(part).size; } catch (e) { fail(409, 'unknown upload: start again at offset 0'); }
    if (offset !== have) fail(409, `expected offset ${have}`);
    if (have + buf.length > size) { fs.rmSync(part, { force: true }); fail(413, `more bytes than the declared size (${size})`); }
    fs.appendFileSync(part, buf);
    const got = have + buf.length;
    if (!done) return { upload, received: got, size };
    if (got !== size) { fs.rmSync(part, { force: true }); fail(400, `incomplete: ${got} of ${size} bytes`); }
    const sn = sniffFile(part);
    if (!sn) { fs.rmSync(part, { force: true }); fail(415, NOT_MEDIA); }
    const k = kind == null ? (sn.type === 'video' ? 'clip' : 'still') : String(kind);
    if (!KIND_RE.test(k)) { fs.rmSync(part, { force: true }); fail(400, 'kind: 1-32 lower-case letters, digits, _ and -'); }
    const top = priv === true ? 'private' : 'media', dest = path.join(projDir(p), top, k);
    const stem = path.basename(String(name || 'upload')).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'upload';
    fs.mkdirSync(dest, { recursive: true });
    let fname = `${stem}.${sn.ext}`; for (let n = 2; fs.existsSync(path.join(dest, fname)); n++) fname = `${stem}-${n}.${sn.ext}`;
    fs.renameSync(part, path.join(dest, fname));
    const r = ops.media_add(p, { path: `${top}/${k}/${fname}`, kind: k, label: label ? String(label).slice(0, 300) : String(name || fname).slice(0, 300), private: priv === true, ...(request ? { request } : {}), entities: Array.isArray(entities) ? entities.filter(x => typeof x === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(x)) : [] });
    mutateMedia(p, (doc) => { const y = doc.items.find(z => z.id === r.media.id); if (y) y.imported = { by: 'director', via: 'page', at: nowIso(), from: 'upload', name: String(name || '').slice(0, 200) }; });
    if (r.added !== false) landed(p, [{ file: r.media.path, media: r.media.id, ...(request ? { request } : {}), source: 'import' }]);   // D7
    return { upload, received: got, size, media: { ...r.media }, thumbnails: r.thumbnails };
  },

  // review #3 walk blocker 2, "Make public…" (PAGE ONLY, after a confirm in the page): a file the director UPLOADED as private
  // (private/<kind>/<name>) moves to media/<kind>/<name> and loses its private flag, so it may be exported, packaged and sent
  // to fal like any public file. Only the director lowers a privacy, only on their own upload, only with confirm: true; an
  // agent gets 403 (media_update private:false stays refused everywhere). Every place that names the old path follows: the
  // current storyboard's picks / alternatives / thumbs (a new version), the requests' refs and video frames (logged), the
  // take proposals. Thumbnails are made again as public ones. Logged on the item (made_public {by, via, at, from}).
  media_publish(p, { media, confirm, via = 'agent' } = {}) {
    if (via !== 'page') fail(403, 'making a private file public is the director\'s, in the page (Make public…, after a confirm); an agent never lowers a privacy');
    if (confirm !== true) fail(400, 'confirm: true (the page asks first: a public file can be exported, packaged and uploaded to fal)');
    const m0 = findMedia(p, media); if (!m0) fail(404, `no registered media "${String(media).slice(0, 80)}"`);
    if (!m0.private) fail(409, `${m0.id} is not private`);
    const mm = /^private\/([a-z0-9_-]{1,32})\/([^/]+)$/.exec(m0.path || '');
    if (m0.imported?.from !== 'upload' || !mm) fail(403, `${m0.id} was not uploaded by you as private (${m0.path}): only your own private uploads can be made public (a private ref photo, a node made from one or a generation from private refs stays private)`);
    const pd = projDir(p), src = inside(pd, m0.path); if (!src || !fs.existsSync(src)) fail(404, `${m0.path}: the file is missing`);
    const dir = path.join(pd, 'media', mm[1]); fs.mkdirSync(dir, { recursive: true });
    let name = mm[2]; for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = mm[2].replace(/(\.[^.]+)?$/, `-${n}$1`);
    const to = `media/${mm[1]}/${name}`;
    if (isPrivate(to)) fail(409, `${to} still matches the PRIVATE rule of this machine (private_media): it would stay private`);
    fs.renameSync(src, path.join(dir, name));
    const from = m0.path, at = nowIso();
    const m = mutateMedia(p, (doc) => {
      const x = doc.items.find(y => y.id === m0.id);
      for (const k of ['thumb', 'strip']) if (x[k] && /^thumbs\//.test(x[k])) { try { fs.rmSync(path.join(pd, x[k]), { force: true }); } catch (e) { /* gone */ } delete x[k]; }
      delete x.strip_n;
      const th = makeThumbs(path.join(dir, name), path.join(pd, 'thumbs'), x.id, { priv: false, durMs: x.duration_ms });
      Object.assign(x, { path: to, private: false, status: (x.use_as || []).some(u => u.shot) ? 'picked' : 'unused', made_public: { by: 'director', via: 'page', at, from } });
      x.thumb = th.thumb || (IMAGE.test(to) ? to : null); if (th.strip) { x.strip = th.strip; x.strip_n = 8; }
      return { ...x };
    });
    const updated = { storyboard: null, requests: [], takes: 0 };
    // the current storyboard: picks, alternatives and thumbs that name the old path
    const sb = path.join(pd, 'storyboard.json');
    if (fs.existsSync(sb)) updated.storyboard = withFileLock(sb, () => {
      const d = boardDoc(p), cur = SB.currentBoard(d); if (!cur) return null;
      let hit = false; const fix = (v) => { if (v === from) { hit = true; return to; } return v; };
      const shots = structuredClone(cur.shots).map(s => { const x = { ...s, thumb: fix(s.thumb) }; if (x.thumb == null) delete x.thumb; if (x.clip) x.clip = { ...x.clip, file: fix(x.clip.file), ...(Array.isArray(x.clip.alt) ? { alt: x.clip.alt.map(a => ({ ...a, ...(a.file ? { file: fix(a.file) } : {}) })) } : {}) }; return x; });
      if (!hit) return null;
      const v = SB.addBoardVersion(d, shots, { by: 'director', via: 'page', message: `made ${m0.id} public: ${from} → ${to}` });
      delete d.derived; try { SB.checkBoard(d); } catch (e) { fail(400, e.message); }
      d.rev = (d.rev || 0) + 1; write(p, 'storyboard.json', d); return v.id;
    });
    // the requests' refs and video frames (the same bytes under a new name: logged, the approval stands)
    withFileLock(path.join(pd, 'requests.json'), () => {
      const d = read(p, 'requests.json'); let n = 0;
      for (const r of d.items || []) {
        let hit = false; const fix = (v) => { if (v === from) { hit = true; return to; } return v; };
        if (Array.isArray(r.refs)) r.refs = r.refs.map(fix);
        if (r.video) for (const k of ['start', 'end', 'ref_video']) if (r.video[k]) r.video[k] = fix(r.video[k]);
        if (hit) { (r.log ||= []).push({ at, by: 'director', via: 'page', moved_ref: { from, to }, why: 'made public' }); updated.requests.push(r.id); n++; }
      }
      if (n) { d.rev = (d.rev || 0) + 1; write(p, 'requests.json', d); }
    });
    const tf = path.join(pd, 'takes.json');
    if (fs.existsSync(tf)) withFileLock(tf, () => { const d = readJSON(tf, null); if (!d?.proposals) return; for (const x of d.proposals) if (x.file === from) { x.file = to; updated.takes++; } if (updated.takes) { d.rev = (d.rev || 0) + 1; write(p, 'takes.json', d); } });
    return { media: m, from, to, updated };
  },

  // review #3 walk blocker 5 (PAGE ONLY): the images made in another app for a handed-off request ("Open in another app",
  // generators/openwith.mjs) dropped on its Queue row land in its results/ folder (gen/<id>/results/, private/gen/... for a
  // private request): one image a call (PNG / JPEG / WebP by its bytes, up to 20 MB), name sanitised. "Collect results"
  // (request_run) then makes them its outputs at $0. Nothing is paid or approved here.
  handoff_upload(p, { id, name, data, via = 'agent' } = {}) {
    if (via !== 'page') fail(403, 'dropping results into a request is the director\'s, in the page (Review › Queue); an agent registers files with media_import');
    const r = (read(p, 'requests.json').items || []).find(x => x.id === id); if (!r) fail(404, `no request "${String(id).slice(0, 64)}"`);
    if (r.status !== 'running' || !r.handoff?.results) fail(409, `${r.id} is not waiting for results from another app (it is ${r.status})`);
    const pd = projDir(p), dir = inside(pd, String(r.handoff.results));
    if (!dir || !/[\\/]results$/.test(dir) || !cleanRel(String(r.handoff.results))) fail(400, 'the request\'s results folder is not inside the project');
    if (typeof data !== 'string' || data.length > Math.ceil(20 * 1048576 / 3) * 4 + 4) fail(413, 'an image is at most 20 MB');
    const buf = Buffer.from(data, 'base64'), sn = sniff(buf);
    if (!sn || sn.type !== 'image' || sn.ext === 'gif') fail(415, `${String(name || 'the file').slice(0, 80)}: not a PNG, JPEG or WebP image (judged by its bytes)`);
    const stem = path.basename(String(name || 'result')).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'result';
    fs.mkdirSync(dir, { recursive: true });
    let fname = `${stem}.${sn.ext}`; for (let n = 2; fs.existsSync(path.join(dir, fname)); n++) fname = `${stem}-${n}.${sn.ext}`;
    fs.writeFileSync(path.join(dir, fname), buf);
    const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f));
    return { request: r.id, file: `${r.handoff.results}/${fname}`, results: r.handoff.results, count: files.length, next: 'Collect results (request_run) makes them its outputs at $0' };
  },

  // "use as…" (page only): a node of an asset tree (asset_act import) or a shot's take / start frame
  media_use(p, { media, as, type, id, tree, shot, via = 'agent' } = {}) {
    if (via !== 'page') fail(403, 'using a file as a node, a take or a start frame is the director\'s, in the page (Use as…). Propose it instead: node_import_propose {id, tree, media, why} for an identity / look / base / variant node, or a note on the shot (notes_add {target: {stage: "storyboard", kind: "shot", id}}) for a take or a start frame');
    const AS = ['identity', 'look', 'base', 'variant', 'take', 'start_frame'];
    if (!AS.includes(as)) fail(400, `as: one of ${AS.join(', ')}`);
    if (as === 'take' || as === 'start_frame') return linkShotMedia(p, { shot, media, as, by: 'director', via: 'page' });
    const m = findMedia(p, media); if (!m) fail(404, `no registered media "${media}"`);
    const ent = read(p, 'entities/index.json').find(x => x.id === id);
    if (!ent) fail(404, `no entity "${id}"`);
    const t = as === 'identity' || as === 'look' ? 'character' : (type || ent.kind);
    if (ent.kind !== t) fail(400, `${id} is a ${ent.kind}: ${as} is for a ${as === 'identity' || as === 'look' ? 'character' : 'location or a prop'}`);
    const want = as === 'identity' ? 'identity' : as === 'base' ? 'base' : String(tree || '');
    if ((as === 'look' && !/^look:/.test(want)) || (as === 'variant' && !/^variant:/.test(want))) fail(400, `tree: "${as === 'look' ? 'look' : 'variant'}:<id>"`);
    const r = ops.asset_act(p, { type: t, id, act: 'import', tree: want, media: m.id, via: 'page' });
    mutateMedia(p, (doc) => { const y = doc.items.find(z => z.id === m.id); if (y) { y.entities = [...new Set([...(y.entities || []), id])].sort(); y.use_as = [...(y.use_as || []), { entity: id, tree: want, node: r.node, as, by: 'director', via: 'page', at: nowIso() }]; } });
    return { as, type: t, id, tree: want, media: m.id, ...r };
  },
});
