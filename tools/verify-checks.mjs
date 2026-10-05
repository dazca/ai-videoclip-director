// v21 of the headless UI suite (tools/verify.mjs): identity checks (ROADMAP_v4 D7) and the character constants editor (D2).
// Exported so verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-checks.mjs [outDir]
// Self-contained: a scratch copy of data/demo (Ada gets an approved identity node and a base description), a scratch media
// root, its own server on a free port, an MCP client over stdio; all deleted at the end. Nothing is generated or paid.
// The cycle: the director seeds Ada's constants from the base in the Characters stage, names one "clip side", saves, and
// switches "ask for an identity check when an output lands" on -> the agent adds two look nodes from an approved, done
// request (character_iteration_add) and imports two takes of shot s2-wall (media_import) -> ONE "identity check" ask per
// landing, in the Characters Notes column -> the agent writes check_add per output (a bad target, an unknown constant and
// "ok" with a failed constant are refused) -> the asks are absorbed -> badges on the nodes ("✗ clip side", "identity ok")
// and on the take cards ("drift"), hover shows the items -> approvals.json, requests.json and storyboard.json are untouched;
// with the switch off, nothing is asked. Screenshots v21_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sdk = (p) => import(pathToFileURL(path.join(WB, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);
const sha = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return null; } };
export const BASE_TEXT = 'Ada, late twenties, wiry. Copper-tipped curls; cyan jaw seam + hazel-green eyes. Orange starburst clip above the LEFT ear';

// the fixture: Ada with an approved identity node (n01) and a base description, a done look request with two outputs (its
// approval recorded from the page), a done shot request for s2-wall, and two takes under a scratch media root
export function checksFixture(PD, MR) {
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8')), W = (f, d) => fs.writeFileSync(path.join(PD, f), JSON.stringify(d, null, 1));
  const ada = J('entities/characters/ada.json');
  ada.base = { text: BASE_TEXT, refs: [], at: '2026-10-05T09:00:00', by: 'director', via: 'page' };
  ada.iter = { nodes: [{ id: 'n01', tree: 'identity', parent: null, image: 'media/still/ada_face.jpg', request: null, kind: 'identity', edit: null, choice: 'kept', at: '2026-10-05T09:00:00', by: 'director', via: 'page' }],
    trees: { identity: { head: 'n01', approved: 'n01', approved_by: 'director', via: 'page' } }, notes: [], log: [] };
  W('entities/characters/ada.json', ada);
  for (const i of [0, 1]) { fs.mkdirSync(path.join(PD, 'gen', 'rv21look'), { recursive: true }); fs.copyFileSync(path.join(PD, 'media', 'still', i ? 'ada_face.jpg' : 'ada_body.jpg'), path.join(PD, 'gen', 'rv21look', `rv21look_${i}.jpg`)); }
  fs.mkdirSync(path.join(MR, 'v21'), { recursive: true });
  for (const [n, src] of [['take_a.jpg', 'ada_body.jpg'], ['take_b.jpg', 'ada_face.jpg'], ['late.jpg', 'ada_face.jpg']]) fs.copyFileSync(path.join(PD, 'media', 'still', src), path.join(MR, 'v21', n));
  const R = J('requests.json'), log = [{ at: '2026-10-05T10:00:00', by: 'director', via: 'page', status: 'approved' }, { at: '2026-10-05T10:01:00', by: 'agent', via: 'agent', status: 'done' }];
  R.items.push({ id: 'rv21look', kind: 'look-sheet', target: 'character:ada', prompt: 'Ada, orange hoodie look sheet', refs: ['media/still/ada_face.jpg'], est_cost: 0.24, status: 'done', by: 'agent', at: '2026-10-05T10:01:00', tool: 'fal-ai/nano-banana-2/edit',
    asset: { type: 'character', id: 'ada', tree: 'look:base', from: 'n01', kind: 'look' }, outputs: ['gen/rv21look/rv21look_0.jpg', 'gen/rv21look/rv21look_1.jpg'], actual_cost_usd: 0.24, log });
  R.items.push({ id: 'rv21shot', kind: 'shot-still', target: 'shot:s2-wall', prompt: 'Ada at the wall', refs: [], est_cost: 0.24, status: 'done', by: 'agent', at: '2026-10-05T10:01:00', tool: 'fal-ai/nano-banana-2/edit', outputs: [], actual_cost_usd: 0, log });
  R.rev = (R.rev || 0) + 1; W('requests.json', R);
}

