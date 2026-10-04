// Headless test of the sketch tool (core/sketch/): serves the workbench folder with a tiny static server on a free
// port, opens tools/sketch-dev.html in headless Chromium, draws (pen pressure, shapes, fill, mask, pins), checks undo /
// redo, copy/paste into a floating sketch, zoom / pinch, exports and their pixels, and writes screenshots to shots/.
//   node tools/sketch-test.mjs [--headful]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChrome } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

let fails = 0, passes = 0;
const check = (ok, msg) => { if (ok) passes++; else fails++; console.log((ok ? 'ok   ' : 'FAIL ') + msg); };

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: !process.argv.includes('--headful'), args: ['--no-sandbox', '--force-device-scale-factor=1'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(BASE + '/tools/sketch-dev.html', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.SK?.a);
const cdp = await page.createCDPSession();
const shot = async (name) => { const f = path.join(SHOTS, name); await page.screenshot({ path: f }); console.log('     shot ' + path.relative(ROOT, f)); };
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const scr = (x, y, who = 'a') => ev((x, y, who) => SK[who].toScreen(x, y), x, y, who);
const key = async (k, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(k); for (const m of mods.reverse()) await page.keyboard.up(m); };
const settle = () => ev(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
async function drag(points, who = 'a') {   // mouse drag through document points
  const [x0, y0] = await scr(...points[0], who); await page.mouse.move(x0, y0); await page.mouse.down();
  for (const p of points.slice(1)) { const [x, y] = await scr(...p, who); await page.mouse.move(x, y, { steps: 4 }); }
  await page.mouse.up(); await settle();
}
async function penStroke(points) {          // points [x, y, force] in document px, sent as a pen (pressure)
  const send = async (type, [x, y, f]) => { const [sx, sy] = await scr(x, y); await cdp.send('Input.dispatchMouseEvent', { type, x: sx, y: sy, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force: f }); };
  await send('mousePressed', points[0]);
  for (const p of points.slice(1)) await send('mouseMoved', p);
  await send('mouseReleased', points[points.length - 1]); await settle();
}
const clickDoc = async (x, y, who = 'a') => { const [sx, sy] = await scr(x, y, who); await page.mouse.click(sx, sy); await settle(); };
const pixel = (what, x, y, scale = 1) => ev(async (what, x, y, scale) => {
  const cv = what === 'mask' ? SK.a.renderMaskCanvas({ scale }) : await SK.a.renderPNGCanvas({ scale });
  return [...cv.getContext('2d').getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data];
}, what, x, y, scale);

// ---------------------------------------------------------------- 1. empty
await settle();
check(await ev(() => document.querySelectorAll('.sk-bar .sk-b').length) >= 20, 'toolbar rendered');
check(await ev(() => Math.round(document.querySelector('.sk-bar').getBoundingClientRect().height)) === 22, 'toolbar is one 22 px row');
check(await ev(() => [...document.querySelectorAll('.sk-bar button')].every(b => b.getAttribute('aria-label'))), 'every toolbar button has an aria-label');
await shot('sketch-01-empty.png');

// ---------------------------------------------------------------- 2. underlay + drawing
await page.select('#ul', '../data/demo/media/still/studio.jpg');
await page.waitForFunction(() => !document.querySelector('.sk-hud').textContent.includes('loading'));
await settle();
await page.click('.sk-cv', { offset: { x: 5, y: 5 } }); // focus (pen tool on the margin: a dot outside... undo it below)
if (await ev(() => SK.a.get().strokes.length)) await key('z', ['Control']);
await ev(() => SK.a.setColor('#ff3b30'));
await key('b'); await ev(() => SK.a.setSize(14));
const pen = []; for (let i = 0; i <= 30; i++) pen.push([200 + i * 14, 200 + Math.sin(i / 4) * 60, 0.1 + 0.9 * Math.sin(i / 30 * Math.PI)]);
await penStroke(pen);
let s = await ev(() => SK.a.get());
const ps = s.strokes[0]?.pts.map(p => p[2]) || [];
check(s.strokes.length === 1 && s.strokes[0].t === 'pen', 'pen stroke recorded');
check(ps.length > 10 && Math.min(...ps) < 0.3 && Math.max(...ps) > 0.9, `pen pressure recorded (${Math.min(...ps)}..${Math.max(...ps)})`);
await key('r'); await ev(() => SK.a.setColor('#0a84ff')); await ev(() => SK.a.setSize(5));
await drag([[700, 380], [1000, 600]]);
await key('a'); await ev(() => SK.a.setColor('#ffcc00'));
await drag([[150, 600], [420, 420]]);
await key('o'); await ev(() => SK.a.setColor('#34c759'));
await drag([[1050, 120], [1220, 300]]);
await key('l'); await ev(() => SK.a.setColor('#bf5af2'));
await drag([[100, 680], [600, 690]]);
await key('f'); await ev(() => SK.a.setColor('#0a84ff')); await ev(() => SK.a.setOpacity(0.5));
await clickDoc(850, 490);
await ev(() => SK.a.setOpacity(1));
s = await ev(() => SK.a.get());
check(s.strokes.map(x => x.t).join() === 'pen,rect,arrow,ellipse,line,fill', 'tools recorded: ' + s.strokes.map(x => x.t).join());
const inFill = await pixel('png', 850, 490), outFill = await pixel('png', 650, 490);
check(inFill[2] > inFill[0] + 40 && JSON.stringify(inFill) !== JSON.stringify(outFill), `fill painted inside the rectangle (${inFill} vs outside ${outFill})`);
const onPen = await pixel('png', pen[15][0], pen[15][1]);
check(onPen[0] > 200 && onPen[1] < 120, 'pen stroke in the flattened PNG ' + onPen);
await key('e'); await ev(() => SK.a.setSize(30));
await drag([[600, 130], [600, 330]]);
await shot('sketch-02-drawing-underlay.png');

// ---------------------------------------------------------------- 3. eyedropper, selection move
await key('i'); await clickDoc(pen[15][0], pen[15][1]);
const picked = await ev(() => SK.a.color);
check(/^#(f|e)/.test(picked), 'eyedropper picked the red stroke: ' + picked);
await key('v');
const before = (await ev(() => SK.a.get())).strokes[3];
await drag([[1220, 210], [1180, 260]]);        // grab the ellipse's right edge and move it
const after = (await ev(() => SK.a.get())).strokes[3];
check(after.x0 === before.x0 - 40 && after.y0 === before.y0 + 50, `selection move (ellipse ${before.x0},${before.y0} -> ${after.x0},${after.y0})`);

// ---------------------------------------------------------------- 4. mask
await key('m'); await ev(() => SK.a.setSize(90));
await drag([[300, 300], [420, 330], [520, 300]]);
await key('m', ['Shift']); await ev(() => SK.a.setSize(30));
await drag([[420, 250], [420, 400]]);
s = await ev(() => SK.a.get());
check(s.mask.length === 2 && s.mask[0].t === 'paint' && s.mask[1].t === 'erase', 'mask paint + erase recorded');
await key('m');
await shot('sketch-03-mask-mode.png');
const mIn = await pixel('mask', 320, 300), mOut = await pixel('mask', 900, 650), mErased = await pixel('mask', 420, 320);
check(mIn.join() === '255,255,255,255' && mOut.join() === '0,0,0,255' && mErased.join() === '0,0,0,255', `mask PNG white where painted, black elsewhere and where erased (${mIn} / ${mOut} / ${mErased})`);
const binary = await ev(() => { const d = SK.a.renderMaskCanvas().getContext('2d').getImageData(0, 0, SK.a.get().w, SK.a.get().h).data; for (let i = 0; i < d.length; i += 4) if (!((d[i] === 0 || d[i] === 255) && d[i] === d[i + 1] && d[i] === d[i + 2] && d[i + 3] === 255)) return false; return true; });
check(binary, 'mask PNG is strictly black/white');

// ---------------------------------------------------------------- 5. pins
await key('p');
await clickDoc(560, 220);
await page.keyboard.type('necklace, silver, thin'); await key('Enter');
await clickDoc(1100, 520);
await page.keyboard.type('messier hair, more volume on this side'); await key('Enter');
s = await ev(() => SK.a.get());
check(s.pins.length === 2 && s.pins[0].n === 1 && s.pins[1].n === 2 && s.pins[0].text === 'necklace, silver, thin', 'two numbered pins with notes');
check(await ev(() => document.querySelectorAll('.sk-pinlist li').length) === 2, 'pins listed in the side list');
const pinPx = await pixel('png', s.pins[0].x - 7, s.pins[0].y - 4);  // on the badge, beside the digit
check(pinPx[0] > 230 && pinPx[1] > 140 && pinPx[1] < 190 && pinPx[2] < 80, 'pin drawn in the flattened PNG ' + pinPx);
// drag pin 2
const [p2x, p2y] = await scr(1100, 520); await page.mouse.move(p2x, p2y); await page.mouse.down(); await page.mouse.move(p2x - 60, p2y + 40, { steps: 5 }); await page.mouse.up(); await settle();
s = await ev(() => SK.a.get());
check(Math.abs(s.pins[1].x - 1100) > 20, `pin dragged (${s.pins[1].x},${s.pins[1].y})`);
await shot('sketch-04-pins.png');

// ---------------------------------------------------------------- 6. undo / redo
await page.focus('.sk');
const nUndo = await ev(() => JSON.stringify(SK.a.get().pins));
await key('z', ['Control']);
check(await ev(() => SK.a.get().pins[1].x) === 1100, 'undo restores the pin position');
await key('z', ['Control']); await key('z', ['Control']);
check(await ev(() => SK.a.get().pins.length) === 1, 'undo removes the second pin');
await key('z', ['Control', 'Shift']); await key('z', ['Control', 'Shift']); await key('z', ['Control', 'Shift']);
check(await ev(() => JSON.stringify(SK.a.get().pins)) === nUndo, 'redo brings everything back');
const nStrokes = await ev(() => SK.a.get().strokes.length);
let nu = 0; while (nu < 12 && await ev(() => SK.a.get().mask.length) === 2) { await key('z', ['Control']); nu++; }
check(await ev(() => SK.a.get().strokes.length) === nStrokes && await ev(() => SK.a.get().pins.length) === 0 && await ev(() => SK.a.get().mask.length) === 1, `undo walks back through pins and mask (${nu} steps)`);
for (let i = 0; i < nu; i++) await key('z', ['Control', 'Shift']);
check(await ev(() => SK.a.get().mask.length) === 2 && await ev(() => SK.a.get().pins.length) === 2, 'redo restores mask and pins');

// ---------------------------------------------------------------- 7. zoom / pan / pinch
const z0 = await ev(() => SK.a.view.z);
const [cx, cy] = await scr(640, 360);
await page.keyboard.down('Control'); await page.mouse.move(cx, cy); await page.mouse.wheel({ deltaY: -300 }); await page.keyboard.up('Control'); await settle();
const z1 = await ev(() => SK.a.view.z);
check(z1 > z0 * 1.3, `ctrl+wheel zooms (${z0.toFixed(3)} -> ${z1.toFixed(3)})`);
const [cx2, cy2] = await scr(640, 360);
check(Math.abs(cx2 - cx) < 2 && Math.abs(cy2 - cy) < 2, 'zoom keeps the point under the cursor');
await page.keyboard.down('Space'); await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 80, cy + 30, { steps: 3 }); await page.mouse.up(); await page.keyboard.up('Space'); await settle();
check(await ev(() => SK.a.get().strokes.length) === nStrokes, 'space+drag pans without drawing');
await shot('sketch-05-zoomed.png');
await key('1'); check(Math.abs(await ev(() => SK.a.view.z) - 1) < 1e-6, '1 = 100%');
await key('0'); check(Math.abs(await ev(() => SK.a.view.z) - z0) < 1e-6, '0 = fit');
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 400, id: 1 }, { x: 700, y: 400, id: 2 }] });
for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 500 - i * 30, y: 400, id: 1 }, { x: 700 + i * 30, y: 400, id: 2 }] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle();
const zp = await ev(() => SK.a.view.z);
check(zp > z0 * 1.5 && await ev(() => SK.a.get().strokes.length) === nStrokes && await ev(() => SK.a.get().pins.length) === 2, `pinch zooms without drawing or pinning (${z0.toFixed(3)} -> ${zp.toFixed(3)})`);
await key('0');

