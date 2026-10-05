// v20 of the headless UI suite (tools/verify.mjs): ROADMAP_v4 D4, job books, waves and pilot gates, live in the page.
// Exported so verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-batches.mjs [outDir]
// Self-contained: a scratch copy of data/demo with a 10-shot storyboard, a fake falgen tree as the media base (tools/
// fake-falgen.mjs + a jobs_test.json job book), a MOCK fal (tools/mock-fal.mjs: never the real one), its own serve.mjs on
// a free port (never 8140); all removed at the end. Checks: Review › Queue › "Plan waves…" (a pilot of two ticked shots,
// then 4 and the rest, takes 2, the cap) creates draft batches gated wave after wave; the batches show as collapsible
// groups with their gate state; an agent cannot approve or unlock (403) and a locked batch never runs; "Approve batch ·
// $X" confirms with the total and the cap impact; "Run batch" runs it within its cap on the mock; the take is picked for
// one shot and the other's takes rejected, then "Mark reviewed" unlocks wave 2; the take-ratio stats (takes per used shot,
// cost per used second) and the remaining waves re-estimated; "Import job books" brings the falgen jobs in as history
// (done, outputs linked, never run, no new cost). Screenshots v20_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockFal } from './mock-fal.mjs';
import { makeFakeFalgen } from './fake-falgen.mjs';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = async () => { for (;;) { const p = await new Promise(ok => { const s = net.createServer().listen(0, () => { const x = s.address().port; s.close(() => ok(x)); }); }); if (p !== 8140) return p; } };

// a 10-shot storyboard (2 s each, no clips: every shot is a gap) and the job book of a first film
export function batchFixture(ND, base) {
  const shots = Array.from({ length: 10 }, (_, i) => ({ id: `w${String(i + 1).padStart(2, '0')}`, scene: null, t0: i * 2000, t1: (i + 1) * 2000, kind: 'insert', title: `shot ${i + 1}`, text: `an insert of object ${i + 1} on the desk`, camera: 'static', sketch: null, beats: [], cast: [], locations: [], props: [], variants: {}, gen: 'still', clips: [] }));
  fs.writeFileSync(path.join(ND, 'storyboard.json'), JSON.stringify({ rev: 1, current: 'v1', versions: [{ id: 'v1', n: 1, created: '2026-10-05T10:00:00', by: 'director', via: 'page', message: 'ten inserts', shots }], notes: [] }));
  const c = JSON.parse(fs.readFileSync(path.join(ND, 'costs.json'), 'utf8')); c.cap_usd = 20; fs.writeFileSync(path.join(ND, 'costs.json'), JSON.stringify(c));
  const pj = JSON.parse(fs.readFileSync(path.join(ND, 'project.json'), 'utf8')); pj.falgen = 'project/gen'; fs.writeFileSync(path.join(ND, 'project.json'), JSON.stringify(pj));
  if (base) fs.writeFileSync(path.join(base, 'project', 'gen', 'jobs_test.json'), JSON.stringify({ note: 'a test job book', jobs: [
    { id: 'A1', kind: 'image', model: 'nb2', resolution: '2K', n: 2, refs: ['project/gen/refs/face.png'], prompt: 'HOODIE HACKER at a beige CRT', notes: 'verse-4 still' },
    { id: 'G01', kind: 'video', model: 'h3', image: 'project/gen/out/A1/A1_0_0.png', duration: 6, prompt: 'eyes open', notes: 'boot' },
    { id: 'N9', kind: 'image', model: 'nb2', prompt: 'never ran' }] }, null, 1));
}

