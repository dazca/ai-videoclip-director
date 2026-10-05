// The lyric gate (ROADMAP_v4 E2). Shapes and shared logic: js/surfaces.js.
//   surfaces_get     read only: every lyric line with each word covered or not (the shot + where it appears), the uncovered
//                    runs, the surfaces per shot, the agent's proposals, the counts (Final's "every word on a surface")
//   surface_propose  the agent proposes a surface {shot, line, w?, where, why} (surfaces.json); never on a shot itself
//   surface_act      PAGE ONLY: accept / dismiss / reopen a proposal; add / remove a surface directly. Writes shot.lyrics
//                    through a NEW storyboard version (nothing else changes). The agent cannot (403, no MCP tool)
// surfaces.json is the server's (not a page save); a page save of storyboard.json and the agent's shots_update keep the
// server's shot.lyrics (serve.mjs, lib/ops/storyboard.mjs).
import path from 'node:path';
import * as SF from '../../js/surfaces.js';
import * as SB from '../../js/storyboard.js';
import { span } from '../../js/scenes.js';
import { fail, nowIso, ops, projDir, read, readJSON, withFileLock, write, writeJSON } from './_shared.mjs';
import { boardDoc } from './storyboard.mjs';
import { scenesDoc } from './scenes.mjs';

const FILE = 'surfaces.json';
export const surfacesDoc = (p) => SF.normSurfaces(readJSON(path.join(projDir(p), FILE), null, true));
function mutateSurfaces(p, fn) { return withFileLock(path.join(projDir(p), FILE), () => { const d = surfacesDoc(p); const r = fn(d); d.rev = (d.rev || 0) + 1; writeJSON(path.join(projDir(p), FILE), d); return r === undefined ? d : r; }); }
const pageOnly = (via) => { if (via !== 'page') fail(403, 'a surface on a shot is the director\'s, in the page (Storyboard › Shot › Lyrics on screen): propose one with surface_propose'); };
const check = (fn) => { try { return fn(); } catch (e) { fail(e.code || 400, e.message); } };

function ctx(p) { const song = read(p, 'song.json'), doc = boardDoc(p), v = SB.currentBoard(doc); return { song, doc, v, shots: SB.boardShots(doc) }; }
function needShot(c, shot) {
  if (typeof shot !== 'string' || !SB.SHOT_ID.test(shot)) fail(400, 'shot: a shot id of the storyboard (storyboard_get lists them)');
  const s = c.shots.find(x => x.id === shot); if (!s) fail(404, `no shot "${shot}" in the current storyboard version (storyboard_get)`);
  return s;
}
// the words a surface names must be sung during the shot ("at its time")
function needAtTime(c, s, e) {
  const L = c.song.lines.find(l => l.id === e.line), ws = SF.lineWords(L).filter((_, i) => !e.w || (i >= e.w[0] && i <= e.w[1]));
  if (!ws.some(w => w.t0 < s.t1 && Math.max(w.t1, w.t0 + 1) > s.t0)) fail(400, `${e.line}${e.w ? ` words ${e.w[0]}-${e.w[1]}` : ''} (${span(ws[0]?.t0 ?? L.t0, ws[ws.length - 1]?.t1 ?? L.t1)}) is not sung during ${s.id} (${span(s.t0, s.t1)}): pick the shot on screen at that time`);
}
// a NEW storyboard version with the shot's lyrics changed (the picks and everything else as they are)
function writeLyrics(p, shotId, fn, message) {
  return withFileLock(path.join(projDir(p), 'storyboard.json'), () => {
    const d = boardDoc(p), v = SB.currentBoard(d), shots = structuredClone(v?.shots || []), s = shots.find(x => x.id === shotId);
    if (!s) fail(404, `no shot "${shotId}" in the current storyboard version`);
    const before = JSON.stringify(s.lyrics || []), next = fn([...(s.lyrics || [])]);
    if (JSON.stringify(next) === before) return { version: d.current, unchanged: true, lyrics: next };
    if (next.length) s.lyrics = next; else delete s.lyrics;
    const nv = SB.addBoardVersion(d, shots, { by: 'director', via: 'page', message, script: scenesDoc(p).current || undefined });
    delete d.derived;
    try { SB.checkBoard(d); } catch (e) { fail(400, e.message); }
    d.rev = (d.rev || 0) + 1; write(p, 'storyboard.json', d);
    return { version: nv.id, lyrics: next };
  });
}

