#!/usr/bin/env node
// Verify an HTML package made by export.mjs against the MP4 render of the same composition.
//
//   node verify.mjs <outDir> --against <render.mp4> [--n 12 | --times 4,18.5,...] [--play 6] [--report <dir>]
//                   [--max-mad 5] [--min-psnr 20]
//
// 1. integrity: every asset in manifest.json is present with the recorded sha256
// 2. serves outDir, opens index.html headless (viewport = composition size, so the player shows it at 1:1), waits for
//    the player's ready + assetsReady, checks the runtime came from the package (no request leaves the server)
// 3. frames: seeks through the player API (player.seek) to N frame times of the render, waits until the on-screen
//    media have decoded, screenshots, and compares with the render's frame: mean absolute difference (% of 255) and
//    PSNR (dB) over RGB. The player's control bar is hidden for the captures (controls attribute removed).
// 4. playback: player.play() for --play s, the clock must advance
// 5. requests: no 4xx/5xx except files the composition probes that are missing in the source too
//    (manifest.missing_in_source), no network failures, no page errors
// Exit code 1 on any failure: integrity, requests, page errors, media still pending at a capture, a frame above
// --max-mad (% of 255, default 5) or below --min-psnr (dB, default 20). The render's own noise is ~1-2 % / ~30 dB.
// Writes <report>/verify.json and side-by-side JPEGs (package | render). Default report dir: <outDir>-verify.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { serve, launch, sha256, rgb, ffprobe, sleep, argv } from './lib.mjs';

const OUT = resolve(process.argv[2] || '');
const RENDER = argv('--against');
if (!process.argv[2] || !existsSync(join(OUT, 'manifest.json')) || !RENDER || !existsSync(RENDER)) {
  console.error('usage: node verify.mjs <outDir> --against <render.mp4> [--n 12 | --times a,b,c] [--play 6] [--report <dir>]');
  process.exit(2);
}
const REPORT = resolve(argv('--report', OUT.replace(/[\\/]+$/, '') + '-verify'));
mkdirSync(REPORT, { recursive: true });
const M = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
const W = M.composition.width, H = M.composition.height, D = M.composition.duration;
const R = { package: OUT, render: resolve(RENDER), composition: M.composition };
const say = (s) => console.log(s);

// ---------- 1. integrity
const bad = [];
for (const a of M.assets) { const f = join(OUT, a.path); if (!existsSync(f)) bad.push(`missing ${a.path}`); else if (sha256(f) !== a.sha256) bad.push(`sha256 ${a.path}`); }
R.integrity = { assets: M.assets.length, problems: bad };
say(`integrity: ${M.assets.length} assets, ${bad.length ? bad.length + ' problems: ' + bad.slice(0, 5).join(', ') : 'all present with the recorded sha256'}`);

// ---------- render facts and frame times
const MAX_MAD = Number(argv('--max-mad', 5)), MIN_PSNR = Number(argv('--min-psnr', 20));
if (Number.isNaN(MAX_MAD) || Number.isNaN(MIN_PSNR)) { console.error('--max-mad and --min-psnr take numbers'); process.exit(2); }
const probe = ffprobe(RENDER);
const vs = probe && (probe.streams || []).find((s) => s.codec_type === 'video');
if (!vs) { console.error(`cannot read a video stream from ${RENDER} (ffprobe failed or the file has no video)`); process.exit(2); }
const [fa, fb] = String(vs.r_frame_rate || '').split('/').map(Number), FPS = fa / (fb || 1);
if (!(FPS > 0)) { console.error(`cannot read the frame rate of ${RENDER} (r_frame_rate ${vs.r_frame_rate})`); process.exit(2); }
const startPts = Number(vs.start_time) || 0;
let times;
if (argv('--times')) times = argv('--times').split(',').map(Number);
else { const n = Number(argv('--n', 12)); times = Array.from({ length: n }, (_, k) => D * (k + 0.5) / n); }
if (!times.length || times.some((t) => !Number.isFinite(t))) { console.error('need at least one frame time: --n >= 1 or --times a,b,c (numbers)'); process.exit(2); }
const frames = times.map((t) => Math.min(Math.round(t * FPS), Math.floor((D - 1e-3) * FPS)));

