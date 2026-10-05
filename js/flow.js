// The guided creation flow (docs/SPEC_v3_GUIDED.md): the seven stages and the lyrics model. Pure functions, no DOM and
// no Node APIs: the page (tabs/lyrics.js, core/rail.js) and the data layer (lib/store.mjs) import the same code, so
// both derive the same defaults, the same line ids and the same song timings.
//
// stages.json  {rev, stages: [{id, status, done_by?, via?, updated?, blockers[], note?}]}
//   id      lyrics | script | breakdown | characters | scenery | storyboard | final   (always all seven, in this order)
//   status  empty | in_progress | needs_you | done      (only the page sets done: serve.mjs stamps done_by/via "page")
//   A project without the file reads as derived: nothing is done; a stage whose files hold content is in progress.
//   What the rail shows is computed from the content too: stagesView below (ROADMAP_v4 F1).
// lyrics.json  {rev, current: "v3", seq, versions: [{id, n, created, by, via, message, from?, sections: [{id, label,
//   lines: [{id, text, t?}]}]}], notes: [{id, line, w: [w0, w1] | null, quote, text, by, via, to?, kind?, status,
//   at, version, replies: [{id, text, by, via, at}], resolved_by?, resolved_at?}]}
//   A version is immutable; a save appends one and moves `current`; a restore appends a copy. Line ids are stable
//   across versions (a changed line keeps its id, so its timings and notes follow it); song.json lines use the same
//   ids. A project without the file reads as one version derived from song.json (ids = the song's line ids).
// scenes.json (stage 2, the script draft): js/scenes.js. breakdown.json (stage 3): js/breakdown.js. storyboard.json
// (stage 6): js/storyboard.js.
import { currentScript, gaps as scriptGaps, intakeOpen, INTAKE } from './scenes.js';
import { currentBreakdown, PROMOTABLE } from './breakdown.js';
import { currentBoard } from './storyboard.js';
import * as A from './assets.js';
import { isV2 as notesV2, openAsks } from './notes.js';

export const STAGES = [
  { id: 'lyrics', title: 'Lyrics', n: 1, does: 'the poem: lines, sections, notes, versions; the song file when you have it' },
  { id: 'script', title: 'Script', n: 2, does: 'intake questions, then scenes bound to song time with beats, text and sketches' },
  { id: 'breakdown', title: 'Breakdown', n: 3, does: 'characters, locations, props, wardrobe and FX extracted from the script' },
  { id: 'characters', title: 'Characters', n: 4, does: 'identity sheets and looks per character, iterated with sketch + text' },
  { id: 'scenery', title: 'Scenery', n: 5, does: 'locations and props: bases, variants, iterations' },
  { id: 'storyboard', title: 'Storyboard', n: 6, does: 'shots per scene with frame sketches; the remaining gaps filled' },
  { id: 'final', title: 'Final', n: 7, does: 'everything still draft / changes / review, costs, ready-to-render checklist' },
];
export const STAGE_STATUSES = ['empty', 'in_progress', 'needs_you', 'done'];
export const STATUS_LABEL = { empty: 'empty', in_progress: 'in progress', needs_you: 'needs you', done: 'done' };
export const stageById = (id) => STAGES.find(s => s.id === id);

// ------------------------------------------------------------------ stage status from content (ROADMAP_v4 F1)
// Two things are kept apart:
//   status   what stages.json stores: the director's mark (done, page only) or an agent's flag (empty / in_progress /
//            needs_you). A project without stages.json, or a "done" that was derived (done_by "derived", written by
//            older versions), is never done: it reads as in_progress when the files hold content.
//   content  what the files hold, per stage: {status: empty | in_progress | needs_you | ready, blockers[], hints[],
//            counts}. blockers stop "ready"; hints are advisory (no song file yet, entities from before the flow).
//   shown    what the rail and the stage bar show: done only when the director marked it AND the content is still
//            ready; a done whose content regressed shows "changed" (done ⚠ changed since) with the reason; a stage the
//            director or an agent flagged needs_you stays needs_you; else the content status (ready = ready to mark done).
export const SHOWN_LABEL = { empty: 'empty', in_progress: 'in progress', needs_you: 'needs you', ready: 'ready to mark done', done: 'done', changed: 'done ⚠ changed since' };
const pl = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const LEGACY_STATES = ['approved', 'locked'];

