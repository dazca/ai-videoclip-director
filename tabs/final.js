// Stage 7 workspace: Final (a placeholder until phase 7, ROADMAP_v4 C). For now: every shot of the storyboard in time
// order with its approval state and its generation request or clip, the counts per state, and the Notes column
// (core/notescol.js) row-aligned with the shots: the notes for the last pass ("final" stage, target {kind: "shot"}).
// Approvals stay in the Storyboard stage / Review › Approvals (the director's, page only).
import { store, esc } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { NotesColumn } from '../core/notescol.js';

const STATES = ['draft', 'review', 'changes', 'approved', 'locked'];
let S = null;
class Final {
  constructor(el, ctx) {
    this.el = el; this.ctx = ctx;
    el.classList.add('fnws');
    el.innerHTML = '<div class="lybar fnbar"></div><div class="fnlist" tabindex="-1"></div>';
    this.$ = (s) => el.querySelector(s);
    this.nc = new NotesColumn({ stage: 'final', scroller: this.$('.fnlist'),
      top: { label: 'notes on the final cut', targets: [{ stage: 'final', kind: 'stage', id: null }] },
      rows: () => [...this.el.querySelectorAll('.fnlist .fnrow[data-shot]')].map(e => ({ el: e, targets: [{ stage: 'final', kind: 'shot', id: e.dataset.shot }] })),
      current: () => { const f = this.el.querySelector('.fnrow.on'); return f ? { stage: 'final', kind: 'shot', id: f.dataset.shot } : null; } });
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-t]'); if (t) return this.ctx.goto(Number(t.dataset.t));
      const r = e.target.closest('.fnrow'); if (r) { for (const x of this.el.querySelectorAll('.fnrow.on')) x.classList.remove('on'); r.classList.add('on'); }
    });
    store.on((w) => { if (['board', 'approvals', 'requests', 'all'].includes(w)) this.render(); });
    this.render();
  }
  render() {
    const shots = store.boardShots().sort((a, b) => a.t0 - b.t0), reqs = store.requests?.items || [];
    const count = Object.fromEntries(STATES.map(s => [s, 0])); for (const s of shots) count[store.state('shot:' + s.id)] = (count[store.state('shot:' + s.id)] || 0) + 1;
    this.$('.fnbar').innerHTML = `<b>${shots.length} shots</b><span class="dim">${STATES.filter(s => count[s]).map(s => `${count[s]} ${s}`).join(' · ') || 'none yet'}</span><span class="sp"></span><span class="dim">approve in the Storyboard stage or Review › Approvals · the render checklist comes in phase 7</span>`;
    const on = this.el.querySelector('.fnrow.on')?.dataset.shot;
    this.$('.fnlist').innerHTML = shots.length ? shots.map(s => {
      const st = store.state('shot:' + s.id), r = reqs.filter(x => x.target === 'shot:' + s.id).pop();
      return `<div class="fnrow${s.id === on ? ' on' : ''}" data-shot="${esc(s.id)}" data-sel="shot:${esc(s.id)}"><a class="fnt" data-t="${s.t0}" title="show in the timeline">${fmt(s.t0)}</a><b>${esc(s.id)}</b><span class="chip s-${esc(st)}">${esc(st)}</span><span class="dim fnk">${esc(s.kind || '')}</span><span class="fntx" title="${esc(s.text || s.title || '')}">${esc(s.title || s.text || '')}</span><span class="dim">${(s.clips || []).length ? 'clip ' + esc(String(s.clips[0]).split('@')[0]) : r ? `${esc(String(r.kind).replace('shot-', ''))} · ${esc(r.status)}` : 'no request'}</span></div>`;
    }).join('') : '<div class="scempty">No shots yet: the storyboard (stage 6) makes them.</div>';
  }
}
export default {
  mount(el, ctx) { S = new Final(el, ctx); },
  show() { S?.render(); },
  get ws() { return S; },
};
