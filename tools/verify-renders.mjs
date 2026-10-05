// v27 of the headless UI suite (tools/verify.mjs): E4 render jobs, E7 song versions and the Suno brief, E8 contact sheets
// and second opinions (ROADMAP_v4).
//   E7: suno_brief over MCP (style + lyrics with section tags, the gates); a Suno take added over MCP with an LRC; the
//       Lyrics stage's "versions…" dialog: the takes, Preview (the E1 re-time preview's table: the same rows as
//       song_version_plan), a take uploaded from the page (song_upload), Use v2 (the song, the lyric timings and a new scenes /
//       storyboard version), Ctrl+Z back to v1; the Suno brief dialog with its counts
//   E4: Render settings… (the director's command: a tiny fake render, ffmpeg colour bars), an agent's render_propose, the
//       director's Render… with its confirm (free RAM vs the floor, the command as it runs), the job (log, the MP4 + a
//       contact sheet + a seams sheet registered and linked to the revision), Review › Queue's render row; the agent cannot
//       start it (no tool, 403); the full film waits for the chapters (409)
//   E8: sheet_make (storyboard, a request's takes), "Ask for a second opinion" in the sheet viewer -> a note to the agent,
//       sheets_get (each frame's context), sheet_review -> the badge; the sheets of two revisions in Review › Compare
// Exported so verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-renders.mjs [outDir]
// Self-contained: a scratch copy of data/demo, its own server on a free port, an MCP client over stdio; all deleted at the end.
// Screenshots v27_*.png (1600x900); the render's sheets are copied next to them (v27_render_sheet.jpg, v27_render_seams.jpg).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(process.env.WB_VERIFY_PORT ? Number(process.env.WB_VERIFY_PORT) + ((globalThis.__wbVerifyPortN = (globalThis.__wbVerifyPortN ?? -1) + 1) % 10) : 0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sdk = (p) => import(pathToFileURL(path.join(WB, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);
const FAKE = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptebars=size={width}x{height}:rate={fps}', '-t', '{duration}', '-pix_fmt', 'yuv420p', '{out}'];

