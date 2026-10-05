// End-to-end test of the MCP server on a SCRATCH COPY of the demo project (never on data/demo itself, never on anyone's
// real project):
//   node mcp/test.mjs          (npm run test:mcp; TEST_PORT picks the port, default 8146)
// Copies data/demo to a temp folder, starts serve.mjs on it, opens the page in headless Chromium (when puppeteer-core +
// a Chromium are available; otherwise an SSE client stands in for the page), spawns mcp/server.mjs over stdio with the
// official SDK client and exercises: tools/list, song_get, timeline_query, note_add + note_resolve, request_create +
// request_update (the approval and cap rules, done -> cost + media), snapshot_save + snapshot_restore, ui_focus, the guided
// flow (stages_get / stage_update, lyrics_* on a derived and on a new lyrics-only project, song_attach; stage 2: intake_*,
// script_get / scenes_update (derived from script.json, versions, snap, restore, diff, status rules), scene notes, sketches; stage 3: breakdown_* (versions, statuses, notes, the page-only promotion); stage 4: character_* and look_create; stage 5: asset_* and variant_create (the
// page-only base / choices / approvals, requests linked to a tree, nodes from approved runs only, locks, looks, notes, an
// agent restore); stage 6: storyboard_get / shots_update (derived from shots.json, versions, tiling on the beat grid, statuses,
// warnings, restore, diff), shot notes and asks, gaps_get (draft requests, the estimate vs the cap)),
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
import { tinyPngB64 } from '../tools/tiny-png.mjs';

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
    'stages_get', 'stage_update', 'lyrics_get', 'lyrics_update', 'lyrics_versions', 'lyrics_note_add', 'lyrics_note_resolve', 'song_attach',
    'script_get', 'scenes_update', 'scene_note_add', 'scene_note_resolve', 'intake_get', 'intake_answer', 'sketch_save', 'sketch_get', 'sketch_list',
    'breakdown_get', 'breakdown_update', 'breakdown_note_add', 'breakdown_note_resolve', 'character_get', 'character_iteration_add', 'character_note_add', 'look_create',
    'asset_get', 'asset_iteration_add', 'asset_note_add', 'variant_create',
    'storyboard_get', 'shots_update', 'shot_note_add', 'shot_note_resolve', 'gaps_get'];
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
  // ROADMAP_v4 F1: content is never "done" by itself (only the director marks done); it reads in_progress, shown "ready"
  check('stages_get on a project without stages.json: derived (content = in progress, never done), shown status from the content, next stage named', st.derived === true && st.stages?.length === 7 && st.stages[0].status === 'in_progress' && !st.stages[0].done_by && st.stages[0].shown === 'ready' && st.stages.every(s => s.status !== 'done') && st.next?.id && st.next.id !== 'lyrics' && st.facts?.lines === 9,
    { derived: st.derived, statuses: st.stages?.map(s => [s.status, s.shown]), next: st.next });
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

