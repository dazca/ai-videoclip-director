// The Notes column (docs/SPEC_v4_NOTES_ROUNDS.md §1): ONE component every stage workspace mounts on the right of its
// rows. It lives inside the stage's scroll container (so it scrolls with the rows) and is ROW-ALIGNED: each row of the
// stage (a lyric line, a section, a scene, an item, a tree strip, a node, a shot) gets a cell at the same height; a row
// grows when its notes need more room. A thin "whole stage" row on top holds the notes on the stage itself and the
// notes whose row is gone. Click an empty cell (or Alt+N on the selected row) to type: Enter saves, Shift+Enter is a new
// line, Esc cancels; "@agent " at the start (or the → toggle) makes it an ask for the agent. On a note: ↩ reply,
// ✓ done (absorbed), × dismiss, ↺ reopen. Everything writes notes.json v2 through the store (undoable: Ctrl+Z).
//
//   const nc = new NotesColumn({ stage, scroller, rows: () => [Row], top?: {label, targets}, current?: () => target,
//                                width?: (stageWidth) => px, maxWidth? })
//   The column's width follows the stage: by default ~22% of it (236..400 px); a stage whose rows have a natural width
//   (the lyrics) passes width = what its rows leave, so nothing is left empty to the right (236..maxWidth, default 640;
//   the lyrics: 800).
//   Row = { el | els: [first, last], targets: [target, ...] (the first is the default), match?(note) -> bool,
//           sub?(note) -> short label ("“night bus”", "sh03", "n03 📍"), targetAt?(element) -> target }
//   nc.edit(target, {text?})  open the editor on the row that holds target (a word range, a pin, a sub-row)
//   nc.editCurrent()          Alt+N: the stage's current() target, else its first row
//   nc.rowAt(element)         the row under an element (right-click "+ note here")
//   nc.render() / nc.place()  rebuild / re-align (the column watches the scroller, its rows and the store itself)
import { store, esc, prefs, toast } from '../js/store.js';
import * as N from '../js/notes.js';

const WB = () => window.WB;
export const columns = new Set();   // every mounted column (the context menu finds the one under the pointer)
const when = (at) => at ? String(at).replace('T', ' ').slice(5, 16) : '';
const keyOf = (t) => t ? `${t.stage}|${t.kind}|${t.id ?? ''}` : '';
const first = (r) => r.els ? r.els[0] : r.el;
const last = (r) => r.els ? r.els[r.els.length - 1] : r.el;
const tlabel = (t) => t.kind === 'stage' ? `the whole ${t.stage}` : t.kind === 'line' ? (t.quote ? `“${t.quote}”` : 'this line') : `${t.kind} ${N.splitId(t.id)[1] || t.id}${t.pin ? ' 📍' : ''}`;

