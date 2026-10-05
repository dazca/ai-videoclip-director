// v19 of the headless UI suite (tools/verify.mjs): the stages' Time view (core/timemode.js; ROADMAP_v4 F6, provisional
// decision). Exported so verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-timemode.mjs [outDir]
// Self-contained: a scratch copy of data/demo (+ a breakdown written over the agent surface), its own server on a free
// port; all deleted at the end. Checks: the List | Time toggle (stage bar, Alt+T) remembered per stage across a reload;
// ALIGNMENT: in Time, a lyric line sits at the same y as the timeline's lyric line for the same t (±2 px), a script scene
// as the timeline's scene, a storyboard shot as the timeline's shot, a breakdown scene row at y(t0); the Notes cells on
// their rows; the playhead line at y(t) after a seek; a click on an empty spot seeks to the ms under the pointer;
// right-click > "+ Add at m:ss" > "+ note at this time" types a note on the row at that time; scrolling the stage keeps
// the timeline's reading time; Final groups its rows by song section; the timeline's warp is the same behind a stage
// (it stays laid out); the cost of placing the rows. Review #2 (U13 / U17): a click on a row's text seeks to the row's
// start; on a short axis a slot under two lines is one line (no text cut through or stacked), the scene headers show
// whole lines only, a short row carries its text as a tooltip, and a script scene title keeps its width (no "T..").
// Screenshots v19_<stage>.png: the stage in Time next to the timeline; v19_short_<stage>.png on the short axis.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(process.env.WB_VERIFY_PORT ? Number(process.env.WB_VERIFY_PORT) + ((globalThis.__wbVerifyPortN = (globalThis.__wbVerifyPortN ?? -1) + 1) % 10) : 0, () => { const p = s.address().port; s.close(() => ok(p)); }); });

