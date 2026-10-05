// Identity checks (ROADMAP_v4 D7): the agent looks at an output and writes what it saw against the character's constants
// checklist (D2, entity constants[] with check !== false). Shapes and the badge logic: js/checks.js.
//   check_add   the agent's vision check of a node, a take or a media file against an approved identity: verdict ok | drift |
//               fail, one item per constant ({constant, ok, note}), a note; optionally the local face-embedding score
//               (checks.score, tools/face-score.md: nothing here computes it). Writes checks.json only: a check never
//               approves, rejects or picks anything (approvals.json, requests.json, the storyboard are never touched).
//   checks_get  read only: the checks (latest per target), the open "identity check" asks with what is still unchecked, the
//               checklist per character (its approved identity image to compare with, the constants to check)
//   the ask     when an output lands (lib/ops/_hooks.mjs: the runner's done, an import, a node added to a tree) and the
//               project has settings.json identity_checks: true (off by default), the server writes ONE note for the agent per
//               character ("identity check": the outputs and the approved identity to compare with); each output once.
// checks.json is the server's (not a page save; the page reads it).
import fs from 'node:fs';
import path from 'node:path';
import * as C from '../../js/checks.js';
import * as A from '../../js/assets.js';
import * as SB from '../../js/storyboard.js';
import * as T from '../../js/takes.js';
import { fail, nowIso, ops, projDir, read, readJSON, resolveMedia, withFileLock, writeJSON } from './_shared.mjs';
import { onLanded } from './_hooks.mjs';
import { readAsset } from './assets.mjs';
import { addNote, notesDoc, setStatus } from './notes.mjs';
import { boardDoc } from './storyboard.mjs';
import { shotMediaLinks } from './media.mjs';

const FILE = 'checks.json';
export const checksDoc = (p) => C.normChecks(readJSON(path.join(projDir(p), FILE), null, true));
function mutateChecks(p, fn) {
  return withFileLock(path.join(projDir(p), FILE), () => { const d = checksDoc(p); const r = fn(d); d.rev = (d.rev || 0) + 1; writeJSON(path.join(projDir(p), FILE), d); return r === undefined ? d : r; });
}
const abs = (p, f) => { const a = resolveMedia(p, f); return a && fs.existsSync(a) ? a : null; };
const characters = (p) => (read(p, 'entities/index.json') || []).filter(e => e?.kind === 'character');
// a character, its approved identity node and its checklist
function identityOf(p, id) {
  const e = characters(p).find(x => x.id === id); if (!e) return null;
  const { ent } = readAsset(p, 'character', id), it = A.normIter(ent.iter), node = A.approvedNode(it, 'identity');
  return { id, name: ent.name || id, ent, iter: it, node, checklist: C.checklist(ent), constants: C.constantsList(ent) };
}
const shotsOf = (p) => { try { return SB.boardShots(boardDoc(p)); } catch (e) { return []; } };
const ckId = (d) => `ck${String(d.checks.reduce((m, c) => Math.max(m, Number(String(c.id).replace(/\D/g, '')) || 0), 0) + 1).padStart(2, '0')}`;