// 11c. stage 2 (the script draft): intake, scenes as versions, scene notes, sketches; on the demo (script.json derived)
{
  const g0 = await call(mcp, 'script_get');
  check('script_get on a project without scenes.json: v1 derived from script.json (stages -> scenes, lines -> beats), full coverage, nothing written',
    g0.derived === true && g0.current === 'v1' && g0.scenes?.length === 3 && g0.scenes[1].title === 'The wall' && g0.scenes[1].beats.length === 7 && g0.scenes[1].lines.length === 7 && g0.coverage === 1 && !g0.gaps.length && !fs.existsSync(path.join(D, 'scenes.json')),
    { derived: g0.derived, scenes: g0.scenes?.map(s => [s.id, s.t0, s.t1, s.beats.length]), coverage: g0.coverage });
  const ig = await call(mcp, 'intake_get');
  const ia = await call(mcp, 'intake_answer', { answers: { mood: 'mcp: bright and playful', kind: 'concept' }, by: 'director' });
  const iq = await call(mcp, 'intake_answer', { key: 'who', asked_in_chat: true });
  const ib = await call(mcp, 'intake_answer', { key: 'nope', text: 'x' });
  const ig2 = await call(mcp, 'intake_get');
  const pageIntake = await pageHas((_, s) => s ? s.files.includes('scenes.json') : window.WB.store.scenes?.intake?.mood?.text === 'mcp: bright and playful');
  check('intake_get / intake_answer: 9 questions, answers stamped via agent, asked in chat, unknown key refused, the page sees it',
    ig.questions?.length === 9 && ig.unanswered?.length === 9 && ia.updated?.length === 2 && iq.updated?.[0] === 'who' && /400|Invalid enum/.test(ib.error || '') && ig2.unanswered.length === 7
    && ig2.questions.find(q => q.id === 'mood').via === 'agent' && ig2.questions.find(q => q.id === 'mood').by === 'director' && !!ig2.questions.find(q => q.id === 'who').asked_in_chat && pageIntake,
    { unanswered: ig2.unanswered, bad: ib.error, pageIntake });
  // remove a scene -> a gap; fill it (snapped to lines); the ok status is refused; a needs_you is fine
  const u1 = await call(mcp, 'scenes_update', { remove: ['sc03'], message: 'mcp: drop the outro' });
  const g1 = await call(mcp, 'script_get');
  const u2 = await call(mcp, 'scenes_update', { upsert: [{ t0: '0:18.03', t1: 19950, title: 'mcp outro', text: 'back to the screen', beats: [{ t: 18600, text: 'cut to black' }] }], snap: 'lines', message: 'mcp: fill the gap' });
  const g2 = await call(mcp, 'script_get');
  const sc4 = g2.scenes?.find(s => s.title === 'mcp outro');
  const okRef = await call(mcp, 'scenes_update', { status: { sc01: 'ok' } });
  const nyou = await call(mcp, 'scenes_update', { status: { sc02: 'needs_you' } });
  const bad = await call(mcp, 'scenes_update', { upsert: [{ id: 'sc02', t1: 9000 }] });
  const same = await call(mcp, 'scenes_update', { scenes: g2.scenes.map(({ id, t0, t1, title, text, beats, sketches }) => ({ id, t0, t1, title, text, beats, sketches })) });
  check('scenes_update: every write a new version; remove -> a gap listed; a new scene snapped to lines (ids never reused); ok refused; needs_you set; beats outside refused; an unchanged list makes none',
    u1.version === 'v2' && g1.gaps?.[0]?.t0 === 18000 && g1.gaps[0].lines[0].id === 'outro/0' && u2.version === 'v3' && !u2.gaps.length && sc4?.id === 'sc04' && sc4.t0 === 18000 && sc4.t1 === 20000 && sc4.line_ids[0] === 'outro/0'
    && /403/.test(okRef.error || '') && nyou.status?.sc02 === 'needs_you' && g2.scenes.find(s => s.id === 'sc02').status === 'draft' && /400/.test(bad.error || '') && same.unchanged === true,
    { u1, gap: g1.gaps?.[0], u2: u2.version, sc4: sc4 && [sc4.id, sc4.t0, sc4.t1], ok: okRef.error, bad: bad.error, same });
  const rs = await call(mcp, 'scenes_update', { restore: 'v1' });
  const df = await call(mcp, 'script_get', { diff: ['v1', 'v3'] });
  const g3 = await call(mcp, 'script_get');
  check('scenes_update restore = a new version copied from the old one; script_get diff lists the scene changes and a word diff',
    rs.version === 'v4' && g3.current === 'v4' && g3.versions.at(-1).from === 'v1' && g3.scenes.length === 3 && JSON.stringify(df.scenes) === JSON.stringify({ added: ['sc04'], removed: ['sc03'], changed: [] }) && /\{\+mcp\+\}/.test(df.diff) && g3.scenes.find(s => s.id === 'sc02').status === 'needs_you',
    { rs, scenes: df.scenes, current: g3.current });
  // scene notes: on a scene, a reply, resolve; an ask from the page shows in asks_for_agent
  const n1 = await call(mcp, 'scene_note_add', { scene: 'sc02', text: 'mcp: cut on the downbeat?' });
  const r1 = await call(mcp, 'scene_note_add', { reply_to: n1.id, text: 'mcp: a reply' });
  const nb = await call(mcp, 'scene_note_add', { scene: 'nope', text: 'x' });
  const cur = JSON.parse(fs.readFileSync(path.join(D, 'scenes.json'), 'utf8'));
  cur.notes.push({ id: 'sn90', scene: null, text: 'fill the gaps please', to: 'agent', kind: 'fill_gaps', gaps: [[0, 1000]], status: 'open', replies: [] });
  const ps = await post(`/api/save/scenes.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur });
  const asks = (await call(mcp, 'script_get')).asks_for_agent;
  const rv = await call(mcp, 'scene_note_resolve', { id: 'sn90', reply: 'mcp: done' });
  check('scene notes: via agent, thread reply, unknown scene refused; a page ask (via page) is in asks_for_agent; resolve with a reply',
    n1.via === 'agent' && n1.scene === 'sc02' && r1.reply?.id === `${n1.id}.1` && /404/.test(nb.error || '') && ps.status === 200 && asks.some(a => a.id === 'sn90' && a.kind === 'fill_gaps') && rv.status === 'resolved' && rv.replies.length === 1
    && JSON.parse(fs.readFileSync(path.join(D, 'scenes.json'), 'utf8')).notes.find(n => n.id === 'sn90').via === 'page',
    { n1: n1.id, asks: asks.map(a => a.id), rv: rv.status });
  // sketches: save (PNG + mask, pins), get (image paths + pins), list, use in a scene; bad PNG / bad id refused
  const sk = { w: 64, h: 36, paper: '#ffffff', strokes: [{ t: 'line', c: '#111111', size: 3, o: 1, x0: 2, y0: 2, x1: 60, y1: 30 }], mask: [{ t: 'paint', size: 8, pts: [[10, 10, 1]] }], pins: [{ n: 1, x: 20, y: 12, text: 'necklace, silver, thin' }] };
  const sv = await call(mcp, 'sketch_save', { id: 'mcp-sk1', sketch: sk, png: tinyPngB64(64, 36), mask: tinyPngB64(64, 36, [0, 0, 0]), links: { scenes: ['sc02'] } });
  const sget = await call(mcp, 'sketch_get', { id: 'mcp-sk1' });
  const sbad = await call(mcp, 'sketch_save', { id: 'mcp-sk2', sketch: sk, png: Buffer.from('GIF89a not a png at all, really not').toString('base64') });
  const sid = await call(mcp, 'sketch_save', { id: '../evil', sketch: sk, png: tinyPngB64() });
  const used = await call(mcp, 'scenes_update', { upsert: [{ id: 'sc02', sketches: ['mcp-sk1'] }], message: 'mcp: sketch on the wall' });
  const sl = await call(mcp, 'sketch_list', { scene: 'sc02' });
  const g4 = await call(mcp, 'script_get');
  const media = S.read(PROJECT, 'media.json').items.find(m => m.id === 'sketch-mcp-sk1');
  check('sketch_save / sketch_get / sketch_list: files written (json, png, mask), media kind sketch with links, pins and absolute paths back; used by a scene; a non-PNG and a bad id refused',
    sv.png === 'sketches/mcp-sk1.png' && sv.mask === 'sketches/mcp-sk1.mask.png' && fs.existsSync(path.join(D, 'sketches/mcp-sk1.json')) && fs.existsSync(path.join(D, 'sketches/mcp-sk1.mask.png'))
    && sget.pins?.[0]?.text === 'necklace, silver, thin' && fs.existsSync(sget.files?.png || '') && sget.via === 'agent' && media?.kind === 'sketch' && media.scenes.includes('sc02') && media.mask === 'sketches/mcp-sk1.mask.png'
    && /400/.test(sbad.error || '') && /400/.test(sid.error || '') && !fs.existsSync(path.join(DATA, 'evil.json')) && !used.warnings && sl.length === 1 && sl[0].scenes.includes('sc02')
    && g4.scenes.find(s => s.id === 'sc02').sketches[0].pins[0].n === 1,
    { sv, pins: sget.pins, bad: sbad.error, id: sid.error, used, list: sl.map(x => x.id) });
  const st2 = await call(mcp, 'stages_get');
  check('stages_get: the script stage counts scenes, intake and gaps', st2.facts?.scenes === 3 && st2.facts.intakeOpen === 7 && st2.stages.find(x => x.id === 'script').blockers_all.some(b => /intake/.test(b)), { facts: st2.facts });
}

// 11d. stage 3 (the breakdown): items as versions linked to scenes / beats, statuses, notes, asks; promotion is the page's
{
  const b0 = await call(mcp, 'breakdown_get');
  check('breakdown_get on a project without breakdown.json: no version, the script to extract from (scenes, beats, sketch pins, intake), the existing entities',
    b0.current === null && b0.items?.length === 0 && b0.script?.scenes?.length >= 3 && b0.script.scenes.find(s => s.id === 'sc02')?.beats.length > 3 && b0.script.scenes.find(s => s.id === 'sc02').sketches[0]?.pins?.[0]?.text === 'necklace, silver, thin'
    && b0.intake?.mood === undefined && 'who' in (b0.intake || {}) && b0.entities?.some(e => e.id === 'ada') && !fs.existsSync(path.join(D, 'breakdown.json')),
    { current: b0.current, scenes: b0.script?.scenes?.map(s => s.id), entities: b0.entities?.map(e => e.id) });
  const u1 = await call(mcp, 'breakdown_update', { items: [
    { kind: 'character', name: 'Ada', description: 'the lead', links: [{ scene: 'sc02', beats: ['b1'], note: 'faces the wall' }] },
    { kind: 'character', name: 'Bo', links: ['sc02'] },
    { kind: 'location', name: 'Studio', links: ['sc01', 'sc02', 'sc03'] },
    { kind: 'prop', name: 'Tone generator', links: [{ scene: 'sc02', beats: ['b3'] }] },
    { kind: 'wardrobe', name: 'Orange hoodie', for: 'bi01', links: ['sc02'] },
    { kind: 'fx', name: 'Test card', links: ['sc01', 'sc03', 'sc99'], status: 'ok', entity_id: 'x' },
  ], message: 'mcp: first extraction' });
  const g1 = await call(mcp, 'breakdown_get', { with_script: false });
  const pageBd = await pageHas((_, s) => s ? s.files.includes('breakdown.json') : window.WB.store.breakdown?.current === 'v1');
  check('breakdown_update: a new version (ids bi01…, source agent, script version recorded); a link to an unknown scene and page fields (status, entity_id) only warn; the page sees it',
    u1.version === 'v1' && u1.items === 6 && u1.warnings?.some(w => /sc99/.test(w)) && u1.warnings?.some(w => /entity_id ignored/.test(w)) && g1.items.map(i => i.id).join() === 'bi01,bi02,bi03,bi04,bi05,bi06'
    && g1.items.every(i => i.source === 'agent' && i.status === 'draft' && !i.entity_id) && g1.items[0].links[0].note === 'faces the wall' && g1.items[4].for === 'bi01' && g1.version.script === g1.script_current
    && g1.counts.character === 2 && g1.scenes.find(s => s.id === 'sc02').items.length === 5 && g1.items[5].missing_scenes?.[0] === 'sc99' && !g1.script && pageBd,
    { u1, counts: g1.counts, ids: g1.items.map(i => i.id) });
  const okRef = await call(mcp, 'breakdown_update', { status: { bi01: 'ok' } });
  const rev = await call(mcp, 'breakdown_update', { status: { bi01: 'review' } });
  const badId = await call(mcp, 'breakdown_update', { upsert: [{ id: '../x', kind: 'prop', name: 'x' }] });
  const badKind = await call(mcp, 'breakdown_update', { upsert: [{ kind: 'vehicle', name: 'bus' }] });
  const up = await call(mcp, 'breakdown_update', { upsert: [{ id: 'bi06', dropped: true }, { kind: 'prop', name: 'Fractal wall', links: [{ scene: 'sc02', beats: ['b1', 'b2'] }] }], remove: ['bi02'], message: 'mcp: drop the test card, wall in, Bo out' });
  const g2 = await call(mcp, 'breakdown_get', { with_script: false, kind: 'prop' });
  const same = await call(mcp, 'breakdown_update', { upsert: [{ id: 'bi01', name: 'Ada' }] });
  check('breakdown_update: ok refused (403), review set; bad ids / kinds refused; upsert + remove + dropped make v2 (a new id, never reused); an unchanged list makes none',
    /403/.test(okRef.error || '') && rev.status?.bi01 === 'review' && /400|Invalid/.test(badId.error || '') && /400|Invalid/.test(badKind.error || '') && up.version === 'v2'
    && g2.items.map(i => i.id).join() === 'bi04,bi07' && g2.dropped === 1 && same.unchanged === true,
    { okRef: okRef.error, badId: badId.error, badKind: badKind.error, up, props: g2.items?.map(i => i.id) });
  const rs = await call(mcp, 'breakdown_update', { restore: 'v1' });
  const df = await call(mcp, 'breakdown_get', { diff: ['v1', 'v2'] });
  const bySc = await call(mcp, 'breakdown_get', { with_script: false, scene: 'sc01' });
  check('breakdown_update restore = a new version copied from the old one; breakdown_get diff lists the items added / removed / changed; scene filter',
    rs.version === 'v3' && JSON.stringify(df.items) === JSON.stringify({ added: ['bi07'], removed: ['bi02'], changed: ['bi06'] }) && /\{\+Fractal\+\}/.test(df.diff) && bySc.items.map(i => i.id).join() === 'bi03,bi06',
    { rs, items: df.items, bySc: bySc.items?.map(i => i.id) });
  // notes: on an item, a reply, resolve; an ask (kind extract) from the page shows in asks_for_agent
  const n1 = await call(mcp, 'breakdown_note_add', { item: 'bi03', text: 'mcp: one studio or two?' });
  const r1 = await call(mcp, 'breakdown_note_add', { reply_to: n1.id, text: 'mcp: a reply' });
  const nb = await call(mcp, 'breakdown_note_add', { item: 'nope', text: 'x' });
  const ns = await call(mcp, 'breakdown_note_add', { scene: 'sc77', text: 'x' });
  const cur = JSON.parse(fs.readFileSync(path.join(D, 'breakdown.json'), 'utf8'));
  cur.notes.push({ id: 'bn90', item: null, text: 'extract it please', to: 'agent', kind: 'extract', status: 'open', replies: [] });
  const ps = await post(`/api/save/breakdown.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur });
  const asks = (await call(mcp, 'breakdown_get', { with_script: false })).asks_for_agent;
  const rv = await call(mcp, 'breakdown_note_resolve', { id: 'bn90', reply: 'mcp: extracted' });
  check('breakdown notes: via agent, thread reply, unknown item / scene refused; a page ask (kind extract, via page) is in asks_for_agent; resolve with a reply',
    n1.via === 'agent' && n1.item === 'bi03' && n1.item_name === 'Studio' && r1.reply?.id === `${n1.id}.1` && /404/.test(nb.error || '') && /404/.test(ns.error || '') && ps.status === 200
    && asks.some(a => a.id === 'bn90' && a.kind === 'extract') && rv.status === 'resolved' && rv.replies.length === 1 && JSON.parse(fs.readFileSync(path.join(D, 'breakdown.json'), 'utf8')).notes.find(n => n.id === 'bn90').via === 'page',
    { n1: n1.id, nb: nb.error, ns: ns.error, ps: ps.status, asks });
  // promotion is the page's: no MCP tool; the HTTP op without the page's Origin and the offline op are refused
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const prHttp = await post(`/api/op/breakdown_promote?project=${PROJECT}`, { item: 'bi01' });
  let prOff = null; try { S.ops.breakdown_promote(PROJECT, { item: 'bi01' }); } catch (e) { prOff = e.code; }
  const prPage = await post(`/api/op/breakdown_promote?project=${PROJECT}`, { item: 'bi03', entity_id: 'studio' }, { origin: URL_ });
  const g3 = await call(mcp, 'breakdown_get', { with_script: false });
  check('create entity is the page\'s: no MCP tool; refused to the agent surface (HTTP without the page\'s Origin: 403; offline: 403); the page links an item to an existing entity (ok, entity_id)',
    !tools.includes('breakdown_promote') && prHttp.status === 403 && prOff === 403 && prPage.status === 200 && prPage.body?.entity_id === 'studio' && g3.items.find(i => i.id === 'bi03').entity_id === 'studio' && g3.items.find(i => i.id === 'bi03').status === 'ok',
    { prHttp: prHttp.status, prOff, prPage: prPage.body, bi03: g3.items.find(i => i.id === 'bi03') });
  const st3 = await call(mcp, 'stages_get');
  check('stages_get: the breakdown counts items and asks; the characters stage lists the items not yet entities',
    st3.facts?.items === 6 && st3.facts.itemsToPromote === 4 && st3.stages.find(x => x.id === 'characters').blockers_all.some(b => /4 breakdown items not yet entities/.test(b)), { facts: st3.facts });
}

