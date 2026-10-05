// v25 of the headless UI suite (tools/verify.mjs): E3 chapters and build status, E5 placeholder frames, E6 looks per context
// (worlds), F2 a compact Assets › Characters. Exported so verify.mjs runs it after the other blocks; runnable alone:
//   node tools/verify-chapters.mjs [outDir]
// Self-contained: a scratch copy of data/demo, its own server on a free port (never 8140), an MCP client over stdio; all
// deleted at the end.
// E6: the agent gives a new look its world (look_create world), proposes the world of an existing one (look_world_propose: a
// proposal, nothing changes; no tool sets it, asset_act look_world without the page is 403, also with via "page"), sets the
// scenes' worlds (scenes_update context) and a shot's (shots_update context) -> the cast chips wear the world's look, a
// character without one is a gap (gaps_get looks, final_get's `looks` line) -> the page: the Shot panel's world select, the
// chips, the Gaps tab, Final's line, the Characters stage's world select and the agent's proposal accepted in one click.
// E3: chapters_update (a status sent is dropped: the status is derived) -> storyboard_get / final_get chapters -> the page:
// the chapter band on the first scene with its derived status, the scene's chapter picker (+ new chapter), the timeline's
// chapters band; a picked take on every shot of a chapter makes it "built".
// E5: a shot without a frame or take shows its placeholder frame (an SVG data: image with its id) on the storyboard card and
// in the timeline's shots column; composition_export writes the same frame (placeholder.svg) in edl.json, escaped, with
// the shot's world and the chapters.
// F2: Assets › Characters: one dense row per character, 1 px separators, no empty grid cell, "+ New look" as a card per
// character (it opens the look form). Screenshots v25_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(process.env.WB_VERIFY_PORT ? Number(process.env.WB_VERIFY_PORT) + ((globalThis.__wbVerifyPortN = (globalThis.__wbVerifyPortN ?? -1) + 1) % 10) : 0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sdk = (p) => import(pathToFileURL(path.join(WB, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);

