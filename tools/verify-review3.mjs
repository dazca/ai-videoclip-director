// v28 of the headless UI suite (tools/verify.mjs): the fixes of review #3 (workbench-review/REVIEW_2026-10-05c.md) seen in the
// page, and a scripted walk-through of a NEW user: a data folder holding only _template, no agent, no fal key, and a media
// root named like a project folder ("media/"), from the first open to Final, without leaving the page:
//   1. the wizard makes the project (title, lyrics, a song file); the lyric gate is off for it (no red, no Final blocker)
//   2. Script: the intake answers are typed field after field (with letters that are shortcuts: m, p): every answer is kept
//      (scenes.json) and no shortcut fires (no marker note, no dock); a scene covers the song; Save version; scene ok;
//      "next:" leaves Script although intake questions are open (a hint now, not a blocker)
//   3. Ask the agent… ends with "Connect Claude…"; an ask with no agent connected says so with a link that opens Help ›
//      Connect Claude…, and the stage bar shows "no agent connected · Connect Claude…" inline
//   4. Storyboard: shots from beats, saved; a draft request for the first shot
//   5. Review › Queue: no fal key = "Open in another app" by default (a banner says so); Approve · $0; Run exports the prompt
//      pack; the row says what to do in one line, with Open folder and a drop zone; an image dropped there is collected
//      at $0 and becomes the shot's take
//   6. a private upload (File › Import media, the default) used as the second shot's take: Final's "an export is possible"
//      fails with a "make public…" link; the confirm explains it; then the file is public and the line passes
//   7. every shot picked (the Shot panel's Pick) and approved (Final), the asks dismissed: the checklist passes; Lock for
//      render (the stage bar's, the only Lock button); File › Export composition data writes edl.json
//   8. on a demo copy: the re-time dialog lists the approved shot and the shared cuts in red, Apply stays off until each is
//      ticked, Esc closes it; the timeline lyric column keeps a wrapped line in one block at the line's time
// Exported so verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-review3.mjs [outDir]
// Self-contained: scratch data folders, its own servers on free ports; all deleted at the end. Screenshots v28_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tinyPngB64 } from './tiny-png.mjs';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(process.env.WB_VERIFY_PORT ? Number(process.env.WB_VERIFY_PORT) + ((globalThis.__wbVerifyPortN = (globalThis.__wbVerifyPortN ?? -1) + 1) % 10) : 0, () => { const p = s.address().port; s.close(() => ok(p)); }); });

async function startServer(env, tag) {
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.log = ''; srv.stderr.on('data', d => { srv.log += d; }); srv.stdout.on('data', d => { srv.log += d; });
  await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error(`${tag} server exited ${c}: ${srv.log}`))); });
  return { srv, BASE };
}

