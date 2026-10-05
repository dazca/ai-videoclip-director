#!/usr/bin/env node
// Security regressions for G5 (the project as a zip) and G6's staged song upload (ROADMAP_v4; lib/ops/projectio.mjs, lib/zip.mjs):
//   - zip-slip: an entry named "../x", "a/../../x", "/abs", "C:/x", "C:x", "a\..\x", with NUL / ":" / a control character, a dot-folder
//     (.history/, .git/), a reserved device name (CON.json, nul), an 8.3 short name (x~1), a trailing dot: the whole zip is refused (400)
//     and nothing is written anywhere (no new project, no file outside); a symlink entry, overlapping entries, a local name that differs
//     from the central one: refused
//   - size caps: a zip over IMPORT_MAX (the upload's declared size and the file), an entry over ENTRY_MAX, a total over IMPORT_MAX, a
//     deflate stream bigger than its declared size: 413 / 400
//   - checksums: a file whose sha256 or size differs from the manifest, a file not in the manifest, a manifest file missing, no
//     manifest / another format: 400
//   - ids: a bad entity file name, an entity index path elsewhere, a request id with markup: 400
//   - private media is excluded by default and every JSON scrubbed; an agent cannot opt it in (403 over HTTP, claiming via "page",
//     the page token alone, the Origin alone, offline); the page can (private/exports/, served to localhost only)
//   - an import is always a NEW project (409 over an existing id) and the director's decisions do not travel: approvals -> review,
//     requests -> draft with "allow uploading private refs" taken back, looks / variants -> review, approved tree nodes unset, scenes ok ->
//     needs_you, stages done -> in_progress, the render lock and command dropped, the same in imported snapshots; costs kept
//   - project_upload is page only (403 to the agent token, the page token alone, a claimed via "page"); its first chunk must sniff as a
//     zip / an audio file (415); declared size caps (413); offsets (409)
// Scratch data folder; never touches data/.   node tools/security-projectzip.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = 'zsec', TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sec-zip-')), DATA = path.join(TMP, 'data'), D = path.join(DATA, P);
fs.cpSync(path.join(WB, 'data', 'demo'), D, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: [] }));
Object.assign(process.env, { WORKBENCH_DATA: DATA, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P, WB_TEST: '1', WB_IMPORT_MAX: String(3 * 1048576), WB_IMPORT_ENTRY_MAX: String(1048576) });
for (const k of ['WB_TOKEN', 'WB_HOST', 'WB_ALLOW_REMOTE_OPS', 'WB_AGENT_TOKEN']) delete process.env[k];
const S = await import('../lib/store.mjs');
const Z = await import('../lib/zip.mjs');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const projects = () => fs.readdirSync(DATA).filter(x => !x.startsWith('.')).sort().join(',');
const tryOp = (fn) => { try { const r = fn(); return { ok: true, r }; } catch (e) { return { ok: false, code: e.code, error: e.message }; } };
// a zip with the given entries ({name, data, deflate?, manifest?: false}); the manifest is built from them unless `manifest` is given
let zn = 0;
function craft(entries, { manifest, mutate } = {}) {
  const f = path.join(D, 'exports', `craft-${++zn}.zip`); fs.mkdirSync(path.dirname(f), { recursive: true });
  const w = new Z.ZipWriter(f);
  for (const e of entries) w.add(e.name, Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), { deflate: !!e.deflate });
  const m = manifest !== undefined ? manifest : { format: S.ZIP_FORMAT, v: 1, project: 'crafted', title: 'crafted', files: entries.filter(e => e.listed !== false).map(e => { const b = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data); return { path: e.name, size: b.length, sha256: sha(b) }; }) };
  if (m !== null) w.add(S.ZIP_MANIFEST, Buffer.from(JSON.stringify(m)));
  w.finish();
  if (mutate) { const b = fs.readFileSync(f); mutate(b); fs.writeFileSync(f, b); }
  return `data/${P}/exports/${path.basename(f)}`;
}
const base = () => [{ name: 'song.json', data: fs.readFileSync(path.join(D, 'song.json')) }, { name: 'project.json', data: '{"title":"crafted"}' }];
const imp = (rel, extra = {}) => tryOp(() => S.ops.project_import(P, { path: rel, ...extra }));