export class NotesColumn {
  constructor(o) {
    this.o = o; this.stage = o.stage; this.sc = o.scroller;
    this.filter = prefs.get('ncFilter:' + this.stage, 'open');
    this.on = prefs.get('ncOn', true);
    this.ed = null;          // the open editor {key (row key), target, text, reply?: note id}
    this.rows = []; this.raf = 0; this.need = null; this.mine = new Set(); this.watched = new Set(); this.seq = 0;
    this.layer = document.createElement('div'); this.layer.className = 'nclayer'; this.layer.dataset.stage = this.stage;
    this.topEl = document.createElement('div'); this.topEl.className = 'ncstage';
    this.mine.add(this.layer); this.mine.add(this.topEl);
    this.sc.classList.add('nchost');
    // the stage re-rendered its rows: re-align on the next frame; with a note being typed, at once (a microtask, before the
    // next key reaches the page: the stage's innerHTML took the focused editor out of the document)
    this.mo = new MutationObserver((recs) => { if (!recs.some(r => [...r.addedNodes, ...r.removedNodes].some(x => !this.mine.has(x)))) return; if (this.ed && !this.layer.isConnected) this.render(); else this.schedule('render'); });
    this.mo.observe(this.sc, { childList: true });
    this.ro = new ResizeObserver(() => this.schedule('place'));
    this.ro.observe(this.sc);
    this.unsub = store.on((w) => { if (w === 'notes' || w === 'all') this.schedule('render'); });
    this.wire();
    columns.add(this);
    this.schedule('render');
  }
  get visible() { return this.sc.isConnected && this.sc.offsetParent !== null; }
  schedule(k) {
    this.need = k === 'render' || this.need === 'render' ? 'render' : 'place';
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; const n = this.need; this.need = null; if (n === 'render') this.render(); else this.place(); });
  }
  setOn(on) { this.on = on; prefs.set('ncOn', on); for (const c of columns) c.render(); }
  // ---------------------------------------------------------------- build
  attach() {
    if (this.topEl.parentNode !== this.sc || this.sc.firstChild !== this.topEl) this.sc.prepend(this.topEl);
    if (this.layer.parentNode !== this.sc) this.sc.appendChild(this.layer);
  }
  render() {
    const on = this.on && (!this.o.active || this.o.active());
    this.sc.classList.toggle('ncoff', !on);
    if (!on) { this.layer.remove(); this.topEl.remove(); this.clearGrown(); return; }
    // an open editor survives a re-render of the stage's rows (an agent's change, a live reload): it is rebuilt below
    const live = this.liveEditor(); if (live) this.ed.text = live.value;
    this.attach();
    const top = (typeof this.o.top === 'function' ? this.o.top() : this.o.top) || { label: `the whole ${N.STAGE_TITLE[this.stage].toLowerCase()}`, targets: [{ stage: this.stage, kind: 'stage', id: null }] };
    this.topEl.innerHTML = `<span class="dim">${esc(top.label)}</span>`;
    const rows = [{ el: this.topEl, targets: top.targets, top: true, match: top.match, sub: top.sub }, ...(this.o.rows() || []).filter(r => first(r) && last(r))];
    for (const r of rows) { r.key = keyOf(r.targets[0]) + (r.top ? '|top' : ''); r.notes = []; }
    const shown = (n) => this.filter === 'all' ? true : n.status === 'open';
    const mine = N.notesOn(store.notes, { stage: this.stage }).filter(n => !this.o.scope || this.o.scope(n));
    for (const n of mine) {
      const r = rows.find(x => !x.top && (x.match ? x.match(n) : x.targets.some(t => N.sameTarget(t, n.target)))) || rows.find(x => x.top && (x.match ? x.match(n) : x.targets.some(t => N.sameTarget(t, n.target))));
      if (r) { r.notes.push(n); continue; }
      rows[0].notes.push({ ...n, _gone: true });   // its row is not on screen (a deleted line, another asset's tab, a filtered list)
    }
    const open = mine.filter(n => n.status === 'open').length;
    this.rows = rows;
    this.layer.innerHTML = `<div class="nchead"><b>Notes</b><span class="dim" title="open notes in this stage">${open} open</span><span class="sp"></span><a data-nc="filter" title="show the open notes only, or every note (done and dismissed too)">${this.filter === 'all' ? 'all' : 'open'}</a><a data-nc="hide" title="hide the notes column (View > Notes column)">×</a></div>`
      + rows.map((r, i) => {
        const ns = r.notes.filter(n => shown(n) || (this.ed?.reply === n.id)).sort((a, b) => String(a.created).localeCompare(String(b.created)));
        const editing = this.ed && this.ed.key === r.key && !this.ed.reply;
        return `<div class="nccell${ns.length ? '' : ' empty'}${r.top ? ' top' : ''}" data-row="${i}">${ns.map(n => this.noteHtml(n, r)).join('')}${editing ? this.editorHtml(r) : ''}${!editing ? `<div class="ncadd" data-nc="add" title="add a note here (Alt+N on the selected row)">${ns.length ? '+' : '+ note'}</div>` : ''}</div>`;
      }).join('');
    this.place();
    const ta = this.layer.querySelector('.nced');
    if (ta) { ta.value = this.ed.text || ''; this.grow(ta); if (document.activeElement !== ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); } }
    this.paintRows();
  }
  noteHtml(n, r) {
    const sub = n._gone ? `${N.targetLabel(n.target)} (not here)` : r.sub ? r.sub(n) : n.target.quote ? `“${n.target.quote}”` : n.target.pin ? '📍' : '';
    const ag = n.via === 'agent', st = n.status;
    const acts = st === 'open' ? `<b data-nc="reply" title="reply">↩</b><b data-nc="done" title="done: mark it absorbed">✓</b><b data-nc="dismiss" title="dismiss">×</b>` : `<b data-nc="reply" title="reply">↩</b><b data-nc="reopen" title="reopen">↺</b>`;
    const reps = (n.replies || []).map(x => `<div class="ncr ${x.via === 'agent' ? 'ag' : 'dr'}" title="${esc(`${x.via === 'agent' ? 'agent' : 'director'} · ${when(x.at)}`)}">${esc(x.text)}</div>`).join('');
    const replyEd = this.ed?.reply === n.id ? `<textarea class="nced rep" data-tok="${this.ed.tok}" rows="1" placeholder="reply (Enter saves, Esc cancels)" spellcheck="false"></textarea>` : '';
    return `<div class="ncn s-${st} ${ag ? 'ag' : 'dr'}${n.to === 'agent' ? ' ask' : ''}" data-nid="${esc(n.id)}" title="${esc(`${n.id} · ${ag ? `${n.by && n.by !== 'agent' ? n.by + ' · ' : ''}agent` : 'director'} · ${when(n.created)} · ${st}${n.round ? ' · round ' + n.round : ''}\n${N.targetLabel(n.target)}`)}">`
      + `<span class="ncx">${acts}</span>${sub ? `<i class="ncs">${esc(sub)}</i>` : ''}${n.to === 'agent' ? '<i class="nca" title="an ask for the agent">→ agent</i>' : ''}${st !== 'open' ? `<i class="ncst">${st === 'absorbed' ? '✓' : '×'}</i>` : ''}<span class="ncb">${esc(n.text)}</span>${reps}${replyEd}</div>`;
  }
  editorHtml(r) {
    const t = this.ed.target, opts = r.targets.length > 1 || !r.targets.some(x => keyOf(x) === keyOf(t)) ? [...(r.targets.some(x => keyOf(x) === keyOf(t)) ? [] : [t]), ...r.targets] : null;
    const pick = opts ? `<select class="ncpick" title="what the note is on">${opts.map((x, i) => `<option value="${i}"${keyOf(x) === keyOf(t) && JSON.stringify(x.w || x.pin || null) === JSON.stringify(t.w || t.pin || null) ? ' selected' : ''}>${esc(tlabel(x))}</option>`).join('')}</select>` : `<span class="ncon">${esc(tlabel(t))}</span>`;
    this.edOpts = opts;
    return `<div class="ncedw"><div class="ncedh">on ${pick}<span class="sp"></span><a class="ncto${this.ed.to ? ' on' : ''}" data-nc="to" title="an ask for the agent (it reads it with notes_get)">→ agent</a></div><textarea class="nced" data-tok="${this.ed.tok}" rows="1" placeholder="note (Enter saves · Esc cancels · @agent asks the agent)" spellcheck="false"></textarea></div>`;
  }
  // ---------------------------------------------------------------- align
  clearGrown() { for (const e of this.sc.querySelectorAll('.nc-grown')) { e.style.minHeight = ''; e.classList.remove('nc-grown'); } }
  place() {
    if (!this.on || !this.visible || !this.rows.length || !this.layer.isConnected) return;
    // 0. the width: what the stage leaves (o.width), else a share of it; set on the host (its padding and the layer)
    const W = this.sc.clientWidth, max = this.o.maxWidth || (this.o.width ? 640 : 400);
    const want = Math.round(Math.max(236, Math.min(this.o.width ? this.o.width(W) : W * 0.22, max)));
    if (W && want !== this.w) { this.w = want; this.sc.style.setProperty('--ncw', `${want}px`); }
    const cells = [...this.layer.querySelectorAll('.nccell')];
    // 1. the rows at their own height, the cells at theirs
    for (const r of this.rows) { const L = last(r); if (L.classList.contains('nc-grown')) { L.style.minHeight = ''; L.classList.remove('nc-grown'); } }
    for (const c of cells) c.style.minHeight = '';
    const scR = this.sc.getBoundingClientRect(), st = this.sc.scrollTop;
    const geo = this.rows.map(r => { const a = first(r).getBoundingClientRect(), b = last(r).getBoundingClientRect(); return { h: b.bottom - a.top, lh: b.height }; });
    const ch = cells.map(c => c.offsetHeight);
    // 2. a row grows to its notes (its last element)
    this.rows.forEach((r, i) => { if (ch[i] > geo[i].h + 0.5 && geo[i].h > 0) { const L = last(r); L.style.minHeight = `${Math.ceil(geo[i].lh + ch[i] - geo[i].h)}px`; L.classList.add('nc-grown'); } });
    // 3. the cells on their rows
    const tops = this.rows.map(r => { const a = first(r).getBoundingClientRect(), b = last(r).getBoundingClientRect(); return { top: a.top - scR.top + st, h: b.bottom - a.top, hidden: !a.height && !b.height }; });
    cells.forEach((c, i) => { const g = tops[i]; c.style.display = g.hidden ? 'none' : ''; c.style.top = `${Math.round(g.top)}px`; c.style.minHeight = `${Math.max(0, Math.round(g.h))}px`; });
    this.layer.style.height = `${this.sc.scrollHeight}px`;
    // watch the rows themselves (images loading, an editor opening in a row): re-align
    // (only new elements: observe() always reports once, and re-observing everything would re-align forever)
    const now = new Set(this.rows.flatMap(r => [first(r), last(r)]));
    for (const e of this.watched) if (!now.has(e)) { this.ro.unobserve(e); this.watched.delete(e); }
    for (const e of now) if (!this.watched.has(e)) { this.ro.observe(e); this.watched.add(e); }
  }
  paintRows() {
    for (const e of this.sc.querySelectorAll('.nc-has')) e.classList.remove('nc-has');
    for (const r of this.rows) if (!r.top && r.notes.some(n => n.status === 'open')) first(r).classList.add('nc-has');
  }
  grow(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(160, ta.scrollHeight + 2)}px`; }
  // ---------------------------------------------------------------- editing
  rowFor(target) {
    const k = keyOf(target);
    return this.rows.find(r => !r.top && r.targets.some(t => keyOf(t) === k)) || this.rows.find(r => !r.top && r.match?.({ target }))
      || this.rows.find(r => r.top && (r.targets.some(t => keyOf(t) === k) || r.match?.({ target }))) || null;
  }
  // the textarea of the open editor (a stale one, left from a saved note until the next render, does not count)
  liveEditor() { const t = this.ed && this.layer.querySelector('.nced'); return t && t.dataset.tok === String(this.ed.tok) ? t : null; }
  edit(target, { text = '', to = false } = {}) {
    const live = this.liveEditor(); if (live && live.value.trim()) this.save();   // a note being typed elsewhere is kept
    if (!this.on) this.setOn(true);
    if (!this.rows.length) this.render();
    const r = this.rowFor(target) || this.rows[0];
    this.ed = { key: r.key, target, text, to, tok: ++this.seq };
    this.render();
    this.layer.querySelector('.nced')?.scrollIntoView({ block: 'nearest' });
  }
  editRow(r, target) { this.edit(target || r.targets[0]); }
  editCurrent() { const t = this.o.current?.(); if (t) return this.edit(t); const r = this.rows.find(x => !x.top) || this.rows[0]; if (r) this.edit(r.targets[0]); }
  rowAt(el) { const i = this.rows.findIndex(r => !r.top && (r.els || [r.el]).some(e => e === el || e.contains(el))); if (i >= 0) return this.rows[i]; const c = el.closest?.('.nccell'); return c && this.layer.contains(c) ? this.rows[Number(c.dataset.row)] : null; }
  targetAt(el) { const r = this.rowAt(el); return r ? (r.targetAt?.(el) || r.targets[0]) : null; }
  cancel() { this.ed = null; this.render(); }
  async save() {
    const ta = this.liveEditor(); if (!ta) return;
    let text = ta.value.trim(), to = this.ed.to; ta.dataset.tok = '';
    if (/^@agent\b/i.test(text)) { to = true; text = text.replace(/^@agent\b[:,]?\s*/i, ''); }
    const ed = this.ed; this.ed = null;
    if (!text) return this.render();
    if (ed.reply) { await store.noteReply(ed.reply, text); return; }
    try { await store.noteAdd(ed.target, text, to ? { to: 'agent' } : {}); } catch (e) { toast('note not saved: ' + (e.message || e)); }
  }
  wire() {
    const L = this.layer;
    L.addEventListener('mousedown', (e) => { if (e.target.closest('[data-nc="to"]')) e.preventDefault(); if (e.target.closest('.nced, .ncpick')) e.stopPropagation(); });
    L.addEventListener('click', async (e) => {
      e.stopPropagation();
      const a = e.target.closest('[data-nc]')?.dataset.nc, nid = e.target.closest('[data-nid]')?.dataset.nid, cell = e.target.closest('.nccell');
      if (a === 'filter') { this.filter = this.filter === 'all' ? 'open' : 'all'; prefs.set('ncFilter:' + this.stage, this.filter); return this.render(); }
      if (a === 'hide') { this.setOn(false); toast('notes column hidden: View > Notes column brings it back'); return; }
      if (a === 'to') { this.ed.to = !this.ed.to; e.target.classList.toggle('on', this.ed.to); return; }
      if (nid && a === 'done') return store.noteStatus(nid, 'absorbed');
      if (nid && a === 'dismiss') return store.noteStatus(nid, 'dismissed');
      if (nid && a === 'reopen') return store.noteStatus(nid, 'open');
      if (nid && a === 'reply') { const r = this.rows[Number(cell.dataset.row)]; this.ed = { key: r.key, reply: nid, text: '', tok: ++this.seq }; return this.render(); }
      if (e.target.closest('.ncedw, .nced, .ncn')) return;
      if (cell) { const r = this.rows[Number(cell.dataset.row)]; if (r) this.edit(this.o.current?.() && r.targets.some(t => keyOf(t) === keyOf(this.o.current())) ? this.o.current() : r.targets[0]); }
    });
    L.addEventListener('change', (e) => { if (e.target.matches('.ncpick') && this.edOpts) { const live = this.liveEditor(); if (live) this.ed.text = live.value; this.ed.target = this.edOpts[Number(e.target.value)]; L.querySelector('.nced')?.focus(); } });
    L.addEventListener('input', (e) => { if (e.target.matches('.nced')) { this.grow(e.target); if (this.ed) this.ed.text = e.target.value; this.schedule('place'); } });
    L.addEventListener('keydown', (e) => {
      if (!e.target.matches('.nced')) return;
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.save(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancel(); }
    });
    L.addEventListener('focusout', (e) => {
      if (!e.target.matches('.nced')) return;
      setTimeout(() => { if (!this.ed || e.target.dataset.tok !== String(this.ed.tok) || L.contains(document.activeElement)) return; if (e.target.value.trim()) this.save(); else this.cancel(); }, 120);
    });
    L.addEventListener('mouseover', (e) => {
      const c = e.target.closest('.nccell'); for (const x of this.sc.querySelectorAll('.nc-hl')) x.classList.remove('nc-hl');
      const r = c && this.rows[Number(c.dataset.row)]; if (r && !r.top) for (const x of r.els || [r.el]) x.classList.add('nc-hl');
    });
    L.addEventListener('mouseleave', () => { for (const x of this.sc.querySelectorAll('.nc-hl')) x.classList.remove('nc-hl'); });
  }
  destroy() { this.mo.disconnect(); this.ro.disconnect(); this.unsub?.(); columns.delete(this); this.layer.remove(); this.topEl.remove(); this.clearGrown(); }
}

// the column of the visible stage (Alt+N, "+ note here")
export function visibleColumn() { for (const c of columns) if (c.visible) return c; return null; }
export function columnAt(el) { for (const c of columns) if (c.sc.contains(el)) return c; return null; }
// for the tests and the console: WB.notesCol.visible() is the shown stage's column (rows, layer, edit())
window.WB = Object.assign(window.WB || {}, { notesCol: { visible: visibleColumn, all: () => [...columns] } });
