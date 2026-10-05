// Stage 7 of the guided flow (docs/SPEC_v3_GUIDED.md; ROADMAP_v4 C1-C4): final approvals. Pure functions, no DOM and no
// Node APIs: the page (tabs/final.js, tabs/approvals.js) and the data layer (lib/ops/final.mjs, the final_get tool) use
// the same code, so the director and the agent see the same list, the same checklist and the same sums.
//
// finalView(input) -> {rows, groups, counts, checklist, ready, costs, lock}
//   input  {song, lyrics, stages, scenes, breakdown, board, uses, entities, approvals, requests, notes, revisions,
//           costs (costs.json), ledger? (costs_get: the merged ledger), media?, isPrivate?(path)}
//   Nothing here is stored: every row and every check is derived from where its status lives:
//     lyrics      stages.json (the lyrics stage not marked done)        approve = mark the stage done (page)
//     script      scenes.json states (a scene not ok)                    approve = states[id] ok (page save)
//     breakdown   breakdown.json states (an item not ok, not dropped)    approve = states[id] ok (page save)
//     characters, scenery   an asset's identity / base tree not approved, a look / variant not approved
//                                                                        approve = asset_act approve (page only)
//     storyboard  approvals.json shot:<id> and use:<id> not approved / locked   approve = approvals.json (page save)
//     requests    requests.json drafts                                   approve = requests.json status (page save)
//   Row  {key, group, kind, id, title, sub, t0?, t1?, thumb?, status (the file's word), st: draft | review | changes,
//         why, est_usd, spent_usd, targets [note targets], jump {stage?, view?, focus?, t?}, act {approve?, changes}}
//   A locked project (revisions.json lock, set by "Lock for render", page only) refuses agent writes (409).
import { currentScript, gaps as scriptGaps, span } from './scenes.js';
import { currentBreakdown } from './breakdown.js';
import * as SB from './storyboard.js';
import * as A from './assets.js';
import * as N from './notes.js';
import { inFlight } from './revisions.js';
import { currentVersion, flatLines, assetApproval } from './flow.js';
import { takesChecklist } from './takes.js';
import { gateCheck } from './surfaces.js';
import { chaptersView } from './chapters.js';

export const GROUPS = [
  { id: 'lyrics', title: 'Lyrics', n: 1 }, { id: 'script', title: 'Script', n: 2 }, { id: 'breakdown', title: 'Breakdown', n: 3 },
  { id: 'characters', title: 'Characters', n: 4 }, { id: 'scenery', title: 'Scenery', n: 5 }, { id: 'storyboard', title: 'Storyboard', n: 6 },
  { id: 'requests', title: 'Requests', n: null },   // the generation queue: not a stage, so no number
];
export const ST = ['draft', 'review', 'changes'];
const DONE = ['approved', 'locked'];
const OPEN_REQ = ['draft', 'approved', 'queued', 'running'];
const money = (x) => +(Number(x) || 0).toFixed(2);
const sum = (a) => money(a.reduce((s, x) => s + (Number(x) || 0), 0));
const pl = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const clip = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// the lock (revisions.json `lock`, written by the server only): {at, revision, by, via, summary} | null
export const lockOf = (rv) => (rv?.lock && typeof rv.lock === 'object' ? rv.lock : null);

// the spend recorded for a set of request ids (costs.json items, by request or id)
const spentFor = (costs, ids) => ids.length ? sum((costs?.items || []).filter(x => ids.includes(x.request) || ids.includes(x.id)).map(x => x.usd)) : 0;

