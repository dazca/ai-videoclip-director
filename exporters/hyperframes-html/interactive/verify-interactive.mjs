#!/usr/bin/env node
// Headless check of the interactive layer of a package (export.mjs --interactive, or interactive/build.mjs).
//
//   node interactive/verify-interactive.mjs <outDir> [--report <dir>] [--at text=20,window=110,image=86,video=160,dancer=116,alpha=258]
//   (alpha = a stacked-alpha dancer clip)
//
// 0. clean screen: the HUD is hidden at start, shows at the bottom edge (48 px), hides 1.2 s after the pointer leaves;
//    a key shows it briefly; H cycles auto / always / never; L the progress line; nothing has a transition
// 1. clock baseline: 6 s of plain playback, audio-clock progress vs wall time
// 2. while playing, one run per kind (text, window, image, video, dancer): hover, click to lift (instantly: no
//    animation), check the card's content, drag it, Ctrl+wheel zoom, (text) select inside it by a mouse drag, outlines
//    hide when the pointer is still for 1.5 s, Esc closes instantly, for 6 s of wall time each; the film clock must
//    progress like the baseline (within 50 ms) and never jump
// 3. paused mode: Space pauses (clock holds), the system pointer is visible over the film's elements, a mouse drag
//    selects text in the film document, double-click lifts, Space resumes from the paused ms
// 4. aspect: fit and fill at 1280x720, 1080x1920, 2560x1080, 1024x768: geometry, hit-test, hover, click-lift and
//    paused double-click lift land on the same thing; a screenshot of each with a card lifted
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
const noAnim = () => page.evaluate(() => [...document.querySelectorAll('.ix-card, #ix-hud, #ix-hover, #ix-line, #ix-toast')].every((e) => !e.getAnimations().length && getComputedStyle(e).transitionDuration.split(',').every((d) => parseFloat(d) === 0)));
const disp = (id) => page.evaluate((id) => getComputedStyle(document.getElementById(id)).display, id);
// the preferences are per viewer (localStorage): start from the defaults
await page.evaluate(() => { try { for (const k of Object.keys(localStorage)) if (k.startsWith('ix.')) localStorage.removeItem(k); } catch (e) {} IX.setAspect('fit'); IX.setHud('auto', false); });