// 11e. stage 4 (characters): the base and every choice are the page's; generations are requests; an agent registers
// the output of an approved, done request as a node; keep / branch / revert and approvals stay the director's
{
  const pageAct = (body) => post(`/api/op/character_act?project=${PROJECT}`, body, { origin: URL_ });
  const agentAct = (body) => post(`/api/op/character_act?project=${PROJECT}`, body);
  const approveInPage = async (rid) => { const cur = JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')); cur.items.find(r => r.id === rid).status = 'approved'; return post(`/api/save/requests.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur }); };
  const out = (f, rgb) => { fs.mkdirSync(path.join(D, 'media/gen'), { recursive: true }); fs.writeFileSync(path.join(D, 'media/gen', f), Buffer.from(tinyPngB64(32, 32, rgb), 'base64')); return `media/gen/${f}`; };
  const runReq = async (rid, file) => { for (const s of ['queued', 'running']) await call(mcp, 'request_update', { id: rid, status: s }); return call(mcp, 'request_update', { id: rid, status: 'done', outputs: [file], actual_cost_usd: 0 }); };
  const l0 = await call(mcp, 'character_get');
  check('character_get (no id): every character with its stage-4 status', l0.characters?.some(c => c.id === 'bo' && c.status === 'base' && c.label === 'needs a base') && l0.characters.some(c => c.id === 'ada'), { chars: l0.characters?.map(c => [c.id, c.status]) });
  // the base: the page's (with its Origin); the agent surface is refused, over HTTP and offline
  const base = { text: 'tall, calm, counts the bars', refs: [{ path: 'catalog/body/mannequin_neutral_turnaround.jpg', source: 'catalog', licence: 'CC0-1.0' }, { path: 'media/still/bo_face.jpg', source: 'media' }] };
  const pb = await pageAct({ id: 'bo', act: 'base', base }), pbA = await agentAct({ id: 'bo', act: 'base', base });
  let offAct = null; try { S.ops.character_act(PROJECT, { id: 'bo', act: 'base', base }); } catch (e) { offAct = e.code; }
  const badRef = await pageAct({ id: 'bo', act: 'base', base: { refs: [{ path: 'catalog/../package.json', source: 'catalog' }] } });
  const pubPhoto = await pageAct({ id: 'bo', act: 'base', base: { refs: [{ path: 'media/still/bo_face.jpg', source: 'photo' }] } });
  check('the base is the page\'s (character_act, via page): the agent surface gets 403; bad / escaping refs refused; a "photo" ref must be private',
    pb.status === 200 && pb.body?.base?.refs?.length === 2 && pb.body.base.via === 'page' && pbA.status === 403 && offAct === 403 && badRef.status === 400 && pubPhoto.status === 400 && !(await mcp.listTools()).tools.some(t => t.name === 'character_act' || t.name === 'ref_upload'),
    { pb: pb.status, pbA: pbA.status, offAct, badRef: badRef.status, pubPhoto: pubPhoto.status });
  // an identity request (draft) linked to the tree; bad links refused
  const r1 = await call(mcp, 'request_create', { kind: 'identity-sheet', prompt: 'identity sheet of Bo', est_cost: 0.08, tool: 'fal-ai/flux-pro/kontext/max/multi', refs: base.refs.map(r => r.path), char: { id: 'bo', tree: 'identity', kind: 'identity' } });
  const rBad = await call(mcp, 'request_create', { kind: 'identity-sheet', prompt: 'x', est_cost: 0.08, char: { id: 'nobody' } });
  const rBad2 = await call(mcp, 'request_create', { kind: 'character-edit', prompt: 'x', est_cost: 0.04, char: { id: 'bo', from: 'n99' } });
  const early = await call(mcp, 'character_iteration_add', { id: 'bo', request: r1.id });
  const ap = await approveInPage(r1.id);
  const notDone = await call(mcp, 'character_iteration_add', { id: 'bo', request: r1.id });
  const d1 = await runReq(r1.id, out('bo_n1.png', [40, 120, 90]));
  const n1 = await call(mcp, 'character_iteration_add', { id: 'bo', request: r1.id, note: 'placeholder' });
  const dup = await call(mcp, 'character_iteration_add', { id: 'bo', request: r1.id });
  const notOut = await call(mcp, 'character_iteration_add', { id: 'bo', request: r1.id, image: 'media/still/ada_face.jpg' });
  const wrongChar = await call(mcp, 'character_iteration_add', { id: 'ada', request: r1.id });
  check('a generation is a draft request with a character link (char accepted, stored as asset only: target character:bo); bad links refused; character_iteration_add only after a page approval and done; n01 is the head; idempotent; only the request\'s outputs; only its character',
    r1.status === 'draft' && r1.target === 'character:bo' && r1.asset?.tree === 'identity' && r1.asset.type === 'character' && !r1.char && /404/.test(rBad.error || '') && /404/.test(rBad2.error || '') && /403/.test(early.error || '') && ap.status === 200
    && /409/.test(notDone.error || '') && d1.request?.status === 'done' && n1.node?.id === 'n01' && n1.head === 'n01' && n1.node.via === 'agent' && dup.duplicate === true && /400/.test(notOut.error || '') && /400/.test(wrongChar.error || ''),
    { r1: r1.asset, rBad: rBad.error, rBad2: rBad2.error, early: early.error, notDone: notDone.error, n1: n1.node?.id, dup: dup.duplicate, notOut: notOut.error });
  // an edit: a sketch over n01 with a mask and a pin; the request carries them; n02 waits for the director
  const sk = { w: 32, h: 32, underlay: { src: 'media/gen/bo_n1.png' }, strokes: [{ t: 'pen', c: '#ff3b30', size: 3, o: 1, pts: [[4, 4, 0.5], [20, 20, 0.5]] }], mask: [{ t: 'paint', size: 8, pts: [[10, 10, 1]] }], pins: [{ n: 1, x: 12, y: 8, text: 'necklace here, silver' }] };
  const sv = await call(mcp, 'sketch_save', { id: 'bo-edit1', sketch: sk, png: tinyPngB64(32, 32), mask: tinyPngB64(32, 32, [255, 255, 255]), links: { entities: ['bo'] } });
  const r2 = await call(mcp, 'request_create', { kind: 'character-edit', prompt: 'add a silver necklace', est_cost: 0.05, tool: 'fal-ai/flux-pro/v1/fill', refs: ['media/gen/bo_n1.png', sv.png, sv.mask],
    char: { id: 'bo', from: 'n01', text: 'add a silver necklace', sketch: 'bo-edit1', png: sv.png, mask: sv.mask, pins: sk.pins } });
  await approveInPage(r2.id); await runReq(r2.id, out('bo_n2.png', [200, 200, 200]));
  const n2 = await call(mcp, 'character_iteration_add', { id: 'bo', request: r2.id });
  const g = await call(mcp, 'character_get', { id: 'bo' });
  const rq2 = g.requests?.find(r => r.id === r2.id);
  check('an edit request carries the text, the pins and the sketch: character_get gives the sketch PNG / mask (absolute files) and the pins; n02 (parent n01) waits for the director',
    r2.asset?.kind === 'edit' && r2.asset.pins?.[0]?.text === 'necklace here, silver' && n2.node?.parent === 'n01' && n2.waiting_for_director === true && g.waiting_for_director?.includes('n02')
    && fs.existsSync(rq2?.sketch?.files?.png || '') && fs.existsSync(rq2?.sketch?.files?.mask || '') && rq2.pins[0].n === 1 && rq2.ref_files?.every(Boolean) && g.base?.refs?.[0]?.file && fs.existsSync(g.base.refs[0].file)
    && g.trees?.[0]?.nodes?.length === 2 && g.trees[0].branches?.[0]?.nodes?.join() === 'n01,n02' && g.trees[0].nodes[0].file,
    { n2: n2.node && { id: n2.node.id, parent: n2.node.parent }, waiting: g.waiting_for_director, sketch: rq2?.sketch, branches: g.trees?.[0]?.branches });
  // keep / branch / revert and approve are the page's
  const cA = await agentAct({ id: 'bo', act: 'choose', node: 'n02', choice: 'kept' });
  const cP = await pageAct({ id: 'bo', act: 'choose', node: 'n02', choice: 'kept' });
  const aA = await agentAct({ id: 'bo', act: 'approve', tree: 'identity' });
  const uA = await call(mcp, 'entity_upsert', { kind: 'character', id: 'bo', fields: { iter: { trees: { identity: { head: 'n01', approved: 'n01' } } } } });
  const aP = await pageAct({ id: 'bo', act: 'approve', tree: 'identity' });
  const r3 = await call(mcp, 'request_create', { kind: 'character-edit', prompt: 'messier hair', est_cost: 0.04, char: { id: 'bo', from: 'n02', text: 'messier hair' } });
  await approveInPage(r3.id); await runReq(r3.id, out('bo_n3.png', [90, 90, 90]));
  const locked = await call(mcp, 'character_iteration_add', { id: 'bo', request: r3.id });
  const E = JSON.parse(fs.readFileSync(path.join(D, 'entities/characters/bo.json'), 'utf8'));
  check('keep / approve are the page\'s: the agent gets 403 and cannot write the trees through entity_upsert (ignored); the page keeps n02 and approves the identity (locked: a new node is refused, 409)',
    cA.status === 403 && cP.status === 200 && cP.body?.head === 'n02' && aA.status === 403 && uA.warnings?.some(w => /iter ignored/.test(w)) && aP.status === 200 && aP.body?.approved === 'n02'
    && /409/.test(locked.error || '') && E.iter.trees.identity.approved === 'n02' && E.iter.trees.identity.via === 'page' && E.identity_sheet === 'media/gen/bo_n2.png' && E.iter.log.some(l => l.act === 'approve' && l.via === 'page'),
    { cA: cA.status, aA: aA.status, uA: uA.warnings, aP: aP.body, locked: locked.error, identity: E.iter.trees.identity });
  // looks: the agent proposes one (review), cannot approve it; its tree starts from the approved identity
  const lc = await call(mcp, 'look_create', { id: 'bo', name: 'Night shift', garments: ['grey overalls', 'headlamp'] });
  const lcDup = await call(mcp, 'look_create', { id: 'bo', name: 'Night shift' });
  const lcAp = await call(mcp, 'entity_upsert', { kind: 'character', id: 'bo', look: { id: 'night-shift', status: 'approved' } });
  const r4 = await call(mcp, 'request_create', { kind: 'look-sheet', prompt: 'Bo in night shift', est_cost: 0.08, refs: ['media/gen/bo_n2.png'], char: { id: 'bo', tree: 'look:night-shift', from: 'n02', kind: 'look' } });
  await approveInPage(r4.id); await runReq(r4.id, out('bo_n4.png', [30, 30, 140]));
  const n4 = await call(mcp, 'character_iteration_add', { id: 'bo', request: r4.id });
  const no1 = await call(mcp, 'character_note_add', { id: 'bo', node: n4.node?.id, text: 'mcp: headlamp too bright?' });
  const no2 = await call(mcp, 'character_note_add', { id: 'bo', reply_to: no1.id, text: 'mcp: toned down', resolve: true });
  const g2 = await call(mcp, 'character_get', { id: 'bo', notes: 'all' });
  check('look_create: status review (a duplicate 409; approving it through entity_upsert 403); its look sheet roots the look tree from the approved identity (from_identity n02, head); notes on a node, a reply, resolved',
    lc.status === 'review' && lc.tree === 'look:night-shift' && /409/.test(lcDup.error || '') && /403/.test(lcAp.error || '') && n4.node?.tree === 'look:night-shift' && n4.node.from_identity === 'n02' && n4.node.parent === null && n4.head === n4.node.id
    && no1.via === 'agent' && no1.tree === 'look:night-shift' && no2.status === 'resolved' && no2.replies.length === 1 && g2.looks?.find(l => l.id === 'night-shift')?.status === 'review' && g2.status?.key === 'looks',
    { n4: n4.error || (n4.node && { tree: n4.node.tree, from: n4.node.from_identity, parent: n4.node.parent, head: n4.head }), no1: no1.error || no1.tree, no2: no2.error || no2.status, status: g2.status?.key, look: g2.looks?.find(l => l.id === 'night-shift')?.status });
  // a snapshot restored by the agent brings back no approval and keeps the nodes made since
  const snap = await call(mcp, 'snapshot_save', { message: 'mcp: characters' });
  await pageAct({ id: 'bo', act: 'unlock', tree: 'identity' });
  const r5 = await call(mcp, 'request_create', { kind: 'character-edit', prompt: 'scarf', est_cost: 0.04, char: { id: 'bo', from: 'n02', text: 'scarf' } });
  await approveInPage(r5.id); await runReq(r5.id, out('bo_n5.png', [120, 30, 30]));
  const n5 = await call(mcp, 'character_iteration_add', { id: 'bo', request: r5.id });
  const rs = await call(mcp, 'snapshot_restore', { snapshot: snap.id });
  const E2 = JSON.parse(fs.readFileSync(path.join(D, 'entities/characters/bo.json'), 'utf8'));
  check('an agent\'s snapshot restore brings no identity approval back and keeps the node made since (undecided)',
    !!snap.id && n5.node?.id && rs.restored === snap.id && !E2.iter.trees.identity.approved && E2.iter.nodes.some(n => n.id === n5.node.id && n.choice === null) && rs.kept_since_snapshot?.some(k => /approval not restored/.test(k)),
    { kept: rs.kept_since_snapshot, identity: E2.iter.trees.identity, nodes: E2.iter.nodes.map(n => n.id) });
}

// 11f. stage 5 (scenery): locations and props on the same asset code path; variants (angle / time of day / weather,
// angle / state) are trees from the approved base; the variant each scene needs is the director's pick
{
  const pageAct = (body) => post(`/api/op/asset_act?project=${PROJECT}`, body, { origin: URL_ });
  const agentAct = (body) => post(`/api/op/asset_act?project=${PROJECT}`, body);
  const approveInPage = async (rid) => { const cur = JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')); cur.items.find(r => r.id === rid).status = 'approved'; return post(`/api/save/requests.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur }); };
  const out = (f, rgb) => { fs.mkdirSync(path.join(D, 'media/gen'), { recursive: true }); fs.writeFileSync(path.join(D, 'media/gen', f), Buffer.from(tinyPngB64(48, 27, rgb), 'base64')); return `media/gen/${f}`; };
  const runReq = async (rid, file) => { for (const s of ['queued', 'running']) await call(mcp, 'request_update', { id: rid, status: s }); return call(mcp, 'request_update', { id: rid, status: 'done', outputs: [file], actual_cost_usd: 0 }); };
  const scIds = (await call(mcp, 'script_get')).scenes.map(s => s.id);
  const l0 = await call(mcp, 'asset_get', { type: 'location' }), all = await call(mcp, 'asset_get');
  check('asset_get: the locations with their stage-5 status; without a type every kind (characters, locations, props)',
    l0.locations?.some(x => x.id === 'studio' && x.status === 'base' && x.label === 'needs a base') && !l0.characters && all.characters?.some(c => c.id === 'bo') && all.props?.some(x => x.id === 'tone-generator') && Array.isArray(all.not_entities_yet),
    { l0: l0.locations?.map(x => [x.id, x.status]), kinds: Object.keys(all) });
  // the base: the page's (asset_act with its Origin); the agent surface is refused, over HTTP and offline
  const base = { text: 'a room that is a test pattern, neon tubes, concrete floor', refs: [{ path: 'catalog/location/neon_photostudio.jpg', source: 'catalog', licence: 'CC0-1.0' }, { path: 'media/still/studio.jpg', source: 'media' }] };
  const pb = await pageAct({ type: 'location', id: 'studio', act: 'base', base }), pbA = await agentAct({ type: 'location', id: 'studio', act: 'base', base });
  let offAct = null; try { S.ops.asset_act(PROJECT, { type: 'location', id: 'studio', act: 'base', base }); } catch (e) { offAct = e.code; }
  const wrongType = await pageAct({ type: 'prop', id: 'studio', act: 'base', base }), badType = await pageAct({ type: 'planet', id: 'studio', act: 'base', base });
  check('the location base is the page\'s (asset_act, via page): the agent surface gets 403 (HTTP and offline); a wrong or unknown type is refused; no asset_act tool',
    pb.status === 200 && pb.body?.base?.refs?.length === 2 && pb.body.base.via === 'page' && pbA.status === 403 && offAct === 403 && wrongType.status === 404 && badType.status === 400 && !(await mcp.listTools()).tools.some(t => t.name === 'asset_act'),
    { pb: pb.status, pbA: pbA.status, offAct, wrongType: wrongType.status, badType: badType.status });
  // a base plate request (asset link, no char link); bad links refused; the node after a page approval and done
  const r1 = await call(mcp, 'request_create', { kind: 'location-plate', prompt: 'establishing plate of the studio', est_cost: 0.08, tool: 'fal-ai/flux-pro/kontext/max/multi', refs: base.refs.map(r => r.path), asset: { type: 'location', id: 'studio', tree: 'base', kind: 'base' } });
  const rBad = await call(mcp, 'request_create', { kind: 'location-plate', prompt: 'x', est_cost: 0.08, asset: { type: 'location', id: 'studio', tree: 'identity' } });
  const rBad2 = await call(mcp, 'request_create', { kind: 'prop-sheet', prompt: 'x', est_cost: 0.08, asset: { type: 'prop', id: 'studio' } });
  const rBad3 = await call(mcp, 'request_create', { kind: 'location-variant', prompt: 'x', est_cost: 0.08, asset: { type: 'location', id: 'studio', tree: 'variant:nope' } });
  const early = await call(mcp, 'asset_iteration_add', { type: 'location', id: 'studio', request: r1.id });
  await approveInPage(r1.id); await runReq(r1.id, out('studio_n1.png', [30, 60, 120]));
  const n1 = await call(mcp, 'asset_iteration_add', { id: 'studio', request: r1.id, note: 'placeholder plate' });
  const asChar = await call(mcp, 'character_iteration_add', { id: 'studio', request: r1.id });
  check('a location generation: a draft request with an asset link (target location:studio, no char link); a root / variant tree that is not this type\'s or does not exist and a type mismatch refused; asset_iteration_add only after approval and done (type read from the request): n01 heads the base tree; character_iteration_add does not take it',
    r1.status === 'draft' && r1.target === 'location:studio' && r1.asset?.type === 'location' && r1.asset.tree === 'base' && !r1.char && /400/.test(rBad.error || '') && /404/.test(rBad2.error || '') && /404/.test(rBad3.error || '')
    && /403/.test(early.error || '') && n1.node?.id === 'n01' && n1.node.tree === 'base' && n1.node.kind === 'base' && n1.head === 'n01' && /400/.test(asChar.error || ''),
    { r1: r1.asset, rBad: rBad.error, rBad2: rBad2.error, rBad3: rBad3.error, early: early.error, n1: n1.error || n1.node?.id, asChar: asChar.error });
  // variants: the agent proposes one (review) for a scene; bad axes refused; its node waits for the approved base
  const v1 = await call(mcp, 'variant_create', { type: 'location', id: 'studio', axes: { angle: 'reverse', tod: 'night', weather: 'rain' }, scenes: [scIds[1]], description: 'neon reflections on the wet floor' });
  const vDup = await call(mcp, 'variant_create', { type: 'location', id: 'studio', axes: { angle: 'reverse', tod: 'night', weather: 'rain' } });
  const vBad = await call(mcp, 'variant_create', { type: 'location', id: 'studio', axes: { tod: '<b>night</b>' } }), vBad2 = await call(mcp, 'variant_create', { type: 'location', id: 'studio', axes: { state: 'broken' } });
  const vAp = await call(mcp, 'entity_upsert', { kind: 'location', id: 'studio', fields: { variants: [{ id: 'x', status: 'approved' }] } });
  const r2 = await call(mcp, 'request_create', { kind: 'location-variant', prompt: 'the studio, reverse angle at night in the rain', est_cost: 0.08, refs: ['media/gen/studio_n1.png'], asset: { type: 'location', id: 'studio', tree: `variant:${v1.variant}`, from: 'n01', kind: 'variant' } });
  await approveInPage(r2.id); await runReq(r2.id, out('studio_night.png', [10, 10, 40]));
  const tooEarly = await call(mcp, 'asset_iteration_add', { type: 'location', id: 'studio', request: r2.id });
  const apA = await agentAct({ type: 'location', id: 'studio', act: 'approve', tree: 'base' }), apP = await pageAct({ type: 'location', id: 'studio', act: 'approve', tree: 'base' });
  const n2 = await call(mcp, 'asset_iteration_add', { type: 'location', id: 'studio', request: r2.id });
  check('variant_create (location): axes reverse / night / rain -> id reverse-night-rain, name from the axes, status review, proposed for a scene; a duplicate 409, a bad axis value or an axis of another type 400; approving a variant through entity_upsert 403; its node waits for the approved base (409), the page approves the base (the agent 403), then the variant tree roots from it (from_identity n01)',
    v1.variant === 'reverse-night-rain' && v1.name === 'reverse · night · rain' && v1.status === 'review' && v1.tree === 'variant:reverse-night-rain' && /409/.test(vDup.error || '') && /400/.test(vBad.error || '') && /400/.test(vBad2.error || '') && /403/.test(vAp.error || '')
    && /409/.test(tooEarly.error || '') && apA.status === 403 && apP.status === 200 && n2.node?.tree === 'variant:reverse-night-rain' && n2.node.from_identity === 'n01' && n2.node.parent === null && n2.head === n2.node.id,
    { v1, vDup: vDup.error, vBad: vBad.error, vBad2: vBad2.error, vAp: vAp.error, tooEarly: tooEarly.error, apA: apA.status, apP: apP.status, n2: n2.error || n2.node?.tree });
  // the variant each scene needs: the agent's proposal shows until the director picks (page only)
  const g1 = await call(mcp, 'asset_get', { type: 'location', id: 'studio' });
  const useA = await agentAct({ type: 'location', id: 'studio', act: 'use', scene: scIds[0], variant: 'reverse-night-rain' });
  const useP = await pageAct({ type: 'location', id: 'studio', act: 'use', scene: scIds[0], variant: 'reverse-night-rain' }), useP2 = await pageAct({ type: 'location', id: 'studio', act: 'use', scene: scIds[1], variant: null });
  const useBad = await pageAct({ type: 'location', id: 'studio', act: 'use', scene: scIds[0], variant: 'nope' }), useBad2 = await pageAct({ type: 'location', id: 'studio', act: 'use', scene: '../x', variant: null });
  const upUses = await call(mcp, 'entity_upsert', { kind: 'location', id: 'studio', fields: { uses: { [scIds[2]]: { variant: 'reverse-night-rain' } } } });
  const g2 = await call(mcp, 'asset_get', { type: 'location', id: 'studio' });
  const u = (g, s) => g.scenes?.find(x => x.scene === s);
  check('scenes: the agent\'s proposal (variant_create scenes) shows as source agent; the director\'s pick (asset_act use, page only; the agent 403; an unknown variant 404, a bad scene id 400; entity_upsert uses ignored) wins: a scene on the variant, another back on the base; asset_get gives each scene its variant, name and image',
    u(g1, scIds[1])?.variant === 'reverse-night-rain' && u(g1, scIds[1]).source === 'agent' && u(g1, scIds[1]).image === n2.node.image && useA.status === 403 && useP.status === 200 && useP2.status === 200 && useBad.status === 404 && useBad2.status === 400
    && upUses.warnings?.some(w => /uses ignored/.test(w)) && u(g2, scIds[0])?.variant === 'reverse-night-rain' && u(g2, scIds[0]).source === 'director' && u(g2, scIds[1])?.variant === null && u(g2, scIds[1]).source === 'director' && u(g2, scIds[1]).variant_name === 'base' && u(g2, scIds[2])?.source !== 'director'
    && g2.variants?.[0]?.axes?.tod === 'night' && g2.root_approved === 'n01' && g2.status?.key === 'variants',
    { g1: g1.scenes, g2: g2.scenes, useA: useA.status, useBad: useBad.status, useBad2: useBad2.status, warn: upUses.warnings, status: g2.status });
  // a prop: an angle / state variant; notes on a scene's use; the character tools still answer
  const pv = await call(mcp, 'variant_create', { type: 'prop', id: 'tone-generator', axes: { state: 'broken' } }), pvBad = await call(mcp, 'variant_create', { type: 'prop', id: 'tone-generator', axes: { tod: 'night' } });
  const pvLit = await call(mcp, 'variant_create', { type: 'prop', id: 'tone-generator', axes: { angle: 'close-up', state: 'lit' }, name: 'Glowing close-up' });
  const no1 = await call(mcp, 'asset_note_add', { type: 'prop', id: 'tone-generator', scene: scIds[0], text: 'mcp: broken in this scene?', to: 'agent' });
  const no2 = await call(mcp, 'asset_note_add', { type: 'prop', id: 'tone-generator', reply_to: no1.id, text: 'mcp: yes, proposed the broken variant', resolve: true });
  const noBad = await call(mcp, 'asset_note_add', { type: 'prop', id: 'tone-generator', tree: 'identity', text: 'x' });
  const gp = await call(mcp, 'asset_get', { id: 'tone-generator', notes: 'all' }), gc = await call(mcp, 'asset_get', { id: 'bo' }), cl = await call(mcp, 'character_get');
  const lc = await call(mcp, 'variant_create', { type: 'character', id: 'bo', name: 'Rain gear', garments: ['yellow raincoat'] });
  check('a prop: variant_create state broken -> id broken; angle close-up + state lit with a name; a time of day refused (not a prop axis); notes on a scene\'s use (an01, reply, resolved; a character tree refused); asset_get finds the type by id; the character tools still answer (character_get lists characters; variant_create on a character is look_create)',
    pv.variant === 'broken' && pv.status === 'review' && /400/.test(pvBad.error || '') && pvLit.variant === 'close-up-lit' && pvLit.name === 'Glowing close-up' && no1.id === 'an01' && no1.scene === scIds[0] && no2.status === 'resolved'
    && /400/.test(noBad.error || '') && gp.type === 'prop' && gp.variants?.length === 2 && gp.notes?.length === 1 && gc.type === 'character' && gc.looks?.length >= 1 && cl.characters?.some(c => c.id === 'bo') && lc.look === 'rain-gear' && lc.status === 'review',
    { pv: pv.error || pv.variant, pvBad: pvBad.error, pvLit: pvLit.error || pvLit.variant, no1: no1.error || no1.id, noBad: noBad.error, gp: gp.variants?.map(v => v.id), lc: lc.error || lc.look });
  // an agent's snapshot restore: no variant approval comes back, the director's scene picks made since stay
  await pageAct({ type: 'location', id: 'studio', act: 'approve', tree: 'variant:reverse-night-rain' });
  const E1 = JSON.parse(fs.readFileSync(path.join(D, 'entities/locations/studio.json'), 'utf8'));
  const snap = await call(mcp, 'snapshot_save', { message: 'mcp: scenery' });
  await pageAct({ type: 'location', id: 'studio', act: 'unlock', tree: 'variant:reverse-night-rain' });
  await pageAct({ type: 'location', id: 'studio', act: 'use', scene: scIds[2], variant: 'reverse-night-rain' });
  const rs = await call(mcp, 'snapshot_restore', { snapshot: snap.id });
  const E2 = JSON.parse(fs.readFileSync(path.join(D, 'entities/locations/studio.json'), 'utf8'));
  check('approving a variant (page) sets it approved; an agent\'s snapshot restore brings back no variant approval that is not the current one (the variant back to review) and keeps the director\'s scene picks made since',
    E1.variants.find(v => v.id === 'reverse-night-rain')?.status === 'approved' && E1.iter.trees['variant:reverse-night-rain'].via === 'page' && rs.restored === snap.id
    && !E2.iter.trees['variant:reverse-night-rain']?.approved && E2.variants.find(v => v.id === 'reverse-night-rain')?.status === 'review' && E2.uses?.[scIds[2]]?.variant === 'reverse-night-rain'
    && rs.kept_since_snapshot?.some(k => /approval not restored/.test(k)),
    { kept: rs.kept_since_snapshot, uses: E2.uses, tree: E2.iter?.trees?.['variant:reverse-night-rain'] });
}

// 11g. stage 6 (the storyboard): shots per scene as versions (derived from shots.json until the first write), tiling on
// the beat grid, statuses (approval is the page's), notes and asks, the gaps with the draft requests and the estimate
{
  const SB = path.join(D, 'storyboard.json');
  const sb0 = await call(mcp, 'storyboard_get');
  const all0 = [...(sb0.scenes || []).flatMap(s => s.shots), ...(sb0.outside_script || [])];
  const s2 = all0.find(s => s.id === 's2-wall');
  check('storyboard_get without storyboard.json: v1 derived from shots.json (the same ids, thumbs, cast, clip uses), each shot in the scene at its middle; the beat grid; the gaps; nothing written',
    sb0.current === 'v1' && sb0.derived === true && all0.length === 5 && s2?.clips?.includes('C1@4000') && !!s2.frame?.thumb && s2.cast?.includes('ada') && !!s2.scene && sb0.grid?.beat_ms === 500 && typeof sb0.gaps?.total === 'number' && !fs.existsSync(SB)
    && s2.assets?.some(a => a.type === 'location' && a.id === 'studio'),
    { current: sb0.current, derived: sb0.derived, shots: all0.map(s => `${s.id}@${s.scene}`), assets: s2?.assets?.map(a => `${a.type}:${a.id}:${a.approved}`) });
  // upsert: text / camera / kind on a shot; a new shot inside the same scene snapped to the grid; the scene stays tiled
  const sc = sb0.scenes.find(s => s.id === s2.scene);
  const u1 = await call(mcp, 'shots_update', { upsert: [{ id: 's2-wall', text: 'mcp: Ada at the wall, the pattern breathing', camera: 'slow push in', kind: 'medium' }, { scene: sc.id, t0: s2.t0 + 1334, t1: s2.t1, kind: 'close', text: 'mcp: close on the hum', cast: ['ada'], locations: ['studio'], gen: 'still' }], snap: 'beats', message: 'mcp: shots' });
  const F1 = JSON.parse(fs.readFileSync(SB, 'utf8')), v = F1.versions.at(-1), nw = v.shots.find(s => s.id === 'sh01'), w2 = v.shots.find(s => s.id === 's2-wall');
  const grp = v.shots.filter(s => s.scene === sc.id).sort((a, b) => a.t0 - b.t0);
  check('shots_update: a NEW version (v1 from shots.json kept, via import); text / camera / kind changed; a new shot sh01 in the scene, its start snapped to a beat (5500), s2-wall now ends where it starts; the scene is tiled from its start to its end',
    u1.version === 'v2' && F1.versions.length === 2 && F1.versions[0].via === 'import' && v.via === 'agent' && w2?.camera === 'slow push in' && w2.kind === 'medium' && nw?.t0 === 5500 && w2.t1 === 5500 && nw.kind === 'close' && nw.gen === 'still'
    && grp[0].t0 === sc.t0 && grp.at(-1).t1 === sc.t1 && grp.every((s, i) => !i || grp[i - 1].t1 === s.t0),
    { u1, s2: w2 && [w2.t0, w2.t1], nw: nw && [nw.t0, nw.t1], grp: grp.map(s => [s.id, s.t0, s.t1]), scene: [sc.t0, sc.t1] });
  // statuses: review is fine (approvals.json, via agent); approved / locked are the director's (403)
  const st1 = await call(mcp, 'shots_update', { status: { 's2-wall': 'review', sh01: 'changes' } });
  const stA = await call(mcp, 'shots_update', { status: { sh01: 'approved' } }), stL = await call(mcp, 'shots_update', { status: { sh01: 'locked' } });
  const AP = JSON.parse(fs.readFileSync(path.join(D, 'approvals.json'), 'utf8'));
  check('shots_update status: review / changes written to approvals.json (shot:<id>, via agent); approved and locked refused (403)',
    st1.status?.['s2-wall'] === 'review' && AP.items['shot:s2-wall']?.state === 'review' && AP.items['shot:s2-wall'].via === 'agent' && AP.items['shot:sh01']?.state === 'changes' && /403/.test(stA.error || '') && /403/.test(stL.error || ''),
    { st1: st1.status || st1.error, stA: stA.error, stL: stL.error });
  // bad input: ids, sketch ids, entity ids, variants, times, removing what is not there: 400 / 404, nothing written
  const nV = F1.versions.length, bad = {};
  for (const [k, a] of Object.entries({ shotId: { upsert: [{ id: '../x', t0: 0, t1: 1000 }] }, sketch: { upsert: [{ id: 'sh01', sketch: '../evil' }] }, cast: { upsert: [{ id: 'sh01', cast: ['<b>x</b>'] }] },
    variant: { upsert: [{ id: 'sh01', variants: { ada: '../y' } }] }, times: { upsert: [{ id: 'sh01', t0: 9000, t1: 2000 }] }, noTimes: { upsert: [{ scene: sc.id, text: 'no times' }] }, kind: { upsert: [{ id: 'sh01', kind: '<script>' }] },
    removeNone: { remove: ['nope'] }, gen: { upsert: [{ id: 'sh01', gen: 'film' }] }, both: { shots: [], upsert: [] } })) bad[k] = (await call(mcp, 'shots_update', a)).error || 'accepted';
  const nV2 = JSON.parse(fs.readFileSync(SB, 'utf8')).versions.length;
  check('shots_update refuses bad shot / sketch / entity / variant ids, bad times, kinds and gens (400, or the tool schema), unknown removals (404), two modes at once (400); nothing written',
    Object.entries(bad).every(([k, e]) => (k === 'removeNone' ? /404/ : /400|-32602/).test(e)) && nV2 === nV, bad);
  // warnings: an unknown entity and a sketch without files; remove, restore, diff
  const u2 = await call(mcp, 'shots_update', { upsert: [{ id: 'sh01', cast: ['ada', 'nobody'], sketch: 'nosuch-frame' }], message: 'mcp: warnings' });
  const u3 = await call(mcp, 'shots_update', { remove: ['sh01'], message: 'mcp: remove' });
  const F3 = JSON.parse(fs.readFileSync(SB, 'utf8')), w3 = F3.versions.at(-1).shots.find(s => s.id === 's2-wall');
  const rs = await call(mcp, 'shots_update', { restore: 'v2' }), df = await call(mcp, 'storyboard_get', { diff: ['v1', 'v2'] });
  check('shots_update warns about an unknown entity and a sketch without files; remove gives the time back to the neighbour (tiled again); restore copies an old version as a new one; diff lists the shots added / changed',
    u2.warnings?.some(w => /no character "nobody"/.test(w)) && u2.warnings.some(w => /nosuch-frame/.test(w)) && /^v\d+$/.test(u3.version || '') && w3?.t1 === s2.t1 && rs.version && JSON.parse(fs.readFileSync(SB, 'utf8')).versions.at(-1).from === 'v2'
    && df.shots?.added?.includes('sh01') && df.shots.changed.includes('s2-wall') && /\{\+/.test(df.diff || ''),
    { warn: u2.warnings, u3: u3.version, w3: w3 && w3.t1, rs, df: df.shots });
  // notes: on a shot, a reply, resolve; an ask from the page (its own save, stamped director / page) shows in asks_for_agent
  const n1 = await call(mcp, 'shot_note_add', { shot: 's2-wall', text: 'mcp: the push-in should land on the downbeat' });
  const n2 = await call(mcp, 'shot_note_add', { reply_to: n1.id, text: 'mcp: a reply' });
  const nb = await call(mcp, 'shot_note_add', { shot: 'nope', text: 'x' }), nb2 = await call(mcp, 'shot_note_add', { shot: '../x', text: 'x' });
  const cur = JSON.parse(fs.readFileSync(SB, 'utf8'));
  cur.notes.push({ id: 'sbn99', shot: null, text: 'mcp: page ask: storyboard the chorus', to: 'agent', kind: 'storyboard', status: 'open', by: 'agent', via: 'agent', replies: [] });
  const ps = await post(`/api/save/storyboard.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur }, { origin: URL_ });
  const g1 = await call(mcp, 'storyboard_get'), ask = g1.asks_for_agent?.find(a => a.id === 'sbn99');
  const rv = await call(mcp, 'shot_note_resolve', { id: 'sbn99', reply: 'mcp: done' });
  const SBF = JSON.parse(fs.readFileSync(SB, 'utf8'));
  check('shot notes: on a shot (sbn01, via agent), a reply, an unknown or bad shot refused; a page ask (stamped director / page whatever it claims) is an ask for the agent; resolved with a reply',
    n1.id === 'sbn01' && n1.via === 'agent' && n1.shot === 's2-wall' && n2.reply?.id === 'sbn01.1' && /404/.test(nb.error || '') && /400/.test(nb2.error || '') && ps.status === 200 && ask?.kind === 'storyboard'
    && SBF.notes.find(n => n.id === 'sbn99')?.via === 'page' && SBF.notes.find(n => n.id === 'sbn99').by === 'director' && rv.status === 'resolved' && rv.replies?.[0]?.text === 'mcp: done',
    { n1: n1.id || n1.error, ask, rv: rv.status });
  // gaps: the rows, the draft requests (refs = the approved base image of the studio), the estimate against the cap; a
  // request on a shot takes it off the list
  // s1-intro's scene uses a studio variant the director picked (no longer approved after the 11f restore): the shot
  // overrides it with the base (null), which is approved
  const ov = await call(mcp, 'shots_update', { upsert: [{ id: 's1-intro', locations: ['studio'], variants: { studio: null } }], message: 'mcp: s1 on the studio base' });
  const gp = await call(mcp, 'gaps_get');
  const p1 = gp.proposals?.find(x => x.shot === 's1-intro'), q1 = p1?.requests?.[0];
  const studio = JSON.parse(fs.readFileSync(path.join(D, 'entities/locations/studio.json'), 'utf8')), baseImg = studio.iter.nodes.find(n => n.id === studio.iter.trees.base.approved)?.image;
  const rq = await call(mcp, 'request_create', { kind: q1.kind, target: q1.target, prompt: q1.prompt, refs: q1.refs, est_cost: q1.est_cost, tool: q1.tool });
  const gp2 = await call(mcp, 'gaps_get');
  check('gaps_get: the groups (counts), a shot without a request (its studio overridden to the approved base) gets its draft requests (a start frame then the video: kind shot-still first, target shot:<id>, refs = the approved studio base image, NB2 2K $0.12 from js/prices.js, the video priced per second), the estimate against the cap; request_create on the shot takes it off the list',
    /^v\d+$/.test(ov.version || '') && typeof gp.counts?.no_request === 'number' && gp.no_request.some(x => x.shot === 's1-intro') && q1?.kind === 'shot-still' && q1.target === 'shot:s1-intro' && q1.refs.includes(baseImg) && q1.est_cost === 0.12 && /nano-banana-2/.test(q1.tool) && p1.requests[1]?.kind === 'shot-video' && p1.requests[1].est_cost >= 0.24 && /h3-max/.test(p1.requests[1].tool)
    && typeof gp.estimate.over_cap === 'boolean' && gp.estimate.total_usd >= gp.estimate.usd && rq.status === 'draft' && !gp2.no_request.some(x => x.shot === 's1-intro') && gp2.estimate.usd < gp.estimate.usd,
    { p1: p1 && { gen: p1.gen, reqs: p1.requests.map(r => [r.kind, r.est_cost, r.refs]) }, baseImg, est: gp.estimate, est2: gp2.estimate?.usd });
  const tq = await call(mcp, 'timeline_query', { t0: 4000, t1: 6000 }), sbs = await call(mcp, 'storyboard_get', { scene: sc.id });
  check('timeline_query lists the storyboard shots in the range (board); storyboard_get filters by scene', tq.board?.some(x => x.id === 's2-wall' && x.camera === 'slow push in') && sbs.scenes?.length === 1 && sbs.scenes[0].id === sc.id && !sbs.outside_script.length,
    { board: tq.board?.map(x => x.id), scenes: sbs.scenes?.map(s => s.id) });
}

// 12. offline: the server is unreachable -> the same tools work on the files; ui_focus explains
{
  const off = await connect({ WORKBENCH_URL: 'http://localhost:9' });
  const st = await call(off, 'status');
  const tq = await call(off, 'timeline_query', { t0: 4000, t1: 8000 });
  const ui = await call(off, 'ui_focus', { t: 1000 });
  const sg = await call(off, 'stages_get'), lu = await call(off, 'lyrics_update', { project: 'mcp-lyrics', text: '[Verse 1]\noffline line', message: 'offline' });
  const so = await call(off, 'scenes_update', { upsert: [{ id: 'sc01', title: 'offline title' }], message: 'offline' }), sko = await call(off, 'sketch_get', { id: 'mcp-sk1' }), bo = await call(off, 'breakdown_get', { with_script: false }), sbo = await call(off, 'storyboard_get'), gpo = await call(off, 'gaps_get');
  check('offline mode: files directly (stages, lyrics, scenes, sketches, breakdown too), ui_focus refuses politely', st.mode === 'files' && tq.shots?.[0]?.id === 's2-wall' && /not running/.test(ui.error || '') && sg.stages?.length === 7 && lu.version === 'v4'
    && /^v\d+$/.test(so.version || '') && sko.pins?.length === 1 && bo.current === 'v3' && bo.items?.length === 6 && /^v\d+$/.test(sbo.current || '') && !sbo.derived && Array.isArray(gpo.proposals),
    { mode: st.mode, shots: tq.shots?.map(s => s.id), ui: ui.error, stages: sg.stages?.length, lyrics: lu.version || lu.error, scenes: so.version || so.error });
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
// 14. the dogfood frictions (DOGFOOD_her_v3.md): one cost ledger with falgen, cost_record, media_update, base_propose,
// node_import_propose (+ the page's accept), request warnings and the deprecated char link, the photoreal recipe,
// wait_for, the stale server (status, warnings, the offline fallback for an op it does not know) and mcp/client.mjs
{
  const callW = async (client, name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { r: r.isError ? { error: t } : j, warn: (r.content || []).slice(1).map(c => c.text).join('\n') }; };
  const pageAct = (body) => post(`/api/op/asset_act?project=${PROJECT}`, body, { origin: URL_ });
  const approveInPageW = async (rid) => { const cur = JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')); cur.items.find(r => r.id === rid).status = 'approved'; return post(`/api/save/requests.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur }); };
  // falgen: a scratch folder under the test media base, named in project.json (read only)
  fs.mkdirSync(path.join(MB, 'proj', 'gen'), { recursive: true });
  fs.writeFileSync(path.join(MB, 'proj', 'gen', 'spent.json'), JSON.stringify({ total: 1.5 }));
  fs.writeFileSync(path.join(MB, 'proj', 'LEDGER.md'), '| Date | Phase | Tool | Items | Est $ | Running total |\n|---|---|---|---|---|---|\n| 2026-10-04 | song | Suno | | ~10 | ~10 |\n| 2026-10-04 | C1 | fal C1 via falgen | | 0.24 | gen total 0.24 |\n| 2026-10-04 | HV1 | fal HV1 via falgen | | 0.24 | gen total 0.48 |\n| 2026-10-04 | HV2 | fal HV2 via falgen | | 0.36 | gen total 0.84 |\n');
  const pj = path.join(D, 'project.json'), pj0 = fs.readFileSync(pj, 'utf8');
  fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(pj0), falgen: 'proj/gen' }));
  const c0 = await call(mcp, 'costs_get');
  const fgRow = c0.sources?.find(s => s.id === 'falgen'), un = c0.sources?.find(s => s.id === 'falgen_unitemized');
  const rec = await call(mcp, 'cost_record', { usd: 0.24, via: 'falgen', job: 'HV1', note: 'ran before its request' });
  const recDup = await call(mcp, 'cost_record', { usd: 0.24, via: 'falgen', job: 'HV1' });
  const recBad = await call(mcp, 'cost_record', { usd: 0.1, via: 'Bad Via!' });
  const doneReq = (await call(mcp, 'requests_list', { status: 'done' }))[0];
  const recDone = doneReq ? await call(mcp, 'cost_record', { usd: 0.1, via: 'retro', request: doneReq.id }) : { error: '409 (no done request)' };
  const c1 = await call(mcp, 'costs_get');
  check('costs_get merges falgen (project.json "falgen"): ledger rows not in costs.json + spent.json not itemised, C1 counted once; cost_record adds HV1 (via falgen) and the total does not move (no double count); the same job again is not recorded; a bad via 400; a done request 409; never an approval',
    fgRow?.deduped === 1 && fgRow.usd === 0.6 && un?.usd === 0.66 && rec.recorded === true && rec.item?.via === 'falgen' && /never an approval/.test(rec.note) && recDup.recorded === false && !!recBad.error && /409/.test(recDone.error || '')
    && Math.abs(c1.total_spent_usd - c0.total_spent_usd) < 0.005 && c1.sources.find(s => s.id === 'falgen').deduped === 2 && c1.falgen?.other_ledger_rows?.length === 1,
    { c0: c0.sources, c1: c1.sources, totals: [c0.total_spent_usd, c1.total_spent_usd], recDone: recDone.error });
  fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(pj0), falgen: '../../outside' }));
  const cOut = await call(mcp, 'costs_get');
  fs.writeFileSync(pj, pj0);
  check('a falgen folder outside the media base is refused (no read), reported in costs_get', /inside the media base/.test(cOut.falgen?.error || ''), cOut.falgen);

  // media_update: relabel, re-kind, re-link; private only toward more private
  const mu = await call(mcp, 'media_update', { id: 'I1', label: 'studio still (relabelled)', kind: 'look', entities: ['ada', 'studio'] });
  const muPriv = await call(mcp, 'media_update', { id: 'I1', private: true });
  const muBack = await call(mcp, 'media_update', { id: 'I1', private: false });
  const muNone = await call(mcp, 'media_update', { id: 'nope', label: 'x' });
  const mI1 = JSON.parse(fs.readFileSync(path.join(D, 'media.json'), 'utf8')).items.find(m => m.id === 'I1');
  check('media_update: relabel + kind + links; private:true flags it (status private, a thumbs/priv_ thumbnail); private:false refused (403); an unknown id 404',
    mu.changed?.join() === 'label,kind,entities' && mI1.label === 'studio still (relabelled)' && mI1.kind === 'look' && mI1.private === true && mI1.status === 'private' && (!mI1.thumb || /thumbs\/priv_/.test(mI1.thumb)) && muPriv.changed?.includes('private') && /403/.test(muBack.error || '') && /404/.test(muNone.error || ''),
    { mu: mu.changed, priv: [mI1.private, mI1.status, mI1.thumb], back: muBack.error });

  // base_propose + node_import_propose, accepted in the page only
  const bp = await call(mcp, 'base_propose', { id: 'ada', text: 'Ada: the lead, short dark hair', refs: ['media/still/ada_face.jpg', { path: 'media/still/ada_body.jpg', source: 'media' }], why: 'her registered stills' });
  const bpBad = await call(mcp, 'base_propose', { id: 'ada', refs: ['media/still/nope.jpg'] });
  const ip = await call(mcp, 'node_import_propose', { id: 'ada', tree: 'identity', media: 'ada_body', why: 'the approved legacy look image' });
  const ipBad = await call(mcp, 'node_import_propose', { id: 'ada', tree: 'identity', media: 'demo-song', why: 'audio' });
  const agentAccept = await post(`/api/op/asset_act?project=${PROJECT}`, { type: 'character', id: 'ada', act: 'import_accept', proposal: ip.proposal?.id });
  let offAccept = null; try { S.ops.asset_act(PROJECT, { type: 'character', id: 'ada', act: 'base_accept' }); } catch (e) { offAccept = e.code; }
  const g0 = await call(mcp, 'asset_get', { id: 'ada' });
  const acc1 = await pageAct({ type: 'character', id: 'ada', act: 'base_accept' });
  const acc2 = await pageAct({ type: 'character', id: 'ada', act: 'import_accept', proposal: ip.proposal?.id });
  const g1 = await call(mcp, 'asset_get', { id: 'ada' });
  const node = g1.trees?.[0]?.nodes?.[0];
  check('base_propose / node_import_propose: proposals the agent cannot accept (HTTP without the page Origin 403, offline 403); asset_get shows them; the page accepts: the base (by director, proposed_by agent) and an identity node with origin imported, provenance, request null, the head; bad refs 404, a non-image 400',
    bp.base_proposal?.refs?.length === 2 && /404/.test(bpBad.error || '') && ip.proposal?.status === 'open' && /400/.test(ipBad.error || '') && agentAccept.status === 403 && offAccept === 403
    && g0.base_proposal?.refs?.[0]?.file && g0.import_proposals?.length === 1 && acc1.status === 200 && acc2.status === 200 && g1.base?.by === 'director' && g1.base.proposed_by === 'agent' && !g1.base_proposal && !g1.import_proposals?.length
    && node?.origin === 'imported' && node.request === null && node.provenance?.media === 'ada_body' && g1.trees[0].head === node.id,
    { bp: bp.base_proposal?.refs?.length, ipBad: ipBad.error, agent: agentAccept.status, off: offAccept, acc: [acc1.status, acc2.status, acc2.body], node });

  // request warnings, the deprecated char link, the recipe
  await call(mcp, 'look_create', { id: 'ada', name: 'Night out' });
  const w1 = await callW(mcp, 'request_create', { kind: 'look-sheet', prompt: 'Ada night out', est_cost: 0.12, char: { id: 'ada', tree: 'look:night-out', kind: 'look' } });
  await pageAct({ type: 'character', id: 'ada', act: 'approve', tree: 'identity' });
  const w2 = await call(mcp, 'request_create', { kind: 'look-sheet', prompt: 'x', est_cost: 0.12, asset: { type: 'character', id: 'ada', tree: 'look:night-out', kind: 'look' } });
  const rc = await call(mcp, 'request_create', { kind: 'look-sheet', refs: ['media/still/ada_body.jpg'], asset: { type: 'character', id: 'ada', tree: 'look:night-out', from: node?.id, kind: 'look' },
    recipe: { wardrobe: 'a black satin slip dress', action: 'she leans on the counter', place: 'a narrow bar at night, zinc counter', light: 'warm tungsten bulbs above, hard, from the left' } });
  const rcV = await call(mcp, 'request_create', { kind: 'shot-video', refs: ['media/still/ada_body.jpg'], recipe: { model: 'kling3pro', action: 'she turns her head slowly', seconds: 6 } });
  const ru = await call(mcp, 'request_update', { id: rc.id, recipe: { blocks: { texture: 'Visible pores and satin creases.' }, light: 'cold fluorescent tubes overhead' } });
  const reqFile = JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')).items.find(r => r.id === w1.r.id);
  check('request_create: a look sheet with from null and no approved identity warns (stored on the request, shown on its card); char is deprecated (a warning, stored as asset, never echoed); once the identity is approved the warning names the node to start from',
    w1.r.warnings?.some(w => /no approved identity/.test(w)) && w1.r.warnings.some(w => /deprecated/.test(w)) && !w1.r.char && !reqFile.char && reqFile.asset?.type === 'character' && reqFile.warnings?.length === 2
    && w2.warnings?.some(w => new RegExp(`set from: "${node?.id}"`).test(w)),
    { w1: w1.r.warnings, w2: w2.warnings });
  check('request_create recipe: the prompt from the photoreal blocks (identity lock since image 1 is the approved identity), est and tool from js/prices.js (NB2 2K $0.12; Kling v3 Pro $0.112/s x 6 s = $0.672 + its negative prompt); request_update recipe rebuilds the prompt from edited blocks / fields',
    rc.recipe?.blocks?.some(b => b.id === 'identity_lock') && /Keep the face exactly as in Image 1/.test(rc.prompt) && /satin slip dress/.test(rc.prompt) && rc.est_cost === 0.12 && /nano-banana-2/.test(rc.tool) && !rc.warnings
    && rcV.est_cost === 0.672 && /kling-video\/v3\/pro/.test(rcV.tool) && /morphing face/.test(rcV.recipe?.negative_prompt || '')
    && /Visible pores and satin creases\./.test(ru.request?.prompt || '') && /cold fluorescent tubes/.test(ru.request.prompt) && !/tungsten/.test(ru.request.prompt),
    { rc: rc.warnings || rc.est_cost, rcV: [rcV.est_cost, rcV.tool], ru: ru.request?.prompt?.slice(0, 200) || ru.error });

  // wait_for: blocks until the director approves in the page (the server's change feed wakes it)
  const target = rc.id;
  const waiting = call(mcp, 'wait_for', { request: target, until: ['approved', 'rejected'], timeout_s: 30 });
  await wait(800); const t0 = Date.now(); await approveInPageW(target);
  const wf = await waiting, wfMs = Date.now() - t0;
  const wfNow = await call(mcp, 'wait_for', { request: target, until: ['approved'], timeout_s: 5 });
  const wfTo = await call(mcp, 'wait_for', { stage: 'final', timeout_s: 1 });
  const wfBad = await call(mcp, 'wait_for', { request: target, stage: 'final' });
  check('wait_for: wakes when the page approves (changed, status approved, within a few s), returns at once when already there, times out with the current state, needs exactly one item',
    wf.changed === true && wf.status === 'approved' && wf.from === 'draft' && wfMs < 6000 && wfNow.already === true && wfTo.timed_out === true && /400/.test(wfBad.error || ''), { wf, wfMs, wfTo: wfTo.timed_out, wfBad: wfBad.error });

  // a stale server: a copy of the code where lib/store.mjs differs (it does not know media_update) on its own port
  const OLD = path.join(TMP, 'oldcode'), P2 = PORT + 1;
  for (const p of ['serve.mjs', 'index.html', 'dock.html', 'app.js', 'app.css', 'lib', 'js', 'tabs', 'core', 'templates']) fs.cpSync(path.join(WB, p), path.join(OLD, p), { recursive: true });
  const sf = path.join(OLD, 'lib', 'store.mjs'); fs.writeFileSync(sf, fs.readFileSync(sf, 'utf8').replace('  media_update(p, {', '  media_update_was(p, {'));
  const old = spawn(process.execPath, [path.join(OLD, 'serve.mjs'), String(P2)], { stdio: 'pipe', env: process.env });
  try {
    await new Promise((ok, bad) => { old.stdout.once('data', ok); old.once('exit', (c) => bad(new Error('old server exited ' + c))); });
    const m2 = await connect({ WORKBENCH_URL: `http://localhost:${P2}` });
    try {
      const st = await callW(m2, 'status');
      const mu2 = await callW(m2, 'media_update', { id: 'I1', label: 'via the offline fallback' });
      const sg = await callW(m2, 'song_get', { words: false });
      check('a stale server: status says server.code.stale + restart, and every tool adds a "warning: … restart the server" block; an op the old server does not know (404 no such op) is done on the files directly, with a warning',
        st.r.server?.code?.stale === true && /restart/.test(st.r.server.restart || '') && /restart the server/.test(st.warn) && mu2.r.media?.label === 'via the offline fallback' && /does not know "media_update"/.test(mu2.warn) && /restart the server/.test(sg.warn),
        { code: st.r.server?.code, warn: mu2.warn.slice(0, 200), mu2: mu2.r.error });
    } finally { await m2.close().catch(() => {}); }
  } finally { old.kill(); await wait(200); }
  const fresh = await callW(mcp, 'status');
  check('the current server: code not stale, no warning', fresh.r.server?.code?.stale === false && !fresh.warn, fresh.r.server?.code);

  // mcp/client.mjs from another folder: a tool call (JSON out) and a runner's cost_record hook
  const cli = (args) => new Promise((ok) => { const c = spawn(process.execPath, [path.join(WB, 'mcp', 'client.mjs'), ...args], { cwd: os.tmpdir(), env: { ...process.env, WORKBENCH_URL: URL_ } }); let o = '', e = ''; c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; }); c.on('exit', (code) => ok({ code, o, e })); });
  const c1o = await cli(['costs_get', '--project', PROJECT]);
  const c2o = await cli(['cost_record', '{"usd":0.36,"via":"falgen","job":"HV2"}', '--project', PROJECT]);
  const c3o = await cli(['no_such_tool', '{}']);
  let cj = null; try { cj = JSON.parse(c1o.o); } catch (e) { /* not JSON */ }
  check('mcp/client.mjs from another folder: costs_get prints JSON (exit 0); cost_record works as a runner hook; an unknown tool exits 1',
    c1o.code === 0 && typeof cj?.total_spent_usd === 'number' && c2o.code === 0 && /"recorded": true/.test(c2o.o) && c3o.code === 1, { c1: c1o.code, c2: c2o.o.slice(0, 80), c3: [c3o.code, (c3o.o + c3o.e).slice(0, 120)] });
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
