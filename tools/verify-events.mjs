// v23 of the headless UI suite (tools/verify.mjs): named sync points and the re-time after the take (ROADMAP_v4 E1).
// Exported so verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-events.mjs [outDir]
// Self-contained: a scratch copy of data/demo (its importer events.json: an old array, read as v2), its own server on a free
// port; all deleted at the end. The cycle:
//   the events column (section starts left out, kinds, ⚓ counts); an agent's event (event_add over the agent surface) shows
//   dashed with "accept", the agent cannot accept it (403), the director's click does; right-click › + Add › "+ Named event
//   here" and "+ Named event at “word”" (a lyric word's time) through the event dialog; Import events… (an audio events.json
//   in seconds, the first film's shape) -> ms; the script and storyboard snap menus offer "events"; a scene end anchored to
//   stop_outro and a shot cut anchored to drop_chorus in the page (saved versions carry anchors); snap "events" anchors a
//   typed cut to the nearest event; dragging an event in the column sets its measured time, "= playhead" and a typed time
//   too; Re-time after the take… previews every anchored boundary and the cuts that share it (old -> new) and applies it as
//   ONE undoable change (a new scenes and storyboard version; Ctrl+Z = new versions with the old times, the events pending
//   again; redo); an agent's retime_propose shows in the dialog and the director applies it; the agent cannot apply (403);
//   the Time view draws the events on a stage's axis.
// Screenshots v23_*.png: the events column, the + Add menu, the snap menus with "events", an anchored scene and shot cut,
// the re-time preview, the agent's proposal, the Time view markers.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(process.env.WB_VERIFY_PORT ? Number(process.env.WB_VERIFY_PORT) + ((globalThis.__wbVerifyPortN = (globalThis.__wbVerifyPortN ?? -1) + 1) % 10) : 0, () => { const p = s.address().port; s.close(() => ok(p)); }); });

