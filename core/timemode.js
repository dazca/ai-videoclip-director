// The stages' Time view (ROADMAP_v4 F6, provisional decision: an optional toggle; the list stays the default). Each of
// Lyrics, Script, Breakdown, Storyboard and Final has a List | Time toggle (the stage bar, or Alt+T), remembered per stage
// in prefs ("timeMode"). In Time, the warped stages put their rows on the TIMELINE's own axis: the same y(t) (its anchors
// and measured row heights, js/warp.js), read from WB.timeline.warp, so a line, scene or shot sits at its song time to the
// pixel, scrolls with the timeline's playhead and shares its reading position. A row is clipped to its time slot like a
// timeline "follow" column (hover shows the rest); the Notes column stays row-aligned, which here means time-aligned.
// A click on an empty spot seeks; right-click > "+ Add at m:ss" adds at that time. Final groups its rows by section.
//   const ta = new TimeAxis({ stage, scroller, rows: () => [{ el, t0, t1, subs?: [{ el, t0, t1 }] }], nc?, noSeek?, onApply? })
//   ta.on            the stage is in Time mode (and the timeline has a warp)
//   ta.apply()       place the rows (the stage calls it after every render; the timeline's relayouts call it too)
//   ta.timeAt(clientY), ta.yOf(t) (px from the axis origin), ta.rowsAt(t)
// Rows outside the viewport are skipped by the browser (content-visibility: auto), so a long song stays cheap.
import { prefs } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { commands } from './commands.js';
import { menus } from './menus.js';

const WB = () => window.WB;
const READ = 0.3;   // the reading line, as on the timeline (js/timeline.js READ_LINE)
export const TIME_STAGES = ['lyrics', 'script', 'breakdown', 'storyboard', 'final'];
export const axes = new Set();

export function mode(stage) { return (prefs.get('timeMode', {}) || {})[stage] === 'time' ? 'time' : 'list'; }
export const isTime = (stage) => mode(stage) === 'time';
export function setMode(stage, m) {
  const all = { ...(prefs.get('timeMode', {}) || {}) };
  if (m === 'time') all[stage] = 'time'; else delete all[stage];
  prefs.set('timeMode', all);
  document.dispatchEvent(new CustomEvent('wb:timemode', { detail: { stage, mode: m === 'time' ? 'time' : 'list' } }));
}
export const toggle = (stage) => setMode(stage, isTime(stage) ? 'list' : 'time');
export function axisAt(el) { for (const a of axes) if (a.sc.contains(el)) return a; return null; }

