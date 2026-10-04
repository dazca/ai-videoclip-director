#!/usr/bin/env node
// HyperFrames HTML package exporter: the composition ITSELF, packaged 1:1, playable in any browser with the official
// <hyperframes-player>. Nothing is trimmed, re-encoded or re-timed; compression is a separate, later step that reads
// manifest.json.
//
//   node export.mjs <compositionDir> <outDir> [--entry index.html] [--sample-fps 10] [--hyperframes <dir>]
//                   [--hf-version 0.8.114]
//
// outDir/
//   index.html                     wrapper: the official player, full window, its own controls, nothing else
//   _hyperframes/                  vendored player + runtime (the player's CDN runtime URL points here: one rewrite)
//   composition/                   every file the composition uses, byte-identical, same relative layout
//   manifest.json                  assets {path, kind, bytes, sha256, mime, media facts, usage}, totals, composition
//
// What is collected: static references (HTML src/href/poster/srcset/data-composition-src, inline and linked CSS url()
// and @import, string literals in loaded scripts that name an existing file) plus every request the composition makes
// at runtime, recorded while a headless Chrome steps the whole timeline through the player (sample-fps per second).
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, copyFileSync, realpathSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative, extname, posix, sep, basename } from 'node:path';
import { serve, launch, kindOf, mimeOf, sha256, mediaInfo, sleep, argv, flag } from './lib.mjs';

const VALUED = ['--entry', '--sample-fps', '--hyperframes', '--hf-version'];
const [compArg, outArg] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && VALUED.includes(all[i - 1])));
if (!compArg || !outArg) {
  console.error('usage: node export.mjs <compositionDir> <outDir> [--entry index.html] [--sample-fps 10] [--hyperframes <dir>] [--hf-version X]');
  process.exit(2);
}
const COMP = resolve(compArg), OUT = resolve(outArg), ENTRY = argv('--entry', 'index.html').replace(/\\/g, '/');
const SFPS = Number(argv('--sample-fps', 10));
const CDIR = 'composition', HDIR = '_hyperframes';
if (!existsSync(join(COMP, ENTRY))) { console.error(`entry not found: ${join(COMP, ENTRY)}`); process.exit(2); }
if (OUT === COMP) { console.error('outDir must differ from the composition folder'); process.exit(2); }
if (OUT.startsWith(COMP + sep)) console.warn('note: outDir is inside the composition folder; it is never collected (requests only reach the composition through the server).');
const log = (s) => console.log(s);
const toPosix = (p) => p.split(sep).join('/');

// ---------------------------------------------------------------- 1. the official player + runtime
async function hyperframesFiles() {
  const want = ['hyperframes-player.global.js', 'hyperframe.runtime.iife.js'];
  const cands = [];
  if (argv('--hyperframes')) cands.push(resolve(argv('--hyperframes')));
  for (let d = COMP; ; d = dirname(d)) { cands.push(join(d, 'node_modules', 'hyperframes', 'dist')); if (dirname(d) === d) break; }
  for (const c of cands) if (want.every((f) => existsSync(join(c, f)))) {
    let version = null; try { version = JSON.parse(readFileSync(join(c, '..', 'package.json'), 'utf8')).version; } catch {}
    return { from: c, version, player: readFileSync(join(c, want[0])), runtime: readFileSync(join(c, want[1])) };
  }
  const v = argv('--hf-version');
  if (!v) throw new Error('no local hyperframes package found (node_modules/hyperframes/dist); pass --hyperframes <dist dir> or --hf-version <x.y.z> to download from jsDelivr');
  const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return Buffer.from(await r.arrayBuffer()); };
  return { from: `jsdelivr @${v}`, version: v, player: await get(`https://cdn.jsdelivr.net/npm/@hyperframes/player@${v}/dist/hyperframes-player.global.js`),
    runtime: await get(`https://cdn.jsdelivr.net/npm/@hyperframes/core@${v}/dist/hyperframe.runtime.iife.js`) };
}
const HF = await hyperframesFiles();
// The player injects the runtime into the composition's iframe from a hard-coded jsDelivr URL. Point that one constant
// at the vendored copy next to the player (resolved from the player's own <script src>, so the package can live under
// any path). This is the only change to any file, and it is in the player, not in the composition.
const CDN_RE = /"https:\/\/cdn\.jsdelivr\.net\/npm\/@hyperframes\/core@([^"/]+)\/dist\/hyperframe\.runtime\.iife\.js"/g;
const playerSrc = HF.player.toString('utf8'), cdnHits = [...playerSrc.matchAll(CDN_RE)];
if (cdnHits.length !== 1) throw new Error(`expected exactly one runtime CDN URL in the player, found ${cdnHits.length}`);
const RUNTIME_EXPR = 'new URL("hyperframe.runtime.iife.js",document.currentScript&&document.currentScript.src||location.href).href';
const playerPatched = Buffer.from(playerSrc.replace(CDN_RE, RUNTIME_EXPR), 'utf8');
const runtimeVersionInPlayer = cdnHits[0][1];
const rewrites = [{ file: `${HDIR}/hyperframes-player.global.js`, what: 'runtime URL constant (the player injects this script into the composition iframe)',
  from: cdnHits[0][0].slice(1, -1), to: `${HDIR}/hyperframe.runtime.iife.js (resolved next to the player script)` }];
