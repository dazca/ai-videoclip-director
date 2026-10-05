// E6, looks per context (ROADMAP_v4; the first film's gen/LOOKS_PLAN.md: "one look per world, for both characters": on the
// screen / out of the screen / dancing). Pure functions, no DOM and no Node APIs: the page, the data layer and the
// composition export share them.
//
//   A WORLD is a short name ("on screen", "off screen", "dancing"): letters, digits, spaces, _ ' - (1-40), lower case.
//   look.context            the world a character's look is for (the director's: asset_act look_world, page only; an agent
//                           proposes it with look_world_propose -> look.world_proposal {world, why, by, via, at}, or gives it
//                           to a NEW look with look_create world)
//   scene.context           the world of a scene (scenes.json, a script version)
//   shot.context            the world of a shot (storyboard.json), when it differs from its scene's
//   The world of a shot = shot.context, else its scene's. A cast chip of a shot with a world wears the character's look for
//   that world (the approved one first), unless the shot overrides the look (shot.variants); a shot with no world keeps the
//   scene's pick (entity uses). A mismatch = a cast character of a shot with a world whose look is not for that world (or
//   who has no look for it): a gap (js/storyboard.js boardGaps `looks`, Final's checklist line `looks`).
export const WORLD_RE = /^[\p{L}\p{N}][\p{L}\p{N} _'’-]{0,39}$/u;
export const WORLD_HINT = 'a world: a short name (letters, digits, spaces, _ \' -; up to 40), e.g. "on screen", "off screen", "dancing"';

// a world from the page or an agent -> the stored spelling (trimmed, lower case, single spaces) or null; throws on a bad one
export function cleanWorld(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new Error(WORLD_HINT);
  const s = v.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (!WORLD_RE.test(s)) throw new Error(`world "${s.slice(0, 50)}": ${WORLD_HINT}`);
  return s;
}
export const lookWorld = (l) => (l && typeof l.context === 'string' && l.context ? l.context : null);
const looksOf = (ent) => (Array.isArray(ent?.looks) ? ent.looks : []).filter(l => l && typeof l === 'object' && l.id);
// the world a shot is in: {world, source: shot | scene | null}
export function shotWorld(shot, scene) {
  if (shot?.context) return { world: shot.context, source: 'shot' };
  if (scene?.context) return { world: scene.context, source: 'scene' };
  return { world: null, source: null };
}
// a character's look for a world: the approved one first, else the first tagged with it
export function worldLook(ent, world) {
  if (!world) return null;
  const l = looksOf(ent).filter(x => lookWorld(x) === world);
  return l.find(x => x.status === 'approved') || l[0] || null;
}
// every world the project names (looks, scenes, shots), sorted
export function worldsIn({ entities = [], scenes = [], shots = [] } = {}) {
  const w = new Set();
  for (const e of entities) if (e?.kind === 'character') for (const l of looksOf(e)) { if (lookWorld(l)) w.add(l.context); if (l.world_proposal?.world) w.add(l.world_proposal.world); }
  for (const s of [...scenes, ...shots]) if (s?.context) w.add(s.context);
  return [...w].sort();
}
// the look x world matrix of the characters (LOOKS_PLAN.md as data): [{id, name, worlds: {<world>: {look, name, status} | null}}]
export function lookMatrix(entities = [], worlds = worldsIn({ entities })) {
  return entities.filter(e => e?.kind === 'character').map(e => ({ id: e.id, name: e.name || e.id,
    worlds: Object.fromEntries(worlds.map(w => { const l = worldLook(e, w); return [w, l ? { look: l.id, name: l.name || l.id, status: l.status || 'draft' } : null]; })) }));
}
