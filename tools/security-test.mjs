#!/usr/bin/env node
// Security regressions for the workbench server, the data layer and the page (audit F01-F15, NV1, NV2; the exporter's
// F07/F08/F12 are in tools/security-exporter.mjs). Runs on a SCRATCH copy of data/demo with scratch media and config,
// on free ports; never touches data/. Uses headless Chromium when one is found (tools/chrome.mjs), else skips the
// browser checks.   node tools/security-test.mjs   (npm run test:security runs both files)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = 'demo';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sectest-'));
const DATA = path.join(TMP, 'data'), D = path.join(DATA, P), MB = path.join(TMP, 'mediabase');
for (const d of [P, '_template']) fs.cpSync(path.join(WB, 'data', d), path.join(DATA, d), { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
put(path.join(MB, 'roots/a.txt'), 'public'); put(path.join(MB, 'outside/secret.txt'), 'SECRET-OUTSIDE-ROOTS');
const png = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', f]); if (!fs.existsSync(f)) fs.writeFileSync(f, 'not an image'); };
png(path.join(MB, 'roots/private/face.png')); png(path.join(TMP, 'elsewhere/private/crop.png')); png(path.join(TMP, 'elsewhere/plain.png'));
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: ['roots/'], private_media: '^faces/' }));   // agent_approvals off (the default)
Object.assign(process.env, { WORKBENCH_DATA: DATA, WORKBENCH_MEDIA_BASE: MB, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P });
for (const k of ['WB_TOKEN', 'WB_HOST', 'WB_AGENT_APPROVALS', 'WB_ALLOW_REMOTE_OPS']) delete process.env[k];
const S = await import('../lib/store.mjs');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 300) : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const lanIp = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
// raw GET: a path sent as is (no URL normalisation) with any Host header
const get = (host, port, p, headers = {}) => new Promise(ok => http.get({ host, port, path: p, headers, timeout: 3000 }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => ok({ status: r.statusCode, headers: r.headers, body: b })); })
  .on('error', e => ok({ status: e.code })).on('timeout', function () { this.destroy(); }));
