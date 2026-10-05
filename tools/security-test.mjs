#!/usr/bin/env node
// Security regressions for the workbench server, the data layer and the page (audit F01-F15, NV1, NV2, the guided flow
// stages 1-6, notes.json v2 (target validation, the director's notes, stored payloads in every Notes column), review rounds
// and revisions (the page-only send / close / restore, the change link, the index, snapshots never served), final approvals
// (no agent approvals from Final, the page-only lock / unlock, a locked project refuses agent writes: 409); the exporter's
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
// the request runner (D3a) talks to a MOCK fal only (WB_FAL_BASE counts only with WB_TEST=1); the key is a sentinel
const { startMockFal } = await import('./mock-fal.mjs');
const FAL_KEY = `fal-sec-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const FAL = await startMockFal({ key: FAL_KEY, polls: 1 });
Object.assign(process.env, { WB_TEST: '1', WB_FAL_BASE: FAL.url, FAL_KEY, WB_RUN_POLL_MS: '30' });
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
  c.log = ''; c.stdout.on('data', d => { c.log += d; }); c.stderr.on('data', d => { c.log += d; });
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

  // ---------------------------------------------------------------- D3a: the request runner (mock fal; agent approvals off)
  {
    const bodies = [];
    const opR = async (name, args) => { const r = await op(name, args); bodies.push(JSON.stringify(r.body)); return r; };
    const capOf = () => readP('costs.json'); const setCap = (usd) => { const c = capOf(); c.cap_usd = usd; fs.writeFileSync(path.join(D, 'costs.json'), JSON.stringify(c)); };
    setCap(50);
    const waitStatus = async (id, sts, ms = 8000) => { const t0 = Date.now(); let r; while (Date.now() - t0 < ms) { r = readP('requests.json').items.find(x => x.id === id); if (sts.includes(r?.status)) return r; await wait(80); } return r; };
    const q = (await opR('request_create', { kind: 'identity', prompt: 'sec runner: one image', est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' })).body;
    const s0 = FAL.stats.submits;
    const runDraft = await opR('request_run', { ids: [q.id] });
    const selfAp = await opR('request_update', { id: q.id, status: 'approved', director_approved: true, by: 'director' });
    const selfQ = await opR('request_update', { id: q.id, status: 'queued' });
    const hand = readP('requests.json'); hand.items.find(x => x.id === q.id).status = 'approved'; hand.rev++; fs.writeFileSync(path.join(D, 'requests.json'), JSON.stringify(hand));   // typed by hand: no recorded approval
    const runHand = await opR('request_run', { ids: [q.id] });
    check('D3a an agent cannot get a request run without the director: request_run refuses a draft, self-approval 403 (also with director_approved), a status typed by hand is refused; nothing reached fal',
      runDraft.status === 200 && runDraft.body.started.length === 0 && /draft/.test(runDraft.body.refused[0].why) && selfAp.status === 403 && [403, 409].includes(selfQ.status)
      && runHand.body?.started?.length === 0 && /no director approval/.test(runHand.body.refused?.[0]?.why || '') && FAL.stats.submits === s0,
      { runDraft: runDraft.body?.refused, selfAp: selfAp.status, selfQ: selfQ.status, runHand: runHand.body?.refused });
    const back = readP('requests.json'); back.items.find(x => x.id === q.id).status = 'draft'; back.rev++; fs.writeFileSync(path.join(D, 'requests.json'), JSON.stringify(back));
    await pageSave('requests.json', (d) => { d.items.find(x => x.id === q.id).status = 'approved'; });   // the director, in the page
    const dry = await opR('request_run', { ids: [q.id], dry_run: true });
    const costs0 = JSON.stringify(readP('costs.json'));
    check('D3a a dry run spends nothing: no fal call, costs.json byte-identical, the request still approved, no gen/ folder',
      dry.body?.dry_run === true && dry.body.items[0].ok && FAL.stats.submits === s0 && JSON.stringify(readP('costs.json')) === costs0 && readP('requests.json').items.find(x => x.id === q.id).status === 'approved' && !fs.existsSync(path.join(D, 'gen', q.id)), dry.body?.items?.[0]);
    const run = await opR('request_run', { ids: [q.id] });   // the agent surface runs an approved request (background)
    const done = await waitStatus(q.id, ['done', 'failed']);
    const costItems = readP('costs.json').items.filter(x => x.request === q.id || x.job === q.id || x.id === q.id);
    check('D3a the agent surface runs an approved request: started, then done with one output and one cost item ($0.12, via runner); the runner never approves (its log has no approved entry of its own)',
      run.body?.started?.length === 1 && done?.status === 'done' && done.outputs?.length === 1 && costItems.length === 1 && costItems[0].usd === 0.12 && FAL.stats.submits === s0 + 1
      && done.log.filter(l => l.status === 'approved').every(l => l.via === 'page'), { run: run.body, status: done?.status, costItems });
    // the cap: 0 blocks every paid run at run time; a dry run says it does not fit
    const q2 = (await opR('request_create', { kind: 'identity', prompt: 'sec runner: capped', est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' })).body;
    await pageSave('requests.json', (d) => { d.items.find(x => x.id === q2.id).status = 'approved'; });
    setCap(0);
    const capDry = await opR('request_run', { ids: [q2.id], dry_run: true });
    await opR('request_run', { ids: [q2.id] }); await wait(400);
    const q2r = readP('requests.json').items.find(x => x.id === q2.id);
    check('D3a the cap is enforced at run time (cap 0: refused 402, nothing called, still approved; the dry run says it does not fit)',
      capDry.body?.items?.[0]?.cap?.fits === false && q2r.status === 'approved' && q2r.last_run?.status === 'refused' && /cap/.test(q2r.last_run.why) && FAL.stats.submits === s0 + 1, { dry: capDry.body?.items?.[0]?.cap, last: q2r.last_run });
    setCap(50);
    // ---- D3b video: an unapproved video request never runs; the per-second cost is recorded once per take (a failed take
    // retried once, two retakes at the same time pay once); a private reference video needs the director's private-upload tick
    const pageSaveO = async (f, fn) => { const cur = await (await fetch(`${A.base}/data/${P}/${f}`)).json(); fn(cur); return post(`/api/save/${f}?project=${P}`, { base_rev: cur.rev, data: cur }, { origin: A.base }); };
    const vq = (await opR('request_create', { kind: 'shot-video', target: 'shot:s4-chorus', prompt: 'sec video: she turns her head. Camera: static locked-off camera.', takes: 2, video: { model: 'h3max', start: 'media/still/ada_face.jpg', seconds: 5 } })).body;
    const vs0 = FAL.stats.videoSubmits;
    const vRunDraft = await opR('request_run', { ids: [vq.id] }), vSelf = await opR('request_update', { id: vq.id, status: 'approved', director_approved: true });
    const vHand = readP('requests.json'); vHand.items.find(x => x.id === vq.id).status = 'approved'; vHand.rev++; fs.writeFileSync(path.join(D, 'requests.json'), JSON.stringify(vHand));
    const vRunHand = await opR('request_run', { ids: [vq.id] }); await wait(200);
    check('D3b an unapproved video request is refused: request_run on the draft, self-approval 403, a status typed by hand (no recorded approval); nothing reached fal',
      vq.video?.model === 'h3max' && vRunDraft.body?.started?.length === 0 && /draft/.test(vRunDraft.body.refused?.[0]?.why || '') && vSelf.status === 403 && vRunHand.body?.started?.length === 0 && /no director approval/.test(vRunHand.body.refused?.[0]?.why || '') && FAL.stats.videoSubmits === vs0,
      { draft: vRunDraft.body?.refused, self: vSelf.status, hand: vRunHand.body?.refused });
    const vBack = readP('requests.json'); vBack.items.find(x => x.id === vq.id).status = 'draft'; vBack.rev++; fs.writeFileSync(path.join(D, 'requests.json'), JSON.stringify(vBack));
    await pageSave('requests.json', (d) => { d.items.find(x => x.id === vq.id).status = 'approved'; });
    FAL.failNext = 1;
    await opR('request_run', { ids: [vq.id] });
    const vDone = await waitStatus(vq.id, ['done', 'failed'], 15000);
    const vc1 = readP('costs.json').items.filter(x => x.request === vq.id);
    const vAgain = await opR('request_run', { ids: [vq.id] });
    const [rtA, rtB] = await Promise.all([opR('request_run', { ids: [vq.id], retake: true }), opR('request_run', { ids: [vq.id], retake: true })]);
    const t0r = Date.now(); while (Date.now() - t0r < 15000 && (readP('requests.json').items.find(x => x.id === vq.id).retaking || readP('requests.json').items.find(x => x.id === vq.id).outputs.length < 2)) await wait(80);
    await wait(300);
    const vAfter = readP('requests.json').items.find(x => x.id === vq.id), vc2 = readP('costs.json').items.filter(x => x.request === vq.id);
    const vRt3 = await opR('request_run', { ids: [vq.id], retake: true });
    check('D3b the per-second cost is recorded once per take: 5 s x $0.048 = $0.24 for the take that finished (one item; the failed take costs nothing); a plain re-run of the done request is refused; two retakes at once run the failed take once ($0.24 more, one <id>#<take> item); a third retake is refused; total $0.48 = the approved estimate',
      vDone?.status === 'done' && vc1.length === 1 && Math.abs(vc1[0].usd - 0.24) < 1e-9 && vDone.takes_failed?.length === 1 && vAgain.body?.started?.length === 0
      && vAfter.outputs.length === 2 && vc2.length === 2 && Math.abs(vc2.reduce((x, y) => x + y.usd, 0) - 0.48) < 1e-9 && vc2.filter(x => /#\d$/.test(x.id)).length === 1 && Math.abs(vAfter.actual_cost_usd - 0.48) < 1e-9
      && FAL.stats.videoSubmits === vs0 + 3 && vRt3.body?.started?.length === 0 && [rtA, rtB].filter(r => r.body?.started?.length === 1).length >= 1, { vc1, vc2, a: rtA.body?.started, b: rtB.body?.started, rt3: vRt3.body?.refused, submits: FAL.stats.videoSubmits - vs0 });
    // a private reference video (any private/ folder: a real performance of the director): the S4 rule
    fs.mkdirSync(path.join(D, 'private', 'clip'), { recursive: true }); fs.copyFileSync(path.join(D, 'media', 'clip', 'C1_0.mp4'), path.join(D, 'private', 'clip', 'me_dancing.mp4'));
    const pv = (await opR('request_create', { kind: 'motion', target: 'shot:s3-grid', prompt: 'sec video: an empty studio, cool light', video: { model: 'klingmc', start: 'media/still/ada_body.jpg', ref_video: 'private/clip/me_dancing.mp4', seconds: 3 }, extra: { private_upload_ok: true } })).body;
    await pageSave('requests.json', (d) => { d.items.find(x => x.id === pv.id).status = 'approved'; });
    const pvDry = await opR('request_run', { ids: [pv.id], dry_run: true });
    const agentTick = await pageSave('requests.json', (d) => { d.items.find(x => x.id === pv.id).private_upload_ok = true; });   // the token without the page's Origin
    const pvDry2 = await opR('request_run', { ids: [pv.id], dry_run: true });
    const up0 = FAL.uploadsMeta.length, pvs0 = FAL.stats.videoSubmits;
    await pageSaveO('requests.json', (d) => { d.items.find(x => x.id === pv.id).private_upload_ok = true; });   // the director's tick in the page
    const pvDry3 = await opR('request_run', { ids: [pv.id], dry_run: true });
    await opR('request_run', { ids: [pv.id] });
    const pvDone = await waitStatus(pv.id, ['done', 'failed'], 15000);
    const pvMedia = readP('media.json').items.filter(m => m.request === pv.id);
    check('D3b a private reference video goes to fal storage only with the director\'s tick: the agent\'s private_upload_ok is dropped, the run refused ("allow uploading private refs"); a save without the page\'s Origin does not tick it; with the tick from the page it runs (the clip uploaded as video/mp4), the outputs land in private/gen/ and are flagged private',
      pv.private_upload_ok === undefined && pvDry.body?.items?.[0]?.ok === false && /allow uploading private refs/.test(pvDry.body.items[0].why) && pvDry2.body?.items?.[0]?.ok === false && pvDry3.body?.items?.[0]?.ok === true
      && pvDone?.status === 'done' && /^private\/gen\//.test(pvDone.outputs[0]) && pvMedia.length === 1 && pvMedia[0].private === true && FAL.uploadsMeta.slice(up0).some(u => u.content_type === 'video/mp4' && /me_dancing/.test(u.file_name)) && FAL.stats.videoSubmits === pvs0 + 1,
      { why: pvDry.body?.items?.[0]?.why, tick: agentTick.status, dry2: pvDry2.body?.items?.[0]?.ok, dry3: pvDry3.body?.items?.[0]?.why, out: pvDone?.outputs, media: pvMedia.map(m => [m.path, m.private]) });

    // the key: only to the queue / storage origins (a forged status_url gets nothing), never in a response, file or log
    const fal = (await import('../generators/fal.mjs')).default;
    let forged = null; try { await fal.poll({ status_url: 'http://evil.example/requests/x/status' }, { key: FAL_KEY }); } catch (e) { forged = e.message; }
    const gi = await opR('generators_get', {}), st = await fetch(`${A.base}/api/status`).then(r => r.text());
    bodies.push(st);
    // WB_FAL_BASE is ignored without WB_TEST=1 (a stray env var cannot redirect the key); the key file must be outside the project
    const child = (env, code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: WB, env: { ...process.env, ...env }, encoding: 'utf8' });
    const base1 = child({ WB_TEST: '', WB_FAL_BASE: 'http://127.0.0.1:9' }, "const m = await import('./generators/fal.mjs'); console.log(m.QUEUE, m.STORAGE)").stdout.trim();
    const kIn = path.join(D, 'fal.key'), kOut = path.join(TMP, 'outside-keys', 'fal.env');
    put(kIn, `FAL_KEY=${FAL_KEY}-inproject`); put(kOut, `# my keys\nFAL_KEY=${FAL_KEY}-file\n`);
    const cfgIn = path.join(TMP, 'cfg-in.json'), cfgOut = path.join(TMP, 'cfg-out.json');
    fs.writeFileSync(cfgIn, JSON.stringify({ media_roots: ['roots/'], fal_key_file: kIn })); fs.writeFileSync(cfgOut, JSON.stringify({ media_roots: ['roots/'], fal_key_file: kOut }));
    const info = (cfg) => child({ FAL_KEY: '', WORKBENCH_CONFIG: cfg }, `const S = await import('./lib/store.mjs'); console.log(JSON.stringify(S.generatorsInfo('${P}').fal_key))`);
    const iIn = info(cfgIn), iOut = info(cfgOut);
    fs.rmSync(kIn, { force: true });
    const leaks = S.walk(D).filter(f => { try { return fs.readFileSync(path.join(D, f)).includes(FAL_KEY); } catch (e) { return false; } });
    check('D3a/D3b the fal key (also through the video runs): sent only to the fal queue / storage origin (a forged status_url is refused), never in a response (generators_get says where it came from only), a project file (job.json, requests, costs, media) or the server log; WB_FAL_BASE needs WB_TEST=1; a key file inside the project is refused, one outside works (and is not printed)',
      /refusing to send the fal key/.test(forged || '') && gi.body?.fal_key?.found === true && !bodies.some(b => b.includes(FAL_KEY)) && !leaks.length && !A.c.log.includes(FAL_KEY)
      && base1 === 'https://queue.fal.run https://rest.alpha.fal.ai' && /"found":false/.test(iIn.stdout) && /outside the workbench/.test(iIn.stdout) && /"found":true/.test(iOut.stdout) && /fal_key_file/.test(iOut.stdout) && !(iIn.stdout + iOut.stdout + iIn.stderr + iOut.stderr).includes(FAL_KEY)
      && FAL.stats.keyOnCdn === 0, { forged, leaks, base1, iIn: iIn.stdout.trim() || iIn.stderr.slice(0, 200), iOut: iOut.stdout.trim() || iOut.stderr.slice(0, 200) });
  }

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
  const lnA = (await op('lyrics_note_add', { line: 'verse/1', text: 'sec: an agent note' })).body;   // writes notes.json v2 (lyrics.json stays derived)
  // the page's first save of the derived lyrics (v1 is then a saved version), then a save trying to rewrite it; an old
  // page pushing a note into lyrics.json's own list is still stamped director / page
  const ly0 = S.lyricsDoc(P); delete ly0.derived;
  const pl0 = await post(`/api/save/lyrics.json?project=${P}`, { base_rev: 0, data: ly0 });
  const pl = await pageSave('lyrics.json', (d) => { d.versions[0].sections[0].lines[0].text = 'FORGED';
    d.notes.push({ id: 'ln99', line: null, text: 'sec: page note claiming to be the agent', by: 'agent', via: 'agent', status: 'open', replies: [] }); });
  const LY = readP('lyrics.json');
  // notes.json v2 from the page: an agent's note keeps its author and its words; a new note claiming to be the agent's is the director's
  const pn = await pageSave('notes.json', (d) => { const a = d.notes.find(x => x.id === lnA.id); a.by = 'director'; a.via = 'page'; a.text = 'FORGED'; a.created = '2000-01-01T00:00:00';
    d.notes.push({ id: 'ln98', target: { stage: 'lyrics', kind: 'stage', id: null }, text: 'sec: v2 page note claiming to be the agent', by: 'agent', via: 'agent', status: 'open', round: 1, replies: [] }); });
  const NT = readP('notes.json');
  const badShape = await post(`/api/save/lyrics.json?project=${P}`, { base_rev: LY.rev, data: { versions: 'x' } });
  const ps = await pageSave('stages.json', (d) => { d.stages.find(x => x.id === 'final').status = 'done'; });
  const stg = readP('stages.json').stages.find(x => x.id === 'final');
  const nA = NT.notes.find(x => x.id === lnA.id), n98 = NT.notes.find(x => x.id === 'ln98');
  check('flow: an agent cannot mark a stage done; a page save cannot rewrite a saved lyrics version nor a note\'s author or words (notes.json v2 and the old lyrics list), is stamped director/page, marks done; a malformed lyrics.json is refused',
    sDone.status === 403 && sNeeds.status === 200 && pl0.status === 200 && pl.status === 200 && LY.versions[0].sections[0].lines[0].text !== 'FORGED' && pn.status === 200 && nA?.via === 'agent' && nA?.by === 'agent' && nA?.text === 'sec: an agent note' && nA?.created !== '2000-01-01T00:00:00'
    && n98?.via === 'page' && n98?.by === 'director' && LY.notes.find(x => x.id === 'ln99')?.via === 'page' && LY.notes.find(x => x.id === 'ln99')?.by === 'director' && badShape.status === 400 && ps.status === 200 && stg.status === 'done' && stg.done_by === 'director' && stg.via === 'page',
    { agentDone: sDone.status, v1: LY.versions[0].sections[0].lines[0].text, agentNote: nA && [nA.by, nA.via, nA.text], pageNote: n98 && [n98.by, n98.via], oldList: LY.notes.find(x => x.id === 'ln99')?.via, badShape: badShape.status, stage: stg });
  const snapS = (await post(`/api/snapshot?project=${P}`, { message: 'sec: final done' })).body;
  await pageSave('stages.json', (d) => { d.stages.find(x => x.id === 'final').status = 'in_progress'; });   // the director reopened it
  // content alone is never done (ROADMAP_v4 F1): the director marks lyrics done in the page, then the agent tries to move it
  await pageSave('stages.json', (d) => { d.stages.find(x => x.id === 'lyrics').status = 'done'; });
  const agentMove = await op('stage_update', { stage: 'lyrics', status: 'empty' });
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
  const sp = await pageSave('scenes.json', (d) => { d.versions[0].scenes[0].title = 'FORGED';
    d.notes.push({ id: 'sn99', scene: null, text: 'sec: page note claiming the agent', by: 'agent', via: 'agent', status: 'open', replies: [] });
    d.states.sc01 = { status: 'ok', by: 'agent', via: 'agent' }; d.intake.mood.via = 'page'; d.intake.mood.by = 'director'; d.intake.where = { text: 'sec: page answer', by: 'agent', via: 'agent' }; });
  const SCN = readP('scenes.json');
  const badScenes = await post(`/api/save/scenes.json?project=${P}`, { base_rev: SCN.rev, data: { versions: [{ id: 'v1', scenes: [{ id: '../x', t0: 5, t1: 1 }] }] } });
  check('scenes.json: an agent cannot mark a scene ok; a page save cannot rewrite a saved version or an author, is stamped director/page (status, answer, new note); a malformed file is refused',
    okAgent.status === 403 && sp.status === 200 && SCN.versions[0].scenes[0].title !== 'FORGED' && readP('notes.json').notes.find(x => x.id === sn.id)?.via === 'agent' && SCN.notes.find(x => x.id === 'sn99')?.via === 'page'
    && SCN.states.sc01?.status === 'ok' && SCN.states.sc01.via === 'page' && SCN.intake.mood.via === 'agent' && SCN.intake.where.via === 'page' && SCN.intake.where.by === 'director' && badScenes.status === 400,
    { okAgent: okAgent.status, v1: SCN.versions[0].scenes[0].title, note: readP('notes.json').notes.find(x => x.id === sn.id)?.via, pageNote: SCN.notes.find(x => x.id === 'sn99')?.via, state: SCN.states.sc01, mood: SCN.intake.mood, where: SCN.intake.where, bad: badScenes.status });
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
  const bp = await pageSave('breakdown.json', (d) => { d.versions[0].items[0].name = 'FORGED';
    d.notes.push({ id: 'bn99', item: null, text: 'sec: page note claiming the agent', by: 'agent', via: 'agent', status: 'open', replies: [] });
    d.states.bi02 = { status: 'ok', by: 'agent', via: 'agent', entity_id: 'forged-entity' }; d.states.bi01 = { status: 'ok' }; d.states.bi04 = { status: 'review', by: 'agent', via: 'agent', entity_id: 'forged-two' }; });
  const BDN = readP('breakdown.json');
  const badBd = await post(`/api/save/breakdown.json?project=${P}`, { base_rev: BDN.rev, data: { versions: [{ id: 'v1', items: [{ id: '../x', kind: 'prop', name: 'x', links: [] }] }], current: 'v1' } });
  const badSt = await post(`/api/save/breakdown.json?project=${P}`, { base_rev: BDN.rev, data: { ...BDN, states: { bi01: { status: 'approved' } } } });
  check('breakdown.json from the page: a saved version, a note author and an entity link cannot be forged (nor dropped); a changed status is stamped director / page; malformed refused (400); an agent cannot mark ok (403)',
    okA.status === 403 && bp.status === 200 && BDN.versions[0].items[0].name === 'Sec Ada' && readP('notes.json').notes.find(x => x.id === bn.id)?.via === 'agent' && BDN.notes.find(x => x.id === 'bn99')?.via === 'page'
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
  const bp6 = await pageSave('storyboard.json', (d) => { d.versions[1].shots.find(s => s.id === 's2-wall').text = 'FORGED';
    d.notes.push({ id: 'sbn99', shot: null, text: 'sec: page note claiming the agent', by: 'agent', via: 'agent', status: 'open', replies: [] }); });
  const SBF = readP('storyboard.json'), bads = {};
  for (const [k, fn] of Object.entries({ id: (d) => { d.versions.at(-1).shots[0].id = '../x'; }, times: (d) => { d.versions.at(-1).shots[0].t1 = -5; }, sketch: (d) => { d.versions.at(-1).shots[0].sketch = '../../x'; },
    thumb: (d) => { d.versions.at(-1).shots[0].thumb = '../../../secret.jpg'; }, cast: (d) => { d.versions.at(-1).shots[0].cast = ['<img>']; }, current: (d) => { d.current = 'nope'; }, notes: (d) => { d.notes = 'x'; } })) {
    const cur = structuredClone(SBF); fn(cur); bads[k] = (await post(`/api/save/storyboard.json?project=${P}`, { base_rev: SBF.rev, data: cur })).status;
  }
  check('storyboard.json from the page: a saved version and a note author cannot be forged; a new note is stamped director / page; malformed files (bad ids, times, sketch / thumb paths, current, notes) refused (400)',
    bp6.status === 200 && SBF.versions[1].shots.find(s => s.id === 's2-wall')?.text === 'sec: agent text' && readP('notes.json').notes.find(x => x.id === sn6.id)?.via === 'agent' && SBF.notes.find(x => x.id === 'sbn99')?.via === 'page' && SBF.notes.find(x => x.id === 'sbn99').by === 'director'
    && Object.values(bads).every(x => x === 400), { bp: bp6.status, text: SBF.versions[1].shots.find(s => s.id === 's2-wall')?.text, bads });
  }

  // ---------------------------------------------------------------- notes.json v2: target validation, the director's notes stay the director's
  {
    const nBefore = fs.readFileSync(path.join(D, 'notes.json'), 'utf8');
    const T = (target, text = 'sec: x') => op('notes_add', { target, text });
    const bad = {
      stage: (await T({ stage: 'nowhere', kind: 'line', id: 'verse/0' })).status, kind: (await T({ stage: 'lyrics', kind: 'shot', id: 's1-intro' })).status,
      dotdot: (await T({ stage: 'lyrics', kind: 'line', id: '../verse/0' })).status, dotSeg: (await T({ stage: 'characters', kind: 'node', id: 'ada/../n01' })).status,
      beatNoScene: (await T({ stage: 'script', kind: 'beat', id: 'sc01' })).status, markup: (await T({ stage: 'breakdown', kind: 'item', id: '<img src=x>' })).status,
      backslash: (await T({ stage: 'lyrics', kind: 'line', id: 'verse\\0' })).status, gone: (await T({ stage: 'lyrics', kind: 'line', id: 'verse/99' })).status,
      noShot: (await T({ stage: 'storyboard', kind: 'shot', id: 'nope' })).status, noNode: (await T({ stage: 'characters', kind: 'node', id: 'ada/n99' })).status,
      wrongStage: (await T({ stage: 'scenery', kind: 'asset', id: 'ada' })).status, words: (await T({ stage: 'lyrics', kind: 'line', id: 'verse/0', w: [3, 99] })).status,
      wOnScene: (await T({ stage: 'script', kind: 'scene', id: 'sc01', w: [0, 1] })).status, tLate: (await T({ stage: 'timeline', kind: 'time', t: 99999999 })).status,
      tMissing: (await T({ stage: 'timeline', kind: 'time' })).status, pin: (await T({ stage: 'characters', kind: 'asset', id: 'ada', pin: { x: 2, y: 0 } })).status,
      pinOnLine: (await T({ stage: 'lyrics', kind: 'line', id: 'verse/0', pin: { x: 0.5, y: 0.5 } })).status, noText: (await T({ stage: 'lyrics', kind: 'stage' }, '   ')).status,
      long: (await T({ stage: 'lyrics', kind: 'stage' }, 'x'.repeat(8001))).status, noTarget: (await op('notes_add', { text: 'x' })).status,
    };
    const expect404 = ['gone', 'noShot', 'noNode', 'wrongStage'];
    check('notes_add: target validation (unknown stage / kind, ../, ., \\ and markup in ids, a beat without its scene, rows that do not exist (404), word ranges, times, pins, empty / too long text) refused; nothing written',
      Object.entries(bad).every(([k, s]) => s === (expect404.includes(k) ? 404 : 400)) && fs.readFileSync(path.join(D, 'notes.json'), 'utf8') === nBefore, bad);
    // a note of the director's (written by the page: stamped director / page whatever it claims) and one of the agent's
    const dn = await pageSave('notes.json', (d) => { d.notes.push({ id: 'sec-dn', target: { stage: 'script', kind: 'scene', id: 'sc01' }, text: 'sec: the director', by: 'agent', via: 'agent', status: 'open', replies: [] }); });
    const an = (await T({ stage: 'script', kind: 'scene', id: 'sc01' }, 'sec: the agent')).body;
    const dis = await op('notes_status', { id: 'sec-dn', status: 'dismissed' });
    let disOff = null; try { S.ops.notes_status(P, { id: 'sec-dn', status: 'dismissed' }); } catch (e) { disOff = e.code; }
    const disClaim = await op('notes_status', { id: 'sec-dn', status: 'dismissed', via: 'page', by: 'director' });
    const disOwn = await op('notes_status', { id: an?.id, status: 'dismissed' });
    const abs = await op('notes_status', { id: 'sec-dn', status: 'absorbed', reply: 'sec: done in v3' });
    await pageSave('notes.json', (d) => { d.notes.find(x => x.id === 'sec-dn').status = 'dismissed'; });
    const reopen = await op('notes_status', { id: 'sec-dn', status: 'open' });
    const NTs = readP('notes.json'), dnN = NTs.notes.find(x => x.id === 'sec-dn');
    check('the director\'s notes: an agent cannot dismiss them (HTTP, offline, a claimed via "page": 403) nor reopen one the director dismissed (403); it may mark one absorbed with a reply and dismiss its own; a page note is stamped director / page',
      dn.status === 200 && dnN?.by === 'director' && dnN.via === 'page' && dis.status === 403 && disOff === 403 && disClaim.status === 403 && disOwn.status === 200 && abs.status === 200 && reopen.status === 403 && dnN.status === 'dismissed' && dnN.replies.some(r => r.via === 'agent' && r.text === 'sec: done in v3'),
      { dn: dn.status, author: dnN && [dnN.by, dnN.via], dis: dis.status, disOff, disClaim: disClaim.status, disOwn: disOwn.status, abs: abs.status, reopen: reopen.status, status: dnN?.status });
    // the page's save of the list: an old (v1) list, a bad target, a bad status refused; a deleted migrated note never comes back
    const v1save = await post(`/api/save/notes.json?project=${P}`, { base_rev: readP('notes.json').rev, data: { rev: 1, notes: [{ id: 'n1', t: 0, text: 'x', status: 'open' }] } });
    const badT = await pageSave('notes.json', (d) => { d.notes.push({ id: 'sec-bad', target: { stage: 'lyrics', kind: 'line', id: '../../x' }, text: 'x', status: 'open' }); });
    const badS = await pageSave('notes.json', (d) => { d.notes.push({ id: 'sec-bad2', target: { stage: 'lyrics', kind: 'stage' }, text: 'x', status: 'approved' }); });
    const badId = await pageSave('notes.json', (d) => { d.notes.push({ id: '../n', target: { stage: 'lyrics', kind: 'stage' }, text: 'x', status: 'open' }); });
    const seen0 = readP('notes.json').legacy_seen.length;
    const shrink = await pageSave('notes.json', (d) => { d.legacy_seen = []; d.notes = d.notes.filter(x => x.id !== 'n01'); });
    const after = readP('notes.json');
    check('notes.json from the page: an old (v1) list, a bad target, status or id refused (400); legacy_seen only grows, so a deleted migrated note (n01) is not imported again',
      v1save.status === 400 && badT.status === 400 && badS.status === 400 && badId.status === 400 && shrink.status === 200 && after.legacy_seen.length >= seen0 && !after.notes.some(x => x.id === 'n01') && !(await op('notes_get', { note: 'n01' })).body?.notes,
      { v1save: v1save.status, badT: badT.status, badS: badS.status, badId: badId.status, seen: [seen0, after.legacy_seen.length] });
  }

  // ---------------------------------------------------------------- review rounds and revisions (SPEC v4 §2): the director's acts
  {
    const asPage = (name, body = {}) => post(`/api/op/${name}?project=${P}`, body, { origin: A.base });
    const foreign = (name, body = {}) => post(`/api/op/${name}?project=${P}`, body, { origin: 'http://evil.example' });
    const tries = {}, offline = {};
    for (const name of ['round_send', 'revision_close', 'revision_restore']) {
      tries[name] = [(await op(name, { id: 'R1' })).status, (await op(name, { id: 'R1', via: 'page' })).status, (await foreign(name, { id: 'R1' })).status];
      try { S.ops[name](P, { id: 'R1' }); offline[name] = 200; } catch (e) { offline[name] = e.code; }
    }
    const revSave = await post(`/api/save/revisions.json?project=${P}`, { base_rev: 0, data: { v: 1, rounds: [], revisions: [{ id: 'R9' }] } }, { origin: A.base });
    check('rounds: sending a round, closing and restoring a revision are the page\'s only: the agent surface (also with a claimed via "page"), a foreign Origin and offline get 403; revisions.json is not a page save (403)',
      Object.values(tries).every(a => a[0] === 403 && a[1] === 403 && a[2] === 403) && Object.values(offline).every(s => s === 403) && revSave.status === 403, { tries, offline, revSave: revSave.status });
    // a round in flight: the agent's change link is checked, a page save cannot forge it (nor absorbed_in, nor the round)
    await pageSave('notes.json', (d) => { d.notes.push({ id: 'sec-rn', target: { stage: 'lyrics', kind: 'stage' }, text: 'sec: round note', status: 'open', replies: [] }); });
    const sent = await asPage('round_send');
    const badFile = await op('round_absorb', { note: 'sec-rn', change: { stage: 'lyrics', file: '../../workbench.config.json', summary: 'x' } });
    const badStage = await op('round_absorb', { note: 'sec-rn', change: { stage: 'nowhere', summary: 'x' } });
    const noSum = await op('round_absorb', { note: 'sec-rn', change: { stage: 'lyrics' } });
    const okAbs = await op('round_absorb', { note: 'sec-rn', change: { stage: 'lyrics', file: 'lyrics.json', summary: 'sec: done' } });
    const round0 = readP('notes.json').round;
    const forge = await pageSave('notes.json', (d) => {
      const x = d.notes.find(n => n.id === 'sec-rn'); x.absorbed_in = 'R99'; x.change = { stage: 'final', summary: 'forged' }; x.round = 42; d.round = 77;
      d.notes.push({ id: 'sec-rn2', target: { stage: 'lyrics', kind: 'stage' }, text: 'sec: new', status: 'absorbed', absorbed_in: 'R98', change: { stage: 'lyrics', summary: 'forged too' }, replies: [] });
    });
    const NF = readP('notes.json'), x1 = NF.notes.find(n => n.id === 'sec-rn'), x2 = NF.notes.find(n => n.id === 'sec-rn2');
    check('rounds: round_absorb checks the change (a path out of the project, an unknown stage, no summary: 400); a page save of notes.json keeps the server\'s absorbed_in, change and round (a new note gets none of them)',
      sent.status === 200 && badFile.status === 400 && badStage.status === 400 && noSum.status === 400 && okAbs.status === 200 && forge.status === 200
      && x1.absorbed_in === 'R1' && x1.change?.summary === 'sec: done' && x1.round !== 42 && NF.round === round0 && x2 && x2.absorbed_in == null && !x2.change,
      { badFile: badFile.status, badStage: badStage.status, noSum: noSum.status, x1: x1 && [x1.absorbed_in, x1.change?.summary, x1.round], round: [round0, NF.round], x2: x2 && [x2.absorbed_in, x2.change] });
    // revisions: the index is the server's, snapshots and the git mirror are never served, restore takes known ids only
    const cl = await asPage('revision_close', { summary: '<img src=x onerror="window.__rv=1">' });
    const snapGet = await st(`/data/${P}/.snapshots/${cl.body?.snapshot}/notes.json`), histGet = await st(`/data/${P}/.history/.git/config`), dotGet = await st(`/data/${P}/.meta.json`);
    const rsBad = await asPage('revision_restore', { id: '../x' }), rsNo = await asPage('revision_restore', { id: 'R7' });
    const cmpBad = await op('revision_compare', { a: '../../x', b: 'now' }), cmpOk = await op('revision_compare', { a: 'R0', b: 'R1' });
    check('revisions: closing works from the page (R1); .snapshots, .history and dot files under /data are never served (403); a restore or a compare of an unknown / malformed revision is refused (404 / 400); the compare is read only for the agent (200)',
      cl.status === 200 && cl.body.id === 'R1' && !fs.existsSync(path.join(D, '.history')) && snapGet === 403 && histGet === 403 && dotGet === 403 && rsBad.status === 404 && rsNo.status === 404 && cmpBad.status === 400 && cmpOk.status === 200,
      { cl: cl.status, snapGet, histGet, dotGet, rsBad: rsBad.status, rsNo: rsNo.status, cmpBad: cmpBad.status, cmpOk: cmpOk.status });
    // the git mirror never runs what a handed-over .history/.git brings (review S3): a hook is not run (hooksPath: an empty
    // folder of ours), and a config key git init does not write (core.fsmonitor, a filter, an alias...) skips the mirror
    if (spawnSync('git', ['--version']).status === 0) {
      const H = path.join(D, '.history'), G = path.join(H, '.git'), PW = path.join(D, 'pwned.txt');
      const stF = path.join(D, 'settings.json'), st0 = fs.existsSync(stF) ? fs.readFileSync(stF, 'utf8') : null;
      fs.writeFileSync(stF, JSON.stringify({ ...(st0 ? JSON.parse(st0) : {}), revisions_git: true }));
      spawnSync('git', ['init', '-q', H]);
      const NL = String.fromCharCode(10);
      fs.writeFileSync(path.join(G, 'hooks', 'pre-commit'), ['#!/bin/sh', 'echo hook > "$GIT_DIR/../../pwned.txt"', ''].join(NL), { mode: 0o755 });
      const hk = await asPage('revision_close', { summary: 'sec: a hook in the mirror' });
      fs.appendFileSync(path.join(G, 'config'), ['[core]', '\tfsmonitor = "node -e require(\'fs\').writeFileSync(\'pwned.txt\',\'fsm\')"', ''].join(NL));
      const fm = await asPage('revision_close', { summary: 'sec: fsmonitor in the mirror config' });
      fs.rmSync(path.join(G, 'config')); spawnSync('git', ['init', '-q', H]); fs.appendFileSync(path.join(G, 'config'), ['[filter "x"]', '\tclean = node -e 1', ''].join(NL));
      const fl = await asPage('revision_close', { summary: 'sec: a filter in the mirror config' });
      const pw = fs.existsSync(PW) || fs.existsSync(path.join(H, 'pwned.txt'));
      if (st0 == null) fs.rmSync(stF); else fs.writeFileSync(stF, st0);
      fs.rmSync(H, { recursive: true, force: true }); fs.rmSync(PW, { force: true });
      check('git mirror (S3): a pre-commit hook in a handed-over .history/.git never runs (the commit is made, hooks off); a config key git init does not write (core.fsmonitor, a filter) skips the mirror with the reason; nothing was executed',
        hk.status === 200 && !!hk.body?.git?.commit && fm.status === 200 && /not the workbench's own/.test(fm.body?.git?.skipped || '') && /fsmonitor/.test(fm.body.git.skipped) && /filter/.test(fl.body?.git?.skipped || '') && !pw,
        { hk: hk.body?.git, fm: fm.body?.git, fl: fl.body?.git, pw });
    } else check('git mirror (S3): git is not on PATH (skipped)', true);
  }

  // ---------------------------------------------------------------- proposals (SPEC v4 §3): the SVG sanitiser and the director's picks
  {
    const OKS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#123"/></svg>';
    // known SVG XSS payloads: every one is refused (with a reason), none reaches the disk
    const XSS = {
      script: '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>',
      script_ns: '<svg viewBox="0 0 10 10"><svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script></svg>',
      onload: '<svg viewBox="0 0 10 10" onload="alert(1)"/>',
      onload_case: '<svg viewBox="0 0 10 10" OnLoAd="alert(1)"/>',
      onerror_rect: '<svg viewBox="0 0 10 10"><rect onerror="alert(1)" width="1" height="1"/></svg>',
      unquoted_handler: '<svg viewBox="0 0 10 10"><rect onclick=alert(1) /></svg>',
      foreignObject: '<svg viewBox="0 0 10 10"><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>',
      image_js: '<svg viewBox="0 0 10 10"><image href="javascript:alert(1)"/></svg>',
      a_js: '<svg viewBox="0 0 10 10"><a href="javascript:alert(1)"><rect width="5" height="5"/></a></svg>',
      use_external: '<svg viewBox="0 0 10 10"><use href="https://evil.example/x.svg#a"/></svg>',
      use_xlink_js: '<svg viewBox="0 0 10 10"><use xlink:href="javascript:alert(1)"/></svg>',
      use_data: '<svg viewBox="0 0 10 10"><use href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=#x"/></svg>',
      entity_js: '<svg viewBox="0 0 10 10"><use href="java&#x73;cript:alert(1)"/></svg>',
      href_on_rect: '<svg viewBox="0 0 10 10"><rect href="#a"/></svg>',
      animate_href: '<svg viewBox="0 0 10 10"><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>',
      set_href: '<svg viewBox="0 0 10 10"><set attributeName="onmouseover" to="alert(1)"/></svg>',
      style_el: '<svg viewBox="0 0 10 10"><style>@import url(https://evil.example/x.css)</style></svg>',
      style_url: '<svg viewBox="0 0 10 10"><rect style="fill:url(https://evil.example/x)" width="1" height="1"/></svg>',
      style_escape: '<svg viewBox="0 0 10 10"><rect style="background:u\\72l(https://evil.example)"/></svg>',
      style_expr: '<svg viewBox="0 0 10 10"><rect style="width:expression(alert(1))"/></svg>',
      fill_url_ext: '<svg viewBox="0 0 10 10"><rect fill="url(https://evil.example/#g)"/></svg>',
      filter_url: '<svg viewBox="0 0 10 10"><rect filter="url(https://evil.example/#f)"/></svg>',
      feimage: '<svg viewBox="0 0 10 10"><filter id="f"><feImage href="https://evil.example/x.png"/></filter></svg>',
      doctype_xxe: '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 10 10"><text>&xxe;</text></svg>',
      cdata: '<svg viewBox="0 0 10 10"><script><![CDATA[alert(1)]]></script></svg>',
      cdata_text: '<svg viewBox="0 0 10 10"><text><![CDATA[<script>alert(1)</script>]]></text></svg>',
      html_root: '<html><body><script>alert(1)</script></body></html>',
      two_roots: '<svg viewBox="0 0 10 10"/><svg viewBox="0 0 10 10" onload="alert(1)"/>',
      iframe: '<svg viewBox="0 0 10 10"><iframe srcdoc="<script>alert(1)</script>"/></svg>',
      unclosed: '<svg viewBox="0 0 10 10"><g><rect/></svg>',
      lt_in_attr: '<svg viewBox="0 0 10 10"><rect id="a<script>"/></svg>',
      no_viewbox: '<svg><rect/></svg>',
      huge_viewbox: '<svg viewBox="0 0 99999 99999"/>',
      thin_viewbox: '<svg viewBox="0 0 1000 10"/>',
      too_big: `<svg viewBox="0 0 10 10">${'<rect width="1" height="1"/>'.repeat(3000)}</svg>`,
      xml_stylesheet: '<?xml-stylesheet href="https://evil.example/x.css"?><svg viewBox="0 0 10 10"/>',
      // review S7: an image-set() in a style, a CSS escape in a presentation attribute
      style_image_set: '<svg viewBox="0 0 10 10"><rect style="background-image:image-set(\'http://evil.example/x\' 1x)"/></svg>',
      fill_css_escape: '<svg viewBox="0 0 10 10"><rect fill="\\75 rl(http://evil.example/x)"/></svg>',
    };
    const refused = {}, leaked = [];
    for (const [k, v] of Object.entries(XSS)) { try { S.sanitizeSvg(v); leaked.push(k); } catch (e) { refused[k] = e.code; } }
    // what is kept is written out again from the parsed tree: text and values escaped, internal refs only
    const neut = S.sanitizeSvg('<svg viewBox="0 0 160 90"><defs><marker id="m"><path d="M0 0 L6 3 L0 6 Z"/></marker></defs><line x1="1" y1="1" x2="9" y2="9" marker-end="url(#m)"/><text>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "q"</text><use href="#m"/></svg>').svg;
    check('proposals: the SVG sanitiser refuses every known XSS payload (script, on* handlers in any case, foreignObject, image / a / iframe, external or javascript: / data: hrefs even entity-encoded, animate / set, <style>, url() outside #id, CSS escapes and expressions, DOCTYPE / XXE, CDATA, a non-SVG or second root, broken markup, a bad viewBox, > 64 KB) and re-escapes what it keeps',
      !leaked.length && Object.values(refused).every(c => c === 400) && /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; "q"/.test(neut) && !/<script/i.test(neut) && /marker-end="url\(#m\)"/.test(neut),
      { leaked, n: Object.keys(refused).length, neut: neut.slice(0, 200) });
    const before = fs.existsSync(path.join(D, 'proposals')) ? fs.readdirSync(path.join(D, 'proposals')).length : 0;
    const http = {};
    for (const k of ['script', 'onload', 'foreignObject', 'use_external', 'style_url', 'doctype_xxe']) http[k] = (await op('proposals_add', { target: { stage: 'script', kind: 'scene', id: 'sc02' }, items: [{ title: 'x', svg: XSS[k] }] })).status;
    const badT = (await op('proposals_add', { target: { stage: 'script', kind: 'scene', id: '../../x' }, items: [{ title: 'x', text: 'y' }] })).status;
    const noRow = (await op('proposals_add', { target: { stage: 'script', kind: 'scene', id: 'sc99' }, items: [{ title: 'x', text: 'y' }] })).status;
    const badKind = (await op('proposals_add', { target: { stage: 'timeline', kind: 'time', id: null }, items: [{ title: 'x', text: 'y' }] })).status;
    const both = (await op('proposals_add', { target: { stage: 'script', kind: 'scene', id: 'sc02' }, items: [{ title: 'x', text: 'y', svg: OKS }] })).status;
    const many = (await op('proposals_add', { target: { stage: 'script', kind: 'scene', id: 'sc02' }, items: Array.from({ length: 7 }, () => ({ title: 'x', text: 'y' })) })).status;
    const after = fs.existsSync(path.join(D, 'proposals')) ? fs.readdirSync(path.join(D, 'proposals')).length : 0;
    const good = await op('proposals_add', { target: { stage: 'script', kind: 'scene', id: 'sc02' }, items: [{ title: '<img src=x onerror="window.__pp=1">', why: '<b onmouseover=alert(1)>why</b>', svg: OKS }, { title: 'a text', text: '<img src=x onerror="window.__pp=2">' }] });
    const setId = good.body?.set?.id, svgRel = good.body?.set?.items?.[0]?.svg;
    const served = await fetch(`${A.base}/data/${P}/${svgRel}`);
    check('proposals: proposals_add over HTTP refuses the payloads (400) and writes nothing; a target outside the project / missing / of a kind proposals do not take, both svg and text, more than 6 items: 400 / 404; a good SVG is written under proposals/ and served as image/svg+xml with the sandboxing CSP and nosniff',
      Object.values(http).every(s => s === 400) && after === before && badT === 400 && noRow === 404 && badKind === 400 && both === 400 && many === 400 && good.status === 200
      && served.status === 200 && /image\/svg\+xml/.test(served.headers.get('content-type') || '') && /sandbox/.test(served.headers.get('content-security-policy') || '') && served.headers.get('x-content-type-options') === 'nosniff',
      { http, badT, noRow, badKind, both, many, files: [before, after], good: good.status, ct: served.headers.get('content-type'), csp: served.headers.get('content-security-policy') });
    // picks are the director's: the agent surface (also claiming via "page"), a foreign Origin and offline get 403; the page may
    const asPage = (body) => post(`/api/op/proposal_act?project=${P}`, body, { origin: A.base });
    const tries = [(await op('proposal_act', { set: setId, item: 'a', act: 'pick' })).status, (await op('proposal_act', { set: setId, item: 'a', act: 'pick', via: 'page' })).status,
      (await post(`/api/op/proposal_act?project=${P}`, { set: setId, item: 'a', act: 'pick' }, { origin: 'http://evil.example' })).status];
    let offline = null; try { S.ops.proposal_act(P, { set: setId, item: 'a', act: 'pick' }); offline = 200; } catch (e) { offline = e.code; }
    const ppSave = await post(`/api/save/proposals.json?project=${P}`, { base_rev: 0, data: { v: 1, sets: [] } }, { origin: A.base });
    const pagePick = await asPage({ set: setId, item: 'a', act: 'pick' });
    const badAct = await asPage({ set: setId, item: 'a', act: 'approve' }), badSet = await asPage({ set: '../x', item: 'a', act: 'pick' });
    const picked = readP('proposals.json').sets.find(x => x.id === setId)?.items[0];
    check('proposals: a pick is the page\'s only: the agent surface (also with a claimed via "page"), a foreign Origin and offline get 403, the MCP server has no such tool; proposals.json is not a page save (403); the page picks (via page, by director); an unknown act / set is refused',
      tries.every(x => x === 403) && offline === 403 && ppSave.status === 403 && pagePick.status === 200 && picked?.status === 'picked' && picked.via === 'page' && picked.by === 'director' && badAct.status === 400 && badSet.status === 404
      && !fs.readFileSync(path.join(WB, 'mcp', 'tools', 'proposals.mjs'), 'utf8').includes("registerTool('proposal_act'"),
      { tries, offline, ppSave: ppSave.status, pagePick: pagePick.status, badAct: badAct.status, badSet: badSet.status });
    // a hand-written (unsanitised) SVG with script in proposals/: the page only ever shows it as <img> (checked in the browser below)
    fs.writeFileSync(path.join(D, 'proposals', 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="top.__ppsvg=1"><script>top.__ppsvg=2</script><rect width="10" height="10" fill="red"/></svg>');
    const pj = readP('proposals.json'); pj.sets.push({ id: 'ps90', target: { stage: 'script', kind: 'scene', id: 'sc02' }, round: 1, by: '<img src=x onerror="window.__pp=3">', via: 'agent', source: 'agent', created: '2026-10-05T00:00:00', items: [{ id: 'a', title: 'hand-edited <svg onload=alert(1)>', why: 'x', svg: 'proposals/evil.svg', status: 'open' }] }); pj.rev++;
    fs.writeFileSync(path.join(D, 'proposals.json'), JSON.stringify(pj));
  }

  // ---------------------------------------------------------------- take selection (D6): the pick is the director's (page only); in / out stay
  // inside the take's duration; the take must be registered media of the project (and a take of that shot); a page save of
  // storyboard.json and the agent's shots_update cannot set or change a pick
  {
    const asPage = (body) => post(`/api/op/take_act?project=${P}`, body, { origin: A.base });
    const pick = { act: 'pick', shot: 's2-wall', media: 'C1_1', in_ms: 500, out_ms: 1500, note: '<img src=x onerror="window.__tk=1">' };
    const tries = [(await op('take_act', pick)).status, (await op('take_act', { ...pick, via: 'page' })).status, (await post(`/api/op/take_act?project=${P}`, pick, { origin: 'http://evil.example' })).status];
    try { S.ops.take_act(P, pick); tries.push(200); } catch (e) { tries.push(e.code); }
    const noTool = !fs.readFileSync(path.join(WB, 'mcp', 'tools', 'takes.mjs'), 'utf8').includes("registerTool('take_act'");
    const sb0 = readP('storyboard.json');
    check('take selection: an agent cannot pick a take (take_act over the agent surface, with a claimed via "page", from a foreign Origin, offline: 403; no MCP tool); storyboard.json untouched',
      tries.every(s => s === 403) && noTool && readP('storyboard.json').rev === sb0.rev, { tries, noTool });
    const rng = {
      past_end: (await asPage({ ...pick, out_ms: 3001 })).status, negative_in: (await asPage({ ...pick, in_ms: -40 })).status, in_after_out: (await asPage({ ...pick, in_ms: 1500, out_ms: 1500 })).status,
      not_a_number: (await asPage({ ...pick, out_ms: 'end' })).status, still_with_range: (await asPage({ ...pick, media: undefined, file: 'media/still/I1.jpg', in_ms: 100, out_ms: 500 })).status,
      alt_outside_song: (await asPage({ ...pick, alt: [{ media: 'C1_0', t: 10 ** 9, note: 'x' }] })).status,
      propose_past_end: (await op('take_propose', { shot: 's2-wall', media: 'C1_1', in_ms: 0, out_ms: 999999, why: 'x' })).status,
    };
    check('take selection: in / out must stay inside the take\'s duration (past the end, negative, in >= out, not a number, a range on a still, an alternative outside the song: 400; take_propose too)',
      Object.values(rng).every(s => s === 400) && readP('storyboard.json').rev === sb0.rev, rng);
    const reg = {
      unregistered: (await asPage({ ...pick, media: undefined, file: 'media/clip/not-there.mp4' })).status,
      traversal: (await asPage({ ...pick, media: undefined, file: '../_template/song.json' })).status,
      outside: (await asPage({ ...pick, media: undefined, file: path.join(MB, 'roots', 'a.txt') })).status,
      a_render: (await asPage({ ...pick, media: 'demo-v1' })).status, audio: (await asPage({ ...pick, media: 'demo-song', in_ms: 0, out_ms: 1000 })).status,
      not_this_shot: (await asPage({ ...pick, media: 'C2_0', in_ms: 0, out_ms: 1000 })).status,
      alt_unregistered: (await asPage({ ...pick, alt: [{ file: 'media/clip/nope.mp4', t: 1000 }] })).status,
      propose_unregistered: (await op('take_propose', { shot: 's2-wall', file: 'media/clip/nope.mp4', why: 'x' })).status,
      bad_shot: (await asPage({ ...pick, shot: '../x' })).status,
    };
    check('take selection: the take must be registered media of the project and a take of that shot (unregistered, a traversal, a path outside, a render, audio, another shot\'s take, an unregistered alternative: 4xx; take_propose too)',
      Object.values(reg).every(s => s === 400 || s === 404) && readP('storyboard.json').rev === sb0.rev, reg);
    const ok = await asPage(pick), sbP = readP('storyboard.json'), clipNow = sbP.versions.find(v => v.id === sbP.current).shots.find(s => s.id === 's2-wall').clip;
    // a page save that forges a pick (another take, another range) keeps the server's; the agent's shots_update cannot set one either
    const forged = await pageSave('storyboard.json', (d) => { const v = structuredClone(d.versions.find(x => x.id === d.current)); v.id = 'v99'; v.n = 99; const s = v.shots.find(x => x.id === 's2-wall'); s.clip = { ...s.clip, file: 'media/clip/C1_0.mp4', media: 'C1_0', in_ms: 0, out_ms: 3000 }; const o = v.shots.find(x => x.id === 's3-grid'); o.clip = { file: 'render/demo-v1.mp4', in_ms: 0, out_ms: 100 }; d.versions.push(v); d.current = 'v99'; });
    const sbF = readP('storyboard.json'), vF = sbF.versions.find(v => v.id === sbF.current);
    const agentClip = await op('shots_update', { upsert: [{ id: 's3-grid', clip: { file: 'media/clip/C2_0.mp4', in_ms: 0, out_ms: 1000 } }] });
    const sbA = readP('storyboard.json'), vA = sbA.versions.find(v => v.id === sbA.current);
    check('take selection: the page picks (200, a new version, approvals untouched); a page save of storyboard.json cannot forge a pick (the server\'s is kept, a forged one on another shot dropped); the agent\'s shots_update ignores a clip (warning)',
      ok.status === 200 && clipNow?.file === 'media/clip/C1_1.mp4' && clipNow.via === 'page' && forged.status === 200 && vF.shots.find(s => s.id === 's2-wall').clip?.file === 'media/clip/C1_1.mp4' && vF.shots.find(s => s.id === 's2-wall').clip.in_ms === 500
      && !vF.shots.find(s => s.id === 's3-grid').clip && agentClip.status === 200 && !vA.shots.find(s => s.id === 's3-grid').clip && (agentClip.body?.warnings || []).some(w => /clip ignored/.test(w)),
      { ok: ok.status, forged: forged.status, kept: vF.shots.find(s => s.id === 's2-wall').clip?.file, s3: vF.shots.find(s => s.id === 's3-grid').clip, agent: agentClip.status });
  }

  // ---------------------------------------------------------------- D4 batches (waves): only the director approves, reviews (unlocks), sets the
  // cap of or dismisses a batch (page only); a page save cannot forge batches or history; a locked batch never runs; the
  // per-batch cap holds; the job-book import is the page's
  {
    const asPage = (name, body = {}) => post(`/api/op/${name}?project=${P}`, body, { origin: A.base });
    const RQ = () => readP('requests.json'), s0 = FAL.stats.submits;
    const pageSaveO = async (f, fn) => { const cur = await (await fetch(`${A.base}/data/${P}/${f}`)).json(); fn(cur); return post(`/api/save/${f}?project=${P}`, { base_rev: cur.rev, data: cur }, { origin: A.base }); };
    const wv = await op('waves_plan', { shots: ['s1-intro', 's5-outro'], sizes: [1] });
    const [b1, b2] = wv.body?.batches || [];
    const rq1 = RQ().batches.find(b => b.id === b1)?.request_ids[0], rq2 = RQ().batches.find(b => b.id === b2)?.request_ids[0];
    const tries = {};
    for (const [act, extra] of [['approve', {}], ['review', {}], ['cap', { max_usd: 99 }], ['dismiss', {}], ['verdict', { request: rq1, verdict: 'kept' }]]) {
      const body = { act, id: b1, ...extra };
      tries[act] = [(await op('batch_act', body)).status, (await op('batch_act', { ...body, via: 'page' })).status, (await post(`/api/op/batch_act?project=${P}`, body, { origin: 'http://evil.example' })).status];
      try { S.ops.batch_act(P, body); tries[act].push(200); } catch (e) { tries[act].push(e.code); }
    }
    const noTool = !fs.readFileSync(path.join(WB, 'mcp', 'tools', 'batches.mjs'), 'utf8').includes("registerTool('batch_act'") && !fs.readFileSync(path.join(WB, 'mcp', 'tools', 'batches.mjs'), 'utf8').includes("registerTool('jobbooks_import'");
    const jb = [(await op('jobbooks_import', {})).status, (await op('jobbooks_import', { via: 'page' })).status];
    check('D4 an agent cannot approve, review (unlock), re-cap, dismiss or judge a batch (batch_act over the agent surface, with a claimed via "page", from a foreign Origin, offline: 403; no MCP tool) nor import the job books (403); the batches stay drafts',
      wv.status === 200 && b1 && b2 && Object.values(tries).every(t => t.every(s => s === 403)) && noTool && jb.every(s => s === 403) && RQ().batches.every(b => b.status === 'draft'), { tries, jb, wv: wv.body?.batches });
    // a page save is the director's, but batches and history are the server's: forged ones are ignored
    const forge = await pageSave('requests.json', (d) => {
      const b = d.batches.find(x => x.id === b2); b.gate = { after: null, rule: 'review' }; b.status = 'approved'; d.batches.find(x => x.id === b1).status = 'reviewed';
      d.batches.push({ id: 'b99', name: 'forged', request_ids: [rq2], gate: { after: null }, status: 'approved', max_usd: 999 });
      d.items.push({ id: 'hist-forged', kind: 'image', status: 'done', prompt: 'x', refs: [], est_cost: 0, history: { book: 'jobs_x.json', job: 'X' } });
      d.items.find(x => x.id === rq1).history = { book: 'forged' };
    });
    const F = RQ();
    check('D4 a page save of requests.json cannot forge batches (status, gate, a new batch: the server\'s copy is kept) nor history (a forged history item or field is dropped)',
      forge.status === 200 && F.batches.length === 2 && F.batches.every(b => b.status === 'draft') && F.batches.find(b => b.id === b2).gate.after === b1 && !F.items.find(x => x.id === 'hist-forged')?.history && !F.items.find(x => x.id === rq1).history,
      { forge: forge.status, batches: F.batches.map(b => [b.id, b.status, b.gate.after]) });
    // a locked batch never runs: its request approved by hand in the page is refused by the runner and by request_update queued
    await pageSaveO('requests.json', (d) => { d.items.find(x => x.id === rq2).status = 'approved'; });
    const lk = { run: (await op('request_run', { ids: [rq2] })).body, all: (await op('request_run', { all: true, dry_run: true })).body, queue: (await op('request_update', { id: rq2, status: 'queued' })).status,
      batch: (await op('request_run', { batch: b2 })).body };
    let offline; try { offline = await S.ops.request_run(P, { ids: [rq2], wait: true }); } catch (e) { offline = { error: e.code }; }
    const pageApprove = await asPage('batch_act', { act: 'approve', id: b2 });
    await wait(300);
    check('D4 a locked batch never runs: a request of the locked wave approved in the page is refused by request_run (ids, all, batch, offline), request_update queued is 409, approving the locked batch is 409 even from the page; nothing reached fal',
      lk.run?.started?.length === 0 && /locked until/.test(lk.run.refused[0].why) && !(lk.all?.items || []).some(x => x.id === rq2 && x.ok) && lk.queue === 409 && lk.batch?.started?.length === 0 && offline?.results?.length === 0 && /locked/.test(JSON.stringify(offline.refused))
      && pageApprove.status === 409 && RQ().items.find(x => x.id === rq2).status === 'approved' && FAL.stats.submits === s0, { lk: { run: lk.run?.refused, queue: lk.queue }, offline: offline?.refused || offline, pageApprove: pageApprove.status });
    // the per-batch cap: the director approves b01 with a cap below its estimate: the run is refused, nothing reached fal
    const ap = await asPage('batch_act', { act: 'approve', id: b1, max_usd: 0.05 });
    const capRun = await op('request_run', { batch: b1 }); await wait(300);
    const capUp = await asPage('batch_act', { act: 'cap', id: b1, max_usd: -1 });
    check('D4 the per-batch cap holds: b01 approved with max_usd $0.05 below its $0.12 estimate: request_run {batch} refuses it ("over the batch cap"), nothing reached fal; a negative cap is refused (400)',
      ap.status === 200 && ap.body.max_usd === 0.05 && capRun.body?.started?.length === 0 && /over the batch cap/.test(capRun.body?.refused?.[0]?.why || '') && FAL.stats.submits === s0 && capUp.status === 400 && RQ().items.find(x => x.id === rq1).status === 'approved',
      { ap: ap.body, cap: capRun.body?.refused, capUp: capUp.status });
    // leave the demo as the later blocks expect it: the wave requests back to draft is not possible for approved ones; reject them
    await pageSaveO('requests.json', (d) => { for (const x of d.items) if ([rq1, rq2].includes(x.id)) { x.status = 'rejected'; x.why = 'security test'; } });
  }

  // ---------------------------------------------------------------- final approvals (stage 7): the director approves and locks; a locked
  // project refuses every agent write (409) over HTTP (op, save, restore) and offline, while the page and the reads still work
  {
    const asPage = (name, body = {}) => post(`/api/op/${name}?project=${P}`, body, { origin: A.base });
    const tries = {};
    for (const name of ['final_lock', 'final_unlock']) {
      tries[name] = [(await op(name, { force: true })).status, (await op(name, { force: true, via: 'page' })).status, (await post(`/api/op/${name}?project=${P}`, { force: true }, { origin: 'http://evil.example' })).status];
      try { S.ops[name](P, { force: true }); tries[name].push(200); } catch (e) { tries[name].push(e.code); }
    }
    const apF = await op('set_states', { keys: ['shot:s5-outro'], state: 'approved', director_approved: true });
    const reqF = (await op('request_create', { kind: 'shot-still', target: 'shot:s5-outro', prompt: 'sec final', est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' })).body;
    const apR = await op('request_update', { id: reqF?.id, status: 'approved', director_approved: true });
    const fg = await op('final_get', {});
    check('final: the agent cannot approve from Final (a shot: 403, a request: 403, also with director_approved) nor lock / unlock (agent surface, a claimed via "page", a foreign Origin, offline: 403); final_get reads (200)',
      apF.status === 403 && apR.status === 403 && Object.values(tries).every(a => a.every(s => s === 403)) && fg.status === 200 && Array.isArray(fg.body?.checklist) && fg.body.locked === null,
      { apF: apF.status, apR: apR.status, tries, fg: fg.status });
    const lk = await asPage('final_lock', { force: true });
    const ap0 = readP('approvals.json');
    const w = {
      notes_add: (await op('notes_add', { target: { stage: 'final', kind: 'stage', id: null }, text: 'sec: locked' })).status,
      set_states: (await op('set_states', { keys: ['shot:s5-outro'], state: 'review' })).status,
      request_create: (await op('request_create', { kind: 'shot-still', target: 'shot:s5-outro', prompt: 'x', est_cost: 0.1, tool: 'fal-ai/nano-banana-2/edit' })).status,
      entity_upsert: (await op('entity_upsert', { kind: 'character', id: 'ada', fields: { name: 'Locked Ada' } })).status,
      proposals_add: (await op('proposals_add', { target: { stage: 'script', kind: 'scene', id: 'sc02' }, items: [{ title: 'locked', text: 'while locked' }] })).status,
      save: (await post(`/api/save/approvals.json?project=${P}`, { base_rev: ap0.rev, data: { ...ap0, items: { ...ap0.items, 'shot:s5-outro': { state: 'review' } } } })).status,
      restore: (await post(`/api/restore?project=${P}`, { snapshot: lk.body?.snapshot, by: 'agent' })).status,
      delete: (await post(`/api/projects/delete?project=${P}`, { id: P })).status,
    };
    let off = null; try { S.lockGate(P, 'notes_add', {}); off = 200; } catch (e) { off = e.code; }
    const reads = [(await op('final_get', {})).status, (await op('notes_get', {})).status, (await op('costs_get', {})).status];
    const pg1 = await post(`/api/save/approvals.json?project=${P}`, { base_rev: readP('approvals.json').rev, data: { ...readP('approvals.json'), items: { ...readP('approvals.json').items, 'shot:s5-outro': { state: 'changes' } } } }, { origin: A.base });
    const RVJ = readP('revisions.json');
    check('final: "Lock for render" from the page closes a revision marked final (revisions.json lock); then the agent surface gets 409 on every write (op, page-style save without the Origin, restore; offline lockGate 409) and nothing changes; reads still work; the page itself still saves',
      lk.status === 200 && RVJ.lock?.revision === lk.body.revision && RVJ.revisions.find(r => r.id === lk.body.revision)?.final === true && Object.values(w).every(s => s === 409) && off === 409
      && reads.every(s => s === 200) && pg1.status === 200 && readP('entities/characters/ada.json').name !== 'Locked Ada',
      { lk: lk.status, w, off, reads, pg1: pg1.status });
    const ul = await asPage('final_unlock'), after = await op('notes_add', { target: { stage: 'final', kind: 'stage', id: null }, text: 'sec: unlocked' });
    check('final: the page unlocks (the agent writes again)', ul.status === 200 && after.status === 200 && readP('revisions.json').lock === null, { ul: ul.status, after: after.status });
  }

  // ---------------------------------------------------------------- F09: the EDL extractor's server (source check: it needs the owner's render page)
  const edl = fs.readFileSync(path.join(WB, 'importers/azemar_extract_edl.mjs'), 'utf8');
  check('F09 EDL extractor server: 127.0.0.1, decode in try/catch, confined to ROOT', /listen\(\d+, '127\.0\.0\.1'/.test(edl) && /try \{ p = inside\(ROOT,/.test(edl) && /if \(!p\) \{ r\.writeHead\(403\)/.test(edl));

  // ---------------------------------------------------------------- the dogfood fixes: proposals, imports, costs, media, the recipe template
  {
    const asPage = (body) => post(`/api/op/asset_act?project=${P}`, body, { origin: A.base });
    const bp = await op('base_propose', { id: 'ada', text: 'x', refs: ['media/still/ada_face.jpg'] });
    const bpPhoto = await op('base_propose', { id: 'ada', refs: [{ path: 'media/still/ada_face.jpg', source: 'photo' }] });
    const bpEsc = await op('base_propose', { id: 'ada', refs: ['../../../workbench.config.json'] });
    const ip = await op('node_import_propose', { id: 'ada', tree: 'identity', media: 'ada_body', why: 'test' });
    const tries = {};
    for (const act of ['base_accept', 'base_dismiss', 'import', 'import_accept', 'import_dismiss']) tries[act] = (await op('asset_act', { type: 'character', id: 'ada', act, media: 'ada_body', proposal: ip.body?.proposal?.id })).status;
    let off = {}; for (const act of ['base_accept', 'import', 'import_accept']) { try { S.ops.asset_act(P, { type: 'character', id: 'ada', act, media: 'ada_body', proposal: 'ip01' }); off[act] = 200; } catch (e) { off[act] = e.code; } }
    const upsert = await op('entity_upsert', { kind: 'character', id: 'ada', fields: { iter: { base_proposal: { text: 'forged', refs: [] }, nodes: [] } } });
    const E = readP('entities/characters/ada.json');
    check('dogfood: accepting a base proposal or an import, and importing an image, are the page\'s acts only (agent surface 403, offline 403); entity_upsert cannot plant a proposal (iter ignored); a proposed "photo" ref must be private (400), a path out of the project 400 / 404',
      bp.status === 200 && bpPhoto.status === 400 && [400, 404].includes(bpEsc.status) && Object.values(tries).every(s => s === 403) && Object.values(off).every(s => s === 403)
      && /iter ignored/.test((upsert.body?.warnings || []).join(' ')) && E.iter?.base_proposal?.text === 'x' && !E.base,
      { bp: bp.status, bpPhoto: bpPhoto.status, bpEsc: bpEsc.status, tries, off, warn: upsert.body?.warnings });
    // the page imports only a registered image (no arbitrary path), never into a locked tree
    const impPath = await asPage({ type: 'character', id: 'ada', act: 'import', tree: 'identity', media: '../../../workbench.config.json' });
    const impAudio = await asPage({ type: 'character', id: 'ada', act: 'import', tree: 'identity', media: 'demo-song' });
    const impOk = await asPage({ type: 'character', id: 'ada', act: 'import', tree: 'identity', media: 'ada_face' });
    await asPage({ type: 'character', id: 'ada', act: 'approve', tree: 'identity' });
    const impLocked = await asPage({ type: 'character', id: 'ada', act: 'import', tree: 'identity', media: 'ada_body' });
    check('dogfood: the page\'s import takes registered images only (a path 404, audio 400) and never changes a locked tree (409)', impPath.status === 404 && impAudio.status === 400 && impOk.status === 200 && impLocked.status === 409, { impPath: impPath.status, impAudio: impAudio.status, impOk: impOk.status, impLocked: impLocked.status });
    // media_update: a private flag never goes back
    const mp = await op('media_update', { id: 'bo_face', private: true });
    const mpBack = await op('media_update', { id: 'bo_face', private: false });
    const mpStatus = await op('media_update', { id: 'bo_face', status: 'used' });
    const mBo = readP('media.json').items.find(m => m.id === 'bo_face');
    const thumbRemote = mBo.thumb ? await get(lanIp || '127.0.0.1', A.port, `/data/${P}/${mBo.thumb}`, { host: `localhost:${A.port}` }) : { status: 'none' };
    check('dogfood: media_update private:true is one-way (private:false 403, a status change 403); its thumbnail is a thumbs/priv_ file', mp.status === 200 && mpBack.status === 403 && mpStatus.status === 403 && mBo.private === true && (!mBo.thumb || /^thumbs\/priv_/.test(mBo.thumb)), { mp: mp.status, back: mpBack.status, st: mpStatus.status, thumb: mBo.thumb, remote: thumbRemote.status });
    // costs: a falgen folder outside the media base is never read; cost_record never approves
    const pj = path.join(D, 'project.json'), pj0 = fs.readFileSync(pj, 'utf8');
    put(path.join(TMP, 'spent.json'), JSON.stringify({ total: 999 }));
    fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(pj0), falgen: '..' }));
    const cOut = await op('costs_get', {});
    fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(pj0), falgen: TMP }));
    const cAbs = await op('costs_get', {});
    fs.writeFileSync(pj, pj0);
    const draft = readP('requests.json').items.find(r => r.status === 'draft');
    const cr = await op('cost_record', { usd: 0.5, via: 'retro', request: draft?.id });
    const after = readP('requests.json').items.find(r => r.id === draft?.id);
    check('dogfood: a falgen folder outside the media base (relative or absolute) is not read (an error, no spend added); cost_record on a draft request records the cost and leaves the request a draft (never an approval)',
      /inside the media base/.test(cOut.body?.falgen?.error || '') && /inside the media base/.test(cAbs.body?.falgen?.error || '') && cAbs.body.total_spent_usd < 999 && cr.status === 200 && after?.status === 'draft' && after.log.length === draft.log.length,
      { out: cOut.body?.falgen?.error, abs: cAbs.body?.total_spent_usd, cr: cr.status, after: after?.status });
    // the recipe template is served (read only); nothing else under templates/ or next to it; every /api response says its code
    const tpl = await get('127.0.0.1', A.port, '/templates/photoreal_recipe.json', { host: `localhost:${A.port}` });
    const tplOther = { up: await st('/templates/..%2Fpackage.json'), md: await st('/templates/x.md'), docs: await st('/docs/PHOTOREAL.md'), client: await st('/mcp/client.mjs'), prices: await st('/js/prices.js') };
    check('dogfood: /templates/photoreal_recipe.json is served (sandbox CSP, nosniff); /templates/ serves nothing else, docs/ and mcp/ stay closed; /api responses carry x-wb-code',
      tpl.status === 200 && /sandbox/.test(tpl.headers['content-security-policy'] || '') && tpl.headers['x-content-type-options'] === 'nosniff' && [400, 403].includes(tplOther.up) && tplOther.md === 403 && tplOther.docs === 403 && tplOther.client === 403 && tplOther.prices === 200 && /^[0-9a-f]{12}$/.test(cOut.code || (await fetch(A.base + '/api/status')).headers.get('x-wb-code') || ''),
      { tpl: tpl.status, tplOther });
  }

  // ---------------------------------------------------------------- D8: importing existing images and video (media_scan / media_import /
  // media_upload / media_use): paths outside the media roots and traversal refused, the upload size cap, type sniffing, the
  // private flag never lowered, "use as" and uploads page only. A fake falgen tree under the root (never fal).
  {
    const Q = 'sec-d8', QD = path.join(DATA, Q);
    fs.cpSync(path.join(WB, 'data', 'demo'), QD, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
    const { makeFakeFalgen } = await import('./fake-falgen.mjs');
    makeFakeFalgen(path.join(MB, 'roots', 'ff'));
    const qop = (name, args, headers) => post(`/api/op/${name}?project=${Q}`, args, headers);
    const page = { origin: A.base };
    const OUTR = 'roots/ff/project/gen/out';
    // a junction (Windows: no admin needed) / a symlink under the root that points outside it
    let jx = false; try { fs.symlinkSync(path.join(MB, 'outside'), path.join(MB, 'roots', 'jx'), 'junction'); jx = true; } catch (e) { /* not supported here */ }
    const t1 = await qop('media_scan', { path: 'roots/../outside' }), t2 = await qop('media_scan', { path: 'outside' }), t3 = await qop('media_scan', { path: path.join(MB, 'outside') });
    const t4 = await qop('media_import', { paths: [path.join(TMP, 'elsewhere', 'plain.png')] }), t5 = await qop('media_import', { paths: ['roots\\..\\outside\\secret.txt'] });
    const t6 = await qop('media_scan', { path: 'C:/Windows/System32' }), t7 = jx ? await qop('media_scan', { path: 'roots/jx' }) : { status: 403 };
    const t8 = await qop('media_import', { items: [{ path: 'roots/./a.txt' }] }), t9 = await qop('media_scan', { path: 'roots/ff/project/gen/out/A1/job.json/..' });
    check('D8 path traversal: media_scan / media_import refuse ".." and "." paths and backslashes (400), paths outside the media roots, absolute paths elsewhere and a junction under the root pointing outside it (403); nothing is registered',
      t1.status === 400 && t2.status === 403 && t3.status === 403 && t4.status === 403 && t5.status === 400 && t6.status === 403 && t7.status === 403 && t8.status === 400 && t9.status === 400
      && !JSON.stringify(JSON.parse(fs.readFileSync(path.join(QD, 'media.json'), 'utf8'))).includes('outside'),
      { t1: t1.status, t2: t2.status, t3: t3.status, t4: t4.status, t5: t5.status, t6: t6.status, t7: t7.status, jx, t8: t8.status, t9: t9.status });
    // the upload size cap: declared over 200 MB, more bytes than declared, a body over the op's limit
    const big = await qop('media_upload', { upload: 'cap0000001', name: 'big.mp4', size: 200 * 1024 * 1024 + 1, offset: 0, data: tinyPngB64(2, 2) }, page);
    const pngB = Buffer.from(tinyPngB64(16, 16), 'base64');
    const over = await qop('media_upload', { upload: 'cap0000002', name: 'o.png', size: 10, offset: 0, data: pngB.toString('base64'), done: true }, page);
    const body = await qop('media_upload', { upload: 'cap0000003', name: 'b.png', size: 9e6, offset: 0, data: 'A'.repeat(9.5e6) }, page);
    const ok200 = await qop('media_upload', { upload: 'cap0000004', name: 'fine.png', size: pngB.length, offset: 0, data: pngB.toString('base64'), done: true }, page);
    check('D8 upload size cap: a file declared over 200 MB (413), more bytes than declared (413, the partial file removed), a body over the upload limit (413); a small real PNG is accepted',
      big.status === 413 && /200 MB/.test(big.body?.error || '') && over.status === 413 && !fs.existsSync(path.join(QD, '.uploads', 'cap0000002.part')) && body.status === 413 && ok200.status === 200 && ok200.body?.media?.path === 'media/still/fine.png',
      { big: big.status, over: over.status, body: body.status, ok: ok200.status, path: ok200.body?.media?.path });
    // type sniffing: an HTML file named .png, a text file, an audio-only MP4 brand: refused by the upload and the import
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    const s1 = await qop('media_upload', { upload: 'snf0000001', name: 'x.png', size: 38, offset: 0, data: html, done: true }, page);
    const m4a = Buffer.alloc(32); m4a.writeUInt32BE(24, 0); m4a.write('ftypM4A ', 4, 'latin1');
    const s2 = await qop('media_upload', { upload: 'snf0000002', name: 'song.mp4', size: 32, offset: 0, data: m4a.toString('base64'), done: true }, page);
    const s3 = await qop('media_import', { paths: [`${OUTR}/A1/fake.png`] }), s4 = await qop('media_import', { paths: ['roots/a.txt'] });
    const s5 = await qop('media_scan', { path: `${OUTR}/A1` });
    check('D8 type sniffing: a script named .png and an audio-only MP4 are refused on upload (415, nothing written), a text file named .png and a .txt on import (415); the scan skips them',
      s1.status === 415 && s2.status === 415 && s3.status === 415 && s4.status === 415 && s5.body?.skipped?.some(x => /fake\.png$/.test(x.path)) && s5.body.files.every(f => f.type === 'image')
      && !fs.readdirSync(path.join(QD, 'media'), { recursive: true }).some(f => /^still[\\/]x\.|song\./.test(String(f))),
      { s1: s1.status, s2: s2.status, s3: s3.status, s4: s4.status, skipped: s5.body?.skipped?.map(x => x.why) });
    // the private flag: never lowered (a PRIVATE path, a file flagged private), a private upload lands under private/
    const p1 = await qop('media_import', { paths: ['roots/private/face.png'], private: false });
    const p2 = await qop('media_import', { paths: [`${OUTR}/A1/A1_0_0.png`], private: true });
    const p3 = await qop('media_import', { paths: [`${OUTR}/A1/A1_0_0.png`], private: false });
    const p4 = await qop('media_import', { paths: ['roots/private/face.png'] });
    const pu = await qop('media_upload', { upload: 'prv0000001', name: 'me.png', size: pngB.length, offset: 0, data: pngB.toString('base64'), done: true, private: true }, page);
    const MQ = JSON.parse(fs.readFileSync(path.join(QD, 'media.json'), 'utf8')).items;
    const fl = MQ.find(m => m.path === `${OUTR}/A1/A1_0_0.png`), fc = MQ.find(m => m.path === 'roots/private/face.png');
    const localFile = await get('127.0.0.1', A.port, `/data/${Q}/${pu.body?.media?.path}`, {});
    check('D8 private: private:false on a PRIVATE path or a file flagged private is refused (403); private:true sticks (private thumbnail); a private upload goes to private/<kind>/ and is flagged',
      p1.status === 403 && p2.status === 200 && fl?.private === true && /priv_/.test(fl.thumb || '') && p3.status === 403 && p4.status === 200 && fc?.private === true
      && pu.status === 200 && /^private\/still\//.test(pu.body?.media?.path || '') && pu.body.media.private === true && localFile.status === 200,
      { p1: p1.status, p2: p2.status, fl: fl && { private: fl.private, thumb: fl.thumb }, p3: p3.status, p4: p4.status, pu: pu.body?.media?.path });
    // "use as" and uploads are the director's: the agent surface (no Origin, or claiming via "page") and offline mode get 403
    const u1 = await qop('media_use', { media: fl.id, as: 'identity', id: 'ada' });
    const u2 = await qop('media_use', { media: fl.id, as: 'start_frame', shot: 's1-intro', via: 'page' });
    const u3 = await qop('media_upload', { upload: 'agt0000001', name: 'a.png', size: pngB.length, offset: 0, data: pngB.toString('base64'), done: true, via: 'page' });
    let u4 = null; try { S.ops.media_use(Q, { media: fl.id, as: 'take', shot: 's1-intro' }); } catch (e) { u4 = e.code; }
    let u5 = null; try { S.ops.media_upload(Q, { upload: 'agt0000002', name: 'a.png', size: 4, offset: 0, data: 'AAAA' }); } catch (e) { u5 = e.code; }
    const ent = JSON.parse(fs.readFileSync(path.join(QD, 'entities', 'characters', 'ada.json'), 'utf8'));
    const u6 = await qop('media_use', { media: fl.id, as: 'take', shot: 's1-intro' }, page);
    check('D8 an agent cannot "use as" (a node, a take, a start frame) nor upload: 403 over HTTP without the page\'s Origin (even claiming via "page") and offline; no node made; the page can',
      u1.status === 403 && u2.status === 403 && u3.status === 403 && u4 === 403 && u5 === 403 && !(ent.iter?.nodes || []).some(n => n.image === fl.path) && u6.status === 200 && /director/.test(JSON.stringify(u6.body?.links?.takes || [])),
      { u1: u1.status, u2: u2.status, u3: u3.status, u4, u5, u6: u6.status });
    if (jx) try { fs.rmSync(path.join(MB, 'roots', 'jx'), { force: true, recursive: false }); } catch (e) { try { fs.unlinkSync(path.join(MB, 'roots', 'jx')); } catch (er) { /* left in the scratch folder */ } }
  }

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
    await pageSave('notes.json', (d) => { d.notes.push({ id: 'n99', target: { stage: 'timeline', kind: 'time', t: 1000 }, by: '<img src=x onerror="window.__y=3">', text: '<img src=x onerror="window.__y=4">', status: 'open', replies: [{ id: 'n99.1', text: '<img src=x onerror="window.__y=5">' }] }); });
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
    check('F02 stored payloads in the script (scene titles, text, beats, notes, intake, version messages, the timeline scenes column) render as text', await pg.evaluate(() => window.__s === undefined && !document.querySelector('.scws img:not([src*="sketches/"]):not([src*="/proposals/"]), .col-scenes img')));
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
    // notes.json v2: payloads in note texts, authors, replies and a quote, on every stage's Notes column, the timeline notes
    // column and Review > Notes, render as text
    const W = (n) => `<img src=x onerror="window.__nt=${n}">`;
    const targets = [{ stage: 'lyrics', kind: 'stage' }, { stage: 'script', kind: 'scene', id: 'sc02' }, { stage: 'breakdown', kind: 'stage' }, { stage: 'characters', kind: 'asset', id: 'ada' }, { stage: 'scenery', kind: 'asset', id: 'sec-xloc' },
      { stage: 'storyboard', kind: 'shot', id: 's2-wall' }, { stage: 'final', kind: 'shot', id: 's1-intro' }, { stage: 'timeline', kind: 'time', t: 3000 }];
    const made = [];
    for (const [i, target] of targets.entries()) { const r = await op('notes_add', { target, text: W(i), by: W(100 + i) }); if (r.status === 200) { made.push(target.stage); await op('notes_add', { reply_to: r.body.id, text: W(200 + i) }); } }
    await pageSave('notes.json', (d) => { d.notes.push({ id: 'sec-q', target: { stage: 'lyrics', kind: 'line', id: d.notes.find(x => x.target.kind === 'line')?.target.id || 'verse/0', w: [0, 0], quote: W(300) }, text: W(301), status: 'open', replies: [] }); });
    const npg = await browser.newPage(); const nv = [];
    npg.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) nv.push(m.text()); });
    await npg.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await npg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    let cells = 0;
    for (const s of ['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'final']) { await npg.evaluate((x) => window.WB.stages.open(x), s); await wait(600); cells += await npg.evaluate(() => document.querySelectorAll('.nclayer .ncn').length); }
    await npg.evaluate(() => window.WB.app.show('timeline')); await wait(700);
    const tl = await npg.evaluate(() => document.querySelectorAll('.col-notes .note').length);
    await npg.evaluate(() => window.WB.app.show('notes')); await wait(500);
    const nInert = await npg.evaluate(() => window.__nt === undefined && !document.querySelector('.nclayer img, .col-notes img, .ntab img, img[src="x"]'));
    check('F02 stored payloads in notes.json v2 (note text, author, replies, a word-range quote) render as text in every Notes column, the timeline notes column and Review > Notes',
      nInert && !nv.length && made.length === targets.length && cells >= 7 && tl >= 1, { nInert, made, cells, tl, nv: nv.slice(0, 2) });
    await npg.close();
    // rounds and revisions: payloads in a note, the agent's change summary and reply, its round summary and a revision
    // summary render as text on the rail (the round chip and its tooltips) and in Review › Compare
    const V = (n) => `<img src=x onerror="window.__rv=${n}">`;
    await pageSave('notes.json', (d) => { d.notes.push({ id: 'sec-rx', target: { stage: 'script', kind: 'scene', id: 'sc02' }, text: V(10), status: 'open', replies: [] }); });
    await post(`/api/op/round_send?project=${P}`, {}, { origin: A.base });
    await op('round_absorb', { note: 'sec-rx', change: { stage: 'script', file: 'scenes.json', version: 'v9', summary: V(11) } });
    await op('round_finish', { summary: V(12) });
    const rpg = await browser.newPage(); const rvv = [];
    rpg.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) rvv.push(m.text()); });
    await rpg.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await rpg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    const railOk = await rpg.evaluate(() => document.querySelector('#rail .rnd')?.dataset.phase === 'finished');
    await post(`/api/op/revision_close?project=${P}`, { summary: V(13) }, { origin: A.base });
    await wait(800);
    await rpg.evaluate(() => window.WB.app.show('compare')); await wait(900);
    const shown = await rpg.evaluate(async () => { const rv = window.WB.store.revisions.revisions.map(r => r.id); await window.WB.compare.select(rv.at(-2), rv.at(-1)); return { notes: window.WB.compare.data()?.notes?.length, rows: document.querySelectorAll('.cmpb .cmprow').length, list: document.querySelectorAll('.cmpl [data-rid]').length }; });
    await wait(300);
    const rInert = await rpg.evaluate(() => window.__rv === undefined && !document.querySelector('#rail img, .cmp img[src="x"], img[src="x"]'));
    check('F02 stored payloads in a round (a note, the agent\'s change summary and round summary, a revision summary) render as text on the rail and in Review › Compare',
      rInert && !rvv.length && railOk && shown.notes >= 1 && shown.rows >= 1 && shown.list >= 2, { rInert, railOk, shown, rvv: rvv.slice(0, 2) });
    await rpg.close();
    // proposals: hostile titles / whys / texts render as text, and an SVG with script (written by hand, past the
    // sanitiser) is only ever shown as <img>: it never runs in the page (also in the large view)
    const ppg = await browser.newPage(); const ppv = [];
    ppg.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) ppv.push(m.text()); });
    await ppg.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await ppg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await ppg.evaluate(() => window.WB.stages.open('script')); await wait(600);
    await ppg.evaluate(() => window.WB.script.focus('sc02')); await wait(600);
    const ppCards = await ppg.evaluate(() => document.querySelectorAll('.scrow[data-scene="sc02"] .pps .ppc').length);
    await ppg.evaluate(() => { const i = document.querySelector('.ppc[data-set="ps90"] img'); i?.click(); }); await wait(600);
    const ppInert = await ppg.evaluate(() => window.__pp === undefined && window.__ppsvg === undefined && !document.querySelector('.pps img[src="x"], .pps svg, .ppbig svg, .pps iframe, .pps object, .pps embed') && [...document.querySelectorAll('.pps .ppc img, .ppbig img')].every(i => /\/proposals\//.test(i.getAttribute('src'))));
    check('F02 proposals: hostile titles, whys and texts render as text in the strips; an SVG with script written by hand into proposals/ is only an <img> (strip and large view) and never runs',
      ppInert && ppCards >= 3 && !ppv.length, { ppInert, ppCards, ppv: ppv.slice(0, 2) });
    await ppg.close();
    // take selection: the pick's hostile note (and the shot's takes) render as text in the Shot panel and the timeline clip column
    const tpg = await browser.newPage();
    await tpg.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
    await tpg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
    await tpg.evaluate(() => window.WB.stages.open('storyboard')); await wait(600);
    await tpg.evaluate(() => window.WB.storyboard.focus('s2-wall')); await wait(800);
    const tk = await tpg.evaluate(() => ({ inert: window.__tk === undefined && !document.querySelector('.tkw img[src="x"], .col-clips img[src="x"]'), note: document.querySelector('.tkw .tknote')?.value || '', cards: document.querySelectorAll('.tkw .tkc').length }));
    check('F02 take selection: a hostile note on the pick renders as text (the Shot panel\'s takes, the note field) and never runs', tk.inert && /onerror/.test(tk.note) && tk.cards >= 2, tk);
    await tpg.close();
  }
  // ==================== D7 identity checks + D2 constants: BEGIN (a separate section) ====================
  // check_add writes checks.json only (never an approval or a pick, whatever the body says); its targets must exist; checks.json
  // is not a page save; the constants act is page only; hostile notes, item notes and constants render as text (badge, hover, editor)
  {
    const crypto = await import('node:crypto');
    const sha = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(D, f))).digest('hex'); } catch (e) { return null; } };
    const { checksFixture } = await import('./verify-checks.mjs');
    checksFixture(D, path.join(MB, 'roots'));
    const n2 = await op('character_iteration_add', { id: 'ada', request: 'rv21look', image: 'gen/rv21look/rv21look_0.jpg' });
    const NODE = `ada/${n2.body?.node?.id}`;
    const ent = readP('entities/characters/ada.json'); ent.constants = [{ text: 'clip <img src=x onerror="window.__ck3=1"> LEFT', label: '<b onmouseover="window.__ck4=1">side</b>', check: true }]; fs.writeFileSync(path.join(D, 'entities/characters/ada.json'), JSON.stringify(ent, null, 1));
    const files = ['approvals.json', 'requests.json', 'storyboard.json', 'takes.json', 'notes.json'], before = files.map(sha);
    const fromPage = await post(`/api/op/check_add?project=${P}`, { target: { kind: 'node', id: NODE }, against: { entity: 'ada' }, verdict: 'ok' }, { origin: A.base });
    const forged = await op('check_add', { target: { kind: 'node', id: NODE }, against: { entity: 'ada' }, verdict: 'fail', note: '<img src=x onerror="window.__ck=1">', via: 'page', status: 'approved', approve: true, director_approved: true, pick: { shot: 's2-wall' },
      items: [{ constant: 0, ok: false, note: '<svg onload="window.__ck2=1">' }] });
    const after = files.map(sha), ck = readP('checks.json');
    check('D7: check_add (agent or page) writes checks.json only: approvals.json, requests.json, the storyboard (picks), takes.json and notes.json are byte-identical even with status / approve / director_approved / pick / via:"page" in the body; the stored check is via "agent" with no such fields',
      forged.status === 200 && fromPage.status === 200 && JSON.stringify(after) === JSON.stringify(before) && ck.checks.length === 2 && ck.checks.every(c => c.via === 'agent' && !('status' in c) && !('approve' in c) && !('pick' in c)),
      { forged: forged.status, fromPage: fromPage.status, changed: files.filter((f, i) => after[i] !== before[i]) });
    const bad = await Promise.all([
      op('check_add', { target: { kind: 'node', id: 'ada/n99' }, against: { entity: 'ada' }, verdict: 'ok' }),
      op('check_add', { target: { kind: 'node', id: '../x/n01' }, against: { entity: 'ada' }, verdict: 'ok' }),
      op('check_add', { target: { kind: 'take', id: 's2-wall/nope' }, against: { entity: 'ada' }, verdict: 'ok' }),
      op('check_add', { target: { kind: 'take', id: 's9-none/C1_0' }, against: { entity: 'ada' }, verdict: 'ok' }),
      op('check_add', { target: { kind: 'media', id: 'nope' }, against: { entity: 'ada' }, verdict: 'ok' }),
      op('check_add', { target: { kind: 'media', id: '<script>' }, against: { entity: 'ada' }, verdict: 'ok' }),
      op('check_add', { target: { kind: 'shot', id: 's2-wall' }, against: { entity: 'ada' }, verdict: 'ok' }),
      op('check_add', { target: { kind: 'node', id: NODE }, against: { entity: 'ghost' }, verdict: 'ok' }),
      op('check_add', { target: { kind: 'node', id: NODE }, against: { entity: 'ada', node: 'n77' }, verdict: 'ok' }),
      op('check_add', { target: { kind: 'node', id: NODE }, against: { entity: 'ada' }, verdict: 'approved' }),
    ]);
    check('D7: check_add targets must exist (a missing node, a take that is not one of that shot\'s, a missing shot or media, a missing character or comparison node: 404) and be well formed (a path in an id, markup, an unknown kind, an unknown verdict: 400); nothing written',
      bad.map(r => r.status).join() === '404,400,404,404,404,400,400,404,404,400' && readP('checks.json').checks.length === 2, bad.map(r => `${r.status} ${String(r.body?.error || '').slice(0, 40)}`));
    const saveCk = await post(`/api/save/checks.json?project=${P}`, { base_rev: ck.rev, data: { ...ck, checks: [] } }, { origin: A.base });
    const agentConst = await op('asset_act', { type: 'character', id: 'ada', act: 'constants', constants: ['x'] });
    const claimed = await op('asset_act', { type: 'character', id: 'ada', act: 'constants', constants: ['x'], via: 'page' });
    check('D7: checks.json is not a page save (403); D2: the constants act is the page\'s (agent 403, also with via:"page" in the body)', saveCk.status === 403 && agentConst.status === 403 && claimed.status === 403 && readP('checks.json').checks.length === 2,
      { saveCk: saveCk.status, agentConst: agentConst.status, claimed: claimed.status });
    if (browser) {
      const cpg = await browser.newPage();
      await cpg.setViewport({ width: 1400, height: 900 });
      await cpg.goto(`${A.base}/?project=${P}`, { waitUntil: 'domcontentloaded' });
      await cpg.waitForFunction('document.body.dataset.ready === "1"', { timeout: 30000 });
      await cpg.evaluate(() => window.WB.stages.open('characters')); await wait(600);
      await cpg.evaluate(() => window.WB.characters.open('ada')); await wait(300);
      await cpg.evaluate(() => window.WB.characters.ws.setTab('identity')); await wait(400);
      const ed = await cpg.evaluate(() => ({ text: document.querySelector('.chconst .cctext')?.value || '', label: document.querySelector('.chconst .cclabel')?.value || '' }));
      await cpg.evaluate(() => window.WB.characters.ws.setTab('looks')); await wait(500);
      await cpg.hover('.chnode .ckb').catch(() => {}); await wait(300);
      const r = await cpg.evaluate(() => ({ inert: window.__ck === undefined && window.__ck2 === undefined && window.__ck3 === undefined && window.__ck4 === undefined && !document.querySelector('.ckpop img, .ckpop svg, .ckb img, .chconst img, .ckpop b[onmouseover]'),
        badge: document.querySelector('.chnode .ckb')?.textContent || '', pop: document.querySelector('.ckpop')?.textContent || '' }));
      check('F02 D7: hostile check notes, item notes and constants (text and label) render as text in the badge, its hover detail and the constants editor, and never run',
        r.inert && /onerror/.test(r.pop) && /onload/.test(r.pop) && /^✗ /.test(r.badge) && /onerror/.test(ed.text) && /onmouseover/.test(ed.label), { ...r, pop: r.pop.slice(0, 160), ed });
      await cpg.close();
    }
  }
  // ==================== D7 identity checks + D2 constants: END ====================
} catch (e) { check('test ran to the end', false, String(e.stack || e)); }
finally {
  if (browser) await browser.close().catch(() => {});
  A?.c.kill(); L?.c.kill(); await FAL.close(); await wait(300);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
console.log(`\n${n - failed}/${n} security checks passed`);
process.exit(failed ? 1 : 0);
