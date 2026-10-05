// Take selection (ROADMAP_v4 D6). Shapes and shared logic: js/takes.js.
//   takes_get     read only: every take of a shot (or of a request): the registered media linked to it (runner outputs,
//                 imports), with file paths, duration, fps, the director's pick (shot.clip) and the agent's proposals
//   take_propose  the agent proposes a take of a shot with in / out points and a why (takes.json); never a pick
//   take_act      PAGE ONLY: pick (writes shot.clip through a NEW storyboard version: the take, in / out inside its
//                 duration, a note, the alternatives), unpick, dismiss a proposal. The agent cannot pick (403, no MCP tool)
// takes.json is the server's (not a page save); a page save of storyboard.json keeps the server's picks (serve.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as T from '../../js/takes.js';
import * as SB from '../../js/storyboard.js';
import * as SC from '../../js/scenes.js';
import { fail, ms, nowIso, ops, projDir, read, readJSON, resolveMedia, write, writeJSON } from './_shared.mjs';
import { boardDoc } from './storyboard.mjs';
import { scenesDoc } from './scenes.mjs';
import { shotMediaLinks } from './media.mjs';   // D8: media the director marked "use as shot take" are takes of it

const FILE = 'takes.json';
// a time inside a take: integer ms, or "m:ss.mmm" (the agent's form); anything else goes to checkClip as is (and fails there)
const tms = (v, n) => typeof v === 'string' && v.includes(':') ? ms(v, n) : v;
export const takesDoc = (p) => T.normTakes(readJSON(path.join(projDir(p), FILE), null, true));
function mutateTakes(p, fn) { const d = takesDoc(p); const r = fn(d); d.rev = (d.rev || 0) + 1; writeJSON(path.join(projDir(p), FILE), d); return r === undefined ? d : r; }

// duration and frame rate from ffprobe (cached by path + mtime); the media index's duration_ms wins when it has one
const probeCache = new Map();
function probe(abs) {
  let st; try { st = fs.statSync(abs); } catch (e) { return { dur: null, fps: null }; }
  const k = `${abs}|${st.mtimeMs}|${st.size}`; if (probeCache.has(k)) return probeCache.get(k);
  let out = { dur: null, fps: null };
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate:format=duration', '-of', 'json', abs], { encoding: 'utf8', timeout: 20000 });
    const j = JSON.parse(r.stdout || '{}'), [a, b] = String(j.streams?.[0]?.r_frame_rate || '').split('/').map(Number), d = Number(j.format?.duration);
    out = { dur: Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null, fps: a > 0 && b > 0 ? +(a / b).toFixed(3) : null };
  } catch (e) { /* no ffprobe */ }
  probeCache.set(k, out); return out;
}
const absOf = (p, file) => { const a = resolveMedia(p, file); return a && fs.existsSync(a) ? a : null; };
const durationOf = (p) => (m) => { const a = absOf(p, m.path); return a ? probe(a).dur : null; };

function ctx(p) {
  const media = read(p, 'media.json').items || [], requests = read(p, 'requests.json').items || [], uses = read(p, 'shots.json').uses || [];
  const doc = boardDoc(p), v = SB.currentBoard(doc);
  return { media, requests, uses, doc, v, shots: v?.shots || [], song: read(p, 'song.json') };
}
const shotIdOk = (x) => typeof x === 'string' && SB.SHOT_ID.test(x);
function needShot(c, shot) {
  if (!shotIdOk(shot)) fail(400, 'shot: a shot id of the storyboard (storyboard_get lists them)');
  const s = c.shots.find(x => x.id === shot);
  if (!s) fail(404, `no shot "${shot}" in the current storyboard version (storyboard_get)`);
  return s;
}
// one take for the agent / the page: + the absolute file, fps, the duration probed when the index has none
function enrich(p, t, s) {
  const abs = absOf(p, t.file), pr = abs && t.kind === 'video' ? probe(abs) : { dur: null, fps: null };
  const pick = s?.clip, picked = !!pick && pick.file === t.file;
  return { ...t, duration_ms: t.duration_ms ?? pr.dur, fps: t.fps ?? pr.fps ?? (t.kind === 'video' ? T.DEFAULT_FPS : null), abs: abs || null, missing: !abs,
    url: `/data/${p}/${t.file}`, picked, ...(picked ? { in_ms: pick.in_ms, out_ms: pick.out_ms } : {}), alt_for: (pick?.alt || []).filter(a => a.file === t.file || (a.file == null && a.take === t.take && pick.file !== t.file)).map(a => ({ t: a.t, note: a.note })) };
}
// the shot whose storyboard version gets a new pick: a NEW version (the previous one stays), nothing else changes
function writePick(p, shotId, clip, message) {
  const d = boardDoc(p), v = SB.currentBoard(d);
  const shots = structuredClone(v?.shots || []), s = shots.find(x => x.id === shotId);
  if (!s) fail(404, `no shot "${shotId}" in the current storyboard version`);
  if (T.sameClip(s.clip, clip)) return { version: d.current, unchanged: true };
  if (clip) s.clip = clip; else delete s.clip;
  const nv = SB.addBoardVersion(d, shots, { by: 'director', via: 'page', message, script: scenesDoc(p).current || undefined });
  delete d.derived;
  try { SB.checkBoard(d); } catch (e) { fail(400, e.message); }
  d.rev = (d.rev || 0) + 1; write(p, 'storyboard.json', d);
  return { version: nv.id };
}