// One definition of "approved" for an asset (character, location, prop), shared by Assets and the stage workspaces:
// approved = the root tree (identity / base) has an approved node. An approval from before the flow (approvals.json
// "<kind>:<id>" approved / locked, or entity.status "approved") without that node is "approved (legacy)": shown as
// such everywhere, and it does not satisfy stage 4 / 5.
//   -> {key: approved | legacy | none, approved, legacy, nodes, node?, label, title}
export function assetApproval(ent, approvals) {
  const type = A.TYPE[ent?.kind] ? ent.kind : 'character', T = A.TYPE[type], it = A.normIter(ent?.iter);
  const nodes = A.treeNodes(it, T.root).length, ap = A.approvedNode(it, T.root);
  const st = approvals?.items?.[`${type}:${ent?.id}`]?.state;
  const legacy = st ? LEGACY_STATES.includes(st) : ent?.status === 'approved';   // the Assets approval wins over the entity's own status
  if (ap) return { key: 'approved', approved: true, legacy: false, nodes, node: ap.id, label: `${T.rootWord} approved`, title: `${T.rootWord} approved in stage ${T.stage === 'characters' ? 4 : 5} (node ${ap.id})` };
  if (legacy) return { key: 'legacy', approved: false, legacy: true, nodes, label: nodes ? `approved (legacy) · ${T.rootWord} not approved` : `approved (legacy) · no ${T.rootWord} node`,
    title: `approved before the guided flow (${st ? 'Assets approval: ' + st : 'entity status approved'}), but the ${T.rootWord} tree of stage ${T.stage === 'characters' ? 4 : 5} ${nodes ? `has ${pl(nodes, 'node')} and none is approved` : 'is empty'}: import an existing image as the ${T.rootWord} (no request, nothing paid), then approve it` };
  const base = !!(ent?.base?.refs?.length || ent?.base?.text);
  return { key: 'none', approved: false, legacy: false, nodes, label: nodes ? `${T.rootWord} · ${pl(nodes, 'node')}` : base ? 'base chosen' : 'needs a base', title: '' };
}
// the stage-4/5 facts of one asset entity
function assetFact(e, approvals) {
  const it = A.normIter(e?.iter), a = assetApproval(e, approvals);
  return { id: e.id, kind: e.kind, name: e.name || e.id, approval: a.key, label: a.label,
    waiting: it.nodes.filter(n => A.pending(it, n)).length, proposals: (it.base_proposal ? 1 : 0) + (it.proposals || []).filter(x => x?.status === 'open').length,
    review: A.variants(e, e.kind).filter(v => v.status === 'review').length };
}