if (HF.version && HF.version !== runtimeVersionInPlayer) console.warn(`warning: player expects runtime ${runtimeVersionInPlayer}, vendored package is ${HF.version}`);

// ---------------------------------------------------------------- 2. wrapper
const entryHtml = readFileSync(join(COMP, ENTRY), 'utf8');
const title = ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(entryHtml) || [])[1] || 'HyperFrames composition').trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const entryUrl = `${CDIR}/${ENTRY.split('/').map(encodeURIComponent).join('/')}`;
const wrapper = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}hyperframes-player{display:block;width:100vw;height:100vh}</style>
</head>
<body>
<hyperframes-player src="${esc(entryUrl)}" controls></hyperframes-player>
<script src="${HDIR}/hyperframes-player.global.js"></script>
</body>
</html>
`;

// ---------------------------------------------------------------- 3. static references
const staticRefs = new Map(); // composition-relative posix path -> Set(of referrers)
const external = new Set();
function addRef(fromFileRel, ref, baseRel) {
  if (!ref) return;
  ref = ref.trim().replace(/^['"]|['"]$/g, '');
  if (!ref || ref.startsWith('#') || /^(data|blob|javascript|about|mailto):/i.test(ref)) return;
  if (/^(https?:)?\/\//i.test(ref)) { external.add(ref); return; }
  const clean = ref.split('#')[0].split('?')[0];
  let p;
  try { p = decodeURIComponent(clean); } catch { p = clean; }
  p = p.startsWith('/') ? posix.normalize(p.slice(1)) : posix.normalize(posix.join(baseRel, p));
  if (p.startsWith('..')) { (staticRefs.outside ||= new Set()).add(`${fromFileRel}: ${ref}`); return; }
  if (!staticRefs.has(p)) staticRefs.set(p, new Set());
  staticRefs.get(p).add(fromFileRel + (ref.startsWith('/') ? ' (root-absolute)' : ''));
}
const scanned = new Set();
function scanFile(rel, docBase) {
  if (scanned.has(rel)) return; scanned.add(rel);
  const abs = join(COMP, rel); if (!existsSync(abs) || !statSync(abs).isFile()) return;
  const k = kindOf(rel), text = () => readFileSync(abs, 'utf8'), dir = posix.dirname(rel);
  const cssUrls = (src, base) => {
    for (const m of src.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) addRef(rel, m[2], base);
    for (const m of src.matchAll(/@import\s+(['"])([^'"]+)\1/g)) addRef(rel, m[2], base);
  };
  if (k === 'html') {
    const s = text();
    const base = dir === '.' ? '' : dir;
    for (const m of s.matchAll(/<(script|img|video|audio|source|track|link|iframe|image|use|embed|object|input)\b([^>]*)>/gi)) {
      const attrs = m[2];
      for (const a of attrs.matchAll(/\b(src|href|xlink:href|poster|data|data-composition-src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) addRef(rel, a[3] ?? a[4] ?? a[5], base);
      const ss = /\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
      if (ss) for (const part of (ss[2] ?? ss[3]).split(',')) addRef(rel, part.trim().split(/\s+/)[0], base);
    }
    for (const m of s.matchAll(/\bdata-composition-src\s*=\s*("([^"]*)"|'([^']*)')/gi)) addRef(rel, m[2] ?? m[3], base);
    for (const m of s.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssUrls(m[1], base);
    for (const m of s.matchAll(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) cssUrls(m[2] ?? m[3], base);
    for (const m of s.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) scanJsLiterals(rel, m[1], docBase ?? base);
  } else if (k === 'css') cssUrls(text(), dir === '.' ? '' : dir);
  else if (k === 'script') scanJsLiterals(rel, text(), docBase ?? '');
}
// String literals in a loaded script that name an existing file (relative to the document, as the browser resolves them).
function scanJsLiterals(rel, src, base) {
  for (const m of src.matchAll(/(["'`])((?:\.{0,2}\/)?[\w@.\-~ %()+]+(?:\/[\w@.\-~ %()+]+)*\.[A-Za-z0-9]{2,5})\1/g)) {
    const lit = m[2]; if (/^(https?:)?\/\//.test(lit)) continue;
    const p = lit.startsWith('/') ? lit.slice(1) : posix.normalize(posix.join(base, lit));
    if (!p.startsWith('..') && existsSync(join(COMP, p)) && statSync(join(COMP, p)).isFile()) addRef(rel + ' (js literal)', lit, base);
  }
}
const entryBase = posix.dirname(ENTRY) === '.' ? '' : posix.dirname(ENTRY);
scanFile(ENTRY, entryBase);
for (let changed = true; changed;) { // follow css/js/html found statically
  changed = false;
  for (const p of [...staticRefs.keys()]) if (!scanned.has(p) && ['css', 'script', 'html'].includes(kindOf(p))) { scanFile(p, kindOf(p) === 'html' ? (posix.dirname(p) === '.' ? '' : posix.dirname(p)) : entryBase); changed = true; }
}
log(`static scan: ${staticRefs.size} references (${[...staticRefs.keys()].filter((p) => existsSync(join(COMP, p))).length} exist), ${external.size} external URLs`);

