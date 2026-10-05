#!/usr/bin/env node
// Security regressions for E4 render jobs, E7 song versions and E8 contact sheets (ROADMAP_v4):
//   - page only (S9: the page token + this server's Origin + Sec-Fetch-Site: same-origin): render_config, render_start,
//     render_cancel, song_version_use, song_upload. 403 to the page token alone, the agent token, the Origin alone,
//     Sec-Fetch-Site alone, cross-site, a forged Origin with the agent token, a claimed via "page"; no MCP tool; offline refuses
//   - a render is never started by an agent: request_update (queued / running / done), request_run (the server and
//     tools/run.mjs) refuse a render request, even one a save marked "approved"
//   - the render command is never taken from an agent: render_propose drops any command; renders.json is not a save; an agent's
//     save of requests.json with a forged render.command / render_run never runs or reads anything else (the job reads the
//     director's config only; a job's files are named from its id); arguments go to the program without a shell
//   - sheet paths are not traversable: sheet_make / sheet_review / sheets_get take ids only (no "..", "\", "/", "%"),
//     the output is always sheets/<generated id>.jpg (private/sheets/ for a private source), /data/<p>/sheets/%2e%2e/ is refused
//   - song_version_add takes audio only, never a PRIVATE path or a path with ".."; the page's upload is sniffed as audio
//   - a project locked for render refuses the agent's render_propose (409) but not the director's render
//   - render whys, sheet titles and review notes render escaped in the page (Final's panel, the sheet viewer)
// Scratch copy of data/demo, its own server on a free port; never touches data/.   node tools/security-renders.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = 'rsec', TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sec-renders-')), DATA = path.join(TMP, 'data'), D = path.join(DATA, P);
fs.cpSync(path.join(WB, 'data', 'demo'), D, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
Object.assign(process.env, { WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P, WB_TEST: '1' });
for (const k of ['WB_TOKEN', 'WB_HOST', 'WB_ALLOW_REMOTE_OPS']) delete process.env[k];
const S = await import('../lib/store.mjs');
const RN = await import('../js/renders.js');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const J = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
const MARK = path.join(TMP, 'PWNED.txt');
const evil = ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(MARK)}, 'x')`];
const FAKE = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=size={width}x{height}:rate={fps}', '-t', '{duration}', '-pix_fmt', 'yuv420p', '{out}'];
let srv = null, browser = null;
try {
  const port = await freePort(), BASE = `http://localhost:${port}`;
  srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: process.env });
  srv.stderr.on('data', d => process.stderr.write('server: ' + d));
  await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
  const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
  const AGENT = fs.readFileSync(path.join(DATA, '.wb-agent-token'), 'utf8').trim();
  const H = {
    page: { 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'same-origin' },
    tokenOnly: { 'x-wb-token': TOKEN }, agent: { 'x-wb-agent-token': AGENT }, originOnly: { 'x-wb-token': TOKEN, origin: BASE },
    fetchSiteOnly: { 'x-wb-token': TOKEN, 'sec-fetch-site': 'same-origin' }, agentForged: { 'x-wb-agent-token': AGENT, 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'same-origin' },
    crossSite: { 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'cross-site' },
  };
  const op = async (name, body, h = H.agent) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const save = async (file, fn, h = H.page) => { const d = J(file); fn(d); const r = await fetch(`${BASE}/api/save/${file}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ base_rev: d.rev || 0, data: d }) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(200); } return null; };

  // 1. the page-only acts
  const pr = await op('render_propose', { scope: 'excerpt', t0: 1000, t1: 6000, why: 'sec', command: evil, render: { command: evil }, extra: { command: evil } });
  const rid = pr.body?.request?.id;
  const song = J('song.json'), take = path.join(TMP, 'take.wav');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${(song.duration_ms / 1000 + 1).toFixed(2)}`, take]);
  const ver = await op('song_version_add', { path: take, source: 'upload' });
  const BODIES = { render_config: { config: { command: evil } }, render_start: { id: rid }, render_cancel: { id: rid }, song_version_use: { version: 'v2' }, song_upload: { upload: 'abcdefgh12', size: 10, offset: 0, data: 'AAAA' } };
  const matrix = {};
  for (const [name, body] of Object.entries(BODIES)) {
    matrix[name] = {};
    for (const k of ['tokenOnly', 'agent', 'originOnly', 'fetchSiteOnly', 'agentForged', 'crossSite']) matrix[name][k] = (await op(name, body, H[k])).status;
    matrix[name].claimed = (await op(name, { ...body, via: 'page' }, H.agent)).status;
  }
  const offline = {};
  for (const name of Object.keys(BODIES)) { try { await S.ops[name](P, BODIES[name]); offline[name] = 'allowed'; } catch (e) { offline[name] = e.code; } }
  check('render_config / render_start / render_cancel / song_version_use / song_upload are page only: 403 to the page token alone, the agent token, the Origin alone, Sec-Fetch-Site alone, a forged Origin with the agent token, cross-site, a claimed via "page"; offline 403',
    rid && ver.status === 200 && Object.values(matrix).every(m => Object.values(m).every(s => s === 403)) && Object.values(offline).every(c => c === 403), { matrix, offline });

  // 2. a render is never started by an agent
  const forged = await save('requests.json', (d) => { const r = d.items.find(x => x.id === rid); r.status = 'approved'; r.render = { ...r.render, command: evil }; r.command = evil; r.render_run = { log: '../../.wb-agent-token', out: '../../../x.mp4' }; }, H.agent);
  const forged2 = await save('requests.json', (d) => { const r = d.items.find(x => x.id === rid); r.render = { ...r.render, command: evil }; r.command = evil; r.render_run = { log: '../../.wb-agent-token', out: '../../../x.mp4' }; }, H.agent);
  const r1 = await op('request_run', { ids: [rid] }), r2 = await op('request_update', { id: rid, status: 'queued' }), r3 = await op('request_update', { id: rid, status: 'done', outputs: ['x.mp4'], actual_cost_usd: 0 });
  const cli = spawnSync(process.execPath, [path.join(WB, 'tools', 'run.mjs'), '--project', P, rid], { env: process.env, encoding: 'utf8', timeout: 60000 });
  const g = await op('renders_get', { id: rid });
  check('a render is never started by an agent: request_run (even after a save marked it approved), request_update queued / done, tools/run.mjs refuse it; a forged render_run log path reads nothing (renders_get never shows the agent token file)',
    r1.status === 200 && !(r1.body.started || []).length && r1.body.refused?.some(x => /render/.test(x.why)) && r2.status === 403 && r3.status === 403 && !/started/i.test(cli.stdout + '') && /render/.test(cli.stdout + cli.stderr)
    && !JSON.stringify(g.body).includes(AGENT) && !fs.existsSync(MARK),
    { forged: forged.status, forged2: forged2.status, r1: r1.body?.refused, r2: r2.status, r3: r3.status, cli: (cli.stdout + cli.stderr).slice(0, 200) });

  // 3. the render command is never taken from an agent: the director's runs; the agent's never does; no shell
  const noSave = await fetch(`${BASE}/api/save/renders.json?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', ...H.page }, body: JSON.stringify({ base_rev: 0, data: { v: 1, config: { command: evil }, sheets: [] } }) });
  fs.writeFileSync(path.join(D, 'renders.json'), JSON.stringify({ v: 1, rev: 1, config: null, sheets: [] }));   // (reset what a hand edit could do; the server's copy is the truth)
  const pc = await op('render_config', { config: { command: [...FAKE.slice(0, -1), '{out}', ' & calc'].slice(0, FAKE.length), min_free_mb: 32, ram_wait_s: 0, width: 160, height: 90 } }, H.page);
  const pc2 = await op('render_config', { config: { command: FAKE, min_free_mb: 32, ram_wait_s: 0, width: 160, height: 90 } }, H.page);
  const st = await op('render_start', { id: rid, command: evil, config: { command: evil } }, H.page);
  const done = await until(async () => { const x = (await op('renders_get', { id: rid })).body?.renders?.[0]; return ['done', 'failed'].includes(x?.status) ? x : null; });
  check('the render command is the director\'s only: renders.json is not a save; render_start ignores a command in its body and in the request (forged by an agent\'s save); the director\'s FAKE command ran, the agent\'s never did; the outputs are named from the id',
    noSave.status === 403 && pc.status === 200 && pc2.status === 200 && st.status === 200 && done?.status === 'done' && !fs.existsSync(MARK) && done.outputs[0] === `renders/${rid}/${rid}.mp4` && fs.existsSync(path.join(D, done.outputs[0])),
    { noSave: noSave.status, st: st.status, done: done?.status, why: done?.why, outs: done?.outputs });
  check('placeholders: an unknown {name} is refused, a value is filled as one argument (never a shell)', (() => { try { RN.checkArgv(['x', '{evil}']); return false; } catch (e) { return /unknown placeholder/.test(e.message); } })()
    && RN.fillArgv(['a{from}b', '{nope}'], { from: '1 & calc' }).join('|') === 'a1 & calcb|{nope}');
  // one at a time: a live lock refuses a second start
  const p2 = (await op('render_propose', { scope: 'excerpt', t0: 0, t1: 3000 }, H.page)).body?.request?.id;
  fs.writeFileSync(path.join(DATA, '.render.lock'), JSON.stringify({ pid: process.pid, project: 'other', id: 'rX', at: new Date().toISOString().slice(0, 19), heartbeat: new Date().toISOString() }));
  const busy = await op('render_start', { id: p2 }, H.page);
  fs.rmSync(path.join(DATA, '.render.lock'), { force: true });
  check('one render at a time on the machine: a live render lock refuses another start (409)', busy.status === 409 && /one render at a time/.test(busy.body?.error || ''), { busy: busy.status });

  // 4. sheet paths
  const tries = [{ from: 'render', id: '../../x' }, { from: 'render', id: '..%2F..%2Fx' }, { from: 'render', id: 'a/b' }, { from: 'request', id: '..\\..\\x' }, { from: 'storyboard', cols: 99 }, { from: '../x' }];
  const sm = []; for (const t of tries) sm.push((await op('sheet_make', t)).status);
  const okSheet = await op('sheet_make', { from: 'storyboard', title: '../../../evil<img src=x onerror=window.__pwn=1>' });
  const rv = [await op('sheet_review', { sheet: '../renders', verdict: 'ok' }), await op('sheet_review', { sheet: 'SH..', verdict: 'ok' }), await op('sheets_get', { sheet: '../../x' }), await op('sheet_ask', { sheet: '..\\x' }, H.page)].map(x => x.status);
  const raw = await fetch(`${BASE}/data/${P}/sheets/%2e%2e/%2e%2e/.wb-agent-token`), raw2 = await fetch(`${BASE}/data/${P}/sheets/..%5c..%5c.wb-agent-token`);
  // a forged done render whose stored out points elsewhere: the sheet reads the canonical file only
  const sheetFromForged = await op('sheet_make', { from: 'render', id: rid });
  check('sheet paths are not traversable: sheet_make ids with "..", "/", "\\" or "%", a bad from / cols: 400; sheet_review / sheets_get / sheet_ask with a traversing id: 400; the file is sheets/<generated id>.jpg whatever the title; /data/<p>/sheets/%2e%2e and ..%5c refused',
    sm.every(s => s === 400) && okSheet.status === 200 && /^sheets\/sh[a-z0-9]+\.jpg$/.test(okSheet.body.file) && fs.existsSync(path.join(D, okSheet.body.file)) && rv.every(s => s === 400) && raw.status >= 400 && raw2.status >= 400
    && sheetFromForged.status === 200 && !fs.existsSync(path.join(TMP, 'x.mp4')),
    { sm, rv, raw: raw.status, raw2: raw2.status, file: okSheet.body?.file, forged: sheetFromForged.status });
  // a private take: its sheet goes to private/sheets and is flagged private
  fs.mkdirSync(path.join(D, 'private', 'still'), { recursive: true });
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:d=1', '-frames:v', '1', path.join(D, 'private', 'still', 'p1.png')]);
  const rq = await op('request_create', { kind: 'shot-still', target: 'shot:s2-wall', prompt: 'p', est_cost: 0.1 });
  const ma = await op('media_add', { path: 'private/still/p1.png', kind: 'still', request: rq.body?.id, private: true });
  const ps = await op('sheet_make', { from: 'request', id: rq.body?.id });
  const pm = J('media.json').items.find(m => m.path === ps.body?.file);
  check('a sheet of a private take is private: written under private/sheets/ and flagged private in media.json', ma.status === 200 && ps.status === 200 && /^private\/sheets\//.test(ps.body.file) && pm?.private === true, { ps: ps.body?.file, pm: pm?.private });

  // 5. song versions: audio only, never private, never ".."
  fs.writeFileSync(path.join(D, 'fake.wav'), 'not audio at all, a text file');
  fs.mkdirSync(path.join(D, 'private', 'audio'), { recursive: true }); fs.copyFileSync(take, path.join(D, 'private', 'audio', 'me.wav'));
  const sv = [await op('song_version_add', { path: 'private/audio/me.wav' }), await op('song_version_add', { path: '../../x.wav' }), await op('song_version_add', { path: 'fake.wav' }), await op('song_version_add', { path: 'song.json' }), await op('song_version_add', { path: take, source: 'import' })].map(x => x.status);
  const up = await op('song_upload', { upload: 'abcdefgh12', name: 'x.wav', size: 12, offset: 0, data: Buffer.from('<script>x</sc').toString('base64'), done: true }, H.page);
  check('song_version_add refuses a PRIVATE path (400), "..", a file that is not audio (415), a non-audio name, a source "import"; the page\'s upload is sniffed as audio (415)', sv[0] === 400 && sv[1] === 400 && sv[2] === 415 && sv[3] === 400 && sv[4] === 400 && up.status === 415, { sv, up: up.status });

  // 6. locked for render
  const lk = await op('final_lock', { force: true, summary: 'sec' }, H.page);
  const p409 = await op('render_propose', { scope: 'full' }), sOk = await op('sheet_make', { from: 'storyboard' }), dStart = await op('render_start', { id: p2 }, H.page);
  await until(async () => { const x = (await op('renders_get', { id: p2 })).body?.renders?.[0]; return ['done', 'failed'].includes(x?.status); });
  const ul = await op('final_unlock', {}, H.page);
  check('a project locked for render refuses the agent\'s render_propose (409); a sheet is still made; the director still renders', lk.status === 200 && p409.status === 409 && sOk.status === 200 && dStart.status === 200 && ul.status === 200, { lk: lk.status, p409: p409.status, sOk: sOk.status, dStart: dStart.status });

  // 7. escaping in the page
  await op('render_propose', { scope: 'excerpt', t0: 0, t1: 2000, why: '<img src=x onerror=window.__pwn=1>' });
  await op('sheet_review', { sheet: okSheet.body.sheet, verdict: 'issues', items: [{ ok: false, note: '<img src=x onerror=window.__pwn=1>' }], note: '<img src=x onerror=window.__pwn=1>' });
  try {
    const puppeteer = createRequire(path.join(WB, 'package.json'))('puppeteer-core');
    const { findChrome } = await import('./chrome.mjs');
    const exe = findChrome(); if (!exe) throw new Error('no Chromium');
    browser = await puppeteer.launch({ executablePath: exe, headless: true });
    const pg = await browser.newPage(); await pg.setViewport({ width: 1400, height: 850 });
    await pg.goto(`${BASE}/?project=${P}`); await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await pg.evaluate(() => window.WB.stages.open('final')); await wait(1200);
    const fx = await pg.evaluate(() => ({ panel: !!document.querySelector('.fnrend .rnh'), imgs: [...document.querySelectorAll('.fnrend img')].filter(i => !/\.jpg/.test(i.getAttribute('src') || '')).length, pwn: window.__pwn === 1, txt: /onerror/.test(document.querySelector('.fnrend')?.textContent || '') }));
    await pg.evaluate((id) => window.WB.renders.openSheet(id), okSheet.body.sheet); await wait(400);
    const vx = await pg.evaluate(() => ({ dlg: !!document.querySelector('.rnview'), imgs: [...document.querySelectorAll('.rnview img')].filter(i => !/\.jpg/.test(i.getAttribute('src') || '')).length, pwn: window.__pwn === 1, txt: /onerror/.test(document.querySelector('.rnview')?.textContent || '') }));
    check('render whys, sheet titles and review notes render as text in the page (Final\'s panel, the sheet viewer): no element injected, no script ran', fx.panel && fx.imgs === 0 && fx.txt && !fx.pwn && vx.dlg && vx.imgs === 0 && vx.txt && !vx.pwn, { fx, vx });
  } catch (e) { console.log('SKIP browser checks: ' + e.message); }
} catch (e) { check('test ran to the end', false, String(e.stack || e)); }
finally {
  if (browser) await browser.close().catch(() => {});
  srv?.kill(); await wait(400);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
console.log(`\n${n - failed}/${n} render / song version / sheet security checks passed`);
process.exit(failed ? 1 : 0);
