// Director workbench server: static files + read-only media + writable state files + projects/snapshots + agent ops
// + a change feed and a live UI channel. The data layer is lib/store.mjs (shared with the MCP server, mcp/server.mjs).
//   node serve.mjs [port] [--lan]  (default 8140) then open http://localhost:8140/  (?project=<id>)
// Listens on 127.0.0.1 only. --lan (or WB_HOST / config "host", e.g. 0.0.0.0) opts in to the network: other hosts may
// then read the page and the non-private files; every POST from them still needs allow_remote_ops.
// Every request must carry a Host header naming this server (localhost / 127.0.0.1 / [::1]:<port>, plus this
// machine's names and addresses with --lan), so a DNS-rebinding page cannot reach it. Every POST /api/* must be
// content-type application/json, have no foreign Origin, and carry a token: the page's x-wb-token (the per-run token the
// server writes into index.html / dock.html, <meta name="wb-token">, read by core/token.js; env WB_TOKEN fixes it) or the
// agents' x-wb-agent-token (<data folder>/.wb-agent-token). Only a request with the page token, this server's Origin and
// Sec-Fetch-Site: same-origin is the page (the director, S9); anything else is an agent and never does a page act.
// Only the page's own files are served from the workbench folder (an allow-list), every response says nosniff, and the
// page shell gets a Content-Security-Policy without inline scripts. Approvals made in the page (POST /api/save of
// requests.json / approvals.json) are stamped via:"page"; an agent never approves (lib/ops/_shared.mjs directorGate).
// Every /api call takes ?project=<id> (default: $WB_PROJECT, workbench.config.json default_project, else "demo").
// GET  /...                              files under the workbench folder; /data/<p>/... from the data folder
// GET  /media/<path>                     read-only files under media_base, only below the configured media_roots (Range supported)
// GET  /api/config                       {default_project, media_roots, private_re} (the page reads it at boot)
// GET  /api/status                       {ok, code {hash, started, disk, stale, changed}, default_project, pages, data_dir}
//                                        (every /api response carries the header x-wb-code: the hash of the code it runs)
// POST /api/save/<file>                  body {base_rev, data}; <file> in WRITABLE; 409 + current file when base_rev is stale
// GET  /api/events                       Server-Sent Events {"project", "file"} whenever a data file changes on disk,
//                                        and {"project", "ui": {...}} for the live UI channel, and {"project", "run": {id, phase, ...}}
//                                        for the request runner's progress (POST /api/op/request_run starts it)
// POST /api/op/<name>                    body = the op's arguments -> lib/store.mjs ops[name](project, args)   (local only;
//                                        bodies up to 5 MB, sketch_save up to 25 MB: two base64 PNGs + the strokes)
//                                        A project locked for render (revisions.json lock) answers 409 to every write
//                                        without this server's Origin (op, save, restore); reads stay open
// POST /api/ui                           {t?, view?, preview?, select?, message?, open_project?, wait_ms?} -> pushed to
//                                        the open pages of ?project; returns {delivered, pages} once they ack (local only)
// POST /api/ui/ack                       {id}  (the page, after it applied a UI command)
// GET  /api/projects                     [{id, title, modified, snapshots}]
// POST /api/projects/new                 {id, title?, lyrics?, song?}  a copy of data/_template/; with lyrics (text) and/or
//                                        song (an audio file path on this machine): the new-project wizard (lyrics.json v1,
//                                        song timings estimated until a song is attached)
// POST /api/projects/duplicate           {from, to, reset_state?}     copy data/<from>/ (no snapshots); reset_state = template
// POST /api/projects/delete              {id}                         refuses the default project, _template and demo
// GET  /api/snapshots                    [{id, at, message, auto, files}] newest first
// POST /api/snapshot                     {message}  -> copies the small JSON files to data/<p>/.snapshots/<ts>-<slug>/
// POST /api/restore                      {snapshot} -> snapshots the current state first ("auto"), then restores
// POST /api/reveal                       {path}     -> opens the file manager at a media file (local only)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream';
import os from 'node:os';
import crypto from 'node:crypto';
import * as S from './lib/store.mjs';
import { checkLyrics } from './js/flow.js';
import { checkScenes, SCENE_STATUSES } from './js/scenes.js';
import { checkBreakdown, ITEM_STATUSES } from './js/breakdown.js';
import { checkBoard } from './js/storyboard.js';
import { checkNotes } from './js/notes.js';
import * as BT from './js/batches.js';

