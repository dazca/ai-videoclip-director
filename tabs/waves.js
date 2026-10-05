// "Plan waves" (ROADMAP_v4 D4): a dialog over the Queue. The storyboard gaps (shots without a request or clip, and shots
// whose draft requests are in no batch) split into waves of 2 -> 4 -> 8 -> the rest: the pilot first (the shots the
// director ticks, else the first shots in song time), each wave a batch gated on the review of the one before. The plan is
// the server's (waves_plan dry_run, the same op the agent's waves_propose calls); once a wave was reviewed it shows the take
// ratio measured and each wave re-estimated from it (its seconds x the cost per used second). "Create waves" writes DRAFT
// requests and draft batches: nothing is approved or paid (the director approves each batch in the Queue).
import { store, toast } from '../js/store.js';
import { esc } from '../core/esc.js';

let dlg = null;
export function openWaves(o = {}) { if (!dlg) dlg = new WavesDialog(); dlg.show(o); return dlg; }
const money = (x) => `$${(Number(x) || 0).toFixed(2)}`;

class WavesDialog {
  constructor() {
    this.pilot = new Set(); this.sizes = '2, 4, 8'; this.takes = 2; this.plan = null; this.busy = false;
    const el = this.el = document.createElement('div'); el.className = 'imback wvback';
    el.innerHTML = `<div class="imdlg wvdlg" role="dialog" aria-label="Plan waves">
      <div class="imh"><b>Plan waves</b><span class="dim">from the storyboard gaps · a pilot first, then 2 → 4 → 8 → the rest · drafts only: nothing is approved or paid</span><span class="sp"></span><i data-x="close" title="Esc">×</i></div>
      <div class="wvctl"><label title="the wave sizes after the pilot (then the rest)">wave sizes <input data-f="sizes" value="${esc(this.sizes)}" spellcheck="false" style="width:7em"></label>
        <label title="takes per request: 2 measures the take ratio (the estimate covers every take)">takes per shot <select data-f="takes">${[1, 2, 3, 4].map(n => `<option${n === this.takes ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <span class="dim">tick the pilot shots (TREATMENT: "a pilot … to measure the take ratio; the rest only after that"); none ticked = the first shots</span></div>
      <div class="wvbody"><div class="wvcands"></div><div class="wvplan"></div></div>
      <div class="imf"><span class="wvsum dim"></span><span class="sp"></span><button data-x="create" class="pri">Create waves (drafts)</button></div></div>`;
    el.addEventListener('click', (e) => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (e.target === el || x === 'close') return this.hide();
      if (x === 'create') return this.create();
    });
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.pilot) { if (t.checked) this.pilot.add(t.dataset.pilot); else this.pilot.delete(t.dataset.pilot); this.refresh(); }
      if (t.dataset.f === 'takes') { this.takes = Number(t.value) || 1; this.refresh(); }
      if (t.dataset.f === 'sizes') { this.sizes = t.value; this.refresh(); }
    });
    el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.hide(); });
  }
  sizeList() { const s = String(this.sizes).split(/[^\d]+/).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 50); return s.length ? s.slice(0, 8) : [2, 4, 8]; }
  show({ pilot } = {}) { if (Array.isArray(pilot)) this.pilot = new Set(pilot); if (!this.el.isConnected) document.body.appendChild(this.el); this.refresh(); }
  hide() { this.el.remove(); }
  args() { return { pilot: [...this.pilot], sizes: this.sizeList(), takes: this.takes }; }
  async refresh() {
    try { this.plan = await store.op('waves_plan', { ...this.args(), dry_run: true }); } catch (er) { this.plan = null; this.el.querySelector('.wvplan').innerHTML = `<p class="qwhy">${esc(er.message)}</p>`; return; }
    this.render();
  }
  render() {
    const P = this.plan, cands = P.candidates || [], wave = new Map();
    for (const w of P.waves || []) for (const s of w.shots) wave.set(s.shot, w.n);
    this.el.querySelector('.wvcands').innerHTML = cands.length ? `<table class="tbl wvtbl"><tr><th title="the pilot wave">pilot</th><th>shot</th><th>time</th><th>kind</th><th>request</th><th>$ est</th><th>wave</th></tr>
      ${cands.map(c => `<tr data-shot="${esc(c.shot)}"><td><input type="checkbox" data-pilot="${esc(c.shot)}"${this.pilot.has(c.shot) ? ' checked' : ''}></td><td><b>${esc(c.shot)}</b> <span class="dim">${esc(c.title || '')}</span></td><td class="dim">${esc(c.time)}</td><td>${esc(c.kind)}</td>
        <td>${c.requests.length ? `<span class="dim">draft ${esc(c.requests.join(', '))}</span>` : c.draft ? `new ${esc(c.draft.kind)}${c.not_approved ? ` <span class="qwhy" title="assets not approved yet">⚠ ${c.not_approved}</span>` : ''}` : ''}</td>
        <td>${money(c.requests.length ? c.est_usd : (c.draft?.est_usd || 0) * this.takes)}</td><td>${wave.has(c.shot) ? 'W' + wave.get(c.shot) : ''}</td></tr>`).join('')}</table>`
      : '<p class="dim">no gap: every storyboard shot has a request, a clip or a batch already</p>';
    const ob = P.observed || {};
    this.el.querySelector('.wvplan').innerHTML = `${ob.from?.length ? `<div class="qstats">measured by ${ob.from.length} wave${ob.from.length > 1 ? 's' : ''}: <b>${ob.takes_per_used_shot ?? '–'}</b> takes per used shot · <b>${ob.usd_per_used_s != null ? '$' + ob.usd_per_used_s.toFixed(3) : '–'}</b> per used second</div>` : '<div class="dim qstats">no wave reviewed yet: the estimates are list prices; after the pilot they are re-estimated from its take ratio</div>'}
      ${(P.waves || []).map((w, i) => `<div class="wvwave" data-wave="${w.n}"><b>${esc(w.name)}</b> <span>${w.shots.length} shot${w.shots.length === 1 ? '' : 's'} · ${w.seconds} s · est <b>${money(w.est_usd)}</b>${w.observed_usd != null ? ` · observed <b>${money(w.observed_usd)}</b>` : ''}</span>
        <div class="dim">${i ? `locked until Wave ${P.waves[i - 1].n} is reviewed` : 'unlocked: approve it in the Queue'} · ${w.shots.map(s => esc(s.shot)).join(', ')}</div></div>`).join('')}
      ${(P.skipped || []).length ? `<div class="dim">skipped: ${P.skipped.map(s => `${esc(s.shot)} (${esc(s.why)})`).join(', ')}</div>` : ''}`;
    const c = P.cap || {};
    this.el.querySelector('.wvsum').innerHTML = `${(P.waves || []).length} wave${(P.waves || []).length === 1 ? '' : 's'} · ${money(P.total_usd)} at list prices · cap: spent ${money(c.spent_usd)} + committed ${money(c.committed_usd)} + all waves ${money(c.this_usd)} = ${money(c.after_usd)} of ${money(c.cap_usd)}${c.over_cap ? ' · <b class="qwhy">over the cap</b>' : ''}`;
    this.el.querySelector('[data-x=create]').disabled = !(P.waves || []).length || this.busy;
  }
  async create() {
    if (this.busy) return; this.busy = true;
    try { const j = await store.op('waves_plan', this.args()); toast(`${j.batches.length} wave${j.batches.length === 1 ? '' : 's'} as draft batches (${j.batches.join(', ')}) · ${j.requests_created.length} draft request${j.requests_created.length === 1 ? '' : 's'} · approve ${j.batches[0]} in the Queue`); this.pilot.clear(); this.hide(); }
    catch (er) { toast(`not created: ${er.message}`); }
    finally { this.busy = false; }
  }
}
