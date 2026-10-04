#!/usr/bin/env node
// Headless check of the interactive layer of a package (export.mjs --interactive, or interactive/build.mjs).
//
//   node interactive/verify-interactive.mjs <outDir> [--report <dir>] [--at text=20,window=110,image=86,video=160,dancer=116,alpha=258]
//   (alpha = a stacked-alpha dancer clip)
//
// 1. clock baseline: 6 s of plain playback, audio-clock progress vs wall time
// 2. while playing, one run per kind (text, window, image, video, dancer): hover, click to lift, check the card's
//    content, drag it, Ctrl+wheel zoom, (text) select inside it by a mouse drag, Esc to close (animates back), for
//    6 s of wall time each; the film clock must progress like the baseline (within 50 ms) and never jump
// 3. paused mode: Space pauses (clock holds), a mouse drag selects text in the film document, double-click lifts,
//    Space resumes from the paused ms
// Screenshots + verify-interactive.json in <report> (default <outDir>-verify/interactive). Exit code 1 on a failure.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve, launch, confine, sleep, argv } from '../lib.mjs';

const OUT = resolve(process.argv[2] || '');
if (!process.argv[2] || !existsSync(join(OUT, 'interactive.html'))) { console.error('usage: node interactive/verify-interactive.mjs <outDir> (with interactive.html)'); process.exit(2); }
const REPORT = resolve(argv('--report', join(OUT.replace(/[\\/]+$/, '') + '-verify', 'interactive')));
mkdirSync(REPORT, { recursive: true });
// probe times: --at, else the owner's film defaults; each one is kept inside the film (room for the 6 s run)
let DUR = 0; try { DUR = Number(JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')).composition.duration) || 0; } catch {}
const fit = (t) => (DUR ? Math.max(0, Math.min(t, DUR - 8)) : t);
if (!argv('--at') && DUR && DUR < 260) console.log(`note: no --at given; the default probe times are for a 4+ minute film, clamped to this ${DUR} s one (pass --at kind=s,...)`);
const AT = Object.fromEntries((argv('--at', 'text=20,window=110,image=86,video=160,dancer=116,alpha=258')).split(',').map((kv) => { const [k, v] = kv.split('='); return [k, fit(+v)]; }));
const R = { package: OUT, runs: [], checks: [] };
const say = (s) => console.log(s);
const check = (name, ok, detail) => { R.checks.push({ name, ok: !!ok, detail }); say(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); };

const srv = await serve([{ prefix: '/', dir: OUT }]);
const browser = await launch(srv.url);
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
// interactive.project.json is optional (only with --project): its 404 is not an error
page.on('console', (m) => { if (m.type() === 'error' && !/\/interactive\.project\.json$/.test((m.location() || {}).url || '')) errors.push(m.text()); });
const blocked = [];
await confine(page, srv.url, (u) => blocked.push(u)); // the film's JS stays on this server
await page.goto(srv.url + 'interactive.html', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.IX && IX.ready && IX.playing(), { timeout: 300000, polling: 100 });
const shot = (name) => page.screenshot({ path: join(REPORT, name + '.png') });

// clock sampler in the page: [wall ms, film s] every 50 ms
await page.evaluate(() => { window.__samples = []; setInterval(() => window.__samples.push([performance.now(), IX.t(), IX.playing()]), 50); });
const mark = () => page.evaluate(() => ({ w: performance.now(), a: IX.t() }));
const progress = (m0, m1) => +((m1.a - m0.a) - (m1.w - m0.w) / 1000).toFixed(4); // film seconds minus wall seconds
async function jumps(m0, m1) { // largest deviation between film steps and wall steps inside the window
  return page.evaluate((w0, w1) => {
    const s = window.__samples.filter((x) => x[0] >= w0 && x[0] <= w1 && x[2]); let worst = 0;
    for (let i = 1; i < s.length; i++) worst = Math.max(worst, Math.abs((s[i][1] - s[i - 1][1]) - (s[i][0] - s[i - 1][0]) / 1000));
    return +worst.toFixed(4);
  }, m0.w, m1.w);
}
async function playAt(t) { await page.evaluate((t) => { IX.seek(t, true); IX.play(); }, t); await sleep(900); }

// ---------------------------------------------------------------- 1. baseline
await playAt(fit(DUR ? Math.min(100, DUR * 0.3) : 100));
let m0 = await mark(); await sleep(6000); let m1 = await mark();
const base = progress(m0, m1), baseJump = await jumps(m0, m1);
R.baseline = { from: m0.a, filmSeconds: +(m1.a - m0.a).toFixed(3), wallSeconds: +((m1.w - m0.w) / 1000).toFixed(3), drift: base, worstStep: baseJump };
say(`baseline: ${R.baseline.filmSeconds} s of film in ${R.baseline.wallSeconds} s of wall time (drift ${base}, worst step ${baseJump})`);

// ---------------------------------------------------------------- 2. lifts while playing
const content = {
  text: (c) => { const z = c.querySelector('.ix-zoom'); const t = z.innerText.trim(); return { ok: t.length > 0, text: t.slice(0, 60) }; },
  window: (c) => { const z = c.querySelector('.ix-zoom'); const t = z.innerText.trim(); return { ok: t.length > 3 && z.querySelectorAll('*').length > 5, elements: z.querySelectorAll('*').length, text: t.slice(0, 60) }; },
  image: (c) => { const im = c.querySelector('.ix-zoom img'); return { ok: !!im && im.complete && im.naturalWidth > 0, natural: im && [im.naturalWidth, im.naturalHeight], src: im && im.src.split('/').pop() }; },
  video: (c) => {
    const cv = c.querySelector('.ix-zoom canvas'), v = c.querySelector('.ix-extra video');
    let lit = 0; try { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 0; i < d.length; i += 4 * 97) lit += d[i] + d[i + 1] + d[i + 2]; } catch (e) {}
    return { ok: !!cv && lit > 0 && !!v && v.readyState >= 2 && !v.paused, frame: cv && [cv.width, cv.height], loop: v && { ready: v.readyState, playing: !v.paused, src: v.src.split('/').pop() } };
  },
  dancer: (c) => { const n = c.querySelector('.ix-zoom > *'); return { ok: !!n, node: n && n.tagName, bg: n && n.style.backgroundPosition }; },
};
for (const [key, t] of Object.entries(AT)) {
  const kind = key === 'alpha' ? 'dancer' : key, nameRe = key === 'alpha' ? 'alpha' : null;
  await page.evaluate(() => IX.closeAll()); await sleep(350);
  await playAt(t);
  const run = { kind: key, at: t };
  m0 = await mark();
  const pt = await page.evaluate((k, n) => IX.probe(k, n ? { name: new RegExp(n) } : {}), kind, nameRe);
  if (!pt) { check(`${kind}: something to lift at ${t} s`, false); R.runs.push(run); continue; }
  run.target = pt.name;
  await page.mouse.move(pt.x, pt.y, { steps: 4 }); await sleep(250);
  const hover = await page.evaluate(() => { const h = document.getElementById('ix-hover'); return h.style.display === 'block' ? h.textContent : null; });
  check(`${kind}: hover outline + label`, !!hover, hover);
  if (kind === 'text') await shot('1-hover-outline');
  const n0 = await page.evaluate(() => IX.cards().length);
  await page.mouse.click(pt.x, pt.y); await sleep(500);
  const card = await page.evaluate((k) => { const c = IX.cards().pop(); return c && { kind: c.kind, name: c.name, z: c.z, n: IX.cards().length }; });
  check(`${kind}: click lifts a ${kind} card`, card && card.kind === kind && card.n === n0 + 1, card);
  // wait for decoding where needed, then check what is in the card
  if (kind === 'video' || kind === 'image') await page.waitForFunction((k) => { const c = document.querySelector('.ix-card:last-of-type'); const v = c && c.querySelector(k === 'video' ? '.ix-extra video' : '.ix-zoom img'); return v && (k === 'video' ? v.readyState >= 2 && !v.paused : v.complete && v.naturalWidth > 0); }, { timeout: 8000 }, kind).catch(() => {});
  const got = await page.evaluate((fn) => { const cs = document.querySelectorAll('.ix-card'); return (new Function('return ' + fn))()(cs[cs.length - 1]); }, content[kind].toString());
  check(`${kind}: card content`, got.ok, got);
  if (kind === 'dancer') { await sleep(400); const g2 = await page.evaluate((fn) => { const cs = document.querySelectorAll('.ix-card'); return (new Function('return ' + fn))()(cs[cs.length - 1]); }, content[kind].toString()); check('dancer: animation loops in the card', g2.bg !== got.bg || g2.node === 'CANVAS', [got.bg, g2.bg]); }
  const meta = await page.evaluate(() => { const cs = document.querySelectorAll('.ix-card'); return cs[cs.length - 1].querySelector('.ix-meta').innerText; });
  check(`${kind}: metadata (time, element, file / shot)`, /\d:\d\d\.\d{3}/.test(meta), meta.split('\n').slice(0, 3).join(' | '));
  const shotName = { text: '2-lifted-text', window: '3-lifted-window', video: '4-lifted-video', image: '5-lifted-image', dancer: '6-lifted-dancer', alpha: '6b-lifted-alpha-dancer' }[key];
  if (kind === 'text') {
    const sel = await page.evaluate(() => { const cs = document.querySelectorAll('.ix-card'), z = cs[cs.length - 1].querySelector('.ix-zoom');
      const w = document.createTreeWalker(z, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode()) && !n.nodeValue.trim()); if (!n) return null;
      const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect(); return { x0: b.left + 2, x1: b.right - 2, y: b.top + b.height / 2 }; });
    if (sel) { await page.mouse.move(sel.x0, sel.y); await page.mouse.down(); await page.mouse.move(sel.x1, sel.y, { steps: 8 }); await page.mouse.up(); }
    const s = await page.evaluate(() => window.getSelection().toString());
    check('text: selectable in the card (mouse drag -> getSelection)', s.trim().length > 0, s.slice(0, 50));
  }
  await shot(shotName);
  // drag by the header and zoom with Ctrl+wheel
  const hd = await page.evaluate(() => { const cs = document.querySelectorAll('.ix-card'), c = cs[cs.length - 1], h = c.querySelector('.ix-name').getBoundingClientRect(); return { x: h.left + 10, y: h.top + 8, left: c.offsetLeft }; });
  await page.mouse.move(hd.x, hd.y); await page.mouse.down(); await page.mouse.move(hd.x - 40, hd.y + 20, { steps: 5 }); await page.mouse.up();
  const moved = await page.evaluate(() => { const cs = document.querySelectorAll('.ix-card'); return cs[cs.length - 1].offsetLeft; });
  check(`${kind}: card drags`, Math.abs(moved - (hd.left - 40)) <= 2, { from: hd.left, to: moved });
  const z0 = await page.evaluate(() => IX.cards().pop().z);
  const bb = await page.evaluate(() => { const cs = document.querySelectorAll('.ix-card'), b = cs[cs.length - 1].querySelector('.ix-body').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.move(bb.x, bb.y); await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: -200 }); await page.keyboard.up('Control'); await sleep(100);
  const z1 = await page.evaluate(() => IX.cards().pop().z);
  check(`${kind}: Ctrl+wheel zooms the card`, z1 > z0, { from: +z0.toFixed(3), to: +z1.toFixed(3) });
  // close with Esc: it animates back
  await page.mouse.move(5, 5);
  const before = await page.evaluate(() => document.querySelectorAll('.ix-card').length);
  await page.keyboard.press('Escape'); await sleep(60);
  const anim = await page.evaluate(() => { const cs = document.querySelectorAll('.ix-card'), c = cs[cs.length - 1]; return c ? { anims: c.getAnimations().length, transform: getComputedStyle(c).transform } : null; });
  await sleep(400);
  const after = await page.evaluate(() => document.querySelectorAll('.ix-card').length);
  check(`${kind}: Esc closes with an animation back to the film`, anim && anim.anims > 0 && after === before - 1, { anim, before, after });
  if (kind === 'window') {
    // ctrl-click several, then pin one and click outside: unpinned ones fly back, the pinned one stays
    const pw = await page.evaluate(() => IX.probe('window'));
    if (pw) { await page.mouse.click(pw.x, pw.y); await sleep(300); }
    const p2 = await page.evaluate(() => IX.probe('text') || IX.probe('button') || IX.probe('image')); // a point not under the card
    if (p2 && pw) {
      await page.keyboard.down('Control'); await page.mouse.click(p2.x, p2.y); await page.keyboard.up('Control'); await sleep(300);
      const two = await page.evaluate(() => IX.cards().length);
      check('several cards at once (Ctrl+click keeps the others)', two >= 2, two);
      await page.evaluate(() => document.querySelector('.ix-card [data-a="pin"]').click());
      await page.mouse.click(4, 4); await sleep(450); // closes only (a click outside never lifts while unpinned cards are open)
      const left = await page.evaluate(() => IX.cards().map((c) => c.pinned));
      check('click outside closes the unpinned cards, the pinned one stays', left.length === 1 && left[0] === true, left);
      await page.evaluate(() => document.querySelector('.ix-card [data-a="close"]').click()); await sleep(400);
    }
  }
  const rest = 6000 - (await page.evaluate(() => performance.now()) - m0.w);
  if (rest > 0) await sleep(rest);
  m1 = await mark();
  run.filmSeconds = +(m1.a - m0.a).toFixed(3); run.wallSeconds = +((m1.w - m0.w) / 1000).toFixed(3);
  run.drift = progress(m0, m1); run.worstStep = await jumps(m0, m1);
  check(`${kind}: film clock unaffected (vs baseline within 50 ms, no stall/seek)`, Math.abs(run.drift - base) < 0.05 && run.worstStep < 0.25 && (await page.evaluate(() => IX.playing())),
    { film: run.filmSeconds, wall: run.wallSeconds, drift: run.drift, baseline: base, worstStep: run.worstStep });
  R.runs.push(run);
}