// the media a shot has for the render: its clip uses' files, a done request's outputs, its thumbnail, media linked to it
export function shotMedia(shot, { uses = [], requests, media = [] } = {}) {
  const out = [];
  if (shot.clip?.file) out.push({ path: shot.clip.file, from: 'picked take' });   // the director's pick (js/takes.js) first
  for (const u of shot.clips || []) { const x = uses.find(y => y.id === u); if (x?.file) out.push({ path: x.file, from: 'clip ' + x.id }); }
  for (const r of SB.shotRequests(requests, shot.id)) if (r.status === 'done') for (const o of r.outputs || []) out.push({ path: o, from: 'request ' + r.id });
  for (const m of media) if ((m.links?.shots || m.shots || []).includes?.(shot.id) && ['clip', 'still', 'render'].includes(m.kind) && m.path) out.push({ path: m.path, from: 'media ' + m.id });
  if (shot.thumb) out.push({ path: shot.thumb, from: 'thumbnail' });
  return out.filter((x, i, a) => a.findIndex(y => y.path === x.path) === i);
}

export function finalView(I) {
  const rows = [], song = I.song || {}, dur = song.duration_ms || 0, reqs = I.requests?.items || I.requests || [], costs = I.costs || { items: [] };
  const isPriv = I.isPrivate || (() => false), notes = I.notes;
  const openOn = (targets) => (notes?.notes || []).filter(n => n.status === 'open' && targets.some(t => N.sameTarget(t, n.target))).length;
  const sv = currentScript(I.scenes), scenes = sv?.scenes || [], shots = SB.boardShots(I.board), ents = (I.entities || []).filter(e => e && A.TYPES.includes(e.kind));
  const sceneOf = (id) => scenes.find(s => s.id === id);

  // 1. lyrics: the stage not marked done
  const lyStage = (I.stages?.stages || []).find(s => s.id === 'lyrics'), lv = currentVersion(I.lyrics);
  if (lv && lyStage?.status !== 'done') rows.push({ key: 'lyrics:stage', group: 'lyrics', kind: 'lyrics', id: lv.id, title: `Lyrics ${lv.id}`, sub: `${pl(flatLines(lv).length, 'line')}`,
    status: lyStage?.status === 'needs_you' ? 'needs you' : 'not done', st: lyStage?.status === 'needs_you' ? 'review' : 'draft', why: 'the lyrics stage is not marked done',
    targets: [{ stage: 'lyrics', kind: 'stage', id: null }], jump: { stage: 'lyrics' }, act: { approve: { kind: 'stage', stage: 'lyrics' }, changes: { kind: 'note' } } });

  // 2. script: scenes not ok
  for (const s of scenes) {
    const st = I.scenes?.states?.[s.id]?.status || 'draft'; if (st === 'ok') continue;
    rows.push({ key: 'scene:' + s.id, group: 'script', kind: 'scene', id: s.id, title: s.title || s.id, sub: clip(s.text, 120), t0: s.t0, t1: s.t1, status: st === 'needs_you' ? 'needs you' : st,
      st: st === 'needs_you' ? 'review' : 'draft', why: st === 'needs_you' ? 'flagged for you' : 'scene not ok yet', targets: [{ stage: 'script', kind: 'scene', id: s.id }],
      jump: { stage: 'script', focus: s.id }, act: { approve: { kind: 'scene', id: s.id }, changes: { kind: 'scene', id: s.id } } });
  }

  // 3. breakdown: items not ok (dropped ones are out)
  for (const it of currentBreakdown(I.breakdown)?.items || []) {
    if (it.dropped) continue;
    const st = I.breakdown?.states?.[it.id]?.status || 'draft'; if (st === 'ok') continue;
    rows.push({ key: 'item:' + it.id, group: 'breakdown', kind: 'item', id: it.id, title: it.name, sub: `${it.kind}${it.links?.length ? ' · ' + it.links.map(l => l.scene).join(' ') : ''}${it.description ? ' · ' + clip(it.description, 80) : ''}`,
      status: st, st: st === 'review' ? 'review' : 'draft', why: st === 'review' ? 'in review' : 'item not ok yet', targets: [{ stage: 'breakdown', kind: 'item', id: it.id }],
      jump: { stage: 'breakdown', focus: it.id }, act: { approve: { kind: 'item', id: it.id }, changes: { kind: 'item', id: it.id } } });
  }

  // 4-5. assets: the identity / base tree, then each look / variant, not approved
  for (const e of ents) {
    const T = A.TYPE[e.kind], it = A.normIter(e.iter), stage = T.stage, reqsE = A.assetRequests(reqs, e.kind, e.id);
    const treeRow = (tree, v) => {
      const head = A.headNode(it, tree), nodes = A.treeNodes(it, tree).length, rq = reqsE.filter(r => A.linkOf(r)?.tree === tree);
      const est = sum(rq.filter(r => OPEN_REQ.includes(r.status)).map(r => r.est_cost)), spent = spentFor(costs, rq.map(r => r.id));
      const word = v ? `${T.vWord} ${v.name || v.id}` : T.rootWord;
      const st = v?.status === 'review' || (head && !v) || (v && head) ? 'review' : 'draft';
      const legacy = !v && assetApproval(e, I.approvals).legacy;   // approved before the flow: no identity / base node yet
      rows.push({ key: `tree:${e.id}/${tree}`, group: stage, kind: 'tree', type: e.kind, id: `${e.id}/${tree}`, entity: e.id, tree, title: `${e.name || e.id} · ${word}`,
        sub: head ? `head ${head.id} · ${pl(nodes, 'node')}` : rq.some(r => OPEN_REQ.includes(r.status)) ? 'sheet requested' : v ? `no ${T.vWord} sheet yet` : e.base?.refs?.length || e.base?.text ? 'base chosen, no sheet yet' : 'needs a base',
        thumb: head?.image || (legacy ? e.identity_sheet || e.sheet || e.face || e.establishing || e.hero || null : null), private: !!head?.private, status: v ? v.status || 'draft' : head ? 'not approved' : legacy ? 'legacy' : 'no sheet', st,
        why: head ? `${word} not approved` : legacy ? `approved before the flow: import its image as the ${T.rootWord} node, then approve` : `no ${v ? T.vWord + ' sheet' : T.sheetWord} yet`, est_usd: est || null, spent_usd: spent || null,
        targets: [{ stage, kind: 'tree', id: `${e.id}/${tree}` }, { stage, kind: 'asset', id: e.id }], jump: { stage, focus: e.id },
        act: { ...(head ? { approve: { kind: 'tree', type: e.kind, id: e.id, tree, node: head.id } } : {}), changes: { kind: 'tree', type: e.kind, id: e.id, tree, variant: v?.id || null, vstatus: v?.status || null } } });
    };
    if (!A.approvedNode(it, T.root)) treeRow(T.root, null);
    for (const v of A.variants(e, e.kind)) if (v.status !== 'approved' && !A.approvedNode(it, A.variantTree(e.kind, v.id))) treeRow(A.variantTree(e.kind, v.id), v);
  }

  // 6. storyboard: shots (approvals.json shot:<id>) and clip uses (use:<id>) not approved / locked
  const ap = (k) => I.approvals?.items?.[k]?.state || 'draft';
  for (const s of shots) {
    const st = ap('shot:' + s.id); if (DONE.includes(st)) continue;
    const rq = SB.shotRequests(reqs, s.id), open = rq.filter(r => OPEN_REQ.includes(r.status));
    const est = open.length ? sum(open.map(r => r.est_cost)) : (s.clips || []).length || rq.some(r => r.status === 'done') ? 0 : SB.shotEstimate(s).usd;
    const thumb = s.sketch ? `sketches/${s.sketch}.png` : s.thumb || null, c = I.approvals?.items?.['shot:' + s.id]?.comment;
    rows.push({ key: 'shot:' + s.id, group: 'storyboard', kind: 'shot', id: s.id, title: s.title || clip(s.text, 60) || s.id, sub: `${s.kind || ''}${s.scene ? ' · ' + s.scene : ''}${s.text && s.title ? ' · ' + clip(s.text, 80) : ''}`,
      t0: s.t0, t1: s.t1, thumb, status: st, st: ST.includes(st) ? st : 'draft', why: st === 'changes' ? (c ? 'changes: ' + clip(c, 80) : 'changes asked') : st === 'review' ? 'waiting for your look' : 'shot not approved',
      est_usd: est || null, spent_usd: spentFor(costs, rq.map(r => r.id)) || null, targets: [{ stage: 'final', kind: 'shot', id: s.id }, { stage: 'storyboard', kind: 'shot', id: s.id }],
      jump: { stage: 'storyboard', focus: s.id }, act: { approve: { kind: 'approvals', key: 'shot:' + s.id }, changes: { kind: 'approvals', key: 'shot:' + s.id } } });
  }
  for (const u of I.uses || []) {
    const st = ap('use:' + u.id); if (DONE.includes(st)) continue;
    const sh = shots.find(s => (s.clips || []).includes(u.id)) || shots.find(s => s.t0 <= u.t0 && u.t0 < s.t1);
    rows.push({ key: 'use:' + u.id, group: 'storyboard', kind: 'use', id: u.id, title: u.label || `clip ${u.clip}`, sub: `clip ${u.clip} · take ${u.take ?? 0} · in ${u.in_ms ?? 0} ms${sh ? ' · ' + sh.id : ''}`,
      t0: u.t0, t1: u.t1, thumb: u.thumb || u.start_image || null, status: st, st: ST.includes(st) ? st : 'draft', why: st === 'changes' ? 'changes asked' : 'take not approved',
      targets: sh ? [{ stage: 'final', kind: 'shot', id: sh.id }] : [{ stage: 'final', kind: 'stage', id: null }], jump: { t: u.t0 },
      act: { approve: { kind: 'approvals', key: 'use:' + u.id }, changes: { kind: 'approvals', key: 'use:' + u.id } } });
  }

  // 7. draft requests (a render job is not approved: the director starts it with Render…, E4: Final › Renders and sheets)
  for (const r of reqs.filter(x => x.status === 'draft' && x.kind !== 'render')) {
    const l = A.linkOf(r), shotId = /^shot:/.test(r.target || '') ? r.target.slice(5) : null, sh = shotId ? shots.find(s => s.id === shotId) : null;
    const stage = l ? A.TYPE[l.type || 'character']?.stage : null;
    const targets = l ? [{ stage, kind: 'tree', id: `${l.id}/${l.tree || A.rootTree(l.type || 'character')}` }] : sh ? [{ stage: 'final', kind: 'shot', id: sh.id }] : [{ stage: 'final', kind: 'stage', id: null }];
    rows.push({ key: 'request:' + r.id, group: 'requests', kind: 'request', id: r.id, title: `${r.kind || 'request'} · ${r.id}`, sub: `${r.target || (l ? `${l.type || 'character'}:${l.id} ${l.tree || ''}` : '')}${r.tool ? ' · ' + r.tool : ''}${r.prompt ? ' · ' + clip(r.prompt, 90) : ''}`,
      ...(sh ? { t0: sh.t0, t1: sh.t1 } : {}), thumb: null, status: 'draft', st: 'draft', why: (r.warnings || []).length ? '⚠ ' + clip(r.warnings[0], 80) : `by ${r.by || 'agent'}: approve to commit $${money(r.est_cost).toFixed(2)}`,
      est_usd: money(r.est_cost) || null, spent_usd: null, commit_usd: money(r.est_cost), targets, jump: { view: 'queue' },
      act: { approve: { kind: 'request', id: r.id }, changes: { kind: 'request', id: r.id } } });
  }
  for (const r of rows) r.notes_open = openOn(r.targets);

  // ------------------------------------------------------------------ costs (the merged ledger when given: costs_get)
  const cv = SB.costView(costs, reqs), L = I.ledger;
  const gaps = SB.boardGaps({ song, scenes, shots, entities: ents, approvals: I.approvals, requests: reqs });
  const spent = L ? money(L.total_spent_usd ?? L.spent_usd) : cv.spent, committed = L ? money(L.committed_usd) : cv.committed, drafts = L ? money(L.drafts_usd) : cv.drafts;
  const cap = L ? money(L.cap_usd) : cv.cap, toRequest = money(gaps.estimate.usd);
  const remainingEst = money(drafts + toRequest), projected = money(spent + committed + remainingEst);
  const costView = { cap, spent, committed, drafts, to_request: toRequest, to_request_shots: gaps.estimate.shots, est_remaining: remainingEst, projected,
    left: money(cap - spent - committed), within: spent + committed <= cap + 1e-9, projected_within: projected <= cap + 1e-9, merged: !!L, warnings: L?.warnings || [], sources: (L?.sources || []).map(x => ({ id: x.id, label: x.label, usd: money(x.usd), rows: x.rows ?? null })) };

  // ------------------------------------------------------------------ the "ready to render" checklist (derived, never stored)
  const C = [];
  const add = (id, label, ok, detail, gaps = [], warn = null) => C.push({ id, label, ok: !!ok, detail, gaps: gaps.slice(0, 12), more: Math.max(0, gaps.length - 12), ...(warn ? { warn } : {}) });
  const unscripted = scriptGaps(scenes, dur);
  add('scripted', 'every second of the song is scripted', dur > 0 && scenes.length && !unscripted.length,
    !scenes.length ? 'no scenes yet' : unscripted.length ? `${Math.round(unscripted.reduce((a, [x, y]) => a + y - x, 0) / 1000)} s unscripted in ${pl(unscripted.length, 'gap')}` : `${pl(scenes.length, 'scene')} cover ${span(0, dur)}`,
    unscripted.map(([t0, t1]) => ({ label: span(t0, t1), jump: { stage: 'script', t: t0 } })));
  const noShots = scenes.filter(s => !shots.some(x => x.scene === s.id));
  add('shots', 'every scene has shots', scenes.length && !noShots.length, noShots.length ? `${pl(noShots.length, 'scene')} without shots` : scenes.length ? `${pl(shots.length, 'shot')} in ${pl(scenes.length, 'scene')}` : 'no scenes yet',
    noShots.map(s => ({ label: `${s.id} ${clip(s.title, 30)}`, jump: { stage: 'storyboard', focus: null, scene: s.id } })));
  const shotMissing = [];
  for (const s of shots) {
    const st = ap('shot:' + s.id), m = shotMedia(s, { uses: I.uses || [], requests: reqs, media: I.media || [] });
    if (!DONE.includes(st) || !m.length) shotMissing.push({ label: `${s.id} ${!m.length ? 'no frame, take or clip' : st}`, jump: { stage: 'storyboard', focus: s.id } });
  }
  add('frames', 'every shot has an approved frame, take or clip', shots.length && !shotMissing.length, !shots.length ? 'no shots yet' : shotMissing.length ? `${pl(shotMissing.length, 'shot')} of ${shots.length} not ready` : `${pl(shots.length, 'shot')} approved with media`, shotMissing);
  const tk = takesChecklist(shots);
  add('takes', 'every shot has a picked take', tk.ok, !shots.length ? 'no shots yet' : `${tk.done} of ${pl(tk.total, 'shot')} picked${tk.missing.length ? ` · ${tk.missing.length} to pick` : ''}`,
    tk.missing.map(id => ({ label: `${id} no take picked`, jump: { stage: 'storyboard', focus: id } })));
  // E2, the lyric gate: every sung or spoken word on a desktop surface (a shot's lyrics[]) at its time
  const lg = gateCheck(song, shots);
  add('lyrics', 'every word on a surface', lg.ok, lg.detail,
    lg.gaps.map(g => { const sh = shots.find(x => x.t0 <= g.t0 && g.t0 < x.t1); return { label: g.label, jump: sh ? { stage: 'storyboard', focus: sh.id } : { stage: 'storyboard', t: g.t0 } }; }));
  add('assets', 'every asset the shots need is approved', !gaps.assets.length, gaps.assets.length ? `${pl(gaps.assets.length, 'asset')} not approved` : 'all approved',
    gaps.assets.map(a => ({ label: `${a.name}${a.variant ? ' · ' + a.variant_name : ''}: ${a.why || 'not approved'}`, jump: { stage: A.TYPE[a.type]?.stage || 'characters', focus: a.id } })));
  // E6, looks per context: a cast character of a shot with a world wears its look for that world
  add('looks', "every character wears the look of the shot's world", !gaps.looks.length, gaps.looks.length ? `${pl(gaps.looks.length, 'look')} off their world` : 'every look matches its world',
    gaps.looks.map(l => ({ label: `${l.shot} · ${l.name}: ${l.why}`, jump: { stage: 'storyboard', focus: l.shot } })));
  const oc = N.openCounts(notes), live = inFlight(I.revisions);
  add('notes', 'no open notes', !oc.total, oc.total ? `${pl(oc.total, 'open note')}${oc.asks ? ` (${pl(oc.asks, 'ask')} for the agent)` : ''}` : 'none open',
    Object.entries(oc.stages).filter(([, n]) => n).map(([s, n]) => ({ label: `${N.STAGE_TITLE[s] || s}: ${n}`, jump: s === 'timeline' ? { view: 'notes' } : { stage: s } })));
  add('round', 'no open review round', !live, live ? `round ${live.n} is ${live.status === 'sent' ? 'with the agent' : 'finished: close its revision on the rail'}` : 'none in flight', live ? [{ label: `round ${live.n}`, jump: { view: 'compare' } }] : []);
  add('cap', 'costs are within the cap', costView.within, `$${spent} spent + $${committed} committed of $${cap}${cap ? '' : ' (cap 0 blocks paid runs)'}`,
    costView.within ? [] : [{ label: 'Review › Costs', jump: { view: 'costs' } }], !costView.projected_within ? `projected $${projected} with the drafts and the shots not requested yet` : costView.warnings[0] || null);
  const noMedia = [], privOnly = [];
  for (const s of shots) { const m = shotMedia(s, { uses: I.uses || [], requests: reqs, media: I.media || [] }); if (!m.length) noMedia.push(s); else if (m.every(x => isPriv(x.path))) privOnly.push(s); }
  const hasSong = !!song.audio?.mix;
  add('export', 'an export is possible', hasSong && shots.length && !noMedia.length && !privOnly.length,
    !hasSong ? 'no song file' : !shots.length ? 'no shots' : noMedia.length || privOnly.length ? [noMedia.length ? `${pl(noMedia.length, 'shot')} without media` : '', privOnly.length ? `${pl(privOnly.length, 'shot')} with private media only (never exported)` : ''].filter(Boolean).join(' · ') : 'song + media for every shot, none private',
    [...(!hasSong ? [{ label: 'song file', jump: { stage: 'lyrics' } }] : []), ...noMedia.map(s => ({ label: `${s.id} no media`, jump: { stage: 'storyboard', focus: s.id } })), ...privOnly.map(s => ({ label: `${s.id} private only`, jump: { stage: 'storyboard', focus: s.id } }))]);

  const groups = GROUPS.map(g => ({ ...g, rows: rows.filter(r => r.group === g.id) })).filter(g => g.rows.length);
  const counts = { total: rows.length, ...Object.fromEntries(ST.map(s => [s, rows.filter(r => r.st === s).length])), notes: rows.filter(r => r.notes_open).length,
    by_group: Object.fromEntries(groups.map(g => [g.id, g.rows.length])) };
  // E3: the chapters with their derived build status (planned / generating / built / approved)
  const chapters = chaptersView(I.board, { scenes, shots, approvals: I.approvals, requests: reqs }).map(({ shot_ids: _s, ...c }) => c);
  return { rows, groups, counts, checklist: C, ready: C.every(c => c.ok), failing: C.filter(c => !c.ok).map(c => c.id), costs: costView, lock: lockOf(I.revisions), chapters };
}

// what approving a set of rows commits: drafts become approved requests (their estimate is committed); the rest spend nothing
export function approveImpact(rows, costs) {
  const commit = sum(rows.map(r => r.commit_usd || 0)), can = rows.filter(r => r.act?.approve);
  return { n: can.length, skipped: rows.length - can.length, commit_usd: commit, est_usd: sum(can.map(r => r.est_usd || 0)),
    after: costs ? { committed: money(costs.committed + commit), left: money(costs.left - commit), over: costs.spent + costs.committed + commit > costs.cap + 1e-9 } : null };
}