// ------------------------------------------------------------------ the ask (an output landed)
// the characters an output is about: the request's asset link, a "character:<id>" / "shot:<id>" target (the shot's cast),
// the media's entities and shots, a node's entity
function charactersFor(p, x, { req, m, shots, chars }) {
  const ids = new Set(), add = (id) => { if (chars.has(id)) ids.add(id); }, castOf = (sid) => (shots.find(s => s.id === sid)?.cast || []).forEach(add);
  if (x.entity) add(x.entity);
  const link = req ? A.linkOf(req) : null; if (link && (link.type || 'character') === 'character') add(link.id);
  const tg = String(req?.target || ''); if (tg.startsWith('character:')) add(tg.slice(10)); if (tg.startsWith('shot:')) castOf(tg.slice(5));
  for (const id of m?.entities || []) add(id);
  for (const sid of m?.shots || []) castOf(sid);
  if (x.shot) castOf(x.shot);
  return [...ids];
}
// what a check of this output should name as its target
function suggestTarget(p, x, { req, m, shots, entity }) {
  if (x.node && x.entity === entity) return { kind: 'node', id: `${entity}/${x.node}` };
  if (m) {
    const sid = x.shot || (String(req?.target || '').startsWith('shot:') ? req.target.slice(5) : null) || (m.shots || [])[0];
    const s = sid && shots.find(y => y.id === sid);
    if (s && T.takesForShot(s, { media: read(p, 'media.json').items || [], requests: read(p, 'requests.json').items || [], uses: read(p, 'shots.json').uses || [], links: shotMediaLinks(p, s.id) }).some(t => t.media === m.id)) return { kind: 'take', id: `${s.id}/${m.id}` };
    return { kind: 'media', id: m.id };
  }
  return null;
}
export function askIdentityCheck(p, items) {
  const st = read(p, 'settings.json') || {};
  if (st.identity_checks !== true) return null;
  const media = read(p, 'media.json').items || [], reqs = read(p, 'requests.json').items || [], shots = shotsOf(p);
  const chars = new Set(characters(p).map(e => e.id));
  if (!chars.size) return null;
  const byKey = (f) => String(f || '').replace(/\\/g, '/').toLowerCase();
  const D = checksDoc(p), seen = new Set(D.asks.flatMap(a => (a.files || []).map(f => `${a.entity}|${byKey(f.from || f.file)}`)));
  // per character: the outputs not asked about yet (a node made from a runner output counts as that output)
  const groups = new Map(), ids = new Map();
  for (const x of items) {
    const key = byKey(x.from || x.file), req = x.request ? reqs.find(r => r.id === x.request) : null;
    const m = media.find(y => byKey(y.path) === byKey(x.file)) || (x.from ? media.find(y => byKey(y.path) === key) : null);
    for (const cid of charactersFor(p, x, { req, m, shots, chars })) {
      if (!ids.has(cid)) ids.set(cid, identityOf(p, cid));
      const idn = ids.get(cid); if (!idn?.node) continue;   // nothing approved to compare with yet
      if (byKey(idn.node.image) === byKey(x.file) || seen.has(`${cid}|${key}`)) continue;
      const g = groups.get(cid) || new Map(); groups.set(cid, g);
      const prev = g.get(key), target = suggestTarget(p, x, { req, m, shots, entity: cid });
      if (!target) continue;
      if (!prev || (target.kind === 'node' && prev.target.kind !== 'node')) g.set(key, { file: x.file, ...(x.from ? { from: x.from } : {}), ...(m ? { media: m.id } : {}), ...(x.node ? { node: x.node } : {}), ...(x.request ? { request: x.request } : {}), target, source: x.source || 'runner' });
    }
  }
  const made = [];
  for (const [cid, g] of groups) {
    const files = [...g.values()]; if (!files.length) continue;
    const idn = ids.get(cid), src = [...new Set(files.map(f => f.source))].join(' / '), rq = [...new Set(files.map(f => f.request).filter(Boolean))];
    const list = idn.checklist.length ? idn.checklist.map((c, i) => `${i + 1}. ${c.text}`).join('\n') : '(no constants on the checklist yet: check the likeness, and ask the director to list the constants in the Characters stage)';
    const text = `Identity check: ${files.length} new output${files.length > 1 ? 's' : ''} of ${idn.name} landed (${src}${rq.length ? ' · request ' + rq.join(', ') : ''}). `
      + `Compare each with the approved identity ${idn.node.id} (${idn.node.image}) against the checklist, plus "likeness" (the face as a whole):\n${list}\n`
      + `Outputs:\n${files.map(f => `- ${f.file} -> check_add {target: {kind: "${f.target.kind}", id: "${f.target.id}"}}`).join('\n')}\n`
      + `Then for each: check_add {target, against: {entity: "${cid}"}, verdict: ok | drift | fail, items: [{constant, ok, note}], note}. checks_get {entity: "${cid}"} gives the absolute files. `
      + 'A check is for the director: it never approves, rejects or picks anything.';
    let n; try { n = addNote(p, { target: { stage: 'characters', kind: 'asset', id: cid }, text: text.slice(0, 7900), to: 'agent', ask: 'check', by: 'workbench', via: 'agent' }); } catch (e) { continue; }
    const ask = { note: n.id, entity: cid, against: idn.node.id, files, source: src, at: nowIso() };
    mutateChecks(p, (d) => { d.asks.push(ask); });
    made.push(ask);
  }
  return made;
}
onLanded((p, items) => askIdentityCheck(p, items));