// ---------------------------------------------------------------- 0. clean screen
{
  await page.mouse.move(640, 300); await sleep(300);
  const h0 = { shown: (await page.evaluate(() => IX.hud())).shown, hud: await disp('ix-hud'), line: await disp('ix-line') };
  check('HUD hidden by default (nothing on screen, progress line off)', !h0.shown && h0.hud === 'none' && h0.line === 'none', h0);
  await page.mouse.move(640, 700, { steps: 3 }); await sleep(120);
  const h1 = await disp('ix-hud');
  check('HUD shows at the bottom edge (bottom 48 px)', h1 === 'flex', h1);
  await page.mouse.move(640, 300, { steps: 3 }); await sleep(600);
  const h2 = await disp('ix-hud');
  await sleep(900);
  const h3 = await disp('ix-hud');
  check('HUD hides 1.2 s after the pointer leaves the zone', h2 === 'flex' && h3 === 'none', { at600ms: h2, at1500ms: h3 });
  await page.keyboard.press('ArrowRight'); await sleep(100);
  const h4 = await disp('ix-hud');
  await page.keyboard.press('ArrowLeft'); await sleep(1700);
  const h5 = await disp('ix-hud');
  check('an arrow / Space shows the HUD briefly', h4 === 'flex' && h5 === 'none', { after: h4, later: h5 });
  check('HUD, outline, line, toast: no transition / animation', await noAnim());
  await page.keyboard.press('h'); const m1 = await page.evaluate(() => IX.hud().mode); await page.keyboard.press('h'); const m2 = await page.evaluate(() => IX.hud().mode);
  await page.keyboard.press('h'); const m3 = await page.evaluate(() => [IX.hud().mode, localStorage.getItem('ix.hud')]);
  check('H cycles the HUD mode auto -> always -> never -> auto (remembered)', m1 === 'always' && m2 === 'never' && m3[0] === 'auto' && m3[1] === 'auto', [m1, m2, m3]);
  await page.keyboard.press('l'); await sleep(100);
  const ln = await page.evaluate(() => [getComputedStyle(document.getElementById('ix-line')).display, parseFloat(document.querySelector('#ix-line i').style.width)]);
  await page.keyboard.press('l');
  check('L toggles a 2 px progress line while the HUD is hidden', ln[0] === 'block' && ln[1] > 0, ln);
  // outlines only while the pointer moves (the wallpaper stays put, so the same point is still over something)
  const pw = await page.evaluate(() => IX.probe('image') || IX.probe('window') || IX.probe('element'));
  if (pw) {
    await page.mouse.move(pw.x - 2, pw.y); await page.mouse.move(pw.x, pw.y); await sleep(100);
    const moving = await page.evaluate(() => document.getElementById('ix-hover').style.display);
    await sleep(1700);
    const still = await page.evaluate(() => document.getElementById('ix-hover').style.display);
    await page.mouse.move(pw.x + 1, pw.y); await sleep(80);
    const again = await page.evaluate(() => document.getElementById('ix-hover').style.display);
    check('outline only while the pointer moves (hidden after 1.5 s still, back on the next move)', moving === 'block' && still === 'none' && again === 'block', { moving, still, again });
  }
  await page.mouse.move(5, 5);
}

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
  let pt = await page.evaluate((k, n) => IX.probe(k, n ? { name: new RegExp(n) } : {}), kind, nameRe);
  if (!pt) { check(`${kind}: something to lift at ${t} s`, false); R.runs.push(run); continue; }
  run.target = pt.name;
  await page.mouse.move(pt.x, pt.y, { steps: 4 }); await sleep(250);
  const hover = await page.evaluate(() => { const h = document.getElementById('ix-hover'); return h.style.display === 'block' ? h.textContent : null; });
  check(`${kind}: hover outline + label`, !!hover, hover);
  if (kind === 'text') {
    await shot('1-hover-outline');
    const cur = await page.evaluate(() => getComputedStyle(document.getElementById('ix-overlay')).cursor);
    check('system pointer over the film while playing (hand over a liftable thing)', cur === 'pointer', cur);
    run.hint0 = await page.evaluate(() => !document.getElementById('ix-hint').hidden);
  }
  const n0 = await page.evaluate(() => IX.cards().length);
  { // the film keeps running: if the thing moved away meanwhile, aim again
    const now = await page.evaluate((x, y) => IX.hitAt(x, y), pt.x, pt.y);
    if (!now || now.kind !== kind) { const p2 = await page.evaluate((k, n) => IX.probe(k, n ? { name: new RegExp(n) } : {}), kind, nameRe); if (p2) { pt = p2; await page.mouse.move(pt.x, pt.y); } }
  }
  await page.mouse.click(pt.x, pt.y);
  const inst = await page.evaluate(() => { const cs = document.querySelectorAll('.ix-card'), c = cs[cs.length - 1]; return c && { anims: c.getAnimations().length, transform: getComputedStyle(c).transform, opacity: getComputedStyle(c).opacity }; });
  check(`${kind}: the card appears instantly (no animation)`, inst && inst.anims === 0 && inst.transform === 'none' && inst.opacity === '1', inst);
  if (kind === 'text') { const gone = await page.evaluate(() => document.getElementById('ix-hint').hidden); check('the "click anything" hint is gone after the first lift', run.hint0 && gone, { before: run.hint0, hiddenAfter: gone }); delete run.hint0; }
  await sleep(500);
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
  // close with Esc: the card simply disappears, at once
  await page.mouse.move(5, 5);
  const before = await page.evaluate(() => document.querySelectorAll('.ix-card').length);
  await page.keyboard.press('Escape');
  const after = await page.evaluate(() => ({ n: document.querySelectorAll('.ix-card').length, anims: document.getAnimations().length }));
  check(`${kind}: Esc closes instantly (no fly-back)`, after.n === before - 1 && after.anims === 0, { before, after });
  if (kind === 'window') {
    // ctrl-click several, then pin one and click outside: unpinned ones close, the pinned one stays
    const pw = await page.evaluate(() => IX.probe('window'));
    if (pw) { await page.mouse.click(pw.x, pw.y); await sleep(300); }
    const p2 = await page.evaluate(() => IX.probe('text') || IX.probe('button') || IX.probe('image')); // a point not under the card
    if (p2 && pw) {
      await page.keyboard.down('Control'); await page.mouse.click(p2.x, p2.y); await page.keyboard.up('Control'); await sleep(300);
      const two = await page.evaluate(() => IX.cards().length);
      check('several cards at once (Ctrl+click keeps the others)', two >= 2, two);
      await page.evaluate(() => document.querySelector('.ix-card [data-a="pin"]').click());
      await page.mouse.click(4, 4); await sleep(50); // closes only (a click outside never lifts while unpinned cards are open)
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
{ // paused: the film document has the pointer; its own CSS hides the cursor (#screen {cursor: none}), the layer restores it
  const cur = await page.evaluate(() => {
    const d = IX.film().document, f = IX.fit(), out = {};
    for (const [x, y] of [[200, 200], [640, 360], [1000, 500], [100, 650], [700, 120]]) for (const el of d.elementsFromPoint((x - f.ox) / f.s, (y - f.oy) / f.s).slice(0, 5))
      out[el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '')] = getComputedStyle(el).cursor;
    out['#screen'] = getComputedStyle(d.getElementById('screen')).cursor; return out;
  });
  check('paused: system pointer visible over every film element (computed cursor never none)', Object.values(cur).every((c) => c !== 'none'), cur);
}
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

// ---------------------------------------------------------------- 4. aspect: fit / fill on any window shape
const SIZES = [[1280, 720], [1080, 1920], [2560, 1080], [1024, 768]];
R.aspect = [];
for (const [vw, vh] of SIZES) for (const mode of ['fit', 'fill']) {
  const tag = `${vw}x${vh} ${mode}`;
  await page.evaluate(() => { IX.closeAll(); IX.play(); });
  await page.setViewport({ width: vw, height: vh, deviceScaleFactor: 1 });
  await page.evaluate((m) => IX.setAspect(m), mode);
  await playAt(AT.window ?? fit(110));
  const g = await page.evaluate(() => { const f = IX.fit(), r = document.getElementById('ix-film').getBoundingClientRect(); return { ...f, r: { x: r.left, y: r.top, w: r.width, h: r.height } }; });
  const eps = 1.5, inside = g.r.x >= -eps && g.r.y >= -eps && g.r.x + g.r.w <= vw + eps && g.r.y + g.r.h <= vh + eps;
  const covers = g.r.x <= eps && g.r.y <= eps && g.r.x + g.r.w >= vw - eps && g.r.y + g.r.h >= vh - eps;
  const uniform = Math.abs(g.r.w / g.r.h - g.cw / g.ch) < 0.01;
  const centred = Math.abs(g.r.x + g.r.w / 2 - vw / 2) < eps && Math.abs(g.r.y + g.r.h / 2 - vh / 2) < eps;
  check(`${tag}: geometry (${mode === 'fit' ? 'whole film inside, touching two edges' : 'covers the window, centred crop'}, never stretched)`,
    uniform && centred && (mode === 'fit' ? inside && (Math.abs(g.r.w - vw) < eps || Math.abs(g.r.h - vh) < eps) : covers),
    { scale: +g.s.toFixed(4), film: { x: Math.round(g.r.x), y: Math.round(g.r.y), w: Math.round(g.r.w), h: Math.round(g.r.h) } });
  const A0 = { size: tag, scale: +g.s.toFixed(4) };
  const pt = await page.evaluate(() => IX.probe('window') || IX.probe('text') || IX.probe('image'));
  if (!pt) { check(`${tag}: something to lift on screen`, false); R.aspect.push(A0); continue; }
  await page.mouse.move(pt.x - 3, pt.y); await page.mouse.move(pt.x, pt.y, { steps: 2 }); await sleep(120);
  const hv = await page.evaluate((x, y) => { const h = document.getElementById('ix-hover'), r = h.getBoundingClientRect(); return { on: h.style.display === 'block', contains: x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1, label: h.textContent, hit: IX.hitAt(x, y) }; }, pt.x, pt.y);
  check(`${tag}: hit-test + hover outline land on the thing under the pointer`, hv.on && hv.contains && hv.hit && hv.hit.name === pt.name, { probe: pt.name, hit: hv.hit && hv.hit.name, label: hv.label });
  await page.mouse.click(pt.x, pt.y); await sleep(250);
  const lc = await page.evaluate(() => { const c = IX.cards().pop(); return c && { kind: c.kind, name: c.name }; });
  check(`${tag}: click lifts that thing`, lc && lc.name === pt.name, lc);
  await page.mouse.move(Math.min(vw - 10, pt.x + 30), Math.max(10, pt.y - 30)); await sleep(80);
  await page.screenshot({ path: join(REPORT, `aspect-${vw}x${vh}-${mode}.png`) });
  A0.lifted = lc;
  // paused: the film's own document takes the pointer through the same transform; a double-click lifts the same thing
  await page.evaluate(() => { IX.closeAll(); IX.pause(); }); await sleep(150);
  const pp = await page.evaluate(() => IX.probe('window') || IX.probe('text') || IX.probe('image'));
  if (pp) {
    await page.mouse.click(pp.x, pp.y, { count: 2 }); await sleep(250);
    const dc = await page.evaluate(() => { const c = IX.cards().pop(); return c && c.name; });
    check(`${tag}: paused double-click lifts the thing under the pointer`, dc === pp.name, { probe: pp.name, lifted: dc });
    A0.pausedLift = dc;
  }
  await page.evaluate(() => { IX.closeAll(); IX.play(); });
  R.aspect.push(A0);
}
await page.evaluate(() => IX.setAspect('fit'));

await browser.close(); await srv.close();
R.errors = [...new Set(errors)];
check('no page errors', !R.errors.length, R.errors.slice(0, 5));
R.external_blocked = [...new Set(blocked)]; if (blocked.length) say(`external URLs (blocked, never fetched): ${R.external_blocked.slice(0, 5).join(', ')}`);
writeFileSync(join(REPORT, 'verify-interactive.json'), JSON.stringify(R, null, 1));
const fails = R.checks.filter((c) => !c.ok).length;
say(`${R.checks.length - fails}/${R.checks.length} checks passed -> ${join(REPORT, 'verify-interactive.json')}`);
process.exitCode = fails ? 1 : 0;