// ---------- 2. load
const srv = await serve([{ prefix: '/', dir: OUT }]);
const browser = await launch();
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errors = [], netFails = [], externalReqs = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('request', (q) => { const u = q.url(); if (/^https?:/.test(u) && !u.startsWith(srv.url)) externalReqs.push(u); });
page.on('requestfailed', (q) => { const f = q.failure() && q.failure().errorText; if (f !== 'net::ERR_ABORTED') netFails.push(`${q.url()} ${f}`); });
const t0 = Date.now();
await page.goto(srv.url + 'index.html', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => { const p = document.querySelector('hyperframes-player'); return p && p.ready && p.duration > 0; }, { timeout: 300000, polling: 100 });
const tReady = Date.now() - t0;
await page.waitForFunction(() => document.querySelector('hyperframes-player').assetsReady, { timeout: 300000, polling: 100 }).catch(() => {});
const tAssets = Date.now() - t0;
const cf = page.frames().find((f) => f.url().includes('/composition/'));
if (!cf) { console.error('composition iframe not found in the player'); await browser.close(); await srv.close(); process.exit(1); }
await page.waitForFunction(() => { try { const w = document.querySelector('hyperframes-player').iframeElement.contentWindow; return !!(w.__hf || w.__player); } catch { return false; } }, { timeout: 20000, polling: 100 }).catch(() => {});
const rt = await cf.evaluate(() => ({ runtime: !!(window.__hf || window.__player), scripts: [...document.scripts].map((s) => s.src).filter((s) => /hyperframe\.runtime/.test(s)) }));
R.load = { readyMs: tReady, assetsReadyMs: tAssets, runtimeLoaded: rt.runtime, runtimeScript: rt.scripts.map((s) => s.replace(srv.url, '/')) };
say(`load: player ready ${(tReady / 1000).toFixed(1)} s, assets ready ${(tAssets / 1000).toFixed(1)} s; HyperFrames runtime injected: ${rt.runtime ? 'yes, ' + R.load.runtimeScript.join(', ') : 'no (the player drives window.__timelines directly)'}`);

// ---------- 3. frames
await page.evaluate(() => document.querySelector('hyperframes-player').removeAttribute('controls'));
await sleep(300);
const settle = () => cf.evaluate(() => new Promise((done) => {
  const t0 = performance.now();
  const root = document.querySelector('[data-composition-id]'), Rr = root.getBoundingClientRect();
  const pending = () => [...document.querySelectorAll('video')].filter((v) => {
    if (!v.isConnected || (v.checkVisibility && !v.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) return false;
    const r = v.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0 && r.right > Rr.left && r.left < Rr.right && r.bottom > Rr.top && r.top < Rr.bottom)) return false;
    return v.seeking || v.readyState < 2;
  });
  (function poll() {
    const p = pending();
    if (!p.length || performance.now() - t0 > 15000) requestAnimationFrame(() => requestAnimationFrame(() => done(p.map((v) => (v.currentSrc || v.src).split('/').pop()))));
    else setTimeout(poll, 20);
  })();
}));
const res = [];
for (const i of frames) {
  const t = i / FPS;
  await page.evaluate((t) => document.querySelector('hyperframes-player').seek(t), t);
  let pend = await settle();
  await sleep(120); pend = await settle(); // a second pass catches media the first seek only revealed
  const shot = await page.screenshot({ type: 'png' });
  const A = rgb(shot, W, H), B = rgb(RENDER, W, H, Math.max(0, startPts + (i - 0.25) / FPS).toFixed(4));
  let sad = 0, se = 0; for (let k = 0; k < A.length; k++) { const d = A[k] - B[k]; sad += d < 0 ? -d : d; se += d * d; }
  const mad = sad / A.length / 255 * 100, mse = se / A.length, psnr = mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse);
  const name = `cmp-${t.toFixed(3)}.jpg`;
  writeFileSync(join(REPORT, 'ours.png'), shot);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(REPORT, 'ours.png'), '-ss', Math.max(0, startPts + (i - 0.25) / FPS).toFixed(4), '-i', RENDER,
    '-filter_complex', `[1:v]scale=${W}:${H}[r];[0:v][r]hstack=inputs=2,scale=1600:-2`, '-frames:v', '1', '-q:v', '4', join(REPORT, name)]);
  res.push({ t: +t.toFixed(3), frame: i, madPct: +mad.toFixed(3), psnr: +psnr.toFixed(2), pendingMedia: pend, image: name });
  say(`  t=${t.toFixed(3).padStart(8)}  MAD ${mad.toFixed(2).padStart(5)} %  PSNR ${psnr.toFixed(1).padStart(5)} dB${pend.length ? '  pending: ' + pend.join(',') : ''}`);
}
R.frames = res;

