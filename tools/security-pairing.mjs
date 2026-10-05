#!/usr/bin/env node
// Security regressions for G7 pairing (lib/pairing.mjs, serve.mjs): a page on ANOTHER origin (the future hosted app) talking to the
// local helper.
//   - a pairing code works ONCE, expires (10 min; here a 1 ms code), and 5 wrong codes void every pending code (no brute force);
//     a code made for one Origin is refused from another (and is void after); the code and the token are stored only as sha256
//   - the token is bound to its Origin: another Origin with it, or no Origin at all, is 403 (never "falls back" to anything);
//     the server's own Origin cannot pair; plain http:// on a non-loopback host cannot pair
//   - a wrong Origin without a token is still refused (403 foreign Origin), and a CORS preflight is answered only for /api/pair and
//     for paired Origins (with Access-Control-Allow-Private-Network for Chrome's PNA / LNA)
//   - scope "director": the page's acts only with a browser's Sec-Fetch-Site (else the request is an agent's), never private files
//     (403; JSON scrubbed), never include_private, never pairing management / Reveal / the onboarding flag; scope "read": every
//     write 403
//   - revocable: POST /api/pairings revoke is the LOCAL page's only (403 to the agent token, the page token without its Origin, a
//     paired page); a revoked token is 403 at once; .wb-pairings.json is never served
// Scratch data folder; never touches data/.   node tools/security-pairing.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = 'psec', TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sec-pair-')), DATA = path.join(TMP, 'data'), D = path.join(DATA, P);
fs.cpSync(path.join(WB, 'data', 'demo'), D, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
// a private photo (the PRIVATE rule) and a file flagged private in media.json
fs.mkdirSync(path.join(D, 'private', 'refs'), { recursive: true }); fs.writeFileSync(path.join(D, 'private', 'refs', 'face.png'), 'not really a png');
fs.mkdirSync(path.join(D, 'media', 'still'), { recursive: true }); fs.writeFileSync(path.join(D, 'media', 'still', 'flagged.png'), 'flagged');
const M = JSON.parse(fs.readFileSync(path.join(D, 'media.json'), 'utf8'));
M.items.push({ id: 'psec-face', path: 'private/refs/face.png', kind: 'ref', private: true }, { id: 'psec-flag', path: 'media/still/flagged.png', kind: 'still', private: true });
fs.writeFileSync(path.join(D, 'media.json'), JSON.stringify(M, null, 1));
const PR = await import(pathToFileURL(path.join(WB, 'lib', 'pairing.mjs')).href);

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const O = 'https://director.example', EVIL = 'https://evil.example';

let srv = null;
try {
  const port = await freePort(), B = `http://localhost:${port}`;
  const env = { ...process.env, WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P };
  for (const k of ['WB_TOKEN', 'WB_HOST', 'WB_ALLOW_REMOTE_OPS', 'WB_AGENT_TOKEN', 'WB_HELPER']) delete env[k];
  srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env });
  srv.stderr.on('data', d => process.stderr.write('server: ' + d));
  await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
  const req = async (p, { method = 'GET', headers = {}, body } = {}) => {
    const r = await fetch(B + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, body: j, h: r.headers };
  };
  const pair = (code, origin = O, extra = {}) => req('/api/pair', { method: 'POST', headers: { origin, ...extra }, body: { code } });
  const asPaired = (token, p, { origin = O, body, site = 'cross-site', method } = {}) => req(p, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { origin, 'x-wb-pair-token': token, ...(site ? { 'sec-fetch-site': site } : {}) }, body });

  // ---------------------------------------------------------------- codes: single use, expiry, brute force, bound origin
  const c1 = PR.createCode(DATA, {});
  const r1 = await pair(c1.code.toLowerCase().replace('-', ' '));
  const again = await pair(c1.code);
  const stored = fs.readFileSync(path.join(DATA, '.wb-pairings.json'), 'utf8');
  check('a code redeems once (case and separators do not matter): token + id + origin + scope director; the answer readable by that Origin only (ACAO); the same code again: 403',
    r1.status === 200 && /^[0-9a-f]{64}$/.test(r1.body.token) && r1.body.origin === O && r1.body.scope === 'director' && r1.h.get('access-control-allow-origin') === O && again.status === 403,
    { r1: r1.status, scope: r1.body?.scope, acao: r1.h.get('access-control-allow-origin'), again: again.status });
  check('the pairings file holds only hashes: neither the code nor the token is in it', !stored.includes(r1.body.token) && !stored.includes(c1.code.replace('-', '')), stored.length);
  const T = r1.body.token;
  const c2 = PR.createCode(DATA, { ttlMs: 1 }); await wait(30);
  const exp = await pair(c2.code);
  check('an expired code is refused (403)', exp.status === 403 && /expired/.test(exp.body.error), exp.body);
  const live = PR.createCode(DATA, {});
  const wrongs = []; for (let i = 0; i < PR.MAX_FAILS; i++) wrongs.push((await pair(`ZZZZ-ZZZ${i}`)).status);
  const afterBrute = await pair(live.code);
  check(`${PR.MAX_FAILS} wrong codes void every pending code: the valid one is refused afterwards (no brute force)`, wrongs.every(s => s === 403) && afterBrute.status === 403, { wrongs, afterBrute: afterBrute.body });
  const c3 = PR.createCode(DATA, { origin: 'https://other.example' });
  const wrongOrigin = await pair(c3.code, O), thenRight = await pair(c3.code, 'https://other.example');
  check('a code made for one Origin is refused from another, and is void after that (the right Origin then gets 403 too)', wrongOrigin.status === 403 && thenRight.status === 403, { wrongOrigin: wrongOrigin.body, thenRight: thenRight.status });
  const c4 = PR.createCode(DATA, {});
  const own = await pair(c4.code, B), plain = await pair(c4.code, 'http://evil.example'), none = await req('/api/pair', { method: 'POST', body: { code: c4.code } });
  const stillOk = await pair(c4.code, 'https://second.example');
  check('the server\'s own Origin, plain http:// on another host and no Origin cannot pair (403); the code is still good for a real https Origin afterwards',
    own.status === 403 && plain.status === 403 && none.status === 403 && stillOk.status === 200, { own: own.status, plain: plain.status, none: none.status, stillOk: stillOk.status });
  check('createCode refuses a bad origin and a bad scope', (() => { try { PR.createCode(DATA, { origin: 'javascript:alert(1)' }); return false; } catch (e) { /* ok */ } try { PR.createCode(DATA, { scope: 'root' }); return false; } catch (e) { return true; } })());

  // ---------------------------------------------------------------- the token: bound to its Origin
  const good = await asPaired(T, `/api/projects`);
  const evil = await asPaired(T, `/api/projects`, { origin: EVIL });
  const noOrigin = await req('/api/projects', { headers: { 'x-wb-pair-token': T } });
  const forged = await asPaired('0'.repeat(64), '/api/projects');
  check('the token works from its Origin (CORS for it); another Origin, no Origin, or an unknown token: 403',
    good.status === 200 && good.h.get('access-control-allow-origin') === O && evil.status === 403 && /bound to/.test(evil.body.error) && noOrigin.status === 403 && forged.status === 403,
    { good: good.status, evil: evil.body, noOrigin: noOrigin.status, forged: forged.status });
  const foreign = await req(`/api/op/notes_get?project=${P}`, { method: 'POST', headers: { origin: EVIL }, body: {} });
  const noCors = await req('/api/projects', { headers: { origin: EVIL } });
  check('a wrong Origin without a token: a write is 403 (foreign Origin); a read gets no CORS header (the browser keeps the answer from that page)', foreign.status === 403 && !noCors.h.get('access-control-allow-origin'), { foreign: foreign.status, acao: noCors.h.get('access-control-allow-origin') });
  const pfPaired = await req('/api/op/notes_get', { method: 'OPTIONS', headers: { origin: O, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
  const pfEvil = await req('/api/op/notes_get', { method: 'OPTIONS', headers: { origin: EVIL, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
  const pfPair = await req('/api/pair', { method: 'OPTIONS', headers: { origin: EVIL, 'access-control-request-method': 'POST' } });
  check('a CORS preflight: a paired Origin gets 204 with Access-Control-Allow-Private-Network (PNA / LNA) and x-wb-pair-token allowed; an unpaired Origin 403 (but /api/pair, where the code is the gate)',
    pfPaired.status === 204 && pfPaired.h.get('access-control-allow-private-network') === 'true' && /x-wb-pair-token/.test(pfPaired.h.get('access-control-allow-headers') || '') && pfEvil.status === 403 && pfPair.status === 204,
    { pfPaired: pfPaired.status, pna: pfPaired.h.get('access-control-allow-private-network'), pfEvil: pfEvil.status, pfPair: pfPair.status });

  // ---------------------------------------------------------------- scope director: the page's acts, never private
  const asPage = await asPaired(T, `/api/op/notes_get?project=${P}`, { body: {} });
  const noSite = await asPaired(T, `/api/op/notes_get?project=${P}`, { body: {}, site: null });
  const lockNoSite = await asPaired(T, `/api/op/final_lock?project=${P}`, { body: { summary: 'x' }, site: null });
  check('scope director: from its Origin with a browser\'s Sec-Fetch-Site the request is the page (x-wb-client page); without it, an agent (a page-only act: 403)',
    asPage.status === 200 && asPage.h.get('x-wb-client') === 'page' && noSite.h.get('x-wb-client') === 'agent' && lockNoSite.status === 403, { asPage: asPage.h.get('x-wb-client'), noSite: noSite.h.get('x-wb-client'), lock: lockNoSite.status });
  const privFile = await asPaired(T, `/data/${P}/private/refs/face.png`), flagged = await asPaired(T, `/data/${P}/media/still/flagged.png`), media = await asPaired(T, `/data/${P}/media.json`);
  const localPriv = await req(`/data/${P}/private/refs/face.png`);
  check('never private files: a private photo and a file flagged private are 403 to the paired page (localhost itself still reads them); its media.json is scrubbed of them',
    privFile.status === 403 && flagged.status === 403 && media.status === 200 && !JSON.stringify(media.body).includes('face.png') && !JSON.stringify(media.body).includes('flagged.png') && localPriv.status === 200,
    { privFile: privFile.status, flagged: flagged.status, media: media.status, local: localPriv.status });
  const ip = await asPaired(T, `/api/op/project_export?project=${P}`, { body: { include_private: true } });
  const mgmt = await asPaired(T, '/api/pairings', { body: { action: 'list' } }), rev = await asPaired(T, '/api/reveal', { body: { path: 'song.json' } }), ob = await asPaired(T, '/api/onboarding', { body: { done: true } });
  const pairAgain = await asPaired(T, '/api/pair', { body: { code: 'AAAA-BBBB' } });
  check('a paired page never gets include_private, the pairing list / revoke, Reveal or the onboarding flag, and cannot pair again with its token (403 each)',
    [ip, mgmt, rev, ob, pairAgain].every(r => r.status === 403), [ip, mgmt, rev, ob, pairAgain].map(r => r.status));
  // scope read
  const cr = PR.createCode(DATA, { scope: 'read' }), rr = await pair(cr.code, 'https://viewer.example');
  const rGet = await asPaired(rr.body.token, `/data/${P}/song.json`, { origin: 'https://viewer.example' });
  const rPost = await asPaired(rr.body.token, `/api/op/notes_get?project=${P}`, { origin: 'https://viewer.example', body: {} });
  check('scope read: reads work, every write is 403', rr.body.scope === 'read' && rGet.status === 200 && rPost.status === 403 && /read only/.test(rPost.body.error), { get: rGet.status, post: rPost.body });

  // ---------------------------------------------------------------- revocation: the local page only; .wb-pairings.json never served
  const html = await (await fetch(`${B}/?project=${P}`)).text();
  const PT = /name="wb-token" content="([0-9a-f]+)"/.exec(html)?.[1];
  const AT = fs.readFileSync(path.join(DATA, '.wb-agent-token'), 'utf8').trim();
  const local = (headers, body) => req('/api/pairings', { method: 'POST', headers, body });
  const byAgent = await local({ 'x-wb-agent-token': AT }, { action: 'revoke', id: r1.body.id });
  const byTokenOnly = await local({ 'x-wb-token': PT }, { action: 'revoke', id: r1.body.id });
  const pageH = { 'x-wb-token': PT, origin: B, 'sec-fetch-site': 'same-origin' };
  const list = await local(pageH, { action: 'list' });
  check('the pairing list is the local page\'s (the agent token and the page token without its Origin: 403); it names origins and scopes, never a token',
    byAgent.status === 403 && byTokenOnly.status === 403 && list.status === 200 && list.body.pairings.some(p => p.id === r1.body.id && p.origin === O) && !JSON.stringify(list.body).includes(T) && !JSON.stringify(list.body).includes('hash'),
    { byAgent: byAgent.status, byTokenOnly: byTokenOnly.status, list: list.body?.pairings?.map(p => p.id) });
  const revoked = await local(pageH, { action: 'revoke', id: r1.body.id });
  const afterRevoke = await asPaired(T, '/api/projects');
  const pfAfter = await req('/api/op/notes_get', { method: 'OPTIONS', headers: { origin: O, 'access-control-request-method': 'POST' } });
  check('Revoke (the local page): the token is 403 at once and its Origin\'s preflights are no longer answered', revoked.status === 200 && !revoked.body.pairings.some(p => p.id === r1.body.id) && afterRevoke.status === 403 && pfAfter.status === 403,
    { revoked: revoked.status, after: afterRevoke.status, pf: pfAfter.status });
  const leak = await Promise.all([`/data/.wb-pairings.json`, `/data/${P}/../.wb-pairings.json`, `/.wb-pairings.json`, `/data/%2e%2e/.wb-pairings.json`].map(p => req(p).then(r => r.status)));
  check('.wb-pairings.json is never served', leak.every(s => s === 403 || s === 400 || s === 404), leak);
} catch (e) { check('ran to the end', false, String(e.stack || e)); }
finally {
  srv?.kill(); await wait(300);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
console.log(`\nsecurity-pairing: ${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