// ---------------------------------------------------------------- 8. exports
const ex = await ev(async () => {
  const png = await SK.a.exportPNG(), mask = await SK.a.exportMask(), big = await SK.a.exportPNG({ scale: 2 });
  const dims = async (b) => { const i = await createImageBitmap(b); return [i.width, i.height]; };
  const r1 = (await SK.a.renderPNGCanvas()).toDataURL(), r2 = (await SK.a.renderPNGCanvas()).toDataURL();
  const json = SK.a.get(), clone = await SK.renderSketch(JSON.parse(JSON.stringify(json)), { scale: 1 });
  return { png: [png.type, png.size, ...await dims(png)], mask: [mask.type, mask.size, ...await dims(mask)], big: await dims(big), same: r1 === r2, w: json.w, h: json.h, json };
});
check(ex.png[0] === 'image/png' && ex.png[2] === ex.w && ex.png[3] === ex.h, `flattened PNG ${ex.png[2]}x${ex.png[3]}, ${ex.png[1]} B`);
check(ex.mask[0] === 'image/png' && ex.mask[2] === ex.w, `mask PNG ${ex.mask[2]}x${ex.mask[3]}, ${ex.mask[1]} B`);
check(ex.big[0] === ex.w * 2, 'PNG re-renders at 2x from the vectors');
check(ex.same, 'rendering is deterministic (two renders, same bytes)');
fs.writeFileSync(path.join(SHOTS, 'sketch-export.json'), JSON.stringify(ex.json, null, 1));
for (const [n, fn] of [['sketch-export.png', 'exportPNG'], ['sketch-export.mask.png', 'exportMask']]) {
  const b64 = await ev(async (fn) => { const b = await SK.a[fn](); const u8 = new Uint8Array(await b.arrayBuffer()); let s = ''; for (const c of u8) s += String.fromCharCode(c); return btoa(s); }, fn);
  fs.writeFileSync(path.join(SHOTS, n), Buffer.from(b64, 'base64')); console.log('     wrote shots/' + n);
}

