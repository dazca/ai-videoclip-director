// v30 of the headless UI suite (tools/verify.mjs): C5 the render handoff from the page, and the review #3 leftovers.
//   C5: an agent proposes an HTML package export (package_propose: a draft, no path, no command; package_start / _cancel have no tool
//       and answer 403); the director sets the composition in Render settings…; a render of an excerpt (a fake ffmpeg render of a
//       tiny fake composition: one colour); File › Export › Interactive HTML package… (the menu, the confirm: the composition, the
//       render it is checked against, the agent's proposal); the job (one heavy job at a time: a live render lock refuses it, 409,
//       no draft left behind): the exporter on the composition, then verify.mjs --against the render (an excerpt: compared inside its
//       range); the frame-match report (pass rate, the worst frames as package | render thumbnails); the package registered in
//       renders.json packages[] with the revision; a second render that differs for half its frames -> 50 %, the bad frames shown;
//       Final's "HTML packages" lines, the Queue's package row; the agent's proposal still works on a locked project and Final's lock
//       bar points to the exports
//   review #3: a Notes column in Review › Queue (a note typed on a request row targets final / request / <id>; notes_add takes the
//       same target, 404 for an unknown request); back from a stage's Time view the timeline is never scrolled past the song's end;
//       the low items (no "no chapter" dropdown without chapters, the chapters column's hint, no developer words in Costs / Takes)
// Exported so verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-package.mjs [outDir]
// Self-contained: a scratch copy of data/demo, a tiny composition + a stub HyperFrames dist in a temp folder, its own server on a
// free port, an MCP client over stdio; all deleted at the end. Screenshots v30_*.png (1600x900, the timeline one 1280x800).
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
const BLUE = '0x2050c0';
const RENDER_BLUE = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${BLUE}:s={width}x{height}:r={fps}`, '-t', '{duration}', '-pix_fmt', 'yuv420p', '{out}'];
const RENDER_HALF = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${BLUE}:s={width}x{height}:r={fps}:d=2`, '-f', 'lavfi', '-i', 'color=c=red:s={width}x{height}:r={fps}:d=2',
  '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', '{out}'];

// a tiny fake composition (one colour, 8 s) and a stub HyperFrames dist (the player loads the composition in an iframe and injects
// the runtime from its CDN URL, which the exporter rewrites to the vendored copy); no network, nothing installed
function fixture(T) {
  const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  const HF = path.join(T, 'hf', 'dist'), C = path.join(T, 'comp');
  put(path.join(HF, 'hyperframe.runtime.iife.js'), 'window.__hf = { stub: true };\n');
  put(path.join(HF, 'hyperframes-player.global.js'), `(() => {
const RT = "https://cdn.jsdelivr.net/npm/@hyperframes/core@0.0.1/dist/hyperframe.runtime.iife.js";
customElements.define('hyperframes-player', class extends HTMLElement {
  connectedCallback() {
    this.style.cssText = 'display:block;position:fixed;inset:0';
    const f = document.createElement('iframe'); f.style.cssText = 'width:100%;height:100%;border:0;display:block';
    f.onload = () => {
      const d = f.contentDocument, r = d.querySelector('[data-composition-id]');
      const s = d.createElement('script'); s.src = RT; s.onload = () => { this.assetsReady = true; }; d.head.appendChild(s);
      this.duration = Number(r && r.getAttribute('data-duration')) || 1;
      this.compositionWidth = Number(r && r.getAttribute('data-width')) || 320; this.compositionHeight = Number(r && r.getAttribute('data-height')) || 180;
      this.ready = true;
    };
    f.src = this.getAttribute('src'); this.appendChild(f); this.iframeElement = f; this.currentTime = 0; this.paused = true;
  }
  seek(t) { this.currentTime = t; } play() {} pause() {}
});
})();
`);
  put(path.join(C, 'index.html'), `<!doctype html><html><head><title>tiny</title><style>html,body{margin:0;background:#2050c0;overflow:hidden}</style></head><body>
<div data-composition-id="tiny" data-width="320" data-height="180" data-duration="8" style="width:320px;height:180px;background:#2050c0"></div></body></html>`);
  return { HF, C };
}