// what the project files already hold (the page passes its store, the server reads the files). `entities` are the full
// entity files (the page) or only entities/index.json (then assetsKnown is false: the identity / base trees are unknown).
// `notes` = notes.json v2 (js/notes.js): the open asks for the agent per stage come from it (else from the old stores)
export function projectFacts({ song, script, shots, entities, lyrics, scenes, breakdown, storyboard, approvals, notes }) {
  const askN = (stage, old) => notesV2(notes) ? openAsks(notes, stage).length : (old?.notes || []).filter(n => n.status === 'open' && n.to === 'agent').length;
  const ents = (entities || []).filter(e => e && typeof e === 'object');
  const bitems = (currentBreakdown(breakdown)?.items || []).filter(i => !i.dropped);
  const sv = currentScript(scenes), dur = song?.duration_ms || 0;
  const bstate = (i) => breakdown?.states?.[i.id]?.status || 'draft';
  const assetsKnown = !ents.length || ents.some(e => !e.path || 'iter' in e || 'looks' in e || 'variants' in e || 'base' in e);
  const af = (kind) => assetsKnown ? ents.filter(e => e.kind === kind).map(e => assetFact(e, approvals)) : [];
  return {
    scenes: sv?.scenes?.length || 0, gapMs: sv ? scriptGaps(sv.scenes, dur).reduce((a, [x, y]) => a + y - x, 0) : dur,
    intakeOpen: scenes ? intakeOpen(scenes).length : 0, intakeAnswered: scenes ? INTAKE.length - intakeOpen(scenes).length : 0,
    sceneAsks: askN('script', scenes),
    scenesNeedYou: sv ? sv.scenes.filter(s => scenes?.states?.[s.id]?.status === 'needs_you').length : 0,
    lines: song?.lines?.length || 0, hasSong: !!song?.audio?.mix, timing: song?.timing || null,
    script: script?.lines?.length || 0, shots: shots?.length || 0,
    characters: ents.filter(e => e.kind === 'character').length, locations: ents.filter(e => e.kind === 'location').length,
    props: ents.filter(e => e.kind === 'prop').length,
    agentAsks: askN('lyrics', lyrics),
    items: bitems.length, itemsToPromote: bitems.filter(i => PROMOTABLE.includes(i.kind) && !breakdown?.states?.[i.id]?.entity_id).length,
    itemsReview: bitems.filter(i => bstate(i) === 'review').length, itemsDraft: bitems.filter(i => bstate(i) === 'draft').length,
    sceneryToPromote: bitems.filter(i => (i.kind === 'location' || i.kind === 'prop') && !breakdown?.states?.[i.id]?.entity_id).length,
    breakdownAsks: askN('breakdown', breakdown),
    // stages 4 and 5: per asset, where its identity / base stands (assetApproval)
    assetsKnown, assets: { character: af('character'), location: af('location'), prop: af('prop') },
    // stage 6: the storyboard (a project without storyboard.json reads its shots from shots.json)
    ...(() => { const bs = currentBoard(storyboard)?.shots || [];
      return { boardShots: bs.length, scenesNoShots: sv && storyboard ? sv.scenes.filter(s => !bs.some(x => x.scene === s.id)).length : 0, shotsNoFrame: bs.filter(s => !s.sketch && !s.thumb).length,
        boardAsks: askN('storyboard', storyboard) }; })(),
  };
}
const asks = (n) => n ? [`${pl(n, 'open ask')} for the agent`] : [];
// a stage's own content -> {status: empty | in_progress | needs_you | ready, blockers[] (stop ready), hints[], counts}
function assetsContent(f, kinds, toPromote, word) {
  const list = kinds.flatMap(k => f.assets?.[k] || []), n = kinds.reduce((a, k) => a + (f[k === 'character' ? 'characters' : k + 's'] || 0), 0);
  const c = { assets: n, approved: list.filter(x => x.approval === 'approved').length, legacy: list.filter(x => x.approval === 'legacy').length,
    needsBase: list.filter(x => x.approval === 'none' && x.label === 'needs a base').length, waiting: list.reduce((a, x) => a + x.waiting, 0),
    proposals: list.reduce((a, x) => a + x.proposals, 0), review: list.reduce((a, x) => a + x.review, 0), toPromote };
  if (!n && !toPromote) return { status: 'empty', blockers: [`no ${kinds.map(k => k === 'character' ? 'characters' : k + 's').join(' or ')} yet`], hints: [], counts: c };
  const you = [], work = [], hints = [];
  if (toPromote) you.push(`${pl(toPromote, 'breakdown item')} not yet entities`);
  if (!f.assetsKnown) work.push(`${word} state unknown here (only the entity index was read)`);
  for (const x of list) {
    if (x.approval === 'legacy') you.push(`${x.name}: ${x.label}`);
    else if (x.approval === 'none') (x.label === 'base chosen' && !x.waiting && !x.proposals ? work : you).push(`${x.name}: ${x.label}`);
  }
  if (c.waiting) you.push(`${pl(c.waiting, 'new node')} to keep / branch / revert`);
  if (c.proposals) you.push(`${pl(c.proposals, 'agent proposal')} to accept or dismiss`);
  if (c.review) you.push(`${pl(c.review, 'variant')} in review`);
  return { status: you.length ? 'needs_you' : work.length ? 'in_progress' : 'ready', blockers: [...you, ...work], hints, counts: c };
}
export function stageContent(id, f) {
  switch (id) {
    case 'lyrics': {
      const counts = { lines: f.lines || 0, asks: f.agentAsks || 0, song: !!f.hasSong };
      if (!f.lines) return { status: 'empty', blockers: ['no lyrics yet'], hints: [], counts };
      const b = asks(f.agentAsks);
      return { status: b.length ? 'in_progress' : 'ready', blockers: b, hints: f.hasSong ? [] : ['no song file yet (timings estimated)'], counts };
    }
    case 'script': {
      const gapS = f.scenes ? Math.round((f.gapMs || 0) / 1000) : 0;
      const counts = { scenes: f.scenes || 0, intakeOpen: f.intakeOpen || 0, scenesNeedYou: f.scenesNeedYou || 0, unscriptedS: gapS, asks: f.sceneAsks || 0, legacyLines: f.script || 0 };
      // nothing written yet (no scene, no legacy script, no intake answer): empty, whatever the open questions
      if (!f.scenes && !f.script && !f.intakeAnswered) return { status: 'empty', blockers: ['no scenes yet', ...(f.intakeOpen ? [`${pl(f.intakeOpen, 'intake question')} open`] : [])], hints: [], counts };
      // review #3: open intake questions are a hint once there are scenes (the questions help the draft; a complete script
      // with every scene ok is ready, and "next:" moves on); before any scene they still need the director
      const intake = f.intakeOpen ? [`${pl(f.intakeOpen, 'intake question')} open`] : [];
      const you = [...(f.scenes ? [] : intake), ...(f.scenesNeedYou ? [`${pl(f.scenesNeedYou, 'scene')} flagged needs you`] : [])];
      const work = [...(f.scenes ? (f.gapMs >= 1000 ? [`${gapS} s unscripted`] : []) : ['no scenes yet']), ...asks(f.sceneAsks)];
      return { status: you.length ? 'needs_you' : work.length ? 'in_progress' : 'ready', blockers: [...you, ...work], hints: f.scenes ? intake : [], counts };
    }
    case 'breakdown': {
      const ents = f.characters + f.locations + f.props;
      const counts = { items: f.items || 0, review: f.itemsReview || 0, draft: f.itemsDraft || 0, asks: f.breakdownAsks || 0, entities: ents };
      if (!f.items) return { status: 'empty', blockers: ['no items yet', ...asks(f.breakdownAsks)], hints: ents ? [`${pl(ents, 'entity', 'entities')} from before the flow (not a breakdown)`] : [], counts };
      const you = [...(f.itemsReview ? [`${pl(f.itemsReview, 'item')} in review`] : []), ...(f.itemsDraft ? [`${pl(f.itemsDraft, 'item')} not ok yet`] : [])];
      const work = asks(f.breakdownAsks);
      return { status: you.length ? 'needs_you' : work.length ? 'in_progress' : 'ready', blockers: [...you, ...work], hints: [], counts };
    }
    case 'characters': return assetsContent(f, ['character'], f.itemsToPromote || 0, 'identity');
    case 'scenery': return assetsContent(f, ['location', 'prop'], f.sceneryToPromote || 0, 'base');
    case 'storyboard': {
      const counts = { shots: f.boardShots || 0, legacyShots: f.shots || 0, scenesNoShots: f.scenesNoShots || 0, shotsNoFrame: f.shotsNoFrame || 0, asks: f.boardAsks || 0 };
      if (!f.boardShots && !f.shots) return { status: 'empty', blockers: [f.scenesNoShots ? `${pl(f.scenesNoShots, 'scene')} without shots` : 'no shots yet'], hints: [], counts };
      const work = [...(f.boardShots ? [] : ['no storyboard yet (shots.json only)']), ...(f.scenesNoShots ? [`${pl(f.scenesNoShots, 'scene')} without shots`] : []),
        ...(f.shotsNoFrame ? [`${pl(f.shotsNoFrame, 'shot')} without a frame`] : []), ...asks(f.boardAsks)];
      return { status: work.length ? 'in_progress' : 'ready', blockers: work, hints: [], counts };
    }
    default: return { status: 'empty', blockers: [], hints: [], counts: {} };
  }
}
// a project without stages.json: nothing is done (only the director marks done); a stage with content is in progress
export function deriveStages(f) {
  return { rev: 0, derived: true, stages: STAGES.map(s => ({ id: s.id, status: s.id !== 'final' && stageContent(s.id, f || {}).status !== 'empty' ? 'in_progress' : 'empty', blockers: [] })) };
}
// any stages.json (or none) -> all seven stages in order, unknown statuses read as empty; a derived "done" is not done
export function normStages(doc, facts) {
  if (!doc || !Array.isArray(doc.stages)) return deriveStages(facts || {});
  const by = new Map(doc.stages.filter(s => s && typeof s === 'object').map(s => [s.id, s]));
  return { ...doc, stages: STAGES.map(s => {
    const x = { ...(by.get(s.id) || {}) };
    if (x.status === 'done' && x.done_by === 'derived') { x.status = 'in_progress'; delete x.done_by; }
    return { ...x, id: s.id, status: STAGE_STATUSES.includes(x.status) ? x.status : 'empty', blockers: Array.isArray(x.blockers) ? x.blockers : [] };
  }) };
}
// stored status + content -> shown status (and the reason of a "changed")
function shownOf(s, c) {
  // (review #3: the director's own open asks for the agent never undo their "done": they wait for an agent, a hint)
  if (s.status === 'done' && c.status !== 'empty' && c.blockers.length && c.blockers.every(b => / open asks? for the agent$/.test(b))) return { shown: 'done' };
  if (s.status === 'done') return c.status === 'ready' ? { shown: 'done' } : { shown: 'changed', changed: `${s.done_ok === false ? 'marked done while not ready' : 'changed since marked done'}: ${c.blockers.join('; ') || c.status}` };
  if (s.status === 'needs_you') return { shown: 'needs_you' };
  if (c.status === 'empty' && s.status === 'in_progress') return { shown: 'in_progress' };
  return { shown: c.status };
}
export function stagesView(doc, facts) {
  const f = facts || {}, n = normStages(doc, f), out = [];
  for (const s of n.stages) {
    const d = stageById(s.id);
    let c;
    if (s.id === 'final') {
      const open = out.filter(x => x.shown !== 'done');
      c = { status: open.length ? (out.some(x => x.content.status !== 'empty') ? 'in_progress' : 'empty') : 'ready', blockers: open.length ? [`${pl(open.length, 'stage')} not done (${open.map(x => x.title.toLowerCase()).join(', ')})`] : [], hints: [], counts: { stagesNotDone: open.length } };
    } else c = stageContent(s.id, f);
    const up = { script: ['lyrics'], breakdown: ['script'], characters: ['breakdown'], scenery: ['breakdown'], storyboard: ['script'] }[s.id] || [];
    const waits = up.filter(u => out.find(x => x.id === u)?.shown !== 'done').map(u => `${stageById(u).title.toLowerCase()} not done`);
    const sh = shownOf(s, c);
    out.push({ ...s, title: d.title, n: d.n, content: c, ...sh, shown_label: sh.shown === 'changed' && s.done_ok === false ? 'done ⚠ not ready' : SHOWN_LABEL[sh.shown],
      blockers_all: [...s.blockers, ...waits, ...c.blockers, ...c.hints] });
  }
  // "next:" from the F1 status of each stage: first what needs the director (needs you / changed since done), then the first
  // stage with work left (empty / in progress; Final only once the others are done or ready), then a stage that is ready to
  // mark done. A stage that is ready but not marked no longer holds the hint back (review #3: it stayed on Script)
  const next = out.find(s => s.shown === 'needs_you' || s.shown === 'changed')
    || out.find(s => s.id !== 'final' && ['empty', 'in_progress'].includes(s.shown))
    || out.find(s => s.shown !== 'done') || null;
  return { rev: n.rev || 0, derived: !!n.derived, stages: out, next: next ? { id: next.id, title: next.title, status: next.status, shown: next.shown, blockers: next.blockers_all } : null };
}
// the rail / stage-bar tooltip of a stage: status, why, what blocks it
export function stageTip(s) {
  const c = s.content || { blockers: [], hints: [], counts: {} };
  const by = s.status === 'done' ? ` (marked by the ${s.done_by || 'director'}${s.updated ? ' ' + s.updated : ''})` : '';
  const counts = Object.entries(c.counts || {}).filter(([, v]) => v && typeof v !== 'boolean').map(([k, v]) => `${k} ${v}`).join(' · ');
  return [`${s.n} ${s.title}: ${s.shown_label}${by}`, ...(s.changed ? [`⚠ ${s.changed}`] : []), ...(counts ? [counts] : []),
    ...(s.blockers_all.length ? ['blockers:', ...s.blockers_all.map(b => '· ' + b)] : ['nothing blocking'])].join('\n');
}

