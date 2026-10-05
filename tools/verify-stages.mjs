// ROADMAP_v4 F1, "stage status that tells the truth": the stage status computed from the content (js/flow.js
// stagesView / stageContent / assetApproval) and the rail that shows it. Runs alone:
//   node tools/verify-stages.mjs [outDir]        (default outDir: shots/; a scratch copy of data/demo + _template)
// 1. unit cases per stage (lyrics, script, breakdown, characters, scenery, storyboard, final): empty, partial, done
//    (marked by the director and still satisfied), regressed (marked done, the content no longer satisfies it: "done ⚠
//    changed since" with the reason); a derived project is never done; one definition of "approved" for an asset.
// 2. headless, on a scratch copy of the demo (its own serve.mjs on a free port, never 8140): the rail on an empty
//    project, on the demo as it ships (made before the flow), after the director marks stages done, and after a
//    regression; the Assets chip and the Characters stage agree on Ada ("approved (legacy) · no identity node").
//    Review #2 U6 / U8: every stage bar shows ONE status (no "(marked …)"), the SAME buttons (Mark done | Reopen, Needs you,
//    Ask the agent…), and "Ask the agent…" opens that stage's asks, every one worded "Ask the agent …"; the rail's next
//    hint names the next stage with its own status.
//    Screenshots f1_*.png.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const F = await import('../js/flow.js');
const results = {};
const check = (name, ok, detail) => { results[name] = !!ok; console.log(`f1 ${name}: ${ok ? 'PASS' : 'FAIL'}${!ok && detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 900) : ''}`); };

