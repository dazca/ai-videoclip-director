// v29 of the headless UI suite (tools/verify.mjs): G5 the project as a zip, G6 a new project from a song, in the page (ROADMAP_v4).
//   G5 export: File › Export project as zip… (the File menu's entries; the dialog's counts = project_export dry_run, the private files
//      left out by default; ticking "include private media (personal backup)" shows the warning and the counts with them); Export writes
//      exports/<p>-<stamp>.zip and the browser downloads it (the download's bytes = the file); the zip holds no private file and no
//      JSON names one; its manifest's sha256s are right
//   G5 import: File › Import project from zip…: the zip chosen in the dialog is uploaded in chunks (progress), checked (project_import
//      dry_run: the source, files, size), imported as a NEW project with its id editable; approvals arrive as review, requests as draft,
//      costs as history; "Open project" opens it; a crafted zip-slip zip is refused in the dialog with the reason (nothing created)
//   G6: File › New project…: title, lyrics loaded from a .lrc file, the song DROPPED as a file (no path typing): uploaded in chunks with
//      a progress bar, read on the server (ffprobe length, waveform peaks, energy, the beat grid estimated from a 100 BPM click track,
//      LRC timings), the result shown (length, BPM estimated, lines), then the project opens on the lyrics stage
// Exported so verify.mjs runs it after the other blocks; runnable alone:   node tools/verify-projectzip.mjs [outDir]
// Self-contained: a scratch copy of data/demo, its own server on a free port, an MCP-free agent token for the crafted zip; all
// deleted at the end. Screenshots v29_*.png (1600x900).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(process.env.WB_VERIFY_PORT ? Number(process.env.WB_VERIFY_PORT) + ((globalThis.__wbVerifyPortN = (globalThis.__wbVerifyPortN ?? -1) + 1) % 10) : 0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