export async function verifyTimeMode({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v19 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v19-')), DATA = path.join(TMP, 'data'), P = 'tmode', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P };
  delete env.WB_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v19 server: ' + d));
  let pg = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
    const call = async (name, body) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    // a breakdown (the agent's draft) so the Breakdown stage has items x scenes
    const bd = await call('breakdown_update', { items: [{ kind: 'character', name: 'Ada', links: [{ scene: 'sc02' }, { scene: 'sc03' }] }, { kind: 'location', name: 'Studio', links: [{ scene: 'sc01' }, { scene: 'sc02' }] }, { kind: 'prop', name: 'Tone generator', links: [{ scene: 'sc02' }] }] });
    if (bd.status !== 200) throw new Error('breakdown_update ' + bd.status + ' ' + JSON.stringify(bd.body));

    pg = await browser.newPage();
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v19 pageerror', e.stack || e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.error('v19 console', m.text()); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(3);
    // a taller axis than the demo's 20 s needs: zoom in, so the rows have room and every px check means something
    await pg.evaluate(() => { const tl = window.WB.timeline; tl.pxPerSec = 60; tl.relayout(); tl.scrollToTime(0); });
    const warp0 = await pg.evaluate(() => [5000, 10000, 15000].map(t => window.WB.timeline.warp.y(t)));

    // the stage in Time next to the timeline, at the same reading time: one PNG
    const sideBySide = async (name) => {
      await frames(3); await wait(250);
      const a = await pg.screenshot({ encoding: 'base64' });
      await pg.evaluate(() => window.WB.app.show('timeline')); await frames(3); await wait(250);
      const b = await pg.screenshot({ encoding: 'base64' });
      const png = await pg.evaluate(async (A, B) => {
        const load = (s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = 'data:image/png;base64,' + s; });
        const [ia, ib] = await Promise.all([load(A), load(B)]);
        const c = document.createElement('canvas'); c.width = ia.width + ib.width + 6; c.height = Math.max(ia.height, ib.height);
        const x = c.getContext('2d'); x.fillStyle = '#f5a524'; x.fillRect(0, 0, c.width, c.height); x.drawImage(ia, 0, 0); x.drawImage(ib, ia.width + 6, 0);
        return c.toDataURL('image/png').split(',')[1];
      }, a, b);
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(png, 'base64'));
    };
    const open = async (stage) => { await pg.evaluate((s) => window.WB.stages.open(s), stage); await frames(4); await wait(200); };
    const AX = `(() => window.WB.timeMode.axes().find(a => a.visible))()`;

    // 1. the toggle: List is the default; the stage bar's Time / Alt+T switch it; remembered per stage across a reload
    await open('lyrics');
    const bar0 = await pg.evaluate(() => ({ tm: !!document.querySelector('.sgbar .sgtm'), on: document.querySelector('.sgbar .sgtm a.on')?.dataset.tm, mode: window.WB.timeMode.mode('lyrics') }));
    await pg.evaluate(() => document.querySelector('.sgbar .sgtm [data-tm=time]').click()); await frames(4);
    const bar1 = await pg.evaluate(() => ({ on: document.querySelector('.sgbar .sgtm a.on')?.dataset.tm, tmode: !!document.querySelector('.lypoem.tmode'), rows: document.querySelectorAll('.lypoem .lyl.tmrow').length }));
    await open('script');
    await pg.focus('body').catch(() => {}); await pg.keyboard.down('Alt'); await pg.keyboard.press('KeyT'); await pg.keyboard.up('Alt'); await frames(4);
    const bar2 = await pg.evaluate(() => ({ mode: window.WB.timeMode.mode('script'), tmode: !!document.querySelector('.sclist.tmode') }));
    await pg.evaluate(() => { window.WB.timeMode.setMode('storyboard', 'time'); window.WB.timeMode.setMode('breakdown', 'time'); });
    await pg.reload({ waitUntil: 'domcontentloaded' }); await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(3);
    await pg.evaluate(() => { const tl = window.WB.timeline; tl.pxPerSec = 60; tl.relayout(); tl.scrollToTime(0); });
    const kept = await pg.evaluate(() => ['lyrics', 'script', 'breakdown', 'storyboard', 'final'].map(s => window.WB.timeMode.mode(s)));
    check('the List | Time toggle: List by default; the stage bar\'s Time and Alt+T switch a stage to Time; remembered per stage (prefs) across a reload; Final stays List',
      bar0.tm && bar0.on === 'list' && bar0.mode === 'list' && bar1.on === 'time' && bar1.tmode && bar1.rows > 3 && bar2.mode === 'time' && bar2.tmode && kept.join() === 'time,time,time,time,list', { bar0, bar1, bar2, kept });

    // 2. lyrics: ALIGNMENT with the timeline (the same t -> the same y, ±2 px), the Notes cells on their rows
    await open('lyrics');
    const ly = await pg.evaluate((ax) => {
      const a = eval(ax), tl = window.WB.timeline, sheet = a.sheet.getBoundingClientRect().top, tsheet = tl.sheet.getBoundingClientRect().top, out = [];
      for (const it of tl.byId.lyrics.items.filter(i => i.first)) {
        const e = a.sc.querySelector(`.lyl[data-line="${CSS.escape(it.line.id)}"]`); if (!e) continue;
        out.push({ id: it.line.id, stage: e.getBoundingClientRect().top - sheet, timeline: it.el.getBoundingClientRect().top - tsheet, warp: tl.warp.y(it.t0) });
      }
      return { out, ms: a.ms, n: tl.byId.lyrics.items.filter(i => i.first).length };
    }, AX);
    const lyBad = ly.out.filter(r => Math.abs(r.stage - r.timeline) > 2 || Math.abs(r.stage - r.warp) > 2);
    check('ALIGNMENT, lyrics: every lyric line in Time sits at the same y as the timeline\'s line for the same t (±2 px; both measured on screen from their axis origin)',
      ly.out.length === ly.n && ly.n > 3 && !lyBad.length, { lines: ly.out.length, bad: lyBad.slice(0, 4), sample: ly.out.slice(0, 3).map(r => [r.id, +r.stage.toFixed(1), +r.timeline.toFixed(1)]), ms: ly.ms });
    const warp1 = await pg.evaluate(() => [5000, 10000, 15000].map(t => window.WB.timeline.warp.y(t)));
    check('the timeline stays laid out behind a stage: its warp y(t) is the same as when it is shown (a hidden timeline used to re-warp at width 0)', warp0.every((y, i) => Math.abs(y - warp1[i]) < 0.5), { warp0, warp1 });
    // the Notes column: a note on a line sits on that line's row
    const lid = ly.out[2].id;
    await pg.evaluate((id) => window.WB.store.noteAdd({ stage: 'lyrics', kind: 'line', id }, 'v19: a note on this line'), lid);
    await until(() => [...document.querySelectorAll('.nclayer .ncn')].some(n => n.textContent.includes('v19: a note on this line')));
    await frames(4);
    const ncAl = await pg.evaluate((id) => { const row = document.querySelector(`.lyl[data-line="${CSS.escape(id)}"]`), n = [...document.querySelectorAll('.nclayer .ncn')].find(x => x.textContent.includes('v19: a note')), cell = n?.closest('.nccell'); return cell ? { row: row.getBoundingClientRect().top, cell: cell.getBoundingClientRect().top, rh: row.getBoundingClientRect().height, ch: cell.getBoundingClientRect().height, fix: cell.classList.contains('ncfix') } : null; }, lid);
    check('the Notes column stays row-aligned, i.e. time-aligned: the note\'s cell starts at its line\'s row and keeps the row\'s height (no growing)', ncAl && Math.abs(ncAl.row - ncAl.cell) <= 2 && Math.abs(ncAl.rh - ncAl.ch) <= 2 && ncAl.fix, ncAl);
    // the playhead: a seek moves the stage's playhead line to y(t)
    const ph = await pg.evaluate((ax) => { const a = eval(ax), tl = window.WB.timeline; tl.seek(7300); return { y: a.head.getBoundingClientRect().top - a.sheet.getBoundingClientRect().top, want: tl.warp.y(7300) }; }, AX);
    check('the playhead: a seek puts the stage\'s playhead line at y(t) of the timeline\'s axis (±2 px)', Math.abs(ph.y - ph.want) <= 2, ph);
    // a click on an empty spot seeks to the ms under the pointer
    const pt = await pg.evaluate((ax, id) => { const a = eval(ax), e = a.sc.querySelector(`.lyl[data-line="${CSS.escape(id)}"]`); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(), w = [...e.querySelectorAll('.w')].pop().getBoundingClientRect(); return { x: Math.round(w.right + 40), y: Math.round(r.top + Math.min(r.height - 2, 6)) }; }, AX, ly.out[4].id);   // past the words, before the row's tools
    await frames(2);
    const want = await pg.evaluate((ax, y) => eval(ax).timeAt(y), AX, pt.y);
    await pg.mouse.click(pt.x, pt.y); await frames(2);
    const got = await pg.evaluate(() => Math.round(window.WB.timeline.player.time()));
    check('a click on an empty spot of the Time view moves the playhead to the ms under the pointer', Math.abs(got - want) <= 2 && want > 0, { want, got });
    // U17 / I3: a click on a row's TEXT seeks to that row's start (t0), not to wherever the text sits
    const wd = await pg.evaluate((ax, id) => { const a = eval(ax), e = a.sc.querySelector(`.lyl[data-line="${CSS.escape(id)}"]`), w = [...e.querySelectorAll('.w')].pop(), r = w.getBoundingClientRect(); window.WB.timeline.seek(0); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), t0: a.rowT0(e), under: a.timeAt(r.top + r.height / 2) }; }, AX, ly.out[5].id);
    await pg.mouse.click(wd.x, wd.y); await frames(2);
    const gotW = await pg.evaluate(() => Math.round(window.WB.timeline.player.time()));
    check('a click on a row\'s text (a lyric line\'s last word) seeks to the row\'s start t0, not to the ms under the pointer', wd.t0 > 0 && Math.abs(gotW - wd.t0) <= 2, { ...wd, got: gotW });
    // right-click > + Add at m:ss > + note at this time: the Notes column's editor on the row at that time
    await pg.mouse.click(pt.x, pt.y, { button: 'right' }); await frames(2);
    const menu = await pg.evaluate(() => [...document.querySelectorAll('.pop .pi .lb')].map(e => e.textContent));
    const addI = await pg.evaluate(() => { const r = [...document.querySelectorAll('.pop .pi')].find(e => /^\+ Add at /.test(e.querySelector('.lb')?.textContent || '')); r?.click(); return !!r; });
    await frames(2);
    await pg.evaluate(() => { const r = [...document.querySelectorAll('.pop .pi')].find(e => (e.querySelector('.lb')?.textContent || '') === '+ note at this time'); r?.click(); });
    await until(() => !!document.querySelector('.nclayer .nced'));
    await pg.keyboard.type('v19: at this time'); await pg.keyboard.press('Enter');
    await until(() => window.WB.store.notes.notes.some(n => n.text === 'v19: at this time'));
    const nt = await pg.evaluate(() => window.WB.store.notes.notes.find(n => n.text === 'v19: at this time')?.target || null);
    check('right-click in Time: "+ Add at m:ss" comes first (at the time under the pointer) and "+ note at this time" notes the row at that time', /^\+ Add at \d+:\d\d$/.test(menu[0] || '') && addI && nt?.kind === 'line' && nt.id === ly.out[4].id, { menu: menu.slice(0, 4), nt });
    // scrolling the stage keeps the timeline's reading time (it is laid out behind)
    await wait(500);   // the saved note's live reload re-renders the stage first
    const sy = await pg.evaluate(async (ax) => { const a = eval(ax); a.scrollToTime(9000); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); a.sc.scrollTop += 140; await new Promise(r => setTimeout(r, 150)); return { st: Math.round(a.timeAtRead()), tl: Math.round(window.WB.timeline.timeAtRead()) }; }, AX);
    check('scroll sync: after scrolling the Time view the timeline reads the same time (±40 ms)', Math.abs(sy.st - sy.tl) <= 40, sy);
    await sideBySide('v19_lyrics');

    // 3. script: each scene at the timeline's scene (the scenes column), its lyric lines at their times
    await open('script');
    const sc = await pg.evaluate((ax) => {
      const a = eval(ax), tl = window.WB.timeline, sheet = a.sheet.getBoundingClientRect().top, tsheet = tl.sheet.getBoundingClientRect().top;
      const sc = tl.byId.scenes.items.filter(i => !i.x.b).map(it => { const e = a.sc.querySelector(`.scrow[data-scene="${CSS.escape(it.x.s.id)}"]`); return e && { id: it.x.s.id, stage: e.getBoundingClientRect().top - sheet, timeline: it.el.getBoundingClientRect().top - tsheet, h: e.getBoundingClientRect().height, th: it.el.getBoundingClientRect().height }; }).filter(Boolean);
      const ls = [...a.sc.querySelectorAll('.scl.tmsub')].map(e => ({ stage: e.getBoundingClientRect().top - sheet, warp: tl.warp.y(Number(e.querySelector('[data-t]').dataset.t)) }));
      return { sc, ls, ms: a.ms };
    }, AX);
    const scBad = sc.sc.filter(r => Math.abs(r.stage - r.timeline) > 2 || Math.abs(r.h - r.th) > 2), lsBad = sc.ls.filter(r => Math.abs(r.stage - r.warp) > 2);
    check('ALIGNMENT, script: each scene row at the timeline\'s scene (same y, same height, ±2 px), its lyric lines at y(t)', sc.sc.length >= 2 && !scBad.length && sc.ls.length >= 3 && !lsBad.length, { scenes: sc.sc.length, bad: scBad.slice(0, 3), lines: sc.ls.length, lineBad: lsBad.slice(0, 3), ms: sc.ms });
    await sideBySide('v19_script');

    // 4. storyboard: each shot at the timeline's shot (the shots column)
    await open('storyboard');
    const sb = await pg.evaluate((ax) => {
      const a = eval(ax), tl = window.WB.timeline, sheet = a.sheet.getBoundingClientRect().top, tsheet = tl.sheet.getBoundingClientRect().top;
      return { ms: a.ms, shots: tl.byId.shots.items.map(it => { const e = a.sc.querySelector(`.sbcard[data-shot="${CSS.escape(it.x.id)}"]`); return e && { id: it.x.id, stage: e.getBoundingClientRect().top - sheet, timeline: it.el.getBoundingClientRect().top - tsheet, h: e.getBoundingClientRect().height, th: it.el.getBoundingClientRect().height }; }).filter(Boolean) };
    }, AX);
    const sbBad = sb.shots.filter(r => Math.abs(r.stage - r.timeline) > 2 || Math.abs(r.h - r.th) > 2);
    check('ALIGNMENT, storyboard: each shot card at the timeline\'s shot (same y, same height, ±2 px), stacked down its scene', sb.shots.length >= 3 && !sbBad.length, { shots: sb.shots.length, bad: sbBad.slice(0, 3), ms: sb.ms });
    await sideBySide('v19_storyboard');

    // 5. breakdown: items x scenes, the scenes ordered and sized by time; a cell links / unlinks
    await open('breakdown');
    const bk = await pg.evaluate((ax) => {
      const a = eval(ax), tl = window.WB.timeline, sheet = a.sheet.getBoundingClientRect().top, ws = window.WB.breakdown.ws;
      const rows = [...a.sc.querySelectorAll('.bdtmr[data-scene]')].map(e => { const s = ws.scenes.find(x => x.id === e.dataset.scene); const r = e.getBoundingClientRect(); return { id: s.id, y: r.top - sheet, h: r.height, want: tl.warp.y(s.t0), wh: tl.warp.y(s.t1) - tl.warp.y(s.t0) }; });
      return { rows, items: a.sc.querySelectorAll('.bdtmh .bdtmi[data-icol]').length, on: a.sc.querySelectorAll('.bdtc.on').length, nc: window.WB.notesCol.visible()?.rows.filter(r => !r.top).length };
    }, AX);
    const bkBad = bk.rows.filter(r => Math.abs(r.y - r.want) > 2 || Math.abs(r.h - r.wh) > 2);
    const ord = bk.rows.every((r, i) => !i || r.y >= bk.rows[i - 1].y);
    await pg.evaluate(() => document.querySelector('.bdtc:not(.on)[data-scene="sc03"]')?.click()); await frames(2);
    const linked = await pg.evaluate(() => window.WB.breakdown.ws.draft.filter(i => i.links.some(l => l.scene === 'sc03')).length);
    check('Breakdown in Time: items x scenes, one row per scene ordered and sized by time (y(t0), y(t1) − y(t0), ±2 px), a column per item, a cell click links; the Notes rows are the scenes',
      bk.rows.length >= 3 && !bkBad.length && ord && bk.items === 3 && bk.on === 5 && linked === 2 && bk.nc === bk.rows.length, { ...bk, rows: bk.rows.slice(0, 3), bad: bkBad.slice(0, 3), linked });
    await sideBySide('v19_breakdown');

    // 6. final: rows grouped by song section, in time order (no time last)
    await open('final');
    await pg.evaluate(() => window.WB.timeMode.setMode('final', 'time')); await until(() => !!document.querySelector('.fnlist.fntime .fntg'));
    const fn = await pg.evaluate(() => {
      const ws = window.WB.final.ws, gs = [...document.querySelectorAll('.fnlist .fntg')].map(g => g.querySelector('b').textContent);
      const keys = [...document.querySelectorAll('.fnlist .fnrow')].map(e => ws.byKey.get(e.dataset.key)), timed = keys.filter(r => r.t0 != null).map(r => r.t0);
      return { gs, sorted: timed.every((t, i) => !i || t >= timed[i - 1]), lastNone: keys.findIndex(r => r.t0 == null) < 0 || keys.slice(keys.findIndex(r => r.t0 == null)).every(r => r.t0 == null), n: keys.length, all: ws.rowsShown().length, tag: !!document.querySelector('.fnrow .fnsg') };
    });
    check('Final in Time: the rows grouped by song section in time order (each tagged with its stage), the rows without a song time last, none lost', fn.gs.length >= 2 && fn.sorted && fn.lastNone && fn.n === fn.all && fn.tag, fn);
    await sideBySide('v19_final');
    await pg.evaluate(() => window.WB.timeMode.setMode('final', 'list'));

    // 6b. U13: a SHORT axis (the timeline's own fit for a short song): 1 s and 2 s shots, scenes of 2 s, at 1280 px. A row
    // under two lines is one line (tmshort); its visible lines lie inside it (nothing cut through or stacked); the
    // scene headers show whole lines only; a short row has its text as a tooltip; a script title keeps ≥ 120 px
    const sh = await call('shots_update', { upsert: [{ id: 's1-intro', t1: 2000 }, { t0: 2000, t1: 4000, kind: 'insert', title: 'boot screen', text: 'CRT boot text scrolls line after line', camera: 'static' },
      { id: 's5-outro', t1: 19000 }, { t0: 19000, t1: 20000, kind: 'insert', title: 'fade', text: 'the screen fades to a dot and the tone stops', camera: 'static' }], message: 'v19: short shots' });
    if (sh.status !== 200) throw new Error('shots_update ' + sh.status + ' ' + JSON.stringify(sh.body));
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await pg.evaluate(() => { const tl = window.WB.timeline; tl.pxPerSec = 16; tl.relayout(); tl.scrollToTime(0); });
    await open('storyboard'); await until(() => document.querySelectorAll('.sblist .sbcard.tmsub').length >= 6); await frames(4); await wait(300);
    const sbs = await pg.evaluate(() => {
      const vis = (e) => e.offsetParent !== null && getComputedStyle(e).display !== 'none';
      const cards = [...document.querySelectorAll('.sblist .sbcard.tmsub')].map(c => { const r = c.getBoundingClientRect();
        const kids = [...c.children].filter(vis).map(k => { const b = k.getBoundingClientRect(); return { cls: k.className.split(' ')[0], top: b.top - r.top, bottom: b.bottom - r.top }; });
        return { id: c.dataset.shot, h: Math.round(r.height), short: c.classList.contains('tmshort'), title: c.title || '', cut: kids.filter(k => k.top < r.height - 1 && k.bottom > r.height + 1).map(k => k.cls), lines: new Set(kids.filter(k => k.top < r.height - 1).map(k => Math.round(k.top))).size, nowrap: getComputedStyle(c.querySelector('.sbtx')).whiteSpace === 'nowrap' }; });
      const heads = [...document.querySelectorAll('.sblist .sbscene.tmrow > .sbsh')].map(s => { const r = s.getBoundingClientRect(), row = s.parentElement.getBoundingClientRect();
        const kids = [...s.children].filter(vis).map(k => k.getBoundingClientRect()).filter(b => b.height > 0);
        return { scene: s.parentElement.dataset.scene, h: Math.round(row.height), inside: r.bottom <= row.bottom + 1, partial: kids.filter(b => b.top < r.bottom - 1 && b.bottom > r.bottom + 1).length }; });
      return { cards, heads };
    });
    const shortCards = sbs.cards.filter(c => c.h < 30);
    check('U13 storyboard on a short axis: a shot under two lines is ONE line (tmshort, nowrap, no child cut through its bottom edge) with its text as a tooltip; the scene headers show whole lines only (none cut, none past the row)',
      shortCards.length >= 2 && shortCards.every(c => c.short && c.nowrap && !c.cut.length && c.lines === 1 && c.title.length > 3) && sbs.heads.length >= 3 && sbs.heads.every(x => x.inside && !x.partial), { short: shortCards, heads: sbs.heads });
    await sideBySide('v19_short_storyboard');
    await open('script'); await until(() => !!document.querySelector('.sclist.tmode .scrow.tmrow')); await frames(4); await wait(200);
    const sct = await pg.evaluate(() => [...document.querySelectorAll('.sclist.tmode .sccard:not(.open) .sct')].map(e => ({ text: e.textContent, w: Math.round(e.getBoundingClientRect().width), clipped: e.scrollWidth > e.clientWidth + 1 })));
    check('U13 script on a short axis at 1280 px: every scene title is whole, or keeps at least 120 px (never "T..")', sct.length >= 3 && sct.every(x => !x.clipped || x.w >= 120), sct);
    // U17 in the script: a click on a lyric line's text in a scene row seeks to that line's time
    const sl = await pg.evaluate((ax) => { const a = eval(ax), e = [...a.sc.querySelectorAll('.scl.tmsub')].at(-1), sp = e.querySelector('span:last-child'), r = sp.getBoundingClientRect(); sp.scrollIntoView({ block: 'center' }); const b = sp.getBoundingClientRect(); window.WB.timeline.seek(0); return { x: Math.round(b.left + Math.min(10, b.width / 2)), y: Math.round(b.top + b.height / 2), t0: a.rowT0(sp), want: Number(e.querySelector('[data-t]').dataset.t) }; }, AX);
    await frames(2); await pg.mouse.click(sl.x, sl.y); await frames(2);
    const gotS = await pg.evaluate(() => Math.round(window.WB.timeline.player.time()));
    check('U17 script: a click on a lyric line\'s text inside a scene row seeks to that line\'s time', Math.abs(gotS - sl.want) <= 2, { ...sl, got: gotS });
    await sideBySide('v19_short_script');
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

    // 7. back to List: the rows leave the axis (no tmode, no positioned rows)
    await open('lyrics');
    await pg.evaluate(() => document.querySelector('.sgbar .sgtm [data-tm=list]').click()); await frames(3);
    const back = await pg.evaluate(() => ({ tmode: !!document.querySelector('.lypoem.tmode'), placed: document.querySelectorAll('.lypoem .tmrow').length, sheet: !!document.querySelector('.lypoem .tmsheet'), mode: window.WB.timeMode.mode('lyrics') }));
    check('back to List: the stage is its list again (no axis, nothing positioned)', !back.tmode && !back.placed && !back.sheet && back.mode === 'list', back);
  } catch (e) { console.error('v19 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-timemode.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyTimeMode({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v19 (time view):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
