// v22 of the headless UI suite (tools/verify.mjs): a round trip with the composition (ROADMAP_v4 E9). Exported so verify.mjs
// runs it after the other blocks; runnable alone:   node tools/verify-composition.mjs [outDir]
// Self-contained: a scratch copy of data/demo, two placeholder takes made with ffmpeg (never fal), its own workbench server on a
// free port, an MCP client over stdio, and a TEST COMPOSITION written to the scratch folder: a tiny HyperFrames-like page
// (#root with data-composition-id / data-width / data-height / data-duration, one <video>, a placeholder card) that includes
// exporters/composition-data/reader.js with <script src> and renders a frame as a pure function of song time t
// (window.renderAt(t)). The composition's assets/ folder is the project folder (like azemar's assets/world junction) and its
// wb/edl.json is the project's export file, served in place. The cycle, all pixels read from headless screenshots:
//   no pick -> export -> frame N is the placeholder card (grey)
//   pick take A (red for 1 s, then green) at in 1000 ms in the page -> "Export composition data…" (the page's command and
//   dialog) -> frame N (shot t0 + 200 ms -> take time 1.2 s) is GREEN: take A at its in-point
//   pick take B (blue) at in 0 -> composition_export over MCP -> frame N is BLUE; the same frame twice = the same pixels;
//   exporting the same picks again changes nothing (same bytes, same checksum). Screenshots v22_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve, rgb } from '../exporters/hyperframes-html/lib.mjs';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sdk = (p) => import(pathToFileURL(path.join(WB, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);
// a placeholder take: solid colours from lavfi (VP8 webm, 24 fps, 320x180: plays in any Chromium); several = concatenated 1 s each
function take(file, colours) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ins = colours.flatMap(c => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=24:d=1`]);
  return spawnSync('ffmpeg', ['-v', 'error', '-y', ...ins, '-filter_complex', `${colours.map((_, i) => `[${i}:v]`).join('')}concat=n=${colours.length}:v=1:a=0[v]`, '-map', '[v]', '-c:v', 'libvpx', '-b:v', '400k', '-pix_fmt', 'yuv420p', file]).status === 0;
}
// the test composition: HyperFrames-like markup, the drop-in reader, a frame = a pure function of t
const COMP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>E9 test composition</title>
<style>html,body{margin:0;background:#000}#root{position:relative;width:320px;height:180px;overflow:hidden;background:#000}
#v,#card{position:absolute;left:0;top:0;width:320px;height:180px;object-fit:fill}#card{display:none;background:#808080;color:#808080;font:10px sans-serif}</style></head>
<body><div id="root" data-composition-id="main" data-start="0" data-width="320" data-height="180" data-duration="20">
<video id="v" muted playsinline preload="auto"></video><div id="card"></div></div>
<script src="wb/reader.js"></script>
<script>
  var EDL = WB_EDL.load("wb/edl.json");   // build time: the workbench's picks
  var v = document.getElementById("v"), card = document.getElementById("card");
  function settle(ok, r) { var done = false, go = function () { if (!done) { done = true; ok(r); } }; requestAnimationFrame(function () { requestAnimationFrame(go); }); setTimeout(go, 250); }
  // render song time t (ms): the take the director picked for the shot under t, at in_ms + (t - shot.t0); else the card
  window.renderAt = function (t) {
    var r = EDL.at(t);
    return new Promise(function (ok, bad) {
      if (!r || r.status !== "picked" || r.kind !== "video") { v.style.display = "none"; card.style.display = "block"; card.textContent = r ? r.shot + " " + r.placeholder.reason : ""; return settle(ok, r); }
      card.style.display = "none"; v.style.display = "block";
      function seek() { v.addEventListener("seeked", function f() { v.removeEventListener("seeked", f); settle(ok, r); }); v.currentTime = r.media_s; }
      if (v.getAttribute("src") !== r.file) {
        v.addEventListener("loadeddata", function f() { v.removeEventListener("loadeddata", f); seek(); });
        v.addEventListener("error", function () { bad(new Error("cannot play " + r.file)); }, { once: true });
        v.setAttribute("src", r.file); v.load();
      } else seek();
    });
  };
  window.__edl = { checksum: EDL.checksum, storyboard: EDL.doc.storyboard };
</script></body></html>
`;

export async function verifyComposition({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v22 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { check('ffmpeg is on PATH (placeholder takes)', false); return { checks, pass: false }; }
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v22-')), DATA = path.join(TMP, 'data'), P = 'comp', PD = path.join(DATA, P), COMP = path.join(TMP, 'composition');
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  fs.mkdirSync(COMP, { recursive: true }); fs.writeFileSync(path.join(COMP, 'index.html'), COMP_HTML);
  const SHOT = 's2-wall', T0 = 4000, N = T0 + 200;   // frame N: 200 ms into the shot
  const madeA = take(path.join(PD, 'media', 'clip', 'e9_takeA.webm'), ['red', 'lime']), madeB = take(path.join(PD, 'media', 'clip', 'e9_takeB.webm'), ['blue', 'blue']);
  const EF = path.join(PD, 'exports', 'composition', 'edl.json');
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P };
  delete env.WB_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v22 server: ' + d));
  let pg = null, cpg = null, client = null, comp = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
    const call = async (name, body, page = false) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN, ...(page ? { origin: BASE } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-composition', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* error text */ } return { error: !!r.isError, body, text: t }; };

    // the composition's server: its folder, assets/ = the project folder, wb/reader.js and wb/edl.json in place (no copies)
    comp = await serve([{ prefix: '/wb/reader.js', file: path.join(WB, 'exporters', 'composition-data', 'reader.js') }, { prefix: '/wb/edl.json', file: EF },
      { prefix: '/assets/', dir: PD }, { prefix: '/', dir: COMP }]);
    cpg = await browser.newPage(); await cpg.setViewport({ width: 320, height: 180, deviceScaleFactor: 1 });
    cpg.on('pageerror', e => console.error('v22 composition pageerror', e.message));
    // render frame t of the composition as it stands (a fresh load: the build reads edl.json), screenshot, mean colour
    const render = async (t, name) => {
      await cpg.bringToFront(); await cpg.goto(comp.url + 'index.html', { waitUntil: 'load' });
      const r = await cpg.evaluate((x) => window.renderAt(x).then(r => r && { shot: r.shot, status: r.status, file: r.file, media_ms: r.media_ms, reason: r.placeholder?.reason || null }), t);
      const png = await cpg.screenshot({ clip: { x: 0, y: 0, width: 320, height: 180 } });
      fs.writeFileSync(path.join(OUT, `${name}.png`), png);
      const px = rgb(png, 8, 8); let R = 0, G = 0, B = 0; for (let i = 0; i < px.length; i += 3) { R += px[i]; G += px[i + 1]; B += px[i + 2]; }
      const k = px.length / 3, c = [Math.round(R / k), Math.round(G / k), Math.round(B / k)];
      return { r, c, png, edl: await cpg.evaluate(() => window.__edl) };
    };
    const is = (c, want) => want === 'grey' ? Math.max(...c) - Math.min(...c) < 24 && c[0] > 90 && c[0] < 170
      : want === 'green' ? c[1] > 180 && c[0] < 70 && c[2] < 70 : want === 'blue' ? c[2] > 180 && c[0] < 70 && c[1] < 70 : want === 'red' ? c[0] > 180 && c[1] < 70 && c[2] < 70 : false;

    // 1. the takes, registered and linked to the shot (as an import or the runner would)
    const A = (await tool('media_add', { path: 'media/clip/e9_takeA.webm', kind: 'clip', label: 'take A (red, then green)', shots: [SHOT] })).body?.media;
    const B = (await tool('media_add', { path: 'media/clip/e9_takeB.webm', kind: 'clip', label: 'take B (blue)', shots: [SHOT] })).body?.media;
    const e0 = await tool('composition_export', {});
    const f0 = await render(N, 'v22_frame_unpicked');
    check('two takes registered on the shot; before any pick the export makes every shot a placeholder and the test composition (reader.js via <script src>) renders frame N as the placeholder card',
      madeA && madeB && A?.duration_ms === 2000 && B?.duration_ms === 2000 && !e0.error && e0.body.counts?.picked === 0 && f0.r?.status === 'placeholder' && f0.r.reason === 'unpicked' && is(f0.c, 'grey'),
      { A: A?.id, B: B?.id, e0: e0.body?.counts || e0.text, r: f0.r, c: f0.c });

    // 2. the director picks take A at in 1000 ms (the page's own act), then exports from the page: File › Export composition data…
    const pa = await call('take_act', { act: 'pick', shot: SHOT, media: A.id, in_ms: 1000, out_ms: 2000 }, true);
    pg = await browser.newPage(); await pg.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v22 pageerror', e.stack || e.message));
    await pg.goto(`${BASE}/?project=${P}`); await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    const inMenu = await pg.evaluate(() => !!window.WB.commands.get?.('file.exportComposition') || (window.WB.commands.list?.() || []).some(c => c.id === 'file.exportComposition'));
    await pg.evaluate(() => { window.WB.commands.run('file.exportComposition'); });
    await pg.waitForFunction(() => /picked/.test(document.querySelector('.cxdlg .cxsum')?.textContent || ''), { timeout: 10000 });
    const sum = await pg.evaluate(() => document.querySelector('.cxdlg .cxsum').textContent);
    await pg.evaluate(() => document.querySelector('.cxdlg [name=map]').value = ' => assets/');
    await pg.click('.cxdlg [data-x=export]');
    await pg.waitForFunction(() => /written|unchanged/.test(document.querySelector('.cxdlg .cxr')?.textContent || ''), { timeout: 10000 });
    const res = await pg.evaluate(() => document.querySelector('.cxdlg .cxr').textContent);
    const dlg = await pg.$('.cxdlg'); if (dlg) fs.writeFileSync(path.join(OUT, 'v22_dialog.png'), await dlg.screenshot());
    const dA = JSON.parse(fs.readFileSync(EF, 'utf8')), sA = dA.shots.find(s => s.id === SHOT);
    const settings = await pg.evaluate(() => window.WB.store.settings?.composition || null);
    const fA = await render(N, 'v22_frame_takeA');
    check('take A picked in the page (in 1000 ms); the page\'s "Export composition data…" dialog shows the counts and writes edl.json (written + checksum; map and file remembered in settings.json); the composition renders frame N GREEN: take A at 1.2 s (its in-point + 200 ms)',
      pa.status === 200 && /1 picked/.test(sum) && /written/.test(res) && /sha256:/.test(res) && sA?.status === 'picked' && sA.take.file === 'assets/media/clip/e9_takeA.webm' && sA.take.in_ms === 1000
      && settings?.out === 'composition/edl.json' && fA.r?.file === 'assets/media/clip/e9_takeA.webm' && fA.r.media_ms === 1200 && is(fA.c, 'green') && fA.edl?.checksum === dA.checksum,
      { pick: pa.status, inMenu, sum, res: res.slice(0, 160), take: sA?.take, r: fA.r, c: fA.c });
    await pg.evaluate(() => document.querySelector('.cxback')?.remove());

    // 3. take B (blue) at in 0; composition_export over MCP; the same frame N now shows take B
    const pb = await call('take_act', { act: 'pick', shot: SHOT, media: B.id, in_ms: 0, out_ms: 2000 }, true);
    const eB = await tool('composition_export', {});
    const fB = await render(N, 'v22_frame_takeB'), fB2 = await render(N, 'v22_frame_takeB_again');
    const eB2 = await tool('composition_export', {});
    check('take B picked (in 0) -> composition_export (MCP) -> the composition renders the same frame N BLUE: take B at 0.2 s; rendering it again gives the same pixels; exporting the same picks again writes nothing new (changed false, same checksum)',
      pb.status === 200 && !eB.error && eB.body.changed === true && fB.r?.file === 'assets/media/clip/e9_takeB.webm' && fB.r.media_ms === 200 && is(fB.c, 'blue')
      && Buffer.compare(fB.png, fB2.png) === 0 && !eB2.error && eB2.body.changed === false && eB2.body.checksum === eB.body.checksum && fB.edl?.checksum === eB.body.checksum,
      { pick: pb.status, r: fB.r, c: fB.c, same: Buffer.compare(fB.png, fB2.png) === 0, changed: eB2.body?.changed });
    check('frame N differs between take A and take B, and neither is the placeholder (picking a take in the page changes the render)',
      Buffer.compare(fA.png, fB.png) !== 0 && Buffer.compare(f0.png, fA.png) !== 0 && !is(fA.c, 'blue') && !is(fB.c, 'green'), { c0: f0.c, cA: fA.c, cB: fB.c });
  } catch (e) { console.error('v22 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await client?.close().catch(() => {});
    await pg?.close().catch(() => {}); await cpg?.close().catch(() => {});
    await comp?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-composition.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyComposition({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v22 (composition round trip):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