export async function verifyEvents({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v23 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v23-')), DATA = path.join(TMP, 'data'), P = 'evts', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P };
  delete env.WB_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v23 server: ' + d));
  const readP = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  const cur = (f, k) => { const d = readP(f); return d.versions.find(v => v.id === d.current)[k]; };
  let pg = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
    // an agent: the token without the page's Origin (the agent surface)
    const agent = async (name, body) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };

    pg = await browser.newPage();
    await pg.setViewport({ width: 1500, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v23 pageerror', e.stack || e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.error('v23 console', m.text()); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    // a <select> drawn open (a native drop-down does not show in a headless screenshot): a listbox copy over it, then a PNG
    const selectShot = async (sel, name) => {
      const b = await pg.evaluate((s) => { const o = document.querySelector(s), r = o.getBoundingClientRect(), c = o.cloneNode(true); c.id = 'v23open'; c.size = o.options.length; c.value = o.value;
        Object.assign(c.style, { position: 'fixed', left: r.left + 'px', top: r.bottom + 'px', zIndex: 99, height: 'auto', width: Math.max(90, r.width) + 'px' }); document.body.appendChild(c);
        const q = c.getBoundingClientRect(); return { x: Math.max(0, r.left - 160), y: Math.max(0, r.top - 8), width: Math.max(r.right, q.right) - r.left + 200, height: q.bottom - r.top + 16 }; }, sel);
      fs.writeFileSync(path.join(OUT, `${name}.png`), await pg.screenshot({ clip: b }));
      await pg.evaluate(() => document.getElementById('v23open')?.remove());
    };
    const shot = async (sel, name, pad = 0) => { const el = await pg.$(sel); if (!el) return false; const b = await el.boundingBox(); fs.writeFileSync(path.join(OUT, `${name}.png`), await pg.screenshot({ clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad } })); return true; };
    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(3);
    await pg.evaluate(() => { const tl = window.WB.timeline; tl.pxPerSec = 40; tl.relayout(); tl.scrollToTime(0); });

    // 1. the events column: the importer's array read as v2 (section starts left to the sections column)
    const col1 = await pg.evaluate(() => [...document.querySelectorAll('.tl .col-events .evn')].map(e => ({ id: e.dataset.ev, kind: [...e.classList].find(c => c.startsWith('k-')), text: e.textContent })));
    check('the events column lists the named events of the importer\'s events.json (an old array, read as v2): drop_chorus (a cue), stop_outro (a stop); the section starts are left to the sections column',
      col1.some(e => e.id === 'drop_chorus' && e.kind === 'k-cue') && col1.some(e => e.id === 'stop_outro' && e.kind === 'k-stop') && !col1.some(e => /^section_/.test(e.id)), col1);

    // 2. an agent's event: proposed (dashed, "accept"); the agent cannot accept it; the director's click does
    const add = await agent('event_add', { name: 'her hi there', t: '0:05.000', kind: 'spoken', note: 'Verse, her first line' });
    const agentAccept = await agent('events_act', { act: 'accept', id: 'her_hi_there', via: 'page' });
    await until(() => !!document.querySelector('.tl .col-events .evn[data-ev="her_hi_there"].st-proposed .acc'));
    await pg.evaluate(() => window.WB.timeline.scrollToTime(0)); await frames(2);
    await shot('.tl', 'v23_events_column_proposed');
    await pg.click('.tl .col-events .evn[data-ev="her_hi_there"] .acc');
    const accepted = await until(() => window.WB.store.events.find(e => e.id === 'her_hi_there')?.status === 'accepted');
    const ev1 = readP('events.json');
    check('event_add (an agent) writes a PROPOSED event (dashed in the column, "accept"); the agent\'s events_act accept is 403 even claiming via "page"; the director\'s click accepts it; events.json is now v2 {rev, events, retimes}',
      add.status === 200 && add.body?.event?.status === 'proposed' && agentAccept.status === 403 && accepted && ev1.v === 2 && Array.isArray(ev1.events) && ev1.events.find(e => e.id === 'her_hi_there')?.accepted_by === 'director',
      { add: add.status, agentAccept: agentAccept.status, accepted });

    // 3. right-click › + Add › "+ Named event here" (the menu), then the event dialog; and "+ Named event at “word”" on a lyric word
    const y9 = await pg.evaluate(() => { const tl = window.WB.timeline; tl.scrollToTime(8000); const r = tl.sheet.getBoundingClientRect(), c = tl.byId.events; return { x: r.left + c.x + c.vw / 2, y: r.top + tl.warp.y(9000) }; });
    await frames(2);
    await pg.mouse.click(y9.x, y9.y, { button: 'right' });
    await until(() => !!document.querySelector('.pop'));
    const addRow = await pg.evaluateHandle(() => [...document.querySelectorAll('.pop .pi')].find(r => /\+ Add/.test(r.textContent)));
    await addRow.hover(); await until(() => document.querySelectorAll('.pop').length > 1);
    await wait(150);
    const pops = await pg.evaluate(() => [...document.querySelectorAll('.pop')].map(p => p.textContent));
    { const b = await pg.evaluate(() => { const ps = [...document.querySelectorAll('.pop')].map(p => p.getBoundingClientRect()); const x0 = Math.min(...ps.map(r => r.left)), y0 = Math.min(...ps.map(r => r.top)), x1 = Math.max(...ps.map(r => r.right)), y1 = Math.max(...ps.map(r => r.bottom)); return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }; });
      fs.writeFileSync(path.join(OUT, 'v23_menu_add_event.png'), await pg.screenshot({ clip: { x: Math.max(0, b.x - 120), y: Math.max(0, b.y - 20), width: b.width + 140, height: b.height + 40 } })); }
    const itemRow = await pg.evaluateHandle(() => [...document.querySelectorAll('.pop')].at(-1).querySelector('.pi:last-child') && [...[...document.querySelectorAll('.pop')].at(-1).querySelectorAll('.pi')].find(r => /Named event here/.test(r.textContent)));
    await itemRow.click();
    await until(() => !!document.querySelector('.evdlg [name=name]'));
    const dlgT = await pg.evaluate(() => document.querySelector('.evdlg [name=t]').value);
    await pg.evaluate(() => { const d = document.querySelector('.evdlg'); d.querySelector('[name=name]').value = 'beat nine'; d.querySelector('[name=kind]').value = 'cue'; d.querySelector('[name=t]').value = '0:09.000'; d.querySelector('[name=note]').value = '<img src=x onerror="window.__ev=1">'; });
    await pg.click('.evdlg [data-x=save]');
    const nine = await until(() => window.WB.store.events.some(e => e.id === 'beat_nine' && e.t === 9000 && e.kind === 'cue'));
    // a lyric word: the timeline's lyrics column
    const word = await pg.evaluate(() => { const w = [...document.querySelectorAll('.tl .col-lyrics span[data-t]')].find(s => /colour/i.test(s.textContent)); if (!w) return null; window.WB.commands.run('events.addAtWord', { target: w, line: { id: 'x' } }); return { t: Number(w.dataset.t), w: w.textContent }; });
    await until(() => !!document.querySelector('.evdlg [name=name]'));
    const wName = await pg.evaluate(() => document.querySelector('.evdlg [name=name]').value);
    await pg.click('.evdlg [data-x=save]');
    const wordEv = await until((t) => window.WB.store.events.some(e => e.t === t && e.kind === 'spoken' && /colour/.test(e.name)), word?.t);
    check('right-click › + Add › "+ Named event here" opens the event dialog at the clicked time; saved (name, kind, time, note) it is an accepted event of the director; "+ Named event at “word”" takes a lyric word\'s time and the word as its name; the note renders escaped',
      pops.some(t => /Named event here/.test(t)) && /^0:0[89]\./.test(dlgT) && nine && word && wName === word.w.replace(/[^\p{L}\p{N}' -]/gu, '').trim() && wordEv && !(await pg.evaluate(() => window.__ev)),
      { pops: pops.map(t => t.slice(0, 120)), dlgT, nine, word, wName, wordEv });

    // 4. Import events…: an audio events.json in seconds (the first film's shape) -> ms; sections skipped; existing ids kept
    await pg.evaluate(() => window.WB.commands.run('events.import'));
    await until(() => !!document.querySelector('.evdlg [name=json]'));
    await pg.evaluate(() => { const ta = document.querySelector('.evdlg [name=json]'); ta.value = JSON.stringify([{ id: 'section_x', t: 3.7, kind: 'section', note: 'x' }, { id: 'stop2_beat_cut', t: 14.25, kind: 'stop', note: 'written: 1-bar stop' }, { id: 'duet_5_both', t: 16.5, kind: 'line', note: 'Does it matter? Play your part' }, { id: 'stop_outro', t: 18, kind: 'stop' }]); ta.dispatchEvent(new Event('input')); });
    const prev = await pg.evaluate(() => document.querySelector('.evdlg .evr').textContent);
    await pg.click('.evdlg [data-x=import]');
    const imp = await until(() => ['stop2_beat_cut', 'duet_5_both'].every(id => window.WB.store.events.some(e => e.id === id)));
    const im = await pg.evaluate(() => window.WB.store.events.filter(e => ['stop2_beat_cut', 'duet_5_both', 'section_x'].includes(e.id)).map(e => [e.id, e.t, e.kind, e.source_kind || '']));
    check('Import events… reads an audio events.json in seconds (auto): stop2_beat_cut 14.25 s -> 14250 ms (stop), duet_5_both 16.5 s -> 16500 ms (a line -> voice); the section start is skipped and an existing id (stop_outro) kept',
      /2 new events/.test(prev) && imp && JSON.stringify(im) === JSON.stringify([['stop2_beat_cut', 14250, 'stop', ''], ['duet_5_both', 16500, 'voice', 'line']]), { prev, im });

    // 5. the script: the snap menu offers "events"; sc02's end anchored to stop_outro in the scene card; saved
    await pg.evaluate(() => window.WB.stages.open('script')); await until(() => !!window.WB.script?.ws);
    await pg.evaluate(() => { window.WB.script.ws.focus('sc02'); });
    await until(() => !!document.querySelector('.scrow[data-scene="sc02"] .scanc[data-edge="t1"]'));
    const snapOpts = await pg.evaluate(() => [...document.querySelectorAll('.scbar .scsnap option')].map(o => o.value));
    // the snap menu as a list (a native drop-down does not show in a headless screenshot), "events" picked
    await pg.select('.scbar .scsnap', 'events');
    await selectShot('.scbar .scsnap', 'v23_script_snap_menu');
    await pg.select('.scrow[data-scene="sc02"] .scanc[data-edge="t1"]', 'stop_outro');
    await until(() => window.WB.script.ws.scene('sc02')?.anchors?.t1 === 'stop_outro');
    await shot('.scrow[data-scene="sc02"] .sccard', 'v23_anchored_scene', 2);
    await pg.evaluate(() => window.WB.script.ws.save('anchor sc02 end to stop_outro'));
    const scSaved = await until(() => { const d = window.WB.store.scenes; return d.versions.find(v => v.id === d.current)?.scenes.find(s => s.id === 'sc02')?.anchors?.t1 === 'stop_outro'; });
    check('the script stage: the snap menu offers lines / bars / sections / EVENTS; the scene card anchors sc02\'s end to stop_outro (⚓ select) and the saved version carries anchors {t1: "stop_outro"} (scenes.json)',
      snapOpts.includes('events') && scSaved && cur('scenes.json', 'scenes').find(s => s.id === 'sc02')?.anchors?.t1 === 'stop_outro', { snapOpts, scSaved });

    // 6. the storyboard: snap "events"; s3-grid's end (the cut to s4-chorus) anchored to drop_chorus; a typed cut snaps + anchors
    await pg.evaluate(() => window.WB.stages.open('storyboard')); await until(() => !!window.WB.storyboard?.ws);
    const sbOpts = await pg.evaluate(() => [...document.querySelectorAll('.sbbar .sbsnap option')].map(o => o.value));
    await pg.select('.sbbar .sbsnap', 'events');
    const sbSnap = await pg.evaluate(() => window.WB.storyboard.ws.snap);
    await selectShot('.sbbar .sbsnap', 'v23_storyboard_snap_menu');
    await pg.evaluate(() => { const w = window.WB.storyboard.ws; w.setSide?.('shot'); w.select('s3-grid'); w.render(); });
    await until(() => !!document.querySelector('.sbside .sbanc[data-edge="t1"]'));
    await pg.select('.sbside .sbanc[data-edge="t1"]', 'drop_chorus');
    await until(() => window.WB.storyboard.ws.shot('s3-grid')?.anchors?.t1 === 'drop_chorus');
    await shot('.sbside .lylist', 'v23_anchored_shot');
    // snap "events": s2-wall's end typed at 8.6 s snaps to beat_nine (9.0 s) and anchors to it (s3-grid's start follows)
    await pg.evaluate(() => { const w = window.WB.storyboard.ws; w.select('s2-wall'); w.render(); });
    await until(() => !!document.querySelector('.sbside .sbin-t1'));
    await pg.evaluate(() => { const i = document.querySelector('.sbside .sbin-t1'); i.value = '0:08.600'; i.dispatchEvent(new Event('change', { bubbles: true })); });
    const snapped = await until(() => { const w = window.WB.storyboard.ws, a = w.shot('s2-wall'), b = w.shot('s3-grid'); return a?.t1 === 9000 && a.anchors?.t1 === 'beat_nine' && b?.t0 === 9000 && b.anchors?.t0 === 'beat_nine'; });
    await pg.evaluate(() => window.WB.storyboard.ws.save('anchor cuts'));
    const sbSaved = await until(() => { const sh = window.WB.store.boardShots(); return sh.find(s => s.id === 's3-grid')?.anchors?.t1 === 'drop_chorus'; });
    const sb1 = cur('storyboard.json', 'shots');
    check('the storyboard: the snap menu offers beats / bars / EVENTS / off; the shot panel anchors s3-grid\'s end (the cut to s4-chorus) to drop_chorus; with snap "events" a cut typed at 8.6 s lands on beat_nine (9.0 s) and both shots sharing it are anchored; the saved version carries the anchors',
      sbOpts.includes('events') && sbSnap === 'events' && snapped && sbSaved && sb1.find(s => s.id === 's3-grid')?.anchors?.t1 === 'drop_chorus' && sb1.find(s => s.id === 's2-wall')?.anchors?.t1 === 'beat_nine' && sb1.find(s => s.id === 's3-grid')?.t0 === 9000,
      { sbOpts, sbSnap, snapped, sbSaved, s2: sb1.find(s => s.id === 's2-wall'), s3: sb1.find(s => s.id === 's3-grid') });

    // 7. measuring: drag stop_outro in the events column (measured follows the pointer), then type it; = playhead for drop_chorus
    await pg.evaluate(() => window.WB.app.show('timeline')); await frames(3);
    const drag = await pg.evaluate(() => { const tl = window.WB.timeline; tl.scrollToTime(16500); const e = document.querySelector('.tl .col-events .evn[data-ev="stop_outro"]'), r = e.getBoundingClientRect(), s = tl.sheet.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 4, y2: s.top + tl.warp.y(18600) }; });
    await frames(2);
    const d0 = await pg.evaluate(() => { const e = document.querySelector('.tl .col-events .evn[data-ev="stop_outro"]').getBoundingClientRect(); return { x: e.left + 20, y: e.top + 4 }; });
    await pg.mouse.move(d0.x, d0.y); await pg.mouse.down(); await pg.mouse.move(d0.x, d0.y + 10, { steps: 2 });
    const y2 = await pg.evaluate(() => { const tl = window.WB.timeline; return tl.sheet.getBoundingClientRect().top + tl.warp.y(18600); });
    await pg.mouse.move(d0.x, y2, { steps: 6 }); await pg.mouse.up();
    const dragged = await until(() => { const e = window.WB.store.events.find(x => x.id === 'stop_outro'); return Number.isFinite(e?.measured) && Math.abs(e.measured - 18600) < 120 && e.t === 18000; });
    const dm = await pg.evaluate(() => window.WB.store.events.find(x => x.id === 'stop_outro').measured);
    await until(() => !!document.querySelector('.tl .col-events .evg[data-ev="stop_outro"]'));
    await shot('.tl', 'v23_events_measured');
    await pg.evaluate(() => window.WB.events.edit('stop_outro'));
    await until(() => !!document.querySelector('.evdlg [name=measured]'));
    const tLocked = await pg.evaluate(() => document.querySelector('.evdlg [name=t]').disabled);
    await pg.evaluate(() => { document.querySelector('.evdlg [name=measured]').value = '0:18.250'; });
    await pg.click('.evdlg [data-x=save]');
    const typed = await until(() => window.WB.store.events.find(x => x.id === 'stop_outro')?.measured === 18250);
    await pg.evaluate(() => window.WB.timeline.seek(11900));
    await pg.evaluate(() => window.WB.commands.run('events.measurePlayhead', { item: 'event:drop_chorus' }));
    const ph = await until(() => window.WB.store.events.find(x => x.id === 'drop_chorus')?.measured === 11900);
    check('measuring: dragging stop_outro in the events column sets its measured time (≈ 18.6 s, a ghost row "measured"; its time stays 18.0 s while boundaries are anchored: the dialog locks it); typed 0:18.250 in the dialog; "Measured = playhead" sets drop_chorus to 11.9 s',
      dragged && tLocked && typed && ph, { dragged, dm, tLocked, typed, ph });

    // 8. Re-time after the take…: the preview, Apply = one undoable change, Ctrl+Z, redo
    const sc0 = readP('scenes.json').current, sb0 = readP('storyboard.json').current;
    await pg.evaluate(() => window.WB.commands.run('events.retime'));
    await until(() => !!document.querySelector('.evdlg .rtrows'));
    const rows = await pg.evaluate(() => [...document.querySelectorAll('.evdlg .rtrows tr[data-row]')].map(r => [r.dataset.row, r.querySelector('.old').textContent, r.querySelector('.new').textContent, r.querySelector('.why').textContent]));
    await shot('.evdlg', 'v23_retime_preview');
    const want = { 'scene:sc02:t1': ['0:18.000', '0:18.250', 'anchored'], 'scene:sc03:t0': ['0:18.000', '0:18.250', 'shares'], 'shot:s4-chorus:t1': ['0:18.000', '0:18.250', 'shares'], 'shot:s5-outro:t0': ['0:18.000', '0:18.250', 'shares'],
      'shot:s3-grid:t1': ['0:12.000', '0:11.900', 'anchored'], 'shot:s4-chorus:t0': ['0:12.000', '0:11.900', 'anchored'] };
    const rowsOk = Object.entries(want).every(([k, [a, b, w]]) => rows.some(r => r[0] === k && r[1] === a && r[2] === b && r[3].includes(w))) && rows.length === Object.keys(want).length;
    const undoN = await pg.evaluate(() => window.WB.history.undoStack.length);
    // review #3 M2: the held items (shared cuts, approved shots) are ticked one by one first
    await pg.evaluate(() => { for (const i of document.querySelectorAll('.evdlg .rtmine input[data-held]')) i.click(); });
    await pg.click('.evdlg [data-x=apply]');
    const applied = await until(() => /applied rt/.test(document.querySelector('.evdlg .rtres')?.textContent || ''));
    const res = await pg.evaluate(() => document.querySelector('.evdlg .rtres')?.textContent);
    await until(() => window.WB.store.events.find(e => e.id === 'stop_outro')?.t === 18250);
    const scA = cur('scenes.json', 'scenes'), sbA = cur('storyboard.json', 'shots'), evA = readP('events.json');
    const one = await pg.evaluate((n) => window.WB.history.undoStack.length === n + 1 && /re-time rt/.test(window.WB.history.undoStack.at(-1).label), undoN);
    const appliedOk = applied && readP('scenes.json').current !== sc0 && readP('storyboard.json').current !== sb0
      && scA.find(s => s.id === 'sc02').t1 === 18250 && scA.find(s => s.id === 'sc03').t0 === 18250 && scA.find(s => s.id === 'sc02').anchors?.t1 === 'stop_outro'
      && sbA.find(s => s.id === 's3-grid').t1 === 11900 && sbA.find(s => s.id === 's4-chorus').t0 === 11900 && sbA.find(s => s.id === 's4-chorus').t1 === 18250 && sbA.find(s => s.id === 's5-outro').t0 === 18250
      && evA.events.find(e => e.id === 'stop_outro').t === 18250 && evA.events.find(e => e.id === 'stop_outro').measured == null && evA.events.find(e => e.id === 'drop_chorus').t === 11900
      && evA.retimes.at(-1)?.status === 'applied' && evA.retimes.at(-1).by === 'director';
    check('Re-time after the take…: the preview lists every boundary anchored to the measured events and the cuts that share them, old -> new (sc02 end 18.000 -> 18.250 anchored, sc03 start / s4-chorus end / s5-outro start shared; s3-grid end and s4-chorus start 12.000 -> 11.900, both anchored: the shot panel anchors the cut); Apply writes ONE change: a new scenes and a new storyboard version, the events at their new times (measured cleared), one undo step',
      rowsOk && appliedOk && one, { rows, res, scenes: [sc0, readP('scenes.json').current], board: [sb0, readP('storyboard.json').current], one });
    await pg.evaluate(() => document.querySelector('.evback')?.remove());
    await pg.evaluate(() => { window.WB.history.undo(); });
    if (await until(() => !!document.querySelector('.pal .pr'), null, 3000)) await pg.keyboard.press('Enter');   // the confirm of the held items
    const undone = await until(() => window.WB.store.events.find(e => e.id === 'stop_outro')?.t === 18000);
    const scU = cur('scenes.json', 'scenes'), sbU = cur('storyboard.json', 'shots'), evU = readP('events.json');
    const undoOk = undone && scU.find(s => s.id === 'sc02').t1 === 18000 && sbU.find(s => s.id === 's3-grid').t1 === 12000 && sbU.find(s => s.id === 's5-outro').t0 === 18000
      && evU.events.find(e => e.id === 'stop_outro').measured === 18250 && evU.retimes.at(-1).status === 'undone';
    await pg.evaluate(() => { window.WB.history.redo(); });
    if (await until(() => !!document.querySelector('.pal .pr'), null, 3000)) await pg.keyboard.press('Enter');
    const redone = await until(() => window.WB.store.events.find(e => e.id === 'stop_outro')?.t === 18250);
    check('Ctrl+Z undoes the re-time (new versions with the old times; the events back and pending again: measured kept); redo applies it again',
      undoOk && redone && cur('scenes.json', 'scenes').find(s => s.id === 'sc02').t1 === 18250, { undone, redone, sc02: scU.find(s => s.id === 'sc02'), rt: evU.retimes.at(-1)?.status });

    // 9. the agent proposes a re-time; it cannot apply it (403); the director applies it from the dialog
    const prop = await agent('retime_propose', { moves: [{ event: 'stop_outro', to: '0:18.500' }], why: 'the take: the kick stops 250 ms later (stems)' });
    const agentApply = await agent('retime_apply', { retime: prop.body?.retime, via: 'page' }), agentApply2 = await agent('retime_apply', { moves: [{ event: 'stop_outro', to: 18500 }] });
    const untouched = cur('scenes.json', 'scenes').find(s => s.id === 'sc02').t1 === 18250;
    await until((id) => window.WB.store.eventsDoc.retimes.some(r => r.id === id && r.status === 'proposed'), prop.body?.retime);
    await pg.evaluate(() => window.WB.commands.run('events.retime'));
    await until(() => !!document.querySelector('.evdlg .prop[data-rt]'));
    await shot('.evdlg', 'v23_retime_agent_proposal');
    await pg.evaluate(() => { for (const i of document.querySelectorAll('.evdlg .prop input[data-held]')) i.click(); });
    await pg.click('.evdlg .prop [data-x=rtapply]');
    const propApplied = await until(() => window.WB.store.events.find(e => e.id === 'stop_outro')?.t === 18500);
    const evP = readP('events.json');
    check('retime_propose (an agent) records a proposed re-time with its plan and moves nothing; the agent\'s retime_apply is 403 (by record or by moves, even claiming via "page"); the dialog shows the proposal and the director applies it (sc02 end -> 18.5 s)',
      prop.status === 200 && prop.body?.plan?.rows?.length >= 2 && untouched && agentApply.status === 403 && agentApply2.status === 403 && propApplied
      && cur('scenes.json', 'scenes').find(s => s.id === 'sc02').t1 === 18500 && evP.retimes.find(r => r.id === prop.body.retime)?.status === 'applied',
      { prop: prop.status, err: prop.body?.error, rows: prop.body?.plan?.rows?.length, agentApply: agentApply.status, agentApply2: agentApply2.status, propApplied });
    await pg.evaluate(() => document.querySelector('.evback')?.remove());

    // 10. the Time view: the events on a stage's axis (a thin line per event at the timeline's y)
    await pg.evaluate(() => { window.WB.timeMode.setMode('script', 'time'); return window.WB.stages.open('script'); });
    await pg.evaluate(() => { document.querySelector('.offer, .ppoffer')?.remove(); const w = window.WB.script.ws; w.setOpen(null); w.render(); });
    await until(() => document.querySelectorAll('.sclist > .tmev').length > 0);
    await frames(3); await wait(200);
    const tm = await pg.evaluate(() => { const ax = window.WB.timeMode.axes().find(a => a.visible), m = ax?.sc.querySelector('.tmev[data-ev="stop_outro"]'); if (!m) return null; const y = new DOMMatrix(getComputedStyle(m).transform).m42; return { y, want: ax.off + ax.tl.warp.y(18500), n: ax.sc.querySelectorAll('.tmev').length }; });
    await pg.evaluate(() => { const ax = window.WB.timeMode.axes().find(a => a.visible); ax.scrollToTime(9000); }); await frames(3); await wait(200);
    await shot('.stagews', 'v23_timemode_events');
    check('the Time view draws the named events on the stage\'s axis: a thin line per event at the timeline\'s y for its time (±2 px)', tm && Math.abs(tm.y - tm.want) <= 2 && tm.n >= 4, tm);
  } catch (e) { console.error('v23 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-events.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyEvents({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v23 (named events + re-time):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
