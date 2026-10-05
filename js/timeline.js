// Vertical synced timeline: columns side by side, one warped time axis y(t) shared by all of them.
// Text columns in "drive" mode push the axis (their measured heights become constraints); "follow" columns clip to it;
// lane columns (waveform, stems, energy, ruler) are drawn per pixel row of the viewport through t(y), so audio
// stretches with the text. Columns can be resized down to 3 px, collapsed to a strip, hidden; layout persists.
import { buildWarp, upperBound } from './warp.js';
import { store, prefs } from './store.js';
import { makeColumns } from './columns.js';
import { Player } from './player.js';

const STRIP_W = 10;            // text columns narrower than this render as a tick strip
const READ_LINE = 0.3;         // reading line (fraction of the viewport) used for follow-scroll and scroll anchoring

export class Timeline {
  constructor(root) {
    this.root = root;
    this.layout = prefs.get('layout', {});
    this.pxPerSec = prefs.get('pxPerSec', 16);
    this.linear = prefs.get('linear', false);
    this.headerMode = prefs.get('headerMode', 0); // 0 full, 1 thin, 2 hidden
    this.follow = true;
    this.loop = null;
    this.folds = new Set(prefs.get('folds', []));   // section ids folded to a thin band
    this.hoverCol = null;
    this.perf = { relayouts: [], firstRender: 0 };
    this.player = new Player(this);   // lives across rebuilds: a data reload must not stop playback
    this.build();
  }

  // ------------------------------------------------------------------ DOM
  build() {
    const t0 = performance.now();
    this.root.innerHTML = '';
    this.root.classList.add('tl');
    this.scroller = el('div', 'scroller'); this.root.appendChild(this.scroller);
    this.heads = el('div', 'heads'); this.scroller.appendChild(this.heads);
    this.sheet = el('div', 'sheet'); this.scroller.appendChild(this.sheet);
    this.loopShade = el('div', 'loopshade'); this.sheet.appendChild(this.loopShade);
    this.playhead = el('div', 'playhead'); this.sheet.appendChild(this.playhead);
    this.selShade = el('div', 'selshade'); this.sheet.appendChild(this.selShade);
    this.picker = el('button', 'picker'); this.picker.textContent = '⋮'; this.picker.title = 'columns (show / hide)';
    this.picker.onclick = (e) => { e.stopPropagation(); this.openPicker(); };
    this.root.appendChild(this.picker);
    // restore control for a hidden column header: a 12 px chevron at the top edge of the time ruler (shown by CSS only
    // when the header is hidden; positioned in applyColumns)
    this.hdrRestore = el('button', 'hdrrestore'); this.hdrRestore.textContent = '⌄';
    this.hdrRestore.title = 'Show the column header (Alt+H cycles full / thin / hidden)'; this.hdrRestore.setAttribute('aria-label', 'Show the column header');
    this.hdrRestore.onclick = (e) => { e.stopPropagation(); this.setHeaderMode(0); };
    this.root.appendChild(this.hdrRestore);
    this.applyHeaderMode();

    this.defs = makeColumns(this, store);
    this.cols = this.defs.map((d) => {
      const L = this.layout[d.id] || {};
      const c = { def: d, id: d.id, w: L.w ?? d.w, hidden: L.hidden ?? !!d.hidden, collapsed: L.collapsed ?? false,
        mode: L.mode ?? d.mode ?? 'follow', items: [], constraints: [], dirty: true, x: 0, vw: 0 };
      c.el = el('div', `col col-${d.id} kind-${d.kind}`); c.el.dataset.col = d.id;
      c.canvas = el('canvas', 'lane'); c.el.appendChild(c.canvas);
      c.body = el('div', 'body'); c.el.appendChild(c.body);
      c.head = el('div', 'head'); c.head.dataset.col = d.id;
      c.head.innerHTML = `<span class="nm" title="${d.title}">${d.title}</span><span class="hb">${d.kind === 'text' ? '<b data-h="mode" title="drive: pushes the time axis / follow: clips to it"></b>' : ''}<b data-h="collapse" title="collapse to a strip">▸</b><b data-h="hide" title="hide">×</b></span><i class="gut" title="drag to resize"></i>`;
      this.heads.appendChild(c.head); this.sheet.appendChild(c.el);
      return c;
    });
    const order = prefs.get('colOrder', null);
    if (order) this.cols.sort((a, b) => { const i = order.indexOf(a.id), j = order.indexOf(b.id); return (i < 0 ? 1e3 : i) - (j < 0 ? 1e3 : j); });
    this.byId = Object.fromEntries(this.cols.map(c => [c.id, c]));
    for (const c of this.cols) if (c.def.kind === 'text') c.def.build(c);
    this.bind();
    this.fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();
    this.applyColumns();
    this.relayout({ all: true });
    this.perf.firstRender = performance.now() - t0;
    this.unsub = store.on((what) => this.onData(what));
    this.player.setSource();          // the mix may have changed with the data
  }

