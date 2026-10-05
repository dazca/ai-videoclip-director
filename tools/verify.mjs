// Headless verification: screenshots in several layouts, the alignment test, resize perf and memory, (v2) the
// command system: palette, rebinding persistence, Ctrl+wheel zoom anchoring, context menus, undo/redo, snapshots, and
// (v2 Part B) the preview dock, media index, privacy of exports, characters and "+ New look", and (v3) the page
// structure (Timeline / Assets / Review + Settings gear) and the restore chevrons for a hidden top bar / column header,
// and (v4) the guided flow: the stage rail, the new-project wizard (lyrics only, then the song added), the lyrics stage,
// and (v5) stage 2: the script draft (intake, scenes, beats, sketches inline + copy/paste, gaps, notes, versions, the
// timeline Scenes column), and (v6) stage 3: the breakdown (suggest from script, versions, the matrix, merge, drop, context
// menus, Create entity, the agent extracting live, the timeline markers), and (v7, tools/verify-characters.mjs) stage 4: the
// characters (list, base picker: catalogue / Openverse mocked / photos, identity request -> approve -> simulated run ->
// node, an edit with sketch + mask + pins, A/B compare, keep / branch / revert, approve identity, looks, the agent's
// limits, the private export, the CSP, the toast stack), and (v8, tools/verify-scenery.mjs) stage 5: locations and props on the
// same asset workspace (list, location base, edit, approve, variants from axes as trees, a prop state variant, the per-scene
// variant picker, the characters stage still working), and (v9, tools/verify-storyboard.mjs) stage 6: the storyboard (shots from
// beats, tiling, edits, frame sketches, copy / paste, a per-shot variant, the gaps and the estimate vs the cap, the asks, the
// agent's side, the timeline shots column), and (v10, tools/verify-dogfood.mjs) the dogfood frictions: the agent's base proposal
// and image-import proposals accepted in the page, request warnings, the merged cost ledger, the photoreal recipe in the
// Queue's request form, the stale-code bar, and (v11, tools/verify-notes.mjs) notes everywhere (SPEC v4 §1): the migration of
// the old note stores, the Notes column in every stage and on the timeline, the right-click "+ Add" menus, the counters.
//   node tools/verify.mjs [--project <id>] [outDir]     (default project: the server's default; npm run verify = demo)
// Copies data/<project> (and data/_template) into a scratch data folder under the OS temp dir and starts serve.mjs
// on free ports with WORKBENCH_DATA = that folder, so nothing under data/ is written and several runs (or a running
// workbench on 8140) can coexist. Needs the devDependency puppeteer-core (npm install) and a Chromium: $CHROME_PATH,
// Playwright's cache, or a system Chrome/Edge (tools/chrome.mjs). Every write happens in the scratch folder
// (<project>-test, <project>-testb, _verify), deleted at the end, also when a step fails. The "Part B" block checks
// the owner's production (its clip ids, characters, private refs) and runs only on "azemar".
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(WB, 'package.json'));
let puppeteer; try { puppeteer = require('puppeteer-core'); } catch (e) { console.error('puppeteer-core missing: run npm install in the workbench folder'); process.exit(1); }
const { findChrome } = await import('./chrome.mjs');
const { CFG } = await import('../lib/store.mjs');
const argv = process.argv.slice(2), pi = argv.indexOf('--project');
const P = pi >= 0 ? argv.splice(pi, 2)[1] : CFG.defaultProject;
const SRCROOT = CFG.dataRoot, SRCDIR = path.join(SRCROOT, P);   // read only: the source of the scratch copy
if (!fs.existsSync(path.join(SRCDIR, 'song.json'))) { console.error(`no project "${P}" in ${SRCROOT} (node tools/make_demo.mjs builds the demo)`); process.exit(1); }
const OWNER = P === 'azemar';                       // the owner's production: enables the Part B block
const J = (f) => JSON.parse(fs.readFileSync(path.join(SRCDIR, f), 'utf8'));
const DUR = J('song.json').duration_ms;
const at = (ms) => (ms <= DUR * 0.9 ? ms : Math.round(DUR * 0.5));   // the owner's test times, folded into short songs
const SHOT0 = J('shots.json').shots[0]?.id;
const LEAD = J('entities/index.json').find(e => e.kind === 'character');
const MEDIA_N = (J('media.json').items || []).length;
const OUT = path.resolve(argv[0] || path.join(WB, 'shots'));
fs.mkdirSync(OUT, { recursive: true });
const exe = findChrome(); if (!exe) { console.error('no Chromium found: set CHROME_PATH'); process.exit(1); }

// scratch data folder: a copy of the project (without its snapshots) and the template; the servers write only here
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-verify-'));
for (const d of [P, '_template']) if (fs.existsSync(path.join(SRCROOT, d))) fs.cpSync(path.join(SRCROOT, d), path.join(DATA, d), { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
console.log('verify: project', P, '·', DUR, 'ms ·', exe, '· scratch data', DATA);

// cleanup also runs when a step throws (top-level rejection) or on Ctrl+C: no server, Chromium or scratch data left behind
const procs = new Set();
let browser;
function cleanup() {
  for (const c of procs) { try { c.kill(); } catch (e) {} }
  try { browser?.process()?.kill(); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { console.error('could not remove', DATA, e.message); }
}
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

const freePort = () => new Promise((ok, bad) => { const s = net.createServer(); s.on('error', bad); s.listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); }); });
// serve.mjs on a free port with WORKBENCH_DATA = the scratch folder; fails (instead of hanging) if it exits or stays silent
async function startServer(project) {
  const port = await freePort();
  const c = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: { ...process.env, WORKBENCH_DATA: DATA, WB_PROJECT: project } });
  procs.add(c); c.on('exit', () => procs.delete(c));
  let err = ''; c.stderr.on('data', d => { err += d; process.stderr.write(`server ${port}: ` + d); });
  await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error(`server on port ${port} did not start within 15 s`)), 15000);
    c.stdout.once('data', () => { clearTimeout(t); ok(); });
    c.once('exit', (code) => { clearTimeout(t); bad(new Error(`server on port ${port} exited (${code}): ${err.trim()}`)); });
  });
  c.stdout.resume();
  const base = `http://localhost:${port}`;
  const st = await fetch(base + '/api/status').then(r => r.json()).catch(() => ({}));
  if (st.data_dir && path.resolve(st.data_dir) !== path.resolve(DATA)) throw new Error(`server on port ${port} serves ${st.data_dir}, not the scratch folder ${DATA}`);
  return { proc: c, base, port };
}
// headers for the harness's own POSTs. The page gets its per-run write token from the served page (B1), so read it
// from there: a <meta name="...token..." content>, an inline WB_TOKEN = "...", else /api/config {token|write_token};
// any cookie the page response sets is sent back too. JSON content type and the server's own Origin, like the page.
async function writeHeaders(base, project) {
  const res = await fetch(`${base}/?project=${encodeURIComponent(project)}`).catch(() => null);
  const html = res ? await res.text() : '';
  let tok = /<meta\b[^>]*\bname=["'][^"']*token[^"']*["'][^>]*\bcontent=["']([^"']+)/i.exec(html)?.[1]
    || /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["'][^"']*token/i.exec(html)?.[1]
    || /\bWB_TOKEN\s*[:=]\s*["']([^"']+)["']/.exec(html)?.[1];
  if (!tok) { const c = await fetch(base + '/api/config').then(r => r.json()).catch(() => ({})); tok = c?.token || c?.write_token; }
  const cookie = (res?.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  return { 'content-type': 'application/json', origin: base, ...(tok ? { 'x-wb-token': tok } : {}), ...(cookie ? { cookie } : {}) };
}

const { base: BASE } = await startServer(P);
const HDR = await writeHeaders(BASE, P);
const post = async (p, body, base = BASE, headers = HDR) => { const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const report = { configs: [] };
const blockFailed = (name, e) => { console.error(`${name} aborted:`, e?.stack || e); return { pass: false, detail: String(e?.message || e) }; };

async function open(w, h) {
  const pg = await browser.newPage();
  await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  pg.on('pageerror', e => console.error('pageerror', e.message));
  pg.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.error('console', m.text()); });
  const t0 = Date.now();
  await pg.goto(`${BASE}/?project=${encodeURIComponent(P)}`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
  await pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const boot = await pg.evaluate(() => window.WB.boot);
  return { pg, boot, wallMs: Date.now() - t0 };
}

async function shot(pg, name, setup, atMs = 21000) {
  atMs = at(atMs);
  await pg.evaluate(setup);
  await pg.evaluate((t) => { const tl = window.WB.timeline; tl.seek(t); tl.scrollToTime(t); tl.drawLanes(); }, atMs);
  await pg.evaluate(() => Promise.race([new Promise(r => setTimeout(r, 1500)), Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; })))]));
  await pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const file = path.join(OUT, `${name}.png`);
  await pg.screenshot({ path: file });
  const align = await pg.evaluate(() => window.WB.alignTest());
  await pg.evaluate((t) => { const tl = window.WB.timeline; tl.seek(t); tl.scrollToTime(t); tl.drawLanes(); }, atMs);
  await pg.screenshot({ path: file });
  const total = await pg.evaluate(() => Math.round(window.WB.timeline.warp.total));
  report.configs.push({ name, file, totalPx: total, align: { pass: align.pass, worstPx: align.worstPx, rows: align.rows.map(r => ({ t: r.t, maxDev: r.maxDev, columns: r.n })) } });
  console.log(`${name}: align ${align.pass ? 'PASS' : 'FAIL'} worst ${align.worstPx} px over ${align.rows.map(r => r.n).join('/')} columns; axis ${total} px`);
  return align;
}

