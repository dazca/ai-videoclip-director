// v9 of the headless UI suite (tools/verify.mjs): the guided flow, phase 6 (stage 6: the storyboard and the gaps).
// Exported so verify.mjs runs it after v8, and runnable alone:
//   node tools/verify-storyboard.mjs [outDir]     (a scratch copy of data/_template + its own server; deleted at the end)
// On a new project scripted (scenes with beats), broken down and with one location base approved through the pipeline
// (a simulated run: a local placeholder image, nothing paid, no network): the empty board; "Shots from beats" (tiled
// scenes, cuts on the beat grid, the breakdown's assets limited to the beats they name); edits (text, camera, kind, still /
// video), split / merge / move keep the tiling; a frame sketch drawn inline over the location (saved as a new version);
// copy / paste a frame to another shot; a per-shot variant override; the Gaps panel (every group, the estimate against the
// cap, a jump link to the asset); "Fill the gaps" and "Ask the agent to storyboard" asks; the agent's side (gaps_get
// proposals, a draft request on a shot, shots_update arriving live, no approval: 403) and the director approving a shot;
// the timeline shots column showing the storyboard with frame thumbnails, aligned. Screenshots v9_*.png.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tinyPng } from './tiny-png.mjs';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function placeholder(out, src, vf) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(WB, 'catalog', src), '-vf', `scale=768:-2${vf ? ',' + vf : ''}`, '-frames:v', '1', out]);
  if (r.status !== 0 || !fs.existsSync(out)) fs.writeFileSync(out, tinyPng(64, 36, [40, 90, 140]));
}
const tiled = (shots, scenes) => scenes.every(sc => { const g = shots.filter(s => s.scene === sc.id).sort((a, b) => a.t0 - b.t0); return !g.length || (g[0].t0 === sc.t0 && g[g.length - 1].t1 === sc.t1 && g.every((s, i) => s.t1 > s.t0 && (i === 0 || g[i - 1].t1 === s.t0))); });

