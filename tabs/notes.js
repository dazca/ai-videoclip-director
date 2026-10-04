// Notes: all notes in time order; toggle open/resolved; add one at the current playhead.
import { store } from '../js/store.js';
import { fmt } from '../js/timeline.js';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
export default {
  mount(el, ctx) {
    el.classList.add('pane');
    const render = () => {
      el.innerHTML = `<div class="bar"><input class="newnote" placeholder="new note at the playhead (Enter)"> rev ${store.notes.rev}</div>
        <table class="tbl">${store.notes.notes.map(n => `<tr class="n-${n.status}"><td><a data-t="${n.t}">${fmt(n.t, true)}</a></td><td>${esc(n.line_id || '')}</td><td><b>${esc(n.by)}</b></td><td>${esc(n.text)}${n.about ? `<div class="dim">${esc(n.about)}</div>` : ''}</td><td><span class="chip ${n.status === 'open' ? 's-changes' : 's-approved'}" data-id="${n.id}">${n.status}</span></td></tr>`).join('')}</table>`;
      el.querySelector('.newnote').addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && e.target.value.trim()) store.addNote(ctx.timeline?.player.time() || 0, e.target.value.trim());
      });
    };
    render();
    el.addEventListener('click', (e) => { const c = e.target.closest('.chip[data-id]'); if (c) store.toggleNote(c.dataset.id); const a = e.target.closest('a[data-t]'); if (a) ctx.goto(Number(a.dataset.t)); });
    store.on((w) => { if (w === 'notes' || w === 'all') render(); });
  },
};
