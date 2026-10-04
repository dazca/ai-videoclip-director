// Director workbench server: static files + read-only media + writable state files + projects/snapshots + agent ops
// + a change feed and a live UI channel. The data layer is lib/store.mjs (shared with the MCP server, mcp/server.mjs).
//   node serve.mjs [port]          (default 8140) then open http://localhost:8140/  (?project=<id>)
// Every /api call takes ?project=<id> (default: $WB_PROJECT, workbench.config.json default_project, else "demo").
// GET  /...                              files under the workbench folder; /data/<p>/... from the data folder
// GET  /media/<path>                     read-only files under media_base, only below the configured media_roots (Range supported)
// GET  /api/config                       {default_project, media_roots, private_re} (the page reads it at boot)
// GET  /api/status                       {ok, default_project, pages, data_dir}
// POST /api/save/<file>                  body {base_rev, data}; <file> in WRITABLE; 409 + current file when base_rev is stale
// GET  /api/events                       Server-Sent Events {"project", "file"} whenever a data file changes on disk,
//                                        and {"project", "ui": {...}} for the live UI channel
// POST /api/op/<name>                    body = the op's arguments -> lib/store.mjs ops[name](project, args)   (local only)
// POST /api/ui                           {t?, view?, preview?, select?, message?, open_project?, wait_ms?} -> pushed to
//                                        the open pages of ?project; returns {delivered, pages} once they ack (local only)
// POST /api/ui/ack                       {id}  (the page, after it applied a UI command)
// GET  /api/projects                     [{id, title, modified, snapshots}]
// POST /api/projects/new                 {id, title?}                 empty project (a copy of data/_template/)
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
import * as S from './lib/store.mjs';

const { CFG, DATA_ROOT, WB_DIR: WB } = S;
const PORT = Number(process.argv[2] || process.env.PORT || 8140);
const DEFAULT = CFG.defaultProject;
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.md': 'text/plain; charset=utf-8' };
fs.mkdirSync(DATA_ROOT, { recursive: true });

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const head = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': file.startsWith(DATA_ROOT) || /\.(js|mjs|css|html)$/.test(file) ? 'no-cache' : 'max-age=3600' };
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
  if (f.endsWith('.tmp') || f.includes('/.snapshots') || f.includes('/thumbs/')) return;
  const i = f.indexOf('/'); if (i < 0) return;
  clearTimeout(watchTimer.get(f));
  watchTimer.set(f, setTimeout(() => notify(f.slice(0, i), [f.slice(i + 1)]), 80));
});
function send(msg, project) { let n = 0; for (const c of clients) if (!project || !c.project || c.project === project) { c.res.write(`data: ${JSON.stringify(msg)}\n\n`); n++; } return n; }
function notify(project, files) { for (const file of files) send({ project, file }); }

// ------------------------------------------------------------------ live UI channel: an agent asks the open page to show something
const acks = new Map();   // ui id -> {n, done}
let uiSeq = 0;
function pushUi(project, cmd) {
  const id = `ui${Date.now().toString(36)}${(uiSeq++).toString(36)}`;
  const pages = [...clients].filter(c => !c.project || c.project === project).length;
  const wait = Math.min(Math.max(Number(cmd.wait_ms ?? 1500), 0), 10000); delete cmd.wait_ms;
  send({ project, ui: { ...cmd, id } }, project);
  if (!pages || !wait) return Promise.resolve({ id, pages, delivered: 0 });
  return new Promise((ok) => {
    const a = { n: 0, done: () => { clearTimeout(a.timer); acks.delete(id); ok({ id, pages, delivered: a.n }); } };
    a.timer = setTimeout(a.done, wait); acks.set(id, a);
    a.pages = pages;
  });
}

