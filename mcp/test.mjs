// End-to-end test of the MCP server on a SCRATCH COPY of the demo project (never on data/demo itself, never on anyone's
// real project):
//   node mcp/test.mjs          (npm run test:mcp; TEST_PORT picks the port, default 8146)
// Copies data/demo to a temp folder, starts serve.mjs on it, opens the page in headless Chromium (when puppeteer-core +
// a Chromium are available; otherwise an SSE client stands in for the page), spawns mcp/server.mjs over stdio with the
// official SDK client and exercises: tools/list, song_get, timeline_query, note_add + note_resolve, request_create +
// request_update (the approval and cap rules, done -> cost + media), snapshot_save + snapshot_restore, ui_focus, the guided
// flow (stages_get / stage_update, lyrics_* on a derived and on a new lyrics-only project, song_attach),
// resources, the director-session prompt, the guard rules (edit voids approval, director-only approvals, media kind,
// CSRF / Host / token checks, path traversal and the PRIVATE rule) and the offline (files only) mode. The temp folder
// is removed at the end, whatever happens; data/demo must be byte-identical afterwards.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT = 'demo', PORT = Number(process.env.TEST_PORT || 8146), URL_ = `http://localhost:${PORT}`;
const ORIG = path.join(WB, 'data', PROJECT);
if (!fs.existsSync(path.join(ORIG, 'song.json'))) { console.error('no data/demo: run node tools/make_demo.mjs first'); process.exit(1); }

// ---------------------------------------------------------------- scratch data folder, media base and config
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mcptest-'));
const DATA = path.join(TMP, 'data'), D = path.join(DATA, PROJECT), MB = path.join(TMP, 'mediabase');
fs.cpSync(ORIG, D, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
for (const [f, t] of [['roots/a.txt', 'public'], ['refs/face.jpg', 'private ref'], ['secret/s.txt', 'outside any root']]) { fs.mkdirSync(path.dirname(path.join(MB, f)), { recursive: true }); fs.writeFileSync(path.join(MB, f), t); }
// agent_approvals: this suite drives the honor-system flow (director_approved:true from the agent); the default
// (page-only approvals) is covered by tools/security-test.mjs
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: ['roots/', 'refs/'], private_media: '^refs/', agent_approvals: true }));
Object.assign(process.env, { WORKBENCH_DATA: DATA, WORKBENCH_MEDIA_BASE: MB, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: PROJECT });
delete process.env.WB_TOKEN; delete process.env.WB_HOST; delete process.env.WB_AGENT_APPROVALS;
const S = await import('../lib/store.mjs');   // after the env: the same data folder and config as the server

const walk = (dir, rel = '') => { const out = []; for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) out.push(...walk(dir, r)); else out.push(r); } return out; };
const hashAll = (dir) => Object.fromEntries(walk(dir).map(f => [f, crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, f))).digest('hex')]));
const origBefore = hashAll(ORIG);

const results = []; let failed = 0;
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let srv = null, browser = null, page = null, mcp = null; const sse = { files: [], ui: [] };
try {
// ---------------------------------------------------------------- the workbench server
srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(PORT)], { stdio: 'pipe', env: process.env });
srv.stderr.on('data', d => process.stderr.write('server: ' + d));
await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
// the per-run write token, read the way the page and the MCP server get it: from the served page
const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${URL_}/?project=${PROJECT}`)).text())?.[1];
check('the page carries the per-run write token', /^[0-9a-f]{48}$/.test(TOKEN || ''), TOKEN?.length);
const post = (p, body, headers = {}) => fetch(URL_ + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

// ---------------------------------------------------------------- "the open page": a real browser if we can, else an SSE client
try {
  const require = createRequire(path.join(WB, 'package.json'));
  const puppeteer = require('puppeteer-core');
  const { findChrome } = await import('../tools/chrome.mjs');
  const exe = findChrome(); if (!exe) throw new Error('no Chromium found (set CHROME_PATH)');
  browser = await puppeteer.launch({ executablePath: exe, headless: true });
  page = await browser.newPage(); await page.setViewport({ width: 1400, height: 800 });
  page.on('pageerror', e => console.error('pageerror', e.message));
  await page.goto(`${URL_}/?project=${PROJECT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
  await wait(400);
  console.log('page: headless Chromium on', `${URL_}/?project=${PROJECT}`);
} catch (e) {
  console.log('page: no browser (' + e.message + '); using an SSE client as the page');
  browser = null;
  const ctl = new AbortController(); sse.stop = () => ctl.abort();
  (async () => {
    const r = await fetch(`${URL_}/api/events?project=${PROJECT}`, { signal: ctl.signal }); const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body) { buf += dec.decode(chunk); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const m = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.*)$/m.exec(m); if (!d) continue; const j = JSON.parse(d[1]);
      if (j.ui) { sse.ui.push(j.ui); post(`/api/ui/ack?project=${PROJECT}`, { id: j.ui.id }); } else sse.files.push(j.file); } }
  })().catch(() => {});
  await wait(300);
}
const pageHas = async (fn, arg, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (browser ? await page.evaluate(fn, arg) : fn(arg, sse)) return true; await wait(100); }
  return false;
};