// ---------------------------------------------------------------- 3. paused mode
await playAt(AT.text ?? fit(56));
await page.mouse.move(640, 360);
await page.keyboard.press('Space'); await sleep(200);
const tp = await page.evaluate(() => IX.t());
await sleep(1500);
const tp2 = await page.evaluate(() => IX.t());
check('Space pauses; the clock holds', await page.evaluate(() => IX.paused() && !IX.playing()) && Math.abs(tp2 - tp) < 0.001, { paused: tp, after1500ms: tp2 });
const ft = await page.evaluate(() => IX.probe('text', { step: 12 }));
if (ft) {
  const span = await page.evaluate((x, y) => {
    const W = IX.film(), fr = document.getElementById('ix-film').getBoundingClientRect(), s = fr.width / W.innerWidth;
    const el = W.document.elementFromPoint((x - fr.left) / s, (y - fr.top) / s); const r = W.document.createRange(); r.selectNodeContents(el);
    const b = r.getClientRects()[0]; return b && { x0: fr.left + (b.left + 1) * s, x1: fr.left + (b.right - 1) * s, y: fr.top + (b.top + b.height / 2) * s };
  }, ft.x, ft.y);
  if (span) { await page.mouse.move(span.x0, span.y); await page.mouse.down(); await page.mouse.move(span.x1, span.y, { steps: 10 }); await page.mouse.up(); await sleep(150); }
  const sel = await page.evaluate(() => IX.film().getSelection().toString());
  check('paused: text in the film is selectable (mouse drag -> getSelection in the film)', sel.trim().length > 0, sel.slice(0, 60));
  check('paused: a click inside the film does not resume it (standalone click toggle stopped)', await page.evaluate(() => IX.paused() && !IX.playing()));
  await shot('7-paused-selection');
  const n0 = await page.evaluate(() => IX.cards().length);
  await page.mouse.click(ft.x, ft.y, { count: 2 }); await sleep(400);
  const n1 = await page.evaluate(() => IX.cards().length);
  check('paused: double-click lifts', n1 === n0 + 1, { before: n0, after: n1 });
  await page.keyboard.press('Escape'); await sleep(400);
}
const tq = await page.evaluate(() => IX.t());
await page.keyboard.press('Space');
await sleep(1000);
const rs = await page.evaluate(() => {
  const m = IX.modes().filter((x) => !x.paused && !x.byClock).pop(); // the resume
  const first = window.__samples.find((x) => x[0] > m.wall && x[2]), last = window.__samples[window.__samples.length - 1];
  return { resumeT: m.t, firstT: first && first[1], firstLag: first && (first[0] - m.wall) / 1000, lastT: last[1], lastLag: (last[0] - m.wall) / 1000, playing: IX.playing(), sel: IX.film().getSelection().toString() };
});
// the clock at the resume equals the paused ms, and afterwards film time = paused ms + wall time since the resume
check('Space resumes from the paused ms (film clock), selection cleared', rs.playing && Math.abs(tq - tp) < 0.001 && Math.abs(rs.resumeT - tp) < 0.001 &&
  Math.abs(rs.lastT - tp - rs.lastLag) < 0.05 && !rs.sel,
  { paused: +tp.toFixed(4), atResume: +rs.resumeT.toFixed(4), firstSample: +(rs.firstT || 0).toFixed(4), after: +rs.lastT.toFixed(3), expected: +(tp + rs.lastLag).toFixed(3) });

