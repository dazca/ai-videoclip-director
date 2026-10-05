// v31 of the headless UI suite (tools/verify.mjs): G8 onboarding, i18n and the error states, G7's helper first run and Settings ›
// Paired pages (ROADMAP_v4).
//   A. the helper's first run: `node bin/cli.mjs serve --data <empty folder>` makes the data folder (the template, the demo, the
//      onboarding mark), /api/status first_run; the page opens on the onboarding: the three ways to start, Connect Claude, where
//      the data lives (the helper's folder), the system check (server, code, ffmpeg, the fal key not set = optional); the same
//      screen in English, Catalan and Spanish (the onboarding's own language picker; every key of ca / es present); the menu bar,
//      the pages, the rail and the stage bar follow the language (Settings › language switches it back); "Start from a song" opens
//      the wizard and its Next goes straight to the song step; "Lyrics only" to the lyrics step; Not now / any start clears the mark
//      (no onboarding after a reload); Help › Welcome… shows it again; Settings › Paired pages lists a pairing and Revoke cuts it off
//   B. the error states, on a copy of the code with ffmpeg off the PATH and no fal key: the "ffmpeg not found" bar and its
//      "How to fix…" (Help › System check…: ffmpeg ✕ with the install line, the fal key not set with what to do); the code changed
//      on disk -> "Restart the server" (in Catalan: the bar follows the language); the server stopped -> "not answering" with what
//      to run, gone by itself when it is back; a project that cannot load -> the error screen with Retry / Open the demo
// Exported so verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-onboarding.mjs [outDir]
// Self-contained: scratch data folders and a code copy, its own servers on free ports; all deleted at the end. Screenshots v31_*.png.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const CODE_PARTS = ['serve.mjs', 'app.js', 'app.css', 'index.html', 'dock.html', 'README.md', 'package.json', 'lib', 'generators', 'js', 'tabs', 'core', 'templates', 'exporters/composition-data.mjs', 'importers/new_project.mjs'];
const until = async (pg, fn, arg, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await pg.evaluate(fn, arg)) return true; } catch (e) { /* navigating */ } await wait(120); } return false; };
const upStatus = async (base, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(base + '/api/status'); if (r.ok) return await r.json(); } catch (e) { /* not yet */ } await wait(150); } return null; };