const { CFG, DATA_ROOT, WB_DIR: WB } = S;
const ARGS = process.argv.slice(2);
const PORT = Number(ARGS.find(a => /^\d+$/.test(a)) || process.env.PORT || 8140);
const HOST = ARGS.includes('--lan') ? '0.0.0.0' : CFG.host || '127.0.0.1';
const DEFAULT = CFG.defaultProject;
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const TOKEN = process.env.WB_TOKEN || crypto.randomBytes(24).toString('hex');
// S9: the agents' own token (x-wb-agent-token): env WB_AGENT_TOKEN, else <DATA_ROOT>/.wb-agent-token (a dot-file outside
// every project folder: never served), made once and kept across restarts (several servers on one data folder share it).
// The MCP server (mcp/tools/_shared.mjs) reads it from there; a request carrying it is an agent, whatever its headers.
const AGENT_TOKEN_FILE = path.join(DATA_ROOT, '.wb-agent-token');
const AGENT_TOKEN = (() => {
  if (process.env.WB_AGENT_TOKEN) return String(process.env.WB_AGENT_TOKEN);
  const rd = () => { try { const t = fs.readFileSync(AGENT_TOKEN_FILE, 'utf8').trim(); return /^[0-9a-f]{48}$/.test(t) ? t : null; } catch (e) { return null; } };
  let t = rd(); if (t) return t;
  t = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  try { fs.writeFileSync(AGENT_TOKEN_FILE, t, { flag: 'wx', mode: 0o600 }); return t; }
  catch (e) { if (e.code === 'EEXIST') { const t2 = rd(); if (t2) return t2; fs.writeFileSync(AGENT_TOKEN_FILE, t, { mode: 0o600 }); return t; } throw e; }
})();
// the code this process runs (hash of serve.mjs, lib/, js/, tabs/, core/, app.js at start): /api/status and the header
// x-wb-code on every /api response carry it; the MCP server and the page compare it with the files on disk (stale = restart)
const CODE = S.codeState(), STARTED = new Date().toISOString().slice(0, 19);
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(WB, 'package.json'), 'utf8')).version; } catch (e) { return null; } })();   // About shows it
function codeStatus() {
  const disk = S.codeState(), changed = S.codeDiff(CODE, disk);
  return { hash: CODE.hash, started: STARTED, disk: disk.hash, stale: changed.length > 0, changed: changed.slice(0, 20),
    ...(changed.length ? { note: `the workbench code changed on disk after this server started (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''}): restart the server (node serve.mjs), then reload the page` } : {}) };
}
// host names a request may address this server by (DNS rebinding: an attacker's name resolving to us is refused)
const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  HOSTS.add(os.hostname().toLowerCase()); HOSTS.add(os.hostname().toLowerCase() + '.local');
  if (HOST !== '0.0.0.0' && HOST !== '::') HOSTS.add(HOST.includes(':') ? `[${HOST}]` : HOST);
  for (const a of Object.values(os.networkInterfaces()).flat()) if (a) HOSTS.add(a.family === 'IPv6' || a.family === 6 ? `[${a.address.split('%')[0]}]` : a.address);
}
const hostOk = (h) => { const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(h || '').toLowerCase()); return !!m && HOSTS.has(m[1]) && Number(m[2] || 80) === PORT; };
const originOk = (o) => { try { const u = new URL(o); return u.protocol === 'http:' && hostOk(u.host); } catch (e) { return false; } };
const same = (t, ref) => typeof t === 'string' && t.length === ref.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ref));
const tokenOk = (t) => same(t, TOKEN), agentTokenOk = (t) => same(t, AGENT_TOKEN);
// S9: the page = a browser on this server's origin: its Origin is ours AND it says Sec-Fetch-Site: same-origin (browsers
// send both on a same-origin POST; Node's fetch, curl and the MCP server send neither unless told to), with the page
// token and never the agent token. Anything else is an agent: it never approves, picks, locks or uploads as the director.
const isPage = (req) => !agentTokenOk(req.headers['x-wb-agent-token']) && tokenOk(req.headers['x-wb-token'])
  && !!req.headers.origin && originOk(req.headers.origin) && req.headers['sec-fetch-site'] === 'same-origin';
