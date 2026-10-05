// Review › Approvals (ROADMAP_v4 C3): the same rows as the Final stage (tabs/final.js FinalList: what, why, image, time,
// cost, Approve / Request changes, jump), without the checklist / costs panels and the Notes column; below them the raw
// approvals.json states (every key, click a chip to cycle draft -> approved -> changes). Keys, states and by/at/why/comment
// come from approvals.json (agent-written free text): every value is escaped.
import { store } from '../js/store.js';
import { esc } from '../core/esc.js';
import { FinalList } from './final.js';
export default {
  mount(el, ctx) {
    el.classList.add('apws');
    el.innerHTML = '<div class="aplist"></div><details class="apraw"><summary></summary><div class="chips"></div></details>';
    new FinalList(el.querySelector('.aplist'), ctx, { panels: false, notes: false });
    const raw = el.querySelector('.apraw');
    const render = () => {
      const items = Object.entries(store.approvals.items), cnt = {};
      for (const [, v] of items) cnt[v.state] = (cnt[v.state] || 0) + 1;
      raw.querySelector('summary').innerHTML = `approvals.json: ${Object.entries(cnt).map(([s, n]) => `<span class="chip s-${esc(s)}">${esc(s)} ${n}</span>`).join(' ')} <span class="dim">rev ${esc(store.approvals.rev)}</span>`;
      raw.querySelector('.chips').innerHTML = items.map(([k, v]) => `<span class="chip s-${esc(v.state)}" data-k="${esc(k)}" title="${esc(`${v.by} ${v.at}${v.why ? ' · ' + v.why : ''}${v.comment ? ' · ' + v.comment : ''}`)}">${esc(k)}</span>`).join('');
    };
    render();
    el.addEventListener('click', (e) => { const c = e.target.closest('.chips .chip[data-k]'); if (c) store.cycle(c.dataset.k); });
    store.on((w) => { if (w === 'approvals' || w === 'all') render(); });
  },
};