export class TimeAxis {
  constructor(o) {
    this.o = o; this.sc = o.scroller; this.stage = o.stage;
    this.sheet = document.createElement('div'); this.sheet.className = 'tmsheet';
    this.head = document.createElement('div'); this.head.className = 'tmplay';
    this.placed = new Set(); this.rowsNow = []; this.needSync = true; this.raf = 0;
    const later = () => { this.needSync = true; cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.apply()); };
    for (const ev of ['wb:page', 'wb:stage', 'wb:timemode']) document.addEventListener(ev, later);
    // the timeline re-warped (data, width, zoom): re-place; the playhead moved: move ours, follow it while playing
    this.unwatch = null;
    const hook = () => { const tl = this.tl; if (!tl?.watch || this.unwatch) return; this.unwatch = tl.watch((what, t) => {
      if (!this.on || !this.visible) return;
      if (what === 'layout') { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.apply()); }
      else this.tick(t);
    }); };
    hook(); this.hook = hook;
    // the user scrolls the Time view: the timeline keeps the same reading position (it is laid out behind the stage)
    let sraf = 0;
    this.sc.addEventListener('scroll', () => { if (!this.on || this.muted) return; if (!sraf) sraf = requestAnimationFrame(() => { sraf = 0; if (this.on && this.visible) this.tl.scrollToTime(this.timeAtRead()); }); }, { passive: true });
    this.sc.addEventListener('wheel', () => { const tl = this.tl; if (!this.on || !tl?.player.playing) return; tl.follow = false; clearTimeout(tl._fT); tl._fT = setTimeout(() => tl.follow = true, 2500); }, { passive: true });
    // a click on an empty spot (not a control, a card or the Notes column) seeks to that exact ms
    const NOSEEK = 'a, button, input, textarea, select, label, [data-a], [data-l], [data-s], [data-act], [data-nc], .nclayer, .ncstage, .lytools, .pps, ' + (o.noSeek || '');
    this.sc.addEventListener('click', (e) => {
      if (!this.on || e.shiftKey || e.button !== 0 || e.target.closest(NOSEEK.replace(/,\s*$/, ''))) return;
      if (!getSelection()?.isCollapsed) return;   // the end of a drag that selected words
      const t = this.timeAt(e.clientY); if (t != null) this.tl.seek(t);
    });
    axes.add(this);
  }
  get tl() { return WB()?.timeline || null; }
  get on() { return isTime(this.stage) && !!this.tl?.warp; }
  get visible() { return this.sc.isConnected && this.sc.offsetParent !== null; }
  get off() { return this.sheet.isConnected ? this.sheet.offsetTop : 0; }
  yOf(t) { return this.tl.warp.y(t); }
  timeAt(clientY) { if (!this.on) return null; const r = this.sc.getBoundingClientRect(); return Math.max(0, Math.min(this.tl.warp.t(this.tl.warp.total), Math.round(this.tl.warp.t(clientY - r.top - this.sc.clientTop + this.sc.scrollTop - this.off)))); }
  timeAtRead() { return this.tl.warp.t(this.sc.scrollTop + this.sc.clientHeight * READ - this.off); }
  scrollToTime(t) { this.muted = true; this.sc.scrollTop = Math.max(0, this.off + this.tl.warp.y(t) - this.sc.clientHeight * READ); requestAnimationFrame(() => { this.muted = false; }); }
  rowsAt(t) { return this.rowsNow.filter(r => r.t0 != null && t >= r.t0 && t < r.t1); }
  tick(t) {
    if (!this.head.isConnected) return;
    this.head.style.transform = `translateY(${this.off + this.tl.warp.y(t)}px)`;
    const tl = this.tl;
    if (tl.player.playing && tl.follow) { const want = this.off + tl.warp.y(t) - this.sc.clientHeight * READ; if (Math.abs(this.sc.scrollTop - want) > 0.5) { this.muted = true; this.sc.scrollTop = want; requestAnimationFrame(() => { this.muted = false; }); } }
  }
  clear() {
    this.sc.classList.remove('tmode');
    for (const e of this.placed) { e.classList.remove('tmrow', 'tmsub', 'tmtiny', 'tmover'); e.style.removeProperty('--tmy'); e.style.removeProperty('--tmh'); }
    this.placed.clear(); this.rowsNow = [];
    this.sheet.remove(); this.head.remove();
  }
  apply() {
    this.hook();
    if (!this.on) { if (this.sc.classList.contains('tmode') || this.sheet.isConnected) this.clear(); return; }
    if (!this.visible) return;
    const t0 = performance.now(), W = this.tl.warp, sc = this.sc;
    const rows = (this.o.rows() || []).filter(r => r?.el?.isConnected);
    if (!rows.length) { this.clear(); return; }   // nothing on the axis (an empty stage, a diff, the text editor)
    sc.classList.add('tmode');
    // the stage re-rendered its rows (innerHTML): the spacer went with them and the scroll was clamped; put both back
    // before the browser reports that scroll (the shared reading position is the timeline's)
    const lost = this.sheet.parentNode !== sc && this.placed.size > 0;
    if (this.sheet.parentNode !== sc) sc.appendChild(this.sheet);
    if (this.head.parentNode !== sc) sc.appendChild(this.head);
    const keep = new Set(), over = [];
    // 1. writes: every row at y(t0) with the height of its time slot; sub-rows (a scene's shots, lines) inside it
    const off = this.off; let tail = 0; const untimed = [];
    for (const r of rows) {
      const e = r.el; keep.add(e);
      if (r.t0 == null) { untimed.push(r); continue; }
      const y0 = W.y(r.t0), h = Math.max(1, W.y(Math.max(r.t0, r.t1 ?? r.t0)) - y0);
      e.classList.add('tmrow'); e.classList.toggle('tmtiny', h < 13);
      e.style.setProperty('--tmy', `${off + y0}px`); e.style.setProperty('--tmh', `${h}px`);
      for (const s of r.subs || []) {
        const sy = W.y(s.t0) - y0, sh = Math.max(1, W.y(Math.max(s.t0, s.t1 ?? s.t0)) - W.y(s.t0));
        s.el.classList.add('tmsub'); s.el.classList.toggle('tmtiny', sh < 13); keep.add(s.el);
        s.el.style.setProperty('--tmy', `${sy}px`); s.el.style.setProperty('--tmh', `${sh}px`);
        over.push([s.el, sh]);
      }
      over.push([e, h]);
    }
    // rows without a song time (unsaved lines, shots outside the script): after the end of the song, in their order
    for (const r of untimed) { r.el.classList.add('tmrow'); r.el.classList.remove('tmtiny'); r.el.style.setProperty('--tmy', `${off + W.total + 8 + tail}px`); r.el.style.removeProperty('--tmh'); tail += Math.max(18, r.el.offsetHeight); }
    for (const e of this.placed) if (!keep.has(e)) { e.classList.remove('tmrow', 'tmsub', 'tmtiny', 'tmover'); e.style.removeProperty('--tmy'); e.style.removeProperty('--tmh'); }
    this.placed = keep;
    this.sheet.style.height = `${Math.ceil(W.total + (tail ? tail + 16 : 0) + sc.clientHeight * 0.7)}px`;
    // 2. one batch of reads: which rows hold more than their slot (a fade + the whole row on hover)
    const big = over.map(([e, h]) => e.scrollHeight > h + 1);
    over.forEach(([e], i) => e.classList.toggle('tmover', big[i]));
    this.rowsNow = rows.map(r => ({ ...r, t1: r.t1 ?? r.t0 }));
    if (this.needSync || lost) { this.needSync = false; this.scrollToTime(this.tl.timeAtRead()); }
    this.tick(this.tl.player.time());
    this.o.onApply?.();
    this.ms = performance.now() - t0;
    // what sits above the axis can still change height (the Notes column's top row un-growing on its next frame): if the
    // origin moved, place again
    requestAnimationFrame(() => { if (this.on && this.visible && this.sheet.isConnected && Math.abs(this.off - off) > 0.5) { this.muted = true; this.sc.scrollTop += this.off - off; this.apply(); requestAnimationFrame(() => { this.muted = false; }); } });
  }
  destroy() { this.clear(); this.unwatch?.(); axes.delete(this); }
}

