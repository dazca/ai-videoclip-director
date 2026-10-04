// Costs: cap meter, generation spend per job (placed at its first use on the song) and the other ledger rows.
// costs.json items[] are written by the importer and by the agent (request_update -> done records actual_cost_usd).
import { store } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { esc } from '../core/esc.js';
const usd = (x) => Number(x?.usd) || 0;
export default {
  mount(el, ctx) {
    el.classList.add('pane');
    const render = () => {
      const C = { items: [], pre_production: [], cap_usd: 0, ...store.costs }, gen = C.items.reduce((s, x) => s + usd(x), 0);
      const other = C.pre_production.filter(r => !/falgen/.test(r.tool) && !/^world layer/.test(r.phase)).reduce((s, x) => s + usd(x), 0);
      const cap = Number(C.cap_usd) || 0, total = gen + other, pct = cap ? Math.min(100, total / cap * 100) : 0;
      let run = 0;
      el.innerHTML = `<div class="bar">spent ≈ <b>$${total.toFixed(2)}</b> of cap $${cap} (generation $${gen.toFixed(2)}, other $${other.toFixed(2)}${C.fal_total_usd != null ? '; provider total ' + esc(C.fal_total_usd) : ''})
        <div class="meter"><i style="width:${pct}%"></i></div></div>
        <table class="tbl"><tr><th>first use</th><th>job</th><th>$</th><th>Σ</th><th>tool</th></tr>${C.items.map(x => { run += usd(x); return `<tr><td><a data-t="${Number(x.t) || 0}">${fmt(Number(x.t) || 0, true)}</a></td><td>${esc(x.id)}</td><td>${usd(x).toFixed(2)}</td><td>${run.toFixed(2)}</td><td class="dim">${esc(x.tool)}</td></tr>`; }).join('')}</table>
        ${C.pre_production.length ? `<h4>other rows (ledger)</h4><table class="tbl">${C.pre_production.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.phase)}</td><td>${esc(r.tool)}</td><td>${esc(r.usd ?? '')}</td><td class="dim">${esc(r.running)}</td></tr>`).join('')}</table>` : ''}`;
    };
    render();
    el.addEventListener('click', (e) => { const a = e.target.closest('a[data-t]'); if (a) ctx.goto(Number(a.dataset.t)); });
    store.on((w) => { if (w === 'all') render(); });
  },
};
