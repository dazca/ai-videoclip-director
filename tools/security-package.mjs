#!/usr/bin/env node
// Security regressions for C5, the interactive HTML package from the page (ROADMAP_v4), and the Queue's Notes column:
//   - page only (S9: the page token + this server's Origin + Sec-Fetch-Site: same-origin): package_start, package_cancel. 403 to the
//     page token alone, the agent token, the Origin alone, Sec-Fetch-Site alone, cross-site, a forged Origin with the agent token, a
//     claimed via "page"; no MCP tool; offline refuses
//   - an export is never started by an agent: request_create kind package 400, request_update queued / running / done 403 (its own
//     draft's withdraw is fine), request_run and tools/run.mjs refuse a package request, even one a save marked "approved"
//   - the export command and its paths are not agent-controllable: package_propose drops any composition / command / out / entry /
//     args it is sent; an agent's save of requests.json with a forged package {composition, command, out} or package_run {dir, log}
//     is never read (the job reads the director's render settings, the folders are named from the request id, the programs are the
//     workbench's own exporter and checker); renders.json is not a save; render_config refuses an entry that leaves the composition,
//     a relative or missing composition / HyperFrames folder; a request id with ".." is 400; nothing an agent sent ever runs
//   - the report never names a file outside the package's -verify folder (image names are checked)
//   - a project locked for render still takes the agent's proposal (requests.json only), never its start
//   - a note on a Queue row: target final / request / <id> must name a request (404), an id shape (400)
// Scratch copy of data/demo, its own server on a free port; never touches data/; nothing is exported (no Chrome).
//   node tools/security-package.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = 'psec', TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sec-package-')), DATA = path.join(TMP, 'data'), D = path.join(DATA, P);
fs.cpSync(path.join(WB, 'data', 'demo'), D, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
Object.assign(process.env, { WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P, WB_TEST: '1' });
for (const k of ['WB_TOKEN', 'WB_HOST', 'WB_ALLOW_REMOTE_OPS']) delete process.env[k];
const S = await import('../lib/store.mjs');
const RN = await import('../js/renders.js');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 1500) : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const J = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
const MARK = path.join(TMP, 'PWNED.txt');
const evil = ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(MARK)}, 'x')`];
const EVILDIR = path.join(TMP, 'evilcomp');
fs.mkdirSync(EVILDIR, { recursive: true }); fs.writeFileSync(path.join(EVILDIR, 'index.html'), '<script>x</script>');
const FAKE = ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s={width}x{height}:r={fps}', '-t', '{duration}', '-pix_fmt', 'yuv420p', '{out}'];
let srv = null;
try {
  const port = await freePort(), BASE = `http://localhost:${port}`;
  srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: process.env });
  srv.stderr.on('data', d => process.stderr.write('server: ' + d));
  await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
  const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
  const AGENT = fs.readFileSync(path.join(DATA, '.wb-agent-token'), 'utf8').trim();
  const H = {
    page: { 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'same-origin' },
    tokenOnly: { 'x-wb-token': TOKEN }, agent: { 'x-wb-agent-token': AGENT }, originOnly: { 'x-wb-token': TOKEN, origin: BASE },
    fetchSiteOnly: { 'x-wb-token': TOKEN, 'sec-fetch-site': 'same-origin' }, agentForged: { 'x-wb-agent-token': AGENT, 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'same-origin' },
    crossSite: { 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'cross-site' },
  };
  const op = async (name, body, h = H.agent) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const save = async (file, fn, h = H.page) => { let d; try { d = J(file); } catch (e) { d = { rev: 0 }; } fn(d); const r = await fetch(`${BASE}/api/save/${file}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ base_rev: d.rev || 0, data: d }) }); return { status: r.status, body: await r.json().catch(() => null) }; };

  // 1. the agent's proposal drops everything but why / against
  const pr = await op('package_propose', { why: 'sec', composition: EVILDIR, command: evil, out: '../../../x', entry: '../../x.html', args: ['--project', '/'], hyperframes: EVILDIR, package: { composition: EVILDIR } });
  const pid = pr.body?.request?.id, st = J('requests.json').items.find(r => r.id === pid);
  check('package_propose (agent): a draft request of kind package whose package holds only {why}; no composition, command, out, entry or args is stored',
    pr.status === 200 && st?.kind === 'package' && st.status === 'draft' && st.by === 'agent' && JSON.stringify(Object.keys(st.package)) === '["why"]' && !JSON.stringify(st).includes('evilcomp') && !JSON.stringify(st).includes('PWNED'),
    { status: pr.status, pkg: st?.package });
  const badAgainst = await op('package_propose', { against: '../../x' }), notDone = await op('package_propose', { against: 'nope' });
  check('package_propose: against is a render id (400 with "..") of a done render (409)', badAgainst.status === 400 && notDone.status === 409, { badAgainst: badAgainst.status, notDone: notDone.status });

  // 2. the page-only acts
  const BODIES = { package_start: { id: pid }, package_cancel: { id: pid } };
  const matrix = {};
  for (const [name, body] of Object.entries(BODIES)) {
    matrix[name] = {};
    for (const k of ['tokenOnly', 'agent', 'originOnly', 'fetchSiteOnly', 'agentForged', 'crossSite']) matrix[name][k] = (await op(name, body, H[k])).status;
    matrix[name].claimed = (await op(name, { ...body, via: 'page' }, H.agent)).status;
  }
  const offline = {};
  for (const name of Object.keys(BODIES)) { try { await S.ops[name](P, BODIES[name]); offline[name] = 'allowed'; } catch (e) { offline[name] = e.code; } }
  const tools = fs.readFileSync(path.join(WB, 'mcp', 'tools', 'renders.mjs'), 'utf8');
  check('package_start / package_cancel are page only: 403 to the page token alone, the agent token, the Origin alone, Sec-Fetch-Site alone, a forged Origin with the agent token, cross-site, a claimed via "page"; offline 403; no MCP tool',
    Object.values(matrix).every(m => Object.values(m).every(s => s === 403)) && Object.values(offline).every(c => c === 403) && !/registerTool\('package_start'|registerTool\('package_cancel'/.test(tools) && /registerTool\('package_propose'/.test(tools),
    { matrix, offline });

  // 3. never started by an agent: the queue's lifecycle and the runner refuse it
  const cr = await op('request_create', { kind: 'package', prompt: 'x', est_cost: 0 });
  const forged = await save('requests.json', (d) => { const r = d.items.find(x => x.id === pid); r.status = 'approved'; r.package = { composition: EVILDIR, command: evil, out: '../../../x' }; r.command = evil; r.package_run = { dir: '../../..', log: '../../.wb-agent-token' }; }, H.agent);
  const u1 = await op('request_update', { id: pid, status: 'queued' }), u2 = await op('request_update', { id: pid, status: 'running' }), u3 = await op('request_update', { id: pid, status: 'done', outputs: ['x/index.html'], actual_cost_usd: 0 });
  const rr = await op('request_run', { ids: [pid] });
  const cli = spawnSync(process.execPath, [path.join(WB, 'tools', 'run.mjs'), '--project', P, pid], { env: process.env, encoding: 'utf8', timeout: 60000 });
  const g = await op('renders_get', { id: pid });
  check('an export is never started by an agent: request_create kind package 400, request_update queued / running / done 403, request_run (even after a save marked it approved) and tools/run.mjs refuse it; a forged package_run log path reads nothing',
    cr.status === 400 && u1.status === 403 && u2.status === 403 && u3.status === 403 && rr.status === 200 && !(rr.body.started || []).length && rr.body.refused?.some(x => /package/.test(x.why))
    && /package/.test(cli.stdout + cli.stderr) && !/started/i.test(cli.stdout + '') && !JSON.stringify(g.body || {}).includes(AGENT),
    { cr: cr.status, forged: forged.status, u: [u1.status, u2.status, u3.status], rr: rr.body?.refused, cli: (cli.stdout + cli.stderr).slice(0, 160) });

  // 4. the paths and the command come from the director's settings only
  const noCfg = await op('package_start', { id: pid }, H.page);
  const emptyComp = path.join(TMP, 'emptycomp'); fs.mkdirSync(emptyComp, { recursive: true });
  const cfgOk = await op('render_config', { config: { command: FAKE, composition: emptyComp, min_free_mb: 0, ram_wait_s: 0 } }, H.page);
  const noEntry = await op('package_start', { id: pid }, H.page);
  const badEntry = await op('render_config', { config: { command: FAKE, composition: emptyComp, entry: '../evilcomp/index.html' } }, H.page);
  const relComp = await op('render_config', { config: { command: FAKE, composition: 'evilcomp' } }, H.page);
  const missingHf = await op('render_config', { config: { command: FAKE, composition: emptyComp, hyperframes: path.join(TMP, 'nope') } }, H.page);
  const badId = await op('package_start', { id: '../x' }, H.page), badAg = await op('package_start', { id: pid, against: '../r' }, H.page);
  const rsave = await save('renders.json', (d) => { d.config = { command: evil, composition: EVILDIR }; d.packages = [{ id: '../x', dir: '../../..' }]; }, H.agent);
  const rsavePage = await save('renders.json', (d) => { d.config = { command: evil, composition: EVILDIR }; }, H.page);
  await wait(500);
  check('the export reads the director\'s render settings only: with none it is 409 (the forged package.composition is not used), with a composition lacking its entry 409; render_config refuses an entry outside the composition, a relative composition, a missing HyperFrames folder (400); renders.json is not a save (403, the page too); a request id with ".." 400; nothing an agent sent ever ran',
    noCfg.status === 409 && /composition folder/.test(noCfg.body?.error || '') && cfgOk.status === 200 && noEntry.status === 409 && /no index\.html/.test(noEntry.body?.error || '')
    && badEntry.status === 400 && relComp.status === 400 && missingHf.status === 400 && badId.status === 400 && badAg.status === 400 && rsave.status === 403 && rsavePage.status === 403
    && J('renders.json').config.composition === emptyComp && !fs.existsSync(MARK) && !fs.existsSync(path.join(EVILDIR, 'manifest.json')) && !fs.existsSync(path.join(D, 'exports', 'package', pid)),
    { noCfg: noCfg.body?.error, noEntry: noEntry.body?.error, badEntry: badEntry.status, relComp: relComp.status, missingHf: missingHf.status, badId: badId.status, badAg: badAg.status, rsave: rsave.status, rsavePage: rsavePage.status, mark: fs.existsSync(MARK) });

  // 5. the report: image names checked; a package's folders are named from its id
  const rep = RN.packageReport({ frames: [{ t: 1, frame: 30, madPct: 9, psnr: 10, image: '../../../.wb-agent-token' }, { t: 2, frame: 60, madPct: 1, psnr: 40, image: 'cmp-2.000.jpg' }, { t: 3, frame: 90, madPct: 2, psnr: 30, image: 'cmp-3.000.jpg/../../x' }], thresholds: { maxMadPct: 5, minPsnr: 20 }, requests: { pageErrors: ['<img src=x onerror=alert(1)>'] } });
  check('the frame-match report keeps only cmp-<t>.jpg image names (a "../" name is dropped), counts the bad frames and keeps problems as text (rendered escaped)',
    rep.frames === 3 && rep.pass === 2 && rep.verdict === 'fail' && rep.worst[0].image === undefined && rep.worst.find(w => w.t === 2)?.image === 'cmp-2.000.jpg' && rep.worst.find(w => w.t === 3)?.image === undefined && rep.problems.length === 1,
    { worst: rep.worst });

  // 6. the lock: the agent may still propose (requests.json only), never start
  const lk = await op('final_lock', { force: true, summary: 'sec' }, H.page);
  const lp = await op('package_propose', { why: 'locked' }), ls = await op('package_start', { id: lp.body?.request?.id });
  const lrp = await op('render_propose', { scope: 'excerpt', t0: 0, t1: 2000 });
  const ul = await op('final_unlock', {}, H.page);
  check('a project locked for render takes the agent\'s package_propose (200: a draft in requests.json) and still refuses its start (403 / 409) and its render_propose (409)',
    lk.status === 200 && lp.status === 200 && lp.body.request.kind === 'package' && [403, 409].includes(ls.status) && lrp.status === 409 && ul.status === 200, { lk: lk.status, lp: lp.status, ls: ls.status, lrp: lrp.status });

  // 7. a note on a Queue row
  const n1 = await op('notes_add', { target: { stage: 'final', kind: 'request', id: pid }, text: 'on the export' });
  const n2 = await op('notes_add', { target: { stage: 'final', kind: 'request', id: 'nope123' }, text: 'x' });
  const n3 = await op('notes_add', { target: { stage: 'final', kind: 'request', id: '../x' }, text: 'x' });
  const n4 = await op('notes_add', { target: { stage: 'final', kind: 'request', id: pid }, text: '<img src=x onerror=alert(1)>' });
  check('a note on a Queue row: target final / request / <id> of an existing request (200, via agent), an unknown request 404, a bad id 400; its text is stored as text',
    n1.status === 200 && n2.status === 404 && n3.status === 400 && n4.status === 200 && J('notes.json').notes.find(x => x.target?.kind === 'request' && x.text.startsWith('<img'))?.via === 'agent', { n: [n1.status, n2.status, n3.status, n4.status] });
} catch (e) { check('test ran to the end', false, String(e.stack || e)); }
finally {
  srv?.kill(); await wait(400);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
console.log(`\n${n - failed}/${n} HTML package security checks passed`);
process.exit(failed ? 1 : 0);