// ---------- 4. playback
const PLAY = Number(argv('--play', 6));
if (PLAY > 0) {
  const from = Math.min(D * 0.3, Math.max(0, D - PLAY - 1));
  await page.evaluate((t) => { const p = document.querySelector('hyperframes-player'); p.seek(t); p.play(); }, from);
  await sleep(PLAY * 1000);
  const now = await page.evaluate(() => { const p = document.querySelector('hyperframes-player'); const t = p.currentTime; p.pause(); return { t, paused: p.paused }; });
  R.play = { from: +from.toFixed(3), seconds: PLAY, reached: +now.t.toFixed(3), advanced: +(now.t - from).toFixed(3) };
  say(`playback: ${PLAY} s of real time from ${from.toFixed(1)} s advanced the player clock by ${(now.t - from).toFixed(2)} s`);
}
await browser.close();
await srv.close();

// ---------- 5. requests
const probed = new Set((M.missing_in_source || []).map((m) => '/composition/' + m.path));
const httpErr = srv.log.filter((r) => r.status >= 400);
R.requests = {
  total: srv.log.length, bytes: srv.log.reduce((s, r) => s + r.bytes, 0),
  failed: httpErr.filter((r) => !probed.has(r.path)).map((r) => `${r.status} ${r.method} ${r.path}`),
  expectedMissing: httpErr.filter((r) => probed.has(r.path)).map((r) => `${r.status} ${r.method} ${r.path}`),
  networkFailures: netFails, external: [...new Set(externalReqs)], pageErrors: [...new Set(errors)],
};
const avg = (k) => res.reduce((s, x) => s + x[k], 0) / res.length;
R.summary = { frames: res.length, madPctMean: +avg('madPct').toFixed(3), madPctMax: Math.max(...res.map((x) => x.madPct)), psnrMean: +avg('psnr').toFixed(2), psnrMin: Math.min(...res.map((x) => x.psnr)) };
const badFrames = res.filter((x) => x.madPct > MAX_MAD || x.psnr < MIN_PSNR).map((x) => x.t), pendingFrames = res.filter((x) => x.pendingMedia.length).map((x) => x.t);
R.thresholds = { maxMadPct: MAX_MAD, minPsnr: MIN_PSNR, failedFrames: badFrames, pendingMediaFrames: pendingFrames };
writeFileSync(join(REPORT, 'verify.json'), JSON.stringify(R, null, 1));
say(`frames vs ${RENDER}: ${res.length} times, MAD mean ${R.summary.madPctMean} % (max ${R.summary.madPctMax}), PSNR mean ${R.summary.psnrMean} dB (min ${R.summary.psnrMin})`);
say(`requests: ${R.requests.total}, failed: ${R.requests.failed.length ? R.requests.failed.join(', ') : 'none'}; expected-missing probes: ${R.requests.expectedMissing.length}; network failures: ${netFails.length || 'none'}; external: ${R.requests.external.length || 'none'}; page errors: ${R.requests.pageErrors.length ? R.requests.pageErrors.slice(0, 3).join(' | ') : 'none'}`);
if (badFrames.length) say(`FAIL frames above MAD ${MAX_MAD} % or below PSNR ${MIN_PSNR} dB at t = ${badFrames.join(', ')}`);
if (pendingFrames.length) say(`FAIL media still decoding at the capture at t = ${pendingFrames.join(', ')}`);
say(`-> ${join(REPORT, 'verify.json')}`);
process.exitCode = bad.length || R.requests.failed.length || netFails.length || R.requests.external.length || R.requests.pageErrors.length ||
  badFrames.length || pendingFrames.length ? 1 : 0;
