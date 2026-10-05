// v15 of the headless UI suite (tools/verify.mjs): stage 7, final approvals (ROADMAP_v4 C1-C4). Exported so verify.mjs
// runs it after the other blocks; runnable alone:   node tools/verify-final.mjs [outDir]
// Self-contained: a scratch copy of data/demo, its own server on a free port, an MCP client (the official SDK, over stdio,
// against that server); all deleted at the end. Mixed states first (a breakdown with three items, a scene flagged needs
// you, a draft shot request from the agent, an agent note on a shot, an identity head imported in the page), then:
// the Final list (the same rows as final_get, grouped by stage, row-aligned notes), the filters (stage, status, has open
// notes), the checklist with its failing lines (a gap link jumps to its stage), the costs against the cap (the merged
// ledger), Approve per kind (a scene, a breakdown item, an identity tree via asset_act, the lyrics stage), Request changes
// + a note (a shot: state changes), multi-select -> the confirm with the count and the cost impact -> approved (requests
// stamped via page), Review › Approvals (C3: the same rows), "Lock for render" (a revision marked final; the agent gets
// 409 over MCP while final_get reads), Unlock; the group names are the stage names (review #2 U15). Screenshots v15_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(process.env.WB_VERIFY_PORT ? Number(process.env.WB_VERIFY_PORT) + ((globalThis.__wbVerifyPortN = (globalThis.__wbVerifyPortN ?? -1) + 1) % 10) : 0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sdk = (p) => import(pathToFileURL(path.join(WB, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);

