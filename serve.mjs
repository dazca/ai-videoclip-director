// Director workbench server: static files + read-only media + writable state files + projects/snapshots + agent ops
// + a change feed and a live UI channel. The data layer is lib/store.mjs (shared with the MCP server, mcp/server.mjs).
//   node serve.mjs [port] [--lan]  (default 8140) then open http://localhost:8140/  (?project=<id>)
// Listens on 127.0.0.1 only. --lan (or WB_HOST / config "host", e.g. 0.0.0.0) opts in to the network: other hosts may
// then read the page and the non-private files; every POST from them still needs allow_remote_ops.
// Every request must carry a Host header naming this server (localhost / 127.0.0.1 / [::1]:<port>, plus this
// machine's names and addresses with --lan), so a DNS-rebinding page cannot reach it. Every POST /api/* must be
// content-type application/json, have no foreign Origin, and carry the header x-wb-token: the per-run token the
// server writes into index.html / dock.html (<meta name="wb-token">, also window.__WB_TOKEN__; env WB_TOKEN fixes it).
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
import os from 'node:os';
import crypto from 'node:crypto';
import * as S from './lib/store.mjs';

const { CFG, DATA_ROOT, WB_DIR: WB } = S;
const ARGS = process.argv.slice(2);
const PORT = Number(ARGS.find(a => /^\d+$/.test(a)) || process.env.PORT || 8140);
const HOST = ARGS.includes('--lan') ? '0.0.0.0' : CFG.host || '127.0.0.1';
const DEFAULT = CFG.defaultProject;
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const TOKEN = process.env.WB_TOKEN || crypto.randomBytes(24).toString('hex');
// host names a request may address this server by (DNS rebinding: an attacker's name resolving to us is refused)
const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  HOSTS.add(os.hostname().toLowerCase()); HOSTS.add(os.hostname().toLowerCase() + '.local');
  if (HOST !== '0.0.0.0' && HOST !== '::') HOSTS.add(HOST.includes(':') ? `[${HOST}]` : HOST);
  for (const a of Object.values(os.networkInterfaces()).flat()) if (a) HOSTS.add(a.family === 'IPv6' || a.family === 6 ? `[${a.address.split('%')[0]}]` : a.address);
}
const hostOk = (h) => { const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(h || '').toLowerCase()); return !!m && HOSTS.has(m[1]) && Number(m[2] || 80) === PORT; };
const originOk = (o) => { try { const u = new URL(o); return u.protocol === 'http:' && hostOk(u.host); } catch (e) { return false; } };
const tokenOk = (t) => typeof t === 'string' && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
// the page gets the token in its HTML (another site cannot read it); a small fetch wrapper adds it to every /api POST
const TOKEN_TAG = `<meta name="wb-token" content="${TOKEN}"><script>window.__WB_TOKEN__=${JSON.stringify(TOKEN)};(()=>{const f=window.fetch.bind(window);`
  + `window.fetch=(u,o)=>{if(typeof u==='string'&&u.startsWith('/api/')&&o&&o.method&&o.method.toUpperCase()!=='GET'){const h=new Headers(o.headers||{});h.set('x-wb-token',window.__WB_TOKEN__);o={...o,headers:h};}return f(u,o);};})();</script>`;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.md': 'text/plain; charset=utf-8' };
fs.mkdirSync(DATA_ROOT, { recursive: true });

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    if (path.dirname(file) === WB && ['index.html', 'dock.html'].includes(path.basename(file).toLowerCase())) {   // the page shell: inject the token
      const html = fs.readFileSync(file, 'utf8').replace('</head>', TOKEN_TAG + '</head>');
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }); return res.end(req.method === 'HEAD' ? undefined : html);
    }
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
  return new Promise((ok, bad) => {
    const chunks = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > 5e6) { req.destroy(); bad(new S.WbError(413, 'body too big (5 MB max)')); } else chunks.push(d); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8'))); req.on('error', bad);
  });
}
const json = (res, code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };

