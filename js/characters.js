// Stage 4 of the guided flow (docs/SPEC_v3_GUIDED.md): characters. The logic is the generic asset workspace's
// (js/assets.js: base, iteration trees, variants, requests, statuses, estimates, prompts); this file keeps the
// character names the stage-4 code and tools use. Pure functions, no DOM and no Node APIs.
//
// A character entity (entities/characters/<id>.json) carries, next to name, role, looks[] and breakdown {item, scenes}:
//   base {text, refs, at, by, via}, iter {nodes, trees, notes, log} and uses {<scene>: {variant: <look id> | null}}
//   (shapes: js/assets.js). Trees: "identity" and one "look:<look id>" per look (each from the approved identity).
//   looks[i] {id, name, garments, colors, images, notes, status: draft | review | approved, from?: breakdown | agent | page}
// A generation is a request in requests.json carrying char {id, tree, from, kind: identity | edit | look, text?, sketch?,
//   png?, mask?, pins?} (and the same link as asset {type: "character", ...}).
import * as A from './assets.js';
export { CHOICES, REF_SOURCES, NODE_RE, EST, emptyIter, normIter, nextNodeId, treeNodes, nodeById, treeState, headNode, approvedNode, pending, branches, pathTo, OPEN_REQ, cleanPins } from './assets.js';

export const TREE_RE = /^(identity|look:[A-Za-z0-9_][A-Za-z0-9_-]{0,63})$/;
export const estimate = (kind, o = {}) => A.estimate(kind, { ...o, type: 'character' });
export const nextCharNoteId = (iter) => A.nextNoteId(iter, 'character');
export const lookTree = (lookId) => `look:${lookId}`;
export const treeLook = (tree) => (String(tree || '').startsWith('look:') ? tree.slice(5) : null);
export const identityApproved = (ent) => A.rootApproved(ent, 'character');
export const charRequests = (requests, id) => A.assetRequests(requests, 'character', id).map(r => (r.char ? r : { ...r, char: A.linkOf(r) }));
export function charStatus(ent, requests) {
  const s = A.assetStatus(ent, requests, 'character');
  return { ...s, looks: s.variants, looks_approved: s.variants_approved };
}
export const identityPrompt = (ent, base) => A.rootPrompt('character', ent, base);
export const editPrompt = (ent, node, o) => A.editPromptFor('character', ent, node, o);
export const lookPrompt = (ent, look, idNode, o) => A.variantPrompt('character', ent, look, idNode, o);