export async function verifyFinal({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v15 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v15-')), DATA = path.join(TMP, 'data'), P = 'final', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P };
  delete env.WB_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v15 server: ' + d));
  let pg = null, client = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
    const call = async (name, body, page = false) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN, ...(page ? { origin: BASE, 'sec-fetch-site': 'same-origin' } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-final', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* an error text */ } return { error: !!r.isError, body, text: t }; };

    // 0. mixed states: the agent drafts a breakdown, flags a scene, drafts a shot request, notes a shot; the director imports an identity head
    await tool('breakdown_update', { items: [{ kind: 'character', name: 'Ada', links: [{ scene: 'sc02' }] }, { kind: 'location', name: 'Studio', links: [{ scene: 'sc01' }, { scene: 'sc02' }] }, { kind: 'prop', name: 'Tone generator', description: 'a 1970s test-tone box', links: [{ scene: 'sc02' }] }] });
    await tool('scenes_update', { status: { sc02: 'needs_you' } });
    const rq = (await tool('request_create', { kind: 'shot-still', target: 'shot:s5-outro', prompt: 'Film still, 16:9: the screen goes dark', est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' })).body;
    await tool('shot_note_add', { shot: 's4-chorus', text: 'the chorus needs a close-up insert' });
    const imp = await call('asset_act', { type: 'character', id: 'bo', act: 'import', tree: 'identity', media: 'bo_face' }, true);

    pg = await browser.newPage();
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v15 pageerror', e.stack || e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.error('v15 console', m.text()); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const shot = async (n, clip) => { await frames(3); await pg.screenshot({ path: path.join(OUT, `${n}.png`), ...(clip ? { clip } : {}) }); };
    const clipOf = (sel, pad = 0) => pg.evaluate((s, p) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.max(0, r.left - p), y: Math.max(0, r.top - p), width: r.width + 2 * p, height: r.height + 2 * p }; }, sel, pad);
    const click = (sel) => pg.evaluate((s) => { const e = document.querySelector(s); e?.click(); return !!e; }, sel);
    const W = () => pg.evaluate(() => { const w = window.WB.final.ws; return { rows: w.view.rows.map(r => r.key), shown: [...document.querySelectorAll('.fnlist .fnrow')].map(e => e.dataset.key), groups: [...document.querySelectorAll('.fnlist .fngh')].map(e => e.dataset.g), counts: w.view.counts, ready: w.view.ready, failing: w.view.failing, costs: w.view.costs, lock: w.view.lock }; });

    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(3);
    await pg.evaluate(() => window.WB.stages.open('final'));
    await until(() => !!window.WB.final?.ws?.view && !!document.querySelector('.fnlist .fnrow'));
    await until(() => window.WB.final.ws.view.costs.merged);   // the merged ledger arrived (costs_get)
    await wait(300);

    // 1. the list: the same rows as final_get, grouped by stage, each row with status, why, cost; the notes row-aligned
    const v1 = await W(), fg = (await tool('final_get', {})).body;
    const rowInfo = await pg.evaluate(() => { const r = document.querySelector('.fnrow[data-key="request:' + window.WB.final.ws.view.rows.find(x => x.kind === 'request' && x.why.startsWith('by agent'))?.id + '"]'); const s4 = document.querySelector('.fnrow[data-key="shot:s4-chorus"]'), c = window.WB.notesCol.visible(), cell = c && [...c.layer.querySelectorAll('.nccell')].find(x => x.textContent.includes('close-up insert'));
      return { req: r ? { chip: r.querySelector('.chip')?.textContent, est: r.querySelector('.fnc')?.textContent } : null, dy: s4 && cell ? Math.abs(cell.getBoundingClientRect().top - s4.getBoundingClientRect().top) : null, thumbs: document.querySelectorAll('.fnlist img.fnth').length }; });
    await shot('v15_list');
    check('the Final list: every pending row of final_get (same keys), grouped by stage (lyrics, script, breakdown, characters, scenery, shots & clips, requests), with status, why and cost (the agent\'s $0.12 shot request); the agent\'s note on s4-chorus sits on its row in the Notes column',
      JSON.stringify(v1.rows) === JSON.stringify(fg.pending.map(r => r.key)) && ['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'requests'].every(g => v1.groups.includes(g))
      && v1.rows.includes('scene:sc02') && v1.rows.includes('item:' + J('breakdown.json').versions.at(-1).items[0].id) && v1.rows.includes('tree:bo/identity') && v1.rows.includes('shot:s3-grid') && v1.rows.includes('request:' + rq.id)
      && rowInfo.req?.chip === 'draft' && rowInfo.req.est === '$0.12' && rowInfo.dy != null && rowInfo.dy < 3 && rowInfo.thumbs >= 3,
      { n: v1.rows.length, agent: fg.pending.length, groups: v1.groups, rowInfo });

    // 2. filters: stage, status, has open notes
    const filt = async (f, val) => { await pg.evaluate(([k, x]) => { const e = document.querySelector(`.fnbar [data-f="${k}"]`); if (e.type === 'checkbox') e.checked = x; else e.value = x; e.dispatchEvent(new Event('change', { bubbles: true })); }, [f, val]); await frames(2); return (await W()).shown; };
    const fScript = await filt('group', 'script'); await filt('group', '');
    const fChanges = await filt('st', 'changes'); await filt('st', '');
    const fNotes = await filt('notes', true); await filt('notes', false);
    check('filters: by stage (script: its scenes only), by status (changes: s3-grid), "has open notes" (the shot with the agent\'s note)',
      fScript.length === 3 && fScript.every(k => k.startsWith('scene:')) && fChanges.length >= 1 && fChanges.includes('shot:s3-grid') && fChanges.every(k => v1.rows.includes(k)) && fNotes.includes('shot:s4-chorus') && fNotes.length < v1.rows.length,
      { fScript, fChanges, fNotes });

    // 3. the checklist (failing lines with their gaps) and the costs
    const ck = await pg.evaluate(() => [...document.querySelectorAll('.fnci')].map(e => ({ id: e.dataset.ck, ok: e.classList.contains('ok'), gaps: e.querySelectorAll('.fngaps a').length })));
    await shot('v15_checklist', await clipOf('.fnck', 0));
    await shot('v15_costs', await clipOf('.fncost', 0));
    const costTxt = await pg.evaluate(() => document.querySelector('.fncost').textContent);
    check('"Ready to render": 11 derived lines (scripted, shots, frames, takes, lyrics, assets, looks (E6), notes, round, cap, export) matching final_get; each failing line lists its gaps as links; the costs panel shows spent / committed / est. remaining against the cap from the merged ledger',
      ck.length === 11 && ck.every(c => fg.checklist.find(x => x.id === c.id)?.ok === c.ok) && ck.filter(c => !c.ok).every(c => c.gaps > 0) && ck.some(c => !c.ok)
      && v1.costs.merged && v1.costs.cap === fg.costs.cap && v1.costs.drafts === fg.costs.drafts && /spent/.test(costTxt) && /est\. remaining/.test(costTxt) && costTxt.includes('$' + fg.costs.cap),
      { ck, costs: v1.costs });
    // a failing line's gap jumps to the stage that holds it
    await click('.fnci[data-ck="frames"] .fngaps a'); await wait(700);
    const jumped = await pg.evaluate(() => window.WB.stages.current());
    await pg.evaluate(() => window.WB.stages.open('final')); await wait(500);
    check('a failing line\'s gap link jumps to its stage (frames -> the storyboard)', jumped === 'storyboard', { jumped });

    // 4. Approve per kind, in the page: a scene (scenes.json ok), a breakdown item (ok), the lyrics stage (done), an identity tree (asset_act)
    const item0 = J('breakdown.json').versions.at(-1).items[0].id;
    for (const k of ['scene:sc01', 'item:' + item0, 'lyrics:stage', 'tree:bo/identity']) { await click(`.fnrow[data-key="${k}"] [data-x=approve]`); await wait(500); }
    await until(() => !document.querySelector('.fnrow[data-key="tree:bo/identity"]'));
    const sc = J('scenes.json'), bd = J('breakdown.json'), st = J('stages.json'), bo = J('entities/characters/bo.json');
    check('Approve (page only, the existing paths): scene sc01 ok (scenes.json, via page), a breakdown item ok, the lyrics stage done (stages.json, by the director), Bo\'s identity approved (asset_act); the rows leave the list',
      sc.states?.sc01?.status === 'ok' && sc.states.sc01.via === 'page' && bd.states?.[item0]?.status === 'ok' && bd.states[item0].via === 'page' && st.stages.find(s => s.id === 'lyrics')?.status === 'done' && st.stages.find(s => s.id === 'lyrics').done_by === 'director'
      && imp.status === 200 && bo.iter?.trees?.identity?.approved === imp.body.node && !(await W()).rows.some(k => ['scene:sc01', 'item:' + item0, 'lyrics:stage', 'tree:bo/identity'].includes(k)),
      { sc01: sc.states?.sc01, item: bd.states?.[item0], lyrics: st.stages.find(s => s.id === 'lyrics')?.status, bo: bo.iter?.trees?.identity, imp: imp.status });

    // 5. Request changes (+ a note) on a shot: approvals.json changes with the comment, a director note on the shot
    await click('.fnrow[data-key="shot:s5-outro"] [data-x=changes]'); await wait(200);
    await pg.keyboard.type('fade slower, hold the last frame'); await shot('v15_changes'); await pg.keyboard.press('Enter');
    await until(() => window.WB.store.state('shot:s5-outro') === 'changes' && window.WB.store.notes.notes.some(n => n.text === 'fade slower, hold the last frame'));
    // the page's saves reach the files a moment after the store: wait for both files, not the store
    for (let t0 = Date.now(); Date.now() - t0 < 6000; await wait(100)) { try { if (J('approvals.json').items?.['shot:s5-outro']?.state === 'changes' && J('notes.json').notes.some(n => n.text === 'fade slower, hold the last frame')) break; } catch (e) { /* mid-write */ } }
    const apS5 = J('approvals.json').items['shot:s5-outro'], nS5 = J('notes.json').notes.find(n => n.text === 'fade slower, hold the last frame');
    check('Request changes (+ note) on a shot: approvals.json changes (via page, the note as comment) and a director note on the shot (stage final), shown in its row\'s Notes cell',
      apS5?.state === 'changes' && apS5.via === 'page' && /fade slower/.test(apS5.comment || '') && nS5?.target.stage === 'final' && nS5.target.id === 's5-outro' && nS5.via === 'page', { apS5, n: nS5?.target });

    // 6. multi-select -> confirm (count + cost impact) -> approved
    const pick = ['request:' + rq.id, 'request:rdemo01', 'shot:s4-chorus', 'scene:sc03'];
    await pg.evaluate((ks) => { for (const k of ks) { const c = document.querySelector(`.fnrow[data-key="${k}"] input[data-sel-row]`); if (c) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } } }, pick);
    await frames(2);
    await click('[data-x=approvesel]'); await wait(200);
    const conf = await pg.evaluate(() => { const c = document.querySelector('.fnconf'); return c && !c.hidden ? c.textContent.replace(/\s+/g, ' ') : null; });
    await shot('v15_confirm');
    await click('.fnconf [data-x=confirm]');
    await until((id) => { const r = window.WB.store.requests.items; return r.find(x => x.id === id)?.status === 'approved' && r.find(x => x.id === 'rdemo01')?.status === 'approved'; }, rq.id);
    await wait(400);
    const R = J('requests.json').items, rA = R.find(x => x.id === rq.id), rB = R.find(x => x.id === 'rdemo01');
    check('approve selected: the confirm shows the count (4) and the cost impact (2 requests commit $0.52; committed / left before -> after against the cap); confirmed, the requests are approved with a page-stamped log (the runner accepts them), the shot approved, the scene ok',
      /Approve 4 items/.test(conf || '') && /2 requests commit \$0\.52/.test(conf || '') && /left \$10 → \$9\.48/.test(conf || '')
      && rA.status === 'approved' && rA.log?.at(-1)?.via === 'page' && rB.status === 'approved' && J('approvals.json').items['shot:s4-chorus']?.state === 'approved' && J('scenes.json').states?.sc03?.status === 'ok',
      { conf, rA: rA.log?.at(-1), rB: rB.status });

    // 7. Review › Approvals (C3): the same rows, readable (what, why, image, time), plus the raw approvals.json states
    await pg.evaluate(() => window.WB.app.show('approvals')); await wait(700);
    const apv = await pg.evaluate(() => ({ rows: document.querySelectorAll('.apws .fnrow').length, raw: document.querySelectorAll('.apws .apraw .chip[data-k]').length, panels: !!document.querySelector('.apws .fntop'), notes: !!document.querySelector('.apws .nclayer') }));
    await shot('v15_approvals');
    const nowRows = (await tool('final_get', {})).body.pending.length;
    check('Review › Approvals is the same list as the Final stage (rows with what / why / image / time and the acts), without the checklist and costs, WITH the Notes column (review #3); the raw approvals.json states below', apv.rows === nowRows && apv.raw > 0 && !apv.panels && apv.notes, { apv, nowRows });

    // 8. Lock for render (anyway: the checklist still fails) -> the agent is refused (409) while it reads; Unlock
    await pg.evaluate(() => window.WB.stages.open('final')); await wait(500);
    await click('.sgbar [data-slot=primary]'); await wait(200);   // (review #3: the one Lock for render… is the stage bar's)
    const lconf = await pg.evaluate(() => document.querySelector('.fnconf')?.textContent.replace(/\s+/g, ' '));
    await shot('v15_lock_confirm');
    await click('.fnconf [data-x=confirm]');
    await until(() => !!window.WB.store.revisions?.lock);
    await wait(400);
    await shot('v15_locked');
    const RV = J('revisions.json'), lk = RV.lock;
    const ag = await tool('notes_add', { target: { stage: 'final', kind: 'stage', id: null }, text: 'agent: while locked' });
    const ag2 = await tool('shots_update', { status: { 's3-grid': 'review' } });
    const rd = (await tool('final_get', {})).body;
    const bar = await pg.evaluate(() => ({ banner: document.querySelector('.fnlockbar:not([hidden])')?.textContent || null, btn: !!document.querySelector('.fnbar [data-x=unlock]') }));
    check('Lock for render: the confirm names the failing checks ("Lock anyway"); revisions.json gets the lock and a revision marked final (its snapshot = the final one); the page shows the lock banner + Unlock; the agent\'s writes get 409 ("locked for render") while final_get reads (locked)',
      /check(s)? fail/.test(lconf || '') && /Lock anyway/.test(lconf || '') && lk?.revision && RV.revisions.find(r => r.id === lk.revision)?.final === true && fs.existsSync(path.join(PD, '.snapshots', lk.snapshot))
      && /Locked for render/.test(bar.banner || '') && bar.btn && ag.error && /409/.test(ag.text) && /locked for render/.test(ag.text) && ag2.error && /409/.test(ag2.text) && rd.locked?.revision === lk.revision,
      { lconf, lk, bar, ag: ag.text.slice(0, 100), ag2: ag2.text.slice(0, 60) });
    await click('.fnbar [data-x=unlock]');
    await until(() => !window.WB.store.revisions?.lock);
    const ag3 = await tool('notes_add', { target: { stage: 'final', kind: 'stage', id: null }, text: 'agent: after unlock' });
    check('Unlock (the director): the lock is gone (kept in locks[] with unlocked_at) and the agent writes again', !J('revisions.json').lock && J('revisions.json').locks?.[0]?.unlocked_at && !ag3.error, { ag3: ag3.text.slice(0, 80) });
    // review #2 U15: the groups carry the stage names ("6 · Storyboard"), the queue is "Requests" (not a stage: no number); in
    // Time each row's stage tag is whole
    const gl = await pg.evaluate(() => [...document.querySelectorAll('.fnlist .fngh[data-g] b')].map(b => b.textContent));
    await pg.evaluate(() => window.WB.timeMode.setMode('final', 'time')); await until(() => !!document.querySelector('.fnlist.fntime .fnsg'));
    const tags = await pg.evaluate(() => [...document.querySelectorAll('.fnlist.fntime .fnsg')].map(e => ({ t: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1 })));
    await pg.evaluate(() => window.WB.timeMode.setMode('final', 'list'));
    check('U15 Final: the groups use the stage names ("6 · Storyboard"; "Requests" unnumbered, never "Shots & clips" / "7 · Generation requests"); in Time no stage tag is clipped',
      gl.includes('6 · Storyboard') && gl.every(g => g === 'Requests' || /^[1-7] · /.test(g)) && !gl.some(g => /Shots & clips|Generation requests|^7 · /.test(g)) && tags.length > 0 && !tags.some(x => x.clipped), { gl, tags: [...new Set(tags.map(x => x.t + (x.clipped ? ' (clipped)' : '')))] });
  } catch (e) { console.error('v15 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await client?.close().catch(() => {});
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-final.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyFinal({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v15 (final approvals):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
