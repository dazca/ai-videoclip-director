// Proposals (docs/SPEC_v4_NOTES_ROUNDS.md §3; ROADMAP_v4 B9-B11): small, free choices attached to a target (a scene
// sketch, a shot frame, a look, a location variant, a lyric line, a scene idea) so the director starts by choosing, not
// from a blank page. Pure functions, no DOM, no Node APIs: shared by the page (js/store.js, core/proposals.js, the stage
// tabs) and the data layer (lib/ops/proposals.mjs).
//
// proposals.json (the server's only; the page reads it, like revisions.json)
//   {v: 1, rev, sets: [Set]}
//   Set   {id "ps03", target {stage, kind, id}, round (the notes round it was made in), by, via: agent | page,
//          source: agent | local (the free local generator, js/proposals-local.js), created, answers?: [note ids],
//          items: [Item]}
//   Item  {id "a" | "b" | ..., title, why, svg?: "proposals/ps03-a.svg" (sanitised by the server) | text?: "...",
//          status: open | picked | mixed | dismissed, note? (a mix: the director's words), at?, by?, via?}
// One pick per set: picking an item sends the set's other picked / mixed item back to open. Picks, mixes and dismissals
// are the director's (page only: proposal_act); the agent adds sets (proposals_add) and reads them (proposals_get).

export const ITEM_STATUSES = ['open', 'picked', 'mixed', 'dismissed'];
// where proposals may sit: stage -> the target kinds (a subset of js/notes.js KINDS)
export const TARGETS = {
  lyrics: ['line', 'section'],
  script: ['scene'],
  storyboard: ['shot', 'scene'],
  characters: ['asset', 'tree'],
  scenery: ['asset', 'tree'],
};
export const MAX_ITEMS = 6;
export const TITLE_MAX = 80;
export const WHY_MAX = 300;
export const TEXT_MAX = 2000;
export const SET_ID = /^ps\d{2,5}$/;
export const ITEM_ID = /^[a-z]$/;

export const emptyProposals = () => ({ v: 1, rev: 0, sets: [] });
export function normProposals(d) {
  const o = d && typeof d === 'object' && Array.isArray(d.sets) ? d : emptyProposals();
  return { v: 1, rev: o.rev || 0, sets: o.sets.filter(s => s && typeof s === 'object' && s.target && Array.isArray(s.items)) };
}
export const keyOf = (t) => t ? `${t.stage}|${t.kind}|${t.id ?? ''}` : '';
export const sameTarget = (a, b) => !!a && !!b && a.stage === b.stage && a.kind === b.kind && (a.id ?? null) === (b.id ?? null);
// the sets on a target, newest first; open = only the sets with something left to decide (an open item)
export function setsFor(doc, target, { open = false, all = false } = {}) {
  const sets = (doc?.sets || []).filter(s => sameTarget(s.target, target));
  return sets.filter(s => all || s.items.some(i => i.status !== 'dismissed')).filter(s => !open || s.items.some(i => i.status === 'open')).reverse();
}
// the targets of a stage that carry proposals (open or picked), for counters and badges
export function targetsOn(doc, stage) {
  const m = new Map();
  for (const s of doc?.sets || []) if (s.target.stage === stage && s.items.some(i => i.status !== 'dismissed')) m.set(keyOf(s.target), s.target);
  return [...m.values()];
}
export const isPicked = (i) => i.status === 'picked' || i.status === 'mixed';
export const pickedOf = (set) => set.items.find(isPicked) || null;
export const nextSetId = (doc) => `ps${String((doc?.sets || []).reduce((m, s) => Math.max(m, Number(String(s.id).slice(2)) || 0), 0) + 1).padStart(2, '0')}`;
export const itemIds = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
export const svgPath = (setId, itemId) => `proposals/${setId}-${itemId}.svg`;
const STAGE_WORD = { lyrics: 'lyric', script: 'script', storyboard: 'storyboard', characters: 'character', scenery: 'scenery' };
// "scene sc02", "shot s4-chorus", "line verse/0", "look ada/look:base", "variant studio/variant:night"
export function targetLabel(t) {
  if (!t) return '';
  if (t.kind === 'tree') { const [a, b] = String(t.id).split('/'); const w = /^look:/.test(b) ? 'look' : /^variant:/.test(b) ? 'variant' : b; return `${a} ${w}${/:/.test(b) ? ' ' + b.split(':')[1] : ''}`; }
  if (t.kind === 'asset') return `${STAGE_WORD[t.stage]} ${t.id}`;
  return `${t.kind} ${t.id}`;
}
// what a pick does on a target, in words (the strip's tooltips, the tools' descriptions)
export function pickEffect(t, item) {
  if (item?.svg) return t.kind === 'scene' && t.stage === 'script' ? 'the scene sketch\'s underlay' : t.kind === 'shot' ? 'the frame sketch\'s base layer' : 'your choice (the agent reads it)';
  if (t.stage === 'lyrics' && t.kind === 'line') return 'the line\'s text (in your draft)';
  if (t.stage === 'script' && t.kind === 'scene') return 'the scene\'s text (in your draft)';
  if (t.stage === 'storyboard' && t.kind === 'shot') return 'the shot\'s action (in your draft)';
  return 'your choice (the agent reads it)';
}
// the ask a "3 more" (or "Prepare proposals") writes: a note to the agent on the target, ask "proposals"
export function moreText(t, sets = []) {
  const seen = sets.flatMap(s => s.items.map(i => `${s.id}/${i.id} “${i.title}”${i.status === 'dismissed' ? ' (dismissed)' : isPicked(i) ? ` (${i.status})` : ''}`));
  return `3 more proposals for ${targetLabel(t)}${seen.length ? `, different from ${seen.slice(0, 9).join(', ')}${seen.length > 9 ? ', …' : ''}` : ''}: proposals_add {target, items} (SVG layouts or short texts, each with a title and why).`;
}
export const PREPARE_TEXT = {
  script: 'Prepare starting proposals for the script: for each scene, 3 SVG layouts for its sketch (composition, framing, silhouettes, colour blocks, camera arrows from its beats) and, where the idea is thin, 3 short texts for the scene. proposals_add per scene (target {stage: "script", kind: "scene", id}); then resolve this ask.',
  storyboard: 'Prepare starting proposals for the storyboard: for each shot without a frame, 3 SVG frame layouts from its beats (wide / medium / close, rule-of-thirds silhouettes, a camera arrow). proposals_add per shot (target {stage: "storyboard", kind: "shot", id}); then resolve this ask.',
  lyrics: 'Prepare starting proposals for the lyrics: for the lines that are weakest, 3 short alternative texts each. proposals_add per line (target {stage: "lyrics", kind: "line", id}); then resolve this ask.',
  characters: 'Prepare starting proposals for the characters: for each look, 3 mood boards as SVG colour blocks and silhouettes (or short texts). proposals_add per look (target {stage: "characters", kind: "tree", id: "<character>/look:<id>"}); then resolve this ask.',
  scenery: 'Prepare starting proposals for the scenery: for each location variant, 3 SVG colour / light layouts. proposals_add per variant (target {stage: "scenery", kind: "tree", id: "<location>/variant:<id>"}); then resolve this ask.',
};
