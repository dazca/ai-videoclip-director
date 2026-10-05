// v10 of the headless UI suite (tools/verify.mjs): the frictions of the first real agent session (the "HER new looks"
// dogfood), live in the page. Exported so verify.mjs runs it after the other blocks; runnable alone:
//   node tools/verify-dogfood.mjs [outDir]
// Self-contained: a scratch COPY OF THE CODE (so the stale-server check can change a file without touching the repo), a
// scratch copy of data/demo (Ada: an approved legacy look and registered images, no base, no nodes: the HER case) with a
// falgen folder (spent.json + LEDGER.md fixtures under a scratch media base, named in project.json), its own server on
// a free port; all deleted at the end. Nothing is generated or paid: no request leaves the machine.
// Checks: the agent's base proposal accepted in one click (page only); an existing image proposed as the identity head,
// accepted (origin imported + provenance), the identity approved, a look image proposed + accepted and another
// imported directly ("Import an image…"); request warnings (a look sheet with from null and no approved identity, the
// deprecated char link, unfilled recipe blocks) on the request card; the cost panel with merged sources (no double
// count); the Queue's "+ New request" with "Apply photoreal recipe" (blocks, an edited block, the estimate from
// js/prices.js); the stale-code bar after a code file changes on disk. Screenshots v10_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(process.env.WB_VERIFY_PORT ? Number(process.env.WB_VERIFY_PORT) + ((globalThis.__wbVerifyPortN = (globalThis.__wbVerifyPortN ?? -1) + 1) % 10) : 0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
// the code a server runs from: everything the page and the server load (no data, no node_modules)
const CODE_PARTS = ['serve.mjs', 'app.js', 'app.css', 'index.html', 'dock.html', 'README.md', 'package.json', 'lib', 'generators', 'js', 'tabs', 'core', 'templates', 'catalog', 'exporters/composition-data.mjs'];

