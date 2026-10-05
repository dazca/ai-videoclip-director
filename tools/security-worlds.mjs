#!/usr/bin/env node
// Security regressions for E3 chapters, E5 placeholder frames and E6 looks per world (ROADMAP_v4):
//   - a look's world is the director's: asset_act look_world / look_world_accept / look_world_dismiss are page only (S9: the
//     page token + this server's Origin + Sec-Fetch-Site: same-origin). 403 to the page token alone, the agent token, the
//     Origin alone, Sec-Fetch-Site alone, a forged Origin with the agent token, a claimed via "page"; no MCP tool; offline
//     (the data layer without via) refuses too; entity_upsert cannot change an existing look's world
//   - a world is a short name: markup, quotes, control characters, > 40 characters are 400 on every path (look_create,
//     look_world_propose, scenes_update, shots_update, a page save of storyboard.json / scenes.json)
//   - chapters: a page save never stores a `status` (the build status is derived); a chapter `file` cannot leave the
//     composition; a scene in two chapters is 400; names / owners / whys render escaped in the page (no element injected)
//   - the placeholder SVG is made from the shot's text only: markup is escaped (no <script>, no on*, no href / url()), and a
//     picked private take's file name never appears in it
//   - a project locked for render refuses the agent's chapters_update and look_world_propose (409)
// Scratch copy of data/demo, its own server on a free port; never touches data/.   node tools/security-worlds.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = 'worlds', TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sec-worlds-')), DATA = path.join(TMP, 'data'), D = path.join(DATA, P);
fs.cpSync(path.join(WB, 'data', 'demo'), D, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
Object.assign(process.env, { WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P });
for (const k of ['WB_TOKEN', 'WB_HOST', 'WB_ALLOW_REMOTE_OPS']) delete process.env[k];
const S = await import('../lib/store.mjs');
const { placeholderFor, placeholderSvg } = await import('../js/placeholder.js');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const J = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
const ada = () => J('entities/characters/ada.json');
let srv = null, browser = null;
try {
  const port = await freePort(), BASE = `http://localhost:${port}`;
  srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: process.env });
  srv.stderr.on('data', d => process.stderr.write('server: ' + d));
  await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
  const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
  const AGENT = fs.readFileSync(path.join(DATA, '.wb-agent-token'), 'utf8').trim();
  const H = {
    page: { 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'same-origin' },
    tokenOnly: { 'x-wb-token': TOKEN },
    agent: { 'x-wb-agent-token': AGENT },
    originOnly: { 'x-wb-token': TOKEN, origin: BASE },
    fetchSiteOnly: { 'x-wb-token': TOKEN, 'sec-fetch-site': 'same-origin' },
    agentForged: { 'x-wb-agent-token': AGENT, 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'same-origin' },
    crossSite: { 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'cross-site' },
  };
  const op = async (name, body, h = H.agent) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const save = async (file, fn, h = H.page) => { const d = J(file); fn(d); const r = await fetch(`${BASE}/api/save/${file}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ base_rev: d.rev || 0, data: d }) }); return { status: r.status, body: await r.json().catch(() => null) }; };

  // 1. a look's world is the director's
  await op('look_world_propose', { id: 'ada', look: 'base', world: 'dancing', why: 'x' });
  const acts = ['look_world', 'look_world_accept', 'look_world_dismiss'], res = {};
  for (const act of acts) for (const [k, h] of Object.entries(H)) if (k !== 'page') res[`${act}/${k}`] = (await op('asset_act', { type: 'character', id: 'ada', act, look: 'base', world: 'on screen', via: 'page' }, h)).status;
  let offline = null; try { S.ops.asset_act(P, { type: 'character', id: 'ada', act: 'look_world', look: 'base', world: 'x' }); offline = 'allowed'; } catch (e) { offline = e.code; }
  const eu = await op('entity_upsert', { kind: 'character', id: 'ada', fields: { looks: ada().looks.map(l => ({ ...l, context: 'stolen', world_proposal: null })) } });
  const a1 = ada().looks.find(l => l.id === 'base');
  check('a look\'s world is page only: asset_act look_world / accept / dismiss refused (403) to the page token alone, the agent token, the Origin alone, Sec-Fetch-Site alone, cross-site, the agent token with a forged Origin (all with via "page" claimed) and offline; entity_upsert keeps the stored world and the proposal',
    Object.values(res).every(s => s === 403) && offline === 403 && eu.status === 200 && !a1.context && a1.world_proposal?.world === 'dancing', { res, offline, a1: [a1.context, a1.world_proposal?.world] });
  const pg1 = await op('asset_act', { type: 'character', id: 'ada', act: 'look_world_accept', look: 'base' }, H.page);
  check('the page accepts the world proposal (200: the look\'s world)', pg1.status === 200 && ada().looks.find(l => l.id === 'base').context === 'dancing', pg1.body);

  // 2. a world is a short name, on every path
  const BAD = ['<img src=x onerror=alert(1)>', 'on"screen', 'a\u0000b', 'x'.repeat(41), '   '];
  const bads = {};
  for (const w of BAD.slice(0, 4)) {
    bads[`look_create ${JSON.stringify(w).slice(0, 12)}`] = (await op('look_create', { id: 'ada', name: 'W ' + Math.random(), world: w })).status;
    bads[`propose ${JSON.stringify(w).slice(0, 12)}`] = (await op('look_world_propose', { id: 'ada', look: 'base', world: w })).status;
    bads[`scenes ${JSON.stringify(w).slice(0, 12)}`] = (await op('scenes_update', { upsert: [{ id: 'sc01', context: w }] })).status;
    bads[`shots ${JSON.stringify(w).slice(0, 12)}`] = (await op('shots_update', { upsert: [{ id: 's1-intro', context: w }] })).status;
    bads[`page look_world ${JSON.stringify(w).slice(0, 12)}`] = (await op('asset_act', { type: 'character', id: 'ada', act: 'look_world', look: 'base', world: w }, H.page)).status;
  }
  check('a world with markup, a quote, a control character or over 40 characters is 400 on look_create, look_world_propose, scenes_update, shots_update and the page\'s look_world', Object.values(bads).every(s => s === 400), bads);
  // a page save needs a storyboard.json to exist: make one, then forge a world
  await op('shots_update', { upsert: [{ id: 's1-intro', title: 'make the file' }] });
  const sb2 = await save('storyboard.json', (d) => { const v = d.versions.find(x => x.id === d.current); d.versions.push({ ...v, id: 'vbad', shots: v.shots.map(s => ({ ...s, context: '<b>x</b>' })) }); d.current = 'vbad'; });
  check('a page save of storyboard.json with a shot world that is not a world name is 400', sb2.status === 400 && /context|world/.test(JSON.stringify(sb2.body)), { status: sb2.status, body: sb2.body });

  // 3. chapters: no stored status, no file outside the composition, a scene in one chapter
  const XSS = '<img src=x onerror="window.__pwn=1">';
  const cu = await op('chapters_update', { upsert: [{ name: XSS, scenes: ['sc01', 'sc02'], owner: XSS, status: 'approved' }] });
  const forged = await save('storyboard.json', (d) => { d.chapters = d.chapters.map(c => ({ ...c, status: 'approved', name: c.name })); });
  const ch = J('storyboard.json').chapters;
  const trav = {}; for (const f of ['../x.js', '..\\x.js', '/etc/x.js', 'C:/x.js', 'a/../../x.js']) trav[f] = (await op('chapters_update', { upsert: [{ id: 'c1', file: f }] })).status;
  const twice = await op('chapters_update', { chapters: [{ id: 'c1', scenes: ['sc01'] }, { id: 'c2', scenes: ['sc01'] }] });
  const twiceSave = await save('storyboard.json', (d) => { d.chapters = [{ id: 'c1', name: 'a', scenes: ['sc01'] }, { id: 'c2', name: 'b', scenes: ['sc01'] }]; });
  check('chapters: a status sent by the agent or a page save is never stored (the status is derived); a file leaving the composition is 400; a scene in two chapters is 400 (op and page save)',
    cu.status === 200 && forged.status === 200 && ch.length === 1 && !('status' in ch[0]) && ch[0].via === 'agent' && Object.values(trav).every(s => s === 400) && twice.status === 400 && twiceSave.status === 400,
    { cu: cu.status, forged: forged.status, ch: ch.map(c => Object.keys(c)), trav, twice: twice.status, twiceSave: twiceSave.status });

  // 4. the placeholder SVG: escaped, no active content, never a file name
  const evil = { id: 'sh99', kind: 'close', t0: 0, t1: 1000, scene: 'sc01', title: '"><script>alert(1)</script>', text: '</text><script>alert(2)</script><a href="javascript:x">', cast: ['ada'],
    clip: { file: 'private/clip/secret_face_take.webm', media: 'secretmedia' }, context: 'on screen' };
  const ph = placeholderFor(evil, { entities: [{ id: 'ada', kind: 'character', name: '<svg onload=alert(3)>' }], scenes: [], reason: 'private' }).svg;
  // every tag is one of the frame's own (svg, rect, path, text) and no tag carries an event handler, a link or a url()
  const tagsOk = (svg) => (svg.match(/<[^>]*>/g) || []).every(t => /^<\/?(svg|rect|path|text)[\s>\/]/.test(t) && !/\son\w+\s*=|href|url\(|javascript:/i.test(t));
  const raw = placeholderSvg({ id: '<x>', kind: '"k"', time: "'t'", text: '&amp; <y>', cast: ['<z onerror=1>'], world: '<w>' });
  check('the placeholder SVG escapes the shot\'s text, title, cast and world (no <script>, on* attribute, href, url() or raw markup) and never names a picked take\'s file',
    tagsOk(ph) && tagsOk(raw) && !/secret/.test(ph) && /&lt;\/text&gt;&lt;script&gt;/.test(ph)
    && !/<x>|<y>|<z |<w>/.test(raw) && /&amp;amp;/.test(raw), { ph: ph.slice(0, 200) });

  // 5. the page renders chapter names / owners and world proposals escaped
  await op('look_world_propose', { id: 'ada', look: 'base', world: 'on screen', why: XSS });
  const require = createRequire(path.join(WB, 'package.json'));
  let puppeteer = null; try { puppeteer = require('puppeteer-core'); } catch (e) { /* no browser checks */ }
  const { findChrome } = await import('./chrome.mjs');
  const exe = findChrome();
  if (puppeteer && exe) {
    browser = await puppeteer.launch({ executablePath: exe, headless: true });
    const pg = await browser.newPage(); await pg.setViewport({ width: 1400, height: 850 });
    await pg.goto(`${BASE}/?project=${P}`); await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await pg.evaluate(() => window.WB.stages.open('storyboard')); await wait(800);
    const sbx = await pg.evaluate(() => ({ band: !!document.querySelector('.sbchap'), pwn: window.__pwn === 1, imgs: document.querySelectorAll('.sbchap img, .sbchsel img').length, text: document.querySelector('.sbchap')?.textContent.slice(0, 80) }));
    await pg.evaluate(() => window.WB.app.show('timeline')); await wait(800);
    const tlx = await pg.evaluate(() => ({ band: document.querySelectorAll('.col-chapters .chp').length, imgs: document.querySelectorAll('.col-chapters img').length, pwn: window.__pwn === 1 }));
    await pg.evaluate(() => window.WB.stages.open('characters')); await wait(600);
    await pg.evaluate(async () => { await window.WB.characters.open('ada'); const w = window.WB.characters.ws; w.setVariant('base'); w.render(); }); await wait(500);
    const chx = await pg.evaluate(() => ({ row: !!document.querySelector('.aswrow'), imgs: document.querySelectorAll('.aswrow img').length, pwn: window.__pwn === 1 }));
    check('the page shows a chapter name / owner and an agent\'s world-proposal why with markup as text: no element injected, no script ran (storyboard band, timeline chapters band, Characters stage)',
      sbx.band && !sbx.pwn && sbx.imgs === 0 && /<img/.test(sbx.text || '') && tlx.band === 1 && tlx.imgs === 0 && !tlx.pwn && chx.row && chx.imgs === 0 && !chx.pwn, { sbx, tlx, chx });
  } else console.log('SKIP browser checks: no puppeteer-core / Chromium');

  // 6. a project locked for render refuses the agent's chapters and world proposals
  const lk = await op('final_lock', { force: true, summary: 'sec' }, H.page);
  const c409 = await op('chapters_update', { upsert: [{ id: 'c1', name: 'locked?' }] }), w409 = await op('look_world_propose', { id: 'ada', look: 'base', world: 'off screen' });
  const ul = await op('final_unlock', {}, H.page);
  check('a project locked for render refuses the agent\'s chapters_update and look_world_propose (409)', lk.status === 200 && c409.status === 409 && w409.status === 409 && ul.status === 200, { lk: lk.status, c409: c409.status, w409: w409.status });
} catch (e) { check('test ran to the end', false, String(e.stack || e)); }
finally {
  if (browser) await browser.close().catch(() => {});
  srv?.kill(); await wait(300);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
console.log(`\n${n - failed}/${n} world / chapter / placeholder security checks passed`);
process.exit(failed ? 1 : 0);
