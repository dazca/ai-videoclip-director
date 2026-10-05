#!/usr/bin/env node
// Security regressions for review #3 (workbench-review/REVIEW_2026-10-05c.md), one check (or more) per finding:
//   M1  an agent's raw save of storyboard.json (and scenes.json / lyrics.json / breakdown.json) can only APPEND a version:
//       `current` never goes back to an older one, a version left out comes back, the director's surfaces, picks and
//       anchors carry forward (the review's repro R1: a page surface, an agent save with current: "v1", the agent's next
//       shots_update)
//   M2  a re-time never moves an approved / locked shot (or a neighbour that shares its cut, or a shot whose picked take
//       gets too short) silently: retime_apply / retime_undo answer 409 + `held` until the page confirms each one; a moved
//       approved shot goes back to review with a note (repro R2)
//   L1  a project locked for render refuses the director's own re-time (and its undo) too: unlock first (repro R3)
//   L2  on a locked project an agent cannot rewrite exports/composition/edl.json (another file inside exports/ is fine); its
//       file map is the director's: an agent's export of that file with another map is 403, and an agent's save of
//       settings.json keeps the server's `composition` (repro r6)
//   L3  an agent never signs as the director: event_add / retime_propose / surface_propose / look_world_propose /
//       chapters_update / intake_answer with by "director" store "agent" (HTTP and the MCP offline path) (repro R4)
//   I5  event_add stops at 2000 events; /api/status gives data_dir to this machine only (checked in process)
//   walk blockers: "Make public…" (media_publish) is page only, needs confirm, only for the director's own private upload,
//       moves the file out of private/ and the refs follow; an agent still cannot lower a privacy; results dropped in the
//       Queue (handoff_upload) are page only, images only, into the request's results/; a media root named like a project
//       folder ("media/") is ignored (uploads land and are served from the project)
// Scratch copy of data/demo, its own server on a free port; never touches data/.   node tools/security-review3.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = 'rv3', TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sec-rv3-')), DATA = path.join(TMP, 'data'), D = path.join(DATA, P), MB = path.join(TMP, 'mediabase');
fs.cpSync(path.join(WB, 'data', 'demo'), D, { recursive: true, filter: (f) => !f.includes(`${path.sep}.snapshots`) });
fs.cpSync(path.join(WB, 'data', '_template'), path.join(DATA, '_template'), { recursive: true });
fs.mkdirSync(path.join(MB, 'media'), { recursive: true }); fs.mkdirSync(path.join(MB, 'roots'), { recursive: true });
// a media root named like a project folder (media/) next to an ordinary one (roots/): the walk's blocker 6
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ media_roots: ['media/', 'roots/'] }));
Object.assign(process.env, { WORKBENCH_DATA: DATA, WORKBENCH_MEDIA_BASE: MB, WORKBENCH_CONFIG: path.join(TMP, 'config.json'), WB_PROJECT: P });
for (const k of ['WB_TOKEN', 'WB_HOST', 'WB_ALLOW_REMOTE_OPS', 'WB_AGENT_TOKEN', 'FAL_KEY']) delete process.env[k];
const S = await import('../lib/store.mjs');
const { tinyPngB64 } = await import('./tiny-png.mjs');