// ------------------------------------------------------------------ the target exists now
function checkTargetExists(p, t) {
  const media = read(p, 'media.json').items || [];
  if (t.kind === 'node') {
    const [, ent, node] = C.NODE_TARGET.exec(t.id);
    const e = (read(p, 'entities/index.json') || []).find(x => x.id === ent);
    if (!e) fail(404, `no entity "${ent}" (character_get lists them)`);
    if (!A.nodeById(readAsset(p, e.kind, ent).ent.iter, node)) fail(404, `no node "${node}" on ${ent} (character_get {id: "${ent}"} lists its nodes)`);
    return { entity: ent, node, file: A.nodeById(readAsset(p, e.kind, ent).ent.iter, node).image };
  }
  if (t.kind === 'take') {
    const [, sid, mid] = C.TAKE_TARGET.exec(t.id);
    const s = shotsOf(p).find(x => x.id === sid); if (!s) fail(404, `no shot "${sid}" in the storyboard (storyboard_get)`);
    const m = media.find(x => x.id === mid); if (!m) fail(404, `no registered media "${mid}" (media_list)`);
    const ok = T.takesForShot(s, { media, requests: read(p, 'requests.json').items || [], uses: read(p, 'shots.json').uses || [], links: shotMediaLinks(p, s.id) }).some(x => x.media === mid);
    if (!ok) fail(404, `${mid} is not a take of ${sid} (takes_get {shot: "${sid}"} lists them)`);
    return { shot: sid, media: mid, file: m.path };
  }
  const m = media.find(x => x.id === t.id); if (!m) fail(404, `no registered media "${t.id}" (media_list)`);
  if (!/\.(png|jpe?g|webp|gif|mp4|webm|mov|mkv)$/i.test(m.path || '')) fail(400, `${t.id} is not an image or a video`);
  return { media: m.id, file: m.path };
}