  onData(what) {
    if (what === 'all') { const t = this.timeAtRead(); this.destroy(); this.build(); this.scrollToTime(t); return; }
    if (what === 'approvals' || what === 'notes' || what === 'scenes' || what === 'breakdown' || what === 'board') {
      for (const c of this.cols) if (c.def.refresh && c.def.refresh(c, what)) c.dirty = true;
      this.relayout({});
    }
    if (what === 'peaks') this.drawLanes();
    if (what === 'overrides') { const c = this.byId.sections; c.def.build(c); c.dirty = true; this.relayout({}); window.WB?.selection?.paint(); }
  }
  // DOM teardown before build(); the player is kept (playback continues), so build() can follow directly
  destroy() { this.unsub?.(); this.ro?.disconnect(); this.root.innerHTML = ''; }

  applyHeaderMode() {
    this.root.dataset.header = ['full', 'thin', 'none'][this.headerMode];
    this.headH = [16, 5, 0][this.headerMode];
  }

  // positions/widths of visible columns; the notes column (or the last visible) takes any spare width
  applyColumns() {
    const vis = this.cols.filter(c => !c.hidden);
    const avail = this.root.clientWidth - (this.scroller.offsetWidth - this.scroller.clientWidth);
    let x = 0;
    const eff = (c) => c.collapsed ? STRIP_W - 4 : Math.max(3, Math.round(c.w));
    let sum = vis.reduce((s, c) => s + eff(c), 0);
    const flex = vis.find(c => c.id === 'notes' && !c.collapsed) || vis[vis.length - 1];
    // too wide for the window (1280 px with the default columns): the wide text columns give up width, down to 65% of
    // their own (never below 60 px), in proportion to what they can give, so the notes column (the last one) stays whole
    // on screen; only what is still left over scrolls sideways
    const give = new Map();
    if (sum > avail && avail > 0) {
      const can = vis.filter(c => c !== flex && c.def.kind === 'text' && !c.collapsed && eff(c) > 90).map(c => [c, eff(c) - Math.max(60, Math.round(eff(c) * 0.65))]);
      const room = can.reduce((s, [, g]) => s + g, 0), need = Math.min(room, sum - avail);
      if (need > 0) for (const [c, g] of can) give.set(c, Math.floor(need * g / room));
      sum -= [...give.values()].reduce((s, g) => s + g, 0);
    }
    for (const c of this.cols) {
      if (c.hidden) { c.el.style.display = 'none'; c.head.style.display = 'none'; c.vw = 0; continue; }
      let w = eff(c) - (give.get(c) || 0);
      if (c === flex && sum < avail) w += avail - sum;
      const strip = c.def.kind === 'text' && (c.collapsed || w < STRIP_W);
      if (w !== c.vw || strip !== c.strip) c.dirty = true;
      c.vw = w; c.x = x; c.strip = strip; x += w;
      for (const e of [c.el, c.head]) { e.style.display = ''; e.style.left = c.x + 'px'; e.style.width = w + 'px'; }
      c.el.classList.toggle('strip', strip); c.head.classList.toggle('strip', strip);
      c.head.classList.toggle('narrow', w < 40);
      const mb = c.head.querySelector('[data-h=mode]'); if (mb) mb.textContent = c.mode === 'drive' ? 'D' : 'F';
    }
    this.sheet.style.width = x + 'px'; this.heads.style.width = x + 'px';
    const r = this.byId?.ruler; this.hdrRestore.style.left = (r && !r.hidden ? r.x + Math.max(0, (r.vw - 12) >> 1) : 0) + 'px';
  }

