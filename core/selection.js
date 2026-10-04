// Selection: a set of item keys ('shot:c1-desk', 'use:G05@20158', 'note:n03', ...) and/or one time range.
// Elements carrying data-sel="<key>" get the .sel outline; the range is drawn by the timeline (tl.updateSelRange).
export const selection = {
  keys: new Set(), range: null, anchorT: null,
  _emit() { this.paint(); document.dispatchEvent(new CustomEvent('wb:selection')); },
  set(keys) { this.keys = new Set(keys); this._emit(); },
  add(key) { this.keys.add(key); this._emit(); },
  toggle(key) { this.keys.has(key) ? this.keys.delete(key) : this.keys.add(key); this._emit(); },
  clear() { this.keys.clear(); this.range = null; this._emit(); },
  setRange(r) { this.range = r && r.t1 > r.t0 ? { t0: Math.round(r.t0), t1: Math.round(r.t1) } : null; this._emit(); },
  list(prefix) { return [...this.keys].filter(k => !prefix || k.startsWith(prefix + ':')); },
  ids(prefix) { return this.list(prefix).map(k => k.slice(prefix.length + 1)); },
  paint() {
    for (const e of document.querySelectorAll('.sel')) if (!this.keys.has(e.dataset.sel)) e.classList.remove('sel');
    for (const k of this.keys) for (const e of document.querySelectorAll(`[data-sel="${CSS.escape(k)}"]`)) e.classList.add('sel');
    window.WB?.timeline?.updateSelRange?.();
  },
};
