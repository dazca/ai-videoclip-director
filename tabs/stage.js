// Stage workspace (page "stage", opened from the stage rail): a 20 px bar with the stage, its status and the director's
// status buttons (only here and on the rail can a stage be marked done), then the stage's own workspace. Stage 1
// (lyrics) is tabs/lyrics.js, stage 2 (script) tabs/script.js, stage 3 (breakdown) tabs/breakdown.js, stage 4 (characters)
// tabs/charstage.js, stage 5 (scenery) tabs/scenery.js (both on the generic tabs/assetws.js), stage 6 (storyboard)
// tabs/storyboard.js, stage 7 (final) tabs/final.js (final approvals: the pending list, the checklist, the costs, Lock for render).
import { store, esc } from '../js/store.js';
import { STAGES, STATUS_LABEL, stageById, stageTip } from '../js/flow.js';
import { TIME_STAGES, isTime, setMode } from '../core/timemode.js';

const MODULES = { lyrics: () => import('./lyrics.js'), script: () => import('./script.js'), breakdown: () => import('./breakdown.js'), characters: () => import('./charstage.js'), scenery: () => import('./scenery.js'), storyboard: () => import('./storyboard.js'), final: () => import('./final.js') };
const LATER = {};
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
      // the status shown is computed from the content (js/flow.js stagesView), the buttons act on the stored mark
      const ready = s.content?.status === 'ready';
      bar.innerHTML = `<b>${d.n} · ${esc(d.title)}</b><span class="sgst st-${s.shown}" data-shown="${s.shown}" title="${esc(stageTip(s))}"><i></i>${esc(s.shown_label)}${s.shown !== s.status && s.status !== 'done' && s.status !== 'empty' ? ` <span class="dim">(marked ${STATUS_LABEL[s.status]})</span>` : ''}</span>`
        + `${s.status === 'done' ? btn('in_progress', 'Reopen', s.changed ? `back to in progress (${s.changed})` : 'back to in progress') : btn('done', 'Mark done', ready ? 'the director signs this stage off (agents cannot)' : `the director signs this stage off (agents cannot). Not ready yet: ${s.content?.blockers.join('; ')}. Marked anyway, it shows done ⚠ until the content is ready`)}`
        + `${s.status !== 'done' ? btn('in_progress', 'In progress', '') + btn('needs_you', 'Needs you', 'flag it for later') : ''}`
        + `<span class="dim sgbl" title="${esc(stageTip(s))}">${s.changed ? `<b class="stw">⚠ ${esc(s.changed)}</b> · ` : ''}${s.blockers_all.length ? esc(s.blockers_all.join(' · ')) : 'nothing blocking'}</span>`
        + `${s.note ? `<span class="sgnote" title="${esc(`${s.updated_by || ''} ${s.updated || ''}`)}">${s.via === 'agent' ? 'agent: ' : ''}${esc(s.note)}</span>` : ''}`
        + (TIME_STAGES.includes(id) ? `<span class="sgtm" title="${esc(`List: the stage's own list (the default). Time: ${id === 'final' ? 'the rows grouped by song section, in time order' : "the rows on the timeline's time axis (the same y for the same ms); a click on an empty spot seeks"}. Alt+T`)}"><a data-tm="list" class="${isTime(id) ? '' : 'on'}">List</a><a data-tm="time" class="${isTime(id) ? 'on' : ''}">Time</a></span>` : '')
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
      const tm = e.target.closest('[data-tm]'); if (tm) setMode(window.WB.stages.current(), tm.dataset.tm);
    });
    body.addEventListener('click', (e) => { const a = e.target.closest('.sglater [data-view]'); if (a) window.WB.app.show(a.dataset.view); });
    document.addEventListener('wb:stage', () => { if (window.WB.app.active() === 'stage') showStage(); });
    document.addEventListener('wb:timemode', () => { if (window.WB.app.active() === 'stage') renderBar(); });
    store.on((w) => { if (['stages', 'lyrics', 'scenes', 'breakdown', 'board', 'entities', 'approvals', 'notes', 'all'].includes(w) && window.WB.app.active() === 'stage') renderBar(); });
    this._show = showStage;
  },
  show() { return this._show?.(); },
};
