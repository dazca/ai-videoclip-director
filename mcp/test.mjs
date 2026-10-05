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
// warnings, restore, diff), shot notes and asks, gaps_get (draft requests, the estimate vs the cap); notes.json v2: the migration of
// every old note store without loss, notes_get / notes_add / notes_status, the old note tools as aliases, wait_for on a note),
// review rounds and revisions (round_get / round_absorb / round_reply / round_finish, the page-only send / close / restore, the
// compare, the opt-in mirror), proposals (proposals_add with the SVG sanitiser, proposals_get, the page-only picks, the "3 more"
// asks answered by the next set, the free local generator), final approvals (final_get, the page-only lock: a locked project
// refuses agent writes, proposals included), the review fixes (a failed request back to draft in a duplicate / restore,
// private refs uploaded only with the director's tick),
// refuses agent writes, proposals included), take selection (takes_get / take_propose; the pick is the page's, on the shot),
// the lyric gate (surfaces_get / surface_propose; accepting a surface is the page's, on the shot), chapters, placeholder frames and
// looks per world (chapters_update, look_world_propose, the worlds of scenes / shots, the gaps, Final, edl.json; E3 / E5 / E6),
// resources, the director-session prompt, the guard rules (edit voids approval, director-only approvals, media kind,
// CSRF / Host / token checks, path traversal and the PRIVATE rule) and the offline (files only) mode. The temp folder
// is removed at the end, whatever happens; data/demo must be byte-identical afterwards.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
// approvals are always the director's, in the page (review S8): the old switch is set here both ways (config
// agent_approvals: true and WB_AGENT_APPROVALS=1) to prove it is ignored; every approval below is a page save with this
// server's Origin (pageApprove), the way the Queue's Approve does it
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: ['roots/', 'refs/'], private_media: '^refs/', agent_approvals: true }));
Object.assign(process.env, { WORKBENCH_DATA: DATA, WORKBENCH_MEDIA_BASE: MB, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: PROJECT, WB_AGENT_APPROVALS: '1' });
delete process.env.WB_TOKEN; delete process.env.WB_HOST;
// the request runner (section 15) talks to a MOCK fal only (tools/mock-fal.mjs; WB_FAL_BASE counts only with WB_TEST=1):
// never the real one. The key is a random sentinel the test then greps for in every file, response and log.
const { startMockFal } = await import('../tools/mock-fal.mjs');
const FAL_KEY = `fal-test-${crypto.randomBytes(9).toString('hex')}`;
const FAL = await startMockFal({ key: FAL_KEY, polls: 2 });
Object.assign(process.env, { WB_TEST: '1', WB_FAL_BASE: FAL.url, FAL_KEY, WB_RUN_POLL_MS: '40' });
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
let srvLog = ''; srv.stdout.on('data', d => { srvLog += d; }); srv.stderr.on('data', d => { srvLog += d; });
await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
// the per-run write token, read the way the page and the MCP server get it: from the served page
const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${URL_}/?project=${PROJECT}`)).text())?.[1];
check('the page carries the per-run write token', /^[0-9a-f]{48}$/.test(TOKEN || ''), TOKEN?.length);
// the page's own requests carry its Origin and Sec-Fetch-Site: same-origin (S9): a test's { origin: URL_ } stands for the page
const pageH = (h) => (h.origin === URL_ && !('sec-fetch-site' in h) ? { ...h, 'sec-fetch-site': 'same-origin' } : h);
const post = (p, body, headers = {}) => fetch(URL_ + p, { method: 'POST', headers: pageH({ 'content-type': 'application/json', 'x-wb-token': TOKEN, ...headers }), body: typeof body === 'string' ? body : JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
// the director approves a request in the page (Review > Queue): a save of requests.json with this server's Origin
const pageApprove = (rid, proj = PROJECT) => { const cur = JSON.parse(fs.readFileSync(path.join(DATA, proj, 'requests.json'), 'utf8')); cur.items.find(r => r.id === rid).status = 'approved'; return post(`/api/save/requests.json?project=${proj}`, { base_rev: cur.rev, data: cur }, { origin: URL_ }); };

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
    'media_list', 'media_add', 'notes_list', 'note_add', 'note_resolve', 'approvals_get', 'request_changes', 'requests_list', 'request_create', 'request_update', 'costs_get', 'ui_focus',
    'stages_get', 'stage_update', 'lyrics_get', 'lyrics_update', 'lyrics_versions', 'lyrics_note_add', 'lyrics_note_resolve', 'song_attach',
    'script_get', 'scenes_update', 'scene_note_add', 'scene_note_resolve', 'intake_get', 'intake_answer', 'sketch_save', 'sketch_get', 'sketch_list',
    'breakdown_get', 'breakdown_update', 'breakdown_note_add', 'breakdown_note_resolve', 'character_get', 'character_iteration_add', 'character_note_add', 'look_create',
    'asset_get', 'asset_iteration_add', 'asset_note_add', 'variant_create',
    'storyboard_get', 'shots_update', 'shot_note_add', 'shot_note_resolve', 'gaps_get', 'notes_get', 'notes_add', 'notes_status', 'request_run', 'generators_get',
    'round_get', 'round_absorb', 'round_reply', 'round_finish', 'revisions_get', 'proposals_add', 'proposals_get', 'final_get', 'takes_get', 'take_propose', 'surfaces_get', 'surface_propose', 'media_scan', 'media_import', 'batches_get', 'waves_propose', 'events_get', 'event_add', 'retime_propose', 'interpretation_set'];
  check('tools/list has every tool', EXPECT.every(t => tools.includes(t)), { count: tools.length, missing: EXPECT.filter(t => !tools.includes(t)) });
  const schemaOk = (await mcp.listTools()).tools.every(t => t.description?.length > 40 && t.inputSchema?.type === 'object');
  check('every tool has a description and a JSON schema', schemaOk);

  const st = await call(mcp, 'status');
  check('status: server up, current project demo', st.server?.up === true && st.current_project === PROJECT && st.mode === 'http', { server: st.server, current: st.current_project, mode: st.mode });

  // 2. song_get, timeline_query
  const song = await call(mcp, 'song_get');
  check('song_get', song.duration_ms === 20000 && song.sections?.length === 4 && song.lines?.length === 9 && song.lines[1].words?.length > 3 && song.grid?.beats > 30, { title: song.title, sections: song.sections?.map(s => s.id), lines: song.lines?.length });
  const chorus = await call(mcp, 'song_get', { section: 'chorus', words: false });
  check('song_get section filter', chorus.sections?.length === 1 && chorus.lines?.every(l => l.section === 'chorus' && !l.words) && chorus.events?.some(e => e.kind === 'cue' && e.source_kind === 'drop'), { lines: chorus.lines?.length, events: chorus.events?.length });
  const tq = await call(mcp, 'timeline_query', { t0: '0:12', t1: 15000 });
  check('timeline_query across columns', tq.t0 === 12000 && tq.sections?.[0]?.id === 'chorus' && tq.shots?.some(s => s.id === 's4-chorus' && s.state === 'review') && tq.uses?.some(u => u.id === 'C3@12000')
    && tq.lines?.length >= 2 && tq.notes?.some(n => n.id === 'n02') && tq.events?.some(e => e.id === 'drop_chorus' && e.kind === 'cue') && tq.requests?.some(r => r.id === 'rdemo01') && Array.isArray(tq.bars) && tq.cast?.includes('ada'),
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
  // S8: the old switch is on in this suite's config and env, and still an agent cannot approve: no approve tool, and a
  // claimed director_approved:true is refused over MCP, over HTTP and offline, with a 403 that points to the page
  const aFlag = await call(mcp, 'request_update', { id: rq.id, status: 'approved', director_approved: true, by: 'director' });
  const aHttp = await post(`/api/op/request_update?project=${PROJECT}`, { id: rq.id, status: 'approved', director_approved: true, by: 'director' });
  let aOff = null; try { S.ops.request_update(PROJECT, { id: rq.id, status: 'approved', director_approved: true }); aOff = 200; } catch (e) { aOff = e.code; }
  const toolNames = (await mcp.listTools()).tools.map(t => t.name);
  check('S8: agent_approvals: true (config) and WB_AGENT_APPROVALS=1 are ignored (the server warns once); an agent cannot approve through any tool (no approve tool; request_update director_approved: MCP / HTTP / offline 403, pointing to the page)',
    /403/.test(aFlag.error || '') && /in the open page/.test(aFlag.error || '') && aHttp.status === 403 && aOff === 403 && !toolNames.includes('approve')
    && (srvLog.match(/agent_approvals" \/ WB_AGENT_APPROVALS is ignored/g) || []).length === 1
    && JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')).items.find(r => r.id === rq.id).status === 'draft', { mcp: aFlag.error, http: aHttp.status, offline: aOff, warned: /is ignored/.test(srvLog) });
  const a1p = await pageApprove(rq.id), a1 = { request: a1p.status === 200 ? JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')).items.find(r => r.id === rq.id) : null };
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
  await pageApprove(big.id);
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
  await pageApprove(g1.id);
  const keepApproved = await call(mcp, 'request_update', { id: g1.id, status: 'approved', prompt: 'guard: EXPENSIVE', est_cost: 9 });
  const editQueue = await call(mcp, 'request_update', { id: g1.id, status: 'queued', prompt: 'guard: different', est_cost: 5 });
  const editOnly = await call(mcp, 'request_update', { id: g1.id, prompt: 'guard: edited' });
  check('an edit voids the approval (edit + status in one call refused; edit alone -> draft)', /409/.test(keepApproved.error || '') && /409/.test(editQueue.error || '') && editOnly.request?.status === 'draft' && editOnly.request?.est_cost === 0.1,
    { keepApproved: keepApproved.error, editQueue: editQueue.error, after: editOnly.request?.status });
  const sneaky = await post(`/api/op/request_create?project=${PROJECT}`, { kind: 'generate', est_cost: 0, extra: { status: 'approved', id: 'x', note: 'kept' } });
  check('request_create: extra cannot set status / id', sneaky.status === 200 && sneaky.body.status === 'draft' && sneaky.body.id !== 'x' && sneaky.body.note === 'kept', sneaky.body);
  const ap0 = await call(mcp, 'approve', { keys: ['shot:s2-wall'] });
  const lock0 = await call(mcp, 'shot_update', { id: 's2-wall', status: 'locked' });
  const ap1 = await post(`/api/op/set_states?project=${PROJECT}`, { keys: ['shot:s2-wall'], state: 'approved', director_approved: true, by: 'director' });
  const lock1 = await call(mcp, 'shot_update', { id: 's2-wall', status: 'locked', director_approved: true });
  const apC = JSON.parse(fs.readFileSync(path.join(D, 'approvals.json'), 'utf8')); apC.items['shot:s4-chorus'] = { ...(apC.items['shot:s4-chorus'] || {}), state: 'approved' };   // (s4-chorus: in review)
  const apPage = await post(`/api/save/approvals.json?project=${PROJECT}`, { base_rev: apC.rev, data: apC }, { origin: URL_ });
  const apState = (await call(mcp, 'approvals_get', { keys: ['shot:s4-chorus'] })).items['shot:s4-chorus'];
  const bogus = await post(`/api/op/set_states?project=${PROJECT}`, { keys: ['shot:s2-wall'], state: 'bogus' });
  check('approve / lock are the page\'s: no approve tool, set_states approved and shot_update locked 403 even with director_approved; the page approves (via page); unknown states refused', /not found|unknown|no such/i.test(ap0.error || '') && /403/.test(lock0.error || '') && ap1.status === 403 && /in the open page/.test(ap1.body?.error || '') && /403/.test(lock1.error || '')
    && apPage.status === 200 && apState?.state === 'approved' && apState?.via === 'page' && bogus.status === 400,
    { ap0: ap0.error, ap1: ap1.status, lock1: lock1.error, page: apPage.status, state: apState, bogus: bogus.status });
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
  const pageSees = await pageHas((id, s) => s ? s.files.includes('notes.json') : window.WB.store.notes?.notes?.some(n => n.id === id && n.target.stage === 'lyrics' && n.target.id === 'verse/1'), ln.id);
  const v2 = JSON.parse(fs.readFileSync(path.join(D, 'notes.json'), 'utf8')).notes.find(n => n.id === ln.id);
  check('lyrics_note_add on a word range (quote -> [first, last]); writes notes.json v2 (lyrics.json and song.json untouched); the page sees it live', ln.id === 'ln01' && JSON.stringify(ln.w) === '[2,3]' && ln.via === 'agent' && fs.readFileSync(path.join(D, 'song.json'), 'utf8') === songBefore && !fs.existsSync(path.join(D, 'lyrics.json'))
    && v2?.target?.kind === 'line' && JSON.stringify(v2.target.w) === '[2,3]' && v2.target.quote === 'the note' && pageSees,
    { id: ln.id, w: ln.w, via: ln.via, pageSees });
  // a lyrics-only project through the projects tool, then edits, diff, restore, stage rules, the song attached later
  const NP = 'mcp-lyrics';
  const cr = await call(mcp, 'projects', { action: 'create', id: NP, title: 'MCP Lyrics', lyrics: '[Verse 1]\nfirst line here\nsecond line there\n\n[Chorus]\nla la la' });
  const g1 = await call(mcp, 'lyrics_get', { project: NP });
  const st1 = await call(mcp, 'stages_get', { project: NP });
  check('projects create with lyrics: v1, placeholder duration, estimated timings, lyrics stage in progress', cr.lines === 3 && g1.current === 'v1' && g1.song?.has_audio === false && g1.song?.placeholder_duration === true && g1.sections?.[0]?.lines?.[0]?.timing === 'estimated'
    && st1.stages?.[0]?.status === 'in_progress' && (st1.stages?.[0]?.content?.hints || []).some(b => /no song/.test(b)), { cr, song: g1.song, lyrics: st1.stages?.[0] });
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
    && ig2.questions.find(q => q.id === 'mood').via === 'agent' && ig2.questions.find(q => q.id === 'mood').by === 'agent' /* review #3 L3: never signed "director" by an agent */ && !!ig2.questions.find(q => q.id === 'who').asked_in_chat && pageIntake,
    { unanswered: ig2.unanswered, bad: ib.error, pageIntake });
  // E10: the agent's interpretation next to the verbatim answer: written via "agent" (status proposed), never the answer's
  // text; no tool accepts it, and interpretation_act without the page is 403 (also claiming via "page"); a question
  // without an answer has nothing to interpret (409); the director accepts / edits in the page; an edited one is theirs (409)
  {
    const tools = (await mcp.listTools()).tools.map(t => t.name);
    const iset = await call(mcp, 'interpretation_set', { key: 'mood', text: 'mcp: high-key light, saturated primaries, quick cuts on the bar', by: 'claude' });
    const inone = await call(mcp, 'interpretation_set', { key: 'era', text: 'x' });
    const iget = await call(mcp, 'intake_get'), mood = iget.questions?.find(q => q.id === 'mood');
    const agentAct = await post(`/api/op/interpretation_act?project=${PROJECT}`, { key: 'mood', act: 'accept' });
    const claimed = await post(`/api/op/interpretation_act?project=${PROJECT}`, { key: 'mood', act: 'accept', via: 'page' });
    const sc = JSON.parse(fs.readFileSync(path.join(D, 'scenes.json'), 'utf8'));
    // an agent's save of scenes.json cannot forge "accepted" either: the server keeps its own interpretation
    const forged = JSON.parse(JSON.stringify(sc)); forged.intake.mood.interpretation = { ...forged.intake.mood.interpretation, status: 'accepted', text: 'forged' };
    const fsave = await fetch(`${URL_}/api/save/scenes.json?project=${PROJECT}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN }, body: JSON.stringify({ base_rev: sc.rev, data: forged }) }).then(r => r.status);
    const after = JSON.parse(fs.readFileSync(path.join(D, 'scenes.json'), 'utf8')).intake.mood;
    const pageAcc = await post(`/api/op/interpretation_act?project=${PROJECT}`, { key: 'mood', act: 'accept' }, { origin: URL_ });
    const pageEd = await post(`/api/op/interpretation_act?project=${PROJECT}`, { key: 'mood', act: 'edit', text: 'bright, playful, primaries; cut on every bar' }, { origin: URL_ });
    const again = await call(mcp, 'interpretation_set', { key: 'mood', text: 'mcp: overwrite' });
    const fin = (await call(mcp, 'intake_get')).questions.find(q => q.id === 'mood');
    check('E10 interpretation_set: under the verbatim answer, marked the agent\'s (via agent, proposed), the answer untouched; nothing to interpret without an answer (409); no tool accepts, interpretation_act without the page 403 (also via "page"); an agent save cannot forge accepted; the director accepts / edits in the page; an edited one is theirs (409)',
      tools.includes('interpretation_set') && !tools.includes('interpretation_act') && !iset.error && mood?.answer === 'mcp: bright and playful' && mood?.interpretation?.via === 'agent' && mood.interpretation.by === 'claude' && mood.interpretation.status === 'proposed'
      && /409/.test(inone.error || '') && agentAct.status === 403 && claimed.status === 403 && after.interpretation?.status === 'proposed' && after.interpretation?.text !== 'forged'
      && pageAcc.status === 200 && pageAcc.body?.interpretation?.status === 'accepted' && pageEd.status === 200 && pageEd.body?.interpretation?.status === 'edited' && pageEd.body.interpretation.agent_text?.startsWith('mcp: high-key')
      && /409/.test(again.error || '') && fin.interpretation?.text === 'bright, playful, primaries; cut on every bar' && fin.answer === 'mcp: bright and playful',
      { iset: iset.error, inone: inone.error, mood: mood?.interpretation, agentAct: agentAct.status, claimed: claimed.status, fsave, after: after.interpretation?.status, pageAcc: pageAcc.status, pageEd: pageEd.status, again: again.error });
  }
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
  const ps = await post(`/api/save/scenes.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur }, { origin: URL_ });
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
  const ps = await post(`/api/save/breakdown.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur }, { origin: URL_ });
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
  const approveInPage = async (rid) => { const cur = JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')); cur.items.find(r => r.id === rid).status = 'approved'; return post(`/api/save/requests.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur }, { origin: URL_ }); };
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
  const approveInPage = async (rid) => { const cur = JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')); cur.items.find(r => r.id === rid).status = 'approved'; return post(`/api/save/requests.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur }, { origin: URL_ }); };
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

// 11h. notes: ONE model (notes.json v2) for every stage and the timeline. The old stores migrate on first read without loss
// (the old files untouched; notes.json v1 kept as notes.v1.json); notes_get / notes_add / notes_status; the old tools as
// aliases answering in the old shapes; a note added to an old store later is imported once; wait_for on any note
{
  // the demo: its v1 notes.json became v2 on the page's first read, kept byte-identical as notes.v1.json
  const dv = JSON.parse(fs.readFileSync(path.join(D, 'notes.json'), 'utf8'));
  check('demo: notes.json migrated to v2 on first read, the v1 file kept byte-identical as notes.v1.json; its notes keep their ids, time and author',
    dv.v === 2 && fs.readFileSync(path.join(D, 'notes.v1.json'), 'utf8') === fs.readFileSync(path.join(ORIG, 'notes.json'), 'utf8') && dv.notes.some(n => n.id === 'n02' && n.target.stage === 'timeline' && n.target.t === 12000 && n.target.line === 'chorus/0' && n.by === 'director' && n.via === 'page' && n.legacy?.store === 'notes'),
    { v: dv.v, n02: dv.notes.find(n => n.id === 'n02') });
  // a project whose notes are still in the old stores: notes.json v1 (with a reply note), lyrics / scenes / breakdown /
  // storyboard notes, and two characters' iter.notes with the same id
  const MP = 'mcp-notes';
  S.duplicateProject(PROJECT, MP);
  const MD = path.join(DATA, MP), J = (f) => JSON.parse(fs.readFileSync(path.join(MD, f), 'utf8')), W = (f, v) => fs.writeFileSync(path.join(MD, f), JSON.stringify(v, null, 1));
  fs.rmSync(path.join(MD, 'notes.v1.json'), { force: true });
  const at = '2026-10-01T10:00:00';
  const ly = S.lyricsDoc(MP); delete ly.derived;
  ly.notes = [{ id: 'ln01', line: 'verse/1', w: [2, 3], quote: 'the note', text: 'old lyric note', by: 'director', via: 'page', status: 'open', at, replies: [{ id: 'ln01.1', text: 'agent answer', by: 'agent', via: 'agent', at }] },
    { id: 'ln02', line: null, w: null, quote: '', text: 'old ask for the agent', to: 'agent', kind: 'request', by: 'director', via: 'page', status: 'resolved', at, replies: [] }];
  W('lyrics.json', ly);
  const sc = S.scenesDoc(MP); delete sc.derived;
  const beat = sc.versions.at(-1).scenes.find(s => s.id === 'sc02')?.beats[0]?.id;
  sc.notes = [{ id: 'sn01', scene: 'sc02', beat, text: 'old beat note', by: 'director', via: 'page', status: 'open', at, replies: [] },
    { id: 'sn02', scene: null, text: 'fill', to: 'agent', kind: 'fill_gaps', gaps: [[0, 1000]], by: 'director', via: 'page', status: 'open', at, replies: [] }];
  W('scenes.json', sc);
  W('breakdown.json', { rev: 3, current: 'v1', versions: [{ id: 'v1', created: at, by: 'director', via: 'page', message: '', items: [{ id: 'bi01', kind: 'character', name: 'Ada', description: '', links: [{ scene: 'sc02', beats: [] }], source: 'director' }] }], states: {},
    notes: [{ id: 'bn01', item: 'bi01', text: 'old item note', by: 'agent', via: 'agent', status: 'open', at, replies: [] }, { id: 'bn02', item: null, scene: 'sc02', text: 'old scene note', by: 'director', via: 'page', status: 'open', at, replies: [] }] });
  const sb = S.boardDoc(MP); delete sb.derived;
  sb.notes = [{ id: 'sbn01', shot: 's2-wall', scene: 'sc02', text: 'old shot note', by: 'director', via: 'page', status: 'open', at, replies: [] }]; W('storyboard.json', sb);
  for (const [id, note] of [['ada', { id: 'cn01', tree: 'identity', text: 'old tree note', by: 'director', via: 'page', status: 'open', at, replies: [] }], ['bo', { id: 'cn01', text: 'old asset note', by: 'agent', via: 'agent', status: 'resolved', at, replies: [] }]]) {
    const f = `entities/characters/${id}.json`, e = J(f); e.iter = { nodes: [], trees: {}, notes: [note], log: [] }; W(f, e);
  }
  const v1 = { rev: 4, notes: [{ id: 'n01', t: 4000, line_id: 'verse/0', by: 'director', text: 'old timeline note', status: 'open', at },
    { id: 'n02', t: 4000, line_id: 'verse/0', by: 'agent', via: 'agent', text: 'old reply', status: 'resolved', at, reply_to: 'n01' },
    { id: 'n03', t: 12000, line_id: null, by: 'director', text: '◆ marker', kind: 'marker', status: 'resolved', at }] };
  W('notes.json', v1);
  const OLD = ['lyrics.json', 'scenes.json', 'breakdown.json', 'storyboard.json', 'entities/characters/ada.json', 'entities/characters/bo.json'], hash0 = Object.fromEntries(OLD.map(f => [f, fs.readFileSync(path.join(MD, f), 'utf8')]));
  const all = await call(mcp, 'notes_get', { project: MP, status: 'all' }), by = (id) => all.notes?.find(n => n.id === id);
  const v2 = J('notes.json');
  check('migration: every old note in v2 once (11: a v1 reply folded into its note), targets per stage (line + word range, beat, item, scene, shot, tree, asset), status (resolved -> absorbed), author, via, asks and gaps kept; ids kept (a clash renamed)',
    v2.v === 2 && v2.rev === 5 && all.notes?.length === 11 && by('n01')?.replies?.[0]?.text === 'old reply' && by('n01').replies[0].via === 'agent' && by('n03')?.marker === true && by('n03').status === 'absorbed'
    && JSON.stringify(by('ln01')?.target) === JSON.stringify({ stage: 'lyrics', kind: 'line', id: 'verse/1', w: [2, 3], quote: 'the note' }) && by('ln01').replies.length === 1 && by('ln02')?.to === 'agent' && by('ln02').ask === 'request' && by('ln02').status === 'absorbed'
    && by('sn01')?.target.kind === 'beat' && by('sn01').target.id === `sc02/${beat}` && by('sn02')?.ask === 'fill_gaps' && JSON.stringify(by('sn02').gaps) === '[[0,1000]]'
    && by('bn01')?.target.kind === 'item' && by('bn01').via === 'agent' && by('bn02')?.target.kind === 'scene' && by('sbn01')?.target.id === 's2-wall' && by('sbn01').target.scene === 'sc02'
    && by('cn01')?.target.id === 'ada/identity' && by('cn01').target.stage === 'characters' && by('cn01-2')?.target.id === 'bo' && by('cn01-2').status === 'absorbed' && by('cn01-2').via === 'agent'
    && all.notes.every(n => n.legacy?.store && n.created === at && n.round === 1),
    { n: all.notes?.length, ids: all.notes?.map(n => n.id), rev: v2.rev, open: all.open });
  check('migration: the old files are untouched (byte-identical), the v1 notes.json is kept as notes.v1.json; a second read imports nothing',
    OLD.every(f => fs.readFileSync(path.join(MD, f), 'utf8') === hash0[f]) && JSON.stringify(J('notes.v1.json')) === JSON.stringify(v1) && (await call(mcp, 'notes_get', { project: MP, status: 'all' })).notes.length === 11 && J('notes.json').rev === 5,
    { untouched: OLD.filter(f => fs.readFileSync(path.join(MD, f), 'utf8') === hash0[f]).length });
  // the old tools answer in the old shapes from v2
  const lg = await call(mcp, 'lyrics_get', { project: MP, notes: 'all' }), sg = await call(mcp, 'script_get', { project: MP }), bg = await call(mcp, 'breakdown_get', { project: MP, with_script: false, notes: 'all' });
  const sbg = await call(mcp, 'storyboard_get', { project: MP }), ag = await call(mcp, 'asset_get', { project: MP, type: 'character', id: 'ada' }), nl = await call(mcp, 'notes_list', { project: MP });
  check('the old tools read v2 in their old shapes: lyrics_get (line, w, quote, resolved), script_get asks (fill_gaps + gaps), breakdown_get, storyboard_get, asset_get (tree), notes_list (a reply row with reply_to)',
    lg.notes?.some(n => n.id === 'ln01' && n.line === 'verse/1' && JSON.stringify(n.w) === '[2,3]' && n.status === 'open') && lg.notes.some(n => n.id === 'ln02' && n.status === 'resolved')
    && sg.asks_for_agent?.some(a => a.id === 'sn02' && a.kind === 'fill_gaps' && a.gaps) && sg.notes?.some(n => n.id === 'sn01' && n.scene === 'sc02' && n.beat === beat)
    && bg.notes?.some(n => n.id === 'bn01' && n.item === 'bi01') && bg.notes.some(n => n.id === 'bn02' && n.scene === 'sc02') && sbg.notes?.some(n => n.id === 'sbn01' && n.shot === 's2-wall')
    && ag.notes?.some(n => n.id === 'cn01' && n.tree === 'identity') && nl.some(n => n.id === 'n01') && nl.some(n => n.reply_to === 'n01' && n.text === 'old reply'),
    { lg: lg.notes?.map(n => n.id), asks: sg.asks_for_agent?.map(a => a.id), bg: bg.notes?.map(n => n.id), sb: sbg.notes?.map(n => n.id), ag: ag.notes?.map(n => n.id), nl: nl.map(n => n.id) });
  // a note added to an old store later (an older page, a hand edit) is imported once; one the director deleted is not
  const cur = J('notes.json'); cur.notes = cur.notes.filter(n => n.id !== 'bn02');
  const del = await post(`/api/save/notes.json?project=${MP}`, { base_rev: cur.rev, data: cur }, { origin: URL_ });
  const sc2 = J('scenes.json'); sc2.notes.push({ id: 'sn03', scene: 'sc01', text: 'added later by hand', by: 'director', via: 'page', status: 'open', at, replies: [] }); sc2.rev++; W('scenes.json', sc2);
  const bd2 = J('breakdown.json'); bd2.rev++; W('breakdown.json', bd2);   // touched: re-checked, bn02 stays deleted
  const again = await call(mcp, 'notes_get', { project: MP, status: 'all' });
  check('incremental: a note added to scenes.json later is imported once; a migrated note the director deleted (bn02) is not brought back',
    del.status === 200 && again.notes.filter(n => n.id === 'sn03').length === 1 && !again.notes.some(n => n.id === 'bn02') && (await call(mcp, 'notes_get', { project: MP, status: 'all' })).notes.length === again.notes.length,
    { del: del.status, n: again.notes.length });
  // the one model's tools: a note on every stage's rows, a reply, absorb / dismiss / reopen, the asks, the counts
  const add = (target, text) => call(mcp, 'notes_add', { project: MP, target, text });
  const made = {
    line: await add({ stage: 'lyrics', kind: 'line', id: 'verse/0', quote: 'colour' }, 'mcp: a word'), section: await add({ stage: 'lyrics', kind: 'section', id: 'chorus' }, 'mcp: the chorus'),
    scene: await add({ stage: 'script', kind: 'scene', id: 'sc01' }, 'mcp: a scene'), beat: await add({ stage: 'script', kind: 'beat', id: `sc02/${beat}` }, 'mcp: a beat'),
    item: await add({ stage: 'breakdown', kind: 'item', id: 'bi01' }, 'mcp: an item'), asset: await add({ stage: 'characters', kind: 'asset', id: 'ada', pin: { x: 0.25, y: 0.5 } }, 'mcp: a pin'),
    tree: await add({ stage: 'characters', kind: 'tree', id: 'ada/identity' }, 'mcp: a tree'), use: await add({ stage: 'characters', kind: 'use', id: 'ada/sc02' }, 'mcp: in a scene'),
    shot: await add({ stage: 'storyboard', kind: 'shot', id: 's2-wall' }, 'mcp: a shot'), final: await add({ stage: 'final', kind: 'shot', id: 's1-intro' }, 'mcp: final'),
    time: await add({ stage: 'timeline', kind: 'time', t: '0:09.500' }, 'mcp: a time'), whole: await add({ stage: 'storyboard', kind: 'stage' }, 'mcp: the storyboard'),
  };
  const rep = await call(mcp, 'notes_add', { project: MP, reply_to: 'ln01', text: 'mcp: a reply' });
  const abs = await call(mcp, 'notes_status', { project: MP, id: 'ln01', status: 'absorbed', reply: 'mcp: rewritten in v2' });
  const disD = await call(mcp, 'notes_status', { project: MP, id: 'sbn01', status: 'dismissed' });
  const disA = await call(mcp, 'notes_status', { project: MP, id: made.shot.id, status: 'dismissed' });
  const reo = await call(mcp, 'notes_status', { project: MP, id: 'ln01', status: 'open' });
  const og = await call(mcp, 'notes_get', { project: MP, stage: 'characters' }), ga = await call(mcp, 'notes_get', { project: MP, to: 'agent' });
  check('notes_add on every stage\'s rows (a line + quote -> w, a section, a scene, a beat, an item, an asset + pin, a tree, a use, a shot, a final shot, a time given as m:ss, a stage), via agent, round 1, with where / time; a reply; absorbed with a reply; the director\'s note not dismissable (403), the agent\'s own is; reopen',
    Object.values(made).every(n => n.id && n.via === 'agent' && n.status === 'open' && n.round === 1 && n.where) && JSON.stringify(made.line.target.w) === '[3,3]' && made.time.target.t === 9500 && made.time.t === 9500 && made.line.t != null && made.beat.t != null
    && made.asset.target.pin?.x === 0.25 && rep.reply?.id === 'ln01.2' && abs.note?.status === 'absorbed' && abs.note.replies.length === 3 && /403/.test(disD.error || '') && disA.note?.status === 'dismissed' && reo.note?.status === 'open'
    && og.notes.length >= 3 && og.open.stages.characters >= 3 && ga.notes.some(n => n.id === 'sn02'),
    { made: Object.fromEntries(Object.entries(made).map(([k, n]) => [k, n.id || n.error])), rep: rep.reply?.id, abs: abs.note?.status, disD: disD.error, disA: disA.note?.status || disA.error, open: og.open });
  // wait_for on any stage's note: returns at once when it already is in until; wakes on a reply
  const wf = await call(mcp, 'wait_for', { project: MP, note: made.scene.id, until: ['open'] });
  const wfP = call(mcp, 'wait_for', { project: MP, note: made.scene.id, timeout_s: 20 });
  await wait(600); await call(mcp, 'notes_add', { project: MP, reply_to: made.scene.id, text: 'mcp: woke' });
  const wf2 = await wfP;
  check('wait_for note: any stage\'s note (already open: at once; a reply wakes it)', wf.already === true && wf.status === 'open' && wf2.changed === true && wf2.item?.replies?.length === 1, { wf, wf2: wf2 && { changed: wf2.changed, waited: wf2.waited_s } });
  // stages_get counts the asks from v2; a duplicate "as a template" starts with no notes (the old stores' notes stay seen)
  const stg = await call(mcp, 'stages_get', { project: MP });
  const dup = await call(mcp, 'projects', { action: 'duplicate', from: MP, id: 'mcp-notes-tpl', reset_state: true });
  const dn = await call(mcp, 'notes_get', { project: 'mcp-notes-tpl', status: 'all' });
  check('stages_get counts the open asks from notes.json v2; a duplicate with reset_state starts with no notes (nothing re-imported from the copied old stores)',
    stg.facts?.sceneAsks === 1 && stg.facts?.agentAsks === 0 && dup.id === 'mcp-notes-tpl' && dn.notes?.length === 0, { asks: [stg.facts?.sceneAsks, stg.facts?.agentAsks], dup: dup.id || dup.error, n: dn.notes?.length });
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
  await pageApprove(r.id, 'nt');
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
  const approveInPageW = async (rid) => { const cur = JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')); cur.items.find(r => r.id === rid).status = 'approved'; return post(`/api/save/requests.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur }, { origin: URL_ }); };
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

  // ---- the looks dogfood (DOGFOOD_looks.md): a character-agnostic recipe from the entity's constants, the identity lock
  // never dropped silently, fields vs blocks, takes in the estimate, recipe.identity on update, withdrawn, the cost split
  // per take, the falgen link warning and the Settings field, wait_for on several requests, a queued ui_focus
  {
    await call(mcp, 'entity_upsert', { kind: 'character', id: 'bram', name: 'Bram', fields: { role: 'the bus driver', constants: ['a silver ring on the LEFT ring finger', 'a scar through the right eyebrow'] } });
    const bramAsset = { type: 'character', id: 'bram', tree: 'identity', kind: 'identity' };
    const m1 = await callW(mcp, 'request_create', { kind: 'identity-sheet', refs: ['media/still/bo_face.jpg'], asset: bramAsset,
      recipe: { subject: 'Bram, a man in his fifties with short grey hair', wardrobe: 'a navy wool driver jacket', action: 'he leans on the bus door, tired', place: 'the same depot as before, oil stains, a timetable board',
        light: 'sodium lamps overhead, orange, hard. The same light falls on the subject and the place.', texture: 'wool pilling and grey stubble', takes: 2, blocks: { identity_lock: 'Keep his face exactly as in Image 1, with the scar.' } } });
    const p1 = m1.r.prompt || '', blk = (r, id) => r.recipe?.blocks?.find(b => b.id === id)?.text || '';
    const m2 = await callW(mcp, 'request_create', { kind: 'identity-sheet', refs: ['media/still/bo_face.jpg'], asset: bramAsset, recipe: { wardrobe: 'a navy wool driver jacket', action: 'he waits', place: 'a depot', light: 'sodium lamps' } });
    check('looks: the recipe is character-agnostic (Bram\'s name and constants, no "her / woman"); an identity_lock block given while identity is false is ADDED with a warning (never dropped); without it a character request warns "no identity lock"; texture keeps the skin sentence + the field; the light sentence is not doubled; "Location: the same …" keeps its case; takes 2 = est $0.24',
      /Bram, a man in his fifties/.test(p1) && !/\b(her|she|woman)\b/i.test(p1) && /Keep his face exactly as in Image 1, with the scar\./.test(p1) && m1.r.warnings?.some(w => /block "identity_lock" was not built/.test(w))
      && /silver ring on the LEFT ring finger/.test(blk(m1.r, 'constants')) && /pores, fine lines/.test(blk(m1.r, 'texture')) && /wool pilling and grey stubble/.test(blk(m1.r, 'texture'))
      && (blk(m1.r, 'light').match(/same light falls on/gi) || []).length === 1 && /^Location: the same depot/.test(blk(m1.r, 'location')) && m1.r.est_cost === 0.24 && m1.r.takes === 2 && m1.r.recipe?.takes === 2
      && m2.r.warnings?.some(w => /^no identity lock: image 1 is not Bram's approved identity/.test(w)) && !/\b(her|she|woman)\b/i.test(m2.r.prompt || ''),
      { p1: p1.slice(0, 300), w1: m1.r.warnings, w2: m2.r.warnings, est: m1.r.est_cost, light: blk(m1.r, 'light'), loc: blk(m1.r, 'location') });
    const u2 = await call(mcp, 'request_update', { id: m2.r.id, recipe: { identity: true, takes: 3 } });
    const id2 = u2.request || {};
    check('looks: request_update recipe.identity: true rebuilds the references + the identity lock (with the constants), drops the "no identity lock" warning; recipe.takes 3 re-estimates ($0.36) and sets takes',
      /Image 1 is Bram, the approved identity/.test(id2.prompt || '') && /Keep the face exactly as in Image 1/.test(id2.prompt) && /scar through the right eyebrow/.test(blk(id2, 'identity_lock')) && id2.recipe?.identity === true
      && !(id2.warnings || []).some(w => /no identity lock/.test(w)) && id2.est_cost === 0.36 && id2.takes === 3, { prompt: (id2.prompt || u2.error || '').slice(0, 260), warnings: id2.warnings, est: id2.est_cost, takes: id2.takes });

    // wait_for several requests: returns on the first that changes (the agent withdraws its own obsolete draft)
    const waitMany = call(mcp, 'wait_for', { requests: [m1.r.id, m2.r.id], timeout_s: 20 });
    await wait(600);
    const wd = await call(mcp, 'request_update', { id: m2.r.id, status: 'withdrawn', why: 'superseded by the sheet with the identity lock', superseded_by: [m1.r.id] });
    const wm = await waitMany;
    const wdBad = await call(mcp, 'request_update', { id: m1.r.id, superseded_by: ['x'] });
    // a director's own draft (the page): the agent cannot withdraw it; the page withdraws its own, and cannot withdraw the agent's
    const cur = JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8'));
    cur.items.push({ id: 'rdirector1', kind: 'generate', target: null, prompt: 'the director\'s idea', refs: [], est_cost: 0.12, status: 'draft', by: 'director', at: new Date().toISOString().slice(0, 19) });
    const sv = await post(`/api/save/requests.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur }, { origin: URL_ });
    const agW = await call(mcp, 'request_update', { id: 'rdirector1', status: 'withdrawn' });
    const c2 = JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8'));
    c2.items.find(r => r.id === m1.r.id).status = 'withdrawn';
    const pgBad = await post(`/api/save/requests.json?project=${PROJECT}`, { base_rev: c2.rev, data: c2 }, { origin: URL_ });
    const c3 = JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8'));
    c3.items.find(r => r.id === 'rdirector1').status = 'withdrawn';
    const pgOk = await post(`/api/save/requests.json?project=${PROJECT}`, { base_rev: c3.rev, data: c3 }, { origin: URL_ });
    const ql = await call(mcp, 'requests_list', { status: 'withdrawn' });
    check('looks: withdrawn: the agent withdraws its own draft (why + superseded_by), distinct from rejected; superseded_by needs withdrawn (400); the agent cannot withdraw the director\'s draft (403); the page withdraws the director\'s own (stamped page) but not an agent\'s (400); wait_for {requests} returns on the first change (changed_ids)',
      wd.request?.status === 'withdrawn' && wd.request.superseded_by?.[0] === m1.r.id && wd.request.log.at(-1).status === 'withdrawn' && /400/.test(wdBad.error || '') && sv.status === 200 && /403/.test(agW.error || '')
      && pgBad.status === 400 && pgOk.status === 200 && ql.some(r => r.id === 'rdirector1' && r.log.at(-1).via === 'page') && wm.changed === true && wm.changed_ids?.join() === m2.r.id && wm.statuses?.[m2.r.id] === 'withdrawn',
      { wd: wd.request?.status || wd.error, wdBad: wdBad.error, agW: agW.error, pg: [sv.status, pgBad.status, pgBad.body?.error, pgOk.status], wm: { changed_ids: wm.changed_ids, error: wm.error } });

    // a job of 2 takes (falgen HV9, $0.24): each take's import proposal carries its share ($0.12), so they sum to the job once
    for (const k of [0, 1]) { fs.copyFileSync(path.join(D, 'media', 'still', 'ada_face.jpg'), path.join(D, 'media', 'still', `hv9_${k}.jpg`)); await call(mcp, 'media_add', { path: `media/still/hv9_${k}.jpg`, kind: 'sheet', job: 'HV9', take: k, entities: ['ada'] }); }
    await call(mcp, 'cost_record', { usd: 0.24, via: 'falgen', job: 'HV9', tool: 'fal-ai/nano-banana-2/edit' });
    const pr = []; for (const k of [0, 1]) pr.push((await call(mcp, 'node_import_propose', { id: 'ada', tree: 'look:night-out', media: `media/still/hv9_${k}.jpg`, why: `HV9 take ${k}` })).proposal?.provenance?.cost);
    check('looks: alternative takes of one job split its cost per take in their provenance ($0.12 each of the $0.24 job, takes 2): summing them gives the job once',
      pr.every(c => c?.usd === 0.12 && c.job_usd === 0.24 && c.takes === 2) && pr[0].take === 0 && pr[1].take === 1, pr);

    // the falgen link: not linked but a gen/spent.json near the project -> a warning naming it; the Settings field links it
    const nf = await callW(mcp, 'costs_get');
    const readSt = () => { try { return JSON.parse(fs.readFileSync(path.join(D, 'settings.json'), 'utf8')); } catch (e) { return { rev: 0, keybindings: {} }; } }, st0 = readSt();
    const ssv = await post(`/api/save/settings.json?project=${PROJECT}`, { base_rev: st0.rev || 0, data: { ...st0, falgen: 'proj/gen' } });
    const lf = await callW(mcp, 'costs_get');
    const st1 = readSt(); delete st1.falgen;
    await post(`/api/save/settings.json?project=${PROJECT}`, { base_rev: st1.rev || 0, data: st1 });
    check('looks: costs_get with no falgen link: falgen.linked false + a warning naming the proj/gen/spent.json found near the project (its spend not counted); Settings > costs (settings.json falgen) links it: counted, from settings.json',
      nf.r.falgen?.linked === false && nf.r.falgen.candidates?.includes('proj/gen') && /falgen: not configured, but proj\/gen\/spent\.json exists/.test(nf.warn) && ssv.status === 200
      && lf.r.falgen?.linked === true && lf.r.falgen.from === 'settings.json' && lf.r.sources.some(s => s.id === 'falgen') && !/not configured/.test(lf.warn) && lf.r.total_spent_usd > nf.r.total_spent_usd,
      { nf: [nf.r.falgen, nf.warn.slice(0, 160)], lf: [lf.r.falgen?.from, lf.r.total_spent_usd, nf.r.total_spent_usd], ssv: ssv.status });

    // ui_focus with no page open on a project: queued, then shown by the next page that opens it
    const uf = await call(mcp, 'ui_focus', { project: 'nt', view: 'queue', message: 'verify: the queue' });
    const got = await new Promise((ok) => { const ctl = new AbortController(); const t = setTimeout(() => { ctl.abort(); ok(null); }, 4000); let buf = '';
      fetch(`${URL_}/api/events?project=nt`, { signal: ctl.signal }).then(async (r) => { const rd = r.body.getReader(); for (;;) { const x = await rd.read(); if (x.done) break; buf += Buffer.from(x.value).toString(); const m = /data: (\{.*"ui".*\})/.exec(buf); if (m) { clearTimeout(t); ctl.abort(); ok(JSON.parse(m[1])); break; } } }).catch(() => {}); });
    check('looks: ui_focus with no page open is queued (queued: true) and delivered to the next page that opens the project (queued_at)', uf.queued === true && uf.pages === 0 && got?.ui?.view === 'queue' && !!got.ui.queued_at, { uf, got });
  }

  // a stale server: a copy of the code where lib/ops/core.mjs differs (it does not know media_update) on its own port
  const OLD = path.join(TMP, 'oldcode'), P2 = PORT + 1;
  for (const p of ['serve.mjs', 'index.html', 'dock.html', 'app.js', 'app.css', 'lib', 'generators', 'js', 'tabs', 'core', 'templates', 'exporters/composition-data.mjs']) fs.cpSync(path.join(WB, p), path.join(OLD, p), { recursive: true });
  const sf = path.join(OLD, 'lib', 'ops', 'core.mjs'); fs.writeFileSync(sf, fs.readFileSync(sf, 'utf8').replace('  media_update(p, {', '  media_update_was(p, {'));
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
// 15. the request runner (ROADMAP_v4 D3a + D9: lib/run.mjs, generators/, request_run, generators_get) on the MOCK fal
{
  const texts = [];
  const callT = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); const t = (r.content || []).map(c => c.text).join('\n'); texts.push(t); let j; try { j = JSON.parse(r.content?.[0]?.text || ''); } catch (e) { j = r.content?.[0]?.text; } return r.isError ? { error: t } : j; };
  const approveP = async (rid) => { const cur = JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')); cur.items.find(r => r.id === rid).status = 'approved'; return post(`/api/save/requests.json?project=${PROJECT}`, { base_rev: cur.rev, data: cur }, { origin: URL_ }); };
  const reqOf = (id) => JSON.parse(fs.readFileSync(path.join(D, 'requests.json'), 'utf8')).items.find(r => r.id === id);
  const costsF = () => JSON.parse(fs.readFileSync(path.join(D, 'costs.json'), 'utf8'));
  const setCap = (usd) => { const c = costsF(); c.cap_usd = usd; fs.writeFileSync(path.join(D, 'costs.json'), JSON.stringify(c)); };
  setCap(100);
  const gi = await callT('generators_get');
  check('generators_get: fal is the default for every kind, the key found in the environment (its source only), openwith ready, comfyui not configured',
    gi.selected?.image === 'fal' && gi.selected.video === 'fal' && gi.fal_key?.found === true && /FAL_KEY/.test(gi.fal_key.source) && gi.generators?.find(g => g.id === 'comfyui')?.ready === false && gi.generators.find(g => g.id === 'openwith')?.ready === true,
    { selected: gi.selected, key: gi.fal_key, gens: gi.generators?.map(g => [g.id, g.ready]) });

  // a fresh character for the tree link (the earlier sections approve Bo's identity)
  await callT('entity_upsert', { kind: 'character', id: 'runa', fields: { name: 'Runa' } });
  const a = await callT('request_create', { kind: 'identity', target: 'character:runa', prompt: 'mcp runner: Runa identity sheet', refs: ['media/still/bo_face.jpg'], est_cost: 0.24, takes: 2, tool: 'fal-ai/nano-banana-2/edit', asset: { type: 'character', id: 'runa', tree: 'identity', from: null, kind: 'identity' } });
  const s0 = { ...FAL.stats }, cost0 = costsF().items.length;
  const draftRun = await callT('request_run', { ids: [a.id] });
  check('request_run refuses a draft (nothing started, nothing called): only the director approves', a.takes === 2 && draftRun.started?.length === 0 && /draft/.test(draftRun.refused?.[0]?.why || '') && FAL.stats.submits === s0.submits && reqOf(a.id).status === 'draft',
    { a: a.error || a.takes, draftRun });
  await approveP(a.id);
  const dry = await callT('request_run', { ids: [a.id], dry_run: true });
  check('dry_run: the plan (fal, nb2 edit, 2 takes, $0.24 within the approved $0.24, the cap fits, gen/<id>/) and nothing called, written, spent or moved',
    dry.dry_run === true && dry.items?.[0]?.ok && dry.items[0].generator === 'fal' && dry.items[0].tool === 'fal-ai/nano-banana-2/edit' && dry.items[0].takes === 2 && dry.items[0].est_usd === 0.24 && dry.items[0].cap.fits
    && JSON.stringify(FAL.stats) === JSON.stringify(s0) && costsF().items.length === cost0 && reqOf(a.id).status === 'approved' && !fs.existsSync(path.join(D, 'gen', a.id)), { item: dry.items?.[0], stats: FAL.stats });

  // the run: approved -> queued -> running -> done; outputs, job.json, media, one cost item, nodes in Runa's identity tree
  const run = await callT('request_run', { ids: [a.id], wait: true });
  const ra = reqOf(a.id), job = JSON.parse(fs.readFileSync(path.join(D, 'gen', a.id, 'job.json'), 'utf8'));
  const media = JSON.parse(fs.readFileSync(path.join(D, 'media.json'), 'utf8')).items.filter(m => m.request === a.id || m.job === a.id);
  const runa = JSON.parse(fs.readFileSync(path.join(D, 'entities', 'characters', 'runa.json'), 'utf8'));
  const statuses = ra.log.map(l => l.status).join('>');
  check('request_run (wait): queued -> running -> done; gen/<id>/<id>_0.png and _1.png + job.json; 2 submits with the uploaded ref (fal storage), the key sent to the queue only; media registered; the outputs joined Runa\'s identity tree as nodes (the director keeps or picks)',
    ra.status === 'done' && /approved>queued>running>done$/.test(statuses) && ra.outputs?.length === 2 && ra.outputs.every(o => fs.existsSync(path.join(D, o))) && /gen\/.+_0\.png$/.test(ra.outputs[0])
    && FAL.stats.submits === s0.submits + 2 && FAL.stats.uploads >= 1 && FAL.bodies.at(-1).body.image_urls?.[0]?.startsWith(FAL.url + '/cdn/ref') && FAL.stats.keyOnCdn === 0 && FAL.stats.unauthorised === 0
    && job.takes.length === 2 && job.takes.every(t => t.status === 'done' && t.handle?.request_id) && media.length === 2 && ra.linked?.nodes?.length === 2 && runa.iter?.nodes?.filter(n => n.request === a.id).length === 2,
    { status: ra.status, statuses, outputs: ra.outputs, stats: FAL.stats, linked: ra.linked, run: run.results || run.error });
  const items = costsF().items.filter(x => x.request === a.id || x.id === a.id || x.job === a.id);
  const rec = await callT('cost_record', { usd: 0.24, via: 'falgen', job: a.id });
  const cs = await callT('costs_get');
  check('the actual cost is recorded once (costs.json item = the request, via runner, $0.24); a runner hook recording the same job again is not added; the merged total counts it once',
    items.length === 1 && items[0].usd === 0.24 && items[0].via === 'runner' && ra.actual_cost_usd === 0.24 && (rec.recorded === false || /409/.test(rec.error || '')) && costsF().items.filter(x => x.request === a.id || x.job === a.id).length === 1
    && Math.abs(cs.spent_usd - +costsF().items.reduce((s, x) => s + x.usd, 0).toFixed(2)) < 0.005, { items, rec: rec.recorded ?? rec.error });
  const again = await callT('request_run', { ids: [a.id] });
  check('a done request is not run again', again.started?.length === 0 && /done/.test(again.refused?.[0]?.why || '') && FAL.stats.submits === s0.submits + 2, again);

  // re-run safe: take 0 exists already -> only take 1 is submitted
  const b = await callT('request_create', { kind: 'shot-still', target: 'shot:s2-wall', prompt: 'mcp runner: the wall at dusk', refs: [], est_cost: 0.24, takes: 2, tool: 'fal-ai/nano-banana-2/edit' });
  await approveP(b.id);
  fs.mkdirSync(path.join(D, 'gen', b.id), { recursive: true }); fs.writeFileSync(path.join(D, 'gen', b.id, `${b.id}_0.png`), Buffer.from(tinyPngB64(4, 4), 'base64'));
  const s1 = FAL.stats.submits;
  const rb = await callT('request_run', { ids: [b.id], wait: true }), rbq = reqOf(b.id), jb = JSON.parse(fs.readFileSync(path.join(D, 'gen', b.id, 'job.json'), 'utf8'));
  check('re-run safe: an output that exists is skipped (1 submit for 2 takes; text-to-image: no refs -> fal-ai/nano-banana-2); the request is done with both outputs; a shot target links the media to the shot',
    FAL.stats.submits === s1 + 1 && FAL.bodies.at(-1).endpoint === 'fal-ai/nano-banana-2' && !FAL.bodies.at(-1).body.image_urls && rbq.status === 'done' && rbq.outputs?.length === 2 && jb.takes[0].skipped === true
    && JSON.parse(fs.readFileSync(path.join(D, 'media.json'), 'utf8')).items.some(m => m.request === b.id && (m.shots || []).includes('s2-wall')), { submits: FAL.stats.submits - s1, status: rbq.status, res: rb.results || rb.error });

  // the cap at run time: approved while it fitted, the cap lowered since -> refused (402), nothing called, still approved
  const c = await callT('request_create', { kind: 'identity', prompt: 'mcp runner: over the cap', refs: [], est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' });
  await approveP(c.id);
  const spentNow = (await callT('costs_get')).total_spent_usd; setCap(spentNow + 0.05);
  const s2 = FAL.stats.submits;
  const rc2 = await callT('request_run', { ids: [c.id], wait: true });
  check('the cap is re-checked at run time: over it -> refused (402), nothing submitted, the request stays approved',
    rc2.results?.[0]?.status === 'refused' && /cap/.test(rc2.results[0].why) && FAL.stats.submits === s2 && reqOf(c.id).status === 'approved', rc2.results || rc2.error);
  setCap(100);
  // an estimate above what was approved is refused (seedream with 3 refs at 1 take costs more than the $0.01 approved)
  const d = await callT('request_create', { kind: 'identity', prompt: 'mcp runner: underpriced', refs: ['media/still/bo_face.jpg'], est_cost: 0.01, tool: 'bytedance/seedream/v5/pro/edit' });
  await approveP(d.id);
  const rd = await callT('request_run', { ids: [d.id], dry_run: true });
  check('the generator\'s estimate must not exceed the approved est_cost (seedream $0.135 > $0.01: refused, re-approve)', rd.items?.[0]?.ok === false && /approved/.test(rd.items[0].why), rd.items?.[0]);

  // a provider failure -> failed (why); a retry (same approval) runs it again
  FAL.mode = 'fail-submit';
  const e = await callT('request_create', { kind: 'identity', prompt: 'mcp runner: will fail first', refs: [], est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' });
  await approveP(e.id);
  const re1 = await callT('request_run', { ids: [e.id], wait: true }), fe = reqOf(e.id), costFailed = costsF().items.filter(x => x.request === e.id).length;
  FAL.mode = 'ok';
  const re2 = await callT('request_run', { ids: [e.id], wait: true }), fe2 = reqOf(e.id);
  check('a failed run: status failed with why (the provider\'s error, key-free), no cost; Retry runs it again on the same approval (done, one cost item)',
    fe.status === 'failed' && /422/.test(fe.why || '') && costFailed === 0 && fe2.status === 'done' && costsF().items.filter(x => x.request === e.id).length === 1,
    { first: [fe.status, fe.why], second: fe2.status, r1: re1.results?.[0]?.status });

  // "Open in another app" (Settings > Generator: image = openwith): a prompt pack, handed off; results come back at $0
  let st0 = { rev: 0, keybindings: {} }; try { st0 = JSON.parse(fs.readFileSync(path.join(D, 'settings.json'), 'utf8')); } catch (er) { /* none yet */ }
  fs.writeFileSync(path.join(D, 'settings.json'), JSON.stringify({ ...st0, generators: { image: 'openwith' } }));
  const f = await callT('request_create', { kind: 'identity', prompt: 'mcp runner: made elsewhere', refs: ['media/still/bo_face.jpg'], est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' });
  await approveP(f.id);
  const s3 = FAL.stats.submits;
  const rf1 = await callT('request_run', { ids: [f.id], wait: true }), ff = reqOf(f.id), pack = path.join(D, 'gen', f.id, 'pack');
  fs.writeFileSync(path.join(D, 'gen', f.id, 'results', 'made-in-krita.png'), Buffer.from(tinyPngB64(6, 6), 'base64'));
  const rf2 = await callT('request_run', { ids: [f.id], wait: true }), ff2 = reqOf(f.id);
  check('openwith: a prompt pack (prompt.txt = the prompt, refs/01_*, README) and the request handed off (running); results/ -> run again -> done at $0; no fal call',
    rf1.results?.[0]?.status === 'running' && !!ff.handoff?.pack && fs.readFileSync(path.join(pack, 'prompt.txt'), 'utf8') === 'mcp runner: made elsewhere' && fs.readdirSync(path.join(pack, 'refs')).length === 1 && /results/.test(fs.readFileSync(path.join(pack, 'README.md'), 'utf8'))
    && ff2.status === 'done' && ff2.actual_cost_usd === 0 && ff2.outputs?.length === 1 && FAL.stats.submits === s3, { r1: rf1.results, r2: rf2.results, h: ff.handoff });
  fs.writeFileSync(path.join(D, 'settings.json'), JSON.stringify(st0));
  const cmf = await callT('request_create', { kind: 'identity', prompt: 'x', refs: [], est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' });
  await approveP(cmf.id);
  fs.writeFileSync(path.join(D, 'settings.json'), JSON.stringify({ ...st0, generators: { image: 'comfyui' } }));
  const rcm = await callT('request_run', { ids: [cmf.id], dry_run: true });
  fs.writeFileSync(path.join(D, 'settings.json'), JSON.stringify(st0));
  check('comfyui (a stub): refused "not configured"', rcm.items?.[0]?.ok === false && /not configured/.test(rcm.items[0].why), rcm.items?.[0]);

  // ---- D3b video (h3max / kling3pro / klingmc) on the mock fal, D3c retake of a failed take inside a done request
  {
    const bad1 = await callT('request_create', { kind: 'shot-video', prompt: 'x', video: { model: 'h3max', seconds: 6 } });
    const bad2 = await callT('request_create', { kind: 'motion', prompt: 'x', video: { model: 'klingmc', start: 'media/still/bo_face.jpg', seconds: 3 } });
    const bad3 = await callT('request_create', { kind: 'shot-video', prompt: 'x', video: { model: 'h3max', start: 'media/still/bo_face.jpg', seconds: 20 } });
    const bad4 = await callT('request_create', { kind: 'shot-video', prompt: 'x', video: { model: 'h3max', start: 'media/still/nope.jpg', seconds: 6 } });
    const bad5 = await callT('request_create', { kind: 'shot-video', prompt: 'x', video: { model: 'kling3pro', start: 'media/clip/C1_0.mp4', seconds: 5 } });
    check('request_create video: refused without a start frame, motion control without a reference video, seconds out of range (h3max 20 s), a missing file (404), a video as the start frame',
      /start frame/.test(bad1.error || '') && /reference video/.test(bad2.error || '') && /seconds: 5-10/.test(bad3.error || '') && /not found/.test(bad4.error || '') && /must be an image/.test(bad5.error || ''), [bad1, bad2, bad3, bad4, bad5].map(x => (x.error || 'no error').slice(0, 90)));
    const v = await callT('request_create', { kind: 'shot-video', target: 'shot:s4-chorus', prompt: 'mcp video: Bo turns his head slowly. Camera: slow push-in.', refs: ['media/still/bo_body.jpg'], takes: 2, video: { model: 'h3max', start: 'media/still/bo_face.jpg', end: 'media/still/bo_body.jpg', seconds: 6 } });
    check('request_create video (h3max, start + end, 6 s, 2 takes): refs = [start, end] (warned), tool = the H3 endpoint, est_cost = $0.048/s x 6 s x 2 = $0.576 from js/prices.js (no est_cost given), a draft',
      v.status === 'draft' && v.refs?.join(',') === 'media/still/bo_face.jpg,media/still/bo_body.jpg' && v.tool === 'minimax/h3-max/image-to-video' && Math.abs(v.est_cost - 0.576) < 1e-9 && v.video?.seconds === 6 && (v.warnings || []).some(w => /refs set from video/.test(w)), v.error || { refs: v.refs, est: v.est_cost, w: v.warnings });
    const vu = await callT('request_update', { id: v.id, video: { seconds: 5, end: null } });
    check('request_update video {seconds: 5, end: null}: the end frame removed, refs = [start], est_cost follows (2 x 5 s x $0.048 = $0.48)', vu.request?.video?.seconds === 5 && !vu.request.video.end && vu.request.refs.join(',') === 'media/still/bo_face.jpg' && Math.abs(vu.request.est_cost - 0.48) < 1e-9, vu.error || vu.request?.video);
    await callT('request_update', { id: v.id, video: { seconds: 6, end: 'media/still/bo_body.jpg' } });
    await approveP(v.id);
    const vd = await callT('request_run', { ids: [v.id], dry_run: true }), it = vd.items?.[0];
    const vcap = await callT('request_run', { ids: [v.id], dry_run: true, max_usd: 0.5 });
    check('a per-batch cap (max_usd 0.5): the $0.576 video is refused "over the batch cap"', vcap.items?.[0]?.ok === false && /batch cap/.test(vcap.items[0].why) && vcap.runnable === 0, vcap.items?.[0]);
    const RUN = await import('../lib/run.mjs');
    process.env.WB_TEST_DATE = '2026-10-16'; const after = RUN.planRun(PROJECT, { ids: [v.id], clean: false }).items[0]; process.env.WB_TEST_DATE = '2026-10-15'; const last = RUN.planRun(PROJECT, { ids: [v.id], clean: false }).items[0]; delete process.env.WB_TEST_DATE;
    check('dry_run of a video: gen_kind video, h3max, 6 s at $0.048/s (the H3 promo), $0.288 a take, $0.576; the H3 date switch: on 2026-10-15 it still fits, from 2026-10-16 ($0.08/s: $0.96) the run is refused above the approved $0.576',
      it?.ok && it.gen_kind === 'video' && it.model === 'h3max' && it.video?.seconds === 6 && it.video.per_s === 0.048 && it.per_take_usd === 0.288 && it.est_usd === 0.576 && last.ok && after.ok === false && /\$0\.96/.test(after.why) && /approved/.test(after.why), { it, after: after.why });
    const sv = FAL.stats.videoSubmits; FAL.failNext = 1;
    const vr = await callT('request_run', { ids: [v.id], wait: true }), r1 = reqOf(v.id);
    const plain = await callT('request_run', { ids: [v.id] });
    const vr2 = await callT('request_run', { ids: [v.id], retake: true, wait: true }), r2 = reqOf(v.id);
    const vcost = costsF().items.filter(x => x.request === v.id), job = JSON.parse(fs.readFileSync(path.join(D, 'gen', v.id, 'job.json'), 'utf8'));
    check('a video run with one take failing at the provider: (take 0) done with 1 .mp4 and takes_failed [0] ($0.288 once); a plain run of the done request is refused and says retake; request_run retake (wait) runs ONLY take 0 (one more submit), the request stays done with 2 outputs and $0.576, the take\'s cost recorded once as <id>#0; job.json: per take usd, seconds, fps, duration',
      r1.status === 'done' && r1.outputs.length === 1 && /_1\.mp4$/.test(r1.outputs[0]) && r1.takes_failed?.join(',') === '0' && Math.abs(r1.actual_cost_usd - 0.288) < 1e-9 && /retake: true/.test(plain.refused?.[0]?.why || '')
      && vr2.finished === true && FAL.stats.videoSubmits === sv + 3 && r2.status === 'done' && r2.outputs.length === 2 && !r2.takes_failed && !r2.retaking && Math.abs(r2.actual_cost_usd - 0.576) < 1e-9
      && vcost.length === 2 && vcost.some(x => x.id === v.id && Math.abs(x.usd - 0.288) < 1e-9) && vcost.some(x => x.id === `${v.id}#0` && x.take === 0 && Math.abs(x.usd - 0.288) < 1e-9)
      && job.takes.every(t => t.status === 'done' && t.usd === 0.288 && t.seconds === 6 && t.fps > 0 && t.duration_ms === 6000), { r1: [r1.status, r1.outputs, r1.takes_failed], plain: plain.refused, r2: [r2.status, r2.outputs, r2.actual_cost_usd], vcost, run: vr.results, rt: vr2.results });
    const tk = await callT('takes_get', { request: v.id });
    check('the video outputs are takes (D6): takes_get {request} = 2 video takes #0, #1 of 6000 ms with an fps, from the runner, linked to shot s4-chorus',
      tk.takes?.length === 2 && tk.takes.every(t => t.kind === 'video' && t.duration_ms === 6000 && t.fps > 0 && t.source === 'runner') && tk.takes.map(t => t.take).join(',') === '0,1'
      && JSON.parse(fs.readFileSync(path.join(D, 'media.json'), 'utf8')).items.filter(m => m.request === v.id).every(m => (m.shots || []).includes('s4-chorus') && m.kind === 'clip'), tk.takes?.map(t => [t.take, t.kind, t.duration_ms, t.fps]) || tk.error);
    // motion control: the reference video goes to fal storage; a clip longer than the approved seconds is refused
    const mc = await callT('request_create', { kind: 'motion', target: 'shot:s3-grid', prompt: 'mcp video: empty studio at dawn', video: { model: 'klingmc', start: 'media/still/bo_body.jpg', ref_video: 'media/clip/C1_0.mp4', seconds: 3 } });
    // a 5 s reference clip with 3 s approved: the output would be 5 s
    fs.writeFileSync(path.join(D, 'media', 'clip', 'long5.mp4'), (await import('../tools/mock-fal.mjs')).placeholderMp4(5));
    const mcShort = await callT('request_create', { kind: 'motion', prompt: 'mcp video: too short', video: { model: 'klingmc', start: 'media/still/bo_body.jpg', ref_video: 'media/clip/long5.mp4', seconds: 3 } });
    await approveP(mc.id); await approveP(mcShort.id);
    const mcd = await callT('request_run', { ids: [mcShort.id], dry_run: true });
    const up0 = FAL.uploadsMeta.length;
    const mr = await callT('request_run', { ids: [mc.id], wait: true }), mreq = reqOf(mc.id), mb = FAL.bodies.at(-1);
    check('motion control: refs = [still, reference video], $0.168/s x 3 s = $0.504; the reference video uploaded to fal storage as video/mp4 and sent as video_url (character_orientation video); done with an .mp4; a reference clip longer than the approved seconds is refused (fal bills the output seconds)',
      mc.refs?.join(',') === 'media/still/bo_body.jpg,media/clip/C1_0.mp4' && Math.abs(mc.est_cost - 0.504) < 1e-9 && mreq.status === 'done' && /\.mp4$/.test(mreq.outputs[0]) && mb.endpoint === 'fal-ai/kling-video/v3/pro/motion-control'
      && FAL.uploadsMeta.slice(up0).some(u => u.content_type === 'video/mp4' && u.file_url === mb.body.video_url) && mb.body.character_orientation === 'video' && mcd.items?.[0]?.ok === false && /reference video is 5\.0 s but 3 s/.test(mcd.items[0].why), { mc: mc.error || mc.refs, run: mr.results, why: mcd.items?.[0]?.why });
  }

  // the key never appears: not in any file of the project / media base, any tool response, or the server log
  const leaks = walk(TMP).filter(fl => { try { return fs.readFileSync(path.join(TMP, fl)).includes(FAL_KEY); } catch (er) { return false; } });
  check('the fal key never appears in a file (job.json, requests, costs, media, settings), a tool response or the server log', !leaks.length && !texts.some(t => t.includes(FAL_KEY)) && !srvLog.includes(FAL_KEY) && texts.length > 10, { leaks, responses: texts.length });
}
// 16. review rounds and revisions (SPEC v4 §2): notes -> the page sends the round (one ask) -> the agent reads, absorbs,
// replies and finishes through MCP -> the page closes the revision R1 -> compare R0 / R1 -> restore; an agent cannot
// send, close or restore (no tool, 403 over HTTP and offline); the git mirror is off by default and, when on, commits into
// data/<p>/.history (its own repository: the workbench repository does not move)
{
  const RP = 'mcp-rounds';
  S.duplicateProject(PROJECT, RP, true);
  const RD = path.join(DATA, RP), RJ = (f) => JSON.parse(fs.readFileSync(path.join(RD, f), 'utf8'));
  const pageOp = (name, body = {}) => post(`/api/op/${name}?project=${RP}`, body, { origin: URL_ });
  const agentOp = (name, body = {}) => post(`/api/op/${name}?project=${RP}`, body);
  // the director's notes, saved by the page
  const n0 = await (await fetch(`${URL_}/data/${RP}/notes.json`)).json();
  const lyr = await call(mcp, 'lyrics_get', { project: RP }), L1 = lyr.sections[0].lines[0];
  n0.notes.push({ id: 'ln90', target: { stage: 'lyrics', kind: 'line', id: L1.id }, text: 'mcp: this line, warmer', status: 'open', replies: [] },
    { id: 'sn90', target: { stage: 'script', kind: 'scene', id: 'sc01' }, text: 'mcp: sc01 too long?', status: 'open', replies: [] },
    { id: 'n90', target: { stage: 'timeline', kind: 'time', id: null, t: 3000 }, text: 'mcp: a flash here', status: 'open', replies: [] });
  const sv = await post(`/api/save/notes.json?project=${RP}`, { base_rev: n0.rev, data: n0 }, { origin: URL_ });
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const g0 = await call(mcp, 'round_get', { project: RP });
  const deny = [await agentOp('round_send'), await agentOp('revision_close'), await agentOp('revision_restore', { id: 'R1' })].map(r => r.status);
  let offErr = null; try { S.ops.round_send(RP, {}); } catch (e) { offErr = e.code; }
  check('rounds: the agent has round_get / round_absorb / round_reply / round_finish / revisions_get but no tool to send a round, close or restore a revision; the agent surface gets 403 (HTTP and offline); before a send round_get says "collecting" with the open notes',
    sv.status === 200 && ['round_get', 'round_absorb', 'round_reply', 'round_finish', 'revisions_get'].every(t => tools.includes(t)) && !['round_send', 'revision_close', 'revision_restore'].some(t => tools.includes(t))
    && deny.every(s => s === 403) && offErr === 403 && g0.status === 'collecting' && g0.open === 3, { deny, offErr, g0 });
  const sent = await pageOp('round_send'), N1 = RJ('notes.json'), ask = N1.notes.find(n => n.id === sent.body?.ask);
  const again = await pageOp('round_send');
  const g = await call(mcp, 'round_get', { project: RP });
  check('round_send (page): ONE ask to the agent naming every open note with its target; notes.json round 2; round_get groups the notes by stage with their content inlined; a second send while the round is out: 409',
    sent.status === 200 && sent.body.notes === 3 && ask?.to === 'agent' && ask.ask === 'round' && ['ln90', 'sn90', 'n90'].every(id => ask.text.includes(id)) && N1.round === 2 && again.status === 409
    && g.status === 'sent' && g.becomes === 'R1' && g.stages.lyrics?.[0]?.content?.line === L1.text && g.stages.script?.[0]?.content?.title && g.stages.timeline?.[0]?.content?.time === '0:03.000',
    { sent: sent.body, again: again.status, stages: Object.keys(g.stages || {}) });
  const secs = lyr.sections.map(s => ({ label: s.label, lines: s.lines.map(l => l.id === L1.id ? 'Tone on, the lights are warm and low' : l.text) }));
  const up = await call(mcp, 'lyrics_update', { project: RP, sections: secs, message: 'round 1' });
  const ab = await call(mcp, 'round_absorb', { project: RP, note: 'ln90', change: { stage: 'lyrics', file: 'lyrics.json', version: up.version, summary: `line ${L1.id} warmer` } });
  const abBad = await call(mcp, 'round_absorb', { project: RP, note: 'sn90', change: { stage: 'script', file: '../x', summary: 'x' } });
  const rp = await call(mcp, 'round_reply', { project: RP, note: 'sn90', text: 'sc01 is 4 s: keep it?' });
  await call(mcp, 'round_absorb', { project: RP, note: 'n90', change: { stage: 'timeline', summary: 'a flash cue noted for the edit' } });
  const fin = await call(mcp, 'round_finish', { project: RP, summary: '2 absorbed, 1 question' }), fin2 = await call(mcp, 'round_finish', { project: RP, summary: 'again' });
  const N2 = RJ('notes.json');
  check('round_absorb links a note to the change (absorbed, absorbed_in R1, change {stage, file, version, summary}); a bad file path is refused (400); round_reply keeps the note open; round_finish answers the ask, approves nothing, and only once (409)',
    ab.absorbed_in === 'R1' && N2.notes.find(n => n.id === 'ln90').change?.version === up.version && /400/.test(abBad.error || '') && rp.status === 'open' && fin.status === 'finished' && fin.progress.absorbed === 2 && fin.progress.replied === 1
    && /409/.test(fin2.error || '') && N2.notes.find(n => n.id === ask.id).status === 'absorbed' && RJ('revisions.json').rounds[0].status === 'finished',
    { ab, abBad: abBad.error, fin, fin2: fin2.error });
  const cl = await pageOp('revision_close'), R1 = cl.body;
  const cmp = await call(mcp, 'revisions_get', { project: RP, compare: ['R0', 'R1'] }), lst = await call(mcp, 'revisions_get', { project: RP });
  const snapServed = await fetch(`${URL_}/data/${RP}/.snapshots/${R1?.snapshot}/notes.json`).then(r => r.status);
  check('revision_close (page) makes R1: {id, round, created, summary, notes_absorbed, notes_replied, files_changed, cost_delta, snapshot}; no .history (the git mirror is off by default); revisions_get compares R0 -> R1 (the lyric line as a word diff linked to ln90) and lists R1; snapshots are not served',
    cl.status === 200 && R1.id === 'R1' && R1.round === 1 && R1.notes_absorbed.sort().join() === 'ln90,n90' && R1.notes_replied.join() === 'sn90' && R1.files_changed.includes('lyrics.json') && R1.cost_delta === 0 && !R1.git
    && !fs.existsSync(path.join(RD, '.history')) && cmp.lyrics?.lines?.[0]?.op === '~' && cmp.lyrics.lines[0].notes?.includes('ln90') && cmp.notes?.length === 2 && lst.revisions?.length === 1 && lst.in_flight === null && snapServed === 403,
    { R1, lines: cmp.lyrics?.lines, snapServed });
  // the git mirror, opt-in: a commit in data/<p>/.history, never in the workbench repository
  const gitOk = !spawnSync('git', ['--version']).error;
  const head = (dir) => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const wbHead = gitOk ? head(WB) : null;
  const st0 = await (await fetch(`${URL_}/data/${RP}/settings.json`)).json() || { rev: 0, keybindings: {} };
  await post(`/api/save/settings.json?project=${RP}`, { base_rev: st0.rev || 0, data: { ...st0, revisions_git: true } }, { origin: URL_ });
  await call(mcp, 'scenes_update', { project: RP, upsert: [{ id: 'sc01', title: 'mcp R2 title' }], message: 'R2' });
  const cl2 = (await pageOp('revision_close', { summary: 'a checkpoint with the mirror on' })).body;
  const histServed = await fetch(`${URL_}/data/${RP}/.history/.git/config`).then(r => r.status);
  const commits = gitOk ? spawnSync('git', [`--git-dir=${path.join(RD, '.history', '.git')}`, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim() : null;
  check('the git mirror (settings revisions_git: true): R2 is a commit in data/<p>/.history (its own repository, with the snapshot\'s files); the workbench repository\'s HEAD does not move; .history is never served',
    !gitOk || (cl2.git?.commit && fs.existsSync(path.join(RD, '.history', '.git')) && fs.existsSync(path.join(RD, '.history', 'scenes.json')) && commits === '1' && head(WB) === wbHead && histServed === 403),
    { git: gitOk, r2: cl2.git, commits, histServed });
  const rs = await pageOp('revision_restore', { id: 'R1' });
  const titleNow = RJ('scenes.json').versions.find(v => v.id === RJ('scenes.json').current).scenes.find(s => s.id === 'sc01').title;
  check('revision_restore (page) R1: the files go back (sc01 without the R2 title), the state before is a snapshot, the notes are kept as they are, revisions.json keeps R1 and R2 (+ the restore)',
    rs.status === 200 && !/mcp R2 title/.test(titleNow) && fs.existsSync(path.join(RD, '.snapshots', rs.body.previous)) && RJ('notes.json').notes.some(n => n.id === 'ln90' && n.absorbed_in === 'R1') && RJ('revisions.json').revisions.length === 2 && RJ('revisions.json').restores.length === 1,
    { restore: rs.body?.restored || rs.body, titleNow });
}
// 17. proposals (SPEC v4 §3): the agent adds sets (SVG made with code, sanitised; or short texts) and reads the director's
// picks; picking is the page's (no tool; 403 over HTTP and offline); a "3 more" ask is answered by the next set on its
// target; the free local generator makes 3 layouts per scene / shot
{
  const PP = 'mcp-proposals';
  S.duplicateProject(PROJECT, PP, true);
  const PPD = path.join(DATA, PP), PJ = (f) => JSON.parse(fs.readFileSync(path.join(PPD, f), 'utf8'));
  const pageOp = (name, body = {}) => post(`/api/op/${name}?project=${PP}`, body, { origin: URL_ });
  const svg = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="${c}"/><circle cx="53" cy="40" r="9" fill="#111"/><text x="4" y="86" font-size="8">thirds</text></svg>`;
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const scT = { stage: 'script', kind: 'scene', id: 'sc01' };
  const add = await call(mcp, 'proposals_add', { project: PP, target: scT, items: [{ title: 'Wide', why: 'the place', svg: svg('#eee') }, { title: 'Medium', why: 'the action', svg: svg('#ddd') }, { title: 'An idea', why: 'a text', text: 'the screen fades up from black' }] });
  const bad = await call(mcp, 'proposals_add', { project: PP, target: scT, items: [{ title: 'x', svg: '<svg viewBox="0 0 10 10" onload="alert(1)"/>' }] });
  const badT = await call(mcp, 'proposals_add', { project: PP, target: { stage: 'script', kind: 'scene', id: 'sc77' }, items: [{ title: 'x', text: 'y' }] });
  const agentPick = await post(`/api/op/proposal_act?project=${PP}`, { set: add.set?.id, item: 'a', act: 'pick' });
  let offErr = null; try { S.ops.proposal_act(PP, { set: add.set?.id, item: 'a', act: 'pick' }); } catch (e) { offErr = e.code; }
  check('proposals_add: a set of 3 on a scene (SVGs written to proposals/<set>-<item>.svg, sanitised; a text), the answer says what changed; a hostile SVG and a missing scene are refused; the agent cannot pick (no tool, 403 over HTTP and offline)',
    tools.includes('proposals_add') && tools.includes('proposals_get') && !tools.includes('proposal_act') && add.set?.items?.length === 3 && /^proposals\.json: set ps01 on scene sc01 with 3 items/.test(add.changed)
    && fs.existsSync(path.join(PPD, 'proposals', 'ps01-a.svg')) && add.set.items[2].text && /on\* handlers|event handlers/.test(bad.error || '') && /404/.test(badT.error || '') && agentPick.status === 403 && offErr === 403,
    { changed: add.changed, bad: bad.error, badT: badT.error, agentPick: agentPick.status, offErr });
  // the director picks in the page; mixes another; asks for 3 more; the agent reads it all and answers the ask
  const pick = await pageOp('proposal_act', { set: 'ps01', item: 'b', act: 'pick' });
  const mix = await pageOp('proposal_act', { set: 'ps01', item: 'c', act: 'mix', note: 'fade from white instead' });
  const n0 = await (await fetch(`${URL_}/data/${PP}/notes.json`)).json();
  n0.notes.push({ id: 'sn77', target: scT, text: '3 more proposals for scene sc01', status: 'open', to: 'agent', ask: 'proposals', replies: [] });
  const sv = await post(`/api/save/notes.json?project=${PP}`, { base_rev: n0.rev, data: n0 }, { origin: URL_ });
  const got = await call(mcp, 'proposals_get', { project: PP, target: scT });
  const more = await call(mcp, 'proposals_add', { project: PP, target: scT, items: [{ title: 'Close', why: 'her eyes', svg: svg('#ccc') }, { title: 'Top shot', why: 'the floor', svg: svg('#bbb') }, { title: 'Dutch', why: 'unease', svg: svg('#aaa') }] });
  const askNow = PJ('notes.json').notes.find(n => n.id === 'sn77');
  check('proposals_get: the sets with each item\'s status, the director\'s picks (one per set: the mix replaced the pick) with the mix note, the open "3 more" ask; the next proposals_add on that scene answers the ask (absorbed, with a reply)',
    pick.status === 200 && mix.status === 200 && mix.body.note && sv.status === 200 && got.sets?.[0]?.items?.map(i => i.status).join() === 'open,open,mixed' && got.picks?.length === 1 && got.picks[0].note === 'fade from white instead'
    && got.asks?.some(a => a.id === 'sn77') && more.answered?.includes('sn77') && askNow?.status === 'absorbed' && /ps02/.test(askNow.replies?.at(-1)?.text || ''),
    { statuses: got.sets?.[0]?.items?.map(i => i.status), picks: got.picks, asks: got.asks?.map(a => a.id), answered: more.answered, ask: askNow?.status });
  // the free local generator: 3 layouts per scene and shot, $0, nothing twice
  const loc = await pageOp('proposals_local', { scope: 'all' }), loc2 = await pageOp('proposals_local', { scope: 'all' });
  const sets = PJ('proposals.json').sets.filter(x => x.source === 'local');
  check('proposals_local: 3 sanitised SVG layouts per scene / shot without open proposals ($0; sc01 skipped: it has open ones); run again: nothing new',
    loc.status === 200 && loc.body.cost_usd === 0 && loc.body.added.length === sets.length && sets.length >= 3 && sets.every(x => x.items.length === 3 && x.items.every(i => fs.existsSync(path.join(PPD, i.svg))))
    && loc.body.skipped.includes('scene sc01') && loc2.body.added.length === 0,
    { added: loc.body?.added?.length, skipped: loc.body?.skipped, again: loc2.body?.added?.length });
  // the director-session briefing mentions them
  const pr = await mcp.getPrompt({ name: 'director-session', arguments: { project: PP } });
  check('the director-session briefing counts the proposals and tells the agent how to add them', /Proposals: \d+ set/.test(pr.messages[0].content.text) && /proposals_add/.test(pr.messages[0].content.text));
}
// 18. final approvals (stage 7, ROADMAP_v4 C1-C4): final_get is read only (the checklist + the pending list + the costs);
// the agent has no tool to approve from Final nor to lock / unlock; a project the page locked for render refuses every agent
// write (409, over HTTP and offline) while reads keep working; the page unlocks
{
  const FP = 'mcp-final';
  S.duplicateProject(PROJECT, FP, true);
  const FJ = (f) => JSON.parse(fs.readFileSync(path.join(DATA, FP, f), 'utf8'));
  const pageOp = (name, body = {}) => post(`/api/op/${name}?project=${FP}`, body, { origin: URL_ });
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const g = await call(mcp, 'final_get', { project: FP }), gs = await call(mcp, 'final_get', { project: FP, group: 'storyboard' });
  const ids = (g.checklist || []).map(c => c.id);
  check('final_get (read only): the checklist (scripted, shots, frames, assets, notes, round, cap, export; each ok / detail / gaps), the pending rows by group with status, why, cost and approvable, the costs against the cap; the group filter; no tool to lock / unlock',
    tools.includes('final_get') && !tools.some(t => /^final_(lock|unlock)$/.test(t)) && ['scripted', 'shots', 'frames', 'takes', 'assets', 'notes', 'round', 'cap', 'export'].every(i => ids.includes(i))
    && g.ready === false && g.locked === null && g.pending?.length > 3 && g.pending.every(r => r.key && r.group && r.st && r.why) && typeof g.costs?.cap === 'number' && g.costs.merged === true
    && gs.pending.length && gs.pending.every(r => r.group === 'storyboard'), { ids, ready: g.ready, n: g.pending?.length, costs: g.costs, groups: g.counts?.by_group });
  const agentLock = await post(`/api/op/final_lock?project=${FP}`, { force: true, via: 'page' });
  const lk = await pageOp('final_lock', { force: true });
  const w1 = await call(mcp, 'notes_add', { project: FP, target: { stage: 'final', kind: 'stage', id: null }, text: 'mcp: while locked' });
  const wP = await call(mcp, 'proposals_add', { project: FP, target: { stage: 'script', kind: 'scene', id: 'sc01' }, items: [{ title: 'locked', text: 'while locked' }] });
  const w2 = await call(mcp, 'request_create', { project: FP, kind: 'shot-still', target: 'shot:s5-outro', prompt: 'x', est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' });
  const off = await connect({ WORKBENCH_URL: 'http://localhost:9' });
  const w3 = await call(off, 'notes_add', { project: FP, target: { stage: 'final', kind: 'stage', id: null }, text: 'mcp offline: while locked' });
  const r3 = await call(off, 'final_get', { project: FP });
  await off.close();
  const r1 = await call(mcp, 'final_get', { project: FP }), r2 = await call(mcp, 'notes_get', { project: FP });
  const RV = FJ('revisions.json');
  check('lock for render (page only: the agent surface gets 403 even claiming via "page"): a revision closed and marked final, revisions.json lock; then every agent write is refused with 409 + why (HTTP and offline) while final_get / notes_get still read',
    agentLock.status === 403 && lk.status === 200 && RV.lock?.revision === lk.body.revision && RV.revisions.find(r => r.id === lk.body.revision)?.final === true
    && /error 409/.test(w1.error || '') && /locked for render/.test(w1.error || '') && /error 409/.test(w2.error || '') && /error 409/.test(wP.error || '') && /error 409/.test(w3.error || '')
    && r1.locked?.revision === lk.body.revision && r3.locked?.revision === lk.body.revision && Array.isArray(r2.notes) && !FJ('notes.json').notes.some(n => /while locked/.test(n.text)),
    { agentLock: agentLock.status, lk: lk.body, w1: w1.error?.slice(0, 90), w2: w2.error?.slice(0, 60), w3: w3.error?.slice(0, 60), locked: r1.locked?.revision });
  const ul = await pageOp('final_unlock'), w4 = await call(mcp, 'notes_add', { project: FP, target: { stage: 'final', kind: 'stage', id: null }, text: 'mcp: after unlock' });
  check('unlock (page): the agent writes again; the lock stays in revisions.json locks[] with unlocked_at', ul.status === 200 && !w4.error && FJ('revisions.json').lock === null && FJ('revisions.json').locks?.[0]?.unlocked_at, { ul: ul.status, w4: w4.error });
}

// 19. the review fixes of 2026-10-05: (S1) one director approval pays for one run: a FAILED request (runnable: the runner
// retries it) goes back to draft in a duplicate and through a snapshot restore; the copy has no git mirror and no
// revisions of the original; (S4) a fal run that would upload a private ref is refused until the director ticks "allow
// uploading private refs" on the request in the page (a save without the page's Origin cannot tick it; an edit unticks it)
{
  const RVP = 'mcp-review', RD = path.join(DATA, RVP);
  S.duplicateProject(PROJECT, RVP, true);
  const RJ = (f) => JSON.parse(fs.readFileSync(path.join(RD, f), 'utf8'));
  const c0 = RJ('costs.json'); c0.cap_usd = 100; fs.writeFileSync(path.join(RD, 'costs.json'), JSON.stringify(c0));
  const pageSave = async (fn, headers = { origin: URL_ }) => { const cur = RJ('requests.json'); fn(cur); return post(`/api/save/requests.json?project=${RVP}`, { base_rev: cur.rev, data: cur }, headers); };
  const r1 = await call(mcp, 'request_create', { project: RVP, kind: 'shot-still', target: 'shot:s5-outro', prompt: 'review S1', est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' });
  await pageSave((d) => { d.items.find(x => x.id === r1.id).status = 'approved'; });
  for (const st of ['queued', 'running']) S.ops.request_update(RVP, { id: r1.id, status: st });
  S.ops.request_update(RVP, { id: r1.id, status: 'failed', why: 'mcp test: provider error' });
  const snapF = S.snapshot(RVP, 'with a failed request');
  fs.mkdirSync(path.join(RD, '.history', '.git', 'hooks'), { recursive: true }); fs.writeFileSync(path.join(RD, '.history', '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho pwned > ../pwned\n');
  S.duplicateProject(RVP, RVP + '-copy', false);
  const CD = path.join(DATA, RVP + '-copy'), cr = JSON.parse(fs.readFileSync(path.join(CD, 'requests.json'), 'utf8')).items.find(x => x.id === r1.id);
  const cdry = await call(mcp, 'request_run', { project: RVP + '-copy', ids: [r1.id], dry_run: true });
  S.ops.request_update(RVP, { id: r1.id, status: 'draft' });
  const rs = S.restore(RVP, snapF.id, { agent: true }), after = RJ('requests.json').items.find(x => x.id === r1.id);
  const odry = await call(mcp, 'request_run', { project: RVP, ids: [r1.id], dry_run: true });
  check('S1: a failed request goes back to draft in a duplicate (approve again; its dry run is refused) and through a snapshot restore (the restored failed status is not carried); the copy gets no .history (git hooks never travel) and no revisions.json',
    cr?.status === 'draft' && /approve again/.test(cr.log.at(-1)?.why || '') && cdry.items?.[0]?.ok === false && after?.status === 'draft' && /approval not carried/.test(after.log.at(-1)?.why || '')
    && odry.items?.[0]?.ok === false && !fs.existsSync(path.join(CD, '.history')) && !fs.existsSync(path.join(CD, 'revisions.json')),
    { copy: cr?.status, cdry: cdry.items?.[0]?.why, restored: after?.status, kept: rs.kept_since_snapshot });
  // S4: a private ref (private/refs/...) on a fal request
  fs.mkdirSync(path.join(RD, 'private', 'refs', 'runa'), { recursive: true });
  fs.copyFileSync(path.join(RD, 'media', 'still', 'bo_face.jpg'), path.join(RD, 'private', 'refs', 'runa', 'face.jpg'));
  const r2 = await call(mcp, 'request_create', { project: RVP, kind: 'shot-still', target: 'shot:s5-outro', prompt: 'review S4', refs: ['private/refs/runa/face.jpg'], est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' });
  const agentTick = (await post(`/api/op/request_create?project=${RVP}`, { kind: 'shot-still', target: 'shot:s5-outro', prompt: 'review S4 agent', refs: ['private/refs/runa/face.jpg'], est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit', extra: { private_upload_ok: true } })).body;
  await pageSave((d) => { d.items.find(x => x.id === r2.id).status = 'approved'; });
  const d0 = await call(mcp, 'request_run', { project: RVP, ids: [r2.id], dry_run: true });
  const noOrigin = await pageSave((d) => { d.items.find(x => x.id === r2.id).private_upload_ok = true; }, {});
  const d1 = await call(mcp, 'request_run', { project: RVP, ids: [r2.id], dry_run: true }), tick0 = RJ('requests.json').items.find(x => x.id === r2.id).private_upload_ok;
  const tick = await pageSave((d) => { d.items.find(x => x.id === r2.id).private_upload_ok = true; });
  const d2 = await call(mcp, 'request_run', { project: RVP, ids: [r2.id], dry_run: true });
  const ed = await call(mcp, 'request_update', { project: RVP, id: r2.id, prompt: 'review S4, edited' }), r2e = RJ('requests.json').items.find(x => x.id === r2.id);
  check('S4: a fal run with a private ref is refused until the director ticks "allow uploading private refs" in the page (a save without the page\'s Origin cannot tick it, an agent\'s extra is dropped); the tick is logged; an edit unticks it',
    d0.items?.[0]?.ok === false && /private ref/.test(d0.items[0].why) && noOrigin.status === 200 && tick0 !== true && d1.items?.[0]?.ok === false
    && tick.status === 200 && d2.items?.[0]?.ok === true && r2e.private_upload_ok !== true && r2e.log.some(e => e.private_upload === true && e.via === 'page') && r2e.log.some(e => e.private_upload === false) && r2e.status === 'draft'
    && RJ('requests.json').items.find(x => x.id === agentTick?.id)?.private_upload_ok !== true && !!agentTick?.id && !ed.error,
    { agentTick: agentTick?.id, ed: ed.error, d0: d0.items?.[0]?.why, d1: d1.items?.[0]?.ok, d2: d2.items?.[0]?.ok ?? d2.items?.[0]?.why, after: r2e.private_upload_ok });
}
// (S2) one price source: no literal price table outside js/prices.js (the "New look…" form had its own)
{
  const PRICE_LIT = /(usd|cost|price|COST|PRICE)[A-Za-z_]*\s*[:=]\s*\{?\s*[a-z_]*:?\s*0\.[0-9]+/;
  const files = ['core', 'tabs', 'js', 'lib', 'generators'].flatMap(d => fs.readdirSync(path.join(WB, d), { recursive: true }).map(f => path.join(d, String(f)))).concat(['app.js'])
    .filter(f => /\.m?js$/.test(f) && !/prices\.js$/.test(f));
  const hits = files.flatMap(f => fs.readFileSync(path.join(WB, f), 'utf8').split('\n').map((l, i) => PRICE_LIT.test(l) ? `${f}:${i + 1}` : null).filter(Boolean));
  check('S2: no literal price outside js/prices.js (core, tabs, js, lib, generators, app.js)', !hits.length && /estimateWith/.test(fs.readFileSync(path.join(WB, 'core', 'partb.js'), 'utf8')), hits);
}
// (S6) a look's colours go into a style attribute: hex only (look_create, entity_upsert); the page renders hex only
{
  const RVP = 'mcp-review';
  const bad = await call(mcp, 'look_create', { project: RVP, id: 'ada', name: 'S6 beacon', colors: ['red;background-image:url(https://evil.example/b)'] });
  const bad2 = await call(mcp, 'entity_upsert', { project: RVP, kind: 'character', id: 'ada', look: { id: 's6-up', name: 'S6 up', colors: ['#fff', 'url(https://evil.example)'] } });
  const good = await call(mcp, 'look_create', { project: RVP, id: 'ada', name: 'S6 ok', colors: ['#1c2541', '#abc'] });
  const ada = JSON.parse(fs.readFileSync(path.join(DATA, RVP, 'entities', 'characters', 'ada.json'), 'utf8'));
  const lib = fs.readFileSync(path.join(WB, 'tabs', 'library.js'), 'utf8'), pb = fs.readFileSync(path.join(WB, 'core', 'partb.js'), 'utf8');
  check('S6: look colours are hex only (look_create and entity_upsert: 400 on anything else); the swatches render through hexColor()',
    /error 400/.test(bad.error || '') && /hex/.test(bad.error) && /error 400/.test(bad2.error || '') && !good.error && ada.looks.some(l => l.colors?.join() === '#1c2541,#abc') && !ada.looks.some(l => /beacon|s6-up/i.test(`${l.name} ${l.id}`))
    && /background:\$\{hexColor\(c\)\}/.test(lib) && /background:\$\{hexColor\(c\)\}/.test(pb) && !/background:\$\{esc\(c\)\}/.test(lib + pb),
    { bad: bad.error?.slice(0, 120), bad2: bad2.error?.slice(0, 120), good: good.error });
}
// (S5) four processes write costs.json and requests.json at once (offline, the data layer directly): nothing is lost
{
  const RVP = 'mcp-review', RD = path.join(DATA, RVP), N = 4, K = 12;
  const kid = (k) => `const S = await import(${JSON.stringify(pathToFileURL(path.join(WB, 'lib', 'store.mjs')).href)});
for (let i = 0; i < ${K}; i++) { S.ops.cost_record('${RVP}', { usd: 0.01, via: 'race', job: 'race${k}-' + i }); S.ops.request_create('${RVP}', { kind: 'shot-still', prompt: 'race ${k} ' + i, est_cost: 0.01 }); }`;
  const runs = Array.from({ length: N }, (_, k) => new Promise((ok) => { const c = spawn(process.execPath, ['--input-type=module', '-e', kid(k)], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; c.stderr.on('data', d => { err += d; }); c.on('exit', (code) => ok({ code, err: err.slice(0, 300) })); }));
  const outs = await Promise.all(runs);
  const RJ = (f) => JSON.parse(fs.readFileSync(path.join(RD, f), 'utf8'));
  const costs = RJ('costs.json').items.filter(x => x.via === 'race').length, reqs = RJ('requests.json').items.filter(x => /^race /.test(x.prompt || '')).length;
  check('S5: four processes recording costs and creating requests at once (cross-process file lock): every cost row and every request is kept (the cap cannot undercount); no lock file is left',
    outs.every(o => o.code === 0) && costs === N * K && reqs === N * K && !fs.readdirSync(RD).some(f => f.endsWith('.lock')), { outs, costs, reqs, want: N * K });
}
// 20. take selection (ROADMAP_v4 D6): takes_get (read only: the takes of a shot / a request, fps, duration, the pick, the
// proposals), take_propose (checked like a pick: a take of that shot, in / out inside its duration); the pick is the page's
// (take_act: no tool, 403 to the agent); it lands on the storyboard shot as clip{request, take, file, in_ms, out_ms, alt[]}
// through a new version; the agent's shots_update carries it forward; Final counts it
{
  const TP = 'mcp-takes';
  S.duplicateProject(PROJECT, TP, true);
  const TJ = (f) => JSON.parse(fs.readFileSync(path.join(DATA, TP, f), 'utf8'));
  const pageOp = (name, body = {}) => post(`/api/op/${name}?project=${TP}`, body, { origin: URL_ });
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const tg = await call(mcp, 'takes_get', { project: TP, shot: 's2-wall' }), both = await call(mcp, 'takes_get', { project: TP });
  const vids = (tg.takes || []).filter(t => t.kind === 'video');
  check('takes_get {shot}: the shot\'s takes (media linked to it, its clip uses\' job: C1 take 0 and 1, the still) with kind, take, duration, fps, absolute file; nothing picked yet; neither shot nor request: 400; no take_act tool',
    tools.includes('takes_get') && tools.includes('take_propose') && !tools.includes('take_act') && vids.map(t => t.media).join() === 'C1_0,C1_1' && vids.every(t => t.duration_ms === 3000 && t.fps > 0 && t.abs && fs.existsSync(t.abs))
    && tg.takes.some(t => t.kind === 'image') && tg.picked === null && /400/.test(both.error || ''), { takes: tg.takes?.map(t => [t.media, t.kind, t.take, t.duration_ms, t.fps]), both: both.error?.slice(0, 60) });
  const pr = await call(mcp, 'take_propose', { project: TP, shot: 's2-wall', take: 1, request: 'C1', in_ms: '0:00.500', out_ms: 1500, why: 'take 1 is calmer; alternative for 0:06.0: take 0' });
  const again = await call(mcp, 'take_propose', { project: TP, shot: 's2-wall', media: 'C1_1', in_ms: 500, out_ms: 1500, why: 'take 1 is calmer (updated)' });
  const off = await call(mcp, 'take_propose', { project: TP, shot: 's2-wall', media: 'C2_0', why: 'another shot\'s take' });
  const long = await call(mcp, 'take_propose', { project: TP, shot: 's2-wall', media: 'C1_1', in_ms: 2000, out_ms: 3500, why: 'past the end' });
  const agentPick = await post(`/api/op/take_act?project=${TP}`, { act: 'pick', shot: 's2-wall', media: 'C1_1', in_ms: 500, out_ms: 1500 });
  let offPick = null; try { S.ops.take_act(TP, { act: 'pick', shot: 's2-wall', media: 'C1_1', in_ms: 500, out_ms: 1500 }); offPick = 200; } catch (e) { offPick = e.code; }
  check('take_propose: an open proposal in takes.json (take 1 of C1 named by number + request, in as m:ss.mmm); the same take and range again only updates its why; another shot\'s take and out past the duration are refused; the agent cannot pick (403 over HTTP and offline)',
    pr.proposal?.id === 'tp01' && pr.proposal.in_ms === 500 && pr.proposal.out_ms === 1500 && pr.proposal.take === 1 && again.updated === true && TJ('takes.json').proposals.length === 1 && /calmer \(updated\)/.test(TJ('takes.json').proposals[0].why)
    && /not a take of s2-wall/.test(off.error || '') && /inside the take/.test(long.error || '') && agentPick.status === 403 && offPick === 403,
    { pr: pr.changed || pr.error || pr, again, off: off.error?.slice(0, 80), long: long.error?.slice(0, 80), agentPick: agentPick.status, offPick });
  const pk = await pageOp('take_act', { act: 'pick', shot: 's2-wall', media: 'C1_1', in_ms: 500, out_ms: 1500, note: 'calmer', alt: [{ media: 'C1_0', t: 6000, note: 'brighter' }], proposal: 'tp01' });
  const sbj = TJ('storyboard.json'), cur = sbj.versions.find(v => v.id === sbj.current), clip = cur.shots.find(s => s.id === 's2-wall').clip;
  const tg2 = await call(mcp, 'takes_get', { project: TP, shot: 's2-wall' }), sg = await call(mcp, 'storyboard_get', { project: TP });
  const up = await call(mcp, 'shots_update', { project: TP, upsert: [{ id: 's2-wall', text: 'mcp: agent text', clip: { file: 'media/clip/C1_0.mp4', in_ms: 0, out_ms: 100 } }] });
  const sbj2 = TJ('storyboard.json'), cur2 = sbj2.versions.find(v => v.id === sbj2.current).shots.find(s => s.id === 's2-wall');
  const fg = await call(mcp, 'final_get', { project: TP }), tk = fg.checklist?.find(c => c.id === 'takes');
  check('the page picks (take_act): a new storyboard version with shot.clip {request, take, file, in_ms, out_ms, note, alt[{take, file, t, note}], via page}; takes_get / storyboard_get show it; the proposal is "picked"; the agent\'s shots_update keeps it (its clip ignored); Final\'s "takes" line counts it',
    pk.status === 200 && clip?.take === 1 && clip.file === 'media/clip/C1_1.mp4' && clip.in_ms === 500 && clip.out_ms === 1500 && clip.alt?.[0]?.take === 0 && clip.alt[0].t === 6000 && clip.via === 'page' && cur.via === 'page'
    && tg2.picked?.file === clip.file && tg2.takes.find(t => t.media === 'C1_1').picked === true && tg2.takes.find(t => t.media === 'C1_0').alt_for?.[0]?.t === 6000 && TJ('takes.json').proposals[0].status === 'picked'
    && sg.scenes.flatMap(s => s.shots).concat(sg.outside_script || []).find(s => s.id === 's2-wall')?.clip?.take === 1
    && cur2.text === 'mcp: agent text' && cur2.clip?.file === clip.file && (up.warnings || []).some(w => /clip ignored/.test(w)) && tk && /^1 of \d+ shots picked/.test(tk.detail),
    { clip, version: sbj.current, picked: tg2.picked?.media, warnings: up.warnings, tk: tk?.detail });
}
// 20b. the lyric gate (ROADMAP_v4 E2): surfaces_get (read only: every lyric word covered or not, the uncovered runs, the
// surfaces per shot, the proposals), surface_propose (checked: the shot, the line, the word range, the where kind, sung during the
// shot); accepting / adding / removing is the page's (surface_act: no tool, 403 to the agent); a surface lands on the storyboard
// shot as lyrics[{line, w?, where}] through a new version; the agent's shots_update carries it forward; Final counts the words
{
  const TP = 'mcp-gate';
  S.duplicateProject(PROJECT, TP, true);
  const TJ = (f) => JSON.parse(fs.readFileSync(path.join(DATA, TP, f), 'utf8'));
  const pageOp = (name, body = {}) => post(`/api/op/${name}?project=${TP}`, body, { origin: URL_ });
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const g0 = await call(mcp, 'surfaces_get', { project: TP }), g0u = await call(mcp, 'surfaces_get', { project: TP, uncovered: true, line: 'verse/0' });
  check('surfaces_get: every lyric word with covered false (57 words, 9 uncovered runs: one per line), the line filter, the where kinds; no surface_act tool',
    tools.includes('surfaces_get') && tools.includes('surface_propose') && !tools.includes('surface_act') && g0.ok === false && g0.total === 57 && g0.covered === 0 && g0.uncovered?.length === 9
    && g0.lines?.length === 9 && g0.lines[1].words.every(w => w.covered === false) && g0u.lines?.length === 1 && g0u.lines[0].id === 'verse/0' && g0.where_kinds?.includes('karaoke'),
    { total: g0.total, runs: g0.uncovered?.length, err: g0.error });
  const pr = await call(mcp, 'surface_propose', { project: TP, shot: 's4-chorus', line: 'chorus/0', where: 'karaoke: bouncing ball over the lyric', why: 'the chorus is sung along' });
  const again = await call(mcp, 'surface_propose', { project: TP, shot: 's4-chorus', line: 'chorus/0', where: 'karaoke: bouncing ball over the lyric', why: 'updated why' });
  const off = await call(mcp, 'surface_propose', { project: TP, shot: 's1-intro', line: 'chorus/0', where: 'chat', why: 'x' });
  const rng = await call(mcp, 'surface_propose', { project: TP, shot: 's4-chorus', line: 'chorus/0', w: [2, 30], where: 'chat', why: 'x' });
  const agentAct = await post(`/api/op/surface_act?project=${TP}`, { act: 'accept', proposal: 'sp01' });
  let offAct = null; try { S.ops.surface_act(TP, { act: 'accept', proposal: 'sp01' }); offAct = 200; } catch (e) { offAct = e.code; }
  check('surface_propose: an open proposal in surfaces.json; the same surface again only updates its why; a line not sung during the shot and a word range off the line are refused; the agent cannot accept (403 over HTTP and offline)',
    pr.proposal?.id === 'sp01' && pr.proposal.status === 'open' && again.updated === true && TJ('surfaces.json').proposals.length === 1 && TJ('surfaces.json').proposals[0].why === 'updated why'
    && /not sung during s1-intro/.test(off.error || '') && /has 8 words/.test(rng.error || '') && agentAct.status === 403 && offAct === 403,
    { pr: pr.changed || pr.error, off: off.error?.slice(0, 80), rng: rng.error?.slice(0, 80), agentAct: agentAct.status, offAct });
  const acc = await pageOp('surface_act', { act: 'accept', proposal: 'sp01' });
  const add = await pageOp('surface_act', { act: 'add', shot: 's4-chorus', line: 'chorus/1', w: [0, 1], where: 'dialog: Every frame' });
  const sbj = TJ('storyboard.json'), cur = sbj.versions.find(v => v.id === sbj.current), ly = cur.shots.find(s => s.id === 's4-chorus').lyrics;
  const up = await call(mcp, 'shots_update', { project: TP, upsert: [{ id: 's4-chorus', camera: 'mcp: locked-off', lyrics: [] }] });
  const cur2 = (() => { const d = TJ('storyboard.json'); return d.versions.find(v => v.id === d.current).shots.find(s => s.id === 's4-chorus'); })();
  const g1 = await call(mcp, 'surfaces_get', { project: TP, shot: 's4-chorus' }), fg = await call(mcp, 'final_get', { project: TP }), line = fg.checklist?.find(c => c.id === 'lyrics');
  check('the page accepts / adds (surface_act): a new storyboard version with shot.lyrics [{line, w?, where}] (via page); the proposal is "accepted"; the agent\'s shots_update keeps them (its lyrics ignored with a warning); surfaces_get counts the words; Final "every word on a surface" counts them too',
    acc.status === 200 && add.status === 200 && cur.via === 'page' && ly?.length === 2 && ly[0].line === 'chorus/0' && ly[0].w === undefined && String(ly[1].w) === '0,1' && TJ('surfaces.json').proposals[0].status === 'accepted'
    && cur2.camera === 'mcp: locked-off' && cur2.lyrics?.length === 2 && (up.warnings || []).some(w => /lyrics ignored/.test(w))
    && g1.covered === 10 && g1.shots?.[0]?.lyrics?.length === 2 && line && !line.ok && /10 of 57 words/.test(line.detail),
    { acc: acc.status, add: add.status, ly, covered: g1.covered, line: line?.detail, warnings: up.warnings });
}
// 21. (D8) import of existing images and video: a fake falgen tree under a media root (tools/fake-falgen.mjs; never fal)
{
  const D8 = 'mcp-d8', DD = path.join(DATA, D8);
  fs.cpSync(ORIG, DD, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
  const { makeFakeFalgen } = await import('../tools/fake-falgen.mjs');
  makeFakeFalgen(path.join(MB, 'roots', 'ff'));
  fs.writeFileSync(path.join(MB, 'refs', 'p.png'), Buffer.from(tinyPngB64(8, 8, [9, 9, 9]), 'base64'));
  const OUTR = 'roots/ff/project/gen/out';
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  check('D8: media_scan and media_import are tools; uploads (media_upload) and "use as" (media_use) are not (page only)',
    tools.includes('media_scan') && tools.includes('media_import') && !tools.includes('media_upload') && !tools.includes('media_use'));
  const sc = await call(mcp, 'media_scan', { project: D8, path: OUTR });
  const a1 = sc.jobs?.find(j => j.id === 'A1'), g01 = sc.jobs?.find(j => j.id === 'G01');
  check('D8: media_scan reads a falgen output tree: the media files (sniffed; a text file named .png and notes.txt skipped), each job\'s prompt, model, endpoint, refs (names only) and takes; the cost from the ledger next to the tree (A1 $0.24, not counted) or an estimate from js/prices.js (G01)',
    sc.files?.length === 4 && sc.files.every(f => !f.registered) && sc.skipped?.some(s => /fake\.png$/.test(s.path)) && a1?.model === 'nb2' && a1.endpoint === 'fal-ai/nano-banana-2/edit' && /HOODIE HACKER/.test(a1.prompt) && a1.refs.length === 2 && a1.files.length === 2
    && a1.cost?.status === 'not_counted' && a1.cost.source === 'ledger' && a1.cost.usd === 0.24 && a1.cost.offer?.job === 'A1' && a1.cost.offer.takes === 2 && g01?.cost?.source === 'estimate' && g01.cost.usd > 0 && sc.files.find(f => f.name === 'A1_0_1.png')?.take === 1,
    { files: sc.files?.length, skipped: sc.skipped, a1: a1?.cost, g01: g01?.cost, err: sc.error });
  const out1 = await call(mcp, 'media_scan', { project: D8, path: 'secret' });
  const out2 = await call(mcp, 'media_scan', { project: D8, path: 'roots/../secret' });
  const out3 = await call(mcp, 'media_import', { project: D8, paths: [path.join(MB, 'secret', 's.txt')] });
  const fake = await call(mcp, 'media_import', { project: D8, paths: [`${OUTR}/A1/fake.png`] });
  const down = await call(mcp, 'media_import', { project: D8, paths: ['refs/p.png'], private: false });
  check('D8: media_scan / media_import refuse a path outside the media roots (403), a ".." path (400), an absolute path outside (403) and a non-media file (415), and never lower a private flag (403)',
    /error 403/.test(out1.error || '') && /error 400/.test(out2.error || '') && /error 403/.test(out3.error || '') && /error 415/.test(fake.error || '') && /error 403/.test(down.error || ''),
    { out1: out1.error?.slice(0, 80), out2: out2.error?.slice(0, 80), out3: out3.error?.slice(0, 80), fake: fake.error?.slice(0, 80), down: down.error?.slice(0, 80) });
  const imp = await call(mcp, 'media_import', { project: D8, paths: [`${OUTR}/A1`, `${OUTR}/G01`, 'refs/p.png'] });
  const M = JSON.parse(fs.readFileSync(path.join(DD, 'media.json'), 'utf8')).items;
  const m0 = M.find(m => m.path === `${OUTR}/A1/A1_0_0.png`), pv = M.find(m => m.path === 'refs/p.png');
  check('D8: media_import registers in place (never copied): job / take / label from job.json, cost_usd = the job\'s share per take, thumbnails; a PRIVATE path stays private; costs_not_counted lists the cost_record args',
    imp.imported?.length === 4 && m0?.job === 'A1' && m0.take === 0 && m0.cost_usd === 0.12 && /^A1\.0 · HOODIE/.test(m0.label) && m0.imported?.via === 'agent' && pv?.private === true && /priv_/.test(pv.thumb || '')
    && !fs.existsSync(path.join(DD, 'media', 'still', 'A1_0_0.png')) && imp.costs_not_counted?.some(o => o.job === 'A1' && o.usd === 0.24),
    { imp: imp.error || imp.imported?.map(x => x.id), m0: m0 && { job: m0.job, take: m0.take, cost: m0.cost_usd, label: m0.label }, pv: pv && { private: pv.private, thumb: pv.thumb } });
  const again = await call(mcp, 'media_import', { project: D8, paths: [`${OUTR}/A1/A1_0_0.png`] });
  const rec = await call(mcp, 'cost_record', { project: D8, ...a1.cost.offer });
  const rec2 = await call(mcp, 'cost_record', { project: D8, ...a1.cost.offer });
  const sc2 = await call(mcp, 'media_scan', { project: D8, path: `${OUTR}/A1` });
  check('D8: importing twice changes nothing (already); the recovered cost is recorded once (cost_record dedups by job) and the scan then says "recorded"',
    again.already?.length === 1 && !again.imported?.length && rec.recorded === true && rec2.recorded === false && sc2.jobs?.[0]?.cost?.status === 'recorded' && sc2.files.every(f => f.registered),
    { again: again.already?.length, rec: rec.recorded, rec2: rec2.reason, st: sc2.jobs?.[0]?.cost?.status });
  // "use as" is the director's: the agent gets 403 on the HTTP surface; it proposes with node_import_propose
  const ag = await post(`/api/op/media_use?project=${D8}`, { media: m0.id, as: 'identity', id: 'ada', via: 'page' });
  const agUp = await post(`/api/op/media_upload?project=${D8}`, { upload: 'abcdefgh99', name: 'x.png', size: 10, offset: 0, data: tinyPngB64(2, 2), via: 'page' });
  const prop = await call(mcp, 'node_import_propose', { project: D8, id: 'ada', tree: 'identity', media: m0.id, why: 'A1 take 0, made by falgen before the queue' });
  const pg = await post(`/api/op/media_use?project=${D8}`, { media: m0.id, as: 'identity', id: 'bo' }, { origin: URL_ });
  const bo = JSON.parse(fs.readFileSync(path.join(DD, 'entities', 'characters', 'bo.json'), 'utf8'));
  check('D8: "use as" and uploads are page only (the agent surface gets 403 even claiming via "page"); the agent proposes a node with node_import_propose; the page\'s "use as identity" makes an imported node (no request, provenance with the job and its recorded cost)',
    ag.status === 403 && agUp.status === 403 && !prop.error && pg.status === 200 && bo.iter.nodes.some(n => n.origin === 'imported' && n.image === m0.path && n.provenance?.job === 'A1' && n.provenance.cost?.source === 'workbench'),
    { ag: ag.status, agUp: agUp.status, prop: prop.error, pg: pg.status, nodes: bo.iter.nodes.map(n => n.image) });
  // D6 x D8: media the director marks "use as shot take" (use_as[] on the media item, shotMediaLinks) are takes of that shot in
  // takes_get (why "use_as"), so they can be proposed and picked; the start frame is listed and flagged
  const m1 = M.find(m => m.path === `${OUTR}/A1/A1_0_1.png`);
  const ut = await post(`/api/op/media_use?project=${D8}`, { media: m1.id, as: 'take', shot: 's2-wall' }, { origin: URL_ });
  const us = await post(`/api/op/media_use?project=${D8}`, { media: m0.id, as: 'start_frame', shot: 's2-wall' }, { origin: URL_ });
  const tku = await call(mcp, 'takes_get', { project: D8, shot: 's2-wall' }), tu = tku.takes?.find(t => t.media === m1.id), ts = tku.takes?.find(t => t.media === m0.id);
  const tpu = await call(mcp, 'take_propose', { project: D8, shot: 's2-wall', media: m1.id, why: 'the imported falgen still, used as a take by the director' });
  check('D6 x D8: a medium marked "use as shot take" is a take of that shot in takes_get (why use_as, its file absolute) and can be proposed; the start frame is takes_get.start_frame and flagged on its take',
    ut.status === 200 && us.status === 200 && tu?.why?.includes('use_as') && tu.file === m1.path && !!tu.abs && tku.start_frame?.media === m0.id && ts?.why?.includes('start_frame') && !tpu.error && tpu.proposal?.media === m1.id,
    { ut: ut.status, us: us.status, tu: tu && { why: tu.why, abs: !!tu.abs }, sf: tku.start_frame?.media, tpu: tpu.error?.slice(0, 100) });
  // media_add records the fps of a video and accepts request (the MCP schema keeps it): the take's fps comes from the index
  fs.copyFileSync(path.join(DD, 'media', 'clip', 'C1_0.mp4'), path.join(DD, 'media', 'clip', 'fps_probe.mp4'));
  const ma = await call(mcp, 'media_add', { project: D8, path: 'media/clip/fps_probe.mp4', kind: 'clip', request: 'rq-fps', take: 0 });
  const mf = JSON.parse(fs.readFileSync(path.join(DD, 'media.json'), 'utf8')).items.find(m => m.path === 'media/clip/fps_probe.mp4');
  check('media_add records fps for a video and the request it is an output of (request is in the MCP schema)',
    ma.added === true && mf?.fps > 0 && mf.request === 'rq-fps' && ma.media?.fps === mf.fps, { err: ma.error, fps: mf?.fps, request: mf?.request });
}
// 22. (D4) job books, waves and pilot gates: waves_propose (drafts only), batches_get, the page-only batch approval and review,
// a locked batch never runs, the runner runs a batch within its cap (mock fal), the job books as history (page only)
{
  const P4 = 'mcp-d4', DD = path.join(DATA, P4);
  fs.cpSync(ORIG, DD, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
  const { batchFixture } = await import('../tools/verify-batches.mjs');
  batchFixture(DD, path.join(MB, 'roots', 'ff'));   // the fake falgen tree of section 21 (+ its job book)
  const pj = JSON.parse(fs.readFileSync(path.join(DD, 'project.json'), 'utf8')); pj.falgen = 'roots/ff/project/gen'; fs.writeFileSync(path.join(DD, 'project.json'), JSON.stringify(pj));
  const RJ = () => JSON.parse(fs.readFileSync(path.join(DD, 'requests.json'), 'utf8'));
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const n0 = RJ().items.length;
  const dry = await call(mcp, 'waves_propose', { project: P4, pilot: ['w03', 'w07'], takes: 2, dry_run: true });
  check('D4: batches_get and waves_propose are tools; approving / reviewing a batch (batch_act) and the job-book import are not (page only); waves_propose dry_run: the pilot w03 + w07, then 4, then 4 ($0.48 / $0.96 / $0.96), nothing written',
    tools.includes('batches_get') && tools.includes('waves_propose') && !tools.includes('batch_act') && !tools.includes('jobbooks_import') && dry.dry_run === true && dry.waves?.map(w => w.shots.length).join() === '2,4,4'
    && dry.waves[0].shots.map(s => s.shot).join() === 'w03,w07' && dry.waves.map(w => w.est_usd).join() === '0.48,0.96,0.96' && RJ().items.length === n0 && !RJ().batches, { waves: dry.waves?.map(w => [w.name, w.est_usd]), err: dry.error });
  const wp = await call(mcp, 'waves_propose', { project: P4, pilot: ['w03', 'w07'], takes: 2 });
  const bg = await call(mcp, 'batches_get', { project: P4 }), [b1, b2] = bg.batches || [];
  const D0 = RJ(), mine = D0.items.filter(r => wp.requests_created?.includes(r.id));
  check('waves_propose: 3 draft batches gated wave after wave (b01 ready, b02 / b03 locked) and 10 draft requests written by the agent (log via agent); batches_get shows totals, verdicts and the rules',
    wp.batches?.join() === 'b01,b02,b03' && mine.length === 10 && mine.every(r => r.status === 'draft' && r.log[0].via === 'agent') && D0.batches.every(b => b.status === 'draft' && b.via === 'agent')
    && b1?.state === 'ready' && b2?.state === 'locked' && b2.gate.after === 'b01' && b1.totals.est_usd === 0.48 && b1.verdicts.length === 2 && /never approve/.test(bg.rules || ''), { wp: wp.batches, states: bg.batches?.map(b => b.state), err: wp.error });
  // the agent cannot approve or review a batch; a request approved alone (in the page) does not run
  const a1 = await post(`/api/op/batch_act?project=${P4}`, { act: 'approve', id: 'b01' }), a2 = await post(`/api/op/batch_act?project=${P4}`, { act: 'approve', id: 'b01', via: 'page' });
  const ruA = await call(mcp, 'request_update', { project: P4, id: b1.request_ids[0], status: 'approved', director_approved: true });
  const paB = await pageApprove(b1.request_ids[0], P4); const ru = { request: RJ().items.find(r => r.id === b1.request_ids[0]) };
  const rd = await call(mcp, 'request_run', { project: P4, batch: 'b01', dry_run: true });
  check('the agent cannot approve a batch (batch_act 403, also claiming via "page"); a request of the batch is never approved on its own (the agent: 403; a page save: 403, approved with its batch) and the runner refuses it: the batch is not approved',
    a1.status === 403 && a2.status === 403 && /403/.test(ruA.error || '') && paB.status === 403 && ru.request?.status === 'draft' && rd.runnable === 0 && rd.refused.length === 2 && rd.refused.every(x => /not approved/.test(x.why)), { a: [a1.status, a2.status], refused: rd.refused });
  // the director approves b01 (page), the runner runs it as a batch within its cap
  const pa = await post(`/api/op/batch_act?project=${P4}`, { act: 'approve', id: 'b01' }, { origin: URL_ });
  const run = await call(mcp, 'request_run', { project: P4, batch: 'b01', wait: true });
  const lk = await call(mcp, 'request_run', { project: P4, batch: 'b02', dry_run: true });
  const bg2 = await call(mcp, 'batches_get', { project: P4, id: 'b01' });
  check('the page approves b01 (both requests, max_usd $0.48); request_run {batch: b01, wait} runs both on the mock fal (done, $0.48); b01 is in review (2 verdicts pending); b02 is locked and refused ("locked until …")',
    pa.status === 200 && pa.body?.max_usd === 0.48 && run.results?.length === 2 && run.results.every(x => x.status === 'done') && bg2.batches?.[0]?.state === 'review' && bg2.batches[0].verdicts.every(v => v.verdict === 'pending')
    && lk.runnable === 0 && lk.refused.every(x => /locked until the director marks/.test(x.why)), { pa: pa.body, run: run.results?.map(x => x.status), lk: lk.refused?.[0]?.why, err: run.error });
  const rv0 = await post(`/api/op/batch_act?project=${P4}`, { act: 'review', id: 'b01' }, { origin: URL_ });
  for (const id of b1.request_ids) await post(`/api/op/batch_act?project=${P4}`, { act: 'verdict', id: 'b01', request: id, verdict: 'rejected' }, { origin: URL_ });
  const rv = await post(`/api/op/batch_act?project=${P4}`, { act: 'review', id: 'b01' }, { origin: URL_ });
  const bg3 = await call(mcp, 'batches_get', { project: P4 });
  check('Mark reviewed needs every take decided (409 first); with the takes rejected, b01 is reviewed and b02 unlocks (ready); the agent reads the take ratio (4 takes, 0 used) in batches_get',
    rv0.status === 409 && rv.status === 200 && rv.body?.unlocked?.join() === 'b02' && bg3.batches.find(b => b.id === 'b01').state === 'done' && bg3.batches.find(b => b.id === 'b02').state === 'ready' && bg3.observed.takes === 4 && bg3.observed.used_shots === 0,
    { rv0: rv0.status, rv: rv.body, observed: bg3.observed });
  // the job books: page only; history never runs and adds no cost
  const jb = await post(`/api/op/jobbooks_import?project=${P4}`, {}), jd = await post(`/api/op/jobbooks_import?project=${P4}`, { dry_run: true });
  const costs0 = fs.readFileSync(path.join(DD, 'costs.json'), 'utf8');
  const jp = await post(`/api/op/jobbooks_import?project=${P4}`, {}, { origin: URL_ }), again = await post(`/api/op/jobbooks_import?project=${P4}`, { dry_run: true });
  const hist5 = RJ().items.filter(r => r.history);
  check('N5 history: spent (actual_cost_usd) only from a ledger row (recorded / counted); an estimate or a cost not counted stays in history.cost only',
    hist5.length === 2 && hist5.some(r => !r.history.cost.counted) && hist5.every(r => (r.history.cost.counted ? r.actual_cost_usd != null : r.actual_cost_usd === undefined)), hist5.map(r => [r.id, r.history.cost, r.actual_cost_usd]));
  const hr = await call(mcp, 'request_run', { project: P4, ids: ['A1'] }), hu = await call(mcp, 'request_update', { project: P4, id: 'A1', prompt: 'x' });
  check('job books: the agent cannot import (403) but may dry-run it (A1, G01; N9 never ran); the page imports them as done history with their job book, not again on a second run; history never runs and cannot be edited; costs.json unchanged',
    jb.status === 403 && jd.body?.imported?.map(x => x.id).join() === 'A1,G01' && jp.status === 200 && jp.body.imported.length === 2 && again.body?.imported?.length === 0 && again.body.skipped.some(s => /imported already/.test(s.why))
    && RJ().items.filter(r => r.history).every(r => r.status === 'done' && r.history.book === 'jobs_test.json') && hr.started?.length === 0 && /history/.test(hr.refused?.[0]?.why || '') && /409|done/.test(hu.error || '')
    && fs.readFileSync(path.join(DD, 'costs.json'), 'utf8') === costs0, { jb: jb.status, jd: jd.body?.imported, jp: jp.body?.skipped, hr: hr.refused, hu: hu.error });
}
// ==================== 23. (D7) identity checks + (D2) constants: BEGIN ====================
// A separate section on its own project copy (mcp-d7): lib/ops/checks.mjs, mcp/tools/checks.mjs, js/checks.js. Constants through
// entity_upsert (cleaned); identity checks off by default (a run asks nothing); on: the runner's done lands the outputs and their
// nodes as ONE "identity check" ask; checks_get; check_add (checks.json only); the ask absorbed when every output is checked.
{
  const P7 = 'mcp-d7', DD = path.join(DATA, P7);
  fs.cpSync(ORIG, DD, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
  const { checksFixture } = await import('../tools/verify-checks.mjs');
  checksFixture(DD, path.join(MB, 'roots'));
  const J = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DD, f), 'utf8')); } catch (e) { return d; } }, W = (f, d) => fs.writeFileSync(path.join(DD, f), JSON.stringify(d, null, 1));
  const sha = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(DD, f))).digest('hex'); } catch (e) { return null; } };
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const up = await call(mcp, 'entity_upsert', { project: P7, kind: 'character', id: 'ada', fields: { constants: [{ text: 'Orange starburst clip above the LEFT ear', label: 'clip side' }, 'copper-tipped curls', { text: 'hazel-green eyes', check: false }, '  ', 'Copper-tipped curls'] } });
  const upLoc = await call(mcp, 'entity_upsert', { project: P7, kind: 'location', id: 'studio', fields: { constants: ['a red door'] } });
  const cs = J('entities/characters/ada.json').constants || [];
  check('D2: tools check_add and checks_get; entity_upsert cleans constants[] to {text, check, label?} (blank and duplicate dropped, check false kept off the checklist); a location has none (400)',
    tools.includes('check_add') && tools.includes('checks_get') && !up.error && cs.length === 3 && cs[0].label === 'clip side' && cs[0].check === true && cs[1].text === 'copper-tipped curls' && cs[2].check === false && /400/.test(upLoc.error || ''),
    { cs, upLoc: upLoc.error?.slice(0, 80) });
  const c0 = J('costs.json', {}); c0.cap_usd = 100; W('costs.json', c0);
  const mkReq = (id) => { const R = J('requests.json'); R.items.push({ id, kind: 'look-sheet', target: 'character:ada', prompt: `mcp d7: Ada look sheet (${id})`, refs: ['media/still/ada_face.jpg'], est_cost: 0.24, takes: 2, tool: 'fal-ai/nano-banana-2/edit', status: 'approved', by: 'agent', at: '2026-10-05T11:00:00',
    asset: { type: 'character', id: 'ada', tree: 'look:base', from: 'n01', kind: 'look' }, log: [{ at: '2026-10-05T11:00:00', by: 'director', via: 'page', status: 'approved' }] }); R.rev = (R.rev || 0) + 1; W('requests.json', R); };
  const asks = () => (J('notes.json', { notes: [] }).notes || []).filter(n => n.ask === 'check');
  mkReq('rd7off');
  const off = await call(mcp, 'request_run', { project: P7, ids: ['rd7off'], wait: true });
  const offReq = J('requests.json').items.find(r => r.id === 'rd7off');
  check('identity checks are off by default: the runner\'s done (outputs + nodes) asks nothing and writes no checks.json',
    offReq.status === 'done' && offReq.linked?.nodes?.length === 2 && asks().length === 0 && !fs.existsSync(path.join(DD, 'checks.json')), { status: offReq.status, run: off.error?.slice(0, 120), asks: asks().length });
  W('settings.json', { ...J('settings.json', { rev: 0, keybindings: {} }), identity_checks: true });
  mkReq('rd7on');
  await call(mcp, 'request_run', { project: P7, ids: ['rd7on'], wait: true });
  const onReq = J('requests.json').items.find(r => r.id === 'rd7on'), A1 = asks(), ck1 = J('checks.json', { asks: [] });
  const nodeT = (onReq.linked?.nodes || []).map(n => `ada/${n}`);
  check('on (settings.json identity_checks): the runner\'s done lands 2 outputs + their 2 nodes as ONE ask for the agent on Ada (to: agent, ask "check"), naming each node as the target, the approved identity n01 and the checked constants only',
    onReq.status === 'done' && A1.length === 1 && A1[0].to === 'agent' && A1[0].target.id === 'ada' && /2 new outputs/.test(A1[0].text) && nodeT.length === 2 && nodeT.every(t => A1[0].text.includes(t)) && /n01/.test(A1[0].text)
    && /clip above the LEFT ear/.test(A1[0].text) && !/hazel/.test(A1[0].text) && ck1.asks.length === 1 && ck1.asks[0].files.every(f => f.target.kind === 'node' && f.request === 'rd7on'),
    { status: onReq.status, asks: A1.map(n => n.text.slice(0, 200)), files: ck1.asks?.[0]?.files });
  const g1 = await call(mcp, 'checks_get', { project: P7, entity: 'ada' });
  const before = ['approvals.json', 'requests.json', 'storyboard.json', 'takes.json'].map(sha);
  const k1 = await call(mcp, 'check_add', { project: P7, target: { kind: 'node', id: nodeT[0] }, against: { entity: 'ada' }, verdict: 'fail', items: [{ constant: 'clip side', ok: false, note: 'clip on the RIGHT side' }, { constant: 'likeness', ok: true }], note: 'wrong side' });
  const mid = asks()[0].status;
  const k2 = await call(mcp, 'check_add', { project: P7, target: { kind: 'node', id: nodeT[1] }, against: { entity: 'ada', node: 'n01' }, verdict: 'ok', items: [{ constant: 1, ok: true }], score: { model: 'arcface-r100 (local)', value: 0.71, threshold: 0.5, metric: 'cosine' } });
  const kBad = await call(mcp, 'check_add', { project: P7, target: { kind: 'node', id: nodeT[1] }, against: { entity: 'ada' }, verdict: 'ok', score: { model: '', value: 'high' } });
  const g2 = await call(mcp, 'checks_get', { project: P7, entity: 'ada' });
  check('checks_get gives the open ask (2 unchecked, absolute files) and Ada\'s checklist; check_add writes checks.json only (approvals, requests, storyboard, takes untouched), returns the badge ("✗ clip side", "identity ok"), keeps the optional score {model, value, threshold}, refuses a malformed score; the ask stays open until both are checked, then is absorbed with the results',
    g1.enabled === true && g1.asks?.[0]?.unchecked === 2 && g1.asks[0].files.every(f => f.abs) && g1.checklist?.[0]?.identity?.node === 'n01'
    && k1.badge?.label === '✗ clip side' && k2.badge?.label === 'identity ok' && k2.check?.score?.value === 0.71 && /score/.test(kBad.error || '') && mid === 'open'
    && JSON.stringify(['approvals.json', 'requests.json', 'storyboard.json', 'takes.json'].map(sha)) === JSON.stringify(before)
    && asks()[0].status === 'absorbed' && /checked:.*✗ clip side.*identity ok/.test(asks()[0].replies?.at(-1)?.text || '') && g2.asks.length === 0 && g2.latest.length === 2,
    { k1: k1.error || k1.badge, k2: k2.error || k2.badge, kBad: kBad.error?.slice(0, 80), mid, ask: asks()[0]?.status, latest: g2.latest });
}
// ==================== 23. (D7) identity checks + (D2) constants: END ====================
// ==================== 24. (E9) composition data export: BEGIN ====================
// On its own project copy (mcp-comp): exporters/composition-data.mjs, lib/ops/composition.mjs, mcp/tools/composition.mjs, the
// reader (exporters/composition-data/reader.js). composition_export writes exports/<out> only (the project's files unchanged),
// placeholders before a pick, the picked take with in / out and the mapped file after the page's pick, the same bytes twice
// (changed: false, the checksum), the reader resolving a song time, out / map paths that leave exports/ refused (400).
{
  const CP = 'mcp-comp', CD = path.join(DATA, CP);
  S.duplicateProject(PROJECT, CP, true);
  const pageOp = (name, body = {}) => post(`/api/op/${name}?project=${CP}`, body, { origin: URL_ });
  const sha = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(CD, f))).digest('hex'); } catch (e) { return null; } };
  const EF = path.join(CD, 'exports', 'composition', 'edl.json'), edl = () => JSON.parse(fs.readFileSync(EF, 'utf8'));
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const e0 = await call(mcp, 'composition_export', { project: CP }), d0 = edl();
  const pk = await pageOp('take_act', { act: 'pick', shot: 's2-wall', media: 'C1_1', in_ms: 500, out_ms: 1500 });
  const FILES = ['approvals.json', 'requests.json', 'storyboard.json', 'takes.json', 'media.json', 'settings.json', 'notes.json'], before = FILES.map(sha);
  const MAP = [{ from: 'media/clip/', to: 'assets/world/' }, { from: '', to: 'assets/' }];
  const e1 = await call(mcp, 'composition_export', { project: CP, map: MAP }), d1 = edl(), e2 = await call(mcp, 'composition_export', { project: CP, map: MAP });
  const after = FILES.map(sha), sw = d1.shots.find(s => s.id === 's2-wall');
  const { checksumOf } = await import('../exporters/composition-data.mjs');
  const R = createRequire(import.meta.url)('../exporters/composition-data/reader.js').from(d1), r = R.at(4200), rIntro = R.at(1000);
  check('composition_export: before a pick every shot is a placeholder ("unpicked"); after the page\'s pick s2-wall carries the take (file mapped to assets/world/C1_1.mp4, source, take 1, in 500 / out 1500); the song anchors (bpm, beats, sections); the same picks again = the same bytes (changed false, same checksum = sha256 of the body); only exports/ is written; the reader resolves t = 4.2 s to C1_1 at 0.7 s',
    tools.includes('composition_export') && !e0.error && d0.format === 'director-workbench/composition-edl' && d0.version === 1 && d0.shots.every(s => s.status === 'placeholder' && s.placeholder.reason === 'unpicked')
    && pk.status === 200 && !e1.error && e1.changed === true && sw?.status === 'picked' && sw.take.file === 'assets/world/C1_1.mp4' && sw.take.source === 'media/clip/C1_1.mp4' && sw.take.take === 1 && sw.take.in_ms === 500 && sw.take.out_ms === 1500
    && d1.song.bpm === 120 && d1.song.first_beat_ms === 0 && d1.song.sections.length > 0 && d1.checksum === checksumOf(d1) && e2.changed === false && e2.checksum === e1.checksum
    && JSON.stringify(before) === JSON.stringify(after) && r?.shot === 's2-wall' && r.file === 'assets/world/C1_1.mp4' && r.media_ms === 700 && rIntro?.status === 'placeholder',
    { e0: e0.error || e0.counts, e1: e1.error || e1.counts, sw, r, same: e2.changed === false });
  const outs = ['../evil.json', '..\\evil.json', '/evil.json', 'C:/evil.json', 'a/../../evil.json', './edl.json', 'a//b.json', 'edl.txt', 'composition/..'];
  const bad = await Promise.all(outs.map(out => call(mcp, 'composition_export', { project: CP, out })));
  const badMap = await call(mcp, 'composition_export', { project: CP, map: [{ from: '', to: '../../up/' }] }), badMap2 = await call(mcp, 'composition_export', { project: CP, map: [{ from: '', to: 'C:/x/' }] });
  const stray = fs.readdirSync(path.join(DATA)).concat(fs.readdirSync(CD)).filter(f => /evil/.test(f));
  check('composition_export refuses an out that leaves exports/ ("..", a backslash, a leading slash, a drive, ".", an empty segment, not .json) and a map that leaves the composition (400); nothing is written outside',
    bad.every(b => /error 400/.test(b.error || '')) && /error 400/.test(badMap.error || '') && /error 400/.test(badMap2.error || '') && !stray.length, { bad: bad.map(b => (b.error || 'OK').slice(0, 40)), stray });
}
// ==================== 24. (E9) composition data export: END ====================
// ==================== 25. (E1) named sync points and the re-time: BEGIN ====================
// On its own project copy (mcp-events): js/events.js, lib/ops/events.mjs, mcp/tools/events.mjs. events_get reads the importer's
// array as v2; event_add writes a proposed event (accepting is the page's); scenes_update / shots_update anchor boundaries
// (anchors, snap "events": the anchored edge takes the event's time; an unknown event is dropped with a warning);
// retime_propose returns the plan (anchored boundaries and the cuts that share them) and moves nothing; applying, undoing and
// accepting are page only (HTTP without the page: 403; offline: 403; no tool); the page's retime_apply writes a new scenes and
// storyboard version and moves the events; retime_undo puts them back (pending again).
{
  const EP = 'mcp-events', ED = path.join(DATA, EP);
  fs.cpSync(ORIG, ED, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });   // the pristine demo (the sections above changed the scratch one)
  const pageOp = (name, body = {}) => post(`/api/op/${name}?project=${EP}`, body, { origin: URL_ });
  // review #3 M2: a re-time that moves a held item (approved / a shared cut / a short take) needs the page's confirm of each: the dialog's ticks
  const pageRetime = async (name, body) => { const r = await pageOp(name, body); return r.status === 409 && Array.isArray(r.body?.held) ? pageOp(name, { ...body, confirm: r.body.held.map(h => h.key) }) : r; };
  const agentOp = (name, body = {}) => post(`/api/op/${name}?project=${EP}`, body);
  const rd = (f) => JSON.parse(fs.readFileSync(path.join(ED, f), 'utf8'));
  const curV = (f, k) => { const d = rd(f); return d.versions.find(v => v.id === d.current)[k]; };
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const g0 = await call(mcp, 'events_get', { project: EP });
  check('events_get reads the importer\'s events.json (an array) as named events: drop_chorus a cue (source_kind drop), stop_outro a stop, accepted; the agent tools exist and the page-only acts have no tool',
    g0.events?.some(e => e.id === 'drop_chorus' && e.kind === 'cue' && e.source_kind === 'drop' && e.status === 'accepted') && g0.events?.some(e => e.id === 'stop_outro' && e.kind === 'stop') && g0.pending === null
    && ['events_get', 'event_add', 'retime_propose'].every(t => tools.includes(t)) && !['events_act', 'retime_apply', 'retime_undo'].some(t => tools.includes(t)), { n: g0.events?.length, err: g0.error });
  const a1 = await call(mcp, 'event_add', { project: EP, name: 'her hi there', t: '0:05.000', kind: 'spoken', note: 'Verse, her line' });
  const aDup = await call(mcp, 'event_add', { project: EP, id: 'her_hi_there', name: 'again', t: 6000 });
  const aBad = await call(mcp, 'event_add', { project: EP, name: 'x', t: 999999 }), aKind = await call(mcp, 'event_add', { project: EP, name: 'x', t: 1000, kind: 'banana' });
  const acc = await agentOp('events_act', { act: 'accept', id: 'her_hi_there', via: 'page' });
  let accOff; try { S.ops.events_act(EP, { act: 'accept', id: 'her_hi_there' }); accOff = 200; } catch (e) { accOff = e.code; }
  // proposed events are no snap target: anchoring to one is dropped with a warning
  const scP = await call(mcp, 'scenes_update', { project: EP, upsert: [{ id: 'sc01', anchors: { t1: 'her_hi_there' } }], message: 'anchor to a proposed event' });
  const accP = await pageOp('events_act', { act: 'accept', id: 'her_hi_there' });
  check('event_add writes a PROPOSED event (by the agent); a duplicate id 409, a time outside the song or an unknown kind 400; accepting it is the page\'s (agent HTTP 403 even claiming via "page", offline 403); the page accepts it',
    a1.event?.status === 'proposed' && a1.event.via === 'agent' && /409/.test(aDup.error || '') && /400/.test(aBad.error || '') && !!aKind.error && acc.status === 403 && accOff === 403
    && accP.status === 200 && accP.body?.event?.status === 'accepted' && rd('events.json').events.find(e => e.id === 'her_hi_there').accepted_by === 'director',
    { a1: a1.error || a1.event?.status, aDup: aDup.error?.slice(0, 40), acc: acc.status, accOff, accP: accP.status });
  // anchors over the agent tools: the anchored edge takes the event's time; snap "events"; an unknown event is dropped with a warning
  const sc1 = await call(mcp, 'scenes_update', { project: EP, upsert: [{ id: 'sc02', t1: 17900, anchors: { t1: 'stop_outro' } }, { id: 'sc03', t0: 18000 }], message: 'anchor sc02 end' });
  const sb1 = await call(mcp, 'shots_update', { project: EP, upsert: [{ id: 's3-grid', t1: '0:11.950' }, { id: 's4-chorus', t0: '0:11.950' }], snap: 'events', message: 'cut on the drop' });
  const sbBad = await call(mcp, 'shots_update', { project: EP, upsert: [{ id: 's2-wall', anchors: { t1: 'no_such_event' } }], message: 'bad anchor' });
  const sbBad2 = await call(mcp, 'shots_update', { project: EP, upsert: [{ id: 's2-wall', anchors: { t1: '../x' } }] });
  const s2 = curV('scenes.json', 'scenes').find(s => s.id === 'sc02'), b3 = curV('storyboard.json', 'shots').find(s => s.id === 's3-grid'), b4 = curV('storyboard.json', 'shots').find(s => s.id === 's4-chorus');
  check('scenes_update / shots_update anchor boundaries to named events: anchors {t1: stop_outro} sets sc02\'s end to the event\'s time (17.9 -> 18.0 s, warned); snap "events" puts a cut typed at 11.95 s on drop_chorus (12.0 s) and anchors it; an unknown or a proposed event is dropped with a warning; an anchor that is not an event id is 400',
    s2?.t1 === 18000 && s2.anchors?.t1 === 'stop_outro' && (sc1.warnings || []).some(w => /anchored to stop_outro/.test(w)) && b3?.t1 === 12000 && b3.anchors?.t1 === 'drop_chorus' && b4?.t0 === 12000 && b4.anchors?.t0 === 'drop_chorus'
    && (sbBad.warnings || []).some(w => /no_such_event.*dropped/.test(w)) && !curV('storyboard.json', 'shots').find(s => s.id === 's2-wall').anchors && /400/.test(sbBad2.error || '') && (scP.warnings || []).some(w => /her_hi_there.*dropped/.test(w)),
    { s2: s2 && [s2.t1, s2.anchors], w1: sc1.warnings || sc1.error, b3: b3 && [b3.t1, b3.anchors], b4: b4 && [b4.t0, b4.anchors], w: sbBad.warnings, scP: scP.warnings, bad2: sbBad2.error?.slice(0, 60) });
  // the director measures (page); the agent proposes a re-time; nothing moves; applying is the page's
  const m1 = await pageOp('events_act', { act: 'measure', id: 'stop_outro', measured: 18250 });
  const mAgent = await agentOp('events_act', { act: 'measure', id: 'stop_outro', measured: 19000 });
  const g1 = await call(mcp, 'events_get', { project: EP });
  const scV = rd('scenes.json').current, sbV = rd('storyboard.json').current;
  const pr = await call(mcp, 'retime_propose', { project: EP, moves: [{ event: 'stop_outro', to: '0:18.250' }, { event: 'drop_chorus', to: 11900 }], why: 'measured on the stems' });
  const prBad = await call(mcp, 'retime_propose', { project: EP, moves: [{ event: 'stop_outro', to: 3000 }] });
  const prNone = await call(mcp, 'retime_propose', { project: EP, moves: [{ event: 'nope', to: 1000 }] });
  const rows = pr.plan?.rows || [], has = (k, id, e, a, b, why) => rows.some(r => r.kind === k && r.id === id && r.edge === e && r.from === a && r.to === b && r.why === why);
  check('retime_propose: the plan lists every boundary anchored to the moved events and the cuts that share them (sc02 end anchored, sc03 start / s4-chorus end / s5-outro start shared, s3-grid end and s4-chorus start anchored) and records a PROPOSED re-time; nothing moves; a re-time that would leave a boundary without length is 400, an unknown event 404; measuring is the page\'s (agent 403); events_get shows the pending plan',
    pr.retime && has('scene', 'sc02', 't1', 18000, 18250, 'anchored') && has('scene', 'sc03', 't0', 18000, 18250, 'shared') && (has('shot', 's4-chorus', 't1', 18000, 18250, 'shared') || has('shot', 's4-chorus', 't1', 18000, 18250, 'anchored')) && has('shot', 's5-outro', 't0', 18000, 18250, 'shared')
    && has('shot', 's3-grid', 't1', 12000, 11900, 'anchored') && has('shot', 's4-chorus', 't0', 12000, 11900, 'anchored') && rows.length === 6
    && rd('scenes.json').current === scV && rd('storyboard.json').current === sbV && rd('events.json').retimes.find(r => r.id === pr.retime)?.status === 'proposed'
    && /400/.test(prBad.error || '') && /404/.test(prNone.error || '') && m1.status === 200 && mAgent.status === 403 && g1.pending?.rows?.length === 4,
    { pr: pr.error || rows.map(r => `${r.kind} ${r.id}.${r.edge} ${r.from}->${r.to} ${r.why}`), prBad: prBad.error?.slice(0, 80), prNone: prNone.error?.slice(0, 40), m1: m1.status, mAgent: mAgent.status, pending: g1.pending?.rows?.length });
  const apA = await agentOp('retime_apply', { retime: pr.retime, via: 'page' }), apA2 = await agentOp('retime_undo', { retime: pr.retime });
  let apOff; try { S.ops.retime_apply(EP, { retime: pr.retime }); apOff = 200; } catch (e) { apOff = e.code; }
  const ap = await pageRetime('retime_apply', { retime: pr.retime });
  const scA = curV('scenes.json', 'scenes'), sbA = curV('storyboard.json', 'shots'), evA = rd('events.json');
  check('applying a re-time is the page\'s (agent HTTP 403 even claiming via "page", retime_undo 403, offline 403); the page applies the proposal: ONE new scenes version and ONE new storyboard version with the boundaries moved (anchors kept, the picks untouched), the events at their new times (measured cleared, retimed history), the record applied by the director',
    apA.status === 403 && apA2.status === 403 && apOff === 403 && ap.status === 200 && rd('scenes.json').versions.length === JSON.parse(JSON.stringify(rd('scenes.json'))).versions.length
    && ap.body.versions.scenes?.[0] === scV && ap.body.versions.storyboard?.[0] === sbV && scA.find(s => s.id === 'sc02').t1 === 18250 && scA.find(s => s.id === 'sc02').anchors?.t1 === 'stop_outro' && scA.find(s => s.id === 'sc03').t0 === 18250
    && sbA.find(s => s.id === 's3-grid').t1 === 11900 && sbA.find(s => s.id === 's4-chorus').t0 === 11900 && sbA.find(s => s.id === 's4-chorus').t1 === 18250 && sbA.find(s => s.id === 's5-outro').t0 === 18250
    && evA.events.find(e => e.id === 'stop_outro').t === 18250 && evA.events.find(e => e.id === 'stop_outro').measured == null && evA.events.find(e => e.id === 'stop_outro').retimed?.length === 1
    && evA.retimes.find(r => r.id === pr.retime)?.status === 'applied' && evA.retimes.find(r => r.id === pr.retime).applied_by === 'director',
    { apA: apA.status, apA2: apA2.status, apOff, ap: ap.status, versions: ap.body?.versions, err: ap.body?.error });
  const un = await pageRetime('retime_undo', { retime: pr.retime });
  const evU = rd('events.json'), scU = curV('scenes.json', 'scenes'), sbU = curV('storyboard.json', 'shots');
  const g2 = await call(mcp, 'events_get', { project: EP });
  const re = await pageRetime('retime_apply', { retime: pr.retime });
  check('retime_undo (page): new versions with the old times, the events back at their old times and pending again (measured = the re-timed time); retime_apply of the undone record redoes it',
    un.status === 200 && scU.find(s => s.id === 'sc02').t1 === 18000 && sbU.find(s => s.id === 's3-grid').t1 === 12000 && evU.events.find(e => e.id === 'stop_outro').t === 18000 && evU.events.find(e => e.id === 'stop_outro').measured === 18250
    && evU.retimes.find(r => r.id === pr.retime).status === 'undone' && g2.pending?.moves?.length === 2 && re.status === 200 && curV('scenes.json', 'scenes').find(s => s.id === 'sc02').t1 === 18250,
    { un: un.status, re: re.status, pend: g2.pending?.moves?.length });
  // an anchored event cannot be moved or removed directly (measure + re-time); import an audio events.json in seconds
  const upd = await pageOp('events_act', { act: 'update', id: 'stop_outro', t: 19000 }), rem = await pageOp('events_act', { act: 'remove', id: 'stop_outro' });
  const imp = await pageOp('events_act', { act: 'import', events: [{ id: 'her_hi_there', t: 5.5, kind: 'line' }, { id: 'duet_5_both', t: 16.5, kind: 'line', note: 'Does it matter?' }, { id: 'section_x', t: 2.0, kind: 'section' }] });
  const impA = await agentOp('events_act', { act: 'import', events: [{ id: 'zz', t: 1, kind: 'stop' }] });
  check('events_act (page): an anchored event\'s time is not changed directly (409: measure it and re-time) nor removed (409); import reads seconds (duet_5_both 16.5 s -> 16500 ms, a line -> voice), skips sections and existing ids; the agent cannot import (403)',
    upd.status === 409 && rem.status === 409 && imp.status === 200 && imp.body.added === 1 && imp.body.unit === 's' && rd('events.json').events.find(e => e.id === 'duet_5_both')?.t === 16500 && rd('events.json').events.find(e => e.id === 'duet_5_both').kind === 'voice' && impA.status === 403,
    { upd: upd.status, rem: rem.status, imp: imp.body, impA: impA.status });
}
// ==================== 25. (E1) named sync points and the re-time: END ====================
// ==================== 26. (E3 / E5 / E6) chapters, placeholder frames, looks per world: BEGIN ====================
// On its own project copy (mcp-worlds): js/chapters.js, js/placeholder.js, js/worlds.js, chapters_update and look_world_propose
// (lib/ops/storyboard.mjs, lib/ops/assets.mjs). look_create gives a new look its world; look_world_propose only proposes (the
// page accepts: asset_act, 403 to the agent surface and offline); scenes / shots carry a world and the cast chips wear the
// world's look (storyboard_get source "world"), a character without one is a gap (gaps_get looks, final_get's line `looks`);
// chapters_update writes chapters with a derived status (a status sent: ignored), storyboard_get / final_get / edl.json list
// them; the export's placeholders carry the frame (placeholder.svg) and the world; offline the same rules hold.
{
  const WP = 'mcp-worlds';
  S.duplicateProject(PROJECT, WP, true);
  const pageOp = (name, body = {}) => post(`/api/op/${name}?project=${WP}`, body, { origin: URL_ });
  const agentOp = (name, body = {}) => post(`/api/op/${name}?project=${WP}`, body);
  const tools = (await mcp.listTools()).tools;
  const tl = (n) => tools.find(t => t.name === n);
  const lc = await call(mcp, 'look_create', { project: WP, id: 'bo', name: 'Dance kit', world: 'dancing' });
  const lp = await call(mcp, 'look_world_propose', { project: WP, id: 'ada', look: 'base', world: 'on screen', why: 'LOOKS_PLAN: the hoodie is on screen' });
  const agentAcc = await agentOp('asset_act', { type: 'character', id: 'ada', act: 'look_world_accept', look: 'base', via: 'page' });
  const pageAcc = await pageOp('asset_act', { type: 'character', id: 'ada', act: 'look_world_accept', look: 'base' });
  const sc = await call(mcp, 'scenes_update', { project: WP, upsert: [{ id: 'sc01', context: 'on screen' }, { id: 'sc02', context: 'dancing' }] });
  const sb = await call(mcp, 'storyboard_get', { project: WP }), shots = sb.scenes.flatMap(x => x.shots);
  const s1 = shots.find(x => x.id === 's1-intro'), s4 = shots.find(x => x.id === 's4-chorus');
  const g = await call(mcp, 'gaps_get', { project: WP }), f = await call(mcp, 'final_get', { project: WP }), fl = f.checklist.find(c => c.id === 'looks');
  check('E6 tools: look_create world (a new look), look_world_propose (a proposal the page accepts: the agent surface 403 even with via "page"); scenes_update context; storyboard_get dresses Bo in "Dance kit" on the dancing shots (source world) and lists the worlds + the look matrix; Ada has no dancing look: gaps_get looks + final_get\'s line',
    !lc.error && lc.world === 'dancing' && !lp.error && lp.proposal?.world === 'on screen' && agentAcc.status === 403 && pageAcc.status === 200 && pageAcc.body?.world === 'on screen'
    && !sc.error && s1?.world === 'on screen' && s4?.assets.find(a => a.id === 'bo')?.variant === 'dance-kit' && s4.assets.find(a => a.id === 'bo').source === 'world'
    && sb.worlds.includes('dancing') && g.counts.looks >= 2 && g.looks.every(l => l.id === 'ada') && fl && !fl.ok && fl.gaps.length === Math.min(12, g.counts.looks)
    && /world/.test(tl('look_create')?.description + JSON.stringify(tl('look_create')?.inputSchema)) && /PROPOSAL/.test(tl('look_world_propose')?.description || ''),
    { lc: lc.error || lc.world, agentAcc: agentAcc.status, pageAcc: pageAcc.status, s4: s4?.assets.map(a => [a.id, a.variant, a.source]), looks: g.counts?.looks });
  const cu = await call(mcp, 'chapters_update', { project: WP, upsert: [{ name: 'One', scenes: ['sc01', 'sc02'], owner: 'agent-a', status: 'built' }, { name: 'Two', scenes: ['sc03'] }] });
  const mv = await call(mcp, 'chapters_update', { project: WP, upsert: [{ id: 'c2', scenes: ['sc02', 'sc03'] }] });
  const rm = await call(mcp, 'chapters_update', { project: WP, remove: ['c9'] });
  const ex = await call(mcp, 'composition_export', { project: WP }), edl = JSON.parse(fs.readFileSync(path.join(DATA, WP, 'exports', 'composition', 'edl.json'), 'utf8'));
  const r4 = edl.shots.find(x => x.id === 's4-chorus');
  const sb2 = await call(mcp, 'storyboard_get', { project: WP }), f2 = await call(mcp, 'final_get', { project: WP });
  check('E3 / E5 tools: chapters_update (upsert; a status sent ignored with a warning; a scene moved to c2 leaves c1; an unknown id 404); storyboard_get / final_get / edl.json list the chapters with their DERIVED status; every unpicked shot exports its placeholder frame (svg with its id) and its world',
    !cu.error && /status ignored/.test(JSON.stringify(cu.warnings || [])) && cu.chapters.length === 2 && cu.chapters.every(c => ['planned', 'generating'].includes(c.status))
    && !mv.error && mv.chapters.find(c => c.id === 'c1').scenes.join() === 'sc01' && mv.chapters.find(c => c.id === 'c2').scenes.join() === 'sc02,sc03' && /error 404/.test(rm.error || '')
    && sb2.chapters.length === 2 && sb2.scenes.find(x => x.id === 'sc02').chapter === 'c2' && f2.chapters.length === 2 && !ex.error && edl.chapters.length === 2
    && r4?.status === 'placeholder' && r4.world === 'dancing' && /<svg[^>]*>.*s4-chorus/.test(r4.placeholder.svg) && edl.shots.every(x => x.status !== 'placeholder' || x.placeholder.svg),
    { cu: cu.error || cu.chapters?.map(c => [c.id, c.status]), mv: mv.error || mv.chapters?.map(c => [c.id, c.scenes]), rm: rm.error, ex: ex.error || ex.counts });
  // offline (no server): the same rules on the files
  const off = await connect({ WORKBENCH_URL: 'http://localhost:9' });
  const oc = await call(off, 'chapters_update', { project: WP, upsert: [{ id: 'c1', owner: 'offline' }] }), ow = await call(off, 'look_world_propose', { project: WP, id: 'ada', look: 'base', world: '<b>' });
  let offAct = null; try { S.ops.asset_act(WP, { type: 'character', id: 'ada', act: 'look_world', look: 'base', world: 'dancing' }); offAct = 'allowed'; } catch (e) { offAct = e.code; }
  await off.close();
  check('E3 / E6 offline: chapters_update works on the files; a bad world is 400; the look\'s world without the page is 403', !oc.error && oc.chapters.find(c => c.id === 'c1')?.owner === 'offline' && /error 400/.test(ow.error || '') && offAct === 403, { oc: oc.error, ow: ow.error, offAct });
}
// ==================== 26. (E3 / E5 / E6) chapters, placeholder frames, looks per world: END ====================
// ==================== 27. (E4 / E7 / E8) render jobs, song versions, contact sheets ====================
// On its own project copy (mcp-renders): lib/ops/renders.mjs, lib/ops/songs.mjs, lib/contact.mjs. A render is a request of kind
// "render": the agent proposes it (render_propose: a draft, never a command); the director sets the command (render_config) and
// starts it (render_start): both page only (403 to the agent token, a claimed via "page", the runner, request_update and offline);
// the job runs a fake render command (ffmpeg colour bars) and registers the MP4 + sheets. Sheets: sheet_make (never a path from the
// caller: traversal refused), sheet_ask (a "review" note) answered by sheet_review. Song versions: song_version_add (a candidate)
// and song_version_plan; using one is the page's (song_version_use).
{
  const RP = 'mcp-renders';
  S.duplicateProject(PROJECT, RP, true);
  const pageOp = (name, body = {}) => post(`/api/op/${name}?project=${RP}`, body, { origin: URL_ });
  const AGENT_TOKEN = fs.readFileSync(path.join(DATA, '.wb-agent-token'), 'utf8').trim();
  const agentOp = (name, body = {}) => fetch(`${URL_}/api/op/${name}?project=${RP}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-agent-token': AGENT_TOKEN }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const J = (f) => JSON.parse(fs.readFileSync(path.join(DATA, RP, f), 'utf8'));
  const names = (await mcp.listTools()).tools.map(t => t.name);
  check('E4 / E7 / E8 tools: renders_get, render_propose, sheet_make, sheets_get, sheet_review, song_versions_get, song_version_add, song_version_plan, suno_brief; NO tool sets the render command, starts / cancels a render, asks a second opinion or uses a song version',
    ['renders_get', 'render_propose', 'sheet_make', 'sheets_get', 'sheet_review', 'song_versions_get', 'song_version_add', 'song_version_plan', 'suno_brief'].every(n => names.includes(n))
    && !['render_config', 'render_start', 'render_cancel', 'sheet_ask', 'song_version_use', 'song_upload'].some(n => names.includes(n)));
  // the agent proposes; a command it passes is never stored, request_create / request_update / the runner refuse a render
  const MARK = path.join(DATA, RP, 'PWNED.txt');
  const evil = ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(MARK)}, 'x')`];
  const pr = await call(mcp, 'render_propose', { project: RP, scope: 'excerpt', t0: 2000, t1: 10000, why: 'mcp test', command: evil });
  const pr2 = await agentOp('render_propose', { scope: 'excerpt', t0: 1000, t1: 5000, command: evil, render: { command: evil }, extra: { command: evil } });
  const rc = await call(mcp, 'request_create', { project: RP, kind: 'render', prompt: 'x', est_cost: 0, extra: { render: { scope: 'full', command: evil } } });
  const rid = pr.request?.id;
  const ru = await call(mcp, 'request_update', { project: RP, id: rid, status: 'running' });
  const rr = await call(mcp, 'request_run', { project: RP, ids: [rid] });
  const reqs = J('requests.json').items.filter(r => r.kind === 'render');
  check('E4 render_propose: a DRAFT request of kind render ($0, the spec checked, an excerpt at most 20 s), never a command (MCP or HTTP); request_create kind render 400; request_update running 403; request_run refuses it',
    pr.request?.status === 'draft' && pr.request.kind === 'render' && pr.request.est_cost === 0 && pr.request.render?.t1 === 10000 && pr2.status === 200
    && !JSON.stringify(reqs).includes('PWNED') && !reqs.some(r => r.command || r.render?.command || r.extra) && /error 400/.test(rc.error || '') && /error 403/.test(ru.error || '')
    && rr.refused?.some(x => x.id === rid && /render/.test(x.why)) && !(rr.started || []).length && /error 400/.test((await call(mcp, 'render_propose', { project: RP, scope: 'excerpt', t0: 0, t1: 25000 })).error || ''),
    { pr: pr.error || pr.request?.status, pr2: pr2.status, rc: rc.error, ru: ru.error, rr: rr.refused });
  // the command and the start are the director's
  const FAKE = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=size={width}x{height}:rate={fps}', '-t', '{duration}', '-pix_fmt', 'yuv420p', '{out}'];
  const ac1 = await agentOp('render_config', { config: { command: evil } }), ac2 = await post(`/api/op/render_config?project=${RP}`, { config: { command: evil }, via: 'page' });
  const as1 = await agentOp('render_start', { id: rid }), as2 = await post(`/api/op/render_start?project=${RP}`, { id: rid, via: 'page' }), sv = await agentOp('render_cancel', { id: rid });
  const save = await post(`/api/save/renders.json?project=${RP}`, { base_rev: 0, data: { config: { command: evil } } });
  const noCfg = await pageOp('render_start', { id: rid });
  const pc = await pageOp('render_config', { config: { command: FAKE, min_free_mb: 64, ram_wait_s: 0, width: 320, height: 180 } });
  const bad = await pageOp('render_config', { config: { command: ['ffmpeg', '{nope}'] } });
  check('E4 the render command is the director\'s: render_config / render_start / render_cancel 403 to the agent token and to a claimed via "page"; renders.json is not a save (403); no command yet: 409; the page sets it (an unknown {placeholder}: 400)',
    ac1.status === 403 && ac2.status === 403 && as1.status === 403 && as2.status === 403 && sv.status === 403 && save.status === 403 && noCfg.status === 409 && pc.status === 200 && bad.status === 400
    && J('renders.json').config.command.join(' ') === FAKE.join(' ') && J('requests.json').items.find(r => r.id === rid).status === 'draft',
    { ac1: ac1.status, ac2: ac2.status, as1: as1.status, as2: as2.status, save: save.status, noCfg: noCfg.status, pc: pc.status, bad: bad.status });
  const st = await pageOp('render_start', { id: rid });
  let done = null; for (let i = 0; i < 120 && !done; i++) { await wait(250); const g = await call(mcp, 'renders_get', { project: RP, id: rid }); const r = g.renders?.[0]; if (['done', 'failed'].includes(r?.status)) done = r; }
  const media = J('media.json').items.filter(m => m.request === rid);
  check('E4 the page starts it: the director\'s command runs (ffmpeg colour bars), the log, the MP4 + a contact sheet registered (kind render / sheet) linked to the request and the revision; $0; the agent\'s command never ran',
    st.status === 200 && done?.status === 'done' && done.outputs.length >= 2 && fs.existsSync(path.join(DATA, RP, done.outputs[0])) && done.log_tail.some(l => /free RAM/.test(l)) && done.log_tail.some(l => /render: ffmpeg/.test(l))
    && media.some(m => m.kind === 'render' && m.render === rid && m.revision === 'R0') && media.some(m => m.kind === 'sheet') && J('requests.json').items.find(r => r.id === rid).actual_cost_usd === 0 && !fs.existsSync(MARK),
    { st: st.status, done: done?.status, why: done?.why, outs: done?.outputs, media: media.map(m => [m.kind, m.revision]) });
  // sheets: storyboard / request / render; never a path from the caller
  const s1 = await call(mcp, 'sheet_make', { project: RP, from: 'storyboard', title: '../../evil' }), s2 = await call(mcp, 'sheet_make', { project: RP, from: 'render', id: rid, every: 2 });
  const trav = await Promise.all([{ from: 'render', id: '../../x' }, { from: 'request', id: '..\\..\\x' }, { from: 'render', id: 'r1/../../x' }].map(a => call(mcp, 'sheet_make', { project: RP, ...a })));
  const trav2 = [await call(mcp, 'sheet_review', { project: RP, sheet: '../renders', verdict: 'ok' }), await call(mcp, 'sheets_get', { project: RP, sheet: '..' })];
  const get = await fetch(`${URL_}/data/${RP}/sheets/%2e%2e/%2e%2e/.wb-agent-token`);
  check('E8 sheet_make: storyboard (one tile per shot) and a render range, written under sheets/ with a generated id (a title is only a label); ids with "..", "\\" or "/" 400; sheet_review / sheets_get with a traversing id 400; /data/<p>/sheets/../ refused',
    !s1.error && /^sheets\/sh[a-z0-9]+\.jpg$/.test(s1.file) && fs.existsSync(s1.abs) && s1.tiles >= 3 && !s2.error && s2.tiles >= 3 && trav.every(x => /error 400/.test(x.error || '')) && trav2.every(x => /error 400/.test(x.error || '')) && get.status >= 400,
    { s1: s1.error || s1.file, s2: s2.error || s2.tiles, trav: trav.map(x => x.error?.slice(0, 30)), trav2: trav2.map(x => x.error?.slice(0, 30)), get: get.status });
  const ask = await pageOp('sheet_ask', { sheet: s1.sheet });
  const sg = await call(mcp, 'sheets_get', { project: RP, sheet: s1.sheet }), fr = sg.sheets?.[0]?.frames || [];
  const rv = await call(mcp, 'sheet_review', { project: RP, sheet: s1.sheet, verdict: 'issues', items: [{ t: fr[1]?.t ?? 0, shot: fr[1]?.shot?.id, ok: false, note: 'mcp: the wall is too dark' }], note: 'mcp: one issue', status: 'approved', via: 'page' });
  const okBad = await call(mcp, 'sheet_review', { project: RP, sheet: s1.sheet, verdict: 'ok', items: [{ ok: false, note: 'x' }] });
  const n = J('notes.json').notes.find(x => x.id === ask.body?.note);
  check('E8 second opinion: the page\'s ask is a note to the agent (ask "review", about the sheet); sheets_get gives each frame\'s scene / shot / lyric and the constants; sheet_review stores the review (via agent, never an approval) and absorbs the ask; "ok" with a failed item 400',
    ask.status === 200 && n?.ask === 'review' && n.about === `sheet:${s1.sheet}` && n.status === 'absorbed' && fr.some(f => f.shot && f.scene) && sg.sheets[0].abs && !rv.error && rv.review.via === 'agent' && rv.absorbed.includes(n.id)
    && /error 400/.test(okBad.error || '') && J('renders.json').sheets.find(s => s.id === s1.sheet).reviews.length === 1,
    { ask: ask.status, n: n?.status, rv: rv.error || rv.review?.verdict, okBad: okBad.error });
  // E7: the brief, a version, the plan; using it is the page's
  const br = await call(mcp, 'suno_brief', { project: RP, style: 'warm electro-pop, 120 bpm, D major', exclude: 'rap', save: true });
  const song0 = J('song.json'), take = path.join(TMP, 'mcp-take2.wav');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${(song0.duration_ms * 1.2 / 1000).toFixed(2)}`, take]);
  const lrc = song0.lines.map(l => { const t = (l.t0 * 1.2 + 250) / 1000, m = Math.floor(t / 60); return `[${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(2).padStart(5, '0')}] ${l.text}`; }).join('\n');
  const add = await call(mcp, 'song_version_add', { project: RP, path: take, source: 'suno', lrc, suno: { title: 'take 2', link: 'javascript:alert(1)' } });
  const plan = await call(mcp, 'song_version_plan', { project: RP, version: 'v2' });
  const useA = await agentOp('song_version_use', { version: 'v2' }), useB = await post(`/api/op/song_version_use?project=${RP}`, { version: 'v2', via: 'page' });
  const mid = J('song.json');
  check('E7 suno_brief (style + lyrics with [section] tags, the gates, saved); song_version_add (a candidate: the song unchanged; LRC lines matched; a non-https link dropped); song_version_plan lists the boundaries that would move; song_version_use 403 to the agent and a claimed via "page"',
    !br.error && br.ok && /^\[/.test(br.lyrics) && br.gates.every(g => g.ok) && J('settings.json').suno?.style === 'warm electro-pop, 120 bpm, D major'
    && !add.error && add.version.id === 'v2' && add.version.alignment.method === 'lrc' && add.version.alignment.matched >= song0.lines.length - 1 && !add.version.suno?.link
    && mid.duration_ms === song0.duration_ms && mid.current_version === 'v1' && !plan.error && plan.rows.length > 0 && !plan.problems.length && useA.status === 403 && useB.status === 403,
    { br: br.error || br.counts, add: add.error || add.version?.alignment, plan: plan.error || plan.summary, useA: useA.status, useB: useB.status });
  const use = await pageOp('song_version_use', { version: 'v2' }), after = J('song.json');
  check('E7 the page uses v2: the song\'s length, audio and lyric timings follow the take (LRC), every scene / shot boundary moves in a new scenes and storyboard version',
    use.status === 200 && after.current_version === 'v2' && Math.abs(after.duration_ms - song0.duration_ms * 1.2) < 60 && Math.abs(after.lines[0].t0 - (song0.lines[0].t0 * 1.2 + 250)) <= 12
    && use.body.versions?.scenes?.length === 2 && use.body.versions?.storyboard?.length === 2,
    { use: use.status, err: use.body?.error, dur: [song0.duration_ms, after.duration_ms], l0: [song0.lines[0].t0, after.lines[0].t0], v: use.body?.versions });
  // offline (no server): the same page-only rules
  const off = await connect({ WORKBENCH_URL: 'http://localhost:9' });
  let o1 = null, o2 = null, o3 = null;
  try { await S.ops.render_start(RP, { id: rid }); o1 = 'allowed'; } catch (e) { o1 = e.code; }
  try { S.ops.render_config(RP, { config: { command: evil } }); o2 = 'allowed'; } catch (e) { o2 = e.code; }
  try { await S.ops.song_version_use(RP, { version: 'v1' }); o3 = 'allowed'; } catch (e) { o3 = e.code; }
  const oprop = await call(off, 'render_propose', { project: RP, scope: 'full' });
  await off.close();
  check('E4 / E7 offline: render_start, render_config and song_version_use without the page are 403; render_propose still writes a draft', o1 === 403 && o2 === 403 && o3 === 403 && oprop.request?.status === 'draft' && oprop.request.render?.scope === 'full', { o1, o2, o3, oprop: oprop.error || oprop.warnings });
}
// ==================== 27. (E4 / E7 / E8) render jobs, song versions, contact sheets: END ====================
// ==================== 29. (G5) the project as a zip: export / import ====================
// On its own project copy (mcp-zip) with a private photo (the PRIVATE rule) and a file flagged private: project_export over MCP never
// holds them (the schema has no private switch; the op refuses an agent's include_private with 403), the page's personal backup does
// (private/exports/); project_import makes a NEW project with the approvals demoted and the costs kept; an agent cannot upload.
{
  const ZP = 'mcp-zip', ZD = path.join(DATA, ZP);
  S.duplicateProject(PROJECT, ZP, false);
  const Z = await import('../lib/zip.mjs');
  const pageOp = (name, body = {}) => post(`/api/op/${name}?project=${ZP}`, body, { origin: URL_ });
  const AGENT_TOKEN = fs.readFileSync(path.join(DATA, '.wb-agent-token'), 'utf8').trim();
  const agentOp = (name, body = {}) => fetch(`${URL_}/api/op/${name}?project=${ZP}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-agent-token': AGENT_TOKEN }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const png = Buffer.from(tinyPngB64(), 'base64');
  fs.mkdirSync(path.join(ZD, 'private', 'refs', 'ada'), { recursive: true }); fs.writeFileSync(path.join(ZD, 'private', 'refs', 'ada', 'secret-face.png'), png);
  fs.mkdirSync(path.join(ZD, 'media', 'still'), { recursive: true }); fs.writeFileSync(path.join(ZD, 'media', 'still', 'flagged-crop.png'), png);
  const M = JSON.parse(fs.readFileSync(path.join(ZD, 'media.json'), 'utf8'));
  M.items.push({ id: 'zip-secret', path: 'private/refs/ada/secret-face.png', kind: 'ref', private: true, entities: ['ada'] }, { id: 'zip-flagged', path: 'media/still/flagged-crop.png', kind: 'still', private: true });
  fs.writeFileSync(path.join(ZD, 'media.json'), JSON.stringify(M, null, 1));
  const names = (await mcp.listTools()).tools.map(t => t.name);
  check('G5 tools: project_export and project_import; NO tool uploads a file (project_upload is the page\'s) and project_export has no private switch',
    names.includes('project_export') && names.includes('project_import') && !names.includes('project_upload')
    && !Object.keys((await mcp.listTools()).tools.find(t => t.name === 'project_export').inputSchema.properties || {}).includes('include_private'));
  const ex = await call(mcp, 'project_export', { project: ZP, include_private: true });
  const zf = ex.error ? null : path.join(ZD, ex.path), z = zf ? Z.openZip(zf) : null;
  const zn = z ? z.entries.map(e => e.name) : [], jsonText = z ? z.entries.filter(e => e.name.endsWith('.json')).map(e => z.read(e).toString('utf8')).join('\n') : '';
  const man = z ? JSON.parse(z.read(z.entries.find(e => e.name === 'workbench-export.json')).toString('utf8')) : null;
  const sums = z ? man.files.every(f => crypto.createHash('sha256').update(z.read(z.entries.find(e => e.name === f.path))).digest('hex') === f.sha256) : false;
  z?.close();
  check('G5 project_export over MCP: exports/<p>-<stamp>.zip with the manifest (every file\'s sha256 right); the private photo and the flagged file are NOT in it, nor named in any JSON (an include_private sent anyway is ignored)',
    !ex.error && /^exports\/mcp-zip-\d{8}-\d{6}\.zip$/.test(ex.path) && ex.include_private === false && ex.private_excluded >= 2 && zn.includes('song.json') && zn.includes('media.json')
    && !zn.some(n => /secret-face|flagged-crop|^private\//.test(n)) && !/secret-face|flagged-crop/.test(jsonText) && sums && man.format === 'director-workbench/project-zip',
    { ex: ex.error || { path: ex.path, priv: ex.private_excluded }, leaked: zn.filter(n => /secret|flagged|private/.test(n)), sums });
  const a403 = await agentOp('project_export', { include_private: true }), fake = await agentOp('project_export', { include_private: true, via: 'page' });
  const pb = await pageOp('project_export', { include_private: true });
  const pz = pb.status === 200 ? Z.openZip(path.join(ZD, pb.body.path)) : null, pzn = pz ? pz.entries.map(e => e.name) : []; pz?.close();
  check('G5 an agent cannot opt private media in (403, also claiming via "page"); the page\'s personal backup holds them, under private/exports/',
    a403.status === 403 && fake.status === 403 && pb.status === 200 && /^private\/exports\/.+-personal\.zip$/.test(pb.body.path) && pzn.includes('private/refs/ada/secret-face.png') && pzn.includes('media/still/flagged-crop.png'),
    { a403: a403.status, fake: fake.status, pb: pb.status, path: pb.body?.path });
  const A0 = JSON.parse(fs.readFileSync(path.join(ZD, 'approvals.json'), 'utf8')), C0 = JSON.parse(fs.readFileSync(path.join(ZD, 'costs.json'), 'utf8'));
  const dry = await call(mcp, 'project_import', { project: ZP, path: `data/${ZP}/${ex.path}`, dry_run: true });
  const dryWrote = !dry.error && fs.existsSync(path.join(DATA, dry.id));   // checked now: the real import below makes that id
  const im = await call(mcp, 'project_import', { project: ZP, path: `data/${ZP}/${ex.path}` });
  const ID = im.id, IJ = (f) => JSON.parse(fs.readFileSync(path.join(DATA, ID || 'x', f), 'utf8'));
  const A1 = ID ? IJ('approvals.json') : { items: {} }, R1 = ID ? IJ('requests.json') : { items: [] }, C1 = ID ? IJ('costs.json') : {};
  check('G5 project_import over MCP: a NEW project (mcp-zip-import); approvals approved / locked arrive as review, every request as draft, costs kept as history; the original untouched',
    !dry.error && dry.dry_run && !dryWrote && !im.error && ID === 'mcp-zip-import' && Object.values(A0.items).some(x => x.state === 'approved')
    && !Object.values(A1.items).some(x => ['approved', 'locked'].includes(x.state)) && R1.items.every(r => r.status === 'draft') && (C1.items || []).length === (C0.items || []).length && C1.imported?.from === ZP
    && JSON.parse(fs.readFileSync(path.join(ZD, 'approvals.json'), 'utf8')).rev === A0.rev,
    { dry: dry.error || dry.id, im: im.error || im.demoted, left: Object.values(A1.items).filter(x => x.state === 'approved').length, costs: [(C0.items || []).length, (C1.items || []).length, !!C1.imported], notDraft: R1.items.filter(r => r.status !== 'draft').length });
  const over = await call(mcp, 'project_import', { project: ZP, path: `data/${ZP}/${ex.path}`, id: ZP });
  const privImp = await call(mcp, 'project_import', { project: ZP, path: `data/${ZP}/${pb.body?.path}` });
  const outside = await call(mcp, 'project_import', { project: ZP, path: `../${ex.path}` });
  const up = await agentOp('project_upload', { upload: 'abcdefgh12', kind: 'zip', size: 10, offset: 0, data: 'UEsDBA==' });
  const upImp = await agentOp('project_import', { upload: 'abcdefgh12' });
  check('G5 never over an existing project (409); a personal backup is the director\'s to import (403); a path outside exports/ or the media roots is refused; an agent cannot upload a file or import an upload (403)',
    /409/.test(over.error || '') && /403/.test(privImp.error || '') && /40[03]/.test(outside.error || '') && up.status === 403 && upImp.status === 403,
    { over: over.error, privImp: privImp.error, outside: outside.error, up: up.status, upImp: upImp.status });
}
// ==================== 29. (G5) the project as a zip: END ====================

// ==================== 30. (G7) the npm helper: bin/cli.mjs mcp = the MCP server + the page server in ONE process ====================
{
  const HD = path.join(TMP, 'helper-data'), HP = PORT + 7;
  const henv = { ...process.env }; for (const k of ['WORKBENCH_DATA', 'WORKBENCH_URL', 'WORKBENCH_OFFLINE', 'WB_PROJECT', 'WORKBENCH_PROJECT', 'WB_AGENT_TOKEN', 'WB_TOKEN']) delete henv[k];
  let hlog = '';
  const ht = new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'bin', 'cli.mjs'), 'mcp', '--data', HD, '--port', String(HP)], env: henv, stderr: 'pipe' });
  ht.stderr?.on('data', (d) => { hlog += d; });
  const hc = new Client({ name: 'workbench-helper-test', version: '1.0.0' });
  try {
    await hc.connect(ht);
    const st = await call(hc, 'status', {});
    const page = await fetch(`http://localhost:${HP}/?project=demo`).then(async r => ({ status: r.status, html: await r.text() })).catch(e => ({ status: 0, html: String(e) }));
    const made = ['_template', 'demo', '.wb-first-run', '.wb-agent-token'].filter(f => fs.existsSync(path.join(HD, f)));
    check('G7 `ai-videoclip-director mcp --data <dir> --port <p>`: a first run makes the data folder (the template, the demo, the onboarding mark, the agent token); the MCP server answers AND the page is served from the same process (status: server up at that port, mode http, the helper\'s data folder); nothing on stdout but the protocol',
      made.length === 4 && st.server?.up === true && st.server.url === `http://localhost:${HP}` && st.mode === 'http' && path.resolve(st.data_dir) === path.resolve(HD) && page.status === 200 && /name="wb-token"/.test(page.html) && /serving the page/.test(hlog),
      { made, server: st.server?.url, up: st.server?.up, mode: st.mode, data: st.data_dir, page: page.status, log: hlog.slice(0, 200) });
    const na = await call(hc, 'notes_add', { project: 'demo', target: { stage: 'lyrics', kind: 'stage' }, text: 'G7 helper: an agent note through the in-process server' });
    const nj = JSON.parse(fs.readFileSync(path.join(HD, 'demo', 'notes.json'), 'utf8'));
    const n = nj.notes.find(x => /G7 helper/.test(x.text));
    check('G7 a tool write goes through the in-process server with the agent token: stamped via agent (never the director), in the helper\'s data folder',
      !na.error && n?.via === 'agent', { na: na.error || na.id, via: n?.via });
    // a second MCP process on the same port finds the running workbench and uses it (no second server)
    let log2 = '';
    const t2 = new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'bin', 'cli.mjs'), 'mcp', '--data', HD, '--port', String(HP)], env: henv, stderr: 'pipe' });
    t2.stderr?.on('data', (d) => { log2 += d; });
    const c2 = new Client({ name: 'workbench-helper-test-2', version: '1.0.0' });
    await c2.connect(t2);
    const st2 = await call(c2, 'status', {});
    await c2.close().catch(() => {});
    check('G7 a second `mcp` on the same port uses the workbench already serving there (no second server; mode http)', st2.server?.up === true && st2.mode === 'http' && !/serving the page/.test(log2), { up: st2.server?.up, log2: log2.slice(0, 200) });
    const con = spawnSync(process.execPath, [path.join(WB, 'bin', 'cli.mjs'), 'connect', '--data', HD, '--port', String(HP)], { encoding: 'utf8', env: henv });
    const ver = spawnSync(process.execPath, [path.join(WB, 'bin', 'cli.mjs'), '--version'], { encoding: 'utf8' });
    check('G7 `connect` prints the claude mcp add line for this helper (bin/cli.mjs mcp --data … --port …) and where the agent token lives, never the token; --version = package.json',
      con.status === 0 && /claude mcp add workbench -- node .*bin\/cli\.mjs"? mcp --data .* --port \d+/.test(con.stdout) && /\.wb-agent-token/.test(con.stdout)
      && !con.stdout.includes(fs.readFileSync(path.join(HD, '.wb-agent-token'), 'utf8').trim()) && ver.stdout.trim() === JSON.parse(fs.readFileSync(path.join(WB, 'package.json'), 'utf8')).version,
      { out: con.stdout.slice(0, 300), ver: ver.stdout.trim() });
  } catch (e) { check('G7 helper block ran', false, String(e.stack || e) + '\n' + hlog.slice(-600)); }
  finally { await hc.close().catch(() => {}); }
}
// ==================== 30. (G7) the npm helper: END ====================
} catch (e) { check('test ran to the end', false, String(e.stack || e)); }
finally {
  // ---------------------------------------------------------------- clean up whatever happened
  await mcp?.close().catch(() => {});
  if (browser) await browser.close().catch(() => {}); sse.stop?.();
  srv?.kill(); await FAL.close(); await wait(300);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
const origAfter = hashAll(ORIG);
const same = Object.keys(origBefore).length === Object.keys(origAfter).length && Object.entries(origBefore).every(([f, h]) => origAfter[f] === h);
check('data/demo untouched (the test ran on a scratch copy)', same, same ? undefined : { changed: Object.keys(origBefore).filter(f => origAfter[f] !== origBefore[f]), extra: Object.keys(origAfter).filter(f => !origBefore[f]) });
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