// ---------------------------------------------------------------- 9. save
await page.focus('.sk'); await key('s', ['Control']);
await page.waitForFunction(() => SK.saved.length === 1);
const sv = await ev(() => ({ id: SK.saved[0].sketch.id, png: SK.saved[0].png?.size, mask: SK.saved[0].mask?.size, dirty: SK.a.dirty }));
check(sv.png > 1000 && sv.mask > 100 && !sv.dirty, `Ctrl+S calls save(sketch, png, mask) (${sv.png} B / ${sv.mask} B), clean after`);

// ---------------------------------------------------------------- 10. copy -> paste into a floating sketch
await page.focus('.sk'); await key('c', ['Control']);
check(await ev(() => SK.clipboard.has()), 'Ctrl+C copies the sketch to the app clipboard');
await page.click('#float'); await page.waitForFunction(() => SK.b?.el);
await ev(() => SK.b.el.focus());
await key('v', ['Control']); await settle();
const b = await ev(() => SK.b.get()), a = await ev(() => SK.a.get());
check(b.strokes.length === a.strokes.length && b.mask.length === a.mask.length && b.pins.length === 2, `pasted into sketch B (${b.strokes.length} strokes, ${b.mask.length} mask, ${b.pins.length} pins)`);
check(b.strokes[0].pts[5][0] !== undefined && b.w === 1280, 'pasted strokes scaled to the target size');
await ev(() => SK.b.addPin(200, 100, 'third note in B'));
await shot('sketch-06-floating.png');
const wpos = await ev(() => [SK.b.window.offsetLeft, SK.b.window.offsetTop]);
const tb = await ev(() => { const r = SK.b.window.querySelector('.sk-wtitle').getBoundingClientRect(); return [r.left + 60, r.top + 8]; });
await page.mouse.move(...tb); await page.mouse.down(); await page.mouse.move(tb[0] - 100, tb[1] + 40, { steps: 4 }); await page.mouse.up();
const wpos2 = await ev(() => [SK.b.window.offsetLeft, SK.b.window.offsetTop]);
check(wpos2[0] === wpos[0] - 100 && wpos2[1] === wpos[1] + 40, 'floating window drags by its title bar');
await ev(() => SK.b.el.focus()); await key('Escape');
check(await ev(() => SK.b.selection.length === 0 && document.body.contains(SK.b.window)), 'first Esc drops the selection of the pasted strokes');
await key('Escape');
check(await ev(() => !SK.b.el.querySelector('.sk-confirm').hidden && document.body.contains(SK.b.window)), 'Esc on unsaved changes asks first');
await shot('sketch-07-confirm.png');
await page.click('.sk-win [data-cf=discard]');
check(await ev(() => !document.body.contains(SK.b.window)), 'Discard closes the window');

// ---------------------------------------------------------------- 11. duplicate, clear
await page.click('.sk [data-act=dup]'); await page.waitForFunction(() => SK.dup?.el);
const dup = await ev(() => SK.dup.get());
check(dup.id !== a.id && dup.strokes.length === a.strokes.length, 'duplicate = deep copy with a new id');
await ev(() => SK.dup.close(true));
await ev(() => SK.a.clear('sketch'));
check(await ev(() => SK.a.get().strokes.length) === 0, 'clear sketch layer');
await page.focus('.sk'); await key('z', ['Control']);
check(await ev(() => SK.a.get().strokes.length) === nStrokes, 'clear is undoable');

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close(); server.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
