// Stage 7 workspace: Final approvals (docs/SPEC_v3_GUIDED.md; ROADMAP_v4 C1-C4). One compact table of everything not
// approved yet, grouped by stage (js/final.js finalView: the same rows final_get gives the agent), each row with its
// thumbnail or text, status, why, cost (estimated / spent), Approve and Request changes (+ a note) and a jump to where it
// lives; the Notes column (core/notescol.js, every stage's notes on the row's targets) row-aligned on the right.
// Above it: the "ready to render" checklist (derived, never stored; each failing line links to its gaps), the costs
// against the cap (the merged ledger, costs_get), and "Lock for render" (page only: closes a revision, marks it final, the
// project refuses agent writes until Unlock).
// Every act goes through the page's own paths: approvals.json / scenes.json / breakdown.json / requests.json saves
// (stamped via "page" by serve.mjs), asset_act (page only), the stage rail's setStatus, the final_lock / final_unlock ops.
// Review › Approvals (tabs/approvals.js, C3) mounts the same list without the panels: new FinalList(el, ctx, {panels: false}).
import { store, esc, mediaUrl, isPrivatePath, postJSON, prefs, toast } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { NotesColumn } from '../core/notescol.js';
import * as FN from '../js/final.js';
import { isTime } from '../core/timemode.js';
import { mountRenders } from '../core/renders.js';

