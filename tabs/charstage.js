// Stage 4 workspace: characters (docs/SPEC_v3_GUIDED.md). The generic asset workspace (tabs/assetws.js) on the
// character type: Identity (the base from the catalogue / Openverse / a description / private photos / a sketch, then
// the identity sheet's iteration tree with text + sketch + mask + pins edits, A/B compare, keep / branch / revert,
// approve), Looks (one tree per costume, from the approved identity; wardrobe items of the breakdown are draft looks),
// Scenes (the look each scene needs) and Notes. The director's acts go through POST /api/op/asset_act (page only).
import { menus } from '../core/menus.js';
import { store, esc } from '../js/store.js';
import { assetApproval } from '../js/flow.js';
import { AssetWorkspace, assetCommands } from './assetws.js';

let S = null;
assetCommands({ pre: 'chars', group: 'Characters', stage: 'characters', get: () => S, what: 'character', ids: { root: 'requestIdentity', approve: 'approveIdentity', newV: 'newLook' }, root: 'identity sheet', vWord: 'look' });
menus.contribute('chnode', ['chars.compare', 'chars.edit', '-', 'chars.keep', 'chars.branch', 'chars.revert', '-', 'chars.approveIdentity']);

// ROADMAP_v4 F1: one definition of "approved" (js/flow.js assetApproval) in Assets and here. An asset approved before
// the flow whose identity / base tree is empty reads "approved (legacy) · no identity node" instead of "needs a base";
// when the workspace has the import flow (importImage: a registered image becomes a node, no request, nothing paid),
// the row offers "Import as identity / base". Display only: the list and the bar of tabs/assetws.js are patched after
// they render.
export function legacyPatch(ws) {
  const word = (e) => e.kind === 'character' ? 'identity' : 'base';
  const canImport = typeof ws.importImage === 'function';
  const fix = (stEl, e) => {
    const a = assetApproval(e, store.approvals);
    if (a.key !== 'legacy' || !stEl) return a;
    stEl.textContent = a.label; stEl.className = 'chst s-legacy'; stEl.title = a.title;
    return a;
  };
  const list = ws.renderList.bind(ws), bar = ws.renderBar.bind(ws);
  ws.renderList = () => {
    list();
    for (const row of ws.el.querySelectorAll('.chlist .chrow[data-ent]')) {
      const e = ws.assets.find(x => x.id === row.dataset.ent); if (!e) continue;
      const a = fix(row.querySelector('.chst'), e);
      if (a.key !== 'legacy') continue;
      const dot = row.querySelector('.chdot'); if (dot) { dot.className = 'chdot s-legacy'; dot.title = a.title; }
      if (canImport && !a.nodes) row.querySelector('.chst').insertAdjacentHTML('afterend', `<button class="chimp" data-imp="${esc(e.id)}" title="${esc(`make an existing image (e.g. the approved one from before the flow) the first node of the ${word(e)} tree: no request, nothing paid; then approve it`)}">Import as ${word(e)}</button>`);
    }
  };
  ws.renderBar = () => { bar(); const e = ws.ent(); if (e) fix(ws.el.querySelector('.chbar .chst'), e); };
  ws.el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-imp]'); if (!b) return;
    ev.stopPropagation();
    const e = ws.assets.find(x => x.id === b.dataset.imp); if (!e) return;
    await ws.select(e.id);
    ws.importImage(e.kind === 'character' ? 'identity' : 'base');
  }, true);
  store.on((w) => { if (w === 'approvals' && !ws.typing()) ws.render(); });
  ws.render();
}

export default {
  mount(el) { S = new AssetWorkspace(el, { types: ['character'], stage: 'characters', pref: 'ch' }); legacyPatch(S); window.WB.characters = { get ws() { return S; }, open: (id) => S.select(id), node: (id, mode) => S.openNode(id, mode) }; },
  show() { if (S && !S.typing()) S.render(); },
  get ws() { return S; },
};