export async function verifyDogfood({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v10 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v10-')), CODE = path.join(TMP, 'code'), DATA = path.join(TMP, 'data'), MB = path.join(TMP, 'mb');
  for (const p of CODE_PARTS) if (fs.existsSync(path.join(WB, p))) fs.cpSync(path.join(WB, p), path.join(CODE, p), { recursive: true });
  fs.cpSync(path.join(WB, 'data', 'demo'), path.join(DATA, 'demo'), { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  // falgen: spent.json says $1.50; the ledger itemises C1 (a costs.json item already: counted once), HV1, HV2
  fs.mkdirSync(path.join(MB, 'proj', 'gen'), { recursive: true });
  fs.writeFileSync(path.join(MB, 'proj', 'gen', 'spent.json'), JSON.stringify({ total: 1.5 }));
  fs.writeFileSync(path.join(MB, 'proj', 'LEDGER.md'), '# Spend ledger\n\n| Date | Phase | Tool | Items | Est $ | Running total |\n|---|---|---|---|---|---|\n| 2026-10-04 | song | Suno plan (paid directly) | | ~10 | ~10 |\n| 2026-10-04 | C1 | fal C1 via falgen | | 0.24 | gen total 0.24 |\n| 2026-10-04 | HV1 | fal HV1 via falgen | | 0.24 | gen total 0.48 |\n| 2026-10-04 | HV2 | fal HV2 via falgen | | 0.36 | gen total 0.84 |\n');
  const pj = path.join(DATA, 'demo', 'project.json'); fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, 'utf8')), falgen: 'proj/gen' }));
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const port = await freePort(), BASE = `http://localhost:${port}`, ND = path.join(DATA, 'demo');
  const srv = spawn(process.execPath, [path.join(CODE, 'serve.mjs'), String(port)], { stdio: 'pipe', env: { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_MEDIA_BASE: MB, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: 'demo' } });
  srv.stderr.on('data', d => process.stderr.write('v10 server: ' + d));
  let pg = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=demo`)).text())?.[1];
    // the agent surface: the token, no page Origin (as the MCP server calls it)
    const agent = async (name, body) => { const r = await fetch(`${BASE}/api/op/${name}?project=demo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null), code: r.headers.get('x-wb-code') }; };
    const readJ = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ND, f), 'utf8')); } catch (e) { return null; } };
    const fileUntil = async (f, fn, ms = 6000) => { const t0 = Date.now(); let j = null; while (Date.now() - t0 < ms) { j = readJ(f); try { if (j && fn(j)) return j; } catch (e) { /* not yet */ } await wait(100); } return j; };
    const ada = () => readJ('entities/characters/ada.json');

    // 1. the agent's side (MCP ops): a look, a base proposal, an identity import proposal, a look request, a retro cost
    const lc = await agent('look_create', { id: 'ada', name: 'Night out', garments: ['black satin slip dress'] });
    const bp = await agent('base_propose', { id: 'ada', text: 'Ada, late twenties, the lead: tired eyes, short dark hair, orange hoodie by default', refs: ['media/still/ada_face.jpg', 'media/still/ada_body.jpg'], why: 'her current reference images and the identity text from the brief' });
    const ip1 = await agent('node_import_propose', { id: 'ada', tree: 'identity', media: 'ada_body', why: 'the approved legacy look (Orange gradient): make it the identity head instead of a paid re-generation' });
    const ip2 = await agent('node_import_propose', { id: 'ada', tree: 'look:night-out', media: 'ada_face', why: 'an output made outside the queue (falgen HV1, before a request existed)' });
    const rq = await agent('request_create', { kind: 'look-sheet', char: { id: 'ada', tree: 'look:night-out', kind: 'look' }, refs: ['media/still/ada_body.jpg'], recipe: { wardrobe: 'a black satin slip dress with thin straps', place: 'a narrow bar at night, zinc counter, chalkboard menu', light: 'warm tungsten bulbs above the counter, hard, from the left' } });
    const cr = await agent('cost_record', { usd: 0.24, via: 'falgen', job: 'HV1', note: 'HV1 ran before the request existed' });
    const forged = await agent('asset_act', { type: 'character', id: 'ada', act: 'import_accept', proposal: 'ip01' });
    const forged2 = await agent('asset_act', { type: 'character', id: 'ada', act: 'base_accept' });
    check('agent side: look_create, base_propose, node_import_propose (identity; a look one warns: no approved identity yet), request_create warns (char deprecated, from null without an approved identity, an unfilled recipe block) and stores asset only, cost_record (via falgen); accepting is refused to the agent surface (403)',
      lc.status === 200 && bp.status === 200 && bp.body.base_proposal?.refs?.length === 2 && ip1.body?.proposal?.id === 'ip01' && /no approved identity/.test((ip2.body?.warnings || []).join(' '))
      && rq.status === 200 && rq.body.asset?.tree === 'look:night-out' && !('char' in rq.body) && rq.body.warnings?.some(w => /deprecated/.test(w)) && rq.body.warnings?.some(w => /no approved identity/.test(w)) && rq.body.est_cost === 0.12 && /nano-banana-2/.test(rq.body.tool)
      && cr.body?.recorded === true && forged.status === 403 && forged2.status === 403 && /^[0-9a-f]{12}$/.test(cr.code || ''),
      { lc: lc.status, bp: bp.status, ip2: ip2.body?.warnings, rq: rq.body?.warnings, est: rq.body?.est_cost, cr: cr.body?.recorded, forged: [forged.status, forged2.status], code: cr.code });

    // 2. the page: the characters stage on Ada
    pg = await browser.newPage();
    await pg.setViewport({ width: 1500, height: 920, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v10 pageerror', e.message));
    const outside = [];
    await pg.setRequestInterception(true);
    pg.on('request', (r) => { const u = r.url(); if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue(); outside.push(u); return r.abort(); });
    const frames = () => pg.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const click = async (sel) => { const r = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + Math.min(12, b.width / 2), y: b.top + b.height / 2 }; }, sel); if (!r) throw new Error('no element ' + sel); await pg.mouse.click(r.x, r.y); await wait(200); };
    const shot = async (name, sel) => { await pg.evaluate(() => Promise.race([new Promise(r => setTimeout(r, 1200)), Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; })))])); await frames(); if (sel) await pg.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'start' }), sel); await frames(); await pg.screenshot({ path: path.join(OUT, `${name}.png`) }); };
    await pg.goto(`${BASE}/?project=demo`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await pg.evaluate(async () => { await window.WB.stages.open('characters'); });
    await until(() => !!window.WB.characters?.ws);
    await pg.evaluate(async () => { await window.WB.characters.open('ada'); window.WB.characters.ws.setTab('identity'); });
    await until(() => !!document.querySelector('.chprop.base [data-a=bpaccept]'));
    const propUi = await pg.evaluate(() => ({ base: !!document.querySelector('.chprop.base'), text: document.querySelector('.chprop.base .chprt')?.textContent || '', refs: document.querySelectorAll('.chprop.base .chref').length, imp: [...document.querySelectorAll('.chprop.imp')].map(x => x.dataset.prop), listChip: document.querySelector('.chrow[data-ent=ada] .chpq')?.textContent || '' }));
    await shot('v10_base_proposal', '.chbody');
    check('page: the agent\'s base proposal (text + 2 refs + why) and the identity import proposal show on Ada\'s identity tab, with a "prop" chip in the list', propUi.base && /late twenties/.test(propUi.text) && propUi.refs === 2 && propUi.imp.includes('ip01') && /prop/.test(propUi.listChip), propUi);

    // 3. accept the base in one click (the director's act: stamped page)
    await click('.chprop.base [data-a=bpaccept]');
    const E1 = await fileUntil('entities/characters/ada.json', (j) => j.base?.via === 'page' && !j.iter?.base_proposal);
    await until(() => !document.querySelector('.chprop.base'));
    await shot('v10_base_accepted', '.chbody');
    check('Accept base: the proposal becomes the base (by director, via page, proposed_by agent), the proposal is gone, the log says base_accept',
      E1?.base?.via === 'page' && E1.base.by === 'director' && E1.base.proposed_by === 'agent' && E1.base.refs.length === 2 && /late twenties/.test(E1.base.text) && !E1.iter.base_proposal && E1.iter.log.some(x => x.act === 'base_accept'),
      { base: E1?.base && { by: E1.base.by, via: E1.base.via, refs: E1.base.refs.length, proposed_by: E1.base.proposed_by } });

    // 4. accept the identity import: a node with origin imported, provenance, the head; nothing paid, no request
    const costsBefore = readJ('costs.json')?.items?.length, reqsBefore = readJ('requests.json')?.items?.length;
    await click('.chprop.imp[data-prop=ip01] [data-a=ipaccept]');
    const E2 = await fileUntil('entities/characters/ada.json', (j) => j.iter?.nodes?.some(n => n.origin === 'imported' && n.tree === 'identity'));
    const n1 = E2?.iter?.nodes?.find(n => n.tree === 'identity');
    await until(() => !!document.querySelector('.chnode .im'));
    await shot('v10_import_node', '.chbody');
    check('Accept as node: identity node from ada_body, origin imported, provenance {media, path}, request null, kind import, the head, proposal accepted; no request and no cost added',
      n1?.origin === 'imported' && n1.kind === 'import' && n1.request === null && n1.provenance?.media === 'ada_body' && E2.iter.trees.identity?.head === n1.id && E2.iter.proposals.find(p => p.id === 'ip01')?.status === 'accepted'
      && readJ('costs.json')?.items?.length === costsBefore && readJ('requests.json')?.items?.length === reqsBefore,
      { node: n1 && { id: n1.id, origin: n1.origin, kind: n1.kind, prov: n1.provenance, head: E2.iter.trees.identity }, costs: [costsBefore, readJ('costs.json')?.items?.length] });

    // 5. approve the identity (page), then the look: its import proposal is now acceptable; a second image imported directly
    await click('.chbar [data-a=approve]');
    await pg.evaluate(() => document.querySelector('.pal .pr')?.click());   // "There are new nodes…" never asked here; a confirm if any
    const E3 = await fileUntil('entities/characters/ada.json', (j) => !!j.iter?.trees?.identity?.approved);
    await pg.evaluate(() => { const w = window.WB.characters.ws; w.setVariant('night-out'); w.render(); });
    await until(() => !!document.querySelector('.chprop.imp[data-prop=ip02] [data-a=ipaccept]:not([disabled])'));
    const reqCard = await pg.evaluate(() => [...document.querySelectorAll('.chreq.warn .chreqw span')].map(s => s.textContent));
    await shot('v10_request_warnings', '.chlooks');
    check('the look\'s request card shows its warnings (no approved identity when drafted, char deprecated, unfilled block)', reqCard.some(t => /no approved identity/.test(t)) && reqCard.some(t => /deprecated/.test(t)) && reqCard.some(t => /unfilled/.test(t)), reqCard);
    await click('.chprop.imp[data-prop=ip02] [data-a=ipaccept]');
    const E4 = await fileUntil('entities/characters/ada.json', (j) => j.iter?.nodes?.some(n => n.tree === 'look:night-out'));
    const n2 = E4?.iter?.nodes?.find(n => n.tree === 'look:night-out');
    // "Import an image…" on the look tree: pick ada_face? it is used; pick the studio still through the real picker
    await click('.chtree [data-a=importimg]');
    await until(() => !!document.querySelector('.pal input'));
    await pg.type('.pal input', 'studio');
    await wait(150);
    await pg.keyboard.press('Enter');
    const E5 = await fileUntil('entities/characters/ada.json', (j) => j.iter?.nodes?.filter(n => n.tree === 'look:night-out').length === 2);
    const n3 = E5?.iter?.nodes?.filter(n => n.tree === 'look:night-out')[1];
    await until(() => !!document.querySelector('.chnp .chnedit'));
    await shot('v10_import_look', '.chlooks');
    check('identity approved (page); the look import (ip02) accepted: from_identity = the approved identity, provenance cost = the HV1-style row? (ada_face has no job: none); "Import an image…" picked studio as a second look node: the new head, origin imported, by the director via page',
      E3?.iter?.trees?.identity?.approved === n1.id && n2?.origin === 'imported' && n2.from_identity === n1.id && n3?.origin === 'imported' && n3.provenance?.media === 'studio' && E5.iter.trees['look:night-out'].head === n3.id && n3.via === 'page' && n3.by === 'director',
      { approved: E3?.iter?.trees?.identity?.approved, n2: n2 && [n2.id, n2.from_identity], n3: n3 && [n3.id, n3.provenance?.media, n3.via], head: E5?.iter?.trees?.['look:night-out'] });

    // 6. the cost panel: one total, a row per source, no double count
    await pg.evaluate(async () => { await window.WB.app.show('costs'); });
    await until(() => !!document.querySelector('.costs .costsrc tr[data-src=falgen]'));
    const cp = await pg.evaluate(() => ({ total: document.querySelector('.costs .costtotal b')?.textContent, rows: [...document.querySelectorAll('.costs .costsrc tr[data-src]')].map(r => [r.dataset.src, r.children[1].textContent, r.children[3].textContent]) }));
    await shot('v10_costs');
    // workbench $0.24 (HV1 recorded) + falgen HV2 $0.36 (C1, HV1 deduped) + not itemised 1.50 - 0.84 = $0.66 -> $1.26
    check('Costs: one total $1.26 = workbench $0.24 (the recorded HV1) + falgen rows not in costs.json $0.36 (C1 and HV1 counted once) + spent.json not itemised $0.66',
      cp.total === '$1.26' && cp.rows.find(r => r[0] === 'workbench')?.[1] === '$0.24' && cp.rows.find(r => r[0] === 'falgen')?.[1] === '$0.36' && /2 already/.test(cp.rows.find(r => r[0] === 'falgen')?.[2] || '') && cp.rows.find(r => r[0] === 'falgen_unitemized')?.[1] === '$0.66', cp);

    // 7. the Queue: "+ New request" with the photoreal recipe
    await pg.evaluate(async () => { await window.WB.app.show('queue'); });
    await until(() => !!document.querySelector('.queue .qnew'));
    await click('.queue .qnew');
    await pg.evaluate(() => { const s = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }; s('.qform [data-f=kind]', 'look-sheet'); s('.qform [data-f=target]', 'character:ada'); s('.qform [data-f=refs]', 'media/still/ada_body.jpg'); });
    await pg.evaluate(() => { const c = document.querySelector('.qform [data-f=identity]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
    await click('.qform [data-q=recipe]');
    await until(() => !!document.querySelector('.qform .qblocks'));
    for (const [k, v] of [['wardrobe', 'a black satin slip dress with thin straps, a small orange enamel hair clip above the left ear'], ['action', 'she leans on the counter, weight on one leg, looking just past the camera'], ['place', 'a narrow bar in Barcelona at night, zinc counter, chalkboard menu, a stack of glasses'], ['light', 'warm tungsten bulbs above the counter, hard, from the left; a cold blue sign glow from the street']]) {
      await click(`.qform [data-fld=${k}]`); await pg.keyboard.type(v);
    }
    await pg.evaluate(() => { const t = document.querySelector('.qform [data-blk=texture]'); t.value = 'Visible skin texture with pores, a few flyaway hairs, satin with small creases and a slight sheen.'; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await pg.evaluate(() => document.querySelector('.qform [data-fld=light]').dispatchEvent(new Event('change', { bubbles: true })));
    await wait(200);
    const form = await pg.evaluate(() => ({ blocks: [...document.querySelectorAll('.qform .qblocks textarea')].map(t => t.dataset.blk), unfilled: document.querySelectorAll('.qform .qblocks label.unfilled').length, prompt: document.querySelector('.qform [data-f=prompt]').value, est: document.querySelector('.qform .qfrow:last-child b')?.textContent, edited: document.querySelectorAll('.qform .qblocks label.edited').length }));
    await shot('v10_recipe_form', '.qform');
    await click('.qform [data-q=add]');
    const R = await fileUntil('requests.json', (j) => j.items.some(r => r.recipe && r.by === 'director'));
    const rr = R?.items?.find(r => r.recipe && r.by === 'director');
    check('Queue "+ New request" → "Apply photoreal recipe": refs + identity lock, subject + wardrobe, action, place, light, camera, texture (edited), medium, avoid blocks; no unfilled block; est $0.12 (NB2 2K, js/prices.js); the draft carries the recipe blocks, the tool and the price',
      ['refs', 'identity_lock', 'subject_wardrobe', 'action', 'location', 'light', 'camera', 'texture', 'medium', 'avoid'].every(b => form.blocks.includes(b)) && form.unfilled === 0 && form.edited === 1 && /Keep the face exactly as in Image 1/.test(form.prompt) && /satin with small creases/.test(form.prompt) && form.est === '$0.12'
      && rr?.status === 'draft' && rr.est_cost === 0.12 && /nano-banana-2/.test(rr.tool) && rr.recipe?.blocks?.length === 10 && rr.recipe.fields?.place && rr.prompt === form.prompt,
      { form: { ...form, prompt: form.prompt.slice(0, 160) }, req: rr && { est: rr.est_cost, tool: rr.tool, blocks: rr.recipe?.blocks?.length } });

    // 7b. the looks dogfood (DOGFOOD_looks.md) in the page: the recipe form for a male character (his name and constants,
    // the identity lock, takes in the estimate), withdrawn drafts in the Queue, the cost split per take on import proposals
    await agent('entity_upsert', { kind: 'character', id: 'bram', name: 'Bram', fields: { role: 'the bus driver', constants: ['a silver ring on the LEFT ring finger', 'a scar through the right eyebrow'] } });
    await pg.evaluate(() => window.WB.store.reload?.(['entities/index.json']));
    await until(() => window.WB.store.entities.some(e => e.id === 'bram'));
    await click('.queue .qnew');
    await until(() => !!document.querySelector('.qform:not([hidden]) [data-f=target]'));
    await pg.evaluate(() => { const s = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }; s('.qform [data-f=kind]', 'identity-sheet'); s('.qform [data-f=target]', 'character:bram'); s('.qform [data-f=refs]', 'media/still/bo_face.jpg'); s('.qform [data-f=takes]', '2'); });
    await pg.evaluate(() => { const c = document.querySelector('.qform [data-f=identity]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
    await click('.qform [data-q=recipe]');
    await until(() => !!document.querySelector('.qform .qblocks'));
    for (const [k, v] of [['subject', 'Bram, a man in his fifties with short grey hair and a trimmed beard'], ['wardrobe', 'a navy wool driver jacket over a grey shirt'], ['action', 'he leans on the open bus door, tired, looking down the road'], ['place', 'the bus depot at night, oil stains, a timetable board, a vending machine'], ['light', 'sodium lamps overhead, orange, hard, from above'], ['texture', 'grey stubble and wool pilling']]) {
      await click(`.qform [data-fld=${k}]`); await pg.keyboard.type(v);
    }
    await until(() => /grey stubble/.test(document.querySelector('.qform [data-f=prompt]')?.value || ''));
    const male = await pg.evaluate(() => ({ lock: document.querySelector('.qform [data-blk=identity_lock]')?.value || '', refs: document.querySelector('.qform [data-blk=refs]')?.value || '', tex: document.querySelector('.qform [data-blk=texture]')?.value || '', prompt: document.querySelector('.qform [data-f=prompt]').value, est: document.querySelector('.qform .qfrow:last-child b')?.textContent, warn: document.querySelector('.qform .qwarn')?.textContent || '' }));
    await shot('v10_recipe_male_identity', '.qform');
    check('looks: the recipe form for a male character: Bram\'s name, the identity lock with his constants (ring, scar), no "her / woman", the texture keeps the skin sentence + the field, takes 2 = est $0.24',
      /Image 1 is Bram, the approved identity/.test(male.refs) && /Keep the face exactly as in Image 1/.test(male.lock) && /silver ring on the LEFT ring finger; a scar through the right eyebrow/.test(male.lock) && !/\b(her|she|woman)\b/i.test(male.prompt)
      && /pores, fine lines/.test(male.tex) && /grey stubble and wool pilling/.test(male.tex) && male.est === '$0.24', male);
    await click('.qform [data-q=add]');
    const RB = await fileUntil('requests.json', (j) => j.items.some(r => r.target === 'character:bram'));
    const rb = RB?.items?.find(r => r.target === 'character:bram');
    // withdrawn: the agent withdraws its own obsolete draft (why + superseded_by); the director withdraws their own in the Queue
    const old = await agent('request_create', { kind: 'look-sheet', prompt: 'Ada night out, first try', est_cost: 0.12 });
    const wdr = await agent('request_update', { id: old.body.id, status: 'withdrawn', why: 'obsolete: the recipe request replaces it', superseded_by: [rr?.id || 'r'] });
    await until((id) => !!document.querySelector(`.queue tr[data-id="${id}"] [data-x=withdraw]`), rb?.id);
    await click(`.queue tr[data-id="${rb?.id}"] [data-x=withdraw]`);
    const RW = await fileUntil('requests.json', (j) => j.items.find(r => r.id === rb?.id)?.status === 'withdrawn');
    await until((ids) => ids.every(id => document.querySelector(`.queue tr[data-id="${id}"] .chip`)?.textContent === 'withdrawn'), [old.body.id, rb?.id]);
    await pg.evaluate(() => document.querySelector('.queue .qlist')?.scrollIntoView({ block: 'start' }));
    const wq = await pg.evaluate((ids) => ids.map(id => ({ chip: document.querySelector(`.queue tr[data-id="${id}"] .chip`)?.textContent, why: document.querySelector(`.queue tr[data-id="${id}"] .qwhy`)?.textContent || '', reject: !!document.querySelector(`.queue tr[data-id="${id}"] [data-x=reject]`) })), [old.body.id, rb?.id]);
    const agentDraftBtns = await pg.evaluate(() => [...document.querySelectorAll('.queue tr.q-draft')].map(r => [r.dataset.id, !!r.querySelector('[data-x=reject]'), !!r.querySelector('[data-x=withdraw]')]));
    await shot('v10_withdrawn');
    check('looks: withdrawn: the agent\'s draft withdrawn by the agent (why, superseded_by) and the director\'s own draft by its Withdraw button (stamped page) show as "withdrawn" (not rejected), with who and why; an agent\'s draft offers Reject, not Withdraw',
      wdr.body?.request?.status === 'withdrawn' && RW?.items.find(r => r.id === rb?.id)?.log.at(-1).via === 'page' && wq.every(x => x.chip === 'withdrawn' && !x.reject) && /withdrawn by the agent · superseded by/.test(wq[0].why) && /withdrawn by you/.test(wq[1].why)
      && agentDraftBtns.filter(([id]) => RW?.items.find(r => r.id === id)?.log?.[0]?.via === 'agent').length > 0 && agentDraftBtns.filter(([id]) => RW?.items.find(r => r.id === id)?.log?.[0]?.via === 'agent').every(([, rej, wd]) => rej && !wd),
      { wdr: wdr.body?.request?.status || wdr.body, wq, agentDraftBtns });
    // two takes of one falgen job ($0.24): each take's proposal shows its share
    for (const k of [0, 1]) { fs.copyFileSync(path.join(ND, 'media', 'still', 'bo_body.jpg'), path.join(ND, 'media', 'still', `hv9_${k}.jpg`)); await agent('media_add', { path: `media/still/hv9_${k}.jpg`, kind: 'sheet', job: 'HV9', take: k, entities: ['ada'] }); }
    await agent('cost_record', { usd: 0.24, via: 'falgen', job: 'HV9', tool: 'fal-ai/nano-banana-2/edit' });
    const tk = []; for (const k of [0, 1]) tk.push((await agent('node_import_propose', { id: 'ada', tree: 'look:night-out', media: `media/still/hv9_${k}.jpg`, why: `HV9 take ${k}: an alternative take of the same job` })).body?.proposal);
    await pg.evaluate(async () => { await window.WB.stages.open('characters'); await window.WB.characters.open('ada'); const w = window.WB.characters.ws; w.setVariant('night-out'); w.render(); });
    await until((ids) => ids.every(id => !!document.querySelector(`.chprop.imp[data-prop="${id}"]`)), tk.map(x => x?.id));
    const takeUi = await pg.evaluate((ids) => ids.map(id => document.querySelector(`.chprop.imp[data-prop="${id}"] .chprb > div.dim`)?.textContent || ''), tk.map(x => x?.id));
    await shot('v10_cost_per_take', `.chprop.imp[data-prop="${tk[0]?.id}"]`);
    check('looks: two takes of one job ($0.24): each import proposal carries and shows its share ("$0.12 · take k of 2, job HV9 $0.24"), so per-node sums count the job once',
      tk.every(x => x?.provenance?.cost?.usd === 0.12 && x.provenance.cost.takes === 2) && takeUi.every((t, k) => new RegExp(`\\$0\\.12 · take ${k} of 2, job HV9 \\$0\\.24`).test(t)), { takeUi, cost: tk.map(x => x?.provenance?.cost) });
    await pg.evaluate(async () => { await window.WB.app.show('queue'); });

    // 8. the stale-code bar: a code file of this server's copy changes on disk
    const before = await pg.evaluate(() => !!document.getElementById('stalebar'));
    fs.appendFileSync(path.join(CODE, 'lib', 'store.mjs'), '\n// changed after the server started (verify v10)\n');
    const st = await (await fetch(`${BASE}/api/status`)).json();
    await pg.evaluate(() => document.dispatchEvent(new CustomEvent('wb:reconnect')));
    await until(() => !!document.getElementById('stalebar'));
    const bar = await pg.evaluate(() => document.getElementById('stalebar')?.textContent || '');
    await pg.evaluate(async () => { await window.WB.app.show('timeline'); });
    await shot('v10_stale_bar');
    check('stale server: /api/status code.stale with the changed file; the page shows the thin "Restart the server" bar (none before)', !before && st.code?.stale === true && st.code.changed.includes('lib/store.mjs') && /Restart the server/.test(bar) && /lib\/store\.mjs/.test(bar), { before, status: st.code, bar });
    check('no request left the machine', !outside.length, outside);
  } catch (e) { console.error('v10 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-dogfood.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyDogfood({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v10 (dogfood frictions):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