export async function verifyStoryboard({ browser, BASE, DATA, OUT, post, writeHeaders }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v9 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`); };
  const NP = 'board-verify', ND = path.join(DATA, NP);
  if (fs.existsSync(ND)) await post('/api/projects/delete', { id: NP });
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
  pg.on('pageerror', e => console.error('pageerror', e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/Content Security Policy|ERR_FAILED/.test(m.text())) console.error('console', m.text()); });
  const outside = [];
  await pg.setRequestInterception(true);
  pg.on('request', (r) => { const u = r.url(); if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue(); outside.push(u); return r.abort(); });
  const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
  const ready = async () => { await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(); };
  const combo = async (mods, key) => { for (const m of mods) await pg.keyboard.down(m); await pg.keyboard.press(key); for (const m of mods.slice().reverse()) await pg.keyboard.up(m); };
  const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ND, f), 'utf8')); } catch (e) { return null; } };
  const fileUntil = async (f, fn, ms = 6000) => { const t0 = Date.now(); let j = null; while (Date.now() - t0 < ms) { j = readJ(f); try { if (j && fn(j)) return j; } catch (e) { /* not yet */ } await wait(100); } return j; };
  const click = async (sel) => { const r = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(10, b.width / 2), y: b.top + b.height / 2 }; }, sel); if (!r) throw new Error('no element ' + sel); await pg.mouse.click(r.x, r.y); await wait(150); };
  const shot = async (name) => { await pg.evaluate(() => Promise.race([new Promise(r => setTimeout(r, 1200)), Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; })))])); await frames(); await pg.screenshot({ path: path.join(OUT, `${name}.png`) }); };
  const ws = 'window.WB.storyboard.ws';
  const W = (fn) => pg.evaluate(`(${fn})(${ws})`);

  // 1. a project: four scenes with beats, a breakdown made entities, the pier's base approved (pipeline), a cost cap
  const cr = await post('/api/projects/new', { id: NP, title: 'Board Verify', lyrics: '[Verse 1]\nThe night bus hums along the coast\nYour coat is red against the rain\n\n[Chorus]\nRide, ride, the window glows\n\n[Verse 2]\nAt the pier the old boats creak\n\n[Outro]\nThe bus is gone' });
  const H = await writeHeaders(BASE, NP), op = (name, body) => post(`/api/op/${name}?project=${NP}`, body, BASE, H);
  const { origin: _o, ...HA } = H, agent = (name, body) => post(`/api/op/${name}?project=${NP}`, body, BASE, HA);
  const sg = (await op('song_get', { words: false, grid: true })).body, sec = (id) => sg.sections.find(s => s.id === id), dur = sg.duration_ms, beats = sg.grid.beats;
  const c0 = sec('chorus').t0, v2 = sec('verse-2').t0, ou = sec('outro').t0;
  await op('scenes_update', { scenes: [
    { t0: 0, t1: c0, title: 'The night bus', text: 'Mara rides the night bus along the coast road.', beats: [{ t: 300, text: 'Mara boards the night bus' }, { t: Math.round(c0 * 0.45), text: 'Close on her face at the window' }, { t: Math.round(c0 * 0.8), text: 'Her hands hold a folded letter' }] },
    { t0: c0, t1: v2, title: 'Chorus ride', text: 'Neon flicker. Mara sings at the window.', beats: [{ t: c0 + 200, text: 'Mara sings with the neon' }] },
    { t0: v2, t1: ou, title: 'The pier', text: 'Theo waits at the pier at night, a lit lantern at his feet; he hands Mara a letter.', beats: [{ t: v2 + 100, text: 'Theo waits at the pier at night' }, { t: v2 + Math.round((ou - v2) * 0.4), text: 'a lit lantern at his feet' }, { t: v2 + Math.round((ou - v2) * 0.75), text: 'he hands Mara the letter' }] },
    { t0: ou, t1: dur, title: 'Morning', text: 'The pier at dawn, empty.', beats: [] },
  ], message: 'verify: four scenes with beats' });
  await agent('breakdown_update', { items: [
    { kind: 'location', name: 'The pier', description: 'an old wooden pier', links: ['sc03', 'sc04'] },
    { kind: 'character', name: 'Mara', links: ['sc01', 'sc02', { scene: 'sc03', beats: ['b3'] }] },
    { kind: 'prop', name: 'Lantern', links: [{ scene: 'sc03', beats: ['b2'] }] },
    { kind: 'location', name: 'Night bus', links: ['sc01', 'sc02'] },
  ], message: 'verify: breakdown' });
  for (const id of ['bi01', 'bi02', 'bi03', 'bi04']) await op('breakdown_promote', { item: id });
  const G = (f) => `media/gen/${f}`;
  placeholder(path.join(ND, G('pier_plate.jpg')), 'location/lakeside.jpg');
  await op('asset_act', { type: 'location', id: 'the-pier', act: 'base', base: { text: 'an old wooden pier', refs: [{ path: 'catalog/location/lakeside.jpg', source: 'catalog' }] } });
  const R0 = (await agent('request_create', { kind: 'location-plate', prompt: 'the pier', est_cost: 0.08, refs: ['catalog/location/lakeside.jpg'], asset: { type: 'location', id: 'the-pier', tree: 'base', kind: 'base' } })).body;
  const rq = readJ('requests.json'); rq.items.find(r => r.id === R0.id).status = 'approved'; await post(`/api/save/requests.json?project=${NP}`, { base_rev: rq.rev, data: rq }, BASE, H);
  for (const st of ['queued', 'running']) await agent('request_update', { id: R0.id, status: st });
  await agent('request_update', { id: R0.id, status: 'done', outputs: [G('pier_plate.jpg')], actual_cost_usd: 0 });
  await agent('asset_iteration_add', { type: 'location', id: 'the-pier', request: R0.id });
  const apB = await op('asset_act', { type: 'location', id: 'the-pier', act: 'approve', tree: 'base' });
  const night = (await agent('variant_create', { type: 'location', id: 'the-pier', axes: { tod: 'night' }, description: 'harbour lamps' })).body;
  const costs = readJ('costs.json'); fs.writeFileSync(path.join(ND, 'costs.json'), JSON.stringify({ ...costs, cap_usd: 5 }, null, 1));

  await pg.goto(`${BASE}/?project=${NP}`, { waitUntil: 'domcontentloaded' });
  await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
  await combo(['Alt', 'Shift'], 'Digit6'); await wait(700);
  const empty = await pg.evaluate(() => ({ stage: window.WB.stages.current(), scenes: [...document.querySelectorAll('.sbscene[data-scene]')].map(e => e.dataset.scene), empties: document.querySelectorAll('.sbempty').length, bar: document.querySelector('.sbbar')?.textContent, rail: document.querySelector('#rail [data-stage=storyboard]')?.title }));
  await W((s) => s.setSide('gaps')); await wait(200);
  await shot('v9_board_empty');
  check('the storyboard stage (Alt+Shift+6) lists the script\'s four scenes in song time, each "no shots yet"; the bar counts 0/4 boarded; the rail names the scenes without shots',
    cr.status === 200 && apB.status === 200 && night?.variant === 'night' && empty.stage === 'storyboard' && JSON.stringify(empty.scenes) === '["sc01","sc02","sc03","sc04"]' && empty.empties === 4 && /0\/4 scenes boarded/.test(empty.bar || '') && /4 scenes without shots/.test(empty.rail || ''),
    { empty, apB: apB.status });

  // 2. "Shots from beats": every scene tiled, cuts on the beat grid, assets limited to the beats a link names; saved (Ctrl+Enter)
  await click('.sbbar [data-a=beats]'); await wait(300);
  const d1 = await W((s) => ({ shots: s.draft.map(x => ({ id: x.id, scene: x.scene, t0: x.t0, t1: x.t1, kind: x.kind, cast: x.cast, locations: x.locations, props: x.props, beats: x.beats, gen: x.gen, text: x.text })), scenes: s.scenes.map(x => ({ id: x.id, t0: x.t0, t1: x.t1 })), dirty: s.dirty }));
  const inner = d1.shots.filter(x => d1.scenes.some(sc => sc.id === x.scene && x.t0 !== sc.t0)).map(x => x.t0);
  const sc3 = d1.shots.filter(x => x.scene === 'sc03');
  await W((s) => s.select(s.draft.find(x => x.scene === 'sc03').id, { seek: false })); await wait(200);
  await shot('v9_shots_from_beats');
  await combo(['Control'], 'Enter');
  const B1 = await fileUntil('storyboard.json', (j) => j.versions?.length >= 1 && j.versions.at(-1).via === 'page');
  check('"Shots from beats": every scene tiled (the first shot starts with the scene, the last ends with it); every cut on a beat of the grid; sc03 one shot per beat with the lantern only in the b2 shot and Mara only in the b3 shot; the long beatless sc04 cut on bars; a performance shot for "sings"; saved by Ctrl+Enter as a version (via page)',
    tiled(d1.shots, d1.scenes) && inner.length > 0 && inner.every(t => beats.includes(t)) && sc3.length === 3 && sc3.filter(x => x.props.includes('lantern')).length === 1 && sc3.find(x => x.props.includes('lantern'))?.beats.includes('b2')
    && sc3.filter(x => x.cast.includes('mara')).length === 1 && sc3.find(x => x.cast.includes('mara'))?.beats.includes('b3') && sc3.every(x => x.locations.includes('the-pier')) && d1.shots.filter(x => x.scene === 'sc04').length >= 2
    && d1.shots.some(x => x.scene === 'sc02' && x.kind === 'performance') && B1?.versions.at(-1).shots.length === d1.shots.length && B1.versions.at(-1).by === 'director',
    { n: d1.shots.length, per: d1.scenes.map(sc => [sc.id, d1.shots.filter(x => x.scene === sc.id).length]), inner, sc3: sc3.map(x => ({ id: x.id, beats: x.beats, cast: x.cast, props: x.props })), saved: B1?.current });

  // 3. edits: text, camera, kind, video; split at a beat, merge back, move: the tiling holds
  const first3 = sc3[0].id;
  await W((s) => s.select(s.draft.find(x => x.scene === 'sc03').id, { seek: false })); await wait(150);
  await pg.evaluate(() => { const t = document.querySelector('.sbins .sbin-text'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }); await pg.keyboard.type(' Wide on the empty pier, lamps on the water.');
  await pg.evaluate(() => document.querySelector('.sbins .sbin-cam').focus()); await pg.keyboard.type('slow push in from the water');
  await pg.evaluate(() => document.activeElement.blur()); await wait(100);
  await click('.sbins [data-kind=wide]'); await click('.sbins [data-gen=still]');
  const nBefore = await W((s) => s.draft.length);
  await click('.sbins [data-a=split]');
  const afterSplit = await W((s) => ({ n: s.draft.length, sel: s.sel, ok: s.scenes.every(sc => { const g = s.inScene(sc.id); return !g.length || (g[0].t0 === sc.t0 && g.at(-1).t1 === sc.t1 && g.every((x, i) => !i || g[i - 1].t1 === x.t0)); }) }));
  await W((s) => s.select(s.inScene('sc03')[0].id, { seek: false })); await click('.sbins [data-a=merge]');
  const afterMerge = await W((s) => ({ n: s.draft.length, sh: s.shot(s.inScene('sc03')[0].id) }));
  const order0 = await W((s) => s.inScene('sc01').map(x => [x.id, x.t1 - x.t0]));
  await W((s) => s.select(s.inScene('sc01')[1].id, { seek: false })); await click('.sbins [data-a=mvl]');
  const order1 = await W((s) => s.inScene('sc01').map(x => [x.id, x.t1 - x.t0]));
  await combo(['Control'], 'Enter');
  const B2 = await fileUntil('storyboard.json', (j) => j.versions.length >= 2);
  const s3 = B2?.versions.at(-1).shots.find(x => x.id === first3);
  check('editing a shot: text and camera typed, kind "wide", gen still; "Split at beat" adds a shot and keeps the scene tiled; "Merge with next" folds it back; "◂ Move" swaps two shots keeping their lengths; saved as the next version',
    afterSplit.n === nBefore + 1 && afterSplit.ok && afterMerge.n === nBefore && afterMerge.sh?.t1 === sc3[0].t1 && order1[0][0] === order0[1][0] && order1[0][1] === order0[1][1] && order1[1][1] === order0[0][1]
    && /lamps on the water/.test(s3?.text || '') && s3?.camera === 'slow push in from the water' && s3.kind === 'wide' && s3.gen === 'still' && B2.versions.at(-1).via === 'page',
    { nBefore, afterSplit, afterMerge: afterMerge.n, order0, order1, s3: s3 && { kind: s3.kind, gen: s3.gen, camera: s3.camera } });

  // 4. a frame sketch drawn inline over the location (a new version: the draft was clean), then copy / paste to the next shot
  await W((s) => s.select(s.inScene('sc03')[0].id, { seek: false }));
  await click('.sbins [data-a=draw]');
  await until(() => !!window.WB.storyboard.ws.sk?.api); await wait(400);
  const ul = await pg.evaluate(() => window.WB.storyboard.ws.sk.api.get().underlay?.src);
  const box = await pg.evaluate(() => { const c = document.querySelector('.sbskhost .sk-cv'); c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await pg.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.7); await pg.mouse.down();
  for (let i = 1; i <= 12; i++) await pg.mouse.move(box.x + box.w * (0.2 + i * 0.05), box.y + box.h * (0.7 - Math.sin(i / 4) * 0.25), { steps: 2 });
  await pg.mouse.up();
  await pg.evaluate(() => window.WB.storyboard.ws.sk.api.addPin(900, 420, 'Theo, small, at the end of the pier'));
  await wait(200); await shot('v9_shot_sketch');
  const skId = await pg.evaluate(() => window.WB.storyboard.ws.sk.id);
  await pg.evaluate(() => window.WB.storyboard.ws.sk.api.save());
  const B3 = await fileUntil('storyboard.json', (j) => j.versions.at(-1).shots.some(x => x.sketch === skId));
  const med = await (async () => { for (let i = 0; i < 30; i++) { const m = (readJ('media.json')?.items || []).find(x => x.id === `sketch-${skId}`); if (m) return m; await wait(100); } return null; })();
  await click('.sbskhost [data-a=skclose]'); await wait(200);
  await click('.sbins [data-a=skcopy]'); await wait(300);
  const target = await W((s) => s.inScene('sc03')[1].id);
  await W((s) => s.select(s.inScene('sc03')[1].id, { seek: false })); await wait(150);
  await click('.sbins [data-a=skpaste]');
  const B4 = await fileUntil('storyboard.json', (j) => !!j.versions.at(-1).shots.find(x => x.id === target)?.sketch);
  const pasted = B4?.versions.at(-1).shots.find(x => x.id === target)?.sketch, pj = pasted ? readJ(`sketches/${pasted}.json`) : null;
  check('a frame drawn inline (over the approved location, faint) and saved: sketches/<id>.png + json, media kind sketch linked to the shot and its scene; the shot holds it in a new version; copied and pasted into the next shot (its own sketch id, the same strokes and pin)',
    ul === G('pier_plate.jpg') && fs.existsSync(path.join(ND, `sketches/${skId}.png`)) && med?.kind === 'sketch' && med.shots?.includes(first3) && med.scenes?.includes('sc03') && B3?.versions.at(-1).via === 'page'
    && !!pasted && pasted !== skId && pj?.strokes?.length >= 1 && pj.pins?.[0]?.text === 'Theo, small, at the end of the pier' && fs.existsSync(path.join(ND, `sketches/${pasted}.png`)),
    { ul, skId, media: med && [med.shots, med.scenes], pasted, strokes: pj?.strokes?.length });

  // 5. a per-shot variant: the pier at night on the second sc03 shot (not approved yet: an amber chip and a gap)
  await pg.select(`.sbins .sbia[data-eid="the-pier"] .sbin-var`, 'night'); await wait(200);
  const chip = await pg.evaluate((id) => { const c = document.querySelector(`.sbcard[data-shot="${id}"] .sbch.k-location`); return c ? { ok: c.classList.contains('ok'), text: c.textContent } : null; }, target);
  const chip0 = await pg.evaluate((id) => { const c = document.querySelector(`.sbcard[data-shot="${id}"] .sbch.k-location`); return c ? { ok: c.classList.contains('ok'), text: c.textContent } : null; }, first3);
  await combo(['Control'], 'Enter');
  const B5 = await fileUntil('storyboard.json', (j) => j.versions.at(-1).shots.find(x => x.id === target)?.variants?.['the-pier'] === 'night');
  check('a shot overrides the variant: the pier "night" on one shot (saved in variants), an amber chip naming it; the shot next to it keeps the scene\'s (the approved base: a green chip)',
    !!B5 && chip && !chip.ok && /night/.test(chip.text) && chip0?.ok && !/night/.test(chip0.text), { chip, chip0 });

  // 6. the Gaps panel: every group, the estimate against the cap, a jump link to an asset
  await click('.sbside .lytabs [data-side=gaps]'); await wait(250);
  const gp = await pg.evaluate(() => ({ heads: [...document.querySelectorAll('.sbgh')].map(h => h.textContent), rows: [...document.querySelectorAll('.sbgap')].map(r => r.dataset.go), cost: document.querySelector('.sbcl')?.textContent, meter: document.querySelectorAll('.sbmeter i').length, cap: !!document.querySelector('.sbmeter .cap') }));
  await shot('v9_gaps');
  const side = await pg.$('.sbside'); await side.screenshot({ path: path.join(OUT, 'v9_estimate_vs_cap.png') });
  const est = await W((s) => s.gapsNow().estimate);
  check('the Gaps panel: unscripted time, scenes without shots, shots without a frame, assets not approved (Mara with no sheet, the night variant, the bus), shots without a request or clip; the estimate against the cap $5 with a meter',
    gp.heads.length === 5 && gp.rows.some(r => r === 'asset:character:mara:') && gp.rows.some(r => r === 'asset:location:the-pier:night') && gp.rows.some(r => r === 'asset:location:night-bus:') && gp.rows.filter(r => r.startsWith('shot:')).length >= 3
    && /\$5\.00/.test(gp.cost || '') && gp.meter === 4 && gp.cap && est.usd > 0,
    { heads: gp.heads, rows: gp.rows.length, cost: gp.cost, est });
  await click('.sbgap[data-go="asset:character:mara:"]'); await wait(700);
  const jumped = await pg.evaluate(() => ({ stage: window.WB.stages.current(), cur: window.WB.characters?.ws?.cur }));
  await combo(['Alt', 'Shift'], 'Digit6'); await wait(500);
  check('a gap\'s jump link opens the asset in its stage (Mara in the characters stage)', jumped.stage === 'characters' && jumped.cur === 'mara', jumped);

  // 7. the asks: "Fill the gaps" and "Ask the agent to storyboard" write notes for the agent
  await click('.sbbar [data-a=fill]'); await wait(300);
  await click('.sbbar [data-a=askboard]'); await wait(300);
  const N = await fileUntil('storyboard.json', (j) => j.notes?.filter(n => n.to === 'agent').length >= 2);
  const fillN = N?.notes.find(n => n.kind === 'fill_gaps'), boardN = N?.notes.find(n => n.kind === 'storyboard');
  check('"Fill the gaps" writes an ask (kind fill_gaps: the shots, the assets, the estimate) and "Ask the agent to storyboard" another (kind storyboard), both by the director via page',
    !!fillN && fillN.gaps?.shots?.length >= 3 && fillN.gaps.assets.includes('location:the-pier:night') && fillN.gaps.est_usd > 0 && /cap \$5\.00/.test(fillN.text) && fillN.via === 'page' && !!boardN && boardN.via === 'page',
    { fill: fillN && { shots: fillN.gaps?.shots?.length, assets: fillN.gaps?.assets }, board: boardN?.text?.slice(0, 80) });

  // 8. the agent: gaps_get proposals; a draft request on a shot (refs = the approved base image); its shots_update arrives
  // live; it cannot approve a shot (403); the director approves in the page
  const gg = (await agent('gaps_get', {})).body;
  const prop = gg.proposals.find(x => x.scene === 'sc04');
  const rr = (await agent('request_create', { ...prop.requests[0], prompt: prop.requests[0].prompt })).body;
  await until((id) => !!document.querySelector(`.sbcard[data-shot="${id}"] .sbrq.s-draft`), prop.shot);
  const sb4 = (await agent('shots_update', { upsert: [{ id: prop.shot, text: 'Dawn: the empty pier, gulls; the lantern lies broken.', camera: 'locked-off, wide' }], message: 'verify: agent fills sc04' })).body;
  const live = await until((id) => /gulls/.test(document.querySelector(`.sbcard[data-shot="${id}"] .sbtx`)?.textContent || ''), prop.shot);
  const apA = await agent('shots_update', { status: { [prop.shot]: 'approved' } }), rvA = await agent('shots_update', { status: { [prop.shot]: 'review' } });
  await W((s) => s.setSide('shot')); await W((s) => s.select(s.inScene('sc04')[0].id, { seek: false })); await wait(200);
  await click('.sbins [data-st=approved]');
  const AP = await fileUntil('approvals.json', (j) => j.items?.[`shot:${prop.shot}`]?.state === 'approved');
  await shot('v9_agent_request_approved');
  check('the agent: gaps_get proposes a still for a sc04 shot (refs = the approved pier base image, honest est); request_create makes a draft the card shows; its shots_update arrives live in the page; it cannot approve a shot (403), "review" is fine; the director approves the shot in the page (via page)',
    prop?.requests?.[0]?.kind === 'shot-still' && prop.requests[0].refs.includes(G('pier_plate.jpg')) && prop.requests[0].est_cost === 0.12 && rr?.status === 'draft' && rr.target === `shot:${prop.shot}`
    && /^v\d+$/.test(sb4?.version || '') && live && apA.status === 403 && rvA.status === 200 && AP?.items[`shot:${prop.shot}`].via === 'page' && gg.estimate.cap_usd === 5,
    { prop: prop && { shot: prop.shot, refs: prop.requests[0].refs, est: prop.requests[0].est_cost }, sb4, apA: apA.status, rvA: rvA.status });

  // 9. the timeline: the shots column shows the storyboard's shots (frame thumbnails), aligned with every other column
  await pg.evaluate(() => window.WB.app.show('timeline')); await wait(700);
  const cur = readJ('storyboard.json').versions.at(-1).shots.sort((a, b) => a.t0 - b.t0);
  const col = await pg.evaluate(() => [...document.querySelectorAll('.col-shots .shot')].map(e => ({ sel: e.dataset.sel, img: e.querySelector('img')?.getAttribute('src') || null })));
  const al = await pg.evaluate((ts) => window.WB.alignTest(ts), cur.slice(0, 5).map(s => s.t0));
  await pg.evaluate((t) => { const tl = window.WB.timeline; tl.seek(t); tl.scrollToTime(t); tl.drawLanes(); }, cur.find(s => s.scene === 'sc03').t0);
  await shot('v9_timeline_shots');
  const rail = await pg.evaluate(() => document.querySelector('#rail [data-stage=storyboard]')?.className);
  check('the timeline shots column shows the storyboard\'s shots (every one, the frames as thumbnails), aligned with the other columns; the storyboard stage is in progress on the rail; no request left the machine',
    col.length === cur.length && col.every((c, i) => c.sel === `shot:${cur[i].id}`) && col.filter(c => /sketches\//.test(c.img || '')).length === 2 && al.pass && /st-in_progress/.test(rail || '') && !outside.length,
    { col: col.length, cur: cur.length, frames: col.filter(c => c.img).length, align: { pass: al.pass, worst: al.worstPx }, rail, outside });

  await pg.close();
  const del = await post('/api/projects/delete', { id: NP });
  check('storyboard project deleted', del.status === 200 && !fs.existsSync(ND), { del: del.status });
  return { checks, pass: Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-storyboard.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module'), os = await import('node:os'), net = await import('node:net'), { spawn } = await import('node:child_process');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v9-'));
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
    res = await verifyStoryboard({ browser, BASE, DATA, OUT, post, writeHeaders });
  } catch (e) { console.error('v9 aborted:', e.stack || e); }
  finally { await browser?.close().catch(() => {}); srv.kill(); await wait(300); fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  console.log('v9 (storyboard stage):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