export async function verifyReview3({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v28 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v28-')), DATA = path.join(TMP, 'data'), MB = path.join(TMP, 'mediabase');
  fs.cpSync(path.join(WB, 'data', '_template'), path.join(DATA, '_template'), { recursive: true });
  fs.mkdirSync(path.join(MB, 'media'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: ['media/'] }));   // a root named like a project folder (walk blocker 6)
  const SONG = path.join(TMP, 'song.wav');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=16', '-ar', '22050', SONG]);
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_MEDIA_BASE: MB, WORKBENCH_CONFIG: path.join(TMP, 'config.json') };
  for (const k of ['WB_TOKEN', 'WB_AGENT_TOKEN', 'FAL_KEY', 'WB_FAL_BASE', 'WB_PROJECT', 'WORKBENCH_PROJECT']) delete env[k];
  let A = null, B = null, pg = null;
  const errors = [];
  try {
    if (!fs.existsSync(SONG)) throw new Error('ffmpeg is needed (the song file of the walk)');
    A = await startServer(env, 'v28');
    pg = await browser.newPage();
    pg.on('pageerror', e => { errors.push(e.message); console.error('v28 pageerror', e.stack || e.message); });
    pg.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    await pg.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await pg.evaluate(fn, arg)) return true; } catch (e) { /* navigating */ } await wait(120); } return false; };
    const shot = async (n, sel, pad = 0) => {
      await frames(3); await wait(250);
      let clip; if (sel) clip = await pg.evaluate((s, p) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.max(0, r.left - p), y: Math.max(0, r.top - p), width: Math.min(innerWidth - Math.max(0, r.left - p), r.width + 2 * p), height: Math.min(innerHeight - Math.max(0, r.top - p), r.height + 2 * p) }; }, sel, pad);
      await pg.screenshot({ path: path.join(OUT, `${n}.png`), ...(clip && clip.width > 0 && clip.height > 0 ? { clip } : {}) });
    };
    const clickSel = async (sel) => { await pg.waitForSelector(sel, { timeout: 8000 }); const b = await pg.evaluate((s) => { const e = document.querySelector(s); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel); await pg.mouse.click(b.x, b.y); };
    const ready = () => pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    const J = (p, f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, p, f), 'utf8')); } catch (e) { return null; } };
    const confirmYes = async () => { await pg.waitForSelector('.pal .pr', { timeout: 6000 }); await pg.keyboard.press('Enter'); };   // ui.confirm: "Yes" is the first row

    // ---------------------------------------------------------------- 1. the first open: the wizard makes the project
    await pg.goto(`${A.BASE}/`, { waitUntil: 'domcontentloaded' }); await ready();
    await until(() => !!document.querySelector('.wizbg [name=title]'));
    await pg.type('.wizbg [name=title]', 'Night Walk');
    await clickSel('.wizbg [data-w=next]'); await until(() => !!document.querySelector('.wizbg [name=lyrics]'));
    await pg.type('.wizbg [name=lyrics]', '[Verse]\nwalking home at night\nthe city hums along\n\n[Chorus]\nlights go on and off');
    await clickSel('.wizbg [data-w=next]'); await until(() => !!document.querySelector('.wizbg [name=song]'));
    // G6: the song step takes a dropped file; a path on this machine sits under "or a path on this machine" (a <details>): open it
    await pg.evaluate(() => { const d = document.querySelector('.wizbg .wzpath'); if (d) d.open = true; });
    await pg.type('.wizbg [name=song]', SONG);
    await clickSel('.wizbg [data-w=create]');
    await pg.waitForFunction(() => /project=night-walk/.test(location.search) && document.body.dataset.ready === '1', { timeout: 40000 });
    const P = 'night-walk';
    await until(() => !!window.WB.stages && window.WB.stages.current() === 'lyrics', null, 10000);
    const st0 = J(P, 'settings.json'), song0 = J(P, 'song.json');
    check('walk 1: the wizard makes the project from the first open (title, lyrics, the song file); a new project starts with the lyric gate off',
      !!song0?.audio?.mix && song0.lines?.length === 3 && st0?.lyric_gate === false, { audio: song0?.audio?.mix, lines: song0?.lines?.length, gate: st0?.lyric_gate });
    await pg.evaluate(() => window.WB.stages.setStatus('lyrics', 'done')); await wait(400);

    // ---------------------------------------------------------------- 2. Script: the intake, typed field after field
    await pg.evaluate(() => window.WB.stages.open('script')); await until(() => document.querySelectorAll('.scq textarea').length === 9);
    const markers0 = (J(P, 'notes.json')?.notes || []).length;
    await clickSel('.scq[data-q=mood] textarea'); await pg.keyboard.type('moody, map of the night, pp', { delay: 15 });
    await clickSel('.scq[data-q=kind] textarea'); await pg.keyboard.type('a performance mostly', { delay: 15 });
    await clickSel('.scq[data-q=who] textarea'); await pg.keyboard.type('me, my pal', { delay: 15 });
    await clickSel('.scq[data-q=where] textarea'); await pg.keyboard.type('empty streets', { delay: 15 });
    await pg.evaluate(() => document.activeElement?.blur()); await wait(1500);
    const ik = J(P, 'scenes.json')?.intake || {};
    const typed = await pg.evaluate(() => ({ focus: document.activeElement?.tagName, dock: document.body.classList.contains('docked') || !!document.querySelector('.dock')?.offsetParent, mood: document.querySelector('.scq[data-q=mood] textarea')?.value }));
    const markers1 = (J(P, 'notes.json')?.notes || []).length;
    await shot('v28_intake', '.sgbody');
    check('walk 2 (blocker 1): four intake answers typed one field after the other are all kept (scenes.json, director / page), verbatim; the letters typed never ran as shortcuts (no marker note, no dock)',
      ik.mood?.text === 'moody, map of the night, pp' && ik.kind?.text === 'a performance mostly' && ik.who?.text === 'me, my pal' && ik.where?.text === 'empty streets' && ik.mood.via === 'page' && markers1 === markers0 && !typed.dock,
      { mood: ik.mood?.text, kind: ik.kind?.text, who: ik.who?.text, where: ik.where?.text, markers: [markers0, markers1], typed });
    // a scene over the whole song, saved, ok
    await pg.evaluate(() => window.WB.script.ws.addScene()); await wait(300);
    // its end at the song's end (the scene card's end time field)
    await pg.evaluate(() => { const S = window.WB.script.ws, s = S.draft[0]; S.setTimes(s.id, null, window.WB.store.song.duration_ms); }); await wait(300);
    await pg.evaluate(() => window.WB.script.ws.save('first draft')); await until(() => (window.WB.store.scenes?.versions || []).length >= 1);
    const sid = await pg.evaluate(() => window.WB.store.scenes.versions.at(-1).scenes[0]?.id);
    await pg.evaluate((id) => window.WB.script.ws.setStatus(id, 'ok'), sid); await wait(600);
    const next1 = await pg.evaluate(() => ({ hint: document.querySelector('#rail .next')?.textContent || '', next: window.WB.stages.view().next?.id, script: window.WB.stages.view().stages.find(s => s.id === 'script') }));
    check('walk 2 (blocker 4): with the script complete and five intake questions still open, Script is "ready to mark done" (the open questions are a hint) and the rail\'s "next:" moves on',
      next1.next !== 'script' && next1.script?.content?.status === 'ready' && next1.script.content.hints.some(h => /intake question/.test(h)) && !/next: Script/.test(next1.hint), { hint: next1.hint, next: next1.next, script: next1.script?.content });
    await pg.evaluate(() => window.WB.stages.setStatus('script', 'done')); await wait(300);

    // ---------------------------------------------------------------- 3. Ask the agent… with no agent connected
    await pg.evaluate(() => window.WB.agent.refresh(true)); await wait(400);
    await clickSel('.sgbar [data-ask]'); await until(() => document.querySelectorAll('.pop .pi').length > 1);
    const askItems = await pg.evaluate(() => [...document.querySelectorAll('.pop .pi .lb')].map(e => e.textContent));
    await shot('v28_ask_menu', '.pop', 4);
    await pg.evaluate(() => [...document.querySelectorAll('.pop .pi')].find(e => /^Draft the scenes/.test(e.textContent))?.click());
    await until(() => [...document.querySelectorAll('#toasts .toast')].some(t => /No agent connected/.test(t.textContent)), null, 6000);
    const inline = await pg.evaluate(() => document.querySelector('.sgbar [data-connect]')?.textContent || '');
    await shot('v28_ask_no_agent');
    await pg.evaluate(() => [...document.querySelectorAll('#toasts .toast .toasta')].find(a => /Connect Claude/.test(a.textContent))?.click());
    const dlg = await until(() => !!document.querySelector('.wbdlg[data-dlg=connect]'), null, 6000);
    await shot('v28_connect_from_ask', '.wbdlg[data-dlg=connect]', 4);
    await pg.keyboard.press('Escape'); await wait(200);
    check('walk 3 (blocker 3): "Ask the agent…" lists the asks without repeating the prefix and ends with "Connect Claude…"; an ask with no agent connected toasts "No agent connected" with a link that opens Help › Connect Claude…; the stage bar shows it inline',
      askItems.at(-1)?.startsWith('Connect Claude') && askItems.every(a => !/^Ask the agent/.test(a)) && /no agent connected/.test(inline) && dlg, { askItems, inline, dlg });

    // ---------------------------------------------------------------- 4. Storyboard: shots from beats, a request for the first shot
    await pg.evaluate(() => window.WB.stages.open('storyboard')); await wait(600);
    await pg.evaluate(() => window.WB.commands.run('storyboard.fromBeats')); await wait(500);
    await pg.evaluate(() => window.WB.storyboard.ws.save('first shots')); await until(() => (window.WB.store.board?.versions || []).length >= 1, null, 8000);
    const shots = await pg.evaluate(() => window.WB.store.boardShots().map(s => s.id));
    // keep two shots (merge the rest into the second) so the walk stays short
    if (shots.length > 2) { await pg.evaluate(async (ids) => { const S = window.WB.storyboard.ws; for (const id of ids.slice(2).reverse()) { S.select(ids[1], { seek: false }); await window.WB.commands.run('storyboard.merge', { shotId: ids[1] }); } }, shots); await wait(300); await pg.evaluate(() => window.WB.storyboard.ws.dirty && window.WB.storyboard.ws.save('two shots')); await wait(600); }
    const two = await pg.evaluate(() => window.WB.store.boardShots().map(s => s.id));
    await pg.evaluate((id) => window.WB.storyboard.ws.requestGen(id), two[0]); await until(() => (window.WB.store.requests?.items || []).some(r => r.status === 'draft'), null, 8000);
    const req = await pg.evaluate(() => window.WB.store.requests.items.find(r => r.status === 'draft'));
    check('walk 4: shots from beats, saved; a draft request for the first shot from its panel', two.length >= 1 && !!req && req.target === 'shot:' + two[0], { shots, two, req: req && { id: req.id, target: req.target, est: req.est_cost } });

    // ---------------------------------------------------------------- 5. Review › Queue: Open in another app, the drop zone
    await pg.evaluate(() => window.WB.app.show('queue')); await until(() => !!document.querySelector('.queue .qnokey'), null, 8000);
    const banner = await pg.evaluate(() => document.querySelector('.queue .qnokey')?.textContent || '');
    await until((id) => !!document.querySelector(`.queue tr[data-id="${id}"] [data-x=approve0]`), req.id, 6000);
    await clickSel(`.queue tr[data-id="${req.id}"] [data-x=approve0]`); await until((id) => window.WB.store.requests.items.find(r => r.id === id)?.status === 'approved', req.id, 8000);
    await clickSel(`.queue tr[data-id="${req.id}"] [data-x=run]`);
    await until((id) => !!window.WB.store.requests.items.find(r => r.id === id)?.handoff, req.id, 15000);
    await until((id) => !!document.querySelector(`.queue tr[data-id="${id}"] .qdrop`), req.id, 8000);
    const ho = await pg.evaluate((id) => { const r = document.querySelector(`.queue tr[data-id="${id}"]`); return { line: r.querySelector('.qhol')?.textContent || '', drop: !!r.querySelector('.qdrop input[type=file]'), reveal: !!r.querySelector('[data-x=reveal]'), copy: !!r.querySelector('[data-x=copy]') }; }, req.id);
    await shot('v28_queue_handoff', `.queue tr[data-id="${req.id}"]`, 6);
    const pngFile = path.join(TMP, 'made-elsewhere.png'); fs.writeFileSync(pngFile, Buffer.from(tinyPngB64(320, 180, [40, 90, 160]), 'base64'));
    const input = await pg.$(`.queue tr[data-id="${req.id}"] .qdrop input[type=file]`); await input.uploadFile(pngFile);
    await until((id) => window.WB.store.requests.items.find(r => r.id === id)?.status === 'done', req.id, 20000);
    const done = J(P, 'requests.json').items.find(r => r.id === req.id);
    check('walk 5 (blocker 5): with no fal key the Queue says "Open in another app" is the default; Approve · $0; Run exports the pack; the row gives one line of steps, Copy prompt, Open folder and a drop zone; the image dropped there is collected: done at $0, an output of the request',
      /No fal key/.test(banner) && done?.status === 'done' && (done.outputs || []).length === 1 && Number(done.actual_cost_usd || 0) === 0 && /Copy prompt/.test(ho.line) && /drop them here/.test(ho.line) && ho.drop && ho.reveal && ho.copy,
      { banner: banner.slice(0, 80), ho, done: done && { status: done.status, outputs: done.outputs, cost: done.actual_cost_usd, why: done.why } });

    // ---------------------------------------------------------------- 6. a private upload used as the second shot's take, made public
    const second = two[1] || two[0];
    await pg.evaluate(() => window.WB.commands.run('file.importMedia')); await until(() => !!document.querySelector('.imdlg'));
    await pg.evaluate(async (b64) => { const f = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'street photo.png', { type: 'image/png' }); const dt = new DataTransfer(); dt.items.add(f); document.querySelector('.imdlg .imdrop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, tinyPngB64(320, 180, [200, 120, 60]));
    await until(() => document.querySelectorAll('.imrow:not(.bad)').length === 1);
    const privTick = await pg.evaluate(() => document.querySelector('.imrow [data-f=private]')?.checked);
    await clickSel('.imdlg [data-x=import]');
    await until(() => (window.WB.store.media || []).some(m => /street-photo/.test(m.path)), null, 10000);
    const up = await pg.evaluate(() => window.WB.store.media.find(m => /street-photo/.test(m.path)));
    await pg.keyboard.press('Escape'); await wait(200);
    await pg.evaluate(async (m, s) => window.WB.store.op('media_use', { media: m, as: 'take', shot: s }), up.id, second);   // Use as… › Take of shot (the menu's own call)
    // pick both takes in the Shot panel
    await pg.evaluate(() => window.WB.stages.open('storyboard')); await wait(500);
    const pick = async (sh) => {
      await pg.evaluate((s) => window.WB.storyboard.ws.select(s, { seek: false }), sh); await until(() => !!document.querySelector('.sbins .tkc .tkl'), null, 8000);
      await clickSel('.sbins .tkc .tkl'); await until(() => !!document.querySelector('.sbins [data-tk-a=pick]'));
      await clickSel('.sbins [data-tk-a=pick]');
      return until((s) => !!window.WB.store.boardShots().find(x => x.id === s)?.clip, sh, 8000);
    };
    const pk1 = await pick(two[0]), pk2 = second !== two[0] ? await pick(second) : true;
    await pg.evaluate(() => window.WB.stages.open('final')); await until(() => !!document.querySelector('.fnci[data-ck=export]'));
    const ex0 = await pg.evaluate(() => { const e = document.querySelector('.fnci[data-ck=export]'); return { ok: e.classList.contains('ok'), text: e.textContent.replace(/\s+/g, ' ').trim().slice(0, 200), pub: !!e.querySelector('[data-pub]') }; });
    await shot('v28_final_private', '.fnci[data-ck=export]', 6);
    await clickSel('.fnci[data-ck=export] [data-pub]');
    await pg.waitForSelector('.wbdlg[data-dlg=publish] [data-cf=yes]', { timeout: 6000 });
    const conf = await pg.evaluate(() => document.querySelector('.wbdlg[data-dlg=publish]')?.textContent.replace(/\s+/g, ' ') || '');
    await shot('v28_make_public_confirm', '.wbdlg[data-dlg=publish]', 4);
    await clickSel('.wbdlg[data-dlg=publish] [data-cf=yes]');
    await until((id) => window.WB.store.media.find(m => m.id === id)?.private === false, up.id, 10000);
    await until(() => document.querySelector('.fnci[data-ck=export]')?.classList.contains('ok'), null, 10000);
    const mPub = J(P, 'media.json').items.find(m => m.id === up.id), clip2 = J(P, 'storyboard.json'), cur2 = clip2.versions.find(v => v.id === clip2.current).shots.find(s => s.id === second);
    const ex1 = await pg.evaluate(() => document.querySelector('.fnci[data-ck=export]')?.classList.contains('ok'));
    check('walk 6 (blocker 2): an upload is private by default; used as a take it fails Final\'s "an export is possible" with a "make public…" link; its confirm says what public means; then the file is in media/still/ (not private), the pick follows it and the line passes',
      privTick === true && up?.private === true && pk1 && pk2 && !ex0.ok && ex0.pub && /exported/.test(conf) && /private photo/.test(conf) && mPub?.private === false && /^media\/still\//.test(mPub.path) && fs.existsSync(path.join(DATA, P, mPub.path))
      && cur2?.clip?.file === mPub.path && ex1,
      { privTick, up: up && { path: up.path, private: up.private }, pk: [pk1, pk2], ex0, conf: conf.slice(0, 120), now: mPub && { path: mPub.path, private: mPub.private }, clip: cur2?.clip?.file, ex1 });

    // ---------------------------------------------------------------- 7. approve, dismiss the asks, lock, export
    for (const sh of two) {
      await until((k) => !!document.querySelector(`.fnrow[data-key="shot:${k}"] [data-x=approve]`), sh, 6000);
      await pg.evaluate((k) => document.querySelector(`.fnrow[data-key="shot:${k}"] [data-x=approve]`)?.click(), sh); await wait(500);
    }
    // the asks written in step 3 wait for an agent: the director dismisses them (their own notes)
    await pg.evaluate(async () => { for (const n of window.WB.store.notes.notes.filter(x => x.status === 'open')) await window.WB.store.noteStatus(n.id, 'dismissed'); });
    await until(() => [...document.querySelectorAll('.fnci')].every(c => c.classList.contains('ok')), null, 12000);
    const ck = await pg.evaluate(() => [...document.querySelectorAll('.fnci')].map(c => `${c.dataset.ck}:${c.classList.contains('ok') ? 'ok' : 'NO ' + c.textContent.replace(/\s+/g, ' ').slice(0, 90)}`));
    const lockBtns = await pg.evaluate(() => [...document.querySelectorAll('button')].filter(b => /^Lock for render/.test(b.textContent.trim()) && b.offsetParent).length);
    await shot('v28_final_ready');
    await clickSel('.sgbar [data-slot=primary]'); await until(() => !!document.querySelector('.fnconf [data-x=confirm]'));
    await clickSel('.fnconf [data-x=confirm]'); await until(() => !!window.WB.store.revisions?.lock, null, 10000);
    await pg.evaluate(() => window.WB.commands.run('file.exportComposition')); await until(() => !!document.querySelector('.cxdlg [data-x=export]'));
    await clickSel('.cxdlg [data-x=export]');
    const edlF = path.join(DATA, P, 'exports', 'composition', 'edl.json');
    const t0 = Date.now(); while (!fs.existsSync(edlF) && Date.now() - t0 < 8000) await wait(150);
    const edl = fs.existsSync(edlF) ? JSON.parse(fs.readFileSync(edlF, 'utf8')) : null;
    await shot('v28_final_locked');
    check('walk 7: every shot picked and approved, the asks dismissed: Final\'s checklist passes; one Lock for render (the stage bar\'s) locks it; File › Export composition data writes edl.json with both shots picked: a new user reached Final with no agent, no fal key and nothing done outside the page',
      ck.every(c => /:ok$/.test(c)) && lockBtns === 1 && !!J(P, 'revisions.json')?.lock && edl?.shots?.length === two.length && edl.shots.every(s => s.status === 'picked'),
      { ck, lockBtns, lock: !!J(P, 'revisions.json')?.lock, edl: edl?.shots?.map(s => `${s.id}:${s.status}`) });
    check('walk 6 (blocker 6): the media root "media/" is ignored (named like a project folder), so the uploads landed in the project and are served from it', /media root\(s\) media\/ ignored/.test(A.srv.log) && fs.existsSync(path.join(DATA, P, mPub?.path || 'x')), { log: A.srv.log.split('\n').find(l => /media root/.test(l))?.slice(0, 140) });

    // ---------------------------------------------------------------- 8. a demo copy: the re-time dialog, the lyric column
    const D2 = path.join(TMP, 'data2'); fs.cpSync(path.join(WB, 'data', 'demo'), path.join(D2, 'demo'), { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
    fs.writeFileSync(path.join(TMP, 'config2.json'), JSON.stringify({ media_roots: [] }));
    B = await startServer({ ...env, WORKBENCH_DATA: D2, WORKBENCH_CONFIG: path.join(TMP, 'config2.json'), WB_PROJECT: 'demo' }, 'v28b');
    await pg.goto(`${B.BASE}/?project=demo`, { waitUntil: 'domcontentloaded' }); await ready();
    await pg.evaluate(async () => {
      await window.WB.store.op('events_act', { act: 'add', id: 'cut_one', name: 'cut one', t: 4000, kind: 'cue' });
    });
    const agentTok = fs.readFileSync(path.join(D2, '.wb-agent-token'), 'utf8').trim();
    await fetch(`${B.BASE}/api/op/shots_update?project=demo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-agent-token': agentTok }, body: JSON.stringify({ upsert: [{ id: 's1-intro', anchors: { t1: 'cut_one' } }] }) });
    await pg.evaluate(() => window.WB.store.op('events_act', { act: 'measure', id: 'cut_one', measured: 4400 }));
    await wait(800);
    await pg.evaluate(() => window.WB.events.openRetime()); await until(() => !!document.querySelector('.evdlg .rtheld'));
    const rt0 = await pg.evaluate(() => ({ held: [...document.querySelectorAll('.evdlg .rtmine input[data-held]')].map(i => i.dataset.held), off: document.querySelector('.evdlg [data-x=apply]')?.disabled, caps: getComputedStyle(document.querySelector('.evdlg h4')).textTransform }));
    await shot('v28_retime_held', '.evdlg', 4);
    for (const k of rt0.held.slice(0, -1)) await pg.evaluate((x) => document.querySelector(`.evdlg .rtmine input[data-held="${x}"]`).click(), k);
    const partial = await pg.evaluate(() => document.querySelector('.evdlg [data-x=apply]')?.disabled);
    await pg.evaluate((x) => document.querySelector(`.evdlg .rtmine input[data-held="${x}"]`).click(), rt0.held.at(-1));
    const allOn = await pg.evaluate(() => document.querySelector('.evdlg [data-x=apply]')?.disabled === false);
    await pg.mouse.click(5, 5); await wait(100);   // the focus outside the dialog: Esc still closes it
    await pg.keyboard.press('Escape'); await wait(200);
    const closed = await pg.evaluate(() => !document.querySelector('.evback'));
    check('M2 in the page: the re-time preview lists the approved shot and the shared cuts in red; Apply stays off until every one is ticked; Esc closes the dialog wherever the focus is; the headings are not in capitals',
      rt0.held.includes('shot:s1-intro') && rt0.held.length >= 2 && rt0.off === true && partial === true && allOn && closed && rt0.caps !== 'uppercase', { rt0, partial, allOn, closed });
    // the lyric column in a narrow layout (the dock open): a wrapped line is ONE block at the line's time
    await pg.evaluate(() => window.WB.app.show('timeline')); await wait(400);
    await pg.evaluate(() => window.WB.timeline.setWidth('lyrics', 70)); await wait(500);
    const ly = await pg.evaluate(() => { const its = [...document.querySelectorAll('.col-lyrics .vl')]; const multi = its.filter(e => e.querySelectorAll('.vr').length > 1); const ids = its.map(e => e.dataset.line); return { n: its.length, unique: new Set(ids).size === ids.length, multi: multi.length, lines: window.WB.store.song.lines.length, align: window.WB.alignTest?.().pass }; });
    await shot('v28_lyrics_wrapped', '.col-lyrics', 0);
    check('UX 1: a lyric line that wraps in a narrow lyrics column stays one block (its rows stacked) at the line\'s time: one block per line, aligned with the other columns',
      ly.n === ly.lines && ly.unique && ly.multi > 0 && ly.align !== false, ly);
    check('no page errors', !errors.length, errors.slice(0, 5));
  } catch (e) { check('v28 ran to the end', false, String(e.stack || e)); }
  finally {
    await pg?.close().catch(() => {});
    A?.srv.kill(); B?.srv.kill(); await wait(400);
    for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const puppeteer = createRequire(path.join(WB, 'package.json'))('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const exe = findChrome(); if (!exe) { console.error('no Chromium found: set CHROME_PATH'); process.exit(1); }
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots'));
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: exe, headless: true });
  let res = { pass: false, checks: {} }; try { res = await verifyReview3({ browser, OUT }); } finally { await browser.close(); }
  const n = Object.keys(res.checks).length, ok = Object.values(res.checks).filter(c => c.pass).length;
  console.log(`v28 (review #3: security in the page, the new-user walk-through with no agent and no fal key): ${res.pass ? 'all PASS' : 'FAIL'} (${ok}/${n})`);
  process.exitCode = res.pass ? 0 : 1;
}
