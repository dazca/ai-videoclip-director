#!/usr/bin/env node
// Security regressions for the workbench server, the data layer and the page (audit F01-F15, NV1, NV2, the guided flow
// stages 1-6; the exporter's
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
const { tinyPngB64 } = await import('./tiny-png.mjs');

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

  // ---------------------------------------------------------------- guided flow: only the page marks a stage done; saved lyrics versions and authors cannot be rewritten
  const sDone = await op('stage_update', { stage: 'final', status: 'done' });
  const sNeeds = await op('stage_update', { stage: 'final', status: 'needs_you', blockers: ['sec'] });
  const lnA = (await op('lyrics_note_add', { line: 'verse/1', text: 'sec: an agent note' })).body;   // writes lyrics.json (v1 derived from the song)
  const pl = await pageSave('lyrics.json', (d) => { d.versions[0].sections[0].lines[0].text = 'FORGED'; const a = d.notes.find(x => x.id === lnA.id); a.by = 'director'; a.via = 'page';
    d.notes.push({ id: 'ln99', line: null, text: 'sec: page note claiming to be the agent', by: 'agent', via: 'agent', status: 'open', replies: [] }); });
  const LY = readP('lyrics.json');
  const badShape = await post(`/api/save/lyrics.json?project=${P}`, { base_rev: LY.rev, data: { versions: 'x' } });
  const ps = await pageSave('stages.json', (d) => { d.stages.find(x => x.id === 'final').status = 'done'; });
  const stg = readP('stages.json').stages.find(x => x.id === 'final');
  check('flow: an agent cannot mark a stage done; a page save cannot rewrite a saved lyrics version or a note author, is stamped director/page, marks done; a malformed lyrics.json is refused',
    sDone.status === 403 && sNeeds.status === 200 && pl.status === 200 && LY.versions[0].sections[0].lines[0].text !== 'FORGED' && LY.notes.find(x => x.id === lnA.id)?.via === 'agent'
    && LY.notes.find(x => x.id === 'ln99')?.via === 'page' && LY.notes.find(x => x.id === 'ln99')?.by === 'director' && badShape.status === 400 && ps.status === 200 && stg.status === 'done' && stg.done_by === 'director' && stg.via === 'page',
    { agentDone: sDone.status, v1: LY.versions[0].sections[0].lines[0].text, agentNote: LY.notes.find(x => x.id === lnA.id)?.via, pageNote: LY.notes.find(x => x.id === 'ln99'), badShape: badShape.status, stage: stg });
  const snapS = (await post(`/api/snapshot?project=${P}`, { message: 'sec: final done' })).body;
  await pageSave('stages.json', (d) => { d.stages.find(x => x.id === 'final').status = 'in_progress'; });   // the director reopened it
  const agentMove = await op('stage_update', { stage: 'lyrics', status: 'empty' });   // lyrics counts as done (the demo has lyrics)
  await post(`/api/restore?project=${P}`, { snapshot: snapS.id, by: 'agent' });
  const stR = readP('stages.json').stages.find(x => x.id === 'final');
  const sp1 = await op('song_attach', { path: 'roots/private/face.png' }), sp2 = await op('song_attach', { path: path.join(MB, 'outside/secret.txt') }), sp3 = await op('song_attach', { path: 'private/song.wav' });
  check('flow: an agent restore brings no done stage back; the agent cannot move a done stage; song_attach refuses non-audio and PRIVATE paths', stR.status === 'needs_you' && agentMove.status === 409 && [sp1, sp2, sp3].every(x => x.status === 400),
    { restored: stR.status, agentMove: agentMove.status, attach: [sp1.status, sp2.status, sp3.status] });

  // ---------------------------------------------------------------- stage 2: sketch files (ids, PNG check, body limit, token), page saves of scenes.json
  const SK = { w: 32, h: 18, strokes: [], mask: [], pins: [{ n: 1, x: 3, y: 3, text: 'sec' }] };
  const trav = {};
  for (const id of ['../evil', '..\\evil', 'a/b', 'A1', '.hidden', 'x'.repeat(65), 'ok:stream', '']) trav[id || '(empty)'] = (await op('sketch_save', { id, sketch: SK, png: tinyPngB64() })).status;
  const outside = ['evil.json', 'evil.png'].some(f => fs.existsSync(path.join(DATA, f)) || fs.existsSync(path.join(D, f)) || fs.existsSync(path.join(TMP, f)));
  const badPng = { gif: (await op('sketch_save', { id: 'sec1', sketch: SK, png: Buffer.from('GIF89a' + 'x'.repeat(40)).toString('base64') })).status,
    html: (await op('sketch_save', { id: 'sec1', sketch: SK, png: Buffer.from('<svg onload=alert(1)>' + 'x'.repeat(30)).toString('base64') })).status,
    junk: (await op('sketch_save', { id: 'sec1', sketch: SK, png: '%%%not base64%%%' })).status,
    mask: (await op('sketch_save', { id: 'sec1', sketch: SK, png: tinyPngB64(), mask: Buffer.from('not a png, not at all, no').toString('base64') })).status,
    noSketch: (await op('sketch_save', { id: 'sec1', png: tinyPngB64() })).status };
  check('sketch_save: ids that could leave sketches/ refused (.., \\, /, upper case, dot, too long, :), nothing written outside', Object.values(trav).every(x => x === 400) && !outside, trav);
  check('sketch_save: only real PNGs (signature + IHDR) for the image and the mask, a sketch JSON required; nothing written', Object.values(badPng).every(x => x === 400) && !fs.existsSync(path.join(D, 'sketches/sec1.json')), badPng);
  const big = 'A'.repeat(26e6);
  const over = await fetch(`${A.base}/api/op/sketch_save?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': A.token }, body: JSON.stringify({ id: 'secbig', sketch: SK, png: big }) }).then(r => r.status).catch(e => 'reset: ' + (e.cause?.code || e.message));
  const over5 = await fetch(`${A.base}/api/op/note_add?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wb-token': A.token }, body: JSON.stringify({ t: 1, text: 'x'.repeat(6e6) }) }).then(r => r.status).catch(e => 'reset: ' + (e.cause?.code || e.message));
  const mid = await op('sketch_save', { id: 'secmid', sketch: SK, png: 'data:image/png;base64,' + tinyPngB64(16, 9) + '', mask: null });   // a data: URL is fine
  const noTokSk = await post(`/api/op/sketch_save?project=${P}`, { id: 'secnotok', sketch: SK, png: tinyPngB64() }, { 'x-wb-token': '' });
  const foreignSk = await post(`/api/op/sketch_save?project=${P}`, { id: 'secforeign', sketch: SK, png: tinyPngB64() }, { origin: 'https://evil.example' });
  const alive = (await op('costs_get', {})).status;
  check('sketch_save body limit: 26 MB refused (413), other ops keep 5 MB, the server stays up; no token / a foreign Origin refused',
    (over === 413 || /^reset/.test(String(over))) && (over5 === 413 || /^reset/.test(String(over5))) && mid.status === 200 && noTokSk.status === 403 && foreignSk.status === 403 && alive === 200
    && !fs.existsSync(path.join(D, 'sketches/secbig.json')) && !fs.existsSync(path.join(D, 'sketches/secnotok.json')) && !fs.existsSync(path.join(D, 'sketches/secforeign.json')),
    { over, over5, mid: mid.status, noTok: noTokSk.status, foreign: foreignSk.status, alive });
  // a sketch over a PRIVATE underlay is private: under private/sketches/, flagged in media.json, never public
  const pv = (await op('sketch_save', { id: 'secpriv', sketch: { ...SK, underlay: { src: 'roots/private/face.png', opacity: 1 } }, png: tinyPngB64() })).body;
  const pvm = readP('media.json').items.find(m => m.id === 'sketch-secpriv');
  const pvAgent = (await op('sketch_get', { id: 'secpriv' })).body;
  check('a sketch over a PRIVATE underlay is stored under private/sketches/ and flagged private (no public thumbnail); via is never "page" from a tool', pv?.png === 'private/sketches/secpriv.png' && S.isPrivate(pv.png) && pvm?.private === true && pvm.thumb === null && pvAgent.private === true && pvAgent.via === 'agent',
    { pv, media: pvm && { path: pvm.path, private: pvm.private, thumb: pvm.thumb } });
  // scenes.json from the page: saved versions and authors kept, statuses / answers stamped, malformed refused; agent rules
  await op('scenes_update', { upsert: [{ id: 'sc01', title: 'sec: agent title' }], message: 'sec' });   // v2 (v1 derived from script.json)
  const sn = (await op('scene_note_add', { scene: 'sc01', text: 'sec: agent note' })).body;
  await op('intake_answer', { key: 'mood', text: 'sec: agent answer' });
  const okAgent = await op('scenes_update', { status: { sc01: 'ok' } });
  const sp = await pageSave('scenes.json', (d) => { d.versions[0].scenes[0].title = 'FORGED'; const a = d.notes.find(x => x.id === sn.id); a.by = 'director'; a.via = 'page';
    d.notes.push({ id: 'sn99', scene: null, text: 'sec: page note claiming the agent', by: 'agent', via: 'agent', status: 'open', replies: [] });
    d.states.sc01 = { status: 'ok', by: 'agent', via: 'agent' }; d.intake.mood.via = 'page'; d.intake.mood.by = 'director'; d.intake.where = { text: 'sec: page answer', by: 'agent', via: 'agent' }; });
  const SCN = readP('scenes.json');
  const badScenes = await post(`/api/save/scenes.json?project=${P}`, { base_rev: SCN.rev, data: { versions: [{ id: 'v1', scenes: [{ id: '../x', t0: 5, t1: 1 }] }] } });
  check('scenes.json: an agent cannot mark a scene ok; a page save cannot rewrite a saved version or an author, is stamped director/page (status, answer, new note); a malformed file is refused',
    okAgent.status === 403 && sp.status === 200 && SCN.versions[0].scenes[0].title !== 'FORGED' && SCN.notes.find(x => x.id === sn.id)?.via === 'agent' && SCN.notes.find(x => x.id === 'sn99')?.via === 'page'
    && SCN.states.sc01?.status === 'ok' && SCN.states.sc01.via === 'page' && SCN.intake.mood.via === 'agent' && SCN.intake.where.via === 'page' && SCN.intake.where.by === 'director' && badScenes.status === 400,
    { okAgent: okAgent.status, v1: SCN.versions[0].scenes[0].title, note: SCN.notes.find(x => x.id === sn.id)?.via, pageNote: SCN.notes.find(x => x.id === 'sn99')?.via, state: SCN.states.sc01, mood: SCN.intake.mood, where: SCN.intake.where, bad: badScenes.status });
  const snapK = (await post(`/api/snapshot?project=${P}`, { message: 'sec: sc01 ok' })).body;
  await pageSave('scenes.json', (d) => { d.states.sc01 = { status: 'draft' }; });   // the director took the ok back
  await post(`/api/restore?project=${P}`, { snapshot: snapK.id, by: 'agent' });
  check('an agent restore brings no scene ok back (needs_you); sketch files survive a restore', readP('scenes.json').states.sc01?.status === 'needs_you' && fs.existsSync(path.join(D, 'sketches/secmid.png')), readP('scenes.json').states.sc01);
  const stat2 = { sketchJs: await st('/core/sketch/sketch.js'), sketchCss: await st('/core/sketch/sketch.css'), cat: await st('/catalog/catalog.json'), catLic: await st('/catalog/LICENSES.md'),
    catImg: await st('/catalog/' + (fs.readdirSync(path.join(WB, 'catalog/body'))[0] ? 'body/' + fs.readdirSync(path.join(WB, 'catalog/body'))[0] : 'x.jpg')),
    dev: await st('/tools/sketch-dev.html'), catUp: await st('/catalog/%2E%2E/package.json'), deep: await st('/core/sketch/x/../../../lib/store.mjs'), skJson: await st(`/data/${P}/sketches/secmid.json`) };
  check('static allow-list: the sketch tool and the catalogue are served, tools/ and escapes are not', stat2.sketchJs === 200 && stat2.sketchCss === 200 && stat2.cat === 200 && stat2.catLic === 200 && stat2.catImg === 200 && stat2.dev === 403
    && [stat2.catUp, stat2.deep].every(x => x === 400 || x === 403) && stat2.skJson === 200, stat2);

  {
  // ---------------------------------------------------------------- stage 3: breakdown.json (ids, page saves, the page-only "Create entity", restore)
  const bIds = {};
  for (const [k, args] of Object.entries({
    itemId: { upsert: [{ id: '../evil', kind: 'prop', name: 'x' }] }, itemIdBs: { items: [{ id: '..\\evil', kind: 'prop', name: 'x' }] },
    sceneLink: { upsert: [{ kind: 'prop', name: 'x', links: [{ scene: '../evil' }] }] }, beat: { upsert: [{ kind: 'prop', name: 'x', links: [{ scene: 'sc01', beats: ['a/b'] }] }] },
    statusKey: { status: { '../x': 'review' } }, forId: { upsert: [{ kind: 'wardrobe', name: 'x', for: '..\\x' }] }, kind: { upsert: [{ kind: '<script>', name: 'x' }] },
    noName: { upsert: [{ kind: 'prop', name: '   ' }] }, removeId: { remove: ['../x'] }, notAList: { items: 'x' },
  })) bIds[k] = (await op('breakdown_update', args)).status;
  check('breakdown_update: bad item / scene / beat / for ids, kinds, names, status keys and shapes refused (400); nothing written', Object.values(bIds).every(x => x === 400) && !fs.existsSync(path.join(D, 'breakdown.json')), bIds);
  const bu = (await op('breakdown_update', { items: [{ kind: 'character', name: 'Sec Ada', links: ['sc01'] }, { kind: 'location', name: 'Sec Room', links: ['sc01'] }, { kind: 'wardrobe', name: 'Sec Coat', for: 'bi01', links: ['sc01'] }, { kind: 'fx', name: 'Sec Smoke', links: ['sc01'] }], message: 'sec' })).body;
  const bn = (await op('breakdown_note_add', { item: 'bi01', text: 'sec: agent note' })).body;
  const okA = await op('breakdown_update', { status: { bi01: 'ok' } });
  await pageSave('breakdown.json', (d) => { d.states.bi02 = { status: 'ok' }; });
  const snapB = (await post(`/api/snapshot?project=${P}`, { message: 'sec: breakdown bi02 ok' })).body;
  // "Create entity": the page's own request only (token + this origin); the agent surface is refused whatever it claims
  const pr = (b, h = {}) => post(`/api/op/breakdown_promote?project=${P}`, b, h), ownO = { origin: A.base };
  const prom = { noTok: (await pr({ item: 'bi01' }, { 'x-wb-token': '' })).status, foreign: (await pr({ item: 'bi01' }, { origin: 'https://evil.example' })).status,
    agent: (await pr({ item: 'bi01' })).status, agentClaimsPage: (await pr({ item: 'bi01', via: 'page' })).status,
    badEnt: (await pr({ item: 'bi01', entity_id: '../../x' }, ownO)).status, badItem: (await pr({ item: '../x' }, ownO)).status, badChar: (await pr({ item: 'bi03', character: '..\\x' }, ownO)).status,
    fx: (await pr({ item: 'bi04' }, ownO)).status, wrongKind: (await pr({ item: 'bi02', entity_id: 'ada' }, ownO)).status };
  let offAgent = null; try { S.ops.breakdown_promote(P, { item: 'bi01' }); } catch (e) { offAgent = e.code; }
  const pc = await pr({ item: 'bi01' }, ownO), pl = await pr({ item: 'bi03' }, ownO), again = (await pr({ item: 'bi01' }, ownO)).status;
  const entA = fs.existsSync(path.join(D, 'entities/characters/sec-ada.json')) ? readP('entities/characters/sec-ada.json') : null;
  check('Create entity: refused without the token, from a foreign Origin, to the agent surface (no Origin, a claimed via:"page", offline); bad ids, FX and a kind mismatch refused; the page makes a draft entity and a look, once',
    prom.noTok === 403 && prom.foreign === 403 && prom.agent === 403 && prom.agentClaimsPage === 403 && offAgent === 403 && prom.badEnt === 400 && prom.badItem === 400 && prom.badChar === 400 && prom.fx === 400 && prom.wrongKind === 409
    && pc.status === 200 && pc.body?.entity_id === 'sec-ada' && entA?.status === 'draft' && entA.breakdown?.item === 'bi01' && pl.body?.look_id === 'sec-coat' && entA.looks?.[0]?.id === 'sec-coat' && again === 409 && !fs.existsSync(path.join(DATA, 'x.json')),
    { prom, offAgent, pc: pc.body, pl: pl.body, again, ent: entA && { status: entA.status, looks: entA.looks?.map(l => l.id) } });
  // page saves of breakdown.json: saved versions, note authors and entity links cannot be forged; statuses are stamped
  const bp = await pageSave('breakdown.json', (d) => { d.versions[0].items[0].name = 'FORGED'; const a = d.notes.find(x => x.id === bn.id); a.by = 'director'; a.via = 'page';
    d.notes.push({ id: 'bn99', item: null, text: 'sec: page note claiming the agent', by: 'agent', via: 'agent', status: 'open', replies: [] });
    d.states.bi02 = { status: 'ok', by: 'agent', via: 'agent', entity_id: 'forged-entity' }; d.states.bi01 = { status: 'ok' }; d.states.bi04 = { status: 'review', by: 'agent', via: 'agent', entity_id: 'forged-two' }; });
  const BDN = readP('breakdown.json');
  const badBd = await post(`/api/save/breakdown.json?project=${P}`, { base_rev: BDN.rev, data: { versions: [{ id: 'v1', items: [{ id: '../x', kind: 'prop', name: 'x', links: [] }] }], current: 'v1' } });
  const badSt = await post(`/api/save/breakdown.json?project=${P}`, { base_rev: BDN.rev, data: { ...BDN, states: { bi01: { status: 'approved' } } } });
  check('breakdown.json from the page: a saved version, a note author and an entity link cannot be forged (nor dropped); a changed status is stamped director / page; malformed refused (400); an agent cannot mark ok (403)',
    okA.status === 403 && bp.status === 200 && BDN.versions[0].items[0].name === 'Sec Ada' && BDN.notes.find(x => x.id === bn.id)?.via === 'agent' && BDN.notes.find(x => x.id === 'bn99')?.via === 'page'
    && BDN.states.bi02?.via === 'page' && !BDN.states.bi02.entity_id && BDN.states.bi01?.entity_id === 'sec-ada' && BDN.states.bi04?.via === 'page' && BDN.states.bi04.by === 'director' && !BDN.states.bi04.entity_id && badBd.status === 400 && badSt.status === 400,
    { okA: okA.status, v1: BDN.versions[0].items[0].name, states: BDN.states, bad: [badBd.status, badSt.status] });
  await pageSave('breakdown.json', (d) => { d.states.bi02 = { status: 'draft' }; });   // the director took the ok back
  await post(`/api/restore?project=${P}`, { snapshot: snapB.id, by: 'agent' });
  const BDR = readP('breakdown.json');
  check('an agent restore brings no item ok back (review); entities and their links roll back together', BDR.states.bi02?.status === 'review' && !BDR.states.bi01?.entity_id && !BDR.states.bi03?.look_id && !fs.existsSync(path.join(D, 'entities/characters/sec-ada.json')),
    BDR.states);
  }

  // ---------------------------------------------------------------- stage 4 (characters): uploads, private refs, page-only acts, the CSP
  {
    await op('entity_upsert', { kind: 'character', id: 'sec-cast', name: 'Sec Cast' });
    const pageOp = (name, body, headers = {}) => post(`/api/op/${name}?project=${P}`, body, { origin: A.base, ...headers });
    const b64 = (s) => Buffer.from(s).toString('base64'), PNG = tinyPngB64(8, 8);
    put(path.join(TMP, 'elsewhere/notimage.png'), 'just text with a png name');
    const up = {
      agent: (await op('ref_upload', { id: 'sec-cast', kind: 'photo', name: 'a.png', data: PNG })).status,
      claim: (await op('ref_upload', { id: 'sec-cast', kind: 'photo', name: 'a.png', data: PNG, via: 'page' })).status,
      foreign: (await post(`/api/op/ref_upload?project=${P}`, { id: 'sec-cast', kind: 'photo', name: 'a.png', data: PNG }, { origin: 'https://evil.example' })).status,
      svg: (await pageOp('ref_upload', { id: 'sec-cast', kind: 'photo', name: 'x.svg', data: b64('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>') })).status,
      html: (await pageOp('ref_upload', { id: 'sec-cast', kind: 'photo', name: 'x.png', data: b64('<html><script>alert(1)</script></html>') })).status,
      notB64: (await pageOp('ref_upload', { id: 'sec-cast', kind: 'photo', name: 'x.png', data: '%%%' })).status,
      badId: (await pageOp('ref_upload', { id: '../x', kind: 'photo', name: 'x.png', data: PNG })).status,
      badKind: (await pageOp('ref_upload', { id: 'sec-cast', kind: 'public', name: 'x.png', data: PNG })).status,
      localText: (await pageOp('ref_upload', { id: 'sec-cast', kind: 'photo', path: path.join(TMP, 'elsewhere/notimage.png') })).status,
      relPath: (await pageOp('ref_upload', { id: 'sec-cast', kind: 'photo', path: 'media.json' })).status,
    };
    const okUp = (await pageOp('ref_upload', { id: 'sec-cast', kind: 'photo', name: '../../evil.png', data: PNG })).body;
    const okLocal = (await pageOp('ref_upload', { id: 'sec-cast', kind: 'photo', path: path.join(TMP, 'elsewhere/plain.png') })).body;
    const mUp = readP('media.json').items.find(m => m.path === okUp?.ref?.path);
    check('ref_upload (stage 4 reference photos): page only (no Origin, a claimed via:"page", a foreign Origin: 403); only real images (SVG, HTML, not base64, a text file: 400); a photo always lands in private/refs/<character>/ (a ../ name stays inside), flagged private',
      up.agent === 403 && up.claim === 403 && up.foreign === 403 && [up.svg, up.html, up.notB64, up.badId, up.badKind, up.localText, up.relPath].every(s => s === 400)
      && /^private\/refs\/sec-cast\/[a-z0-9_-]+\.png$/.test(okUp?.ref?.path || '') && S.isPrivate(okUp.ref.path) && fs.existsSync(path.join(D, okUp.ref.path)) && mUp?.private === true && mUp.status === 'private'
      && /^private\/refs\/sec-cast\//.test(okLocal?.ref?.path || '') && !fs.existsSync(path.join(D, 'evil.png')) && !fs.existsSync(path.join(DATA, 'evil.png')),
      { up, okUp: okUp?.ref, okLocal: okLocal?.ref?.path, media: mUp && { private: mUp.private, thumb: mUp.thumb } });
    // the director's acts are the page's: an agent cannot approve the identity or a look, nor write the trees
    const base = await pageOp('character_act', { id: 'sec-cast', act: 'base', base: { text: 'x', refs: [{ path: okUp.ref.path, source: 'photo' }, { path: 'catalog/body/mannequin_neutral_turnaround.jpg', source: 'catalog' }] } });
    const acts = {
      approve: (await op('character_act', { id: 'sec-cast', act: 'approve', tree: 'identity' })).status,
      claim: (await op('character_act', { id: 'sec-cast', act: 'approve', tree: 'identity', via: 'page' })).status,
      foreign: (await post(`/api/op/character_act?project=${P}`, { id: 'sec-cast', act: 'approve' }, { origin: 'https://evil.example' })).status,
      noToken: (await post(`/api/op/character_act?project=${P}`, { id: 'sec-cast', act: 'approve' }, { origin: A.base, 'x-wb-token': '' })).status,
      lookAp: (await op('entity_upsert', { kind: 'character', id: 'sec-cast', look: { id: 'l1', status: 'approved' } })).status,
      lookLock: (await op('entity_upsert', { kind: 'character', id: 'sec-cast', fields: { looks: [{ id: 'l2', status: 'locked' }] } })).status,
      importFlag: (await op('entity_upsert', { kind: 'character', id: 'sec-cast', look: { id: 'l3', status: 'approved' }, import_ok: true })).status,
      lookCreate: (await op('look_create', { id: 'sec-cast', name: 'Agent look' })).body?.status,
    };
    const iterW = (await op('entity_upsert', { kind: 'character', id: 'sec-cast', fields: { iter: { trees: { identity: { approved: 'n01' } } }, base: { refs: [] } } })).body;
    const E = readP('entities/characters/sec-cast.json');
    let off = null; try { S.ops.character_act(P, { id: 'sec-cast', act: 'approve' }); } catch (e) { off = e.code; }
    check('an agent cannot approve the identity or a look: character_act refused to the agent surface (no Origin, a claimed via, a foreign Origin, no token, offline: 403); entity_upsert cannot approve or lock a look (import_ok is stripped by the server: 403), nor write iter / base (ignored); look_create is "review"',
      base.status === 200 && acts.approve === 403 && acts.claim === 403 && acts.foreign === 403 && acts.noToken === 403 && off === 403 && acts.lookAp === 403 && acts.lookLock === 403 && acts.importFlag === 403 && acts.lookCreate === 'review'
      && iterW?.warnings?.length === 2 && !E.iter?.trees?.identity?.approved && E.base?.refs?.length === 2 && !(E.looks || []).some(l => l.status === 'approved' || l.status === 'locked'),
      { base: base.status, acts, off, warnings: iterW?.warnings });
    // a remote (LAN) client: no private file, and the JSON it reads carries no private path nor item flagged private
    if (L) {
      const lj = async (p) => { const r = await get(lanIp, L.port, p, { host: `${lanIp}:${L.port}` }); let j = null; try { j = JSON.parse(r.body); } catch (e) { /* not JSON */ } return { status: r.status, body: r.body, j }; };
      const lm = await lj(`/data/${P}/media.json`), le = await lj(`/data/${P}/entities/characters/sec-cast.json`), lf = await lj(`/data/${P}/${okUp.ref.path}`);
      const local = await get('127.0.0.1', A.port, `/data/${P}/entities/characters/sec-cast.json`, { host: `localhost:${A.port}` });
      check('a LAN peer gets no private reference: the photo is 403, media.json lists no private item, the character\'s base lists no private ref (the local page still sees it)',
        lf.status === 403 && lm.status === 200 && Array.isArray(lm.j?.items) && !lm.j.items.some(m => m.private || S.isPrivate(m.path)) && !/private\//.test(lm.body) && le.status === 200 && !/private\//.test(le.body)
        && le.j?.base?.refs?.length === 1 && /private\/refs\/sec-cast/.test(local.body),
        { photo: lf.status, media: lm.j?.items?.length, entityRefs: le.j?.base?.refs?.map(r => r.path) });
    } else check('stage 4 LAN checks skipped: no LAN address', true);
    // the CSP: the page may fetch only this server and the Openverse API
    const shell = await get('127.0.0.1', A.port, `/?project=${P}`, { host: `localhost:${A.port}` });
    const cs = /connect-src ([^;]*)/.exec(shell.headers['content-security-policy'] || '')?.[1]?.trim();
    check('CSP: connect-src is this server and https://api.openverse.org only (img-src keeps https: for remote media)', cs === "'self' https://api.openverse.org" && /img-src 'self' data: blob: https:/.test(shell.headers['content-security-policy'] || ''), cs);
  }

  // ---------------------------------------------------------------- stage 5 (scenery): the same asset code path for locations and props
  {
    await op('entity_upsert', { kind: 'location', id: 'sec-place', name: 'Sec Place' });
    await op('entity_upsert', { kind: 'prop', id: 'sec-thing', name: 'Sec Thing' });
    const pageOp = (name, body, headers = {}) => post(`/api/op/${name}?project=${P}`, body, { origin: A.base, ...headers }), PNG = tinyPngB64(8, 8);
    const up = {
      agent: (await op('ref_upload', { type: 'location', id: 'sec-place', kind: 'photo', name: 'a.png', data: PNG })).status,
      wrongType: (await pageOp('ref_upload', { type: 'prop', id: 'sec-place', kind: 'photo', name: 'a.png', data: PNG })).status,
      badType: (await pageOp('ref_upload', { type: '../x', id: 'sec-place', kind: 'photo', name: 'a.png', data: PNG })).status,
    };
    const okUp = (await pageOp('ref_upload', { type: 'location', id: 'sec-place', kind: 'photo', name: '../../flat.png', data: PNG })).body;
    const mUp = readP('media.json').items.find(m => m.path === okUp?.ref?.path);
    check('ref_upload for a location: page only (403 to the agent surface); the type must match the entity (404) and be known (400); a scouting photo lands in private/refs/<id>/, flagged private',
      up.agent === 403 && up.wrongType === 404 && up.badType === 400 && /^private\/refs\/sec-place\/[a-z0-9_-]+\.png$/.test(okUp?.ref?.path || '') && mUp?.private === true,
      { up, path: okUp?.ref?.path });
    const base = await pageOp('asset_act', { type: 'location', id: 'sec-place', act: 'base', base: { text: 'x', refs: [{ path: okUp.ref.path, source: 'photo' }, { path: 'catalog/location/lakeside.jpg', source: 'catalog' }] } });
    const acts = {
      approve: (await op('asset_act', { type: 'location', id: 'sec-place', act: 'approve', tree: 'base' })).status,
      claim: (await op('asset_act', { type: 'location', id: 'sec-place', act: 'approve', tree: 'base', via: 'page' })).status,
      foreign: (await post(`/api/op/asset_act?project=${P}`, { type: 'location', id: 'sec-place', act: 'approve' }, { origin: 'https://evil.example' })).status,
      noToken: (await post(`/api/op/asset_act?project=${P}`, { type: 'location', id: 'sec-place', act: 'approve' }, { origin: A.base, 'x-wb-token': '' })).status,
      use: (await op('asset_act', { type: 'prop', id: 'sec-thing', act: 'use', scene: 'sc01', variant: null })).status,
      viaChar: (await op('character_act', { type: 'location', id: 'sec-place', act: 'approve', via: 'page' })).status,
      varAp: (await op('entity_upsert', { kind: 'prop', id: 'sec-thing', fields: { variants: [{ id: 'v1', status: 'approved' }] } })).status,
      varCreate: (await op('variant_create', { type: 'prop', id: 'sec-thing', axes: { state: 'broken' } })).body?.status,
      badAxis: (await op('variant_create', { type: 'prop', id: 'sec-thing', axes: { state: '<img src=x>' } })).status,
      badScene: (await op('variant_create', { type: 'prop', id: 'sec-thing', axes: { state: 'lit' }, scenes: ['../../x'] })).status,
    };
    const upW = (await op('entity_upsert', { kind: 'location', id: 'sec-place', fields: { iter: { trees: { base: { approved: 'n01' } } }, base: { refs: [] }, uses: { sc01: { variant: 'x', via: 'page' } } } })).body;
    const E = readP('entities/locations/sec-place.json');
    let off = null; try { S.ops.asset_act(P, { type: 'location', id: 'sec-place', act: 'approve' }); } catch (e) { off = e.code; }
    const fake = await op('request_create', { kind: 'location-plate', prompt: 'x', est_cost: 0, asset: { type: 'location', id: 'sec-place', tree: 'base' }, char: { id: 'sec-cast' } });
    check('an agent cannot approve a location / prop base or variant nor pick a scene\'s variant: asset_act refused to the agent surface (no Origin, a claimed via, a foreign Origin, no token, offline: 403; character_act cannot be used to reach another type); entity_upsert cannot approve a variant (403) nor write iter / base / uses (ignored); variant_create is "review" and checks axes and scene ids (400); a request carries one link (asset wins over char)',
      base.status === 200 && acts.approve === 403 && acts.claim === 403 && acts.foreign === 403 && acts.noToken === 403 && acts.use === 403 && acts.viaChar === 403 && off === 403 && acts.varAp === 403 && acts.varCreate === 'review' && acts.badAxis === 400 && acts.badScene === 400
      && upW?.warnings?.length === 3 && !E.iter?.trees?.base?.approved && !E.uses && E.base?.refs?.length === 2 && fake.status === 200 && fake.body?.asset?.type === 'location' && !fake.body.char,
      { base: base.status, acts, off, warnings: upW?.warnings, fake: fake.body?.asset });
    if (L) {
      const lj = async (p) => { const r = await get(lanIp, L.port, p, { host: `${lanIp}:${L.port}` }); let j = null; try { j = JSON.parse(r.body); } catch (e) { /* not JSON */ } return { status: r.status, body: r.body, j }; };
      const le = await lj(`/data/${P}/entities/locations/sec-place.json`), lf = await lj(`/data/${P}/${okUp.ref.path}`);
      check('a LAN peer gets no private location reference (the photo 403; the base lists only the catalogue ref)', lf.status === 403 && le.status === 200 && !/private\//.test(le.body) && le.j?.base?.refs?.length === 1, { photo: lf.status, refs: le.j?.base?.refs?.map(r => r.path) });
    } else check('stage 5 LAN checks skipped: no LAN address', true);
  }

  {
  // ---------------------------------------------------------------- stage 6 (storyboard): ids, the page-only shot approval, page saves of storyboard.json
  const sIds = {};
  for (const [k, a] of Object.entries({ shotId: { upsert: [{ id: '../evil', t0: 0, t1: 1000 }] }, shotIdBs: { shots: [{ id: '..\\evil', t0: 0, t1: 1000 }] }, sketch: { upsert: [{ id: 's2-wall', sketch: '../../evil' }] },
    cast: { upsert: [{ id: 's2-wall', cast: ['../x'] }] }, scene: { upsert: [{ id: 's2-wall', scene: '../x' }] }, variant: { upsert: [{ id: 's2-wall', variants: { '../x': 'y' } }] }, clip: { upsert: [{ id: 's2-wall', clips: ['<script>'] }] },
    kind: { upsert: [{ id: 's2-wall', kind: '<b>' }] }, statusKey: { status: { '../x': 'review' } }, removeId: { remove: ['../x'] }, notAList: { shots: 'x' } })) sIds[k] = (await op('shots_update', a)).status;
  check('shots_update: bad shot / sketch / entity / scene / variant / clip ids, kinds, status keys and shapes refused (400); nothing written', Object.values(sIds).every(x => x === 400) && !fs.existsSync(path.join(D, 'storyboard.json')), sIds);
  const apBefore = readP('approvals.json').items['shot:s2-wall']?.state;
  const stA = await op('shots_update', { status: { 's2-wall': 'approved' }, director_approved: true }), stL = await op('shots_update', { status: { 's2-wall': 'locked' } });
  let offA = null; try { S.ops.shots_update(P, { status: { 's2-wall': 'approved' } }); } catch (e) { offA = e.code; }
  check('an agent cannot approve or lock a shot: shots_update 403 (over HTTP, with a claimed director_approved, and offline); approvals.json unchanged',
    stA.status === 403 && stL.status === 403 && offA === 403 && readP('approvals.json').items['shot:s2-wall']?.state === apBefore, { stA: stA.status, stL: stL.status, offA });
  await op('shots_update', { upsert: [{ id: 's2-wall', text: 'sec: agent text' }], message: 'sec' });   // v2 (v1 derived from shots.json)
  const sn6 = (await op('shot_note_add', { shot: 's2-wall', text: 'sec: agent note' })).body;
  const bp6 = await pageSave('storyboard.json', (d) => { d.versions[1].shots.find(s => s.id === 's2-wall').text = 'FORGED'; const a = d.notes.find(x => x.id === sn6.id); a.by = 'director'; a.via = 'page';
    d.notes.push({ id: 'sbn99', shot: null, text: 'sec: page note claiming the agent', by: 'agent', via: 'agent', status: 'open', replies: [] }); });
  const SBF = readP('storyboard.json'), bads = {};
  for (const [k, fn] of Object.entries({ id: (d) => { d.versions.at(-1).shots[0].id = '../x'; }, times: (d) => { d.versions.at(-1).shots[0].t1 = -5; }, sketch: (d) => { d.versions.at(-1).shots[0].sketch = '../../x'; },
    thumb: (d) => { d.versions.at(-1).shots[0].thumb = '../../../secret.jpg'; }, cast: (d) => { d.versions.at(-1).shots[0].cast = ['<img>']; }, current: (d) => { d.current = 'nope'; }, notes: (d) => { d.notes = 'x'; } })) {
    const cur = structuredClone(SBF); fn(cur); bads[k] = (await post(`/api/save/storyboard.json?project=${P}`, { base_rev: SBF.rev, data: cur })).status;
  }
  check('storyboard.json from the page: a saved version and a note author cannot be forged; a new note is stamped director / page; malformed files (bad ids, times, sketch / thumb paths, current, notes) refused (400)',
    bp6.status === 200 && SBF.versions[1].shots.find(s => s.id === 's2-wall')?.text === 'sec: agent text' && SBF.notes.find(x => x.id === sn6.id)?.via === 'agent' && SBF.notes.find(x => x.id === 'sbn99')?.via === 'page' && SBF.notes.find(x => x.id === 'sbn99').by === 'director'
    && Object.values(bads).every(x => x === 400), { bp: bp6.status, text: SBF.versions[1].shots.find(s => s.id === 's2-wall')?.text, bads });
  }

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
    await op('lyrics_update', { text: '[<img src=x onerror="window.__z=1">]\nline <img src=x onerror="window.__z=2"> here\n<b>bold</b>', message: '<img src=x onerror="window.__z=3">' });
    await op('lyrics_note_add', { line: null, text: '<img src=x onerror="window.__z=4">', by: '<img src=x onerror="window.__z=5">' });
    await pageSave('stages.json', (d) => { d.stages[1].note = '<img src=x onerror="window.__z=6">'; d.stages[1].blockers = ['<img src=x onerror="window.__z=7">']; });
    await pg.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await pg.evaluate(() => window.WB.stages.open('lyrics')); await wait(800);
    await pg.evaluate(() => document.querySelector('.lytabs [data-side=versions]')?.click()); await wait(300);
    await pg.evaluate(() => window.WB.stages.open('script')); await wait(500);
    check('F02 stored payloads in lyrics (lines, section tags, notes, version messages) and stages (notes, blockers) render as text', await pg.evaluate(() => window.__z === undefined && !document.querySelector('.lyws img, .sgbar img, #rail img')));
    const X = (n) => `<img src=x onerror="window.__s=${n}">`;
    await op('scenes_update', { upsert: [{ id: 'sc02', title: X(1), text: X(2), beats: [{ t: 5000, text: X(3) }] }], message: X(4) });
    await op('scene_note_add', { scene: 'sc02', text: X(5), by: X(6) });
    await op('intake_answer', { key: 'refs', text: X(7), by: X(8), asked_in_chat: true });
    await pg.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await pg.evaluate(() => window.WB.stages.open('script')); await wait(800);
    await pg.evaluate(() => { window.WB.script.focus('sc02'); }); await wait(300);
    for (const side of ['notes', 'versions', 'intake']) { await pg.evaluate((s) => document.querySelector(`.scws .lytabs [data-side=${s}]`)?.click(), side); await wait(200); }
    await pg.evaluate(() => window.WB.app.show('timeline')); await wait(800);
    check('F02 stored payloads in the script (scene titles, text, beats, notes, intake, version messages, the timeline scenes column) render as text', await pg.evaluate(() => window.__s === undefined && !document.querySelector('.scws img:not([src*="sketches/"]), .col-scenes img')));
    const Y = (n) => `<img src=x onerror="window.__b=${n}">`;
    await op('breakdown_update', { upsert: [{ kind: 'character', name: Y(1), description: Y(2), aliases: [Y(3)], links: [{ scene: 'sc02', beats: ['b1'], note: Y(4) }] }, { kind: 'wardrobe', name: Y(5), for: 'bi01', links: ['sc02'] }], message: Y(6) });
    await op('breakdown_note_add', { item: 'bi01', text: Y(7), by: Y(8) });
    await pg.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await pg.evaluate(() => window.WB.stages.open('breakdown')); await wait(800);
    await pg.evaluate(() => { const s = window.WB.breakdown.ws; const it = s.draft.find(i => i.kind === 'character'); s.focus(it.id); }); await wait(300);
    for (const side of ['notes', 'versions']) { await pg.evaluate((x) => document.querySelector(`.bdws .lytabs [data-side=${x}]`)?.click(), side); await wait(200); }
    await pg.evaluate(() => { const s = window.WB.breakdown.ws; s.view = 'matrix'; s.render(); }); await wait(300);
    await pg.evaluate(() => window.WB.app.show('timeline')); await wait(800);
    check('F02 stored payloads in the breakdown (item names, aliases, descriptions, link notes, notes, version messages; list, matrix, the timeline scenes column) render as text', await pg.evaluate(() => window.__b === undefined && !document.querySelector('.bdws img, .col-scenes img')));
    const tokenOk = await pg.evaluate(async () => (await fetch('/api/op/costs_get?project=demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
    const dock = await browser.newPage(); dock.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push('dock: ' + m.text()); });
    await dock.goto(`${A.base}/dock.html?project=${P}`, { waitUntil: 'domcontentloaded' }); await wait(1500);
    const dockOk = await dock.evaluate(() => !!window.WB?.dock && document.body.classList.contains('dockwin') && document.body.children.length > 1);
    check('CSP: the page boots, writes carry the token (core/token.js), the dock window works, no CSP violation', tokenOk === 200 && dockOk && !violations.length, { tokenOk, dockOk, violations: violations.slice(0, 3) });
    // stage 4: stored payloads in characters (names, roles, looks, notes, request texts, pins) render as text; the CSP
    // blocks fetches to any other origin than this server and Openverse
    const C = (n) => `<img src=x onerror="window.__c=${n}">`;
    await op('entity_upsert', { kind: 'character', id: 'sec-xss', name: C(1), fields: { role: C(2) } });
    await op('look_create', { id: 'sec-xss', name: C(3), garments: [C(4)], description: C(5) });
    await op('character_note_add', { id: 'sec-xss', text: C(6), by: C(7) });
    await op('request_create', { kind: C(8), prompt: C(9), est_cost: 0, char: { id: 'sec-xss', text: C(10), pins: [{ x: 1, y: 1, text: C(11) }] } });
    const cp = await browser.newPage(); const cv = [];
    cp.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) cv.push(m.text()); });
    await cp.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await cp.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await cp.evaluate(() => window.WB.stages.open('characters')); await wait(600);
    await cp.evaluate(() => window.WB.characters.open('sec-xss')); await wait(300);
    for (const t of ['identity', 'looks', 'notes']) { await cp.evaluate((x) => document.querySelector(`.chtabs [data-tab=${x}]`)?.click(), t); await wait(250); }
    const inert = await cp.evaluate(() => window.__c === undefined && !document.querySelector('.chws img[src="x"]'));
    const noViolation = !cv.length;
    const blocked = await cp.evaluate(async () => { let v = null; const f = (e) => { v = e.blockedURI; }; document.addEventListener('securitypolicyviolation', f); let failed = false; try { await fetch('https://example.org/leak'); } catch (e) { failed = true; } await new Promise(r => setTimeout(r, 100)); return { failed, v }; });
    check('F02 stored payloads in the characters stage (name, role, looks, garments, notes, request kind / text, pins) render as text; the CSP blocks a fetch to another origin',
      inert && noViolation && blocked.failed && /example\.org/.test(blocked.v || ''), { inert, cv: cv.slice(0, 2), blocked });
    await cp.close();
    // the same for the scenery stage: a location and a prop with payloads in the name, description, variant name / axes / notes, notes, scene picks
    await op('entity_upsert', { kind: 'location', id: 'sec-xloc', name: C(21), fields: { description: C(22) } });
    await op('entity_upsert', { kind: 'prop', id: 'sec-xprop', name: C(23), fields: { description: C(24) } });
    await op('variant_create', { type: 'location', id: 'sec-xloc', name: C(25), axes: { angle: 'reverse', tod: 'night' }, description: C(26), scenes: ['sc01'] });
    await op('variant_create', { type: 'prop', id: 'sec-xprop', axes: { state: 'broken' }, name: C(27) });
    await op('asset_note_add', { type: 'location', id: 'sec-xloc', scene: 'sc01', text: C(28), by: C(29) });
    await op('request_create', { kind: C(30), prompt: C(31), est_cost: 0, asset: { type: 'location', id: 'sec-xloc', text: C(32), pins: [{ x: 1, y: 1, text: C(33) }] } });
    const sp = await browser.newPage(); const sv = [];
    sp.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) sv.push(m.text()); });
    await sp.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await sp.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await sp.evaluate(() => window.WB.stages.open('scenery')); await wait(600);
    for (const id of ['sec-xloc', 'sec-xprop']) {
      await sp.evaluate((x) => window.WB.scenery.open(x), id); await wait(250);
      for (const t of ['base', 'variants', 'scenes', 'notes']) { await sp.evaluate((x) => document.querySelector(`.chtabs [data-tab=${x}]`)?.click(), t); await wait(200); }
    }
    await sp.evaluate(() => document.querySelector('.chlook[data-look]')?.click()); await wait(200);
    const sInert = await sp.evaluate(() => window.__c === undefined && !document.querySelector('.chws img[src="x"]') && document.querySelectorAll('.chws .chrow').length >= 2);
    check('F02 stored payloads in the scenery stage (location / prop names and descriptions, variant names and notes, scene notes, request kind / text, pins) render as text',
      sInert && !sv.length, { sInert, sv: sv.slice(0, 2) });
    await sp.close();
    // the same for the storyboard stage: payloads in shot titles, text, camera, notes, version messages, an asset name
    const Z = (n) => `<img src=x onerror="window.__sb=${n}">`;
    await op('shots_update', { upsert: [{ id: 's2-wall', title: Z(1), text: Z(2), camera: Z(3), locations: ['sec-xloc'] }], message: Z(4) });
    await op('shot_note_add', { shot: 's2-wall', text: Z(5), by: Z(6) });
    const bpg = await browser.newPage(); const bv = [];
    bpg.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) bv.push(m.text()); });
    await bpg.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await bpg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await bpg.evaluate(() => window.WB.stages.open('storyboard')); await wait(700);
    await bpg.evaluate(() => window.WB.storyboard.focus('s2-wall')); await wait(300);
    for (const t of ['shot', 'gaps', 'notes', 'versions']) { await bpg.evaluate((x) => document.querySelector(`.sbside .lytabs [data-side=${x}]`)?.click(), t); await wait(200); }
    await bpg.evaluate(() => window.WB.app.show('timeline')); await wait(700);
    const bInert = await bpg.evaluate(() => window.__sb === undefined && window.__c === undefined && !document.querySelector('.sbws img[src="x"], .col-shots img[src="x"]') && document.querySelectorAll('.col-shots .shot').length >= 5);
    check('F02 stored payloads in the storyboard stage (shot titles, text, camera, notes, version messages, asset names; board, Shot / Gaps / Notes / Versions, the timeline shots column) render as text',
      bInert && !bv.length, { bInert, bv: bv.slice(0, 2) });
    await bpg.close();
  }
} catch (e) { check('test ran to the end', false, String(e.stack || e)); }
finally {
  if (browser) await browser.close().catch(() => {});
  A?.c.kill(); L?.c.kill(); await wait(300);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
console.log(`\n${n - failed}/${n} security checks passed`);
process.exit(failed ? 1 : 0);