Object.assign(ops, {
  // the agent's vision check against the constants checklist: checks.json only, never an approval or a pick
  check_add(p, { target, against, verdict, items, note, score, by = 'agent' } = {}) {
    let t; try { t = C.cleanTarget(target); } catch (e) { fail(e.code || 400, e.message); }
    const where = checkTargetExists(p, t);
    if (!against || typeof against !== 'object' || !C.entityIdOk(against.entity)) fail(400, 'against: {entity: <character id>, node?: <node id> (default: its approved identity)}');
    const idn = identityOf(p, against.entity); if (!idn) fail(404, `no character "${String(against.entity).slice(0, 64)}" (character_get lists them)`);
    let node = idn.node;
    if (against.node != null) { node = A.nodeById(idn.iter, String(against.node)); if (!node) fail(404, `no node "${String(against.node).slice(0, 20)}" on ${idn.id}`); }
    if (!node) fail(409, `${idn.id} has no approved identity yet: name the node to compare with (against.node) or wait until the director approves one`);
    if (!C.VERDICTS.includes(verdict)) fail(400, `verdict: ${C.VERDICTS.join(' | ')}`);
    if (items != null && !Array.isArray(items)) fail(400, 'items: [{constant, ok, note?}]');
    if ((items || []).length > C.ITEMS_MAX) fail(400, `items: at most ${C.ITEMS_MAX}`);
    const its = [], have = new Set();
    for (const [i, x] of (items || []).entries()) {
      if (!x || typeof x !== 'object' || typeof x.ok !== 'boolean') fail(400, `items[${i}]: {constant, ok: true | false, note?}`);
      const c = C.matchConstant(idn.ent, x.constant);
      if (!c) fail(400, `items[${i}].constant: one of ${idn.id}'s constants (${idn.constants.map(k => JSON.stringify(k.text)).join(', ') || 'none yet'}) or "${C.LIKENESS}"`);
      if (have.has(c)) fail(400, `items[${i}]: "${c}" twice`); have.add(c);
      if (x.note != null && typeof x.note !== 'string') fail(400, `items[${i}].note: a string`);
      its.push({ constant: c, ok: x.ok, ...(x.note ? { note: String(x.note).slice(0, C.ITEM_NOTE_MAX) } : {}) });
    }
    if (verdict === 'ok' && its.some(x => !x.ok)) fail(400, 'verdict "ok" with a failed constant: say "drift" or "fail"');
    if (note != null && (typeof note !== 'string' || note.length > C.NOTE_MAX)) fail(400, `note: a string of at most ${C.NOTE_MAX} characters`);
    let sc = null;
    if (score != null) {
      if (typeof score !== 'object' || typeof score.model !== 'string' || !score.model.trim() || score.model.length > 80 || !Number.isFinite(score.value) || Math.abs(score.value) > 1e6
        || (score.threshold != null && !Number.isFinite(score.threshold))) fail(400, 'score: {model (≤ 80 characters), value (a number), threshold?, metric?} (the optional local face-embedding score: tools/face-score.md)');
      sc = { model: score.model.trim(), value: score.value, ...(score.threshold != null ? { threshold: score.threshold } : {}), ...(score.metric ? { metric: String(score.metric).slice(0, 20) } : {}) };
    }
    const ck = mutateChecks(p, (d) => {
      const c = { id: ckId(d), target: t, against: { entity: idn.id, node: node.id, image: node.image }, by: String(by || 'agent').slice(0, 60), via: 'agent', verdict, items: its, note: note ? String(note) : '', ...(sc ? { score: sc } : {}), created: nowIso() };
      d.checks.push(c); return c;
    });
    // an "identity check" ask whose outputs are all checked now is done: absorbed, with what was found
    const absorbed = [];
    const D = checksDoc(p), notes = notesDoc(p).notes;
    for (const a of D.asks) {
      const s = C.askState(D, a), n = notes.find(x => x.id === a.note);
      if (!n || n.status !== 'open' || s.unchecked || !(a.files || []).some(f => C.targetKey(f.target) === C.targetKey(t))) continue;
      const res = (a.files || []).map(f => { const c = D.checks.filter(x => C.targetKey(x.target) === C.targetKey(f.target)).pop(); return `${f.target.id}: ${C.badge(c, idn.ent)?.label}`; }).join('; ');
      try { setStatus(p, a.note, 'absorbed', { reply: `checked: ${res}`.slice(0, 7900), by: ck.by, via: 'agent' }); absorbed.push(a.note); } catch (e) { /* the director's own note: left open */ }
    }
    return { check: ck, badge: C.badge(ck, idn.ent), target: { ...t, ...where }, ...(absorbed.length ? { asks_absorbed: absorbed } : {}),
      note: 'written to checks.json: a badge on the node / take for the director. A check never approves, rejects or picks anything: the director decides' };
  },
  // read only
  checks_get(p, { target, entity, verdict, limit = 200 } = {}) {
    let t = null; if (target != null) { try { t = C.cleanTarget(target); } catch (e) { fail(e.code || 400, e.message); } }
    if (entity != null && !C.entityIdOk(entity)) fail(400, 'entity: a character id');
    if (verdict != null && !C.VERDICTS.includes(verdict)) fail(400, `verdict: ${C.VERDICTS.join(' | ')}`);
    const D = checksDoc(p), notes = notesDoc(p).notes, st = read(p, 'settings.json') || {};
    const list = D.checks.filter(c => (!t || C.targetKey(c.target) === C.targetKey(t)) && (!entity || c.against?.entity === entity) && (!verdict || c.verdict === verdict));
    const latest = {}; for (const c of D.checks) latest[C.targetKey(c.target)] = c;
    const chars = characters(p).filter(e => !entity || e.id === entity).map(e => identityOf(p, e.id)).filter(Boolean);
    return {
      enabled: st.identity_checks === true,
      checks: list.slice(-Math.max(1, Math.min(1000, Number(limit) || 200))),
      latest: Object.values(latest).filter(c => (!entity || c.against?.entity === entity)).map(c => ({ target: c.target, id: c.id, verdict: c.verdict, badge: C.badge(c, identityOf(p, c.against?.entity)?.ent)?.label, created: c.created })),
      asks: D.asks.filter(a => (!entity || a.entity === entity) && notes.find(n => n.id === a.note)?.status === 'open').map(a => C.askState(D, a)).map(a => ({ ...a, files: a.files.map(f => ({ ...f, abs: abs(p, f.file) })), left: a.left.map(f => f.target) })),
      checklist: chars.map(c => ({ entity: c.id, name: c.name, identity: c.node ? { node: c.node.id, image: c.node.image, abs: abs(p, c.node.image) } : null, constants: c.constants, to_check: [...c.checklist.map(k => k.text), C.LIKENESS] })),
      rules: 'look at each output next to the approved identity image; per constant on the checklist say ok true / false with a short note (what you saw: "clip on the RIGHT side"), plus "likeness"; verdict ok (all hold) | drift (holds, but it is drifting) | fail; check_add writes it. '
        + 'The director sees the badge and decides: a check never approves, rejects or picks anything. score is the optional local face-embedding score (tools/face-score.md), never computed by the workbench.',
    };
  },
});
