// Stage workspace (page "stage", opened from the stage rail): the stage bar (core/stagebar.js, F8: one component, the same
// slots on every stage: status, Mark done / Reopen, Needs you, the primary act, Ask the agent…, Send round, List | Time, ‹ ›),
// then the stage's own workspace. Stage 1
// (lyrics) is tabs/lyrics.js, stage 2 (script) tabs/script.js, stage 3 (breakdown) tabs/breakdown.js, stage 4 (characters)
// tabs/charstage.js, stage 5 (scenery) tabs/scenery.js (both on the generic tabs/assetws.js), stage 6 (storyboard)
// tabs/storyboard.js, stage 7 (final) tabs/final.js (final approvals: the pending list, the checklist, the costs, Lock for render).
import { store, esc } from '../js/store.js';
import { stageById } from '../js/flow.js';
import { stageBar } from '../core/stagebar.js';

const MODULES = { lyrics: () => import('./lyrics.js'), script: () => import('./script.js'), breakdown: () => import('./breakdown.js'), characters: () => import('./charstage.js'), scenery: () => import('./scenery.js'), storyboard: () => import('./storyboard.js'), final: () => import('./final.js') };
const LATER = {};
export default {
  mount(el, ctx) {
    el.classList.add('stagews');
    el.innerHTML = '<div class="sgbar"></div><div class="sgbody"></div>';
    const bar = el.querySelector('.sgbar'), body = el.querySelector('.sgbody');
    const hosts = {};   // stage id -> {el, mod}
    let shown = null;
    // F8: ONE stage bar for every stage (core/stagebar.js): the same slots at the same x everywhere
    const renderBar = () => stageBar.render(bar, window.WB.stages.current());
    stageBar.bind(bar);
    // the primary act (Save version, …) follows the stage's draft: re-checked after any edit in the workspace
    let pr = 0; const refresh = () => { if (!pr) pr = requestAnimationFrame(() => { pr = 0; stageBar.refreshPrimary(bar); }); };
    for (const ev of ['input', 'click', 'keyup', 'change']) body.addEventListener(ev, refresh, true);
    const showStage = async () => {
      const id = window.WB.stages.current();
      renderBar();
      if (shown === id && hosts[id]) { await hosts[id].mod?.show?.(ctx); return refresh(); }
      for (const h of Object.values(hosts)) h.el.style.display = 'none';
      shown = id;
      if (!hosts[id]) {
        const h = hosts[id] = { el: document.createElement('div'), mod: null }; h.el.className = 'sghost'; h.el.dataset.stage = id; body.appendChild(h.el);
        if (MODULES[id]) { h.mod = (await MODULES[id]()).default; h.mod.mount(h.el, ctx); if (window.WB.stages.current() === id) renderBar(); }   // its stage actions (the primary act) exist now
        else {
          const d = stageById(id), [where, view] = LATER[id];
          h.el.innerHTML = `<div class="pane sglater"><h4>${d.n} · ${esc(d.title)}</h4><p>${esc(d.does)}.</p><p class="dim">This workspace comes in a later phase of the guided flow. Today: ${esc(where)} <a data-view="${view}">open</a></p>
            <p class="dim">An agent can already work on it through the MCP tools and mark progress with <code>stage_update</code>; you mark it done here or on the rail.</p></div>`;
        }
      }
      hosts[id].el.style.display = '';
      await hosts[id].mod?.show?.(ctx);
      refresh();
    };
    body.addEventListener('click', (e) => { const a = e.target.closest('.sglater [data-view]'); if (a) window.WB.app.show(a.dataset.view); });
    document.addEventListener('wb:stage', () => { if (window.WB.app.active() === 'stage') showStage(); });
    document.addEventListener('wb:timemode', () => { if (window.WB.app.active() === 'stage') renderBar(); });
    store.on((w) => { if (['stages', 'lyrics', 'scenes', 'breakdown', 'board', 'entities', 'approvals', 'notes', 'revisions', 'all'].includes(w) && window.WB.app.active() === 'stage') renderBar(); });
    this._show = showStage;
  },
  show() { return this._show?.(); },
};
