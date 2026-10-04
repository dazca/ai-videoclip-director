// v8 of the headless UI suite (tools/verify.mjs): the guided flow, phase 5 (stage 5: scenery, i.e. locations and props on
// the generic asset workspace shared with the characters). Exported so verify.mjs runs it after v7, and runnable alone:
//   node tools/verify-scenery.mjs [outDir]        (a scratch copy of data/_template + its own server; deleted at the end)
// On a new project scripted and broken down through the ops: the scenery list (locations and props, scenes, status);
// a location base from the catalogue + a description -> "Request base plate" -> Approve (page) -> the agent runs it
// (simulated: local placeholder images made with ffmpeg from the CC0 catalogue, nothing paid, no network) ->
// asset_iteration_add -> the tree; an edit (text + pin) kept; approve the base; a variant made in the page from the
// axes (reverse / night / rain) -> its own tree from the approved base, with a branch; a prop with a state variant (lit);
// the per-scene variant picker (the agent's proposal, the director's pick, saved in the entity); the agent's limits;
// the characters stage still works. Screenshots v8_*.png.
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
  if (r.status !== 0 || !fs.existsSync(out)) fs.writeFileSync(out, tinyPng(64, 36, [Math.random() * 255 | 0, 120, 200]));
}

export async function verifyScenery({ browser, BASE, DATA, OUT, post, writeHeaders }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v8 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`); };
  const NP = 'scenery-verify', ND = path.join(DATA, NP);
  if (fs.existsSync(ND)) await post('/api/projects/delete', { id: NP });
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
  pg.on('pageerror', e => console.error('pageerror', e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/Content Security Policy|ERR_FAILED/.test(m.text())) console.error('console', m.text()); });
  // no request leaves the machine: anything outside this server is refused (and listed)
  const outside = [];
  await pg.setRequestInterception(true);
  pg.on('request', (r) => { const u = r.url(); if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue(); outside.push(u); return r.abort(); });
  const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
  const ready = async () => { await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(); };
  const combo = async (mods, key) => { for (const m of mods) await pg.keyboard.down(m); await pg.keyboard.press(key); for (const m of mods.slice().reverse()) await pg.keyboard.up(m); };
  const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ND, f), 'utf8')); } catch (e) { return null; } };
  const fileUntil = async (f, fn, ms = 6000) => { const t0 = Date.now(); let j = null; while (Date.now() - t0 < ms) { j = readJ(f); try { if (j && fn(j)) return j; } catch (e) { /* not yet */ } await wait(100); } return j; };
  const click = async (sel) => { const r = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(10, b.width / 2), y: b.top + b.height / 2 }; }, sel); if (!r) throw new Error('no element ' + sel); await pg.mouse.click(r.x, r.y); await wait(150); };
  const shot = async (name, sel) => { await pg.evaluate(() => Promise.race([new Promise(r => setTimeout(r, 1200)), Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; })))])); await frames(); if (sel) await pg.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), sel); await pg.screenshot({ path: path.join(OUT, `${name}.png`) }); };
  const loc = (id) => readJ(`entities/locations/${id}.json`), prop = (id) => readJ(`entities/props/${id}.json`);
  const ws = 'window.WB.scenery.ws';

  // 1. a project with a script and a breakdown (two locations, two props, a character), made entities by the page
  const cr = await post('/api/projects/new', { id: NP, title: 'Scenery Verify', lyrics: '[Verse 1]\nThe night bus hums along the coast\nYour coat is red against the rain\n\n[Chorus]\nRide, ride, the window glows\n\n[Verse 2]\nAt the pier the old boats creak\n\n[Outro]\nThe bus is gone' });
  const H = await writeHeaders(BASE, NP), op = (name, body) => post(`/api/op/${name}?project=${NP}`, body, BASE, H);
  const { origin: _o, ...HA } = H, agent = (name, body) => post(`/api/op/${name}?project=${NP}`, body, BASE, HA);   // the agent surface: no page Origin
  const sg = (await op('song_get', { words: false })).body, sec = (id) => sg.sections.find(s => s.id === id);
  await op('scenes_update', { scenes: [
    { t0: 0, t1: sec('chorus').t0, title: 'The night bus', text: 'Mara rides the night bus along the coast road.', beats: [] },
    { t0: sec('chorus').t0, t1: sec('verse-2').t0, title: 'Chorus ride', text: 'Neon flicker. Mara at the window.', beats: [] },
    { t0: sec('verse-2').t0, t1: sec('outro').t0, title: 'The pier', text: 'Theo waits at the pier at night in the rain, a lit lantern at his feet; he hands Mara a letter.', beats: [] },
    { t0: sec('outro').t0, t1: sg.duration_ms, title: 'Morning', text: 'The pier at dawn, empty. The lantern lies broken.', beats: [] },
  ], message: 'verify: four scenes' });
  await agent('breakdown_update', { items: [
    { kind: 'location', name: 'The pier', description: 'an old wooden pier, fishing boats, harbour lights', links: ['sc03', 'sc04'] },
    { kind: 'location', name: 'Night bus', description: 'the inside of a coach at night', links: ['sc01', 'sc02'] },
    { kind: 'prop', name: 'Lantern', description: 'an old storm lantern', links: ['sc03', 'sc04'] },
    { kind: 'prop', name: 'Letter', description: 'a folded letter, wax seal', links: ['sc03'] },
    { kind: 'character', name: 'Mara', links: ['sc01', 'sc02', 'sc03', 'sc04'] },
    { kind: 'location', name: 'Lighthouse', links: ['sc04'] },
  ], message: 'verify: breakdown' });
  const pr = {}; for (const id of ['bi01', 'bi02', 'bi03', 'bi04', 'bi05']) pr[id] = (await op('breakdown_promote', { item: id })).body;
  // the "generations": placeholders on disk (what an agent would download from the provider)
  const G = (f) => `media/gen/${f}`;
  placeholder(path.join(ND, G('pier_plate.jpg')), 'location/lakeside.jpg');
  placeholder(path.join(ND, G('pier_boats.jpg')), 'location/lakeside.jpg', 'drawbox=x=iw*0.62:y=ih*0.55:w=iw*0.18:h=ih*0.08:color=0x5a3a22@1:t=fill');
  placeholder(path.join(ND, G('pier_night_rain.jpg')), 'location/lakeside.jpg', 'eq=brightness=-0.32:saturation=0.6,colorbalance=bs=0.35:bm=0.2,noise=alls=28:allf=t');
  placeholder(path.join(ND, G('pier_night_neon.jpg')), 'location/lakeside.jpg', 'eq=brightness=-0.28:saturation=1.2,colorbalance=rs=0.3:bs=0.4,noise=alls=20:allf=t');
  placeholder(path.join(ND, G('pier_dawn.jpg')), 'location/lakeside.jpg', 'eq=brightness=0.06:saturation=0.8,colorbalance=rs=0.25:gs=0.1');
  placeholder(path.join(ND, G('lantern_sheet.jpg')), 'prop/lantern_01.jpg');
  placeholder(path.join(ND, G('lantern_lit.jpg')), 'prop/lantern_01.jpg', 'eq=brightness=0.12:saturation=1.5,colorbalance=rs=0.35:gs=0.15:bs=-0.2');
  const run = async (rid, out) => { for (const st of ['queued', 'running']) await agent('request_update', { id: rid, status: st }); return agent('request_update', { id: rid, status: 'done', outputs: [out], actual_cost_usd: 0 }); };
  const reqs = () => readJ('requests.json')?.items || [];
  const approveReq = async (rid) => { await click(`.chreq[data-r="${rid}"] [data-a=reqok]`); return fileUntil('requests.json', (j) => j.items.find(r => r.id === rid)?.status === 'approved'); };

  await pg.goto(`${BASE}/?project=${NP}`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
  await combo(['Alt', 'Shift'], 'Digit5'); await wait(600);
  const list = await pg.evaluate(() => ({ stage: window.WB.stages.current(), heads: [...document.querySelectorAll('.chws .chlh b')].map(b => b.textContent), rows: [...document.querySelectorAll('.chws .chrow')].map(r => ({ ent: r.dataset.ent || null, ghost: r.classList.contains('ghost'), name: r.querySelector('.chnm')?.textContent, st: r.querySelector('.chst')?.textContent, scenes: r.querySelectorAll('.chsc .bdsc').length })), tabs: [...document.querySelectorAll('.chtabs [data-tab]')].map(t => t.dataset.tab) }));
  await shot('v8_scenery_list');
  check('the scenery stage (Alt+Shift+5) lists the breakdown locations and props in two groups with their scenes and status; a location not yet an entity shows as such; tabs Base / Variants / Scenes / Notes',
    cr.status === 200 && pr.bi01?.entity_id === 'the-pier' && pr.bi03?.entity_id === 'lantern' && list.stage === 'scenery' && JSON.stringify(list.heads) === '["Locations","Props"]'
    && list.rows.length === 5 && list.rows[0].ent === 'the-pier' && list.rows[0].scenes === 2 && /needs a base/.test(list.rows[0].st) && list.rows.some(r => r.ghost && r.name === 'Lighthouse') && list.rows.filter(r => r.ent === 'lantern' || r.ent === 'letter').length === 2
    && JSON.stringify(list.tabs) === '["base","variants","scenes","notes"]',
    { list, pr: Object.values(pr).map(x => x?.entity_id) });

  // 2. the location base: the catalogue opens on locations; a pick + a description; "Request base plate" -> a draft
  await click('.chsrc [data-src=catalog]'); await until(() => document.querySelectorAll('.chgrid .chtile').length > 3);
  const catKind = await pg.evaluate(() => document.querySelector('.chcatkind')?.value);
  await click('.chgrid [data-cat="location-lakeside"]');
  await click('.chsrc [data-src=text]'); await pg.evaluate(() => document.querySelector('.chbtext').focus());
  await pg.keyboard.type('an old wooden pier into a grey harbour, fishing boats, rope, harbour lamps, wet planks');
  await click('.chsrc [data-src=catalog]'); await wait(200);
  await shot('v8_location_base');
  await click('.chbf [data-a=reqid]');
  const R1 = (await fileUntil('requests.json', (j) => j.items.some(r => r.asset?.id === 'the-pier')))?.items.find(r => r.asset?.id === 'the-pier');
  const E1 = await fileUntil('entities/locations/the-pier.json', (j) => j.base?.refs?.length === 1);
  check('location base: the catalogue opens on the location kind; a catalogue plate + a description; "Request base plate" saves the base (page) and makes a draft request (kind location-plate, asset {type location, tree base}, no char link, est $0.08, an establishing-plate prompt)',
    catKind === 'location' && E1?.base?.via === 'page' && E1.base.refs[0].path === 'catalog/location/lakeside.jpg' && /wooden pier/.test(E1.base.text) && R1?.status === 'draft' && R1.kind === 'location-plate'
    && R1.asset.type === 'location' && R1.asset.tree === 'base' && R1.asset.kind === 'base' && !R1.char && R1.est_cost === 0.08 && /Establishing plate/.test(R1.prompt) && R1.target === 'location:the-pier',
    { catKind, base: E1?.base && { via: E1.base.via, refs: E1.base.refs.map(r => r.path) }, req: R1 && { kind: R1.kind, asset: R1.asset, est: R1.est_cost } });

  // 3. approve (page) -> the agent runs it -> n01; an edit with a pin -> n02 kept; approve the base (page)
  const early = await agent('asset_iteration_add', { type: 'location', id: 'the-pier', request: R1.id });
  await approveReq(R1.id); await run(R1.id, G('pier_plate.jpg'));
  const n1 = (await agent('asset_iteration_add', { type: 'location', id: 'the-pier', request: R1.id, note: 'verify: placeholder plate' })).body;
  await until(() => !!document.querySelector('.chws .chnode[data-node=n01]'));
  await click('.chws .chnode[data-node=n01]'); await click('.chnp [data-a=edit]');
  await until(() => !!window.WB.scenery.ws.sk?.api); await wait(300);
  await pg.evaluate(`(() => { const a = ${ws}.sk.api, s = a.get(); a.addPin(s.w * 0.7, s.h * 0.6, 'a moored fishing boat here'); })()`);
  await pg.evaluate(() => document.querySelector('.chedtext').focus()); await pg.keyboard.type('add a small fishing boat by the pier (pin 1)');
  await click('.chedside [data-a=reqedit]');
  const R2 = (await fileUntil('requests.json', (j) => j.items.some(r => r.asset?.from === 'n01' && r.asset.kind === 'edit')))?.items.find(r => r.asset?.from === 'n01');
  await approveReq(R2.id); await run(R2.id, G('pier_boats.jpg'));
  const n2 = (await agent('asset_iteration_add', { type: 'location', id: 'the-pier', request: R2.id })).body;
  await until(() => !!document.querySelector('.chws .chnode.new[data-node=n02]'));
  await click('.chws .chnode[data-node=n02]'); await until(() => !!document.querySelector('.chcmpbar [data-a=keep]'));
  await click('.chcmpbar [data-a=keep]');
  await fileUntil('entities/locations/the-pier.json', (j) => j.iter?.trees?.base?.head === 'n02');
  await wait(300); await click('.chbar [data-a=approve]');
  const E3 = await fileUntil('entities/locations/the-pier.json', (j) => !!j.iter?.trees?.base?.approved);
  check('the base tree: the agent cannot register a draft (403); approved here, run (placeholder), n01 heads the base tree; an edit (text + pin) -> location-edit request -> n02 waits, compared and kept; "Approve base" (page) locks it and sets the establishing image',
    early.status === 403 && n1?.node?.id === 'n01' && n1.node.tree === 'base' && R2?.kind === 'location-edit' && R2.asset.pins?.[0]?.text === 'a moored fishing boat here' && /Keep the architecture/.test(R2.prompt)
    && n2?.node?.parent === 'n01' && E3?.iter.trees.base.approved === 'n02' && E3.iter.trees.base.via === 'page' && E3.establishing === G('pier_boats.jpg') && E3.sheet === G('pier_boats.jpg'),
    { early: early.status, n1: n1?.node?.id, R2: R2 && { kind: R2.kind, pins: R2.asset.pins }, base: E3?.iter?.trees?.base, establishing: E3?.establishing });

  // 4. a variant made in the page from the axes: reverse / night / rain -> its sheet from the approved base -> its tree,
  // an edit on it kept as a branch
  await click('.chtabs [data-tab=variants]'); await wait(150);
  await click('.chlook.add'); await until(() => !!document.querySelector('.asvf'));
  for (const [ax, v] of [['angle', 'reverse'], ['tod', 'night'], ['weather', 'rain']]) await click(`.asax a[data-ax=${ax}][data-v=${v}]`);
  await pg.evaluate(() => document.querySelector('.asvnotes').focus()); await pg.keyboard.type('harbour lamps reflected on the wet planks');
  await shot('v8_variant_form');
  await click('.asvff [data-a=vcreate]');
  const E4 = await fileUntil('entities/locations/the-pier.json', (j) => (j.variants || []).some(v => v.id === 'reverse-night-rain'));
  await until(() => !!document.querySelector('.chsh [data-a=reqlook]'));
  await click('.chsh [data-a=reqlook]');
  const R3 = (await fileUntil('requests.json', (j) => j.items.some(r => r.asset?.kind === 'variant')))?.items.find(r => r.asset?.kind === 'variant');
  await approveReq(R3.id); await run(R3.id, G('pier_night_rain.jpg'));
  const n3 = (await agent('asset_iteration_add', { type: 'location', id: 'the-pier', request: R3.id })).body;
  // a second take of the night (the agent asked for a neon variation as an edit of n03): kept as a branch
  const R4 = (await agent('request_create', { kind: 'location-edit', prompt: 'n03 with neon signs on the harbour office', est_cost: 0.04, refs: [G('pier_night_rain.jpg')], asset: { type: 'location', id: 'the-pier', tree: 'variant:reverse-night-rain', from: n3.node.id, kind: 'edit', text: 'neon signs on the harbour office' } })).body;
  await until((id) => !!document.querySelector(`.chreq[data-r="${id}"] [data-a=reqok]`), R4.id);
  await approveReq(R4.id); await run(R4.id, G('pier_night_neon.jpg'));
  const n4 = (await agent('asset_iteration_add', { type: 'location', id: 'the-pier', request: R4.id })).body;
  await until((id) => !!document.querySelector(`.chws .chnode.new[data-node=${id}]`), n4.node.id);
  await click(`.chws .chnode[data-node=${n4.node.id}]`); await until(() => !!document.querySelector('.chcmpbar [data-a=branch]'));
  await click('.chcmpbar [data-a=branch]');
  await fileUntil('entities/locations/the-pier.json', (j) => j.iter.nodes.find(x => x.id === n4.node.id)?.choice === 'branch');
  await pg.evaluate((id) => window.WB.scenery.node(id, 'view'), n3.node.id); await wait(300);
  await shot('v8_variant_tree_night', '.chlooks');
  const vt = await pg.evaluate(() => ({ cards: [...document.querySelectorAll('.chlooks .chlook[data-look]')].map(c => c.dataset.look), strips: [...document.querySelectorAll('.chtree .chstrip')].map(s => [...s.querySelectorAll('.chnode')].map(n => n.dataset.node)), approve: document.querySelector('.chbar [data-a=approve]')?.textContent }));
  check('variant (page): the axes reverse / night / rain make variant reverse-night-rain (draft, from the page); "Request variant sheet" starts from the approved base (from n02, its image first, kind location-variant); its node roots the variant tree (from_identity n02); a further take kept as a branch; the bar offers "Approve variant"',
    E4?.variants.find(v => v.id === 'reverse-night-rain')?.from === 'page' && E4.variants[0].axes.tod === 'night' && /reflected/.test(E4.variants[0].notes) && R3?.kind === 'location-variant' && R3.asset.from === 'n02' && R3.refs[0] === G('pier_boats.jpg') && /night/.test(R3.prompt)
    && n3?.node?.tree === 'variant:reverse-night-rain' && n3.node.from_identity === 'n02' && n3.head === n3.node.id && vt.cards.includes('reverse-night-rain') && vt.strips.length === 2 && /Approve variant/.test(vt.approve || ''),
    { variant: E4?.variants?.[0], R3: R3 && { kind: R3.kind, from: R3.asset.from, refs: R3.refs }, n3: n3?.node && { id: n3.node.id, from: n3.node.from_identity }, vt });

  // 5. a prop: base from the catalogue -> sheet -> approved; a state variant "lit" made in the page -> its tree
  await click('.chrow[data-ent=lantern]'); await click('.chtabs [data-tab=base]');
  await click('.chsrc [data-src=catalog]'); await until(() => document.querySelectorAll('.chgrid .chtile').length > 3);
  const pKind = await pg.evaluate(() => document.querySelector('.chcatkind')?.value);
  await click('.chgrid [data-cat="prop-lantern_01"]');
  await click('.chbf [data-a=reqid]');
  const R5 = (await fileUntil('requests.json', (j) => j.items.some(r => r.asset?.id === 'lantern')))?.items.find(r => r.asset?.id === 'lantern');
  await approveReq(R5.id); await run(R5.id, G('lantern_sheet.jpg'));
  const n5 = (await agent('asset_iteration_add', { type: 'prop', id: 'lantern', request: R5.id })).body;
  await until(() => !!document.querySelector('.chws .chnode[data-node=n01]'));
  await click('.chbar [data-a=approve]'); await fileUntil('entities/props/lantern.json', (j) => !!j.iter?.trees?.base?.approved);
  await click('.chtabs [data-tab=variants]'); await click('.chlook.add'); await until(() => !!document.querySelector('.asvf'));
  const propAxes = await pg.evaluate(() => [...document.querySelectorAll('.asvf .asaxl')].map(x => x.textContent));
  await click('.asax a[data-ax=state][data-v=lit]'); await click('.asvff [data-a=vcreate]');
  await fileUntil('entities/props/lantern.json', (j) => (j.variants || []).some(v => v.id === 'lit'));
  await until(() => !!document.querySelector('.chsh [data-a=reqlook]')); await click('.chsh [data-a=reqlook]');
  const R6 = (await fileUntil('requests.json', (j) => j.items.some(r => r.asset?.id === 'lantern' && r.asset.kind === 'variant')))?.items.find(r => r.asset?.id === 'lantern' && r.asset.kind === 'variant');
  await approveReq(R6.id); await run(R6.id, G('lantern_lit.jpg'));
  const n6 = (await agent('asset_iteration_add', { type: 'prop', id: 'lantern', request: R6.id })).body;
  const agBroken = (await agent('variant_create', { type: 'prop', id: 'lantern', axes: { state: 'broken' }, scenes: ['sc04'], description: 'glass cracked, the frame bent' })).body;
  await until(() => !!document.querySelector('.chlook[data-look=broken]'));
  await click('.chlook[data-look=lit]'); await wait(300);
  await shot('v8_prop_state_variant');
  const P6 = prop('lantern');
  check('a prop: the catalogue opens on props; a prop sheet (kind prop-sheet, from the catalogue lantern) -> n01 -> base approved; the variant form offers angle and state; "lit" -> variant lit -> prop-variant from the approved base -> its tree; the agent proposes "broken" for sc04 (review)',
    pKind === 'prop' && R5?.kind === 'prop-sheet' && /Prop sheet/.test(R5.prompt) && n5?.node?.tree === 'base' && P6?.iter.trees.base.approved === 'n01' && P6.hero === G('lantern_sheet.jpg') && JSON.stringify(propAxes) === '["angle","state"]'
    && R6?.kind === 'prop-variant' && R6.asset.tree === 'variant:lit' && /state: lit/.test(R6.prompt) && n6?.node?.tree === 'variant:lit' && agBroken?.variant === 'broken' && agBroken.status === 'review' && P6.variants.find(v => v.id === 'broken')?.scenes?.[0] === 'sc04',
    { pKind, R5: R5?.kind, propAxes, R6: R6 && { kind: R6.kind, tree: R6.asset.tree }, n6: n6?.node?.tree, agBroken });

  // 6. the per-scene variant picker: the pier's scenes (from the breakdown links); the agent proposes a dawn variant for
  // sc04; the director picks the night variant for sc03 (page); the file records it; the lantern's scenes too
  const dawn = (await agent('variant_create', { type: 'location', id: 'the-pier', axes: { angle: 'wide', tod: 'dawn' }, scenes: ['sc04'] })).body;
  await click('.chrow[data-ent=the-pier]'); await click('.chtabs [data-tab=scenes]');
  await until(() => document.querySelectorAll('.asuse[data-scene]').length === 2);
  const before = await pg.evaluate(() => [...document.querySelectorAll('.asuse[data-scene]')].map(r => ({ s: r.dataset.scene, v: r.querySelector('select').value, who: r.querySelector('.who, .dim:not(.asut)')?.textContent })));
  await pg.select('.asusesel[data-scene=sc03]', 'reverse-night-rain');
  const E6 = await fileUntil('entities/locations/the-pier.json', (j) => j.uses?.sc03?.variant === 'reverse-night-rain');
  await pg.select('.asuseadd', 'sc02');
  const E6b = await fileUntil('entities/locations/the-pier.json', (j) => 'sc02' in (j.uses || {}));
  await until(() => document.querySelectorAll('.asuse[data-scene]').length === 3);
  await wait(300); await shot('v8_scene_variant_picker');
  const after = await pg.evaluate(() => [...document.querySelectorAll('.asuse[data-scene]')].map(r => ({ s: r.dataset.scene, v: r.querySelector('select').value, who: r.querySelector('.who')?.textContent || null, img: !!r.querySelector('.asuth img') })));
  const ag = (await agent('asset_get', { type: 'location', id: 'the-pier' })).body;
  const agUse = await agent('asset_act', { type: 'location', id: 'the-pier', act: 'use', scene: 'sc03', variant: null });
  check('the scene picker: the pier\'s scenes come from the breakdown links (sc03, sc04); sc04 shows the agent\'s dawn proposal; the director picks the night variant for sc03 (saved in uses, via page) and adds sc02 on the base; asset_get gives the storyboard each scene\'s variant and image; the agent cannot pick (403)',
    dawn?.variant === 'wide-dawn' && before.length === 2 && before.find(r => r.s === 'sc04')?.v === 'wide-dawn' && E6?.uses.sc03.via === 'page' && E6b?.uses.sc02?.variant === null
    && after.find(r => r.s === 'sc03')?.v === 'reverse-night-rain' && after.find(r => r.s === 'sc03').who === 'you' && after.find(r => r.s === 'sc03').img && after.find(r => r.s === 'sc04')?.who === 'agent'
    && ag.scenes.find(s => s.scene === 'sc03')?.variant === 'reverse-night-rain' && ag.scenes.find(s => s.scene === 'sc03').image === G('pier_night_rain.jpg') && ag.scenes.find(s => s.scene === 'sc02')?.variant === null && agUse.status === 403,
    { before, after, uses: E6b?.uses, agUse: agUse.status });

  // 7. the stage rail: scenery in progress; the characters stage still works on the same code path
  const rail = await pg.evaluate(() => document.querySelector('#rail [data-stage=scenery]')?.className);
  await combo(['Alt', 'Shift'], 'Digit4'); await wait(500);
  const chars = await pg.evaluate(() => ({ stage: window.WB.stages.current(), rows: [...document.querySelectorAll('.sghost[data-stage=characters] .chrow')].map(r => r.dataset.char || null), tabs: [...document.querySelectorAll('.sghost[data-stage=characters] .chtabs [data-tab]')].map(t => t.dataset.tab), base: !!document.querySelector('.sghost[data-stage=characters] .chbf [data-a=reqid]'), label: document.querySelector('.sghost[data-stage=characters] .chbf [data-a=reqid]')?.textContent }));
  await shot('v8_characters_still');
  const ST = readJ('stages.json')?.stages?.find(s => s.id === 'scenery');
  check('the scenery stage is in progress (rail); the characters stage still opens on the shared workspace (Mara, Identity / Looks / Scenes / Notes, "Request identity sheet"); no request left the machine',
    /st-in_progress/.test(rail || '') && ST?.status === 'in_progress' && chars.stage === 'characters' && chars.rows.includes('mara') && JSON.stringify(chars.tabs) === '["identity","looks","scenes","notes"]' && /Request identity sheet/.test(chars.label || '') && !outside.length,
    { rail, stage: ST?.status, chars, outside });

  await pg.close();
  const del = await post('/api/projects/delete', { id: NP });
  check('scenery project deleted', del.status === 200 && !fs.existsSync(ND), { del: del.status });
  return { checks, pass: Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-scenery.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module'), os = await import('node:os'), net = await import('node:net'), { spawn } = await import('node:child_process');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v8-'));
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
    res = await verifyScenery({ browser, BASE, DATA, OUT, post, writeHeaders });
  } catch (e) { console.error('v8 aborted:', e.stack || e); }
  finally { await browser?.close().catch(() => {}); srv.kill(); await wait(300); fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  console.log('v8 (scenery stage):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