// ------------------------------------------------------------------ 1. unit cases
const ALL = ['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'final'];
const doc = (marks = {}) => ({ rev: 1, stages: ALL.map(id => ({ id, status: marks[id] || 'in_progress', ...(marks[id] === 'done' ? { done_by: 'director', via: 'page', done_ok: true } : {}), blockers: [] })) });
const view = (marks, f) => F.stagesView(doc(marks), f);
const one = (v, id) => v.stages.find(s => s.id === id);
const ent = (kind, id, { approved = false, nodes = 0, status, base } = {}) => {
  const tree = kind === 'character' ? 'identity' : 'base';
  const ns = Array.from({ length: nodes }, (_, i) => ({ id: `n0${i + 1}`, tree, parent: i ? `n0${i}` : null, image: `x/${id}${i}.png`, request: null, kind: tree, edit: null, choice: i < nodes - 1 ? 'kept' : null, at: '2026-10-05T10:00:00', by: 'agent', via: 'agent' }));
  return { id, kind, name: id[0].toUpperCase() + id.slice(1), ...(status ? { status } : {}), ...(base ? { base: { text: base } } : {}), iter: { nodes: ns, trees: nodes ? { [tree]: { head: ns[nodes - 1].id, ...(approved ? { approved: ns[nodes - 1].id } : {}) } } : {}, notes: [], log: [] } };
};
const facts = (o = {}) => F.projectFacts({ song: o.song || { lines: [], duration_ms: 60000, audio: { mix: null } }, script: { lines: [] }, shots: [], entities: o.entities || [], lyrics: o.lyrics || null,
  scenes: o.scenes || null, breakdown: o.breakdown || null, storyboard: o.storyboard || null, approvals: o.approvals || { items: {} } });
const song = { duration_ms: 60000, audio: { mix: 'audio/mix.wav' }, lines: [{ id: 'v/0', t0: 1000, t1: 3000, text: 'a line' }] };
const scenes = (n, { intake = true, gap = false } = {}) => ({ rev: 1, current: 'v1', versions: [{ id: 'v1', n: 1, scenes: Array.from({ length: n }, (_, i) => ({ id: `sc0${i + 1}`, t0: i * (60000 / n), t1: gap && i === n - 1 ? 50000 : (i + 1) * (60000 / n), title: 's', text: '', line_ids: [], beats: [], sketches: [] })) }],
  states: {}, notes: [], intake: intake ? Object.fromEntries(['mood', 'kind', 'who', 'where', 'era', 'refs', 'must', 'mustnot', 'budget'].map(k => [k, { text: 'x', by: 'director', via: 'page' }])) : {} });
const breakdown = (items, states = {}) => ({ rev: 1, current: 'v1', versions: [{ id: 'v1', n: 1, items }], states, notes: [] });
const board = (shots) => ({ rev: 1, current: 'v1', versions: [{ id: 'v1', n: 1, shots }], notes: [] });

// per stage: [empty facts, partial facts, ready facts, regressed facts]
const CASES = {
  lyrics: [facts(), facts({ song, lyrics: { versions: [], notes: [{ id: 'ln01', status: 'open', to: 'agent' }] } }), facts({ song }), facts({ song, lyrics: { versions: [], notes: [{ id: 'ln01', status: 'open', to: 'agent' }] } })],
  script: [facts({ song }), facts({ song, scenes: { ...scenes(2, { intake: false }) } }), facts({ song, scenes: scenes(2) }), facts({ song, scenes: scenes(2, { gap: true }) })],
  breakdown: [facts(), facts({ breakdown: breakdown([{ id: 'bi01', kind: 'fx', name: 'rain', links: [] }], { bi01: { status: 'review' } }) }),
    facts({ breakdown: breakdown([{ id: 'bi01', kind: 'fx', name: 'rain', links: [] }], { bi01: { status: 'ok' } }) }),
    facts({ breakdown: breakdown([{ id: 'bi01', kind: 'fx', name: 'rain', links: [] }, { id: 'bi02', kind: 'fx', name: 'fog', links: [] }], { bi01: { status: 'ok' } }) })],
  characters: [facts(), facts({ entities: [ent('character', 'ada', { status: 'approved' }), ent('character', 'bo')] }),
    facts({ entities: [ent('character', 'ada', { nodes: 1, approved: true }), ent('character', 'bo', { nodes: 2, approved: true })] }),
    facts({ entities: [ent('character', 'ada', { nodes: 1, approved: true }), ent('character', 'bo', { nodes: 2 })] })],
  scenery: [facts(), facts({ entities: [ent('location', 'studio', { base: 'a white studio' })] }),
    facts({ entities: [ent('location', 'studio', { nodes: 1, approved: true }), ent('prop', 'lamp', { nodes: 1, approved: true })] }),
    facts({ entities: [ent('location', 'studio', { nodes: 1, approved: true }), ent('prop', 'lamp')] })],
  storyboard: [facts({ song, scenes: scenes(1) }), facts({ song, scenes: scenes(2), storyboard: board([{ id: 'sh01', scene: 'sc01', t0: 0, t1: 30000, sketch: 'sk1' }]) }),
    facts({ song, scenes: scenes(2), storyboard: board([{ id: 'sh01', scene: 'sc01', t0: 0, t1: 30000, sketch: 'sk1' }, { id: 'sh02', scene: 'sc02', t0: 30000, t1: 60000, sketch: 'sk2' }]) }),
    facts({ song, scenes: scenes(2), storyboard: board([{ id: 'sh01', scene: 'sc01', t0: 0, t1: 30000, sketch: 'sk1' }, { id: 'sh02', scene: 'sc02', t0: 30000, t1: 60000 }]) })],
};
for (const [id, [fe, fp, fr, fx]] of Object.entries(CASES)) {
  const e = one(view({ [id]: 'empty' }, fe), id), p = one(view({}, fp), id), d = one(view({ [id]: 'done' }, fr), id), x = one(view({ [id]: 'done' }, fx), id);
  check(`${id}: empty / partial / done / regressed`,
    e.shown === 'empty' && e.content.status === 'empty'
    && ['in_progress', 'needs_you'].includes(p.shown) && p.content.blockers.length > 0
    && d.shown === 'done' && d.content.status === 'ready' && !d.changed
    && x.shown === 'changed' && x.status === 'done' && x.shown_label === 'done ⚠ changed since' && x.changed.startsWith('changed since marked done: ') && x.changed.includes(x.content.blockers[0])
    && F.stageTip(x).includes('⚠ changed since') && F.stageTip(p).includes(p.content.blockers[0]),
    { e: [e.shown, e.content], p: [p.shown, p.content], d: [d.shown, d.content], x: [x.shown, x.changed, x.content] });
}
{ // final: ready only when the six others show done
  const f = CASES.lyrics[2], allDone = Object.fromEntries(ALL.map(id => [id, 'done']));
  const v1 = view({}, f), fin1 = one(v1, 'final');
  check('final: not ready while stages are open, lists them', fin1.shown !== 'done' && fin1.shown !== 'ready' && /stages? not done/.test(fin1.content.blockers[0]), fin1.content);
  const v2 = view(allDone, facts()), fin2 = one(v2, 'final');
  check('final: a "done" on stages whose content is empty shows changed, not done', fin2.shown === 'changed' && one(v2, 'lyrics').shown === 'changed', v2.stages.map(s => s.shown));
}
{ // derived projects and derived marks are never done; ready shows as "ready to mark done"
  const f = CASES.characters[2], v = F.stagesView(null, f), c = one(v, 'characters');
  check('derived (no stages.json): never done; content ready reads "ready to mark done"', v.derived && v.stages.every(s => s.status !== 'done' && s.shown !== 'done') && c.shown === 'ready' && c.shown_label === 'ready to mark done', v.stages.map(s => [s.id, s.status, s.shown]));
  const old = F.stagesView({ rev: 3, stages: [{ id: 'characters', status: 'done', done_by: 'derived' }] }, CASES.characters[1]), oc = one(old, 'characters');
  check('a "done" written as derived by older versions is not done', oc.status !== 'done' && oc.shown !== 'done' && oc.shown !== 'changed', oc);
  const notReady = F.stagesView({ rev: 1, stages: [{ id: 'breakdown', status: 'done', done_by: 'director', done_ok: false }] }, facts()), nb = one(notReady, 'breakdown');
  check('marked done while not ready: "done ⚠ not ready" with the reason', nb.shown === 'changed' && nb.shown_label === 'done ⚠ not ready' && /marked done while not ready: no items yet/.test(nb.changed), nb);
  const flagged = one(F.stagesView({ rev: 1, stages: [{ id: 'lyrics', status: 'needs_you', note: 'x' }] }, CASES.lyrics[2]), 'lyrics');
  check('a needs_you flag (agent or director) stays needs_you even when the content is ready', flagged.shown === 'needs_you', flagged);
}
{ // one definition of "approved" for an asset
  const ap = { items: { 'character:ada': { state: 'approved' }, 'location:studio': { state: 'changes' } } };
  const a1 = F.assetApproval(ent('character', 'ada'), ap), a2 = F.assetApproval(ent('character', 'ada', { nodes: 1, approved: true }), ap);
  const a3 = F.assetApproval(ent('character', 'bo', { status: 'approved' }), { items: {} }), a4 = F.assetApproval(ent('location', 'studio', { status: 'approved' }), ap);
  const a5 = F.assetApproval(ent('character', 'ada', { nodes: 2 }), ap), a6 = F.assetApproval(ent('prop', 'lamp'), { items: {} });
  check('assetApproval: legacy approval without a root node, root approved, approvals.json wins over entity.status',
    a1.key === 'legacy' && a1.label === 'approved (legacy) · no identity node' && a2.key === 'approved' && a3.key === 'legacy' && a4.key === 'none'
    && a5.label === 'approved (legacy) · identity not approved' && a6.label === 'needs a base' && F.assetApproval(ent('location', 'x', { status: 'approved' }), null).label === 'approved (legacy) · no base node',
    [a1, a2, a3, a4, a5, a6].map(a => a.label));
  const f = facts({ entities: [ent('character', 'ada', { status: 'approved' })], approvals: ap }), c = one(F.stagesView(null, f), 'characters');
  check('characters stage: a legacy approved entity blocks with "approved (legacy) · no identity node"', c.content.blockers.includes('Ada: approved (legacy) · no identity node') && c.shown === 'needs_you', c.content);
  const idx = facts({ entities: [{ id: 'ada', kind: 'character', name: 'Ada', path: 'entities/characters/ada.json' }] }), ci = one(F.stagesView(null, idx), 'characters');
  check('characters stage on the entity index only (no files): never ready, says why', !idx.assetsKnown && ci.content.status !== 'ready' && ci.content.blockers.some(b => /unknown here/.test(b)), ci.content);
}

// ------------------------------------------------------------------ 2. headless: the rail in each state
const require = createRequire(path.join(WB, 'package.json'));
let puppeteer; try { puppeteer = require('puppeteer-core'); } catch (e) { console.error('puppeteer-core missing: npm install'); process.exit(1); }
const { findChrome } = await import('./chrome.mjs');
const { CFG } = await import('../lib/store.mjs');
const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
const exe = findChrome(); if (!exe) { console.error('no Chromium: set CHROME_PATH'); process.exit(1); }
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-f1-'));
for (const d of ['demo', '_template']) fs.cpSync(path.join(CFG.dataRoot, d), path.join(DATA, d), { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
fs.cpSync(path.join(CFG.dataRoot, '_template'), path.join(DATA, 'f1-empty'), { recursive: true });
let proc, browser;
const cleanup = () => { try { proc?.kill(); } catch (e) {} try { browser?.process()?.kill(); } catch (e) {} try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) {} };
process.on('exit', cleanup); for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((ok, bad) => { const s = net.createServer(); s.on('error', bad); s.listen(process.env.WB_VERIFY_PORT ? Number(process.env.WB_VERIFY_PORT) + ((globalThis.__wbVerifyPortN = (globalThis.__wbVerifyPortN ?? -1) + 1) % 10) : 0, () => { const { port } = s.address(); s.close(() => ok(port)); }); });
let port = await freePort(); while (port === 8140) port = await freePort();
proc = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: { ...process.env, WORKBENCH_DATA: DATA, WB_PROJECT: 'demo' } });
proc.stderr.on('data', d => process.stderr.write('server: ' + d));
await new Promise((ok, bad) => { const t = setTimeout(() => bad(new Error('server did not start')), 15000); proc.stdout.once('data', () => { clearTimeout(t); ok(); }); proc.once('exit', (c) => { clearTimeout(t); bad(new Error('server exited ' + c)); }); });
proc.stdout.resume();
const BASE = `http://localhost:${port}`;
console.log('f1: server', BASE, '(pid', proc.pid + ') · scratch', DATA);
browser = await puppeteer.launch({ executablePath: exe, headless: true });
const pg = await browser.newPage();
await pg.setViewport({ width: 1500, height: 820, deviceScaleFactor: 1 });
pg.on('pageerror', e => console.error('pageerror', e.message));
const ready = async () => { await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await wait(300); };
const until = async (fn, arg, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
const rail = () => pg.evaluate(() => Object.fromEntries([...document.querySelectorAll('#rail a[data-stage]')].map(a => [a.dataset.stage, { shown: a.dataset.shown, title: a.title }])));
const railShot = (name) => pg.screenshot({ path: path.join(OUT, name), clip: { x: 0, y: 0, width: 1500, height: 46 } });
const D = path.join(DATA, 'demo'), rj = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
const wj = (f, j) => { const p = path.join(D, f), t = p + '.tmp'; fs.writeFileSync(t, JSON.stringify(j, null, 1)); fs.renameSync(t, p); };

try {
  // empty project
  await pg.goto(`${BASE}/?project=f1-empty`, { waitUntil: 'domcontentloaded' }); await ready();
  const r0 = await rail();
  await railShot('f1_rail_0_empty.png');
  check('page, empty project: no stage done, the empty ones say what is missing', Object.values(r0).every(s => s.shown !== 'done') && r0.breakdown.shown === 'empty' && /no items yet/.test(r0.breakdown.title), r0);

  // the demo as it ships (made before the flow: no stages.json, Ada approved in Assets, no identity node)
  await pg.goto(`${BASE}/?project=demo`, { waitUntil: 'domcontentloaded' }); await ready();
  const r1 = await rail();
  await railShot('f1_rail_1_legacy.png');
  check('page, the demo (before the flow): Breakdown empty, Characters / Scenery not done, tooltips list the blockers',
    Object.values(r1).every(s => s.shown !== 'done') && r1.breakdown.shown === 'empty' && r1.characters.shown === 'needs_you' && r1.characters.title.includes('Ada: approved (legacy) · no identity node')
    && r1.characters.title.includes('Bo: needs a base') && r1.scenery.title.includes('approved (legacy) · no base node') && r1.script.title.includes('intake question'), r1);
  // the agent side (stages_get, the MCP tool) computes the same statuses as the page
  const tok = await pg.evaluate(() => document.querySelector('meta[name=wb-token]')?.content || '');
  const sg = await fetch(`${BASE}/api/op/stages_get?project=demo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': tok }, body: '{}' }).then(r => r.json()).catch(e => ({ error: e.message }));
  const agentShown = Object.fromEntries((sg.stages || []).map(s => [s.id, s.shown]));
  check('stages_get (the agent) agrees with the rail: same shown status per stage, Ada legacy in the blockers',
    Object.keys(r1).every(id => agentShown[id] === r1[id].shown) && sg.stages.find(s => s.id === 'characters').blockers_all.includes('Ada: approved (legacy) · no identity node'), { agentShown, page: Object.fromEntries(Object.entries(r1).map(([k, v]) => [k, v.shown])) });
  // Assets › Characters and the Characters stage say the same about Ada
  await pg.evaluate(() => window.WB.app.show('characters')); await wait(400);
  const assetsChip = await pg.evaluate(() => [...document.querySelectorAll('.cc.lead')].map(c => [c.dataset.ent, c.querySelector('.chip')?.textContent]));
  await pg.screenshot({ path: path.join(OUT, 'f1_assets_characters.png'), clip: { x: 0, y: 0, width: 1500, height: 420 } });
  await pg.evaluate(() => window.WB.stages.open('characters')); await until(() => !!document.querySelector('.chlist .chrow[data-ent=ada]'));
  const stageRow = await pg.evaluate(() => ({ ada: document.querySelector('.chlist .chrow[data-ent=ada] .chst')?.textContent, bo: document.querySelector('.chlist .chrow[data-ent=bo] .chst')?.textContent,
    imp: !!document.querySelector('.chlist .chrow[data-ent=ada] [data-imp=ada]'), bar: document.querySelector('.sgbar .sgst')?.textContent }));
  await pg.screenshot({ path: path.join(OUT, 'f1_stage_characters_legacy.png'), clip: { x: 0, y: 0, width: 1500, height: 300 } });
  check('Assets and the Characters stage agree: Ada "approved (legacy) · no identity node", with Import as identity',
    assetsChip.find(x => x[0] === 'ada')?.[1] === 'approved (legacy) · no identity node' && stageRow.ada === 'approved (legacy) · no identity node' && stageRow.bo === 'needs a base' && stageRow.imp && /needs you/.test(stageRow.bar), { assetsChip, stageRow });
  // the import button opens the import picker for Ada's identity (cancelled: nothing written)
  await pg.click('.chlist .chrow[data-ent=ada] [data-imp=ada]'); await wait(500);
  const picker = await pg.evaluate(() => document.body.innerText.includes('Import an image as a node of identity'));
  await pg.keyboard.press('Escape'); await wait(200);
  check('"Import as identity" opens the import picker on Ada\'s identity tree', picker);

  // U6 / U8: one status, the same buttons and one ask menu on every stage bar
  const bars = {};
  for (const id of ['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'final']) {
    await pg.evaluate((s) => window.WB.stages.open(s), id); await until((s) => window.WB.stages.current() === s && !!document.querySelector('.sgbar .sgst'), id); await wait(200);
    const b = await pg.evaluate(() => ({ st: document.querySelector('.sgbar .sgst')?.textContent.trim(), btns: [...document.querySelectorAll('.sgbar button')].map(x => x.textContent.trim()),
      askX: Math.round(document.querySelector('.sgbar [data-ask]')?.getBoundingClientRect().left - document.querySelector('.sgbar .sgst').getBoundingClientRect().right) }));
    await pg.evaluate(() => document.querySelector('.sgbar [data-ask]')?.click()); await wait(200);
    b.asks = await pg.evaluate(() => [...document.querySelectorAll('.pop .pi .lb')].map(e => e.textContent));
    await pg.keyboard.press('Escape'); await wait(100);
    bars[id] = b;
  }
  if (bars.script) await pg.evaluate(() => window.WB.stages.open('script'));
  await wait(200); await pg.screenshot({ path: path.join(OUT, 'f1_stage_bar_script.png'), clip: { x: 0, y: 0, width: 1500, height: 80 } });
  const nextHint = await pg.evaluate(() => document.querySelector('#rail .next')?.textContent || '');
  const sameBtns = Object.values(bars).every(b => b.btns.length === 3 && /^(Mark done|Reopen)$/.test(b.btns[0]) && b.btns[1] === 'Needs you' && b.btns[2] === 'Ask the agent…');
  check('U6 / U8: every stage bar shows one status (no "(marked …)"), the same three buttons (Mark done | Reopen · Needs you · Ask the agent…) in the same place; "Ask the agent…" lists the stage\'s asks, each worded "Ask the agent …"; the rail\'s next hint is "next: <stage> · <its status>"',
    sameBtns && Object.values(bars).every(b => !/marked/.test(b.st) && b.asks.length >= 1 && b.asks.every(a => /^Ask the agent/.test(a))) && new Set(Object.values(bars).map(b => b.askX)).size <= 2
    && /^next: \S+ · (empty|in progress|needs you|ready to mark done|done ⚠ changed since)$/.test(nextHint.trim()), { bars, nextHint });

  // done: the director marks lyrics done (content ready); Ada and Bo get an approved identity; Characters marked done
  await pg.evaluate(() => window.WB.stages.setStatus('lyrics', 'done'));
  const img = rj('entities/characters/ada.json').face;
  for (const id of ['ada', 'bo']) {
    const e = rj(`entities/characters/${id}.json`);
    e.iter = { nodes: [{ id: 'n01', tree: 'identity', parent: null, image: img, request: null, kind: 'identity', edit: null, choice: null, at: '2026-10-05T10:00:00', by: 'director', via: 'page', origin: 'imported' }],
      trees: { identity: { head: 'n01', approved: 'n01', approved_at: '2026-10-05T10:01:00', approved_by: 'director', via: 'page' } }, notes: [], log: [] };
    wj(`entities/characters/${id}.json`, e);
  }
  await until(() => document.querySelector('#rail a[data-stage=characters]')?.dataset.shown === 'ready');
  const r2a = await rail();
  await pg.evaluate(() => window.WB.stages.setStatus('characters', 'done'));
  await until(() => document.querySelector('#rail a[data-stage=characters]')?.dataset.shown === 'done');
  const r2 = await rail(), st2 = rj('stages.json').stages.find(s => s.id === 'characters');
  await railShot('f1_rail_2_done.png');
  check('page, done: "ready to mark done" before the mark, done after it (director, via page, done_ok)',
    r2a.characters.shown === 'ready' && r2.characters.shown === 'done' && r2.lyrics.shown === 'done' && st2.status === 'done' && st2.done_by === 'director' && st2.done_ok === true, { before: r2a.characters, after: r2.characters, st2 });

  // regressed: Bo's identity approval is gone (unlocked) -> Characters "done ⚠ changed since", with the reason
  const bo = rj('entities/characters/bo.json'); delete bo.iter.trees.identity.approved; wj('entities/characters/bo.json', bo);
  await until(() => document.querySelector('#rail a[data-stage=characters]')?.dataset.shown === 'changed');
  const r3 = await rail();
  await railShot('f1_rail_3_regressed.png');
  await pg.evaluate(() => window.WB.stages.open('characters')); await wait(400);
  const bar3 = await pg.evaluate(() => ({ st: document.querySelector('.sgbar .sgst')?.textContent, bl: document.querySelector('.sgbar .sgbl')?.textContent, reopen: [...document.querySelectorAll('.sgbar [data-st]')].map(b => b.textContent) }));
  await pg.screenshot({ path: path.join(OUT, 'f1_stage_characters_regressed.png'), clip: { x: 0, y: 0, width: 1500, height: 140 } });
  check('page, regressed: the rail and the stage bar say "done ⚠ changed since" and why; Reopen offered',
    r3.characters.shown === 'changed' && r3.characters.title.includes('⚠ changed since marked done: Bo: identity · 1 node') && bar3.st.includes('done ⚠ changed since') && bar3.bl.includes('Bo: identity · 1 node') && bar3.reopen.includes('Reopen'), { r3: r3.characters, bar3 });
} catch (e) { console.error(e); results.aborted = false; }
const fails = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
console.log(`\nf1: ${Object.keys(results).length - fails.length}/${Object.keys(results).length} pass${fails.length ? ' · FAIL: ' + fails.join(' | ') : ''} · screenshots in ${OUT} (f1_*.png)`);
await browser.close().catch(() => {});
process.exit(fails.length ? 1 : 0);