  save() {
    const L = {};
    for (const c of this.cols) L[c.id] = { w: c.w, hidden: c.hidden, collapsed: c.collapsed, mode: c.mode };
    this.layout = L; prefs.set('layout', L); prefs.set('pxPerSec', this.pxPerSec); prefs.set('linear', this.linear); prefs.set('headerMode', this.headerMode);
    prefs.set('colOrder', this.cols.map(c => c.id)); prefs.set('folds', [...this.folds]);
  }

  // ------------------------------------------------------------------ warp
  timeAtRead() { return this.warp ? this.warp.t(this.scroller.scrollTop + this.readOffset()) : 0; }
  readOffset() { return Math.max(0, (this.scroller.clientHeight - this.headH) * READ_LINE); }
  scrollToTime(t) { this.scroller.scrollTop = Math.max(0, this.warp.y(t) - this.readOffset()); }

  relayout({ all = false } = {}) {
    const t0 = performance.now();
    const tRef = this.warp ? this.timeAtRead() : 0;
    const song = store.song, dur = song.duration_ms;
    const vis = this.cols.filter(c => !c.hidden);
    // 1. measure driving text columns whose width/content changed (one batch of reads)
    const drivers = vis.filter(c => c.def.kind === 'text' && !c.strip && c.mode === 'drive' && !this.linear);
    for (const c of vis) if (c.def.kind === 'text' && !c.strip && (c.dirty || all) && c.def.prepare) c.def.prepare(c); // writes (lyrics re-wrap)
    for (const c of drivers) if (c.dirty || all || !c.constraints.length) c.constraints = c.def.measure ? c.def.measure(c) : measureItems(c);
    // 2. anchors: section bounds, line onsets, shot cuts (always), plus every constraint end
    const anchors = [];
    for (const s of song.sections) anchors.push(s.t0, s.t1);
    for (const l of song.lines) anchors.push(l.t0);
    for (const s of store.boardShots()) anchors.push(s.t0, s.t1);   // the storyboard's shots (else shots.json's)
    const folds = this.foldRanges();
    const inFold = (t) => folds.some(f => t >= f.t0 && t < f.t1);
    const cons = [];
    for (const c of drivers) for (const k of c.constraints) if (!folds.length || !inFold(k.t0)) cons.push(k);
    this.warp = buildWarp({ duration: dur, pxPerSec: this.pxPerSec, anchorTimes: anchors, constraints: cons, linear: this.linear, folds });
    // 3. place
    this.sheet.style.height = Math.ceil(this.warp.total + this.scroller.clientHeight * 0.7) + 'px';
    for (const c of vis) {
      if (c.def.kind !== 'text') continue;
      c.body.style.display = c.strip ? 'none' : '';
      if (!c.strip) placeItems(c, this.warp, c.mode === 'drive' && !this.linear, c.id === 'sections' ? null : (folds.length ? inFold : null));
      c.dirty = false;
    }
    // 4. scroll anchored by time, lanes, playhead
    if (this._restoreT != null) { this.scrollToTime(this._restoreT); this._restoreT = null; } else this.scrollToTime(tRef);
    this.drawLanes();
    this.updatePlayhead(this.player.time());
    this.updateLoop(); this.updateSelRange();
    const dt = performance.now() - t0;
    this.perf.relayouts.push(dt); if (this.perf.relayouts.length > 200) this.perf.relayouts.shift();
    return dt;
  }