// the page gets the token in its HTML (another site cannot read it); core/token.js adds it to every /api POST
const TOKEN_TAG = `<meta name="wb-token" content="${TOKEN}"><script src="core/token.js"></script>`;
// the page shell: scripts only from this server (no inline script, no eval), styles may be inline (style attributes);
// media may also come from https: / data: / blob: (a project can reference remote files; Openverse thumbnails come from
// https://api.openverse.org/v1/images/<id>/thumb/ and its result tiles may show the original hosts' images). The page may
// fetch() only from this server and the Openverse API (stage 4's "Openverse" base picker searches it from the browser,
// CC0 / public domain by default); every other origin is blocked. Every other file served gets a sandboxing policy, so
// an HTML or SVG file in a project folder cannot run script in this origin.
const OPENVERSE = 'https://api.openverse.org';
const CSP_PAGE = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; "
  + `connect-src 'self' ${OPENVERSE}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
const CSP_FILE = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'";
// static files: only the page's own (compared lower-cased: Windows and macOS file systems ignore case), the sketch tool
// (core/sketch/), the free starter catalogue (catalog/: images + catalog.json + LICENSES.md, one folder deep) and the
// prompt templates (templates/*.json: the photoreal recipe the Queue's request form reads)
const STATIC = /^(index\.html|dock\.html|app\.js|app\.css|readme\.md|(core|js|tabs|core\/sketch)\/[\w.-]+\.(js|css)|catalog\/([\w-]+\/)?[\w.-]+\.(json|md|jpe?g|png|webp)|templates\/[\w.-]+\.json)$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.gif': 'image/gif', '.mov': 'video/quicktime', '.md': 'text/plain; charset=utf-8' };
fs.mkdirSync(DATA_ROOT, { recursive: true });

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    if (path.dirname(file) === WB && ['index.html', 'dock.html'].includes(path.basename(file).toLowerCase())) {   // the page shell: inject the token
      const html = fs.readFileSync(file, 'utf8').replace('</head>', TOKEN_TAG + '</head>');
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'content-security-policy': CSP_PAGE }); return res.end(req.method === 'HEAD' ? undefined : html);
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const head = { 'content-type': type, 'accept-ranges': 'bytes', 'content-security-policy': CSP_FILE,
      'cache-control': file.startsWith(DATA_ROOT) || /\.(js|mjs|css|html)$/.test(file) ? 'no-cache' : 'max-age=3600' };
    if (range && (range[1] || range[2])) {
      let a = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let b = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      a = Math.max(0, a); b = Math.min(st.size - 1, b);
      if (a > b) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...head, 'content-range': `bytes ${a}-${b}/${st.size}`, 'content-length': b - a + 1 });
      return pipeline(fs.createReadStream(file, { start: a, end: b }), res, () => {});
    }
    res.writeHead(200, { ...head, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    // small files in one read (no handle left open if the client goes away: Windows would then refuse to replace the
    // file); large media streamed with pipeline(), which closes the file when the response is aborted
    if (st.size < 4e6) return fs.readFile(file, (er, buf) => res.end(er ? undefined : buf));
    pipeline(fs.createReadStream(file), res, () => {});
  });
}

// ------------------------------------------------------------------ change feed (all projects; the page filters by project)
const clients = new Set();   // {res, project}
const watchTimer = new Map();
fs.watch(DATA_ROOT, { recursive: true }, (_ev, name) => {
  if (!name) { clearTimeout(watchTimer.get('*')); watchTimer.set('*', setTimeout(() => notify('*', ['*']), 80)); return; }   // Windows drops names when its event buffer overflows
  const f = name.replace(/\\/g, '/');
  // (gen/: the runner's outputs, job.json and lock: the page follows requests.json and media.json instead; .history: the git mirror)
  if (f.endsWith('.tmp') || f.endsWith('.lock') || f.includes('/.snapshots') || f.includes('/.history') || f.includes('/.uploads') || f.includes('/thumbs/') || /\/gen(\/|$)/.test(f)) return;
  const i = f.indexOf('/'); if (i < 0) return;
  clearTimeout(watchTimer.get(f));
  watchTimer.set(f, setTimeout(() => notify(f.slice(0, i), [f.slice(i + 1)]), 80));
});
function send(msg, project) { let n = 0; for (const c of clients) if (!project || !c.project || c.project === project) { c.res.write(`data: ${JSON.stringify(msg)}\n\n`); n++; } return n; }
function notify(project, files) { for (const file of files) send({ project, file }); }
// the request runner's progress (lib/run.mjs: claim, upload, submit, polling, take done, done / failed / handed off): live in the Queue
S.runEvents.on('run', (m) => send(m, m.project));

// ------------------------------------------------------------------ live UI channel: an agent asks the open page to show something
const acks = new Map();   // ui id -> {n, done}
const pendingUi = new Map();   // project -> {cmd, at}: a ui_focus sent while no page was open, shown by the next page that opens
const PENDING_UI_MS = 2 * 3600 * 1000;
function flushPendingUi(c) {
  const x = c.project && pendingUi.get(c.project); if (!x) return;
  pendingUi.delete(c.project);
  if (Date.now() - x.at > PENDING_UI_MS) return;
  c.res.write(`data: ${JSON.stringify({ project: c.project, ui: { ...x.cmd, queued_at: new Date(x.at).toISOString().slice(0, 19) } })}\n\n`);
}
let uiSeq = 0;
function pushUi(project, cmd) {
  const id = `ui${Date.now().toString(36)}${(uiSeq++).toString(36)}`;
  const pages = [...clients].filter(c => !c.project || c.project === project).length;
  const wait = Math.min(Math.max(Number(cmd.wait_ms ?? 1500), 0), 10000); delete cmd.wait_ms;
  send({ project, ui: { ...cmd, id } }, project);
  // no page open on the project: keep the latest focus for the next page that opens it (within 2 hours)
  if (!pages && !cmd.open_project) { pendingUi.set(project, { cmd: { ...cmd, id }, at: Date.now() }); return Promise.resolve({ id, pages, delivered: 0, queued: true }); }
  if (!pages || !wait) return Promise.resolve({ id, pages, delivered: 0 });
  return new Promise((ok) => {
    const a = { n: 0, done: () => { clearTimeout(a.timer); acks.delete(id); ok({ id, pages, delivered: a.n }); } };
    a.timer = setTimeout(a.done, wait); acks.set(id, a);
    a.pages = pages;
  });
}

// request bodies: 5 MB, except a sketch save (two base64 PNGs + the stroke JSON): 25 MB. Over the limit: 413 at once
// (by Content-Length when sent, else while reading); the rest of the upload is discarded and the connection closed.
const bodyLimit = (p) => p === '/api/op/sketch_save' || p === '/api/op/ref_upload' ? 25e6 : p === '/api/op/media_upload' ? 9e6 : 5e6;
function readBody(req, limit) {
  return new Promise((ok, bad) => {
    const too = () => new S.WbError(413, `body too big (${limit / 1e6} MB max)`);
    if (Number(req.headers['content-length']) > limit) { req.resume(); return bad(too()); }
    const chunks = []; let n = 0, over = false;
    req.on('data', d => { if (over) return; n += d.length; if (n > limit) { over = true; chunks.length = 0; bad(too()); } else chunks.push(d); });
    req.on('end', () => { if (!over) ok(Buffer.concat(chunks).toString('utf8')); }); req.on('error', bad);
  });
}
// a page save is the director's own act: record it as such. requests.json: the server owns each request's log (the page
// never writes it) and appends {by: "director", via: "page"} on a status change, which is what lib/store.mjs approvalOk()
// accepts as an approval. approvals.json: an item whose state changed is marked via:"page". stages.json: a stage whose
// status changed is marked via:"page" (done: done_by "director"; only the page marks a stage done). lyrics.json: a
// version once saved never changes (the server keeps its copy); new versions, notes and replies are stamped
// by "director", via "page"; existing notes and replies keep their author. scenes.json (stage 2): the same for its
// versions, notes and replies; a changed scene status or intake answer is stamped director / page (an unchanged one keeps
// its author); a malformed file is refused (400). breakdown.json (stage 3): versions and note authors the same; a changed
// item status is stamped director / page; entity_id / look_id are never taken from a page save (only the page's
// "Create entity" op, breakdown_promote, sets them). storyboard.json (stage 6): versions and note authors the same; a
// malformed file is refused (400). A shot's approval is approvals.json (stamped above), never storyboard.json.
// notes.json (v2, one list for every stage and the timeline): new notes and replies are stamped by "director", via
// "page" (round = the current round); an existing note keeps its author, via, created, target, round, legacy link and
// absorbed_in and change (the round's link to what the agent changed), and an agent's note keeps its words (only the director's own text can be edited); a status change is
// stamped closed_by director / via page; legacy_seen only grows (a deleted migrated note never comes back); anything that
// is not a v2 doc (an old page saving the v1 list) is refused (400: reload).
// S9: a save without the page (no page Origin + Sec-Fetch-Site: same-origin, or the agent token) is an agent's: it is
// stamped by "agent", via "agent", and may not approve / lock, mark a stage done, set a scene or item ok, or dismiss the
// director's notes (403, "approve in the page").
const SAVE_STATUSES = ['draft', 'approved', 'rejected', 'withdrawn'];   // what a save may move a request to (the runner does the rest)
const CONTENT = ['prompt', 'refs', 'est_cost', 'tool', 'video', 'takes'];   // what the director approves (an edit voids it)
const same_ = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function stampPage(name, data, cur, fromPage = true) {
  const at = new Date().toISOString().slice(0, 19);
  const W = fromPage ? { by: 'director', via: 'page' } : { by: 'agent', via: 'agent' };
  const deny = (what) => { throw new S.WbError(403, `${what}: only the director does this, in the open page (approve in the page). This save is an agent's (no page Origin + Sec-Fetch-Site: same-origin); agents use the MCP tools`); };
  if (name === 'requests.json' && Array.isArray(data.items)) {
    const was = new Map((cur.items || []).map(r => [r.id, r])), seen = new Set(), project = cur.__project;
    // N3: an existing request is never removed or renamed by a save (withdraw or reject it); ids are unique
    for (const r of data.items) {
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id)) throw new S.WbError(400, 'requests.json: every item needs an id ([A-Za-z0-9_-], 1-64)');
      if (seen.has(r.id)) throw new S.WbError(400, `requests.json: request ${r.id} twice`); seen.add(r.id);
    }
    for (const id of was.keys()) if (!seen.has(id)) throw new S.WbError(400, `request ${id}: a save never removes or renames a request (withdraw or reject it instead)`);
    data.items = data.items.map(r => {
      const c = was.get(r.id), log = [...(c?.log || [])];
      // a history request (imported from a job book) is the server's: a page save cannot make one or change it
      if (c?.history) return { ...c };
      const out = { ...r }; delete out.history;
      if (!c) {   // a new request is always a draft, its author the saver
        if (r.status !== 'draft') throw new S.WbError(400, `request ${r.id}: a new request is a draft (approve it afterwards, in the page)`);
        if (Array.isArray(out.refs)) out.refs = S.canonRefs(project, out.refs);
        delete out.private_upload_ok;
        return { ...out, by: W.by, log: [{ at, ...W, status: 'draft' }] };
      }
      let status = r.status;
      // an edit of what was approved (prompt, refs, estimate, tool, video, takes) voids the approval and the private tick
      if (Array.isArray(out.refs) && !same_(out.refs, c.refs)) out.refs = S.canonRefs(project, out.refs);
      const edited = CONTENT.some(k => !same_(out[k], c[k]));
      if (edited && !['draft', 'approved'].includes(c.status)) throw new S.WbError(400, `request ${r.id} is ${c.status}: only draft or approved requests can be edited`);
      if (edited && c.status === 'approved') { if (status !== c.status && status !== 'draft') throw new S.WbError(400, `request ${r.id}: an edit voids its approval (it goes back to draft); approve it again afterwards`); status = 'draft'; }
      out.status = status;
      if (c.status !== status) {
        if (!SAVE_STATUSES.includes(status)) throw new S.WbError(400, `request ${r.id}: a save moves a request to ${SAVE_STATUSES.join(' / ')} only (the runner queues and runs it)`);
        if (status === 'approved' && !fromPage) deny(`request ${r.id} approved`);
        // N3: a request in a batch (D4) is approved with its batch (batch_act); a save only rejects, withdraws or re-drafts it
        const b = BT.batchOfRequest(cur, r.id);
        if (b && status === 'approved') throw new S.WbError(403, `request ${r.id} is in ${b.name || b.id}: it is approved with its batch (Approve batch), not alone`);
        // withdrawn = its author took the draft back: the director withdraws their own drafts; an agent's draft they reject
        if (status === 'withdrawn' && (c.status !== 'draft' || S.requestAuthor(c) !== (fromPage ? 'director' : 'agent'))) throw new S.WbError(fromPage ? 400 : 403, `request ${r.id}: only its author withdraws a draft (${fromPage ? 'an agent\'s draft: Reject' : 'the director\'s: they decide'})`);
        if (status === 'rejected' && !fromPage) deny(`request ${r.id} rejected (an agent withdraws its own draft)`);
        log.push({ at, ...W, status, ...(edited && c.status === 'approved' ? { why: 'edited: approve it again' } : {}) });
      }
      // "allow uploading private refs" is the director's tick: recorded in the server-owned log (lib/ops/_shared.mjs privateUploadOk);
      // an agent's save leaves it as it is, and an edit unticks it
      const pu = edited ? false : fromPage ? r.private_upload_ok === true : c.private_upload_ok === true;
      if (pu !== (c.private_upload_ok === true)) log.push({ at, ...(edited ? W : { by: 'director', via: 'page' }), private_upload: pu, ...(edited ? { why: 'edited: tick "allow uploading private refs" again' } : {}) });
      out.log = log; if (pu) out.private_upload_ok = true; else delete out.private_upload_ok;
      if (c.by !== undefined) out.by = c.by; else delete out.by;   // the author is the server's record
      return out;
    });
    // batches (D4) are the server's: written only by waves_plan / batch_act, a page save keeps the server's copy
    if (Array.isArray(cur.batches)) data.batches = cur.batches; else delete data.batches;
  }
  if (name === 'approvals.json' && data.items && typeof data.items === 'object') {
    for (const [k, v] of Object.entries(data.items)) {
      if (!v || typeof v !== 'object') continue;
      const c = cur.items?.[k];
      if (!c || c.state !== v.state) { if (!fromPage && ['approved', 'locked'].includes(v.state)) deny(`${k} ${v.state}`); v.via = W.via; } else if (c.via) v.via = c.via; else delete v.via;
    }
  }
  if (name === 'stages.json') {
    if (!Array.isArray(data.stages)) throw new S.WbError(400, 'stages.json: {stages: [...]} expected');
    const was = new Map((cur.stages || []).map(x => [x?.id, x]));
    data.stages = data.stages.filter(x => x && typeof x === 'object').map(x => {
      const c = was.get(x.id), out = { ...x };
      if (!c || c.status !== x.status) { if (!fromPage && (x.status === 'done' || c?.status === 'done')) deny(`stage ${x.id} ${x.status === 'done' ? 'marked done' : 'moved from done'}`); out.updated = at; out.via = W.via; out.updated_by = W.by; if (x.status === 'done') out.done_by = 'director'; else delete out.done_by; }
      else { for (const k of ['done_by', 'via', 'updated_by']) { if (c[k] !== undefined) out[k] = c[k]; else delete out[k]; } }
      return out;
    });
  }
  if (name === 'lyrics.json') {
    try { checkLyrics(data); } catch (e) { throw new S.WbError(400, e.message); }
    const cv = new Map((cur.versions || []).map(v => [v.id, v])), cn = new Map((cur.notes || []).map(n => [n.id, n]));
    data.versions = data.versions.map(v => cv.get(v.id) || { ...v, created: at, ...(v.via === 'import' && !cur.versions ? {} : { ...W }) });
    data.notes = (data.notes || []).filter(n => n && typeof n === 'object').map(n => {
      const c = cn.get(n.id), cr = new Map((c?.replies || []).map(r => [r.id, r]));
      const replies = (Array.isArray(n.replies) ? n.replies : []).filter(r => r && typeof r === 'object').map(r => cr.get(r.id) ? { ...r, by: cr.get(r.id).by, via: cr.get(r.id).via, at: cr.get(r.id).at } : { ...r, ...W, at });
      return c ? { ...n, by: c.by, via: c.via, at: c.at, replies } : { ...n, ...W, at, replies };
    });
  }
  if (name === 'scenes.json') {
    try { checkScenes(data); } catch (e) { throw new S.WbError(400, e.message); }
    const cv = new Map((cur.versions || []).map(v => [v.id, v])), cn = new Map((cur.notes || []).map(n => [n.id, n]));
    data.versions = data.versions.map(v => cv.get(v.id) || { ...v, created: at, ...(v.via === 'import' && !cur.versions ? {} : { ...W }) });
    data.notes = (data.notes || []).filter(n => n && typeof n === 'object').map(n => {
      const c = cn.get(n.id), cr = new Map((c?.replies || []).map(r => [r.id, r]));
      const replies = (Array.isArray(n.replies) ? n.replies : []).filter(r => r && typeof r === 'object').map(r => cr.get(r.id) ? { ...r, by: cr.get(r.id).by, via: cr.get(r.id).via, at: cr.get(r.id).at } : { ...r, ...W, at });
      return c ? { ...n, by: c.by, via: c.via, at: c.at, replies } : { ...n, ...W, at, replies };
    });
    // per-scene statuses and intake answers: a changed one is the director's (via page); an unchanged one keeps its author
    const st = {};
    for (const [k, v] of Object.entries(data.states || {})) {
      if (!v || !SCENE_STATUSES.includes(v.status)) continue;
      const c = cur.states?.[k];
      if (!(c && c.status === v.status) && v.status === 'ok' && !fromPage) deny(`scene ${k} ok`);
      st[k] = c && c.status === v.status ? { ...c } : { status: v.status, ...W, at };
    }
    data.states = st;
    const ik = {};
    for (const [k, v] of Object.entries(data.intake || {})) {
      if (!v || typeof v !== 'object') continue;
      const c = cur.intake?.[k] || {}, a = {};
      if (typeof v.text === 'string') Object.assign(a, v.text === c.text ? { text: c.text, by: c.by, via: c.via, at: c.at } : { text: v.text.slice(0, 8000), ...W, at });
      if (v.asked) a.asked = c.asked || { ...W, at };
      ik[k] = a;
    }
    data.intake = ik;
  }
  if (name === 'breakdown.json') {
    try { checkBreakdown(data); } catch (e) { throw new S.WbError(400, e.message); }
    const cv = new Map((cur.versions || []).map(v => [v.id, v])), cn = new Map((cur.notes || []).map(n => [n.id, n]));
    data.versions = data.versions.map(v => cv.get(v.id) || { ...v, created: at, ...W });
    data.notes = (data.notes || []).filter(n => n && typeof n === 'object').map(n => {
      const c = cn.get(n.id), cr = new Map((c?.replies || []).map(r => [r.id, r]));
      const replies = (Array.isArray(n.replies) ? n.replies : []).filter(r => r && typeof r === 'object').map(r => cr.get(r.id) ? { ...r, by: cr.get(r.id).by, via: cr.get(r.id).via, at: cr.get(r.id).at } : { ...r, ...W, at });
      return c ? { ...n, by: c.by, via: c.via, at: c.at, replies } : { ...n, ...W, at, replies };
    });
    const st = {};
    for (const [k, v] of Object.entries(data.states || {})) {
      if (!v || !ITEM_STATUSES.includes(v.status)) continue;
      const c = cur.states?.[k], x = c && c.status === v.status ? { ...c } : { status: v.status, ...W, at };
      if (!(c && c.status === v.status) && v.status === 'ok' && !fromPage) deny(`item ${k} ok`);
      delete x.entity_id; delete x.look_id;
      if (c?.entity_id) x.entity_id = c.entity_id; if (c?.look_id) x.look_id = c.look_id;
      st[k] = x;
    }
    for (const [k, c] of Object.entries(cur.states || {})) if (c?.entity_id && !st[k]) st[k] = { ...c };
    data.states = st;
  }
  if (name === 'notes.json') {
    try { checkNotes(data, { duration: S.read(cur.__project, 'song.json')?.duration_ms }); } catch (e) { throw new S.WbError(400, e.message); }
    const cn = new Map((cur.notes || []).map(n => [n.id, n]));
    data.notes = data.notes.map(n => {
      const c = cn.get(n.id), cr = new Map((c?.replies || []).map(r => [r.id, r]));
      const replies = (Array.isArray(n.replies) ? n.replies : []).map((r, k) => { const o = cr.get(r.id); return o ? { ...o } : { id: typeof r.id === 'string' && r.id ? r.id.slice(0, 60) : `${n.id}.${k + 1}`, text: String(r.text).slice(0, 8000), ...W, at }; });
      if (!c) { const { legacy: _l, absorbed_in: _a, closed_via: _v, change: _c, ...x } = n; return { ...x, ...W, created: at, round: cur.round || 1, absorbed_in: null, replies, ...(n.status !== 'open' ? { closed_by: W.by, closed_via: W.via, closed_at: at } : {}) }; }
      if (!fromPage && n.status !== c.status && c.via !== 'agent' && (n.status === 'dismissed' || c.status === 'dismissed')) deny(`note ${n.id} ${n.status === 'dismissed' ? 'dismissed' : 'reopened'} (the director's note)`);
      const out = { ...n, by: c.by, via: c.via, created: c.created, target: c.target, round: c.round, replies, text: c.via === 'agent' || !fromPage ? c.text : n.text };
      for (const k of ['legacy', 'absorbed_in', 'reply_to', 'change']) { if (c[k] !== undefined) out[k] = c[k]; else delete out[k]; }
      if (n.status !== c.status) { if (n.status === 'open') { delete out.closed_by; delete out.closed_via; delete out.closed_at; } else Object.assign(out, { closed_by: W.by, closed_via: W.via, closed_at: at }); }
      else for (const k of ['closed_by', 'closed_via', 'closed_at']) { if (c[k] !== undefined) out[k] = c[k]; else delete out[k]; }
      return out;
    });
    data.v = 2; data.round = cur.round || data.round || 1;
    data.legacy_seen = [...new Set([...(cur.legacy_seen || []), ...(Array.isArray(data.legacy_seen) ? data.legacy_seen : [])].filter(x => typeof x === 'string'))];
    if (cur.migrated) data.migrated = cur.migrated;
  }
  if (name === 'storyboard.json') {
    try { checkBoard(data); } catch (e) { throw new S.WbError(400, e.message); }
    const cv = new Map((cur.versions || []).map(v => [v.id, v])), cn = new Map((cur.notes || []).map(n => [n.id, n]));
    // the picked takes (shot.clip) are written only by take_act: a new version from a page save keeps the server's picks
    const picks = new Map(((cur.versions || []).find(v => v.id === cur.current)?.shots || []).filter(x => x.clip).map(x => [x.id, x.clip]));
    const keepPicks = (shots) => shots.map(x => { const { clip: _c, ...r } = x; return picks.has(x.id) ? { ...r, clip: picks.get(x.id) } : r; });
    data.versions = data.versions.map(v => cv.get(v.id) || { ...v, shots: keepPicks(v.shots), created: at, ...(v.via === 'import' && !cur.versions ? {} : { ...W }) });
    data.notes = (data.notes || []).filter(n => n && typeof n === 'object').map(n => {
      const c = cn.get(n.id), cr = new Map((c?.replies || []).map(r => [r.id, r]));
      const replies = (Array.isArray(n.replies) ? n.replies : []).filter(r => r && typeof r === 'object').map(r => cr.get(r.id) ? { ...r, by: cr.get(r.id).by, via: cr.get(r.id).via, at: cr.get(r.id).at } : { ...r, ...W, at });
      return c ? { ...n, by: c.by, via: c.via, at: c.at, replies } : { ...n, ...W, at, replies };
    });
  }
  return data;
}
const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json', 'x-wb-code': CODE.hash }); res.end(JSON.stringify(v)); };