export async function verifyProjectZip({ browser, OUT }) {
  const checks = {};
  const check = (name, ok, detail) => { checks[name] = { pass: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`v29 ${name}: ${ok ? 'PASS' : 'FAIL'}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`); };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-v29-')), DATA = path.join(TMP, 'data'), P = 'zipui', PD = path.join(DATA, P), DL = path.join(TMP, 'downloads');
  fs.cpSync(path.join(WB, 'data', 'demo'), PD, { recursive: true, filter: (s) => path.basename(s) !== '.snapshots' });
  fs.mkdirSync(DL, { recursive: true });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
  // a private photo (the PRIVATE rule) and a crop flagged private: never in a default export
  const { tinyPng } = await import(pathToFileURL(path.join(WB, 'tools', 'tiny-png.mjs')).href);
  fs.mkdirSync(path.join(PD, 'private', 'refs', 'ada'), { recursive: true }); fs.writeFileSync(path.join(PD, 'private', 'refs', 'ada', 'face-secret.png'), tinyPng(8, 8, [200, 120, 90]));
  fs.mkdirSync(path.join(PD, 'media', 'still'), { recursive: true }); fs.writeFileSync(path.join(PD, 'media', 'still', 'crop-flagged.png'), tinyPng(8, 8, [90, 120, 200]));
  const M = JSON.parse(fs.readFileSync(path.join(PD, 'media.json'), 'utf8'));
  M.items.push({ id: 'v29-face', path: 'private/refs/ada/face-secret.png', kind: 'ref', private: true, entities: ['ada'] }, { id: 'v29-crop', path: 'media/still/crop-flagged.png', kind: 'still', private: true });
  fs.writeFileSync(path.join(PD, 'media.json'), JSON.stringify(M, null, 1));
  const port = await freePort(), BASE = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P, WB_TEST: '1' };
  delete env.WB_TOKEN; delete env.WB_AGENT_TOKEN;
  const srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('v29 server: ' + d));
  let pg = null;
  const prevEnv = process.env.WORKBENCH_DATA;
  try {
    await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
    const Z = await import(pathToFileURL(path.join(WB, 'lib', 'zip.mjs')).href);
    pg = await browser.newPage();
    const errors = [];
    pg.on('pageerror', e => { errors.push(e.message); console.error('v29 pageerror', e.stack || e.message); });
    pg.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
    const cdp = await pg.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }).catch(() => cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }));
    const frames = (n = 2) => pg.evaluate((k) => new Promise(r => { const f = () => (k-- > 0 ? requestAnimationFrame(f) : r()); f(); }), n);
    const until = async (fn, arg, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pg.evaluate(fn, arg)) return true; await wait(100); } return false; };
    const shot = async (n) => { await frames(3); await wait(250); await pg.screenshot({ path: path.join(OUT, `${n}.png`) }); };
    const text = (sel) => pg.evaluate((s) => document.querySelector(s)?.textContent || '', sel);
    await pg.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    await pg.goto(`${BASE}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });

    // ---------------------------------------------------------------- G5 export
    await pg.evaluate(() => import('/core/menus.js').then(m => m.openBar('File'))); await frames(3);
    const menu = await pg.evaluate(() => [...document.querySelectorAll('.pop')].map(m => m.textContent).join(' '));
    await shot('v29_file_menu');
    await pg.keyboard.press('Escape'); await frames(2);
    check('G5 the File menu has "Export project as zip…" and "Import project from zip…"', /Export project as zip/.test(menu) && /Import project from zip/.test(menu));
    await pg.evaluate(() => window.WB.commands.run('file.exportZip'));
    await until(() => /files/.test(document.querySelector('[data-dlg=projectExport] .pzsum')?.textContent || ''));
    const sum0 = await text('[data-dlg=projectExport] .pzsum');
    await shot('v29_export');
    await pg.click('[data-dlg=projectExport] input[name=private]');
    await until(() => !document.querySelector('[data-dlg=projectExport] .pzwarn').hidden && /Personal backup/.test(document.querySelector('[data-dlg=projectExport] .pzwarn').textContent));
    await wait(300);
    const warn = await text('[data-dlg=projectExport] .pzwarn'), sumP = await text('[data-dlg=projectExport] .pzsum'), btnP = await text('[data-dlg=projectExport] [data-x=export]');
    await shot('v29_export_private');
    await pg.click('[data-dlg=projectExport] input[name=private]');
    await until(() => document.querySelector('[data-dlg=projectExport] .pzwarn').hidden);
    check('G5 export dialog: the counts (files, size, private files LEFT OUT by default); ticking "include private media" shows the personal-backup warning and the button says so; unticked by default',
      /\d+ files/.test(sum0) && /2 private files left out/.test(sum0) && /Personal backup/.test(warn) && /Keep it to yourself/.test(warn) && !/left out/.test(sumP) && /personal backup/i.test(btnP), { sum0, sumP, btnP });
    await pg.click('[data-dlg=projectExport] [data-x=export]');
    await until(() => /written/.test(document.querySelector('[data-dlg=projectExport] .pzres')?.textContent || ''), null, 30000);
    const res = await text('[data-dlg=projectExport] .pzres');
    const zipRel = /exports\/[^ ]+\.zip/.exec(res)?.[0], zipAbs = zipRel ? path.join(PD, zipRel) : null;
    let dl = null; for (let i = 0; i < 60 && !dl; i++) { dl = fs.readdirSync(DL).find(f => f.endsWith('.zip')); if (!dl) await wait(200); }
    await shot('v29_export_done');
    let zinfo = {};
    if (zipAbs && fs.existsSync(zipAbs)) {
      const z = Z.openZip(zipAbs), names = z.entries.map(e => e.name), man = JSON.parse(z.read(z.entries.find(e => e.name === 'workbench-export.json')).toString('utf8'));
      const json = z.entries.filter(e => e.name.endsWith('.json')).map(e => z.read(e).toString('utf8')).join('\n');
      zinfo = { files: names.length, priv: names.filter(n => /secret|flagged|^private\//.test(n)), named: /face-secret|crop-flagged/.test(json), sums: man.files.every(f => sha(z.read(z.entries.find(e => e.name === f.path))) === f.sha256) };
      z.close();
    }
    const same = dl && zipAbs && fs.readFileSync(path.join(DL, dl)).equals(fs.readFileSync(zipAbs));
    check('G5 Export writes exports/<p>-<stamp>.zip and the browser downloads the same bytes; no private file in it, no JSON names one; the manifest\'s sha256s are right',
      !!zipRel && /^exports\/zipui-\d{8}-\d{6}\.zip$/.test(zipRel) && same && zinfo.files > 20 && !zinfo.priv.length && !zinfo.named && zinfo.sums, { zipRel, dl, same, zinfo });
    await pg.keyboard.press('Escape');

    // ---------------------------------------------------------------- G5 import (the zip just exported), and a zip-slip zip refused
    await pg.evaluate(() => window.WB.commands.run('file.importZip'));
    await until(() => !!document.querySelector('[data-dlg=projectImport] input[type=file]'));
    const fileIn = await pg.$('[data-dlg=projectImport] input[type=file]');
    await fileIn.uploadFile(zipAbs);
    await until(() => !document.querySelector('[data-dlg=projectImport] [data-x=import]').disabled, null, 30000);
    const isum = await text('[data-dlg=projectImport] .pzsum'), iid = await pg.$eval('[data-dlg=projectImport] [name=id]', e => e.value), ires = await text('[data-dlg=projectImport] .pzres');
    await shot('v29_import');
    await pg.click('[data-dlg=projectImport] [data-x=import]');
    await until(() => /imported as/.test(document.querySelector('[data-dlg=projectImport] .pzres')?.textContent || ''), null, 30000);
    const idone = await text('[data-dlg=projectImport] .pzres');
    await shot('v29_import_done');
    const NJ = (f) => JSON.parse(fs.readFileSync(path.join(DATA, iid, f), 'utf8'));
    const A0 = JSON.parse(fs.readFileSync(path.join(PD, 'approvals.json'), 'utf8')), A1 = fs.existsSync(path.join(DATA, iid)) ? NJ('approvals.json') : { items: {} };
    const R1 = fs.existsSync(path.join(DATA, iid)) ? NJ('requests.json') : { items: [] }, PJ = fs.existsSync(path.join(DATA, iid)) ? NJ('project.json') : {};
    check('G5 import in the page: the chosen zip is uploaded and checked (source project, files, size; "checked: paths, sizes, checksums and ids"), the new id proposed (zipui-import), Import makes a NEW project: approvals arrive as review (none approved), requests as draft, project.json says where it came from',
      /from zipui/.test(isum) && /checked/.test(ires) && iid === 'zipui-import' && /imported as zipui-import/.test(idone) && /approvals/.test(idone)
      && Object.values(A0.items).some(x => x.state === 'approved') && !Object.values(A1.items).some(x => ['approved', 'locked'].includes(x.state)) && R1.items.every(r => r.status === 'draft') && PJ.imported?.from === P,
      { isum, iid, ires, idone });
    await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null), pg.click('[data-dlg=projectImport] [data-x=open]')]);
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }).catch(() => {});
    check('G5 "Open project" opens the imported project', new URL(pg.url()).searchParams.get('project') === 'zipui-import', pg.url());
    // a crafted zip with "../" in it: refused in the dialog, nothing created
    const evil = path.join(TMP, 'evil.zip'), w = new Z.ZipWriter(evil), song = fs.readFileSync(path.join(PD, 'song.json')), bad = Buffer.from('{"pwned":true}');
    w.add('song.json', song); w.add('../../pwned.json', bad);
    w.add('workbench-export.json', Buffer.from(JSON.stringify({ format: 'director-workbench/project-zip', v: 1, project: 'evil', files: [{ path: 'song.json', size: song.length, sha256: sha(song) }, { path: '../../pwned.json', size: bad.length, sha256: sha(bad) }] })));
    w.finish();
    const before = fs.readdirSync(DATA).sort().join(',');
    await pg.evaluate(() => window.WB.commands.run('file.importZip'));
    await until(() => !!document.querySelector('[data-dlg=projectImport] input[type=file]'));
    await (await pg.$('[data-dlg=projectImport] input[type=file]')).uploadFile(evil);
    await until(() => document.querySelector('[data-dlg=projectImport] .pzres')?.classList.contains('err'), null, 20000);
    const evilMsg = await text('[data-dlg=projectImport] .pzres');
    await shot('v29_import_refused');
    await pg.keyboard.press('Escape');
    check('G5 a zip-slip zip ("../../pwned.json") is refused in the dialog with the reason; Import stays disabled; nothing is created',
      /unsafe path/.test(evilMsg) && await pg.$eval('[data-dlg=projectImport] [data-x=import]', b => b.disabled).catch(() => true) && fs.readdirSync(DATA).sort().join(',') === before && !fs.existsSync(path.join(TMP, 'pwned.json')) && !fs.existsSync(path.join(DATA, 'pwned.json')), evilMsg);

    // ---------------------------------------------------------------- G6: a new project from a dropped song + a .lrc file
    const click = path.join(TMP, 'click-100bpm.wav');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='0.15*sin(2*PI*220*t)+0.8*sin(2*PI*1000*t)*exp(-40*mod(t-0.5\\,0.6))*gte(t\\,0.5)':s=44100:d=24`, click]);
    const lrc = path.join(TMP, 'lyrics.lrc');
    fs.writeFileSync(lrc, '[ti:Click]\n[Verse 1]\n[00:02.00] first line on the beat\n[00:05.60] second line comes after\n\n[Chorus]\n[00:10.40] click click click\n[00:14.00] the grid is the song\n');
    await pg.evaluate(() => window.WB.wizard.open()); await frames(2);
    await pg.type('.wiz [name=title]', 'Click Song');
    await pg.click('.wiz [data-w=next]'); await frames(2);
    await (await pg.$('.wiz [name=lyrfile]')).uploadFile(lrc);
    await until(() => /first line on the beat/.test(document.querySelector('.wiz [name=lyrics]')?.value || ''));
    await shot('v29_song_lyrics');
    await pg.click('.wiz [data-w=next]'); await frames(2);
    // drop the song on the wizard (a DataTransfer with the file, the way a drag from the desktop arrives)
    const wav = fs.readFileSync(click).toString('base64');
    await pg.evaluate((b64) => {
      const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const f = new File([u], 'click-100bpm.wav', { type: 'audio/wav' }), dt = new DataTransfer(); dt.items.add(f);
      const z = document.querySelector('.wiz .wzdrop');
      z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      z.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, wav);
    await until(() => /click-100bpm\.wav/.test(document.querySelector('.wiz .wzfile')?.textContent || ''));
    const songStep = await text('.wiz .wizb'), bpmPh = await pg.$eval('.wiz [name=bpm]', e => e.placeholder), pathField = await pg.$eval('.wiz [name=song]', e => ({ empty: e.value === '', closed: !e.closest('details').open }));
    await shot('v29_song_step');
    await pg.evaluate(() => { window.WB.wizard.hold = true; });
    await pg.click('.wiz [data-w=create]');
    await until(() => !!document.querySelector('.wzsteps li.on, .wzsteps li.done'), null, 5000);
    const sawSteps = await pg.evaluate(() => [...document.querySelectorAll('.wzsteps li')].map(l => l.dataset.s));
    await until(() => !document.querySelector('.wzres')?.hidden && /BPM/.test(document.querySelector('.wzres')?.textContent || ''), null, 60000);
    const result = await text('.wiz .wzres'), stepsDone = await pg.evaluate(() => [...document.querySelectorAll('.wzsteps li')].map(l => l.className).join(','));
    await shot('v29_song_wizard');
    const ND = path.join(DATA, 'click-song'), SJ = fs.existsSync(path.join(ND, 'song.json')) ? JSON.parse(fs.readFileSync(path.join(ND, 'song.json'), 'utf8')) : {};
    check('G6 the song step takes a DROPPED file (no path typed: the path field stays closed and empty), the BPM says "auto"; the lyrics came from a .lrc file',
      /click-100bpm\.wav/.test(songStep) && bpmPh === 'auto' && pathField.empty && pathField.closed, { bpmPh, pathField });
    check('G6 Create shows the steps (upload with its progress, read the song, open) and the result: the length, the BPM estimated from the song (100), the lyric lines',
      sawSteps.join(',') === 'up,read,done' && /done,done,on/.test(stepsDone) && /0:24 long/.test(result) && /100 BPM/.test(result) && /estimated/.test(result) && /4 lyric lines/.test(result), { sawSteps, stepsDone, result });
    const peaks = fs.existsSync(path.join(ND, 'peaks', 'mix.json')), energy = fs.existsSync(path.join(ND, 'energy.json')) && JSON.parse(fs.readFileSync(path.join(ND, 'energy.json'), 'utf8')).rms.length > 100;
    const l0 = SJ.lines?.[0], beats = SJ.grid?.beats || [];
    check('G6 the server read the song: song.json duration (ffprobe / decode, 24 s), audio in the project (audio/click-100bpm.wav), the waveform peaks and the energy, the beat grid at 100 BPM on the clicks (first beat 500 ms ± 30), the LRC timings kept (line 1 at 2.000 s)',
      Math.abs((SJ.duration_ms || 0) - 24000) < 60 && SJ.audio?.mix === 'audio/click-100bpm.wav' && fs.existsSync(path.join(ND, 'audio', 'click-100bpm.wav')) && peaks && energy
      && SJ.bpm === 100 && beats.some(b => Math.abs(b - 500) <= 30) && l0?.t0 === 2000 && SJ.lines.length === 4 && !SJ.placeholder_duration,
      { dur: SJ.duration_ms, mix: SJ.audio?.mix, bpm: SJ.bpm, b0: beats.slice(0, 3), l0: l0 && [l0.t0, l0.text], lines: SJ.lines?.length, peaks, energy });
    await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null), pg.click('.wiz [data-w2=open]')]);
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 }).catch(() => {});
    await wait(800);
    await shot('v29_song_project');
    check('G6 "Open the project" opens it on the lyrics stage', new URL(pg.url()).searchParams.get('project') === 'click-song', pg.url());
    check('no page errors', !errors.length, errors.slice(0, 5));
  } catch (e) { check('v29 ran to the end', false, String(e.stack || e)); }
  finally {
    if (prevEnv === undefined) delete process.env.WORKBENCH_DATA; else process.env.WORKBENCH_DATA = prevEnv;
    await pg?.close().catch(() => {});
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
  let res = { pass: false, checks: {} }; try { res = await verifyProjectZip({ browser, OUT }); } finally { await browser.close(); }
  const n = Object.keys(res.checks).length, ok = Object.values(res.checks).filter(c => c.pass).length;
  console.log(`v29 (G5 project zip export / import, G6 new project from a song): ${res.pass ? 'all PASS' : 'FAIL'} (${ok}/${n})`);
  process.exitCode = res.pass ? 0 : 1;
}