export async function verifyOnboarding({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v31 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v31-')), DATA = path.join(TMP, 'helper-data');
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  const baseEnv = { ...process.env, WORKBENCH_CONFIG: path.join(TMP, 'config.json') };
  for (const k of ['WB_TOKEN', 'WB_AGENT_TOKEN', 'FAL_KEY', 'WB_FAL_BASE', 'WB_PROJECT', 'WORKBENCH_PROJECT', 'WORKBENCH_DATA', 'WORKBENCH_URL', 'WB_HELPER']) delete baseEnv[k];
  const procs = [];
  const errors = [];
  let pg = null;
  try {
    // ================================================================ A. the helper's first run + the onboarding
    const portA = await freePort(), A = `http://localhost:${portA}`;
    let helperLog = '';
    const hp = spawn(process.execPath, [path.join(WB, 'bin', 'cli.mjs'), 'serve', '--data', DATA, '--port', String(portA), '--no-open'], { stdio: 'pipe', env: baseEnv }); procs.push(hp);
    hp.stderr.on('data', d => { helperLog += d; }); hp.stdout.on('data', d => { helperLog += d; });
    const st0 = await upStatus(A); await wait(300);
    const made = ['_template', 'demo', '.wb-first-run', '.wb-agent-token'].filter(f => fs.existsSync(path.join(DATA, f)));
    check('A1 the helper\'s first run: the data folder made (the template, the demo, the onboarding mark, the agent token), the URL and the Connect command printed; /api/status first_run, ffmpeg found',
      made.length === 4 && st0?.first_run === true && st0.tools?.ffmpeg === true && new RegExp(`open +http://localhost:${portA}/`).test(helperLog) && /claude mcp add workbench -- node .*cli\.mjs"? mcp --data/.test(helperLog),
      { made, first_run: st0?.first_run, tools: st0?.tools, log: helperLog.slice(0, 400) });

    pg = await browser.newPage();
    pg.on('pageerror', e => { errors.push(e.message); console.error('v31 pageerror', e.stack || e.message); });
    pg.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    await pg.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const shot = async (n, sel) => {
      await frames(3); await wait(250);
      let clip; if (sel) clip = await pg.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(innerWidth, r.width), height: Math.min(innerHeight - Math.max(0, r.top), r.height) }; }, sel);
      await pg.screenshot({ path: path.join(OUT, `${n}.png`), ...(clip && clip.width > 0 && clip.height > 0 ? { clip } : {}) });
    };
    const ready = () => pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    const obReady = () => until(pg, () => document.querySelector('.ob')?.parentElement?.dataset.ready === '1' || document.querySelector('.obg')?.dataset.ready === '1');
    await pg.goto(`${A}/`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
    await obReady();
    const ob = await pg.evaluate(() => ({ ways: [...document.querySelectorAll('.obway')].map(b => b.dataset.ob), title: document.querySelector('.ob h2')?.textContent, connect: !!document.querySelector('[data-ob=connect]'),
      data: document.querySelector('[data-ob-data]')?.textContent, rows: Object.fromEntries([...document.querySelectorAll('[data-ob-check] tr[data-chk]')].map(r => [r.dataset.chk, r.className])), wizard: !!document.querySelector('.wizbg'), lang: document.documentElement.lang }));
    await shot('v31_onboarding_en');
    check('A2 the first open shows the onboarding (not the wizard): the three ways to start (song, lyrics only, the demo), Connect Claude, where the data lives (the helper\'s folder), the system check (server ✓, code ✓, ffmpeg ✓, the fal key not set = optional)',
      ob.ways.join(',') === 'song,lyrics,demo' && ob.title === 'Welcome to the Director Workbench' && ob.connect && path.resolve(ob.data || '.') === path.resolve(DATA) && ob.rows.server === 'ok' && ob.rows.code === 'ok' && ob.rows.ffmpeg === 'ok' && ob.rows.fal === 'opt' && !ob.wizard && ob.lang === 'en',
      ob);
    // the onboarding's Connect Claude… opens the Connect dialog on top of it
    await pg.click('[data-ob=connect]'); await until(pg, () => !!document.querySelector('.wbdlg[data-dlg=connect]'));
    const conn = await pg.evaluate(() => ({ dlg: !!document.querySelector('.wbdlg[data-dlg=connect]'), under: !!document.querySelector('.obg') }));
    await pg.keyboard.press('Escape'); await until(pg, () => !document.querySelector('.wbdlg[data-dlg=connect]'));
    check('A3 Connect Claude… opens the Connect dialog over the onboarding (Esc closes it; the onboarding stays)', conn.dlg && conn.under && await pg.evaluate(() => !!document.querySelector('.obg')), conn);

    // the language: the onboarding's own picker; the page is drawn again in that language (Catalan, then Spanish)
    const cov = await pg.evaluate(() => window.WB.i18n.coverage());
    const langShot = async (id, title, file, menuFile) => {
      await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded' }), pg.select('[data-ob-lang]', id)]);
      await ready(); await obReady();
      const v = await pg.evaluate(() => ({ title: document.querySelector('.ob h2')?.textContent, song: document.querySelector('[data-ob=song] b')?.textContent, lang: document.documentElement.lang, file: document.querySelector('#top .mbar [data-m=File]')?.textContent, rows: document.querySelectorAll('[data-ob-check] tr[data-chk]').length }));
      await shot(file);
      return v.title === title && v.lang === id && v.file === menuFile && v.rows >= 5 ? v : { fail: v };
    };
    const ca = await langShot('ca', 'Benvingut al Director Workbench', 'v31_onboarding_ca', 'Fitxer');
    const es = await langShot('es', 'Te damos la bienvenida al Director Workbench', 'v31_onboarding_es', 'Archivo');
    check('A4 the onboarding in Catalan and in Spanish (its own language picker; the page reloads in that language, the menu bar too); every English key has a Catalan and a Spanish string',
      !ca.fail && !es.fail && !cov.ca.missing.length && !cov.es.missing.length && !cov.ca.extra.length && !cov.es.extra.length, { ca, es, cov });

    // "Start from a song": the wizard, Next goes straight to the song step; the mark is cleared
    await pg.click('[data-ob=song]'); await until(pg, () => !!document.querySelector('.wizbg [name=title]'));
    await pg.type('.wizbg [name=title]', 'First Song');
    await pg.click('.wizbg [data-w=next]'); await until(pg, () => !!document.querySelector('.wizbg .wzdrop'));
    const wz = await pg.evaluate(() => ({ drop: !!document.querySelector('.wizbg .wzdrop'), lyrics: !!document.querySelector('.wizbg [name=lyrics]'), ob: !!document.querySelector('.obg') }));
    await pg.keyboard.press('Escape'); await wait(200);
    const st1 = await (await fetch(A + '/api/status')).json();
    check('A5 "Start from a song" closes the onboarding and opens the wizard; after the name, Next goes straight to the song step (drop the song); the onboarding mark is cleared (/api/status first_run false)',
      wz.drop && !wz.lyrics && !wz.ob && st1.first_run === false && !fs.existsSync(path.join(DATA, '.wb-first-run')), { wz, first_run: st1.first_run });
    await pg.reload({ waitUntil: 'domcontentloaded' }); await ready(); await wait(700);
    const noOb = await pg.evaluate(() => !document.querySelector('.obg'));
    // the main chrome in Spanish (the language stays): pages, sub-views, the rail, the stage bar
    await pg.evaluate(() => window.WB.stages.open('lyrics')); await until(pg, () => !!document.querySelector('[data-slot=mark]'));
    const chromeEs = await pg.evaluate(() => ({ tabs: [...document.querySelectorAll('#top nav a')].map(a => a.textContent), menus: [...document.querySelectorAll('#top .mbar b')].map(b => b.textContent),
      rail: [...document.querySelectorAll('#rail [data-stage][data-shown]')].map(a => a.textContent.replace(/\d+$/, '').trim()), mark: document.querySelector('[data-slot=mark]')?.textContent, ask: document.querySelector('[data-slot=ask]')?.textContent, name: document.querySelector('[data-slot=name]')?.textContent }));
    await shot('v31_chrome_es');
    check('A6 after a reload no onboarding; the main chrome in Spanish: the menu bar, the pages, the rail\'s stage names, the stage bar\'s buttons',
      noOb && chromeEs.menus.join(',') === 'Archivo,Edición,Ver,Línea de tiempo,Generar,Ventana,Ayuda' && chromeEs.tabs[0] === 'Línea de tiempo' && chromeEs.rail[0] === '1 Letra' && chromeEs.rail[6] === '7 Final' && chromeEs.mark === '✓ Hecha' && chromeEs.ask === 'Pedir al agente…' && /Letra/.test(chromeEs.name),
      chromeEs);
    // Settings › language back to English; Settings › Paired pages lists a pairing, Revoke cuts it off
    const PR = await import(pathToFileURL(path.join(WB, 'lib', 'pairing.mjs')).href);
    const code = PR.createCode(DATA, {});
    const paired = await (await fetch(A + '/api/pair', { method: 'POST', headers: { origin: 'https://director.example', 'content-type': 'application/json' }, body: JSON.stringify({ code: code.code }) })).json();
    await pg.evaluate(() => window.WB.app.show('settings')); await until(pg, () => !!document.querySelector('.settings [data-x=lang]') && !!document.querySelector('.pairbox tr[data-pair]'));
    const setv = await pg.evaluate(() => ({ h: document.querySelector('.settings h4.lang')?.textContent, pairs: [...document.querySelectorAll('.pairbox tr[data-pair]')].map(r => r.textContent) }));
    await shot('v31_settings_es');
    await pg.click(`.pairbox [data-revoke="${paired.id}"]`); await until(pg, () => !document.querySelector('.pairbox tr[data-pair]'));
    const afterRevoke = await fetch(A + '/api/projects', { headers: { origin: 'https://director.example', 'x-wb-pair-token': paired.token } });
    check('A7 Settings › language and Settings › Paired pages (in Spanish): the pairing listed (origin, scope), never its token; Revoke removes it and its token is refused at once (403)',
      /idioma/.test(setv.h || '') && setv.pairs.length === 1 && setv.pairs[0].includes('https://director.example') && !setv.pairs[0].includes(paired.token) && afterRevoke.status === 403,
      { setv, after: afterRevoke.status });
    await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded' }), pg.select('.settings [data-x=lang]', 'en')]); await ready();
    const backEn = await pg.evaluate(() => ({ lang: document.documentElement.lang, file: document.querySelector('#top .mbar [data-m=File]')?.textContent }));
    // Help › Welcome… shows it again; "Lyrics only" -> the wizard's lyrics step after the name
    await pg.evaluate(() => window.WB.commands.run('help.welcome')); await obReady();
    const again = await pg.evaluate(() => document.querySelector('.ob h2')?.textContent);
    await pg.click('[data-ob=lyrics]'); await until(pg, () => !!document.querySelector('.wizbg [name=title]'));
    await pg.type('.wizbg [name=title]', 'Words First'); await pg.click('.wizbg [data-w=next]'); await until(pg, () => !!document.querySelector('.wizbg [name=lyrics]'));
    const lyr = await pg.evaluate(() => !!document.querySelector('.wizbg [name=lyrics]'));
    await pg.keyboard.press('Escape'); await wait(200);
    check('A8 Settings › language back to English (the page reloads in English); Help › Welcome… shows the onboarding again; "Lyrics only" -> the wizard\'s lyrics step',
      backEn.lang === 'en' && backEn.file === 'File' && again === 'Welcome to the Director Workbench' && lyr, { backEn, again, lyr });
    hp.kill(); await wait(300);

    // ================================================================ B. the error states (a copy of the code: no ffmpeg, no fal key)
    const CODE = path.join(TMP, 'code'), DB = path.join(TMP, 'data-b');
    for (const p of CODE_PARTS) if (fs.existsSync(path.join(WB, p))) fs.cpSync(path.join(WB, p), path.join(CODE, p), { recursive: true });
    fs.cpSync(path.join(WB, 'data', 'demo'), path.join(DB, 'demo'), { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
    const portB = await freePort(), Bu = `http://localhost:${portB}`;
    // ffmpeg off the PATH: only node's own folder and the system folders (the server looks for ffmpeg / ffprobe once, at start)
    const sysDirs = process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'] : ['/bin'];
    const envB = { ...baseEnv, WORKBENCH_DATA: DB, WB_PROJECT: 'demo', PATH: [path.dirname(process.execPath), ...sysDirs].join(path.delimiter) };
    delete envB.Path;
    const startB = () => { const s = spawn(process.execPath, [path.join(CODE, 'serve.mjs'), String(portB)], { stdio: 'pipe', env: envB }); s.stderr.on('data', d => process.stderr.write('v31 B: ' + d)); procs.push(s); return s; };
    let sb = startB(); const stB = await upStatus(Bu);
    await pg.goto(`${Bu}/?project=demo`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
    await until(pg, () => document.getElementById('stalebar')?.dataset.key === 'ffmpeg');
    const ffbar = await pg.evaluate(() => ({ key: document.getElementById('stalebar')?.dataset.key, text: document.getElementById('stalebar')?.textContent }));
    await shot('v31_err_ffmpeg');
    await pg.click('#stalebar [data-a=how]'); await until(pg, () => document.querySelector('.wbdlg[data-dlg=health]')?.dataset.ready === '1');
    const hc = await pg.evaluate(() => Object.fromEntries([...document.querySelectorAll('.wbdlg[data-dlg=health] tr[data-chk]')].map(r => [r.dataset.chk, { cls: r.className, text: r.textContent }])));
    await shot('v31_err_check', '.wbdlg[data-dlg=health]');
    check('B1 no ffmpeg on the PATH: /api/status tools false; the bar "ffmpeg not found" with How to fix…; Help › System check… says ffmpeg ✕ with the install line, the fal key not set (optional: "Open in another app") with how to set it, the server and code ✓',
      stB?.tools?.ffmpeg === false && ffbar.key === 'ffmpeg' && /ffmpeg not found/.test(ffbar.text) && hc.ffmpeg?.cls === 'no' && /winget install ffmpeg/.test(hc.ffmpeg.text) && hc.fal?.cls === 'opt' && /FAL_KEY/.test(hc.fal.text) && /Open in another app/.test(hc.fal.text) && hc.server?.cls === 'ok' && hc.code?.cls === 'ok',
      { tools: stB?.tools, ffbar, hc: Object.fromEntries(Object.entries(hc).map(([k, v]) => [k, v.cls])) });
    await pg.keyboard.press('Escape');
    // the code changes on disk: "Restart the server", in Catalan (the bar follows the language)
    await pg.evaluate(() => { try { localStorage.setItem('wb:lang', '"ca"'); } catch (e) {} });
    fs.appendFileSync(path.join(CODE, 'lib', 'store.mjs'), '\n// changed after the server started (verify v31)\n');
    await pg.reload({ waitUntil: 'domcontentloaded' }); await ready();
    await until(pg, () => /^stale:/.test(document.getElementById('stalebar')?.dataset.key || ''));
    const stale = await pg.evaluate(() => document.getElementById('stalebar')?.textContent || '');
    await shot('v31_err_stale_ca');
    check('B2 the code changed on disk after the server started: the bar says "Reinicia el servidor" (Catalan) with the changed file; it outranks the ffmpeg bar', /Reinicia el servidor/.test(stale) && /lib\/store\.mjs/.test(stale), stale);
    // the server stops: "not answering" (what to run), then back by itself
    sb.kill(); await wait(200);
    await until(pg, () => document.getElementById('stalebar')?.dataset.key === 'down' && document.body.dataset.server === 'down', null, 15000);
    const down = await pg.evaluate(() => ({ key: document.getElementById('stalebar')?.dataset.key, text: document.getElementById('stalebar')?.textContent }));
    await shot('v31_err_down_ca');
    sb = startB(); await upStatus(Bu);
    const back = await until(pg, () => document.getElementById('stalebar')?.dataset.key !== 'down' && !document.body.dataset.server, null, 15000);
    const after = await pg.evaluate(() => ({ key: document.getElementById('stalebar')?.dataset.key || null, toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ') }));
    check('B3 the server stops: within seconds the bar says it is not answering and what to run (npx ai-videoclip-director / npm start), in Catalan; started again, the bar goes by itself ("El servidor torna a respondre")',
      down.key === 'down' && /no respon/.test(down.text) && /npx ai-videoclip-director/.test(down.text) && back && /torna a respondre/.test(after.toast), { down, after });
    // a project that cannot load: the error screen, Retry / Open the demo
    await pg.evaluate(() => { try { localStorage.setItem('wb:lang', '"en"'); } catch (e) {} });
    await pg.goto(`${Bu}/?project=missing-one`, { waitUntil: 'domcontentloaded' });
    await until(pg, () => document.body.dataset.loaderr === '1');
    const le = await pg.evaluate(() => ({ h: document.querySelector('.loaderr h2')?.textContent, btns: [...document.querySelectorAll('.loaderr [data-le]')].map(b => b.dataset.le) }));
    await shot('v31_err_load');
    await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded' }), pg.click('.loaderr [data-le=demo]')]); await ready();
    check('B4 a project that cannot load: an error screen (the project, what to run) with Retry and Open the demo (which opens it)',
      le.h === 'Could not load project "missing-one"' && le.btns.join(',') === 'retry,demo' && /project=demo/.test(pg.url()), { le, url: pg.url() });
    check('no page errors', !errors.filter(e => !/Failed to fetch|NetworkError|ERR_CONNECTION/.test(e)).length, errors.slice(0, 5));
  } catch (e) { check('v31 ran to the end', false, String(e.stack || e)); }
  finally {
    await pg?.close().catch(() => {});
    for (const p of procs) { try { p.kill(); } catch (e) { /* gone */ } }
    await wait(400);
    for (let i = 0; i < 6; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(400); } }
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
  let res = { pass: false, checks: {} }; try { res = await verifyOnboarding({ browser, OUT }); } finally { await browser.close(); }
  const n = Object.keys(res.checks).length, ok = Object.values(res.checks).filter(c => c.pass).length;
  console.log(`v31 (G8 onboarding, i18n, error states; G7 first run, paired pages): ${res.pass ? 'all PASS' : 'FAIL'} (${ok}/${n})`);
  process.exitCode = res.pass ? 0 : 1;
}