http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  try {
    if (!hostOk(req.headers.host)) return json(res, 403, { error: `unknown Host header (open http://localhost:${PORT}/)` });
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const project = url.searchParams.get('project') || DEFAULT;
    // also no ":" (NTFS streams: private::$INDEX_ALLOCATION/x, x.jpg::$DATA) and no "~<digit>" (8.3 short names: SNAPSH~1)
    if (/[\\\0:]|~\d/.test(p) || p.split('/').some(s => s === '..' || s === '.')) return json(res, 400, { error: 'bad path' });
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n'); const c = { res, project: url.searchParams.get('project') || null }; clients.add(c); req.on('close', () => clients.delete(c)); flushPendingUi(c); return;
    }
    if (p === '/api/config') return json(res, 200, { default_project: DEFAULT, media_roots: CFG.mediaRoots, private_re: CFG.privateSrc });
    if (p === '/api/status') return json(res, 200, { ok: true, app: 'director-workbench', version: VERSION, code: codeStatus(), default_project: DEFAULT, pages: clients.size, pages_by_project: [...clients].reduce((o, c) => (o[c.project || '*'] = (o[c.project || '*'] || 0) + 1, o), {}), data_dir: DATA_ROOT });
    if (p === '/api/projects' && req.method === 'GET') return json(res, 200, S.listProjects());
    if (p === '/api/snapshots' && req.method === 'GET') return json(res, 200, S.listSnapshots(project));
    if (p.startsWith('/api/') && req.method === 'POST') {
      // CSRF: JSON only (a cross-site form or no-preflight fetch cannot send it), no foreign Origin, the per-run token
      if (req.headers.origin && !originOk(req.headers.origin)) return json(res, 403, { error: 'foreign Origin' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'content-type must be application/json' });
      if (!tokenOk(req.headers['x-wb-token']) && !agentTokenOk(req.headers['x-wb-agent-token'])) return json(res, 403, { error: 'missing or wrong token: the page sends x-wb-token (reload the page); agents send x-wb-agent-token from <data folder>/.wb-agent-token (the MCP server reads it)' });
      if (!isLocal(req) && !CFG.allowRemoteOps && p !== '/api/ui/ack') return json(res, 403, { error: 'writes are local only (set allow_remote_ops in workbench.config.json)' });
      let raw; try { raw = await readBody(req, bodyLimit(p)); } catch (e) { if (e.code === 413) res.setHeader('connection', 'close'); throw e; }
      const body = raw ? JSON.parse(raw) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'body must be a JSON object' });
      // who writes (S9): the page (the director) or an agent; every stamp, page-only act and lock check follows it
      const fromPage = isPage(req);
      res.setHeader('x-wb-client', fromPage ? 'page' : 'agent');
      // a project locked for render (Final stage, page only) refuses every write that is not the page's own: 409 + why
      if (!fromPage && (p.startsWith('/api/save/') || p === '/api/restore')) S.lockGate(project, p.startsWith('/api/save/') ? 'save' : 'snapshot_restore');
      if (!fromPage && p === '/api/projects/delete' && S.validId(body.id)) S.lockGate(body.id, 'project_delete');
      if (p.startsWith('/api/save/')) {
        const name = p.slice('/api/save/'.length);
        if (!S.WRITABLE.has(name)) { res.writeHead(403); return res.end('not writable'); }
        const file = path.join(S.projDir(project), name);
        if (name === 'notes.json') S.notesDoc(project);   // the old stores are migrated before a page save of the v2 list
        // under the file's lock (lib/ops/_shared.mjs withFileLock): another process's write between the rev check and this
        // write would be lost otherwise
        const r = S.withFileLock(file, () => {
          const cur = S.readJSON(file, { rev: 0 }, true) || { rev: 0 };
          if ((cur.rev || 0) !== body.base_rev) return { stale: cur };
          const data = stampPage(name, { ...body.data, rev: (cur.rev || 0) + 1 }, Object.defineProperty({ ...cur }, '__project', { value: project, enumerable: false }), fromPage);
          S.writeJSON(file, data); return { data, cur };
        });
        if (r.stale) return json(res, 409, r.stale);
        const { data, cur } = r;
        S.afterPageSave(project, name, data, cur);   // lyrics.json: the song's lines follow the current version
        return json(res, 200, { rev: data.rev });
      }
      if (p === '/api/ui/ack') { const a = acks.get(body.id); if (a) { a.n++; if (a.n >= a.pages) a.done(); } return json(res, 200, { ok: true }); }
      if (p === '/api/ui') { S.projDir(project); return json(res, 200, await pushUi(project, body)); }
      if (p.startsWith('/api/op/')) {
        const name = p.slice('/api/op/'.length);
        if (!Object.hasOwn(S.ops, name)) return json(res, 404, { error: 'no such op: ' + name });
        // who drew a sketch (provenance, not a permission): a browser on this origin is the page, anything else an agent
        // S9: whatever the op, a body that claims via "page" is the page's only when the request is the page's
        if (!fromPage && body.via === 'page') body.via = 'agent';
        if (name === 'sketch_save' || name === 'request_run') body.via = fromPage ? 'page' : 'agent';   // provenance (who started a run / drew)
        // only the page turns a breakdown item into an entity: a browser request from this origin (the MCP server has no
        // such tool, and a request without the page's Origin is the agent surface and refused by the op)
        if (name === 'breakdown_promote') body.via = fromPage ? 'page' : 'agent';
        // stages 4 and 5: the director's acts (base, keep / branch / revert, approving the root or a variant, the variant
        // a scene uses) and reference uploads are the page's only, the same way
        if (name === 'character_act' || name === 'asset_act' || name === 'ref_upload') body.via = fromPage ? 'page' : 'agent';
        // review rounds and revisions: sending a round, closing and restoring a revision are the director's (page only)
        if (name === 'round_send' || name === 'revision_close' || name === 'revision_restore') body.via = fromPage ? 'page' : 'agent';
        // proposals: a pick / mix / dismiss is the director's (page only); the local generator's provenance (not a permission)
        if (name === 'proposal_act' || name === 'proposals_local' || name === 'proposals_add') body.via = fromPage ? 'page' : 'agent';
        // stage 7: locking / unlocking the project for render are the director's (page only)
        if (name === 'final_lock' || name === 'final_unlock') body.via = fromPage ? 'page' : 'agent';
        // take selection (D6): picking a take, its in / out and alternatives are the director's (page only)
        if (name === 'take_act') body.via = fromPage ? 'page' : 'agent';
        // D8: uploading files and "use as" (a node, a shot's take / start frame) are the director's (page only); an import's provenance
        if (name === 'media_upload' || name === 'media_use' || name === 'media_import') body.via = fromPage ? 'page' : 'agent';
        // D4: approving / reviewing a batch and importing the job books are the director's (page only); a plan's provenance
        if (name === 'batch_act' || name === 'jobbooks_import' || name === 'waves_plan') body.via = fromPage ? 'page' : 'agent';
        // E1: changing / accepting the named events and applying / undoing a re-time are the director's (page only); an agent's
        // event and re-time are proposals
        if (name === 'events_act' || name === 'retime_apply' || name === 'retime_undo' || name === 'event_add' || name === 'retime_propose') body.via = fromPage ? 'page' : 'agent';
        if (!fromPage) S.lockGate(project, name, body);   // a locked project refuses every agent write, proposals included
        delete body.import_ok;   // only a local script calling lib/store.mjs directly may import approved looks
        try { return json(res, 200, await S.ops[name](project, body)); }
        catch (e) { if (e.code === 403 && !fromPage) e.message += ' (an agent\'s request: no page Origin + Sec-Fetch-Site: same-origin; agents use the MCP tools, the director acts in the open page)'; throw e; }
      }
      if (p === '/api/projects/new') return json(res, 200, body.lyrics != null || body.song ? await S.createGuidedProject(body) : S.createProject(body.id, body.title));
      if (p === '/api/projects/duplicate') return json(res, 200, S.duplicateProject(body.from || project, body.to, !!body.reset_state));
      if (p === '/api/projects/delete') return json(res, 200, S.deleteProject(body.id));
      if (p === '/api/snapshot') return json(res, 200, S.snapshot(project, body.message));
      if (p === '/api/restore') {
        const r = S.restore(project, body.snapshot, { agent: !fromPage || body.by === 'agent' });
        setTimeout(() => notify(project, [...r.changed, ...r.removed]), 120);   // explicit: the watcher may have overflowed
        return json(res, 200, r);
      }
      if (p === '/api/reveal') {
        if (!isLocal(req)) return json(res, 403, { error: 'local only' });
        const f = S.resolveMedia(project, String(body.path || ''));
        if (!f || !fs.existsSync(f)) return json(res, 404, { error: 'not found' });
        if (process.platform === 'win32') spawn('explorer.exe', ['/select,', f], { detached: true, stdio: 'ignore' }).unref();
        else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [process.platform === 'darwin' ? '-R' : path.dirname(f), ...(process.platform === 'darwin' ? [f] : [])], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { path: f });
      }
      res.writeHead(404); return res.end('no such endpoint');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    // the page reads its project from ?project=: send a bare / to the default project
    if ((p === '/' || p === '/index.html' || p === '/dock.html') && !S.validId(url.searchParams.get('project'))) {
      res.writeHead(302, { location: `${p === '/dock.html' ? '/dock.html' : '/'}?project=${encodeURIComponent(DEFAULT)}` }); return res.end();
    }
    // every check below runs on the path normalised relative to its root, case-insensitively (Windows/macOS file
    // systems ignore case, so /TOOLS/ and /Data/ are the same folders as /tools/ and /data/)
    const priv = (rel, projects) => !isLocal(req) && (S.isPrivate(rel) || S.isFlaggedPrivate(rel, projects));
    if (p.startsWith('/media/')) {
      const f = S.mediaRootFile(p.slice(7)); if (!f) { res.writeHead(403); return res.end('not a media root'); }
      if (priv(S.relTo(CFG.mediaBase, f), S.projectIds())) { res.writeHead(403); return res.end('private: local only'); }
      return sendFile(req, res, f);
    }
    let f;
    const m = /^\/data\/([^/]+)\/(.+)$/i.exec(p);
    if (m) {
      // dot-folders (.snapshots, the git mirror .history) and dot-files are never served
      if (!S.validId(m[1]) || m[2].split('/').some(x => x.startsWith('.'))) { res.writeHead(403); return res.end(); }
      const pd = path.join(DATA_ROOT, m[1]);
      f = S.inside(pd, m[2]); if (!f) { res.writeHead(403); return res.end(); }
      const rel = S.relTo(pd, f);
      if (priv(rel, [m[1]]) || priv(`data/${m[1]}/${rel}`, [])) { res.writeHead(403); return res.end('private: local only'); }
      // notes.json: the old note stores are migrated into it (v2) on its first read
      if (m[2] === 'notes.json' && fs.existsSync(path.join(pd, 'song.json'))) { try { S.notesDoc(m[1]); } catch (e) { /* a broken file is served as it is */ } }
      // a writable state file (or revisions.json / proposals.json / takes.json / checks.json, the server's) that does not exist yet reads as null (the page uses its default)
      if ((S.WRITABLE.has(m[2]) || m[2] === 'revisions.json' || m[2] === 'proposals.json' || m[2] === 'takes.json' || m[2] === 'checks.json' || m[2] === 'events.json') && !fs.existsSync(f)) return json(res, 200, null);
      // a remote (LAN) client reads the project's JSON without private paths or items flagged private (media.json,
      // entities with private refs and iteration nodes, requests built on private photos)
      if (!isLocal(req) && /\.json$/i.test(f) && fs.existsSync(f)) {
        const j = S.readJSON(f, null); if (j == null) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-cache', 'content-security-policy': CSP_FILE }); return res.end(JSON.stringify(S.scrubPrivate(j, [m[1]])));
      }
    } else {
      f = S.inside(WB, p === '/' ? 'index.html' : p.slice(1)); if (!f) { res.writeHead(403); return res.end(); }
      const rel = S.relTo(WB, f).toLowerCase();
      if (!STATIC.test(rel)) { res.writeHead(403); return res.end(); }
      if (priv(rel, [])) { res.writeHead(403); return res.end('private: local only'); }
    }
    sendFile(req, res, f);
  } catch (e) { const code = e.code >= 400 && e.code < 600 ? e.code : e instanceof SyntaxError || e instanceof URIError ? 400 : 500; json(res, code, { error: String(e.message || e) }); }
}).listen(PORT, HOST, () => console.log(`workbench: http://localhost:${PORT}/  (listening on ${HOST}; default project ${DEFAULT}, data ${DATA_ROOT}${CFG.file ? ', config ' + path.basename(CFG.file) : ''})`));
