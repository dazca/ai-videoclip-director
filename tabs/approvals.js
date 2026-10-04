// Approvals: counts per state and every item, filterable by kind; click a chip to cycle draft -> approved -> changes.
// Keys, states and by/at/why/comment come from approvals.json (agent-written free text): every value is escaped.
import { store } from '../js/store.js';
import { esc } from '../core/esc.js';
export default {
  mount(el) {
    el.classList.add('pane');
    let filter = '';
    const render = () => {
      const items = Object.entries(store.approvals.items);
      const kinds = [...new Set(items.map(([k]) => k.split(':')[0]))];
      const cnt = {}; for (const [, v] of items) cnt[v.state] = (cnt[v.state] || 0) + 1;
      el.innerHTML = `<div class="bar">${Object.entries(cnt).map(([s, n]) => `<span class="chip s-${esc(s)}">${esc(s)} ${n}</span>`).join(' ')} · rev ${esc(store.approvals.rev)}
        · <select>${['', ...kinds].map(k => `<option ${k === filter ? 'selected' : ''} value="${esc(k)}">${esc(k || 'all kinds')}</option>`).join('')}</select></div>
        <div class="chips">${items.filter(([k]) => !filter || k.startsWith(filter + ':')).map(([k, v]) => `<span class="chip s-${esc(v.state)}" data-k="${esc(k)}" title="${esc(`${v.by} ${v.at}${v.why ? ' · ' + v.why : ''}${v.comment ? ' · ' + v.comment : ''}`)}">${esc(k)}</span>`).join('')}</div>`;
      el.querySelector('select').onchange = (e) => { filter = e.target.value; render(); };
    };
    render();
    el.addEventListener('click', (e) => { const c = e.target.closest('.chips .chip[data-k]'); if (c) store.cycle(c.dataset.k); });
    store.on((w) => { if (w === 'approvals' || w === 'all') render(); });
  },
};