// ------------------------------------------------------------------ lyrics: text <-> structure
const LRC_TAG = /\[(\d+):(\d+(?:\.\d+)?)\]/g, LRC_LINE = /^\s*((?:\[\d+:\d+(?:\.\d+)?\]\s*)+)(.*)$/;
const HEAD = /^\s*(?:\[([^\]\d][^\]]*)\]|#+\s*(.+))\s*$/, META = /^\s*\[(ar|ti|al|by|offset|length|re|ve):/i;
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'part';
export const words = (text) => String(text || '').split(/\s+/).filter(Boolean);
// plain text (with [Verse 1] / # Chorus headers, blank lines between untagged blocks, optional LRC time tags) ->
// [{label, lines: [{text, t?}]}]; no ids yet
export function parseText(text) {
  const blocks = []; let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (META.test(raw)) continue;
    const l = LRC_LINE.exec(raw), h = !l && HEAD.exec(raw);
    if (h) { cur = { label: (h[1] || h[2]).trim(), lines: [], explicit: true }; blocks.push(cur); continue; }
    if (!raw.trim()) { if (cur && cur.lines.length && !cur.explicit) cur = null; continue; }
    let t = null, txt = raw.trim();
    if (l) { const m = [...l[1].matchAll(LRC_TAG)][0]; t = Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000); txt = l[2].trim(); if (!txt) continue; }
    if (!cur) { cur = { label: null, lines: [] }; blocks.push(cur); }
    cur.lines.push(t != null ? { text: txt, t } : { text: txt });
  }
  const bl = blocks.filter(b => b.lines.length || b.explicit);
  return bl.map((b, i) => ({ label: b.label || (bl.length === 1 ? 'Song' : `Part ${i + 1}`), lines: b.lines }));
}
export function versionText(v) {
  return (v?.sections || []).map(s => `[${s.label}]\n${s.lines.map(l => l.text).join('\n')}`).join('\n\n');
}
export const flatLines = (v) => (v?.sections || []).flatMap(s => s.lines.map(l => ({ ...l, section: s.id, label: s.label })));
const maxSeq = (doc, v) => Math.max(doc?.seq || 0, ...[...(doc?.versions || []), ...(v ? [v] : [])].flatMap(x => flatLines(x)).map(l => /^L(\d+)$/.exec(l.id)?.[1]).filter(Boolean).map(Number));
// longest common subsequence of two arrays (by key): pairs [i, j]
function lcs(a, b, key = (x) => x) {
  const n = a.length, m = b.length, A = a.map(key), B = b.map(key);
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { out.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return out;
}
// blocks from parseText -> a version body with ids: unchanged lines keep their id; inside each changed stretch, edited
// lines take the ids of the removed ones in order (so a reworded line keeps its timings and notes); the rest are new
export function assignIds(blocks, prev, doc) {
  const old = flatLines(prev), fresh = blocks.flatMap((b, bi) => b.lines.map(l => ({ ...l, bi })));
  const norm = (x) => x.text.trim().toLowerCase().replace(/\s+/g, ' ');
  const pairs = lcs(old, fresh, norm);
  let seq = maxSeq(doc, prev); const nid = () => `L${++seq}`;
  const ids = new Array(fresh.length).fill(null);
  let pi = 0, pj = 0;
  for (const [i, j] of [...pairs, [old.length, fresh.length]]) {
    const gapOld = old.slice(pi, i), gapNew = fresh.slice(pj, j);
    gapNew.forEach((_, k) => { ids[pj + k] = gapOld[k]?.id || null; });
    if (j < fresh.length) ids[j] = old[i].id;
    pi = i + 1; pj = j + 1;
  }
  const seen = new Set();
  fresh.forEach((l, k) => { if (!ids[k] || seen.has(ids[k])) ids[k] = nid(); seen.add(ids[k]); });
  // sections: same label (first unused) keeps its id, else a slug of the label
  const prevSecs = [...(prev?.sections || [])], used = new Set();
  let k = 0;
  const sections = blocks.map((b) => {
    let s = prevSecs.find(x => x.label === b.label && !used.has(x.id));
    let id = s?.id || slug(b.label); for (let n = 2; used.has(id); n++) id = `${slug(b.label)}-${n}`;
    used.add(id);
    return { id, label: b.label, lines: b.lines.map(l => ({ id: ids[k++], text: l.text, ...(l.t != null ? { t: l.t } : {}) })) };
  });
  return { sections, seq };
}
// song.json -> the version a project without lyrics.json reads as (ids = the song's line ids, labels = section labels)
export function versionFromSong(song, labels = {}) {
  const sections = [], lab = (id) => labels[id] || song.sections?.find(s => s.id === id)?.label || id;
  for (const l of [...(song?.lines || [])].sort((a, b) => a.t0 - b.t0)) {
    const sid = l.section || song.sections?.find(s => s.t0 <= l.t0 && l.t0 < s.t1)?.id || 'song';
    let s = sections[sections.length - 1];
    if (!s || s.id !== sid) { let id = sid; for (let n = 2; sections.some(x => x.id === id); n++) id = `${sid}-${n}`; s = { id, label: lab(sid), lines: [] }; sections.push(s); }
    s.lines.push({ id: l.id, text: l.text });
  }
  return sections;
}
export function emptyLyrics() { return { rev: 0, current: null, seq: 0, versions: [], notes: [] }; }
// any lyrics.json (or none) -> a usable doc; a missing / empty one derives version v1 from song.json
export function normLyrics(doc, song, labels) {
  const d = doc && Array.isArray(doc.versions) ? { notes: [], seq: 0, ...doc } : { ...emptyLyrics(), ...(doc && typeof doc === 'object' ? { rev: doc.rev || 0 } : {}) };
  if (!Array.isArray(d.notes)) d.notes = [];
  if (!d.versions.length && song?.lines?.length) {
    d.versions = [{ id: 'v1', n: 1, created: null, by: 'import', via: 'import', message: 'from song.json', sections: versionFromSong(song, labels) }];
    d.current = 'v1'; d.derived = true;
  }
  if (d.versions.length && !d.versions.some(v => v.id === d.current)) d.current = d.versions[d.versions.length - 1].id;
  return d;
}
export const currentVersion = (doc) => doc?.versions?.find(v => v.id === doc.current) || null;
export function addVersion(doc, sections, { by = 'director', via, message = '', from, created } = {}) {
  const n = Math.max(0, ...doc.versions.map(v => v.n || Number(String(v.id).replace(/\D/g, '')) || 0)) + 1;
  const v = { id: `v${n}`, n, created: created || new Date().toISOString().slice(0, 19), by, ...(via ? { via } : {}), message: String(message || ''), ...(from ? { from } : {}), sections: structuredClone(sections) };
  doc.versions.push(v); doc.current = v.id; doc.seq = Math.max(doc.seq || 0, maxSeq(doc));
  delete doc.derived;
  return v;
}
export const sameBody = (a, b) => JSON.stringify(a?.sections || a) === JSON.stringify(b?.sections || b);
// a lyrics.json from the page or an agent: the shape the tools rely on (throws a message on a bad file)
export function checkLyrics(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.versions) || !Array.isArray(d.notes || [])) throw new Error('lyrics.json: {versions[], notes[]} expected');
  const ids = new Set();
  for (const v of d.versions) {
    if (!v || typeof v.id !== 'string' || ids.has(v.id) || !Array.isArray(v.sections)) throw new Error('lyrics.json: every version needs a unique id and sections[]');
    ids.add(v.id); const L = new Set();
    for (const s of v.sections) {
      if (!s || typeof s.id !== 'string' || typeof s.label !== 'string' || !Array.isArray(s.lines)) throw new Error(`lyrics.json: ${v.id}: a section needs id, label, lines[]`);
      for (const l of s.lines) { if (!l || typeof l.id !== 'string' || typeof l.text !== 'string' || L.has(l.id)) throw new Error(`lyrics.json: ${v.id}: every line needs a unique id and text`); L.add(l.id); }
    }
  }
  if (d.versions.length && !ids.has(d.current)) throw new Error('lyrics.json: current must name a version');
  return d;
}
// a note's words on the line as it reads now: the stored range when the quote still matches, else the quote found
// again on the line, else null (the text changed: the note stays on the line, unanchored)
export function anchorWords(lineText, note) {
  if (!note?.w) return null;
  const ws = words(lineText), [a, b] = note.w, q = words(note.quote || '');
  if (a >= 0 && b < ws.length && a <= b && (!q.length || ws.slice(a, b + 1).join(' ') === q.join(' '))) return [a, b];
  if (q.length) for (let i = 0; i + q.length <= ws.length; i++) if (ws.slice(i, i + q.length).join(' ') === q.join(' ')) return [i, i + q.length - 1];
  return null;
}

