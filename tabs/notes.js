// Review > Notes: every note of every stage and the timeline (notes.json v2, js/notes.js) in one table: the stage, where
// (a click opens it: the stage workspace, or the timeline at its time), who, the note and its thread, the status (click:
// done / reopen; × dismisses). A new note at the playhead goes on the timeline.
import { store, esc, prefs } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import * as N from '../js/notes.js';
import { currentScript } from '../js/scenes.js';

export default {
  mount(el, ctx) {
    el.classList.add('pane', 'ntab');
    let filter = prefs.get('notesTabFilter', 'open');
    const render = () => {
      const tctx = { song: store.song, scenes: currentScript(store.scenes)?.scenes || [], shots: store.boardShots() };
      const all = store.notes.notes, c = N.openCounts(store.notes);
      const list = all.filter(n => filter === 'all' || n.status === 'open')
        .map(n => ({ n, t: N.noteTime(n, tctx) }))
        .sort((a, b) => N.STAGES.indexOf(a.n.target.stage) - N.STAGES.indexOf(b.n.target.stage) || (a.t ?? 1e12) - (b.t ?? 1e12) || String(a.n.created).localeCompare(String(b.n.created)));
      el.innerHTML = `<div class="bar"><input class="newnote" placeholder="new note on the timeline at the playhead (Enter)"> <b>${c.total}</b> open · round ${esc(store.notes.round || 1)} · ${N.STAGES.filter(s => c.stages[s]).map(s => `${esc(N.STAGE_TITLE[s])} ${c.stages[s]}`).join(' · ') || 'nothing open'}
        <select class="nflt"><option value="open"${filter === 'open' ? ' selected' : ''}>open</option><option value="all"${filter === 'all' ? ' selected' : ''}>all</option></select></div>
        <table class="tbl"><tr><th>stage</th><th>where</th><th>who</th><th>note</th><th>status</th></tr>${list.map(({ n, t }) => `<tr class="n-${esc(n.status)}" data-id="${esc(n.id)}">
          <td>${esc(N.STAGE_TITLE[n.target.stage])}</td><td><a data-go="${esc(n.target.stage)}" data-t="${t ?? ''}">${t != null ? fmt(t, true) + ' ' : ''}${esc(n.target.kind === 'time' ? '' : N.targetLabel(n.target))}</a></td>
          <td><span class="who ${n.via === 'agent' ? 'ag' : 'dr'}">${n.via === 'agent' ? 'agent' : 'director'}</span></td>
          <td>${n.to === 'agent' ? '<span class="to">→ agent</span> ' : ''}${esc(n.text)}${(n.replies || []).map(r => `<div class="dim">↳ ${r.via === 'agent' ? 'agent' : 'director'}: ${esc(r.text)}</div>`).join('')}</td>
          <td><span class="chip ${n.status === 'open' ? 's-changes' : 's-approved'}" data-st="${esc(n.id)}" title="${n.status === 'open' ? 'click: done (absorbed)' : 'click: reopen'}">${esc(n.status)}</span>${n.status === 'open' ? ` <a data-dis="${esc(n.id)}" title="dismiss">×</a>` : ''}</td></tr>`).join('')}</table>`;
      el.querySelector('.newnote').addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && e.target.value.trim()) store.addNote(ctx.timeline?.player.time() || 0, e.target.value.trim());
      });
      el.querySelector('.nflt').addEventListener('change', (e) => { filter = e.target.value; prefs.set('notesTabFilter', filter); render(); });
    };
    render();
    el.addEventListener('click', (e) => {
      const c = e.target.closest('[data-st]'); if (c) return store.toggleNote(c.dataset.st);
      const d = e.target.closest('[data-dis]'); if (d) return store.noteStatus(d.dataset.dis, 'dismissed');
      const a = e.target.closest('a[data-go]'); if (!a) return;
      if (a.dataset.go === 'timeline' || (a.dataset.t !== '' && e.altKey)) return ctx.goto(Number(a.dataset.t));
      window.WB.stages.open(a.dataset.go);
    });
    store.on((w) => { if (w === 'notes' || w === 'all') render(); });
  },
};