const WB = () => window.WB;
const nowIso = () => new Date().toISOString().slice(0, 19);
const usd = (x) => x == null ? '' : '$' + (Number(x) || 0).toFixed(2).replace(/\.00$/, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const keyOf = (t) => `${t.stage}|${t.kind}|${t.id ?? ''}`;
const NS = { script: 'script', breakdown: 'breakdown', characters: 'characters', scenery: 'scenery', storyboard: 'storyboard' };

export class FinalList {
  constructor(el, ctx, { panels = true, notes = true, stage = 'final' } = {}) {
    this.el = el; this.ctx = ctx; this.o = { panels, notes }; this.pf = panels ? 'fn' : 'ap';
    this.sel = new Set(); this.chg = null; this.confirm = null; this.ledger = null; this.view = null;
    this.f = { group: prefs.get(this.pf + 'Group', ''), st: prefs.get(this.pf + 'St', ''), notes: prefs.get(this.pf + 'Notes', false) };
    el.classList.add('fnws');
    el.innerHTML = `<div class="lybar fnbar"></div><div class="fnlockbar" hidden></div><div class="fnconf" hidden></div>${panels ? '<div class="fntop"></div><div class="fnrend"></div>' : ''}<div class="fnlist" tabindex="-1"></div>`;
    this.$ = (s) => el.querySelector(s);
    // E4 / E8: the render jobs, the director's Render… (with a confirm), the contact sheets and their second opinions (core/renders.js)
    if (panels) mountRenders(this.$('.fnrend'));
    if (notes) this.nc = new NotesColumn({ stage, scroller: this.$('.fnlist'), allStages: true,
      top: { label: 'notes on the final cut', targets: [{ stage: 'final', kind: 'stage', id: null }] },
      scope: (n) => n.target.stage === 'final' || this.tkeys?.has(keyOf(n.target)),
      rows: () => [...this.el.querySelectorAll('.fnlist .fnrow[data-key]')].map(e => { const r = this.byKey?.get(e.dataset.key), nx = e.nextElementSibling?.classList.contains('fnchg') ? e.nextElementSibling : null; return r ? (nx ? { els: [e, nx], targets: r.targets } : { el: e, targets: r.targets }) : null; }).filter(Boolean),
      current: () => { const f = this.el.querySelector('.fnrow.on'); return f ? this.byKey?.get(f.dataset.key)?.targets[0] || null : null; } });
    el.addEventListener('click', (e) => this.click(e));
    // the stage's Time view (core/timemode.js; the Final stage only, not Review › Approvals): rows grouped by song section
    if (panels) document.addEventListener('wb:timemode', (e) => { if (e.detail.stage === 'final') this.render(); });
    el.addEventListener('change', (e) => this.change(e));
    el.addEventListener('keydown', (e) => {
      if (!e.target.matches('.fnchg input')) return;
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.sendChanges(e.target.value); }
      else if (e.key === 'Escape') { e.preventDefault(); this.chg = null; this.render(); }
    });
    store.on((w) => {
      if (['costs', 'requests', 'all'].includes(w)) this.fetchLedger();
      if (['board', 'approvals', 'requests', 'scenes', 'breakdown', 'stages', 'lyrics', 'notes', 'revisions', 'costs', 'media', 'all', 'entities'].includes(w)) this.render();
    });
    this.fetchLedger();
    this.render();
  }
  async fetchLedger() {
    if (!this.o.panels) return;
    const j = await store.costsSummary().catch(() => null);
    if (j && JSON.stringify(j) !== JSON.stringify(this.ledger)) { this.ledger = j; this.render(); }
  }
  input() {
    return { song: store.song, lyrics: store.lyrics, stages: store.stages, scenes: store.scenes, breakdown: store.breakdown, board: store.board, uses: store.uses || [],
      entities: store.entities, approvals: store.approvals, requests: store.requests, notes: store.notes, revisions: store.revisions, costs: store.costs, ledger: this.ledger,
      media: store.media, settings: store.settings, isPrivate: (p) => isPrivatePath(p) || store.mediaByPath?.[p]?.private === true };
  }
  rowsShown() {
    const f = this.f;
    return this.view.rows.filter(r => (!f.group || r.group === f.group) && (!f.st || r.st === f.st) && (!f.notes || r.notes_open));
  }
  // ---------------------------------------------------------------- render
  render() {
    if (this.chg && document.activeElement?.matches('.fnchg input')) this.chg.text = document.activeElement.value;
    const v = this.view = FN.finalView(this.input());
    this.byKey = new Map(v.rows.map(r => [r.key, r]));
    this.tkeys = new Set(v.rows.flatMap(r => r.targets.map(keyOf)));
    for (const k of [...this.sel]) if (!this.byKey.has(k)) this.sel.delete(k);
    const rows = this.rowsShown(), L = v.lock;
    const opt = (val, cur, label) => `<option value="${esc(val)}"${val === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const selRows = [...this.sel].map(k => this.byKey.get(k)).filter(Boolean);
    this.$('.fnbar').innerHTML = `<b title="everything not approved yet, across the stages">${v.counts.total} to approve</b>`
      + `<span class="dim">${FN.ST.filter(s => v.counts[s]).map(s => `${v.counts[s]} ${s}`).join(' · ') || 'nothing pending'}</span>`
      + `<select data-f="group" title="stage">${opt('', this.f.group, 'all stages')}${FN.GROUPS.map(g => opt(g.id, this.f.group, `${g.n ? g.n + ' ' : ''}${g.title} (${v.counts.by_group[g.id] || 0})`)).join('')}</select>`
      + `<select data-f="st" title="status">${opt('', this.f.st, 'any status')}${FN.ST.map(s => opt(s, this.f.st, `${s} (${v.counts[s]})`)).join('')}</select>`
      + `<label class="fnchk" title="only rows with open notes"><input type="checkbox" data-f="notes"${this.f.notes ? ' checked' : ''}>has open notes (${v.counts.notes})</label>`
      + `<span class="sp"></span>`
      + (this.sel.size ? `<span class="dim">${this.sel.size} selected</span><button data-x="approvesel" class="pri" title="approve every selected row (a confirm shows the count and the cost)">Approve selected (${selRows.filter(r => r.act?.approve).length})</button><button data-x="clearsel">Clear</button>` : '')
      + (this.o.panels ? (L ? `<span class="fnlocked" title="${esc(`locked by the director at ${String(L.at).replace('T', ' ')}${L.summary ? '\n' + L.summary : ''}\nagents cannot change anything until you unlock`)}">🔒 Locked for render · ${esc(L.revision)}</span><button data-x="unlock" title="agents may write again">Unlock</button>`
        : '<span class="dim" title="the stage bar’s Lock for render…: close a revision (the final snapshot) and lock the project">lock: the stage bar ↑</span>') : '');   // review #3 (UX 8): one Lock button, the bar's
    const lb = this.$('.fnlockbar'); lb.hidden = !(L && this.o.panels);
    lb.innerHTML = L && this.o.panels ? `🔒 <b>Locked for render</b> · ${esc(L.revision)} (the final snapshot) · ${esc(String(L.at).replace('T', ' ').slice(0, 16))}${L.ready === false ? ` · locked with ${esc((L.failing || []).join(', '))} failing` : ''} · agents cannot change anything (409) until you unlock` : '';
    if (this.o.panels) this.$('.fntop').innerHTML = this.checklistHtml(v) + this.costsHtml(v.costs);
    const gs = FN.GROUPS.map(g => ({ g, rs: rows.filter(r => r.group === g.id) })).filter(x => x.rs.length);
    const on = this.el.querySelector('.fnrow.on')?.dataset.key;
    const tm = this.o.panels && isTime('final');
    this.tgroups = tm ? this.timeGroups(rows) : null;
    this.$('.fnlist').classList.toggle('fntime', tm);
    if (tm) this.$('.fnlist').innerHTML = this.tgroups.length ? this.tgroups.map((g, i) => {
      const all = g.rs.every(r => this.sel.has(r.key));
      return `<div class="fngh fntg" data-tg="${i}"><input type="checkbox" data-tsel="${i}"${all ? ' checked' : ''} title="select these rows"><b>${esc(g.label)}</b>${g.t0 != null ? `<a data-t="${g.t0}" title="show in the timeline">${fmt(g.t0)}–${fmt(g.t1)}</a>` : ''}<span class="dim">${g.rs.length}</span></div>`
        + g.rs.map(r => this.rowHtml(r, r.key === on, true)).join('');
    }).join('') : `<div class="scempty">${v.counts.total ? 'Nothing matches the filters.' : 'Nothing left to approve.'}</div>`;
    else this.$('.fnlist').innerHTML = gs.length ? gs.map(({ g, rs }) => {
      const all = rs.every(r => this.sel.has(r.key));
      return `<div class="fngh" data-g="${g.id}"><input type="checkbox" data-gsel="${g.id}"${all ? ' checked' : ''} title="select the ${esc(g.title.toLowerCase())} rows"><b>${g.n ? g.n + ' · ' : ''}${esc(g.title)}</b><span class="dim">${rs.length}</span>${g.id !== 'requests' && g.id !== 'storyboard' ? `<a data-gostage="${g.id}" title="open the stage">open ›</a>` : g.id === 'storyboard' ? '<a data-gostage="storyboard" title="open the stage">open ›</a>' : '<a data-goview="queue" title="Review › Queue">queue ›</a>'}</div>`
        + rs.map(r => this.rowHtml(r, r.key === on)).join('');
    }).join('') : `<div class="scempty">${v.counts.total ? 'Nothing matches the filters.' : 'Nothing left to approve.'}</div>`;
    if (this.chg) { const i = this.$('.fnchg input'); if (i) { i.value = this.chg.text || ''; if (document.activeElement !== i) i.focus({ preventScroll: true }); } }
    this.renderConfirm();
  }
  // the Time view: the song's sections in time order, each with the rows that sit in it (by their time); rows without a
  // song time (an asset tree, a request without a shot) in a last group
  timeGroups(rows) {
    const secs = [...(store.song?.sections || [])].sort((a, b) => a.t0 - b.t0).map(s => ({ label: store.secLabel(s), t0: s.t0, t1: s.t1, rs: [] }));
    const none = { label: 'no song time', t0: null, rs: [] };
    for (const r of rows) { if (r.t0 == null) { none.rs.push(r); continue; } (secs.find(g => r.t0 >= g.t0 && r.t0 < g.t1) || secs[secs.length - 1] || none).rs.push(r); }
    for (const g of secs) g.rs.sort((a, b) => a.t0 - b.t0);
    return [...secs, none].filter(g => g.rs.length);
  }
  rowHtml(r, on, tm = false) {
    const t = r.t0 != null ? `<a class="fnt" data-t="${r.t0}" title="show in the timeline">${fmt(r.t0)}</a>` : '<span class="fnt"></span>';
    const th = r.thumb ? `<img class="fnth" src="${esc(mediaUrl(r.thumb))}" alt="" loading="lazy">` : `<span class="fnth fnk-${esc(r.kind)}">${esc(r.kind === 'tree' ? r.type?.[0] || 'a' : r.kind === 'request' ? '$' : r.kind[0])}</span>`;
    const ap = r.act?.approve, chgOpen = this.chg?.key === r.key;
    return `<div class="fnrow${on ? ' on' : ''}${this.sel.has(r.key) ? ' picked' : ''}" data-key="${esc(r.key)}"${r.kind === 'shot' ? ` data-shot="${esc(r.id)}" data-sel="shot:${esc(r.id)}"` : ''}>`
      + `<input type="checkbox" data-sel-row${this.sel.has(r.key) ? ' checked' : ''}${ap ? '' : ' disabled title="cannot be approved here yet"'}>${th}${t}`
      + (tm ? `<i class="fnsg" title="stage">${esc(FN.GROUPS.find(g => g.id === r.group)?.title || r.group)}</i>` : '')
      + `<span class="fntx" title="${esc(`${r.title}${r.sub ? '\n' + r.sub : ''}`)}"><b>${esc(r.title)}</b> <span class="dim">${esc(r.sub || '')}</span></span>`
      + `<span class="chip s-${esc(r.st)}" title="${esc(r.status)}">${esc(r.status)}</span>`
      + `<span class="fnwhy" title="${esc(r.why)}">${esc(r.why)}</span>`
      + `<span class="fnc" title="estimated (open requests, else the list price of what it still needs)">${usd(r.est_usd)}</span><span class="fnc sp2" title="spent (costs.json)">${usd(r.spent_usd)}</span>`
      + `<button data-x="approve"${ap ? '' : ' disabled'} title="${esc(ap ? (r.kind === 'request' ? `approve: commits ${usd(r.commit_usd)}` : 'approve (the director\'s)') : r.why)}">✓</button>`
      + `<button data-x="changes" title="request changes: a note on this row${r.act?.changes?.kind === 'approvals' ? ' + state changes' : ''}">✎</button>`
      + `<a class="fnj" data-x="jump" title="go to it">↗</a></div>`
      + (chgOpen ? `<div class="fnchg" data-key="${esc(r.key)}"><span class="dim">changes on ${esc(r.title)}:</span><input placeholder="what to change (Enter sends: a note on the row${r.kind === 'shot' || r.kind === 'use' ? ', state changes' : ''}) · Esc cancels" spellcheck="false" maxlength="8000"></div>` : '');
  }
  checklistHtml(v) {
    const n = v.checklist.filter(c => c.ok).length;
    return `<div class="fnck"><div class="fnph"><b>Ready to render</b><span class="${v.ready ? 'fnok' : 'fnbad'}">${v.ready ? 'yes' : `${n}/${v.checklist.length}`}</span><span class="dim">derived from the files, never stored</span></div>`
      + v.checklist.map(c => `<div class="fnci ${c.ok ? 'ok' : 'bad'}" data-ck="${c.id}"><i>${c.ok ? '✓' : '✗'}</i><span class="fncl">${esc(c.label)}</span><span class="dim fncd" title="${esc(c.detail + (c.warn ? '\n⚠ ' + c.warn : ''))}">${esc(c.detail)}${c.warn ? ` <b class="fnw">⚠ ${esc(c.warn)}</b>` : ''}</span>`
        + (c.ok ? '' : `<span class="fngaps">${c.gaps.map((g, i) => `<a data-gap="${c.id}:${i}" title="go there">${esc(g.label)}</a>${g.publish?.length ? `<a data-pub="${c.id}:${i}" class="fnpub" title="your own private upload: make it public (asks first) so it can be exported">make public…</a>` : ''}`).join('')}${c.more ? `<span class="dim">+${c.more}</span>` : ''}</span>`) + '</div>').join('') + '</div>';
  }
  costsHtml(c) {
    const cap = c.cap || 0, scale = Math.max(cap, c.projected, 0.01), pct = (x) => `${Math.max(0, Math.min(100, x / scale * 100)).toFixed(2)}%`;
    return `<div class="fncost"><div class="fnph"><b>Costs</b><span class="dim">${c.merged ? 'merged ledger (costs_get)' : 'costs.json'}</span><a data-goview="costs" title="Review › Costs">details ›</a></div>`
      + `<div class="fnbarw" title="spent | committed (approved, queued, running) | estimated remaining (drafts + shots not requested yet), against the cap"><div class="fnbarv"><i class="sp" style="width:${pct(c.spent)}"></i><i class="cm" style="width:${pct(c.committed)}"></i><i class="er" style="width:${pct(c.est_remaining)}"></i></div>${cap ? `<b class="cap" style="left:${pct(cap)}" title="cap ${usd(cap)}"></b>` : ''}</div>`
      + `<div class="fncg"><span><i class="sp"></i>spent <b>${usd(c.spent)}</b></span><span><i class="cm"></i>committed <b>${usd(c.committed)}</b></span><span><i class="er"></i>est. remaining <b>${usd(c.est_remaining)}</b> <span class="dim">(drafts ${usd(c.drafts)} + ${c.to_request_shots} shot${c.to_request_shots === 1 ? '' : 's'} ${usd(c.to_request)})</span></span></div>`
      + `<div class="fncg"><span>cap <b>${usd(cap)}</b></span><span class="${c.within ? '' : 'fnbad'}">left <b>${usd(c.left)}</b></span><span class="${c.projected_within ? 'dim' : 'fnbad'}">projected <b>${usd(c.projected)}</b>${c.projected_within ? '' : ' over the cap'}</span></div>`
      + (c.sources?.length ? `<div class="fncg dim" title="${esc(c.sources.map(x => `${x.label}: ${usd(x.usd)}${x.rows != null ? ` (${x.rows} rows)` : ''}`).join('\n'))}">spent by source: ${c.sources.map(x => `${esc(x.id)} ${usd(x.usd)}${x.rows != null ? ` · ${x.rows} row${x.rows === 1 ? '' : 's'}` : ''}`).join(' · ')}</div>` : '')
      + (c.warnings?.length ? `<div class="fnw" title="${esc(c.warnings.join('\n'))}">⚠ ${esc(c.warnings[0])}</div>` : '') + '</div>';
  }
  renderConfirm() {
    const box = this.$('.fnconf'), c = this.confirm;
    box.hidden = !c; if (!c) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="fncfm">${c.html}</div><div class="fncfb"><button data-x="confirm" class="pri">${esc(c.ok)}</button><button data-x="cancel">Cancel</button></div>`;
    box.querySelector('[data-x="confirm"]')?.focus({ preventScroll: true });
  }
  // ---------------------------------------------------------------- events
  change(e) {
    const t = e.target;
    if (t.matches('[data-f]')) { const k = t.dataset.f; this.f[k] = t.type === 'checkbox' ? t.checked : t.value; prefs.set(this.pf + { group: 'Group', st: 'St', notes: 'Notes' }[k], this.f[k]); return this.render(); }
    if (t.matches('[data-sel-row]')) { const k = t.closest('.fnrow').dataset.key; t.checked ? this.sel.add(k) : this.sel.delete(k); return this.render(); }
    if (t.matches('[data-tsel]')) { const rs = (this.tgroups?.[Number(t.dataset.tsel)]?.rs || []).filter(r => r.act?.approve); for (const r of rs) t.checked ? this.sel.add(r.key) : this.sel.delete(r.key); return this.render(); }
    if (t.matches('[data-gsel]')) { const rs = this.rowsShown().filter(r => r.group === t.dataset.gsel && r.act?.approve); for (const r of rs) t.checked ? this.sel.add(r.key) : this.sel.delete(r.key); return this.render(); }
  }
  async click(e) {
    const t = e.target;
    if (t.closest('.fnchg') || t.matches('select, input')) return;
    const x = t.closest('[data-x]')?.dataset.x, row = t.closest('.fnrow'), r = row && this.byKey.get(row.dataset.key);
    if (t.closest('[data-t]') && !x) return this.ctx.goto(Number(t.closest('[data-t]').dataset.t));
    const gs = t.closest('[data-gostage]'); if (gs) return this.jump({ stage: gs.dataset.gostage });
    const gv = t.closest('[data-goview]'); if (gv) return this.jump({ view: gv.dataset.goview });
    const pub = t.closest('[data-pub]'); if (pub) { const [id, i] = pub.dataset.pub.split(':'); const g = this.view.checklist.find(c => c.id === id)?.gaps[Number(i)]; return g?.publish && WB().importMedia?.makePublic(g.publish); }
    const gap = t.closest('[data-gap]'); if (gap) { const [id, i] = gap.dataset.gap.split(':'); const g = this.view.checklist.find(c => c.id === id)?.gaps[Number(i)]; return g && this.jump(g.jump); }
    if (x === 'approve' && r) return this.approve([r]);
    if (x === 'changes' && r) { this.chg = { key: r.key, text: '' }; return this.render(); }
    if (x === 'jump' && r) return this.jump(r.jump);
    if (x === 'approvesel') return this.askApprove();
    if (x === 'clearsel') { this.sel.clear(); return this.render(); }
    if (x === 'lock') return this.askLock();
    if (x === 'unlock') return this.unlock();
    if (x === 'confirm') { const c = this.confirm; this.confirm = null; this.renderConfirm(); return c?.run(); }
    if (x === 'cancel') { this.confirm = null; return this.renderConfirm(); }
    if (row) { for (const y of this.el.querySelectorAll('.fnrow.on')) y.classList.remove('on'); row.classList.add('on'); }
  }
  async jump(j) {
    if (!j) return;
    if (j.view) return WB().app.show(j.view);
    if (j.stage) {
      await WB().stages.open(j.stage);
      const ns = NS[j.stage];
      if (ns && (j.focus || j.scene)) {
        for (let i = 0; i < 40 && !WB()[ns]; i++) await sleep(50);
        const m = WB()[ns];
        if (j.focus && m) (m.focus || m.open)?.call(m, j.focus);
        else if (j.scene && m?.ws?.focusScene) m.ws.focusScene(j.scene);
      }
      return;
    }
    if (j.t != null) return this.ctx.goto(j.t);
  }
  // ---------------------------------------------------------------- the director's acts (page only)
  askApprove() {
    const rows = [...this.sel].map(k => this.byKey.get(k)).filter(Boolean), imp = FN.approveImpact(rows, this.view.costs);
    if (!imp.n) return toast('nothing selected can be approved here');
    const reqN = rows.filter(r => r.kind === 'request').length;
    this.confirm = { ok: `Approve ${imp.n}`, run: () => this.approve(rows.filter(r => r.act?.approve)),
      html: `<b>Approve ${imp.n} item${imp.n > 1 ? 's' : ''}?</b> `
        + `${FN.GROUPS.map(g => [g, rows.filter(r => r.group === g.id && r.act?.approve).length]).filter(([, n]) => n).map(([g, n]) => `${esc(g.title)} ${n}`).join(' · ')}`
        + `<div class="fnimp">${reqN ? `${reqN} request${reqN > 1 ? 's' : ''} commit <b>${usd(imp.commit_usd)}</b>: committed ${usd(this.view.costs.committed)} → <b>${usd(imp.after.committed)}</b>, left ${usd(this.view.costs.left)} → <b class="${imp.after.over ? 'fnbad' : ''}">${usd(imp.after.left)}</b> of the ${usd(this.view.costs.cap)} cap${imp.after.over ? ' (over the cap: the runner will refuse them)' : ''}` : 'nothing is committed or spent: no request among them'}`
        + `${imp.skipped ? ` · ${imp.skipped} cannot be approved here (skipped)` : ''}</div>` };
    this.renderConfirm();
  }
  async approve(rows) {
    const by = (k) => rows.filter(r => r.act?.approve?.kind === k), at = nowIso();
    try {
      const keys = by('approvals').map(r => r.act.approve.key);
      if (keys.length) await store.setStates(keys, 'approved');
      const sc = by('scene').map(r => r.act.approve.id);
      if (sc.length) await store.mutate('scenes.json', (d) => { d.states ||= {}; for (const id of sc) d.states[id] = { status: 'ok', by: 'director', via: 'page', at }; }, { label: `scene${sc.length > 1 ? 's' : ''} ok` });
      const it = by('item').map(r => r.act.approve.id);
      if (it.length) await store.mutate('breakdown.json', (d) => { d.states ||= {}; for (const id of it) d.states[id] = { ...(d.states[id] || {}), status: 'ok', by: 'director', via: 'page', at }; }, { label: `item${it.length > 1 ? 's' : ''} ok` });
      const rq = by('request').map(r => r.act.approve.id);
      if (rq.length) await store.mutate('requests.json', (d) => { for (const x of d.items) if (rq.includes(x.id) && x.status === 'draft') Object.assign(x, { status: 'approved', at }); }, { label: `approve ${rq.length} request${rq.length > 1 ? 's' : ''}` });
      for (const r of by('tree')) { const a = r.act.approve, res = await postJSON('/api/op/asset_act', { type: a.type, id: a.id, act: 'approve', tree: a.tree, node: a.node }); if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`); }
      for (const r of by('stage')) await WB().stages.setStatus(r.act.approve.stage, 'done');
      for (const r of rows) this.sel.delete(r.key);
      toast(`${rows.length} approved`);
    } catch (e) { toast('not approved: ' + (e.message || e)); }
    this.render();
  }
  async sendChanges(text) {
    const r = this.byKey.get(this.chg?.key); text = String(text || '').trim();
    if (!r) { this.chg = null; return this.render(); }
    if (!text) return toast('say what to change (the note is what the agent reads)');
    this.chg = null;
    const c = r.act.changes, at = nowIso();
    try {
      await store.noteAdd(r.targets[0], r.kind === 'request' ? `${r.id}: ${text}` : text);
      if (c.kind === 'approvals') await store.setState(c.key, 'changes', text.slice(0, 500));
      else if (c.kind === 'scene' && store.scenes?.states?.[c.id]?.status === 'needs_you') await store.mutate('scenes.json', (d) => { d.states[c.id] = { status: 'draft', by: 'director', via: 'page', at }; }, { label: `scene ${c.id} draft` });
      else if (c.kind === 'item' && store.breakdown?.states?.[c.id]?.status === 'review') await store.mutate('breakdown.json', (d) => { d.states[c.id] = { ...(d.states[c.id] || {}), status: 'draft', by: 'director', via: 'page', at }; }, { label: `item ${c.id} draft` });
      else if (c.kind === 'tree' && c.variant && c.vstatus === 'review') await postJSON('/api/op/asset_act', { type: c.type, id: c.id, act: c.type === 'character' ? 'look_status' : 'variant_status', [c.type === 'character' ? 'look' : 'variant']: c.variant, status: 'draft' });
      toast(`changes asked on ${r.title}`);
    } catch (e) { toast('not saved: ' + (e.message || e)); }
    this.render();
  }
  askLock() {
    const v = this.view, bad = v.checklist.filter(c => !c.ok);
    this.confirm = { ok: bad.length ? 'Lock anyway' : 'Lock for render', run: () => this.lock(bad.length > 0),
      html: bad.length ? `<b>${bad.length} check${bad.length > 1 ? 's' : ''} fail:</b> ${bad.map(c => esc(c.label)).join(' · ')}. <div class="fnimp">Lock anyway? It closes a revision (the final snapshot) with ${v.counts.total} item${v.counts.total === 1 ? '' : 's'} not approved; agents cannot change anything until you unlock.</div>`
        : `<b>Lock for render?</b><div class="fnimp">Closes a revision (the final snapshot) and marks it final. Agents cannot change anything until you unlock.</div>` };
    this.renderConfirm();
  }
  async lock(force) {
    const r = await postJSON('/api/op/final_lock', { force }), j = await r.json().catch(() => ({}));
    if (!r.ok) return toast('not locked: ' + (j.error || r.status));
    toast(`locked for render: ${j.revision}`);
  }
  async unlock() {
    const r = await postJSON('/api/op/final_unlock', {}), j = await r.json().catch(() => ({}));
    if (!r.ok) return toast('not unlocked: ' + (j.error || r.status));
    toast(`unlocked (${j.unlocked})`);
  }
}

let S = null;
export default {
  mount(el, ctx) { S = new FinalList(el, ctx); window.WB.final = { get ws() { return S; } }; },
  show() { S?.render(); },
  get ws() { return S; },
};
window.WB = Object.assign(window.WB || {}, { stageActions: { ...(window.WB?.stageActions || {}), final: { canSave: () => false, save: () => {},
  // F8: the stage bar's primary act on Final: Lock for render… (Unlock while locked); the panel's own button stays
  primary: { get label() { return S?.view?.lock ? 'Unlock' : 'Lock for render…'; }, title: 'Lock for render: close a revision (the final snapshot) and lock the project (agents cannot change anything until you unlock)', can: () => !!S?.view, run: () => (S.view.lock ? S.unlock() : S.askLock()) },
  canNote: () => !!S?.nc && WB().stages?.current() === 'final', note: () => S.nc.editCurrent() } } });