  // ------------------------------------------------------------------ lanes
  drawLanes() {
    if (!this.warp) return;
    const dpr = window.devicePixelRatio || 1;
    const vh = Math.max(1, this.scroller.clientHeight - this.headH);
    const top = this.scroller.scrollTop;
    const rows = Math.ceil(vh * dpr);
    // t at every device-row boundary, shared by all lanes this frame
    if (!this.rowsT || this.rowsT.length !== rows + 1) this.rowsT = new Float64Array(rows + 1);
    const W = this.warp;
    for (let r = 0; r <= rows; r++) this.rowsT[r] = W.t(top + r / dpr);
    this.lastRows = { top, dpr, rows };
    for (const c of this.cols) {
      const lane = !c.hidden && (c.def.kind === 'lane' || c.strip);
      c.canvas.style.display = lane ? '' : 'none';
      if (!lane) continue;
      const w = Math.max(1, Math.round(c.vw * dpr));
      if (c.canvas.width !== w || c.canvas.height !== rows) { c.canvas.width = w; c.canvas.height = rows; }
      c.canvas.style.width = c.vw + 'px'; c.canvas.style.height = vh + 'px'; c.canvas.style.top = this.headH + 'px';
      const ctx = c.canvas.getContext('2d');
      ctx.clearRect(0, 0, w, rows);
      const env = { ctx, w, rows, dpr, top, rowsT: this.rowsT, warp: W, yOf: (t) => (W.y(t) - top) * dpr };
      if (c.strip) drawStrip(c, env); else c.def.draw(c, env);
    }
  }

  // ------------------------------------------------------------------ playhead, karaoke, loop
  updatePlayhead(t) {
    if (!this.warp) return;
    this.playhead.style.transform = `translateY(${this.warp.y(t)}px)`;
    for (const c of this.cols) if (!c.hidden && !c.strip && c.def.tick) c.def.tick(c, t);
    const hd = this.byId.ruler?.head.querySelector('.nm');
    if (hd) hd.textContent = fmt(t, true);
  }
  tickPlaying(t) {
    this.updatePlayhead(t);
    if (this.follow) {
      const want = this.warp.y(t) - this.readOffset();
      if (Math.abs(this.scroller.scrollTop - want) > 0.5) this.scroller.scrollTop = want;
    }
  }
  setLoop(range) { this.loop = range; this.updateLoop(); }
  updateLoop() {
    if (!this.loop) { this.loopShade.style.display = 'none'; return; }
    const y0 = this.warp.y(this.loop.t0), y1 = this.warp.y(this.loop.t1);
    Object.assign(this.loopShade.style, { display: '', top: y0 + 'px', height: (y1 - y0) + 'px' });
  }
  seek(t) { this.player.seek(t); this.updatePlayhead(t); }
  updateSelRange() {
    const r = window.WB?.selection?.range;
    if (!r || !this.warp) { this.selShade.style.display = 'none'; return; }
    const y0 = this.warp.y(r.t0), y1 = this.warp.y(r.t1);
    Object.assign(this.selShade.style, { display: '', top: y0 + 'px', height: Math.max(1, y1 - y0) + 'px' });
  }
  foldRanges() { return this.folds.size ? store.song.sections.filter(s => this.folds.has(s.id)).map(s => ({ t0: s.t0, t1: s.t1 })) : []; }
  toggleFold(id) { this.folds.has(id) ? this.folds.delete(id) : this.folds.add(id); for (const c of this.cols) c.dirty = true; this.save(); this.relayout({ all: true }); }

