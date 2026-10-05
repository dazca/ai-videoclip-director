// v12 of the headless UI suite (tools/verify.mjs): SPEC v4 §2, rounds, revisions and compare (ROADMAP_v4 B6-B8), and
// the Notes column filling the width of every stage. Exported so verify.mjs runs it after the other blocks; runnable
// alone:   node tools/verify-rounds.mjs [outDir]
// Self-contained: a scratch copy of data/demo, its own server on a free port, an MCP client (the official SDK, over
// stdio, against that server); all deleted at the end. The full cycle: the director writes notes in the page (lyrics,
// script, storyboard, a character node, the timeline) -> the rail says "Round 1 · 5 open notes" -> one click on "Send
// round to Claude" (one ask, notes.json round 2, a base snapshot) -> the agent reads round_get (content inlined),
// rewrites a lyric line, moves a scene, adds a shot, proposes a new identity image (the director accepts it in the
// page), round_absorb's four notes and round_reply's one, while the rail shows its progress -> round_finish -> "Close
// revision R1" on the rail (an immutable snapshot + revisions.json) -> Review › Compare (R0 → R1: the lyric word diff,
// the scene / shot changes on the mini time line, the image A / B, every change with its note chip) -> another change
// and R2 -> restore R1 (the current state is snapshotted first; the notes are kept). Also: an agent cannot send a round,
// close or restore a revision (403; no MCP tool), the git mirror is off by default (no .history), and the Notes column
// ends at the right edge in every stage at 1600 px. Screenshots v12_*.png.
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