// ---------------------------------------------------------------- the MCP client
async function connect(env) {
  const client = new Client({ name: 'workbench-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...process.env, WORKBENCH_PROJECT: PROJECT, ...env }, stderr: 'inherit' }));
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || '';
  if (r.isError) return { error: text };
  try { return JSON.parse(text); } catch (e) { return text; }
};

mcp = await connect({ WORKBENCH_URL: URL_ });
{
  // 1. tools
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const EXPECT = ['status', 'projects', 'snapshot_save', 'snapshot_list', 'snapshot_restore', 'song_get', 'timeline_query', 'shots_list', 'shot_get', 'shot_update', 'entities_list', 'entity_get', 'entity_upsert',
    'media_list', 'media_add', 'notes_list', 'note_add', 'note_resolve', 'approvals_get', 'approve', 'request_changes', 'requests_list', 'request_create', 'request_update', 'costs_get', 'ui_focus',
    'stages_get', 'stage_update', 'lyrics_get', 'lyrics_update', 'lyrics_versions', 'lyrics_note_add', 'lyrics_note_resolve', 'song_attach'];
  check('tools/list has every tool', EXPECT.every(t => tools.includes(t)), { count: tools.length, missing: EXPECT.filter(t => !tools.includes(t)) });
  const schemaOk = (await mcp.listTools()).tools.every(t => t.description?.length > 40 && t.inputSchema?.type === 'object');
  check('every tool has a description and a JSON schema', schemaOk);

  const st = await call(mcp, 'status');
  check('status: server up, current project demo', st.server?.up === true && st.current_project === PROJECT && st.mode === 'http', { server: st.server, current: st.current_project, mode: st.mode });

  // 2. song_get, timeline_query
  const song = await call(mcp, 'song_get');
  check('song_get', song.duration_ms === 20000 && song.sections?.length === 4 && song.lines?.length === 9 && song.lines[1].words?.length > 3 && song.grid?.beats > 30, { title: song.title, sections: song.sections?.map(s => s.id), lines: song.lines?.length });
  const chorus = await call(mcp, 'song_get', { section: 'chorus', words: false });
  check('song_get section filter', chorus.sections?.length === 1 && chorus.lines?.every(l => l.section === 'chorus' && !l.words) && chorus.events?.some(e => e.kind === 'drop'), { lines: chorus.lines?.length, events: chorus.events?.length });
  const tq = await call(mcp, 'timeline_query', { t0: '0:12', t1: 15000 });
  check('timeline_query across columns', tq.t0 === 12000 && tq.sections?.[0]?.id === 'chorus' && tq.shots?.some(s => s.id === 's4-chorus' && s.state === 'review') && tq.uses?.some(u => u.id === 'C3@12000')
    && tq.lines?.length >= 2 && tq.notes?.some(n => n.id === 'n02') && tq.events?.some(e => e.kind === 'drop') && tq.requests?.some(r => r.id === 'rdemo01') && Array.isArray(tq.bars) && tq.cast?.includes('ada'),
    { sections: tq.sections?.length, shots: tq.shots?.map(s => s.id), uses: tq.uses?.map(u => u.id), lines: tq.lines?.length, notes: tq.notes?.length, bars: tq.bars?.length, requests: tq.requests?.length });

  // 3. snapshot first (the round trip below restores to it)
  const snap = await call(mcp, 'snapshot_save', { message: 'mcp test: start' });
  check('snapshot_save', !!snap.id && fs.existsSync(path.join(D, '.snapshots', snap.id, 'notes.json')), snap);
  const revs = Object.fromEntries(['notes.json', 'requests.json', 'approvals.json'].map(f => [f, JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')).rev]));

  // 4. note_add -> live in the page; note_resolve with a reply
  const note = await call(mcp, 'note_add', { t: 8000, text: 'mcp test: Bo enters on the downbeat now', about: 'shot:s3-grid' });
  check('note_add', note.id && note.line_id === 'verse/2' && note.by === 'agent', note);
  const live = await pageHas((id, s) => s ? s.files.includes('notes.json') : window.WB.store.notes.notes.some(n => n.id === id) && [...document.querySelectorAll('.col-notes .note')].some(e => e.textContent.includes('Bo enters on the downbeat')), note.id);
  check('the open page receives the note live (SSE -> reload -> notes column)', live, { browser: !!browser });
  const res = await call(mcp, 'note_resolve', { id: 'n01', reply: 'mcp test: done, the wall cuts in on 0:04.000' });
  const notes = await call(mcp, 'notes_list');
  check('note_resolve with a reply', res.note?.status === 'resolved' && res.reply && notes.find(n => n.id === res.reply)?.reply_to === 'n01', { resolved: res.note?.status, reply: res.reply });

  // 5. requests: draft -> (refused queue) -> (refused approve) -> approved by the director -> queued -> running -> done
  const rq = await call(mcp, 'request_create', { kind: 'new-variant', target: 'use:C3@12000', prompt: 'mcp test: C3 in warm colours', refs: ['media/clip/C3_0.mp4'], est_cost: 0.2, tool: 'ffmpeg (synthetic)' });
  check('request_create makes a draft', rq.id && rq.status === 'draft' && rq.est_cost === 0.2, { id: rq.id, status: rq.status });
  const q0 = await call(mcp, 'request_update', { id: rq.id, status: 'queued' });
  const a0 = await call(mcp, 'request_update', { id: rq.id, status: 'approved' });
  check('rules: a draft cannot be queued, an agent cannot approve alone', /409/.test(q0.error || '') && /403/.test(a0.error || ''), { queue: q0.error, approve: a0.error });
  const a1 = await call(mcp, 'request_update', { id: rq.id, status: 'approved', director_approved: true, by: 'director' });
  const q1 = await call(mcp, 'request_update', { id: rq.id, status: 'queued' });
  const r1 = await call(mcp, 'request_update', { id: rq.id, status: 'running' });
  const d0 = await call(mcp, 'request_update', { id: rq.id, status: 'done' });
  // "generate": a warm-tinted copy of C3 (ffmpeg if present, else a plain copy), outside the project so media_add copies it in
  const out = path.join(os.tmpdir(), `wb-mcptest-${Date.now()}.mp4`);
  const ffr = spawn('ffmpeg', ['-v', 'error', '-y', '-i', path.join(D, 'media/clip/C3_0.mp4'), '-vf', 'hue=h=30:s=2', '-c:v', 'libx264', '-crf', '32', '-pix_fmt', 'yuv420p', out], { stdio: 'ignore' });
  await new Promise(r => { ffr.on('exit', r); ffr.on('error', r); }); if (!fs.existsSync(out)) fs.copyFileSync(path.join(D, 'media/clip/C3_0.mp4'), out);
  const costBefore = await call(mcp, 'costs_get');
  const d1 = await call(mcp, 'request_update', { id: rq.id, status: 'done', outputs: [out], actual_cost_usd: 0.15, media_kind: 'clip' });
  const costAfter = await call(mcp, 'costs_get');
  const media = await call(mcp, 'media_list', { q: rq.id });
  check('request lifecycle approved -> queued -> running -> done (outputs + actual cost)', a1.request?.status === 'approved' && q1.request?.status === 'queued' && r1.request?.status === 'running' && /outputs/.test(d0.error || '')
    && d1.request?.status === 'done' && d1.request.outputs?.[0]?.startsWith('media/clip/') && d1.request.log?.length === 5 && Math.abs(costAfter.spent_usd - costBefore.spent_usd - 0.15) < 1e-9 && media.total === 1 && !!media.items[0].thumb,
    { statuses: [a1.request?.status, q1.request?.status, r1.request?.status, d1.request?.status], doneWithoutOutputs: d0.error, output: d1.request?.outputs, spent: [costBefore.spent_usd, costAfter.spent_usd], media: media.items?.[0]?.path, thumb: media.items?.[0]?.thumb });
  const big = await call(mcp, 'request_create', { kind: 'generate', prompt: 'mcp test: over the cap', est_cost: 50 });
  await call(mcp, 'request_update', { id: big.id, status: 'approved', director_approved: true });
  const over = await call(mcp, 'request_update', { id: big.id, status: 'queued' });
  check('the cost cap blocks queueing', /402/.test(over.error || ''), over.error);
  const queueLive = await pageHas((id, s) => s ? s.files.includes('requests.json') : (window.WB.store.requests.items || []).some(r => r.id === id && r.status === 'done'), rq.id);
  check('the open page sees the queue change live', queueLive);

  // 6. shot_update / approvals
  const su = await call(mcp, 'shot_update', { id: 'C1@15000', take: 0, in_ms: 250, status: 'review', comment: 'mcp test' });
  const ag = await call(mcp, 'approvals_get', { keys: ['use:C1@15000'] });
  check('shot_update (take, in-point, status)', su.use?.take === 0 && su.use?.in_ms === 250 && su.use?.file === 'media/clip/C1_0.mp4' && ag.items['use:C1@15000']?.state === 'review', { changed: su.changed, file: su.use?.file });

  // 7. ui_focus -> the page jumps
  const ui = await call(mcp, 'ui_focus', { t: '0:15.500', preview: 'use:C3@12000', message: 'mcp test: look here' });
  const jumped = await pageHas((t, s) => s ? s.ui.some(u => u.t === t) : Math.abs(window.WB.timeline.player.time() - t) < 50 && window.WB.dock.current()?.id === 'C3@12000', 15500);
  check('ui_focus reaches the open page (delivered + playhead moved + dock shows the clip)', ui.delivered >= 1 && jumped, { ui, jumped });

  // 8. snapshot round trip: restore -> the notes and the requests that never ran are gone, the page reloads; the request
  // that ran (done) and its recorded cost survive (spend is never rolled back)
  const rs = await call(mcp, 'snapshot_restore', { snapshot: snap.id });
  const notesAfter = await call(mcp, 'notes_list');
  const reqAfter = await call(mcp, 'requests_list');
  // content back exactly; the shared {rev} files get a rev above the pre-restore one (a stale page gets 409, never overwrites)
  const noRev = (b) => { const j = JSON.parse(b); delete j.rev; return JSON.stringify(j); };
  const costsNow = JSON.parse(fs.readFileSync(path.join(D, 'costs.json'), 'utf8')), costsSnap = JSON.parse(fs.readFileSync(path.join(D, '.snapshots', snap.id, 'costs.json'), 'utf8'));
  const filesBack = ['shots.json', 'media.json'].every(f => fs.readFileSync(path.join(D, f)).equals(fs.readFileSync(path.join(D, '.snapshots', snap.id, f))))
    && ['notes.json', 'approvals.json'].every(f => noRev(fs.readFileSync(path.join(D, f), 'utf8')) === noRev(fs.readFileSync(path.join(D, '.snapshots', snap.id, f), 'utf8'))
      && JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')).rev > revs[f])
    && JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')).rev > revs['requests.json']
    && costsNow.items.length === costsSnap.items.length + 1 && costsNow.items.some(x => x.request === rq.id);
  const pageBack = await pageHas((id, s) => s ? true : !window.WB.store.notes.notes.some(n => n.id === id), note.id);
  const snaps = await call(mcp, 'snapshot_list');
  check('snapshot_restore round trip (content back, rev moves forward, ran request + its cost kept, previous state kept, page reloaded)', rs.restored === snap.id && !notesAfter.some(n => n.id === note.id)
    && reqAfter.find(r => r.id === rq.id)?.status === 'done' && !reqAfter.some(r => r.id === big.id) && filesBack && pageBack && snaps.some(s => s.id === rs.previous && s.auto),
    { restored: rs.restored, previous: rs.previous, changed: rs.changed, filesBack, pageBack });

  // 9. resources + prompt
  const resources = (await mcp.listResources()).resources.map(r => r.uri);
  const ff = await mcp.readResource({ uri: 'workbench://docs/file-formats' });
  const pf = await mcp.readResource({ uri: `workbench://project/${PROJECT}/song.json` });
  const prompt = await mcp.getPrompt({ name: 'director-session', arguments: { goal: 'fix the chorus colours' } });
  check('resources + director-session prompt', resources.includes('workbench://docs/claude') && resources.includes('workbench://docs/readme') && /requests\.json/.test(ff.contents[0].text) && JSON.parse(pf.contents[0].text).duration_ms === 20000
    && /APPROVED/.test(prompt.messages[0].content.text) && /fix the chorus colours/.test(prompt.messages[0].content.text), { resources: resources.length });
  fs.rmSync(out, { force: true });

  // 10. guard rules (agent side)
  const g1 = await call(mcp, 'request_create', { kind: 'generate', prompt: 'guard: cheap', est_cost: 0.1 });
  await call(mcp, 'request_update', { id: g1.id, status: 'approved', director_approved: true, by: 'director' });
  const keepApproved = await call(mcp, 'request_update', { id: g1.id, status: 'approved', prompt: 'guard: EXPENSIVE', est_cost: 9 });
  const editQueue = await call(mcp, 'request_update', { id: g1.id, status: 'queued', prompt: 'guard: different', est_cost: 5 });
  const editOnly = await call(mcp, 'request_update', { id: g1.id, prompt: 'guard: edited' });
  check('an edit voids the approval (edit + status in one call refused; edit alone -> draft)', /409/.test(keepApproved.error || '') && /409/.test(editQueue.error || '') && editOnly.request?.status === 'draft' && editOnly.request?.est_cost === 0.1,
    { keepApproved: keepApproved.error, editQueue: editQueue.error, after: editOnly.request?.status });
  const sneaky = await post(`/api/op/request_create?project=${PROJECT}`, { kind: 'generate', est_cost: 0, extra: { status: 'approved', id: 'x', note: 'kept' } });
  check('request_create: extra cannot set status / id', sneaky.status === 200 && sneaky.body.status === 'draft' && sneaky.body.id !== 'x' && sneaky.body.note === 'kept', sneaky.body);
  const ap0 = await call(mcp, 'approve', { keys: ['shot:s2-wall'] });
  const lock0 = await call(mcp, 'shot_update', { id: 's2-wall', status: 'locked' });
  const ap1 = await call(mcp, 'approve', { keys: ['shot:s2-wall'], director_approved: true });
  const apState = (await call(mcp, 'approvals_get', { keys: ['shot:s2-wall'] })).items['shot:s2-wall'];
  const bogus = await post(`/api/op/set_states?project=${PROJECT}`, { keys: ['shot:s2-wall'], state: 'bogus' });
  check('approve / lock need director_approved; unknown states refused', /403/.test(ap0.error || '') && /403/.test(lock0.error || '') && ap1.state === 'approved' && apState?.by === 'agent' && apState?.via === 'agent' && bogus.status === 400,
    { ap0: ap0.error, lock0: lock0.error, by: apState?.by, via: apState?.via, bogus: bogus.status });
  const src = path.join(TMP, 'kind-src.txt'); fs.writeFileSync(src, 'x');
  const kindBad = await post(`/api/op/media_add?project=${PROJECT}`, { path: src, kind: '../../../escaped' });
  const kindMcp = await call(mcp, 'media_add', { path: src, kind: '../x' });
  const privAdd = await call(mcp, 'media_add', { path: src, kind: 'ref', private: true });
  check('media_add: kind cannot leave the project; a private copy lands under private/', kindBad.status === 400 && !!kindMcp.error && !fs.existsSync(path.join(TMP, 'escaped')) && privAdd.media?.path === 'private/ref/kind-src.txt' && S.isPrivate(privAdd.media.path),
    { http: kindBad.status, mcp: kindMcp.error?.slice(0, 80), priv: privAdd.media?.path });

  // 11. guard rules (HTTP side): CSRF, DNS rebinding, token, traversal, the deny-list
  const plain = await post(`/api/op/costs_get?project=${PROJECT}`, '{}', { 'content-type': 'text/plain' });
  const foreign = await post(`/api/op/costs_get?project=${PROJECT}`, {}, { origin: 'http://evil.example' });
  const own = await post(`/api/op/costs_get?project=${PROJECT}`, {}, { origin: URL_ });
  const noTok = await post(`/api/save/notes.json?project=${PROJECT}`, { base_rev: 0, data: {} }, { 'x-wb-token': '' });
  const badTok = await post(`/api/projects/delete?project=${PROJECT}`, { id: 'x' }, { 'x-wb-token': 'f'.repeat(48) });
  const rebound = await new Promise((ok) => http.get({ host: '127.0.0.1', port: PORT, path: `/data/${PROJECT}/song.json`, headers: { host: `evil.example:${PORT}` } }, r => { r.resume(); ok(r.statusCode); }).on('error', () => ok(0)));
  check('writes need JSON + own Origin + the token; foreign Host refused', plain.status === 415 && foreign.status === 403 && own.status === 200 && noTok.status === 403 && badTok.status === 403 && rebound === 403,
    { plain: plain.status, foreign: foreign.status, own: own.status, noTok: noTok.status, badTok: badTok.status, rebound });
  const st_ = async (u) => (await fetch(URL_ + u)).status;
  const paths = { mediaOk: await st_('/media/roots/a.txt'), mediaEsc: await st_('/media/roots%2F..%2Fsecret%2Fs.txt'), mediaEsc2: await st_('/media/roots%2F..%2Frefs%2Fface.jpg'),
    bslash: await st_(`/data/${PROJECT}/thumbs%5Cm_I1.jpg`), dataEsc: await st_(`/data/${PROJECT}/..%2F..%2Fconfig.json`), tools: await st_('/TOOLS/verify.mjs'), lib: await st_('/Lib/store.mjs'),
    git: await st_('/.GIT/config'), cfg: await st_('/WORKBENCH.CONFIG.JSON'), snaps: await st_(`/data/${PROJECT}/.SNAPSHOTS/x`), page: await st_('/app.js') };
  check('path traversal, %5C, case tricks and the deny-list', paths.mediaOk === 200 && paths.mediaEsc === 400 && paths.mediaEsc2 === 400 && paths.bslash === 400 && paths.dataEsc === 400
    && paths.tools === 403 && paths.lib === 403 && paths.git === 403 && paths.cfg === 403 && paths.snaps === 403 && paths.page === 200, paths);
  check('PRIVATE rule ignores case and separators; media roots are checked after normalising', S.isPrivate('Thumbs/Priv_x.jpg') && S.isPrivate('a\\private\\b.png') && S.isPrivate('REFS/face.jpg')
    && !S.mediaRootFile('roots/../secret/s.txt') && !S.mediaRootFile('roots/../refs/face.jpg') && !!S.mediaRootFile('roots/a.txt') && S.isFlaggedPrivate('private/ref/kind-src.txt', [PROJECT]));
  const lanIp = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
  const lan = lanIp ? await new Promise((ok) => http.get({ host: lanIp, port: PORT, path: '/', timeout: 1500 }, r => { r.resume(); ok(r.statusCode); }).on('error', (e) => ok(e.code)).on('timeout', function () { this.destroy(); ok('timeout'); })) : 'no LAN address';
  check('the server listens on 127.0.0.1 only (not reachable on the LAN address)', typeof lan === 'string', { lanIp, lan });
}

// 11b. the guided flow: stages + stage 1 (lyrics) tools, on the demo (derived) and on a new lyrics-only project
{
  const st = await call(mcp, 'stages_get');
  check('stages_get on a project without stages.json: derived (content = done), next stage named', st.derived === true && st.stages?.length === 7 && st.stages[0].status === 'done' && st.stages[0].done_by === 'derived' && st.next?.id === 'final' && st.facts?.lines === 9,
    { derived: st.derived, statuses: st.stages?.map(s => s.status), next: st.next });
  const lg = await call(mcp, 'lyrics_get');
  check('lyrics_get on a project without lyrics.json: v1 derived from song.json, song line ids, timings', lg.derived === true && lg.current === 'v1' && lg.sections?.length === 4 && lg.sections[1].lines[0].id === 'verse/0' && lg.sections[1].lines[0].t0 === S.read(PROJECT, 'song.json').lines.find(l => l.id === 'verse/0').t0 && !fs.existsSync(path.join(D, 'lyrics.json')),
    { derived: lg.derived, sections: lg.sections?.map(s => s.id), first: lg.sections?.[1]?.lines?.[0] });
  const songBefore = fs.readFileSync(path.join(D, 'song.json'), 'utf8');
  const ln = await call(mcp, 'lyrics_note_add', { line: 'verse/1', quote: 'the note', text: 'mcp test: "the tone"?' });
  const pageSees = await pageHas((id, s) => s ? s.files.includes('lyrics.json') : window.WB.store.lyrics?.notes?.some(n => n.id === id), ln.id);
  check('lyrics_note_add on a word range (quote -> [first, last]); writes lyrics.json, not song.json; the page sees it live', ln.id === 'ln01' && JSON.stringify(ln.w) === '[2,3]' && ln.via === 'agent' && fs.readFileSync(path.join(D, 'song.json'), 'utf8') === songBefore && pageSees,
    { id: ln.id, w: ln.w, via: ln.via, pageSees });
  // a lyrics-only project through the projects tool, then edits, diff, restore, stage rules, the song attached later
  const NP = 'mcp-lyrics';
  const cr = await call(mcp, 'projects', { action: 'create', id: NP, title: 'MCP Lyrics', lyrics: '[Verse 1]\nfirst line here\nsecond line there\n\n[Chorus]\nla la la' });
  const g1 = await call(mcp, 'lyrics_get', { project: NP });
  const st1 = await call(mcp, 'stages_get', { project: NP });
  check('projects create with lyrics: v1, placeholder duration, estimated timings, lyrics stage in progress', cr.lines === 3 && g1.current === 'v1' && g1.song?.has_audio === false && g1.song?.placeholder_duration === true && g1.sections?.[0]?.lines?.[0]?.timing === 'estimated'
    && st1.stages?.[0]?.status === 'in_progress' && st1.next?.blockers?.some(b => /no song/.test(b)), { cr, song: g1.song, lyrics: st1.stages?.[0] });
  const u2 = await call(mcp, 'lyrics_update', { project: NP, text: g1.text.replace('second line there', 'second line, rewritten') + '\nla la lo', message: 'mcp test: rewrite' });
  const same = await call(mcp, 'lyrics_update', { project: NP, text: (await call(mcp, 'lyrics_get', { project: NP })).text });
  const g2 = await call(mcp, 'lyrics_get', { project: NP });
  const ids2 = g2.sections.flatMap(s => s.lines.map(l => l.id));
  check('lyrics_update makes a new version, keeps ids (reworded line too), the song follows; an unchanged text makes none', u2.version === 'v2' && u2.song?.changed === true && same.unchanged === true && JSON.stringify(ids2) === '["L1","L2","L3","L4"]' && S.read(NP, 'song.json').lines.length === 4,
    { u2, same, ids2 });
  const dv = await call(mcp, 'lyrics_versions', { project: NP, diff: ['v1', 'v2'] });
  const rs = await call(mcp, 'lyrics_update', { project: NP, restore: 'v1' });
  const vl = await call(mcp, 'lyrics_versions', { project: NP });
  check('lyrics_versions: word diff, list; restore = a new version copied from the old one', dv.added === 5 && dv.removed === 2 && /\[-there-\]/.test(dv.diff) && /\{\+rewritten\+\}/.test(dv.diff) && /\{\+lo\+\}/.test(dv.diff) && rs.version === 'v3' && vl.versions?.length === 3 && vl.versions[2].from === 'v1' && vl.current === 'v3',
    { diff: dv.diff, added: dv.added, removed: dv.removed, restore: rs.version, versions: vl.versions?.map(v => v.id) });
  const n1 = await call(mcp, 'lyrics_note_add', { project: NP, line: 'L1', words: [0, 1], text: 'mcp: stronger opening?' });
  const r1 = await call(mcp, 'lyrics_note_add', { project: NP, reply_to: n1.id, text: 'mcp: a reply in the thread' });
  const bad = await call(mcp, 'lyrics_note_add', { project: NP, line: 'L1', words: [3, 9], text: 'x' });
  const rv = await call(mcp, 'lyrics_note_resolve', { project: NP, id: n1.id, reply: 'mcp: done' });
  check('lyrics notes: word range, thread reply, bad range refused, resolve with a reply', n1.quote === 'first line' && r1.reply?.id === `${n1.id}.1` && /400/.test(bad.error || '') && rv.status === 'resolved' && rv.replies?.length === 2,
    { quote: n1.quote, reply: r1.reply?.id, bad: bad.error, resolved: rv.status });
  const sd = await call(mcp, 'stage_update', { project: NP, stage: 'lyrics', status: 'done' });
  const sn = await call(mcp, 'stage_update', { project: NP, stage: 'lyrics', status: 'needs_you', blockers: ['mcp: check the chorus'], note: 'please read v3' });
  check('stage_update: done refused (only the page), needs_you + blockers + note accepted', /403/.test(sd.error || '') && sn.stage?.status === 'needs_you' && sn.stage.blockers[0] === 'mcp: check the chorus' && sn.stage.via === 'agent' && sn.next?.id === 'lyrics',
    { done: sd.error, stage: sn.stage });
  const song = path.join(ORIG, 'audio', 'demo-song.mp3');
  const at = await call(mcp, 'song_attach', { project: NP, path: song });
  const s2 = S.read(NP, 'song.json');
  const badSong = await call(mcp, 'song_attach', { project: NP, path: path.join(TMP, 'kind-src.txt') });
  check('song_attach: the song added later (duration, peaks), lines re-timed inside it; a non-audio file refused', at.duration_ms === 20000 && at.replaced === false && s2.audio.mix === 'audio/demo-song.mp3' && fs.existsSync(path.join(DATA, NP, 'peaks', 'mix.json')) && s2.lines.every(l => l.t1 <= 20000) && !s2.placeholder_duration && /400/.test(badSong.error || ''),
    { at, lines: s2.lines.map(l => [l.id, l.t0, l.t1]), bad: badSong.error });
  const pr = await mcp.getPrompt({ name: 'director-session', arguments: { project: NP } });
  check('director-session briefs the stages and the lyrics', /Stages: lyrics needs_you/.test(pr.messages[0].content.text) && /lyrics_get/.test(pr.messages[0].content.text), pr.messages[0].content.text.split('\n')[1]);
}

// 12. offline: the server is unreachable -> the same tools work on the files; ui_focus explains
{
  const off = await connect({ WORKBENCH_URL: 'http://localhost:9' });
  const st = await call(off, 'status');
  const tq = await call(off, 'timeline_query', { t0: 4000, t1: 8000 });
  const ui = await call(off, 'ui_focus', { t: 1000 });
  const sg = await call(off, 'stages_get'), lu = await call(off, 'lyrics_update', { project: 'mcp-lyrics', text: '[Verse 1]\noffline line', message: 'offline' });
  check('offline mode: files directly (stages, lyrics too), ui_focus refuses politely', st.mode === 'files' && tq.shots?.[0]?.id === 's2-wall' && /not running/.test(ui.error || '') && sg.stages?.length === 7 && lu.version === 'v4',
    { mode: st.mode, shots: tq.shots?.map(s => s.id), ui: ui.error, stages: sg.stages?.length, lyrics: lu.version || lu.error });
  await off.close();
}

// 13. data layer: corrupt files are not overwritten, a template-less project works, cap 0 means nothing paid, entity ids hold
{
  const nf = path.join(D, 'notes.json'), good = fs.readFileSync(nf, 'utf8'), broken = good.slice(0, -5);
  fs.writeFileSync(nf, broken);
  let err = null; try { S.ops.note_add(PROJECT, { t: 1000, text: 'x' }); } catch (e) { err = e; }
  check('a corrupt JSON file is refused, not overwritten', err?.code === 500 && fs.readFileSync(nf, 'utf8') === broken, err?.message);
  fs.writeFileSync(nf, good);
  S.createProject('nt', 'no template');
  let ok = true, why = null; try { S.ops.entities_list('nt'); S.ops.song_get('nt'); } catch (e) { ok = false; why = e.message; }
  const r = S.ops.request_create('nt', { kind: 'generate', est_cost: 1 });
  S.ops.request_update('nt', { id: r.id, status: 'approved', director_approved: true });
  let capErr = null; try { S.ops.request_update('nt', { id: r.id, status: 'queued' }); } catch (e) { capErr = e.code; }
  check('createProject without a template; cap 0 refuses paid queueing', ok && Array.isArray(JSON.parse(fs.readFileSync(path.join(DATA, 'nt', 'events.json'), 'utf8'))) && capErr === 402, { why, capErr });
  const ent = S.ops.entity_upsert(PROJECT, { kind: 'prop', id: 'pp', fields: { id: 'other', kind: 'character' } }).entity;
  check('entity_upsert: fields cannot change id / kind', ent.id === 'pp' && ent.kind === 'prop', ent);
}
} catch (e) { check('test ran to the end', false, String(e.stack || e)); }
finally {
  // ---------------------------------------------------------------- clean up whatever happened
  await mcp?.close().catch(() => {});
  if (browser) await browser.close().catch(() => {}); sse.stop?.();
  srv?.kill(); await wait(300);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
const origAfter = hashAll(ORIG);
const same = Object.keys(origBefore).length === Object.keys(origAfter).length && Object.entries(origBefore).every(([f, h]) => origAfter[f] === h);
check('data/demo untouched (the test ran on a scratch copy)', same, same ? undefined : { changed: Object.keys(origBefore).filter(f => origAfter[f] !== origBefore[f]), extra: Object.keys(origAfter).filter(f => !origBefore[f]) });
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
