// EXAMPLE (owner's production only): extract the world-clip EDL (every WORLD.clip use: id, start, end, in, take) from
// the render page <AZEMAR_BASE>/project/clip/index.html by hooking WORLD.clip at build time in headless Chromium.
// Output: data/azemar/_src/edl.json (read by importers/azemar_import.py).
//   AZEMAR_BASE=<folder with project/clip> CHROME_PATH=<chrome.exe> node importers/azemar_extract_edl.mjs
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = path.resolve(process.env.AZEMAR_BASE || path.dirname(WB));
const ROOT = path.join(BASE, 'project', 'clip');
const require = createRequire(path.join(WB, 'package.json'));
const puppeteer = require('puppeteer-core');
const { findChrome } = await import('../tools/chrome.mjs');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { const p = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, b) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); r.end(b); }); }).listen(8931);
const b = await puppeteer.launch({ executablePath: findChrome(), headless: true });
const pg = await b.newPage(); await pg.setViewport({ width: 1280, height: 720 });
await pg.evaluateOnNewDocument(() => {
  window.__edl = []; let W;
  Object.defineProperty(window, 'WORLD', { configurable: true, get() { return W; }, set(v) {
    const orig = v.clip; v.clip = function (parent, id, o) { try { window.__edl.push({ id, start: o.start, end: o.end, in: o.in || 0, take: o.take || 0, rate: o.rate || 1, label: o.label || '' }); } catch (e) {} return orig.apply(this, arguments); }; W = v; } });
});
pg.on('pageerror', e => console.error('pageerror', e.message));
await pg.goto('http://localhost:8931/index.html', { waitUntil: 'load', timeout: 120000 });
let n = -1; for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 1500)); const m = await pg.evaluate(() => window.__edl.length); if (m > 0 && m === n) break; n = m; }
const edl = await pg.evaluate(() => window.__edl);
const out = path.join(process.env.WORKBENCH_DATA || path.join(WB, 'data'), 'azemar', '_src', 'edl.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(edl, null, 1));
console.log(edl.length, 'uses');
await b.close(); srv.close();