function readBody(req) {
  return new Promise((ok, bad) => { let b = ''; req.on('data', d => { b += d; if (b.length > 5e6) bad(new Error('too big')); }); req.on('end', () => ok(b)); });
}
const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  const project = url.searchParams.get('project') || DEFAULT;
  try {
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n'); const c = { res, project: url.searchParams.get('project') || null }; clients.add(c); req.on('close', () => clients.delete(c)); return;
    }
    if (p === '/api/config') return json(res, 200, { default_project: DEFAULT, media_roots: CFG.mediaRoots, private_re: CFG.privateSrc });
    if (p === '/api/status') return json(res, 200, { ok: true, app: 'director-workbench', default_project: DEFAULT, pages: clients.size, pages_by_project: [...clients].reduce((o, c) => (o[c.project || '*'] = (o[c.project || '*'] || 0) + 1, o), {}), data_dir: DATA_ROOT });
    if (p === '/api/projects' && req.method === 'GET') return json(res, 200, S.listProjects());
    if (p === '/api/snapshots' && req.method === 'GET') return json(res, 200, S.listSnapshots(project));
    if (p.startsWith('/api/') && req.method === 'POST') {
      const raw = await readBody(req); const body = raw ? JSON.parse(raw) : {};
      if (p.startsWith('/api/save/')) {
        const name = p.slice('/api/save/'.length);
        if (!S.WRITABLE.has(name)) { res.writeHead(403); return res.end('not writable'); }
        const file = path.join(S.projDir(project), name);
        const cur = S.readJSON(file, { rev: 0 });
        if ((cur.rev || 0) !== body.base_rev) return json(res, 409, cur);
        const data = { ...body.data, rev: (cur.rev || 0) + 1 };
        S.writeJSON(file, data);
        return json(res, 200, { rev: data.rev });
      }
      if (p === '/api/ui/ack') { const a = acks.get(body.id); if (a) { a.n++; if (a.n >= a.pages) a.done(); } return json(res, 200, { ok: true }); }
      if ((p.startsWith('/api/op/') || p === '/api/ui') && !isLocal(req) && !CFG.allowRemoteOps) return json(res, 403, { error: 'agent ops are local only (set allow_remote_ops in workbench.config.json)' });
      if (p === '/api/ui') { S.projDir(project); return json(res, 200, await pushUi(project, body)); }
      if (p.startsWith('/api/op/')) {
        const name = p.slice('/api/op/'.length);
        if (!Object.hasOwn(S.ops, name)) return json(res, 404, { error: 'no such op: ' + name });
        return json(res, 200, S.ops[name](project, body));
      }
      if (p === '/api/projects/new') return json(res, 200, S.createProject(body.id, body.title));
      if (p === '/api/projects/duplicate') return json(res, 200, S.duplicateProject(body.from || project, body.to, !!body.reset_state));
      if (p === '/api/projects/delete') return json(res, 200, S.deleteProject(body.id));
      if (p === '/api/snapshot') return json(res, 200, S.snapshot(project, body.message));
      if (p === '/api/restore') {
        const r = S.restore(project, body.snapshot);
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
    if ((p === '/' || p === '/index.html' || p === '/dock.html') && !url.searchParams.get('project')) {
      res.writeHead(302, { location: `${p === '/dock.html' ? '/dock.html' : '/'}?project=${encodeURIComponent(DEFAULT)}` }); return res.end();
    }
    if (p.startsWith('/media/')) {
      const rel = p.slice(7);
      if (!S.isMediaRootPath(rel)) { res.writeHead(403); return res.end('not a media root'); }
      const f = S.inside(CFG.mediaBase, rel); if (!f) { res.writeHead(403); return res.end(); }
      if (S.isPrivate(rel) && !isLocal(req)) { res.writeHead(403); return res.end('private: local only'); }
      return sendFile(req, res, f);
    }
    let f;
    const m = /^\/data\/([^/]+)\/(.+)$/.exec(p);
    if (m) {
      if (!S.validId(m[1]) || m[2].split('/').includes('.snapshots')) { res.writeHead(403); return res.end(); }
      f = S.inside(path.join(DATA_ROOT, m[1]), m[2]);
      // a writable state file that does not exist yet reads as null (the page uses its default; first save creates it)
      if (f && S.WRITABLE.has(m[2]) && !fs.existsSync(f)) return json(res, 200, null);
    } else {
      f = S.inside(WB, p === '/' ? 'index.html' : p.slice(1));
      const top = f && path.relative(WB, f).split(path.sep)[0];
      if (!f || ['tools', 'node_modules', 'mcp', 'lib', 'importers', '.git', '.claude', 'shots', 'data'].includes(top) || /\.(env|config\.json)$/.test(f)) { res.writeHead(403); return res.end(); }
    }
    if (S.isPrivate(p) && !isLocal(req)) { res.writeHead(403); return res.end('private: local only'); }
    if (!f) { res.writeHead(403); return res.end(); }
    sendFile(req, res, f);
  } catch (e) { const code = e.code >= 400 && e.code < 600 ? e.code : e instanceof SyntaxError ? 400 : 500; json(res, code, { error: String(e.message || e) }); }
}).listen(PORT, () => console.log(`workbench: http://localhost:${PORT}/  (default project ${DEFAULT}, data ${DATA_ROOT}${CFG.file ? ', config ' + path.basename(CFG.file) : ''})`));
