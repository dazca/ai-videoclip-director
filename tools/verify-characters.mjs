// v7 of the headless UI suite (tools/verify.mjs): the guided flow, phase 4 (stage 4: characters). Exported so verify.mjs
// runs it after the other blocks, and so it can run alone while working on the stage:
//   node tools/verify-characters.mjs [outDir]        (a scratch copy of data/_template + its own server; deleted at the end)
// On a new project scripted and broken down through the ops: the character list (scenes, status), the base picker
// (catalogue; Openverse with the network MOCKED: no request leaves the machine; a private photo upload), "Request
// identity sheet" -> Approve (page) -> the agent runs it (simulated: local placeholder images, nothing paid) ->
// character_iteration_add -> the tree; an edit with text + a sketch over the image + a mask + pins; the A/B compare and
// keep / branch / revert; approve identity (page only); a look from the breakdown's wardrobe; the agent's limits; the
// export without private files; the CSP (Openverse allowed, other origins blocked); the toast stack. Screenshots v7_*.png.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tinyPng } from './tiny-png.mjs';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// a placeholder "generation": a catalogue image, scaled, with an ffmpeg filter standing for the edit (no model, no network)
function placeholder(out, src, vf) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(WB, 'catalog', src), '-vf', `scale=768:-2${vf ? ',' + vf : ''}`, '-frames:v', '1', out]);
  if (r.status !== 0 || !fs.existsSync(out)) fs.writeFileSync(out, tinyPng(64, 64, [Math.random() * 255 | 0, 120, 200]));
}
// what Openverse would answer (the page's fetch is intercepted: no request leaves the machine)
const OV = (n) => ({ result_count: 3, page_count: 1, page_size: 20, page: 1, results: [
  { id: 'aaaa1111-0000-4000-8000-000000000001', title: 'Mannequin, walking pose', url: 'https://upload.wikimedia.org/x/mannequin.jpg', thumbnail: 'https://api.openverse.org/v1/images/aaaa1111-0000-4000-8000-000000000001/thumb/', foreign_landing_url: 'https://commons.wikimedia.org/wiki/File:Mannequin.jpg', creator: 'Test Creator', license: 'cc0', license_version: '1.0', license_url: 'https://creativecommons.org/publicdomain/zero/1.0/', source: 'wikimedia', category: 'illustration', attribution: '"Mannequin, walking pose" by Test Creator is marked with CC0 1.0.', mature: false, unstable__sensitivity: [] },
  { id: 'aaaa1111-0000-4000-8000-000000000002', title: 'Costume plate 1920s', url: 'https://images.metmuseum.org/x/plate.jpg', thumbnail: 'https://api.openverse.org/v1/images/aaaa1111-0000-4000-8000-000000000002/thumb/', foreign_landing_url: 'https://www.metmuseum.org/art/collection/search/1', creator: 'The Met', license: 'pdm', license_version: '1.0', license_url: 'https://creativecommons.org/publicdomain/mark/1.0/', source: 'met', category: 'digitized_artwork', attribution: '"Costume plate 1920s" is marked with Public Domain Mark 1.0.', mature: false, unstable__sensitivity: [] },
  { id: 'aaaa1111-0000-4000-8000-000000000003', title: 'hidden: sensitive', url: 'https://x.example/s.jpg', thumbnail: 'https://api.openverse.org/v1/images/aaaa1111-0000-4000-8000-000000000003/thumb/', creator: 'x', license: 'cc0', source: 'flickr', mature: false, unstable__sensitivity: ['sensitive_text'] },
].slice(0, n) });

