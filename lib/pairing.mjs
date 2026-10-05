// G7 pairing: a page served from ANOTHER origin (the future hosted app, G1) talking to this local helper. The local side only.
//   1. the terminal shows a short code (npx ai-videoclip-director pair [--origin https://…] [--read-only]); the code is
//      the only secret that crosses from the terminal to the page, typed by the director;
//   2. the page sends it ONCE: POST /api/pair {code} from its Origin -> {token, id, origin, scope}. The code is
//      single-use, expires (10 min), and 5 wrong codes void every pending code (no brute force);
//   3. the page then sends x-wb-pair-token on every call. The token is bound to that Origin: another Origin with it is
//      refused, and so is a request without an Origin (pair tokens are for browsers);
//   4. pairings are listed (never their token) and revocable: Settings › Paired pages (the local page only) or
//      `npx ai-videoclip-director pair --list | --revoke <id>`.
// Scopes: "director" (the paired page acts as the director: the page's own acts, like the local page; never private
// files, never pairing management, never Reveal) and "read" (GET only: every write 403).
// Storage: <data folder>/.wb-pairings.json (a dot-file outside every project: never served). Only sha256 hashes of codes and
// tokens are stored; the token itself is shown once, to the page that redeemed the code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_FAILS = 5;
export const SCOPES = ['director', 'read'];
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I: read aloud, typed by hand
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const fileOf = (dataRoot) => path.join(dataRoot, '.wb-pairings.json');
const empty = () => ({ v: 1, codes: [], pairings: [], fails: 0 });

export function load(dataRoot) {
  try { const j = JSON.parse(fs.readFileSync(fileOf(dataRoot), 'utf8')); return { ...empty(), ...j, codes: Array.isArray(j.codes) ? j.codes : [], pairings: Array.isArray(j.pairings) ? j.pairings : [] }; }
  catch (e) { return empty(); }
}
function save(dataRoot, d) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const f = fileOf(dataRoot), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 }); fs.renameSync(tmp, f);
}
// an Origin as the browser sends it: scheme://host[:port], nothing else; https, or http on a loopback name (tests, a dev build)
export function cleanOrigin(o) {
  if (typeof o !== 'string' || !o || o === 'null') return null;
  let u; try { u = new URL(o); } catch (e) { return null; }
  if (u.origin !== o.replace(/\/$/, '')) return null;
  if (u.protocol === 'https:') return u.origin;
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return u.origin;
  return null;
}
export const normCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// a new code (shown once in the terminal): {code: "ABCD-EFGH", expires}
export function createCode(dataRoot, { origin = null, scope = 'director', ttlMs = CODE_TTL_MS } = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`scope: ${SCOPES.join(' | ')}`);
  const o = origin == null ? null : cleanOrigin(origin);
  if (origin != null && !o) throw new Error(`origin: an https origin like https://director.example (got ${origin})`);
  const bytes = crypto.randomBytes(8); let raw = '';
  for (const b of bytes) raw += ALPHA[b % ALPHA.length];
  const d = load(dataRoot), now = Date.now();
  d.codes = d.codes.filter(c => c.expires > now);
  d.codes.push({ hash: sha(raw), origin: o, scope, expires: now + ttlMs });
  save(dataRoot, d);
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires: new Date(now + ttlMs).toISOString().slice(0, 19), origin: o, scope };
}

// the page redeems a code from its Origin -> {token, id, origin, scope}; errors carry .code (400 / 403)
export function redeem(dataRoot, code, origin, { label } = {}) {
  const fail = (status, msg) => { const e = new Error(msg); e.code = status; throw e; };
  const o = cleanOrigin(origin);
  if (!o) fail(403, 'pairing needs the page\'s Origin (https://…): open the hosted page in a browser');
  const d = load(dataRoot), now = Date.now();
  d.codes = d.codes.filter(c => c.expires > now);
  const n = normCode(code);
  const hit = n.length === 8 ? d.codes.find(c => crypto.timingSafeEqual(Buffer.from(c.hash), Buffer.from(sha(n)))) : null;
  if (!hit) {
    d.fails = (d.fails || 0) + 1;
    if (d.fails >= MAX_FAILS) { d.codes = []; d.fails = 0; save(dataRoot, d); fail(403, `wrong pairing code ${MAX_FAILS} times: every pending code is void. Make a new one in the terminal (npx ai-videoclip-director pair)`); }
    save(dataRoot, d); fail(403, 'wrong or expired pairing code (codes work once, for 10 minutes): make a new one in the terminal');
  }
  if (hit.origin && hit.origin !== o) { d.codes = d.codes.filter(c => c !== hit); save(dataRoot, d); fail(403, `this code was made for ${hit.origin}, not ${o}: it is void now`); }
  d.codes = d.codes.filter(c => c !== hit); d.fails = 0;   // single use
  const token = crypto.randomBytes(32).toString('hex'), id = 'pr' + crypto.randomBytes(4).toString('hex');
  const at = new Date(now).toISOString().slice(0, 19);
  d.pairings.push({ id, hash: sha(token), origin: o, scope: hit.scope, created: at, last_used: at, ...(label ? { label: String(label).slice(0, 80) } : {}) });
  save(dataRoot, d);
  return { token, id, origin: o, scope: hit.scope };
}

// a request's pair token + Origin -> {ok, pairing} | {ok: false, why}; touches last_used at most once a minute
export function check(dataRoot, token, origin) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return { ok: false, why: 'missing or malformed pair token' };
  const d = load(dataRoot), h = sha(token);
  const p = d.pairings.find(x => crypto.timingSafeEqual(Buffer.from(x.hash), Buffer.from(h)));
  if (!p) return { ok: false, why: 'unknown or revoked pairing: pair again (npx ai-videoclip-director pair)' };
  if (!origin || cleanOrigin(origin) !== p.origin) return { ok: false, why: `this pairing is bound to ${p.origin}; the request came from ${origin || 'no Origin'}` };
  const now = Date.now();
  if (now - Date.parse(p.last_used + 'Z') > 60000) { p.last_used = new Date(now).toISOString().slice(0, 19); try { save(dataRoot, d); } catch (e) { /* a read-only folder: fine */ } }
  return { ok: true, pairing: { id: p.id, origin: p.origin, scope: p.scope } };
}
// the Origins that hold a pairing (CORS preflights cannot carry the token: they are answered for these only)
export const pairedOrigins = (dataRoot) => new Set(load(dataRoot).pairings.map(p => p.origin));
export const list = (dataRoot) => { const d = load(dataRoot), now = Date.now(); return { pairings: d.pairings.map(({ hash: _h, ...p }) => p), pending_codes: d.codes.filter(c => c.expires > now).map(c => ({ origin: c.origin, scope: c.scope, expires: new Date(c.expires).toISOString().slice(0, 19) })) }; };
export function revoke(dataRoot, id) {
  const d = load(dataRoot), n = d.pairings.length;
  d.pairings = d.pairings.filter(p => p.id !== id);
  if (d.pairings.length === n) { const e = new Error(`no pairing ${id}`); e.code = 404; throw e; }
  save(dataRoot, d); return { revoked: id };
}