  // ------------------------------------------------------------------ events
  bind() {
    let raf = 0;
    const schedule = (fn) => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fn(); }); };
    this.scroller.addEventListener('scroll', () => schedule(() => this.drawLanes()), { passive: true });
    this.scroller.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.scroller.addEventListener('pointermove', (e) => { this.hoverCol = this.colAtClientX(e.clientX); }, { passive: true });
    // middle-drag = pan
    this.scroller.addEventListener('pointerdown', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY, sl = this.scroller.scrollLeft, st = this.scroller.scrollTop;
      const move = (ev) => { this.scroller.scrollLeft = sl - (ev.clientX - x0); this.scroller.scrollTop = st - (ev.clientY - y0); this.follow = false; };
      onDrag(move);
    });
    this.scroller.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    // widths: ResizeObserver on the timeline root (window resize), re-warp at most once per frame
    let pending = false;
    this.requestRelayout = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; this.applyColumns(); this.relayout(); }); };
    this.ro = new ResizeObserver(() => this.requestRelayout()); this.ro.observe(this.root);
    // header buttons + drag handles
    this.heads.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('.head'); if (!head || e.button !== 0) return;
      const c = this.byId[head.dataset.col];
      if (e.target.classList.contains('gut')) return this.dragResize(e, c);
      const h = e.target.dataset.h;
      if (!h) return this.dragReorder(e, c);
      if (h === 'hide') { c.hidden = true; }
      else if (h === 'collapse') { c.collapsed = !c.collapsed; }
      else if (h === 'mode') { c.mode = c.mode === 'drive' ? 'follow' : 'drive'; c.dirty = true; }
      else return;
      e.preventDefault(); this.save(); this.applyColumns(); this.relayout(); this.drawLanes();
    });
    // the 1 px separator in the sheet is also a handle
    this.sheet.addEventListener('pointermove', (e) => { this.sheet.style.cursor = this.edgeAt(e) ? 'col-resize' : ''; });
    this.sheet.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const c = this.edgeAt(e); if (c) { e.preventDefault(); this.dragResize(e, c); return; }
      if (e.target.closest('.col-ruler')) this.dragRange(e);
    });
    this.heads.addEventListener('dblclick', (e) => {
      const head = e.target.closest('.head'); if (!head) return;
      if (e.target.classList.contains('gut')) this.resetWidth(head.dataset.col); else if (!e.target.dataset.h) this.autoFit(head.dataset.col);
    });
    // click anywhere = seek to that exact ms (inverse map); items with data-act handle their own clicks
    this.sheet.addEventListener('click', (e) => {
      if (this._dragged) { this._dragged = false; return; }
      const S = window.WB?.selection;
      const selEl = e.target.closest('[data-sel]');
      if (S && e.shiftKey) {                      // Shift+click: extend the selection (items) or the time range
        if (selEl) S.toggle(selEl.dataset.sel);
        else { const t = this.timeAtClientY(e.clientY), a = S.range ? S.range.t0 : this.player.time(); S.setRange({ t0: Math.min(a, t), t1: Math.max(a, t) }); }
        return;
      }
      if (S) { if (selEl) S.set([selEl.dataset.sel]); else if (S.keys.size || S.range) S.clear(); }
      const act = e.target.closest('[data-act]');
      if (act) { const c = this.byId[act.closest('.col').dataset.col]; c.def.act?.(c, act, e); return; }
      const t = this.timeAtClientY(e.clientY);
      this.seek(t);
      // a column may take the click (the notes column: a new note at that time)
      const colEl = e.target.closest('.col'), cc = colEl && this.byId[colEl.dataset.col];
      if (cc?.def.click && !cc.strip) cc.def.click(cc, t, e);
    });
    this.sheet.addEventListener('dblclick', (e) => {
      const edge = this.edgeAt(e); if (edge) { this.resetWidth(edge.id); return; }
      const colEl = e.target.closest('.col'); if (!colEl) return;
      const c = this.byId[colEl.dataset.col]; c.def.dblclick?.(c, this.timeAtClientY(e.clientY), e);
    });
  }
  timeAtClientY(cy) { const r = this.sheet.getBoundingClientRect(); return Math.round(this.warp.t(cy - r.top)); }
  edgeAt(e) {
    const r = this.sheet.getBoundingClientRect(); const x = e.clientX - r.left;
    return this.cols.find(c => !c.hidden && Math.abs(c.x + c.vw - x) <= 2) || null;
  }
  dragResize(e, c) {
    e.preventDefault();
    const x0 = e.clientX, w0 = c.collapsed ? STRIP_W - 4 : c.vw;
    c.collapsed = false;
    const move = (ev) => { c.w = Math.max(3, w0 + ev.clientX - x0); this._dragged = true; this.requestRelayout(); };
    onDrag(move, () => { this.save(); setTimeout(() => this._dragged = false, 0); });
  }
  setWidth(id, w) { const c = this.byId[id]; c.w = w; c.collapsed = false; this.applyColumns(); const dt = this.relayout(); this.save(); return dt; }
  colAtClientX(x) { const r = this.sheet.getBoundingClientRect(); const xx = x - r.left; return this.cols.find(c => !c.hidden && xx >= c.x && xx < c.x + c.vw) || null; }
  resetWidth(id) { this.setWidth(id, this.byId[id].def.w); }
  autoFit(id) {
    const c = this.byId[id]; if (!c) return;
    let w = c.def.w;
    if (c.def.kind === 'text') {
      if (id === 'lyrics') {
        const cv = document.createElement('canvas').getContext('2d'); cv.font = getComputedStyle(c.body).font;
        w = Math.ceil(Math.max(40, ...store.song.lines.map(l => cv.measureText(l.words.map(x => x.w).join(' ')).width))) + 8;
      } else {
        const probe = el('div', 'fitprobe'); c.body.appendChild(probe); let m = 24;
        for (const it of c.items.slice(0, 400)) { probe.innerHTML = it.el.innerHTML; m = Math.max(m, probe.scrollWidth); }
        probe.remove(); w = Math.min(360, m + 4);
      }
    }
    this.setWidth(id, Math.max(3, Math.round(w)));
  }
  moveCol(id, d) {
    const vis = this.cols.filter(c => !c.hidden), i = vis.findIndex(c => c.id === id), j = i + d;
    if (i < 0 || j < 0 || j >= vis.length) return;
    const a = this.cols.indexOf(vis[i]), b = this.cols.indexOf(vis[j]);
    [this.cols[a], this.cols[b]] = [this.cols[b], this.cols[a]];
    this.save(); this.applyColumns(); this.relayout();
  }
  dragReorder(e, c) {
    const x0 = e.clientX; let on = false, mark = null, target = null;
    const move = (ev) => {
      if (!on && Math.abs(ev.clientX - x0) < 5) return;
      if (!on) { on = true; c.head.classList.add('dragging'); mark = el('div', 'dropmark'); this.heads.appendChild(mark); }
      const r = this.sheet.getBoundingClientRect(), x = ev.clientX - r.left;
      const vis = this.cols.filter(k => !k.hidden);
      target = vis.find(k => x < k.x + k.vw / 2) || null;
      const last = vis[vis.length - 1];
      mark.style.left = ((target ? target.x : last.x + last.vw) - 1) + 'px';
    };
    onDrag(move, (ev) => {
      if (!on) return;
      c.head.classList.remove('dragging'); mark?.remove();
      if (ev.type === 'pointerup' && target !== c) {
        this.cols.splice(this.cols.indexOf(c), 1);
        const k = target ? this.cols.indexOf(target) : this.cols.length;
        this.cols.splice(k, 0, c);
        this.save(); this.applyColumns(); this.relayout();
      }
    });
  }
  // drag on the ruler = select a time range (a plain click still seeks)
  dragRange(e) {
    const t0 = this.timeAtClientY(e.clientY), y0 = e.clientY; let on = false;
    const move = (ev) => {
      if (!on && Math.abs(ev.clientY - y0) < 4) return;
      on = true; this._dragged = true;
      const t = this.timeAtClientY(ev.clientY);
      window.WB.selection.setRange({ t0: Math.min(t0, t), t1: Math.max(t0, t) });
    };
    onDrag(move, () => { if (on) setTimeout(() => this._dragged = false, 0); });
  }
  // wheel: plain = scroll time; Ctrl (and touchpad pinch) = zoom time at the cursor; Alt or Ctrl+Shift = width of the
  // column under the cursor; Shift = horizontal scroll
  onWheel(e) {
    if (this.player.playing && !e.ctrlKey && !e.altKey) { this.follow = false; clearTimeout(this._fT); this._fT = setTimeout(() => this.follow = true, 2500); }
    const d = e.deltaY || e.deltaX;
    if ((e.ctrlKey && e.shiftKey) || e.altKey) {
      e.preventDefault();
      const c = this.colAtClientX(e.clientX); if (!c || !d) return;
      const step = Math.max(1, Math.round(c.vw * 0.08)) * (d < 0 ? 1 : -1);
      c.w = Math.max(3, Math.round((c.collapsed ? STRIP_W - 4 : c.vw) + step)); c.collapsed = false;
      this.save(); this.requestRelayout();
      return;
    }
    if (e.ctrlKey) {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      this._zf = (this._zf || 1) * Math.exp(-e.deltaY * unit * 0.0015);
      this._zy = e.clientY;
      if (!this._zraf) this._zraf = requestAnimationFrame(() => { this._zraf = 0; const f = this._zf; this._zf = 1; this.zoomAt(f, this._zy); });
      return;
    }
    if (e.shiftKey && !e.deltaX) { e.preventDefault(); this.scroller.scrollLeft += e.deltaY; }
  }
  // zoom the time axis keeping the time under clientY on the same screen row (the warp is rebuilt with the new floor)
  zoomAt(f, clientY) {
    if (!this.warp) return;
    const t = this.warp.t(clientY - this.sheet.getBoundingClientRect().top);
    const pps = Math.max(2, Math.min(800, this.pxPerSec * f));
    if (pps === this.pxPerSec) return t;
    this.pxPerSec = pps; this.save();
    this.relayout();
    this.scroller.scrollTop += (this.sheet.getBoundingClientRect().top + this.warp.y(t)) - clientY;
    this.drawLanes();
    return t;
  }
  // fit [t0, t1] (default: the whole song) into the visible height, as far as the text allows
  fitRange(t0 = 0, t1 = store.song.duration_ms) {
    const vh = Math.max(50, this.scroller.clientHeight - this.headH - 4);
    for (let i = 0; i < 5; i++) {           // the warp is not linear in the floor: a few corrective steps
      const h = this.warp.y(t1) - this.warp.y(t0);
      if (Math.abs(h - vh) < 2) break;
      const textH = h - this.pxPerSec * (t1 - t0) / 1000;
      const want = Math.max(2, Math.min(800, (vh - Math.max(0, textH)) / ((t1 - t0) / 1000)));
      if (Math.abs(want - this.pxPerSec) < 0.01) break;
      this.pxPerSec = want; this.relayout();
    }
    this.save();
    this.scroller.scrollTop = this.warp.y(t0);
    this.drawLanes();
  }
  // "+ note at this time": the notes column (shown if hidden) gets an editor at t (scrolled into view)
  noteAt(t) {
    const c = this.byId.notes; if (!c) return;
    if (c.hidden || c.collapsed) { c.hidden = false; c.collapsed = false; this.save(); this.applyColumns(); this.relayout(); }
    const y = this.warp.y(t) - this.scroller.scrollTop;
    if (y < this.headH + 10 || y > this.scroller.clientHeight - 70) { this.scrollToTime(t); this.drawLanes(); }
    this.seek(t);
    return c.def.editAt(c, t);
  }
  setHidden(id, hidden) { const c = this.byId[id]; c.hidden = hidden; this.save(); this.applyColumns(); this.relayout(); }
  toggleLinear() { this.linear = !this.linear; for (const c of this.cols) c.dirty = true; this.save(); this.relayout({ all: true }); }
  zoom(f) { this.pxPerSec = Math.max(2, Math.min(800, this.pxPerSec * f)); this.save(); this.relayout(); }
  cycleHeader() { this.headerMode = (this.headerMode + 1) % 3; this.applyHeaderMode(); this.save(); this.relayout(); }
  setHeaderMode(m) { this.headerMode = m; this.applyHeaderMode(); this.save(); this.relayout(); }

  openPicker() {
    const r = this.picker.getBoundingClientRect();
    window.WB.menus.open(window.WB.menus.itemsFor('columns'), { x: r.right - 210, y: r.bottom });
  }
}

