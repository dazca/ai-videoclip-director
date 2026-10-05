// v11 of the headless UI suite (tools/verify.mjs): SPEC v4 §1, notes everywhere (ROADMAP_v4 B1-B5). Exported so
// verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-notes.mjs [outDir]
// Self-contained: a scratch copy of data/demo as "legacy" whose notes are still in the OLD stores (notes.json v1 with a
// reply, lyrics.json / scenes.json / breakdown.json / storyboard.json notes, a character's iter.notes), its own server on
// a free port; all deleted at the end. Checks: the migration on first load (every old note in notes.json v2, the old files
// byte-identical, notes.json v1 kept as notes.v1.json); the Notes column in every stage (row-aligned with its rows: a
// lyric line, a section, a scene, an item, a tree node with an image pin, a shot, a final shot), typing in an empty cell
// and Alt+N; the time-aligned notes column on the timeline (a click at a time types a note at that ms); the right-click
// "+ Add" menus (lyrics, script, timeline, storyboard, breakdown, trees) and their acts undone with Ctrl+Z; the commands
// in the palette; the open-notes counts on the stage rail and the top bar. Screenshots v11_*.png.
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
const imp = (f) => import(pathToFileURL(path.join(WB, f)).href);

export async function verifyNotes({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v11 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v11-')), DATA = path.join(TMP, 'data'), P = 'legacy', LD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), LD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  // ---------------------------------------------------------------- the old stores (as the earlier workbench wrote them)
  const F = await imp('js/flow.js'), SC = await imp('js/scenes.js'), SB = await imp('js/storyboard.js');
  const J = (f) => JSON.parse(fs.readFileSync(path.join(LD, f), 'utf8')), Wf = (f, v) => fs.writeFileSync(path.join(LD, f), JSON.stringify(v, null, 1));
  const at = '2026-10-02T09:00:00', song = J('song.json');
  const ly = F.normLyrics(null, song, {}); delete ly.derived; ly.rev = 2;
  ly.notes = [{ id: 'ln01', line: 'verse/1', w: [2, 3], quote: F.words(song.lines.find(l => l.id === 'verse/1').text).slice(2, 4).join(' '), text: 'verify legacy: these two words', by: 'director', via: 'page', status: 'open', at, version: 'v1', replies: [{ id: 'ln01.1', text: 'verify legacy: agent answer', by: 'agent', via: 'agent', at }] },
    { id: 'ln02', line: null, w: null, quote: '', text: 'verify legacy: a bridge?', to: 'agent', kind: 'request', by: 'director', via: 'page', status: 'open', at, version: 'v1', replies: [] }];
  Wf('lyrics.json', ly);
  const sc = SC.normScenes(null, song, J('script.json')); delete sc.derived; sc.rev = 2;
  const sc02 = sc.versions.at(-1).scenes.find(s => s.id === 'sc02'), beat = sc02.beats[0]?.id;
  sc.notes = [{ id: 'sn01', scene: 'sc02', beat, text: 'verify legacy: this beat', by: 'director', via: 'page', status: 'open', at, version: sc.current, replies: [] }];
  Wf('scenes.json', sc);
  Wf('breakdown.json', { rev: 2, current: 'v1', versions: [{ id: 'v1', n: 1, created: at, by: 'director', via: 'page', message: 'legacy', script: sc.current,
    items: [{ id: 'bi01', kind: 'character', name: 'Ada', description: 'the lead', links: [{ scene: 'sc02', beats: [] }], source: 'director' }, { id: 'bi02', kind: 'location', name: 'The wall', description: '', links: [{ scene: 'sc02', beats: [] }], source: 'director' }, { id: 'bi03', kind: 'prop', name: 'Tone generator', description: '', links: [{ scene: 'sc03', beats: [] }], source: 'director' }] }],
    states: {}, notes: [{ id: 'bn01', item: 'bi02', text: 'verify legacy: one wall or two angles?', by: 'agent', via: 'agent', status: 'open', at, version: 'v1', replies: [] }, { id: 'bn02', item: null, scene: 'sc02', text: 'verify legacy: no prop in sc02', by: 'director', via: 'page', status: 'resolved', at, version: 'v1', replies: [] }] });
  const sb = SB.normBoard(null, J('shots.json'), sc); delete sb.derived; sb.rev = 2;
  sb.notes = [{ id: 'sbn01', shot: 's3-grid', scene: 'sc02', text: 'verify legacy: frame it wider', by: 'director', via: 'page', status: 'open', at, version: sb.current, replies: [] }];
  Wf('storyboard.json', sb);
  const ada = J('entities/characters/ada.json'); ada.iter = { nodes: [], trees: {}, notes: [{ id: 'cn01', text: 'verify legacy: older, late thirties?', by: 'director', via: 'page', status: 'open', at, replies: [] }], log: [] }; Wf('entities/characters/ada.json', ada);
  const OLD = ['notes.json', 'lyrics.json', 'scenes.json', 'breakdown.json', 'storyboard.json', 'entities/characters/ada.json'];
  const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(LD, f))).digest('hex');
  const before = Object.fromEntries(OLD.map(f => [f, sha(f)])), v1text = fs.readFileSync(path.join(LD, 'notes.json'), 'utf8');

  const port = await freePort(), BASE = `http://localhost:${port}`;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P, WB_AGENT_APPROVALS: '' } });
  srv.stderr.on('data', d => process.stderr.write('v11 server: ' + d));
  let pg = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
    const call = async (name, body, page = false) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN, ...(page ? { origin: BASE } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    pg = await browser.newPage();
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v11 pageerror', e.stack || e.message));
    pg.on('console', m => { if (m.type() === 'error') console.error('v11 console', m.text()); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const combo = async (mods, key) => { for (const m of mods) await pg.keyboard.down(m); await pg.keyboard.press(key); for (const m of mods.slice().reverse()) await pg.keyboard.up(m); };
    const shot = async (n) => { await frames(3); await pg.screenshot({ path: path.join(OUT, `${n}.png`) }); };
    const stage = async (id) => { await pg.evaluate((s) => window.WB.stages.open(s), id); await wait(500); await frames(3); };
    const notes = () => pg.evaluate(() => window.WB.store.notes.notes.map(n => ({ id: n.id, target: n.target, by: n.by, via: n.via, status: n.status, text: n.text, to: n.to })));
    // the cell of the visible Notes column on the row matching fn(row), and how far its top is from the row's
    const cellOf = (rowSel) => pg.evaluate((s) => {
      const c = window.WB.notesCol.visible(); if (!c) return null;
      const i = c.rows.findIndex(r => !r.top && (r.els || [r.el]).some(e => e.matches(s))); if (i < 0) return null;
      const cell = c.layer.querySelector(`.nccell[data-row="${i}"]`), row = (c.rows[i].els || [c.rows[i].el])[0], a = cell.getBoundingClientRect(), b = row.getBoundingClientRect();
      return { x: a.left + a.width / 2, y: a.top + Math.min(8, a.height / 2), dy: Math.abs(a.top - b.top), notes: [...cell.querySelectorAll('.ncn')].map(n => n.dataset.nid), empty: cell.classList.contains('empty') };
    }, rowSel);
    // type a note in the cell of a row (a click on the cell), Enter saves; -> the new note
    const typeIn = async (rowSel, text) => {
      const n0 = (await notes()).length, c = await cellOf(rowSel); if (!c) return null;
      await pg.evaluate((s) => { const x = document.querySelector(s); x?.scrollIntoView({ block: 'center' }); }, rowSel); await frames(2);
      const c2 = await cellOf(rowSel); await pg.mouse.click(c2.x, c2.y); await wait(120);
      const focused = await pg.evaluate(() => !!document.activeElement?.matches('.nclayer .nced'));
      await pg.keyboard.type(text); await pg.keyboard.press('Enter');
      await until((k) => window.WB.store.notes.notes.length > k, n0);
      return { focused, note: (await notes()).find(n => n.text === text.replace(/^@agent\s*/, '')) };
    };
    // right-click at an element, open "+ Add", read its items; pick one (by label) when asked
    const addMenu = async (sel, { pick, shotName, at } = {}) => {
      await pg.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel); await frames(2);
      const box = await pg.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(8, r.height / 2) }; }, sel);
      if (!box) return { items: [], top: [] };
      await pg.mouse.click(at?.x ?? box.x, at?.y ?? box.y, { button: 'right' }); await wait(120);
      const top = await pg.evaluate(() => [...document.querySelectorAll('.pop .pi .lb')].map(x => x.textContent.trim()));
      const add = await pg.evaluate(() => { const r = [...document.querySelectorAll('.pop .pi')].find(x => x.querySelector('.lb')?.textContent.trim() === '+ Add' && !x.classList.contains('dis')); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; });
      if (!add) { await pg.keyboard.press('Escape'); return { items: [], top }; }
      await pg.mouse.move(add.x, add.y); await wait(250);
      const items = await pg.evaluate(() => { const pops = document.querySelectorAll('.pop'); const sub = pops[pops.length - 1]; return [...sub.querySelectorAll('.pi')].map(x => ({ label: x.querySelector('.lb').textContent.trim(), dis: x.classList.contains('dis') })); });
      if (shotName) await shot(shotName);
      if (pick) {
        const it = await pg.evaluate((l) => { const pops = document.querySelectorAll('.pop'); const r = [...pops[pops.length - 1].querySelectorAll('.pi')].find(x => x.querySelector('.lb').textContent.trim() === l); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; }, pick);
        if (it) { await pg.mouse.move(it.x, it.y); await pg.mouse.click(it.x, it.y); await wait(250); } else { await pg.keyboard.press('Escape'); await pg.keyboard.press('Escape'); }
      } else { await pg.keyboard.press('Escape'); await pg.keyboard.press('Escape'); }
      return { items, top };
    };
    const undo = async () => { await pg.evaluate(() => document.activeElement?.blur?.()); await combo(['Control'], 'KeyZ'); await wait(300); };

    // 1. the migration: on the page's first load the old stores are read into notes.json v2, without loss; the old
    // files stay byte-identical; notes.json v1 is kept as notes.v1.json; the page shows every note
    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(3);
    const V2 = J('notes.json'), ids = V2.notes.map(n => n.id).sort();
    const pageN = await notes();
    const want = ['bn01', 'bn02', 'cn01', 'ln01', 'ln02', 'n01', 'n02', 'sbn01', 'sn01'];
    const by = (id) => V2.notes.find(n => n.id === id);
    check('migration on first load: every old note (notes.json v1, lyrics, scenes, breakdown, storyboard, a character) in notes.json v2 with its target, author, status and thread; the old files byte-identical, notes.json v1 kept as notes.v1.json; the page shows them all',
      V2.v === 2 && JSON.stringify(ids) === JSON.stringify(want) && OLD.filter(f => f !== 'notes.json').every(f => sha(f) === before[f]) && fs.readFileSync(path.join(LD, 'notes.v1.json'), 'utf8') === v1text
      && by('ln01').target.kind === 'line' && JSON.stringify(by('ln01').target.w) === '[2,3]' && by('ln01').replies[0].via === 'agent' && by('ln02').to === 'agent' && by('sn01').target.id === `sc02/${beat}` && by('bn02').status === 'absorbed'
      && by('bn01').via === 'agent' && by('sbn01').target.id === 's3-grid' && by('cn01').target.stage === 'characters' && by('n02').target.t === 12000 && pageN.length === want.length,
      { ids, page: pageN.length, untouched: OLD.filter(f => f !== 'notes.json').filter(f => sha(f) === before[f]).length });
    // the counts: per stage on the rail, all of them in the top bar
    const counts = await pg.evaluate(() => ({ rail: Object.fromEntries([...document.querySelectorAll('#rail a[data-stage]')].map(a => [a.dataset.stage, Number(a.querySelector('.rnc')?.textContent || 0)])), top: document.querySelector('#top .opennotes')?.textContent || '' }));
    const open = V2.notes.filter(n => n.status === 'open'), per = (s) => open.filter(n => n.target.stage === s).length;
    check('counters: each stage on the rail shows its open notes; the top bar "N open notes" counts every stage and the timeline',
      ['lyrics', 'script', 'breakdown', 'characters', 'storyboard', 'final'].every(s => counts.rail[s] === per(s)) && counts.top === `${open.length} open notes`, { counts, open: open.length });

    // 2. lyrics: notes on their line (row-aligned), a word range marked; a click in an empty cell types a note there;
    // Alt+N on a focused line; right-click "+ Add" (line above / below, verse, section, note) and Ctrl+Z
    await stage('lyrics');
    const l1 = await cellOf('.lyl[data-line="verse/1"]');
    const marks = await pg.evaluate(() => [...document.querySelectorAll('.lyl[data-line="verse/1"] .w.nw')].length);
    const tl = await typeIn('.lyl[data-line="chorus/0"]', 'verify: slower here, let it breathe');
    await pg.evaluate(() => document.querySelector('.lyl[data-line="verse/0"]').focus()); await combo(['Alt'], 'KeyN'); await wait(150);
    const altN = await pg.evaluate(() => ({ focus: !!document.activeElement?.matches('.nclayer .nced'), on: document.querySelector('.nclayer .ncedh')?.textContent || '' }));
    await pg.keyboard.type('@agent verify: rhyme check'); await pg.keyboard.press('Enter');
    await until(() => window.WB.store.notes.notes.some(n => n.text === 'verify: rhyme check'));
    const ask = (await notes()).find(n => n.text === 'verify: rhyme check');
    await shot('v11_lyrics');
    check('lyrics: notes sit on their line (row-aligned) with the word range marked; a click in an empty cell types a note on that line (director / page); Alt+N on a focused line, "@agent" makes it an ask',
      l1?.notes.includes('ln01') && l1.dy < 1.5 && marks === 2 && tl?.focused && tl.note?.target.id === 'chorus/0' && tl.note.target.kind === 'line' && tl.note.by === 'director' && altN.focus && /verse\/0|this line/.test(altN.on) && ask?.target.id === 'verse/0' && ask.to === 'agent',
      { l1, marks, typed: tl?.note?.target, focused: tl?.focused, altN, ask: ask && [ask.target, ask.to], texts: (await notes()).map(n => n.text).slice(-3) });
    const m1 = await addMenu('.lyl[data-line="verse/1"] .lytx', { shotName: 'v11_add_lyrics' });
    const n0 = await pg.evaluate(() => window.WB.stages && document.querySelectorAll('.lyl').length);
    await addMenu('.lyl[data-line="verse/1"] .lytx', { pick: '+ line below' });
    await pg.keyboard.type('verify: a new line'); await pg.keyboard.press('Enter'); await wait(200);
    const n1 = await pg.evaluate(() => document.querySelectorAll('.lyl').length), after = await pg.evaluate(() => document.querySelector('.lyl[data-line="verse/1"]').nextElementSibling?.textContent || '');
    await undo();
    const n2 = await pg.evaluate(() => document.querySelectorAll('.lyl').length);
    await addMenu('.lyhead', { pick: '+ verse' }); await pg.keyboard.type('verify: a verse line'); await pg.keyboard.press('Enter'); await wait(200);
    const verse = await pg.evaluate(() => window.WB.stages && [...document.querySelectorAll('.lytag')].map(t => t.textContent));
    await undo();
    check('lyrics right-click "+ Add": line above / below, verse, section, note here; "+ line below" adds a line under the clicked one (draft), Ctrl+Z takes it back; "+ verse" adds a [Verse N] section',
      ['+ line above', '+ line below', '+ verse', '+ section…', '+ note here'].every(l => m1.items.some(x => x.label === l && !x.dis)) && n1 === n0 + 1 && /a new line/.test(after) && n2 === n0 && verse.some(t => /\[Verse \d\]/.test(t)),
      { items: m1.items.map(x => x.label), lines: [n0, n1, n2], verse });

    // 3. script: a beat's note on its scene's row; a click types on a scene; "+ beat at this time", "+ scene here" (a split), Ctrl+Z
    await stage('script');
    const s2 = await cellOf('.scrow[data-scene="sc02"]');
    const ts = await typeIn('.scrow[data-scene="sc01"]', 'verify: open on the test card');
    const m2 = await addMenu('.scrow[data-scene="sc02"] .scl .lyt', { shotName: 'v11_add_script' });
    const b0 = await pg.evaluate(() => window.WB.script.ws.scene('sc02').beats.length);
    await addMenu('.scrow[data-scene="sc02"] .scl .lyt', { pick: '+ beat at this time' }); await pg.keyboard.press('Escape');
    const b1 = await pg.evaluate(() => window.WB.script.ws.scene('sc02').beats.length);
    await undo(); const b2 = await pg.evaluate(() => window.WB.script.ws.scene('sc02').beats.length);
    const sc0 = await pg.evaluate(() => window.WB.script.ws.draft.length);
    await addMenu('.scrow[data-scene="sc02"] .scl:nth-child(2) .lyt', { pick: '+ scene here' }); await pg.keyboard.press('Escape');
    const sc1 = await pg.evaluate(() => window.WB.script.ws.draft.length);
    await undo(); const sc2n = await pg.evaluate(() => window.WB.script.ws.draft.length);
    await stage('script'); await shot('v11_script');
    check('script: a beat\'s note sits on its scene\'s row (tagged with the beat); a click types a note on a scene; "+ Add" beat at this time / scene here (a split) change the draft, Ctrl+Z takes them back',
      s2?.notes.includes('sn01') && s2.dy < 1.5 && ts?.note?.target.kind === 'scene' && ts.note.target.id === 'sc01' && ['+ scene here', '+ beat at this time', '+ note here'].every(l => m2.items.some(x => x.label === l)) && b1 === b0 + 1 && b2 === b0 && sc1 === sc0 + 1 && sc2n === sc0,
      { s2, typed: ts?.note?.target, items: m2.items.map(x => x.label), beats: [b0, b1, b2], scenes: [sc0, sc1, sc2n] });

    // 4. breakdown: an item's note on its row, a scene's in the top row; a click types on an item; "+ Add" an item, Ctrl+Z
    await stage('breakdown');
    const bi = await cellOf('.bdrow[data-item="bi02"]');
    const top = await pg.evaluate(() => [...(window.WB.notesCol.visible()?.layer.querySelectorAll('.nccell.top .ncn') || [])].map(n => n.dataset.nid));
    const tb = await typeIn('.bdrow[data-item="bi01"]', 'verify: her coat colour?');
    const m3 = await addMenu('.bdrow[data-item="bi03"] .bdnm', { shotName: 'v11_add_breakdown' });
    const i0 = await pg.evaluate(() => window.WB.breakdown.ws.draft.length);
    await addMenu('.bdrow[data-item="bi03"] .bdnm', { pick: '+ prop' }); await pg.keyboard.type('Bus ticket'); await pg.keyboard.press('Enter'); await wait(300);
    const i1 = await pg.evaluate(() => window.WB.breakdown.ws.draft.length);
    await undo(); const i2 = await pg.evaluate(() => window.WB.breakdown.ws.draft.length);
    await shot('v11_breakdown');
    check('breakdown: an item\'s note on its row, a scene\'s note in the top row; a click types on an item; "+ Add" by kind adds an item (draft), Ctrl+Z takes it back',
      bi?.notes.includes('bn01') && bi.dy < 1.5 && tb?.note?.target.kind === 'item' && tb.note.target.id === 'bi01' && ['+ character', '+ location', '+ prop', '+ wardrobe item', '+ FX', '+ note here'].filter(l => m3.items.some(x => x.label === l)).length >= 4 && i1 === i0 + 1 && i2 === i0,
      { bi, top, typed: tb?.note?.target, items: m3.items.map(x => x.label), items0: [i0, i1, i2] });

    // 5. characters: the asset's notes in the top row; a node (an imported image) opened, a note pinned on its image; the
    // node's right-click "+ Add" (note on this node)
    const imp1 = await call('asset_act', { type: 'character', id: 'ada', act: 'import', tree: 'identity', media: 'ada_body' }, true);
    await stage('characters');
    await pg.evaluate(() => window.WB.characters.open('ada')); await wait(300);
    await pg.evaluate(() => window.WB.characters.node('n01')); await wait(400);
    const topC = await pg.evaluate(() => [...(window.WB.notesCol.visible()?.layer.querySelectorAll('.nccell.top .ncn') || [])].map(n => n.dataset.nid));
    await pg.evaluate(() => document.querySelector('.chnp [data-a=pinnote]').click()); await wait(200);
    const img = await pg.evaluate(() => { const i = document.querySelector('.chpinw img'); i.scrollIntoView({ block: 'center' }); const r = i.getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.4 }; });
    await pg.mouse.click(img.x, img.y); await wait(200);
    const pinEd = await pg.evaluate(() => ({ focus: !!document.activeElement?.matches('.nclayer .nced'), on: document.querySelector('.nclayer .ncedh')?.textContent || '' }));
    await pg.keyboard.type('verify: the collar here'); await pg.keyboard.press('Enter'); await wait(500);
    const pinN = (await notes()).find(n => n.text === 'verify: the collar here');
    const pins = await pg.evaluate(() => [...document.querySelectorAll('.chpinw .chnpin')].map(p => ({ l: p.style.left, t: p.style.top })));
    await shot('v11_characters');
    const m4 = await addMenu('.chstrip .chnode[data-node="n01"]', { shotName: 'v11_add_tree', pick: '+ note on this node' });
    const nodeEd = await pg.evaluate(() => document.querySelector('.nclayer .ncedh')?.textContent || '');
    await pg.keyboard.type('verify: keep this one'); await pg.keyboard.press('Enter'); await wait(400);
    const nodeN = (await notes()).find(n => n.text === 'verify: keep this one');
    check('characters: the asset\'s note in the top row; a note pinned on the open node\'s image (target node + pin, a numbered marker); the node\'s "+ Add › note on this node" types a note on it',
      imp1.status === 200 && topC.includes('cn01') && pinEd.focus && pinN?.target.kind === 'node' && pinN.target.id === 'ada/n01' && Math.abs(pinN.target.pin?.x - 0.3) < 0.02 && Math.abs(pinN.target.pin?.y - 0.4) < 0.02 && pins.length === 1 && Math.abs(parseFloat(pins[0].l) - 30) < 2
      && m4.items.some(x => x.label === '+ note on this node') && /n01/.test(nodeEd) && nodeN?.target.id === 'ada/n01',
      { imp: imp1.status, topC, pinEd, pin: pinN?.target, pins, items: m4.items.map(x => x.label), nodeN: nodeN?.target });

    // 6. scenery: a click in the top row types a note on the asset (a location)
    await stage('scenery');
    await pg.evaluate(() => window.WB.scenery.open('studio')); await wait(300);
    const sTop = await pg.evaluate(() => { const c = window.WB.notesCol.visible(); const cell = c.layer.querySelector('.nccell.top'); cell.scrollIntoView({ block: 'nearest' }); const r = cell.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 6 }; });
    await pg.mouse.click(sTop.x, sTop.y); await wait(120);
    await pg.keyboard.type('verify: warmer light in the studio'); await pg.keyboard.press('Enter'); await wait(400);
    const sN = (await notes()).find(n => n.text === 'verify: warmer light in the studio');
    await shot('v11_scenery');
    check('scenery: a click in the top row types a note on the location (stage scenery, asset studio)', sN?.target.stage === 'scenery' && sN.target.kind === 'asset' && sN.target.id === 'studio', sN?.target);

    // 7. storyboard: a shot's note on its scene's row; Alt+N with a shot selected notes that shot; "+ Add › shot" splits
    await stage('storyboard');
    const sb2 = await cellOf('.sbscene[data-scene="sc02"]');
    await pg.evaluate(() => window.WB.storyboard.focus('s2-wall')); await wait(200);
    await pg.evaluate(() => document.querySelector('.sblist').focus()); await combo(['Alt'], 'KeyN'); await wait(150);
    await pg.keyboard.type('verify: a push in'); await pg.keyboard.press('Enter'); await wait(400);
    const shN = (await notes()).find(n => n.text === 'verify: a push in');
    const m5 = await addMenu('.sbcard[data-shot="s3-grid"] .sbtx', { shotName: 'v11_add_storyboard' });
    const k0 = await pg.evaluate(() => window.WB.storyboard.ws.draft.length);
    await addMenu('.sbcard[data-shot="s3-grid"] .sbtx', { pick: '+ shot' });
    const k1 = await pg.evaluate(() => window.WB.storyboard.ws.draft.length);
    await undo(); const k2 = await pg.evaluate(() => window.WB.storyboard.ws.draft.length);
    await shot('v11_storyboard');
    check('storyboard: a shot\'s note on its scene\'s row (tagged with the shot); Alt+N with a shot selected notes that shot; "+ Add › shot" cuts the shot (draft), Ctrl+Z takes it back',
      sb2?.notes.includes('sbn01') && sb2.dy < 1.5 && shN?.target.kind === 'shot' && shN.target.id === 's2-wall' && m5.items.some(x => x.label === '+ shot') && k1 === k0 + 1 && k2 === k0,
      { sb2, shN: shN?.target, items: m5.items.map(x => x.label), shots: [k0, k1, k2] });

    // 8. final: a note on a shot row; Ctrl+Z removes the note again (the notes are undoable like every page edit)
    await stage('final');
    const tf = await typeIn('.fnrow[data-shot="s4-chorus"]', 'verify: grade it warmer');
    await shot('v11_final');
    await undo();
    const gone = !(await notes()).some(n => n.text === 'verify: grade it warmer');
    check('final: a click on a shot row\'s cell types a note on that shot (stage final); Ctrl+Z removes it again', tf?.note?.target.stage === 'final' && tf.note.target.id === 's4-chorus' && gone, { typed: tf?.note?.target, gone });

    // 9. the timeline: notes at their time (the timeline's and the stages' with a time), a click on an empty spot of the
    // notes column types a note at that ms; right-click "+ Add" (note at this time, scene here, shot here)
    await pg.evaluate(() => window.WB.app.show('timeline')); await wait(600); await frames(3);
    const t1 = 15000;
    await pg.evaluate((t) => { const tl = window.WB.ctx.timeline; tl.scrollToTime(t - 3000); tl.drawLanes(); }, t1); await frames(3);
    const spot = await pg.evaluate((t) => { const tl = window.WB.ctx.timeline, c = tl.byId.notes, r = c.el.getBoundingClientRect(), y = tl.sheet.getBoundingClientRect().top + tl.warp.y(t); return { x: r.left + Math.min(c.vw - 10, 150), y }; }, t1);
    await pg.mouse.click(spot.x, spot.y); await wait(200);
    const tlEd = await pg.evaluate(() => !!document.activeElement?.matches('.noteedit'));
    await pg.keyboard.type('verify: the cut lands late'); await pg.keyboard.press('Enter'); await wait(500);
    const tN = (await notes()).find(n => n.text === 'verify: the cut lands late');
    const inCol = await pg.evaluate(() => ({ items: document.querySelectorAll('.col-notes .note').length, other: document.querySelectorAll('.col-notes .note.other').length, shown: [...document.querySelectorAll('.col-notes .note')].some(n => n.textContent.includes('the cut lands late')) }));
    await shot('v11_timeline');
    const m6 = await addMenu('.col-lyrics .vl', { shotName: 'v11_add_timeline' });
    check('timeline: the notes column holds every note with a time (the stages\' tagged); a click on an empty spot types a note at that ms (± a few ms); right-click "+ Add": note at this time, scene here, shot here',
      tlEd && tN?.target.stage === 'timeline' && Math.abs(tN.target.t - t1) < 120 && inCol.shown && inCol.other >= 4 && ['+ note at this time', '+ scene here', '+ shot here'].every(l => m6.items.some(x => x.label === l && !x.dis)),
      { tlEd, t: tN?.target.t, inCol, items: m6.items.map(x => x.label) });
    const sh0 = await pg.evaluate(() => window.WB.storyboard?.ws?.draft.length ?? null);
    await addMenu('.col-lyrics .vl', { pick: '+ shot here' }); await wait(500);
    const sh1 = await pg.evaluate(() => ({ stage: window.WB.app.active() === 'stage' && window.WB.stages.current(), n: window.WB.storyboard.ws.draft.length }));
    await undo(); const sh2 = await pg.evaluate(() => window.WB.storyboard.ws.draft.length);
    await pg.evaluate(() => window.WB.app.show('timeline')); await wait(400);
    await addMenu('.col-lyrics .vl', { pick: '+ note at this time' }); await wait(200);
    const tlEd2 = await pg.evaluate(() => !!document.activeElement?.matches('.noteedit'));
    await pg.keyboard.press('Escape');
    check('timeline "+ shot here" opens the storyboard with the shot cut there (draft), Ctrl+Z takes it back; "+ note at this time" opens the editor at that time',
      sh1.stage === 'storyboard' && sh1.n === (sh0 ?? sh1.n - 1) + 1 && sh2 === sh1.n - 1 && tlEd2, { sh0, sh1, sh2, tlEd2 });

    // 10. the palette has the "+ Add" commands; the files: every new note is the director's (page) in notes.json v2
    await stage('lyrics');
    await combo(['Control'], 'KeyK'); await pg.keyboard.type('add a lyric line'); await wait(150);
    const pal = await pg.evaluate(() => [...document.querySelectorAll('.pal .pr .lb')].map(x => x.textContent));
    await pg.keyboard.press('Escape');
    await combo(['Control'], 'KeyK'); await pg.keyboard.type('note here'); await wait(150);
    const pal2 = await pg.evaluate(() => [...document.querySelectorAll('.pal .pr .lb')].map(x => x.textContent));
    await pg.keyboard.press('Escape');
    const FV = J('notes.json'), mine = FV.notes.filter(n => /^verify: /.test(n.text));
    check('the "+ Add" commands are in the palette (Add a lyric line above / below, Add a note here); every note typed in the page is in notes.json v2, by the director, via page',
      pal.some(x => /Add a lyric line above/.test(x)) && pal.some(x => /Add a lyric line below/.test(x)) && pal2.some(x => /Add a note here/.test(x)) && mine.length >= 8 && mine.every(n => n.by === 'director' && n.via === 'page'),
      { pal: pal.slice(0, 4), pal2: pal2.slice(0, 3), mine: mine.length });
  } catch (e) { console.error('v11 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-notes.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyNotes({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v11 (notes everywhere):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
