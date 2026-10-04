// Stage 5 workspace: scenery, i.e. locations and props (docs/SPEC_v3_GUIDED.md). The generic asset workspace
// (tabs/assetws.js, the same code path as the characters) on two types at once: the list groups the locations and the
// props the breakdown found; per asset, Base (the base from the catalogue / Openverse / a description / private photos /
// a sketch, then the base sheet's iteration tree with text + sketch + mask + pins edits, A/B compare, keep / branch /
// revert, approve), Variants (each its own tree from the approved base: a location's angle wide / medium / reverse /
// custom, time of day dawn / day / dusk / night and weather; a prop's angle and state, e.g. broken, lit), Scenes (the
// scenes that use it and the variant each one needs: the storyboard reads it) and Notes. The director's acts go through
// POST /api/op/asset_act (page only). Formats: js/assets.js.
import { AssetWorkspace, assetCommands } from './assetws.js';

let S = null;
assetCommands({ pre: 'scenery', group: 'Scenery', stage: 'scenery', get: () => S, what: 'location or prop', ids: { root: 'requestBase', approve: 'approveBase', newV: 'newVariant' }, root: 'base sheet', vWord: 'variant' });

export default {
  mount(el) { S = new AssetWorkspace(el, { types: ['location', 'prop'], stage: 'scenery', pref: 'sn' }); window.WB.scenery = { get ws() { return S; }, open: (id) => S.select(id), node: (id, mode) => S.openNode(id, mode), tab: (t) => S.setTab(t) }; },
  show() { if (S && !S.typing()) S.render(); },
  get ws() { return S; },
};
