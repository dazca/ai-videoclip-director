// v18 of the headless UI suite (tools/verify.mjs): ROADMAP_v4 D3b (video generation in the request runner) + the light
// D3c (a failed take retried inside a done request, video one at a time, stale locks), live in the page. Exported so
// verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-video.mjs [outDir]
// Self-contained: a scratch copy of data/demo, a MOCK fal (tools/mock-fal.mjs: never the real one; WB_TEST=1 +
// WB_FAL_BASE; its video endpoints check each kind's parameters and answer a placeholder MP4 made with ffmpeg), its own
// serve.mjs on a free port (never 8140); all removed at the end. Checks: the Queue's video form (a motion-only prompt, the
// duration selector with the cost of each length, the start / end frame pickers from approved nodes and registered
// images, the H3 promo date switch); a video request approved and run: live progress, one take failing at the provider,
// "Retry take 2" runs only that take (the cost recorded once per take); the outputs are .mp4 takes of the shot (fps,
// duration) in Review › Takes; motion control with a reference video; two video requests run one at a time; a stale lock
// is cleaned up. Screenshots v18_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockFal } from './mock-fal.mjs';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = async () => { for (;;) { const p = await new Promise(ok => { const s = net.createServer().listen(0, () => { const x = s.address().port; s.close(() => ok(x)); }); }); if (p !== 8140) return p; } };

