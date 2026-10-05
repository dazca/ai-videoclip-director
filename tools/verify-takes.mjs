// v16 of the headless UI suite (tools/verify.mjs): take selection (ROADMAP_v4 D6). Exported so verify.mjs runs it after
// the other blocks; runnable alone:   node tools/verify-takes.mjs [outDir]
// Self-contained: a scratch copy of data/demo, placeholder takes made with ffmpeg (4 s, 24 fps, VP8 webm; never fal), its
// own server on a free port, an MCP client over stdio; all deleted at the end. The cycle: a done request on shot s2-wall
// with 3 runner outputs + an imported file linked to the shot -> takes_get lists them (fps, duration) -> the agent proposes
// a take with in / out (take_propose; out of range refused; no tool to pick, 403 over HTTP) -> the Shot panel shows the
// cards (hover scrubs the video) -> the director drags the in / out handles (snapped to frames), writes a note, picks ->
// storyboard.json gets a NEW version with shot.clip (approvals untouched) -> picks the agent's proposal in one click ->
// marks an alternative for a song time -> A/B in the dock -> the agent's shots_update keeps the pick -> the timeline clip
// column shows the pick with in / out -> Final counts picked takes -> Review › Takes per request. Screenshots v16_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sdk = (p) => import(pathToFileURL(path.join(WB, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);
// a placeholder take: a lavfi pattern, 4 s at 24 fps, 320x180, VP8 in webm (plays in any Chromium build)
const take = (file, src) => { fs.mkdirSync(path.dirname(file), { recursive: true }); return spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src}=size=320x180:rate=24:duration=4`, '-c:v', 'libvpx', '-b:v', '300k', '-pix_fmt', 'yuv420p', file]).status === 0; };

export async function verifyTakes({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v16 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { check('ffmpeg is on PATH (placeholder takes)', false); return { checks, pass: false }; }
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v16-')), DATA = path.join(TMP, 'data'), P = 'takes', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  // the runner's outputs of an approved, done shot-video request (as lib/run.mjs leaves them) and an imported file
  const RQ = 'rv16shot', SHOT = 's2-wall';
  const made = ['testsrc', 'testsrc2', 'smptebars'].map((src, i) => take(path.join(PD, 'gen', RQ, `${RQ}_${i}.webm`), src)).concat(take(path.join(TMP, 'import', 'handheld.webm'), 'rgbtestsrc'));
  const R = J('requests.json'); R.items.push({ id: RQ, kind: 'shot-video', target: `shot:${SHOT}`, prompt: 'the wall breathes', refs: [], est_cost: 0.48, status: 'done', by: 'agent', at: '2026-10-05T10:00:00', tool: 'minimax/h3-max/image-to-video',
    outputs: [0, 1, 2].map(i => `gen/${RQ}/${RQ}_${i}.webm`), actual_cost_usd: 0.48, log: [{ at: '2026-10-05T10:00:00', by: 'director', via: 'page', status: 'approved', director_approved: true }, { at: '2026-10-05T10:01:00', by: 'agent', status: 'done' }] });
  R.rev = (R.rev || 0) + 1; fs.writeFileSync(path.join(PD, 'requests.json'), JSON.stringify(R, null, 1));
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P };
  delete env.WB_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v16 server: ' + d));
  let pg = null, client = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
    const call = async (name, body, page = false) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN, ...(page ? { origin: BASE } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-takes', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* an error text */ } return { error: !!r.isError, body, text: t }; };

    // 1. registered media: the runner's 3 outputs (media_add as request_update done does it) and an import linked to the shot
    for (let i = 0; i < 3; i++) await tool('media_add', { path: `gen/${RQ}/${RQ}_${i}.webm`, kind: 'clip', label: `shot-video ${SHOT} · ${RQ}`, job: RQ, take: i, request: RQ, shots: [SHOT] });
    const imp = await tool('media_add', { path: path.join(TMP, 'import', 'handheld.webm'), kind: 'clip', label: 'handheld pass (imported)', shots: [SHOT] });
    const tg = (await tool('takes_get', { shot: SHOT })).body, tr = (await tool('takes_get', { request: RQ })).body;
    const rq = (tg.takes || []).filter(t => t.request === RQ);
    check('takes_get: a shot\'s takes = the runner outputs of its request (take numbers, fps 24, duration 4 s, absolute files) + the imported file + the older clip takes; per request: its 3 outputs',
      made.every(Boolean) && rq.length === 3 && rq.every((t, i) => t.take === i && t.fps === 24 && Math.abs(t.duration_ms - 4000) < 60 && t.abs && fs.existsSync(t.abs) && t.source === 'runner')
      && tg.takes.some(t => t.media === imp.body?.media?.id && t.source === 'import') && tr.takes?.length === 3 && tg.picked === null,
      { n: tg.takes?.length, rq: rq.map(t => [t.media, t.take, t.fps, t.duration_ms]), imp: imp.body?.media?.id, perReq: tr.takes?.length });
    const M2 = rq[2]?.media, M1 = rq[1]?.media, M0 = rq[0]?.media;

    // 2. the agent proposes (never picks)
    const tools = (await client.listTools()).tools.map(t => t.name);
    const prop = await tool('take_propose', { shot: SHOT, media: M2, in_ms: 500, out_ms: 2500, why: 'take 2: the bars settle at 0.5 s; take 0 drifts. Alternative for 6.5 s: take 1' });
    const bad = await tool('take_propose', { shot: SHOT, media: M2, in_ms: 0, out_ms: 9000, why: 'too long' });
    const unreg = await tool('take_propose', { shot: SHOT, file: 'gen/rv16shot/nope.webm', why: 'not registered' });
    const agentPick = await call('take_act', { act: 'pick', shot: SHOT, media: M2, in_ms: 0, out_ms: 1000 });
    const claimed = await call('take_act', { act: 'pick', shot: SHOT, media: M2, in_ms: 0, out_ms: 1000, via: 'page' });
    check('take_propose writes an open proposal (takes.json) with in / out and why; out past the take\'s duration and an unregistered file are refused; there is no tool to pick and take_act without the page\'s Origin is 403 (also with via:"page" in the body)',
      !prop.error && prop.body.proposal?.status === 'open' && J('takes.json').proposals.length === 1 && bad.error && /inside the take/.test(bad.text) && unreg.error && /registered media/.test(unreg.text)
      && !tools.includes('take_act') && tools.includes('takes_get') && tools.includes('take_propose') && agentPick.status === 403 && claimed.status === 403,
      { prop: prop.body?.changed, bad: bad.text.slice(0, 80), unreg: unreg.text.slice(0, 80), agentPick: agentPick.status, claimed: claimed.status });

    // 3. the page: the Shot panel's takes
    pg = await browser.newPage();
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v16 pageerror', e.stack || e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.error('v16 console', m.text()); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const shot = async (n, sel, pad = 6) => {
      await frames(3); await wait(200);
      let clip;
      if (sel) clip = await pg.evaluate((s, p) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.max(0, r.left - p), y: Math.max(0, r.top - p), width: Math.min(innerWidth, r.width + 2 * p), height: Math.min(innerHeight - Math.max(0, r.top - p), r.height + 2 * p) }; }, sel, pad);
      await pg.screenshot({ path: path.join(OUT, `${n}.png`), ...(clip ? { clip } : {}) });
    };
    const box = (sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, sel);
    const clickSel = async (sel, mods = []) => { const b = await box(sel); if (!b) return false; for (const k of mods) await pg.keyboard.down(k); await pg.mouse.click(b.x + b.w / 2, b.y + b.h / 2); for (const k of mods) await pg.keyboard.up(k); await wait(250); return true; };
    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(3);
    await pg.evaluate(() => window.WB.stages.open('storyboard')); await wait(600);
    await pg.evaluate((s) => window.WB.storyboard.focus(s), SHOT); await wait(500);
    await until(() => document.querySelectorAll('.sbins .tkc').length >= 4);
    await until(() => [...document.querySelectorAll('.sbins .tkc img')].every(i => i.complete));
    const cards = await pg.evaluate(() => [...document.querySelectorAll('.sbins .tkc')].map(c => ({ id: c.dataset.tk, kind: c.dataset.tkind, w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) })));
    const propRow = await pg.evaluate(() => !!document.querySelector('.sbins .tkp.s-open [data-tk-a=ppick]'));
    await shot('v16_takes_strip', '.sbins .tkw');
    // hover-scrub: the pointer over the right part of a card seeks its video there
    const cb = await box(`.sbins .tkc[data-tk="${M1}"] .tkth`);
    await pg.mouse.move(cb.x + 4, cb.y + cb.h / 2); await wait(120); await pg.mouse.move(cb.x + cb.w * 0.8, cb.y + cb.h / 2);
    await until((m) => { const v = document.querySelector(`.sbins .tkc[data-tk="${m}"] video`); return v && v.readyState >= 2 && v.currentTime > 2; }, M1, 6000);
    const scrub = await pg.evaluate((m) => { const v = document.querySelector(`.sbins .tkc[data-tk="${m}"] video`); return v ? { t: +v.currentTime.toFixed(2), ready: v.readyState } : null; }, M1);
    await shot('v16_hover_scrub', `.sbins .tkc[data-tk="${M1}"]`, 4);
    check('the Shot panel shows every take as a compact card (thumbnail, take name, length; ★ / ◆ badges), the agent\'s proposal with a one-click Pick, and hovering a card scrubs its video (80 % of the width = ~3.2 s)',
      cards.length === tg.takes.length && cards.every(c => c.w <= 110 && c.h <= 80) && propRow && scrub && scrub.t > 2.6 && scrub.t < 3.8, { cards: cards.length, size: cards[0], scrub });
    await pg.mouse.move(5, 5); await wait(150);

    // 4. click a card (it opens in the editor), drag the in / out handles (snapped to 24 fps frames), a note, Pick take
    await clickSel(`.sbins .tkc[data-tk="${M1}"] .tkl`);
    await until(() => !!document.querySelector('.sbins .tked video.tkvid'));
    const sb = await box('.sbins .tkstrip');
    const drag = async (h, frac) => { const b = await box(`.sbins .tkh[data-h=${h}]`); await pg.mouse.move(b.x + b.w / 2, b.y + b.h / 2); await pg.mouse.down(); await pg.mouse.move(sb.x + sb.w * frac, sb.y + sb.h / 2, { steps: 6 }); await pg.mouse.up(); await wait(150); };
    await drag('out', 0.7); await drag('in', 0.2);
    const rng = await pg.evaluate(() => ({ in: document.querySelector('.sbins .tkin').value, out: document.querySelector('.sbins .tkout').value, len: document.querySelector('.sbins .tklen').textContent, fit: document.querySelector('.sbins .tkfit').textContent }));
    await pg.evaluate(() => { const n = document.querySelector('.sbins .tknote'); n.focus(); });
    await pg.keyboard.type('use the settle; add a code push');
    await shot('v16_inout_handles', '.sbins .tked');
    const ap0 = J('approvals.json').items?.['shot:' + SHOT]?.state || 'draft', v0 = fs.existsSync(path.join(PD, 'storyboard.json')) ? J('storyboard.json').current : null;
    await clickSel('.sbins [data-tk-a=pick]');
    await until(() => !!window.WB.store.board && window.WB.storyboard.ws.cur?.shots.find(s => s.id === 's2-wall')?.clip, null, 6000);
    const SBJ = J('storyboard.json'), cur = SBJ.versions.find(v => v.id === SBJ.current), clip = cur.shots.find(s => s.id === SHOT).clip, f = 1000 / 24;
    const onFrame = (ms) => Math.abs(ms / f - Math.round(ms / f)) < 0.6 / f * f;
    check('the director drags in / out on the mini strip (snapped to the take\'s frames, the readout follows), writes a note and picks: storyboard.json gets a NEW version (director, page) with shot.clip {request, take, file, in_ms, out_ms, note}; the approval is untouched',
      clip && clip.request === RQ && clip.take === 1 && clip.file === `gen/${RQ}/${RQ}_1.webm` && clip.in_ms > 600 && clip.in_ms < 1000 && clip.out_ms > 2600 && clip.out_ms < 3000 && onFrame(clip.in_ms) && onFrame(clip.out_ms)
      && clip.note === 'use the settle; add a code push' && clip.by === 'director' && clip.via === 'page' && SBJ.current !== v0 && cur.via === 'page' && (J('approvals.json').items?.['shot:' + SHOT]?.state || 'draft') === ap0 && /f @24/.test(rng.len),
      { clip, rng, version: SBJ.current, was: v0 });

    // 5. one click on the agent's proposal: its take and range become the pick; the proposal is "picked"
    await until(() => !!document.querySelector('.sbins .tkp.s-open [data-tk-a=ppick]'));
    await clickSel('.sbins .tkp.s-open [data-tk-a=ppick]');
    await until((m) => window.WB.storyboard.ws.cur?.shots.find(s => s.id === 's2-wall')?.clip?.media === m, M2, 6000);
    const c2 = J('storyboard.json').versions.find(v => v.id === J('storyboard.json').current).shots.find(s => s.id === SHOT).clip;
    check('Pick on the agent\'s proposal: one click makes its take and range the pick (a new version, proposal "picked" in takes.json)',
      c2?.media === M2 && c2.in_ms === 500 && c2.out_ms === 2500 && c2.proposal === prop.body.proposal.id && J('takes.json').proposals[0].status === 'picked', { c2, p: J('takes.json').proposals[0]?.status });

    // 6. an alternative: take 1 for 0:06.50
    await clickSel(`.sbins .tkc[data-tk="${M1}"] .tkl`);
    await pg.evaluate(() => { const t = document.querySelector('.sbins .tkaltt'); t.value = '0:06.50'; t.dispatchEvent(new Event('input', { bubbles: true })); const n = document.querySelector('.sbins .tkaltn'); n.value = 'bigger smile'; n.dispatchEvent(new Event('input', { bubbles: true })); });
    await clickSel('.sbins [data-tk-a=alt]');
    await until(() => (window.WB.storyboard.ws.cur?.shots.find(s => s.id === 's2-wall')?.clip?.alt || []).length === 1, null, 6000);
    const c3 = J('storyboard.json').versions.find(v => v.id === J('storyboard.json').current).shots.find(s => s.id === SHOT).clip;
    await until(() => !!document.querySelector('.sbins .tkalt1'));
    await shot('v16_alternatives', '.sbins .tkw');
    check('"+ alt" marks the selected take as an alternative for a song time (alt [{take, file, t, note}] on the pick; the pick and its proposal link unchanged; no unsaved storyboard edit from the clicks); shown under the editor and as "alt" on the card',
      !(await pg.evaluate(() => window.WB.storyboard.ws.dirty)) && c3?.media === M2 && c3.proposal === prop.body.proposal.id && J('takes.json').proposals[0].status === 'picked' && c3.alt?.length === 1 && c3.alt[0].take === 1 && c3.alt[0].t === 6500 && c3.alt[0].note === 'bigger smile' && await pg.evaluate((m) => !!document.querySelector(`.sbins .tkc[data-tk="${m}"] .tkal`), M1),
      { alt: c3?.alt });

    // 7. A/B in the dock: Shift+click a card = B; A/B plays the two in lockstep over their ranges
    await clickSel(`.sbins .tkc[data-tk="${M0}"] .tkl`, ['Shift']);
    await clickSel('.sbins [data-tk-a=ab]');
    await until(() => document.querySelectorAll('.dock .cmp.ab video').length === 2);
    await until(() => [...document.querySelectorAll('.dock .cmp.ab video')].every(v => v.readyState >= 2), null, 6000);
    const ab = await pg.evaluate(() => ({ vids: document.querySelectorAll('.dock .cmp.ab video').length, labels: [...document.querySelectorAll('.dock .cmp.ab .ct b')].map(b => b.textContent), title: document.querySelector('.dock .dt')?.textContent }));
    await shot('v16_ab_dock', '.dock');
    check('A/B: the dock shows A (the selected take) and B (Shift+click) side by side, each over its in → out, in lockstep', ab.vids === 2 && /^A/.test(ab.labels[0]) && /^B/.test(ab.labels[1]) && /A .+ B /.test(ab.title || ''), ab);
    await pg.evaluate(() => window.WB.dock.close?.());

    // 8. the agent edits the shot: the pick is kept (and a clip it sends is ignored, with a warning)
    const up = await tool('shots_update', { upsert: [{ id: SHOT, camera: 'slow push in', clip: { file: `gen/${RQ}/${RQ}_0.webm`, in_ms: 0, out_ms: 1000 } }] });
    const c4 = J('storyboard.json').versions.find(v => v.id === J('storyboard.json').current).shots.find(s => s.id === SHOT);
    check('the agent\'s shots_update carries the pick forward unchanged (its own clip ignored with a warning): only the page picks',
      !up.error && c4.camera === 'slow push in' && c4.clip?.media === M2 && c4.clip.alt?.length === 1 && (up.body.warnings || []).some(w => /clip ignored/.test(w)), { warnings: up.body?.warnings, clip: c4.clip?.media });

    // 9. the timeline clip column: the pick over the shot's time, with in–out
    await pg.evaluate(() => window.WB.app.show('timeline')); await wait(700);
    await pg.evaluate(() => { const c = window.WB.timeline?.columns?.find?.(x => x.id === 'clips'); if (c && c.hidden) window.WB.commands.run('view.column.clips'); });
    await until(() => !!document.querySelector('.col-clips .use.pick'), null, 6000);
    const tl = await pg.evaluate(() => { const e = document.querySelector('.col-clips .use.pick'); return e ? { txt: e.querySelector('.cap').textContent, title: e.title, sel: e.dataset.sel, img: !!e.querySelector('img') } : null; });
    await pg.evaluate(() => { const e = document.querySelector('.col-clips .use.pick'); e?.scrollIntoView({ block: 'center' }); }); await wait(300);
    const colBox = await pg.evaluate(() => { const e = document.querySelector('.col-clips .use.pick'), r = e.getBoundingClientRect(), col = e.closest('.col-clips')?.getBoundingClientRect() || r; return { x: Math.max(0, col.left - 240), y: Math.max(0, r.top - 60), width: Math.min(560, innerWidth), height: Math.min(r.height + 120, 400) }; });
    await frames(3); await pg.screenshot({ path: path.join(OUT, 'v16_timeline_clip.png'), clip: colBox });
    check('the timeline clip column shows the picked take over its shot (★ take name, in–out seconds, its frame, the alternatives count)', tl && /★t2/.test(tl.txt) && /rv16shot\.2/.test(tl.title) && /0\.5–2\.5/.test(tl.txt) && /\+1/.test(tl.txt) && tl.sel === 'shot:' + SHOT, tl);

    // 10. Final: the checklist counts picked takes (final_get and the page)
    const fg = (await tool('final_get')).body, tk = fg.checklist?.find(c => c.id === 'takes');
    await pg.evaluate(() => window.WB.stages.open('final')); await wait(700);
    const fl = await pg.evaluate(() => { const e = document.querySelector('.fnci[data-ck="takes"]'); return e ? e.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : null; });
    if (fl) await shot('v16_final_takes', '.fnci[data-ck="takes"]', 4);
    check('Final: "every shot has a picked take" counts the picks (1 of N; the others listed as gaps that open the storyboard)', tk && !tk.ok && /^1 of \d+ shots picked/.test(tk.detail) && tk.gaps.length >= 1 && !tk.gaps.some(g => String(g.label ?? g).startsWith(SHOT + ' ')) && (!fl || /1 of/.test(fl)), { tk: tk && { detail: tk.detail, gaps: tk.gaps.length }, fl });

    // 11. Review › Takes: per request
    await pg.evaluate(() => window.WB.app.show('takes')); await wait(700);
    await until(() => document.querySelectorAll('.tkview .tkli').length > 0);
    await pg.evaluate((k) => document.querySelector(`.tkview .tkli[data-k="${k}"]`)?.click(), 'r:' + RQ); await wait(400);
    await until(() => document.querySelectorAll('.tkview .tkmain .tkc').length >= 4);
    const tv = await pg.evaluate(() => ({ rows: [...document.querySelectorAll('.tkview .tkli')].map(e => e.dataset.k), cards: document.querySelectorAll('.tkview .tkmain .tkc').length, picked: document.querySelector('.tkview .tkpkd')?.textContent || '' }));
    await shot('v16_takes_view', '.tkview');
    check('Review › Takes lists the requests with outputs and the shots with takes; a shot request opens the same takes panel (the pick shown)', tv.rows.includes('r:' + RQ) && tv.rows.includes('s:' + SHOT) && tv.cards >= 4 && /rv16shot\.2/.test(tv.picked), tv);
  } catch (e) { console.error('v16 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await client?.close().catch(() => {});
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-takes.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyTakes({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v16 (take selection):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