export async function verifyChapters({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v25 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v25-')), DATA = path.join(TMP, 'data'), P = 'chap', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  const ent = (id) => J(`entities/characters/${id}.json`);
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P };
  delete env.WB_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v25 server: ' + d));
  let pg = null, client = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
    const call = async (name, body, page = false) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN, ...(page ? { origin: BASE, 'sec-fetch-site': 'same-origin' } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-chapters', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* an error text */ } return { error: !!r.isError, body, text: t }; };

    // 1. E6 over MCP: worlds on looks (new: direct; existing: a proposal), scenes and a shot; the gaps
    const tools = (await client.listTools()).tools.map(t => t.name);
    const lc = await tool('look_create', { id: 'ada', name: 'Night out', world: 'Dancing', garments: ['black satin slip dress'] });
    const badW = await tool('look_create', { id: 'ada', name: 'Bad', world: '<script>x</script>' });
    const lp = await tool('look_world_propose', { id: 'ada', look: 'base', world: 'on screen', why: 'her hoodie is the on-screen look' });
    const agentAct = await call('asset_act', { type: 'character', id: 'ada', act: 'look_world', look: 'base', world: 'dancing' });
    const claimed = await call('asset_act', { type: 'character', id: 'ada', act: 'look_world_accept', look: 'base', via: 'page' });
    const eu = await tool('entity_upsert', { kind: 'character', id: 'ada', look: { id: 'base', context: 'dancing' } });
    const sc = await tool('scenes_update', { upsert: [{ id: 'sc01', context: 'on screen' }, { id: 'sc02', context: 'dancing' }], message: 'worlds' });
    const sh = await tool('shots_update', { upsert: [{ scene: 'sc03', t0: 19000, t1: 20000, kind: 'performance', text: 'Ada & Bo dance on the desk <b>wild</b>', cast: ['ada', 'bo'], context: 'dancing' }], message: 'a dance' });
    const sb1 = (await tool('storyboard_get')).body, g1 = (await tool('gaps_get')).body;
    const shotsOf = (sb) => sb.scenes.flatMap(s => s.shots);
    const s2 = shotsOf(sb1).find(x => x.id === 's2-wall'), adaS2 = s2?.assets.find(a => a.id === 'ada'), sh01 = shotsOf(sb1).find(x => x.id === 'sh01');
    const a0 = ent('ada'), base0 = a0.looks.find(l => l.id === 'base');
    check('E6 over MCP: look_create gives a NEW look its world (lower case); a bad world is 400; look_world_propose only proposes (the look keeps no world); no tool sets a look\'s world and asset_act look_world without the page is 403 (also claimed via "page"); entity_upsert cannot change an existing look\'s world (warning)',
      !lc.error && lc.body.world === 'dancing' && a0.looks.find(l => l.id === 'night-out')?.context === 'dancing' && badW.error && /world/.test(badW.text)
      && !lp.error && base0.world_proposal?.world === 'on screen' && !base0.context && agentAct.status === 403 && claimed.status === 403
      && tools.includes('look_world_propose') && tools.includes('chapters_update') && !tools.some(t => /^(look_world|asset_act|chapter_status)$/.test(t))
      && !eu.error && /context ignored/.test(JSON.stringify(eu.body.warnings || [])) && !ent('ada').looks.find(l => l.id === 'base').context,
      { lc: lc.body?.world, bad: badW.text.slice(0, 80), lp: base0.world_proposal, agentAct: agentAct.status, claimed: claimed.status, eu: eu.body?.warnings });
    check('E6: scenes_update / shots_update carry the worlds; a shot in "dancing" dresses Ada in her dancing look (source world); Bo, who has none, is a gap (gaps_get looks) on every dancing shot',
      !sc.error && !sh.error && sb1.scenes.find(s => s.id === 'sc02')?.world === 'dancing' && s2?.world === 'dancing' && adaS2?.variant === 'night-out' && adaS2?.source === 'world' && !adaS2?.mismatch
      && sh01?.world === 'dancing' && sh01.world_source === 'shot' && g1.counts.looks === 3 && g1.looks.every(l => l.id === 'bo' && l.world === 'dancing' && /no look for the world/.test(l.why))
      && sb1.worlds.join() === 'dancing,on screen' && sb1.looks_by_world.find(c => c.id === 'ada')?.worlds.dancing?.look === 'night-out',
      { s2: adaS2 && [adaS2.variant, adaS2.source], looks: g1.looks?.map(l => l.shot), worlds: sb1.worlds });

    // 2. E3 over MCP: chapters, a status sent is dropped, the derived status
    const cu = await tool('chapters_update', { upsert: [{ name: 'Opening', scenes: ['sc01', 'sc02'], owner: 'lead', file: 'xp/ch1.js', status: 'approved' }, { name: 'Outro', scenes: ['sc03'] }] });
    const dup = await tool('chapters_update', { chapters: [{ id: 'c1', scenes: ['sc01'] }, { id: 'c2', scenes: ['sc01'] }] });
    const badFile = await tool('chapters_update', { upsert: [{ id: 'c1', file: '../../etc/x.js' }] });
    const stored = J('storyboard.json').chapters;
    const c1 = cu.body?.chapters?.find(c => c.id === 'c1'), c2 = cu.body?.chapters?.find(c => c.id === 'c2');
    check('E3 over MCP: chapters_update groups scenes into chapters (c1, c2) outside the versions; a status sent is ignored (warning) and never stored; a scene in two chapters and a file leaving the composition are 400; the status is derived (c1 generating: world clips, nothing picked; c2 planned)',
      !cu.error && stored.length === 2 && stored.every(c => !('status' in c)) && stored[0].via === 'agent' && /status ignored/.test(JSON.stringify(cu.body.warnings || []))
      && c1?.status === 'generating' && c1.placeholders === 4 && c2?.status === 'planned' && c2.shots === 2 && dup.error && /one chapter/.test(dup.text) && badFile.error,
      { c1: c1 && [c1.status, c1.why], c2: c2 && [c2.status, c2.why], dup: dup.text.slice(0, 80), stored: stored.map(c => c.id) });

    // 3. E5: the export carries the placeholder frame, escaped, with the world and the chapters
    const ex = await tool('composition_export', {});
    const edlText = fs.readFileSync(path.join(PD, 'exports', 'composition', 'edl.json'), 'utf8'), edl = JSON.parse(edlText);
    const r01 = edl.shots.find(s => s.id === 'sh01'), svg = r01?.placeholder?.svg || '';
    const ex2 = await tool('composition_export', {});
    check('E5: composition_export writes each unpicked shot as a placeholder with its frame (placeholder.svg: the id, kind, text, cast; markup escaped, no script / external reference), the shot\'s world and the chapters with their status; the same state gives the same bytes',
      !ex.error && r01?.status === 'placeholder' && r01.placeholder.reason === 'unpicked' && r01.world === 'dancing' && /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg) && svg.includes('>sh01<')
      && svg.includes('&lt;b&gt;wild&lt;/b&gt;') && svg.includes('Ada &amp; Bo') && !/<script|<b>|href|url\(/i.test(svg) && /with Ada, Bo/.test(svg) && r01.placeholder.cast.join() === 'Ada,Bo'
      && edl.chapters?.length === 2 && edl.chapters[0].status === 'generating' && ex2.body?.changed === false,
      { status: r01?.status, world: r01?.world, svg: svg.length, chapters: edl.chapters?.map(c => [c.id, c.status]) });

    // 4. Final: the looks line and the chapters (final_get)
    const f1 = (await tool('final_get')).body, fl = f1.checklist.find(c => c.id === 'looks');
    check('E6 in Final: final_get has the line "every character wears the look of the shot\'s world", failing with Bo\'s 3 shots; and the chapters with their derived status',
      fl && !fl.ok && /3 looks off their world/.test(fl.detail) && fl.gaps.length === 3 && f1.chapters?.map(c => c.status).join() === 'generating,planned', { fl: fl && [fl.ok, fl.detail], ch: f1.chapters?.map(c => c.status) });

    // 5. the page: the storyboard (chapter band, picker, placeholder, world chips, Shot panel world, Gaps tab)
    pg = await browser.newPage();
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    pg.on('pageerror', e => { errors.push(e.message); console.error('v25 pageerror', e.stack || e.message); });
    pg.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const shot = async (n, sel, pad = 4) => {
      await frames(3); await wait(200);
      let clip;
      if (sel) clip = await pg.evaluate((s, p) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: Math.max(0, r.left - p), y: Math.max(0, r.top - p), width: Math.min(innerWidth, r.width + 2 * p), height: Math.max(10, Math.min(innerHeight - Math.max(0, r.top - p), r.height + 2 * p)) }; }, sel, pad);
      await pg.screenshot({ path: path.join(OUT, `${n}.png`), ...(clip ? { clip } : {}) });
    };
    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(3);
    await pg.evaluate(() => window.WB.stages.open('storyboard')); await wait(700);
    await until(() => !!document.querySelector('.sbchap[data-chapter="c1"]'));
    const b1 = await pg.evaluate(() => {
      const band = (id) => { const e = document.querySelector(`.sbchap[data-chapter="${id}"]`); return e ? { text: e.textContent.replace(/\s+/g, ' ').trim(), st: e.querySelector('.sbchs')?.textContent, scene: e.closest('.sbscene')?.dataset.scene } : null; };
      const card = document.querySelector('.sbcard[data-shot="sh01"]'), ph = card?.querySelector('img.sbph');
      const chip = (shot, id) => { const c = [...document.querySelectorAll(`.sbcard[data-shot="${shot}"] .sbch`)].find(x => x.textContent.includes(id)); return c ? { cls: c.className, text: c.textContent } : null; };
      return { c1: band('c1'), c2: band('c2'), bands: document.querySelectorAll('.sbchap').length, sel: [...document.querySelectorAll('.sbchsel')].map(s => s.value), ph: ph ? ph.getAttribute('src').slice(0, 26) : null, phW: ph?.naturalWidth || 0,
        adaS2: chip('s2-wall', 'Ada'), boS3: chip('s3-grid', 'Bo'), wld: document.querySelector('.sbscene[data-scene="sc02"] .sbsh .sbwld')?.textContent };
    });
    await shot('v25_storyboard_chapters', '.sblist', 0);
    check('E3 in the storyboard: the first scene of each chapter carries its band (name, DERIVED status, picked / shots, placeholders, owner, file); every scene header has the chapter picker; E5: sh01 (no frame, no take) shows its placeholder frame (an SVG data: image); E6: the scene\'s world tag, Ada\'s chip wears "Night out" from the world, Bo\'s chip is marked off its world',
      b1.c1?.scene === 'sc01' && b1.c1.st === 'generating' && /Opening/.test(b1.c1.text) && /0\/4 picked/.test(b1.c1.text) && /4 placeholders/.test(b1.c1.text) && /lead/.test(b1.c1.text) && /xp\/ch1\.js/.test(b1.c1.text)
      && b1.c2?.scene === 'sc03' && b1.c2.st === 'planned' && b1.bands === 2 && b1.sel.join() === 'c1,c1,c2' && b1.ph === 'data:image/svg+xml;charset' && b1.phW === 320
      && b1.wld === 'dancing' && /\bwld\b/.test(b1.adaS2?.cls || '') && /Night out/.test(b1.adaS2?.text || '') && /\bwmis\b/.test(b1.boS3?.cls || ''), b1);

    // the director moves sc03 into c1 with the picker (a page op), then makes a new chapter of it
    await pg.select('.sbscene[data-scene="sc03"] .sbchsel', 'c1');
    await until(() => (window.WB.store.board?.chapters || []).find(c => c.id === 'c1')?.scenes.includes('sc03'), null, 6000);
    const mv = J('storyboard.json').chapters;
    check('E3: the scene\'s chapter picker moves sc03 into c1 (chapters_update from the page: stamped director / page; c2 keeps no scene)',
      mv.find(c => c.id === 'c1')?.scenes.join() === 'sc01,sc02,sc03' && mv.find(c => c.id === 'c1').via === 'page' && mv.find(c => c.id === 'c1').by === 'director' && mv.find(c => c.id === 'c2')?.scenes.length === 0, mv.map(c => [c.id, c.scenes, c.by, c.via]));

    // the Shot panel: the world select (the shot's own vs the scene's), the per-asset look select names the world's look
    await pg.evaluate(() => window.WB.storyboard.focus('s2-wall')); await wait(500);
    await until(() => !!document.querySelector('.sbins .sbin-world'));
    const sp = await pg.evaluate(() => ({ world: document.querySelector('.sbins .sbin-world')?.selectedOptions[0]?.textContent, ada: document.querySelector('.sbins .sbia[data-eid="ada"] .sbin-var')?.selectedOptions[0]?.textContent, warn: document.querySelector('.sbins .sbwrow .bad')?.textContent || '' }));
    await pg.select('.sbins .sbin-world', 'on screen'); await wait(400);
    const sp2 = await pg.evaluate(() => ({ ctx: window.WB.storyboard.ws.shot('s2-wall')?.context, ada: document.querySelector('.sbins .sbia[data-eid="ada"] .sbin-var')?.selectedOptions[0]?.textContent, warn: document.querySelector('.sbins .sbwrow .bad')?.textContent || '' }));
    await shot('v25_shot_world', '.sbins');
    await pg.evaluate(() => window.WB.storyboard.ws.discard()); await wait(300);
    check('E6 in the Shot panel: the world select shows the scene\'s ("dancing"); Ada\'s look select defaults to "world\'s (dancing): Night out"; picking "on screen" for the shot puts it in the draft and Ada (no on-screen look yet) shows as off the world',
      /the scene's: dancing/.test(sp.world || '') && /world's \(dancing\): Night out/.test(sp.ada || '') && !sp.warn && sp2.ctx === 'on screen' && /scene's/.test(sp2.ada || '') && /1 look off the world/.test(sp2.warn), { sp, sp2 });

    // the Gaps tab: "Looks off their world"
    await pg.evaluate(() => window.WB.storyboard.ws.setSide('gaps')); await wait(400);
    const gp = await pg.evaluate(() => { const h = [...document.querySelectorAll('.sbgh')].find(e => /Looks off their world/.test(e.textContent)); return h ? { n: h.querySelector('i')?.textContent } : null; });
    check('E6 in the storyboard\'s Gaps tab: "Looks off their world" lists Bo\'s 3 dancing shots', gp?.n === '3', gp);

    // 6. the timeline: the chapters band, the shots column's placeholder
    await pg.evaluate(() => window.WB.app.show('timeline')); await wait(800);
    const hid = await pg.evaluate(() => window.WB.timeline.byId.chapters?.hidden);
    await pg.evaluate(() => window.WB.timeline.setHidden('chapters', false)); await wait(400);   // the columns menu: chapters
    await until(() => document.querySelectorAll('.col-chapters .chp').length >= 1);
    const tl = await pg.evaluate(() => ({ ch: [...document.querySelectorAll('.col-chapters .chp')].map(e => [e.dataset.sel, e.className.replace(/\bchp\b\s*/, '').trim(), e.querySelector('b')?.textContent]), ph: [...document.querySelectorAll('.col-shots .shot img.ph')].map(e => e.closest('.shot').dataset.sel) }));
    await pg.evaluate(() => { const t = window.WB.timeline; t.zoomAt(8, innerHeight / 2); t.seek(18500); }); await wait(900);
    const cb = await pg.evaluate(() => { const a = document.querySelector('.col-scenes'), b = document.querySelector('.col-shots'), it = document.querySelector('.col-shots .shot[data-sel="shot:sh01"]'); if (!a || !b || !it) return null; it.scrollIntoView({ block: 'center' });
      const r1 = a.getBoundingClientRect(), r2 = b.getBoundingClientRect(), ri = it.getBoundingClientRect(); const y = Math.max(40, ri.top - 260); return { x: r1.left, y, width: r2.right - r1.left, height: Math.min(innerHeight - y, ri.bottom - y + 10) }; });
    await pg.screenshot({ path: path.join(OUT, 'v25_timeline_chapters.png'), ...(cb ? { clip: cb } : {}) });
    check('E3 / E5 on the timeline: the chapters band (a column, hidden by default: the columns menu shows it) shows c1 (generating) over its scenes (c2 has no scene left: no band), and the shots column draws sh01 as its placeholder frame',
      hid === true && tl.ch.length === 1 && tl.ch[0][0] === 'chapter:c1' && /st-generating/.test(tl.ch[0][1]) && tl.ch[0][2] === 'Opening' && tl.ph.includes('shot:sh01'), tl);

    // 7. Final's looks line
    await pg.evaluate(() => window.WB.stages.open('final')); await wait(700);
    await until(() => !!document.querySelector('.fnci[data-ck="looks"]'));
    const fn = await pg.evaluate(() => { const e = document.querySelector('.fnci[data-ck="looks"]'); return e ? { text: e.textContent.replace(/\s+/g, ' ').trim().slice(0, 200), ok: e.classList.contains('ok') } : null; });
    await shot('v25_final_looks', '.fnci[data-ck="looks"]', 4);
    check('E6 in Final: the checklist line "every character wears the look of the shot\'s world" fails with "3 looks off their world" and the shots', fn && !fn.ok && /3 looks off their world/.test(fn.text) && /Bo/.test(fn.text), fn);

    // 8. the Characters stage: the look's world select + the agent's proposal accepted in one click
    await pg.evaluate(() => window.WB.stages.open('characters')); await wait(600);
    await pg.evaluate(async () => { await window.WB.characters.open('ada'); const w = window.WB.characters.ws; w.setVariant('base'); w.render(); }); await wait(500);
    await until(() => !!document.querySelector('.aswrow [data-a="wldok"]'));
    const cw0 = await pg.evaluate(() => document.querySelector('.aswrow')?.textContent.replace(/\s+/g, ' ').trim());
    { const lb = await pg.evaluate(() => { const a = document.querySelector('.chlooks').getBoundingClientRect(), b = document.querySelector('.aswrow').getBoundingClientRect(); return { x: a.left, y: a.top, width: Math.max(a.width, b.right - a.left), height: b.bottom - a.top + 22 }; });
      await pg.screenshot({ path: path.join(OUT, 'v25_look_world.png'), clip: lb }); }
    await pg.evaluate(() => document.querySelector('.aswrow [data-a="wldok"]').click());
    await until(() => !document.querySelector('.aswrow [data-a="wldok"]'), null, 6000);
    const bAfter = ent('ada').looks.find(l => l.id === 'base');
    // the director gives Bo's base look the dancing world from the select: the gaps close
    await pg.evaluate(async () => { await window.WB.characters.open('bo'); const w = window.WB.characters.ws; w.setVariant('base'); w.render(); }); await wait(500);
    await until(() => !!document.querySelector('.aswrow .aswld'));
    await pg.select('.aswrow .aswld', 'dancing');
    let boOk = false; for (let i = 0; i < 40 && !boOk; i++) { boOk = ent('bo').looks.find(l => l.id === 'base')?.context === 'dancing'; if (!boOk) await wait(150); }
    const g2 = (await tool('gaps_get')).body, f2 = (await tool('final_get')).body.checklist.find(c => c.id === 'looks');
    check('E6 in the Characters stage: the look shows the agent\'s proposal ("agent proposes on screen") with Accept / Dismiss; Accept sets the look\'s world (asset_act, page); the director gives Bo\'s look "dancing" from the world select, and the looks gaps close (gaps_get 0, Final\'s line ok)',
      /proposes on screen/.test(cw0 || '') && bAfter?.context === 'on screen' && !bAfter.world_proposal && boOk && g2.counts.looks === 0 && f2?.ok, { cw0: cw0?.slice(0, 120), base: bAfter?.context, bo: boOk, looks: g2.counts.looks });

    // 9. E3: picking a take on every shot of a chapter makes it built (a picked take is the director's: take_act, page)
    const cu3 = await tool('chapters_update', { upsert: [{ id: 'c2', name: 'Intro alone', scenes: ['sc01'] }] });
    const rv = await tool('shots_update', { status: { 's1-intro': 'review' } });   // the demo approved s1-intro: back to review (an agent may)
    const media = J('media.json').items, take = media.find(m => m.kind === 'clip' && m.path && /\.(mp4|webm)$/i.test(m.path));
    let built = null, pickSt = null, appr = null;
    if (take) {
      const linked = await call('media_update', { id: take.id, shots: ['s1-intro'] });
      const pk = await call('take_act', { act: 'pick', shot: 's1-intro', media: take.id, in_ms: 0, out_ms: Math.min(1000, take.duration_ms || 1000) }, true);
      pickSt = [linked.status, pk.status, pk.body?.error];
      built = (await tool('storyboard_get')).body.chapters.find(c => c.id === 'c2');
      // the director approves the shot (a page save of approvals.json): the chapter is approved
      const ap = J('approvals.json'); ap.items['shot:s1-intro'] = { ...(ap.items['shot:s1-intro'] || {}), state: 'approved' };
      const r = await fetch(`${BASE}/api/save/approvals.json?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ base_rev: ap.rev || 0, data: ap }) });
      appr = [r.status, (await tool('storyboard_get')).body.chapters.find(c => c.id === 'c2')?.status];
    }
    check('E3: with a picked take on its only shot, chapter c2 (sc01 alone, moved out of c1) is "built" (derived: every shot picked; 0 placeholders); once the director approves the shot it is "approved"', !cu3.error && !rv.error && built?.status === 'built' && built.placeholders === 0 && appr?.[0] === 200 && appr[1] === 'approved', { built: built && [built.status, built.why], appr, pickSt, take: take?.id });

    // 10. F2: Assets › Characters is compact
    await pg.evaluate(() => window.WB.app.show('characters')); await wait(700);
    await until(() => document.querySelectorAll('.pgwrap[data-page="assets"] .cc.lead').length === 2);
    const f2c = await pg.evaluate(() => {
      const g = document.querySelector('.pgwrap[data-page="assets"] .cgrid'), rows = [...g.querySelectorAll(':scope > .cc.lead')], gr = g.getBoundingClientRect();
      return { rows: rows.map(r => { const b = r.getBoundingClientRect(); return { id: r.dataset.ent, w: Math.round(b.width), h: Math.round(b.height), add: !!r.querySelector('.lk.add[data-newlook]'), looks: r.querySelectorAll('.lk:not(.add)').length, worlds: [...r.querySelectorAll('.lk .lkm')].map(e => e.textContent) }; }),
        gw: Math.round(gr.width), gap: rows.length > 1 ? Math.round(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom) : null,
        empty: [...g.children].filter(c => !c.classList.contains('cc')).length, bg: getComputedStyle(g).display };
    });
    await shot('v25_assets_characters', '.pgwrap[data-page="assets"] .lib', 0);
    await pg.evaluate(() => document.querySelector('.pgwrap[data-page="assets"] .cc.lead[data-ent="bo"] .lk.add').click()); await wait(300);
    const form = await pg.evaluate(() => document.querySelector('.lookform')?.textContent.replace(/\s+/g, ' ').slice(0, 60) || null);
    await pg.evaluate(() => document.querySelector('.lookform')?.remove());
    check('F2: Assets › Characters is one dense row per character (full width, ≤ 120 px high, 1 px between rows, no empty grid cell), each with its looks as small cards (name, world) and "+ New look" as a card that opens the look form',
      f2c.rows.length === 2 && f2c.rows.every(r => Math.abs(r.w - f2c.gw) <= 1 && r.h <= 120 && r.add) && f2c.gap === 1 && f2c.empty === 0 && f2c.rows[0].looks === 2 && f2c.rows[0].worlds.includes('dancing') && /New look/.test(form || ''), { ...f2c, form });
    check('no page errors in v25', !errors.length, errors.slice(0, 5));
  } catch (e) { console.error('v25 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await client?.close().catch(() => {});
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-chapters.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyChapters({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v25 (chapters, placeholders, worlds, F2):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
