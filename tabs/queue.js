// Generation queue: data/<project>/requests.json. The page only writes DRAFT requests and approvals; the agent picks up
// approved ones, sets queued/running, and writes back status done + outputs (or rejected). Cost cap shown on top.
//   {id, kind, target, prompt, refs[], est_cost, status: draft|approved|queued|running|done|rejected, by, at, outputs?[]}
import { store } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { esc, mediaAttr } from '../core/esc.js';
const ORDER = ['draft', 'approved'];
const CLS = { draft: '', approved: 's-approved', queued: 's-review', running: 's-review', done: 's-locked', rejected: 's-changes' };

export default {
  mount(el, ctx) {
    el.classList.add('pane', 'queue');
    let filter = '';
    const timeOf = (k) => { if (!k) return null; const id = k.slice(k.indexOf(':') + 1); return store.shots.find(s => 'shot:' + s.id === k)?.t0 ?? store.uses.find(u => u.id === id)?.t0 ?? store.song.sections.find(s => s.id === id)?.t0 ?? store.song.lines.find(l => l.id === id)?.t0 ?? null; };
    const render = () => {
      const items = store.requests?.items || [];
      const by = {}; for (const r of items) by[r.status] = (by[r.status] || 0) + 1;
      const spent = (store.costs?.items || []).reduce((s, x) => s + (Number(x.usd) || 0), 0);
      const pending = items.filter(r => ['approved', 'queued', 'running'].includes(r.status)).reduce((s, r) => s + (Number(r.est_cost) || 0), 0);
      const drafts = items.filter(r => r.status === 'draft').reduce((s, r) => s + (Number(r.est_cost) || 0), 0);
      const cap = Number(store.costs?.cap_usd) || 0, pct = cap ? Math.min(100, (spent + pending) / cap * 100) : 0;
      el.innerHTML = `<div class="bar">spent $${spent.toFixed(2)} + approved/queued $${pending.toFixed(2)} (drafts $${drafts.toFixed(2)}) of cap $${cap}
        <div class="meter"><i style="width:${pct}%"></i></div>
        ${['', 'draft', 'approved', 'queued', 'running', 'done', 'rejected'].map(s => `<a data-f="${s}" class="${s === filter ? 'picked' : ''}">${s || 'all'}${s ? ' ' + (by[s] || 0) : ' ' + items.length}</a>`).join(' · ')}
        <span class="dim"> · the agent runs approved requests only; right-click a shot / clip / cast chip / card to add one</span></div>
        ${items.length ? `<table class="tbl"><tr><th>status</th><th>kind</th><th>target</th><th>prompt draft</th><th>$ est</th><th>refs / outputs</th><th>at</th><th></th></tr>
        ${items.filter(r => !filter || r.status === filter).slice().reverse().map(r => { const t = timeOf(r.target); return `<tr data-id="${esc(r.id)}" data-sel="request:${esc(r.id)}">
          <td><span class="chip ${CLS[r.status] || ''}" data-x="cycle" title="click: draft ⇄ approved">${esc(r.status)}</span></td><td>${esc(r.kind)}</td>
          <td>${t != null ? `<a data-t="${Number(t) || 0}">${esc(r.target)} ${fmt(t)}</a>` : esc(r.target || '')}</td>
          <td><textarea data-x="prompt" rows="1" ${['draft', 'approved'].includes(r.status) ? '' : 'disabled'}>${esc(r.prompt)}</textarea></td>
          <td><input data-x="cost" type="number" step="0.05" min="0" value="${Number(r.est_cost) || 0}" style="width:4.5em"></td>
          <td class="refs">${(r.refs || []).map(p => `<a href="${mediaAttr(p)}" target="_blank">${esc(String(p).split('/').pop())}</a>`).join(' ')}${(r.outputs || []).map(p => ` <a class="picked" href="${mediaAttr(p)}" target="_blank">→ ${esc(String(p).split('/').pop())}</a>`).join('')}</td>
          <td class="dim">${esc((r.at || '').replace('T', ' ').slice(5, 16))}</td>
          <td><button data-x="reject" title="reject">✕</button></td></tr>`; }).join('')}</table>` : '<p class="dim">no requests yet</p>'}`;
    };
    render();
    el.addEventListener('click', (e) => {
      const f = e.target.closest('a[data-f]'); if (f) { filter = f.dataset.f; render(); return; }
      const a = e.target.closest('a[data-t]'); if (a) return ctx.goto(Number(a.dataset.t));
      const row = e.target.closest('tr[data-id]'); if (!row) return;
      const id = row.dataset.id, r = store.requests?.items?.find(x => x.id === id), x = e.target.dataset.x;
      if (!r) return;
      if (x === 'cycle' && ORDER.includes(r.status)) store.setRequest(id, { status: ORDER[(ORDER.indexOf(r.status) + 1) % ORDER.length] });
      else if (x === 'cycle' && r.status === 'rejected') store.setRequest(id, { status: 'draft' });
      if (x === 'reject') store.setRequest(id, { status: 'rejected' });
      if (!x) window.WB.selection.set(['request:' + id]);
    });
    el.addEventListener('change', (e) => {
      const row = e.target.closest('tr[data-id]'); if (!row) return;
      if (e.target.dataset.x === 'prompt') store.setRequest(row.dataset.id, { prompt: e.target.value });
      if (e.target.dataset.x === 'cost') store.setRequest(row.dataset.id, { est_cost: Number(e.target.value) || 0 });
    });
    // never re-render under the director's cursor (focused field, or mid-click); a skipped render runs once focus has
    // left the pane and the click is over, so the agent's status changes still show up
    let stale = false, down = false;
    const flush = () => { if (stale && !down && !el.contains(document.activeElement)) { stale = false; render(); } };
    store.on((w) => { if (w !== 'requests' && w !== 'all') return; stale = true; flush(); });
    el.addEventListener('focusout', () => setTimeout(flush));
    el.addEventListener('pointerdown', () => { down = true; });
    document.addEventListener('pointerup', () => { if (down) { down = false; setTimeout(flush); } }, true);
  },
};