export async function verifyBatches({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v20 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v20-')), DATA = path.join(TMP, 'data'), ND = path.join(DATA, 'demo'), BASE_DIR = path.join(TMP, 'base');
  fs.cpSync(path.join(WB, 'data', 'demo'), ND, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  const { config } = makeFakeFalgen(BASE_DIR);
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify(config));
  batchFixture(ND, BASE_DIR);
  const KEY = `fal-v20-${Math.random().toString(36).slice(2)}`;
  const FAL = await startMockFal({ key: KEY, polls: 1 });
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: 'demo', WB_AGENT_APPROVALS: '', WB_TEST: '1', WB_FAL_BASE: FAL.url, FAL_KEY: KEY, WB_RUN_POLL_MS: '150', WB_TEST_DATE: '' };
  delete env.WORKBENCH_MEDIA_BASE; delete env.WB_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; process.stderr.write('v20 server: ' + d); });
  let pg = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=demo`)).text())?.[1];
    const agent = async (name, body) => { const r = await fetch(`${BASE}/api/op/${name}?project=demo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const readJ = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ND, f), 'utf8')); } catch (e) { return null; } };
    const fileUntil = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { /* not yet */ } await wait(100); } return false; };
    const batch = (id) => (readJ('requests.json').batches || []).find(b => b.id === id);
    const reqs = (ids) => readJ('requests.json').items.filter(r => ids.includes(r.id));

    pg = await browser.newPage();
    await pg.setViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v20 pageerror', e.message));
    pg.on('console', m => { if (/warn|error/.test(m.type())) console.error('v20 console', m.type(), m.text().slice(0, 300)); });
    const outside = [];
    await pg.setRequestInterception(true);
    pg.on('request', (r) => { const u = r.url(); if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue(); outside.push(u); return r.abort(); });
    const frames = () => pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const click = async (sel) => { const r = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(12, b.width / 2), y: b.top + b.height / 2 }; }, sel); if (!r) throw new Error('no element ' + sel); await pg.mouse.click(r.x, r.y); await wait(250); };
    const shot = async (name, clip) => { await pg.evaluate(() => Promise.race([new Promise(r => setTimeout(r, 1000)), Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; })))])); await frames(); await pg.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) }); };
    const clipOf = async (sel, pad = 4) => pg.evaluate((s, pd) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'start' }); const b = e.getBoundingClientRect(); return { x: 0, y: Math.max(0, b.top - pd), width: 1500, height: Math.min(900 - Math.max(0, b.top - pd), b.height + pd * 2) }; }, sel, pad);
    const head = (id) => pg.evaluate((b) => { const e = document.querySelector(`.queue .qbatch[data-b="${b}"]`); if (!e) return null; return { state: e.querySelector('.gate')?.textContent, text: e.querySelector('.qbh')?.textContent.replace(/\s+/g, ' ').trim(), stats: e.querySelector('.qstats')?.textContent.replace(/\s+/g, ' ').trim() || null, rows: e.querySelectorAll('tr[data-id]').length, btns: [...e.querySelectorAll('.qbh button')].map(x => ({ t: x.textContent, d: x.disabled })) }; }, id);
    await pg.goto(`${BASE}/?project=demo`, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await pg.evaluate(async () => { await window.WB.app.show('queue'); });
    await until(() => !!document.querySelector('.queue [data-q=waves]'));

    // 1. Plan waves: tick a pilot of two shots, takes 2; the preview: the pilot, then 4, then the rest, gated wave after wave
    await click('.queue [data-q=waves]');
    await until(() => document.querySelectorAll('.wvdlg .wvtbl tr[data-shot]').length === 10);
    await pg.select('.wvdlg select[data-f=takes]', '2'); await wait(400);
    for (const s of ['w03', 'w07']) { await click(`.wvdlg input[data-pilot="${s}"]`); await wait(400); }
    await until(() => /pilot/.test(document.querySelector('.wvdlg .wvwave')?.textContent || ''));
    const pv = await pg.evaluate(() => ({ waves: [...document.querySelectorAll('.wvdlg .wvwave')].map(w => w.textContent.replace(/\s+/g, ' ').trim()), sum: document.querySelector('.wvdlg .wvsum')?.textContent.replace(/\s+/g, ' ').trim(), cand: document.querySelectorAll('.wvdlg .wvtbl tr[data-shot]').length }));
    await shot('v20_plan_waves');
    check('Plan waves: the 10 gap shots; the ticked pilot w03 + w07 is wave 1, then 4 shots, then the rest (4); 2 takes x $0.12 a still: $0.48 / $0.96 / $0.96; waves 2 and 3 locked until the one before is reviewed; the cap line',
      pv.cand === 10 && pv.waves.length === 3 && /Wave 1 · pilot \(2 shots\).*est \$0\.48/.test(pv.waves[0]) && /w03, w07/.test(pv.waves[0]) && /Wave 2 \(4 shots\).*\$0\.96.*locked until Wave 1 is reviewed/.test(pv.waves[1]) && /Wave 3 \(4 shots\)/.test(pv.waves[2])
      && /3 waves · \$2\.40 at list prices · cap: .* of \$20\.00/.test(pv.sum || ''), pv);
    await click('.wvdlg [data-x=create]');
    await fileUntil(() => (readJ('requests.json').batches || []).length === 3);
    const D0 = readJ('requests.json'), [b1, b2, b3] = D0.batches;
    check('Create waves: 3 DRAFT batches (b01 pilot, b02 gated on b01, b03 on b02) and 10 draft requests (shot-still, 2 takes, est $0.24 each, target shot:<id>); nothing approved',
      b1.status === 'draft' && b1.gate.after === null && b2.gate.after === b1.id && b3.gate.after === b2.id && b1.request_ids.length === 2 && b2.request_ids.length === 4 && b3.request_ids.length === 4
      && D0.items.filter(r => r.status === 'draft' && r.kind === 'shot-still' && r.takes === 2 && Math.abs(r.est_cost - 0.24) < 1e-9).length === 10 && !D0.items.some(r => r.status === 'approved')
      && reqs(b1.request_ids).map(r => r.target).sort().join(',') === 'shot:w03,shot:w07', { b: D0.batches.map(b => [b.id, b.status, b.gate.after, b.request_ids.length]) });

    // 2. the batches in the Queue: collapsible groups with their gate; the agent cannot approve, unlock or run them
    await until(() => document.querySelectorAll('.queue .qbatch[data-b]').length === 3);
    const h1 = await head(b1.id), h2 = await head(b2.id), h3 = await head(b3.id);
    await click(`.queue .qbatch[data-b="${b3.id}"] [data-q=btog]`);
    const h3c = await head(b3.id);
    await pg.evaluate(() => document.querySelector('.queue .qwaveshead')?.scrollIntoView({ block: 'start' }));
    await shot('v20_batches');
    const ag1 = await agent('batch_act', { act: 'approve', id: b1.id }), ag2 = await agent('batch_act', { act: 'approve', id: b1.id, via: 'page' }), ag3 = await agent('batch_act', { act: 'review', id: b1.id });
    const ag4 = await agent('request_update', { id: b1.request_ids[0], status: 'approved', director_approved: true });
    const ar = await agent('request_run', { batch: b1.id });
    check('the Queue: three batch groups; b01 READY with "Approve batch · $0.48" + Dismiss, b02 / b03 LOCKED ("waits for" the wave before, no approve button), totals per batch; a group collapses; the agent gets 403 on batch_act (also claiming via "page") and on approving a request, and request_run {batch} refuses the unapproved batch',
      h1?.state === 'ready' && h1.btns.some(b => /Approve batch · \$0\.48/.test(b.t)) && h2?.state === 'locked' && /waits for Wave 1/.test(h2.text) && !h2.btns.length && h3?.state === 'locked' && h1.rows === 2 && h2.rows === 4 && /2 requests · 2 shots · est \$0\.48/.test(h1.text)
      && h3c.rows === 0 && ag1.status === 403 && ag2.status === 403 && ag3.status === 403 && ag4.status === 403 && ar.body?.started?.length === 0 && /not approved/.test(ar.body?.refused?.[0]?.why || ''), { h1, h2, h3c: h3c?.rows, ag: [ag1.status, ag2.status, ag3.status, ag4.status], ar: ar.body?.refused });

    // 3. "Approve batch · $0.48": the confirm shows the total and the cap impact; approving moves both drafts at once
    await click(`.queue .qbatch[data-b="${b1.id}"] [data-q=bapprove]`);
    const conf = await pg.evaluate((b) => document.querySelector(`.queue .qbatch[data-b="${b}"] .qconfirm`)?.textContent.replace(/\s+/g, ' ').trim(), b1.id);
    const cc = await clipOf(`.queue .qbatch[data-b="${b1.id}"]`);
    await shot('v20_approve_confirm', cc ? { ...cc, height: Math.min(cc.height, 200) } : undefined);
    await click(`.queue .qbatch[data-b="${b1.id}"] [data-q=bconfirm]`);
    await fileUntil(() => batch(b1.id).status === 'approved');
    const B1 = batch(b1.id), R1 = reqs(b1.request_ids);
    check('Approve batch: the confirm says "2 requests · $0.48 · cap: spent $0.00 + committed $0.00 + this $0.48 = $0.48 of $20.00 (2%)"; confirmed, both requests approved at once (log via page, batch b01), the batch approved with its cap max_usd $0.48',
      /Approve Wave 1 · pilot \(2 shots\): 2 requests · \$0\.48 · cap: spent \$0\.00 \+ committed \$0\.00 \+ this \$0\.48 = \$0\.48 of \$20\.00 \(2%\)/.test(conf || '') && B1.status === 'approved' && B1.max_usd === 0.48
      && R1.every(r => r.status === 'approved' && r.log.at(-1).via === 'page' && r.log.at(-1).batch === b1.id), { conf, B1: { status: B1.status, max: B1.max_usd } });

    // 4. a locked batch never runs: a b02 request approved by hand in the page is still refused, and b02 cannot be approved yet
    await pg.evaluate((id) => window.WB.store.setRequest(id, { status: 'approved' }), b2.request_ids[0]);
    await fileUntil(() => reqs([b2.request_ids[0]])[0].status === 'approved');
    const lr = await agent('request_run', { ids: [b2.request_ids[0]] }), lq = await agent('request_update', { id: b2.request_ids[0], status: 'queued' });
    const la = await pg.evaluate((b) => window.WB.store.op('batch_act', { act: 'approve', id: b }).then(() => 'ok', e => e.message), b2.id);
    check('a locked batch never runs: a request of b02 approved by hand is refused by the runner ("locked until the director marks Wave 1 … reviewed") and by request_update queued (409); "approve" on the locked b02 is refused even from the page',
      lr.body?.started?.length === 0 && /locked until the director marks Wave 1/.test(lr.body?.refused?.[0]?.why || '') && lq.status === 409 && /locked/.test(la), { lr: lr.body?.refused, lq: lq.status, la });
    await pg.evaluate((id) => window.WB.store.setRequest(id, { status: 'draft' }), b2.request_ids[0]);

    // 5. Run batch: the two requests run on the mock fal within the batch cap; the batch goes to REVIEW
    await until((b) => !!document.querySelector(`.queue .qbatch[data-b="${b}"] [data-q=brun]`), b1.id);
    const runLbl = await pg.evaluate((b) => document.querySelector(`.queue .qbatch[data-b="${b}"] [data-q=brun]`)?.textContent, b1.id);
    await click(`.queue .qbatch[data-b="${b1.id}"] [data-q=brun]`);
    await fileUntil(() => reqs(b1.request_ids).every(r => r.status === 'done'), 25000);
    await until((b) => document.querySelector(`.queue .qbatch[data-b="${b}"] .gate`)?.textContent === 'review', b1.id);
    const hr = await head(b1.id), R2 = reqs(b1.request_ids);
    check('Run batch · $0.48: both requests ran (2 takes each, $0.24 each, recorded once); the batch is in REVIEW with "Mark reviewed (2 to decide)" disabled',
      /Run batch · \$0\.48/.test(runLbl || '') && R2.every(r => r.outputs?.length === 2 && Math.abs(r.actual_cost_usd - 0.24) < 1e-9) && readJ('costs.json').items.filter(x => b1.request_ids.includes(x.request)).length === 2
      && hr.state === 'review' && hr.btns.some(b => /Mark reviewed \(2 to decide\)/.test(b.t) && b.d), { runLbl, hr });

    // 6. review: the director picks a take of w03 (take selection, D6) and rejects the takes of w07; then Mark reviewed unlocks b02
    const rW03 = R2.find(r => r.target === 'shot:w03'), rW07 = R2.find(r => r.target === 'shot:w07');
    const mPick = (readJ('media.json').items || []).find(m => m.path === rW03.outputs[1]);
    const pick = await pg.evaluate((a) => window.WB.store.op('take_act', a).then(j => j.clip?.take, e => 'ERR ' + e.message), { act: 'pick', shot: 'w03', media: mPick.id });
    await until((id) => !!document.querySelector(`.queue tr[data-id="${id}"] [data-x=vreject]`), rW07.id);
    await until((id) => /take picked/.test(document.querySelector(`.queue tr[data-id="${id}"] .qverd`)?.textContent || ''), rW03.id);
    await click(`.queue tr[data-id="${rW07.id}"] [data-x=vreject]`);
    await fileUntil(() => batch(b1.id).verdicts?.[rW07.id]?.verdict === 'rejected');
    await until((b) => { const x = [...document.querySelectorAll(`.queue .qbatch[data-b="${b}"] .qbh button`)].find(y => /Mark reviewed/.test(y.textContent)); return x && !x.disabled; }, b1.id);
    const verd = await pg.evaluate((ids) => ids.map(id => document.querySelector(`.queue tr[data-id="${id}"] .qverd`)?.textContent), [rW03.id, rW07.id]);
    const cr = await clipOf(`.queue .qbatch[data-b="${b1.id}"]`);
    await shot('v20_review', cr ? { ...cr, height: Math.min(cr.height, 420) } : undefined);
    await click(`.queue .qbatch[data-b="${b1.id}"] [data-q=breview]`);
    await fileUntil(() => batch(b1.id).status === 'reviewed');
    await until((b) => document.querySelector(`.queue .qbatch[data-b="${b}"] .gate`)?.textContent === 'ready', b2.id);
    await click(`.queue .qbatch[data-b="${b1.id}"] [data-q=btog]`);   // the done pilot is folded: open it again to show its rows
    const h1r = await head(b1.id), h2r = await head(b2.id);
    await pg.evaluate(() => document.querySelector('.queue .qwaveshead')?.scrollIntoView({ block: 'start' }));
    await shot('v20_gate_unlocked');
    check('review: a picked take shows "✓ take picked", the rejected one "✕ takes rejected"; Mark reviewed (page) sets b01 reviewed (DONE) and b02 unlocks (READY, "Approve batch · $0.96"); b03 stays locked',
      pick === 1 && /take picked/.test(verd[0] || '') && /takes rejected/.test(verd[1] || '') && h1r.state === 'done' && h2r.state === 'ready' && h2r.btns.some(b => /Approve batch · \$0\.96/.test(b.t)) && (await head(b3.id)).state === 'locked'
      && batch(b1.id).stats?.used_shots === 1, { pick, verd, h1r, h2r });

    // 7. the take ratio: 4 takes for 2 shots, 1 used: 4 takes per used shot; $0.48 for 2 s used: $0.24 per used second;
    // the remaining waves re-estimated from it (wave 2: 4 shots x 2 s = 8 s x $0.24 = $1.92 vs $0.96 at list prices)
    const wh = await pg.evaluate(() => ({ stats: document.querySelector('.queue .qwaveshead .qstats')?.textContent.replace(/\s+/g, ' ').trim(), rest: document.querySelector('.queue .qwaveshead .qrest')?.textContent.replace(/\s+/g, ' ').trim() }));
    const bg = await agent('batches_get', {});
    const ch = await clipOf('.queue .qwaveshead');
    await shot('v20_take_ratio', ch ? { ...ch, height: Math.min(900 - ch.y, 240) } : undefined);
    check('take-ratio stats: "4 takes for 2 shots · 1 used · 4 takes per used shot · $0.48 spent · 2 s used · $0.240 per used second"; remaining: Wave 2 list $0.96 → observed $1.92, Wave 3 the same; batches_get gives the same numbers',
      /4 takes for 2 shots · 1 used · 4 takes per used shot · \$0\.48 spent · 2 s used · \$0\.240 per used second/.test(wh.stats || '') && /Wave 2 \(4 shots\): list \$0\.96 → observed \$1\.92/.test(wh.rest || '')
      && bg.body?.observed?.takes_per_used_shot === 4 && bg.body.observed.usd_per_used_s === 0.24 && bg.body.remaining.find(x => x.id === b2.id)?.observed_usd === 1.92, { wh, observed: bg.body?.observed, remaining: bg.body?.remaining });

    // 8. the per-batch cap: approve b02 with the page, lower its cap to $0.30: only one $0.24 request fits
    await pg.evaluate((b) => window.WB.store.op('batch_act', { act: 'approve', id: b }), b2.id);
    await pg.evaluate((b) => window.WB.store.op('batch_act', { act: 'cap', id: b, max_usd: 0.3 }), b2.id);
    const capDry = await agent('request_run', { batch: b2.id, dry_run: true });
    check('per-batch cap: b02 approved, its cap lowered to $0.30: a dry run of the batch takes one $0.24 request and refuses the other three ("over the batch cap")',
      capDry.body?.runnable === 1 && (capDry.body.refused || []).filter(x => /over the batch cap/.test(x.why)).length === 3, { runnable: capDry.body?.runnable, refused: capDry.body?.refused?.map(x => x.why.slice(0, 60)) });

    // 9. Import job books: register the falgen outputs (D8), then the page imports jobs_test.json as history
    await agent('media_import', { paths: ['project/gen/out/A1', 'project/gen/out/G01'] });
    const costs0 = JSON.stringify(readJ('costs.json').items);
    const ajb = await agent('jobbooks_import', {}), adry = await agent('jobbooks_import', { dry_run: true });
    await click('.queue [data-q=jobbooks]');
    await wait(600);   // the confirm (core/palette.js ui.confirm): Enter picks "Yes"
    await pg.keyboard.press('Enter');
    await fileUntil(() => readJ('requests.json').items.some(r => r.history));
    await until(() => !!document.querySelector('.queue .qhist tr[data-id]'));
    const H = readJ('requests.json').items.filter(r => r.history), A1 = H.find(r => r.id === 'A1'), G01 = H.find(r => r.id === 'G01');
    const hh = await pg.evaluate(() => { const e = document.querySelector('.queue .qhist'); return { text: e?.querySelector('.qbh')?.textContent.replace(/\s+/g, ' ').trim(), stats: e?.querySelector('.qstats')?.textContent.replace(/\s+/g, ' ').trim(), rows: [...e.querySelectorAll('tr[data-id]')].map(r => r.querySelector('.qbtns')?.textContent.replace(/\s+/g, ' ').trim()) }; });
    const hrun = await agent('request_run', { ids: ['A1'] }), hrt = await agent('request_run', { ids: ['A1'], retake: true });
    const tk = await agent('takes_get', { request: 'A1' });
    const chh = await clipOf('.queue .qhist');
    await shot('v20_history', chh ? { ...chh, height: Math.min(900 - chh.y, 320) } : undefined);
    check('Import job books: the agent cannot import (403; a dry run is fine: A1, G01, N9 skipped as never run); the page imports jobs_test.json as history: A1 (2 registered outputs, $0.24 counted in the falgen ledger) and G01 (1 output, an estimate, not counted), status done, never run (request_run and a retake refuse "history"), no new cost in costs.json; A1\'s outputs are its takes; a "History · job books" group with its stats',
      ajb.status === 403 && adry.body?.imported?.length === 2 && adry.body.skipped.some(s => s.job === 'N9' && /never ran/.test(s.why))
      && A1?.status === 'done' && A1.outputs.length === 2 && A1.history.cost.counted === true && Math.abs(A1.actual_cost_usd - 0.24) < 1e-9 && G01?.status === 'done' && G01.outputs.length === 1 && G01.history.cost.counted === false && G01.kind === 'shot-video'
      && JSON.stringify(readJ('costs.json').items) === costs0 && hrun.body?.started?.length === 0 && /history/.test(hrun.body?.refused?.[0]?.why || '') && hrt.body?.started?.length === 0
      && (tk.body?.takes || []).length === 2 && /History · job books/.test(hh.text || '') && /jobs_test\.json/.test(hh.text || '') && /3 takes/.test(hh.stats || '') && hh.rows.length === 2, { adry: adry.body?.skipped, hh, A1: A1 && { out: A1.outputs, cost: A1.history.cost }, G01: G01 && { out: G01.outputs, cost: G01.history.cost }, hrun: hrun.body?.refused });

    check('nothing left the page; the fal key is in no project file and not in the server log', !outside.length && !log.includes(KEY) && !fs.readdirSync(ND, { recursive: true }).some(f => { try { return fs.statSync(path.join(ND, f)).isFile() && fs.readFileSync(path.join(ND, f)).includes(KEY); } catch (e) { return false; } }), { outside });
  } catch (e) { console.error('v20 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await pg?.close().catch(() => {});
    srv.kill(); await FAL.close(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-batches.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyBatches({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v20 (batches, waves, job books):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