export async function verifyChecks({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v21 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v21-')), DATA = path.join(TMP, 'data'), P = 'checks', PD = path.join(DATA, P), MB = path.join(TMP, 'mb'), MR = path.join(MB, 'mroot');
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  checksFixture(PD, MR);
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: ['mroot/'] }));
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WORKBENCH_MEDIA_BASE: MB, WB_PROJECT: P, WB_AGENT_APPROVALS: '' };
  delete env.WB_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v21 server: ' + d));
  let pg = null, client = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-checks', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* an error text */ } return { error: !!r.isError, body, text: t }; };

    // 1. the page: the Characters stage, Ada, Identity: the constants editor (seed from base, a label, save) and the switch
    pg = await browser.newPage();
    await pg.setViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v21 pageerror', e.stack || e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.error('v21 console', m.text()); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const fileUntil = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) { /* not yet */ } await wait(100); } return false; };
    const shot = async (n, sel, pad = 6) => {
      await frames(3); await wait(200);
      let clip;
      if (sel) clip = await pg.evaluate((s, p) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.max(0, r.left - p), y: Math.max(0, r.top - p), width: Math.min(innerWidth, r.width + 2 * p), height: Math.min(innerHeight - Math.max(0, r.top - p), r.height + 2 * p) }; }, sel, pad);
      await pg.screenshot({ path: path.join(OUT, `${n}.png`), ...(clip ? { clip } : {}) });
    };
    const box = (sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, sel);
    const clickSel = async (sel) => { const b = await box(sel); if (!b) return false; await pg.mouse.click(b.x + b.w / 2, b.y + b.h / 2); await wait(300); return true; };
    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(3);
    await pg.evaluate(() => window.WB.stages.open('characters')); await wait(600);
    await pg.evaluate(() => window.WB.characters.open('ada')); await wait(400);
    await pg.evaluate(() => window.WB.characters.ws.setTab('identity')); await wait(300);
    const empty = await pg.evaluate(() => ({ editor: !!document.querySelector('.chconst'), rows: document.querySelectorAll('.chconst .ccrow').length, ask: document.querySelector('.chconst .ccask')?.checked }));
    await clickSel('.chconst [data-a=ccseed]');
    const seeded = await pg.evaluate(() => [...document.querySelectorAll('.chconst .ccrow .cctext')].map(i => i.value));
    // the director tidies the seed: drops the first row (not a detail), names the clip "clip side", unticks the eyes
    await clickSel('.chconst .ccrow[data-ci="0"] [data-a=ccrm]');
    const rowOf = (re) => pg.evaluate((src) => [...document.querySelectorAll('.chconst .ccrow')].findIndex(r => new RegExp(src, 'i').test(r.querySelector('.cctext').value)), re);
    const clipRow = await rowOf('starburst clip'), eyesRow = await rowOf('hazel');
    await pg.click(`.chconst .ccrow[data-ci="${clipRow}"] .cclabel`); await pg.keyboard.type('clip side');
    await pg.click(`.chconst .ccrow[data-ci="${eyesRow}"] .ccchk`); await wait(200);
    await clickSel('.chconst [data-a=ccadd]'); await pg.keyboard.type('never the Anthropic logo'); await wait(100);
    await shot('v21_constants_draft', '.chconst');
    await pg.keyboard.press('Enter');
    await fileUntil(() => (J('entities/characters/ada.json').constants || []).length >= 4);
    await clickSel('.chconst .ccask');
    await fileUntil(() => J('settings.json').identity_checks === true);
    await until(() => !document.querySelector('.chconst .unsaved') && document.querySelector('.chconst .ccask')?.checked && document.querySelectorAll('.chconst .ccrow').length === 5);
    await shot('v21_constants', '.chconst');
    const shown = await pg.evaluate(() => ({ rows: document.querySelectorAll('.chconst .ccrow').length, unsaved: !!document.querySelector('.chconst .unsaved'), label: [...document.querySelectorAll('.chconst .cclabel')].map(i => i.value).join('|') }));
    const consts = J('entities/characters/ada.json').constants || [];
    const clipC = consts.find(c => /starburst clip/i.test(c.text)), eyesC = consts.find(c => /hazel/i.test(c.text));
    check('D2 constants editor: Seed from base proposes one row per detail of the base description; the director drops one, names "clip side", unticks the eyes, adds a row, saves (Enter) -> entity constants[] {text, check, label}; the switch writes settings.json identity_checks',
      empty.editor && empty.rows === 0 && empty.ask === false && seeded.length >= 4 && seeded.some(s => /copper-tipped curls/i.test(s)) && seeded.some(s => /cyan jaw seam/i.test(s))
      && clipC?.label === 'clip side' && clipC.check === true && eyesC?.check === false && consts.some(c => c.text === 'never the Anthropic logo') && !consts.some(c => /late twenties/i.test(c.text)) && J('settings.json').identity_checks === true
      && shown.rows === 5 && !shown.unsaved && shown.label.includes('clip side'),
      { seeded, consts, shown });

    // 2. outputs land: two look nodes (character_iteration_add of a done, approved request) and two imported takes of s2-wall
    const before = { approvals: sha(path.join(PD, 'approvals.json')), requests: sha(path.join(PD, 'requests.json')) };
    const n2 = await tool('character_iteration_add', { id: 'ada', request: 'rv21look', image: 'gen/rv21look/rv21look_0.jpg' });
    const n3 = await tool('character_iteration_add', { id: 'ada', request: 'rv21look', image: 'gen/rv21look/rv21look_1.jpg' });
    const imp = await tool('media_import', { paths: ['mroot/v21/take_a.jpg', 'mroot/v21/take_b.jpg'], request: 'rv21shot' });
    const asks = () => (J('notes.json').notes || []).filter(n => n.ask === 'check');
    const ck = J('checks.json'), A1 = asks();
    const nodeIds = [n2.body?.node?.id, n3.body?.node?.id], mids = (imp.body?.imported || []).map(x => x.id);
    check('when outputs land (a node joins a tree, files are imported) with the switch on, the agent gets ONE "identity check" ask per landing on the character (to: agent), listing the outputs with the target to name, the approved identity n01 and the checklist (ticked constants only); checks.json records what was asked',
      !n2.error && !n3.error && !imp.error && A1.length === 3 && A1.every(n => n.to === 'agent' && n.target.stage === 'characters' && n.target.id === 'ada' && n.status === 'open' && /n01/.test(n.text) && /clip above the LEFT ear/i.test(n.text) && !/hazel/i.test(n.text))
      && A1.some(n => n.text.includes(`ada/${nodeIds[0]}`)) && A1.some(n => mids.every(m => n.text.includes(`s2-wall/${m}`))) && ck.asks.length === 3,
      { asks: A1.map(n => n.text.slice(0, 160)), nodes: nodeIds, mids, err: [n2.text, imp.text].filter(t => /error/.test(t)).map(t => t.slice(0, 200)) });
    const cg = (await tool('checks_get', { entity: 'ada' })).body;
    check('checks_get: enabled, the open asks with every output (absolute file, unchecked), the checklist (approved identity n01 with its absolute image; the ticked constants + likeness)',
      cg.enabled === true && cg.asks?.length === 3 && cg.asks.every(a => a.unchecked === a.files.length && a.files.every(f => f.abs && fs.existsSync(f.abs))) && cg.checklist?.[0]?.identity?.node === 'n01' && fs.existsSync(cg.checklist[0].identity.abs)
      && cg.checklist[0].to_check.includes('likeness') && !cg.checklist[0].to_check.some(t => /hazel/i.test(t)), { asks: cg.asks?.length, checklist: cg.checklist?.[0]?.to_check });

    // 3. the agent's checks: refused when wrong, written to checks.json only
    const bad1 = await tool('check_add', { target: { kind: 'node', id: 'ada/n99' }, against: { entity: 'ada' }, verdict: 'ok' });
    const bad2 = await tool('check_add', { target: { kind: 'node', id: `ada/${nodeIds[0]}` }, against: { entity: 'ada' }, verdict: 'fail', items: [{ constant: 'a tattoo', ok: false }] });
    const bad3 = await tool('check_add', { target: { kind: 'node', id: `ada/${nodeIds[0]}` }, against: { entity: 'ada' }, verdict: 'ok', items: [{ constant: 'clip side', ok: false }] });
    const bad4 = await tool('check_add', { target: { kind: 'take', id: 's3-grid/' + mids[0] }, against: { entity: 'ada' }, verdict: 'ok' });
    const c1 = await tool('check_add', { target: { kind: 'node', id: `ada/${nodeIds[0]}` }, against: { entity: 'ada' }, verdict: 'fail', note: 'the clip moved to her right side; the rest holds',
      items: [{ constant: 'clip side', ok: false, note: 'clip on the RIGHT side' }, { constant: 'Copper-tipped curls', ok: true }, { constant: 'cyan jaw seam', ok: true }, { constant: 'likeness', ok: true }] });
    const c2 = await tool('check_add', { target: { kind: 'node', id: `ada/${nodeIds[1]}` }, against: { entity: 'ada' }, verdict: 'ok', items: [{ constant: 0, ok: true }, { constant: 'likeness', ok: true }] });
    const c3 = await tool('check_add', { target: { kind: 'take', id: `s2-wall/${mids[0]}` }, against: { entity: 'ada' }, verdict: 'drift', note: 'the curls lose their copper tips toward the end', items: [{ constant: 'clip side', ok: true }, { constant: 'likeness', ok: true }] });
    const c4 = await tool('check_add', { target: { kind: 'take', id: `s2-wall/${mids[1]}` }, against: { entity: 'ada' }, verdict: 'ok', items: [{ constant: 'clip side', ok: true }] });
    const after = { approvals: sha(path.join(PD, 'approvals.json')), requests: sha(path.join(PD, 'requests.json')) };
    const A2 = asks();
    check('check_add: a missing node (404), an unknown constant (400), "ok" with a failed constant (400) and a take of another shot (404) are refused; four checks written (badges "✗ clip side", "identity ok", "drift"); approvals.json and requests.json unchanged; every ask whose outputs are all checked is absorbed with the results',
      bad1.error && /404/.test(bad1.text) && bad2.error && /constant/.test(bad2.text) && bad3.error && /drift/.test(bad3.text) && bad4.error && /404/.test(bad4.text)
      && c1.body?.badge?.label === '✗ clip side' && c2.body?.badge?.label === 'identity ok' && c3.body?.badge?.label === 'drift' && !c4.error && J('checks.json').checks.length === 4
      && after.approvals === before.approvals && after.requests === before.requests && A2.every(n => n.status === 'absorbed' && n.replies?.some(r => /checked:/.test(r.text))),
      { bad: [bad1.text, bad2.text, bad3.text, bad4.text].map(t => t.slice(0, 90)), badges: [c1, c2, c3].map(c => c.body?.badge?.label), asks: A2.map(n => n.status) });

    // 4. the badges on the nodes (Looks tab) and the hover detail
    await pg.evaluate(() => { const ws = window.WB.characters.ws; ws.setTab('looks'); }); await wait(500);
    await until(() => document.querySelectorAll('.chnode .ckb').length >= 2);
    const nb = await pg.evaluate(() => [...document.querySelectorAll('.chnode')].map(n => ({ node: n.dataset.node, badge: n.querySelector('.ckb')?.textContent || null })));
    await shot('v21_node_badges', '.chtree');
    const bb = await box(`.chnode[data-node="${nodeIds[0]}"] .ckb`);
    await pg.mouse.move(bb.x + bb.w / 2, bb.y + bb.h / 2); await wait(250);
    const pop = await pg.evaluate(() => { const p = document.querySelector('.ckpop'); return p && getComputedStyle(p).display !== 'none' ? { text: p.textContent, no: [...p.querySelectorAll('li.no')].map(l => l.textContent), ok: p.querySelectorAll('li.ok').length } : null; });
    const pb = await pg.evaluate(() => { const r = document.querySelector('.ckpop').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await pg.screenshot({ path: path.join(OUT, 'v21_hover.png'), clip: { x: Math.max(0, Math.min(bb.x, pb.x) - 8), y: Math.max(0, bb.y - 90), width: Math.max(pb.w, 200) + 120, height: pb.y + pb.h - bb.y + 100 } });
    await pg.mouse.move(5, 5); await wait(150);
    check('the look nodes carry the badges ("✗ clip side" on the drifted one, "identity ok"); hovering a badge shows its items (✗ clip side: clip on the RIGHT side; ✓ the others), the note and "the director decides"',
      nb.find(n => n.node === nodeIds[0])?.badge === '✗ clip side' && nb.find(n => n.node === nodeIds[1])?.badge === 'identity ok' && pop && pop.no.length === 1 && /clip on the RIGHT side/.test(pop.no[0]) && pop.ok === 3 && /director decides/.test(pop.text),
      { nb, pop });

    // 5. the badges on the take cards (Storyboard › Shot › takes)
    await pg.evaluate(() => window.WB.stages.open('storyboard')); await wait(600);
    await pg.evaluate(() => window.WB.storyboard.focus('s2-wall')); await wait(600);
    await until(() => document.querySelectorAll('.sbins .tkc .ckb').length >= 2);
    const tb = await pg.evaluate(() => [...document.querySelectorAll('.sbins .tkc')].map(c => ({ m: c.dataset.tk, badge: c.querySelector('.ckb')?.textContent || null })));
    await shot('v21_take_badges', '.sbins .tkw');
    const tbb = await box(`.sbins .tkc[data-tk="${mids[0]}"] .ckb`);
    if (tbb) { await pg.mouse.move(tbb.x + tbb.w / 2, tbb.y + tbb.h / 2); await wait(250); }
    const tpop = await pg.evaluate(() => { const p = document.querySelector('.ckpop'); return p && getComputedStyle(p).display !== 'none' ? p.textContent : null; });
    if (tpop) { const pb2 = await pg.evaluate(() => { const r = document.querySelector('.ckpop').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }); await pg.screenshot({ path: path.join(OUT, 'v21_take_hover.png'), clip: { x: Math.max(0, Math.min(tbb.x, pb2.x) - 8), y: Math.max(0, tbb.y - 70), width: Math.max(pb2.w, 200) + 140, height: pb2.y + pb2.h - tbb.y + 80 } }); }
    await pg.mouse.move(5, 5);
    check('the take cards of s2-wall carry the badges ("drift" on take_a, "identity ok" on take_b), with the same hover detail; the other takes have none',
      tb.find(t => t.m === mids[0])?.badge === 'drift' && tb.find(t => t.m === mids[1])?.badge === 'identity ok' && tb.filter(t => t.badge).length === 2 && /copper tips/.test(tpop || ''), { tb, tpop: tpop?.slice(0, 120) });

    // 6. the ask in the Characters Notes column (a new landing), then the switch off: nothing asked
    const imp2 = await tool('media_import', { paths: ['mroot/v21/late.jpg'], entities: ['ada'] });
    await pg.evaluate(() => window.WB.stages.open('characters')); await wait(500);
    await pg.evaluate(() => window.WB.characters.ws.setTab('identity')); await wait(400);
    await until(() => [...document.querySelectorAll('.nccell, .ncnote, [data-nid]')].some(e => /Identity check/.test(e.textContent)), null, 6000);
    const askShown = await pg.evaluate(() => { const e = [...document.querySelectorAll('[data-nid]')].find(x => /Identity check: 1 new output/.test(x.textContent)); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); return e.dataset.nid; });
    if (askShown) await shot('v21_ask_note', `[data-nid="${askShown}"]`, 40); else await shot('v21_ask_note');
    const A3 = asks();
    await pg.evaluate(() => window.WB.characters.ws.setIdentityChecks(false));
    await fileUntil(() => J('settings.json').identity_checks !== true);
    fs.copyFileSync(path.join(MR, 'v21', 'late.jpg'), path.join(MR, 'v21', 'later.jpg'));
    const imp3 = await tool('media_import', { paths: ['mroot/v21/later.jpg'], entities: ['ada'] });
    check('a later import of an Ada image asks again (one open ask, shown in the Characters Notes column); with the switch off, an import asks nothing',
      !imp2.error && A3.length === 4 && A3.filter(n => n.status === 'open').length === 1 && !!askShown && !imp3.error && asks().length === 4, { asks: A3.length, askShown, after: asks().length });
  } catch (e) { console.error('v21 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await client?.close().catch(() => {});
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-checks.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyChecks({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v21 (identity checks):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
