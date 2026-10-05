// v14 of the headless UI suite (tools/verify.mjs): SPEC v4 §3, proposals (ROADMAP_v4 B9-B11). Exported so verify.mjs
// runs it after the other blocks; runnable alone:   node tools/verify-proposals.mjs [outDir]
// Self-contained: a scratch copy of data/demo, its own server on a free port, an MCP client (the official SDK, over stdio,
// against that server); all deleted at the end. The cycle: the agent adds proposals over MCP (3 SVG sketch layouts on a
// scene, 3 SVG frames on a shot, 3 texts on a lyric line, 3 SVG mood boards on a look; a hostile SVG is refused) and
// cannot pick (no tool; 403 over HTTP) -> the page shows a compact strip next to each target -> the director picks an SVG
// on the scene (it becomes the sketch's underlay) and on the shot (the frame's base layer), a text on the line (the draft
// line changes; Ctrl+Z puts both back), mixes a look (pick + a note to the agent), asks for "3 more" (an ask the agent
// answers with its next proposals_add) -> proposals_get reports the picks -> the free local generator (no agent) makes 3
// layouts per scene and shot -> "Prepare proposals" writes an ask; the offer after a save never runs by itself.
// Screenshots v14_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sdk = (p) => import(pathToFileURL(path.join(WB, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);

// SVGs an agent would write with code: a framing with silhouettes and a camera arrow; a mood board of colour blocks
const ARROW = '<defs><marker id="ah" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#e0503a"/></marker></defs>';
const frameSvg = (sky, ground, x, h, move) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90">${ARROW}<rect width="160" height="90" fill="${sky}"/><rect y="62" width="160" height="28" fill="${ground}"/>`
  + `<circle cx="${x}" cy="${88 - h}" r="${h * 0.12}" fill="#1d1b22"/><rect x="${x - h * 0.17}" y="${88 - h + h * 0.16}" width="${h * 0.34}" height="${h}" rx="3" fill="#1d1b22"/>`
  + `<line x1="${move[0]}" y1="${move[1]}" x2="${move[2]}" y2="${move[3]}" stroke="#e0503a" stroke-width="2" marker-end="url(#ah)"/><text x="4" y="10" font-size="7" fill="#1d1b22">${move[4]}</text></svg>`;
const moodSvg = (cols, word) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90">${cols.map((c, i) => `<rect x="${i * 160 / cols.length}" width="${160 / cols.length + 0.5}" height="90" fill="${c}"/>`).join('')}<circle cx="80" cy="34" r="12" fill="#111" fill-opacity="0.85"/><rect x="66" y="47" width="28" height="43" rx="4" fill="#111" fill-opacity="0.85"/><text x="4" y="86" font-size="8" fill="#fff">${word}</text></svg>`;

