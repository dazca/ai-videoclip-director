// Projects in and out (ROADMAP_v4 G5, G6; docs/WEB_SERVICE_PLAN.md 2.4). Everything stays on the user's side: a zip is
// written into the project folder and downloaded by the page from this server; an import is unpacked into data/.
//   project_export   the project as ONE zip (lib/zip.mjs, no dependency): every JSON file, the sketches, peaks, thumbnails
//                    and the media the project registers or points at (media.json, song.json audio, refs, node images…), with
//                    `workbench-export.json` (format director-workbench/project-zip v1: per file its size and sha256).
//                    PRIVATE media (the PRIVATE rule, media flagged private) is left out and every JSON file is scrubbed of
//                    private paths (scrubPrivate) unless `include_private` (a personal backup) is ticked IN THE PAGE: an agent
//                    asking for it gets 403. Snapshots (.snapshots/) only with `snapshots: true`. Never: .history (the git
//                    mirror), .uploads, other exports, temp / lock files, unregistered files, files under a media root (listed
//                    as `external`). Written to exports/<p>-<stamp>.zip, a personal backup to private/exports/ (local only).
//                    `dry_run`: the counts and sizes, nothing written.
//   project_upload   PAGE ONLY: a file the director drops on the page, in chunks (base64, the D8 shape: upload id, offset,
//                    size, done), staged in <data>/.uploads/ (a dot-folder: never served, cleaned after a day) before any
//                    project exists: a zip to import (`kind: zip`, sniffed PK, up to IMPORT_MAX) or a song for a new project
//                    (`kind: song`, sniffed as audio, up to 300 MB)
//   project_import   a zip -> a NEW project (never over an existing one: 409; default id = the zip's, else <id>-import[-n]).
//                    Validated before anything is written: zip-slip (every name a clean relative path: no "..", ".", drive,
//                    backslash, leading "/", ":", NUL, "~<digit>", control characters, reserved device names, dot-folders but
//                    .snapshots), symlinks, sizes (the zip, each file, the total, the entry count, the compression ratio),
//                    the manifest (format, ids, every file listed with the same size and sha256, nothing extra), every JSON
//                    file parses, entity / request / media ids. Then the director's decisions are demoted: approvals
//                    approved / locked -> review, requests -> draft (the old status kept as `imported.status`; "allow
//                    uploading private refs" off), batches -> draft, looks / variants approved -> review, approved tree nodes
//                    -> `imported_approved`, scenes ok -> needs_you, breakdown items ok -> review, stages done ->
//                    in_progress, the render lock and the render command dropped; costs are kept as history (costs.json
//                    `imported`). The page imports an upload; an agent imports a zip under a project's exports/ or a
//                    media root (never a private path). `dry_run`: what it would do.
//   createFromSong   G6: POST /api/projects/new {song_upload} (page only): a new project from the staged song + lyrics / LRC
//                    (lib/ops/lyrics.mjs createGuidedProject, then importers/new_project.mjs attachSong: ffprobe, decode, the
//                    waveform, the energy curve, the beat grid (estimated from the song when no bpm is given), the lyric
//                    timings estimated over the real length; LRC tags win)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AUDIO, DATA_ROOT, IMAGE, VIDEO, WB_DIR, fail, ffprobe, inside, isFlaggedPrivate, isMediaRootPath, isPrivate, mediaRootFile, normRel, nowIso, ops, projDir, readJSON, relTo, stamp, validId, writeJSON } from './_shared.mjs';
import { scrubPrivate } from './core.mjs';
import { createGuidedProject } from './lyrics.mjs';
import { CHUNK_MAX } from './media.mjs';
import { audioSniff } from './songs.mjs';
import { ZipWriter, openZip } from '../zip.mjs';

export const FORMAT = 'director-workbench/project-zip';
export const MANIFEST = 'workbench-export.json';
const T = process.env.WB_TEST === '1';
export const IMPORT_MAX = (T && Number(process.env.WB_IMPORT_MAX)) || 2048 * 1048576;   // bytes of a zip, and of its files uncompressed
export const ENTRY_MAX = (T && Number(process.env.WB_IMPORT_ENTRY_MAX)) || 512 * 1048576;
export const SONG_MAX = 300 * 1048576;
const MAX_ENTRIES = 20000;
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(WB_DIR, 'package.json'), 'utf8')).version; } catch (e) { return null; } })();
const MEDIA = (f) => IMAGE.test(f) || VIDEO.test(f) || AUDIO.test(f) || /\.(aac|m4a|svg)$/i.test(f);
const pageOnly = (via, what) => { if (via !== 'page') fail(403, `${what} is the director's, in the page (File › Import project from zip…, File › New project…): an agent imports a zip with project_import {path}`); };