export async function verifyVideo({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v18 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v18-')), DATA = path.join(TMP, 'data'), ND = path.join(DATA, 'demo');
  fs.cpSync(path.join(WB, 'data', 'demo'), ND, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  // Ada's identity is approved (n01 = ada_face.jpg): the start frame comes from the approved nodes
  const adaF = path.join(ND, 'entities', 'characters', 'ada.json'), ada = JSON.parse(fs.readFileSync(adaF, 'utf8'));
  ada.iter = { nodes: [{ id: 'n01', tree: 'identity', parent: null, image: 'media/still/ada_face.jpg', request: null, kind: 'identity', choice: null, at: '2026-10-05T10:00:00', by: 'director', via: 'page' }], trees: { identity: { head: 'n01', approved: 'n01' } }, notes: [], log: [] };
  fs.writeFileSync(adaF, JSON.stringify(ada, null, 1));
  const KEY = `fal-v18-${Math.random().toString(36).slice(2)}`;
  const FAL = await startMockFal({ key: KEY, polls: 2 });
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: 'demo', WB_AGENT_APPROVALS: '', WB_TEST: '1', WB_FAL_BASE: FAL.url, FAL_KEY: KEY, WB_RUN_POLL_MS: '200', WB_TEST_DATE: '' } });
  let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; process.stderr.write('v18 server: ' + d); });
  let pg = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=demo`)).text())?.[1];
    const agent = async (name, body) => { const r = await fetch(`${BASE}/api/op/${name}?project=demo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const readJ = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ND, f), 'utf8')); } catch (e) { return null; } };
    const reqOf = (id) => readJ('requests.json')?.items?.find(r => r.id === id);
    const fileUntil = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { /* not yet */ } await wait(100); } return false; };
    const c = readJ('costs.json'); c.cap_usd = 20; fs.writeFileSync(path.join(ND, 'costs.json'), JSON.stringify(c));

    pg = await browser.newPage();
    await pg.setViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v18 pageerror', e.message));
    pg.on('console', m => { if (/warn|error/.test(m.type())) console.error('v18 console', m.type(), m.text().slice(0, 300)); });
    const outside = [];
    await pg.setRequestInterception(true);
    pg.on('request', (r) => { const u = r.url(); if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue(); outside.push(u); return r.abort(); });
    const frames = () => pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const click = async (sel) => { const r = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(12, b.width / 2), y: b.top + b.height / 2 }; }, sel); if (!r) throw new Error('no element ' + sel); await pg.mouse.click(r.x, r.y); await wait(250); };
    const shot = async (name, clip) => { await pg.evaluate(() => Promise.race([new Promise(r => setTimeout(r, 1200)), Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; })))])); await frames(); await pg.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) }); };
    const row = (id) => `.queue tr[data-id="${id}"]`;
    const formVal = () => pg.evaluate(() => { const f = document.querySelector('.queue .qform'); return { title: f.querySelector('.qfh b')?.textContent, secs: [...f.querySelectorAll('select[data-f=seconds] option')].map(o => o.textContent), start: [...f.querySelectorAll('select[data-f=start] optgroup')].map(g => [g.label, g.children.length]), startFirst: f.querySelector('select[data-f=start] optgroup option')?.textContent, end: f.querySelector('select[data-f=end] option')?.textContent, est: f.querySelector('.qest')?.textContent.replace(/\s+/g, ' ').trim(), prompt: f.querySelector('.qprompt')?.textContent.slice(0, 80), ref: !!f.querySelector('select[data-f=ref_video]'), thumbs: [...f.querySelectorAll('.qvthumbs .qthumb span')].map(s => s.textContent), warn: f.querySelector('.qwarn')?.textContent }; });
    await pg.goto(`${BASE}/?project=demo`, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await pg.evaluate(async () => { await window.WB.app.show('queue'); });
    await until(() => !!document.querySelector('.queue [data-q=new]'));

    // 1. the video request form: model -> h3max; a motion-only prompt, the duration selector with costs, the frame pickers
    await click('.queue [data-q=new]');
    await pg.select('.queue .qform select[data-f=model]', 'h3max'); await wait(200);
    const f0 = await formVal();
    await pg.evaluate(() => { const t = document.querySelector('.queue .qform input[data-f=target]'); t.value = 'shot:s2-wall'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await pg.select('.queue .qform select[data-f=start]', 'media/still/ada_face.jpg'); await wait(150);
    await pg.select('.queue .qform select[data-f=end]', 'media/still/ada_body.jpg'); await wait(150);
    await pg.select('.queue .qform select[data-f=seconds]', '6'); await wait(150);
    await pg.evaluate(() => { const t = document.querySelector('.queue .qform input[data-f=takes]'); t.value = '2'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await click('.queue .qform [data-q=recipe]'); await wait(300);
    await pg.evaluate(() => { const set = (sel, v) => { const t = document.querySelector(sel); t.value = v; t.dispatchEvent(new Event('input', { bubbles: true })); }; set('.queue .qform input[data-fld=action]', 'Ada lifts her head and glances toward the window, a strand of hair moves'); set('.queue .qform input[data-fld=camera]', 'slow push-in'); });
    await pg.select('.queue .qform select[data-f=seconds]', '6'); await wait(200);
    const f1 = await formVal();
    // the H3 promo date switch, from the page's own price code (js/video.js + js/prices.js)
    const dates = await pg.evaluate(async () => { const V = await import('/js/video.js'); const v = { model: 'h3max', seconds: 6, start: 'x.jpg' }; return { promo: V.videoEstimate(v, { takes: 2, date: '2026-10-15' }).usd, after: V.videoEstimate(v, { takes: 2, date: '2026-10-16' }).usd, why: V.videoEstimate(v, { date: '2026-10-05' }).why, kling: V.videoEstimate({ model: 'kling3pro', seconds: 5 }, {}).usd }; });
    const fb = await pg.evaluate(() => document.querySelector('.queue .qform').getBoundingClientRect().toJSON());
    await shot('v18_video_form', { x: 0, y: Math.max(0, fb.y - 4), width: 1500, height: Math.min(900 - Math.max(0, fb.y - 4), fb.height + 8) });
    check('the video form: h3max turns it into a video request (motion prompt, a duration selector with each length\'s cost, start / end frame pickers with the approved nodes first), the recipe\'s motion blocks, est $0.58 = $0.048/s x 6 s x 2 takes (promo until 2026-10-15)',
      /video request/.test(f0.title) && f0.secs.some(s => /^6 s · \$0\.29$/.test(s)) && f0.secs.some(s => /^10 s · \$0\.48$/.test(s)) && f0.start[0]?.[0] === 'approved nodes' && /Ada · identity · n01/.test(f0.startFirst || '') && /none/.test(f0.end || '') && /motion prompt/.test(f0.prompt || '') && !f0.ref
      && /est \$0\.58/.test(f1.est) && /0\.048\/s/.test(f1.est) && /promo until 2026-10-15/.test(f1.est) && f1.secs.some(s => /^6 s · \$0\.58$/.test(s)) && f1.thumbs.join(',').includes('start') && f1.thumbs.join(',').includes('end'), { f0, f1 });
    check('the H3 date switch: $0.048/s up to 2026-10-15, $0.08/s from 2026-10-16 (6 s x 2: $0.576 -> $0.96); Kling v3 Pro $0.112/s',
      dates.promo === 0.576 && dates.after === 0.96 && /promo until 2026-10-15, then \$0\.08\/s/.test(dates.why) && dates.kling === 0.56, dates);
    const n0 = (readJ('requests.json').items || []).length;
    await click('.queue .qform [data-q=add]');
    await fileUntil(() => readJ('requests.json').items.length > n0);
    const V = readJ('requests.json').items.at(-1);
    check('Add draft request: a draft with video {h3max, start, end, 6 s}, refs = [start, end], tool = the H3 endpoint, est_cost $0.576, a motion-only prompt from the recipe',
      V.status === 'draft' && V.kind === 'shot-video' && V.target === 'shot:s2-wall' && V.video?.model === 'h3max' && V.video.seconds === 6 && V.video.start === 'media/still/ada_face.jpg' && V.video.end === 'media/still/ada_body.jpg'
      && V.refs.join(',') === 'media/still/ada_face.jpg,media/still/ada_body.jpg' && V.tool === 'minimax/h3-max/image-to-video' && Math.abs(V.est_cost - 0.576) < 1e-9 && V.takes === 2 && /lifts her head/.test(V.prompt) && /Camera: slow push-in/.test(V.prompt), V);

    // 2. an agent cannot run it; the director approves and runs it: live progress (the provider "hangs" first)
    const early = await agent('request_run', { ids: [V.id] });
    await until((id) => !!document.querySelector(`.queue tr[data-id="${id}"] [data-x=approve]`), V.id);
    await click(`${row(V.id)} [data-x=approve]`);
    await fileUntil(() => reqOf(V.id).status === 'approved');
    await until((id) => !!document.querySelector(`.queue tr[data-id="${id}"] [data-x=run]`), V.id);
    const runLbl = await pg.evaluate((id) => document.querySelector(`.queue tr[data-id="${id}"] [data-x=run]`)?.textContent, V.id);
    FAL.mode = 'hang';
    await click(`${row(V.id)} [data-x=run]`);
    const live = await until((id) => /take 1\/2/.test(document.querySelector(`.queue tr[data-id="${id}"] .qprog`)?.textContent || ''), V.id, 10000);
    await wait(700);
    const prog = await pg.evaluate((id) => ({ prog: document.querySelector(`.queue tr[data-id="${id}"] .qprog`)?.textContent, vid: document.querySelector(`.queue tr[data-id="${id}"] .qvid`)?.textContent, chip: document.querySelector(`.queue tr[data-id="${id}"] .chip`)?.textContent }), V.id);
    await pg.evaluate((id) => document.querySelector(`.queue tr[data-id="${id}"]`)?.scrollIntoView({ block: 'center' }), V.id);
    await shot('v18_video_running');
    const vb = FAL.bodies.filter(b => b.endpoint === 'minimax/h3-max/image-to-video');
    check('an agent\'s request_run refuses the draft; the director approves and runs it ("Run · $0.58"): running with live progress (take 1/2, the seconds ticking), "h3max · 6 s · start→end"; the H3 payload names the uploaded start and end frames, duration 6 (integer), 768P',
      early.body?.started?.length === 0 && /draft/.test(early.body?.refused?.[0]?.why || '') && /Run · \$0\.58/.test(runLbl || '') && live && /running/.test(prog.chip || '') && /h3max · 6 s · start→end/.test(prog.vid || '')
      && vb.length === 1 && vb[0].body.duration === 6 && vb[0].body.resolution === '768P' && FAL.uploadsMeta.some(u => u.file_url === vb[0].body.image_url && u.content_type === 'image/jpeg') && FAL.uploadsMeta.some(u => u.file_url === vb[0].body.end_image_url) && !FAL.rejects.length, { prog, runLbl, body: vb[0]?.body, rejects: FAL.rejects });
    // take 1 finishes, take 2 fails at the provider
    FAL.failNext = 1; FAL.mode = 'ok';
    await fileUntil(() => reqOf(V.id).status === 'done', 20000);
    await until((id) => !!document.querySelector(`.queue tr[data-id="${id}"] [data-x=retake]`), V.id, 8000);
    const d1 = await pg.evaluate((id) => ({ retake: document.querySelector(`.queue tr[data-id="${id}"] [data-x=retake]`)?.textContent, done: document.querySelector(`.queue tr[data-id="${id}"] .qdone`)?.textContent }), V.id);
    const r1 = reqOf(V.id), cost1 = readJ('costs.json').items.filter(x => x.request === V.id);
    check('one take failed at the provider: done with 1 output (.mp4), takes_failed [1], $0.288 recorded once (6 s x $0.048); the row offers "Retry take 2 · $0.29"',
      r1.outputs?.length === 1 && /_0\.mp4$/.test(r1.outputs[0]) && r1.takes_failed?.join(',') === '1' && Math.abs(r1.actual_cost_usd - 0.288) < 1e-9 && cost1.length === 1 && Math.abs(cost1[0].usd - 0.288) < 1e-9 && /Retry take 2 · \$0\.29/.test(d1.retake || '') && /take 2 failed/.test(d1.done || ''), { d1, r1: { outputs: r1.outputs, tf: r1.takes_failed, usd: r1.actual_cost_usd }, cost1 });
    await pg.evaluate((id) => document.querySelector(`.queue tr[data-id="${id}"]`)?.scrollIntoView({ block: 'center' }), V.id);
    await shot('v18_video_take_failed');
    const s1 = FAL.stats.videoSubmits;
    await click(`${row(V.id)} [data-x=retake]`);
    await fileUntil(() => reqOf(V.id).outputs?.length === 2 && !reqOf(V.id).retaking, 20000);
    await until((id) => !document.querySelector(`.queue tr[data-id="${id}"] [data-x=retake]`) && /\$0\.58 spent/.test(document.querySelector(`.queue tr[data-id="${id}"] .qdone`)?.textContent || ''), V.id, 8000);
    const r2 = reqOf(V.id), cost2 = readJ('costs.json').items.filter(x => x.request === V.id), again = await agent('request_run', { ids: [V.id], retake: true });
    const job = readJ(`gen/${V.id}/job.json`);
    check('Retry take 2: only that take runs (1 submit, take 1 kept), the request stays done with 2 outputs and $0.576; its cost recorded once (<id>#1); a second retake is refused (nothing failed); job.json has each take\'s fps and duration',
      FAL.stats.videoSubmits === s1 + 1 && r2.status === 'done' && r2.outputs.length === 2 && !r2.takes_failed && Math.abs(r2.actual_cost_usd - 0.576) < 1e-9 && cost2.length === 2 && cost2.some(x => x.id === `${V.id}#1` && Math.abs(x.usd - 0.288) < 1e-9)
      && again.body?.started?.length === 0 && /no take failed/.test(again.body?.refused?.[0]?.why || '') && job.takes.every(t => t.status === 'done' && t.fps === 24 && t.duration_ms === 6000), { r2: { outputs: r2.outputs, usd: r2.actual_cost_usd }, cost2, again: again.body?.refused, takes: job.takes });
    await pg.evaluate((id) => document.querySelector(`.queue tr[data-id="${id}"]`)?.scrollIntoView({ block: 'center' }), V.id);
    await shot('v18_video_done');

    // 3. the outputs are takes of the shot (D6): takes_get and Review › Takes
    const tg = (await agent('takes_get', { request: V.id })).body;
    await pg.evaluate(() => window.WB.app.show('takes')); await wait(700);
    await until((k) => !!document.querySelector(`.tkview .tkli[data-k="${k}"]`), 'r:' + V.id);
    await pg.evaluate((k) => document.querySelector(`.tkview .tkli[data-k="${k}"]`)?.click(), 'r:' + V.id); await wait(500);
    await until(() => document.querySelectorAll('.tkview .tkmain .tkc[data-tkind=video]').length >= 2);
    const tv = await pg.evaluate(() => ({ cards: [...document.querySelectorAll('.tkview .tkmain .tkc')].map(c => c.querySelector('.tkl')?.textContent), video: document.querySelectorAll('.tkview .tkmain .tkc[data-tkind=video]').length, thumbs: [...document.querySelectorAll('.tkview .tkmain .tkc img')].length }));
    await shot('v18_takes');
    const ts = (await agent('takes_get', { shot: 's2-wall' })).body;
    check('the outputs are takes (D6): takes_get {request} lists 2 video takes #0 and #1 (6000 ms, 24 fps, runner); they are takes of shot s2-wall; Review › Takes shows them as video cards with thumbnails',
      tg?.takes?.length === 2 && tg.takes.every(t => t.kind === 'video' && t.duration_ms === 6000 && t.fps === 24 && t.source === 'runner') && tg.takes.map(t => t.take).join(',') === '0,1'
      && (ts?.takes || []).filter(t => t.request === V.id).length === 2 && tv.video >= 2 && tv.thumbs >= 2 && tv.cards.some(c => /6\.0s/.test(c || '')), { tg: tg?.takes?.map(t => [t.take, t.kind, t.duration_ms, t.fps]), tv });

    // 4. motion control (a reference video) and a Kling i2v, run together: video runs one at a time
    await pg.evaluate(async () => { await window.WB.app.show('queue'); });
    await click('.queue [data-q=new]');
    await pg.select('.queue .qform select[data-f=model]', 'klingmc'); await wait(200);
    await pg.select('.queue .qform select[data-f=ref_video]', 'media/clip/C1_0.mp4'); await wait(200);
    const fm = await formVal();
    const mcFormSecs = await pg.evaluate(() => document.querySelector('.queue .qform select[data-f=seconds]')?.value);
    await click('.queue .qform [data-q=close]');
    check('the motion-control form: a reference video picker (registered clips with their length); picking the 3 s clip sets the duration to 3 s',
      fm.ref && mcFormSecs === '3' && /reference video/.test(fm.warn || '') === false, { fm, mcFormSecs });
    const M = (await agent('request_create', { kind: 'motion', target: 'shot:s3-grid', prompt: 'an empty studio at dawn, cool window light, slow dust in the air', video: { model: 'klingmc', start: 'media/still/ada_body.jpg', ref_video: 'media/clip/C1_0.mp4', seconds: 3 } })).body;
    const K = (await agent('request_create', { kind: 'shot-video', target: 'shot:s4-chorus', prompt: 'Ada turns toward the camera. Camera: static locked-off camera.', video: { model: 'kling3pro', start: 'media/still/ada_face.jpg', seconds: 5 } })).body;
    await until((ids) => ids.every(id => document.querySelector(`.queue tr[data-id="${id}"] [data-x=approve]`)), [M.id, K.id]);
    await click(`${row(M.id)} [data-x=approve]`); await click(`${row(K.id)} [data-x=approve]`);
    await fileUntil(() => reqOf(M.id).status === 'approved' && reqOf(K.id).status === 'approved');
    await until(() => /Run all approved \(2\)/.test(document.querySelector('.queue [data-q=runall]')?.textContent || ''));
    const ev0 = FAL.events.length;
    await click('.queue [data-q=runall]');
    await fileUntil(() => reqOf(M.id).status === 'done' && reqOf(K.id).status === 'done', 25000);
    const ev = FAL.events.slice(ev0).filter(e => /video|motion/.test(e.endpoint || ''));
    const first = ev[0]?.endpoint, firstResp = ev.findIndex(e => e.type === 'response' && e.endpoint === first), otherSubmit = ev.findIndex(e => e.type === 'submit' && e.endpoint !== first);
    const mb = FAL.bodies.find(b => b.endpoint.endsWith('motion-control')), kb = FAL.bodies.find(b => b.endpoint.endsWith('v3/pro/image-to-video'));
    const mr = reqOf(M.id), kr = reqOf(K.id);
    check('motion control: the reference video uploaded to fal storage (video/mp4) and named as video_url, character_orientation video; Kling i2v: start_image_url, duration "5" (a string), generate_audio false, a negative prompt; $0.504 (3 s x $0.168) and $0.56 (5 s x $0.112); "Run all approved" ran the two video requests one at a time (the second submitted after the first finished)',
      mr.status === 'done' && kr.status === 'done' && /\.mp4$/.test(mr.outputs[0]) && Math.abs(mr.actual_cost_usd - 0.504) < 1e-9 && Math.abs(kr.actual_cost_usd - 0.56) < 1e-9
      && FAL.uploadsMeta.some(u => u.file_url === mb?.body?.video_url && u.content_type === 'video/mp4') && mb.body.character_orientation === 'video' && kb?.body?.duration === '5' && kb.body.generate_audio === false && !!kb.body.negative_prompt && !kb.body.end_image_url
      && firstResp >= 0 && otherSubmit > firstResp && !FAL.rejects.length, { ev: ev.map(e => e.type + ':' + e.endpoint.split('/').pop()), mb: mb?.body, kb: kb?.body });

    // 5. a stale lock (a runner that died) is cleaned up when the next plan is made
    const staleDir = path.join(ND, 'gen', K.id);
    await fileUntil(() => !fs.existsSync(path.join(staleDir, '.lock')) && !fs.existsSync(path.join(ND, 'gen', M.id, '.lock')));   // the runs released their locks
    await wait(300);
    fs.writeFileSync(path.join(staleDir, '.lock'), JSON.stringify({ pid: 999999, at: '2026-10-05T00:00:00', beat: Date.now() - 3600e3 }));
    const sdry = (await agent('request_run', { ids: [K.id], dry_run: true })).body;
    const keptDry = fs.existsSync(path.join(staleDir, '.lock'));
    const sreal = (await agent('request_run', { ids: [K.id] })).body;
    check('a stale lock (its runner gone) is left alone by a dry run and removed by the next run\'s plan (stale_locks_removed)', keptDry && !sdry?.stale_locks_removed && !fs.existsSync(path.join(staleDir, '.lock')) && (sreal?.stale_locks_removed || []).includes(K.id), { keptDry, sdry: sdry?.stale_locks_removed, sreal });

    const leaks = fs.readdirSync(ND, { recursive: true }).filter(f => { try { return fs.statSync(path.join(ND, f)).isFile() && fs.readFileSync(path.join(ND, f)).includes(KEY); } catch (e) { return false; } });
    check('nothing left the page (its requests stay on its server); the fal key is in no file and not in the server log; the key went to the CDN never', !outside.length && !leaks.length && !log.includes(KEY) && FAL.stats.keyOnCdn === 0 && FAL.stats.unauthorised === 0, { outside, leaks });
  } catch (e) { console.error('v18 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await pg?.close().catch(() => {});
    srv.kill(); await FAL.close(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-video.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyVideo({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v18 (video runner):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