// ---------------------------------------------------------------- 4. headless pass through the player
const hfContent = new Map([[`/${HDIR}/hyperframes-player.global.js`, playerPatched], [`/${HDIR}/hyperframe.runtime.iife.js`, HF.runtime], ['/index.html', Buffer.from(wrapper)], ['/', Buffer.from(wrapper)]]);
const srv = await serve([{ content: hfContent }, { prefix: `/${CDIR}/`, dir: COMP }, { prefix: '/', dir: COMP }]); // last: root-absolute refs
const browser = await launch();
const page = await browser.newPage();
const errors = [], netFails = [], browserReqs = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('request', (q) => browserReqs.push({ url: q.url(), type: q.resourceType() }));
page.on('requestfailed', (q) => { const f = q.failure() && q.failure().errorText; if (f !== 'net::ERR_ABORTED') netFails.push(`${q.url()} ${f}`); });
let W = 1920, H = 1080;
{ const m = /data-width\s*=\s*["']?(\d+)/.exec(entryHtml), n = /data-height\s*=\s*["']?(\d+)/.exec(entryHtml); if (m) W = +m[1]; if (n) H = +n[1]; }
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const t0 = Date.now();
await page.goto(srv.url + 'index.html', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => { const p = document.querySelector('hyperframes-player'); return p && p.ready && p.duration > 0; }, { timeout: 300000, polling: 200 });
await page.waitForFunction(() => document.querySelector('hyperframes-player').assetsReady, { timeout: 300000, polling: 200 }).catch(() => log('warning: player never reported assetsReady'));
const meta = await page.evaluate(() => { const p = document.querySelector('hyperframes-player'); return { duration: p.duration, width: p.compositionWidth, height: p.compositionHeight }; });
const frame = () => page.frames().find((f) => f.url().includes(`/${CDIR}/`));
const cf = frame(); if (!cf) throw new Error('composition iframe not found');
const compMeta = await cf.evaluate(() => {
  const r = document.querySelector('[data-composition-id]');
  const fps = (window.__player && typeof window.__player.getFps === 'function' && window.__player.getFps()) || null;
  return { id: r && r.getAttribute('data-composition-id'), dataDuration: r && Number(r.getAttribute('data-duration')) || null, fps, runtime: !!window.__hf || !!window.__player };
});
log(`player ready in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${meta.width}x${meta.height}, ${meta.duration} s`);

// step the timeline; each sample lists [url, tag, visible, audible, mediaTime, elementId]
await cf.evaluate(() => {
  const ids = new WeakMap(); let next = 1;
  const id = (el) => { if (!ids.has(el)) ids.set(el, next++); return ids.get(el); };
  const URLRE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  window.__hfxSample = (t) => {
    const root = document.querySelector('[data-composition-id]'), R = root.getBoundingClientRect(), out = [];
    const onScreen = (el) => {
      if (!el.isConnected) return false;
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > R.left && r.left < R.right && r.bottom > R.top && r.top < R.bottom;
    };
    for (const el of document.querySelectorAll('video,audio')) {
      const src = el.currentSrc || el.src || (el.querySelector('source') || {}).src; if (!src) continue;
      const ds = el.getAttribute('data-start'), dd = el.getAttribute('data-duration');
      const s = ds !== null && ds !== '' && !isNaN(+ds) ? +ds : null, d = dd !== null && dd !== '' && !isNaN(+dd) ? +dd : null;
      const inWin = s === null || (t >= s && (d === null || t < s + d));
      const vis = el.tagName === 'VIDEO' ? onScreen(el) : false;
      const muted = el.muted || el.hasAttribute('muted') || el.volume === 0;
      const aud = inWin && !muted;
      // HyperFrames media timing: mediaTime = data-media-start + (t - data-start) * rate (what the runtime and the
      // renderer seek to); the element's own currentTime when the composition declares no timing
      const ms = Number(el.getAttribute('data-media-start')) || 0, rate = Number(el.getAttribute('data-playback-rate')) || 1;
      const mt = s !== null ? ms + Math.max(0, t - s) * rate : el.currentTime;
      out.push([src, el.tagName.toLowerCase(), vis ? 1 : 0, aud ? 1 : 0, Math.round(mt * 1000) / 1000, id(el),
        el.className && typeof el.className === 'string' ? el.className : '', getComputedStyle(el).filter !== 'none' ? getComputedStyle(el).filter : '']);
    }
    for (const el of document.querySelectorAll('img')) { const src = el.currentSrc || el.src; if (src) out.push([src, 'img', onScreen(el) ? 1 : 0, 0, null, id(el), '', '']); }
    for (const el of document.querySelectorAll('image')) { const src = el.href && el.href.baseVal; if (src) out.push([new URL(src, document.baseURI).href, 'svg-image', onScreen(el) ? 1 : 0, 0, null, id(el), '', '']); }
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO' || el.tagName === 'IMG') continue;
      const cs = getComputedStyle(el), bg = cs.backgroundImage, mk = cs.webkitMaskImage || cs.maskImage;
      if ((!bg || bg === 'none') && (!mk || mk === 'none')) continue;
      const v = onScreen(el) ? 1 : 0;
      for (const val of [bg, mk]) if (val && val !== 'none') for (const m of val.matchAll(URLRE)) if (!m[2].startsWith('data:')) out.push([m[2], 'css', v, 0, null, 0, '', '']);
    }
    // fonts: every ~second, the font-family stacks of on-screen text
    if (Math.abs(t * 1 - Math.round(t)) < 1e-6) {
      const stacks = window.__hfxFonts ||= {};
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement; if (!el || seen.has(el) || !n.nodeValue.trim()) continue; seen.add(el);
        if (!onScreen(el)) continue;
        const f = getComputedStyle(el).fontFamily; stacks[f] = (stacks[f] || 0) + 1;
      }
    }
    return out;
  };
});
const D = meta.duration, step = 1 / SFPS, N = Math.floor(D * SFPS + 1e-6) + 1;
const samples = []; // {t, list}
const tPass = Date.now();
for (let i = 0; i < N; i++) {
  const t = Math.min(i * step, Math.max(0, D - 1e-3));
  await page.evaluate((t) => document.querySelector('hyperframes-player').seek(t), t);
  const list = await cf.evaluate((t) => new Promise((r) => requestAnimationFrame(() => r(window.__hfxSample(t)))), t);
  samples.push({ t, list });
  if (i % Math.max(1, Math.round(N / 10)) === 0) process.stdout.write(`  pass ${Math.round(i / N * 100)}% (t=${t.toFixed(1)} s)\r`);
}
log(`timeline pass: ${N} samples at ${SFPS}/s in ${((Date.now() - tPass) / 1000).toFixed(0)} s                `);
// short real-time play so anything only loaded while playing is requested too
await page.evaluate(() => { const p = document.querySelector('hyperframes-player'); p.seek(0); p.play(); });
await sleep(3000);
await page.evaluate(() => document.querySelector('hyperframes-player').pause());
await sleep(500);
const fontInfo = await cf.evaluate(() => ({ runtime: !!(window.__hf || window.__player), stacks: window.__hfxFonts || {}, declared: (() => {
  // @font-face rules: packaged when a src is a url() (a file or data: URI), system when only local()
  const out = {}, walk = (rules) => { for (const r of rules) { try {
    if (r instanceof CSSFontFaceRule) { const fam = r.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, ''); const src = r.style.getPropertyValue('src'); out[fam] = out[fam] || /url\(/.test(src); }
    else if (r.cssRules) walk(r.cssRules); else if (r.styleSheet) walk(r.styleSheet.cssRules);
  } catch {} } };
  for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch {} }
  for (const f of document.fonts) { const fam = f.family.replace(/^["']|["']$/g, ''); if (!(fam in out)) out[fam] = true; } // FontFace objects made in JS
  return out;
})() }));
await browser.close();
await srv.close();
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont']);
const declared = Object.keys(fontInfo.declared);
const fonts = { font_faces: Object.fromEntries(declared.sort().map((f) => [f, fontInfo.declared[f] ? 'file' : 'local() only (system font)'])), text_stacks: [], system_fonts: [] };
for (const [stack, n] of Object.entries(fontInfo.stacks).sort((a, b) => b[1] - a[1])) {
  const fams = stack.split(',').map((f) => f.trim().replace(/^["']|["']$/g, ''));
  const first = fams[0], face = declared.find((d) => d.toLowerCase() === first.toLowerCase()), packaged = !!(face && fontInfo.declared[face]);
  fonts.text_stacks.push({ stack, primary: first, packaged, on_screen_seconds: n });
  if (!packaged && !GENERIC.has(first.toLowerCase()) && !fonts.system_fonts.includes(first)) fonts.system_fonts.push(first);
}

// ---------------------------------------------------------------- 5. the file set
const compUrlPrefix = `${srv.url}${CDIR}/`;
const urlToRel = (u) => {
  if (!u.startsWith(srv.url)) return null;
  let p = u.slice(srv.url.length).split('#')[0].split('?')[0];
  try { p = decodeURIComponent(p); } catch {}
  if (p.startsWith(CDIR + '/')) return { rel: p.slice(CDIR.length + 1), abs: false };
  if (p === '' || p === 'index.html' || p.startsWith(HDIR + '/')) return null;
  return { rel: p, abs: true }; // root-absolute reference that bypassed composition/
};
const files = new Map(); // rel -> {sources:Set, absolute:bool, requests:n, status}
const missing = new Map(); // rel -> {statuses, method}
const absoluteRefs = new Set();
const touch = (rel, src) => { if (!files.has(rel)) files.set(rel, { sources: new Set(), requests: 0, bytesServed: 0 }); files.get(rel).sources.add(src); return files.get(rel); };
for (const r of srv.log) {
  let p = r.path.replace(/^\//, '');
  if (p === '' || p === 'index.html' || p.startsWith(HDIR + '/')) continue;
  const abs = !p.startsWith(CDIR + '/'); if (!abs) p = p.slice(CDIR.length + 1);
  if (p === '' ) p = 'index.html';
  if (r.status >= 400) { const m = missing.get(p) || { statuses: new Set(), methods: new Set() }; m.statuses.add(r.status); m.methods.add(r.method); missing.set(p, m); continue; }
  if (abs) absoluteRefs.add(p);
  const f = touch(p, 'runtime-request'); f.requests++; f.bytesServed += r.bytes;
}
for (const [p] of staticRefs) if (existsSync(join(COMP, p)) && statSync(join(COMP, p)).isFile()) touch(p, 'static');
const usageRaw = new Map(); // rel -> [{t, tag, vis, aud, m, el, cls, filter}]
for (const s of samples) for (const [u, tag, vis, aud, m, el, cls, filter] of s.list) {
  const r = urlToRel(u); if (!r) { if (/^https?:/.test(u)) external.add(u); continue; }
  if (r.abs) absoluteRefs.add(r.rel);
  if (existsSync(join(COMP, r.rel))) touch(r.rel, 'dom');
  if (!usageRaw.has(r.rel)) usageRaw.set(r.rel, []);
  usageRaw.get(r.rel).push({ t: s.t, tag, vis, aud, m, el, cls, filter });
}
for (const q of browserReqs) if (/^https?:/.test(q.url) && !q.url.startsWith(srv.url)) external.add(q.url);
files.delete(''); // never the folder itself
for (const p of [...files.keys()]) if (!existsSync(join(COMP, p)) || !statSync(join(COMP, p)).isFile()) files.delete(p);
for (const p of missing.keys()) if (files.has(p)) missing.delete(p); // a later request succeeded

// ---------------------------------------------------------------- 6. copy byte-identical
if (existsSync(OUT)) {
  // only ever clear a previous export of ours
  const prev = join(OUT, 'manifest.json');
  if (readdirSync(OUT).length && !(existsSync(prev) && /"exporter":\s*"hyperframes-html"/.test(readFileSync(prev, 'utf8')))) { console.error(`refusing to overwrite ${OUT}: not empty and not a previous hyperframes-html export`); process.exit(2); }
  rmSync(OUT, { recursive: true, force: true });
}
mkdirSync(join(OUT, HDIR), { recursive: true });
writeFileSync(join(OUT, 'index.html'), wrapper);
writeFileSync(join(OUT, HDIR, 'hyperframes-player.global.js'), playerPatched);
writeFileSync(join(OUT, HDIR, 'hyperframe.runtime.iife.js'), HF.runtime);
const assets = [];
for (const rel of [...files.keys()].sort()) {
  const src = join(COMP, rel), real = realpathSync(src), dst = join(OUT, CDIR, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(real, dst);
  const h = sha256(dst);
  if (h !== sha256(real)) throw new Error(`copy mismatch: ${rel}`);
  const st = statSync(dst), kind = kindOf(rel);
  const a = { path: `${CDIR}/${rel}`, kind, bytes: st.size, sha256: h, mime: mimeOf(rel), found_by: [...files.get(rel).sources].sort() };
  if (real !== resolve(src)) a.resolved_from = toPosix(relative(COMP, real)).startsWith('..') ? '(outside the composition folder, via a junction/symlink)' : toPosix(relative(COMP, real));
  if (staticRefs.has(rel)) a.referenced_by = [...staticRefs.get(rel)].sort();
  if (['video', 'audio', 'image'].includes(kind)) Object.assign(a, mediaInfo(real, kind));
  a.usage = usageOf(rel, a);
  assets.push(a);
}
// root-absolute references: the package nests the composition under composition/, so "/x" would miss. Rewrite them
// to document-relative paths in the text files that contain them (reported one by one).
for (const p of absoluteRefs) {
  for (const a of assets.filter((x) => ['html', 'css', 'script', 'data'].includes(x.kind))) {
    const f = join(OUT, a.path), s = readFileSync(f, 'utf8');
    const fileDir = posix.dirname(a.path.slice(CDIR.length + 1)), base = a.kind === 'css' ? fileDir : entryBase;
    const relTo = posix.relative(base === '.' ? '' : base, p) || p;
    const re = new RegExp(`(["'(])/${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(["')])`, 'g');
    const n = (s.match(re) || []).length;
    if (n) {
      writeFileSync(f, s.replace(re, `$1${relTo}$2`));
      const h = sha256(f); a.rewritten = { original_sha256: a.sha256 }; a.sha256 = h; a.bytes = statSync(f).size;
      rewrites.push({ file: a.path, what: `root-absolute reference x${n}`, from: `/${p}`, to: relTo });
    }
  }
}

function usageOf(rel, a) {
  const raw = usageRaw.get(rel);
  if (a.kind === 'font') return { note: 'font: loaded by the document, used whenever its family is on screen' };
  if (!raw) return a.kind === 'video' || a.kind === 'audio' || a.kind === 'image'
    ? { observed: false, note: 'requested, but never found on an element during the pass (e.g. drawn to a canvas, preloaded, or decoded off-DOM)' } : undefined;
  const isMedia = a.kind === 'video' || a.kind === 'audio';
  const on = raw.filter((x) => x.vis || x.aud).sort((p, q) => p.t - q.t);
  const merge = (ranges) => { const r = ranges.slice().sort((p, q) => p[0] - q[0]), o = []; for (const x of r) { const l = o[o.length - 1]; if (l && x[0] <= l[1] + 1e-6) l[1] = Math.max(l[1], x[1]); else o.push(x.slice()); } return o.map(([p, q]) => [+p.toFixed(3), +q.toFixed(3)]); };
  const ranges = (pred) => { const o = []; let cur = null; const ts = [...new Set(raw.filter(pred).map((x) => x.t))].sort((p, q) => p - q); for (const t of ts) { if (cur && t - cur[1] <= step * 1.5 + 1e-6) cur[1] = t + step; else { cur = [t, t + step]; o.push(cur); } } return merge(o.map(([p, q]) => [p, Math.min(q, D)])); };
  const u = { visible: ranges((x) => x.vis), elements: [...new Set(raw.map((x) => x.el).filter(Boolean))].length || undefined };
  if (isMedia) {
    u.audible = ranges((x) => x.aud);
    // per element: segments where media time advances with the timeline: {t0, t1, m0, m1}
    const segs = [];
    const byEl = new Map(); for (const x of on) { if (!byEl.has(x.el)) byEl.set(x.el, []); byEl.get(x.el).push(x); }
    for (const list of byEl.values()) {
      let s = null;
      for (const x of list) {
        if (s && x.t - s.lastT <= step * 1.5 + 1e-6 && x.m >= s.lastM - 1e-3 && x.m - s.lastM <= (x.t - s.lastT) * 4 + 0.05) { s.lastT = x.t; s.lastM = x.m; s.m1 = Math.max(s.m1, x.m); }
        else { s = { t0: x.t, lastT: x.t, m0: x.m, lastM: x.m, m1: x.m }; segs.push(s); }
      }
    }
    const dur = a.duration || Infinity;
    u.segments = segs.map((s) => ({ t0: +s.t0.toFixed(3), t1: +Math.min(s.lastT + step, D).toFixed(3), m0: +s.m0.toFixed(3), m1: +Math.min(s.m1 + (s.m1 > s.m0 || s.lastT > s.t0 ? step : 0), dur).toFixed(3) })).sort((p, q) => p.t0 - q.t0);
    u.media_ranges = merge(u.segments.map((s) => [s.m0, Math.max(s.m1, s.m0)]));
    const used = u.media_ranges.reduce((acc, [p, q]) => acc + (q - p), 0);
    if (a.duration) u.media_used_fraction = +(Math.min(1, used / a.duration)).toFixed(3);
    const cls = [...new Set(raw.map((x) => x.cls).filter(Boolean))], fil = [...new Set(raw.map((x) => x.filter).filter(Boolean))];
    if (cls.length) u.element_classes = cls.slice(0, 8);
    if (fil.length) u.element_filters = fil.slice(0, 8); // e.g. an SVG filter that decodes a stacked-alpha layout
  }
  u.on_screen_seconds = +u.visible.reduce((s, [p, q]) => s + q - p, 0).toFixed(2);
  if (isMedia) u.audible_seconds = +u.audible.reduce((s, [p, q]) => s + q - p, 0).toFixed(2);
  u.tags = [...new Set(raw.map((x) => x.tag))];
  return u;
}

// ---------------------------------------------------------------- 7. manifest
const totals = {};
for (const a of assets) { const t = totals[a.kind] ||= { files: 0, bytes: 0 }; t.files++; t.bytes += a.bytes; }
const pkgBytes = (p) => statSync(join(OUT, p)).size;
totals.player = { files: 3, bytes: pkgBytes('index.html') + pkgBytes(`${HDIR}/hyperframes-player.global.js`) + pkgBytes(`${HDIR}/hyperframe.runtime.iife.js`) };
const all = Object.values(totals).reduce((s, t) => ({ files: s.files + t.files, bytes: s.bytes + t.bytes }), { files: 0, bytes: 0 });
const manifest = {
  exporter: 'hyperframes-html', version: 1, created: new Date().toISOString(),
  composition: {
    entry: `${CDIR}/${ENTRY}`, title, id: compMeta.id, width: meta.width, height: meta.height, duration: meta.duration,
    fps: compMeta.fps, data_duration: compMeta.dataDuration,
  },
  player: { package_version: HF.version, runtime_version: runtimeVersionInPlayer, source: HF.from.includes('jsdelivr') ? HF.from : 'local node_modules/hyperframes/dist', files: [`${HDIR}/hyperframes-player.global.js`, `${HDIR}/hyperframe.runtime.iife.js`],
    runtime_injected_during_pass: fontInfo.runtime, note: fontInfo.runtime ? 'the player injected the vendored runtime' : 'the player drove window.__timelines directly and never injected the runtime for this composition; the vendored runtime is there for compositions that need it (e.g. nested data-composition-src)' },
  pass: { sample_fps: SFPS, samples: N, note: 'usage = sampled while seeking the player through the whole timeline; ranges are [t0, t1) seconds, accurate to 1/sample_fps' },
  totals: { ...totals, all },
  rewrites,
  missing_in_source: [...missing].map(([p, m]) => ({ path: p, status: [...m.statuses], methods: [...m.methods], note: 'requested by the composition but absent in the source folder too (e.g. an existence probe); not packaged' })),
  outside_refs: staticRefs.outside ? [...staticRefs.outside] : [],
  fonts: { ...fonts, note: 'system_fonts are not in the package: the viewer machine supplies them, as the render machine did; text_stacks counts element-seconds sampled once per second' },
  external: [...external].sort(),
  page_errors: [...new Set(errors)].slice(0, 50),
  network_failures: netFails,
  assets,
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));

const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
log(`\n${OUT}`);
log(`  ${all.files} files, ${mb(all.bytes)}`);
for (const [k, t] of Object.entries(totals)) log(`  ${k.padEnd(8)} ${String(t.files).padStart(4)} files  ${mb(t.bytes).padStart(10)}`);
log(`  HyperFrames runtime injected by the player: ${fontInfo.runtime ? 'yes (vendored copy)' : 'no (player drives __timelines directly)'}`);
log(`  rewrites: ${rewrites.length}${rewrites.map((r) => `\n    ${r.file}: ${r.from} -> ${r.to}`).join('')}`);
if (missing.size) log(`  requested but missing in the source too (not packaged): ${[...missing.keys()].slice(0, 10).join(', ')}${missing.size > 10 ? ' ...' : ''}`);
if (external.size) log(`  external URLs (not packaged): ${[...external].slice(0, 10).join(', ')}`);
if (fonts.system_fonts.length) log(`  system fonts used by on-screen text (not packaged; supplied by the viewer's OS): ${fonts.system_fonts.join(', ')}`);
if (errors.length) log(`  page errors during the pass: ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
log(`  serve it: node ${toPosix(relative(process.cwd(), join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'serve.mjs')))} ${toPosix(relative(process.cwd(), OUT)) || '.'}`);
