#!/usr/bin/env node
// Security regressions for the composition data export (ROADMAP_v4 E9: exporters/composition-data.mjs, composition_export).
//   - private media is never exported: a picked take under private/ (the PRIVATE rule), one flagged private:true in
//     media.json at an ordinary path, and a private alternative: none of their names reach edl.json; the shots export
//     as placeholders with reason "private"; a configured private_media regex counts too
//   - export path traversal is refused: out with "..", a backslash, a drive, a leading slash, ".", %2e, not .json, and
//     a junction inside exports/ that leads outside (400, nothing written outside); a map whose `to` leaves the
//     composition (400); over HTTP without the page's Origin (the agent surface) and in process alike
//   - the export never touches the project's files, and works on a project locked for render (it only writes exports/)
// Scratch copy of data/demo, its own server on a free port; never touches data/.   node tools/security-composition.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = 'comp', TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sec-comp-')), DATA = path.join(TMP, 'data'), D = path.join(DATA, P), OUTSIDE = path.join(TMP, 'outside');
fs.cpSync(path.join(WB, 'data', 'demo'), D, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [], private_media: '(^|/)faces/' }));
Object.assign(process.env, { WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P });
for (const k of ['WB_TOKEN', 'WB_HOST', 'WB_ALLOW_REMOTE_OPS']) delete process.env[k];
const S = await import('../lib/store.mjs');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sha = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(D, f))).digest('hex'); } catch (e) { return null; } };
// placeholder takes (VP8 webm, 2 s): the names are what must never leak
const take = (rel) => { const f = path.join(D, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24:duration=2', '-c:v', 'libvpx', '-b:v', '200k', f]); return fs.existsSync(f); };
let srv = null;
try {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) throw new Error('ffmpeg is needed for the placeholder takes');
  const T = { ruled: 'private/clip/secretface_take.webm', flagged: 'media/clip/flaggedtake_x9.webm', regex: 'faces/regexface_take.webm', alt: 'private/clip/secretalt_take.webm', plain: 'media/clip/plain_e9.webm' };
  const made = Object.values(T).map(take);
  const reg = {};
  for (const [k, rel] of Object.entries(T)) reg[k] = S.ops.media_add(P, { path: rel, kind: 'clip', shots: ['s1-intro', 's2-wall', 's3-grid', 's4-chorus'], ...(k === 'flagged' ? { private: true } : {}) }).media;
  const port = await freePort(), BASE = `http://localhost:${port}`;
  srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: process.env });
  srv.stderr.on('data', d => process.stderr.write('server: ' + d));
  await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
  const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
  const op = async (name, body, page = false) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': TOKEN, ...(page ? { origin: BASE } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };

  // the director picks: a ruled-private take, a flagged-private take, a regex-private take, and a plain take with a private alternative
  const picks = await Promise.all([
    op('take_act', { act: 'pick', shot: 's1-intro', media: reg.ruled.id, in_ms: 0, out_ms: 1000 }, true),
    op('take_act', { act: 'pick', shot: 's3-grid', media: reg.flagged.id, in_ms: 0, out_ms: 1000 }, true),
    op('take_act', { act: 'pick', shot: 's4-chorus', media: reg.regex.id, in_ms: 0, out_ms: 1000 }, true),
  ]);
  const pk4 = await op('take_act', { act: 'pick', shot: 's2-wall', media: reg.plain.id, in_ms: 0, out_ms: 1500, alt: [{ media: reg.alt.id, t: 6000, note: 'alt' }] }, true);
  const FILES = ['approvals.json', 'requests.json', 'storyboard.json', 'takes.json', 'media.json', 'settings.json', 'notes.json'], before = FILES.map(sha);
  const ex = await op('composition_export', {});
  const EF = path.join(D, 'exports', 'composition', 'edl.json'), text = fs.existsSync(EF) ? fs.readFileSync(EF, 'utf8') : '', doc = text ? JSON.parse(text) : {};
  const by = Object.fromEntries((doc.shots || []).map(s => [s.id, s]));
  const leaks = ['secretface', 'flaggedtake', 'regexface', 'secretalt', 'private/', 'faces/', reg.ruled.id, reg.flagged.id, reg.regex.id, reg.alt.id].filter(w => text.includes(w));
  check('private media is never exported: picks of a PRIVATE-rule take, a take flagged private in media.json and one the configured private_media regex matches export as placeholders (reason "private", no file); a private alternative is dropped; none of their names or ids is in edl.json',
    made.every(Boolean) && reg.ruled.private && reg.flagged.private && reg.regex.private && picks.every(p => p.status === 200) && pk4.status === 200 && ex.status === 200
    && ['s1-intro', 's3-grid', 's4-chorus'].every(id => by[id]?.status === 'placeholder' && by[id].placeholder.reason === 'private' && !by[id].take)
    && by['s2-wall']?.status === 'picked' && by['s2-wall'].take.source === T.plain && !by['s2-wall'].alt && ex.body.counts.private === 3 && !leaks.length,
    { picks: picks.map(p => p.status), ex: ex.body?.counts || ex.body, leaks, s1: by['s1-intro'], s2: by['s2-wall']?.take });
  check('the export writes exports/ only: approvals, requests, storyboard (picks), takes, media, settings, notes unchanged', JSON.stringify(before) === JSON.stringify(FILES.map(sha)));

  // path traversal on out (HTTP, the agent surface) and in process
  fs.mkdirSync(path.join(D, 'exports'), { recursive: true });
  let junction = false; try { fs.symlinkSync(OUTSIDE, path.join(D, 'exports', 'jx'), 'junction'); junction = true; } catch (e) { /* no junctions here */ }
  const outs = ['../evil.json', '../../evil.json', '..\\evil.json', 'a\\..\\..\\evil.json', '/evil.json', 'C:/evil.json', 'C:evil.json', '\\\\host\\share\\evil.json',
    'a/../../../evil.json', './evil.json', 'a//evil.json', '%2e%2e/evil.json', 'evil.txt', 'evil.json\0.txt', 'composition/..', ''.padEnd(300, 'a') + '.json', ...(junction ? ['jx/evil.json'] : [])];
  const http = await Promise.all(outs.map(out => op('composition_export', { out })));
  const inproc = outs.map(out => { try { S.ops.composition_export(P, { out }); return 200; } catch (e) { return e.code; } });
  const maps = [[{ from: '', to: '../' }], [{ from: '', to: '/abs/' }], [{ from: '', to: 'C:/x/' }], [{ from: '..', to: 'a/' }], [{ from: '', to: 'a\\b/' }], 'assets/'];
  const mapRes = await Promise.all(maps.map(map => op('composition_export', { map })));
  const strays = [...fs.readdirSync(TMP), ...fs.readdirSync(DATA), ...fs.readdirSync(D), ...fs.readdirSync(OUTSIDE)].filter(f => /evil/.test(f));
  check(`export path traversal is refused: an out with "..", a backslash, a drive, a UNC / leading slash, ".", an empty segment, %2e, NUL, not .json, too long${junction ? ', a junction inside exports/ leading outside' : ''} (400 over HTTP and in process), a map leaving the composition (400); nothing written outside exports/`,
    http.every(r => r.status === 400) && inproc.every(c => c === 400) && mapRes.every(r => r.status === 400) && !strays.length,
    { http: http.map(r => r.status).join(), inproc: inproc.join(), maps: mapRes.map(r => r.status).join(), strays, junction });

  // a project locked for render still exports (the lock is for the render), and the agent surface still gets 409 on writes
  const rv = { v: 1, rev: 1, rounds: [], revisions: [], restores: [], lock: { at: '2026-10-05T12:00:00', revision: 'R1', snapshot: 'x', summary: 'locked', by: 'director', via: 'page', ready: true, pending: 0 }, locks: [] };
  fs.writeFileSync(path.join(D, 'revisions.json'), JSON.stringify(rv));
  const lockedEx = await op('composition_export', { out: 'locked/edl.json' }), lockedWrite = await op('notes_add', { target: { stage: 'storyboard', kind: 'shot', id: 's2-wall' }, text: 'x' });
  check('a project locked for render still exports (composition_export writes exports/ only) while other agent writes get 409', lockedEx.status === 200 && fs.existsSync(path.join(D, 'exports', 'locked', 'edl.json')) && lockedWrite.status === 409,
    { lockedEx: lockedEx.status, lockedWrite: lockedWrite.status });
} catch (e) { check('test ran to the end', false, String(e.stack || e)); }
finally {
  srv?.kill(); await wait(300);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
console.log(`\n${n - failed}/${n} composition export security checks passed`);
process.exit(failed ? 1 : 0);
