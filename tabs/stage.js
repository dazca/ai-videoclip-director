// Stage workspace (page "stage", opened from the stage rail): a 20 px bar with the stage, its status and the director's
// status buttons (only here and on the rail can a stage be marked done), then the stage's own workspace. Stage 1
// (lyrics) is tabs/lyrics.js, stage 2 (script) tabs/script.js, stage 3 (breakdown) tabs/breakdown.js, stage 4 (characters)
// tabs/charstage.js; the later stages show what they will hold and where
// their data lives today.
import { store, esc } from '../js/store.js';
import { STAGES, STATUS_LABEL, stageById } from '../js/flow.js';

const MODULES = { lyrics: () => import('./lyrics.js'), script: () => import('./script.js'), breakdown: () => import('./breakdown.js'), characters: () => import('./charstage.js') };
const LATER = {
  scenery: ['Assets > Locations and Props.', 'locations'],
  storyboard: ['Timeline > shots and clips columns (shots.json).', 'timeline'],
  final: ['Review > Approvals, Queue and Costs.', 'approvals'],
};
export default {
  mount(el, ctx) {
    el.classList.add('stagews');
    el.innerHTML = '<div class="sgbar"></div><div class="sgbody"></div>';
    const bar = el.querySelector('.sgbar'), body = el.querySelector('.sgbody');
    const hosts = {};   // stage id -> {el, mod}
    let shown = null;
    const renderBar = () => {
      const v = window.WB.stages.view(), id = window.WB.stages.current(), s = v.stages.find(x => x.id === id), d = stageById(id);
      const btn = (st, label, title) => s.status === st ? '' : `<button data-st="${st}" title="${esc(title)}">${label}</button>`;
      bar.innerHTML = `<b>${d.n} · ${esc(d.title)}</b><span class="sgst st-${s.status}"><i></i>${STATUS_LABEL[s.status]}</span>`
        + `${s.status === 'done' ? btn('in_progress', 'Reopen', 'back to in progress') : btn('done', 'Mark done', 'the director signs this stage off (agents cannot)')}`
        + `${s.status !== 'done' ? btn('in_progress', 'In progress', '') + btn('needs_you', 'Needs you', 'flag it for later') : ''}`
        + `<span class="dim sgbl" title="${esc(s.blockers_all.join('\n'))}">${s.blockers_all.length ? esc(s.blockers_all.join(' · ')) : 'nothing blocking'}</span>`
        + `${s.note ? `<span class="sgnote" title="${esc(`${s.updated_by || ''} ${s.updated || ''}`)}">${s.via === 'agent' ? 'agent: ' : ''}${esc(s.note)}</span>` : ''}`
        + `<span class="sgnav">${d.n > 1 ? `<a data-go="${STAGES[d.n - 2].id}">‹ ${esc(STAGES[d.n - 2].title)}</a>` : ''}${d.n < 7 ? `<a data-go="${STAGES[d.n].id}">${esc(STAGES[d.n].title)} ›</a>` : ''}</span>`;
    };
    const showStage = async () => {
      const id = window.WB.stages.current();
      renderBar();
      if (shown === id && hosts[id]) return hosts[id].mod?.show?.(ctx);
      for (const h of Object.values(hosts)) h.el.style.display = 'none';
      shown = id;
      if (!hosts[id]) {
        const h = hosts[id] = { el: document.createElement('div'), mod: null }; h.el.className = 'sghost'; h.el.dataset.stage = id; body.appendChild(h.el);
        if (MODULES[id]) { h.mod = (await MODULES[id]()).default; h.mod.mount(h.el, ctx); }
        else {
          const d = stageById(id), [where, view] = LATER[id];
          h.el.innerHTML = `<div class="pane sglater"><h4>${d.n} · ${esc(d.title)}</h4><p>${esc(d.does)}.</p><p class="dim">This workspace comes in a later phase of the guided flow. Today: ${esc(where)} <a data-view="${view}">open</a></p>
            <p class="dim">An agent can already work on it through the MCP tools and mark progress with <code>stage_update</code>; you mark it done here or on the rail.</p></div>`;
        }
      }
      hosts[id].el.style.display = '';
      hosts[id].mod?.show?.(ctx);
    };
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-st]'); if (b) return window.WB.stages.setStatus(window.WB.stages.current(), b.dataset.st);
      const g = e.target.closest('[data-go]'); if (g) window.WB.stages.open(g.dataset.go);
    });
    body.addEventListener('click', (e) => { const a = e.target.closest('.sglater [data-view]'); if (a) window.WB.app.show(a.dataset.view); });
    document.addEventListener('wb:stage', () => { if (window.WB.app.active() === 'stage') showStage(); });
    store.on((w) => { if (['stages', 'lyrics', 'scenes', 'breakdown', 'all'].includes(w) && window.WB.app.active() === 'stage') renderBar(); });
    this._show = showStage;
  },
  show() { return this._show?.(); },
};