// window-level drag: move on pointermove, end(ev) once on pointerup or pointercancel (touch, lost focus), which also
// removes the listeners so a cancelled drag does not keep resizing / selecting on later mouse moves
function onDrag(move, end) {
  const stop = (ev) => { removeEventListener('pointermove', move); removeEventListener('pointerup', stop); removeEventListener('pointercancel', stop); end?.(ev); };
  addEventListener('pointermove', move); addEventListener('pointerup', stop); addEventListener('pointercancel', stop);
}

// ------------------------------------------------------------------ helpers for text columns
// default measure: natural height of each item; it must fit before the next item of the same column starts
function measureItems(c) {
  const out = [], its = c.items;
  for (const it of its) { it.el.style.height = ''; }
  for (let i = 0; i < its.length; i++) {
    const it = its[i];
    const next = i + 1 < its.length ? its[i + 1].t0 : store.song.duration_ms;
    out.push({ t0: it.t0, t1: Math.max(next, it.t0 + 1), h: it.el.offsetHeight + (c.def.gap ?? 1) });
  }
  return out;
}

function placeItems(c, warp, drive, inFold) {
  let prevBottom = -1e9;
  const its = c.items;
  if (drive) { const cons = c.constraints; for (let i = 0; i < its.length; i++) its[i].h = cons[i] ? cons[i].h - (c.def.gap ?? 1) : 0; }
  for (let i = 0; i < its.length; i++) {
    const it = its[i];
    let top = warp.y(it.t0);
    if (drive && top < prevBottom - 0.5) top = prevBottom; // same-ms items (rare): stack instead of overlapping
    it.top = top;
    it.el.style.transform = `translateY(${top}px)`;
    if (inFold) it.el.style.visibility = inFold(it.t0) ? 'hidden' : ''; else if (it.el.style.visibility) it.el.style.visibility = '';
    if (drive) { it.el.style.height = ''; it.el.classList.remove('clip'); prevBottom = top + (it.h || 0); }
    else {
      const end = it.t1 ?? (i + 1 < its.length ? its[i + 1].t0 : store.song.duration_ms);
      const h = Math.max(1, warp.y(end) - top);
      it.el.style.height = h + 'px'; it.el.classList.add('clip');
      it.el.classList.toggle('tiny', h < 13);
    }
  }
}