async function start(args) {
  const port = await freePort();
  const c = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port), ...args], { stdio: 'pipe', env: process.env });
  c.stderr.on('data', d => process.stderr.write('server: ' + d));
  await new Promise((ok, bad) => { c.stdout.once('data', ok); c.once('exit', (x) => bad(new Error('server exited ' + x))); });
  const base = `http://localhost:${port}`;
  const token = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${base}/?project=${P}`)).text())?.[1];
  return { c, port, base, token };
}
let A, L, browser;
try {
  A = await start([]);
  const post = (p, body, headers = {}) => fetch(A.base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': A.token, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const op = (name, args) => post(`/api/op/${name}?project=${P}`, args);
  const readP = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
  // the page's way of saving a shared file: whole file + base_rev
  const pageSave = async (f, fn) => { const cur = await (await fetch(`${A.base}/data/${P}/${f}`)).json(); fn(cur); return post(`/api/save/${f}?project=${P}`, { base_rev: cur.rev, data: cur }); };

  // ---------------------------------------------------------------- NV2 / F05 / F03: Host, Origin, content type, token, bind address
  const reb = await get('127.0.0.1', A.port, '/api/status', { host: `rebind.example:${A.port}` });
  const rebMedia = await get('127.0.0.1', A.port, '/media/roots/a.txt', { host: `rebind.example:${A.port}` });
  const rebPost = await fetch(`http://127.0.0.1:${A.port}/api/op/costs_get?project=${P}`, { method: 'POST' }).then(r => r.status);   // a fetch cannot forge Host; raw below
  const rebPostRaw = await new Promise(ok => { const r = http.request({ host: '127.0.0.1', port: A.port, method: 'POST', path: `/api/op/media_add?project=${P}`, headers: { host: `rebind.example:${A.port}`, 'content-type': 'application/json', 'x-wb-token': A.token } }, x => { x.resume(); ok(x.statusCode); }); r.on('error', () => ok(0)); r.end(JSON.stringify({ path: path.join(MB, 'outside/secret.txt') })); });
  check('NV2 DNS rebinding: a foreign Host is refused on reads and writes, even with the token', reb.status === 403 && rebMedia.status === 403 && rebPostRaw === 403 && !fs.existsSync(path.join(D, 'media/still/secret.txt')), { reb: reb.status, rebMedia: rebMedia.status, rebPostRaw, rebPost });
  const plain = await post(`/api/op/request_update?project=${P}`, '{"id":"rdemo01","status":"approved","director_approved":true}', { 'content-type': 'text/plain' });
  const foreign = await post(`/api/projects/delete?project=${P}`, { id: 'x' }, { origin: 'https://evil.example' });
  const noTok = await post(`/api/save/approvals.json?project=${P}`, { base_rev: 0, data: {} }, { 'x-wb-token': '' });
  const own = await post(`/api/op/costs_get?project=${P}`, {}, { origin: A.base });
  check('F05 CSRF: text/plain 415, foreign Origin 403, no token 403, own origin + token 200', plain.status === 415 && foreign.status === 403 && noTok.status === 403 && own.status === 200, { plain: plain.status, foreign: foreign.status, noTok: noTok.status, own: own.status });
  const lan = lanIp ? await get(lanIp, A.port, '/') : { status: 'no LAN address' };
  check('F03 the default server listens on 127.0.0.1 only', typeof lan.status === 'string', { lanIp, lan: lan.status });

  // ---------------------------------------------------------------- F04 / F13 / F01 server side: paths, allow-list, CSP
  const st = async (p) => (await get('127.0.0.1', A.port, p, { host: `localhost:${A.port}` })).status;
  const media = { ok: await st('/media/roots/a.txt'), e1: await st('/media/roots/..%2Foutside%2Fsecret.txt'), e2: await st('/media/roots/..%5Coutside%5Csecret.txt'), e3: await st('/media/roots%2F..%2Foutside%2Fsecret.txt') };
  check('F04 /media cannot leave the media roots (%2F, %5C)', media.ok === 200 && [media.e1, media.e2, media.e3].every(s => s === 400 || s === 403), media);
  const stat = { lib: await st('/LIB/store.mjs'), mods: await st('/Node_Modules/zod/package.json'), data: await st(`/Data/${P}/song.json`), cfg: await st('/Workbench.Config.Json'), pkg: await st('/package.json'),
    docs: await st('/docs/WEB_SERVICE_PLAN.md'), claude: await st('/CLAUDE.md'), mcp: await st('/mcp/server.mjs'), exp: await st('/exporters/hyperframes-html/lib.mjs'),
    app: await st('/app.js'), css: await st('/app.css'), tok: await st('/core/token.js'), tab: await st('/tabs/queue.js'), readme: await st('/README.md'), data2: await st(`/data/${P}/song.json`) };
  // (/Data/<p>/ is the data route itself, case-insensitively, with its PRIVATE gate: not the static branch)
  check('F13 static files: an allow-list (page files only), case-insensitive', ['lib', 'mods', 'cfg', 'pkg', 'docs', 'claude', 'mcp', 'exp'].every(k => stat[k] === 403) && ['app', 'css', 'tok', 'tab', 'readme', 'data2'].every(k => stat[k] === 200), stat);
  const shell = await get('127.0.0.1', A.port, `/?project=${P}`, { host: `localhost:${A.port}` });
  const csp = shell.headers['content-security-policy'] || '';
  const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] || '';
  const inline = [...shell.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(m => !/\bsrc=/.test(m[1]) || m[2].trim());
  const bad = await get('127.0.0.1', A.port, '/?project=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', { host: `localhost:${A.port}` });
  const fileCsp = (await get('127.0.0.1', A.port, `/data/${P}/song.json`, { host: `localhost:${A.port}` })).headers;
  check('F01/F02 server side: CSP without inline script on the page, invalid ?project= redirected, sandbox + nosniff on files', scriptSrc.trim() === "'self'" && !inline.length && /frame-ancestors 'self'/.test(csp)
    && bad.status === 302 && bad.headers.location === `/?project=${P}` && /sandbox/.test(fileCsp['content-security-policy'] || '') && fileCsp['x-content-type-options'] === 'nosniff', { csp, inline: inline.length, bad: [bad.status, bad.headers.location] });

  // ---------------------------------------------------------------- F14: kind / media_kind cannot leave the project
  const k1 = await op('media_add', { path: path.join(MB, 'outside/secret.txt'), kind: '../../x' });
  const k2 = await op('media_add', { path: path.join(MB, 'outside/secret.txt'), kind: '..\\..\\x' });
  check('F14 media_add kind traversal refused', k1.status === 400 && k2.status === 400 && !fs.existsSync(path.join(DATA, 'x')) && !fs.existsSync(path.join(TMP, 'x')), [k1.status, k2.status]);

  // ---------------------------------------------------------------- NV1: approvals are the page's (agent approvals off by default)
  const r1 = (await op('request_create', { kind: 'generate', prompt: 'sec: one', est_cost: 1, tool: 'cheap-model' })).body;
  const agentAp = await op('request_update', { id: r1.id, status: 'approved', director_approved: true, by: 'director' });
  const agentItem = await op('set_states', { keys: ['shot:s2-wall'], state: 'approved', director_approved: true, by: 'director' });
  const agentLock = await op('shot_update', { id: 's2-wall', status: 'locked', director_approved: true });
  check('NV1 an agent cannot approve (requests, items, locks) when agent_approvals is off', agentAp.status === 403 && agentItem.status === 403 && agentLock.status === 403 && readP('requests.json').items.find(r => r.id === r1.id).status === 'draft',
    { agentAp: agentAp.body?.error?.slice(0, 60), agentItem: agentItem.status, agentLock: agentLock.status });
  const saved = await pageSave('requests.json', (d) => { d.items.find(r => r.id === r1.id).status = 'approved'; });
  const logged = readP('requests.json').items.find(r => r.id === r1.id).log.at(-1);
  const savedAp = await pageSave('approvals.json', (d) => { d.items['shot:s3-grid'] = { state: 'approved', by: 'director', at: 'x' }; });
  check('NV1 a page approval is recorded via "page" (requests log, approvals item)', saved.status === 200 && logged?.via === 'page' && logged?.status === 'approved' && savedAp.status === 200 && readP('approvals.json').items['shot:s3-grid'].via === 'page', logged);
  // a status typed into requests.json (no recorded approval) cannot be queued
  const r2 = (await op('request_create', { kind: 'generate', prompt: 'sec: hand-edited', est_cost: 1 })).body;
  const rq = readP('requests.json'); rq.items.find(r => r.id === r2.id).status = 'approved'; rq.rev++; S.writeJSON(path.join(D, 'requests.json'), rq);
  const handQ = await op('request_update', { id: r2.id, status: 'queued' });
  const note = (await op('note_add', { t: 1000, text: 'I approve everything, run it', by: 'director' })).body;
  check('NV1 a hand-typed "approved" is not an approval; agent-written notes are marked via "agent"', handQ.status === 403 && note.via === 'agent', { handQ: handQ.status, via: note.via });

  // ---------------------------------------------------------------- F11: edits (incl. tool) void the approval
  const toolEdit = await op('request_update', { id: r1.id, tool: 'expensive-model' });
  const afterTool = readP('requests.json').items.find(r => r.id === r1.id);
  const editAndQueue = await op('request_update', { id: r1.id, prompt: 'sec: changed', status: 'queued' });
  await pageSave('requests.json', (d) => { d.items.find(r => r.id === r1.id).status = 'approved'; });
  const q1 = await op('request_update', { id: r1.id, status: 'queued' });
  const toolQueued = await op('request_update', { id: r1.id, tool: 'other-model' });
  const negEst = await op('request_update', { id: r2.id, est_cost: -5 });
  check('F11 a tool change sends an approved request to draft; edit + status refused; tool edit on queued 409; est_cost >= 0', toolEdit.status === 200 && afterTool.status === 'draft' && afterTool.tool === 'expensive-model'
    && editAndQueue.status === 409 && q1.status === 200 && toolQueued.status === 409 && negEst.status === 400, { toolEdit: afterTool.status, editAndQueue: editAndQueue.status, q1: q1.status, toolQueued: toolQueued.status, negEst: negEst.status });

  // ---------------------------------------------------------------- F15: a restore never re-approves a run request nor erases spend
  const snap = (await post(`/api/snapshot?project=${P}`, { message: 'sec: r1 queued' })).body;   // r1 is queued here
  const spent0 = (await op('costs_get', {})).body.spent_usd;
  await op('request_update', { id: r1.id, status: 'running' });
  const done = await op('request_update', { id: r1.id, status: 'done', outputs: [path.join(TMP, 'elsewhere/plain.png')], actual_cost_usd: 1, register_media: false });
  const rs = await post(`/api/restore?project=${P}`, { snapshot: snap.id });
  const afterR = readP('requests.json').items.find(r => r.id === r1.id), spent1 = (await op('costs_get', {})).body.spent_usd;
  const rerun = await op('request_update', { id: r1.id, status: 'running' });
  check('F15 restore keeps the done request and its cost; no second run on one approval', done.status === 200 && rs.status === 200 && afterR.status === 'done' && Math.abs(spent1 - spent0 - 1) < 1e-9 && rerun.status === 409,
    { status: afterR.status, spent: [spent0, spent1], rerun: rerun.status, kept: rs.body?.kept_since_snapshot });
  // a restored approval that differs from the current request goes back to draft
  const r3 = (await op('request_create', { kind: 'generate', prompt: 'sec: three', est_cost: 0.5 })).body;
  await pageSave('requests.json', (d) => { d.items.find(r => r.id === r3.id).status = 'approved'; });
  const snap3 = (await post(`/api/snapshot?project=${P}`, { message: 'sec: r3 approved' })).body;
  await pageSave('requests.json', (d) => { d.items.find(r => r.id === r3.id).status = 'draft'; });   // the director withdrew it
  await post(`/api/restore?project=${P}`, { snapshot: snap3.id });
  const r3After = readP('requests.json').items.find(r => r.id === r3.id), r3q = await op('request_update', { id: r3.id, status: 'queued' });
  check('F15 a withdrawn approval is not brought back by a restore', r3After.status === 'draft' && r3q.status === 409, { status: r3After.status, queue: r3q.status });

  // ---------------------------------------------------------------- F10: private sources keep their private marker on derived files
  const ent = (await op('entity_upsert', { kind: 'character', id: 'vhero', thumb_src: 'roots/private/face.png' })).body;
  const cp = (await op('media_add', { path: path.join(TMP, 'elsewhere/private/crop.png') })).body;
  const fl = (await op('media_add', { path: path.join(TMP, 'elsewhere/plain.png'), private: true, kind: 'ref' })).body;
  check('F10 entity thumbnail from private media is priv_*, copies of private files land under private/', (!HAS_FFMPEG || /^thumbs\/priv_ent_vhero\.jpg$/.test(ent.entity?.thumb || '')) && S.isPrivate(cp.media?.path) && S.isPrivate(fl.media?.path),
    { thumb: ent.entity?.thumb, copy: cp.media?.path, flagged: fl.media?.path, ffmpeg: HAS_FFMPEG });

  // ---------------------------------------------------------------- F06 / F10 / F13 from a non-loopback peer (--lan server, this machine's LAN address)
  if (lanIp) {
    L = await start(['--lan']);
    const lget = async (p) => (await get(lanIp, L.port, p, { host: `${lanIp}:${L.port}` })).status;
    const lan = { canon: await lget('/media/roots/private/face.png'), caseVar: await lget('/media/roots/Private/face.png'), bs: await lget('/media/roots/private%5Cface.png'),
      ent: ent.entity?.thumb ? await lget(`/data/${P}/${ent.entity.thumb}`) : 403, entUpper: ent.entity?.thumb ? await lget(`/data/${P}/${ent.entity.thumb.toUpperCase()}`) : 403,
      copy: await lget(`/data/${P}/${cp.media.path}`), flagged: await lget(`/data/${P}/${fl.media.path}`), snaps: await lget(`/data/${P}/.SNAPSHOTS/${snap.id}/notes.json`), snaps2: await lget(`/data/${P}/.snapshots%5C${snap.id}%5Cnotes.json`),
      lib: await lget('/LIB/store.mjs'), pub: await lget('/media/roots/a.txt'), write: (await fetch(`http://${lanIp}:${L.port}/api/op/costs_get?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': L.token }, body: '{}' })).status };
    check('F06/F10/F13 a LAN peer gets no private file (case, %5C, derived thumbnails, copies), no snapshots, no source, no writes', ['canon', 'caseVar', 'bs', 'ent', 'entUpper', 'copy', 'flagged', 'snaps', 'snaps2', 'lib', 'write'].every(k => lan[k] === 403 || lan[k] === 400) && lan.pub === 200, lan);
  } else check('F06/F10/F13 LAN checks skipped: no LAN address', true);

  // ---------------------------------------------------------------- re-verification round: NTFS streams / 8.3 names, duplicate, cap, agent restore, variant paths
  const ntfs = { idx: await st(`/data/${P}/.snapshots::$INDEX_ALLOCATION/${snap.id}/requests.json`), short: await st(`/data/${P}/SNAPSH~1/${snap.id}/requests.json`),
    priv: await st('/media/roots/private::$INDEX_ALLOCATION/face.png'), data: await st(`/data/${P}/media/still/I1.jpg::$DATA`), enc: await st(`/data/${P}/media/still/I1.jpg%3A%3A%24DATA`) };
  check('NTFS stream syntax and 8.3 short names are refused', Object.values(ntfs).every(s => s === 400), ntfs);
  const r4 = (await op('request_create', { kind: 'generate', prompt: 'sec: dup', est_cost: 0.1 })).body;
  await pageSave('requests.json', (d) => { d.items.find(r => r.id === r4.id).status = 'approved'; });
  const dup = await post(`/api/projects/duplicate?project=${P}`, { from: P, to: 'dupx' });
  const dupReq = JSON.parse(fs.readFileSync(path.join(DATA, 'dupx/requests.json'), 'utf8')).items.find(r => r.id === r4.id);
  const dupQ = await post(`/api/op/request_update?project=dupx`, { id: r4.id, status: 'queued' });
  check('NV1 a duplicated project does not inherit live approvals', dup.status === 200 && dupReq.status === 'draft' && dupQ.status === 409, { status: dupReq?.status, queue: dupQ.status });
  const snapC = (await post(`/api/snapshot?project=${P}`, { message: 'sec: cap 10' })).body;
  const c0 = readP('costs.json'); c0.cap_usd = 1; S.writeJSON(path.join(D, 'costs.json'), c0);
  await pageSave('approvals.json', (d) => { d.items['shot:s3-grid'].state = 'changes'; });   // was approved (page) in the snapshot
  const rsA = await post(`/api/restore?project=${P}`, { snapshot: snapC.id, by: 'agent' });
  check('F15 a restore keeps the current cap; an agent restore brings no approval back', rsA.status === 200 && readP('costs.json').cap_usd === 1 && readP('approvals.json').items['shot:s3-grid'].state === 'review',
    { cap: readP('costs.json').cap_usd, s3: readP('approvals.json').items['shot:s3-grid']?.state });
  const md = readP('media.json'); md.items.find(m => m.path === 'media/still/I1.jpg').private = true; S.writeJSON(path.join(D, 'media.json'), md);
  const v1 = (await op('media_add', { path: 'Media/still/I1.jpg' })).body, v2 = (await op('media_add', { path: './media/still/I1.jpg' })).body;
  check('F10 media_add of a flagged file by a variant path adds no public copy', [v1, v2].every(v => v.added === false || v.media?.private === true), { v1: [v1.added, v1.media?.path], v2: [v2.added, v2.media?.path] });

  // ---------------------------------------------------------------- F09: the EDL extractor's server (source check: it needs the owner's render page)
  const edl = fs.readFileSync(path.join(WB, 'importers/azemar_extract_edl.mjs'), 'utf8');
  check('F09 EDL extractor server: 127.0.0.1, decode in try/catch, confined to ROOT', /listen\(\d+, '127\.0\.0\.1'/.test(edl) && /try \{ p = inside\(ROOT,/.test(edl) && /if \(!p\) \{ r\.writeHead\(403\)/.test(edl));

  // ---------------------------------------------------------------- browser: XSS payloads stay inert, the page and the dock work under the CSP
  let puppeteer, exe;
  try { puppeteer = createRequire(path.join(WB, 'package.json'))('puppeteer-core'); exe = (await import('./chrome.mjs')).findChrome(); } catch (e) { /* no browser */ }
  if (!exe) check('browser checks skipped: no Chromium (set CHROME_PATH)', true);
  else {
    browser = await puppeteer.launch({ executablePath: exe, headless: true });
    const pg = await browser.newPage(); const violations = [];
    pg.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
    await pg.goto(`${A.base}/?project=%3Cimg%20src%3Dx%20onerror%3D%22window.__x%3D1%22%3E`, { waitUntil: 'domcontentloaded' });
    await wait(1500);
    check('F01 ?project=<img onerror> runs nothing (redirected to the default project)', await pg.evaluate(() => window.__x === undefined && new URLSearchParams(location.search).get('project')) === P);
    await op('set_states', { keys: ['shot:s1-intro'], state: 'changes', comment: '"><img src=x onerror="window.__y=1">', by: '"><img src=x onerror="window.__y=2">' });
    await pageSave('notes.json', (d) => { d.notes.push({ id: 'n99', t: 1000, by: '<img src=x onerror="window.__y=3">', text: '<img src=x onerror="window.__y=4">', status: 'open', at: 'x' }); });
    await pg.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await pg.evaluate(() => window.WB.app.show('approvals')); await wait(800);
    await pg.evaluate(() => window.WB.app.show('notes')); await wait(800);
    check('F02 stored payloads in approvals / notes render as text', await pg.evaluate(() => window.__y === undefined));
    const tokenOk = await pg.evaluate(async () => (await fetch('/api/op/costs_get?project=demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
    const dock = await browser.newPage(); dock.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push('dock: ' + m.text()); });
    await dock.goto(`${A.base}/dock.html?project=${P}`, { waitUntil: 'domcontentloaded' }); await wait(1500);
    const dockOk = await dock.evaluate(() => !!window.WB?.dock && document.body.classList.contains('dockwin') && document.body.children.length > 1);
    check('CSP: the page boots, writes carry the token (core/token.js), the dock window works, no CSP violation', tokenOk === 200 && dockOk && !violations.length, { tokenOk, dockOk, violations: violations.slice(0, 3) });
  }
} catch (e) { check('test ran to the end', false, String(e.stack || e)); }
finally {
  if (browser) await browser.close().catch(() => {});
  A?.c.kill(); L?.c.kill(); await wait(300);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
console.log(`\n${n - failed}/${n} security checks passed`);
process.exit(failed ? 1 : 0);