// arrows seek and "back to live"
const ta = await page.evaluate(() => IX.t());
await page.keyboard.press('ArrowRight'); await sleep(300);
const tb = await page.evaluate(() => ({ t: IX.t(), live: !document.getElementById('ix-live').hidden }));
check('ArrowRight seeks +5 s and offers "live"', tb.t - ta > 4.5 && tb.live, { from: +ta.toFixed(2), to: +tb.t.toFixed(2) });
await page.evaluate(() => IX.back()); await sleep(300);
const tc = await page.evaluate(() => IX.t());
check('"live" returns to where the film would be', Math.abs(tc - (ta + 0.6)) < 0.4, { live: +tc.toFixed(2) });

await browser.close(); await srv.close();
R.errors = [...new Set(errors)];
check('no page errors', !R.errors.length, R.errors.slice(0, 5));
R.external_blocked = [...new Set(blocked)]; if (blocked.length) say(`external URLs (blocked, never fetched): ${R.external_blocked.slice(0, 5).join(', ')}`);
writeFileSync(join(REPORT, 'verify-interactive.json'), JSON.stringify(R, null, 1));
const fails = R.checks.filter((c) => !c.ok).length;
say(`${R.checks.length - fails}/${R.checks.length} checks passed -> ${join(REPORT, 'verify-interactive.json')}`);
process.exitCode = fails ? 1 : 0;
