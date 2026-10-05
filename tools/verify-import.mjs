// v17 of the headless UI suite (tools/verify.mjs): D8, importing existing images and video. Exported so verify.mjs runs
// it after the other blocks; runnable alone:   node tools/verify-import.mjs [outDir]
// Self-contained: a scratch copy of data/demo, a fake falgen-style tree as the media base (tools/fake-falgen.mjs: never
// fal), its own server on a free port, an MCP client against it; all deleted at the end. Then: File › Import media…;
// files dropped on the page (a real drop event: two images and a text file, the text refused by its bytes); a folder read
// in place (project/gen/out: jobs with their prompt, model, refs and cost recovered, the PRIVATE folder forced private);
// Import (chunked uploads + media_import in place + the recovered ledger cost recorded once); "Use as…" from a row
// (identity of a character: an imported node) and from the Media context menu (a shot's start frame: a new storyboard
// version, and a take); the Assets › Media browser (kind, linked / unlinked, private, search, compact); the agent's
// media_import over MCP and its 403 on "use as". Screenshots v17_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFakeFalgen } from './fake-falgen.mjs';
import { tinyPng } from './tiny-png.mjs';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sdk = (p) => import(pathToFileURL(path.join(WB, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);

export async function verifyImport({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v17 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 1600) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v17-')), DATA = path.join(TMP, 'data'), P = 'imp', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  const { config } = makeFakeFalgen(path.join(TMP, 'base'));
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify(config));
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P };
  delete env.WB_TOKEN; delete env.WORKBENCH_MEDIA_BASE;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v17 server: ' + d));
  let pg = null, client = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-import', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* an error text */ } return { error: !!r.isError, body, text: t }; };

    pg = await browser.newPage();
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v17 pageerror', e.stack || e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.error('v17 console', m.text()); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const shot = async (n, clip) => { await frames(3); await pg.screenshot({ path: path.join(OUT, `${n}.png`), ...(clip ? { clip } : {}) }); };
    const box = (sel, pad = 0) => pg.evaluate((s, p) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: Math.max(0, r.left - p), y: Math.max(0, r.top - p), width: r.width + 2 * p, height: r.height + 2 * p }; }, sel, pad);
    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });

    // 1. File › Import media… is in the File menu; files dropped on the page open the dialog with them
    const inMenu = await pg.evaluate(() => window.WB.menus.itemsFor('menubar:File').includes('file.importMedia'));
    const png1 = tinyPng(160, 90, [30, 120, 200]).toString('base64'), png2 = tinyPng(160, 90, [220, 120, 40]).toString('base64');
    await pg.evaluate(async (a, b) => {
      const f = (s, n, t) => new File([Uint8Array.from(atob(s), c => c.charCodeAt(0))], n, { type: t });
      const dt = new DataTransfer();
      dt.items.add(f(a, 'my_photo.png', 'image/png')); dt.items.add(f(b, 'desk test.png', 'image/png')); dt.items.add(new File(['<html>not an image</html>'], 'notes.png', { type: 'image/png' }));
      document.querySelector('#panes').dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      document.querySelector('#panes').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, png1, png2);
    await until(() => document.querySelectorAll('.imrow').length >= 3);
    await pg.evaluate(() => { const r = [...document.querySelectorAll('.imrow')].find(x => x.textContent.includes('my_photo')); r.querySelector('[data-f=private]').click(); });
    const drop = await pg.evaluate(() => ({ rows: document.querySelectorAll('.imrow').length, bad: [...document.querySelectorAll('.imrow.bad')].map(r => r.textContent.trim().slice(0, 80)), thumbs: [...document.querySelectorAll('.imrow .imth img')].filter(i => i.src.startsWith('blob:')).length, sum: document.querySelector('.imsum')?.textContent }));
    await shot('v17_import_dialog', await box('.imdlg', 4));
    check('File › Import media… is in the File menu; files dropped on the page open the dialog: a row each with its thumbnail, kind, label and private; a text file named .png is refused by its bytes',
      inMenu && drop.rows === 3 && drop.bad.length === 1 && /notes\.png/.test(drop.bad[0]) && /not an image/.test(drop.bad[0]) && drop.thumbs === 2, drop);

    // 2. a folder under a media root, read in place: the jobs with what job.json recovers, the PRIVATE folder forced private
    await pg.evaluate(() => { const i = document.querySelector('.impath input'); i.value = 'project/gen/out'; document.querySelector('.impath').requestSubmit(); });
    await until(() => document.querySelectorAll('.imjob').length >= 3);
    await wait(500);
    const folder = await pg.evaluate(() => {
      const job = (id) => document.querySelector(`.imjob[data-job="${id}"]`);
      const row = (n) => [...document.querySelectorAll('.imrow')].find(r => r.textContent.includes(n));
      return { a1: job('A1')?.textContent.replace(/\s+/g, ' ').trim(), g01: job('G01')?.textContent.replace(/\s+/g, ' ').trim(), a1rec: job('A1')?.querySelector('[name=record]')?.checked, g01rec: job('G01')?.querySelector('[name=record]')?.checked,
        p9: { checked: row('P9_0_0')?.querySelector('[data-f=private]')?.checked, disabled: row('P9_0_0')?.querySelector('[data-f=private]')?.disabled },
        vid: !!row('G01_0')?.querySelector('video'), rows: document.querySelectorAll('.imrow').length, fakeSkipped: ![...document.querySelectorAll('.imrow')].some(r => r.textContent.includes('fake.png')) };
    });
    await shot('v17_folder_jobs', await box('.imdlg', 4));
    check('a folder read in place (project/gen/out): each job with its model, endpoint, prompt, refs (private counted) and cost: A1 $0.24 from the ledger next to the tree, "not counted yet", ticked to record; G01 an estimate (offered, not ticked); P9 under the PRIVATE rule is private and cannot be unticked; the video has a thumbnail',
      /nb2/.test(folder.a1) && /nano-banana-2/.test(folder.a1) && /HOODIE HACKER/.test(folder.a1) && /\$0\.24/.test(folder.a1) && /not counted yet/.test(folder.a1) && /refs 2 \(1 🔒\)/.test(folder.a1) && folder.a1rec === true
      && /estimate/.test(folder.g01) && folder.g01rec === false && folder.p9.checked && folder.p9.disabled && folder.vid && folder.rows === 7 && folder.fakeSkipped, folder);

    // 3. Import: uploads (chunked), the folder in place, the ledger cost recorded once
    await pg.evaluate(() => document.querySelector('.imdlg [data-x=import]').click());
    await until(() => document.querySelectorAll('.imrow.done').length >= 6, null, 20000);
    await wait(600);
    const M = J('media.json').items, C = J('costs.json').items;
    const up = M.find(m => m.label === 'my_photo'), up2 = M.find(m => m.label === 'desk test'), a10 = M.find(m => m.path === 'project/gen/out/A1/A1_0_0.png'), p9 = M.find(m => m.path === 'project/gen/out/P9/P9_0_0.png');
    check('Import: the dropped files are uploaded into the project (media/still/, the private one under private/still/), the folder\'s files registered in place (job / take / cost share), P9 private; the A1 cost recorded once in costs.json (via falgen, 2 takes), G01\'s estimate not',
      up?.path === 'private/still/my_photo.png' && up.private === true && up2?.path === 'media/still/desk-test.png' && a10?.job === 'A1' && a10.take === 0 && a10.cost_usd === 0.12 && p9?.private === true
      && C.filter(x => x.job === 'A1').length === 1 && C.find(x => x.job === 'A1').usd === 0.24 && C.find(x => x.job === 'A1').takes === 2 && !C.some(x => x.job === 'G01') && fs.existsSync(path.join(PD, 'private', 'still', 'my_photo.png')),
      { up: up?.path, up2: up2?.path, a10: a10 && { job: a10.job, take: a10.take, cost: a10.cost_usd }, p9: p9?.private, costs: C.filter(x => x.job).map(x => `${x.job}:${x.usd}`) });

    // 4. "Use as…" from a row: identity of Bo (an imported node, no request)
    await pg.evaluate((id) => { const b = document.querySelector(`.imrow [data-x=useas][data-m="${id}"]`); b.scrollIntoView({ block: 'center' }); b.click(); }, a10.id);
    await until(() => [...document.querySelectorAll('.pop .pi')].some(x => x.textContent.includes('Identity of')));
    const idItem = await pg.evaluate(() => { const it = [...document.querySelectorAll('.pop .pi')].find(x => x.textContent.includes('Identity of')); const r = it.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
    await pg.mouse.move(idItem.x, idItem.y); await wait(500);
    await until(() => document.querySelectorAll('.pop').length >= 2);
    await shot('v17_use_as');
    await pg.evaluate(() => { const pops = document.querySelectorAll('.pop'), sub = pops[pops.length - 1]; const it = [...sub.querySelectorAll('.pi')].find(x => /\bBo\b/i.test(x.textContent)) || sub.querySelector('.pi'); it.click(); });
    await until(() => { const e = window.WB.store.entityById?.bo; return (e?.iter?.nodes || []).some(n => n.origin === 'imported'); }, null, 8000);
    const bo = JSON.parse(fs.readFileSync(path.join(PD, 'entities', 'characters', 'bo.json'), 'utf8'));
    const node = bo.iter?.nodes?.find(n => n.image === a10.path);
    check('"Use as…" › Identity of › Bo (from the dialog row): an imported node heads Bo\'s identity tree (no request, nothing paid; provenance: job A1 take 0, the recorded cost split per take); the media item is linked to bo',
      node?.origin === 'imported' && node.request === null && node.tree === 'identity' && bo.iter.trees.identity.head === node.id && node.provenance?.job === 'A1' && node.provenance.cost?.source === 'workbench' && node.provenance.cost.usd === 0.12
      && J('media.json').items.find(m => m.id === a10.id)?.entities?.includes('bo'), { node: node && { id: node.id, tree: node.tree, prov: node.provenance } });
    await pg.evaluate(() => document.querySelector('.imdlg [data-x=close]').click());

    // 5. the Media context menu anywhere: start frame of a shot, then a take
    await pg.evaluate(() => window.WB.app.show('media')); await wait(700);
    const a11 = M.find(m => m.path === 'project/gen/out/A1/A1_0_1.png'), g0 = M.find(m => m.path === 'project/gen/out/G01/G01_0.mp4');
    const shotId = await pg.evaluate(() => window.WB.store.board && (window.WB.store.board.versions.find(v => v.id === window.WB.store.board.current)?.shots || [])[0]?.id);
    const ctx = async (id, label) => {
      await pg.evaluate((mid) => { const c = document.querySelector(`.media [data-media="${mid}"]`); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 })); }, id);
      await until(() => [...document.querySelectorAll('.pop .pi')].some(x => x.textContent.includes('Use as…')));
      const u = await pg.evaluate(() => { const it = [...document.querySelectorAll('.pop .pi')].find(x => x.textContent.includes('Use as…')); const r = it.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
      await pg.mouse.move(u.x, u.y); await wait(500);
      await pg.evaluate((l) => { const pops = document.querySelectorAll('.pop'), sub = pops[pops.length - 1]; [...sub.querySelectorAll('.pi')].find(x => x.textContent.includes(l)).click(); }, label);
      await until(() => !!document.querySelector('.pal input'));
      await pg.keyboard.press('Enter');
    };
    await ctx(a11.id, 'Start frame of shot');
    await until((s) => (window.WB.store.mediaById[s.m]?.use_as || []).some(u => u.as === 'start_frame'), { m: a11.id });
    await ctx(g0.id, 'Take of shot');
    await until((s) => (window.WB.store.mediaById[s.m]?.use_as || []).some(u => u.as === 'take'), { m: g0.id });
    const SBD = J('storyboard.json'), cur = SBD.versions.find(v => v.id === SBD.current), sh = cur.shots.find(s => s.id === shotId);
    const M2 = J('media.json').items;
    check('the Media context menu › Use as… › Start frame of shot… / Take of shot…: the start frame becomes the shot\'s thumb in a new storyboard version (by the director, via page); both are recorded on the media items (use_as, shots) for the take picker',
      sh?.thumb === a11.path && cur.by === 'director' && cur.via === 'page' && /start frame/.test(cur.message) && M2.find(m => m.id === a11.id)?.use_as?.some(u => u.shot === shotId && u.as === 'start_frame')
      && M2.find(m => m.id === g0.id)?.use_as?.some(u => u.shot === shotId && u.as === 'take') && M2.find(m => m.id === g0.id)?.shots?.includes(shotId), { shotId, thumb: sh?.thumb, v: cur.id });

    // 6. the Assets › Media browser: kind, linked / unlinked, private, search, compact
    await pg.evaluate(() => { const s = document.querySelector('.media select[data-f=link]'); s.value = 'unlinked'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await wait(300);
    await pg.evaluate(() => { const s = document.querySelector('.media input[data-f=compact]'); if (!s.checked) s.click(); });
    await wait(300);
    const brU = await pg.evaluate(() => [...document.querySelectorAll('.media .mc[data-media]')].map(c => c.dataset.media));
    await shot('v17_media_browser');
    await pg.evaluate(() => { const s = document.querySelector('.media select[data-f=link]'); s.value = 'linked'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await pg.evaluate(() => { const i = document.querySelector('.media input[data-f=q]'); i.value = 'A1'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await wait(500);
    const brL = await pg.evaluate(() => ({ ids: [...document.querySelectorAll('.media .mc[data-media]')].map(c => c.dataset.media), badges: [...document.querySelectorAll('.media .mc .mlk')].map(b => b.textContent), compact: document.querySelector('.pane.media')?.classList.contains('compact') }));
    await shot('v17_media_linked');
    await pg.evaluate(() => { const s = document.querySelector('.media select[data-f=link]'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); const i = document.querySelector('.media input[data-f=q]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); const c = document.querySelector('.media input[data-f=compact]'); if (c.checked) c.click(); });
    check('Assets › Media: the linked / unlinked filter (A1_0_1 and G01_0, used as a start frame / take, and A1_0_0, a node, are linked; P9 and the uploads are not), the search, the "use as" badges, compact cells',
      brU.includes(p9.id) && brU.includes(up2.id) && !brU.includes(a10.id) && !brU.includes(a11.id) && brL.ids.includes(a10.id) && brL.ids.includes(a11.id) && !brL.ids.includes(up2.id) && brL.badges.length >= 2 && brL.compact,
      { unlinked: brU.length, linked: brL });

    // 7. the agent: media_import over MCP (in place, private never lowered), and no "use as"
    const ai = await tool('media_import', { paths: ['project/gen/out/A1/A1_0_1.png', 'project/gen/out/P9'] });
    const ad = await tool('media_import', { paths: ['project/gen/out/P9/P9_0_0.png'], private: false });
    const au = await fetch(`${BASE}/api/op/media_use?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1] }, body: JSON.stringify({ media: a11.id, as: 'identity', id: 'ada', via: 'page' }) });
    const ml = await tool('media_list', { linked: 'unlinked' });
    check('the agent: media_import (already registered: nothing changes), private:false on a private file 403; "use as" over HTTP without the page 403; media_list linked / unlinked',
      !ai.error && ai.body.already?.length === 2 && ad.error && /403/.test(ad.text) && au.status === 403 && !ml.error && ml.body.items.some(m => m.id === p9.id) && !ml.body.items.some(m => m.id === a11.id), { ai: ai.text.slice(0, 120), ad: ad.text.slice(0, 100), au: au.status });
  } catch (e) { console.error('v17 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await client?.close().catch(() => {});
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-import.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyImport({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v17 (import media):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