export async function verifyProposals({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v14 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v14-')), DATA = path.join(TMP, 'data'), P = 'proposals', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P };
  delete env.WB_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v14 server: ' + d));
  let pg = null, client = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
    const call = async (name, body, page = false) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN, ...(page ? { origin: BASE } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-proposals', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* an error text */ } return { error: !!r.isError, body, text: t }; };

    // 1. the agent's tools: add and get, never pick
    const tools = (await client.listTools()).tools.map(t => t.name);
    const L = (await tool('lyrics_get')).body, line = L.sections.flatMap(s => s.lines)[1];
    const sc = { stage: 'script', kind: 'scene', id: 'sc02' }, sh = { stage: 'storyboard', kind: 'shot', id: 's4-chorus' }, ln = { stage: 'lyrics', kind: 'line', id: line.id }, lk = { stage: 'characters', kind: 'tree', id: 'ada/look:base' };
    const aSc = await tool('proposals_add', { target: sc, items: [
      { title: 'Wide · Ada small against the wall', why: 'The world appears: keep her tiny, the wall huge.', svg: frameSvg('#e9e2d0', '#9a8f7c', 50, 26, [60, 12, 110, 12, 'pan right']) },
      { title: 'Medium · Ada on the right third', why: 'Her reaction as the wall appears behind her.', svg: frameSvg('#d8d0ff', '#6b5aa8', 110, 60, [20, 15, 45, 35, 'push in']) },
      { title: 'Close · face, wall out of focus', why: 'Only her eyes: the change is in them.', svg: frameSvg('#20212a', '#141418', 60, 110, [140, 70, 140, 30, 'tilt up']) }] });
    const aSh = await tool('proposals_add', { target: sh, items: [
      { title: 'Low angle, both on the thirds', why: 'The chorus lifts: look up at them.', svg: frameSvg('#ffcf8a', '#c0503a', 53, 44, [80, 80, 80, 40, 'tilt up']) },
      { title: 'Over the shoulder', why: 'Bo in the foreground, Ada sings to him.', svg: frameSvg('#9fc8de', '#2f6f8f', 120, 70, [30, 20, 60, 20, 'pan right']) },
      { title: 'Top shot, circling', why: 'The loop of the chorus as a circle.', svg: frameSvg('#141a2e', '#0b0e17', 80, 30, [40, 20, 120, 20, 'orbit']) }] });
    const aLn = await tool('proposals_add', { target: ln, items: [
      { title: 'Plainer', why: 'Fewer words, more air.', text: 'the screen hums, and nothing else' },
      { title: 'An image', why: 'A concrete picture instead of a statement.', text: 'a test card glowing in an empty room' },
      { title: 'A question', why: 'Pulls the listener into the next line.', text: 'who is still watching the colour bars?' }] });
    const aLk = await tool('proposals_add', { target: lk, items: [
      { title: 'Warm orange, deep navy', why: 'The base look: hoodie and jeans, a warm key.', svg: moodSvg(['#ff8844', '#ffb37a', '#223355', '#101828'], 'warm / navy') },
      { title: 'Faded pastel', why: 'Washed-out, like an old test card.', svg: moodSvg(['#f3c6b4', '#e7d36f', '#9fc8de', '#d8d0ff'], 'pastel') },
      { title: 'Night neon', why: 'For the chorus: magenta and cyan rims.', svg: moodSvg(['#1d0f2b', '#ff3fa4', '#2de2e6', '#110818'], 'neon') }] });
    const hostile = await tool('proposals_add', { target: sc, items: [{ title: 'evil', svg: '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>' }] });
    const agentPick = await call('proposal_act', { set: aSc.body?.set?.id, item: 'a', act: 'pick' });
    const PJ = J('proposals.json');
    check('the agent adds proposals over MCP (proposals_add: a scene, a shot, a lyric line, a look; SVGs written to proposals/, sanitised) and reads them (proposals_get); it has no tool to pick and the HTTP op without the page\'s Origin is refused (403); a hostile SVG is refused with the reason',
      ['proposals_add', 'proposals_get'].every(t => tools.includes(t)) && !tools.includes('proposal_act') && [aSc, aSh, aLn, aLk].every(x => !x.error && x.body.set.items.length === 3 && /^proposals\.json: set ps\d+/.test(x.body.changed))
      && PJ.sets.length === 4 && fs.existsSync(path.join(PD, 'proposals', `${aSc.body.set.id}-a.svg`)) && hostile.error && /<script> is not allowed/.test(hostile.text) && agentPick.status === 403,
      { sets: PJ.sets.map(s => s.id), hostile: hostile.text.slice(0, 120), agentPick: agentPick.status, changed: aSc.body?.changed });
    const S1 = aSc.body.set.id, S2 = aSh.body.set.id, S3 = aLn.body.set.id, S4 = aLk.body.set.id;

    pg = await browser.newPage();
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v14 pageerror', e.stack || e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.error('v14 console', m.text()); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const shot = async (n, sel, pad = 8) => {
      await frames(3); await wait(150);
      let clip;
      if (sel) clip = await pg.evaluate((s, p) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.max(0, r.left - p), y: Math.max(0, r.top - p), width: Math.min(innerWidth, r.width + 2 * p), height: Math.min(innerHeight - Math.max(0, r.top - p), r.height + 2 * p) }; }, sel, pad);
      await pg.screenshot({ path: path.join(OUT, `${n}.png`), ...(clip ? { clip } : {}) });
    };
    const stage = async (id) => { await pg.evaluate((s) => window.WB.stages.open(s), id); await wait(500); await frames(3); };
    const clickSel = async (sel) => { const b = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel); if (b) { await pg.mouse.click(b.x, b.y); await wait(250); } return !!b; };

    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(3);

    // 2. the script: a compact strip on the closed scene card, the full strip on the open scene; Pick an SVG -> the
    // sketch's underlay; Ctrl+Z puts it back (the sketch closes, the item is open again)
    await stage('script');
    const mini = await pg.evaluate(() => document.querySelectorAll('.scrow[data-scene="sc02"] .pps.mini img').length);
    await pg.evaluate(() => window.WB.script.focus('sc02')); await wait(400);
    const strip = await pg.evaluate(() => { const s = document.querySelector('.scrow[data-scene="sc02"] .pps:not(.mini)'); return s ? { cards: s.querySelectorAll('.ppc').length, imgs: [...s.querySelectorAll('.ppc img')].filter(i => i.complete && i.naturalWidth > 0).length, w: Math.round(s.getBoundingClientRect().width), nc: Math.round(document.querySelector('.nclayer')?.getBoundingClientRect().left || 0), right: Math.round(s.getBoundingClientRect().right) } : null; });
    await until(() => [...document.querySelectorAll('.scrow[data-scene="sc02"] .ppc img')].every(i => i.complete && i.naturalWidth > 0));
    await shot('v14_script_strip', '.scrow[data-scene="sc02"]');
    check('script: a compact strip (3 thumbnails) on the closed scene, a strip of 3 cards (SVG as <img>, title, why, Pick / Mix / ×) on the open scene, left of the Notes column',
      mini === 3 && strip?.cards === 3 && strip.right <= strip.nc + 1, { mini, strip });
    await clickSel(`.scrow[data-scene="sc02"] .ppc[data-set="${S1}"][data-item="a"] [data-pp="pick"]`);
    await until(() => !!window.WB.script.ws.sk);
    await wait(500);
    const picked = await pg.evaluate((s) => ({ ul: window.WB.script.ws.sk?.api.get().underlay?.src || null, st: window.WB.store.proposals.sets.find(x => x.id === s)?.items.map(i => i.status) }), S1);
    await shot('v14_script_pick_underlay', '.scrow[data-scene="sc02"]');
    await pg.evaluate(() => document.activeElement?.blur?.());
    await pg.evaluate(() => window.WB.commands.run('edit.undo')); await wait(700);
    const undone = await pg.evaluate((s) => ({ sk: !!window.WB.script.ws.sk, st: window.WB.store.proposals.sets.find(x => x.id === s)?.items.map(i => i.status) }), S1);
    check('script: Pick on an SVG layout opens the scene\'s sketch with it as the underlay (proposals.json: picked, by the director via the page); Ctrl+Z closes the sketch and the item is open again',
      picked.ul === `proposals/${S1}-a.svg` && picked.st?.[0] === 'picked' && J('proposals.json').sets[0].items[0].via === 'page' && !undone.sk && undone.st?.[0] === 'open', { picked, undone });

    // 3. "3 more": an ask for the agent on the scene; the strip says it is waiting; the agent's next proposals_add answers it
    await clickSel('.scrow[data-scene="sc02"] .pps:not(.mini) [data-pp="more"]');
    await until(() => window.WB.store.notes.notes.some(n => n.ask === 'proposals' && n.status === 'open'));
    await wait(300);
    const wait3 = await pg.evaluate(() => !!document.querySelector('.scrow[data-scene="sc02"] .ppwait'));
    await shot('v14_more_waiting', '.scrow[data-scene="sc02"] .pps:not(.mini)', 4);
    const askN = J('notes.json').notes.find(n => n.ask === 'proposals' && n.status === 'open');
    const got = (await tool('proposals_get', { target: sc })).body;
    const more = await tool('proposals_add', { target: sc, items: [
      { title: 'Split screen', why: 'Test card left, the world right.', svg: frameSvg('#ffffff', '#cccccc', 120, 40, [80, 10, 80, 80, 'static']) },
      { title: 'Through the screen', why: 'We start inside the test card.', svg: frameSvg('#2de2e6', '#1d0f2b', 80, 50, [20, 20, 60, 40, 'push in']) },
      { title: 'Reflection', why: 'The world appears in a window.', svg: frameSvg('#9fc8de', '#3f5a32', 40, 30, [100, 15, 140, 15, 'pan right']) }] });
    await until(() => window.WB.store.proposals.sets.length >= 5); await wait(400);
    const after3 = await pg.evaluate(() => ({ cards: document.querySelectorAll('.scrow[data-scene="sc02"] .pps:not(.mini) .ppc').length, waiting: !!document.querySelector('.scrow[data-scene="sc02"] .ppwait') }));
    await shot('v14_more_answered', '.scrow[data-scene="sc02"] .pps:not(.mini)', 4);
    check('"3 more" writes one ask for the agent on the scene (ask "proposals", to the agent, the director\'s); the strip shows it waiting; proposals_get lists it; the agent\'s next proposals_add on that scene answers it (absorbed) and the strip shows 6 cards',
      wait3 && askN?.by === 'director' && askN.to === 'agent' && got.asks.some(a => a.id === askN.id) && more.body.answered?.includes(askN.id) && J('notes.json').notes.find(n => n.id === askN.id)?.status === 'absorbed' && after3.cards === 6 && !after3.waiting,
      { wait3, ask: askN?.id, answered: more.body.answered, after3 });

    // 4. the storyboard: the strip in the shot panel; Pick -> the frame sketch's base layer (mountSketch underlay)
    await stage('storyboard');
    await pg.evaluate(() => window.WB.storyboard.ws.select('s4-chorus', { scroll: true, seek: false })); await wait(500);
    await until(() => [...document.querySelectorAll('.sbins .ppc img')].every(i => i.complete && i.naturalWidth > 0));
    const sbStrip = await pg.evaluate(() => ({ cards: document.querySelectorAll('.sbins .pps .ppc').length, badge: document.querySelector('.sbcard[data-shot="s4-chorus"] .ppbadge')?.textContent || null }));
    await shot('v14_shot_strip', '.sbside');
    await clickSel(`.sbins .ppc[data-set="${S2}"][data-item="b"] [data-pp="pick"]`);
    await until(() => !!window.WB.storyboard.ws.sk); await wait(500);
    const sbPick = await pg.evaluate(() => window.WB.storyboard.ws.sk?.api.get().underlay?.src || null);
    await shot('v14_shot_pick_base_layer');
    check('storyboard: the shot panel shows the shot\'s strip (3 frames) and its card a ◇ badge; Pick opens the frame sketch with the SVG as its base layer (underlay)',
      sbStrip.cards === 3 && /◇/.test(sbStrip.badge || '') && sbPick === `proposals/${S2}-b.svg`, { sbStrip, sbPick });
    await pg.evaluate(() => window.WB.storyboard.ws.closeSketch(true)); await wait(200);

    // 5. lyrics: the strip under the line (texts); Pick replaces the line in the draft; Ctrl+Z puts it back
    await stage('lyrics');
    const ly = () => pg.evaluate(async (id) => { const m = await import('/tabs/lyrics.js'); const w = m.default.ws; return w.findLine(id)?.l.text; }, line.id);
    const before = await ly();
    const lyStrip = await pg.evaluate((id) => document.querySelectorAll(`.lyl[data-line="${CSS.escape(id)}"] .pps .ppc.txt`).length, line.id);
    await shot('v14_lyric_strip', `.lyl[data-line="${line.id.replace(/"/g, '')}"]`, 30);
    await clickSel(`.lyl[data-line="${line.id}"] .ppc[data-item="b"] [data-pp="pick"]`);
    await wait(500);
    const lyPicked = await ly();
    await shot('v14_lyric_picked', `.lyl[data-line="${line.id.replace(/"/g, '')}"]`, 30);
    await pg.evaluate(() => window.WB.commands.run('edit.undo')); await wait(600);
    const lyUndone = await ly();
    check('lyrics: a lyric line with proposals shows its 3 texts under it; Pick replaces the line in the draft (unsaved); Ctrl+Z puts the old line back and the item is open again',
      lyStrip === 3 && lyPicked === 'a test card glowing in an empty room' && lyUndone === before && J('proposals.json').sets.find(s => s.id === S3).items[1].status === 'open', { lyStrip, before, lyPicked, lyUndone });

    // 6. characters: a look's mood boards; Mix = pick + a note to the agent
    await stage('characters');
    await pg.evaluate(() => { const w = window.WB.characters.ws; w.select('ada'); w.tab = w.U.vTab; w.vid = 'base'; w.render(); }); await wait(500);
    await until(() => [...document.querySelectorAll('.chbody .pps .ppc img')].every(i => i.complete && i.naturalWidth > 0));
    const lkStrip = await pg.evaluate(() => document.querySelectorAll('.chbody .pps .ppc').length);
    await pg.evaluate((s) => window.WB.proposals.act(s, 'c', 'mix', { note: 'neon, but keep the orange hoodie' }), S4); await wait(500);
    await shot('v14_look_strip', '.chbody');
    const mixNote = J('notes.json').notes.find(n => /Mix of proposal/.test(n.text));
    const lkSet = J('proposals.json').sets.find(s => s.id === S4);
    check('characters: the look tree shows its 3 mood boards; Mix records the pick with the director\'s note and writes a note to the agent on the look (it goes into the next round)',
      lkStrip === 3 && lkSet.items[2].status === 'mixed' && lkSet.items[2].note === 'neon, but keep the orange hoodie' && mixNote?.to === 'agent' && mixNote.target.id === 'ada/look:base' && mixNote.via === 'page',
      { lkStrip, item: lkSet.items[2], note: mixNote?.text });

    // 7. proposals_get: what the director chose
    const picks = (await tool('proposals_get', {})).body.picks;
    check('proposals_get reports the director\'s choices (picks with the mix note) to the agent',
      picks.some(p => p.set === S4 && p.status === 'mixed' && p.note === 'neon, but keep the orange hoodie') && picks.some(p => p.set === S2 && p.status === 'picked'), picks);

    // 8. the free local generator (no agent): 3 layouts per scene and shot, idempotent; "Prepare proposals" writes an ask
    await stage('script');
    const loc = await pg.evaluate(() => window.WB.proposals.local({ scope: 'all' }));
    const loc2 = await pg.evaluate(() => window.WB.proposals.local({ scope: 'all' }));
    await until(() => window.WB.store.proposals.sets.some(s => s.source === 'local')); await wait(300);
    await pg.evaluate(() => window.WB.script.focus('sc01')); await wait(400);
    await until(() => [...document.querySelectorAll('.scrow[data-scene="sc01"] .ppc img')].every(i => i.complete && i.naturalWidth > 0));
    await shot('v14_local_generator', '.sclist', 0);
    const nScenes = (await tool('script_get')).body.scenes.length, nShots = (await tool('storyboard_get')).body.scenes.reduce((a, x) => a + x.shots.length, 0) + ((await tool('storyboard_get')).body.outside?.length || 0);
    const locSets = J('proposals.json').sets.filter(s => s.source === 'local');
    const svgOk = locSets.every(s => s.items.length === 3 && s.items.every(i => { const f = path.join(PD, i.svg); return fs.existsSync(f) && /^<svg [^>]*viewBox="0 0 160 90"/.test(fs.readFileSync(f, 'utf8')); }));
    check('Make free layouts (no agent, $0): 3 SVG layouts per scene and per shot (a scene / shot that already had open proposals is skipped), each a sanitised file; running it again adds nothing',
      loc?.added?.length >= 3 && loc.cost_usd === 0 && svgOk && locSets.every(s => s.via === 'page' && s.by === 'local generator') && loc2.added.length === 0 && locSets.some(s => s.target.stage === 'storyboard'),
      { added: loc?.added?.length, skipped: loc?.skipped, again: loc2?.added?.length, nScenes, nShots });
    await pg.evaluate(() => window.WB.proposals.prepare('storyboard')); await wait(500);
    const prep = J('notes.json').notes.find(n => n.ask === 'proposals' && n.target.kind === 'stage' && n.target.stage === 'storyboard');
    const pa = (await tool('proposals_get', { stage: 'storyboard' })).body.asks;
    // the offer after a save: shown, never run by itself
    await pg.evaluate(() => window.WB.proposals.offer('scenery', { force: true })); await wait(200);
    const offer = await pg.evaluate(() => document.querySelector('.ppoffer')?.textContent || null);
    await shot('v14_offer', '.ppoffer', 6);
    const setsBefore = J('proposals.json').sets.length;
    await wait(300);
    check('"Prepare proposals" writes one ask to the agent on the stage (proposals_get asks); the offer after a save only offers (nothing written until a click)',
      prep?.to === 'agent' && pa.some(a => a.id === prep.id) && /Prepare starting proposals/.test(offer || '') && J('proposals.json').sets.length === setsBefore && !J('notes.json').notes.some(n => n.target.stage === 'scenery' && n.ask === 'proposals'),
      { prep: prep?.id, offer });
    await pg.evaluate(() => document.querySelector('.ppoffer')?.remove());

    // 9. the large view (click a thumbnail) and a hostile title / why rendered as text
    await stage('script'); await pg.evaluate(() => window.WB.script.focus('sc02')); await wait(400);
    await clickSel(`.scrow[data-scene="sc02"] .ppc[data-set="${S1}"][data-item="b"] img`);
    const big = await pg.evaluate(() => !!document.querySelector('.ppbig img'));
    await shot('v14_zoom');
    await pg.keyboard.press('Escape'); await wait(200);
    check('a thumbnail opens a larger view with the same Pick / Mix / Dismiss (Esc closes it)', big && !(await pg.evaluate(() => !!document.querySelector('.ppbig'))));

    // 10. the new-project wizard offers "Prepare starting proposals" (unticked: nothing runs unless the director ticks it)
    await pg.evaluate(() => window.WB.wizard.open()); await wait(200);
    await pg.evaluate(() => { const t = document.querySelector('.wiz [name=title]'); t.value = 'Proposal test'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.wiz [data-w=next]').click(); }); await wait(300);
    await pg.evaluate(() => document.querySelector('.wiz [data-w=next]').click()); await wait(300);
    const wiz = await pg.evaluate(() => { const c = document.querySelector('.wiz [name=prep]'); return c ? { checked: c.checked, label: c.closest('label').textContent.trim().slice(0, 40) } : null; });
    await shot('v14_wizard_offer', '.wiz', 4);
    await pg.evaluate(() => window.WB.wizard.close());
    check('the new-project wizard offers "Prepare starting proposals", unticked by default', wiz && !wiz.checked && /Prepare starting proposals/.test(wiz.label), wiz);
  } catch (e) { console.error('v14 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await client?.close().catch(() => {});
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-proposals.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyProposals({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v14 (proposals):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