// ------------------------------------------------------------------ the toggle: a command with a key, the stage bar, menus
const cur = () => WB()?.stages?.current?.();
commands.register([
  { id: 'stage.timeMode', group: 'Stages', title: (c) => `Time view: rows on the timeline's axis (${(c?.stageId || cur()) ? 'this stage' : 'stage'}; List is the default)`, keys: ['Alt+T'],
    when: (c) => c.tab === 'stage' && TIME_STAGES.includes(cur()), checked: () => isTime(cur()), run: () => toggle(cur()) },
  // "+ Add at this time": a note on the row at that time (the Notes column), else on the whole stage
  { id: 'stage.noteAtTime', group: 'Stages', title: (c) => `Add a note at ${fmt(c.t ?? 0)} (Notes column)`, hidden: true, when: (c) => !!c.tmAxis?.o.nc,
    run: (c) => { const a = c.tmAxis, nc = a.o.nc; if (!nc.rows.length) nc.render(); const row = a.rowsAt(c.t).map(r => nc.rowAt(r.el)).find(Boolean); return nc.edit(row?.targets[0] || nc.rows[0].targets[0]); } },
]);
menus.contribute('tmadd', [{ label: (c) => `+ Add at ${fmt(c.t ?? 0)}`, submenu: [{ cmd: 'stage.noteAtTime', label: '+ note at this time' }, { cmd: 'timeline.addScene', label: '+ scene here' }, { cmd: 'timeline.addShot', label: '+ shot here' }] }]);
menus.contribute('stage', ['-', 'stage.timeMode']);
menus.contribute('menubar:View', ['stage.timeMode']);
window.WB = Object.assign(window.WB || {}, { timeMode: { mode, setMode, toggle, isTime, axes: () => [...axes], STAGES: TIME_STAGES } });
