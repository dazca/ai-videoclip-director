// Costs: cap meter, generation spend per job (placed at its first use on the song) and the other ledger rows.
// costs.json items[] are written by the importer and by the agent (request_update -> done records actual_cost_usd).
import { store } from '../js/store.js';
import { fmt } from '../js/timeline.js';
export default {
  mount(el, ctx) {
    el.classList.add('pane');
    const render = () => {
      const C = { items: [], pre_production: [], cap_usd: 0, ...store.costs }, gen = C.items.reduce((s, x) => s + x.usd, 0);
      const other = C.pre_production.filter(r => !/falgen/.test(r.tool) && !/^world layer/.test(r.phase)).reduce((s, x) => s + (x.usd || 0), 0);
      const total = gen + other, pct = C.cap_usd ? Math.min(100, total / C.cap_usd * 100) : 0;
      let run = 0;
      el.innerHTML = `<div class="bar">spent ≈ <b>$${total.toFixed(2)}</b> of cap $${C.cap_usd} (generation $${gen.toFixed(2)}, other $${other.toFixed(2)}${C.fal_total_usd != null ? '; provider total ' + C.fal_total_usd : ''})
        <div class="meter"><i style="width:${pct}%"></i></div></div>
        <table class="tbl"><tr><th>first use</th><th>job</th><th>$</th><th>Σ</th><th>tool</th></tr>${C.items.map(x => { run += x.usd; return `<tr><td><a data-t="${x.t}">${fmt(x.t, true)}</a></td><td>${x.id}</td><td>${x.usd.toFixed(2)}</td><td>${run.toFixed(2)}</td><td class="dim">${x.tool}</td></tr>`; }).join('')}</table>
        ${C.pre_production.length ? `<h4>other rows (ledger)</h4><table class="tbl">${C.pre_production.map(r => `<tr><td>${r.date}</td><td>${r.phase}</td><td>${r.tool}</td><td>${r.usd ?? ''}</td><td class="dim">${r.running}</td></tr>`).join('')}</table>` : ''}`;
    };
    render();
    el.addEventListener('click', (e) => { const a = e.target.closest('a[data-t]'); if (a) ctx.goto(Number(a.dataset.t)); });
    store.on((w) => { if (w === 'all') render(); });
  },
};