let failed = 0, n = 0;
const check = (name, ok, detail) => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 500) : ''}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rj = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
let srv = null;
try {
  const port = await freePort(), BASE = `http://localhost:${port}`;
  srv = spawn(process.execPath, [path.join(WB, 'serve.mjs'), String(port)], { stdio: 'pipe', env: process.env });
  let log = ''; srv.stderr.on('data', d => { log += d; }); srv.stdout.on('data', d => { log += d; });
  await new Promise((ok, bad) => { srv.stdout.once('data', ok); srv.once('exit', (c) => bad(new Error('server exited ' + c))); });
  const TOKEN = /<meta name="wb-token" content="([^"]+)">/.exec(await (await fetch(`${BASE}/?project=${P}`)).text())?.[1];
  const AGENT = fs.readFileSync(path.join(DATA, '.wb-agent-token'), 'utf8').trim();
  const H = (page) => ({ 'content-type': 'application/json', ...(page ? { 'x-wb-token': TOKEN, origin: BASE, 'sec-fetch-site': 'same-origin' } : { 'x-wb-agent-token': AGENT }) });
  const op = async (name, body, page = false) => { const r = await fetch(`${BASE}/api/op/${name}?project=${P}`, { method: 'POST', headers: H(page), body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const save = async (file, fn, page = false) => {
    const cur = await (await fetch(`${BASE}/data/${P}/${file}`)).json(); const d = structuredClone(cur ?? {}); fn(d);
    const r = await fetch(`${BASE}/api/save/${file}?project=${P}`, { method: 'POST', headers: H(page), body: JSON.stringify({ base_rev: cur?.rev || 0, data: d }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const board = () => S.boardDoc(P), shotNow = (id) => S.ops.storyboard_get ? null : null;
  const cur = (d) => d.versions.find(v => v.id === d.current);

  // ------------------------------------------------------------------ M1: `current` only moves to a version a save adds
  const sf = await op('surface_act', { act: 'add', shot: 's2-wall', line: 'verse/0', where: 'chat: Notepad' }, true);
  const b1 = board(), vSurf = b1.current, v1 = b1.versions[0].id;
  const back = await save('storyboard.json', (d) => { d.current = v1; }, false);
  const b2 = board();
  const up = await op('shots_update', { upsert: [{ id: 's3-grid', title: 'agent title' }] });
  const b3 = board(), s2 = cur(b3).shots.find(s => s.id === 's2-wall');
  check('M1 (R1): an agent\'s raw save of storyboard.json with current: "v1" leaves current where it was; the agent\'s next shots_update builds on it, so the director\'s lyric surface stays',
    sf.status === 200 && back.status === 200 && b2.current === vSurf && up.status === 200 && b3.current !== v1 && s2?.lyrics?.[0]?.line === 'verse/0',
    { sf: sf.status, back: back.status, current: [vSurf, b2.current, b3.current], s2: s2?.lyrics });
  const drop = await save('storyboard.json', (d) => { d.versions = d.versions.slice(-1); }, false);
  const add = await save('storyboard.json', (d) => { const v = structuredClone(cur(d)); v.id = 'v90'; v.n = 90; v.shots = v.shots.map(s => { const { lyrics: _l, clip: _c, ...r } = s; return r; }); d.versions.push(v); d.current = v1; }, false);
  const b4 = board(), s2b = cur(b4).shots.find(s => s.id === 's2-wall');
  check('M1: an agent save that leaves versions out gets them back (every version stays); one that adds a version and points current at an old one makes the added version current, with the director\'s surfaces carried in',
    drop.status === 200 && b4.versions.length >= b3.versions.length + 1 && add.status === 200 && b4.current === 'v90' && s2b?.lyrics?.[0]?.line === 'verse/0',
    { versions: b4.versions.map(v => v.id), current: b4.current, s2: s2b?.lyrics });
  // anchors: the director's anchored edge survives an agent save that drops it
  const ev = await op('events_act', { act: 'add', id: 'cut_one', name: 'cut one', t: 4000, kind: 'cue' }, true);
  const anc = await op('shots_update', { upsert: [{ id: 's1-intro', anchors: { t1: 'cut_one' } }] });
  const strip = await save('storyboard.json', (d) => { const v = structuredClone(cur(d)); v.id = 'v95'; v.n = 95; v.shots = v.shots.map(s => { const { anchors: _a, ...r } = s; return r; }); d.versions.push(v); d.current = 'v95'; }, false);
  const s1a = cur(board()).shots.find(s => s.id === 's1-intro');
  check('M1: an agent\'s raw save never drops an anchored boundary (the anchor and its time carry into the agent\'s new version)', ev.status === 200 && anc.status === 200 && strip.status === 200 && s1a?.anchors?.t1 === 'cut_one' && s1a.t1 === 4000, { ev: ev.status, anc: anc.body?.error, strip: [strip.status, strip.body], s1a: s1a && { t1: s1a.t1, anchors: s1a.anchors } });
  // the same rule on scenes.json and lyrics.json
  const sc0 = S.scenesDoc(P), lyFirst = S.lyricsDoc(P);
  await op('scenes_update', { upsert: [{ id: sc0.versions.length ? (cur(sc0)?.scenes[0]?.id) : 'sc01', title: 'agent v2' }] }).catch(() => null);
  const sc1 = S.scenesDoc(P), scBack = sc1.versions.length > 1 ? await save('scenes.json', (d) => { d.current = d.versions[0].id; }) : { status: 'skip' };
  const lyUp = await op('lyrics_update', { text: '[Verse]\nline one\nline two' });
  const ly1 = S.lyricsDoc(P), lyBack = await save('lyrics.json', (d) => { d.current = d.versions[0].id; });
  check('M1: the same on scenes.json and lyrics.json: an agent save never moves current back to an older version',
    (scBack.status === 'skip' || (scBack.status === 200 && S.scenesDoc(P).current === sc1.current)) && lyUp.status === 200 && lyBack.status === 200 && S.lyricsDoc(P).current === ly1.current && ly1.current !== lyFirst.versions?.[0]?.id,
    { sc: [sc1.current, S.scenesDoc(P).current, scBack.status], ly: [ly1.current, S.lyricsDoc(P).current, lyBack.status] });

  // ------------------------------------------------------------------ M2: re-time vs approvals (s1-intro is approved in the demo)
  const ap0 = rj('approvals.json').items['shot:s1-intro']?.state;
  const meas = await op('events_act', { act: 'measure', id: 'cut_one', measured: 4400 }, true);
  const plan = await op('events_get', {});
  const noConf = await op('retime_apply', { from_measured: true }, true);
  const held = noConf.body?.held || [];
  const sbV = board().current;
  const partConf = await op('retime_apply', { from_measured: true, confirm: ['shot:s1-intro'] }, true);
  check('M2 (R2): the plan flags the approved shot and the neighbours that share its cut; retime_apply without the page\'s confirm is 409 with the list (nothing moves), a partial confirm too',
    ap0 === 'approved' && meas.status === 200 && (plan.body?.pending?.held || []).some(h => h.key === 'shot:s1-intro' && h.reasons.includes('approved'))
    && noConf.status === 409 && held.some(h => h.key === 'shot:s1-intro') && held.some(h => h.reasons.includes('shared')) && board().current === sbV && partConf.status === 409,
    { ap0, noConf: [noConf.status, noConf.body?.error?.slice(0, 120)], held: held.map(h => `${h.key}:${h.reasons}`), part: partConf.status });
  const all = await op('retime_apply', { from_measured: true, confirm: held.map(h => h.key) }, true);
  const ap1 = rj('approvals.json').items['shot:s1-intro'], notes1 = S.notesDoc(P).notes.filter(x => x.target?.kind === 'shot' && x.target.id === 's1-intro' && /re-time/.test(x.text));
  const s1m = cur(board()).shots.find(s => s.id === 's1-intro');
  check('M2: with every held item confirmed it applies; the moved approved shot goes back to review (approvals.json, a comment) with a note on the shot saying why',
    all.status === 200 && s1m?.t1 === 4400 && ap1?.state === 'review' && /re-time/.test(ap1.comment || '') && notes1.length === 1 && (all.body?.back_to_review || []).includes('shot:s1-intro'),
    { all: [all.status, all.body?.error], ap1, notes: notes1.length, t1: s1m?.t1 });
  // the agent's proposal is flagged the same way (held in its record), and the agent never applies
  const prop = await op('retime_propose', { moves: [{ event: 'cut_one', to: 4600 }], why: 'x' });
  const agentApply = await op('retime_apply', { retime: prop.body?.retime, confirm: ['shot:s2-wall'] });
  check('M2: an agent\'s retime_propose carries the plan\'s held list; applying it stays the page\'s (403)', prop.status === 200 && Array.isArray(prop.body?.plan?.held) && agentApply.status === 403, { prop: prop.status, held: prop.body?.plan?.held?.length, agentApply: agentApply.status });

  // ------------------------------------------------------------------ L1: the lock stops the director's re-time too
  const rv = { v: 1, rev: 1, rounds: [], revisions: [], restores: [], lock: { at: '2026-10-05T12:00:00', revision: 'R1', snapshot: 'x', summary: 'locked', by: 'director', via: 'page', ready: true, pending: 0 }, locks: [] };
  fs.writeFileSync(path.join(D, 'revisions.json'), JSON.stringify(rv));
  const lk1 = await op('retime_apply', { retime: prop.body?.retime, confirm: ['shot:s1-intro', 'shot:s2-wall', 'scene:sc01', 'scene:sc02'] }, true);
  const lk2 = await op('retime_undo', { retime: all.body?.retime }, true);
  check('L1 (R3): on a project locked for render the page\'s re-time and its undo are refused (409 "unlock it first"); nothing moves', lk1.status === 409 && /unlock/i.test(lk1.body?.error || '') && lk2.status === 409 && /unlock/i.test(lk2.body?.error || ''), { lk1: lk1.body?.error?.slice(0, 100), lk2: lk2.status });

  // ------------------------------------------------------------------ L2: edl.json and its map on a locked project
  const exAgent = await op('composition_export', { map: [{ from: '', to: 'nothing/' }] });
  const exOther = await op('composition_export', { out: 'agent/edl.json', map: [{ from: '', to: 'x/' }] });
  const exPage = await op('composition_export', {}, true);
  check('L2 (r6): locked: an agent\'s composition_export of exports/composition/edl.json is 409 (another file inside exports/ is fine); the director\'s export works',
    exAgent.status === 409 && exOther.status === 200 && fs.existsSync(path.join(D, 'exports', 'agent', 'edl.json')) && exPage.status === 200, { exAgent: exAgent.status, exOther: exOther.status, exPage: exPage.status });
  fs.writeFileSync(path.join(D, 'revisions.json'), JSON.stringify({ ...rv, lock: null }));
  const remember = await save('settings.json', (d) => { d.composition = { map: [{ from: 'media/clip/', to: 'assets/world/' }, { from: '', to: 'assets/' }], out: 'composition/edl.json' }; }, true);
  const mapAgent = await op('composition_export', { map: [{ from: '', to: 'elsewhere/' }] }), sameAgent = await op('composition_export', {});
  const forge = await save('settings.json', (d) => { d.composition = { map: [{ from: '', to: 'evil/' }] }; d.lyric_gate = true; }, false);
  const st = rj('settings.json');
  check('L2: unlocked, the remembered map is the director\'s: an agent\'s export of that file with another map is 403, without a map it uses theirs; an agent\'s save of settings.json keeps the server\'s composition (the rest of its edit stands)',
    remember.status === 200 && mapAgent.status === 403 && sameAgent.status === 200 && JSON.stringify(sameAgent.body?.map) === JSON.stringify(st.composition.map) && forge.status === 200 && st.composition.map[0].to === 'assets/world/' && st.lyric_gate === true,
    { remember: remember.status, mapAgent: mapAgent.status, same: sameAgent.status, comp: st.composition });

  // ------------------------------------------------------------------ L3: never "director" from an agent
  const e1 = await op('event_add', { name: 'signed', t: 9000, kind: 'cue', by: 'director' });
  const e2 = await op('event_add', { name: 'signed page', t: 9100, kind: 'cue', by: 'Director (page)', via: 'page' });
  const rp = await op('retime_propose', { moves: [{ event: 'cut_one', to: 4500 }], why: 'y', by: 'director' });
  const lf = (() => { const L = rj('song.json').lines || []; for (const s of cur(board()).shots) { const l = L.find(x => x.t0 >= s.t0 && x.t0 < s.t1 && x.t1 <= s.t1); if (l) return { shot: s.id, line: l.id }; } return { shot: 's3-grid', line: 'verse/1' }; })();
  const sp = await op('surface_propose', { ...lf, where: 'window', why: 'z', by: 'director' });
  const ch = await op('chapters_update', { upsert: [{ name: 'Ch', scenes: [] }], by: 'director' });
  const ia = await op('intake_answer', { answers: { mood: 'agent typed' }, by: 'director' });
  const evs = S.ops.events_get(P, {}).events, rts = S.ops.events_get(P, {}).retimes;
  const off = S.agentArgs({ by: 'the director', via: 'page' });
  const sfx = fs.existsSync(path.join(D, 'surfaces.json')) ? JSON.parse(fs.readFileSync(path.join(D, 'surfaces.json'), 'utf8')).proposals.find(x => x.why === 'z') : null;
  const chx = (board().chapters || []).find(c => c.name === 'Ch'), ix = S.scenesDoc(P).intake.mood;
  check('L3 (R4): an agent never signs as the director: event_add, retime_propose, surface_propose, chapters_update and intake_answer with by "director" store "agent" (via agent); the MCP offline path does the same',
    e1.status === 200 && e2.status === 200 && rp.status === 200 && sp.status === 200 && ch.status === 200 && ia.status === 200
    && evs.filter(e => /^signed/.test(e.name)).every(e => e.by === 'agent' && e.via === 'agent') && rts.find(r => r.id === rp.body.retime)?.by === 'agent'
    && sfx?.by === 'agent' && chx?.by === 'agent' && ix?.by !== 'director' && ix?.via === 'agent' && off.by === 'agent' && off.via === 'agent',
    { e: evs.filter(e => /^signed/.test(e.name)).map(e => `${e.by}/${e.via}`), rt: rts.find(r => r.id === rp.body?.retime)?.by, sp: sfx?.by, ch: chx?.by, ia: ix && `${ix.by}/${ix.via}`, off });

  // ------------------------------------------------------------------ I5: event cap, data_dir local only
  const ed = JSON.parse(fs.readFileSync(path.join(D, 'events.json'), 'utf8'));
  ed.events = Array.from({ length: 2000 }, (_, i) => ({ id: `e${i}`, name: `e${i}`, t: i, kind: 'cue', status: 'accepted' })); ed.rev = (ed.rev || 0) + 1;
  fs.writeFileSync(path.join(D, 'events.json'), JSON.stringify(ed));
  const capd = await op('event_add', { name: 'one more', t: 5000, kind: 'cue' });
  const stat = await (await fetch(`${BASE}/api/status`)).json();
  check('I5: event_add stops at 2000 events (409); /api/status still gives data_dir to this machine (only)', capd.status === 409 && typeof stat.data_dir === 'string', { capd: capd.status, data_dir: !!stat.data_dir });

  // ------------------------------------------------------------------ walk blocker 6: media root "media/" ignored
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  const upId = 'rv3up0001', b64 = tinyPngB64(), size = Buffer.from(b64, 'base64').length;
  const upl = await op('media_upload', { upload: upId, name: 'my photo.png', size, offset: 0, data: b64, done: true, kind: 'still', private: true }, true);
  const pub0 = await op('media_upload', { upload: 'rv3up0002', name: 'public one.png', size, offset: 0, data: b64, done: true, kind: 'still' }, true);
  const served = pub0.body?.media ? await fetch(`${BASE}/data/${P}/${pub0.body.media.path}`) : null;
  check('walk 6: a media root named like a project folder ("media/") is ignored (said at start and in /api/config); a public upload lands in the project\'s media/still/ and is served from the project',
    JSON.stringify(cfg.media_roots) === '["roots/"]' && JSON.stringify(cfg.media_roots_ignored) === '["media/"]' && /media root\(s\) media\/ ignored/.test(log)
    && pub0.status === 200 && /^media\/still\//.test(pub0.body.media.path) && fs.existsSync(path.join(D, pub0.body.media.path)) && served?.status === 200,
    { cfg, pub: pub0.body?.media?.path || pub0.body, served: served?.status });

  // ------------------------------------------------------------------ walk blocker 2: Make public
  const pm = upl.body?.media;
  const rq = await op('request_create', { kind: 'still', prompt: 'p', refs: [pm?.path], est_cost: 0.12, tool: 'fal-ai/nano-banana-2/edit' });
  const lower = await op('media_update', { id: pm?.id, private: false });
  const agentPub = await op('media_publish', { media: pm?.id, confirm: true });
  const noConfirm = await op('media_publish', { media: pm?.id }, true);
  const notMine = await op('media_publish', { media: 'C1_0', confirm: true }, true);
  const pub = await op('media_publish', { media: pm?.id, confirm: true }, true);
  const mNow = (rj('media.json').items || []).find(x => x.id === pm?.id), rqNow = rj('requests.json').items.find(x => x.id === rq.body?.request?.id || x.id === rq.body?.id);
  check('walk 2: "Make public…" is the director\'s: the agent gets 403 (and media_update private:false stays 403), the page needs confirm (400) and only for its own private upload; then the file moves to media/still/, the flag drops, the request\'s ref follows (logged)',
    upl.status === 200 && pm?.private === true && /^private\/still\//.test(pm.path) && lower.status === 403 && agentPub.status === 403 && noConfirm.status === 400 && [403, 409].includes(notMine.status)
    && pub.status === 200 && mNow?.private === false && /^media\/still\//.test(mNow.path) && fs.existsSync(path.join(D, mNow.path)) && !fs.existsSync(path.join(D, pm.path)) && mNow.made_public?.via === 'page'
    && (!rqNow || (rqNow.refs.includes(mNow.path) && rqNow.log.some(l => l.moved_ref))),
    { upl: upl.status, lower: lower.status, agentPub: agentPub.status, noConfirm: noConfirm.status, notMine: notMine.status, pub: [pub.status, pub.body?.error], m: mNow && { path: mNow.path, private: mNow.private }, refs: rqNow?.refs, rq: rq.status });

  // ------------------------------------------------------------------ walk blocker 5: results dropped on a handed-off request
  const rqs = rj('requests.json'); rqs.items.push({ id: 'rho1', kind: 'still', prompt: 'p', refs: [], est_cost: 0, status: 'running', by: 'director', log: [], handoff: { generator: 'openwith', pack: 'gen/rho1/pack', results: 'gen/rho1/results' } }); rqs.rev++;
  fs.writeFileSync(path.join(D, 'requests.json'), JSON.stringify(rqs));
  const hoAgent = await op('handoff_upload', { id: 'rho1', name: 'r.png', data: b64 });
  const hoText = await op('handoff_upload', { id: 'rho1', name: 'x.png', data: Buffer.from('<script>alert(1)</script>').toString('base64') }, true);
  const hoBad = await op('handoff_upload', { id: 'r_nope', name: 'r.png', data: b64 }, true);
  const hoOk = await op('handoff_upload', { id: 'rho1', name: '../../evil name.png', data: b64 }, true);
  const resDir = path.join(D, 'gen', 'rho1', 'results'), files = fs.existsSync(resDir) ? fs.readdirSync(resDir) : [];
  check('walk 5: results for a handed-off request are dropped by the page only (agent 403), images only (415), a known handed-off request (404 / 409); the file lands in its results/ with a clean name',
    hoAgent.status === 403 && hoText.status === 415 && [404, 409].includes(hoBad.status) && hoOk.status === 200 && files.length === 1 && /^[A-Za-z0-9_-]+\.png$/.test(files[0]) && !fs.existsSync(path.join(D, 'evil name.png')),
    { hoAgent: hoAgent.status, hoText: hoText.status, hoBad: hoBad.status, hoOk: [hoOk.status, hoOk.body?.file], files });
} catch (e) { check('test ran to the end', false, String(e.stack || e)); }
finally {
  srv?.kill(); await wait(300);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (e) { await wait(300); } }
}
console.log(`\n${n - failed}/${n} review #3 security checks passed`);
process.exit(failed ? 1 : 0);