let srv = null;
try {
  // ---------------------------------------------------------------- 0. a good zip imports (the baseline every refusal below differs from)
  const good = imp(craft(base()));
  check('baseline: a crafted zip with a manifest imports as a new project', good.ok && good.r.id === 'crafted', good.error || good.r?.id);

  // ---------------------------------------------------------------- 1. zip-slip and unsafe names: the whole zip is refused, nothing written
  const before = projects(), outside = [path.join(TMP, 'evil.json'), path.join(DATA, 'evil.json'), path.join(D, 'evil.json'), path.join(TMP, 'x', 'evil.json')];
  const BAD = ['../evil.json', 'a/../../evil.json', '../../x/evil.json', '/evil.json', 'C:/evil.json', 'C:evil.json', 'a\\..\\evil.json', 'a/./evil.json', 'a//evil.json', 'evil\u0000.json',
    'x:stream.json', 'a/\u0007.json', '.history/config', 'x/.git/config', '.uploads/x.zip', 'CON.json', 'a/nul', 'aux.txt', 'SNAPSH~1/x.json', 'evil.json.', 'evil.json '];
  const res = BAD.map(nm => { const r = imp(craft([...base(), { name: nm, data: '{}' }])); return { nm, code: r.ok ? 200 : r.code, why: r.error?.slice(0, 60) }; });
  check('zip-slip: every unsafe entry name (.., absolute, drive, backslash, ".", empty segment, NUL, ":", control char, dot-folders, device names, 8.3, trailing dot / space) refuses the whole zip with 400',
    res.every(r => r.code === 400 && /unsafe path/.test(r.why || '')), res.filter(r => r.code !== 400 || !/unsafe/.test(r.why || '')));
  check('zip-slip: nothing was written (no new project, no file outside the data folder)', projects() === before && outside.every(f => !fs.existsSync(f)) && !fs.readdirSync(DATA).some(x => x.startsWith('_import-')), { before, after: projects() });
  // the same names in the MANIFEST only (the zip's entries clean): refused too
  const mOnly = imp(craft(base(), { manifest: { format: S.ZIP_FORMAT, v: 1, project: 'crafted2', files: [...base().map(e => ({ path: e.name, size: Buffer.from(e.data).length, sha256: sha(Buffer.from(e.data)) })), { path: '../evil.json', size: 2, sha256: sha(Buffer.from('{}')) }] } }));
  check('zip-slip in the manifest alone is refused (400)', !mOnly.ok && mOnly.code === 400, mOnly.error);
  // a symlink entry (unix mode 0120000 in the central directory's external attributes)
  const symRel = craft([...base(), { name: 'link.json', data: '../../../etc/passwd' }], { mutate: (b) => { const at = b.lastIndexOf(Buffer.from('link.json')); for (let i = b.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); i >= 0; i = b.indexOf(Buffer.from([0x50, 0x4b, 1, 2]), i + 4)) { const nl = b.readUInt16LE(i + 28); if (b.toString('utf8', i + 46, i + 46 + nl) === 'link.json') b.writeUInt32LE((0o120777 << 16) >>> 0, i + 38); } void at; } });
  const sym = imp(symRel);
  // overlapping entries: the second central record points at the first local header
  const ovRel = craft([...base(), { name: 'b.json', data: '{}' }], { mutate: (b) => { const recs = []; for (let i = b.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); i >= 0; i = b.indexOf(Buffer.from([0x50, 0x4b, 1, 2]), i + 4)) recs.push(i); b.writeUInt32LE(b.readUInt32LE(recs[0] + 42), recs[1] + 42); } });
  const ov = imp(ovRel);
  // a local header whose name differs from the central directory's (a parser-confusion slip)
  const lnRel = craft([...base(), { name: 'aaaaa.json', data: '{}' }], { mutate: (b) => { const i = b.indexOf(Buffer.from('aaaaa.json')); b.write('../a.json', i, 'latin1'); } });
  const ln = imp(lnRel);
  check('a symlink entry, overlapping entries and a local name that differs from the central directory are refused (400)',
    !sym.ok && sym.code === 400 && /symbolic/.test(sym.error) && !ov.ok && ov.code === 400 && !ln.ok && ln.code === 400, { sym: sym.error, ov: ov.error, ln: ln.error });

  // ---------------------------------------------------------------- 2. size caps
  const big = crypto.randomBytes(1048576 + 10);
  const e1 = imp(craft([...base(), { name: 'media/big.png', data: big }]));
  const parts = [0, 1, 2, 3].map(i => ({ name: `media/p${i}.json`, data: Buffer.alloc(900 * 1024, 32 + i), deflate: true }));   // 3.6 MB uncompressed in a small zip
  const e2 = imp(craft([...base(), ...parts]));
  // a deflate stream that inflates past its declared size (a bomb that lies): declared 100 bytes, inflates to 600 kB
  const zeros = Buffer.alloc(600 * 1024), bm = [...base(), { name: 'bomb.json', data: zeros, deflate: true }];
  const bombRel = craft(bm, { manifest: { format: S.ZIP_FORMAT, v: 1, project: 'bomb', files: bm.map(e => { const b = Buffer.from(e.data); return { path: e.name, size: e.name === 'bomb.json' ? 100 : b.length, sha256: sha(b) }; }) }, mutate: (b) => {
    for (let i = b.indexOf(Buffer.from([0x50, 0x4b, 3, 4])); i >= 0; i = b.indexOf(Buffer.from([0x50, 0x4b, 3, 4]), i + 4)) { const nl = b.readUInt16LE(i + 26); if (b.toString('utf8', i + 30, i + 30 + nl) === 'bomb.json') b.writeUInt32LE(100, i + 22); }
    for (let i = b.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); i >= 0; i = b.indexOf(Buffer.from([0x50, 0x4b, 1, 2]), i + 4)) { const nl = b.readUInt16LE(i + 28); if (b.toString('utf8', i + 46, i + 46 + nl) === 'bomb.json') b.writeUInt32LE(100, i + 24); } } });
  const e3 = imp(bombRel);
  const hugeF = path.join(D, 'exports', 'huge.zip'); fs.writeFileSync(hugeF, Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(3 * 1048576 + 10)]));
  const e4 = imp(`data/${P}/exports/huge.zip`);
  check('size caps: an entry over the per-file cap (413), a total over the import cap (413), a deflate stream bigger than declared (400), a zip file over the cap (413)',
    !e1.ok && e1.code === 413 && !e2.ok && e2.code === 413 && !e3.ok && e3.code === 400 && !e4.ok && e4.code === 413, { e1: e1.error, e2: e2.error, e3: e3.error, e4: e4.error });

  // ---------------------------------------------------------------- 3. the manifest's checksums
  const b0 = base();
  const m = (over) => ({ format: S.ZIP_FORMAT, v: 1, project: 'crafted3', files: b0.map(e => { const b = Buffer.from(e.data); return { path: e.name, size: b.length, sha256: sha(b), ...(over[e.name] || {}) }; }) });
  const c1 = imp(craft(b0, { manifest: m({ 'project.json': { sha256: 'a'.repeat(64) } }) }));
  const c2 = imp(craft(b0, { manifest: m({ 'project.json': { size: 3 } }) }));
  const c3 = imp(craft([...b0, { name: 'extra.json', data: '{}', listed: false }]));
  const c4 = imp(craft(b0, { manifest: { ...m({}), files: [...m({}).files, { path: 'missing.json', size: 2, sha256: sha(Buffer.from('{}')) }] } }));
  const c5 = imp(craft(b0, { manifest: null }));
  const c6 = imp(craft(b0, { manifest: { ...m({}), format: 'something-else' } }));
  // a byte flipped inside a stored file after the zip was made: its CRC (and its sha256) no longer match
  const flipRel = craft([...b0, { name: 'notes.json', data: '{"v":2,"rev":1,"notes":[],"legacy_seen":[]}' }], { mutate: (b) => { const i = b.indexOf(Buffer.from('"legacy_seen"')); b[i + 1] = 0x4c; } });
  const c7 = imp(flipRel);
  check('checksums: a sha256 that differs, a size that differs, a file not in the manifest, a manifest file missing, no manifest, another format, a byte changed after export: 400 each',
    [c1, c2, c3, c4, c5, c6, c7].every(c => !c.ok && c.code === 400) && /checksum mismatch/.test(c1.error) && /checksum mismatch/.test(c2.error) && /not in the manifest/.test(c3.error) && /not in the zip/.test(c4.error) && /CRC|checksum/.test(c7.error),
    [c1, c2, c3, c4, c5, c6, c7].map(c => c.error || 'IMPORTED'));
  check('a refused import leaves nothing behind', !fs.readdirSync(DATA).some(x => x.startsWith('_import-') || x.startsWith('crafted3')));

  // ---------------------------------------------------------------- 4. ids
  const i1 = imp(craft([...base(), { name: 'entities/characters/bad id.json', data: '{}' }]));
  const i2 = imp(craft([...base(), { name: 'entities/index.json', data: JSON.stringify([{ id: 'ada', kind: 'character', path: '../../evil.json' }]) }]));
  const i3 = imp(craft([...base(), { name: 'requests.json', data: JSON.stringify({ rev: 1, items: [{ id: '<img src=x onerror=alert(1)>', status: 'draft' }] }) }]));
  const i4 = imp(craft([...base(), { name: 'media.json', data: JSON.stringify({ items: [{ id: 'm1', path: '../../outside.png' }] }) }]));
  const i5 = imp(craft([...base(), { name: 'approvals.json', data: '{not json' }]));
  const i6 = imp(craft(base(), { manifest: { format: S.ZIP_FORMAT, v: 1, project: '../evil', files: base().map(e => ({ path: e.name, size: Buffer.from(e.data).length, sha256: sha(Buffer.from(e.data)) })) } }));
  const i7 = imp(craft(base()), { id: '../evil' });
  check('ids: a bad entity file id, an index path elsewhere, a request id with markup, a media path with "..", a JSON that does not parse, a bad project id in the manifest or given: 400 each',
    [i1, i2, i3, i4, i5, i6, i7].every(c => !c.ok && c.code === 400), [i1, i2, i3, i4, i5, i6, i7].map(c => c.error || 'IMPORTED'));
  // ---------------------------------------------------------------- 4b. review #3 M1: a versioned file arrives whole (current is one of its versions, ids unique)
  const m1 = imp(craft([...base(), { name: 'storyboard.json', data: JSON.stringify({ rev: 1, current: 'v2', versions: [{ id: 'v1', shots: [] }] }) }]));
  const m2 = imp(craft([...base(), { name: 'scenes.json', data: JSON.stringify({ rev: 1, current: 'v1', versions: [{ id: 'v1', scenes: [] }, { id: 'v1', scenes: [] }] }) }]));
  const m3 = imp(craft([...base(), { name: 'lyrics.json', data: JSON.stringify({ rev: 1, current: 'v1', versions: 'v1' }) }]));
  check('M1: a versioned file whose current is not one of its versions, with a version id twice, or versions not a list: 400 each, nothing imported',
    [m1, m2, m3].every(c => !c.ok && c.code === 400), [m1, m2, m3].map(c => c.error || 'IMPORTED'));

  // ---------------------------------------------------------------- 5. private media: out by default, scrubbed; only the page opts in
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  fs.mkdirSync(path.join(D, 'private', 'refs', 'ada'), { recursive: true }); fs.writeFileSync(path.join(D, 'private', 'refs', 'ada', 'face-secret.jpg'), png);
  fs.mkdirSync(path.join(D, 'media', 'still'), { recursive: true }); fs.writeFileSync(path.join(D, 'media', 'still', 'crop-flagged.png'), png);
  fs.mkdirSync(path.join(D, 'thumbs'), { recursive: true }); fs.writeFileSync(path.join(D, 'thumbs', 'priv_crop-flagged.jpg'), png);
  const MJ = JSON.parse(fs.readFileSync(path.join(D, 'media.json'), 'utf8'));
  MJ.items.push({ id: 'sec-face', path: 'private/refs/ada/face-secret.jpg', kind: 'ref', private: true }, { id: 'sec-crop', path: 'media/still/crop-flagged.png', kind: 'still', private: true, thumb: 'thumbs/priv_crop-flagged.jpg' });
  fs.writeFileSync(path.join(D, 'media.json'), JSON.stringify(MJ));
  const ada = JSON.parse(fs.readFileSync(path.join(D, 'entities/characters/ada.json'), 'utf8'));
  ada.base = { text: 'x', refs: [{ path: 'private/refs/ada/face-secret.jpg', source: 'photo', private: true }, { path: 'catalog/x.jpg', source: 'catalog' }] };
  fs.writeFileSync(path.join(D, 'entities/characters/ada.json'), JSON.stringify(ada));
  const ex = S.ops.project_export(P, {});
  const zz = Z.openZip(ex.abs), names = zz.entries.map(e => e.name), text = zz.entries.filter(e => e.name.endsWith('.json')).map(e => zz.read(e).toString('utf8')).join('\n'); zz.close();
  check('private media is excluded by default: no private/ file, no file flagged private, no priv_ thumbnail, and no JSON names them (scrubbed); the public ref stays',
    ex.private_excluded >= 3 && !names.some(x => /face-secret|crop-flagged|^private\/|priv_/.test(x)) && !/face-secret|crop-flagged|priv_crop/.test(text) && /catalog\/x\.jpg/.test(text), { names: names.filter(x => /secret|flagged|priv/.test(x)), excluded: ex.private_excluded });
  const agentOff = tryOp(() => S.ops.project_export(P, { include_private: true })), agentVia = tryOp(() => S.ops.project_export(P, { include_private: true, via: 'agent' }));
  check('offline / the agent surface: include_private is 403', !agentOff.ok && agentOff.code === 403 && !agentVia.ok && agentVia.code === 403);

  // over HTTP: the page-only rules (S9)
  const port = await freePort(), BASE = `http://localhost:${port}`;
  srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: process.env });
  srv.stderr.on('data', d => process.stderr.write('server: ' + d));
  await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
  const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
  const AGENT = fs.readFileSync(path.join(DATA, '.wb-agent-token'), 'utf8').trim();
  const H = { page: { 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'same-origin' }, tokenOnly: { 'x-wb-token': TOKEN }, agent: { 'x-wb-agent-token': AGENT },
    originOnly: { 'x-wb-token': TOKEN, origin: BASE }, agentForged: { 'x-wb-agent-token': AGENT, 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'same-origin' } };
  const op = async (name, body, h) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const NOT = ['tokenOnly', 'agent', 'originOnly', 'agentForged'];
  const xp = {}; for (const k of NOT) xp[k] = (await op('project_export', { include_private: true, via: 'page' }, H[k])).status;
  const pg = await op('project_export', { include_private: true }, H.page);
  const pz = pg.status === 200 ? Z.openZip(path.join(D, pg.body.path)) : null, pzn = pz ? pz.entries.map(e => e.name) : []; pz?.close();
  const remote = await fetch(`${BASE}/data/${P}/${pg.body?.path}`);   // localhost: served (the director's download)
  check('an agent cannot opt private media in over HTTP (403 to the page token alone, the agent token, the Origin alone, a forged Origin with the agent token, all claiming via "page"); the page\'s personal backup holds them in private/exports/',
    NOT.every(k => xp[k] === 403) && pg.status === 200 && /^private\/exports\//.test(pg.body.path) && pzn.includes('private/refs/ada/face-secret.jpg') && pzn.includes('media/still/crop-flagged.png') && remote.status === 200,
    { xp, pg: pg.status, path: pg.body?.path });
  const ap = await op('project_import', { path: `data/${P}/${pg.body?.path}`, dry_run: true }, H.agent);
  check('a personal backup (a private path) is not an agent\'s to import (403)', ap.status === 403, ap.body);

  // project_upload: page only, sniffed, capped
  const up = {}; for (const k of NOT) up[k] = (await op('project_upload', { upload: 'secupload01', kind: 'zip', name: 'a.zip', size: 4, offset: 0, data: Buffer.from('PK\x03\x04').toString('base64'), done: true, via: 'page' }, H[k])).status;
  const notZip = await op('project_upload', { upload: 'secupload02', kind: 'zip', name: 'a.zip', size: 4, offset: 0, data: Buffer.from('<htm').toString('base64'), done: true }, H.page);
  const notAudio = await op('project_upload', { upload: 'secupload03', kind: 'song', name: 'a.mp3', size: 16, offset: 0, data: Buffer.from('#!/bin/sh echo x').toString('base64'), done: true }, H.page);
  const tooBig = await op('project_upload', { upload: 'secupload04', kind: 'zip', name: 'a.zip', size: 4 * 1048576, offset: 0, data: Buffer.from('PK\x03\x04').toString('base64') }, H.page);
  const badKind = await op('project_upload', { upload: 'secupload05', kind: '../x', name: 'a', size: 4, offset: 0, data: 'UEsDBA==' }, H.page);
  const badId = await op('project_upload', { upload: '../../x', kind: 'zip', name: 'a', size: 4, offset: 0, data: 'UEsDBA==' }, H.page);
  const st1 = await op('project_upload', { upload: 'secupload06', kind: 'zip', name: 'a.zip', size: 8, offset: 0, data: Buffer.from('PK\x03\x04').toString('base64') }, H.page);
  const skip = await op('project_upload', { upload: 'secupload06', kind: 'zip', name: 'a.zip', size: 8, offset: 2, data: Buffer.from('abcd').toString('base64') }, H.page);
  const upImp = await op('project_import', { upload: 'secupload06' }, H.agent);
  check('project_upload is page only (403 to the page token alone, the agent token, the Origin alone, a forged Origin with the agent token); not a zip / not audio 415; over the cap 413; a bad kind / id 400; a wrong offset 409; an agent cannot import an upload (403)',
    NOT.every(k => up[k] === 403) && notZip.status === 415 && notAudio.status === 415 && tooBig.status === 413 && badKind.status === 400 && badId.status === 400 && st1.status === 200 && skip.status === 409 && upImp.status === 403,
    { up, notZip: notZip.status, notAudio: notAudio.status, tooBig: tooBig.status, badKind: badKind.status, badId: badId.status, skip: skip.status, upImp: upImp.status });
  const song = await fetch(`${BASE}/api/projects/new?project=${P}`, { method: 'POST', headers: { 'content-type': 'application/json', ...H.agent }, body: JSON.stringify({ id: 'agent-song', song_upload: 'secupload06', via: 'page' }) });
  check('a new project from an uploaded song is the page\'s (403 to the agent)', song.status === 403 && !fs.existsSync(path.join(DATA, 'agent-song')), song.status);
  const dot = await fetch(`${BASE}/data/.uploads/secupload06.zip.part`);
  check('the staging folder is never served', dot.status >= 400, dot.status);

  // ---------------------------------------------------------------- 6. the director's decisions do not travel; never over an existing project
  const W = (f, fn) => { const p = path.join(D, f), d = JSON.parse(fs.readFileSync(p, 'utf8')); fn(d); fs.writeFileSync(p, JSON.stringify(d)); };
  W('requests.json', (d) => { d.items.push({ id: 'rq-ok', status: 'approved', private_upload_ok: true, prompt: 'x', log: [{ at: '2026-10-05T10:00:00', by: 'director', via: 'page', status: 'approved' }, { at: '2026-10-05T10:00:01', by: 'director', via: 'page', private_upload: true }] }, { id: 'rq-done', status: 'done', actual_cost_usd: 0.12 }); d.batches = [{ id: 'b01', status: 'approved', request_ids: ['rq-ok'] }]; });
  W('entities/characters/ada.json', (e) => { e.looks = [{ id: 'l1', status: 'approved' }]; e.iter = { nodes: [], trees: { identity: { head: 'n01', approved: 'n01', approved_at: 'x', approved_by: 'director' } } }; });
  fs.writeFileSync(path.join(D, 'scenes.json'), JSON.stringify({ rev: 1, current: 'v1', versions: [], states: { sc01: { status: 'ok', by: 'director', via: 'page' } } }));
  fs.writeFileSync(path.join(D, 'stages.json'), JSON.stringify({ rev: 1, stages: [{ id: 'lyrics', status: 'done', done_by: 'director', blockers: [] }] }));
  fs.writeFileSync(path.join(D, 'revisions.json'), JSON.stringify({ v: 1, rev: 1, rounds: [], revisions: [], lock: { at: 'x', revision: 'R1', by: 'director', via: 'page' }, locks: [] }));
  fs.writeFileSync(path.join(D, 'renders.json'), JSON.stringify({ v: 1, rev: 1, config: { command: ['node', '-e', 'x'] }, sheets: [] }));
  W('costs.json', (c) => { c.items = [...(c.items || []), { id: 'rq-done', usd: 0.12, via: 'runner' }]; });
  S.snapshot(P, 'before export');
  const ex2 = S.ops.project_export(P, { snapshots: true });
  const r6 = imp(`data/${P}/${ex2.path}`), ID = r6.r?.id, IJ = (f) => JSON.parse(fs.readFileSync(path.join(DATA, ID, f), 'utf8'));
  const A = IJ('approvals.json'), R = IJ('requests.json'), E = IJ('entities/characters/ada.json'), SC = IJ('scenes.json'), ST = IJ('stages.json'), RV = IJ('revisions.json'), RN = IJ('renders.json'), C = IJ('costs.json');
  const snapDir = path.join(DATA, ID, '.snapshots'), snap = fs.existsSync(snapDir) ? fs.readdirSync(snapDir)[0] : null, SA = snap ? JSON.parse(fs.readFileSync(path.join(snapDir, snap, 'approvals.json'), 'utf8')) : null;
  const rq = R.items.find(x => x.id === 'rq-ok');
  check('imported approvals are demoted: approvals -> review, requests -> draft (old status kept, "allow uploading private refs" taken back: privateUploadOk false, approvalOk false), batches -> draft, looks -> review, the approved identity node unset, scenes ok -> needs_you, stages done -> in_progress, the lock and the render command dropped; the same inside imported snapshots; costs kept',
    r6.ok && !Object.values(A.items).some(x => ['approved', 'locked'].includes(x.state)) && R.items.every(x => x.status === 'draft') && rq.imported.status === 'approved' && !rq.private_upload_ok && !S.privateUploadOk(rq) && !S.approvalOk(rq)
    && R.batches[0].status === 'draft' && E.looks[0].status === 'review' && !E.iter.trees.identity.approved && E.iter.trees.identity.imported_approved === 'n01' && SC.states.sc01.status === 'needs_you' && ST.stages[0].status === 'in_progress'
    && RV.lock === null && RN.config === null && SA && !Object.values(SA.items).some(x => x.state === 'approved') && C.items.some(x => x.id === 'rq-done' && x.usd === 0.12) && C.imported,
    { r6: r6.error || r6.r?.demoted, snap: !!SA });
  const vOf = (dir, f) => { try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return j.versions ? `${j.current}:${j.versions.map(v => v.id).join(',')}` : null; } catch (e) { return null; } };
  const vers = ['lyrics.json', 'scenes.json', 'breakdown.json', 'storyboard.json'].map(f => [f, vOf(D, f), vOf(path.join(DATA, ID), f)]);
  check('M1: an export / import keeps every version of the versioned files and their current (nothing dropped, nothing moved back)', r6.ok && vers.every(([, a, b]) => a === b), vers);
  const ow = imp(`data/${P}/${ex2.path}`, { id: P }), ow2 = imp(`data/${P}/${ex2.path}`, { id: ID });
  check('an import never goes over an existing project (409), even the one it came from', !ow.ok && ow.code === 409 && !ow2.ok && ow2.code === 409, [ow.error, ow2.error]);
  const lockedImport = (() => { fs.writeFileSync(path.join(D, 'revisions.json'), JSON.stringify({ v: 1, rev: 2, rounds: [], revisions: [], lock: { at: 'x', revision: 'R1' }, locks: [] })); return tryOp(() => S.lockGate(P, 'project_export')); })();
  check('a project locked for render still exports (the export writes only exports/<zip>)', lockedImport.ok, lockedImport.error);
} catch (e) { check('ran to the end', false, String(e.stack || e)); }
finally {
  srv?.kill(); await wait(300);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
console.log(`\nsecurity-projectzip: ${n - failed}/${n} checks passed`);
process.exit(failed ? 1 : 0);