export async function verifyRounds({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v12 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v12-')), DATA = path.join(TMP, 'data'), P = 'rounds', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P, WB_AGENT_APPROVALS: '' };
  delete env.WB_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v12 server: ' + d));
  let pg = null, client = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
    const call = async (name, body, page = false) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN, ...(page ? { origin: BASE } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    // the agent: the MCP server over stdio, against this server
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-rounds', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* an error text */ } return { error: !!r.isError, body, text: t }; };

    pg = await browser.newPage();
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    pg.on('pageerror', e => console.error('v12 pageerror', e.stack || e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.error('v12 console', m.text()); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const shot = async (n, clip) => { await frames(3); await pg.screenshot({ path: path.join(OUT, `${n}.png`), ...(clip ? { clip } : {}) }); };
    const railShot = async (n) => { const r = await pg.evaluate(() => { const b = document.getElementById('rail').getBoundingClientRect(); return { x: 0, y: 0, width: innerWidth, height: Math.ceil(b.bottom) + 160 }; }); await shot(n, r); };
    const stage = async (id) => { await pg.evaluate((s) => window.WB.stages.open(s), id); await wait(500); await frames(3); };
    const rail = () => pg.evaluate(() => { const r = document.querySelector('#rail .rnd'); return r ? { phase: r.dataset.phase, text: r.textContent.replace(/\s+/g, ' ').trim(), btn: r.querySelector('.rbtn')?.textContent || null, dis: !!r.querySelector('.rbtn')?.disabled, chip: r.querySelector('.rvc')?.textContent || null } : null; });
    const clickRail = async (sel) => { const b = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel); if (b) await pg.mouse.click(b.x, b.y); return !!b; };

    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }); await frames(3);

    // 0. the director's own image import before the round (so the round can change the identity head: image A / B)
    const imp = await call('asset_act', { type: 'character', id: 'ada', act: 'import', tree: 'identity', media: 'ada_face' }, true);
    // the demo's two timeline notes are done already: the round takes only what the director writes now
    await pg.evaluate(() => window.WB.store.mutate('notes.json', (d) => { for (const n of d.notes) n.status = 'absorbed'; }));
    await until(() => window.WB.store.notes.notes.every(n => n.status !== 'open'));
    const r0 = await rail();

    // 1. notes in the page, on five stages
    const st = await pg.evaluate(async () => {
      const S = window.WB.store, add = (t, x) => S.noteAdd(t, x);
      const line = S.lyrics.versions.find(v => v.id === S.lyrics.current).sections.flatMap(x => x.lines)[1];
      const ids = [await add({ stage: 'lyrics', kind: 'line', id: line.id }, 'this line is flat: make it sing'),
        await add({ stage: 'script', kind: 'scene', id: 'sc02' }, 'sc02 should start on the downbeat, a bit later'),
        await add({ stage: 'storyboard', kind: 'shot', id: 's4-chorus' }, 'the chorus needs a close-up insert'),
        await add({ stage: 'characters', kind: 'node', id: 'ada/n01', pin: { x: 0.5, y: 0.3 } }, 'try the full-body photo as her identity'),
        await add({ stage: 'timeline', kind: 'time', id: null, t: 15000 }, 'a strobe on this bar?')];
      return { line: line.id, ids };
    });
    await until((k) => document.querySelector('#rail .rnd')?.textContent.includes(`${k} open notes`), 5);
    const r1 = await rail();
    await railShot('v12_round_counter');
    check('the rail shows "Round 1 · 5 open notes" and a "Send round to Claude" button (enabled); collecting = round_get says nothing was sent',
      r1?.phase === 'collecting' && /Round 1 · 5 open notes/.test(r1.text) && r1.btn === 'Send round to Claude' && !r1.dis && r0?.dis === true && imp.status === 200,
      { r0, r1, imp: imp.status });
    const g0 = await tool('round_get');

    // 2. agents cannot send or close (no tool; the op is page only)
    const tl = (await client.listTools()).tools.map(t => t.name);
    const a1 = await call('round_send', {}), a2 = await call('revision_close', {}), a3 = await call('revision_restore', { id: 'R1' });
    const a4 = await call('round_send', {}, false);
    check('an agent cannot send a round, close or restore a revision: no such MCP tool; the agent surface (no page Origin) gets 403; round_get before the send says "collecting"',
      ['round_get', 'round_absorb', 'round_reply', 'round_finish', 'revisions_get'].every(t => tl.includes(t)) && !['round_send', 'revision_close', 'revision_restore'].some(t => tl.includes(t))
      && a1.status === 403 && a2.status === 403 && a3.status === 403 && a4.status === 403 && g0.body?.status === 'collecting' && g0.body?.open === 5,
      { statuses: [a1.status, a2.status, a3.status], g0: g0.body?.status });

    // 3. one click: Send round to Claude
    await clickRail('#rail .rnd .rbtn[data-rv="send"]');
    await until(() => document.querySelector('#rail .rnd')?.dataset.phase === 'sent');
    const r2 = await rail(), N1 = J('notes.json'), RV1 = J('revisions.json'), ask = N1.notes.find(n => n.ask === 'round');
    await railShot('v12_round_sent');
    check('"Send round to Claude": ONE ask to the agent listing the five notes (targets + words), notes.json round 2, revisions.json round 1 "sent" with a base snapshot; the rail shows "Claude working" with 0 / 5',
      ask && ask.to === 'agent' && st.ids.every(id => ask.text.includes(id)) && /Lyrics: line/.test(ask.text) && N1.round === 2 && N1.notes.filter(n => n.ask === 'round').length === 1
      && RV1.rounds[0]?.status === 'sent' && RV1.rounds[0].notes.length === 5 && fs.existsSync(path.join(PD, '.snapshots', RV1.rounds[0].base)) && r2?.phase === 'sent' && /0 absorbed · 0 replied · 5 left/.test(r2.text),
      { ask: ask?.text.slice(0, 160), round: N1.round, r2 });

    // 4. the agent: round_get (content inlined), then the work, absorbing as it goes
    const g = (await tool('round_get')).body, gl = g.stages?.lyrics?.[0], gs = g.stages?.script?.[0], gc = g.stages?.characters?.[0];
    check('round_get: the round\'s notes grouped by stage, each with the content its target points at (the lyric line and version, the scene with its beats, the node image, the lyric at a timeline time)',
      g.round === 1 && g.status === 'sent' && g.becomes === 'R1' && Object.keys(g.stages).sort().join() === 'characters,lyrics,storyboard,script,timeline'.split(',').sort().join()
      && gl?.content?.line && gl.content.version && gs?.content?.beats?.length > 0 && /ada_face/.test(gc?.content?.image || '') && g.stages.timeline[0].content.time === '0:15.000',
      { stages: Object.keys(g.stages || {}), lyric: gl?.content, node: gc?.content });
    const ly = (await tool('lyrics_get')).body, secs = ly.sections.map(s => ({ label: s.label, lines: s.lines.map(l => l.id === st.line ? 'Sing it bright, sing it in square and gold' : l.text) }));
    const u1 = await tool('lyrics_update', { sections: secs, message: 'round 1: line sings' });
    const ab1 = await tool('round_absorb', { note: st.ids[0], change: { stage: 'lyrics', file: 'lyrics.json', version: u1.body?.version?.id || u1.body?.current || 'v2', summary: `line ${st.line} rewritten` } });
    const sc = (await tool('script_get')).body, s2 = sc.scenes.find(x => x.id === 'sc02');
    await tool('scenes_update', { upsert: [{ id: 'sc02', t0: s2.t0 + 1000, t1: s2.t1, title: s2.title + ' (on the downbeat)', text: s2.text, beats: s2.beats.map(b => ({ ...b, t: Math.max(b.t, s2.t0 + 1000) })) }], message: 'sc02 later' });
    await tool('round_absorb', { note: st.ids[1], change: { stage: 'script', file: 'scenes.json', summary: 'sc02 starts one beat later, on the downbeat' } });
    await until(() => /2 absorbed/.test(document.querySelector('#rail .rnd')?.textContent || ''));
    const r3 = await rail();
    await railShot('v12_round_progress');
    const sb = (await tool('storyboard_get')).body, allShots = (sb.scenes || []).flatMap(s => s.shots || []).concat(sb.shots_outside || []);
    const ch = allShots.find(x => x.id === 's4-chorus');
    const su = await tool('shots_update', { upsert: [{ scene: ch?.scene || 'sc02', t0: (ch?.t1 || 18000) - 2000, t1: ch?.t1 || 18000, kind: 'insert', title: 'close-up insert: the tone generator dial', text: 'a close-up insert for the chorus' }], message: 'chorus insert' });
    await tool('round_absorb', { note: st.ids[2], change: { stage: 'storyboard', file: 'storyboard.json', summary: 'added insert sh01 in the chorus' } });
    const prop = await tool('node_import_propose', { id: 'ada', tree: 'identity', media: 'ada_body', why: 'the full-body photo the director asked for (round 1)' });
    const pr = J('entities/characters/ada.json').iter.proposals?.find(x => x.status === 'open');
    const acc = await call('asset_act', { type: 'character', id: 'ada', act: 'import_accept', proposal: pr?.id }, true);
    await tool('round_absorb', { note: st.ids[3], change: { stage: 'characters', file: 'entities/characters/ada.json', summary: 'identity head is now the full-body image' } });
    const rep = await tool('round_reply', { note: st.ids[4], text: 'a strobe needs a render pass we do not have yet: keep it for the edit?' });
    const notInRound = await tool('round_absorb', { note: N1.notes.find(n => n.status === 'absorbed' && !n.ask)?.id, change: { stage: 'timeline', summary: 'x' } });
    const fin = await tool('round_finish', { summary: '4 notes applied (lyric line, sc02 timing, chorus insert, identity image); 1 replied (strobe)' });
    await until(() => document.querySelector('#rail .rnd')?.dataset.phase === 'finished');
    const r4 = await rail(), N2 = J('notes.json');
    await railShot('v12_round_finished');
    check('the agent absorbs (linked to the change: absorbed_in R1 + change {stage, file, summary}) and replies; the rail follows (2 absorbed · 0 replied · 3 left, then "Claude finished" 4 · 1 · 0 + "Close revision R1"); a note outside the round is refused (409); round_finish answers the ask and approves nothing',
      !ab1.error && !u1.error && st.ids.slice(0, 4).every(id => { const n = N2.notes.find(x => x.id === id); return n.status === 'absorbed' && n.absorbed_in === 'R1' && n.change?.summary; }) && N2.notes.find(x => x.id === st.ids[4]).status === 'open'
      && !rep.error && !prop.error && acc.status === 200 && !su.error && notInRound.error && /409/.test(notInRound.text) && !fin.error && N2.notes.find(n => n.id === ask.id).status === 'absorbed'
      && /2 absorbed · 0 replied · 3 left/.test(r3?.text || '') && r4?.phase === 'finished' && /4 absorbed · 1 replied · 0 left/.test(r4.text) && r4.btn === 'Close revision R1' && J('approvals.json').items['shot:sh01'] == null,
      { r3: r3?.text, r4: r4?.text, notInRound: notInRound.text.slice(0, 80), lyrics: u1.text.slice(0, 160) });

    // 5. Close revision R1 (the rail): an immutable snapshot + the index entry; the git mirror is off by default
    await clickRail('#rail .rnd .rbtn[data-rv="close"]');
    await until(() => document.querySelector('#rail .rnd')?.dataset.phase === 'collecting' && !!document.querySelector('#rail .rvc'));
    const RV2 = J('revisions.json'), R1 = RV2.revisions[0], r5 = await rail();
    const meta = JSON.parse(fs.readFileSync(path.join(PD, '.snapshots', R1.snapshot, '.meta.json'), 'utf8'));
    check('"Close revision R1": revisions.json {id R1, round 1, created, summary (the agent\'s), notes_absorbed (4), notes_replied (1), files_changed, cost_delta} + an immutable snapshot; the rail is back to "Round 2 · 1 open note" with an R1 chip; no .history (git mirror off by default)',
      R1?.id === 'R1' && R1.round === 1 && R1.notes_absorbed.length === 4 && R1.notes_replied.length === 1 && ['lyrics.json', 'scenes.json', 'storyboard.json', 'entities/characters/ada.json'].every(f => R1.files_changed.includes(f))
      && R1.cost_delta === 0 && /4 notes applied/.test(R1.summary) && meta.revision === 'R1' && meta.immutable && RV2.rounds[0].status === 'closed' && !R1.git
      && !fs.existsSync(path.join(PD, '.history')) && /Round 2 · 1 open note/.test(r5?.text || '') && r5.chip === 'R1',
      { R1: { ...R1, snapshot: undefined }, r5 });
    const http403 = await fetch(`${BASE}/data/${P}/.snapshots/${R1.snapshot}/lyrics.json`).then(r => r.status);

    // 6. Compare (the rail's chip): R0 (before round 1) -> R1
    await clickRail('#rail .rvc');
    await until(() => !!window.WB.compare?.data() && !window.WB.compare.data().error && !!document.querySelector('.cmpb h4'));
    await frames(3);
    const cmp = await pg.evaluate(() => { const d = window.WB.compare.data(), q = (s) => document.querySelectorAll(s).length;
      return { sel: window.WB.compare.sel(), lyrics: d.lyrics.lines.map(l => ({ op: l.op, notes: l.notes })), script: d.script.items.filter(x => x.st !== 'same').map(x => ({ id: x.id, st: x.st, notes: x.notes })),
        board: d.storyboard.items.filter(x => x.st !== 'same').map(x => ({ id: x.id, st: x.st })), assets: d.assets.map(a => ({ id: a.id, tree: a.tree, a: a.a?.image, b: a.b?.image, notes: a.notes })),
        ins: q('.cmpb ins'), del: q('.cmpb del'), lanes: q('.cmpln .tb.st-moved') + q('.cmpln .tb.st-added'), imgs: q('.cmpim img'), chips: q('.cmpb .cmpn'), list: q('.cmpl [data-rid]'), notes: d.notes.length }; });
    await shot('v12_compare');
    check('Compare (the R1 chip): R0 → R1 by default; the lyric line as a word diff, sc02 moved and sh01 added on the mini time line, Ada\'s identity head as image A / B, every change with the chip of the note that caused it; snapshots are not served (403)',
      cmp.sel.a === 'R0' && cmp.sel.b === 'R1' && cmp.lyrics.length === 1 && cmp.lyrics[0].op === '~' && cmp.lyrics[0].notes[0] === st.ids[0] && cmp.script.some(x => x.id === 'sc02' && x.st === 'moved' && x.notes.includes(st.ids[1]))
      && cmp.board.some(x => x.id === 'sh01' && x.st === 'added') && cmp.assets.some(a => a.id === 'ada' && /ada_face/.test(a.a) && /ada_body/.test(a.b) && a.notes.includes(st.ids[3]))
      && cmp.ins > 0 && cmp.del > 0 && cmp.lanes >= 2 && cmp.imgs >= 2 && cmp.chips >= 4 && cmp.list === 1 && cmp.notes === 4 && http403 === 403,
      cmp);
    // the three parts close up (text diff, time line diff, image A / B)
    const part = async (sel, name) => { const r = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'start' }); const b = e.getBoundingClientRect(); return { x: Math.max(0, b.left - 4), y: Math.max(0, b.top - 22), width: Math.min(innerWidth - b.left + 4, 1100), height: Math.min(innerHeight - b.top + 22, 230) }; }, sel); if (r) await shot(name, r); };
    await part('.cmpb .cmprow.opc', 'v12_compare_text');
    await part('.cmpb .cmptl', 'v12_compare_timeline');
    await part('.cmpb .cmpab', 'v12_compare_images');
    // a note chip jumps to the note (what it changed)
    const jump = await pg.evaluate((id) => { const c = document.querySelector(`.cmpb .cmpn[data-note="${id}"]`); c?.click(); return !!document.querySelector(`#cmpn-${id}.flash`); }, st.ids[1]);

    // 7. R2, then restore R1 (the current state is snapshotted first; the notes stay as they are)
    await tool('scenes_update', { upsert: [{ id: 'sc02', title: 'The wall (R2 title)' }], message: 'R2 edit' }).catch(() => null);
    const scNow = (await tool('script_get')).body.scenes.find(x => x.id === 'sc02');
    if (!/R2 title/.test(scNow.title)) await tool('scenes_update', { upsert: [{ ...scNow, title: 'The wall (R2 title)' }], message: 'R2 edit' });
    await pg.evaluate(() => window.WB.rounds.close('a checkpoint after a hand edit'));
    await until(() => window.WB.store.revisions?.revisions?.length === 2);
    await until(() => document.querySelectorAll('.cmpl [data-rid]').length === 2);
    await frames(3);
    await shot('v12_revisions');
    const notesBefore = J('notes.json').notes.length;
    const r1row = await pg.evaluate(() => { const a = document.querySelector('.cmpl [data-restore="R1"]'); const b = a.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await pg.mouse.click(r1row.x, r1row.y); await wait(150);
    const armed = await pg.evaluate(() => document.querySelector('.cmpl [data-restore="R1"]').textContent);
    await pg.mouse.click(r1row.x, r1row.y);
    await until(() => (window.WB.store.revisions?.restores || []).length === 1);
    await wait(400);
    const RV3 = J('revisions.json'), titleNow = J('scenes.json').versions.find(v => v.id === J('scenes.json').current).scenes.find(s => s.id === 'sc02').title;
    const before = RV3.restores[0]?.previous, hasBefore = before && fs.existsSync(path.join(PD, '.snapshots', before));
    check('R2 (a checkpoint) then restore R1 from the revision list (two clicks: "confirm restore?"): the files go back to R1 (sc02\'s R1 title), the state before is snapshotted first, the notes are kept, revisions.json keeps R1 and R2; the note chip jumps to its note',
      RV3.revisions.length === 2 && RV3.revisions[1].round === null && armed === 'confirm restore?' && /on the downbeat/.test(titleNow) && !/R2 title/.test(titleNow) && hasBefore && J('notes.json').notes.length === notesBefore && jump,
      { titleNow, armed, before, jump });

    // 8. the Notes column fills the width at 1600 px in every stage (no dead area to its right)
    const widths = {};
    for (const s of ['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'final']) {
      await stage(s);
      widths[s] = await pg.evaluate(() => { const c = window.WB.notesCol?.visible?.(); if (!c) return null; const l = c.layer.getBoundingClientRect(), h = c.sc.getBoundingClientRect(); return { left: Math.round(l.left), right: Math.round(l.right), w: Math.round(l.width), host: Math.round(h.right), gap: Math.round(h.right - l.right) }; });
      if (s === 'lyrics' || s === 'storyboard') await shot(`v12_width_${s}`);
    }
    check('the Notes column ends at the right edge of every stage at 1600 px (at most a scrollbar away) and is 236-800 px wide (the lyrics: what the poem leaves)',
      Object.values(widths).every(x => x && x.gap <= 18 && x.w >= 236 && x.w <= 800), widths);
  } catch (e) { console.error('v12 aborted:', e.stack || e); checks.aborted = { pass: false, detail: String(e.message || e) }; }
  finally {
    await client?.close().catch(() => {});
    await pg?.close().catch(() => {});
    srv.kill(); await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

// standalone: node tools/verify-rounds.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(WB, 'package.json')), puppeteer = require('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots')); fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  let res = { pass: false };
  try { res = await verifyRounds({ browser, OUT }); } finally { await browser.close().catch(() => {}); }
  console.log('v12 (rounds, revisions, compare):', res.pass ? 'all PASS' : 'FAIL');
  process.exitCode = res.pass ? 0 : 1;
}