export async function verifyPackage({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v30 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v30-')), DATA = path.join(TMP, 'data'), P = 'pkg', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const { HF, C } = fixture(TMP);
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  const Jn = (f) => { try { return J(f); } catch (e) { return null; } };
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P, WB_TEST: '1' };
  delete env.WB_TOKEN; delete env.WB_AGENT_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v30 server: ' + d));
  let pg = null, client = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const AGENT_TOKEN = fs.readFileSync(path.join(DATA, '.wb-agent-token'), 'utf8').trim();
    const agentOp = async (name, body) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-agent-token': AGENT_TOKEN }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-package', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* an error text */ } return { error: !!r.isError, body, text: t }; };
    const tools = (await client.listTools()).tools.map(t => t.name);

    pg = await browser.newPage();
    const errors = [];
    pg.on('pageerror', e => { errors.push(e.message); console.error('v30 pageerror', e.stack || e.message); });
    pg.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const untilFile = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (e) { /* mid-write */ } await wait(150); } return null; };
    const shot = async (n) => { await frames(3); await wait(300); await pg.screenshot({ path: path.join(OUT, `${n}.png`) }); };
    const click = (sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel);
    const pageOp = (name, body) => pg.evaluate((n, b) => window.WB.store.op(n, b).then(r => ({ ok: true, r }), e => ({ ok: false, error: e.message })), name, body);
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });

    // ---------------------------------------------------------------- 1. the agent proposes; it cannot start
    const prop = await tool('package_propose', { why: 'hand-off to the web site', composition: 'C:/evil', command: ['calc.exe'], out: '../../x' });
    const pid = prop.body?.request?.id;
    const stored = Jn('requests.json')?.items.find(r => r.id === pid);
    const s403 = await agentOp('package_start', { id: pid }), c403 = await agentOp('package_cancel', { id: pid }), u403 = await agentOp('request_update', { id: pid, status: 'running' });
    const cr400 = await tool('request_create', { kind: 'package', prompt: 'x', est_cost: 0 });
    check('C5 an agent proposes an export (package_propose: a draft request of kind package with its why; a path, a command or an out it sends is never stored) and cannot start, cancel or run it (no tool; package_start / package_cancel 403; request_update 403; request_create kind package 400)',
      !prop.error && stored?.kind === 'package' && stored.status === 'draft' && JSON.stringify(Object.keys(stored.package)) === '["why"]' && !JSON.stringify(stored).includes('evil') && !JSON.stringify(stored).includes('calc')
      && tools.includes('package_propose') && !tools.includes('package_start') && !tools.includes('package_cancel') && s403.status === 403 && c403.status === 403 && u403.status === 403 && cr400.error,
      { prop: prop.error ? prop.text : prop.body.warnings, stored: stored?.package, s403: s403.status, c403: c403.status, u403: u403.status, cr400: cr400.text.slice(0, 80) });

    // ---------------------------------------------------------------- 2. Render settings: the command and the composition (the director's)
    await pg.evaluate(() => window.WB.stages.open('final')); await until(() => !!document.querySelector('.fnrend .rnh'));
    await click('.fnrend [data-rn=settings]'); await until(() => !!document.querySelector('.wbdlg [data-f=composition]'));
    await pg.evaluate((cmd, comp, hf) => {
      const d = document.querySelector('.wbdlg'); d.querySelector('[data-f=command]').value = cmd.join('\n');
      d.querySelector('[data-f=composition]').value = comp; d.querySelector('[data-f=hyperframes]').value = hf;
      const set = (k, v) => { d.querySelector(`[data-n=${k}]`).value = v; };
      set('min_free_mb', '64'); set('ram_wait_s', '0'); set('width', '320'); set('height', '180'); set('verify_n', '6'); set('sample_fps', '2');
    }, RENDER_BLUE, C, HF);
    await shot('v30_render_settings');
    await click('.wbdlg [data-x=save]');
    const cfg = await untilFile(() => { const r = J('renders.json'); return r.config?.composition ? r.config : null; }, 8000);
    check('C5 Render settings… holds the composition (an absolute folder), its entry and the HyperFrames folder next to the render command: the director\'s, page only (an agent\'s render_config 403)',
      cfg?.composition === C && cfg.hyperframes === HF && cfg.entry === 'index.html' && cfg.verify_n === 6 && (await agentOp('render_config', { config: { command: ['x'], composition: TMP } })).status === 403, { cfg: cfg && { composition: cfg.composition, entry: cfg.entry, verify_n: cfg.verify_n } });

    // a render of the excerpt 2-6 s (blue, like the composition)
    const renderNow = async (why) => {
      const r = await pageOp('render_propose', { scope: 'excerpt', t0: 2000, t1: 6000, why }); const id = r.r?.request?.id;
      await pageOp('render_start', { id });
      return untilFile(() => { const x = J('requests.json').items.find(i => i.id === id); return ['done', 'failed'].includes(x.status) ? x : null; }, 60000);
    };
    const r1 = await renderNow('the excerpt for the package');

    // ---------------------------------------------------------------- 3. File › Export › Interactive HTML package…
    await pg.evaluate(() => import('/core/menus.js').then(m => m.openBar('File'))); await frames(3);
    await pg.evaluate(() => { const it = [...document.querySelectorAll('.pop .pi')].find(x => /^Export/.test(x.querySelector('.lb')?.textContent || '')); it?.click(); });
    await wait(400); await frames(2);
    const menu = await pg.evaluate(() => [...document.querySelectorAll('.pop')].map(m => m.textContent).join(' | '));
    await shot('v30_file_export_menu');
    await pg.keyboard.press('Escape'); await pg.keyboard.press('Escape'); await frames(2);
    await pg.evaluate(() => window.WB.commands.run('file.exportPackage')); await until(() => !!document.querySelector('.pkdlg [data-x=go]'));
    const conf = await pg.evaluate(() => ({ text: document.querySelector('.pkdlg')?.textContent || '', against: document.querySelector('.pkdlg [data-f=against]')?.value, props: [...document.querySelectorAll('.pkdlg input[name=pkp]')].map(i => i.value), go: !document.querySelector('.pkdlg [data-x=go]').disabled }));
    await shot('v30_export_confirm');
    check('C5 File › Export › Interactive HTML package… (the menu) opens the confirm: the composition of the render settings, the render it is checked against (the newest done one), the agent\'s proposal to start, free RAM vs the floor; Export enabled',
      r1?.status === 'done' && /Interactive HTML package…/.test(menu) && conf.text.includes(C) && conf.against === r1.id && conf.props.includes(pid) && /free RAM/.test(conf.text) && conf.go, { r1: r1?.status, why: r1?.why, menu: menu.slice(0, 200), conf: { ...conf, text: conf.text.slice(0, 200) } });
    await pg.evaluate((id) => { const i = [...document.querySelectorAll('.pkdlg input[name=pkp]')].find(x => x.value === id); if (i) i.checked = true; }, pid);
    await click('.pkdlg [data-x=go]');
    const sawProgress = await until(() => !!document.querySelector('.pkdlg .pkph, .pkdlg .pkrep'), null, 15000);
    if (await pg.evaluate(() => !!document.querySelector('.pkdlg .pkph'))) await shot('v30_export_progress');
    await until(() => !!document.querySelector('.pkdlg .pkrep, .pkdlg .pkph.rnerr'), null, 120000);
    await until(() => [...document.querySelectorAll('.pkdlg .pkfr img')].every(i => i.complete), null, 5000);
    const rep1 = await pg.evaluate(() => ({ rate: document.querySelector('.pkdlg .pkrate')?.textContent, chip: document.querySelector('.pkdlg .pkchip')?.textContent, imgs: [...document.querySelectorAll('.pkdlg .pkfr img')].map(i => i.naturalWidth), err: document.querySelector('.pkdlg .pkph.rnerr')?.textContent || '' }));
    await shot('v30_report_pass');
    const x1 = Jn('requests.json')?.items.find(r => r.id === pid), pk1 = Jn('renders.json')?.packages?.find(k => k.id === pid);
    const log1 = (() => { try { return fs.readFileSync(path.join(PD, 'exports', 'package', `${pid}.log`), 'utf8'); } catch (e) { return ''; } })();
    const files1 = ['index.html', 'manifest.json', 'interactive.html', 'composition/index.html'].map(f => fs.existsSync(path.join(PD, 'exports', 'package', pid, f)));
    check('C5 Export runs the workbench\'s exporter on the composition of the settings (--interactive, the HyperFrames folder) and then verify.mjs --against the render (an excerpt: --from 2 --to 6); the agent\'s proposal is the job; the package is written to exports/package/<id>/ and registered in renders.json packages[] with the revision and its report: 6 / 6 frames (100 %), pass',
      sawProgress && x1?.status === 'done' && x1.actual_cost_usd === 0 && pk1?.report?.frames === 6 && pk1.report.pass === 6 && pk1.report.verdict === 'pass' && pk1.against?.render === r1.id && pk1.revision === 'R0' && pk1.composition === C
      && files1.every(Boolean) && /--interactive/.test(log1) && log1.includes('--hyperframes') && /--from 2\.000 --to 6\.000/.test(log1) && !log1.includes('evil') && /6 \/ 6 frames match · 100 %/.test(rep1.rate || '') && /pass/.test(rep1.chip || '') && rep1.imgs.length >= 1 && rep1.imgs.every(w => w > 0),
      { x1: x1 && { status: x1.status, why: x1.why }, pk1: pk1 && { report: pk1.report && { frames: pk1.report.frames, pass: pk1.report.pass, verdict: pk1.report.verdict, problems: pk1.report.problems }, against: pk1.against, revision: pk1.revision }, files1, rep1, log: log1.split('\n').filter(l => /export:|verify:|frame match/.test(l)).map(l => l.slice(0, 160)) });
    await pg.keyboard.press('Escape');

    // ---------------------------------------------------------------- 4. a render that differs for half its frames: the report shows them
    await pageOp('render_config', { config: { ...cfg, command: RENDER_HALF } });
    const r2 = await renderNow('a render with a red second half');
    await pg.evaluate(() => window.WB.commands.run('file.exportPackage')); await until(() => !!document.querySelector('.pkdlg [data-x=go]'));
    const ag2 = await pg.evaluate(() => document.querySelector('.pkdlg [data-f=against]')?.value);
    await click('.pkdlg [data-x=go]');
    await until(() => !!document.querySelector('.pkdlg .pkrep, .pkdlg .pkph.rnerr'), null, 120000);
    await until(() => [...document.querySelectorAll('.pkdlg .pkfr img')].every(i => i.complete), null, 5000);
    const rep2 = await pg.evaluate(() => ({ rate: document.querySelector('.pkdlg .pkrate')?.textContent, bad: document.querySelectorAll('.pkdlg .pkfr.bad').length, imgs: [...document.querySelectorAll('.pkdlg .pkfr img')].map(i => i.naturalWidth) }));
    await shot('v30_report_fail');
    const pk2 = Jn('renders.json')?.packages?.at(-1);
    check('C5 against a render whose second half differs (the newest done render, preselected): 3 / 6 frames match (50 %), fail; the worst frames are the bad ones, each a package | render thumbnail with its MAD / PSNR',
      r2?.status === 'done' && ag2 === r2.id && pk2?.id !== pid && pk2?.report?.frames === 6 && pk2.report.pass === 3 && pk2.report.verdict === 'fail' && pk2.report.worst.slice(0, 3).every(w => w.bad && w.t >= 4) && /3 \/ 6 frames match · 50 %/.test(rep2.rate || '') && rep2.bad === 3 && rep2.imgs.every(w => w > 0),
      { r2: r2?.status, ag2, pk2: pk2?.report && { pass: pk2.report.pass, frames: pk2.report.frames, worst: pk2.report.worst.map(w => [w.t, w.mad, w.bad]) }, rep2 });
    await pg.keyboard.press('Escape');

    // ---------------------------------------------------------------- 5. one heavy job at a time (the render lock), no draft left behind
    const nPk = () => (Jn('requests.json')?.items || []).filter(r => r.kind === 'package').length, n0 = nPk();
    fs.writeFileSync(path.join(DATA, '.render.lock'), JSON.stringify({ pid: process.pid, project: P, id: 'rbusy', kind: 'render', at: new Date().toISOString(), heartbeat: new Date().toISOString() }));
    const busy = await pageOp('package_start', {});
    fs.rmSync(path.join(DATA, '.render.lock'), { force: true });
    check('C5 one heavy job at a time: with a render running on the machine (the shared lock), the export answers 409 and leaves no draft', !busy.ok && /one render at a time/.test(busy.error) && nPk() === n0, { busy: busy.error, n: [n0, nPk()] });

    // ---------------------------------------------------------------- 6. Final's lines, the Queue's row and its Notes column
    await pg.evaluate(() => window.WB.stages.open('final')); await frames(3); await wait(500);
    await pg.evaluate(() => document.querySelector('.fnrend')?.scrollTo(0, 1e5));
    const fl = await pg.evaluate(() => ({ lines: document.querySelectorAll('.fnrend .pkline').length, text: document.querySelector('.fnrend')?.textContent || '' }));
    await shot('v30_final_packages');
    check('C5 Final › Renders and sheets lists the HTML packages with their pass rate and a Report button', fl.lines >= 2 && /HTML packages/.test(fl.text) && /100 %/.test(fl.text) && /50 %/.test(fl.text), { lines: fl.lines });
    await pg.evaluate(() => window.WB.app.show('queue')); await frames(4); await wait(700);
    const q = await pg.evaluate((id) => { const tr = document.querySelector(`tr[data-id="${id}"]`); const nc = document.querySelector('.queue .nclayer'); return { row: tr?.textContent || '', nc: !!nc, cells: nc ? nc.querySelectorAll('.nccell:not(.top)').length : 0, rows: document.querySelectorAll('.queue tr[data-id]').length, head: nc?.querySelector('.nchead')?.textContent || '' }; }, pid);
    // type a note on the package row (its cell's "+")
    await pg.evaluate((id) => { const nc = [...(window.WB.notesColumns?.() || [])].find(c => c.sc.closest('.queue')); if (nc) return nc.edit({ stage: 'final', kind: 'request', id }); const tr = document.querySelector(`tr[data-id="${id}"]`); const i = [...document.querySelectorAll('.queue .nccell')].findIndex(c => Math.abs(c.getBoundingClientRect().top - tr.getBoundingClientRect().top) < 2); document.querySelectorAll('.queue .nccell')[i]?.querySelector('[data-nc=add]')?.click(); }, pid);
    await until(() => !!document.querySelector('.queue .nced'));
    await pg.keyboard.type('the web build wants the 1080p render too');
    await pg.keyboard.press('Enter');
    const qn = await untilFile(() => J('notes.json').notes.find(n => n.target?.kind === 'request' && n.target.id === pid), 8000);
    await frames(3); await wait(400);
    const cellTxt = await pg.evaluate(() => [...document.querySelectorAll('.queue .nccell')].map(c => c.textContent).join(' | '));
    await shot('v30_queue_notes');
    const an = await tool('notes_add', { target: { stage: 'final', kind: 'request', id: pid }, text: 'the agent: the 1080p render is proposed' });
    const an404 = await tool('notes_add', { target: { stage: 'final', kind: 'request', id: 'nope123' }, text: 'x' });
    check('review #3: Review › Queue has a Notes column (a cell per request row); a note typed on a row targets final / request / <id> (the director\'s), shows in its cell; notes_add takes the same target (404 for an unknown request); the package row shows "exported · 6/6 frames"',
      q.nc && q.cells === q.rows && q.rows > 0 && /exported · 6\/6 frames/.test(q.row) && qn?.via === 'page' && /1080p/.test(cellTxt) && !an.error && an404.error && /404|no request/.test(an404.text), { q: { ...q, row: q.row.slice(0, 120) }, qn: qn && { target: qn.target, via: qn.via }, an: an.error ? an.text : 'ok', an404: an404.text.slice(0, 80) });

    // ---------------------------------------------------------------- 7. a locked project: the agent may still propose an export; Final points to the exports
    const rv = Jn('revisions.json') || { v: 1, rev: 0, rounds: [], revisions: [] }; rv.lock = { at: new Date().toISOString(), revision: 'R0', snapshot: null, summary: 'v30', by: 'director', via: 'page', ready: true }; rv.rev = (rv.rev || 0) + 1;
    fs.writeFileSync(path.join(PD, 'revisions.json'), JSON.stringify(rv));
    await wait(400);
    const lp = await tool('package_propose', { why: 'after the lock' }), lr = await tool('render_propose', { scope: 'excerpt', t0: 0, t1: 2000 });
    await pg.evaluate(() => window.WB.store.reload(['revisions.json'])); await pg.evaluate(() => window.WB.stages.open('final')); await frames(3); await wait(500);
    const lb = await pg.evaluate(() => ({ text: document.querySelector('.fnlockbar')?.textContent || '', links: [...document.querySelectorAll('.fnlockbar [data-runcmd]')].map(a => a.dataset.runcmd) }));
    await shot('v30_final_locked');
    check('C5 on a project locked for render the agent still proposes an export (package_propose: what a locked cut is for) while its render_propose is 409; Final\'s lock bar points to Export composition data… and the HTML package',
      !lp.error && lp.body.request.kind === 'package' && lr.error && /locked/.test(lr.text) && lb.links.includes('file.exportPackage') && lb.links.includes('file.exportComposition'), { lp: lp.error ? lp.text : 'ok', lr: lr.text.slice(0, 80), lb });
    delete rv.lock; rv.rev++; fs.writeFileSync(path.join(PD, 'revisions.json'), JSON.stringify(rv)); await wait(300);

    // ---------------------------------------------------------------- 8. the timeline after a stage's Time view: never scrolled past the song's end
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await pg.evaluate(() => window.WB.store.reload(['revisions.json']));
    await pg.evaluate(() => window.WB.stages.open('lyrics')); await frames(3);
    await pg.evaluate(() => window.WB.timeMode.setMode('lyrics', 'time')); await frames(4); await wait(300);
    const back = await pg.evaluate(async () => {
      const ax = window.WB.timeMode.axes().find(a => a.visible); if (!ax) return { ax: false };
      ax.sc.scrollTop = ax.sc.scrollHeight; await new Promise(r => setTimeout(r, 300));
      const tl = window.WB.timeline, before = tl.scroller.scrollTop;
      await window.WB.app.show('timeline'); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))));
      const sc = tl.scroller, max = Math.max(0, Math.ceil(tl.warp.total + 24 - (sc.clientHeight - tl.headH)));
      return { ax: true, before, after: sc.scrollTop, max, total: Math.round(tl.warp.total), ch: sc.clientHeight };
    });
    await shot('v30_timeline_back');
    await pg.evaluate(() => window.WB.timeMode.setMode('lyrics', 'list'));
    check('review #3 UX 9: back on the timeline from a stage\'s Time view scrolled to its end, the song\'s end is at most at the bottom edge (no screen of nothing)', back.ax && back.after <= back.max + 1, back);

    // ---------------------------------------------------------------- 9. the low items
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    await pg.evaluate(() => window.WB.stages.open('storyboard')); await frames(4); await wait(500);
    const sbx = await pg.evaluate(() => ({ sel: document.querySelectorAll('.sbchsel').length, link: document.querySelectorAll('.sbchnew').length, chapters: (window.WB.store.board?.chapters || []).length }));
    await pg.evaluate(() => window.WB.app.show('costs')); await frames(3); await wait(300);
    const costTxt = await pg.evaluate(() => document.querySelector('.tabpane[data-tab=costs]')?.textContent || document.body.textContent);
    await pg.evaluate(() => window.WB.app.show('timeline')); await frames(2);
    const chcol = await pg.evaluate(async () => { const tl = window.WB.timeline, c = tl.cols.find(x => x.id === 'chapters'); if (!c) return null; c.def.build(c); return c.body.textContent; });
    check('review #3 LOW: no "no chapter" dropdown in the scene headers of a project without chapters (a quiet "+ chapter"); the chapters column says how to make one; no "js/prices.js" / "costs.json" words in Costs',
      sbx.chapters === 0 && sbx.sel === 0 && sbx.link > 0 && /no chapters yet/.test(chcol || '') && !/js\/prices\.js|\(costs\.json\)/.test(costTxt), { sbx, chcol: (chcol || '').slice(0, 60) });

    check('no page errors', !errors.length, errors.slice(0, 5));
  } catch (e) { check('v30 ran to the end', false, String(e.stack || e)); }
  finally {
    await pg?.close().catch(() => {});
    await client?.close().catch(() => {});
    srv.kill(); await wait(300);
    for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const puppeteer = createRequire(path.join(WB, 'package.json'))('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const exe = findChrome(); if (!exe) { console.error('no Chromium found: set CHROME_PATH'); process.exit(1); }
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots'));
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: exe, headless: true });
  let res = { pass: false, checks: {} }; try { res = await verifyPackage({ browser, OUT }); } finally { await browser.close(); }
  const n = Object.keys(res.checks).length, ok = Object.values(res.checks).filter(c => c.pass).length;
  console.log(`v30 (C5 the HTML package from the page + review #3 leftovers): ${res.pass ? 'all PASS' : 'FAIL'} (${ok}/${n})`);
  process.exitCode = res.pass ? 0 : 1;
}