// ------------------------------------------------------------------ export
// every string in a JSON value (lower-cased, normalised): what the project points at
function strings(v, out) {
  if (typeof v === 'string') { if (v.length < 400) out.add(normRel(v).toLowerCase()); }
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}
// the files of a project folder, not entering the folders an export never holds
function files(d, snapshots) {
  const out = [];
  const go = (rel) => {
    for (const e of fs.readdirSync(path.join(d, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') && !(rel === '' && e.name === '.snapshots' && snapshots)) continue;   // .history, .uploads, .sheet-*
        go(r);
      } else if (e.isFile()) out.push(r);
    }
  };
  go('');
  return out;
}
const SKIP = (r) => /\.(tmp|part|lock)$/i.test(r) || /(^|\/)\.[^/]*\.lock$/.test(r) || /^(private\/)?exports\/[^/]*\.zip$/i.test(r) || r === MANIFEST;
export function exportPlan(p, { include_private = false, snapshots = false } = {}) {
  const d = projDir(p), all = files(d, snapshots);
  const json = all.filter(r => /\.json$/i.test(r) && !SKIP(r));
  // what the project points at: every string of every JSON file (media.json paths, song.json audio, refs, node images, sketches)
  const refs = new Set();
  for (const r of json) { const j = readJSON(path.join(d, r), null); if (j != null) strings(j, refs); }
  const media = readJSON(path.join(d, 'media.json'), {}) || {};
  const external = [...new Set((media.items || []).map(m => m?.path).filter(x => typeof x === 'string' && isMediaRootPath(x)))];
  const plan = { include: [], private: [], unregistered: [], bytes: 0, private_bytes: 0, external };
  for (const r of all) {
    if (SKIP(r)) continue;
    const st = fs.statSync(path.join(d, r)), priv = isPrivate(r) || isFlaggedPrivate(r, [p]) || (r.startsWith('.snapshots/') && isPrivate(r.split('/').slice(2).join('/')));
    if (priv && !include_private) { plan.private.push(r); plan.private_bytes += st.size; continue; }
    const registered = /\.json$/i.test(r) || !MEDIA(r) || /^(thumbs|peaks|sketches|private\/sketches|proposals)\//.test(r) || refs.has(r.toLowerCase());
    if (!registered) { plan.unregistered.push(r); continue; }
    plan.include.push({ path: r, size: st.size }); plan.bytes += st.size;
  }
  return plan;
}
// a JSON file without private paths (scrubPrivate); the spend is history: a cost row that names a private file keeps its money and
// loses only that field (scrubPrivate would drop the whole row)
function scrub(rel, j, p) {
  if (/(^|\/)costs\.json$/.test(rel) && j && typeof j === 'object' && !Array.isArray(j)) {
    const o = scrubPrivate(Object.fromEntries(Object.entries(j).filter(([, v]) => !Array.isArray(v))), [p]);
    for (const [k, v] of Object.entries(j)) if (Array.isArray(v)) o[k] = v.map(x => (x && typeof x === 'object' ? scrubPrivate(x, [p]) : x));
    return o;
  }
  return scrubPrivate(j, [p]);
}
function prune(dir, prefix, keep = 3) {
  try {
    const zs = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.zip')).sort();
    for (const f of zs.slice(0, Math.max(0, zs.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
  } catch (e) { /* none yet */ }
}

// ------------------------------------------------------------------ import: validation
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
// a name inside the zip -> null when it is a clean relative path, else why not
export function badName(name) {
  if (typeof name !== 'string' || !name || name.length > 400) return 'empty or too long';
  if (/[\\\0:]/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) return 'a backslash, ":", NUL or a control character';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'an absolute path';
  const segs = name.replace(/\/$/, '').split('/');
  for (const [i, s] of segs.entries()) {
    if (!s) return 'an empty segment';
    if (s === '.' || s === '..') return '"." or ".."';
    if (/~\d/.test(s)) return 'an 8.3 short name';
    if (RESERVED.test(s) || /[. ]$/.test(s)) return 'a reserved device name or a trailing dot / space';
    if (s.length > 200) return 'a segment over 200 characters';
    if (s.startsWith('.') && !(i === 0 && s === '.snapshots') && !(i === 2 && segs[0] === '.snapshots' && s === '.meta.json')) return 'a dot-file or dot-folder';
  }
  return null;
}
const ID = /^[A-Za-z0-9_][A-Za-z0-9_.@:#-]{0,95}$/;
// a staged or given zip -> {manifest, entries, files[{name, size, sha256}]}; throws 400 / 413 with the reason
export function inspectZip(file) {
  const st = fs.statSync(file);
  if (st.size > IMPORT_MAX) fail(413, `the zip is ${(st.size / 1048576).toFixed(0)} MB: over the ${(IMPORT_MAX / 1048576).toFixed(0)} MB an import takes`);
  let z;
  try { z = openZip(file, { maxEntries: MAX_ENTRIES, maxEntry: ENTRY_MAX, maxTotal: IMPORT_MAX }); }
  catch (e) { fail(/over|too many/.test(e.message) ? 413 : 400, `not imported: ${e.message}`); }
  try {
    for (const en of z.entries) { const why = badName(en.name); if (why) fail(400, `not imported: unsafe path in the zip (${why}): ${JSON.stringify(en.name.slice(0, 120))}`); }
    const me = z.entries.find(en => en.name === MANIFEST);
    if (!me) fail(400, `not imported: no ${MANIFEST} (not a workbench project zip)`);
    let m; try { m = JSON.parse(z.read(me).toString('utf8')); } catch (e) { fail(400, `not imported: ${MANIFEST} is not valid JSON (${e.message})`); }
    if (m?.format !== FORMAT || m.v !== 1) fail(400, `not imported: ${MANIFEST} is not ${FORMAT} v1`);
    if (!validId(m.project)) fail(400, 'not imported: the manifest\'s project id is not valid');
    if (!Array.isArray(m.files) || m.files.length > MAX_ENTRIES) fail(400, 'not imported: the manifest lists no files');
    const listed = new Map();
    for (const f of m.files) {
      if (!f || typeof f.path !== 'string' || badName(f.path) || !Number.isInteger(f.size) || f.size < 0 || !/^[0-9a-f]{64}$/.test(String(f.sha256))) fail(400, `not imported: a bad manifest row ${JSON.stringify(f).slice(0, 120)}`);
      if (listed.has(f.path.toLowerCase())) fail(400, `not imported: ${f.path} listed twice`);
      listed.set(f.path.toLowerCase(), f);
    }
    const ents = z.entries.filter(en => !en.dir && en.name !== MANIFEST);
    for (const en of ents) {
      const f = listed.get(en.name.toLowerCase());
      if (!f || f.path !== en.name) fail(400, `not imported: ${en.name} is in the zip but not in the manifest`);
      if (f.size !== en.usize) fail(400, `not imported: checksum mismatch: ${en.name} is ${en.usize} bytes, the manifest says ${f.size}`);
    }
    if (ents.length !== listed.size) { const have = new Set(ents.map(e => e.name.toLowerCase())); const miss = [...listed.values()].find(f => !have.has(f.path.toLowerCase())); fail(400, `not imported: ${miss?.path} is in the manifest but not in the zip`); }
    if (!listed.has('song.json')) fail(400, 'not imported: no song.json (not a workbench project)');
    return { z, manifest: m, entries: ents, listed };
  } catch (e) { z.close(); throw e; }
}
// the ids inside the JSON files: entity files named by a valid id, index paths matching, request / media ids of a sane shape
function checkIds(name, j) {
  const bad = (what) => fail(400, `not imported: ${name}: ${what}`);
  const em = /^entities\/(characters|locations|props)\/([^/]+)\.json$/.exec(name);
  if (em && !validId(em[2])) bad(`entity id "${em[2].slice(0, 40)}"`);
  if (name === 'entities/index.json') {
    if (!Array.isArray(j)) bad('not a list');
    for (const e of j) {
      if (!e || !validId(e.id)) bad(`entity id ${JSON.stringify(e?.id).slice(0, 40)}`);
      if (e.path != null && !/^entities\/(characters|locations|props)\/[A-Za-z0-9_][A-Za-z0-9_-]{0,63}\.json$/.test(e.path)) bad(`entity path ${JSON.stringify(e.path).slice(0, 60)}`);
    }
  }
  if (name === 'requests.json') for (const r of j?.items || []) if (!r || !ID.test(String(r.id))) bad(`request id ${JSON.stringify(r?.id).slice(0, 40)}`);
  if (name === 'media.json') for (const m of j?.items || []) {
    if (!m || !ID.test(String(m.id))) bad(`media id ${JSON.stringify(m?.id).slice(0, 40)}`);
    if (typeof m.path === 'string' && !isMediaRootPath(m.path) && badName(normRel(m.path))) bad(`media path ${JSON.stringify(m.path).slice(0, 80)}`);
  }
}

// ------------------------------------------------------------------ import: the director's decisions do not travel
// demote(dir, info) on a project folder (and on each imported snapshot) -> counts
export function demote(dir, info) {
  const n = { approvals: 0, requests: 0, batches: 0, looks: 0, variants: 0, trees: 0, scenes: 0, items: 0, stages: 0, lock: 0, render_config: 0 };
  const at = nowIso(), j = (f) => readJSON(path.join(dir, f), null), w = (f, v) => writeJSON(path.join(dir, f), v);
  const A = j('approvals.json');
  if (A?.items && typeof A.items === 'object') {
    for (const it of Object.values(A.items)) if (it && ['approved', 'locked'].includes(it.state)) { it.imported_state = it.state; it.state = 'review'; it.by = 'import'; it.via = 'import'; it.at = at; n.approvals++; }
    w('approvals.json', A);
  }
  const R = j('requests.json');
  if (R && Array.isArray(R.items)) {
    R.items = R.items.map(r => {
      if (!r || typeof r !== 'object') return r;
      const { private_upload_ok: _pu, ...x } = r;
      if (x.status !== 'draft' || _pu) n.requests++;
      return { ...x, status: 'draft', imported: { status: r.status, from: info.from, at },
        log: [...(Array.isArray(r.log) ? r.log : []), { at, by: 'import', via: 'import', status: 'draft', private_upload: false, why: `imported from ${info.from}: approve again` }] };
    });
    if (Array.isArray(R.batches)) R.batches = R.batches.map(b => { if (b && b.status && b.status !== 'draft') { n.batches++; return { ...b, imported_status: b.status, status: 'draft' }; } return b; });
    w('requests.json', R);
  }
  for (const kind of ['characters', 'locations', 'props']) {
    let names = []; try { names = fs.readdirSync(path.join(dir, 'entities', kind)).filter(f => f.endsWith('.json')); } catch (e) { continue; }
    for (const f of names) {
      const rel = `entities/${kind}/${f}`, e = j(rel); if (!e || typeof e !== 'object') continue;
      if (e.status === 'approved' || e.status === 'locked') { e.imported_status = e.status; e.status = 'review'; }
      for (const [list, key] of [['looks', 'looks'], ['variants', 'variants']]) for (const v of Array.isArray(e[list]) ? e[list] : []) if (v && (v.status === 'approved' || v.status === 'locked')) { v.imported_status = v.status; v.status = 'review'; n[key]++; }
      for (const t of Object.values(e.iter?.trees || {})) if (t && t.approved) { t.imported_approved = t.approved; delete t.approved; delete t.approved_at; delete t.approved_by; n.trees++; }
      if (e.uses && typeof e.uses === 'object') for (const u of Object.values(e.uses)) if (u && u.via === 'page') u.via = 'import';
      w(rel, e);
    }
  }
  const I = j('entities/index.json');
  if (Array.isArray(I)) { for (const e of I) if (e && (e.status === 'approved' || e.status === 'locked')) e.status = 'review'; w('entities/index.json', I); }
  for (const [f, from, to, key] of [['scenes.json', 'ok', 'needs_you', 'scenes'], ['breakdown.json', 'ok', 'review', 'items']]) {
    const d = j(f); if (!d?.states || typeof d.states !== 'object') continue;
    for (const s of Object.values(d.states)) if (s && s.status === from) { s.status = to; s.imported_status = from; s.by = 'import'; s.via = 'import'; s.at = at; n[key]++; }
    w(f, d);
  }
  const S = j('stages.json');
  if (Array.isArray(S?.stages)) { for (const s of S.stages) if (s && s.status === 'done') { s.status = 'in_progress'; delete s.done_by; s.via = 'import'; s.updated = at; n.stages++; } w('stages.json', S); }
  const V = j('revisions.json');
  if (V && typeof V === 'object') { if (V.lock) { V.lock = null; n.lock++; } w('revisions.json', V); }
  const Rd = j('renders.json');
  if (Rd && typeof Rd === 'object' && Rd.config) { Rd.config = null; n.render_config++; w('renders.json', Rd); }
  const C = j('costs.json');
  if (C && typeof C === 'object') { C.imported = { from: info.from, at, note: 'the spend of the imported project, kept as history' }; w('costs.json', C); }
  return n;
}

// ------------------------------------------------------------------ the staging area (<data>/.uploads)
const STAGE = () => path.join(DATA_ROOT, '.uploads');
const staged = (upload, kind) => {
  if (typeof upload !== 'string' || !/^[a-z0-9]{8,40}$/.test(upload)) fail(400, 'upload: an id of 8-40 lower-case letters and digits');
  if (!['zip', 'song'].includes(kind)) fail(400, 'kind: zip or song');
  return path.join(STAGE(), `${upload}.${kind}`);
};
export function stagedFile(upload, kind) { const f = staged(upload, kind); if (!fs.existsSync(f)) fail(404, 'no such upload (upload it first; staged files are kept a day)'); return f; }

function freeId(base) {
  const b = String(base).slice(0, 56);
  for (const c of [b, `${b}-import`, ...Array.from({ length: 98 }, (_, i) => `${b}-import-${i + 2}`)]) if (validId(c) && !fs.existsSync(path.join(DATA_ROOT, c))) return c;
  fail(409, 'no free project id');
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

Object.assign(ops, {
  project_export(p, { include_private = false, snapshots = false, dry_run = false, via } = {}) {
    if (include_private === true && via !== 'page') fail(403, 'including private media is the director\'s choice, in the page (File › Export project as zip…, "include private media (personal backup)"): an agent\'s export never includes it');
    const priv = include_private === true, plan = exportPlan(p, { include_private: priv, snapshots: snapshots === true });
    const out = { project: p, include_private: priv, snapshots: snapshots === true, files: plan.include.length, bytes: plan.bytes,
      private_excluded: plan.private.length, private_bytes: plan.private_bytes, unregistered_skipped: plan.unregistered.length, external: plan.external.length,
      ...(plan.external.length ? { external_note: `${plan.external.length} media file(s) under a media root are not in the zip (they live outside the project)` } : {}) };
    if (dry_run) return { ...out, dry_run: true };
    const d = projDir(p), meta = readJSON(path.join(d, 'project.json'), {}) || {};
    const dir = path.join(d, priv ? 'private/exports' : 'exports'); fs.mkdirSync(dir, { recursive: true });
    const name = `${p}-${stamp()}${priv ? '-personal' : ''}.zip`, file = path.join(dir, name), tmp = file + '.part';
    const zw = new ZipWriter(tmp), rows = [];
    try {
      for (const f of plan.include) {
        let b = fs.readFileSync(path.join(d, f.path));
        if (/\.json$/i.test(f.path) && !priv) { try { b = Buffer.from(JSON.stringify(scrub(f.path, JSON.parse(b.toString('utf8')), p), null, 1)); } catch (e) { /* not JSON: as it is */ } }
        zw.add(f.path, b, { deflate: /\.(json|svg|txt|lrc|md|log)$/i.test(f.path) || !MEDIA(f.path) });
        rows.push({ path: f.path, size: b.length, sha256: sha(b) });
      }
      const manifest = { format: FORMAT, v: 1, project: p, title: meta.title || p, exported: nowIso(), app: 'director-workbench', version: VERSION,
        include_private: priv, snapshots: snapshots === true, excluded: { private: plan.private.length, unregistered: plan.unregistered.length, external: plan.external },
        files: rows };
      zw.add(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 1)), { deflate: true });
      const r = zw.finish();
      fs.renameSync(tmp, file);
      prune(dir, `${p}-`);
      const rel = relTo(d, file);
      return { ...out, path: rel, url: `data/${p}/${rel}`, zip_bytes: r.bytes, files: rows.length, abs: file };
    } catch (e) { zw.abort(); throw e; }
  },

  // the page's drop: chunks staged in <data>/.uploads/ (no project needed: a new project from a song, or an import)
  project_upload(_p, { upload, kind, name, size, offset, data, done = false, via } = {}) {
    pageOnly(via, 'uploading a file');
    const file = staged(upload, kind), part = file + '.part', max = kind === 'zip' ? IMPORT_MAX : SONG_MAX;
    if (!Number.isInteger(size) || size <= 0) fail(400, 'size: the file\'s size in bytes');
    if (size > max) fail(413, `${String(name || 'the file').slice(0, 80)}: ${(size / 1048576).toFixed(0)} MB, over the ${(max / 1048576).toFixed(0)} MB a ${kind === 'zip' ? 'zip' : 'song'} may be`);
    if (!Number.isInteger(offset) || offset < 0) fail(400, 'offset: where this chunk starts');
    if (typeof data !== 'string' || data.length > Math.ceil(CHUNK_MAX / 3) * 4 + 4) fail(413, `a chunk is at most ${CHUNK_MAX / 1048576} MB`);
    const buf = Buffer.from(data, 'base64');
    fs.mkdirSync(STAGE(), { recursive: true });
    if (offset === 0) {
      for (const f of fs.readdirSync(STAGE())) { try { if (Date.now() - fs.statSync(path.join(STAGE(), f)).mtimeMs > 864e5) fs.rmSync(path.join(STAGE(), f), { force: true }); } catch (e) { /* gone */ } }
      try { const st = fs.statfsSync(STAGE()), free = Number(st.bavail) * Number(st.bsize); if (free < size * 2 + 512 * 1048576) fail(507, `not enough free disk space: ${(free / 1048576).toFixed(0)} MB free`); } catch (e) { if (e.code === 507) throw e; }
      if (kind === 'zip' ? !(buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) : !audioSniff(buf)) fail(415, `${String(name || 'the file').slice(0, 80)}: ${kind === 'zip' ? 'not a zip' : 'not an audio file (MP3, WAV, M4A, FLAC, OGG; judged by its bytes)'}`);
      fs.writeFileSync(part, Buffer.alloc(0));
    }
    let have = 0; try { have = fs.statSync(part).size; } catch (e) { fail(409, 'unknown upload: start again at offset 0'); }
    if (offset !== have) fail(409, `expected offset ${have}`);
    if (have + buf.length > size) { fs.rmSync(part, { force: true }); fail(413, `more bytes than the declared size (${size})`); }
    fs.appendFileSync(part, buf);
    const got = have + buf.length;
    if (!done) return { upload, kind, received: got, size };
    if (got !== size) { fs.rmSync(part, { force: true }); fail(400, `incomplete: ${got} of ${size} bytes`); }
    fs.renameSync(part, file);
    return { upload, kind, received: got, size, staged: true, name: String(name || '').slice(0, 200) };
  },

  project_import(_p, { upload, path: src, id, title, dry_run = false, via } = {}) {
    let file;
    if (upload != null) { pageOnly(via, 'importing an uploaded zip'); file = stagedFile(upload, 'zip'); }
    else {
      if (typeof src !== 'string' || !/\.zip$/i.test(src) || /[\0]/.test(src) || src.length > 1000) fail(400, 'path: a .zip under a project\'s exports/ folder (data/<project>/exports/…) or under a media root; or upload (the page)');
      if (isPrivate(src) && via !== 'page') fail(403, 'a private zip (a personal backup) is imported by the director, in the page');
      const rel = normRel(src.replace(/\\/g, '/'));
      if (rel.split('/').some(s => s === '..' || s === '.')) fail(400, 'path: no ".." or "."');
      const m = /^data\/([^/]+)\/((?:private\/)?exports\/[^/]+\.zip)$/i.exec(rel);
      file = m && validId(m[1]) ? inside(path.join(DATA_ROOT, m[1]), m[2]) : isMediaRootPath(rel) ? mediaRootFile(rel) : null;
      if (!file) fail(403, 'path: a .zip under data/<project>/exports/ or under a media root');
      if (!fs.existsSync(file)) fail(404, 'no such file: ' + src);
    }
    const { z, manifest, entries, listed } = inspectZip(file);
    try {
      if (id != null && !validId(id)) fail(400, 'id: letters, digits, _ and - (max 64)');
      if (id != null && fs.existsSync(path.join(DATA_ROOT, id))) fail(409, `a project "${id}" exists: an import always makes a NEW project (pick another id)`);
      const to = id || freeId(manifest.project);
      const summary = { id: to, from: manifest.project, title: title || manifest.title || to, exported: manifest.exported, version: manifest.version,
        files: entries.length, bytes: entries.reduce((s, e) => s + e.usize, 0), include_private: !!manifest.include_private,
        private_files: entries.filter(e => isPrivate(e.name)).length, snapshots: entries.some(e => e.name.startsWith('.snapshots/')) };
      if (dry_run) {
        // the JSON files are read and checked in a dry run too (ids, parse); media only on the real import
        for (const en of entries.filter(e => /\.json$/i.test(e.name))) { const b = z.read(en); if (sha(b) !== listed.get(en.name.toLowerCase()).sha256) fail(400, `not imported: checksum mismatch: ${en.name}`); let j; try { j = JSON.parse(b.toString('utf8')); } catch (e) { fail(400, `not imported: ${en.name} is not valid JSON`); } checkIds(en.name, j); }
        return { ...summary, dry_run: true, note: 'nothing written: an import makes a NEW project; approvals arrive as review, requests as draft, costs as history' };
      }
      const tmp = path.join(DATA_ROOT, `_import-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      fs.mkdirSync(tmp);
      try {
        for (const en of entries) {
          const b = z.read(en), f = listed.get(en.name.toLowerCase());
          if (sha(b) !== f.sha256) fail(400, `not imported: checksum mismatch: ${en.name}`);
          if (/\.json$/i.test(en.name)) { let j; try { j = JSON.parse(b.toString('utf8')); } catch (e) { fail(400, `not imported: ${en.name} is not valid JSON`); } checkIds(en.name, j); }
          const dest = inside(tmp, en.name);
          if (!dest || dest === tmp) fail(400, `not imported: unsafe path ${en.name}`);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, b, { flag: 'wx' });
        }
        if (!fs.existsSync(path.join(tmp, 'song.json'))) fail(400, 'not imported: no song.json');
        const info = { from: manifest.project }, counts = demote(tmp, info);
        const snaps = path.join(tmp, '.snapshots');
        if (fs.existsSync(snaps)) { for (const s of fs.readdirSync(snaps)) if (fs.statSync(path.join(snaps, s)).isDirectory()) demote(path.join(snaps, s), info); }
        else fs.rmSync(path.join(tmp, 'revisions.json'), { force: true });   // its snapshots did not come: the copy starts its own history
        const meta = readJSON(path.join(tmp, 'project.json'), {}) || {};
        writeJSON(path.join(tmp, 'project.json'), { ...meta, title: summary.title, created: nowIso(), imported: { from: manifest.project, exported: manifest.exported, version: manifest.version, at: nowIso(), private: !!manifest.include_private } });
        const dest = path.join(DATA_ROOT, to);
        if (fs.existsSync(dest)) fail(409, `a project "${to}" appeared meanwhile: import again`);
        fs.renameSync(tmp, dest);
        if (upload != null) fs.rmSync(file, { force: true });
        return { ...summary, imported: true, demoted: counts };
      } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
    } finally { z.close(); }
  },
});

// G6: a new project from a song the page staged (project_upload kind song) + the lyrics (plain text or LRC). The song is
// moved into the new project's audio/ and attached: ffprobe (format, duration), the waveform peaks, the energy curve, the
// beat grid (the bpm given, else estimated from the song's onsets: `beats.source`), the lyric timings over the real length
export async function createFromSong({ id, title, lyrics = '', bpm, song_upload, song_name, via } = {}) {
  pageOnly(via, 'a new project from an uploaded song');
  const src = stagedFile(song_upload, 'song');
  const head = Buffer.alloc(16); { const fd = fs.openSync(src, 'r'); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd); }
  const ext = audioSniff(head); if (!ext) fail(415, 'not an audio file');
  if (bpm != null && bpm !== '' && !(Number(bpm) > 20 && Number(bpm) <= 400)) fail(400, 'bpm: a number between 20 and 400');
  const r = await createGuidedProject({ id, title, lyrics });
  try {
    const base = String(song_name || 'song').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'song';
    const dir = path.join(projDir(id), 'audio'); fs.mkdirSync(dir, { recursive: true });
    const rel = `audio/${base}.${ext}`;
    fs.renameSync(src, path.join(projDir(id), rel));
    const probe = ffprobe(path.join(projDir(id), rel));
    const I = await import('../../importers/new_project.mjs');
    const song = I.attachSong(id, rel, { bpm: bpm ? Number(bpm) : undefined, estimate: !bpm });
    return { ...r, song, probe: { duration_ms: probe?.dur != null ? Math.round(probe.dur * 1000) : null, format: ext } };
  } catch (e) { fs.rmSync(projDir(id, false), { recursive: true, force: true }); throw e; }
}