http.createServer(async (req, res) => {
  try {
    if (!hostOk(req.headers.host)) return json(res, 403, { error: `unknown Host header (open http://localhost:${PORT}/)` });
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const project = url.searchParams.get('project') || DEFAULT;
    if (/[\\\0]/.test(p) || p.split('/').some(s => s === '..' || s === '.')) return json(res, 400, { error: 'bad path' });
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n'); const c = { res, project: url.searchParams.get('project') || null }; clients.add(c); req.on('close', () => clients.delete(c)); return;
    }
    if (p === '/api/config') return json(res, 200, { default_project: DEFAULT, media_roots: CFG.mediaRoots, private_re: CFG.privateSrc });
    if (p === '/api/status') return json(res, 200, { ok: true, app: 'director-workbench', default_project: DEFAULT, pages: clients.size, pages_by_project: [...clients].reduce((o, c) => (o[c.project || '*'] = (o[c.project || '*'] || 0) + 1, o), {}), data_dir: DATA_ROOT });
    if (p === '/api/projects' && req.method === 'GET') return json(res, 200, S.listProjects());
    if (p === '/api/snapshots' && req.method === 'GET') return json(res, 200, S.listSnapshots(project));
    if (p.startsWith('/api/') && req.method === 'POST') {
      // CSRF: JSON only (a cross-site form or no-preflight fetch cannot send it), no foreign Origin, the per-run token
      if (req.headers.origin && !originOk(req.headers.origin)) return json(res, 403, { error: 'foreign Origin' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'content-type must be application/json' });
      if (!tokenOk(req.headers['x-wb-token'])) return json(res, 403, { error: 'missing or wrong x-wb-token (reload the page; tools read it from <meta name="wb-token"> in /index.html)' });
      if (!isLocal(req) && !CFG.allowRemoteOps && p !== '/api/ui/ack') return json(res, 403, { error: 'writes are local only (set allow_remote_ops in workbench.config.json)' });
      const raw = await readBody(req); const body = raw ? JSON.parse(raw) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'body must be a JSON object' });
      if (p.startsWith('/api/save/')) {
        const name = p.slice('/api/save/'.length);
        if (!S.WRITABLE.has(name)) { res.writeHead(403); return res.end('not writable'); }
        const file = path.join(S.projDir(project), name);
        const cur = S.readJSON(file, { rev: 0 }, true) || { rev: 0 };
        if ((cur.rev || 0) !== body.base_rev) return json(res, 409, cur);
        const data = { ...body.data, rev: (cur.rev || 0) + 1 };
        S.writeJSON(file, data);
        return json(res, 200, { rev: data.rev });
      }
      if (p === '/api/ui/ack') { const a = acks.get(body.id); if (a) { a.n++; if (a.n >= a.pages) a.done(); } return json(res, 200, { ok: true }); }
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
      if (!S.validId(m[1]) || m[2].toLowerCase().split('/').includes('.snapshots')) { res.writeHead(403); return res.end(); }
      const pd = path.join(DATA_ROOT, m[1]);
      f = S.inside(pd, m[2]); if (!f) { res.writeHead(403); return res.end(); }
      const rel = S.relTo(pd, f);
      if (priv(rel, [m[1]]) || priv(`data/${m[1]}/${rel}`, [])) { res.writeHead(403); return res.end('private: local only'); }
      // a writable state file that does not exist yet reads as null (the page uses its default; first save creates it)
      if (S.WRITABLE.has(m[2]) && !fs.existsSync(f)) return json(res, 200, null);
    } else {
      f = S.inside(WB, p === '/' ? 'index.html' : p.slice(1)); if (!f) { res.writeHead(403); return res.end(); }
      const rel = S.relTo(WB, f).toLowerCase(), top = rel.split('/')[0];
      if (top.startsWith('.') || ['tools', 'node_modules', 'mcp', 'lib', 'importers', 'shots', 'data'].includes(top) || /\.env$|config\.json$/.test(rel)) { res.writeHead(403); return res.end(); }
      if (priv(rel, [])) { res.writeHead(403); return res.end('private: local only'); }
    }
    sendFile(req, res, f);
  } catch (e) { const code = e.code >= 400 && e.code < 600 ? e.code : e instanceof SyntaxError || e instanceof URIError ? 400 : 500; json(res, code, { error: String(e.message || e) }); }
}).listen(PORT, HOST, () => console.log(`workbench: http://localhost:${PORT}/  (listening on ${HOST}; default project ${DEFAULT}, data ${DATA_ROOT}${CFG.file ? ', config ' + path.basename(CFG.file) : ''})`));