export async function verifyRenders({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v27 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v27-')), DATA = path.join(TMP, 'data'), P = 'renders', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P, WB_TEST: '1' };
  delete env.WB_TOKEN; delete env.WB_AGENT_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v27 server: ' + d));
  let pg = null, client = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const AGENT_TOKEN = fs.readFileSync(path.join(DATA, '.wb-agent-token'), 'utf8').trim();
    const agentOp = async (name, body) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-agent-token': AGENT_TOKEN }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-renders', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* an error text */ } return { error: !!r.isError, body, text: t }; };
    const tools = (await client.listTools()).tools.map(t => t.name);

    pg = await browser.newPage();
    const errors = [];
    pg.on('pageerror', e => { errors.push(e.message); console.error('v27 pageerror', e.stack || e.message); });
    pg.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const untilFile = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (e) { /* mid-write */ } await wait(150); } return null; };
    const shot = async (n) => { await frames(3); await wait(300); await pg.screenshot({ path: path.join(OUT, `${n}.png`) }); };
    const click = (sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }, sel);
    const pageOp = (name, body) => pg.evaluate((n, b) => window.WB.store.op(n, b).then(r => ({ ok: true, r }), e => ({ ok: false, error: e.message })), name, body);
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });

    // ---------------------------------------------------------------- E7: the brief, a Suno take, preview, upload, use, undo
    const song0 = J('song.json');
    const br = await tool('suno_brief', { style: 'warm electro-pop, 120 bpm, D major; soft robotic spoken lines in the stops', exclude: 'rap, dubstep', save: true });
    const take2 = path.join(TMP, 'suno-take-2.wav'), take3 = path.join(TMP, 'upload-take-3.wav');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${(song0.duration_ms * 1.15 / 1000).toFixed(2)}`, take2]);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${(song0.duration_ms * 0.95 / 1000).toFixed(2)}`, '-c:a', 'libmp3lame', '-q:a', '6', take3.replace(/\.wav$/, '.mp3')]);
    const lrc = song0.lines.map(l => { const t = (l.t0 * 1.15 + 400) / 1000, m = Math.floor(t / 60); return `[${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(2).padStart(5, '0')}] ${l.text}`; }).join('\n');
    const add = await tool('song_version_add', { path: take2, source: 'suno', label: 'Suno take 2', lrc, suno: { title: 'Demo take 2', model: 'v6' } });
    const plan = await tool('song_version_plan', { version: 'v2' });
    check('E7 over MCP: suno_brief (style + lyrics with [section] tags, within the gates, saved); song_version_add (a Suno take with its style / lyrics prompt, its LRC lines matched; nothing moved); song_version_plan (the rows that would move); no tool uses a version',
      !br.error && br.body.ok && /^\[Intro\]/.test(br.body.lyrics) && !add.error && add.body.version.id === 'v2' && add.body.version.style?.startsWith('warm electro-pop') && add.body.version.lyrics_prompt?.includes('[Verse]')
      && add.body.version.alignment.method === 'lrc' && add.body.version.alignment.matched >= song0.lines.length - 1 && J('song.json').current_version === 'v1' && J('song.json').duration_ms === song0.duration_ms
      && !plan.error && plan.body.rows_total > 0 && !tools.includes('song_version_use') && !tools.includes('song_upload'),
      { br: br.error ? br.text : br.body.counts, add: add.error ? add.text : add.body.version.alignment, plan: plan.error ? plan.text : plan.body.summary });

    await pg.evaluate(() => window.WB.stages.open('lyrics')); await frames(3); await wait(500);
    const line = await pg.evaluate(() => document.querySelector('.lysong')?.textContent || '');
    await click('.lysong [data-a=songvers]'); await until(() => !!document.querySelector('.sgdlg'));
    await shot('v27_song_versions');
    await click('.sgdlg button[data-x=pv][data-v=v2]'); await until(() => !!document.querySelector('.sgdlg .sgpv'));
    // review #3 M2: an approved shot the take moves is held (red, one tick each): Use stays off until every one is ticked
    const tickAll = () => pg.evaluate(() => { for (const i of document.querySelectorAll('.sgdlg .sgpv input[data-held]')) if (!i.checked) i.click(); });
    const pv = await pg.evaluate(() => ({ rows: document.querySelectorAll('.sgdlg .sgpv table.rtrows tr[data-row]').length, sum: document.querySelector('.sgdlg .sgsum')?.textContent, held: document.querySelectorAll('.sgdlg .sgpv input[data-held]').length, offBefore: !!document.querySelector('.sgdlg [data-x=use][disabled]') }));
    await tickAll(); pv.use = await pg.evaluate(() => !!document.querySelector('.sgdlg [data-x=use]:not([disabled])'));
    await shot('v27_song_preview');
    check('E7 the Lyrics stage: the song line links "versions…" and "Suno brief…"; the dialog lists v1 (in use) and v2; Preview v2 shows the E1 re-time table with the same rows as song_version_plan and the held (approved) shots to tick, and Use v2 once each is ticked',
      /versions…/.test(line) && /Suno brief/.test(line) && pv.rows === Math.min(400, plan.body.rows_total) && (pv.held === 0 || pv.offBefore) && pv.use && /lyric line/.test(pv.sum || ''), { line: line.slice(0, 120), pv, planRows: plan.body?.rows_total });
    // a take uploaded from the page (song_upload, page only)
    const fi = await pg.$('.sgdlg [data-f=file]'); await fi.uploadFile(take3.replace(/\.wav$/, '.mp3'));
    await pg.select('.sgdlg [data-f=source]', 'upload');
    await pg.evaluate(() => { document.querySelector('.sgdlg [data-f=label]').value = 'take 3 (upload)'; });
    await click('.sgdlg [data-x=add]');
    const v3 = await untilFile(() => (J('song.json').versions || []).find(v => v.id === 'v3'));
    await until(() => !!document.querySelector('.sgdlg .sgpv'));
    check('E7 a take uploaded in the page: song_upload (chunks, sniffed as audio) into audio/versions/, then a version v3 (source upload, stretched to its length); the dialog previews it',
      v3?.source === 'upload' && /^audio\/versions\/upload-take-3\.mp3$/.test(v3.audio) && fs.existsSync(path.join(PD, v3.audio)) && v3.alignment.method === 'stretch' && J('song.json').current_version === 'v1', { v3 });
    await click('.sgdlg button[data-x=pv][data-v=v2]'); await until(() => /v2/.test(document.querySelector('.sgdlg .sgpv h4')?.textContent || ''));
    const Jn = (f) => { try { return J(f); } catch (e) { return null; } };
    const sc0 = Jn('scenes.json'), sb0 = Jn('storyboard.json');
    await tickAll();
    await click('.sgdlg [data-x=use]');
    const used = await untilFile(() => J('song.json').current_version === 'v2' && J('song.json'));
    await until(() => !document.querySelector('.sgdlg [data-x=use]') || /in use/.test(document.querySelector('.sgdlg tr[data-v=v2]')?.textContent || ''));
    const sc1 = J('scenes.json'), sb1 = J('storyboard.json');
    await shot('v27_song_used');
    check('E7 Use v2 in the page: the audio, the length and the beat grid follow the take, each lyric line starts where the LRC says, the scenes and shots move in ONE new scenes and storyboard version',
      used && used.audio.mix.endsWith('suno-take-2.wav') && Math.abs(used.duration_ms - song0.duration_ms * 1.15) < 60 && Math.abs(used.lines[1].t0 - (song0.lines[1].t0 * 1.15 + 400)) <= 12
      && sc1.versions.length === (sc0?.versions?.length ?? 1) + 1 && sb1.versions.length === (sb0?.versions?.length ?? 1) + 1, { dur: used?.duration_ms, l1: [song0.lines[1].t0, used?.lines?.[1]?.t0], sc: [sc0?.versions?.length, sc1.versions.length], sb: [sb0?.versions?.length, sb1.versions.length] });
    await pg.keyboard.press('Escape');
    await pg.evaluate(() => window.WB.history.undo());
    const back = await untilFile(() => J('song.json').current_version === 'v1' && J('song.json'));
    check('E7 Ctrl+Z after Use: the song is v1 again (its own timings), the boundaries back (another new version)', back && back.duration_ms === song0.duration_ms && Math.abs(back.lines[1].t0 - song0.lines[1].t0) <= 2, { dur: back?.duration_ms, l1: back?.lines?.[1]?.t0 });
    const agentUse = await agentOp('song_version_use', { version: 'v2' });
    check('E7 using a version is the director\'s: the agent token gets 403', agentUse.status === 403 && J('song.json').current_version === 'v1', { agentUse: agentUse.status });
    await pg.evaluate(() => window.WB.songs.brief()); await until(() => !!document.querySelector('.sgdlg [data-f=style]'));
    const bx = await pg.evaluate(() => ({ style: document.querySelector('.sgdlg [data-f=style]').value, lyrics: document.querySelector('.sgdlg [data-f=lyrics]').value, cnt: [...document.querySelectorAll('.sgdlg .cnt')].map(c => c.textContent), over: document.querySelectorAll('.sgdlg .cnt.over').length }));
    await shot('v27_suno_brief');
    check('E7 the Suno brief dialog: the saved style, the lyrics of the Lyrics stage with their [section] tags, each count against Suno\'s limit (style /1000, lyrics /5000), copy buttons; nothing calls Suno',
      bx.style.startsWith('warm electro-pop') && /\[Verse\]\nA square of colour/.test(bx.lyrics) && bx.cnt.some(c => / \/ 1000$/.test(c)) && bx.cnt.some(c => / \/ 5000$/.test(c)) && !bx.over, bx);
    await pg.keyboard.press('Escape');

    // ---------------------------------------------------------------- E4: settings, a proposed render, Render… with its confirm
    const ch = await tool('chapters_update', { upsert: [{ name: 'Opening', scenes: ['sc01', 'sc02'] }, { name: 'Off', scenes: ['sc03'] }] });
    const seam = ch.body.chapters?.find(c => c.id === 'c2')?.t0;
    await pg.evaluate(() => window.WB.stages.open('final')); await until(() => !!document.querySelector('.fnrend .rnh'));
    await click('.fnrend [data-rn=settings]'); await until(() => !!document.querySelector('.wbdlg [data-f=command]'));
    await pg.evaluate((cmd) => { const d = document.querySelector('.wbdlg'); d.querySelector('[data-f=command]').value = cmd.join('\n'); const set = (k, v) => { d.querySelector(`[data-n=${k}]`).value = v; }; set('min_free_mb', '64'); set('ram_wait_s', '0'); set('width', '640'); set('height', '360'); }, FAKE);
    await shot('v27_render_settings');
    await click('.wbdlg [data-x=save]');
    const cfg = await untilFile(() => { const r = J('renders.json'); return r.config?.command?.length ? r.config : null; }, 8000);
    const prop = await tool('render_propose', { scope: 'excerpt', t0: seam - 4000, t1: Math.min(song0.duration_ms, seam + 1500), why: 'the seam Opening -> Off' });
    const rid = prop.body?.request?.id;
    const as = await agentOp('render_start', { id: rid });
    check('E4 the director sets the render command in the page (Render settings…: one argument a line, placeholders); an agent proposes a render (a draft, $0, no command) and cannot start it (no tool; 403)',
      cfg?.command.join(' ') === FAKE.join(' ') && cfg.via === 'page' && !prop.error && prop.body.request.status === 'draft' && prop.body.request.kind === 'render' && as.status === 403 && !tools.includes('render_start') && !tools.includes('render_config'),
      { cfg: cfg?.command?.length, prop: prop.error ? prop.text : prop.body.request.status, as: as.status, seam, ch: ch.error ? ch.text : ch.body.chapters?.map(c => [c.id, c.t0, c.scenes]) });
    await until((id) => !!document.querySelector(`.fnrend [data-rn=start][data-id="${id}"]`), rid);
    await click(`.fnrend [data-rn=start][data-id="${rid}"]`); await until(() => !!document.querySelector('.wbdlg [data-x=go]'));
    const conf = await pg.evaluate(() => ({ text: document.querySelector('.wbdlg')?.textContent || '', cmd: [...document.querySelectorAll('.wbdlg .rncmd')].map(x => x.textContent).join(' | ') }));
    await shot('v27_render_confirm');
    const before = J('requests.json').items.find(r => r.id === rid).status;
    await click('.wbdlg [data-x=go]');
    const done = await untilFile(() => { const r = J('requests.json').items.find(x => x.id === rid); return ['done', 'failed'].includes(r.status) ? r : null; }, 60000);
    await until((id) => /rendered/.test(document.querySelector(`.fnrend [data-sel="request:${id}"]`)?.textContent || ''), rid);
    await wait(500); await shot('v27_final_renders');
    const media = J('media.json').items.filter(m => m.request === rid), sheets = J('renders.json').sheets.filter(s => s.source === rid);
    for (const s of sheets) fs.copyFileSync(path.join(PD, s.file), path.join(OUT, `v27_render_${s.kind === 'seams' ? 'seams' : 'sheet'}.jpg`));
    const log = fs.readFileSync(path.join(PD, 'renders', rid, 'render.log'), 'utf8');
    check('E4 Render… asks first (the range, free RAM against the floor, the command as it will run) and starts only on the click; the job runs the director\'s command, logs free RAM and its output, and registers the MP4 (kind render), a contact sheet and a seams sheet (the chapter seam inside the excerpt) linked to the request and revision R0; $0',
      /Free RAM now/.test(conf.text) && /smptebars=size=640x360/.test(conf.cmd) && before === 'draft' && done?.status === 'done' && done.actual_cost_usd === 0 && done.outputs.length === 3
      && media.some(m => m.kind === 'render' && m.revision === 'R0') && media.filter(m => m.kind === 'sheet').length === 2 && sheets.some(s => s.kind === 'seams' && s.seams?.[0]?.t === seam) && /free RAM \d+ MB/.test(log) && /render: ffmpeg/.test(log),
      { before, status: done?.status, why: done?.why, outputs: done?.outputs, media: media.map(m => [m.kind, m.revision]), sheets: sheets.map(s => [s.kind, s.seams]), conf: [/Free RAM now/.test(conf.text), conf.cmd.slice(0, 120)], log: [/free RAM \d+ MB/.test(log), /render: ffmpeg/.test(log)] });
    await pg.evaluate(() => window.WB.app.show('queue')); await frames(3); await wait(600);
    const qx = await pg.evaluate((id) => { const tr = document.querySelector(`tr[data-id="${id}"]`); return { row: !!tr, txt: tr?.textContent || '', sheet: !!tr?.querySelector('[data-rn=sheet]'), approve: !!tr?.querySelector('[data-x=approve], [data-x=run]') }; }, rid);
    await shot('v27_queue_render');
    check('E4 Review › Queue: the render row (kind render) shows "rendered · $0" with its Sheet / Seams / Log buttons, never Approve or Run (the runner never runs it)', qx.row && /rendered/.test(qx.txt) && qx.sheet && !qx.approve, qx);
    const full = await tool('render_propose', { scope: 'full', why: 'the whole film' });
    const fs409 = await pageOp('render_start', { id: full.body?.request?.id });
    check('E4 the etiquette: the full film waits for the chapters (render_start 409 names the chapters not rendered; the confirm offers "render the full film anyway")', !fs409.ok && /c1/.test(fs409.error) && /chapters/.test(fs409.error), { fs409: fs409.error });

    // ---------------------------------------------------------------- E8: sheets and the second opinion; Compare
    const rq = await tool('request_create', { kind: 'shot-still', target: 'shot:s2-wall', prompt: 'v27 takes', est_cost: 0.12 });
    const stills = J('media.json').items.filter(m => m.kind === 'still' && /\.(png|jpe?g)$/i.test(m.path)).slice(0, 2);
    for (const m of stills) await tool('media_update', { id: m.id, job: rq.body.id });
    const sr = await tool('sheet_make', { from: 'request', id: rq.body.id });
    const sb = await tool('sheet_make', { from: 'storyboard' });
    await pg.evaluate(() => window.WB.stages.open('final')); await frames(3);
    await pg.evaluate((id) => window.WB.renders.openSheet(id), sb.body.sheet); await until(() => !!document.querySelector('.rnview [data-x=ask]'));
    await click('.rnview [data-x=ask]');
    const askNote = await untilFile(() => J('notes.json').notes.find(n => n.about === `sheet:${sb.body.sheet}`));
    const sg = await tool('sheets_get', { sheet: sb.body.sheet }), fr = sg.body.sheets?.[0]?.frames || [];
    const wall = fr.find(f => f.shot?.id === 's2-wall');
    const rv = await tool('sheet_review', { sheet: sb.body.sheet, verdict: 'issues', items: [{ t: wall?.t, shot: 's2-wall', constant: 'continuity', ok: false, note: 'the wall frame is the test card, not the fractal wall the script asks for' }, { t: fr[0]?.t, shot: fr[0]?.shot?.id, ok: true, note: 'test card as scripted' }], note: 'one frame off the script' });
    await untilFile(() => J('renders.json').sheets.find(s => s.id === sb.body.sheet)?.reviews?.length);
    await wait(500);
    await pg.evaluate((id) => window.WB.renders.openSheet(id), sb.body.sheet); await until(() => !!document.querySelector('.rnview .rnbadge.issues'));
    await shot('v27_sheet_review');
    const badge = await pg.evaluate(() => !!document.querySelector('.rnview .rnbadge.issues') && /fractal wall/.test(document.querySelector('.rnview')?.textContent || ''));
    await pg.keyboard.press('Escape');
    check('E8 contact sheets: a request\'s takes (one tile each) and the storyboard (one tile per shot) with ffmpeg; "Ask for a second opinion" writes a note to the agent (ask review, about the sheet); sheets_get gives each frame\'s scene / shot / lyric; sheet_review comes back as the "issues" badge with its items, and absorbs the ask',
      !sr.error && sr.body.tiles === stills.length && !sb.error && sb.body.tiles >= 3 && askNote?.ask === 'review' && askNote.to === 'agent' && wall?.scene && !rv.error && rv.body.absorbed.includes(askNote.id) && badge && J('notes.json').notes.find(n => n.id === askNote.id).status === 'absorbed',
      { sr: sr.error ? sr.text : sr.body.tiles, sb: sb.error ? sb.text : sb.body.tiles, ask: askNote?.id, wall: !!wall, rv: rv.error ? rv.text : rv.body.absorbed, badge });
    const rc = await pageOp('revision_close', { summary: 'v27: the first cut reviewed' });
    const sb2 = await tool('sheet_make', { from: 'storyboard', title: 'after R1' });
    await pg.evaluate(() => window.WB.app.show('compare')); await frames(3); await wait(500);
    await pg.evaluate(() => window.WB.compare?.select('R1', 'now')); await until(() => !!document.querySelector('.cmpsheets'));
    await wait(400);
    const cx = await pg.evaluate(() => { const cols = [...document.querySelectorAll('.cmpsheets > div')]; return { cols: cols.length, cards: cols.map(c => c.querySelectorAll('.rncard').length), h: cols.map(c => c.querySelector('h5')?.textContent) }; });
    await pg.evaluate(() => document.querySelector('.cmpsheets')?.scrollIntoView({ block: 'center' })); await shot('v27_compare_sheets');
    check('E8 Review › Compare shows the sheets made at each revision side by side (R1: the sheet made after it was closed; now: the newest)', rc.ok && rc.r.id === 'R1' && sb2.body?.revision === 'R1' && cx.cols === 2 && cx.cards[0] >= 1 && cx.cards[1] >= 1, { rc: rc.ok ? rc.r.id : rc.error, sb2: sb2.body?.revision, cx });
    await pg.evaluate(() => window.WB.stages.open('final')); await frames(3); await wait(800);
    await shot('v27_final_sheets');
    check('no page errors', !errors.length, errors.slice(0, 5));
  } catch (e) { check('v27 ran to the end', false, String(e.stack || e)); }
  finally {
    await pg?.close().catch(() => {});
    await client?.close().catch(() => {});
    srv.kill(); await wait(300);
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
  let res = { pass: false, checks: {} }; try { res = await verifyRenders({ browser, OUT }); } finally { await browser.close(); }
  const n = Object.keys(res.checks).length, ok = Object.values(res.checks).filter(c => c.pass).length;
  console.log(`v27 (E4 render jobs, E7 song versions + Suno brief, E8 contact sheets + second opinions): ${res.pass ? 'all PASS' : 'FAIL'} (${ok}/${n})`);
  process.exitCode = res.pass ? 0 : 1;
}
