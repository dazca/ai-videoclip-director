// End-to-end test of the MCP server on the DEMO project (never on anyone's real project):
//   node mcp/test.mjs          (npm run test:mcp)
// Starts serve.mjs on a spare port, opens the demo page in headless Chromium (when puppeteer-core + a Chromium are
// available; otherwise an SSE client stands in for the page), spawns mcp/server.mjs over stdio with the official SDK
// client and exercises: tools/list, song_get, timeline_query, note_add + note_resolve, request_create + request_update
// (the approval and cap rules, done -> cost + media), snapshot_save + snapshot_restore, ui_focus, resources, the
// director-session prompt, and the offline (files only) mode. At the end the demo files are restored byte for byte.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT = 'demo', PORT = Number(process.env.TEST_PORT || 8146), URL_ = `http://localhost:${PORT}`;
const DATA = path.resolve(WB, process.env.WORKBENCH_DATA || 'data'), D = path.join(DATA, PROJECT);
if (!fs.existsSync(path.join(D, 'song.json'))) { console.error('no data/demo: run node tools/make_demo.mjs first'); process.exit(1); }

// ---------------------------------------------------------------- bookkeeping so the demo ends exactly as it started
const hashAll = () => Object.fromEntries(walk(D).filter(f => !f.startsWith('.snapshots/')).map(f => [f, crypto.createHash('sha1').update(fs.readFileSync(path.join(D, f))).digest('hex')]));
function walk(dir, rel = '') { const out = []; for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) out.push(...walk(dir, r)); else out.push(r); } return out; }
const before = hashAll();
const snapsBefore = new Set(fs.existsSync(path.join(D, '.snapshots')) ? fs.readdirSync(path.join(D, '.snapshots')) : []);

const results = []; let failed = 0;
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- the workbench server
const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(PORT)], { stdio: 'pipe', env: { ...process.env, WB_PROJECT: PROJECT } });
srv.stderr.on('data', d => process.stderr.write('server: ' + d));
await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });

// ---------------------------------------------------------------- "the open page": a real browser if we can, else an SSE client
let browser = null, page = null; const sse = { files: [], ui: [] };
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
      if (j.ui) { sse.ui.push(j.ui); fetch(`${URL_}/api/ui/ack?project=${PROJECT}`, { method: 'POST', body: JSON.stringify({ id: j.ui.id }) }); } else sse.files.push(j.file); } }
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

const mcp = await connect({ WORKBENCH_URL: URL_ });
try {
  // 1. tools
  const tools = (await mcp.listTools()).tools.map(t => t.name);
  const EXPECT = ['status', 'projects', 'snapshot_save', 'snapshot_list', 'snapshot_restore', 'song_get', 'timeline_query', 'shots_list', 'shot_get', 'shot_update', 'entities_list', 'entity_get', 'entity_upsert',
    'media_list', 'media_add', 'notes_list', 'note_add', 'note_resolve', 'approvals_get', 'approve', 'request_changes', 'requests_list', 'request_create', 'request_update', 'costs_get', 'ui_focus'];
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

  // 8. snapshot round trip: restore -> the notes/requests/costs written above are gone, the page reloads
  const rs = await call(mcp, 'snapshot_restore', { snapshot: snap.id });
  const notesAfter = await call(mcp, 'notes_list');
  const reqAfter = await call(mcp, 'requests_list');
  const filesBack = ['notes.json', 'requests.json', 'costs.json', 'approvals.json', 'shots.json', 'media.json'].every(f => fs.readFileSync(path.join(D, f)).equals(fs.readFileSync(path.join(D, '.snapshots', snap.id, f))));
  const pageBack = await pageHas((id, s) => s ? true : !window.WB.store.notes.notes.some(n => n.id === id), note.id);
  const snaps = await call(mcp, 'snapshot_list');
  check('snapshot_restore round trip (byte-identical, previous state kept, page reloaded)', rs.restored === snap.id && !notesAfter.some(n => n.id === note.id) && !reqAfter.some(r => r.id === rq.id) && filesBack && pageBack && snaps.some(s => s.id === rs.previous && s.auto),
    { restored: rs.restored, previous: rs.previous, changed: rs.changed, filesBack, pageBack });

  // 9. resources + prompt
  const resources = (await mcp.listResources()).resources.map(r => r.uri);
  const ff = await mcp.readResource({ uri: 'workbench://docs/file-formats' });
  const pf = await mcp.readResource({ uri: `workbench://project/${PROJECT}/song.json` });
  const prompt = await mcp.getPrompt({ name: 'director-session', arguments: { goal: 'fix the chorus colours' } });
  check('resources + director-session prompt', resources.includes('workbench://docs/claude') && resources.includes('workbench://docs/readme') && /requests\.json/.test(ff.contents[0].text) && JSON.parse(pf.contents[0].text).duration_ms === 20000
    && /APPROVED/.test(prompt.messages[0].content.text) && /fix the chorus colours/.test(prompt.messages[0].content.text), { resources: resources.length });
  fs.rmSync(out, { force: true });
} finally { await mcp.close(); }

// 10. offline: the server is unreachable -> the same tools work on the files; ui_focus explains
{
  const off = await connect({ WORKBENCH_URL: 'http://localhost:9' });
  const st = await call(off, 'status');
  const tq = await call(off, 'timeline_query', { t0: 4000, t1: 8000 });
  const ui = await call(off, 'ui_focus', { t: 1000 });
  check('offline mode: files directly, ui_focus refuses politely', st.mode === 'files' && tq.shots?.[0]?.id === 's2-wall' && /not running/.test(ui.error || ''), { mode: st.mode, shots: tq.shots?.map(s => s.id), ui: ui.error });
  await off.close();
}

// ---------------------------------------------------------------- leave the demo exactly as we found it
if (browser) await browser.close(); sse.stop?.();
srv.kill(); await wait(300);
for (const s of fs.existsSync(path.join(D, '.snapshots')) ? fs.readdirSync(path.join(D, '.snapshots')) : []) if (!snapsBefore.has(s)) fs.rmSync(path.join(D, '.snapshots', s), { recursive: true, force: true });
if (!snapsBefore.size && fs.existsSync(path.join(D, '.snapshots')) && !fs.readdirSync(path.join(D, '.snapshots')).length) fs.rmSync(path.join(D, '.snapshots'), { recursive: true });
const after = hashAll();
for (const f of Object.keys(after)) if (!before[f]) fs.rmSync(path.join(D, f));            // files the test created (copied output, its thumbnails)
for (const dir of ['media/clip', 'media', 'thumbs']) { const p = path.join(D, dir); if (fs.existsSync(p) && !fs.readdirSync(p).length) fs.rmSync(p, { recursive: true }); }
const final = hashAll();
const same = Object.keys(before).length === Object.keys(final).length && Object.entries(before).every(([f, h]) => final[f] === h);
check('demo project restored byte for byte', same, same ? undefined : { changed: Object.keys(before).filter(f => final[f] !== before[f]), extra: Object.keys(final).filter(f => !before[f]) });
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
