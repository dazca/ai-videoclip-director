// v26 of the headless UI suite (tools/verify.mjs): F7 the timeline uses the height and the width (a short song fills the
// window; every column on screen at 1280 and 1600, no sideways scroll; the preview dock DOCKED at the right narrows the
// columns instead of covering them, and floats on demand), F8 one stage bar (the same slots at the same x, the same
// wording, on every stage), F9 Help › Connect Claude… (the claude mcp add command with this checkout's path, the agent
// token's FILE (never its value), the mcp/client.mjs quick test, which is run here, a copy button each, the connection
// state), F10 About (package.json's version + the git commit), E10 the agent's interpretation under the verbatim intake
// answer and note (written over MCP, accepted and edited in the page; no tool accepts it).
// Exported so verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-layout.mjs [outDir]
// Self-contained: a scratch copy of data/demo, its own server on a free port, an MCP client over stdio; all deleted at the end.
// Screenshots v26_*.png at 1280x800 and 1600x900.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(process.env.WB_VERIFY_PORT ? Number(process.env.WB_VERIFY_PORT) + ((globalThis.__wbVerifyPortN = (globalThis.__wbVerifyPortN ?? -1) + 1) % 10) : 0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sdk = (p) => import(pathToFileURL(path.join(WB, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);
const STAGES = ['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'final'];
const SIZES = [[1280, 800], [1600, 900]];

export async function verifyLayout({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v26 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v26-')), DATA = path.join(TMP, 'data'), P = 'layout', PD = path.join(DATA, P);
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const J = (f) => JSON.parse(fs.readFileSync(path.join(PD, f), 'utf8'));
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P };
  delete env.WB_TOKEN; delete env.WB_AGENT_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v26 server: ' + d));
  let pg = null, client = null;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const AGENT_TOKEN = fs.readFileSync(path.join(DATA, '.wb-agent-token'), 'utf8').trim();
    const PAGE_TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
    const call = async (name, body) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': PAGE_TOKEN }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const { Client } = await sdk('client/index.js'), { StdioClientTransport } = await sdk('client/stdio.js');
    client = new Client({ name: 'verify-layout', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(WB, 'mcp', 'server.mjs')], env: { ...env, WORKBENCH_URL: BASE, WORKBENCH_PROJECT: P }, stderr: 'pipe' }));
    const tool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text || ''; let body = t; try { body = JSON.parse(t); } catch (e) { /* an error text */ } return { error: !!r.isError, body, text: t }; };

    pg = await browser.newPage();
    const errors = [];
    pg.on('pageerror', e => { errors.push(e.message); console.error('v26 pageerror', e.stack || e.message); });
    pg.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const shot = async (n, clip) => { await frames(3); await wait(250); await pg.screenshot({ path: path.join(OUT, `${n}.png`), ...(clip ? { clip } : {}) }); };
    const open = async (w, h) => {
      await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
      await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
      await pg.reload({ waitUntil: 'domcontentloaded' });
      await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
      await frames(3);
    };
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(WB, 'package.json'), 'utf8')).version;
    let gitCommit = null; try { gitCommit = execFileSync('git', ['describe', '--always', '--dirty', '--abbrev=7'], { cwd: WB, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch (e) { gitCommit = null; }

    for (const [W, H] of SIZES) {
      await open(W, H);
      // ---------------------------------------------------------------- F7: the timeline
      await pg.evaluate(() => window.WB.app.show('timeline')); await frames(4); await wait(300);
      const tlGeo = () => pg.evaluate(() => {
        const tl = window.WB.timeline, sc = tl.scroller, vh = sc.clientHeight - tl.headH - 4, rr = tl.root.getBoundingClientRect();
        const vis = tl.cols.filter(c => !c.hidden), notes = tl.byId.notes, nr = notes.el.getBoundingClientRect();
        const d = document.querySelector('.dock'), dr = d?.isConnected ? d.getBoundingClientRect() : null;
        return { total: Math.round(tl.warp.total), vh, filled: tl.filled, pps: +tl.ppsEff.toFixed(2), stored: tl.pxPerSec, sideways: sc.scrollWidth - sc.clientWidth, top: Math.round(sc.scrollTop), scrollable: sc.scrollHeight - sc.clientHeight,
          rootR: Math.round(rr.right), notesR: Math.round(nr.right), notesL: Math.round(nr.left), notesW: notes.vw, minW: Math.min(...vis.map(c => c.vw)), cols: vis.length,
          sep: getComputedStyle(vis[1].el).borderLeftWidth || getComputedStyle(vis[1].el).borderRightWidth, dock: dr ? { l: Math.round(dr.left), t: Math.round(dr.top), b: Math.round(dr.bottom), r: Math.round(dr.right) } : null,
          docked: document.body.classList.contains('docked'), iw: innerWidth, ih: innerHeight };
      });
      const g0 = await tlGeo();
      const al0 = await pg.evaluate(() => window.WB.alignTest());
      await shot(`v26_timeline_${W}`);
      check(`F7 ${W}: a 20 s song fills the timeline's height (axis = the visible height ±6 px, from the top), every column on screen (no sideways scroll, the notes column inside the window), columns synced`,
        g0.filled && Math.abs(g0.total - g0.vh) <= 6 && g0.top === 0 && g0.sideways <= 1 && g0.notesR <= g0.iw && g0.notesW >= 120 && al0.pass, { ...g0, align: al0.worstPx });
      // Fit song (Ctrl+0) keeps it filled; a zoom in scrolls, a zoom back out never leaves the song in the top of the window
      await pg.evaluate(() => window.WB.commands.run('view.fit')); await frames(3);
      const gf = await tlGeo();
      await pg.evaluate(() => window.WB.timeline.zoom(2)); await frames(3);
      const gz = await tlGeo();
      await pg.evaluate(() => { window.WB.timeline.zoom(0.25); }); await frames(3);
      const go = await tlGeo();
      await pg.evaluate(() => window.WB.commands.run('view.fit')); await frames(3);
      const gf2 = await tlGeo();
      check(`F7 ${W}: Fit song fills the height; a zoom in (×2) makes it scroll; an explicit zoom out is the director's (shorter than the window); Fit song fills it again`,
        gf.filled && Math.abs(gf.total - gf.vh) <= 6 && gz.total > gz.vh * 1.6 && gz.scrollable > 100 && !go.filled && go.total < go.vh * 0.8 && gf2.filled && Math.abs(gf2.total - gf2.vh) <= 6, { fit: [gf.total, gf.vh, gf.filled], zoomIn: [gz.total, gz.vh, gz.scrollable], zoomOut: [go.total, go.vh, go.filled], refit: [gf2.total, gf2.vh, gf2.filled] });
      // the dock, docked: the panes narrow, the columns re-fit; nothing covered
      await pg.evaluate(() => window.WB.commands.run('view.dock')); await frames(4); await wait(400);
      const gd = await tlGeo();
      await shot(`v26_timeline_dock_${W}`);
      check(`F7 ${W}: the preview dock opens DOCKED at the right (full height under the bars): the timeline narrows to its left edge, the notes column stays whole left of it, no sideways scroll`,
        gd.docked && gd.dock && gd.dock.r === gd.iw && gd.dock.b === gd.ih && gd.dock.t < 60 && gd.rootR <= gd.dock.l + 1 && gd.notesR <= gd.dock.l + 1 && gd.sideways <= 1 && gd.minW >= 3 && gd.notesW >= 120, gd);
      // ⇥ floats it in a corner (over the page; the panes take the width back), ⇥ again docks it
      await pg.evaluate(() => document.querySelector('.dock [data-x=dockmode]').click()); await frames(4); await wait(300);
      const gfl = await tlGeo();
      await pg.evaluate(() => document.querySelector('.dock [data-x=dockmode]').click()); await frames(4); await wait(300);
      const gre = await tlGeo();
      await pg.evaluate(() => window.WB.commands.run('view.dock')); await frames(3); await wait(200);
      const gc = await tlGeo();
      check(`F7 ${W}: ⇥ floats the dock in a corner (the timeline takes the width back), ⇥ docks it again; closing it gives the width back`,
        !gfl.docked && gfl.rootR >= gfl.iw - 1 && gfl.dock && gfl.dock.b - gfl.dock.t < gfl.ih - 100 && gre.docked && gre.rootR <= gre.dock.l + 1 && !gc.docked && gc.rootR >= gc.iw - 1 && !gc.dock, { float: gfl.dock, redock: gre.dock, closed: gc.rootR });

      // ---------------------------------------------------------------- F8: one stage bar
      const bars = {};
      for (const id of STAGES) {
        await pg.evaluate((s) => window.WB.stages.open(s), id);
        await until((s) => window.WB.stages.current() === s && document.querySelector('.sgbar')?.dataset.stage === s && !!document.querySelector('.sgbar [data-slot=round]') && !!document.querySelector(`.sghost[data-stage="${s}"]`)?.childElementCount && !!window.WB.stageActions?.[s], id);
        await wait(250);
        bars[id] = await pg.evaluate(() => {
          const bar = document.querySelector('.sgbar'), slots = [...bar.querySelectorAll(':scope > [data-slot]')];
          return { slots: slots.map(e => e.dataset.slot), x: Object.fromEntries(slots.map(e => [e.dataset.slot, Math.round(e.getBoundingClientRect().left)])), text: Object.fromEntries(slots.map(e => [e.dataset.slot, e.textContent.trim()])),
            right: Math.round(slots[slots.length - 1].getBoundingClientRect().right), w: innerWidth, h: Math.round(bar.getBoundingClientRect().height), overflow: bar.scrollWidth - bar.clientWidth };
        });
        await shot(`v26_stagebar_${id}_${W}`, { x: 0, y: 0, width: W, height: 64 });
        if (id === 'script' || id === 'final') await shot(`v26_stage_${id}_${W}`);
      }
      const SL = ['name', 'status', 'mark', 'flag', 'primary', 'ask', 'round', 'info', 'time', 'prev', 'next'];
      const B = Object.values(bars), sameX = (k) => new Set(B.map(b => b.x[k])).size === 1;
      check(`F8 ${W}: every stage has ONE stage bar with the same slots in the same order (status, Mark done | Reopen, Needs you, the primary act, Ask the agent…, Send round, info, List | Time, ‹ ›) and the buttons at the same x on every stage; the same wording; nothing overflows`,
        B.every(b => JSON.stringify(b.slots) === JSON.stringify(SL)) && ['name', 'status', 'mark', 'flag', 'primary', 'ask', 'round'].every(sameX) && B.every(b => /^(Mark done|Reopen)$/.test(b.text.mark) && b.text.flag === 'Needs you' && b.text.ask === 'Ask the agent…' && /^(Send round \d+ \(\d+\)|Round \d+: Claude working|Close revision R\d+)$/.test(b.text.round))
        && B.every(b => /^(Save version|Send edit request|Lock for render…|Unlock)$/.test(b.text.primary)) && bars.final.text.primary === 'Lock for render…' && bars.characters.text.primary === 'Send edit request' && bars.lyrics.text.next === 'Script ›' && bars.lyrics.text.prev === '' && bars.final.text.next === '' && B.every(b => b.right <= b.w && b.h === 20),
        { final: bars.final, lyrics: bars.lyrics.text });
      // the round button sends the round, like the rail's
      const sendBefore = J('notes.json').round || 1;
      if (W === 1600) {
        await pg.evaluate(() => window.WB.stages.open('script')); await wait(300);
        const disabled = await pg.evaluate(() => document.querySelector('.sgbar [data-slot=round]').disabled);
        if (!disabled) { await pg.evaluate(() => document.querySelector('.sgbar [data-slot=round]').click()); await until(() => /Claude working/.test(document.querySelector('.sgbar [data-slot=round]')?.textContent || '')); }
        const after = await pg.evaluate(() => document.querySelector('.sgbar [data-slot=round]').textContent);
        check('F8: the stage bar\'s round button sends the round (the same command as the rail\'s): the round goes to Claude, the button turns into "Round N: Claude working"', !disabled && /^Round \d+: Claude working$/.test(after) && (J('notes.json').round || 1) === sendBefore + 1, { disabled, after });
      }

      // ---------------------------------------------------------------- F10: About
      await pg.evaluate(() => window.WB.commands.run('help.about'));
      await until(() => !!document.querySelector('.wbdlg[data-dlg=about] .abv'));
      const ab = await pg.evaluate(() => ({ v: document.querySelector('.wbdlg .abv').dataset.version, text: document.querySelector('.wbdlg').innerText, commit: document.querySelector('.wbdlg [data-commit]')?.dataset.commit || null }));
      const st = await (await fetch(`${BASE}/api/status`)).json();
      await shot(`v26_about_${W}`);
      check(`F10 ${W}: About shows the one version (package.json ${pkgVersion}, never "v2") and the git commit (${gitCommit || 'none'}) that /api/status reports`,
        ab.v === pkgVersion && st.version === pkgVersion && ab.text.includes(`v${pkgVersion}`) && !/\bv2\b/.test(ab.text) && (gitCommit ? ab.commit === gitCommit && st.commit === gitCommit : ab.commit === null && /not available/.test(ab.text)), { ab: { v: ab.v, commit: ab.commit }, status: { version: st.version, commit: st.commit } });
      await pg.keyboard.press('Escape'); await wait(150);

      // ---------------------------------------------------------------- F9: Connect Claude
      if (W === 1280) await tool('notes_add', { target: { stage: 'timeline', kind: 'time', t: 2000 }, text: 'v26: an agent write' });
      await pg.evaluate(() => window.WB.commands.run('help.connect'));
      await until(() => document.querySelectorAll('.wbdlg[data-dlg=connect] .cnstep').length === 3);
      await pg.evaluate(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } }, configurable: true }); });
      for (const b of await pg.$$('.wbdlg [data-copy]')) { await b.click(); await wait(60); }
      const cn = await pg.evaluate(() => ({ steps: [...document.querySelectorAll('.cnstep')].map(s => ({ id: s.dataset.step, code: s.querySelector('.cncode').textContent, btn: !!s.querySelector('[data-copy]') })),
        copied: window.__copied, state: document.querySelector('.cnstate').innerText, html: document.querySelector('.wbdlg').outerHTML, btnAfter: document.querySelector('[data-copy]').textContent,
        menu: window.WB.menus.itemsFor ? JSON.stringify(window.WB.menus.itemsFor('menubar:Help')) : '' }));
      await shot(`v26_connect_${W}`);
      const add = cn.steps.find(s => s.id === 'add')?.code || '', tokenStep = cn.steps.find(s => s.id === 'token')?.code || '', test = cn.steps.find(s => s.id === 'test')?.code || '';
      const serverPath = path.join(WB, 'mcp', 'server.mjs').replace(/\\/g, '/');
      check(`F9 ${W}: Help › Connect Claude… shows the claude mcp add command with this checkout's mcp/server.mjs (and WORKBENCH_URL for this port), WHERE the agent token is (the file, never its value), the mcp/client.mjs quick test, a copy button each (they copy exactly that), and the state: pages open + the last agent write`,
        cn.steps.length === 3 && cn.steps.every(s => s.btn) && add === `claude mcp add workbench --env WORKBENCH_URL=${BASE} -- node ${serverPath}` && tokenStep === path.join(DATA, '.wb-agent-token').replace(/\\/g, '/')
        && test.includes('mcp/client.mjs status') && test.includes(`--url ${BASE}`) && JSON.stringify(cn.copied) === JSON.stringify(cn.steps.map(s => s.code))
        && !cn.html.includes(AGENT_TOKEN) && !cn.html.includes(PAGE_TOKEN) && !cn.copied.some(c => c.includes(AGENT_TOKEN)) && /1 page open/.test(cn.state) && (W === 1280 ? /last agent write: notes_add on layout/ : /last agent write: \w+ on layout/).test(cn.state) && /help\.connect/.test(cn.menu),
        { add, tokenStep, test, state: cn.state, copied: cn.copied.length });
      if (W === 1280) {
        // the quick test, run as shown: it reaches this server and prints the status JSON
        const argv = test.replace(/^node /, '').match(/"[^"]*"|\S+/g).map(a => a.replace(/^"|"$/g, ''));
        const r = spawnSync(process.execPath, argv, { env: { ...env, WORKBENCH_URL: '' }, encoding: 'utf8', timeout: 60000 });
        let js = null; try { js = JSON.parse(r.stdout); } catch (e) { /* not JSON */ }
        check('F9: the quick test (node mcp/client.mjs status --url … --project …) runs as shown and reaches this server', r.status === 0 && js?.server?.up === true && js?.current_project === P, { code: r.status, err: (r.stderr || '').slice(0, 200), up: js?.server?.up, project: js?.current_project });
      }
      await pg.keyboard.press('Escape'); await wait(150);

      // ---------------------------------------------------------------- E10: interpretations
      if (W === 1280) {
        await tool('intake_answer', { key: 'mood', text: 'warm but sad, like a song you hum in a cold kitchen', by: 'director' });
        const set = await tool('interpretation_set', { key: 'mood', text: 'tungsten practicals against blue window light; slow push-ins; no hard cuts in the verses', by: 'claude' });
        const nt = await tool('notes_add', { target: { stage: 'script', kind: 'scene', id: 'sc02' }, text: 'v26: the wall should feel like a held breath' });
        const setN = await tool('interpretation_set', { note: nt.body?.id, text: 'hold the wide for the whole first line; the wall appears on the downbeat, not before' });
        const tools = (await client.listTools()).tools.map(t => t.name);
        const agentAct = await call('interpretation_act', { key: 'mood', act: 'accept', via: 'page' });
        check('E10: the agent writes its interpretation over MCP (intake answer and note), marked as its own (via agent, proposed); no tool accepts it and interpretation_act without the page is 403',
          !set.error && set.body.interpretation?.status === 'proposed' && set.body.interpretation.via === 'agent' && !setN.error && setN.body.interpretation?.by === 'agent' && tools.includes('interpretation_set') && !tools.includes('interpretation_act') && agentAct.status === 403,
          { set: set.body?.interpretation, setN: setN.text.slice(0, 120), agentAct: agentAct.status });
        app.noteId = nt.body?.id;
      }
      await pg.evaluate(() => window.WB.stages.open('script'));
      await until(() => !!document.querySelector('.scq[data-q=mood] .itp'));
      await wait(300);
      const e0 = await pg.evaluate((nid) => {
        const q = document.querySelector('.scq[data-q=mood]'), ta = q.querySelector('textarea'), it = q.querySelector('.itp');
        const n = document.querySelector(`.nclayer .ncn[data-nid="${nid}"]`), nb = n?.querySelector('.ncb'), ni = n?.querySelector('.itp');
        return { answer: ta.value, under: it.getBoundingClientRect().top >= ta.getBoundingClientRect().bottom - 1, label: it.querySelector('.itpw').textContent, status: [...it.classList].find(c => c.startsWith('s-')), text: it.querySelector('.itpt').textContent,
          italic: getComputedStyle(it.querySelector('.itpt')).fontStyle, rule: getComputedStyle(it).boxShadow !== 'none', acts: [...it.querySelectorAll('[data-itp]')].map(b => b.textContent),
          note: n ? { under: ni && ni.getBoundingClientRect().top >= nb.getBoundingClientRect().bottom - 1, label: ni?.querySelector('.itpw').textContent, verbatim: nb.textContent } : null };
      }, app.noteId);
      await shot(`v26_e10_${W}`);
      check(`E10 ${W}: under the verbatim intake answer (left as typed) the agent's interpretation shows apart (its own label "agent's reading · not reviewed", italic, a coloured rule) with Accept / Edit; the same under the note in the Notes column`,
        e0.answer === 'warm but sad, like a song you hum in a cold kitchen' && e0.under && /agent's reading · not reviewed|agent's reading · accepted by you|your reading/.test(e0.label) && e0.rule && e0.note?.under && /agent's reading · not reviewed|agent's reading · accepted by you|your reading/.test(e0.note.label) && e0.note.verbatim === 'v26: the wall should feel like a held breath'
        && (W === 1280 ? e0.status === 's-proposed' && e0.italic === 'italic' && JSON.stringify(e0.acts) === '["Accept","Edit"]' : true), e0);
      if (W === 1280) {
        await pg.evaluate(() => document.querySelector('.scq[data-q=mood] .itp [data-itp=accept]').click());
        await until(() => document.querySelector('.scq[data-q=mood] .itp')?.classList.contains('s-accepted'));
        const acc = J('scenes.json').intake.mood.interpretation;
        // the Notes column re-renders after the accept: wait for the note's Edit before clicking it
        await until((nid) => !!document.querySelector(`.nclayer .ncn[data-nid="${nid}"] .itp [data-itp=edit]`), app.noteId);
        await pg.evaluate((nid) => document.querySelector(`.nclayer .ncn[data-nid="${nid}"] .itp [data-itp=edit]`).click(), app.noteId);
        await until(() => !!document.querySelector('.pal input'));
        await pg.evaluate(() => { const i = document.querySelector('.pal input'); i.select(); });
        await pg.keyboard.type('hold the wide; the wall on the downbeat; my words now');
        await pg.keyboard.press('Enter');
        await until((nid) => document.querySelector(`.nclayer .ncn[data-nid="${nid}"] .itp`)?.classList.contains('s-edited'), app.noteId);
        const ed = J('notes.json').notes.find(n => n.id === app.noteId);
        const again = await tool('interpretation_set', { note: app.noteId, text: 'agent tries to overwrite' });
        await shot('v26_e10_accepted_edited_1280');
        check('E10: the director accepts the intake interpretation (accepted, reviewed via page) and edits the note\'s (edited: their words, the agent\'s kept as agent_text) in the page; the verbatim texts never change; the agent cannot overwrite an edited one (409)',
          acc.status === 'accepted' && acc.reviewed?.via === 'page' && J('scenes.json').intake.mood.text === 'warm but sad, like a song you hum in a cold kitchen'
          && ed.interpretation?.status === 'edited' && ed.interpretation.text === 'hold the wide; the wall on the downbeat; my words now' && /^hold the wide for the whole first line/.test(ed.interpretation.agent_text || '') && ed.text === 'v26: the wall should feel like a held breath' && again.error && /409/.test(again.text),
          { acc: acc.status, ed: ed.interpretation, again: again.text.slice(0, 100) });
      }
    }
    check('no page errors', !errors.length, errors.slice(0, 5));
  } catch (e) { check('v26 ran to the end', false, String(e.stack || e)); }
  finally {
    await pg?.close().catch(() => {});
    await client?.close().catch(() => {});
    srv.kill(); await wait(300);
    for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
  }
  return { checks, pass: Object.values(checks).length > 0 && Object.values(checks).every(c => c.pass) };
}
const app = {};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRequire } = await import('node:module');
  const puppeteer = createRequire(path.join(WB, 'package.json'))('puppeteer-core');
  const { findChrome } = await import('./chrome.mjs');
  const exe = findChrome(); if (!exe) { console.error('no Chromium found: set CHROME_PATH'); process.exit(1); }
  const OUT = path.resolve(process.argv[2] || path.join(WB, 'shots'));
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: exe, headless: true });
  let res = { pass: false, checks: {} }; try { res = await verifyLayout({ browser, OUT }); } finally { await browser.close(); }
  const n = Object.keys(res.checks).length, ok = Object.values(res.checks).filter(c => c.pass).length;
  console.log(`v26 (F7 timeline fit + docked preview, F8 stage bar, F9 Connect Claude, F10 About, E10 interpretations): ${res.pass ? 'all PASS' : 'FAIL'} (${ok}/${n})`);
  process.exitCode = res.pass ? 0 : 1;
}
