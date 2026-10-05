// Costs: ONE total spent with a row per source (the workbench's costs.json; when project.json names a falgen folder, its
// ledger rows not already in costs.json and the part of its spent.json no row itemises: lib/store.mjs costSummary, the
// same numbers as the MCP costs_get), the cap meter, generation spend per job (placed at its first use on the song) and
// the other ledger rows. costs.json items[] are written by the importer and by the agent (request_update done records
// actual_cost_usd; cost_record records spend made outside the queue, with its via / job, never as an approval).
import { store, postJSON } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { esc } from '../core/esc.js';
import { priceRows } from '../js/prices.js';
const usd = (x) => Number(x?.usd) || 0;
const $ = (n) => `$${Number(n || 0).toFixed(2)}`;
export default {
  mount(el, ctx) {
    el.classList.add('pane', 'costs');
    let sum = null;
    const load = async () => { try { const r = await postJSON('/api/op/costs_get', {}); if (r.ok) sum = await r.json(); } catch (e) { /* static hosting: the local sums only */ } render(); };
    const render = () => {
      const C = { items: [], pre_production: [], cap_usd: 0, ...store.costs }, gen = C.items.reduce((s, x) => s + usd(x), 0);
      const other = C.pre_production.filter(r => !/falgen/.test(r.tool) && !/^world layer/.test(r.phase)).reduce((s, x) => s + usd(x), 0);
      const cap = Number(C.cap_usd) || 0, total = sum?.total_spent_usd ?? gen, committed = sum?.committed_usd ?? 0, pct = cap ? Math.min(100, (total + committed) / cap * 100) : 0;
      const src = sum?.sources || [{ id: 'workbench', label: 'workbench (costs.json)', usd: gen, rows: C.items.length }], fg = sum?.falgen;
      let run = 0;
      el.innerHTML = `<div class="bar costtotal">spent <b>${$(total)}</b> of cap $${cap}${committed ? ` · approved / queued ${$(committed)}` : ''}${sum?.remaining_usd != null ? ` · remaining ${$(sum.remaining_usd)}` : ''} <span class="dim">(other, not counted: ${$(other)}${C.fal_total_usd != null ? '; provider total ' + esc(C.fal_total_usd) : ''})</span>
        <div class="meter"><i style="width:${pct}%"></i></div></div>
        <table class="tbl costsrc"><tr><th>source</th><th>$</th><th>rows</th><th></th></tr>${src.map(s => `<tr data-src="${esc(s.id)}"><td>${esc(s.label)}</td><td>${$(s.usd)}</td><td>${s.rows ?? ''}</td><td class="dim">${s.deduped ? `${s.deduped} already in costs.json (counted once)` : ''}</td></tr>`).join('')}<tr class="costsum"><td><b>total</b></td><td><b>${$(total)}</b></td><td></td><td class="dim">${fg ? esc(fg.rule) : 'no falgen folder in project.json'}</td></tr></table>
        ${(sum?.warnings || []).map(w => `<div class="chwarn">⚠ ${esc(w)}</div>`).join('')}
        ${fg?.new_rows?.length ? `<h4>falgen rows not in costs.json <span class="dim">${esc(fg.ledger || '')} · read only</span></h4><table class="tbl">${fg.new_rows.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.job)}</td><td>${$(r.usd)}</td><td class="dim">${esc(r.tool)}</td></tr>`).join('')}</table>` : ''}
        <h4>jobs (costs.json)</h4><table class="tbl"><tr><th>first use</th><th>job</th><th>$</th><th>Σ</th><th>tool</th><th>via</th></tr>${C.items.map(x => { run += usd(x); return `<tr><td><a data-t="${Number(x.t) || 0}">${fmt(Number(x.t) || 0, true)}</a></td><td>${esc(x.id)}</td><td>${usd(x).toFixed(2)}</td><td>${run.toFixed(2)}</td><td class="dim">${esc(x.tool)}</td><td class="dim">${esc(x.via || (x.request ? 'request' : ''))}</td></tr>`; }).join('')}</table>
        ${C.pre_production.length ? `<h4>other rows (costs.json pre-production)</h4><table class="tbl">${C.pre_production.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.phase)}</td><td>${esc(r.tool)}</td><td>${esc(r.usd ?? '')}</td><td class="dim">${esc(r.running)}</td></tr>`).join('')}</table>` : ''}
        ${fg?.other_ledger_rows?.length ? `<details><summary class="dim">other ledger rows (${fg.other_ledger_rows.length}, listed, not added)</summary><table class="tbl">${fg.other_ledger_rows.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.phase)}</td><td>${esc(r.tool)}</td><td>${esc(r.usd ?? '')}${r.approx ? ' ~' : ''}</td></tr>`).join('')}</table></details>` : ''}
        <details><summary class="dim">list prices (js/prices.js: every estimate comes from here)</summary><table class="tbl">${priceRows().map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.tier)}</td><td>$${r.usd}${r.unit === 's' ? '/s' : ''}${r.promo_until ? ` (promo until ${esc(r.promo_until)}, then $${r.list_usd})` : ''}</td><td class="dim">verified ${esc(r.verified)}</td></tr>`).join('')}</table></details>`;
    };
    render(); load();
    el.addEventListener('click', (e) => { const a = e.target.closest('a[data-t]'); if (a) ctx.goto(Number(a.dataset.t)); });
    store.on((w) => { if (w === 'all' || w === 'requests') load(); });
  },
};