// the proposals of a shot follow its pick: the one picked is "picked", a previously picked one is open again
function syncProposals(p, shotId, pickedId) {
  const D = takesDoc(p), want = (x) => x.id === pickedId ? 'picked' : x.status === 'picked' ? 'open' : x.status;
  if (!D.proposals.some(x => x.shot === shotId && want(x) !== x.status)) return;
  mutateTakes(p, (d) => { for (const x of d.proposals) if (x.shot === shotId && want(x) !== x.status) { x.status = want(x); x.decided_at = nowIso(); x.decided_by = 'director'; } });
}

Object.assign(ops, {
  // every take of a shot (or a request), read only
  takes_get(p, { shot, request } = {}) {
    if ((shot == null) === (request == null)) fail(400, 'give one of shot (a shot id) or request (a request id)');
    const c = ctx(p), D = takesDoc(p);
    if (shot != null) {
      const s = needShot(c, shot), links = shotMediaLinks(p, s.id), takes = T.takesForShot(s, { ...c, links }).map(t => enrich(p, t, s));
      const reqs = SB.shotRequests(c.requests, s.id).map(r => ({ id: r.id, kind: r.kind, status: r.status, outputs: (r.outputs || []).length }));
      return { shot: { id: s.id, scene: s.scene, t0: s.t0, t1: s.t1, time: SC.span(s.t0, s.t1), length_ms: s.t1 - s.t0, kind: s.kind, title: s.title, text: s.text },
        version: c.doc.current, picked: s.clip || null, ...(s.clip ? { fit: T.fitNote(s.clip, s) } : {}), takes, requests: reqs, start_frame: links.start_frame,
        proposals: D.proposals.filter(x => x.shot === s.id), counts: { takes: takes.length, videos: takes.filter(t => t.kind === 'video').length, proposals_open: T.openProposals(D, s.id).length },
        rules: 'the pick is the director\'s (page only): propose with take_propose {shot, media | file, in_ms, out_ms, why}; they pick with one click. in / out are ms inside the take (0 <= in < out <= duration_ms), on its frames (fps)' };
    }
    if (typeof request !== 'string' || !/^[\w@.:-]{1,80}$/.test(request)) fail(400, 'request: a request id');
    const r = c.requests.find(x => x.id === request); if (!r) fail(404, `no request "${request}" (requests_list)`);
    const sid = /^shot:/.test(r.target || '') ? r.target.slice(5) : null, s = sid ? c.shots.find(x => x.id === sid) : null;
    const takes = T.takesForRequest(request, c).map(t => enrich(p, t, s));
    return { request: { id: r.id, kind: r.kind, status: r.status, target: r.target || null, outputs: r.outputs || [] }, shot: s ? { id: s.id, time: SC.span(s.t0, s.t1), picked: s.clip || null } : null, takes,
      proposals: D.proposals.filter(x => x.request === request || (s && x.shot === s.id)) };
  },
  // the agent's proposal: a take of a shot with in / out and why; checked like a pick, written to takes.json
  take_propose(p, { shot, media, file, take, request, in_ms, out_ms, why, by = 'agent' } = {}) {
    const c = ctx(p), s = needShot(c, shot);
    const w = typeof why === 'string' ? why.trim() : '';
    if (!w || w.length > T.WHY_MAX) fail(400, `why: 1-${T.WHY_MAX} characters (what you saw: "the smile lands at 0.6 s; take 1 has a door wipe")`);
    let m = null;
    if (media == null && file == null && take != null) {
      const cands = T.takesForShot(s, c).filter(t => t.take === Number(take) && (!request || t.request === request || t.job === request));
      if (cands.length !== 1) fail(cands.length ? 400 : 404, cands.length ? `take ${take} is ambiguous for ${s.id}: give request or media (takes_get)` : `no take ${take} for ${s.id} (takes_get lists them)`);
      m = { file: cands[0].file };
    }
    let clip; try { clip = T.checkClip({ file: m?.file ?? file, media, in_ms: tms(in_ms, 'in_ms'), out_ms: tms(out_ms, 'out_ms') }, { media: c.media, requests: c.requests, song: c.song, durationOf: durationOf(p) }); } catch (e) { fail(e.code || 400, e.message); }
    if (!T.takesForShot(s, c).some(t => t.file === clip.file)) fail(400, `${clip.media} is not a take of ${s.id}: link it first (media_update {id, shots: ["${s.id}"]}) or pick one from takes_get`);
    const out = mutateTakes(p, (d) => {
      const dup = d.proposals.find(x => x.status === 'open' && x.shot === s.id && x.file === clip.file && x.in_ms === clip.in_ms && x.out_ms === clip.out_ms);
      if (dup) { dup.why = w; dup.at = nowIso(); return { proposal: dup, updated: true }; }
      const pr = { id: T.nextProposalId(d), shot: s.id, request: clip.request, job: c.media.find(x => x.id === clip.media)?.job ?? null, take: clip.take, file: clip.file, media: clip.media, kind: clip.kind, in_ms: clip.in_ms, out_ms: clip.out_ms, why: w, by: String(by || 'agent').slice(0, 60), via: 'agent', at: nowIso(), status: 'open' };
      d.proposals.push(pr); return { proposal: pr };
    });
    return { ...out, changed: `takes.json: ${out.updated ? 'updated' : 'proposal'} ${out.proposal.id} for ${s.id} (${T.takeName(out.proposal)} ${T.secs(clip.in_ms)}${clip.out_ms != null ? '–' + T.secs(clip.out_ms) : ''})`,
      note: 'the director picks it (or another take) in the page: Storyboard › Shot › Takes; takes_get shows their pick' };
  },
  // PAGE ONLY: the director's pick. act pick {shot, media | file, in_ms, out_ms, note, alt[], proposal?} | unpick {shot}
  // | dismiss {proposal} | reopen {proposal}
  take_act(p, { act, shot, media, file, in_ms, out_ms, note, alt, proposal, via } = {}) {
    if (via !== 'page') fail(403, 'picking a take is the director\'s, in the page (Storyboard › Shot › Takes): propose one with take_propose');
    if (!['pick', 'unpick', 'dismiss', 'reopen'].includes(act)) fail(400, 'act: pick | unpick | dismiss | reopen');
    if (act === 'dismiss' || act === 'reopen') {
      return mutateTakes(p, (d) => {
        const x = d.proposals.find(y => y.id === proposal); if (!x) fail(404, `no take proposal "${String(proposal).slice(0, 40)}"`);
        x.status = act === 'dismiss' ? 'dismissed' : 'open'; x.decided_at = nowIso(); x.decided_by = 'director'; return { proposal: x };
      });
    }
    const c = ctx(p), s = needShot(c, shot);
    if (act === 'unpick') { const r = writePick(p, s.id, null, `unpick the take of ${s.id}`); syncProposals(p, s.id, null); return { ...r, shot: s.id, clip: null }; }
    let clip; try { clip = T.checkClip({ file, media, in_ms: tms(in_ms, 'in_ms'), out_ms: tms(out_ms, 'out_ms'), note, alt }, { media: c.media, requests: c.requests, song: c.song, durationOf: durationOf(p) }); } catch (e) { fail(e.code || 400, e.message); }
    if (!T.takesForShot(s, c).some(t => t.file === clip.file)) fail(400, `${clip.media} is not a take of ${s.id} (not linked to the shot, its clip uses or its requests)`);
    const D = takesDoc(p), same3 = (x) => x.file === clip.file && x.in_ms === clip.in_ms && (x.out_ms ?? null) === (clip.out_ms ?? null);
    let pr = proposal != null ? D.proposals.find(x => x.id === proposal && x.shot === s.id) : null;
    if (proposal != null && !pr) fail(404, `no take proposal "${String(proposal).slice(0, 40)}" on ${s.id}`);
    // the proposal this pick follows: the one named, else one with the same take and range (an alt added later keeps it)
    pr ||= D.proposals.find(x => x.shot === s.id && x.status !== 'dismissed' && same3(x)) || null;
    const full = { ...clip, by: 'director', via: 'page', at: nowIso(), ...(pr ? { proposal: pr.id } : {}) };
    // the same take, in / out, note and alternatives as now: nothing to write (the stamp aside)
    const same = s.clip && T.sameClip({ ...s.clip, at: 0, proposal: 0 }, { ...full, at: 0, proposal: 0 });
    const r = same ? { version: c.doc.current, unchanged: true } : writePick(p, s.id, full, `pick ${T.takeName(clip)} for ${s.id}${clip.out_ms != null ? ` (${T.secs(clip.in_ms)}–${T.secs(clip.out_ms)})` : ''}${clip.alt.length ? ` + ${clip.alt.length} alt` : ''}`);
    syncProposals(p, s.id, pr?.id || null);
    return { ...r, shot: s.id, clip: full, fit: T.fitNote(full, s) };
  },
});
