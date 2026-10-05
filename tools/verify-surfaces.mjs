// v24 of the headless UI suite (tools/verify.mjs): E2 the lyric gate, F4 one status filter in Media, F5 the stage workspaces
// use the space. Exported so verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-surfaces.mjs [outDir]
// Self-contained: a scratch copy of data/demo, its own server on a free port, an MCP client over stdio; all deleted at the end.
// E2: surfaces_get (nothing covered) -> the agent proposes a surface (surface_propose; off time, a bad where, an unknown line
// refused; no tool to accept, surface_act 403 over HTTP even with via "page") -> the Shot panel shows the lines sung in the shot
// with uncovered words in red and the proposal -> Accept (a NEW storyboard version with shot.lyrics; the proposal accepted) ->
// the director adds one by clicking / Shift+clicking words -> removes one -> the agent's shots_update keeps them -> the timeline's
// surface column (covered words normal, uncovered red) -> the Lyrics stage's count per line -> Final's "every word on a surface"
// (= final_get). F4: Assets › Media shows one status select. F5: one-line help + "?" popover; every stage at 1280x800 and
// 1600x900 without horizontal overflow, the Notes column inside the window, a short poem spread over the height.
// Screenshots v24_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(process.env.WB_VERIFY_PORT ? Number(process.env.WB_VERIFY_PORT) + ((globalThis.__wbVerifyPortN = (globalThis.__wbVerifyPortN ?? -1) + 1) % 10) : 0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sdk = (p) => import(pathToFileURL(path.join(WB, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);
const STAGES = ['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'final'];

export async function verifySurfaces({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v24 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v24-')), DATA = path.join(TMP, 'data'), P = 'gate', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  const cur = () => { const d = J('storyboard.json'); return d.versions.find(v => v.id === d.current); };
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P };
  delete env.WB_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v24 server: ' + d));
  let pg = null, client = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
    const call = async (name, body, page = false) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN, ...(page ? { origin: BASE, 'sec-fetch-site': 'same-origin' } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-surfaces', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* an error text */ } return { error: !!r.isError, body, text: t }; };

    // 1. the gate on a project without surfaces; the agent proposes (never accepts)
    const g0 = (await tool('surfaces_get')).body, tools = (await client.listTools()).tools.map(t => t.name);
    const prop = await tool('surface_propose', { shot: 's2-wall', line: 'verse/0', w: [0, 3], where: 'chat: Notepad, typed letter by letter', why: 'the first words type themselves into the chat as she sings them' });
    const offTime = await tool('surface_propose', { shot: 's1-intro', line: 'verse/0', where: 'chat', why: 'x' });
    const badWhere = await tool('surface_propose', { shot: 's2-wall', line: 'verse/0', where: 'billboard', why: 'x' });
    const noLine = await tool('surface_propose', { shot: 's2-wall', line: 'verse/99', where: 'chat', why: 'x' });
    const agentAct = await call('surface_act', { act: 'accept', proposal: 'sp01' });
    const claimed = await call('surface_act', { act: 'accept', proposal: 'sp01', via: 'page' });
    const sbBefore = fs.existsSync(path.join(PD, 'storyboard.json')) ? J('storyboard.json').current : null;
    check('surfaces_get: no word on a surface yet (57 words, 0 covered, uncovered runs per line); surface_propose writes an open proposal (surfaces.json); a line not sung during the shot, an unknown where kind and an unknown line are refused; no tool accepts, and surface_act without the page is 403 (also with via "page")',
      g0.ok === false && g0.total === 57 && g0.covered === 0 && g0.uncovered.length === 9 && !prop.error && prop.body.proposal?.status === 'open' && J('surfaces.json').proposals.length === 1
      && offTime.error && /not sung during s1-intro/.test(offTime.text) && badWhere.error && /starts with one of/.test(badWhere.text) && noLine.error && /error 404/.test(noLine.text)
      && tools.includes('surfaces_get') && tools.includes('surface_propose') && !tools.some(t => /^surface_act$/.test(t)) && agentAct.status === 403 && claimed.status === 403 && !sbBefore,
      { total: g0.total, prop: prop.body?.changed, off: offTime.text.slice(0, 90), bad: badWhere.text.slice(0, 60), agentAct: agentAct.status, claimed: claimed.status });

    // 2. the page: the Shot panel's "lyrics on screen"
    pg = await browser.newPage();
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    pg.on('pageerror', e => { errors.push(e.message); console.error('v24 pageerror', e.stack || e.message); });
    pg.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const shot = async (n, sel, pad = 6) => {
      await frames(3); await wait(200);
      let clip;
      if (sel) clip = await pg.evaluate((s, p) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.max(0, r.left - p), y: Math.max(0, r.top - p), width: Math.min(innerWidth, r.width + 2 * p), height: Math.max(10, Math.min(innerHeight - Math.max(0, r.top - p), r.height + 2 * p)) }; }, sel, pad);
      await pg.screenshot({ path: path.join(OUT, `${n}.png`), ...(clip ? { clip } : {}) });
    };
    const box = (sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, sel);
    const clickSel = async (sel, mods = []) => { const b = await box(sel); if (!b) return false; for (const k of mods) await pg.keyboard.down(k); await pg.mouse.click(b.x + b.w / 2, b.y + b.h / 2); for (const k of mods) await pg.keyboard.up(k); await wait(250); return true; };
    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(3);
    await pg.evaluate(() => window.WB.stages.open('storyboard')); await wait(600);
    await pg.evaluate(() => window.WB.storyboard.focus('s2-wall')); await wait(500);
    await until(() => !!document.querySelector('.sbins .sfx .sfp [data-sf="ok"]'));
    const p0 = await pg.evaluate(() => ({ rows: [...document.querySelectorAll('.sbins .sfx .sfrow')].map(r => r.querySelector('.sfid').textContent), red: document.querySelectorAll('.sbins .sfx .sfw.un').length, props: document.querySelectorAll('.sbins .sfx .sfp').length }));
    await shot('v24_shot_panel_proposal', '.sbins .sfx');
    await clickSel('.sbins .sfx .sfp [data-sf="ok"]');
    await until(() => (window.WB.storyboard.ws.cur?.shots.find(s => s.id === 's2-wall')?.lyrics || []).length === 1, null, 6000);
    const c1 = cur(), s1 = c1.shots.find(s => s.id === 's2-wall');
    check('the Shot panel lists the lyric lines sung in the shot (uncovered words red) and the agent\'s proposal; Accept writes a NEW storyboard version (director, page) with shot.lyrics and marks the proposal accepted',
      p0.rows.join(',') === 'verse/0,verse/1' && p0.red > 10 && p0.props === 1 && J('storyboard.json').current !== sbBefore && c1.via === 'page' && c1.by === 'director'
      && s1.lyrics?.[0]?.line === 'verse/0' && String(s1.lyrics[0].w) === '0,3' && s1.lyrics[0].where === 'chat: Notepad, typed letter by letter' && J('surfaces.json').proposals[0].status === 'accepted',
      { p0, lyrics: s1.lyrics, version: J('storyboard.json').current });

    // 3. the director adds one: click word 0 of verse/1, Shift+click word 7 (the whole line), kind "window", a detail, + surface
    await until(() => !!document.querySelector('.sbins .sfx [data-sfw="verse/1:0"]'));
    await pg.evaluate(() => { const s = document.querySelector('.sbins .sf-line'); s.value = 'verse/1'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await clickSel('.sbins .sfx [data-sfw="verse/1:0"]'); await clickSel('.sbins .sfx [data-sfw="verse/1:7"]', ['Shift']);
    const rng = await pg.evaluate(() => document.querySelector('.sbins .sfrng')?.textContent);
    await pg.evaluate(() => { const k = document.querySelector('.sbins .sf-kind'); k.value = 'window'; k.dispatchEvent(new Event('change', { bubbles: true })); const d = document.querySelector('.sbins .sf-detail'); d.focus(); });
    await pg.keyboard.type('Untitled - Notepad');
    await clickSel('.sbins .sfx [data-sf="add"]');
    await until(() => (window.WB.storyboard.ws.cur?.shots.find(s => s.id === 's2-wall')?.lyrics || []).length === 2, null, 6000);
    // and a third one to remove again
    await clickSel('.sbins .sfx [data-sfw="verse/1:2"]');
    await pg.evaluate(() => { const k = document.querySelector('.sbins .sf-kind'); k.value = 'taskbar'; k.dispatchEvent(new Event('change', { bubbles: true })); });
    await clickSel('.sbins .sfx [data-sf="add"]');
    await until(() => (window.WB.storyboard.ws.cur?.shots.find(s => s.id === 's2-wall')?.lyrics || []).length === 3, null, 6000);
    const n3 = (cur().shots.find(s => s.id === 's2-wall').lyrics || []).length;
    await until(() => document.querySelectorAll('.sbins .sfx .sfe').length === 3);
    await pg.evaluate(() => [...document.querySelectorAll('.sbins .sfx .sfe [data-sf="rm"]')].pop().click());
    await until(() => (window.WB.storyboard.ws.cur?.shots.find(s => s.id === 's2-wall')?.lyrics || []).length === 2, null, 6000);
    const s2 = cur().shots.find(s => s.id === 's2-wall');
    await until(() => document.querySelectorAll('.sbins .sfx .sfe').length === 2);
    await shot('v24_shot_panel_surfaces', '.sbins .sfx');
    check('the director adds a surface by clicking a word and Shift+clicking another (a range; the whole line is stored without w), a kind and a detail, then removes one (×): each a new version',
      /w0–7/.test(rng || '') && n3 === 3 && s2.lyrics.length === 2 && s2.lyrics[1].line === 'verse/1' && s2.lyrics[1].w === undefined && s2.lyrics[1].where === 'window: Untitled - Notepad' && !errors.length,
      { rng, lyrics: s2.lyrics, errors });

    // 4. the agent edits the shot: the surfaces are kept (its own lyrics ignored with a warning)
    const up = await tool('shots_update', { upsert: [{ id: 's2-wall', camera: 'slow push in', lyrics: [] }] });
    const s4 = cur().shots.find(s => s.id === 's2-wall');
    const pageSave = await pg.evaluate(async () => { const d = await (await fetch('/data/gate/storyboard.json', { cache: 'no-cache' })).json(); const v = d.versions.find(x => x.id === d.current); const s = v.shots.find(x => x.id === 's2-wall'); s.lyrics = [{ line: 'verse/2', where: 'chat: forged' }];
      d.versions.push({ ...v, id: 'v999', n: 999, shots: v.shots }); d.current = 'v999';
      const r = await fetch('/api/save/storyboard.json?project=gate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': document.querySelector('meta[name="wb-token"]').content }, body: JSON.stringify({ base_rev: d.rev, data: d }) }); return r.status; });
    const s4b = cur().shots.find(s => s.id === 's2-wall');
    check('the agent\'s shots_update carries the surfaces forward (its own lyrics ignored with a warning), and a page save of storyboard.json keeps the server\'s surfaces (a forged one is replaced)',
      !up.error && s4.camera === 'slow push in' && s4.lyrics?.length === 2 && (up.body.warnings || []).some(w => /lyrics ignored/.test(w)) && pageSave === 200 && JSON.stringify(s4b.lyrics) === JSON.stringify(s4.lyrics),
      { warnings: up.body?.warnings, pageSave, kept: s4b.lyrics });

    // 5. the timeline's surface column: covered words read normally, uncovered ones red
    const g1 = (await tool('surfaces_get')).body;
    await pg.evaluate(() => window.WB.app.show('timeline')); await wait(800);
    await until(() => document.querySelectorAll('.col-surface .sfw').length > 20, null, 8000);
    const col = await pg.evaluate(() => { const on = [...document.querySelectorAll('.col-surface .sfw.on')], un = [...document.querySelectorAll('.col-surface .sfw.un')];
      return { on: on.length, un: un.length, unColor: un[0] ? getComputedStyle(un[0]).color : null, onColor: on[0] ? getComputedStyle(on[0]).color : null, title: on[0]?.title, head: !!document.querySelector('.colhead .nm[title="surface"], .col-surface') }; });
    const cb = await pg.evaluate(() => { const c = document.querySelector('.col-surface'), l = document.querySelector('.col-lyrics'); const it = document.querySelector('.col-surface .sfl'); it?.scrollIntoView({ block: 'start' }); const a = (l || c).getBoundingClientRect(), b = c.getBoundingClientRect(); return { x: Math.max(0, Math.min(a.left, b.left) - 4), y: 40, width: Math.min(innerWidth, Math.max(a.right, b.right) - Math.min(a.left, b.left) + 8), height: Math.min(innerHeight - 40, 520) }; });
    await frames(3); await pg.screenshot({ path: path.join(OUT, 'v24_surface_column.png'), clip: cb });
    const red = (c) => { const m = /rgb\((\d+), (\d+), (\d+)/.exec(c || ''); return m && +m[1] > 200 && +m[2] < 140 && +m[3] < 140; };
    check('the timeline\'s surface column: the covered words read normally (hover: shot · where), the uncovered ones red; the counts match surfaces_get',
      col.on === g1.covered && col.on === 12 && col.un === g1.total - g1.covered && red(col.unColor) && !red(col.onColor) && /s2-wall · chat: Notepad/.test(col.title || ''), { col, covered: g1.covered, total: g1.total });

    // 6. the Lyrics stage: a coverage count per line (and the kinds that show it)
    await pg.evaluate(() => window.WB.stages.open('lyrics')); await wait(700);
    await until(() => document.querySelectorAll('.lypoem .lysf').length === 9);
    const ly = await pg.evaluate(() => Object.fromEntries([...document.querySelectorAll('.lypoem .lyl')].map(l => [l.dataset.line, `${l.querySelector('.lysf')?.textContent} ${[...l.querySelectorAll('.lysfk')].map(k => k.textContent).join('+')}`.trim()])));
    await shot('v24_lyrics_counts', '.lypoem');
    check('the Lyrics stage shows each line\'s coverage (words on a surface / words) and where it shows', ly['verse/0'] === '4/7 chat' && ly['verse/1'] === '8/8 window' && ly['intro/0'] === '0/4', ly);

    // 7. Final: "every word on a surface" (C2), the same as final_get
    const fg = (await tool('final_get')).body, line = fg.checklist?.find(c => c.id === 'lyrics');
    await pg.evaluate(() => window.WB.stages.open('final')); await wait(700);
    await until(() => !!document.querySelector('.fnci[data-ck="lyrics"]'));
    const fl = await pg.evaluate(() => { const e = document.querySelector('.fnci[data-ck="lyrics"]'); return e ? { text: e.textContent.replace(/\s+/g, ' ').trim().slice(0, 160), ok: e.classList.contains('ok'), gaps: e.querySelectorAll('.fngaps a').length } : null; });
    await shot('v24_final_lyrics', '.fnci[data-ck="lyrics"]', 4);
    check('Final\'s checklist: "every word on a surface" fails with the count and the uncovered runs as links (as final_get says)',
      line && !line.ok && /12 of 57 words on a surface/.test(line.detail) && line.gaps.length >= 7 && fl && !fl.ok && /every word on a surface/.test(fl.text) && /12 of 57/.test(fl.text) && fl.gaps > 0, { line: line && { detail: line.detail, gaps: line.gaps.length }, fl });

    // 8. F4: Assets › Media has ONE status filter (the bin's); the page bar's is hidden there and back on Characters
    await pg.evaluate(() => window.WB.app.show('media')); await wait(600);
    const f4 = await pg.evaluate(() => { const vis = (e) => !!e && e.offsetParent !== null; const all = [...document.querySelectorAll('.pgwrap[data-page="assets"] select')].filter(vis).filter(s => [...s.options].some(o => /any status/.test(o.textContent))); return all.length; });
    await shot('v24_media_filters', '.pgwrap[data-page="assets"] .subarea', 0);
    await pg.evaluate(() => window.WB.app.show('characters')); await wait(400);
    const f4c = await pg.evaluate(() => { const s = document.querySelector('.pgwrap[data-page="assets"] .asst'); return !!s && s.offsetParent !== null; });
    check('F4: Assets › Media shows one "any status" filter (the page bar\'s approval status is hidden there; it is back on Characters)', f4 === 1 && f4c, { f4, f4c });

    // 9. F5: the one-line help + "?" popover (Storyboard with no shot), Esc closes it
    await pg.evaluate(() => window.WB.stages.open('storyboard')); await wait(500);
    await pg.evaluate(() => { window.WB.storyboard.ws.setSide('shot'); window.WB.storyboard.ws.select(null, { seek: false }); }); await wait(300);
    await until(() => !!document.querySelector('.sbside .hlpd summary'));
    const lines0 = await pg.evaluate(() => { const v = document.querySelector('.sbside .lyvh'); return v ? Math.round(v.getBoundingClientRect().height) : null; });
    await clickSel('.sbside .hlpd summary');
    const pop = await pg.evaluate(() => { const p = document.querySelector('.sbside .hlpd[open] .hlppop'); if (!p) return null; const r = p.getBoundingClientRect(); return { w: Math.round(r.width), inside: r.left >= 0 && r.right <= innerWidth, hit: p.contains(document.elementFromPoint(r.left + 12, r.top + 12)), text: p.textContent.slice(0, 60) }; });
    await shot('v24_help_popover', '.sbside');
    await pg.keyboard.press('Escape'); await wait(200);
    const closed = await pg.evaluate(() => !document.querySelector('.hlpd[open]'));
    const gate = await pg.evaluate(() => ({ head: [...document.querySelectorAll('.sbside .sbgh')].map(h => h.textContent.replace(/\s+/g, ' ').trim()), runs: document.querySelectorAll('.sbside .sbgap .sfun').length }));
    check('F5: the storyboard\'s side panel is one line of help with a "?" popover (opens inside the window, Esc closes it), then the lyric gate\'s uncovered runs and the gap counts instead of prose',
      lines0 && lines0 <= 22 && pop && pop.inside && pop.hit && /tile/.test(pop.text) && closed && gate.head.some(h => /lyric gate\s*12\/57/i.test(h)) && gate.runs >= 7, { lines0, pop, closed, gate });

    // 10. F5: every stage at 1280x800 and 1600x900: no horizontal overflow, the Notes column inside the window, a short poem fills the height
    const layout = {};
    for (const [w, h] of [[1280, 800], [1600, 900]]) {
      await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); await wait(400);
      for (const s of STAGES) {
        await pg.evaluate((x) => window.WB.stages.open(x), s); await wait(700);
        if (s === 'storyboard') { await pg.evaluate(() => window.WB.storyboard.ws.select(null, { seek: false })); await wait(200); }
        await frames(3);
        layout[`${s}_${w}`] = await pg.evaluate((x) => {
          const host = document.querySelector(`.sghost[data-stage="${x}"]`), nc = host?.querySelector('.nclayer'), r = nc?.getBoundingClientRect();
          const poem = x === 'lyrics' ? host.querySelector('.lypoem') : null, rows = poem ? [...poem.querySelectorAll('.lyl')] : [];
          const fill = poem ? Math.round((rows[rows.length - 1].getBoundingClientRect().bottom - poem.getBoundingClientRect().top) / poem.clientHeight * 100) : null;
          return { over: document.documentElement.scrollWidth > innerWidth + 1, nc: !!nc, ncIn: !nc || (r.right <= innerWidth + 1 && r.width >= 200), fill };
        }, s);
        await pg.screenshot({ path: path.join(OUT, `v24_stage_${s}_${w}.png`) });
      }
    }
    const bad = Object.entries(layout).filter(([, v]) => v.over || !v.ncIn);
    check('F5: every stage at 1280x800 and 1600x900: no horizontal page overflow, a Notes column inside the window, and the short demo poem spread over ≥ 60 % of the Lyrics stage\'s height (35 % before F5)',
      !bad.length && Object.values(layout).every(v => v.nc) && layout.lyrics_1280.fill >= 60 && layout.lyrics_1600.fill >= 60, { bad, lyrics: [layout.lyrics_1280.fill, layout.lyrics_1600.fill] });
  } catch (e) { console.error('v24 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await client?.close().catch(() => {});
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-surfaces.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifySurfaces({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v24 (lyric gate, F4, F5):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
