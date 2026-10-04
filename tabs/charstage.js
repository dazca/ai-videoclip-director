// Stage 4 workspace: characters (docs/SPEC_v3_GUIDED.md). The generic asset workspace (tabs/assetws.js) on the
// character type: Identity (the base from the catalogue / Openverse / a description / private photos / a sketch, then
// the identity sheet's iteration tree with text + sketch + mask + pins edits, A/B compare, keep / branch / revert,
// approve), Looks (one tree per costume, from the approved identity; wardrobe items of the breakdown are draft looks),
// Scenes (the look each scene needs) and Notes. The director's acts go through POST /api/op/asset_act (page only).
import { menus } from '../core/menus.js';
import { AssetWorkspace, assetCommands } from './assetws.js';

let S = null;
assetCommands({ pre: 'chars', group: 'Characters', stage: 'characters', get: () => S, what: 'character', ids: { root: 'requestIdentity', approve: 'approveIdentity', newV: 'newLook' }, root: 'identity sheet', vWord: 'look' });
menus.contribute('chnode', ['chars.compare', 'chars.edit', '-', 'chars.keep', 'chars.branch', 'chars.revert', '-', 'chars.approveIdentity']);

export default {
  mount(el) { S = new AssetWorkspace(el, { types: ['character'], stage: 'characters', pref: 'ch' }); window.WB.characters = { get ws() { return S; }, open: (id) => S.select(id), node: (id, mode) => S.openNode(id, mode) }; },
  show() { if (S && !S.typing()) S.render(); },
  get ws() { return S; },
};