export async function verifyCharacters({ browser, BASE, DATA, OUT, post, writeHeaders }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v7 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`); };
  const NP = 'characters-verify', ND = path.join(DATA, NP);
  if (fs.existsSync(ND)) await post('/api/projects/delete', { id: NP });
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
  pg.on('pageerror', e => console.error('pageerror', e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/Content Security Policy|example\.org|ERR_FAILED/.test(m.text())) console.error('console', m.text()); });
  // the network is mocked: Openverse answers from the fixture, every other origin is refused here (nothing leaves)
  const outside = [];
  await pg.setRequestInterception(true);
  const thumb = fs.readFileSync(path.join(WB, 'catalog', 'pose', 'walk.jpg'));
  pg.on('request', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    if (/^https:\/\/api\.openverse\.org\/v1\/images\/[^/]+\/thumb\/$/.test(u)) return r.respond({ status: 200, contentType: 'image/jpeg', headers: { 'access-control-allow-origin': '*' }, body: thumb });
    if (u.startsWith('https://api.openverse.org/v1/images/?')) return r.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(OV(3)) });
    outside.push(u); return r.abort();
  });
  const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
  const ready = async () => { await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(); };
  const combo = async (mods, key) => { for (const m of mods) await pg.keyboard.down(m); await pg.keyboard.press(key); for (const m of mods.slice().reverse()) await pg.keyboard.up(m); };
  const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ND, f), 'utf8')); } catch (e) { return null; } };
  const fileUntil = async (f, fn, ms = 6000) => { const t0 = Date.now(); let j = null; while (Date.now() - t0 < ms) { j = readJ(f); try { if (j && fn(j)) return j; } catch (e) { /* not yet */ } await wait(100); } return j; };
  const click = async (sel) => { const r = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(10, b.width / 2), y: b.top + b.height / 2 }; }, sel); if (!r) throw new Error('no element ' + sel); await pg.mouse.click(r.x, r.y); await wait(150); };
  const shot = async (name, sel) => { await pg.evaluate(() => Promise.race([new Promise(r => setTimeout(r, 1200)), Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; })))])); await frames(); if (sel) await pg.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), sel); await pg.screenshot({ path: path.join(OUT, `${name}.png`) }); };
  const ent = (id) => readJ(`entities/characters/${id}.json`);
  const reqs = () => readJ('requests.json')?.items || [];

  // 1. a project with a script and a breakdown (two characters, a wardrobe item), the characters made entities by the page
  const cr = await post('/api/projects/new', { id: NP, title: 'Characters Verify', lyrics: '[Verse 1]\nThe night bus hums along the coast\nYour coat is red against the rain\n\n[Chorus]\nRide, ride, the window glows\n\n[Verse 2]\nAt the pier the old boats creak\n\n[Outro]\nThe bus is gone' });
  const H = await writeHeaders(BASE, NP), op = (name, body) => post(`/api/op/${name}?project=${NP}`, body, BASE, H);
  const { origin: _o, ...HA } = H, agent = (name, body) => post(`/api/op/${name}?project=${NP}`, body, BASE, HA);   // the agent surface: no page Origin
  const sg = (await op('song_get', { words: false })).body, sec = (id) => sg.sections.find(s => s.id === id);
  await op('scenes_update', { scenes: [
    { t0: 0, t1: sec('chorus').t0, title: 'The night bus', text: 'Mara rides the night bus, wearing a red raincoat.', beats: [] },
    { t0: sec('chorus').t0, t1: sec('verse-2').t0, title: 'Chorus ride', text: 'Neon flicker. Mara at the window.', beats: [] },
    { t0: sec('verse-2').t0, t1: sec('outro').t0, title: 'The pier', text: 'Theo waits at the pier and hands Mara a letter.', beats: [] },
    { t0: sec('outro').t0, t1: sg.duration_ms, title: 'Morning', text: 'Mara alone.', beats: [] },
  ], message: 'verify: four scenes' });
  await agent('breakdown_update', { items: [
    { kind: 'character', name: 'Mara', description: 'late twenties, tired eyes, rides the night bus', links: ['sc01', 'sc02', 'sc03', 'sc04'] },
    { kind: 'character', name: 'Theo', description: 'waits at the pier', links: ['sc03'] },
    { kind: 'wardrobe', name: 'Red raincoat', for: 'bi01', links: ['sc01', 'sc02'] },
    { kind: 'character', name: 'Bus driver', links: ['sc02'] },
  ], message: 'verify: breakdown' });
  const p1 = await op('breakdown_promote', { item: 'bi01' }), p2 = await op('breakdown_promote', { item: 'bi02' }), p3 = await op('breakdown_promote', { item: 'bi03', character: 'mara' });
  // the "generations": placeholders on disk (what an agent would download from the provider)
  const G = (f) => `media/gen/${f}`;
  placeholder(path.join(ND, G('mara_sheet.jpg')), 'body/athletic_female_turnaround.jpg');
  placeholder(path.join(ND, G('mara_necklace.jpg')), 'body/athletic_female_turnaround.jpg', 'drawbox=x=iw*0.1:y=ih*0.23:w=iw*0.06:h=9:color=gold@1:t=fill,drawbox=x=iw*0.355:y=ih*0.23:w=iw*0.05:h=9:color=gold@1:t=fill');
  placeholder(path.join(ND, G('mara_hair.jpg')), 'body/athletic_female_turnaround.jpg', 'hue=h=25:s=1.4');
  placeholder(path.join(ND, G('mara_raincoat.jpg')), 'body/athletic_female_turnaround.jpg', 'colorchannelmixer=rr=1.3:gg=0.6:bb=0.6');
  placeholder(path.join(ND, G('theo_sheet.jpg')), 'body/athletic_male_turnaround.jpg');
  const photo = path.join(DATA, '..', `wb-v7-photo-${process.pid}.png`); placeholder(photo, 'face-angles/athletic_male_head.jpg');

  await pg.goto(`${BASE}/?project=${NP}`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
  await combo(['Alt', 'Shift'], 'Digit4'); await wait(500);
  const list = await pg.evaluate(() => ({ stage: window.WB.stages.current(), rows: [...document.querySelectorAll('.chws .chrow')].map(r => ({ char: r.dataset.char || null, ghost: r.classList.contains('ghost'), name: r.querySelector('.chnm')?.textContent, st: r.querySelector('.chst')?.textContent, scenes: r.querySelectorAll('.chsc .bdsc').length })) }));
  await shot('v7_characters_list');
  check('the characters stage (Alt+Shift+4) lists the breakdown characters with their scenes and status; one not yet an entity shows as such',
    cr.status === 200 && p1.body?.entity_id === 'mara' && p2.body?.entity_id === 'theo' && p3.body?.look_id && list.stage === 'characters' && list.rows.length === 3
    && list.rows[0].char === 'mara' && list.rows[0].scenes === 4 && /needs a base/.test(list.rows[0].st) && list.rows.some(r => r.ghost && r.name === 'Bus driver'),
    { list, p3: p3.body });

  // 2. base: the catalogue (filtered by kind), Openverse (mocked), a description
  await click('.chsrc [data-src=catalog]'); await until(() => document.querySelectorAll('.chgrid .chtile').length > 3);
  await pg.select('.chcatkind', 'body'); await wait(200);
  await click('.chgrid [data-cat="body-athletic_female"]');
  await shot('v7_base_catalog');
  const catRef = await pg.evaluate(() => window.WB.characters.ws.draft().refs.find(r => r.source === 'catalog'));
  await click('.chsrc [data-src=openverse]');
  await pg.evaluate(() => { const i = document.querySelector('.chovq'); i.focus(); }); await pg.keyboard.type('mannequin pose walking'); await pg.keyboard.press('Enter');
  await until(() => document.querySelectorAll('.chgrid .chtile.ov').length > 0);
  const ovTiles = await pg.evaluate(() => [...document.querySelectorAll('.chgrid .chtile.ov')].map(t => t.querySelector('.chlic')?.textContent));
  await click('.chgrid [data-ov="aaaa1111-0000-4000-8000-000000000001"]');
  await until(() => window.WB.characters.ws.draft().refs.some(r => r.source === 'openverse'));
  await shot('v7_base_openverse');
  const ovRef = await pg.evaluate(() => window.WB.characters.ws.draft().refs.find(r => r.source === 'openverse'));
  await click('.chsrc [data-src=text]'); await pg.evaluate(() => document.querySelector('.chbtext').focus());
  await pg.keyboard.type('late twenties, tired eyes, short dark hair, a small scar on the chin');
  const csp = await pg.evaluate(async () => { const v = []; const f = (e) => v.push(e.blockedURI); document.addEventListener('securitypolicyviolation', f); let blocked = false; try { await fetch('https://example.org/leak'); } catch (e) { blocked = true; } await new Promise(r => setTimeout(r, 100)); document.removeEventListener('securitypolicyviolation', f); return { blocked, v }; });
  const media = readJ('media.json')?.items || [], ovMedia = media.find(m => m.path === ovRef?.path);
  check('base: a catalogue body (filtered by kind) and an Openverse result (CC0 / public domain by default; the sensitive one hidden) become references; the Openverse image is stored with its licence, creator and URL; the CSP lets the page reach api.openverse.org only',
    catRef?.path === 'catalog/body/athletic_female_turnaround.jpg' && catRef.licence === 'CC0-1.0' && ovTiles.length === 2 && ovTiles.every(x => /CC0|PDM/.test(x))
    && /^refs\/mara\/ov-/.test(ovRef?.path || '') && ovRef.licence === 'CC0 1.0' && ovRef.creator === 'Test Creator' && /commons\.wikimedia/.test(ovRef.url) && fs.existsSync(path.join(ND, ovRef.path))
    && ovMedia?.provenance?.licence === 'CC0 1.0' && !ovMedia.private && csp.blocked && csp.v.some(u => /example\.org/.test(u)) && !outside.some(u => /openverse/.test(u)),
    { catRef, ovTiles, ovRef, provenance: ovMedia?.provenance, csp, outside });

  // 3. "Request identity sheet": the base is saved (page), a DRAFT request with refs, tool and an honest estimate
  await click('.chbf [data-a=reqid]');
  await until(() => (window.WB.store.requests?.items || []).some(r => r.asset?.id === 'mara'));
  const E1 = await fileUntil('entities/characters/mara.json', (j) => j.base?.refs?.length === 2);
  const R1 = (await fileUntil('requests.json', (j) => j.items.some(r => r.asset?.id === 'mara'))).items.find(r => r.asset?.id === 'mara');
  await wait(300); await shot('v7_identity_request');
  check('Request identity sheet: the base is saved by the page (2 refs + the description); a draft request (kind identity-sheet, refs, tool, est_cost $0.12 (NB2 2K, js/prices.js), asset tree identity); nothing approved',
    E1?.base?.via === 'page' && /scar on the chin/.test(E1.base.text) && R1?.status === 'draft' && R1.kind === 'identity-sheet' && R1.est_cost === 0.12 && /nano-banana-2/.test(R1.tool) && R1.refs.length === 2 && R1.asset.tree === 'identity' && R1.asset.from === null && /identity sheet/i.test(R1.prompt),
    { base: E1?.base && { via: E1.base.via, refs: E1.base.refs.length }, req: R1 && { status: R1.status, kind: R1.kind, est: R1.est_cost, tool: R1.tool, refs: R1.refs } });

  // 4. the agent cannot run a draft; the director approves here; the agent runs it (placeholder output) and registers the node
  const early = await agent('character_iteration_add', { id: 'mara', request: R1.id });
  const agentApprove = await agent('request_update', { id: R1.id, status: 'approved', director_approved: true });
  await click(`.chreq[data-r="${R1.id}"] [data-a=reqok]`);
  await fileUntil('requests.json', (j) => j.items.find(r => r.id === R1.id)?.status === 'approved');
  const run = async (rid, out) => { for (const st of ['queued', 'running']) await agent('request_update', { id: rid, status: st }); const d = await agent('request_update', { id: rid, status: 'done', outputs: [out], actual_cost_usd: 0 }); return d; };
  const d1 = await run(R1.id, G('mara_sheet.jpg'));
  const n1 = await agent('character_iteration_add', { id: 'mara', request: R1.id, note: 'verify: placeholder for the identity sheet' });
  await until(() => !!document.querySelector('.chws .chnode[data-node=n01]'));
  check('the agent cannot add a node from a draft nor approve the request (403); the director approves in the page (log via page); the agent runs it (done, $0) and registers n01, the head',
    early.status === 403 && agentApprove.status === 403 && d1.status === 200 && n1.status === 200 && n1.body?.node?.id === 'n01' && n1.body.head === 'n01' && n1.body.node.choice === 'kept'
    && readJ('requests.json').items.find(r => r.id === R1.id).log.some(l => l.status === 'approved' && l.via === 'page'),
    { early: early.status, agentApprove: agentApprove.status, done: d1.status, n1: n1.body });

  // 5. an edit: text + a sketch drawn over n01 + a mask + a pin -> a draft request carrying the sketch PNG, the mask and the pins
  await click('.chws .chnode[data-node=n01]');
  await click('.chnp [data-a=edit]');
  await until(() => !!window.WB.characters.ws.sk?.api);
  await wait(400);
  // draw with the mouse: a stroke around the neck, then (M) a mask over it, then (P) a pin
  const box = await pg.evaluate(() => { const c = document.querySelector('.chsk .sk-cv').getBoundingClientRect(); return { x: c.left, y: c.top, w: c.width, h: c.height }; });
  const api = 'window.WB.characters.ws.sk.api';
  const toScr = async (x, y) => pg.evaluate((a) => { const s = window.WB.characters.ws.sk.api.get(); return window.WB.characters.ws.sk.api.toScreen(s.w * a[0], s.h * a[1]); }, [x, y]);
  let [sx, sy] = await toScr(0.10, 0.24); await pg.mouse.move(sx, sy); await pg.mouse.down();
  for (const [x, y] of [[0.12, 0.25], [0.14, 0.255], [0.16, 0.25]]) { const [px, py] = await toScr(x, y); await pg.mouse.move(px, py, { steps: 4 }); }
  await pg.mouse.up();
  await pg.evaluate(`${api}.setTool('mask')`);
  [sx, sy] = await toScr(0.11, 0.245); await pg.mouse.move(sx, sy); await pg.mouse.down(); { const [px, py] = await toScr(0.155, 0.25); await pg.mouse.move(px, py, { steps: 6 }); } await pg.mouse.up();
  await pg.evaluate(`(() => { const a = ${api}, s = a.get(); a.addPin(s.w * 0.17, s.h * 0.23, 'necklace here, silver, thin'); a.setTool('pen'); })()`);
  await pg.evaluate(() => document.querySelector('.chedtext').focus()); await pg.keyboard.type('add a thin silver necklace (pin 1)');
  await wait(200); await shot('v7_edit_sketch_mask_pins');
  const skState = await pg.evaluate(`(() => { const s = ${api}.get(); return { strokes: s.strokes.length, mask: s.mask.length, pins: s.pins.length, underlay: s.underlay?.src }; })()`);
  await click('.chedside [data-a=reqedit]');
  const R2 = (await fileUntil('requests.json', (j) => j.items.some(r => r.asset?.from === 'n01' && r.asset.kind === 'edit')))?.items.find(r => r.asset?.from === 'n01');
  check('Edit from n01: the sketch tool opens over the image (underlay); a stroke, a mask and a pin; "Request edit" saves the sketch (PNG + mask) and makes a draft request with the text, the pins, the sketch and mask paths (masked inpaint estimate)',
    skState.strokes >= 1 && skState.mask >= 1 && skState.pins === 1 && skState.underlay === G('mara_sheet.jpg') && R2?.status === 'draft' && R2.kind === 'character-edit' && R2.asset.pins?.[0]?.text === 'necklace here, silver, thin'
    && /necklace/.test(R2.asset.text) && R2.asset.png && R2.asset.mask && fs.existsSync(path.join(ND, R2.asset.png)) && fs.existsSync(path.join(ND, R2.asset.mask)) && R2.est_cost === 0.08 && /nano-banana-2/.test(R2.tool) && R2.refs[0] === G('mara_sheet.jpg'),
    { skState, req: R2 && { asset: R2.asset, est: R2.est_cost, tool: R2.tool, refs: R2.refs } });

  // 6. approve -> the agent runs it -> n02 waits; the A/B compare (slider, toggle, side by side); Keep makes it the head
  await click(`.chreq[data-r="${R2.id}"] [data-a=reqok]`); await fileUntil('requests.json', (j) => j.items.find(r => r.id === R2.id)?.status === 'approved');
  await run(R2.id, G('mara_necklace.jpg'));
  const n2 = await agent('character_iteration_add', { id: 'mara', request: R2.id });
  const cg = (await agent('character_get', { id: 'mara' })).body;
  await until(() => !!document.querySelector('.chws .chnode.new[data-node=n02]'));
  await click('.chws .chnode[data-node=n02]');
  await until(() => !!document.querySelector('.chab.slider'));
  await pg.evaluate(() => { const r = document.querySelector('.chabr'); r.value = 42; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await shot('v7_compare_ab', '.chnp');
  const ab = await pg.evaluate(() => ({ pos: getComputedStyle(document.querySelector('.chab')).getPropertyValue('--ab').trim(), imgs: document.querySelectorAll('.chab img').length, keep: !!document.querySelector('.chcmpbar [data-a=keep]') }));
  await click('.chcmpbar [data-ab=side]'); const side = await pg.evaluate(() => document.querySelectorAll('.chside img').length);
  await shot('v7_compare_side', '.chnp');
  await click('.chcmpbar [data-ab=toggle]'); await click('.chab [data-a=abflip]'); const tog = await pg.evaluate(() => document.querySelector('.chab.toggle')?.dataset.show);
  await click('.chcmpbar [data-ab=slider]');
  await click('.chcmpbar [data-a=keep]');
  const E2 = await fileUntil('entities/characters/mara.json', (j) => j.iter?.trees?.identity?.head === 'n02');
  check('the output comes back as n02 (waiting for the director; character_get gives the pins and the sketch / mask files); the compare opens on it: slider (A n01 | B n02), side by side, toggle; Keep makes n02 the head (logged via page)',
    n2.body?.node?.id === 'n02' && n2.body.waiting_for_director === true && n2.body.node.parent === 'n01' && cg.waiting_for_director?.includes('n02') && cg.requests.find(r => r.id === R2.id)?.sketch?.files?.png && cg.requests.find(r => r.id === R2.id).pins[0].n === 1
    && ab.pos === '42%' && ab.imgs === 2 && ab.keep && side === 2 && tog === 'A' && E2?.iter.nodes.find(n => n.id === 'n02').choice === 'kept' && E2.iter.log.some(l => l.act === 'keep' && l.via === 'page'),
    { n2: n2.body?.node && { id: n2.body.node.id, parent: n2.body.node.parent }, ab, side, tog, head: E2?.iter?.trees?.identity });

  // 7. a second edit from n01 (messier hair) kept as a branch, and a third from n02 reverted: the tree as strips
  const editFrom = async (nid, text, out, choice) => {
    await pg.evaluate((id) => window.WB.characters.node(id, 'view'), nid); await wait(150);
    await click('.chnp [data-a=edit]'); await until(() => !!window.WB.characters.ws.sk?.api); await wait(200);
    await pg.evaluate(() => document.querySelector('.chedtext').focus()); await pg.keyboard.type(text);
    const before = reqs().length; await click('.chedside [data-a=reqedit]');
    const R = (await fileUntil('requests.json', (j) => j.items.length > before)).items.at(-1);
    await click(`.chreq[data-r="${R.id}"] [data-a=reqok]`); await fileUntil('requests.json', (j) => j.items.find(r => r.id === R.id)?.status === 'approved');
    await run(R.id, out); const n = (await agent('character_iteration_add', { id: 'mara', request: R.id })).body.node;
    await until((id) => !!document.querySelector(`.chws .chnode.new[data-node=${id}]`), n.id);
    await click(`.chws .chnode[data-node=${n.id}]`); await until(() => !!document.querySelector('.chcmpbar [data-a=keep]'));
    await click(`.chcmpbar [data-a=${choice}]`);
    await fileUntil('entities/characters/mara.json', (j) => !!j.iter.nodes.find(x => x.id === n.id)?.choice);
    return n;
  };
  const n3 = await editFrom('n01', 'messier hair, a few strands over the face', G('mara_hair.jpg'), 'branch');
  const n4 = await editFrom('n02', 'a pin on the lapel', G('mara_hair.jpg'), 'revert');
  await pg.evaluate(() => window.WB.characters.node('n02', 'view')); await wait(300);
  await shot('v7_iteration_tree', '.chreqs');
  const tree = await pg.evaluate(() => ({ strips: [...document.querySelectorAll('.chtree .chstrip')].map(s => [...s.querySelectorAll('.chnode')].map(n => n.dataset.node + (n.classList.contains('head') ? '*' : '') + (n.classList.contains('rev') ? '-' : ''))), forks: [...document.querySelectorAll('.chtree .chfork')].map(f => f.textContent) }));
  const E3 = ent('mara');
  check('keep / branch / revert: n03 (from n01) kept as a branch, n04 (from n02) reverted; the head stays n02; the tree shows one strip per branch (main n01 › n02 › n04, ↳ n01: n03)',
    n3.parent === 'n01' && n4.parent === 'n02' && E3.iter.trees.identity.head === 'n02' && E3.iter.nodes.find(n => n.id === 'n03').choice === 'branch' && E3.iter.nodes.find(n => n.id === 'n04').choice === 'reverted'
    && tree.strips.length === 2 && JSON.stringify(tree.strips[0]) === JSON.stringify(['n01', 'n02*', 'n04-']) && JSON.stringify(tree.strips[1]) === JSON.stringify(['n03']) && tree.forks[1] === '↳ n01',
    { tree, head: E3.iter.trees.identity.head });

  // 8. approve the identity (page only): locked; the agent cannot approve, choose, or add to it
  const agAct = await agent('character_act', { id: 'mara', act: 'approve', tree: 'identity' });
  const agChoose = await agent('character_act', { id: 'mara', act: 'choose', node: 'n03', choice: 'kept' });
  const agUp = await agent('entity_upsert', { kind: 'character', id: 'mara', fields: { iter: { trees: { identity: { approved: 'n03' } } } }, look: { id: p3.body.look_id, status: 'approved' } });
  const agUp2 = await agent('entity_upsert', { kind: 'character', id: 'mara', fields: { iter: { trees: { identity: { approved: 'n03' } } }, role: 'the lead' } });
  await click('.chbar [data-a=approve]');
  const E4 = await fileUntil('entities/characters/mara.json', (j) => !!j.iter?.trees?.identity?.approved);
  await wait(300);
  const locked = await pg.evaluate(() => ({ ok: document.querySelector('.chbar .chok')?.textContent, edit: !!document.querySelector('.chnp [data-a=edit]'), row: document.querySelector('.chrow[data-char=mara] .chst')?.textContent }));
  // a request on the locked identity runs, but its output cannot join the tree
  const RL = (await op('request_create', { kind: 'character-edit', est_cost: 0.04, prompt: 'x', char: { id: 'mara', tree: 'identity', from: 'n02', kind: 'edit', text: 'x' } })).body;
  check('Approve identity (page): n02 approved and locked (no Edit, status "identity approved"); the agent cannot approve or choose (403) nor write the trees or approve a look through entity_upsert (ignored / 403)',
    agAct.status === 403 && agChoose.status === 403 && agUp.status === 403 && agUp2.status === 200 && agUp2.body?.warnings?.some(w => /iter ignored/.test(w)) && E4?.iter.trees.identity.approved === 'n02' && E4.iter.trees.identity.via === 'page'
    && E4.role === 'the lead' && !E4.iter.trees.identity.approved_by?.includes('agent') && /approved/.test(locked.ok || '') && !locked.edit && /identity approved/.test(locked.row || '') && RL?.asset?.tree === 'identity',
    { agAct: agAct.status, agChoose: agChoose.status, agUp: agUp.status, warn: agUp2.body?.warnings, identity: E4?.iter?.trees?.identity, locked });

  // 9. looks: the wardrobe item is a draft look; a look sheet from the approved identity; "+ New look"
  await click('.chtabs [data-tab=looks]'); await wait(200);
  const lk0 = await pg.evaluate(() => [...document.querySelectorAll('.chlooks .chlook[data-look]')].map(l => l.dataset.look));
  await click(`.chlook[data-look="${p3.body.look_id}"]`);
  await click('.chsh [data-a=reqlook]');
  const R5 = (await fileUntil('requests.json', (j) => j.items.some(r => r.asset?.kind === 'look')))?.items.find(r => r.asset?.kind === 'look');
  await click(`.chreq[data-r="${R5.id}"] [data-a=reqok]`); await fileUntil('requests.json', (j) => j.items.find(r => r.id === R5.id)?.status === 'approved');
  await run(R5.id, G('mara_raincoat.jpg')); const n5 = (await agent('character_iteration_add', { id: 'mara', request: R5.id })).body;
  await until(() => !!document.querySelector('.chws .chtree .chnode'));
  await click('.chlook.add'); await wait(150); await pg.keyboard.type('Pier jacket'); await pg.keyboard.press('Enter'); await wait(150); await pg.keyboard.type('denim jacket, grey scarf'); await pg.keyboard.press('Enter');
  await fileUntil('entities/characters/mara.json', (j) => j.looks.some(l => l.id === 'pier-jacket'));
  await click(`.chlook[data-look="${p3.body.look_id}"]`); await wait(300);
  const agLook = await agent('look_create', { id: 'mara', name: 'Morning sweater', garments: ['grey sweater'] });
  await until(() => !!document.querySelector('.chlook[data-look=morning-sweater]'));
  await shot('v7_looks');
  const E5 = ent('mara');
  check('looks: the breakdown wardrobe item is a draft look; "Request look sheet" starts from the approved identity (from n02, refs[0] its image); its node n05 roots the look tree; "+ New look" adds one (page); an agent\'s look is "review"',
    lk0.includes(p3.body.look_id) && R5?.asset.from === 'n02' && R5.asset.tree === `look:${p3.body.look_id}` && R5.refs[0] === E4.iter.nodes.find(n => n.id === 'n02').image && n5?.node?.id === 'n05' && n5.node.from_identity === 'n02' && n5.head === 'n05'
    && E5.looks.find(l => l.id === 'pier-jacket')?.from === 'page' && E5.looks.find(l => l.id === 'pier-jacket').garments.includes('grey scarf') && agLook.body?.status === 'review' && E5.looks.find(l => l.id === 'morning-sweater')?.status === 'review',
    { looks: E5.looks.map(l => [l.id, l.status, l.from]), R5: R5 && R5.asset, n5: n5?.node && { id: n5.node.id, from: n5.node.from_identity } });

  // 10. a private photo base (Theo): upload -> private/refs/, flagged private; the identity node made from it is private;
  // nothing private in the export bundle
  await click('.chrow[data-char=theo]'); await click('.chtabs [data-tab=identity]');
  await click('.chsrc [data-src=photos]');
  const notImg = path.join(DATA, '..', `wb-v7-notimg-${process.pid}.png`); fs.writeFileSync(notImg, 'not an image at all');
  const fi = await pg.$('.chphotos'); await fi.uploadFile(photo); await until(() => window.WB.characters.ws.draft().refs.some(r => r.source === 'photo'));
  const bad = await op('ref_upload', { id: 'theo', kind: 'photo', name: 'x.png', data: Buffer.from('<svg onload=alert(1)>').toString('base64') });
  await shot('v7_base_photos');
  const phRef = await pg.evaluate(() => window.WB.characters.ws.draft().refs.find(r => r.source === 'photo'));
  await click('.chbf [data-a=reqid]');
  const R6 = (await fileUntil('requests.json', (j) => j.items.some(r => r.asset?.id === 'theo')))?.items.find(r => r.asset?.id === 'theo');
  await click(`.chreq[data-r="${R6.id}"] [data-a=reqok]`); await fileUntil('requests.json', (j) => j.items.find(r => r.id === R6.id)?.status === 'approved');
  await run(R6.id, G('theo_sheet.jpg')); const n6 = (await agent('character_iteration_add', { id: 'theo', request: R6.id })).body;
  await wait(800);
  const bundle = await pg.evaluate(() => JSON.stringify(window.WB.exporter.bundleData()));
  const M6 = (readJ('media.json')?.items || []).filter(m => /private\//.test(m.path));
  check('a photo of a person is uploaded into private/refs/theo/ (flagged private; a non-image refused); the identity sheet made from it is private (copied under private/characters/); the export bundle carries no private path',
    /^private\/refs\/theo\//.test(phRef?.path || '') && phRef.private && fs.existsSync(path.join(ND, phRef.path)) && M6.some(m => m.path === phRef.path && m.private) && bad.status === 400
    && n6?.node?.private === true && /^private\/characters\/theo\//.test(n6.node.image) && !/private\//.test(bundle) && !bundle.includes(phRef.path),
    { phRef, bad: bad.status, node: n6?.node && { image: n6.node.image, private: n6.node.private }, bundleHasPrivate: /private\//.test(bundle) });

  // 11. toasts stack instead of drawing over each other
  await pg.evaluate(async () => { const { toast } = await import('/js/store.js'); toast('verify: first toast'); toast('verify: second toast, a little longer'); toast('verify: third'); toast('verify: third'); });
  await wait(100);
  const ts = await pg.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(t => { const b = t.getBoundingClientRect(); return { y: b.top, h: b.height, t: t.textContent }; }));
  await pg.screenshot({ path: path.join(OUT, 'v7_toasts.png'), clip: { x: 300, y: 760, width: 900, height: 140 } });
  const noOverlap = ts.every((a, i) => ts.every((b, j) => i === j || a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5));
  check('toasts stack in one column (no overlap; a repeated message is not drawn twice)', ts.length >= 3 && noOverlap && ts.filter(t => t.t === 'verify: third').length === 1, ts);

  // 12. the stage statuses: characters in progress; the agent tools see it all
  const cgAll = (await agent('character_get', {})).body;
  const ST = readJ('stages.json')?.stages?.find(s => s.id === 'characters');
  check('character_get (no id) lists both characters with their status and the breakdown character not yet an entity; the characters stage is in progress',
    cgAll?.characters?.find(c => c.id === 'mara')?.status === 'looks' && cgAll.characters.find(c => c.id === 'theo')?.status === 'iterating' && cgAll.not_entities_yet?.[0]?.name === 'Bus driver' && ST?.status === 'in_progress',
    { chars: cgAll?.characters?.map(c => [c.id, c.status, c.label]), stage: ST?.status });

  await pg.close();
  for (const f of [photo, notImg]) fs.rmSync(f, { force: true });
  const del = await post('/api/projects/delete', { id: NP });
  check('characters project deleted; no request left the machine (only the mocked Openverse)', del.status === 200 && !fs.existsSync(ND) && !outside.filter(u => !/example\.org/.test(u)).length, { del: del.status, outside });
  return { checks, pass: Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-characters.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module'), os = await import('node:os'), net = await import('node:net'), { spawn } = await import('node:child_process');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v7-'));
  fs.cpSync(path.join(WB, 'data', '_template'), path.join(DATA, '_template'), { recursive: true });
  const port = await new Promise(ok => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: { ...process.env, WORKBENCH_DATA: DATA, WB_PROJECT: '_template', WORKBENCH_CONFIG: path.join(DATA, 'none.json') } });
  srv.stderr.on('data', d => process.stderr.write('server: ' + d));
  let browser, res = { pass: false };
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const BASE = `http://localhost:${port}`;
    const writeHeaders = async (base, project) => { const html = await (await fetch(`${base}/?project=${project}`)).text(); return { 'content-type': 'application/json', origin: base, 'x-wb-token': /<meta name="wb-token" content="([^"]+)">/.exec(html)?.[1] }; };
    const HDR = await writeHeaders(BASE, '_template');
    const post = async (p, body, base = BASE, headers = HDR) => { const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
    res = await verifyCharacters({ browser, BASE, DATA, OUT, post, writeHeaders });
  } catch (e) { console.error('v7 aborted:', e.stack || e); }
  finally { await browser?.close().catch(() => {}); srv.kill(); await wait(300); fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  console.log('v7 (characters stage):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