Object.assign(ops, {
  // read only: the gate, line by line
  surfaces_get(p, { line, uncovered = false, shot } = {}) {
    if (line != null && typeof line !== 'string') fail(400, 'line: a lyric line id');
    if (shot != null && (typeof shot !== 'string' || !SB.SHOT_ID.test(shot))) fail(400, 'shot: a shot id');
    const c = ctx(p), cov = SF.coverage(c.song, c.shots), D = surfacesDoc(p);
    const lines = cov.lines.filter(l => (!line || l.id === line) && (!uncovered || l.covered < l.n)).map(l => ({ id: l.id, text: l.text, time: span(l.t0, l.t1), covered: l.covered, n: l.n,
      words: l.words.map(w => ({ i: w.i, w: w.w, t0: w.t0, covered: w.by.length > 0, ...(w.by.length ? { on: w.by } : {}), ...(w.off && !w.by.length ? { off_time: w.off } : {}) })) }));
    return { ok: cov.ok, total: cov.total, covered: cov.covered, uncovered: cov.uncovered.map(u => ({ ...u, time: span(u.t0, u.t1) })), off_time: cov.off,
      lines, shots: c.shots.filter(s => (!shot || s.id === shot) && (s.lyrics?.length || shot)).map(s => ({ id: s.id, time: span(s.t0, s.t1), kind: s.kind, title: s.title, lyrics: s.lyrics || [] })),
      proposals: D.proposals.filter(x => (!shot || x.shot === shot) && (!line || x.line === line)), where_kinds: SF.WHERE, version: c.doc.current,
      rules: 'every sung or spoken word must appear on a desktop surface at its time. Propose one with surface_propose {shot, line, w?, where: "<kind>[: detail]", why}: the shot on screen while the words are sung; the director accepts it in the page (you never write shot.lyrics)' };
  },
  // the agent's proposal: checked like a surface (the shot exists, the line and range exist, sung during the shot)
  surface_propose(p, { shot, line, w, where, why, by = 'agent' } = {}) {
    const c = ctx(p), s = needShot(c, shot), e = check(() => SF.cleanEntry({ line, w, where }, { lines: c.song.lines }));
    needAtTime(c, s, e);
    const y = typeof why === 'string' ? why.trim() : '';
    if (!y || y.length > SF.WHY_MAX) fail(400, `why: 1-${SF.WHY_MAX} characters (what the surface shows and why there)`);
    if ((s.lyrics || []).some(x => SF.sameEntry(x, e))) fail(409, `${s.id} already shows ${e.line} on "${e.where}"`);
    const out = mutateSurfaces(p, (d) => {
      const dup = d.proposals.find(x => x.status === 'open' && x.shot === s.id && SF.sameEntry(x, e));
      if (dup) { dup.why = y; dup.at = nowIso(); return { proposal: dup, updated: true }; }
      const pr = { id: SF.nextProposalId(d), shot: s.id, ...e, why: y, by: String(by || 'agent').slice(0, 60), via: 'agent', at: nowIso(), status: 'open' };
      d.proposals.push(pr); return { proposal: pr };
    });
    return { ...out, changed: `surfaces.json: ${out.updated ? 'updated' : 'proposal'} ${out.proposal.id}: ${e.line} on ${s.id} "${e.where}"`, note: 'the director accepts it (or not) in the page: Storyboard › Shot › Lyrics on screen; surfaces_get shows the gate' };
  },
  // PAGE ONLY. act accept {proposal} | dismiss {proposal} | reopen {proposal} | add {shot, line, w?, where} | remove {shot, index}
  surface_act(p, { act, proposal, shot, line, w, where, index, via } = {}) {
    pageOnly(via);
    if (!['accept', 'dismiss', 'reopen', 'add', 'remove'].includes(act)) fail(400, 'act: accept | dismiss | reopen | add | remove');
    if (act === 'dismiss' || act === 'reopen') {
      return mutateSurfaces(p, (d) => {
        const x = d.proposals.find(y => y.id === proposal); if (!x) fail(404, `no surface proposal "${String(proposal).slice(0, 40)}"`);
        if (x.status === 'accepted') fail(409, `${x.id} was accepted: remove the surface from ${x.shot} instead`);
        x.status = act === 'dismiss' ? 'dismissed' : 'open'; x.decided_at = nowIso(); x.decided_by = 'director'; return { proposal: x };
      });
    }
    const c = ctx(p);
    if (act === 'remove') {
      const s = needShot(c, shot), i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= (s.lyrics || []).length) fail(400, `index: 0..${(s.lyrics || []).length - 1} (a surface of ${s.id})`);
      const gone = s.lyrics[i];
      return { ...writeLyrics(p, s.id, (L) => L.filter((_, k) => k !== i), `${s.id}: ${gone.line} off "${gone.where}"`), shot: s.id, removed: gone };
    }
    let pr = null, s, e;
    if (act === 'accept') {
      pr = surfacesDoc(p).proposals.find(y => y.id === proposal); if (!pr) fail(404, `no surface proposal "${String(proposal).slice(0, 40)}"`);
      if (pr.status !== 'open') fail(409, `${pr.id} is ${pr.status}`);
      s = needShot(c, pr.shot); e = check(() => SF.cleanEntry({ line: pr.line, w: pr.w, where: pr.where }, { lines: c.song.lines }));
    } else { s = needShot(c, shot); e = check(() => SF.cleanEntry({ line, w, where }, { lines: c.song.lines })); }
    needAtTime(c, s, e);
    if ((s.lyrics || []).length >= SF.PER_SHOT) fail(400, `${s.id}: at most ${SF.PER_SHOT} surfaces`);
    const r = writeLyrics(p, s.id, (L) => L.some(x => SF.sameEntry(x, e)) ? L : [...L, e], `${s.id}: ${e.line}${e.w ? ` ${e.w[0]}-${e.w[1]}` : ''} on "${e.where}"${pr ? ` (${pr.id})` : ''}`);
    if (pr) mutateSurfaces(p, (d) => { const x = d.proposals.find(y => y.id === pr.id); if (x) { x.status = 'accepted'; x.decided_at = nowIso(); x.decided_by = 'director'; } });
    return { ...r, shot: s.id, surface: e, ...(pr ? { proposal: pr.id } : {}) };
  },
});