// ------------------------------------------------------------------ word-level diff of two texts
// tokens: words and line breaks; result [{op: '=' | '-' | '+', w}] ('\n' tokens mark line breaks)
export function wordDiff(a, b) {
  const tok = (t) => String(t || '').split('\n').flatMap((ln, i) => [...(i ? ['\n'] : []), ...words(ln)]);
  const A = tok(a), B = tok(b), P = lcs(A, B);
  const out = []; let i = 0, j = 0;
  for (const [x, y] of [...P, [A.length, B.length]]) {
    while (i < x) out.push({ op: '-', w: A[i++] });
    while (j < y) out.push({ op: '+', w: B[j++] });
    if (x < A.length) { out.push({ op: '=', w: A[x] }); i = x + 1; j = y + 1; }
  }
  return out;
}
export const diffStats = (ops) => ({ added: ops.filter(o => o.op === '+' && o.w !== '\n').length, removed: ops.filter(o => o.op === '-' && o.w !== '\n').length });

// ------------------------------------------------------------------ lyrics -> song.json lines (timings)
// placeholder length of a song-less project: ~4 s a line plus intro/outro, 1-10 min
export const placeholderMs = (n) => Math.min(600000, Math.max(60000, Math.round((n * 4000 + 16000) / 2000) * 2000));
export function beatGrid(durMs, bpm = 120, beatsPerBar = 4, offset = 0) {
  const beat = 60000 / bpm, beats = [], downbeats = [];
  for (let k = Math.ceil(-offset / beat); ; k++) { const t = Math.round(offset + k * beat); if (t > durMs) break; if (t < 0) continue; beats.push(t); if (((k % beatsPerBar) + beatsPerBar) % beatsPerBar === 0) downbeats.push(t); }
  return { bpm, beat_ms: +beat.toFixed(3), bar_ms: +(beat * beatsPerBar).toFixed(3), beats_per_bar: beatsPerBar, grid: { beats, downbeats } };
}
const spreadWords = (text, t0, t1) => { const ws = words(text), d = (t1 - t0) / Math.max(1, ws.length); return ws.map((w, j) => { const a = Math.round(t0 + j * d); return { w, t0: a, t1: Math.max(a + 1, Math.round(t0 + (j + 0.9) * d)), p: 0 }; }); };
// The song's lines follow the lyrics version: a line whose id and text are unchanged is kept as is (word timings,
// voice, everything); a reworded line keeps its t0/t1 and gets its words re-spread; a new line is placed between its
// timed neighbours (LRC tag first, if it has one) and marked timing "estimated". Without a song file (audio.mix null)
// every line is estimated over a placeholder duration and the sections are rebuilt from the lyrics sections; with one,
// the song's sections stay (they are musical) unless they came from the lyrics (sections_from "lyrics").
// Returns the new song object (or the same object when nothing changed).
export function syncSong(song, version, { reestimate = false } = {}) {
  const flat = flatLines(version);
  const hasAudio = !!song.audio?.mix;
  const s = structuredClone(song);
  let dur = s.duration_ms;
  if (!hasAudio) {
    const lastHint = Math.max(0, ...flat.map(l => l.t ?? 0));
    dur = Math.max(placeholderMs(flat.length), lastHint ? Math.ceil((lastHint + 10000) / 2000) * 2000 : 0);
    if (dur !== s.duration_ms || !s.grid?.beats?.length) Object.assign(s, beatGrid(dur, s.bpm || 120, s.beats_per_bar || 4));
    s.duration_ms = dur; s.placeholder_duration = true;
  }
  // without a song file every line is an estimate: re-spread them all (deterministic, so an unchanged text changes nothing)
  const old = new Map((reestimate || !hasAudio ? [] : s.lines || []).map(l => [l.id, l]));
  const out = flat.map(l => {
    const o = old.get(l.id);
    if (o && o.text === l.text) return { keep: true, line: o, l };
    if (o) return { line: { ...o, text: l.text, words: spreadWords(l.text, o.t0, o.t1) }, l };
    return { line: null, l };
  });
  // place the untimed ones: LRC hints first, then between timed neighbours (in lyric order)
  for (const x of out) if (!x.line && x.l.t != null && x.l.t < dur) x.hint = Math.round(x.l.t);
  const lo0 = Math.round(dur * 0.06), hi0 = Math.round(dur * 0.94);
  for (let i = 0; i < out.length; i++) {
    if (out[i].line || out[i].hint != null) continue;
    let j = i; while (j < out.length && !out[j].line && out[j].hint == null) j++;
    const prev = out[i - 1], next = out[j];
    const lo = prev ? (prev.line ? prev.line.t1 : prev.hint + 800) : lo0;
    let hi = next ? (next.line ? next.line.t0 : next.hint) : hi0;
    if (!prev && !next) hi = hi0;
    const n = j - i, step = Math.max((hi - lo) / n, 300);
    for (let k = 0; k < n; k++) out[i + k].hint = Math.round(lo + k * step), out[i + k].span = step;
    i = j - 1;
  }
  const est = (x) => Math.max(800, words(x.l.text).length * 450);
  const lines = out.map((x, i) => {
    if (x.line) return x.line;
    const t0 = Math.max(0, Math.min(dur - 2, x.hint));
    const nx = out.slice(i + 1).map(y => y.line ? y.line.t0 : y.hint).find(t => t != null && t > t0) ?? dur;
    const t1 = Math.max(t0 + 1, Math.min(dur, x.span ? t0 + Math.round(x.span * 0.85) : Math.min(nx - 50, t0 + est(x))));
    return { id: x.l.id, section: x.l.section, idx: 0, kind: 'sung', voice: 'none', t0, t1, text: x.l.text, timing: 'estimated', words: spreadWords(x.l.text, t0, t1) };
  });
  const fromLyrics = !hasAudio || s.sections_from === 'lyrics' || !s.sections?.length;
  if (fromLyrics) {
    // sections tile the song from the lyrics sections (start 300 ms before their first line; the first starts at 0)
    const secs = [];
    for (const sec of version.sections) {
      const L = lines.filter(l => sec.lines.some(x => x.id === l.id)); if (!L.length) continue;
      const t0 = secs.length ? Math.max(secs[secs.length - 1].t0 + 1, Math.min(...L.map(l => l.t0)) - 300) : 0;
      secs.push({ id: sec.id, label: sec.label, t0, t1: dur, energy: 0 });
    }
    secs.forEach((x, i) => { x.t1 = i + 1 < secs.length ? secs[i + 1].t0 : dur; });
    s.sections = secs.length ? secs : [{ id: 'song', label: 'Song', t0: 0, t1: dur, energy: 0 }];
    s.sections_from = 'lyrics';
    for (const l of lines) if (l.timing === 'estimated' || !hasAudio) { const sec = version.sections.find(x => x.lines.some(y => y.id === l.id)); if (sec) l.section = sec.id; }
  } else {
    for (const [i, x] of out.entries()) if (!x.keep) lines[i].section = s.sections.find(q => q.t0 <= lines[i].t0 && lines[i].t0 < q.t1)?.id || lines[i].section;
  }
  lines.sort((a, b) => a.t0 - b.t0);
  const kept = new Set(out.filter(x => x.keep).map(x => x.line)), idx = {};
  for (const l of lines) { if (!kept.has(l)) l.idx = idx[l.section] ?? 0; idx[l.section] = (idx[l.section] ?? 0) + 1; }
  s.lines = lines;
  const nEst = lines.filter(l => l.timing === 'estimated').length;
  if (!hasAudio || (nEst && nEst === lines.length)) s.timing = 'estimated';
  else if (nEst && s.timing !== 'estimated') s.timing = 'mixed';
  return JSON.stringify(s) === JSON.stringify(song) ? song : s;
}
// a fresh line id for an edit in progress (draft sections not yet saved as a version)
export const nextLineId = (doc, draft) => `L${maxSeq(doc, draft ? { sections: draft } : null) + 1}`;
