// v12 of the headless UI suite (tools/verify.mjs): ROADMAP_v4 D3a (the request runner) + D9 (Settings > Generator) + F3
// (an explicit Approve / Reject in the Queue), live in the page. Exported so verify.mjs runs it after the other blocks;
// runnable alone:   node tools/verify-runner.mjs [outDir]
// Self-contained: a scratch copy of data/demo, a MOCK fal (tools/mock-fal.mjs: never the real one; WB_TEST=1 +
// WB_FAL_BASE), its own serve.mjs on a free port (never 8140); all removed at the end. The page's own requests may only go
// to its server. Checks: the agent's drafts show Approve / Reject (no hidden chip); Approve, Approve selected, Reject;
// "Run all approved (N) · $X"; Run on one request -> running with the runner's progress (SSE) -> done with its outputs as
// thumbnails and nodes in Ada's identity tree (the stage shows them); Settings > Generator (fal default, the key's
// source only, openwith / comfyui) switches the image generator and the Run button follows. Screenshots v12_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockFal } from './mock-fal.mjs';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });

export async function verifyRunner({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v12 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v12-')), DATA = path.join(TMP, 'data'), ND = path.join(DATA, 'demo');
  fs.cpSync(path.join(WB, 'data', 'demo'), ND, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const KEY = `fal-v12-${Math.random().toString(36).slice(2)}`;
  const FAL = await startMockFal({ key: KEY, polls: 2 });
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: 'demo', WB_AGENT_APPROVALS: '', WB_TEST: '1', WB_FAL_BASE: FAL.url, FAL_KEY: KEY, WB_RUN_POLL_MS: '200' } });
  let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; process.stderr.write('v12 server: ' + d); });
  let pg = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=demo`)).text())?.[1];
    const agent = async (name, body) => { const r = await fetch(`${BASE}/api/op/${name}?project=demo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const readJ = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ND, f), 'utf8')); } catch (e) { return null; } };
    const reqOf = (id) => readJ('requests.json')?.items?.find(r => r.id === id);
    const fileUntil = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { /* not yet */ } await wait(100); } return false; };
    const c = readJ('costs.json'); c.cap_usd = 20; fs.writeFileSync(path.join(ND, 'costs.json'), JSON.stringify(c));

    // 1. the agent proposes (drafts) and cannot run them
    const A = (await agent('request_create', { kind: 'identity', target: 'character:ada', prompt: 'Ada identity sheet: four views and a head close-up, natural light, plain grey backdrop', refs: ['media/still/ada_face.jpg', 'media/still/ada_body.jpg'], est_cost: 0.24, takes: 2, tool: 'fal-ai/nano-banana-2/edit', asset: { type: 'character', id: 'ada', tree: 'identity', from: null, kind: 'identity' } })).body;
    const B = (await agent('request_create', { kind: 'shot-still', target: 'shot:s2-wall', prompt: 'The wall at dusk, 16:9, the frame sketch as layout', refs: ['media/still/studio.jpg'], est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' })).body;
    const C = (await agent('request_create', { kind: 'prop-sheet', target: 'prop:tone-generator', prompt: 'The tone generator, four angles', refs: ['media/still/tone_generator.jpg'], est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' })).body;
    const early = await agent('request_run', { ids: [A.id] });
    check('agent: drafts made; request_run refuses a draft (only the director approves)', !!(A?.id && B?.id && C?.id) && early.body?.started?.length === 0 && /draft/.test(early.body.refused?.[0]?.why || ''), early.body);

    // 2. the page: Review > Queue
    pg = await browser.newPage();
    await pg.setViewport({ width: 1500, height: 860, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v12 pageerror', e.message));
    pg.on('console', m => { if (/warn|error/.test(m.type())) console.error('v12 console', m.type(), m.text().slice(0, 300)); });
    const outside = [];
    await pg.setRequestInterception(true);
    pg.on('request', (r) => { const u = r.url(); if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue(); outside.push(u); return r.abort(); });
    const frames = () => pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const click = async (sel) => { const r = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(12, b.width / 2), y: b.top + b.height / 2 }; }, sel); if (!r) throw new Error('no element ' + sel); await pg.mouse.click(r.x, r.y); await wait(250); };
    const shot = async (name) => { await pg.evaluate(() => Promise.race([new Promise(r => setTimeout(r, 1200)), Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; })))])); await frames(); await pg.screenshot({ path: path.join(OUT, `${name}.png`) }); };
    const row = (id) => `.queue tr[data-id="${id}"]`;
    await pg.goto(`${BASE}/?project=demo`, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await pg.evaluate(async () => { await window.WB.app.show('queue'); });
    await until((ids) => ids.every(id => document.querySelector(`.queue tr[data-id="${id}"]`)), [A.id, B.id, C.id]);
    const q0 = await pg.evaluate((ids) => ({ btns: ids.map(id => [...document.querySelectorAll(`.queue tr[data-id="${id}"] .qbtns button`)].map(b => b.textContent)), runAll: document.querySelector('.queue [data-q=runall]')?.textContent, dis: document.querySelector('.queue [data-q=runall]')?.disabled, cycle: document.querySelectorAll('.queue [data-x=cycle]').length, ta: document.querySelector('.queue tr[data-id] textarea')?.rows, thumbs: document.querySelectorAll('.queue .qthumb img').length }), [A.id, B.id, C.id]);
    await click(`${row(B.id)} [data-x=pick]`); await click(`${row(C.id)} [data-x=pick]`);
    await until(() => /2 selected/.test(document.querySelector('.queue .qselt')?.textContent || ''));
    const selTxt = await pg.evaluate(() => document.querySelector('.queue .qselt')?.textContent);
    await shot('v12_queue_drafts');
    check('F3 the Queue: each draft has Approve / Reject buttons (no hidden chip), a readable prompt (3 rows), ref thumbnails; "Run all approved (0)" disabled; ticking two drafts shows "2 selected · $0.24"',
      q0.btns.every(b => b.join(',') === 'Approve,Reject') && q0.cycle === 0 && q0.ta === 3 && q0.thumbs >= 3 && /Run all approved \(0\)/.test(q0.runAll) && q0.dis && /2 selected · \$0\.24/.test(selTxt), { q0, selTxt });

    // 3. approve: one by its button, two by the selection; reject one
    await click(`${row(A.id)} [data-x=approve]`);
    await click('.queue [data-q=approvesel]');
    await fileUntil(() => [A, B, C].every(x => reqOf(x.id).status === 'approved'));
    await until((id) => !!document.querySelector(`.queue tr[data-id="${id}"] [data-x=reject]`), C.id);
    await click(`${row(C.id)} [data-x=reject]`);
    await fileUntil(() => reqOf(C.id).status === 'rejected');
    await until((ids) => /Run all approved \(2\) · \$0\.36/.test(document.querySelector('.queue [data-q=runall]')?.textContent || '') && !!document.querySelector(`.queue tr[data-id="${ids[0]}"] [data-x=run]`), [A.id]);
    const q1 = await pg.evaluate((ids) => ({ runA: document.querySelector(`.queue tr[data-id="${ids[0]}"] [data-x=run]`)?.textContent, runAll: document.querySelector('.queue [data-q=runall]')?.textContent, rejected: document.querySelector(`.queue tr[data-id="${ids[2]}"] .chip`)?.textContent }), [A.id, B.id, C.id]);
    const via = [A, B, C].map(x => reqOf(x.id).log.filter(l => l.status === 'approved').at(-1)?.via);
    await shot('v12_queue_approved');
    check('Approve (button) and Approve selected stamp the director\'s approval (via page); Reject; approved rows show "Run · $0.24"; "Run all approved (2) · $0.36"',
      via.every(v => v === 'page') && reqOf(C.id).status === 'rejected' && /Run · \$0\.24/.test(q1.runA || '') && /Run all approved \(2\) · \$0\.36/.test(q1.runAll || '') && q1.rejected === 'rejected', { via, q1 });

    // 4. Run A: the provider "hangs" first, so the page shows it running with the runner's live progress (SSE)
    FAL.mode = 'hang';
    await click(`${row(A.id)} [data-x=run]`);
    const live = await until((id) => /take 1\/2/.test(document.querySelector(`.queue tr[data-id="${id}"] .qprog`)?.textContent || ''), A.id, 10000);
    const prog = await pg.evaluate((id) => document.querySelector(`.queue tr[data-id="${id}"] .qprog`)?.textContent, A.id);
    await shot('v12_queue_running');
    check('Run: the request goes running in the page with the runner\'s progress from the server\'s SSE ("… take 1/2")', live && reqOf(A.id).status === 'running' && /running/.test(await pg.evaluate((id) => document.querySelector(`.queue tr[data-id="${id}"] .chip`)?.textContent, A.id)), { prog, status: reqOf(A.id).status });
    FAL.mode = 'ok';
    await fileUntil(() => reqOf(A.id).status === 'done', 15000);
    await until((id) => !!document.querySelector(`.queue tr[data-id="${id}"] .qthumb.out img`) && /node/.test(document.querySelector(`.queue tr[data-id="${id}"] .qdone`)?.textContent || ''), A.id, 8000);
    await until(() => /^spent \$0\.24/.test(document.querySelector('.queue .bar')?.textContent || ''), null, 6000);
    const q2 = await pg.evaluate((id) => ({ bar: document.querySelector('.queue .bar')?.textContent?.slice(0, 40), outs: document.querySelectorAll(`.queue tr[data-id="${id}"] .qthumb.out img`).length, done: document.querySelector(`.queue tr[data-id="${id}"] .qdone`)?.textContent }), A.id);
    const ada = readJ('entities/characters/ada.json'), ra = reqOf(A.id);
    await shot('v12_queue_done');
    check('done: 2 outputs as thumbnails, "$0.24 spent · nodes n01, n02 in ada identity: keep or pick"; Ada\'s identity tree has the 2 nodes from the request; one cost item',
      /^spent \$0\.24/.test(q2.bar || '') && q2.outs === 2 && /\$0\.24 spent/.test(q2.done || '') && /nodes/.test(q2.done || '') && ada.iter?.nodes?.filter(n => n.request === A.id).length === 2 && ra.linked?.nodes?.length === 2
      && readJ('costs.json').items.filter(x => x.request === A.id).length === 1, { q2, linked: ra.linked });
    await click(`${row(A.id)} [data-x=stage]`);
    const inStage = await until(() => document.querySelectorAll('.chreqs a[data-node]').length >= 2, null, 10000);
    const stg = await pg.evaluate(() => ({ nodes: [...document.querySelectorAll('.chreqs a[data-node]')].map(a => a.textContent), store: window.WB.store.entityById?.ada?.iter?.nodes?.length, costs: window.WB.store.costs.items.length }));
    await pg.evaluate(() => document.querySelector('.chreqs')?.scrollIntoView({ block: 'center' }));
    await shot('v12_done_stage');
    check('"Open in stage": the characters stage on Ada lists the request with its nodes n01, n02 (the director keeps or picks)', inStage && stg.nodes.join(',') === 'n01,n02', stg);

    // 5. Settings > Generator
    await pg.evaluate(async () => { await window.WB.app.show('settings'); });
    await until(() => !!document.querySelector('.settings .gentbl select[data-gen=image]'));
    const g0 = await pg.evaluate(() => ({ rows: [...document.querySelectorAll('.settings .gentbl tr[data-kind]')].map(r => [r.dataset.kind, r.querySelector('select').value, r.lastElementChild.textContent]), key: document.querySelector('.settings .genbox > .dim')?.textContent, opts: [...document.querySelectorAll('.settings select[data-gen=image] option')].map(o => o.value) }));
    await shot('v12_settings_generator');
    await pg.select('.settings select[data-gen=image]', 'openwith');
    await fileUntil(() => readJ('settings.json')?.generators?.image === 'openwith');
    await pg.evaluate(async () => { await window.WB.app.show('queue'); });
    await until((id) => /Export prompt pack/.test(document.querySelector(`.queue tr[data-id="${id}"] [data-x=run]`)?.textContent || ''), B.id);
    const runB = await pg.evaluate((id) => document.querySelector(`.queue tr[data-id="${id}"] [data-x=run]`)?.textContent, B.id);
    check('Settings > Generator: image / video / motion with fal the default, the key\'s source (never the key), openwith and comfyui listed; picking "Open in another app" for images is saved (settings.json) and the Run button follows ("Export prompt pack")',
      g0.rows.length === 3 && g0.rows.every(r => r[1] === 'fal') && /✓/.test(g0.rows[0][2]) && /found in the environment/.test(g0.key || '') && !(g0.key || '').includes(KEY) && ['fal', 'openwith', 'comfyui'].every(o => g0.opts.includes(o)) && /Export prompt pack/.test(runB || ''),
      { g0, runB });
    // the pack: Run B with openwith -> handed off, Copy prompt
    await click(`${row(B.id)} [data-x=run]`);
    await fileUntil(() => reqOf(B.id).status === 'running' && reqOf(B.id).handoff);
    await until((id) => !!document.querySelector(`.queue tr[data-id="${id}"] [data-x=copy]`), B.id);
    const hb = reqOf(B.id).handoff;
    check('openwith from the page: a prompt pack (prompt.txt, refs, README), the row says where to put the results, with Copy prompt and Collect results', !!hb?.pack && fs.existsSync(path.join(ND, hb.pack, 'prompt.txt')) && fs.existsSync(path.join(ND, hb.pack, 'README.md')), hb);
    await shot('v12_queue_handoff');
    const leaks = fs.readdirSync(ND, { recursive: true }).filter(f => { try { return fs.statSync(path.join(ND, f)).isFile() && fs.readFileSync(path.join(ND, f)).includes(KEY); } catch (e) { return false; } });
    check('nothing left the page (its requests stay on its server); the fal key is in no file and not in the server log', !outside.length && !leaks.length && !log.includes(KEY), { outside, leaks });
  } catch (e) { console.error('v12 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await pg?.close().catch(() => {});
    srv.kill(); await FAL.close(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-runner.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyRunner({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v12 (runner, generator, queue):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