// 1920x1080
try {
  const { pg, boot, wallMs } = await open(1920, 1080);
  report.boot1920 = { ...boot, wallMs };
  console.log('boot 1920', JSON.stringify(report.boot1920));
  await shot(pg, '1920_default', () => {});
  await shot(pg, '1920_lyrics_narrow', () => window.WB.timeline.setWidth('lyrics', 90));
  await shot(pg, '1920_stems_cost', () => { const tl = window.WB.timeline; tl.setWidth('lyrics', 210); tl.setHidden('stems', false); tl.setHidden('cost', false); }, 58000);
  await pg.evaluate(() => new Promise(r => setTimeout(r, 300)));
  await shot(pg, '1920_stems_cost', () => {}, 58000);
  await shot(pg, '1920_linear', () => window.WB.timeline.toggleLinear(), 58000);
  await pg.evaluate(() => window.WB.timeline.toggleLinear());
  // perf: drag the lyrics gutter in 40 steps
  const widths = Array.from({ length: 40 }, (_, i) => 260 - i * 5);
  const steps = await pg.evaluate((w) => window.WB.perfResize('lyrics', w), widths);
  const steps2 = await pg.evaluate((w) => window.WB.perfResize('script', w), widths.map(x => x + 40));
  const sorted = [...steps, ...steps2].sort((a, b) => a - b);
  report.resize = { steps: sorted.length, medianMs: sorted[sorted.length >> 1], p95Ms: sorted[Math.floor(sorted.length * 0.95)], maxMs: sorted[sorted.length - 1] };
  console.log('resize', JSON.stringify(report.resize));
  // scroll redraw cost
  report.scroll = await pg.evaluate(() => { const tl = window.WB.timeline; const ts = []; for (let i = 0; i < 60; i++) { tl.scroller.scrollTop = i * 97; const t0 = performance.now(); tl.drawLanes(); ts.push(performance.now() - t0); } ts.sort((a, b) => a - b); return { medianMs: +ts[30].toFixed(2), maxMs: +ts[59].toFixed(2) }; });
  console.log('lane redraw', JSON.stringify(report.scroll));
  const cdp = await pg.target().createCDPSession(); await cdp.send('Performance.enable');
  const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
  report.memory = { jsHeapUsedMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, layoutCount: m.LayoutCount };
  console.log('memory', JSON.stringify(report.memory));
  // compact: every lane at 3 px, top bar hidden, thin header
  await shot(pg, '1920_compact_3px', () => { const tl = window.WB.timeline; for (const id of ['wave', 'stems', 'energy']) tl.setWidth(id, 3); tl.setWidth('lyrics', 150); document.body.classList.add('notop'); tl.headerMode = 1; tl.applyHeaderMode(); tl.applyColumns(); tl.relayout(); }, 140000);
  await pg.close();
} catch (e) { report.configs.push({ name: '1920 (aborted)', align: blockFailed('1920 layouts', e) }); }
// 1280x800
try {
  const { pg, boot } = await open(1280, 800);
  report.boot1280 = boot;
  await shot(pg, '1280_default', () => {}, 26000);
  await shot(pg, '1280_lyrics_narrow', () => window.WB.timeline.setWidth('lyrics', 80), 26000);
  await pg.evaluate(() => { document.querySelector('[data-tab=assets]').click(); });
  await pg.evaluate(() => new Promise(r => setTimeout(r, 300)));
  await pg.evaluate(() => document.querySelector('.subnav [data-sub=characters]').click());
  await pg.evaluate(() => new Promise(r => setTimeout(r, 600)));
  await pg.screenshot({ path: path.join(OUT, '1280_characters_tab.png').replace(/\\/g, '/') });
  await pg.evaluate(() => document.querySelector('.subnav [data-sub=locations]').click());
  await pg.evaluate(() => new Promise(r => setTimeout(r, 600)));
  await pg.screenshot({ path: path.join(OUT, '1280_locations_tab.png') });
  await pg.close();
} catch (e) { report.configs.push({ name: '1280 (aborted)', align: blockFailed('1280 layouts', e) }); }
// ---------------------------------------------------------------- v2: commands, palette, keymap, wheel, menus, undo, snapshots
// Runs on a working copy "<project>-test" made through the server's own duplicate endpoint, deleted at the end.
const v2 = report.v2 = { checks: {} };
try {
  const B = BASE, TEST = P + '-test', TD = path.join(DATA, TEST);
  if (fs.existsSync(TD)) await post('/api/projects/delete', { id: TEST });
  const check = (name, ok, detail) => { v2.checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v2 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`); };
  const dup = await post('/api/projects/duplicate', { from: P, to: TEST });
  check('duplicate project', dup.status === 200 && fs.existsSync(path.join(TD, 'song.json')), dup);
  if (!v2.checks['duplicate project'].pass) throw new Error('could not duplicate the project; the v2 checks need the copy');
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  pg.on('pageerror', e => console.error('pageerror', e.message));
  pg.on('console', m => { if (m.type() === 'error') console.error('console', m.text()); });
  const ready = async () => { await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); };
  const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const combo = async (mods, key) => { for (const m of mods) await pg.keyboard.down(m); await pg.keyboard.press(key); for (const m of mods.slice().reverse()) await pg.keyboard.up(m); };
  await pg.goto(`${B}/?project=${TEST}`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
  await pg.evaluate((T) => { const tl = window.WB.timeline; tl.seek(T); tl.scrollToTime(T); tl.drawLanes(); }, at(21000));

  // 1. palette opens (Ctrl+K) and runs a command
  const lin0 = await pg.evaluate(() => window.WB.timeline.linear);
  await combo(['Control'], 'KeyK');
  const palOpen = await pg.evaluate(() => !!document.querySelector('.pal input') && document.activeElement === document.querySelector('.pal input'));
  await pg.keyboard.type('linear time');
  await wait(100);
  await pg.screenshot({ path: path.join(OUT, 'v2_palette.png') });
  const first = await pg.evaluate(() => document.querySelector('.pal .pr.hl .lb')?.textContent);
  await pg.keyboard.press('Enter'); await frames();
  const lin1 = await pg.evaluate(() => window.WB.timeline.linear);
  check('palette opens and runs a command', palOpen && first === 'Linear time (no warp)' && lin1 !== lin0 && !(await pg.evaluate(() => !!document.querySelector('.pal'))), { palOpen, first, linearBefore: lin0, linearAfter: lin1 });
  await pg.evaluate(() => window.WB.commands.run('view.linear')); await frames();

  // 2. rebinding persists across reload (Settings > keybindings: + then press G on "Follow playhead")
  await pg.evaluate(() => window.WB.app.show('settings')); await frames();
  await pg.evaluate(() => { document.querySelector('.kbf').value = ''; document.querySelector('tr[data-id="view.follow"]').scrollIntoView({ block: 'center' }); });
  await pg.click('tr[data-id="view.follow"] button[data-k=add]');
  await pg.keyboard.press('KeyG');
  await wait(500);
  await pg.evaluate(() => { document.querySelector('.kb').scrollIntoView(); const r = document.querySelector('tr[data-id="view.follow"]'); const p = document.querySelector('.settings'); p.scrollTop += r.getBoundingClientRect().top - innerHeight * 0.55; });
  await pg.screenshot({ path: path.join(OUT, 'v2_settings_keybindings.png') });
  const onDisk = JSON.parse(fs.readFileSync(path.join(TD, 'settings.json'), 'utf8')).keybindings?.['view.follow'];
  await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
  await pg.evaluate(() => window.WB.app.show('timeline')); await frames();
  const keysAfter = await pg.evaluate(() => window.WB.commands.keysFor('view.follow'));
  const f0 = await pg.evaluate(() => window.WB.timeline.follow);
  await pg.mouse.move(500, 400); await pg.keyboard.press('KeyG'); await frames();
  const f1 = await pg.evaluate(() => window.WB.timeline.follow);
  check('rebinding persists across reload', JSON.stringify(onDisk) === '["F","G"]' && keysAfter.includes('G') && f0 !== f1, { settingsJson: onDisk, keysAfterReload: keysAfter, followToggledByG: f0 !== f1 });

  // 3. Ctrl+wheel zoom keeps the time under the cursor fixed (<= 1 px) and the columns aligned
  // a short song is shorter than the window at 16 px/s: zoom in first so every cursor row below lies inside the song
  await pg.evaluate((T) => { const tl = window.WB.timeline; const min = innerHeight * 2.5 / (window.WB.store.song.duration_ms / 1000); if (tl.pxPerSec < min) { tl.pxPerSec = min; tl.relayout(); } tl.follow = true; tl.seek(T); tl.scrollToTime(T); tl.drawLanes(); }, at(60000)); await frames();
  const zoomRes = [];
  for (const [dy, y] of [[-240, 520], [-480, 300], [600, 650], [360, 420]]) {
    const pt = await pg.evaluate((cy) => { const tl = window.WB.timeline, c = tl.byId.lyrics; const r = tl.sheet.getBoundingClientRect(); return { x: Math.round(r.left + c.x + c.vw / 2), t: tl.warp.t(cy - r.top), pps: tl.pxPerSec }; }, y);
    await pg.mouse.move(pt.x, y);
    await pg.keyboard.down('Control'); await pg.mouse.wheel({ deltaY: dy }); await pg.keyboard.up('Control');
    await frames(3);
    const after = await pg.evaluate((t) => { const tl = window.WB.timeline; return { y: tl.sheet.getBoundingClientRect().top + tl.warp.y(t), pps: tl.pxPerSec }; }, pt.t);
    zoomRes.push({ deltaY: dy, cursorY: y, t: Math.round(pt.t), ppsBefore: +pt.pps.toFixed(2), ppsAfter: +after.pps.toFixed(2), devPx: +Math.abs(after.y - y).toFixed(3) });
  }
  const zAlign = await pg.evaluate(() => window.WB.alignTest());
  check('ctrl+wheel zoom anchored at the cursor', zoomRes.every(z => z.devPx <= 1 && z.ppsAfter !== z.ppsBefore) && zAlign.pass, { steps: zoomRes, alignAfterZoom: { pass: zAlign.pass, worstPx: zAlign.worstPx } });
  // Alt+wheel widens the column under the cursor
  const w0 = await pg.evaluate(() => window.WB.timeline.byId.script.vw);
  const sx = await pg.evaluate(() => { const tl = window.WB.timeline, c = tl.byId.script; return Math.round(tl.sheet.getBoundingClientRect().left + c.x + c.vw / 2); });
  await pg.mouse.move(sx, 400); await pg.keyboard.down('Alt'); await pg.mouse.wheel({ deltaY: -100 }); await pg.keyboard.up('Alt'); await frames(3);
  const w1 = await pg.evaluate(() => window.WB.timeline.byId.script.vw);
  check('alt+wheel widens the column under the cursor', w1 > w0, { before: w0, after: w1 });
  await pg.evaluate((T) => { const tl = window.WB.timeline; tl.pxPerSec = 16; tl.resetWidth('script'); tl.relayout(); tl.seek(T); tl.scrollToTime(T); tl.drawLanes(); }, at(21000)); await frames();

  // 4. right-click menus per context
  const EXPECT = {
    ruler: { sel: '.col-ruler', labels: ['Play from here', 'Loop section', 'Add marker at the playhead', 'Set loop from here', 'Select section', 'Zoom to section', 'Copy time code'] },
    lyric: { sel: '.col-lyrics .vl span', labels: ['Play from here', 'Loop line', 'Add note to this line…', 'Edit timing… (request)', 'Copy text', 'Add marker at the playhead'] },
    section: { sel: '.col-sections .sec', labels: ['Rename section…', 'Colour', 'Loop section', 'Collapse section (fold)', 'Duplicate as variant (request)'] },
    shot: { sel: '.col-shots .shot', labels: ['Preview', 'Approve', 'Request changes', 'Regenerate (queue a request)', 'Duplicate (request)', 'Copy id'] },
    clip: { sel: '.col-clips .use', labels: ['Preview', 'Show in Clips', 'Choose take', 'Set in-point… (request)', 'Approve', 'Regenerate (queue a request)', 'Open file location', 'Copy id'] },
    cast: { sel: '.col-cast .cast', labels: ['Open', 'Swap costume', 'Preview'] },
    note: { sel: '.col-notes .note', labels: ['Rename…', 'Delete', 'Copy text', 'Done (absorbed)'] },
    header: { sel: '.head[data-col=script] .nm', labels: ['Hide column script', 'Collapse to strip', 'Drives the time axis', 'Width', 'Move left', 'Move right', 'Column settings…', 'Reset width and mode'] },
    empty: { sel: '.col-wave', labels: ['Paste (time code seeks, text becomes a note)', 'Add marker at the playhead'] },
  };
  const menuRes = {};
  const rightClick = async (sel, nth = 3) => {
    const pt = await pg.evaluate((s, n) => {
      if (/^\.col-[a-z]+$/.test(s)) { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 15), y: 450 }; }
      const els = [...document.querySelectorAll(s)].filter(e => e.getClientRects().length);
      const tl = window.WB.timeline;
      const vis = els.filter(e => { const r = e.getBoundingClientRect(); return r.top > 40 && r.bottom < innerHeight - 10 && r.width > 2; });
      const e = vis[Math.min(n, vis.length - 1)] || els[Math.min(n, els.length - 1)];
      if (!e) return { err: 'no element ' + s };
      if (!vis.length && e) { e.scrollIntoView({ block: 'center' }); tl?.drawLanes(); }
      const r = e.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 20), y: r.top + Math.min(r.height / 2, 7) };
    }, sel, nth);
    if (pt.err) { console.error(pt.err); return []; }
    await pg.mouse.click(pt.x, pt.y, { button: 'right' }); await wait(60);
    return pg.evaluate(() => [...document.querySelectorAll('.pop')].map(p => [...p.querySelectorAll('.pi .lb')].map(x => x.childNodes[0]?.textContent.trim())));
  };
  for (const [name, e] of Object.entries(EXPECT)) {
    const menus = await rightClick(e.sel);
    const got = menus[0] || [];
    const missing = e.labels.filter(l => !got.includes(l));
    menuRes[name] = { ok: missing.length === 0, missing, items: got.length };
    await pg.keyboard.press('Escape'); await wait(30);
  }
  // entity card on the Characters tab
  await pg.evaluate(() => window.WB.app.show('characters')); await frames();
  { const got = (await rightClick('.card[data-ent]', 0))[0] || []; const L = ['Open', 'Preview', 'Duplicate (request)', 'New costume / look… (request)', 'Request generation…', 'Archive']; const missing = L.filter(l => !got.includes(l)); menuRes.entity = { ok: !missing.length, missing, items: got.length }; await pg.keyboard.press('Escape'); }
  await pg.evaluate(() => window.WB.app.show('timeline')); await frames();
  // submenu: clip > Choose take (hover opens it, keyboard Right also works)
  await rightClick('.col-clips .use', 4);
  const takeRow = await pg.evaluate(() => { const r = [...document.querySelectorAll('.pop .pi')].find(x => x.textContent.includes('Choose take')).getBoundingClientRect(); return { x: r.left + 40, y: r.top + 10 }; });
  await pg.mouse.move(takeRow.x, takeRow.y); await wait(250);
  const sub = await pg.evaluate(() => { const p = document.querySelectorAll('.pop'); return p.length > 1 ? [...p[1].querySelectorAll('.lb')].map(x => x.textContent.trim()) : []; });
  await pg.mouse.move(takeRow.x + 220, takeRow.y + 22); await wait(150);
  await pg.screenshot({ path: path.join(OUT, 'v2_context_submenu.png') });
  await pg.keyboard.press('Escape'); await pg.keyboard.press('Escape');
  check('right-click menus per context', Object.values(menuRes).every(m => m.ok) && sub.some(s => s.startsWith('take 0')), { ...menuRes, takeSubmenu: sub });

  // 5. undo / redo of an approval (Ctrl+Z, Ctrl+Shift+Z), in the page and in the file
  const fileState = (k) => JSON.parse(fs.readFileSync(path.join(TD, 'approvals.json'), 'utf8')).items[k]?.state || 'draft';
  const key = await pg.evaluate(() => { const ch = [...document.querySelectorAll('.col-status .chip[data-k]')].find(c => c.getBoundingClientRect().top > 40); ch.click(); return ch.dataset.k; });
  await wait(400);
  const u = { key, before: null, afterClick: await pg.evaluate((k) => window.WB.store.state(k), key), fileAfterClick: fileState(key) };
  await combo(['Control'], 'KeyZ'); await wait(400);
  u.afterUndo = await pg.evaluate((k) => window.WB.store.state(k), key); u.fileAfterUndo = fileState(key);
  await combo(['Control', 'Shift'], 'KeyZ'); await wait(400);
  u.afterRedo = await pg.evaluate((k) => window.WB.store.state(k), key); u.fileAfterRedo = fileState(key);
  u.before = J('approvals.json').items[key]?.state || 'draft';
  check('undo/redo of an approval', u.afterClick !== u.before && u.afterUndo === u.before && u.fileAfterUndo === u.before && u.afterRedo === u.afterClick && u.fileAfterRedo === u.afterClick, u);

  // 6. snapshot / change / restore round trip (endpoints through WB.projects, as the File menu does)
  const read = () => ({ approvals: fs.readFileSync(path.join(TD, 'approvals.json'), 'utf8'), notes: fs.readFileSync(path.join(TD, 'notes.json'), 'utf8'), requests: fs.existsSync(path.join(TD, 'requests.json')) ? fs.readFileSync(path.join(TD, 'requests.json'), 'utf8') : null });
  const snap = await pg.evaluate(() => window.WB.projects.snapshot('verify: before change'));
  const s0 = read();
  await pg.evaluate(async ([sh, T]) => { const S = window.WB.store; await S.setState('shot:' + sh, 'changes'); await S.addNote(T, 'verify: changed after snapshot'); await S.addRequest({ kind: 'regenerate', target: 'shot:' + sh, prompt: 'verify', est_cost: 0.4 }); }, [SHOT0, at(33000)]);
  await wait(300);
  const changed = read().approvals !== s0.approvals && read().notes !== s0.notes && read().requests !== s0.requests;
  const res = await pg.evaluate((id) => window.WB.projects.restore(id), snap.id);
  await wait(900);
  const s1 = read();
  // restore bumps {rev} above both versions (so stale pages get 409); compare content without rev
  const norm = (txt) => { if (txt == null) return null; try { const o = JSON.parse(txt); if (o && typeof o === 'object') delete o.rev; return JSON.stringify(o); } catch { return txt; } };
  for (const k of ['approvals', 'notes', 'requests']) { s0[k] = norm(s0[k]); s1[k] = norm(s1[k]); }
  const pageNotes = await pg.evaluate(() => window.WB.store.notes.notes.some(n => n.text === 'verify: changed after snapshot'));
  const snaps = await (await fetch(`${B}/api/snapshots?project=${TEST}`)).json();
  check('snapshot/restore round trip', changed && s1.approvals === s0.approvals && s1.notes === s0.notes && s1.requests === s0.requests && !pageNotes && snaps.some(s => s.auto && s.id === res.previous),
    { snapshot: snap.id, changedBetween: changed, approvalsIdentical: s1.approvals === s0.approvals, notesIdentical: s1.notes === s0.notes, requestsRestored: s1.requests === s0.requests, pageReloaded: !pageNotes, previousKeptAs: res.previous, snapshots: snaps.length });

  // screenshots: menu bar File > Revert to snapshot, cheat sheet
  await pg.evaluate(() => window.WB.projects.refresh());
  const fb = await pg.evaluate(() => { const r = document.querySelector('.mbar [data-m=File]').getBoundingClientRect(); return { x: r.left + 8, y: r.top + 8 }; });
  await pg.mouse.click(fb.x, fb.y); await wait(80);
  const rv = await pg.evaluate(() => { const r = [...document.querySelectorAll('.pop .pi')].find(x => x.textContent.includes('Revert to snapshot')).getBoundingClientRect(); return { x: r.left + 40, y: r.top + 10 }; });
  await pg.mouse.move(rv.x, rv.y); await wait(250);
  const fileMenu = await pg.evaluate(() => [...document.querySelectorAll('.pop')].map(p => p.querySelectorAll('.pi').length));
  await pg.screenshot({ path: path.join(OUT, 'v2_menubar_file.png') });
  await pg.keyboard.press('Escape'); await pg.keyboard.press('Escape');
  // keyboard: F10 opens the bar, Right moves to Edit
  await pg.keyboard.press('F10'); await pg.keyboard.press('ArrowRight'); await wait(50);
  const kbBar = await pg.evaluate(() => document.querySelector('.mbar b.on')?.textContent);
  await pg.keyboard.press('Escape');
  check('menu bar (mouse + keyboard)', fileMenu.length === 2 && fileMenu[1] >= 1 && kbBar === 'Edit', { popups: fileMenu, keyboardMovedTo: kbBar });
  await pg.keyboard.press('?'); await wait(80);
  const cheat = await pg.evaluate(() => document.querySelectorAll('.cheat section').length);
  await pg.screenshot({ path: path.join(OUT, 'v2_cheatsheet.png') });
  await pg.keyboard.press('Escape');
  check('cheat sheet', cheat >= 6, { groups: cheat });

  // 7. (v3) restore chevrons: hide the bar -> a 12 px chevron in the top-right corner -> click restores; Esc never hides
  await pg.evaluate(() => { window.WB.app.show('timeline'); window.WB.app.setTopbar(true); }); await frames();
  await pg.mouse.move(600, 450);
  await pg.keyboard.press('Escape'); await frames();
  const escKeeps = await pg.evaluate(() => !document.body.classList.contains('notop'));
  await pg.keyboard.press('Backquote'); await frames(3);
  const chev = await pg.evaluate(() => { const b = document.getElementById('toprestore'); const r = b.getBoundingClientRect(); const cs = getComputedStyle(b);
    return { hidden: document.body.classList.contains('notop'), barGone: document.getElementById('top').getBoundingClientRect().height === 0, w: r.width, h: r.height, top: r.top, rightGap: innerWidth - r.right, opacity: +cs.opacity, z: cs.zIndex, title: b.title, onTop: document.elementFromPoint(r.left + 6, r.top + 6) === b,
      pickerFree: (() => { const p = document.querySelector('.tl .picker').getBoundingClientRect(); return p.right <= r.left || p.top >= r.bottom; })() }; });
  await pg.keyboard.press('Escape'); await frames();
  const escStillHidden = await pg.evaluate(() => document.body.classList.contains('notop'));
  await pg.screenshot({ path: path.join(OUT, 'v3_topbar_hidden.png') });
  await pg.screenshot({ path: path.join(OUT, 'v3_topbar_hidden_corner.png'), clip: { x: 1600 - 160, y: 0, width: 160, height: 60 } });
  // right-click on empty space and the palette both offer "Show top bar" while it is hidden
  const emptyMenu = (await rightClick('.col-wave'))[0] || []; await pg.keyboard.press('Escape'); await wait(30);
  await combo(['Control'], 'KeyK'); await pg.keyboard.type('show top bar'); await wait(80);
  const palTop = await pg.evaluate(() => document.querySelector('.pal .pr.hl .lb')?.textContent); await pg.keyboard.press('Escape');
  // hover makes it opaque; a click restores the bar
  await pg.mouse.move(1600 - 6, 6); await wait(200);
  const hoverOpacity = await pg.evaluate(() => +getComputedStyle(document.getElementById('toprestore')).opacity);
  await pg.mouse.click(1600 - 6, 6); await frames(3);
  const restored = await pg.evaluate(() => ({ bar: !document.body.classList.contains('notop'), chevronGone: getComputedStyle(document.getElementById('toprestore')).display === 'none' }));
  check('top bar: hide -> corner chevron -> click restores; Esc never hides', escKeeps && chev.hidden && chev.barGone && chev.w === 12 && chev.h === 12 && chev.top === 0 && chev.rightGap === 0 && chev.opacity < 0.6 && chev.onTop && chev.pickerFree && /`/.test(chev.title)
    && escStillHidden && emptyMenu.includes('Show top bar') && palTop === 'Show top bar' && hoverOpacity === 1 && restored.bar && restored.chevronGone,
    { escKeepsBar: escKeeps, chevron: chev, escWhileHidden: escStillHidden ? 'still hidden' : 'toggled!', emptyMenuHasShow: emptyMenu.includes('Show top bar'), palette: palTop, hoverOpacity, restored });
  // column header hidden -> chevron at the top edge of the time ruler -> click restores
  await pg.evaluate(() => window.WB.timeline.setHeaderMode(2)); await frames(3);
  const hc = await pg.evaluate(() => { const tl = window.WB.timeline, b = tl.root.querySelector('.hdrrestore'), r = b.getBoundingClientRect(), ru = tl.byId.ruler.el.getBoundingClientRect(), rt = tl.root.getBoundingClientRect();
    return { visible: getComputedStyle(b).display !== 'none', w: r.width, atTop: Math.round(r.top - rt.top), insideRuler: r.left >= ru.left && r.right <= ru.right, title: b.title }; });
  const hmenu = (await rightClick('.col-wave'))[0] || []; await pg.keyboard.press('Escape'); await wait(30);
  await pg.click('.tl .hdrrestore'); await frames(3);
  const hAfter = await pg.evaluate(() => ({ mode: window.WB.timeline.headerMode, chevronGone: getComputedStyle(document.querySelector('.tl .hdrrestore')).display === 'none' }));
  check('column header: hide -> ruler chevron -> click restores', hc.visible && hc.w === 12 && hc.atTop === 0 && hc.insideRuler && hmenu.includes('Show column header') && hAfter.mode === 0 && hAfter.chevronGone, { chevron: hc, emptyMenuHasShow: hmenu.includes('Show column header'), after: hAfter });

  // 8. (v3) pages: Timeline | Assets | Review tabs + gear; 1-4 switch pages; Alt+1 still toggles a column; Ctrl+, = Settings
  const tabsShown = await pg.evaluate(() => [...document.querySelectorAll('#top nav [data-tab]')].map(a => a.textContent));
  const gear = await pg.evaluate(() => !!document.querySelector('#top [data-gear]'));
  await pg.mouse.move(600, 450);
  const pageKeys = {};
  for (const k of ['2', '3', '4', '1']) { await pg.keyboard.press('Digit' + k); await frames(2); pageKeys[k] = await pg.evaluate(() => window.WB.app.active()); }
  const c0 = await pg.evaluate(() => window.WB.timeline.cols[0].hidden);
  await combo(['Alt'], 'Digit1'); await frames(2);
  const c1 = await pg.evaluate(() => window.WB.timeline.cols[0].hidden);
  await combo(['Alt'], 'Digit1'); await frames(2);
  await combo(['Control'], 'Comma'); await frames(2);
  const ctrlComma = await pg.evaluate(() => ({ active: window.WB.app.active(), gearOn: document.querySelector('#top [data-gear]').classList.contains('on') }));
  await pg.keyboard.press('Digit1'); await frames();
  const winMenu = await pg.evaluate(() => { const its = window.WB.menus.itemsFor('menubar:Window'); return its.length; });
  check('pages: 3 tabs + gear, keys 1-4, Alt+1 columns, Ctrl+, settings', JSON.stringify(tabsShown) === '["Timeline","Assets","Review"]' && gear && pageKeys[2] === 'assets' && pageKeys[3] === 'review' && pageKeys[4] === 'settings' && pageKeys[1] === 'timeline' && c0 !== c1 && ctrlComma.active === 'settings' && ctrlComma.gearOn,
    { tabs: tabsShown, gear, pageKeys, altOneToggledColumn: c0 !== c1, ctrlComma, windowMenuItems: winMenu });
  // Assets: sub-nav, the character page opens inside it, search filters the cards
  await pg.click('#top [data-tab=assets]'); await frames();
  await pg.evaluate(() => document.querySelector('.subnav [data-sub=characters]').click()); await frames(); await wait(300);
  const subs = await pg.evaluate(() => [...document.querySelectorAll('.pgwrap[data-page=assets] .subnav a')].map(a => a.firstChild.textContent));
  await pg.screenshot({ path: path.join(OUT, 'v3_assets_characters.png') });
  await pg.type('.asbar .asq', LEAD.name.toLowerCase()); await wait(150);
  const search = await pg.evaluate(() => ({ shown: document.querySelectorAll('.pgwrap[data-page=assets] .cgrid > .card:not(.nomatch)').length, hidden: document.querySelectorAll('.pgwrap[data-page=assets] .cgrid > .card.nomatch').length, label: document.querySelector('.asbar .asn').textContent }));
  await pg.evaluate(() => { const q = document.querySelector('.asbar .asq'); q.value = ''; q.dispatchEvent(new Event('input')); }); await wait(100);
  await pg.evaluate((id) => document.querySelector(`[data-open="${id}"]`).click(), LEAD.id); await frames();
  const charPage = await pg.evaluate(() => ({ inAssets: !!document.querySelector('.pgwrap[data-page=assets] .lib.page .pbar'), active: window.WB.app.active(), view: window.WB.app.view() }));
  await pg.evaluate(() => document.querySelector('[data-back]').click()); await frames();
  check('assets page: sub-nav, search, character page inside', JSON.stringify(subs) === '["Characters","Locations","Props","Media","Clips"]' && search.shown >= 1 && (search.hidden >= 1 || !OWNER) && charPage.inAssets && charPage.active === 'assets' && charPage.view === 'characters',
    { subs, search, charPage });
  // Review: Approvals, Queue, Notes, Costs
  await pg.click('#top [data-tab=review]'); await frames();
  await pg.evaluate(() => document.querySelector('.pgwrap[data-page=review] .subnav [data-sub=queue]').click()); await frames(); await wait(200);
  const rsubs = await pg.evaluate(() => [...document.querySelectorAll('.pgwrap[data-page=review] .subnav a')].map(a => a.firstChild.textContent));
  const queueShown = await pg.evaluate(() => !!document.querySelector('.pgwrap[data-page=review] .pane.queue') && document.querySelector('.pgwrap[data-page=review] .pane.queue').offsetParent !== null);
  await pg.screenshot({ path: path.join(OUT, 'v3_review.png') });
  // custom page: Window > New page (Media), close it, Media still opens under Assets
  await pg.evaluate(() => window.WB.app.newPage('media')); await frames(); await wait(200);
  const custom = await pg.evaluate(() => ({ tabs: [...document.querySelectorAll('#top nav [data-tab]')].map(a => a.dataset.tab), cells: document.querySelectorAll('.pgwrap[data-page="p:media"] [data-media]').length }));
  await pg.evaluate(() => window.WB.app.closePage('p:media')); await frames();
  await pg.evaluate(() => window.WB.app.show('media')); await frames();
  const back = await pg.evaluate(() => ({ tabs: [...document.querySelectorAll('#top nav [data-tab]')].length, cells: [...document.querySelectorAll('.pgwrap[data-page=assets] [data-media]')].filter(e => e.offsetParent !== null).length }));
  check('review sub-views + custom page (New page / close)', JSON.stringify(rsubs) === '["Approvals","Queue","Notes","Costs"]' && queueShown && custom.tabs.includes('p:media') && custom.cells >= Math.min(100, MEDIA_N) && back.tabs === 3 && back.cells >= Math.min(100, MEDIA_N), { rsubs, queueShown, custom, afterClose: back });
  await pg.evaluate(() => window.WB.app.show('timeline')); await frames();
  v2.commands = await pg.evaluate(() => window.WB.commands.list().length);
  v2.conflicts = await pg.evaluate(() => window.WB.keymap.conflicts());
  check('no default key conflicts', !v2.conflicts.length, v2.conflicts);
  await pg.close();
  const del = await post('/api/projects/delete', { id: TEST });
  check('test project deleted', del.status === 200 && !fs.existsSync(TD), del.status);
  // the guard on the server's default project, tried on the scratch copy (startServer checked the server's data_dir)
  const refuse = await post('/api/projects/delete', { id: P });
  check('default project protected', refuse.status === 403 && fs.existsSync(path.join(DATA, P, 'song.json')), refuse.status);
  v2.pass = Object.values(v2.checks).every(c => c.pass);
} catch (e) { v2.checks.aborted = blockFailed('v2', e); v2.pass = false; }
// ---------------------------------------------------------------- v2 Part B: preview dock, media index, privacy, characters, "+ New look"
// Runs on a working copy "azemar-testb" (server duplicate endpoint), deleted at the end. Screenshots pb_*.png.
// Only on the owner's production: the checks name its clips (G15, I3), characters (dani) and private refs.
if (OWNER) try {
  const B = BASE, TEST = 'azemar-testb', TD = path.join(DATA, TEST);
  if (fs.existsSync(TD)) await post('/api/projects/delete', { id: TEST });
  report.partB = { checks: {} };
  const pb = report.partB;
  const check = (name, ok, detail) => { pb.checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`partB ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`); };
  const dup = await post('/api/projects/duplicate', { from: 'azemar', to: TEST });
  check('duplicate project', dup.status === 200 && fs.existsSync(path.join(TD, 'song.json')), dup);
  if (!pb.checks['duplicate project'].pass) throw new Error('could not duplicate the project; the part B checks need the copy');
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  pg.on('pageerror', e => console.error('pageerror', e.message));
  pg.on('console', m => { if (m.type() === 'error') console.error('console', m.text()); });
  pg.on('response', r => { if (r.status() >= 400) console.error('http', r.status(), r.url()); });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
  const imgsLoaded = () => pg.evaluate(() => Promise.race([new Promise(r => setTimeout(r, 2500)), Promise.all([...document.images].filter(i => !i.complete && i.getClientRects().length).map(i => new Promise(r => { i.onload = i.onerror = r; })))]));
  const filmReady = () => pg.evaluate(() => new Promise(r => { const v = document.querySelector('.dock video.film'); if (!v) return r(false); const ok = () => v.readyState >= 2 && !v.seeking; if (ok()) return r(true); const t0 = Date.now(); const k = () => ok() || Date.now() - t0 > 8000 ? r(ok()) : setTimeout(k, 50); k(); }));
  await pg.goto(`${B}/?project=${TEST}`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames();

  // 1. media.json: N entries, every thumbnail / strip on disk, the page loaded them all
  const mj = JSON.parse(fs.readFileSync(path.join(TD, 'media.json'), 'utf8'));
  const missing = mj.items.filter(m => !fs.existsSync(path.join(TD, m.thumb)) || (m.strip && !fs.existsSync(path.join(TD, m.strip)))).map(m => m.id);
  const pageN = await pg.evaluate(() => window.WB.store.media.length);
  const privOk = mj.items.every(m => m.private === /^(project\/gen\/refs\/|character-lab\/refs\/|character-lab\/base\/_green_compare)/.test(m.path) && (!m.private || m.thumb.startsWith('thumbs/priv_')));
  check('media.json indexed', mj.items.length >= 200 && !missing.length && pageN === mj.items.length && privOk, { n: mj.items.length, byKind: mj.by_kind, private: mj.items.filter(m => m.private).length, missingThumbs: missing.length, pageN, privateFlagsConsistent: privOk });

  // 2. dock opens / closes (P), Film follows the playhead within one frame (paused seeks and while playing)
  await pg.mouse.move(500, 400);
  await pg.keyboard.press('KeyP'); await frames();
  const opened = await pg.evaluate(() => window.WB.dock.isOpen() && !!document.querySelector('.dock video.film'));
  await pg.keyboard.press('KeyP'); await frames();
  const closed = await pg.evaluate(() => !window.WB.dock.isOpen() && !document.querySelector('.dock'));
  await pg.keyboard.press('KeyP'); await frames();
  check('dock opens and closes with P', opened && closed && await pg.evaluate(() => window.WB.dock.isOpen()), { opened, closed });
  await filmReady();
  const seeks = [];
  for (const t of [61000, 12345, 139840, 200007]) {
    await pg.evaluate((x) => window.WB.timeline.seek(x), t);
    const oneFrame = await pg.evaluate(() => new Promise(r => requestAnimationFrame(() => { const v = document.querySelector('.dock video.film'); r(v.currentTime * 1000); })));
    await filmReady();
    const shown = await pg.evaluate(() => document.querySelector('.dock video.film').currentTime * 1000);
    seeks.push({ t, afterOneFrameMs: +Math.abs(oneFrame - t).toFixed(2), decodedDevMs: +Math.abs(shown - t).toFixed(2) });
  }
  // while playing: sample |video - playhead| every 100 ms for 2 s
  await pg.evaluate(() => { window.WB.timeline.seek(30000); window.WB.timeline.player.play(); });
  await wait(800);
  const drift = await pg.evaluate(() => new Promise(r => { const out = []; let n = 0; const k = () => { const v = document.querySelector('.dock video.film'), p = window.WB.timeline.player; if (p.playing && !v.seeking) out.push(Math.abs(v.currentTime * 1000 - p.time())); if (++n < 20) setTimeout(k, 100); else r(out); }; k(); }));
  const playing = await pg.evaluate(() => window.WB.timeline.player.playing);
  await pg.evaluate(() => window.WB.timeline.player.pause());
  drift.sort((a, b) => a - b);
  const FRAME = 1000 / 30;
  const playInfo = { playing, samples: drift.length, medianMs: drift.length ? +drift[drift.length >> 1].toFixed(1) : null, maxMs: drift.length ? +drift[drift.length - 1].toFixed(1) : null };
  check('film follows the playhead within one frame', seeks.every(s => s.afterOneFrameMs <= FRAME && s.decodedDevMs <= FRAME) && (!playing || playInfo.medianMs <= FRAME), { frameMs: +FRAME.toFixed(1), seeks, playback: playInfo });
  await pg.evaluate(() => { const tl = window.WB.timeline; tl.seek(61000); tl.scrollToTime(61000); tl.drawLanes(); }); await filmReady(); await imgsLoaded();
  await pg.screenshot({ path: path.join(OUT, 'pb_dock_film.png') });

  // 3. hover preview: hover a clip cell -> the clip at its in-point after the delay; leave -> back to Film
  const cell = await pg.evaluate(() => { const e = [...document.querySelectorAll('.col-clips .use')].find(x => { const r = x.getBoundingClientRect(); return r.top > 60 && r.bottom < innerHeight - 280 && r.height > 12; }); e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(8, r.height / 2), id: e.dataset.sel }; });
  await pg.mouse.move(cell.x, cell.y); await wait(450);
  const hov = await pg.evaluate(() => ({ cur: window.WB.dock.current(), mode: window.WB.dock.mode(), video: document.querySelector('.dock .db video')?.getAttribute('src') }));
  await pg.mouse.move(1000, 120); await wait(450);
  const back = await pg.evaluate(() => window.WB.dock.mode());
  check('hover preview appears and returns to Film', hov.cur.kind === 'use' && 'use:' + hov.cur.id === cell.id && hov.mode === 'hover' && /G\d\d_\d\.mp4/.test(decodeURIComponent(hov.video || '')) && back === 'film', { cell: cell.id, shown: hov.cur, mode: hov.mode, afterLeave: back });

  // 4. take comparison side by side (Compare takes on a clip)
  await pg.evaluate(() => window.WB.commands.run('media.compare', { use: window.WB.store.uses.find(u => u.clip === 'G15') }));
  await wait(1500);
  const cmp = await pg.evaluate(() => ({ cells: document.querySelectorAll('.dock .cmp .ct').length, inUse: document.querySelectorAll('.dock .cmp .ct.on').length, pinned: window.WB.dock.pinned }));
  await pg.evaluate(() => { const d = window.WB.dock; d.geo.w = 760; d.geo.h = 200; d.applyGeo(); }); await wait(1200);
  await pg.screenshot({ path: path.join(OUT, 'pb_take_compare.png') });
  check('take comparison side by side', cmp.cells === 3 && cmp.inUse >= 1 && cmp.pinned, cmp);
  await pg.evaluate(() => { const d = window.WB.dock; d.geo.w = 400; d.geo.h = 250; d.applyGeo(); d.film(); });

  // 5. dock geometry: drag to the top-left corner, remembered across reload
  const head = await pg.evaluate(() => { const r = document.querySelector('.dock .dt').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 8 }; });
  await pg.mouse.move(head.x, head.y); await pg.mouse.down(); await pg.mouse.move(200, 150, { steps: 6 }); await pg.mouse.up(); await frames();
  const corner = await pg.evaluate(() => window.WB.dock.el.dataset.corner);
  await pg.reload({ waitUntil: 'domcontentloaded' }); await pg.waitForFunction('document.body.dataset.ready === "1"'); await frames();
  const after = await pg.evaluate(() => ({ open: window.WB.dock.isOpen(), corner: window.WB.dock.el?.dataset.corner }));
  check('dock drags to a corner and remembers it', corner === 'tl' && after.open && after.corner === 'tl', { dragged: corner, afterReload: after });
  await pg.evaluate(() => window.WB.dock.setCorner('br'));

  // 6. pop-out window stays synced (BroadcastChannel)
  const popP = new Promise(r => browser.once('targetcreated', r));
  await pg.evaluate(() => window.WB.dock.popout());
  const popT = await popP; const pop = await popT.page();
  await pop.waitForFunction('document.body.dataset.ready === "1"', { timeout: 20000 });
  await wait(600);
  await pg.evaluate(() => window.WB.timeline.seek(95000)); await wait(700);
  const popTime = await pop.evaluate(() => new Promise(r => { const v = document.querySelector('.dock video.film'); const k = () => v.seeking ? setTimeout(k, 50) : r(v.currentTime * 1000); k(); }));
  await pg.evaluate(() => window.WB.dock.show({ kind: 'entity', id: 'dani' })); await wait(400);
  const popSrc = await pop.evaluate(() => window.WB.dock.current());
  await pop.close(); await wait(500);
  const backIn = await pg.evaluate(() => window.WB.dock.isOpen());
  check('pop-out window stays synced', Math.abs(popTime - 95000) <= 1000 / 30 && popSrc?.kind === 'entity' && backIn, { popFilmMs: Math.round(popTime), popSource: popSrc, dockBackAfterClose: backIn });
  await pg.evaluate(() => window.WB.dock.film());

  // 7. no private file in any export path (bundle incl. a request that referenced a private crop; CSV; storyboard)
  await pg.evaluate(() => window.WB.requests.create({ kind: 'generate', target: 'character:dani', prompt: 'verify private ref', refs: ['project/gen/refs/dani_face.png', 'character-lab/base/dani_base_front.png'], est_cost: 0 }));
  const exp = await pg.evaluate(() => {
    const ex = window.WB.exporter, out = {};
    let captured = []; const orig = window.open; window.open = () => ({ document: { write: (h) => captured.push(h), close() {} } });
    const a = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { captured.push(this.download); };
    const blobs = []; const ob = window.Blob; window.Blob = function (parts, o) { blobs.push(parts.join('')); return new ob(parts, o); };
    ex.bundle(); ex.shotList(); ex.storyboard();
    window.open = orig; HTMLAnchorElement.prototype.click = a; window.Blob = ob;
    const all = blobs.join('\n') + captured.join('\n');
    const re = /project\/gen\/refs\/|character-lab\/refs\/|_green_compare|thumbs\/priv_/g;
    return { bytes: all.length, privateHits: (all.match(re) || []).length, bundleHasMedia: blobs.some(b => b.includes('"media"')), nonPrivateRefKept: all.includes('character-lab/base/dani_base_front.png') };
  });
  const remote = await fetch(`${B}/media/project/gen/refs/dani_face.png`).then(r => r.status);
  check('no private file in any export path', exp.privateHits === 0 && exp.bytes > 10000 && exp.nonPrivateRefKept && remote === 200, { ...exp, localServes: remote });

  // 8. screenshots: Media tab, Characters grid, Locations; "+ New look" creates a draft request with an estimate
  await pg.evaluate(() => window.WB.app.show('media')); await frames(); await imgsLoaded();
  const mediaCells = await pg.evaluate(() => document.querySelectorAll('.media [data-media]').length);
  const v = await pg.evaluate(() => { const e = document.querySelector('.media .mc[data-strip]'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
  await pg.mouse.move(v.x + v.w * 0.8, v.y); await wait(300);
  const scrub = await pg.evaluate(() => { const e = document.querySelector('.media .mc[data-frame]'); return e ? Number(e.dataset.frame) : -1; });
  await pg.evaluate(() => document.querySelector('.pane.media').scrollTop = 0); await wait(200);
  await pg.screenshot({ path: path.join(OUT, 'pb_media.png') });
  check('media tab grid + hover scrub', mediaCells === mj.items.length && scrub >= 5, { cells: mediaCells, scrubFrameAt80pct: scrub });
  await pg.mouse.move(5, 300);
  await pg.evaluate(() => window.WB.app.show('characters')); await frames(); await imgsLoaded();
  await pg.screenshot({ path: path.join(OUT, 'pb_characters_grid.png') });
  // cast chip: Swap costume lists the character's looks
  await pg.evaluate(() => window.WB.app.show('timeline')); await frames();
  const chipPt = await pg.evaluate(() => { const e = [...document.querySelectorAll('.col-cast .cast[data-id=dani]')].find(x => { const r = x.getBoundingClientRect(); return r.top > 60 && r.bottom < innerHeight - 40; }); const r = e.getBoundingClientRect(); return { x: r.left + 3, y: r.top + 4 }; });
  await pg.mouse.click(chipPt.x, chipPt.y, { button: 'right' }); await wait(80);
  const sw = await pg.evaluate(() => { const r = [...document.querySelectorAll('.pop .pi')].find(x => x.textContent.includes('Swap costume')).getBoundingClientRect(); return { x: r.left + 40, y: r.top + 10 }; });
  await pg.mouse.move(sw.x, sw.y); await wait(250);
  const looks = await pg.evaluate(() => { const p = document.querySelectorAll('.pop'); return p.length > 1 ? [...p[1].querySelectorAll('.lb')].map(x => x.textContent.trim()) : []; });
  await pg.keyboard.press('Escape'); await pg.keyboard.press('Escape');
  check('swap costume lists the looks', looks.includes('Office day (base look)') && looks.includes('Sleep t-shirt') && looks.length >= 10, { looks });
  await pg.evaluate(() => window.WB.app.show('characters')); await frames();
  await pg.evaluate(() => document.querySelector('[data-open=dani]').click()); await frames(); await imgsLoaded();
  await pg.screenshot({ path: path.join(OUT, 'pb_dani_page.png') });
  await pg.evaluate(() => document.querySelector('.lgrid [data-newlook=dani]').click()); await frames();
  await pg.type('.lookform [name=name]', 'Rainy commute');
  await pg.type('.lookform [name=garments]', 'yellow raincoat, grey beanie, dark jeans, white sneakers');
  await pg.evaluate(() => { const c = document.querySelector('.lookform [name=col]'); c.value = '#f2c230'; c.dispatchEvent(new Event('change', { bubbles: true })); });
  await pg.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/wb-media', 'project/gen/out/I3/I3_0_0.png'); document.querySelector('.lookform .refs').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt })); });
  await pg.type('.lookform [name=notes]', 'walks in wet at 8 a.m. (verse 2 doors)'); await wait(300);
  await pg.screenshot({ path: path.join(OUT, 'pb_new_look_form.png') });
  const est = await pg.evaluate(() => document.querySelector('.lookform .est').textContent);
  await pg.click('.lookform [data-x=ok]'); await wait(700);
  const reqs = JSON.parse(fs.readFileSync(path.join(TD, 'requests.json'), 'utf8')).items;
  const r = reqs.find(x => x.kind === 'new-costume' && x.look?.name === 'Rainy commute');
  const card = await pg.evaluate(() => [...document.querySelectorAll('.lc.req')].some(x => x.textContent.includes('Rainy commute')));
  check('"+ New look" creates a draft request with a cost estimate', r && r.status === 'draft' && r.target === 'character:dani' && r.est_cost > 0 && r.refs.includes('project/gen/out/I3/I3_0_0.png') && r.look.colors.includes('#f2c230') && card,
    r ? { id: r.id, est_cost: r.est_cost, estShown: est, refs: r.refs.length, garments: r.look.garments, shownAsCard: card } : { reqs: reqs.length });
  await pg.evaluate(() => window.WB.app.show('locations')); await frames(); await imgsLoaded();
  await pg.screenshot({ path: path.join(OUT, 'pb_locations.png') });
  await pg.close();
  const del = await post('/api/projects/delete', { id: TEST });
  check('test project deleted', del.status === 200 && !fs.existsSync(TD), del.status);
  pb.pass = Object.values(pb.checks).every(c => c.pass);
} catch (e) { report.partB = { ...report.partB, checks: { ...report.partB?.checks, aborted: blockFailed('part B', e) }, pass: false }; }
// ---------------------------------------------------------------- v4: the guided flow (docs/SPEC_v3_GUIDED.md, phase 1)
// The stage rail, the new-project wizard (a lyrics-only project created in the scratch data folder, then the demo song
// added to it), the lyrics stage (inline editing, a note on a word range, an agent note live, versions, a word diff,
// restore) and the stage status rules (the page marks done, the agent surface cannot). Screenshots v4_*.png.
const v4 = report.v4 = { checks: {} };
try {
  const check = (name, ok, detail) => { v4.checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v4 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`); };
  const NEW = 'wizard-verify', ND = path.join(DATA, NEW);
  if (fs.existsSync(ND)) await post('/api/projects/delete', { id: NEW });
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1500, height: 850, deviceScaleFactor: 1 });
  pg.on('pageerror', e => console.error('pageerror', e.message));
  pg.on('console', m => { if (m.type() === 'error') console.error('console', m.text()); });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
  const ready = async () => { await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(); };
  const combo = async (mods, key) => { for (const m of mods) await pg.keyboard.down(m); await pg.keyboard.press(key); for (const m of mods.slice().reverse()) await pg.keyboard.up(m); };
  const until = async (fn, arg, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
  const readJ = (p, f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, p, f), 'utf8')); } catch (e) { return null; } };
  await pg.goto(`${BASE}/?project=${encodeURIComponent(P)}`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();

  // 1. the rail: 7 stages in one 18 px row right under the top bar, a status dot each, the next-stage hint; hidden with the bar
  const rail = await pg.evaluate(() => { const r = document.getElementById('rail'), b = r.getBoundingClientRect(), t = document.getElementById('top').getBoundingClientRect();
    return { stages: [...r.querySelectorAll('a[data-stage]')].map(a => a.textContent.trim()), dots: r.querySelectorAll('a[data-stage] i').length, h: Math.round(b.height), underTop: Math.round(b.top) === Math.round(t.bottom), next: r.querySelector('.next')?.textContent || '' }; });
  await pg.screenshot({ path: path.join(OUT, 'v4_rail.png') });
  await pg.screenshot({ path: path.join(OUT, 'v4_rail_strip.png'), clip: { x: 0, y: 0, width: 1500, height: 40 } });
  await pg.mouse.move(700, 450); await pg.keyboard.press('Backquote'); await frames(2);
  const hidden = await pg.evaluate(() => getComputedStyle(document.getElementById('rail')).display === 'none');
  await pg.keyboard.press('Backquote'); await frames(2);
  const back = await pg.evaluate(() => getComputedStyle(document.getElementById('rail')).display !== 'none');
  check('rail: 7 stages with dots, 18 px under the top bar, next hint, hidden with the bar', rail.stages.length === 7 && rail.stages[0] === '1 Lyrics' && rail.stages[6] === '7 Final' && rail.dots === 7 && rail.h === 18 && rail.underTop && /next|all stages/.test(rail.next) && hidden && back, { ...rail, hiddenWithBar: hidden, back });
  // keys, palette, context menu
  await combo(['Alt', 'Shift'], 'Digit1'); await frames(2);
  const k1 = await pg.evaluate(() => ({ page: window.WB.app.active(), stage: window.WB.stages.current(), on: document.querySelector('#rail a.on')?.dataset.stage }));
  await combo(['Control'], 'KeyK'); await pg.keyboard.type('go to stage: script'); await wait(80);
  const palFirst = await pg.evaluate(() => document.querySelector('.pal .pr.hl .lb')?.textContent);
  await pg.keyboard.press('Enter'); await frames(2);
  const k2 = await pg.evaluate(() => window.WB.stages.current());
  const rc = await pg.evaluate(() => { const r = document.querySelector('#rail a[data-stage=lyrics]').getBoundingClientRect(); return { x: r.left + 10, y: r.top + 8 }; });
  await pg.mouse.click(rc.x, rc.y, { button: 'right' }); await wait(80);
  const rmenu = await pg.evaluate(() => [...document.querySelectorAll('.pop .pi .lb')].map(x => x.childNodes[0]?.textContent.trim()));
  await pg.keyboard.press('Escape');
  check('rail commands: Alt+Shift+1, palette "Go to stage: Script", right-click menu', k1.page === 'stage' && k1.stage === 'lyrics' && k1.on === 'lyrics' && palFirst === 'Go to stage: Script' && k2 === 'script' && rmenu.includes('Open Lyrics') && rmenu.includes('Go to stage'),
    { altShift1: k1, palFirst, afterPalette: k2, menu: rmenu });

  // 2. the wizard (File > New project): name -> lyrics -> song (skipped) -> create, in the scratch data folder
  await pg.evaluate(() => window.WB.commands.run('file.new')); await wait(100);
  await pg.type('.wiz [name=title]', 'Wizard Verify'); await wait(50);
  await pg.screenshot({ path: path.join(OUT, 'v4_wizard_1_name.png') });
  const autoId = await pg.evaluate(() => document.querySelector('.wiz [name=id]').value);
  await pg.click('.wiz [data-w=next]'); await wait(80);
  const POEM = '[Verse 1]\nThe night bus hums along the coast\nI count the lights I loved the most\n\n[Chorus]\nRide, ride, the window glows\nRide, ride, nobody knows';
  await pg.type('.wiz [name=lyrics]', POEM); await wait(50);
  await pg.screenshot({ path: path.join(OUT, 'v4_wizard_2_lyrics.png') });
  const count = await pg.evaluate(() => document.querySelector('.wizcount').textContent);
  await pg.click('.wiz [data-w=next]'); await wait(80);
  await pg.screenshot({ path: path.join(OUT, 'v4_wizard_3_song.png') });
  await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded' }), pg.click('.wiz [data-w=create]')]); await ready(); await wait(300);
  const wiz = { autoId, count, url: new URL(pg.url()).searchParams.get('project'), page: await pg.evaluate(() => window.WB.app.active() + '/' + window.WB.stages.current()) };
  const L1 = readJ(NEW, 'lyrics.json'), S1 = readJ(NEW, 'song.json'), ST1 = readJ(NEW, 'stages.json');
  check('wizard: a lyrics-only project (lyrics.json v1, estimated timings, placeholder length, lyrics stage in progress), opened on the lyrics stage',
    autoId === NEW && /4 lines in 2 sections/.test(count) && wiz.url === NEW && wiz.page === 'stage/lyrics' && L1?.versions?.length === 1 && L1.current === 'v1' && L1.versions[0].via === 'page'
    && S1?.audio?.mix === null && S1.placeholder_duration === true && S1.lines.length === 4 && S1.lines.every(l => l.timing === 'estimated' && l.id.startsWith('L')) && S1.sections.map(s => s.label).join() === 'Verse 1,Chorus'
    && ST1?.stages?.find(s => s.id === 'lyrics')?.status === 'in_progress',
    { ...wiz, versions: L1?.versions?.length, mix: S1?.audio?.mix, duration: S1?.duration_ms, lines: S1?.lines?.map(l => [l.id, l.t0, l.timing]), lyricsStage: ST1?.stages?.[0] });
  await pg.screenshot({ path: path.join(OUT, 'v4_lyrics_new_project.png') });

  // 3. add the song later (Lyrics > Add song…): the lines get timed over the real song
  const SONG = path.join(WB, 'data', 'demo', 'audio', 'demo-song.mp3');
  if (fs.existsSync(SONG)) {
    await pg.evaluate(() => document.querySelector('.lysong [data-a=song]').click()); await wait(100);
    await pg.keyboard.type(SONG); await pg.keyboard.press('Enter');
    const timed = await until(() => !!window.WB.store.song.audio?.mix && window.WB.store.song.duration_ms === 20000, null, 30000);
    const S2 = readJ(NEW, 'song.json');
    check('add the song later: audio + peaks, real duration, lines re-timed inside the song', timed && S2.audio.mix === 'audio/demo-song.mp3' && fs.existsSync(path.join(ND, 'peaks', 'mix.json')) && !S2.placeholder_duration
      && S2.lines.length === 4 && S2.lines.every(l => l.t0 >= 0 && l.t1 <= 20000 && l.t0 < l.t1) && S2.lines.map(l => l.id).join() === S1.lines.map(l => l.id).join(),
      { timed, mix: S2.audio?.mix, duration: S2.duration_ms, lines: S2.lines.map(l => [l.id, l.t0, l.t1]) });
  } else check('add the song later: skipped (no data/demo/audio/demo-song.mp3)', true);

  // 4. inline editing: reword a line (double-click), add a line below (Shift+Enter), save a version (Ctrl+Enter)
  await pg.evaluate(() => window.WB.stages.open('lyrics')); await wait(150);
  await pg.evaluate(() => document.querySelector('.lyl[data-line="L2"] .lytx').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await wait(60);
  await combo(['Control'], 'KeyA'); await pg.keyboard.type('I count the lights I lost the most');
  await combo(['Shift'], 'Enter'); await wait(60); await pg.keyboard.type('and every stop is somewhere close'); await pg.keyboard.press('Enter'); await wait(100);
  const unsaved = await pg.evaluate(() => ({ bar: !!document.querySelector('.lybar .unsaved'), changed: document.querySelectorAll('.lyl.chg').length }));
  await pg.screenshot({ path: path.join(OUT, 'v4_lyrics_unsaved.png') });
  await pg.type('.lybar .lymsg', 'verify: lost, and a new line');
  await combo(['Control'], 'Enter');
  await until(() => window.WB.store.lyrics.current === 'v2' && window.WB.store.song.lines.length === 5, null, 6000);
  const L2 = readJ(NEW, 'lyrics.json'), S3 = readJ(NEW, 'song.json');
  const l2 = S3.lines.find(l => l.id === 'L2'), lNew = S3.lines.find(l => l.text === 'and every stop is somewhere close');
  check('inline edit + new line + save -> version v2; song.json lines follow (reworded keeps its id and timing, new one estimated)', unsaved.bar && unsaved.changed === 2 && L2.current === 'v2' && L2.versions[1].message === 'verify: lost, and a new line'
    && L2.versions[1].via === 'page' && l2?.text === 'I count the lights I lost the most' && lNew?.timing === 'estimated' && lNew.t0 > l2.t0 && S3.lines.length === 5,
    { unsaved, current: L2.current, message: L2.versions[1]?.message, L2: l2 && [l2.t0, l2.t1, l2.text], newLine: lNew && [lNew.id, lNew.t0, lNew.timing] });

  // 5. the Notes column (notes.json v2): select words -> "+ note" types a note on that word range in the line's cell
  // (director / page); an agent note arrives live on its line; a reply; an ask for the agent ("Ask the agent": → agent)
  await pg.evaluate(() => { const ws = document.querySelectorAll('.lyl[data-line="L1"] .w'); const r = document.createRange(); r.setStart(ws[1].firstChild, 0); r.setEnd(ws[2].firstChild, ws[2].textContent.length); getSelection().removeAllRanges(); getSelection().addRange(r); document.querySelector('.lyws').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await wait(60);
  const fab = await pg.evaluate(() => getComputedStyle(document.querySelector('.lyfab')).display !== 'none');
  await pg.click('.lyfab'); await wait(120);
  const edOn = await pg.evaluate(() => ({ focus: document.activeElement?.matches('.nclayer .nced'), on: document.querySelector('.nclayer .ncedh')?.textContent || '' }));
  await pg.keyboard.type('verify: "night bus" is the title; keep it'); await pg.keyboard.press('Enter');
  await until(() => window.WB.store.notes.notes.some(n => n.target.stage === 'lyrics'));
  const H = await writeHeaders(BASE, NEW);
  const agentNote = await post(`/api/op/lyrics_note_add?project=${NEW}`, { line: 'L4', quote: 'nobody knows', text: 'verify agent: rhyme with "glows" is weak?' }, BASE, H);
  const live = await until(() => !!document.querySelector('.lypoem .nclayer .ncn.ag'));
  const n1id = await pg.evaluate(() => window.WB.store.notes.notes.find(n => n.target.stage === 'lyrics' && n.target.id === 'L1')?.id);
  await pg.evaluate((id) => document.querySelector(`.nclayer .ncn[data-nid="${id}"] [data-nc=reply]`).click(), n1id); await wait(80);
  await pg.keyboard.type('verify reply'); await pg.keyboard.press('Enter');
  await until((id) => window.WB.store.notes.notes.find(n => n.id === id)?.replies?.length === 1, n1id);
  await pg.evaluate(() => window.WB.commands.run('lyrics.ask')); await wait(100);
  await pg.keyboard.type('verify: can you suggest a bridge?'); await pg.keyboard.press('Enter');
  await until(() => window.WB.store.notes.notes.some(n => n.to === 'agent'));
  await pg.evaluate(() => window.WB.app.show('timeline')); await pg.evaluate(() => window.WB.stages.open('lyrics')); await wait(350);
  await pg.screenshot({ path: path.join(OUT, 'v4_lyrics_notes.png') });
  const NT = readJ(NEW, 'notes.json'), n1 = NT.notes.find(n => n.id === n1id), ask = NT.notes.find(n => n.to === 'agent');
  const marked = await pg.evaluate(() => [...document.querySelectorAll('.lyl[data-line="L1"] .w.nw')].map(w => w.textContent));
  const aligned = await pg.evaluate((id) => { const c = document.querySelector(`.nclayer .ncn[data-nid="${id}"]`)?.closest('.nccell'), l = document.querySelector('.lyl[data-line="L1"]'); if (!c || !l) return null; return Math.abs(c.getBoundingClientRect().top - l.getBoundingClientRect().top); }, n1id);
  const asks = (await post(`/api/op/lyrics_get?project=${NEW}`, {}, BASE, H)).body?.asks_for_agent || [];
  check('Notes column: a note on a word range typed in the line\'s cell (notes.json v2, director / page, row-aligned), an agent note live on its line, a reply, an ask for the agent', fab && edOn.focus && /night bus/.test(edOn.on) && n1?.target?.id === 'L1' && JSON.stringify(n1.target.w) === '[1,2]' && n1.target.quote === 'night bus' && n1.by === 'director' && n1.via === 'page'
    && n1.replies?.[0]?.via === 'page' && agentNote.status === 200 && agentNote.body.via === 'agent' && live && JSON.stringify(marked) === '["night","bus"]' && aligned !== null && aligned < 1.5 && ask?.via === 'page' && asks.some(a => a.text === 'verify: can you suggest a bridge?') && !readJ(NEW, 'lyrics.json').notes.length,
    { fab, edOn, note: n1 && { target: n1.target, by: n1.by, via: n1.via, replies: n1.replies?.length, replyVia: n1.replies?.[0]?.via }, agent: agentNote.body?.via, live, marked, aligned, asks: asks.map(a => a.text), ask: ask && [ask.via, ask.text], oldList: readJ(NEW, 'lyrics.json')?.notes?.length });
  await pg.evaluate((id) => document.querySelector(`.nclayer .ncn[data-nid="${id}"] [data-nc=done]`).click(), agentNote.body?.id);
  await until((id) => window.WB.store.notes.notes.find(n => n.id === id)?.status === 'absorbed', agentNote.body?.id);

  // 6. versions: the list, a side-by-side word diff of v1 -> v2, restore v1 as v3
  await pg.evaluate(() => document.querySelector('.lybar [data-a=versions]').click()); await wait(80);
  await pg.evaluate(() => { document.querySelector('.lyv[data-v=v1] [data-ab=a]').click(); document.querySelector('.lyv[data-v=v2] [data-ab=b]').click(); document.querySelector('.lyvh [data-a=ab]').click(); }); await wait(150);
  const diff = await pg.evaluate(() => ({ del: [...document.querySelectorAll('.lydl .del')].map(x => x.textContent), add: [...document.querySelectorAll('.lydr .add')].map(x => x.textContent), cols: document.querySelectorAll('.lydc > div').length, head: document.querySelector('.lydh')?.textContent }));
  await pg.screenshot({ path: path.join(OUT, 'v4_lyrics_diff.png') });
  await pg.evaluate(() => document.querySelector('.lydh [data-a=restore][data-v=v1]').click());
  await until(() => window.WB.store.lyrics.current === 'v3' && window.WB.store.lyrics.rev > 0 && window.WB.store.song.lines.length === 4);
  const L4 = readJ(NEW, 'lyrics.json'), S4 = readJ(NEW, 'song.json');
  check('versions: side-by-side word diff v1 -> v2, restore v1 as a new version v3 (song lines follow)', diff.cols === 2 && diff.del.join(' ') === 'loved' && diff.add.join(' ') === 'lost and every stop is somewhere close'
    && L4.current === 'v3' && L4.versions.length === 3 && L4.versions[2].from === 'v1' && JSON.stringify(L4.versions[2].sections) === JSON.stringify(L4.versions[0].sections) && S4.lines.length === 4 && S4.lines.find(l => l.id === 'L2').text === 'I count the lights I loved the most',
    { diff, current: L4.current, from: L4.versions[2]?.from, lines: S4.lines.length });

  // 7. stage status: the page marks done (stamped director / page); the agent surface cannot, nor move a done stage
  await pg.evaluate(() => document.querySelector('.sgbar [data-st=done]').click());
  await until(() => window.WB.stages.view().stages[0].status === 'done');
  // the page shows its change at once (optimistic); wait for the file too
  for (let i = 0; i < 40 && readJ(NEW, 'stages.json')?.stages?.find(s => s.id === 'lyrics')?.status !== 'done'; i++) await wait(100);
  const ST2 = readJ(NEW, 'stages.json'), lyr = ST2.stages.find(s => s.id === 'lyrics');
  const agentDone = await post(`/api/op/stage_update?project=${NEW}`, { stage: 'script', status: 'done' }, BASE, H);
  const agentMove = await post(`/api/op/stage_update?project=${NEW}`, { stage: 'lyrics', status: 'in_progress' }, BASE, H);
  const agentOk = await post(`/api/op/stage_update?project=${NEW}`, { stage: 'script', status: 'needs_you', blockers: ['verify: intake answers missing'] }, BASE, H);
  // ROADMAP_v4 F1: the ask for the agent is still open, so lyrics marked done reads "done ⚠ not ready" until the agent answers it
  const notReady = await until(() => document.querySelector('#rail a[data-stage=lyrics]')?.classList.contains('st-changed') && /open ask/.test(document.querySelector('#rail a[data-stage=lyrics]')?.title || ''));
  const resolved = await post(`/api/op/lyrics_note_resolve?project=${NEW}`, { id: ask.id, reply: 'verify agent: a bridge idea in the notes' }, BASE, H);
  const railAfter = notReady && resolved.status === 200 && await until(() => document.querySelector('#rail a[data-stage=script]')?.classList.contains('st-needs_you') && document.querySelector('#rail a[data-stage=lyrics]')?.classList.contains('st-done'));
  await pg.screenshot({ path: path.join(OUT, 'v4_rail_after.png'), clip: { x: 0, y: 0, width: 1500, height: 60 } });
  check('stage status: the page marks done (director, via page); the agent cannot mark done or move a done stage; needs_you + blockers show on the rail',
    lyr.status === 'done' && lyr.done_by === 'director' && lyr.via === 'page' && lyr.done_ok === false && agentDone.status === 403 && agentMove.status === 409 && agentOk.status === 200 && railAfter,
    { lyrics: lyr, agentDone: agentDone.status, agentMove: agentMove.status, agentOk: agentOk.status, railAfter });
  // 8. an empty project opens the wizard on its lyrics step ("Start" fills the open project, no new folder)
  const EMPTY = 'empty-verify';
  await post('/api/projects/new', { id: EMPTY });
  await pg.goto(`${BASE}/?project=${EMPTY}`, { waitUntil: 'domcontentloaded' }); await ready(); await wait(200);
  const ew = await pg.evaluate(() => ({ open: !!document.querySelector('.wiz'), step: document.querySelector('.wizh span.on')?.textContent, title: document.querySelector('.wizh b')?.textContent }));
  await pg.type('.wiz [name=lyrics]', '[Intro]\nonly one line for now');
  await pg.click('.wiz [data-w=next]'); await wait(60); await pg.click('.wiz [data-w=create]');
  await until(() => !document.querySelector('.wiz') && window.WB.app.active() === 'stage' && window.WB.store.song.lines.length === 1);
  const EL = readJ(EMPTY, 'lyrics.json'), ES = readJ(EMPTY, 'song.json');
  await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
  const again = await pg.evaluate(() => !!document.querySelector('.wiz'));
  check('an empty project opens the wizard on the lyrics step; Start fills this project (v1, estimated line); not shown again', ew.open && /Lyrics/.test(ew.step || '') && /Start/.test(ew.title || '') && EL?.current === 'v1' && ES?.lines?.length === 1 && ES.lines[0].timing === 'estimated' && !again,
    { wizard: ew, lyrics: EL?.current, lines: ES?.lines?.length, shownAgain: again });
  await pg.close();
  await post('/api/projects/delete', { id: EMPTY });
  const del = await post('/api/projects/delete', { id: NEW });
  check('wizard project deleted', del.status === 200 && !fs.existsSync(ND), del.status);
  v4.pass = Object.values(v4.checks).every(c => c.pass);
} catch (e) { v4.checks.aborted = blockFailed('v4', e); v4.pass = false; }
// ---------------------------------------------------------------- v5: the guided flow, phase 2 (stage 2: the script draft)
// On the scratch copy of the project (its script.json read as v1) and on a new lyrics-only project: the intake (page
// and agent answers), scenes next to the lyric lines, "+ scene", editing (title, text, beats), save as a version, "Fill
// the gaps" and the agent filling them live, a sketch drawn inline and saved (files + media), copy / paste of a sketch
// to another scene, scene notes, a version compare, the timeline Scenes column (aligned), the status rules.
// Screenshots v5_*.png.
const v5 = report.v5 = { checks: {} };
try {
  const check = (name, ok, detail) => { v5.checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v5 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`); };
  const NP = 'script-verify', ND = path.join(DATA, NP);
  if (fs.existsSync(ND)) await post('/api/projects/delete', { id: NP });
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1500, height: 850, deviceScaleFactor: 1 });
  pg.on('pageerror', e => console.error('pageerror', e.message));
  pg.on('console', m => { if (m.type() === 'error') console.error('console', m.text()); });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
  const ready = async () => { await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(); };
  const combo = async (mods, key) => { for (const m of mods) await pg.keyboard.down(m); await pg.keyboard.press(key); for (const m of mods.slice().reverse()) await pg.keyboard.up(m); };
  const until = async (fn, arg, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
  const readJ = (p, f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, p, f), 'utf8')); } catch (e) { return null; } };
  // the page applies its own change at once (optimistic) and saves after: wait for the file before reading it
  const fileUntil = async (p, f, fn, ms = 5000) => { const t0 = Date.now(); let j = null; while (Date.now() - t0 < ms) { j = readJ(p, f); try { if (j && fn(j)) return j; } catch (e) { /* not there yet */ } await wait(100); } return j; };

  // 1. the project's own script (script.json) opens as v1 in the script stage: scenes next to their lyric lines
  await pg.goto(`${BASE}/?project=${encodeURIComponent(P)}`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
  await combo(['Alt', 'Shift'], 'Digit2'); await wait(500);
  const own = await pg.evaluate(() => ({ stage: window.WB.stages.current(), rows: document.querySelectorAll('.scws .scrow[data-scene]').length, gaps: document.querySelectorAll('.scws .scrow.gap').length,
    lines: document.querySelectorAll('.scws .scrow[data-scene] .scl').length, scenes: window.WB.store.scenes?.versions?.[0]?.scenes?.length || 0, derived: !!window.WB.store.scenes?.derived }));
  await pg.screenshot({ path: path.join(OUT, 'v5_script_stage.png') });
  check('script stage (Alt+Shift+2): the project\'s script.json reads as v1, each scene next to its lyric lines', own.stage === 'script' && own.rows === own.scenes && (own.scenes > 0 || !J('script.json').lines?.length) && own.lines >= own.rows && !fs.existsSync(path.join(DATA, P, 'scenes.json')), own);

  // 2. a new lyrics-only project: an empty script, the whole song is one gap; the intake
  const POEM = '[Verse 1]\nThe night bus hums along the coast\nI count the lights I loved the most\n\n[Chorus]\nRide, ride, the window glows\nRide, ride, nobody knows';
  const cr = await post('/api/projects/new', { id: NP, title: 'Script Verify', lyrics: POEM });
  const H = await writeHeaders(BASE, NP);
  const op = async (name, body) => post(`/api/op/${name}?project=${NP}`, body, BASE, H);
  await pg.goto(`${BASE}/?project=${NP}`, { waitUntil: 'domcontentloaded' }); await ready();
  await pg.evaluate(() => window.WB.stages.open('script')); await wait(400);
  const empty = await pg.evaluate(() => ({ empty: !!document.querySelector('.scws .scempty'), gaps: document.querySelectorAll('.scws .scrow.gap').length, side: document.querySelector('.scws .lytabs a.on')?.dataset.side, qs: document.querySelectorAll('.scws .scq').length }));
  await pg.evaluate(() => { const ta = document.querySelector('.scq[data-q=mood] textarea'); ta.value = 'verify: night drive, wistful synth-pop'; ta.dispatchEvent(new Event('change', { bubbles: true })); });
  await until(() => window.WB.store.scenes?.intake?.mood?.text === 'verify: night drive, wistful synth-pop');
  const ag = await op('intake_answer', { answers: { kind: 'story' }, by: 'director' }), asked = await op('intake_answer', { key: 'who', asked_in_chat: true });
  await until(() => !!window.WB.store.scenes?.intake?.who?.asked && !!document.querySelector('.scq[data-q=who] .to'));
  await pg.screenshot({ path: path.join(OUT, 'v5_intake.png') });
  const I1 = await fileUntil(NP, 'scenes.json', (j) => j.intake?.mood?.text && j.intake?.who?.asked);
  check('a new project: empty script (the whole song one gap), the intake (9 questions); a page answer is director / page, an agent one via agent, "asked in chat" shows live',
    cr.status === 200 && empty.empty && empty.gaps === 1 && empty.side === 'intake' && empty.qs === 9 && I1?.intake?.mood?.via === 'page' && I1.intake.mood.by === 'director' && I1.intake.kind?.via === 'agent' && ag.status === 200 && asked.status === 200 && !!I1.intake.who?.asked,
    { empty, mood: I1?.intake?.mood, kind: I1?.intake?.kind?.via });

  // 3. + scene, edit title / text / a beat, save a version (Ctrl+Enter)
  await pg.evaluate(() => document.querySelector('.scbar [data-a=addscene]').click()); await wait(200);
  const sc1 = await pg.evaluate(() => { const ws = window.WB.script.ws; const s = ws.draft[0]; return s && { id: s.id, t0: s.t0, t1: s.t1, open: ws.open, focused: document.activeElement?.classList.contains('scin-title') }; });
  await pg.keyboard.type('verify: the bus');
  await pg.evaluate(() => { const ta = document.querySelector('.sccard.open .scin-text'); ta.focus(); });
  await pg.keyboard.type('Night, a bus on the coast road; the singer at the window, lights sliding past.');
  await pg.evaluate(() => document.querySelector('.sccard.open [data-a=addbeat]').click()); await wait(100);
  await pg.keyboard.type('verify: close-up, breath on the glass');
  await pg.evaluate(() => { const i = document.querySelector('.sccard.open .scin-t1'); i.value = '0:13.000'; i.dispatchEvent(new Event('change', { bubbles: true })); }); await wait(100);
  const draftEnd = await pg.evaluate(() => window.WB.script.ws.draft[0].t1);
  await pg.evaluate(() => document.querySelector('.scbar .lymsg')?.focus()); await pg.keyboard.type('verify: first scene');
  await combo(['Control'], 'Enter');
  await until(() => window.WB.store.scenes?.current === 'v1' && !window.WB.script.ws.dirty);
  const V1 = await fileUntil(NP, 'scenes.json', (j) => j.current === 'v1'), s1 = V1?.versions?.[0]?.scenes?.[0];
  const song = readJ(NP, 'song.json'), snapped = [song.lines.flatMap(l => [l.t0, l.t1]), song.sections.flatMap(s => [s.t0, s.t1]), [0, song.duration_ms]].flat().includes(s1?.t1);
  check('+ scene opens a new scene in the first gap (title focused); title, text, a beat, from/to snapped to lines; Ctrl+Enter saves v1 (director / page)',
    sc1?.id === 'sc01' && sc1.open === 'sc01' && sc1.focused && V1?.current === 'v1' && V1.versions[0].via === 'page' && V1.versions[0].message === 'verify: first scene' && s1.title === 'verify: the bus' && /coast road/.test(s1.text)
    && s1.beats.length === 1 && s1.beats[0].text === 'verify: close-up, breath on the glass' && snapped && s1.t1 === draftEnd && s1.line_ids.length >= 1,
    { sc1, saved: s1 && { t0: s1.t0, t1: s1.t1, lines: s1.line_ids, beats: s1.beats.length }, snapped });

  // 4. Fill the gaps: an ask for the agent with the gaps; the agent fills them and the page follows live
  await pg.evaluate(() => document.querySelector('.scbar [data-a=fill]').click());
  await until(() => window.WB.store.notes.notes.some(n => n.ask === 'fill_gaps'));
  await fileUntil(NP, 'notes.json', (j) => j.notes.some(n => n.ask === 'fill_gaps'));
  const sg = (await op('script_get', {})).body;
  const ask = sg.asks_for_agent.find(a => a.kind === 'fill_gaps');
  const fill = await op('scenes_update', { upsert: sg.gaps.map((g, i) => ({ t0: g.t0, t1: g.t1, title: `verify agent ${i + 1}`, text: 'agent: ' + g.lines.map(l => l.text).join(' / '), beats: [{ t: g.t0, text: 'agent beat' }] })), snap: 'lines', message: 'verify: agent filled the gaps' });
  await op('scene_note_resolve', { id: ask?.id, reply: 'verify: filled' });
  const live = await until(() => window.WB.store.scenes.current === 'v2' && !document.querySelector('.scws .scrow.gap') && /100% scripted/.test(document.querySelector('.scbar').textContent));
  check('Fill the gaps: an ask (kind fill_gaps, gaps listed) for the agent; the agent covers them (scenes_update) and the page shows 100% live',
    !!ask && JSON.stringify(ask.gaps) === JSON.stringify(sg.gaps.map(g => [g.t0, g.t1])) && fill.status === 200 && fill.body.version === 'v2' && !fill.body.gaps.length && live,
    { ask: ask && ask.gaps, fill: fill.body, live });

  // 5. a sketch drawn inline on sc01 and saved: files, media, the scene gets it (a new version: the draft was clean)
  await pg.evaluate(() => window.WB.script.focus('sc01')); await wait(150);
  await pg.evaluate(() => document.querySelector('.sccard.open [data-a=sknew]').click());
  await until(() => !!window.WB.script.ws.sk);
  const box = await pg.evaluate(() => { const c = document.querySelector('.scskhost .sk-cv'); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await pg.mouse.move(box.x + box.w * 0.25, box.y + box.h * 0.6); await pg.mouse.down();
  for (let i = 1; i <= 12; i++) await pg.mouse.move(box.x + box.w * (0.25 + i * 0.04), box.y + box.h * (0.6 - Math.sin(i / 3) * 0.2), { steps: 2 });
  await pg.mouse.up();
  await pg.evaluate(() => window.WB.script.ws.sk.api.addPin(640, 300, 'verify: the window, rain streaks'));
  await wait(150);
  await pg.screenshot({ path: path.join(OUT, 'v5_scene_sketch.png') });
  const skId = await pg.evaluate(() => window.WB.script.ws.sk.id);
  await pg.evaluate(() => window.WB.script.ws.sk.api.save());
  await until(() => window.WB.store.scenes.current === 'v3' && !!window.WB.store.mediaById?.[`sketch-${window.WB.script.ws.sk?.id}`], null, 8000);
  const V3 = await fileUntil(NP, 'scenes.json', (j) => j.current === 'v3'), skJson = readJ(NP, `sketches/${skId}.json`), med = (readJ(NP, 'media.json')?.items || []).find(m => m.id === `sketch-${skId}`);
  check('a sketch drawn inline (stroke + pin) and saved: sketches/<id>.json + .png, media kind sketch linked to the scene, via page; the scene holds it in a new version',
    !!skJson && skJson.strokes.length >= 1 && skJson.pins[0]?.text === 'verify: the window, rain streaks' && skJson.via === 'page' && fs.existsSync(path.join(ND, `sketches/${skId}.png`))
    && med?.kind === 'sketch' && med.scenes.includes('sc01') && V3?.versions.at(-1).scenes.find(s => s.id === 'sc01').sketches.includes(skId) && V3.versions.at(-1).via === 'page',
    { skId, strokes: skJson?.strokes?.length, media: med && [med.path, med.scenes], version: V3?.current });
  // copy it from sc01, paste into sc02 (a new sketch of sc02)
  await pg.evaluate(() => document.querySelector('[data-a=skclose]').click()); await wait(150);
  await pg.evaluate(() => document.querySelector('.scrow[data-scene=sc01] [data-a=skcopy]').click()); await wait(300);
  await pg.evaluate(() => window.WB.script.focus('sc02')); await wait(150);
  await pg.evaluate(() => document.querySelector('.scrow[data-scene=sc02] [data-a=skpaste]').click());
  await until(() => window.WB.store.scenes.current === 'v4', null, 8000); await wait(400);
  const V4 = await fileUntil(NP, 'scenes.json', (j) => j.current === 'v4'), pasted = V4?.versions.at(-1).scenes.find(s => s.id === 'sc02')?.sketches?.[0], pj = pasted && readJ(NP, `sketches/${pasted}.json`);
  await pg.screenshot({ path: path.join(OUT, 'v5_sketch_pasted.png') });
  check('copy a sketch from one scene, paste into another: a new sketch (own id, same strokes and pins) saved for sc02', !!pasted && pasted !== skId && pj?.strokes?.length === skJson?.strokes?.length && pj.pins.length === 1 && fs.existsSync(path.join(ND, `sketches/${pasted}.png`)),
    { pasted, strokes: pj?.strokes?.length });

  // 6. the Notes column: an agent note on a scene shows live on its row; the director replies, then asks the agent (Alt+N
  // on the open scene, "@agent ...")
  const an = await op('scene_note_add', { scene: 'sc01', text: 'verify agent: should the bus pass under the bridge on the chorus downbeat?' });
  const liveNote = await until((id) => !!document.querySelector(`.scws .nclayer .ncn.ag[data-nid="${id}"]`), an.body?.id);
  await pg.evaluate((id) => document.querySelector(`.scws .nclayer .ncn[data-nid="${id}"] [data-nc=reply]`).click(), an.body?.id); await wait(80);
  await pg.keyboard.type('verify reply: yes, on the downbeat'); await pg.keyboard.press('Enter');
  await pg.evaluate(() => { window.WB.script.focus('sc01'); document.querySelector('.scws .sclist').focus(); }); await wait(100);
  await combo(['Alt'], 'KeyN'); await wait(150);
  const altN = await pg.evaluate(() => document.activeElement?.matches('.scws .nclayer .nced'));
  await pg.keyboard.type('@agent verify: add a beat for the bridge'); await pg.keyboard.press('Enter');
  await until(() => window.WB.store.notes.notes.some(n => n.text === 'verify: add a beat for the bridge'));
  await wait(300);
  await pg.screenshot({ path: path.join(OUT, 'v5_notes.png') });
  const N = (await fileUntil(NP, 'notes.json', (j) => j.notes.some(n => n.text === 'verify: add a beat for the bridge') && j.notes.find(n => n.id === an.body?.id)?.replies?.length)).notes, nn = N.find(n => n.id === an.body?.id), ask2 = N.find(n => n.text === 'verify: add a beat for the bridge');
  const rowAligned = await pg.evaluate((id) => { const c = document.querySelector(`.scws .nclayer .ncn[data-nid="${id}"]`)?.closest('.nccell'), r = document.querySelector('.scws .scrow[data-scene=sc01]'); return c && r ? Math.abs(c.getBoundingClientRect().top - r.getBoundingClientRect().top) : null; }, an.body?.id);
  check('Notes column (script): an agent note arrives live on its scene\'s row (aligned); a reply; Alt+N on the open scene types a note there, "@agent" makes it an ask (scene-bound, director / page)',
    liveNote && rowAligned !== null && rowAligned < 1.5 && nn?.replies?.[0]?.via === 'page' && altN && ask2?.to === 'agent' && ask2.target?.kind === 'scene' && ask2.target.id === 'sc01' && ask2.via === 'page',
    { liveNote, rowAligned, reply: nn?.replies?.[0], altN, ask: ask2 && [ask2.target, ask2.via] });

  // 7. versions: a side-by-side diff v1 -> current with the scene changes
  await pg.evaluate(() => { document.querySelector('.scws .lytabs [data-side=versions]').click(); });
  await pg.evaluate(() => { document.querySelector('.scws .lyv[data-v=v1] [data-ab=a]').click(); document.querySelector(`.scws .lyv[data-v=${window.WB.store.scenes.current}] [data-ab=b]`).click(); document.querySelector('.scws .lyvh [data-a=ab]').click(); }); await wait(200);
  const diff = await pg.evaluate(() => ({ cols: document.querySelectorAll('.scws .lydc > div').length, add: document.querySelectorAll('.scws .lydr .add').length, head: document.querySelector('.scws .lydh')?.textContent || '' }));
  await pg.screenshot({ path: path.join(OUT, 'v5_compare.png') });
  check('versions: side-by-side diff of v1 and the current version, with the scenes added', diff.cols === 2 && diff.add > 5 && /\+sc02/.test(diff.head), diff);
  await pg.evaluate(() => document.querySelector('.scws .lydh [data-a=closediff]').click());

  // 8. scene status: ok from the page (director / page); the agent cannot set ok
  await pg.evaluate(() => { window.WB.script.focus('sc01'); document.querySelector('.scrow[data-scene=sc01] [data-st=ok]').click(); });
  await until(() => window.WB.store.scenes.states?.sc01?.status === 'ok');
  await fileUntil(NP, 'scenes.json', (j) => j.states?.sc01?.status === 'ok');
  const okAg = await op('scenes_update', { status: { sc02: 'ok' } });
  const ST = readJ(NP, 'scenes.json').states;
  check('scene status: ok set in the page (director / page); refused to the agent', ST?.sc01?.status === 'ok' && ST.sc01.via === 'page' && okAg.status === 403, { sc01: ST?.sc01, agent: okAg.status });

  // 9. the timeline Scenes column: scenes + beats at their times, aligned with every column
  await pg.evaluate(() => window.WB.app.show('timeline')); await wait(400);
  const col = await pg.evaluate(() => { const tl = window.WB.timeline, c = tl.byId.scenes; const v = window.WB.store.scenes.versions.find(x => x.id === window.WB.store.scenes.current);
    const sc = v.scenes[0]; tl.scrollToTime(sc.t0); tl.drawLanes();
    return { shown: !!c && !c.hidden, items: c.items.length, want: v.scenes.length + v.scenes.reduce((a, s) => a + s.beats.length, 0), align: window.WB.alignTest(v.scenes.map(s => s.t0)).pass }; });
  await pg.evaluate(() => { const tl = window.WB.timeline; tl.scrollToTime(0); tl.drawLanes(); }); await wait(100);
  await pg.screenshot({ path: path.join(OUT, 'v5_timeline_scenes.png') });
  check('timeline: a Scenes column with each scene and its beats at their times, aligned with the other columns', col.shown && col.items === col.want && col.align, col);

  // 10. the stage: the agent cannot mark it done; the page can
  const agDone = await op('stage_update', { stage: 'script', status: 'done' });
  await pg.evaluate(() => window.WB.stages.open('script')); await wait(200);
  await pg.evaluate(() => document.querySelector('.sgbar [data-st=done]').click());
  await until(() => window.WB.stages.view().stages[1].status === 'done');
  for (let i = 0; i < 40 && readJ(NP, 'stages.json')?.stages?.find(s => s.id === 'script')?.status !== 'done'; i++) await wait(100);   // the file, not only the page
  const sst = readJ(NP, 'stages.json')?.stages?.find(s => s.id === 'script');
  check('script stage: done refused to the agent, set in the page (director / page)', agDone.status === 403 && sst?.status === 'done' && sst.via === 'page', { agent: agDone.status, stage: sst });
  await pg.close();
  const del = await post('/api/projects/delete', { id: NP });
  check('script project deleted', del.status === 200 && !fs.existsSync(ND), del.status);
  v5.pass = Object.values(v5.checks).every(c => c.pass);
} catch (e) { v5.checks.aborted = blockFailed('v5', e); v5.pass = false; }
// ---------------------------------------------------------------- v6: the guided flow, phase 3 (stage 3: the breakdown)
// On a new project scripted by the agent: "Suggest from script" (the page's own pre-pass), save as a version, an item
// edited in place, the matrix (a click links a scene), merge (selection bar + pick), drop / restore, the context menus,
// "Create entity" (a character and a wardrobe look; Assets shows it), "Ask the agent to extract" and the agent's
// answer live, the agent rules (no ok, no entity), the timeline scenes column markers and the scene menu entry.
// Screenshots v6_*.png.
const v6 = report.v6 = { checks: {} };
try {
  const check = (name, ok, detail) => { v6.checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v6 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`); };
  const NP = 'breakdown-verify', ND = path.join(DATA, NP);
  if (fs.existsSync(ND)) await post('/api/projects/delete', { id: NP });
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1500, height: 850, deviceScaleFactor: 1 });
  pg.on('pageerror', e => console.error('pageerror', e.message));
  pg.on('console', m => { if (m.type() === 'error') console.error('console', m.text()); });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
  const ready = async () => { await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(); };
  const combo = async (mods, key) => { for (const m of mods) await pg.keyboard.down(m); await pg.keyboard.press(key); for (const m of mods.slice().reverse()) await pg.keyboard.up(m); };
  const until = async (fn, arg, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
  const readJ = (p, f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, p, f), 'utf8')); } catch (e) { return null; } };
  const fileUntil = async (p, f, fn, ms = 5000) => { const t0 = Date.now(); let j = null; while (Date.now() - t0 < ms) { j = readJ(p, f); try { if (j && fn(j)) return j; } catch (e) { /* not there yet */ } await wait(100); } return j; };
  const click = async (sel) => { const r = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(8, b.width / 2), y: b.top + b.height / 2 }; }, sel); if (!r) throw new Error('no element ' + sel); await pg.mouse.click(r.x, r.y); await wait(120); };
  const menuOf = async (sel) => { const r = await pg.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.left + 10, y: b.top + b.height / 2 }; }, sel); await pg.mouse.click(r.x, r.y, { button: 'right' }); await wait(120);
    const m = await pg.evaluate(() => [...document.querySelectorAll('.pop .pi .lb')].map(x => x.childNodes[0]?.textContent.trim())); await pg.keyboard.press('Escape'); return m; };
  const itemId = (name) => pg.evaluate((n) => window.WB.breakdown.ws.draft.find(i => i.name === n)?.id, name);

  // 1. a scripted project (lyrics, intake, four scenes written by the agent); the breakdown stage starts empty
  const POEM = '[Verse 1]\nThe night bus hums along the coast\nI count the lights I loved the most\nYour coat is red against the rain\n\n[Chorus]\nRide, ride, the window glows\nRide, ride, nobody knows\n\n[Verse 2]\nAt the pier the old boats creak\nYou hand me a letter, you don\'t speak\n\n[Outro]\nThe bus is gone, the road is grey';
  const cr = await post('/api/projects/new', { id: NP, title: 'Breakdown Verify', lyrics: POEM });
  const H = await writeHeaders(BASE, NP), op = async (name, body) => post(`/api/op/${name}?project=${NP}`, body, BASE, H);
  const { origin: _o, ...HA } = H, agent = async (name, body) => post(`/api/op/${name}?project=${NP}`, body, BASE, HA);   // the agent surface: no page Origin
  await op('intake_answer', { answers: { who: 'Mara, Theo, the bus driver', where: 'a night bus; the old pier' }, by: 'director' });
  const sg = (await op('song_get', { words: false })).body, L = sg.lines, sec = (id) => sg.sections.find(s => s.id === id);
  const sc = await op('scenes_update', { scenes: [
    { t0: 0, t1: sec('chorus').t0, title: 'The night bus', text: 'Mara rides the night bus along the coast road, wearing a red raincoat. Rain on the window.', beats: [{ t: L[0].t0, text: 'Mara at the window' }, { t: L[2].t0, text: 'Mara writes a name on the glass' }] },
    { t0: sec('chorus').t0, t1: sec('verse-2').t0, title: 'Chorus ride', text: 'The Bus Driver watches Mara in the mirror. Neon flicker.', beats: [{ t: L[3].t0, text: 'the Bus Driver glances up' }] },
    { t0: sec('verse-2').t0, t1: sec('outro').t0, title: 'The pier', text: 'At the old pier Theo waits under a lamp. He hands Mara a letter; she keeps it in her coat.', beats: [{ t: L[5].t0, text: 'Theo hands Mara the letter' }] },
    { t0: sec('outro').t0, t1: sg.duration_ms, title: 'Morning', text: 'Dawn. Mara alone with the ticket.', beats: [] },
  ], snap: 'lines', message: 'verify: four scenes' });
  await pg.goto(`${BASE}/?project=${NP}`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
  await combo(['Alt', 'Shift'], 'Digit3'); await wait(400);
  const empty = await pg.evaluate(() => ({ stage: window.WB.stages.current(), empty: !!document.querySelector('.bdws .scempty [data-a=suggest]'), bar: !!document.querySelector('.bdbar [data-a=extract]') }));
  await pg.screenshot({ path: path.join(OUT, 'v6_breakdown_empty.png') });
  check('a scripted project: the breakdown stage (Alt+Shift+3) starts empty, offering "Suggest from script" and "Ask the agent to extract"', cr.status === 200 && sc.status === 200 && empty.stage === 'breakdown' && empty.empty && empty.bar, { empty, scenes: sc.body });

  // 2. Suggest from script (no agent): characters from capitalised names and the intake, locations, props, wardrobe, FX, linked to scenes and beats
  await click('.bdbar [data-a=suggest]'); await wait(200);
  const sug = await pg.evaluate(() => { const d = window.WB.breakdown.ws.draft, f = (n) => d.find(i => i.name === n);
    return { n: d.length, kinds: [...new Set(d.map(i => i.kind))].sort(), mara: f('Mara') && { kind: f('Mara').kind, scenes: f('Mara').links.map(l => l.scene), beats: f('Mara').links[0]?.beats.length }, theo: f('Theo')?.kind, driver: f('Bus Driver')?.kind,
      pier: f('Old pier')?.kind, raincoat: f('Red raincoat') && { kind: f('Red raincoat').kind, for: f('Red raincoat').for }, rows: document.querySelectorAll('.bdws .bdrow').length, dirty: window.WB.breakdown.ws.dirty }; });
  await pg.evaluate(() => document.querySelector('.bdbar .lymsg')?.focus()); await pg.keyboard.type('verify: first pass');
  await combo(['Control'], 'Enter');
  const V1 = await fileUntil(NP, 'breakdown.json', (j) => j.current === 'v1');
  await until(() => !window.WB.breakdown.ws.dirty);
  await pg.screenshot({ path: path.join(OUT, 'v6_breakdown_list.png') });
  const ST1 = readJ(NP, 'stages.json')?.stages?.find(s => s.id === 'breakdown');
  check('Suggest from script: characters (names + intake), locations, props, wardrobe (with its owner), FX, each linked to scenes and beats; Ctrl+Enter saves v1 (director / page, script version recorded); the stage moves to in progress',
    sug.n >= 8 && sug.kinds.length === 5 && sug.mara?.kind === 'character' && sug.mara.scenes.length === 4 && sug.mara.beats === 2 && sug.theo === 'character' && sug.driver === 'character' && sug.pier === 'location'
    && sug.raincoat?.kind === 'wardrobe' && !!sug.raincoat.for && sug.rows === sug.n && sug.dirty && V1?.versions?.[0]?.via === 'page' && V1.versions[0].message === 'verify: first pass' && V1.versions[0].script === 'v1'
    && V1.versions[0].items.every(i => i.source === 'director') && ST1?.status === 'in_progress',
    { sug, v1: V1?.versions?.[0] && { via: V1.versions[0].via, items: V1.versions[0].items.length, script: V1.versions[0].script }, stage: ST1?.status });

  // 3. an item edited in place: open it (click), status ok saved at once, a beat chip and a link note
  const mara = await itemId('Mara');
  await click(`.bdrow[data-item="${mara}"] .bdnm`);
  await click(`.bded [data-st=ok]`);
  await until((id) => window.WB.store.breakdown.states?.[id]?.status === 'ok', mara);
  await pg.evaluate(() => { const i = document.querySelector('.bded .bdlk[data-scene=sc04] .bdin-lnote'); i.focus(); });
  await pg.keyboard.type('verify: alone at dawn'); await pg.keyboard.press('Enter');
  await pg.screenshot({ path: path.join(OUT, 'v6_breakdown_item.png') });
  const ed = await pg.evaluate((id) => { const it = window.WB.breakdown.ws.item(id); return { open: window.WB.breakdown.ws.open, note: it.links.find(l => l.scene === 'sc04')?.note, editor: !!document.querySelector(`.bded[data-item="${id}"] .bdin-desc`) }; }, mara);
  const S1 = (await fileUntil(NP, 'breakdown.json', (j) => j.states?.[mara]?.status === 'ok'))?.states?.[mara];
  check('an item opens in place (name, kind, status, description, scenes with beats and a note); status ok is saved at once (director / page)', ed.open === mara && ed.editor && ed.note === 'verify: alone at dawn' && S1?.via === 'page' && S1.by === 'director', { ed, state: S1 });

  // 4. the matrix: items x scenes; a click on an empty cell links the item to that scene
  await click('.bdbar [data-view=matrix]');
  const theo = await itemId('Theo');
  const mx0 = await pg.evaluate(() => ({ rows: document.querySelectorAll('.bdmx tr.bdmxr').length, cols: document.querySelectorAll('.bdmx th.bdmxs').length }));
  await click(`.bdmx tr[data-item="${theo}"] td.bdc[data-scene=sc04]`);
  const mx1 = await pg.evaluate((id) => ({ linked: window.WB.breakdown.ws.item(id).links.some(l => l.scene === 'sc04'), on: document.querySelector(`.bdmx tr[data-item="${id}"] td.bdc[data-scene=sc04]`)?.classList.contains('on') }), theo);
  await pg.screenshot({ path: path.join(OUT, 'v6_breakdown_matrix.png') });
  await combo(['Control'], 'Enter');
  const V2 = await fileUntil(NP, 'breakdown.json', (j) => j.current === 'v2');
  check('matrix: one row per item, one column per scene; a click links Theo to sc04 (the cell lights), Ctrl+Enter saves v2', mx0.rows === sug.n && mx0.cols === 4 && mx1.linked && mx1.on && V2?.versions.at(-1).items.find(i => i.id === theo)?.links.some(l => l.scene === 'sc04'), { mx0, mx1, v2: V2?.current });

  // 5. merge: Ctrl+click two items, "merge" in the selection bar, keep the name chosen in the pick list
  await click('.bdbar [data-view=list]');
  const coat = await itemId('Coat'), rain = await itemId('Red raincoat');
  await click(`.bdrow[data-item="${rain}"] .bdnm`); await click(`.bdrow[data-item="${rain}"] .bdnm`);   // open then close: a plain selection
  await pg.evaluate((id) => { const e = document.querySelector(`.bdrow[data-item="${id}"] .bdnm`); e.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); }, coat || rain); await wait(150);
  const selBar = await pg.evaluate(() => ({ shown: getComputedStyle(document.querySelector('.bdsel')).display !== 'none', text: document.querySelector('.bdsel')?.textContent || '' }));
  await click('.bdsel [data-a=merge]'); await wait(150);
  await pg.keyboard.type('raincoat'); await wait(80);
  await pg.screenshot({ path: path.join(OUT, 'v6_breakdown_merge_pick.png') });
  await pg.keyboard.press('Enter'); await wait(250);
  const mg = await pg.evaluate(([a, b]) => { const s = window.WB.breakdown.ws; return { a: !!s.item(a), b: s.item(b) && { aliases: s.item(b).aliases, scenes: s.item(b).links.map(l => l.scene) } }; }, [coat, rain]);
  await pg.screenshot({ path: path.join(OUT, 'v6_breakdown_merged.png') });
  await combo(['Control'], 'Enter');
  const V3 = await fileUntil(NP, 'breakdown.json', (j) => j.current === 'v3');
  check('merge: Ctrl+click selects two, the selection bar offers merge, the pick keeps "Red raincoat" (the other name kept as an alias, scenes united), saved as v3',
    !!coat && selBar.shown && /2 selected/.test(selBar.text) && !mg.a && mg.b?.aliases?.includes('Coat') && mg.b.scenes.includes('sc03') && mg.b.scenes.includes('sc01') && !V3?.versions.at(-1).items.some(i => i.id === coat),
    { coat, rain, selBar, mg, v3: V3?.current });

  // 6. context menus: an item row (rename, kind, merge, split, drop, create entity…) and a scene chip (the scene filter)
  const lamp = await itemId('Lamp');
  const rowMenu = await menuOf(`.bdrow[data-item="${lamp}"] .bdnm`);
  await pg.evaluate((id) => window.WB.commands.run('breakdown.drop', { itemId: id }), lamp); await wait(150);
  const dropped = await pg.evaluate((id) => ({ flag: !!window.WB.breakdown.ws.item(id).dropped, grey: document.querySelector(`.bdrow[data-item="${id}"]`)?.classList.contains('dropped') }), lamp);
  await pg.evaluate((id) => window.WB.commands.run('breakdown.drop', { itemId: id }), lamp); await wait(150);
  const restored = await pg.evaluate((id) => !window.WB.breakdown.ws.item(id).dropped, lamp);
  check('item context menu (rename, change kind, merge, split, drop, create entity, note); drop is soft (greyed) and restorable',
    ['Rename the item', 'Change the kind…', 'Split the item…', 'Drop (soft: restorable)', 'Create entity…', 'Note on the item (Notes column)', '+ Add'].every(x => rowMenu.includes(x)) && dropped.flag && dropped.grey && restored, { rowMenu, dropped, restored });

  // 7. Create entity: Mara becomes a character (Assets), her red raincoat a look on her; nothing generated or spent
  await pg.evaluate((id) => window.WB.breakdown.focus(id), mara); await wait(150);
  await click('.bded [data-a=promote]'); await wait(200);
  const pickRows = await pg.evaluate(() => [...document.querySelectorAll('.pal .pr .lb')].map(x => x.textContent));
  await pg.screenshot({ path: path.join(OUT, 'v6_breakdown_promote_pick.png') });
  await pg.keyboard.press('Enter');
  await until(() => window.WB.store.entities.some(e => e.id === 'mara'), null, 8000);
  await pg.evaluate((id) => window.WB.breakdown.focus(id), rain); await wait(150);
  await click('.bded [data-a=promote]'); await wait(200); await pg.keyboard.press('Enter');
  await until(() => (window.WB.store.entities.find(e => e.id === 'mara')?.looks || []).length === 1, null, 8000); await wait(300);
  await pg.screenshot({ path: path.join(OUT, 'v6_breakdown_promoted.png') });
  const E = readJ(NP, 'entities/characters/mara.json'), BS = readJ(NP, 'breakdown.json')?.states || {}, C = readJ(NP, 'costs.json'), RQ = readJ(NP, 'requests.json');
  await pg.evaluate(() => window.WB.app.show('characters')); await wait(500);
  const assets = await pg.evaluate(() => document.querySelector('#panes')?.textContent.includes('Mara'));
  await pg.screenshot({ path: path.join(OUT, 'v6_assets_from_breakdown.png') });
  check('Create entity (page): Mara becomes a draft character in Assets (linked back to the item and its scenes), the red raincoat a look on her; no request, no cost',
    /Create a new character “Mara”/.test(pickRows[0] || '') && E?.status === 'draft' && E.breakdown?.item === mara && E.breakdown.scenes.length === 4 && E.looks?.[0]?.name === 'Red raincoat' && BS[mara]?.entity_id === 'mara' && BS[rain]?.look_id === E.looks[0].id
    && assets && !(C?.items || []).length && !(RQ?.items || []).length,
    { pick: pickRows.slice(0, 2), entity: E && { status: E.status, breakdown: E.breakdown, looks: E.looks?.map(l => l.id) }, states: { mara: BS[mara], rain: BS[rain] }, assets });

  // 8. Ask the agent to extract: an ask note; the agent answers with a new version (live, marked agent); the agent rules
  await pg.evaluate(() => window.WB.stages.open('breakdown')); await wait(300);
  await click('.bdbar [data-a=extract]');
  await fileUntil(NP, 'notes.json', (j) => j.notes.some(n => n.ask === 'extract'));
  const bg = (await agent('breakdown_get', { with_script: false })).body, ask = bg.asks_for_agent.find(a => a.kind === 'extract');
  const au = await agent('breakdown_update', { upsert: [{ kind: 'prop', name: 'Bus ticket', description: 'verify agent: the ticket she keeps', links: [{ scene: 'sc04', beats: [] }] }], message: 'verify agent: the ticket' });
  await agent('breakdown_note_resolve', { id: ask?.id, reply: 'verify agent: added the ticket' });
  const live = await until(() => [...document.querySelectorAll('.bdws .bdrow')].some(r => r.textContent.includes('Bus ticket') && r.querySelector('.who.ag')));
  const agOk = await agent('breakdown_update', { status: { [theo]: 'ok' } }), agRev = await agent('breakdown_update', { status: { [theo]: 'review' } }), agProm = await agent('breakdown_promote', { item: theo });
  await until((id) => window.WB.store.breakdown.states?.[id]?.status === 'review', theo);
  await pg.screenshot({ path: path.join(OUT, 'v6_breakdown_agent.png') });
  check('Ask the agent to extract: an ask (kind extract) the agent reads; its new version shows live (marked agent); the agent can ask for review but not mark ok or create an entity',
    !!ask && au.status === 200 && live && agOk.status === 403 && agRev.status === 200 && agProm.status === 403, { ask: ask && ask.text.slice(0, 60), au: au.body, live, agOk: agOk.status, agRev: agRev.status, agProm: agProm.status });

  // 9. the timeline: the scenes column carries the breakdown markers; a scene's menu opens its items in the breakdown
  await pg.evaluate(() => window.WB.app.show('timeline')); await wait(500);
  await pg.evaluate(() => { const tl = window.WB.timeline; tl.scrollToTime(0); tl.drawLanes(); }); await wait(200);
  const marks = await pg.evaluate(() => [...document.querySelectorAll('.col-scenes .scn .scbd')].map(e => e.textContent));
  await pg.screenshot({ path: path.join(OUT, 'v6_timeline_markers.png') });
  const scMenu = await menuOf('.col-scenes .it.scene .scn');
  await pg.evaluate(() => window.WB.commands.run('breakdown.sceneItems', { sceneId: 'sc03' })); await wait(400);
  const filt = await pg.evaluate(() => ({ stage: window.WB.stages.current(), scene: window.WB.breakdown.ws.scene, rows: [...document.querySelectorAll('.bdws .bdrow')].map(r => r.dataset.item), bar: document.querySelector('.bdscf')?.textContent || '' }));
  await pg.screenshot({ path: path.join(OUT, 'v6_breakdown_scene.png') });
  const wantSc3 = (readJ(NP, 'breakdown.json')?.versions.at(-1).items || []).filter(i => i.links.some(l => l.scene === 'sc03')).map(i => i.id).sort();
  check('timeline: the scenes column shows each scene\'s characters / locations; the scene menu has "Breakdown items in scene …", which opens the breakdown filtered to that scene',
    marks.length >= 3 && marks.some(m => m.includes('Mara')) && scMenu.some(x => /^Breakdown items in scene sc0\d$/.test(x)) && filt.stage === 'breakdown' && filt.scene === 'sc03' && JSON.stringify([...filt.rows].sort()) === JSON.stringify(wantSc3) && /sc03/.test(filt.bar),
    { marks, scMenu: scMenu.filter(x => /Breakdown/.test(x)), filt: { ...filt, rows: filt.rows.length }, want: wantSc3.length });
  await pg.close();
  const del = await post('/api/projects/delete', { id: NP });
  check('breakdown project deleted', del.status === 200 && !fs.existsSync(ND), del.status);
  v6.pass = Object.values(v6.checks).every(c => c.pass);
} catch (e) { v6.checks.aborted = blockFailed('v6', e); v6.pass = false; }
// ---------------------------------------------------------------- v7: the guided flow, phase 4 (stage 4: characters)
// tools/verify-characters.mjs (also runnable alone). Screenshots v7_*.png.
const v7 = report.v7 = { checks: {} };
try { const { verifyCharacters } = await import('./verify-characters.mjs'); Object.assign(v7, await verifyCharacters({ browser, BASE, DATA, OUT, post, writeHeaders })); }
catch (e) { v7.checks.aborted = blockFailed('v7', e); v7.pass = false; }

// ---------------------------------------------------------------- v8: the guided flow, phase 5 (stage 5: scenery, locations + props)
// tools/verify-scenery.mjs (also runnable alone). Screenshots v8_*.png.
const v8 = report.v8 = { checks: {} };
try { const { verifyScenery } = await import('./verify-scenery.mjs'); Object.assign(v8, await verifyScenery({ browser, BASE, DATA, OUT, post, writeHeaders })); }
catch (e) { v8.checks.aborted = blockFailed('v8', e); v8.pass = false; }

// ---------------------------------------------------------------- v9: the guided flow, phase 6 (stage 6: the storyboard and the gaps)
// tools/verify-storyboard.mjs (also runnable alone). Screenshots v9_*.png.
const v9 = report.v9 = { checks: {} };
try { const { verifyStoryboard } = await import('./verify-storyboard.mjs'); Object.assign(v9, await verifyStoryboard({ browser, BASE, DATA, OUT, post, writeHeaders })); }
catch (e) { v9.checks.aborted = blockFailed('v9', e); v9.pass = false; }
// ---------------------------------------------------------------- v10: the dogfood frictions (base proposal, image import as a node,
// request warnings, merged costs, the photoreal recipe form, the stale-code bar): tools/verify-dogfood.mjs (also runnable alone;
// its own scratch code copy + data + server). Screenshots v10_*.png.
const v10 = report.v10 = { checks: {} };
try { const { verifyDogfood } = await import('./verify-dogfood.mjs'); Object.assign(v10, await verifyDogfood({ browser, OUT })); }
catch (e) { v10.checks.aborted = blockFailed('v10', e); v10.pass = false; }
// ---------------------------------------------------------------- v11: notes everywhere (SPEC v4 §1, ROADMAP_v4 B1-B5): the migration of the
// old note stores on first load, the Notes column per stage (row-aligned) and on the timeline (time-aligned), the right-click
// "+ Add" menus and Ctrl+Z, the counters: tools/verify-notes.mjs (also runnable alone; its own data + server). Screenshots v11_*.png.
const v11 = report.v11 = { checks: {} };
try { const { verifyNotes } = await import('./verify-notes.mjs'); Object.assign(v11, await verifyNotes({ browser, OUT })); }
catch (e) { v11.checks.aborted = blockFailed('v11', e); v11.pass = false; }
// write path: approve/needs-changes + a note, on another scratch copy (_verify, its own server), then a stale-rev POST must get 409
try {
  const TMP = path.join(DATA, '_verify');
  fs.rmSync(TMP, { recursive: true, force: true }); fs.cpSync(SRCDIR, TMP, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  const { proc: s2, base: B2 } = await startServer('_verify');
  const readTmp = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(TMP, f), 'utf8')) || d; } catch (e) { return d; } };
  const pg = await browser.newPage(); await pg.setViewport({ width: 1280, height: 800 });
  await pg.goto(`${B2}/?project=_verify`); await pg.waitForFunction('document.body.dataset.ready === "1"');
  const key = await pg.evaluate(() => document.querySelector('.col-status .chip[data-k]')?.dataset.k);
  if (!key) throw new Error('no status chip in the timeline');
  const ap0 = readTmp('approvals.json', { rev: 0, items: {} }), before = ap0.items?.[key]?.state || 'draft';
  await pg.evaluate(async (k) => { document.querySelector(`.col-status .chip[data-k="${k}"]`).click(); await new Promise(r => setTimeout(r, 400)); }, key);
  await pg.evaluate(async (T) => { await window.WB.store.addNote(T, 'verify: test note'); }, at(61230));
  await new Promise(r => setTimeout(r, 300));
  const ap = readTmp('approvals.json', { rev: 0, items: {} }), nt = readTmp('notes.json', { rev: 0, notes: [] });
  const stale = await fetch(B2 + '/api/save/approvals.json', { method: 'POST', headers: await writeHeaders(B2, '_verify'), body: JSON.stringify({ base_rev: 0, data: ap }) });
  const noteShown = await pg.evaluate(() => [...document.querySelectorAll('.col-notes .note')].some(n => n.textContent.includes('verify: test note')));
  report.writes = { chip: key, stateBefore: before, newState: ap.items?.[key]?.state, approvalsRevBefore: ap0.rev || 0, approvalsRev: ap.rev, noteSaved: (nt.notes || []).some(n => n.text === 'verify: test note'), notesRev: nt.rev, noteShownInColumn: noteShown, staleStatus: stale.status };
  console.log('writes', JSON.stringify(report.writes));
  await pg.close(); s2.kill(); await new Promise(r => setTimeout(r, 300));
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
} catch (e) { report.writes = { error: blockFailed('writes', e).detail }; }
report.project = P;
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
const w = report.writes || {};
const writesOk = w.noteSaved && w.noteShownInColumn && w.staleStatus === 409 && w.newState !== undefined && w.newState !== w.stateBefore && w.approvalsRev > w.approvalsRevBefore;
console.log(`project ${P} · all aligned:`, report.configs.every(c => c.align.pass), '· v2 checks:', report.v2?.pass ? 'all PASS' : 'FAIL', '· v4 (guided flow):', report.v4?.pass ? 'all PASS' : 'FAIL', '· v5 (script stage):', report.v5?.pass ? 'all PASS' : 'FAIL', '· v6 (breakdown stage):', report.v6?.pass ? 'all PASS' : 'FAIL', '· v7 (characters stage):', report.v7?.pass ? 'all PASS' : 'FAIL', '· v8 (scenery stage):', report.v8?.pass ? 'all PASS' : 'FAIL', '· v9 (storyboard stage):', report.v9?.pass ? 'all PASS' : 'FAIL', '· v10 (dogfood frictions):', report.v10?.pass ? 'all PASS' : 'FAIL', '· v11 (notes everywhere):', report.v11?.pass ? 'all PASS' : 'FAIL', '· part B checks:', OWNER ? (report.partB?.pass ? 'all PASS' : 'FAIL') : 'skipped (owner data only)', '· writes:', writesOk ? 'PASS' : 'FAIL');
process.exitCode = report.configs.every(c => c.align.pass) && report.v2?.pass && report.v4?.pass && report.v5?.pass && report.v6?.pass && report.v7?.pass && report.v8?.pass && report.v9?.pass && report.v10?.pass && report.v11?.pass && (!OWNER || report.partB?.pass) && writesOk ? 0 : 1;
await browser.close();
for (const c of procs) c.kill();
await new Promise(r => setTimeout(r, 300));   // let the servers release the scratch folder; cleanup() removes it on exit