// strip: section colour band + one tick per item
function drawStrip(c, env) {
  const { ctx, w, rows, yOf } = env;
  for (const s of store.song.sections) {
    const y0 = yOf(s.t0), y1 = yOf(s.t1); if (y1 < 0 || y0 > rows) continue;
    ctx.fillStyle = secColor(s.id, 0.55); ctx.fillRect(0, y0, Math.max(1, w * 0.4), y1 - y0);
  }
  ctx.fillStyle = c.def.stripColor || '#c9ccd1';
  for (const it of c.items.length ? c.items : (c.def.ticks?.(c) || [])) {
    const y = yOf(it.t0); if (y < -2 || y > rows + 2) continue;
    ctx.fillRect(0, Math.round(y), w, Math.max(1, env.dpr));
  }
}

// ------------------------------------------------------------------ shared small utils
export function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
export function fmt(ms, withMs = false) {
  const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60), r = s - m * 60;
  return withMs ? `${m}:${r.toFixed(3).padStart(6, '0')}` : `${m}:${String(Math.floor(r)).padStart(2, '0')}`;
}
const SEC_HUE = { intro: 220, verse: 205, pre: 40, drop: 0, chorus: 320, interlude: 175, bridge: 140, build: 25, final: 275, outro: 230 };
function hexA(hex, a) { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16); return `rgba(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255}, ${a})`; }
export function secColor(id, a = 1) {
  const o = store.overrides?.sections?.[id]?.color; if (o) return hexA(o, a);
  const key = Object.keys(SEC_HUE).find(k => id.startsWith(k)) || 'intro';
  const sat = key === 'intro' || key === 'outro' ? 12 : 45;
  return `hsla(${SEC_HUE[key]}, ${sat}%, ${key === 'intro' || key === 'outro' ? 40 : 42}%, ${a})`;
}
export { upperBound };
