// Headless verification: screenshots in several layouts, the alignment test, resize perf and memory, (v2) the
// command system: palette, rebinding persistence, Ctrl+wheel zoom anchoring, context menus, undo/redo, snapshots, and
// (v2 Part B) the preview dock, media index, privacy of exports, characters and "+ New look", and (v3) the page
// structure (Timeline / Assets / Review + Settings gear) and the restore chevrons for a hidden top bar / column header,
// and (v4) the guided flow: the stage rail, the new-project wizard (lyrics only, then the song added), the lyrics stage,
// and (v5) stage 2: the script draft (intake, scenes, beats, sketches inline + copy/paste, gaps, notes, versions, the
// timeline Scenes column).
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
    note: { sel: '.col-notes .note', labels: ['Rename…', 'Delete', 'Copy text', 'Resolved'] },
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

  // 5. a note on a word range (select words -> "+ note"), stamped director / page; an agent note arrives live; reply; resolve
  await pg.evaluate(() => { const ws = document.querySelectorAll('.lyl[data-line="L1"] .w'); const r = document.createRange(); r.setStart(ws[1].firstChild, 0); r.setEnd(ws[2].firstChild, ws[2].textContent.length); getSelection().removeAllRanges(); getSelection().addRange(r); document.querySelector('.lyws').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await wait(60);
  const fab = await pg.evaluate(() => getComputedStyle(document.querySelector('.lyfab')).display !== 'none');
  await pg.click('.lyfab'); await wait(80); await pg.keyboard.type('verify: "night bus" is the title; keep it'); await pg.keyboard.press('Enter');
  await until(() => window.WB.store.lyrics.notes.length === 1);
  const H = await writeHeaders(BASE, NEW);
  const agentNote = await post(`/api/op/lyrics_note_add?project=${NEW}`, { line: 'L4', quote: 'nobody knows', text: 'verify agent: rhyme with "glows" is weak?' }, BASE, H);
  const live = await until(() => !!document.querySelector('.lynote .who.ag'));
  await pg.evaluate(() => { const i = document.querySelector('.lynote[data-note="ln01"] .lyrep'); i.style.display = 'block'; i.focus(); });
  await pg.keyboard.type('verify reply'); await pg.keyboard.press('Enter');
  await until(() => window.WB.store.lyrics.notes.find(n => n.id === 'ln01')?.replies?.length === 1);
  await pg.evaluate(() => { const ta = document.querySelector('.lyask textarea'); ta.value = 'verify: can you suggest a bridge?'; document.querySelector('.lyask [data-a=ask]').click(); });
  await until(() => window.WB.store.lyrics.notes.some(n => n.to === 'agent'));
  await pg.evaluate(() => window.WB.app.show('timeline')); await pg.evaluate(() => window.WB.stages.open('lyrics')); await wait(250);
  await pg.screenshot({ path: path.join(OUT, 'v4_lyrics_notes.png') });
  const L3 = readJ(NEW, 'lyrics.json'), n1 = L3.notes.find(n => n.id === 'ln01'), ask = L3.notes.find(n => n.to === 'agent');
  const marked = await pg.evaluate(() => [...document.querySelectorAll('.lyl[data-line="L1"] .w.nw')].map(w => w.textContent));
  const asks = (await post(`/api/op/lyrics_get?project=${NEW}`, {}, BASE, H)).body?.asks_for_agent || [];
  check('note on a word range (director, via page), agent note live, reply, ask the agent', fab && n1?.line === 'L1' && JSON.stringify(n1.w) === '[1,2]' && n1.quote === 'night bus' && n1.by === 'director' && n1.via === 'page'
    && n1.replies?.[0]?.via === 'page' && agentNote.status === 200 && agentNote.body.via === 'agent' && live && JSON.stringify(marked) === '["night","bus"]' && ask?.via === 'page' && asks.some(a => a.text === 'verify: can you suggest a bridge?'),
    { fab, note: n1 && { w: n1.w, quote: n1.quote, by: n1.by, via: n1.via, replies: n1.replies?.length }, agent: agentNote.body?.via, live, marked, asks: asks.length });
  await pg.evaluate(() => document.querySelector('.lynote[data-note="ln02"] [data-a=resolve]').click());
  await until(() => window.WB.store.lyrics.notes.find(n => n.id === 'ln02')?.status === 'resolved');

  // 6. versions: the list, a side-by-side word diff of v1 -> v2, restore v1 as v3
  await pg.evaluate(() => document.querySelector('.lytabs [data-side=versions]').click()); await wait(60);
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
  const railAfter = await until(() => document.querySelector('#rail a[data-stage=script]')?.classList.contains('st-needs_you') && document.querySelector('#rail a[data-stage=lyrics]')?.classList.contains('st-done'));
  await pg.screenshot({ path: path.join(OUT, 'v4_rail_after.png'), clip: { x: 0, y: 0, width: 1500, height: 60 } });
  check('stage status: the page marks done (director, via page); the agent cannot mark done or move a done stage; needs_you + blockers show on the rail',
    lyr.status === 'done' && lyr.done_by === 'director' && lyr.via === 'page' && agentDone.status === 403 && agentMove.status === 409 && agentOk.status === 200 && railAfter,
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
  await until(() => window.WB.store.scenes.notes.some(n => n.kind === 'fill_gaps'));
  await fileUntil(NP, 'scenes.json', (j) => j.notes.some(n => n.kind === 'fill_gaps'));
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

  // 6. notes: an agent note on a scene shows live; the director replies and asks the agent
  const an = await op('scene_note_add', { scene: 'sc01', text: 'verify agent: should the bus pass under the bridge on the chorus downbeat?' });
  await pg.evaluate(() => document.querySelector('.scws .lytabs [data-side=notes]').click());
  const liveNote = await until(() => !!document.querySelector('.scws .lynote .who.ag'));
  await pg.evaluate(() => { const i = document.querySelector('.scws .lynote .lyrep'); i.style.display = 'block'; i.focus(); });
  await pg.keyboard.type('verify reply: yes, on the downbeat'); await pg.keyboard.press('Enter');
  await pg.evaluate(() => { window.WB.script.focus('sc01'); const ta = document.querySelector('.scws .lyask textarea'); ta.value = 'verify: add a beat for the bridge'; document.querySelector('.scws .lyask [data-a=ask]').click(); });
  await until(() => window.WB.store.scenes.notes.some(n => n.text === 'verify: add a beat for the bridge'));
  await wait(200);
  await pg.screenshot({ path: path.join(OUT, 'v5_notes.png') });
  const N = (await fileUntil(NP, 'scenes.json', (j) => j.notes.some(n => n.text === 'verify: add a beat for the bridge') && j.notes.find(n => n.id === an.body?.id)?.replies?.length)).notes, nn = N.find(n => n.id === an.body?.id), ask2 = N.find(n => n.text === 'verify: add a beat for the bridge');
  check('scene notes: an agent note arrives live; a reply and an ask from the page (scene-bound, director / page)', liveNote && nn?.replies?.[0]?.via === 'page' && ask2?.to === 'agent' && ask2.scene === 'sc01' && ask2.via === 'page',
    { liveNote, reply: nn?.replies?.[0], ask: ask2 && [ask2.scene, ask2.via] });

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
console.log(`project ${P} · all aligned:`, report.configs.every(c => c.align.pass), '· v2 checks:', report.v2?.pass ? 'all PASS' : 'FAIL', '· v4 (guided flow):', report.v4?.pass ? 'all PASS' : 'FAIL', '· v5 (script stage):', report.v5?.pass ? 'all PASS' : 'FAIL', '· part B checks:', OWNER ? (report.partB?.pass ? 'all PASS' : 'FAIL') : 'skipped (owner data only)', '· writes:', writesOk ? 'PASS' : 'FAIL');
process.exitCode = report.configs.every(c => c.align.pass) && report.v2?.pass && report.v4?.pass && report.v5?.pass && (!OWNER || report.partB?.pass) && writesOk ? 0 : 1;
await browser.close();
for (const c of procs) c.kill();
await new Promise(r => setTimeout(r, 300));   // let the servers release the scratch folder; cleanup() removes it on exit
