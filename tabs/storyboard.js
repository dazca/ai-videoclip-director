// Stage 6 workspace: the storyboard and the gaps (docs/SPEC_v3_GUIDED.md). The script's scenes in song time, each a
// strip of shot cards that TILE the scene (a thin rail above shows the cuts against the scene's beats and bars). A card:
// time range (snapped to beats / bars), kind, the frame sketch (drawn inline or in a window, copy / paste between shots),
// text, camera / motion, the cast / location / prop chips with the variant each needs (green = approved), the shot's
// status (approvals.json "shot:<id>", the director's) and its generation request or clip. Side panel: the selected shot
// (times, kind, still / video, text, camera, frame, assets with a per-shot variant override, requests, split / merge /
// move / delete), Gaps (everything still missing across the stages, each with a jump link, and the estimate against the
// cost cap; "Fill the gaps" asks the agent for draft requests), Versions (diff, restore). The Notes column
// (core/notescol.js) on the right is row-aligned with the scenes: a scene's notes and its shots' (tagged sh03) sit on its
// row; Alt+N notes the selected shot. Right-click: + Add › shot / note (undoable).
// "Shots from beats" proposes one shot per scene beat or group of beats (js/storyboard.js shotsFromBeats). Edits collect
// in a draft (kept in this browser) until "Save version" (Ctrl+Enter): every save is a new version in storyboard.json.
// Takes (D6, tabs/takes.js): the Shot panel shows the shot's takes; the director picks one with in / out, a note and
// alternatives (take_act, page only: a new version on the saved shot; the draft carries the saved picks along).
// E3 chapters: a scene header's chapter picker groups scenes into chapters (chapters_update, page or agent); the first scene of
// a chapter carries its band (name, owner, the DERIVED build status planned / generating / built / approved, picked / shots).
// E5: a shot with no frame or take shows its placeholder frame (js/placeholder.js). E6 worlds: the scene's world (the script)
// or the shot's own (Shot panel) dresses each cast chip in the look for that world; a look off its world is a gap.
// MCP: storyboard_get, shots_update, shot_note_add / shot_note_resolve, gaps_get, takes_get / take_propose, chapters_update.
// Format: js/storyboard.js.
import { store, prefs, toast, esc, PROJECT, postJSON, mediaUrl } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { commands } from '../core/commands.js';
import { menus } from '../core/menus.js';
import { ui } from '../core/palette.js';
import * as F from '../js/flow.js';
import * as SC from '../js/scenes.js';
import * as SB from '../js/storyboard.js';
import * as EV from '../js/events.js';
import * as A from '../js/assets.js';
import { NotesColumn } from '../core/notescol.js';
import { TimeAxis } from '../core/timemode.js';
import { history } from '../core/history.js';
import { stripHtml, register as registerProposals, offerPrepare } from '../core/proposals.js';
import * as PR from '../js/proposals.js';
import { mountTakes } from './takes.js';
import { mountSurfaces } from './surfaces.js';
import { coverage } from '../js/surfaces.js';
import { help } from '../core/helptip.js';
import { placeholderFor, placeholderUri } from '../js/placeholder.js';
import * as CH from '../js/chapters.js';
import * as WD from '../js/worlds.js';
const op = async (name, body) => { const r = await postJSON('/api/op/' + name, body), j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };

const WB = () => window.WB;
const visible = () => WB()?.app?.active() === 'stage' && WB().stages?.current() === 'storyboard';
const nowIso = () => new Date().toISOString().slice(0, 19);
const DKEY = 'boardDraft:' + PROJECT;
const when = (at) => at ? esc(String(at).replace('T', ' ').slice(5, 16)) : '';
const who = (x) => x.via === 'agent' ? `<span class="who ag" title="written through the agent tools">${esc(x.by && x.by !== 'agent' ? x.by + ' · agent' : 'agent')}</span>` : `<span class="who dr">${esc(x.by === 'import' ? 'import' : 'director')}</span>`;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const clk = (ms) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const nn = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function parseT(s) {
  const v = String(s || '').trim(), m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(v);
  if (m) return Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000);
  return /^\d+(\.\d+)?$/.test(v) ? Math.round(Number(v) * 1000) : null;
}
const blobB64 = (b) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = () => bad(r.error); r.readAsDataURL(b); });
const imgUrl = (p) => !p ? '' : /^catalog\//i.test(p) ? '/' + p.split('/').map(encodeURIComponent).join('/') : mediaUrl(p);
const TL = { character: 'C', location: 'L', prop: 'P' };
const OPEN_REQ = ['draft', 'approved', 'queued', 'running'];
let SKM = null;
const sketchMod = async () => (SKM ||= await import('../core/sketch/sketch.js'));
let S = null;

class Board {
  constructor(el, ctx) {
    this.el = el; this.ctx = ctx; this.side = ['shot', 'gaps', 'versions'].includes(prefs.get('boardSide', 'shot')) ? prefs.get('boardSide', 'shot') : 'shot';
    this.sel = prefs.get('boardSel:' + PROJECT, null); this.snap = prefs.get('boardSnap', 'beats');
    this.compare = null; this.ab = { a: null, b: null }; this.sk = null; this.skVer = {}; this.pending = false;
    el.classList.add('sbws');
    el.innerHTML = `<div class="sbmain"><div class="lybar sbbar"></div><div class="sblist" tabindex="-1"></div></div>
      <div class="lyside sbside"><div class="lytabs"><a data-side="shot">Shot</a><a data-side="gaps">Gaps</a><a data-side="versions">Versions</a></div>
      <div class="lylist"></div></div>`;
    this.$ = (s) => el.querySelector(s);
    this.skHost = document.createElement('div'); this.skHost.className = 'scskhost sbskhost';
    this.loadDraft();
    this.wire();
    // the Notes column: one row per scene (its shots' notes tagged with the shot id); the top row: the whole storyboard
    const sceneT = (id) => ({ stage: 'storyboard', kind: 'scene', id }), shotT = (id) => ({ stage: 'storyboard', kind: 'shot', id });
    this.nc = new NotesColumn({ stage: 'storyboard', scroller: this.$('.sblist'), active: () => !this.compare, fixed: () => !!this.ta?.on,
      top: { label: 'notes on the whole storyboard', targets: [{ stage: 'storyboard', kind: 'stage', id: null }] },
      rows: () => [...this.el.querySelectorAll('.sblist > .sbscene')].map(e => {
        const sc = e.dataset.scene, shots = sc ? this.inScene(sc) : this.orphans(), ids = new Set(shots.map(s => s.id));
        if (!sc && !shots.length) return null;
        return { el: e, targets: [...(sc ? [sceneT(sc)] : []), ...shots.map(s => shotT(s.id))],
          match: (n) => (sc && n.target.kind === 'scene' && n.target.id === sc) || (n.target.kind === 'shot' && (ids.has(n.target.id) || (!!sc && n.target.scene === sc && !this.shot(n.target.id)))),
          sub: (n) => n.target.kind === 'shot' ? n.target.id : '',
          targetAt: (x) => { const c = x.closest?.('[data-shot]'); return c ? shotT(c.dataset.shot) : sc ? sceneT(sc) : null; } }; }).filter(Boolean),
      current: () => this.sel && this.shot(this.sel) ? shotT(this.sel) : null });
    // Time view (core/timemode.js): each scene a row on the timeline's axis (its header a band on the left), its shots
    // stacked down it at their own times; gaps as rows too; shots outside the script after the end
    this.ta = new TimeAxis({ stage: 'storyboard', scroller: this.$('.sblist'), nc: this.nc, rows: () => this.timeRows(), onApply: () => this.nc.schedule('place'), noSeek: '.sbcard, .sbsh, .sbskslot' });
    document.addEventListener('wb:timemode', (e) => { if (e.detail.stage === 'storyboard' && !this.typing()) this.render(); });
    store.on((w) => { if (['board', 'scenes', 'all', 'approvals', 'requests', 'breakdown', 'costs', 'proposals', 'takes', 'surfaces', 'checks', 'events'].includes(w)) { if (this.typing()) this.pending = true; else this.render(); } });
    this.render();
  }
  // a draft edit from "+ Add" (a shot) and the other structural edits: one undo step (Ctrl+Z puts the draft back)
  undoable(label, fn) {
    const before = structuredClone(this.draft); const r = fn(); const after = structuredClone(this.draft);
    if (JSON.stringify(before) !== JSON.stringify(after)) history.push({ label, undo: () => this.setDraft(before), redo: () => this.setDraft(after) });
    return r;
  }
  setDraft(d) { this.draft = structuredClone(d); this.saveDraft(); if (this.sel && !this.shot(this.sel)) this.sel = null; this.render(); }
  get doc() { return store.board; }
  get cur() { return SB.currentBoard(this.doc); }
  get song() { return store.song; }
  get scenes() { return [...(SC.currentScript(store.scenes)?.scenes || [])].sort((a, b) => a.t0 - b.t0); }
  scene(id) { return id ? this.scenes.find(s => s.id === id) || null : null; }
  typing() { const a = document.activeElement; return !!a && this.el.contains(a) && a.matches('input, textarea, select') && !a.closest('.sk'); }
  // ---------------------------------------------------------------- the draft (unsaved edits, kept per project in this browser)
  loadDraft() {
    const d = prefs.get(DKEY, null);
    this.draft = d && d.base === (this.doc?.current || null) && Array.isArray(d.shots) ? d.shots : structuredClone(this.cur?.shots || []);
    this.base = this.doc?.current || null;
  }
  // the picked takes (shot.clip) are the saved version's (take_act writes them): the draft always carries them as they are
  syncPicks() { const m = new Map((this.cur?.shots || []).filter(x => x.clip).map(x => [x.id, x.clip])); for (const d of this.draft) { if (m.has(d.id)) d.clip = structuredClone(m.get(d.id)); else delete d.clip; }
    // the lyric surfaces (shot.lyrics, E2) are the saved version's too (surface_act writes them)
    const l = new Map((this.cur?.shots || []).filter(x => x.lyrics?.length).map(x => [x.id, x.lyrics])); for (const d of this.draft) { if (l.has(d.id)) d.lyrics = structuredClone(l.get(d.id)); else delete d.lyrics; } }
  syncBase() {
    if (this.base === (this.doc?.current || null) || this.busy) return;
    const strip = (l) => this.sorted(l).map(({ clip: _c, lyrics: _l, ...x }) => x), old = this.doc?.versions.find(v => v.id === this.base);
    if (!this.dirtyAgainst(this.base)) this.draft = structuredClone(this.cur?.shots || []);
    else {
      this.syncPicks();   // a pick (take_act) is its own version: the unsaved edits stay, with the new pick
      if (!SB.sameShots(strip(old?.shots), strip(this.cur?.shots))) toast(`storyboard: a new version (${this.doc.current}) arrived while you have unsaved edits; save makes yours the next version`);
    }
    this.base = this.doc?.current || null; this.saveDraft();
  }
  sorted(l) { return [...(l || [])].sort(SB.byTime); }
  dirtyAgainst(id) { const v = this.doc?.versions.find(x => x.id === id); return !SB.sameShots(this.sorted(this.draft), this.sorted(v?.shots)); }
  get dirty() { return !SB.sameShots(this.sorted(this.draft), this.sorted(this.cur?.shots)); }
  saveDraft() { if (this.dirty) prefs.set(DKEY, { base: this.base, shots: this.draft }); else prefs.set(DKEY, null); }
  shot(id) { return id ? this.draft.find(s => s.id === id) || null : null; }
  inScene(id) { return this.draft.filter(s => s.scene === id).sort(SB.byTime); }
  timeRows() {
    if (this.compare) return [];
    return [...this.el.querySelectorAll('.sblist > .sbscene, .sblist > .sbgaprow')].map(e => {
      if (e.dataset.gap) { const [t0, t1] = e.dataset.gap.split(',').map(Number); return { el: e, t0, t1 }; }
      const sc = this.scene(e.dataset.scene); if (!sc) return { el: e, t0: null };
      const subs = [...e.querySelectorAll('.sbcard[data-shot]')].map(c => { const s = this.shot(c.dataset.shot); return s ? { el: c, t0: Math.max(sc.t0, s.t0), t1: Math.min(sc.t1, s.t1) } : null; }).filter(Boolean);
      return { el: e, t0: sc.t0, t1: sc.t1, subs };
    });
  }
  orphans() { const ids = new Set(this.scenes.map(s => s.id)); return this.draft.filter(s => !ids.has(s.scene)).sort(SB.byTime); }
  // a change to the draft: fn(draft); the shots of every scene are tiled again, the list re-sorted; a failure undoes it
  edit(fn, { render = true } = {}) {
    const before = structuredClone(this.draft);
    try { fn(this.draft); SB.tileShots(this.draft, this.scenes); } catch (e) { this.draft = before; toast(e.message); return false; }
    this.draft.sort(SB.byTime); this.saveDraft();
    if (render) this.render(); else this.renderBar();
    return true;
  }
  // ---------------------------------------------------------------- saving
  async save(message) {
    if (!this.dirty) return toast('storyboard: nothing to save');
    if (message == null) message = this.$('.sbbar .lymsg')?.value.trim() || '';
    let body;
    try { body = this.draft.map(s => SB.cleanShot(s, this.song)).sort(SB.byTime); SB.tileShots(body, this.scenes); SB.checkBoard({ versions: [{ id: 'x', shots: body }], current: 'x' }); } catch (e) { return toast('not saved: ' + e.message); }
    let id = null; this.busy = true;
    try { await store.mutate('storyboard.json', (d) => { id = SB.addBoardVersion(d, body, { by: 'director', via: 'page', message, script: store.scenes?.current || undefined }).id; }, { label: 'save storyboard version' }); } finally { this.busy = false; }
    this.base = this.doc.current; this.draft = structuredClone(this.cur?.shots || []); this.saveDraft();
    toast(`storyboard saved as ${id}`);
    this.render();
    offerPrepare('storyboard');   // offer starting frame proposals (never run by itself)
  }
  discard() { this.draft = structuredClone(this.cur?.shots || []); this.saveDraft(); this.render(); }
  restore(id) {
    const v = this.doc.versions.find(x => x.id === id); if (!v) return;
    this.busy = true;
    return store.mutate('storyboard.json', (d) => { SB.addBoardVersion(d, v.shots, { by: 'director', via: 'page', message: `restore ${id}`, from: id }); }, { label: `restore storyboard ${id}` })
      .finally(() => { this.busy = false; }).then(() => { this.base = this.doc.current; this.draft = structuredClone(this.cur.shots); this.saveDraft(); this.compare = null; toast(`restored ${id} as ${this.doc.current}`); this.render(); });
  }
  // ---------------------------------------------------------------- selection
  select(id, { scroll = true, seek = true } = {}) {
    const s = this.shot(id);
    this.sel = s ? id : null; prefs.set('boardSel:' + PROJECT, this.sel);
    if (this.sk && this.sk.shot !== this.sel && !this.sk.api.dirty) this.closeSketch(true);
    if (s && this.side !== 'shot') this.setSide('shot', false);
    if (s && seek) this.ctx.timeline?.seek(s.t0);
    this.render();
    if (s && scroll) this.el.querySelector(`.sbcard[data-shot="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  focus(id) { this.compare = null; this.select(id); const c = this.el.querySelector(`.sbcard[data-shot="${CSS.escape(id)}"]`); c?.classList.add('flash'); setTimeout(() => c?.classList.remove('flash'), 1200); }
  focusScene(id) { this.compare = null; this.render(); const e = this.el.querySelector(`.sbscene[data-scene="${CSS.escape(id)}"]`); e?.scrollIntoView({ block: 'start' }); e?.classList.add('flash'); setTimeout(() => e?.classList.remove('flash'), 1200); }
  step(d) { const l = this.sorted(this.draft), i = l.findIndex(s => s.id === this.sel), n = l[i < 0 ? 0 : Math.max(0, Math.min(l.length - 1, i + d))]; if (n) this.select(n.id); }
  // ---------------------------------------------------------------- shots: add, split, merge, move, delete, times
  minLen() { return this.snap === 'bars' ? SB.barMs(this.song) : SB.beatMs(this.song); }
  snapT(t) { return SB.snapGrid(t, this.song, this.snap, store.events); }
  beatT(sceneId, bid) { return this.scene(sceneId)?.beats.find(b => b.id === bid)?.t ?? null; }
  needs(sceneId) { const r = { cast: [], locations: [], props: [] }; for (const a of SB.sceneAssets(sceneId, store.breakdown, store.entities)) r[SB.FIELD[a.type]].push(a.id); return r; }
  addShot(sceneId) {
    const sc = this.scene(sceneId); if (!sc) return;
    const g = this.inScene(sceneId);
    if (g.length) return this.split(g[g.length - 1].id);
    const id = SB.nextShotId(this.doc, this.draft);
    if (this.undoable(`add shot ${id}`, () => this.edit((d) => { d.push({ ...SB.NEW_SHOT(), id, scene: sceneId, t0: sc.t0, t1: sc.t1, kind: 'wide', gen: 'video', beats: sc.beats.map(b => b.id), text: sc.text ? sc.text.slice(0, 400) : '', ...this.needs(sceneId) }); }))) this.select(id);
    return id;
  }
  // "+ shot here" at a time (the timeline): the shot there is cut at that time (on the grid), else the scene there gets one
  addShotAt(t) {
    const s = this.draft.find(x => x.t0 <= t && t < x.t1);
    if (s) return this.split(s.id, t);
    const sc = this.scenes.find(x => x.t0 <= t && t < x.t1);
    if (!sc) return toast('no scene at this time: + scene first (the script)');
    return this.addShot(sc.id);
  }
  // the cut nearest to `at` (default: the playhead when it is inside the shot, else the middle) on the beat grid
  split(id, at) {
    const s = this.shot(id); if (!s) return;
    const tp = this.ctx.timeline?.player.time(), m = this.minLen();
    const want = at ?? (tp != null && tp > s.t0 + m && tp < s.t1 - m ? tp : (s.t0 + s.t1) / 2);
    let t = null;
    for (const mode of [this.snap, 'beats', 'off']) { const x = SB.snapGrid(want, this.song, mode, store.events), mm = mode === 'off' ? 250 : mode === 'bars' ? SB.barMs(this.song) : SB.beatMs(this.song); if (x - s.t0 >= mm * 0.99 && s.t1 - x >= mm * 0.99) { t = x; break; } }
    if (t == null) return toast(`${id} is too short to split (${secs(s.t1 - s.t0)})`);
    const nid = SB.nextShotId(this.doc, this.draft), bt = (b) => this.beatT(s.scene, b) ?? s.t0;
    if (this.undoable(`split ${id}: ${nid}`, () => this.edit((d) => { const ns = { ...structuredClone(s), id: nid, t0: t, title: '', text: '', camera: '', sketch: null, clips: [], beats: s.beats.filter(b => bt(b) >= t) }; delete ns.clip; d.push(ns); s.beats = s.beats.filter(b => bt(b) < t); s.t1 = t; }))) { this.select(nid); toast(`${id} split at ${clk(t)}: ${nid}`); return nid; }
  }
  neighbours(s) { const g = s.scene && this.scene(s.scene) ? this.inScene(s.scene) : this.orphans(), i = g.indexOf(s); return { g, i, prev: g[i - 1] || null, next: g[i + 1] || null }; }
  merge(id) {
    const s = this.shot(id); if (!s) return;
    const { next } = this.neighbours(s); if (!next || next.scene !== s.scene) return toast('no next shot in this scene to merge with');
    const join = (a, b, sep) => [a, b].filter(Boolean).join(sep);
    if (this.undoable(`merge ${next.id} into ${id}`, () => this.edit((d) => {
      s.t1 = next.t1; s.title = s.title || next.title; s.text = join(s.text, next.text, '\n'); s.camera = join(s.camera, next.camera, '; '); s.sketch = s.sketch || next.sketch;
      for (const k of ['beats', 'cast', 'locations', 'props', 'clips']) s[k] = [...new Set([...(s[k] || []), ...(next[k] || [])])];
      s.variants = { ...(next.variants || {}), ...(s.variants || {}) };
      d.splice(d.indexOf(next), 1);
    }))) { this.select(id); toast(`${next.id} merged into ${id}`); }
  }
  // swap with the neighbour: the two keep their lengths and trade places in the scene
  move(id, dir) {
    const s = this.shot(id); if (!s) return;
    const n = this.neighbours(s), o = dir < 0 ? n.prev : n.next; if (!o) return toast(dir < 0 ? 'already the first shot' : 'already the last shot');
    const [a, b] = dir < 0 ? [o, s] : [s, o], da = a.t1 - a.t0, start = a.t0, db = b.t1 - b.t0;
    if (this.edit(() => { b.t0 = start; b.t1 = start + db; a.t0 = b.t1; a.t1 = a.t0 + da; })) this.select(id, { seek: false });
  }
  async remove(id) {
    const s = this.shot(id); if (!s) return;
    if ((s.text || s.sketch || s.camera) && !(await ui.confirm(`Remove shot ${id}${s.title ? ` “${s.title}”` : ''} from the draft? (saved versions keep it; its time goes to the neighbour)`))) return;
    const { prev, next } = this.neighbours(s);
    if (this.undoable(`remove shot ${id}`, () => this.edit((d) => { if (prev && prev.scene === s.scene) prev.t1 = s.t1; else if (next && next.scene === s.scene) next.t0 = s.t0; d.splice(d.indexOf(s), 1); }))) this.select(prev?.id || next?.id || null, { seek: false });
  }
  // a boundary moves both shots that share it; the first shot starts with its scene, the last ends with it
  setTimes(id, t0, t1) {
    const s = this.shot(id); if (!s) return;
    const { prev, next } = this.neighbours(s), sc = this.scene(s.scene), m = SB.beatMs(this.song);   // a shot lasts at least one beat
    if (t0 != null && t0 !== s.t0) {
      if (sc && (!prev || prev.scene !== s.scene)) { toast('the first shot starts with its scene (change the scene in the script)'); return this.render(); }
      t0 = this.snapT(t0);
      const lo = (prev ? prev.t0 : 0) + m, hi = s.t1 - m;
      if (!(t0 >= lo && t0 <= hi)) { toast(`from: between ${clk(lo)} and ${clk(hi)}`); return this.render(); }
      return this.edit(() => { s.t0 = t0; if (prev) prev.t1 = t0; for (const x of [s, prev]) if (x) EV.reanchor(x, store.events, { snap: this.snap }); });
    }
    if (t1 != null && t1 !== s.t1) {
      if (sc && (!next || next.scene !== s.scene)) { toast('the last shot ends with its scene (change the scene in the script)'); return this.render(); }
      t1 = this.snapT(t1);
      const lo = s.t0 + m, hi = (next ? next.t1 : this.song.duration_ms) - m;
      if (!(t1 >= lo && t1 <= hi)) { toast(`to: between ${clk(lo)} and ${clk(hi)}`); return this.render(); }
      return this.edit(() => { s.t1 = t1; if (next) next.t0 = t1; for (const x of [s, next]) if (x) EV.reanchor(x, store.events, { snap: this.snap }); });
    }
  }
  // anchor a cut to a named event (E1): the cut (this shot's edge and its neighbour's) takes the event's time and follows it
  // when the director re-times after the take; '' removes the anchor (the time stays)
  setAnchor(id, edge, evId) {
    const s = this.shot(id); if (!s) return;
    const e = evId ? store.events.find(x => x.id === evId) : null;
    if (evId && !e) return toast(`no event ${evId}`);
    const { prev, next } = this.neighbours(s), o = edge === 't0' ? prev : next;
    if (e) {
      const t = e.t, m = SB.beatMs(this.song) / 2;
      if (edge === 't0' ? !(t < s.t1 - m && (!prev || t > prev.t0 + m)) : !(t > s.t0 + m && (!next || t < next.t1 - m))) { toast(`${e.name} (${clk(t)}) is outside what ${id}'s ${edge === 't0' ? 'start' : 'end'} can reach`); return this.render(); }
    }
    const sh = (x, k, v) => { const a = { ...(x.anchors || {}) }; if (v) a[k] = v; else delete a[k]; if (Object.keys(a).length) x.anchors = a; else delete x.anchors; };
    this.undoable(e ? `anchor ${id} ${edge === 't0' ? 'start' : 'end'} to ${e.id}` : `unanchor ${id} ${edge === 't0' ? 'start' : 'end'}`, () => this.edit(() => {
      if (e) { s[edge] = e.t; if (o && o.scene === s.scene) o[edge === 't0' ? 't1' : 't0'] = e.t; }
      sh(s, edge, e?.id); if (o && o.scene === s.scene) sh(o, edge === 't0' ? 't1' : 't0', e?.id);
    }));
  }
  nudge(id, which, dir) {
    const s = this.shot(id); if (!s) return;
    const step = this.snap === 'bars' ? SB.barMs(this.song) : SB.beatMs(this.song), t = (which === 't0' ? s.t0 : s.t1) + dir * step;
    return which === 't0' ? this.setTimes(id, t, null) : this.setTimes(id, null, t);
  }
  setField(id, k, v, render = false) { const s = this.shot(id); if (!s) return; this.edit(() => { s[k] = v; }, { render }); }
  addAsset(id, type, eid) { const s = this.shot(id), f = SB.FIELD[type]; if (!s || !f || (s[f] || []).includes(eid)) return; this.edit(() => { s[f] = [...(s[f] || []), eid]; }); }
  removeAsset(id, type, eid) { const s = this.shot(id), f = SB.FIELD[type]; if (!s) return; this.edit(() => { s[f] = (s[f] || []).filter(x => x !== eid); if (s.variants) delete s.variants[eid]; }); }
  setVariant(id, eid, v) { const s = this.shot(id); if (!s) return; this.edit(() => { s.variants ||= {}; if (v === '') delete s.variants[eid]; else s.variants[eid] = v === '__root' ? null : v; }); }
  // E6: the shot's own world ('' = its scene's); a new one is typed
  async setWorld(id, v) {
    const s = this.shot(id); if (!s) return;
    if (v === '__new') { v = await ui.prompt({ title: `The world of ${id} (e.g. dancing)`, placeholder: 'on screen, off screen, dancing…' }); if (v == null) return this.render(); }
    let w; try { w = WD.cleanWorld(v); } catch (e) { toast(e.message); return this.render(); }
    this.undoable(`world of ${id}: ${w || 'the scene\'s'}`, () => this.edit(() => { if (w) s.context = w; else delete s.context; }));
  }
  worlds() { return WD.worldsIn({ entities: store.entities, scenes: this.scenes, shots: this.draft }); }
  // ---------------------------------------------------------------- chapters (E3; storyboard.json chapters, outside the versions)
  get chapters() { return CH.chaptersOf(this.doc); }
  chapterViews() { return CH.chaptersView(this.doc, { scenes: this.scenes, shots: this.cur?.shots || [], approvals: store.approvals, requests: store.requests }); }
  async chapterOp(body, what) { try { await op('chapters_update', { ...body, by: 'director', via: 'page' }); if (what) toast(what); } catch (e) { toast('not done: ' + e.message); } }
  async setChapter(sceneId, chId) {
    const cur = CH.chapterOfScene(this.chapters, sceneId);
    if (chId === '__new') {
      const name = await ui.prompt({ title: `New chapter from ${sceneId}`, placeholder: 'name, e.g. Chapter 1 · the desk' }); if (name == null) return this.render();
      return this.chapterOp({ upsert: [{ name: name.trim() || CH.nextChapterId(this.chapters), scenes: [sceneId] }] }, `${sceneId}: a new chapter`);
    }
    if (!chId) { if (!cur) return; return this.chapterOp({ upsert: [{ id: cur.id, scenes: cur.scenes.filter(x => x !== sceneId) }] }, `${sceneId} left ${cur.id}`); }
    const ch = this.chapters.find(c => c.id === chId); if (!ch) return;
    return this.chapterOp({ upsert: [{ id: ch.id, scenes: [...ch.scenes, sceneId] }] }, `${sceneId} is in ${ch.id} ${ch.name}`);
  }
  async editChapter(chId, field) {
    const ch = this.chapters.find(c => c.id === chId); if (!ch) return;
    if (field === 'remove') { if (!(await ui.confirm(`Remove chapter ${ch.id} “${ch.name}”? (its scenes stay)`))) return; return this.chapterOp({ remove: [ch.id] }, `${ch.id} removed`); }
    const label = { name: 'Chapter name', owner: 'Who builds it (an agent, "lead")', file: 'Where it is built (e.g. xp/ch1.js)' }[field];
    const v = await ui.prompt({ title: `${ch.id}: ${label}`, value: ch[field] || '' }); if (v == null) return;
    return this.chapterOp({ upsert: [{ id: ch.id, [field]: v.trim() }] });
  }
  focusChapter(id) { const ch = this.chapterViews().find(c => c.id === id); if (ch?.scenes[0]) this.focusScene(ch.scenes.find(s => this.scene(s)) || ch.scenes[0]); }
  // ---------------------------------------------------------------- "Shots from beats" (the page's heuristic: js/storyboard.js)
  async fromBeats(sceneIds) {
    const targets = sceneIds || this.scenes.filter(sc => !this.inScene(sc.id).length).map(s => s.id);
    if (!targets.length) return toast('every scene has shots: use “from beats” on a scene to redo it');
    const had = targets.reduce((n, id) => n + this.inScene(id).length, 0);
    if (had && !(await ui.confirm(`Replace the ${nn(had, 'shot')} of ${targets.join(', ')} with shots from the beats? (saved versions keep them; their frame sketches stay on disk)`))) return;
    let made = 0;
    const snap = this.snap === 'off' ? 'beats' : this.snap;
    const ok = this.undoable(`shots from beats (${targets.length === 1 ? targets[0] : targets.length + ' scenes'})`, () => this.edit((d) => {
      for (const id of targets) {
        const sc = this.scene(id); if (!sc) continue;
        for (const x of d.filter(s => s.scene === id)) d.splice(d.indexOf(x), 1);
        for (const p of SB.shotsFromBeats(sc, this.song, { assets: SB.sceneAssets(id, store.breakdown, store.entities), snap })) { d.push({ ...p, id: SB.nextShotId(this.doc, d) }); made++; }
      }
    }));
    if (ok) { toast(`${nn(made, 'shot')} from the beats of ${targets.length === 1 ? targets[0] : targets.length + ' scenes'} · unsaved: Save version (Ctrl+Enter) keeps them`); const f = this.inScene(targets[0])[0]; if (f) this.select(f.id, { seek: false }); }
  }
  // ---------------------------------------------------------------- generation requests (drafts: the director approves them here, the agent runs them)
  reqs(id) { return SB.shotRequests(store.requests, id); }
  haveStill(id) { const r = this.reqs(id).find(x => x.kind === 'shot-still' && x.status === 'done' && x.outputs?.length); return r ? r.outputs[0] : null; }
  proposal(s) { return SB.shotProposal(s, this.scene(s.scene), SB.shotAssets(s, store.entities, store.approvals), { sketchPng: s.sketch ? this.skPath(s.sketch) : null, haveStill: this.haveStill(s.id) }); }
  async requestGen(id) {
    const s = this.shot(id); if (!s) return;
    if (!this.cur?.shots.some(x => x.id === id)) return toast('save the storyboard first: a request names a saved shot');
    if (this.reqs(id).some(r => OPEN_REQ.includes(r.status))) return toast(`${id} already has an open request: approve or reject it first`);
    const pr = this.proposal(s), q = pr.requests[0];
    const r = await store.addRequest({ kind: q.kind, target: q.target, prompt: q.prompt, refs: q.refs.filter(x => !x.startsWith('(')), est_cost: q.est_cost, extra: { tool: q.tool, est_why: q.why, shot: { id, gen: pr.gen } } });
    toast(`draft request ${r.id}: ${q.kind.replace('shot-', '')} of ${id} · est ${usd(q.est_cost)}${pr.missing.length ? ` · ${nn(pr.missing.length, 'asset')} not approved yet` : ''} · approve it here, then Run it (Review › Queue) or let the agent run it`);
  }
  approveReq(id) { return store.setRequest(id, { status: 'approved' }).then(() => toast(`request ${id} approved: the agent may run it now (MCP)`)); }
  rejectReq(id) { return store.setRequest(id, { status: 'rejected', why: 'rejected by the director' }).then(() => toast(`request ${id} rejected`)); }
  setStatus(id, st) { return store.setState('shot:' + id, st).then(() => toast(`${id}: ${st}`)); }
  // ---------------------------------------------------------------- frame sketches
  skPath(id) { return store.mediaById?.[`sketch-${id}`]?.path || `sketches/${id}.png`; }
  skUrl(id) { return `${mediaUrl(this.skPath(id))}?v=${this.skVer[id] || store.mediaById?.[`sketch-${id}`]?.updated || ''}`; }
  async skLoad(id) { const m = store.mediaById?.[`sketch-${id}`], r = await fetch(`${mediaUrl(m?.sketch || `sketches/${id}.json`)}?v=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) throw new Error(`sketch ${id}: ${r.status}`); return r.json(); }
  newSketchId(shotId) { return `sk-${String(shotId).toLowerCase().replace(/[^a-z0-9_-]/g, '')}-${Date.now().toString(36).slice(-5)}`; }
  // a new frame is drawn over the shot's location (its approved / current image, faint) when it has one
  underlayFor(s) { const a = SB.shotAssets(s, store.entities, store.approvals).find(x => x.type === 'location' && x.image); return a ? { src: a.image, opacity: 0.35, fit: 'cover' } : null; }
  async saveSketch(shotId, sk, png, mask) {
    const s = this.shot(shotId);
    const r = await postJSON('/api/op/sketch_save', { id: sk.id, sketch: sk, png: await blobB64(png), mask: mask ? await blobB64(mask) : null, links: { shots: [shotId], ...(s?.scene ? { scenes: [s.scene] } : {}) }, label: `frame of ${shotId}` });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast('frame not saved: ' + (j.error || r.status)); throw new Error(j.error || r.status); }
    this.skVer[sk.id] = Date.now();
    if (s && s.sketch !== sk.id) {
      const clean = !this.dirty;
      this.edit(() => { s.sketch = sk.id; }, { render: false });
      if (clean) await this.save(`frame ${sk.id} on ${shotId}`); else { this.render(); toast(`frame ${sk.id} saved · Save version keeps it on ${shotId}`); }
    } else { this.render(); toast(`frame ${sk.id} saved${j.private ? ' (private: drawn over a private image)' : ''}`); }
    return j;
  }
  async openSketchFor(shotId, sketchId, { window: win = false, underlay = null } = {}) {
    const M = await sketchMod(), s = this.shot(shotId); if (!s) return;
    let sketch = null;
    if (sketchId) { try { sketch = await this.skLoad(sketchId); } catch (e) { return toast(e.message); } }
    const id = sketchId || this.newSketchId(shotId), ul = sketch ? null : underlay || this.underlayFor(s);
    const opts = { sketch: sketch || undefined, id, w: 1280, h: 720, ...(ul ? { underlay: ul } : {}), resolve: imgUrl, title: `Frame ${id} · ${shotId}`, save: (sk, png, mask) => this.saveSketch(shotId, sk, png, mask) };
    if (win) { if (this.sk?.id === id) await this.closeSketch(true); return M.openSketch(opts); }
    if (this.sk && !(await this.closeSketch())) return;
    this.sel = shotId; prefs.set('boardSel:' + PROJECT, shotId);
    this.skHost.innerHTML = `<div class="scskbar"><b>${esc(id)}</b><span class="dim">frame of ${esc(shotId)} · ${sketch ? '' : 'new · '}draw the composition (16:9), P = pin a note${ul ? (underlay ? ' · base layer: the picked proposal' : ' · faint underlay: the location') : ''}; Ctrl+S saves</span><span class="sp"></span><a data-a="skwin">open in window</a><a data-a="skclose">close</a></div><div class="scskbody"></div>`;
    const api = M.mountSketch(this.skHost.querySelector('.scskbody'), opts);
    if (underlay && sketch) api.setUnderlay(underlay);   // a picked proposal under the existing frame: its base layer
    this.sk = { api, id, shot: shotId };
    this.render();
    api.el.focus({ preventScroll: true }); this.skHost.scrollIntoView({ block: 'nearest' });
    return api;
  }
  async closeSketch(force = false) {
    if (!this.sk) return true;
    if (!force && this.sk.api.dirty && !(await ui.confirm(`Close frame ${this.sk.id} without saving?`))) return false;
    this.sk.api.destroy(); this.sk = null; this.skHost.innerHTML = ''; this.skHost.remove(); return true;
  }
  async copySketch(id) {
    const M = await sketchMod();
    try { const s = await this.skLoad(id); M.clipboard.set({ w: s.w, h: s.h, strokes: s.strokes || [], mask: s.mask || [], pins: s.pins || [], underlay: s.underlay || null, from: id }); toast(`copied frame ${id}: paste it into another shot`); }
    catch (e) { toast(e.message); }
  }
  // paste the copied sketch: into the frame being edited (merged), else as the shot's new frame
  async pasteSketch(shotId = this.sel) {
    const M = await sketchMod(), clip = M.clipboard.get(), s = this.shot(shotId);
    if (!s) return toast('select a shot first');
    if (!clip) return toast('nothing copied: copy a frame first (its "copy" link, or Ctrl+C in the sketch tool)');
    if (this.sk && this.sk.shot === shotId) { this.sk.api.paste(clip); return; }
    const sk = M.normalize({ id: this.newSketchId(shotId), w: clip.w, h: clip.h, paper: '#ffffff', underlay: clip.underlay || null, strokes: clip.strokes, mask: clip.mask, pins: clip.pins, title: `from ${clip.from || 'clipboard'}` });
    const png = await new Promise(async (ok) => (await M.renderSketch(sk, { resolve: imgUrl })).toBlob(ok, 'image/png'));
    const mask = sk.mask.length ? await new Promise((ok) => M.renderMask(sk).toBlob(ok, 'image/png')) : null;
    await this.saveSketch(shotId, sk, png, mask);
  }
  // ---------------------------------------------------------------- notes and asks
  // an ask for the agent on the whole storyboard (storyboard, fill the gaps): written at once (notes.json v2)
  addAsk({ text, ask = 'request', gaps }) { return store.noteAdd({ stage: 'storyboard', kind: 'stage', id: null }, text, { to: 'agent', ask, version: this.doc.current, ...(gaps ? { gaps } : {}) }); }
  hasAsk(ask, text) { return store.notesOn({ stage: 'storyboard', status: 'open' }).some(n => n.ask === ask && n.text === text); }
  // a note on a shot (the Notes column, the shot's scene row), else the whole storyboard
  noteOnShot(id = this.sel) { const s = this.shot(id); this.nc.edit(s ? { stage: 'storyboard', kind: 'shot', id: s.id, ...(s.scene ? { scene: s.scene } : {}) } : { stage: 'storyboard', kind: 'stage', id: null }); }
  ask() { const s = this.shot(this.sel); this.nc.edit(s ? { stage: 'storyboard', kind: 'shot', id: s.id, ...(s.scene ? { scene: s.scene } : {}) } : { stage: 'storyboard', kind: 'stage', id: null }, { to: true }); }
  async askStoryboard() {
    if (this.dirty) return toast('save your edits first: the agent reads the saved version');
    const none = this.scenes.filter(sc => !this.inScene(sc.id).length);
    if (!this.scenes.length) return toast('no scenes yet: the script (stage 2) comes first');
    const text = none.length
      ? `Storyboard ${none.map(s => s.id).join(', ')}: propose shots from their beats (one shot per beat or group of beats, tiled to the scene, cut on the beat grid), each with a kind, the action, camera / motion, the cast / locations / props it needs (and the variant when it differs from the scene's) and a frame sketch where it helps (sketch_save, then sketch on the shot). Write them with shots_update.`
      : 'Storyboard pass: go through every scene\'s shots: complete the action, camera / motion and assets, propose frame sketches for the shots without a frame, and flag what does not work (shot_note_add). Write changes with shots_update.';
    if (this.hasAsk('storyboard', text)) return toast('already asked: the agent has this open ask');
    await this.addAsk({ text, ask: 'storyboard', ...(none.length ? { gaps: { scenes: none.map(s => s.id) } } : {}) });
    toast(`asked the agent to storyboard${none.length ? ' ' + nn(none.length, 'scene') : ''} (Notes column, top row)`);
  }
  async fillGaps() {
    if (this.dirty) return toast('save your edits first: the agent reads the saved version');
    const g = this.gapsNow(this.cur?.shots || []), cv = SB.costView(store.costs, store.requests), total = +(cv.spent + cv.committed + g.estimate.usd).toFixed(2);
    if (!g.no_request.length && !g.assets.length && !g.no_frame.length && !g.no_shots.length) return toast('no gaps on the board: every shot has a frame, approved assets and a request or clip');
    const text = `Fill the gaps: ${g.no_request.length ? `draft a generation request (request_create, target "shot:<id>") for each of the ${nn(g.no_request.length, 'shot')} without a request or clip (${g.no_request.map(x => `${x.shot} ${x.gen} ~$${x.usd.toFixed(2)}`).join(', ')}): still or video as listed, an honest est_cost, refs = the approved variant / look images (+ the frame sketch); gaps_get has the drafts. Estimate ~$${g.estimate.usd.toFixed(2)}: spent $${cv.spent.toFixed(2)} + committed $${cv.committed.toFixed(2)} + this = $${total.toFixed(2)} of the cap $${cv.cap.toFixed(2)}.` : 'every shot has a request or a clip.'}`
      + (g.assets.length ? ` ${nn(g.assets.length, 'asset')} not approved yet (${g.assets.map(a => `${a.name}${a.variant ? ' / ' + a.variant_name : ''}`).join(', ')}): propose their sheets first (asset_get, request_create).` : '')
      + (g.no_shots.length ? ` Scenes without shots: ${g.no_shots.map(x => x.scene).join(', ')} (shots_update).` : '') + (g.no_frame.length ? ` ${nn(g.no_frame.length, 'shot')} without a frame sketch.` : '');
    if (this.hasAsk('fill_gaps', text)) return toast('already asked: the agent has an open "fill the gaps" ask for these gaps');
    await this.addAsk({ text, ask: 'fill_gaps', gaps: { shots: g.no_request.map(x => x.shot), assets: g.assets.map(a => `${a.type}:${a.id}${a.variant ? ':' + a.variant : ''}`), scenes: g.no_shots.map(x => x.scene), est_usd: g.estimate.usd } });
    toast(`asked the agent to fill the gaps (est ${usd(g.estimate.usd)}; Notes column, top row)`);
  }
  gapsNow(shots = this.draft) { return SB.boardGaps({ song: this.song, scenes: this.scenes, shots, entities: store.entities, approvals: store.approvals, requests: store.requests }); }
  setSide(s, render = true) { this.side = s; prefs.set('boardSide', s); if (render) this.renderSide(); }
  // a jump link: gap:<t0> (the script stage), scene:<id>, shot:<id>, asset:<type>:<id>:<variant>
  async go(where) {
    const [k, ...rest] = where.split(':'), v = rest.join(':');
    if (k === 'shot') { this.compare = null; return this.focus(v); }
    if (k === 'scene') return this.focusScene(v);
    if (k === 'gap') { await WB().stages.open('script'); await new Promise(r => setTimeout(r, 50)); const e = document.querySelector(`.scws .scrow.gap[data-gap^="${CSS.escape(v)},"]`); e?.scrollIntoView({ block: 'center' }); e?.classList.add('flash'); setTimeout(() => e?.classList.remove('flash'), 1200); return; }
    if (k === 'asset') {
      const [type, id, vid] = rest, stage = type === 'character' ? 'characters' : 'scenery';
      await WB().stages.open(stage);
      const api0 = () => (type === 'character' ? WB().characters : WB().scenery);
      for (let i = 0; i < 60 && !api0()?.ws; i++) await new Promise(r => setTimeout(r, 50));   // the stage module mounts on its first open
      const api = api0(); if (!api?.ws) return;
      await api.open(id);
      if (vid) { api.ws.setVariant(vid); api.ws.render(); } else api.ws.setTab(api.ws.U.rootTab);
    }
  }
  // ---------------------------------------------------------------- rendering
  render() {
    this.pending = false;
    if (!this.doc || !this.song || !store.scenes) return;
    this.syncBase();
    if (this.sel && !this.shot(this.sel)) this.sel = null;
    this.renderBar();
    if (this.compare) this.renderDiff(); else this.renderList();
    this.renderSide();
    this.ta?.apply();
  }
  renderBar() {
    const v = this.cur, scs = this.scenes, boarded = scs.filter(sc => this.inScene(sc.id).length).length, g = this.gapsNow(), cv = SB.costView(store.costs, store.requests);
    const total = cv.spent + cv.committed + g.estimate.usd, over = !cv.cap || total > cv.cap + 1e-9;
    const msg = this.$('.sbbar .lymsg')?.value || '';
    const ver = v ? `<b>${esc(v.id)}</b> <span class="dim">${esc(v.message || '')}${v.created ? ' · ' + when(v.created) : ''}${v.via === 'agent' ? ' · agent' : ''}</span>` : '<span class="dim">no version yet</span>';
    this.$('.sbbar').innerHTML = `${ver}<span class="dim">· ${nn(this.draft.length, 'shot')} · <span class="${boarded === scs.length && scs.length ? 'okc' : 'gapc'}">${boarded}/${scs.length} scenes boarded</span> · <a data-side="gaps" class="${g.total ? 'gapc' : 'okc'}" title="everything still missing (side panel: Gaps)">${nn(g.total, 'gap')}</a></span><span class="sp"></span>`
      + (this.dirty ? `<span class="unsaved">unsaved edits</span><input class="lymsg" placeholder="what changed (optional)" spellcheck="false" value="${esc(msg)}"><button data-a="save" class="pri" title="Ctrl+Enter: a new version">Save version</button><button data-a="drdiff" title="compare the current version with your edits">diff</button><button data-a="discard">Discard</button>` : '')
      + `<label class="dim" title="cuts and new times snap to the nearest beat or downbeat of the song grid, or to a named event (events: the cut is also anchored to it)">snap <select class="sbsnap">${SB.SNAPS.map(x => `<option${x === this.snap ? ' selected' : ''}>${x}</option>`).join('')}</select></label>`
      + `<button data-a="beats" title="one shot per scene beat or group of beats, for every scene without shots (a scene's own “from beats” redoes it)">Shots from beats</button>`
      + `<a class="sbest${over ? ' bad' : ''}" data-side="gaps" title="${esc(`the shots without a request or clip: est ${usd(g.estimate.usd)}; spent ${usd(cv.spent)} + committed ${usd(cv.committed)} + this = ${usd(total)} of the cap ${usd(cv.cap)}`)}">est ${usd(g.estimate.usd)} · ${usd(total)}/${usd(cv.cap)}</a>`;
  }
  renderList() {
    const list = this.$('.sblist'), scs = this.scenes, dur = this.song.duration_ms, orph = this.orphans();
    if (!scs.length) {
      list.innerHTML = `<div class="scempty"><b>No scenes yet.</b> The storyboard cuts the script's scenes into shots: draft the script first (<a data-stage="script">stage 2</a>).</div>` + (orph.length ? this.groupHtml(null, orph) : '');
      return this.placeSketch();
    }
    const tmo = !!this.ta?.on;   // Time view: a gap row seeks on click; its link opens the script
    const rows = [...scs.map(sc => ({ t0: sc.t0, sc })), ...SC.gaps(scs, dur, 1000).map(([a, b]) => ({ t0: a, gap: [a, b] }))].sort((x, y) => x.t0 - y.t0);
    list.innerHTML = rows.map(r => r.gap ? `<div class="sbgaprow" data-gap="${r.gap[0]},${r.gap[1]}"${tmo ? '' : ` data-go="gap:${r.gap[0]}"`} title="no scene covers this stretch: open the script"><span>unscripted ${SC.span(r.gap[0], r.gap[1])} · ${secs(r.gap[1] - r.gap[0])}</span><a data-go="gap:${r.gap[0]}">script ›</a></div>` : this.groupHtml(r.sc, this.inScene(r.sc.id))).join('')
      + (orph.length ? this.groupHtml(null, orph) : '');
    this.placeSketch();
  }
  railHtml(sc, g) {
    const L = sc.t1 - sc.t0, x = (t) => ((t - sc.t0) / L * 100).toFixed(3) + '%', w = (d) => (d / L * 100).toFixed(3) + '%';
    const spans = g.map((s, i) => `<span class="${i % 2 ? 'b' : 'a'}${s.id === this.sel ? ' on' : ''}" data-pick="${esc(s.id)}" style="left:${x(s.t0)};width:${w(s.t1 - s.t0)}" title="${esc(s.id)} ${clk(s.t0)}–${clk(s.t1)}"></span>`).join('');
    const bars = (this.song.grid?.downbeats || []).filter(t => t > sc.t0 && t < sc.t1).map(t => `<u style="left:${x(t)}"></u>`).join('');
    const beats = (sc.beats || []).map(b => `<i style="left:${x(b.t)}" title="${esc(`${clk(b.t)} ${b.id}: ${b.text}`)}"></i>`).join('');
    return `<div class="sbrail" title="the scene: shots (alternating), bars (ticks), the script's beats (dots)">${spans}${bars}${beats}</div>`;
  }
  groupHtml(sc, g) {
    if (!sc) return `<div class="sbscene outside" data-scene=""><div class="sbsh"><b>Outside the script</b><span class="dim">shots whose scene is not in the current script (${g.length}): move them or remove them</span></div><div class="sbstrip">${g.map(s => this.cardHtml(s, null)).join('')}</div><div class="sbskslot"></div></div>`;
    const st = SC.sceneStatus(store.scenes, sc.id), nb = (sc.beats || []).length, chs = this.chapters, mych = CH.chapterOfScene(chs, sc.id);
    const chv = mych && this.scenes.find(x => mych.scenes.includes(x.id))?.id === sc.id ? this.chapterViews().find(c => c.id === mych.id) : null;
    const band = chv ? `<div class="sbchap st-${esc(chv.status)}" data-chapter="${esc(chv.id)}"><b>${esc(chv.id)}</b><span class="sbchn">${esc(chv.name)}</span><span class="sbchs st-${esc(chv.status)}" title="${esc(`derived from the shots: ${chv.why}`)}">${esc(CH.STATUS_LABEL[chv.status])}</span><span class="dim">${chv.picked}/${chv.shots} picked · ${chv.approved} approved${chv.placeholders ? ` · ${chv.placeholders} placeholder${chv.placeholders === 1 ? '' : 's'}` : ''} · ${chv.scenes.length} scene${chv.scenes.length === 1 ? '' : 's'}</span>${chv.owner ? `<span class="sbcho" title="who builds it">${esc(chv.owner)}</span>` : ''}${chv.file ? `<span class="dim" title="where it is built">${esc(chv.file)}</span>` : ''}<span class="sp"></span><a data-cha="name">rename</a><a data-cha="owner">owner</a><a data-cha="file">file</a><a data-cha="remove">×</a></div>` : '';
    const chsel = `<select class="sbchsel" title="the chapter this scene belongs to (E3)"><option value="">no chapter</option>${chs.map(c => `<option value="${esc(c.id)}"${mych?.id === c.id ? ' selected' : ''}>${esc(c.id)} ${esc(c.name)}</option>`).join('')}<option value="__new">+ new chapter…</option></select>`;
    return `<div class="sbscene" data-scene="${esc(sc.id)}">${band}<div class="sbsh"><span class="scid">${esc(sc.id)}</span><b class="sct" title="${esc(sc.text || '')}">${esc(sc.title) || '<i class="dim">untitled</i>'}</b><span class="sctime">${SC.span(sc.t0, sc.t1)} · ${secs(sc.t1 - sc.t0)} · ${SB.bars(this.song, sc.t0, sc.t1)} bars · ${nn(nb, 'beat')}</span><span class="scst s-${st}" title="scene: ${SC.SCENE_STATUS_LABEL[st]}"><i></i></span>${sc.context ? `<span class="sbwld" title="the scene's world (set it in the script): its cast wear their look for it">${esc(sc.context)}</span>` : ''}<span class="sp"></span>${chsel}<span class="dim">${nn(g.length, 'shot')}</span><a data-a="frombeats" title="${g.length ? 'redo this scene\'s shots from its beats' : 'one shot per beat or group of beats'}">from beats</a><a data-a="addshot" title="${g.length ? 'split the last shot on the beat grid' : 'one shot for the whole scene'}">+ shot</a></div>`
      + this.railHtml(sc, g)
      + `<div class="sbstrip">${g.length ? g.map(s => this.cardHtml(s, sc)).join('') : `<div class="sbempty">no shots yet · <a data-a="frombeats">shots from the ${nn(nb, 'beat')}</a> · <a data-a="addshot">one shot for the scene</a>${sc.text ? `<span class="dim"> · ${esc(sc.text.slice(0, 160))}</span>` : ''}</div>`}</div><div class="sbskslot"></div></div>`;
  }
  cardHtml(s, sc) {
    const st = store.state('shot:' + s.id), assets = SB.shotAssets(s, store.entities, store.approvals, this.scenes), est = SB.shotEstimate(s), reqs = this.reqs(s.id);
    const saved = this.cur?.shots.find(x => x.id === s.id), chg = !saved || JSON.stringify(saved) !== JSON.stringify(s);
    const tk = !s.sketch && !s.thumb && s.clip?.media ? store.mediaById?.[s.clip.media] : null;
    const frame = s.sketch ? `<img src="${esc(this.skUrl(s.sketch))}" alt="" loading="lazy">` : s.thumb ? `<img src="${esc(mediaUrl(s.thumb))}" alt="" loading="lazy">` : tk?.thumb ? `<img src="${esc(mediaUrl(tk.thumb))}" alt="" loading="lazy">`
      : `<img class="sbph" src="${esc(placeholderUri(placeholderFor(s, { entities: store.entities, scenes: this.scenes }).svg))}" alt="placeholder ${esc(s.id)}" title="placeholder: no frame or take yet (the export draws the same frame)"><span class="sbnofr" data-a="draw" title="draw the frame">draw</span>`;
    const chips = assets.map(a => `<span class="sbch k-${a.type}${a.approved ? ' ok' : ''}${a.missing ? ' miss' : ''}${a.mismatch ? ' wmis' : ''}${a.source === 'world' ? ' wld' : ''}" title="${esc(`${a.type} ${a.name}${a.variant ? ' · ' + a.variant_name : ''}${a.source === 'shot' ? ' (this shot)' : a.source === 'world' ? ` (the look for “${a.world}”)` : ''} · ${a.approved ? 'approved' : a.why}${a.mismatch ? '\n⚠ ' + a.mismatch : ''}`)}"><i>${TL[a.type]}</i>${esc(a.name)}${a.variant ? `<em>${esc(a.variant_name)}</em>` : ''}</span>`).join('');
    const last = reqs[reqs.length - 1];
    const pk = s.clip?.file ? `<span class="sbrq pick" title="${esc(`picked take ${s.clip.file}${s.clip.out_ms != null ? ` ${(s.clip.in_ms / 1000).toFixed(2)}–${(s.clip.out_ms / 1000).toFixed(2)} s` : ''}${s.clip.note ? ' · ' + s.clip.note : ''}`)}">★ ${esc(s.clip.request || store.mediaById?.[s.clip.media]?.job || 'take')}.${esc(s.clip.take ?? '?')}${s.clip.out_ms != null ? ` ${((s.clip.out_ms - s.clip.in_ms) / 1000).toFixed(1)}s` : ''}</span>` : '';
    const rq = (s.clips || []).length ? `<span class="sbrq clip" title="${esc(s.clips.join(' '))}">clip ${esc(String(s.clips[0]).split('@')[0])}${s.clips.length > 1 ? ' +' + (s.clips.length - 1) : ''}</span>`
      : last ? `<span class="sbrq s-${esc(last.status)}" title="${esc(`${last.id} ${last.kind} · ${last.status} · est ${usd(last.est_cost)}`)}">${esc(String(last.kind).replace('shot-', ''))} · ${esc(last.status)}</span>`
      : `<span class="sbrq none" title="no generation request or clip yet">no request · ${est.gen} ~${usd(est.usd)}</span>`;
    return `<div class="sbcard${s.id === this.sel ? ' on' : ''}${chg ? ' chg' : ''}" data-shot="${esc(s.id)}">`
      + `<div class="sbc1"><b>${esc(s.id)}</b><span class="sbt">${clk(s.t0)}</span><span class="dim">${secs(s.t1 - s.t0)}</span><span class="sbk">${esc(s.kind)}</span>${s.context ? `<span class="sbwld" title="this shot's world">${esc(s.context)}</span>` : ''}<span class="chip s-${esc(st)}" title="shot:${esc(s.id)}: ${esc(st)} (the director's: Shot panel)">${esc({ draft: '', approved: '✓', locked: 'lock', review: 'review', changes: 'changes' }[st] ?? st)}</span></div>`
      + `<div class="sbfr${s.sketch ? ' skf' : ''}">${frame}<span class="sbg" title="${est.gen === 'video' ? 'a video shot' : 'a still'}">${est.gen === 'video' ? '▶' : '▣'}</span>${(() => { const ps = PR.setsFor(store.proposals, { stage: 'storyboard', kind: 'shot', id: s.id }), it = ps.flatMap(x => x.items).filter(i => i.status !== 'dismissed'), pk = it.find(PR.isPicked); return it.length ? `<span class="ppbadge${pk ? ' pk' : ''}" title="${esc(`${it.length} frame proposal(s)${pk ? ` · picked “${pk.title}”` : ''}: select the shot to choose`)}">◇${pk ? '✓' : it.filter(i => i.status === 'open').length}</span>` : ''; })()}</div>`
      + `<div class="sbtx">${esc(s.title && s.text && !s.text.startsWith(s.title) ? `${s.title}: ${s.text}` : s.text || s.title) || '<i class="dim">no action yet</i>'}</div>`
      + (s.camera ? `<div class="sbcam" title="${esc(s.camera)}">⌖ ${esc(s.camera)}</div>` : '')
      + `<div class="sbchips">${chips || '<span class="dim">no cast / location</span>'}</div><div class="sbft">${pk}${rq}</div></div>`;
  }
  placeSketch() {
    if (!this.sk) return;
    const s = this.shot(this.sk.shot), sel = s && this.scene(s.scene) ? `.sbscene[data-scene="${CSS.escape(s.scene)}"] .sbskslot` : '.sbscene.outside .sbskslot';
    const slot = this.el.querySelector(sel);
    if (slot) slot.appendChild(this.skHost); else if (!this.skHost.isConnected) this.$('.sblist').appendChild(this.skHost);
  }
  renderDiff() {
    const { a, b } = this.compare, va = this.doc.versions.find(v => v.id === a), vb = b === 'draft' ? { id: 'draft', shots: this.draft, message: 'your unsaved edits' } : this.doc.versions.find(v => v.id === b);
    if (!va || !vb) { this.compare = null; return this.renderList(); }
    const ops = F.wordDiff(SB.boardText(va), SB.boardText(vb)), st = F.diffStats(ops), ch = SB.shotChanges(va, vb);
    const side = (keep, cls) => ops.filter(o => o.op === '=' || o.op === keep).map(o => o.w === '\n' ? '<br>' : o.op === '=' ? esc(o.w) + ' ' : `<span class="${cls}">${esc(o.w)}</span> `).join('');
    const hd = (v) => `<b>${esc(v.id)}</b> <span class="dim">${esc(v.message || '')}${v.created ? ' · ' + when(v.created) : ''}</span>`;
    const chs = [...ch.added.map(x => `<span class="dst a">+${esc(x)}</span>`), ...ch.changed.map(x => `<span class="dst c">~${esc(x)}</span>`), ...ch.removed.map(x => `<span class="dst d">−${esc(x)}</span>`)].join(' ');
    if (this.sk) this.skHost.remove();
    this.$('.sblist').innerHTML = `<div class="lydiff"><div class="lydh"><span>${hd(va)} → ${hd(vb)}</span><span class="dim"> · <span class="dst a">+${st.added}</span> <span class="dst d">−${st.removed}</span> words${chs ? ' · shots ' + chs : ''}</span><span class="sp"></span>${b !== 'draft' && vb.id !== this.doc.current ? `<button data-a="restore" data-v="${esc(vb.id)}">Restore ${esc(vb.id)}</button>` : ''}${va.id !== this.doc.current ? `<button data-a="restore" data-v="${esc(va.id)}">Restore ${esc(va.id)}</button>` : ''}<button data-a="closediff">Close</button></div>
      <div class="lydc"><div class="lydl">${side('-', 'del')}</div><div class="lydr">${side('+', 'add')}</div></div></div>`;
  }
  renderSide() {
    const g = this.gapsNow();
    for (const a of this.el.querySelectorAll('.sbside .lytabs [data-side]')) {
      a.classList.toggle('on', a.dataset.side === this.side);
      const n = { shot: this.sel || '', gaps: g.total, versions: this.doc.versions.length }[a.dataset.side];
      a.innerHTML = `${{ shot: 'Shot', gaps: 'Gaps', versions: 'Versions' }[a.dataset.side]}<i>${esc(n)}</i>`;
    }
    const list = this.$('.sbside .lylist'), keep = list.scrollTop;
    list.innerHTML = this.side === 'gaps' ? this.gapsHtml(g) : this.side === 'versions' ? this.versionsHtml() : this.shotHtml();
    const th = this.side === 'shot' && this.sel && list.querySelector('.tkhost');
    if (th) mountTakes(th, { shot: this.sel });
    const sh = this.side === 'shot' && this.sel && list.querySelector('.sfhost');
    if (sh) mountSurfaces(sh, { shot: this.sel });
    list.scrollTop = keep;
  }
  shotHtml() {
    const s = this.shot(this.sel);
    if (!s) return this.overviewHtml();
    const sc = this.scene(s.scene), { prev, next } = this.neighbours(s), st = store.state('shot:' + s.id);
    const first = sc && (!prev || prev.scene !== s.scene), lastS = sc && (!next || next.scene !== s.scene);
    const assets = SB.shotAssets(s, store.entities, store.approvals, this.scenes), haveStill = this.haveStill(s.id), est = SB.shotEstimate(s, { haveStill: !!haveStill }), gen = s.gen || SB.defaultGen(s.kind);
    const stb = (x, l, t) => `<button data-st="${x}" class="${st === x ? 'on s-' + x : ''}" title="${esc(t)}">${l}</button>`;
    let h = `<div class="sbih"><b>${esc(s.id)}</b>${sc ? `<a data-go="scene:${esc(sc.id)}" title="${esc(sc.text || '')}">${esc(sc.id)} ${esc(sc.title || '')}</a>` : '<span class="dim">outside the script</span>'}<span class="sp"></span>${stb('draft', 'draft', 'not reviewed')}${stb('review', 'review', 'ready for a look')}${stb('changes', 'changes', 'needs changes')}${stb('approved', 'approve', 'the director signs this shot off (page only)')}</div>`;
    h += `<div class="sbif"><label>from <input class="sbin-t0" value="${fmt(s.t0, true)}" spellcheck="false"${first ? ' disabled title="the first shot starts with its scene"' : ''}></label>${first ? '' : '<b data-nudge="t0:-1" title="one beat (bar) earlier">◂</b><b data-nudge="t0:1" title="later">▸</b>'}<label>to <input class="sbin-t1" value="${fmt(s.t1, true)}" spellcheck="false"${lastS ? ' disabled title="the last shot ends with its scene"' : ''}></label>${lastS ? '' : '<b data-nudge="t1:-1">◂</b><b data-nudge="t1:1">▸</b>'}<span class="dim">${secs(s.t1 - s.t0)} · ${SB.bars(this.song, s.t0, s.t1)} bars</span></div>`;
    // E1: a cut anchored to a named event (the first / last cut is the scene's: anchor it in the script)
    h += `<div class="sbif sbancs">${first ? (sc?.anchors?.t0 ? `<span class="dim">start ⚓ ${esc(sc.anchors.t0)} (the scene's)</span>` : '') : EV.anchorSelect(s, 't0', store.events, esc, 'sbanc')}${lastS ? (sc?.anchors?.t1 ? `<span class="dim">end ⚓ ${esc(sc.anchors.t1)} (the scene's)</span>` : '') : EV.anchorSelect(s, 't1', store.events, esc, 'sbanc')}</div>`;
    h += `<div class="sbopts">${SB.KINDS.map(k => `<a data-kind="${k}" class="${s.kind === k ? 'on' : ''}">${k}</a>`).join('')}${SB.KINDS.includes(s.kind) ? '' : `<a class="on">${esc(s.kind)}</a>`}<input class="sbin-kind" placeholder="other kind" spellcheck="false"></div>`;
    h += `<div class="sbopts gen"><a data-gen="still" class="${gen === 'still' ? 'on' : ''}" title="one generated frame">▣ still</a><a data-gen="video" class="${gen === 'video' ? 'on' : ''}" title="a start frame, then image-to-video">▶ video</a><span class="dim" title="${esc(est.items.map(x => `${x.kind}: ${usd(x.usd)} ${x.tool} (${x.why})`).join('\n'))}">est ${usd(est.usd)} · ${esc(est.items.map(x => x.kind.replace('shot-', '') + ' ' + usd(x.usd)).join(' + '))}</span></div>`;
    const ws = this.worlds();
    h += `<div class="sbopts sbwrow"><span class="dim" title="the world dresses the cast: each character wears its look for it (E6)">world</span><select class="sbin-world"><option value=""${s.context ? '' : ' selected'}>${sc?.context ? `the scene's: ${esc(sc.context)}` : 'the scene\'s (none)'}</option>${ws.map(w => `<option value="${esc(w)}"${s.context === w ? ' selected' : ''}>${esc(w)}</option>`).join('')}<option value="__new">+ new world…</option></select>${assets.some(a => a.mismatch) ? `<span class="bad" title="${esc(assets.filter(a => a.mismatch).map(a => `${a.name} ${a.mismatch}`).join('\n'))}">⚠ ${assets.filter(a => a.mismatch).length} look${assets.filter(a => a.mismatch).length === 1 ? '' : 's'} off the world</span>` : ''}</div>`;
    h += `<input class="sbin-title" value="${esc(s.title)}" placeholder="title (short)" spellcheck="false"><textarea class="sbin-text" rows="3" placeholder="the action: what we see in this shot" spellcheck="false">${esc(s.text)}</textarea><textarea class="sbin-cam" rows="2" placeholder="camera / motion: slow push in, handheld, locked-off, whip pan, rack focus…" spellcheck="false">${esc(s.camera)}</textarea>`;
    h += `<div class="scbh">frame <a data-a="draw">${s.sketch ? 'edit' : '+ draw'}</a>${s.sketch ? '<a data-a="drawwin">window</a><a data-a="skcopy" title="copy: paste it into another shot">copy</a>' : ''}<a data-a="skpaste" title="paste the copied frame">paste</a>${s.sketch ? '<a data-a="skrm" title="the shot loses its frame (the file stays)">remove</a>' : ''}</div>`
      + (s.sketch ? `<img class="sbiframe" src="${esc(this.skUrl(s.sketch))}" alt="" data-a="draw" title="${esc(s.sketch)} (click: edit)">` : s.thumb ? `<img class="sbiframe" src="${esc(mediaUrl(s.thumb))}" alt="" title="the render frame (shots.json)">` : '')
      + stripHtml({ stage: 'storyboard', kind: 'shot', id: s.id }, { label: 'frame layouts' });
    // assets: the shot's chips, the variant each needs (the scene's unless set here), approved or what is missing
    const ents = store.entities.filter(e => A.TYPES.includes(e.kind));
    const row = (a) => {
      const e = ents.find(x => x.id === a.id && x.kind === a.type) || (a.type === 'location' ? ents.find(x => x.kind === 'location' && x.letter === a.id) : null);
      let sel = '';
      if (e) {
        const T = A.TYPE[e.kind], vs = A.variants(e, e.kind), has = Object.hasOwn(s.variants || {}, e.id), ov = has ? s.variants[e.id] : undefined;
        const { variants: _v, ...bare } = s, d = SB.resolveAsset(e, { ...bare, variants: {} }, store.approvals, sc);   // what it wears without this shot's pick
        const sname = d.variant ? vs.find(v => v.id === d.variant)?.name || d.variant : T.rootWord;
        sel = `<select class="sbin-var" title="the ${T.vWord} this shot needs">`
          + `<option value=""${has ? '' : ' selected'}>${d.source === 'world' ? `world's (${esc(d.world)})` : 'scene\'s'}: ${esc(sname)}</option><option value="__root"${has && ov === null ? ' selected' : ''}>${esc(T.rootWord)}</option>`
          + vs.map(v => `<option value="${esc(v.id)}"${has && ov === v.id ? ' selected' : ''}>${esc(v.name || v.id)}${WD.lookWorld(v) ? ` · ${esc(v.context)}` : ''}${v.status === 'approved' ? ' ✓' : ''}</option>`).join('') + '</select>';
      }
      return `<div class="sbia${a.approved ? ' ok' : ''}${a.mismatch ? ' wmis' : ''}"${a.mismatch ? ` title="${esc('⚠ ' + a.mismatch)}"` : ''} data-type="${esc(a.type)}" data-eid="${esc(a.id)}"><i class="sbat k-${esc(a.type)}">${TL[a.type]}</i>${a.image ? `<img src="${esc(imgUrl(a.image))}" alt="" loading="lazy">` : '<span class="sbnoimg"></span>'}<span class="sban" title="${esc(a.name)}">${esc(a.name)}</span>${sel}<span class="sbaok${a.approved ? '' : ' no'}" title="${esc(a.approved ? 'approved' : a.why || '')}">${a.approved ? '✓' : esc(a.why || '')}</span><b data-a="rmasset" title="remove from the shot">×</b>${a.approved ? '' : `<a data-go="asset:${esc(a.type)}:${esc(a.id)}:${esc(a.variant || '')}" title="open it">›</a>`}</div>`;
    };
    const need = sc ? SB.sceneAssets(sc.id, store.breakdown, store.entities).filter(x => !(s[SB.FIELD[x.type]] || []).includes(x.id)) : [];
    const avail = ents.filter(e => !(s[SB.FIELD[e.kind]] || []).includes(e.id));
    h += `<div class="scbh">cast · locations · props <span class="dim">the variant is the scene's unless set here</span></div>${assets.map(row).join('') || '<div class="dim sbpad">none yet</div>'}`
      + `<div class="sbiadd">${need.map(x => `<a data-add="${esc(x.type)}:${esc(x.id)}" title="the scene needs it (breakdown)">+ ${esc(store.entityById?.[x.id]?.name || x.id)}</a>`).join('')}<select class="sbin-add"><option value="">+ add…</option>${['character', 'location', 'prop'].map(t => { const l = avail.filter(e => e.kind === t); return l.length ? `<optgroup label="${A.TYPE[t].Titles}">${l.map(e => `<option value="${t}:${esc(e.id)}">${esc(e.name || e.id)}</option>`).join('')}</optgroup>` : ''; }).join('')}</select></div>`;
    // requests (drafts approved here) and the next one this shot needs
    const reqs = this.reqs(s.id), openR = reqs.some(r => OPEN_REQ.includes(r.status)), saved = !!this.cur?.shots.some(x => x.id === s.id), q = est.items[0];
    h += `<div class="scbh">takes <span class="dim">pick one: in / out, a note, alternatives</span></div><div class="tkhost"></div>`;
    h += `<div class="scbh">lyrics on screen <span class="dim">every sung word on a surface (E2)</span></div><div class="sfhost"></div>`;
    h += `<div class="scbh">generation</div>${(s.clips || []).length ? `<div class="sbreq s-done"><b>clip</b><span class="sbrqs">${esc(s.clips.join(' '))}</span><span class="dim">in the world clips column</span></div>` : ''}` + reqs.map(r => `<div class="sbreq s-${esc(r.status)}" data-r="${esc(r.id)}"><b>${esc(String(r.kind).replace('shot-', ''))}</b><span class="dim">${esc(r.id)}</span><span class="sbrqs">${esc(r.status)}</span><span class="dim">${usd(r.est_cost)}${r.actual_cost_usd != null ? ' / ' + usd(r.actual_cost_usd) : ''}</span>${r.status === 'draft' ? `<button data-a="reqok" class="pri" title="approve: the agent may run it and spend up to the estimate (page only)">Approve</button><button data-a="reqno">Reject</button>` : ''}</div>`).join('')
      + `<div class="sbiact"><button data-a="reqgen" class="pri"${openR || !saved ? ' disabled' : ''} title="${esc(!saved ? 'save the storyboard first' : openR ? 'a request is open' : `a DRAFT request (nothing runs or is paid until you approve it): ${q.tool}, ${q.why}`)}">Request ${esc(q.kind.replace('shot-', ''))} · est ${usd(q.usd)}</button>${est.items.length > 1 ? `<span class="dim">then the video ${usd(est.items[1].usd)}</span>` : ''}</div>`;
    h += `<div class="sbiact"><button data-a="split" title="cut on the beat grid at the playhead (inside the shot) or the middle">Split at beat</button><button data-a="merge"${next && next.scene === s.scene ? '' : ' disabled'}>Merge with next</button><button data-a="mvl"${prev && prev.scene === s.scene ? '' : ' disabled'} title="swap with the previous shot">◂ Move</button><button data-a="mvr"${next && next.scene === s.scene ? '' : ' disabled'} title="swap with the next shot">Move ▸</button><button data-a="note" title="a note on this shot (Alt+N)">✉ Note</button><button data-a="del">Delete</button></div>`;
    return `<div class="sbins" data-shot="${esc(s.id)}">${h}</div>`;
  }
  // F5: no shot selected: one line of help (+ "?"), then what is left: the lyric gate (E2) line by line and the gap counts
  overviewHtml() {
    const shots = SB.boardShots(this.doc), cov = coverage(this.song, shots), g = this.gapsNow();
    const more = '<p>Each scene of the script is a strip of shots that <b>tile</b> it: the thin rail above a strip shows the cuts, the bars (ticks) and the beats (dots).</p><p><b>Shots from beats</b> proposes one shot per beat or group of beats; edit, split, merge and reorder them, draw a frame for each, then <b>Save version</b>.</p><p>Chips: green = approved; the variant is the scene\'s unless the shot sets one. The <b>Gaps</b> tab lists what is still missing and what filling it would cost.</p>';
    const runs = cov.uncovered.slice(0, 40).map(u => { const sh = shots.find(x => x.t0 <= u.t0 && u.t0 < x.t1); return `<div class="sbgap"${sh ? ` data-pick="${esc(sh.id)}"` : ''}><span class="sbgt">${esc(u.line)}</span><span class="sbgx sfun">“${esc(u.text)}”</span><span class="dim sbgc">${esc(clk(u.t0))}${sh ? ' · ' + esc(sh.id) : ''}</span>${sh ? '<a>shot ›</a>' : ''}</div>`; }).join('');
    const counts = [['unscripted', 'unscripted stretches'], ['no_shots', 'scenes without shots'], ['no_frame', 'shots without a frame'], ['assets', 'assets not approved'], ['looks', 'looks off their world'], ['no_request', 'shots without a request']].map(([k, l]) => `<span class="${g.counts[k] ? 'bad' : 'okc'}">${g.counts[k]} ${l}</span>`).join('');
    return `<div class="lyvh sbov">${help('<span class="dim">no shot selected · click a card (← / → step)</span>', more)}</div>`
      + `<div class="sbgh"><b>Lyric gate</b><i>${cov.covered}/${cov.total}</i><span class="dim">every sung word on a surface at its time</span></div>`
      + (cov.ok ? '<div class="sbgok">✓ every word is on a surface</div>' : runs + (cov.uncovered.length > 40 ? `<div class="dim sbpad">+${cov.uncovered.length - 40} more (timeline: the surface column)</div>` : ''))
      + `<div class="sbgh"><b>Gaps</b><i>${g.total}</i><a data-side="gaps">details ›</a></div><div class="sbcounts">${counts}</div>`;
  }
  gapsHtml(g) {
    const cv = SB.costView(store.costs, store.requests), est = g.estimate.usd, total = +(cv.spent + cv.committed + est).toFixed(2), over = total > cv.cap + 1e-9;
    const W = Math.max(cv.cap, total + cv.drafts, 0.01), pc = (x) => `${Math.max(0, x / W * 100).toFixed(2)}%`;
    let left = 0; const seg = (cls, v, t) => { const s = `<i class="${cls}" style="left:${pc(left)};width:${pc(v)}" title="${esc(t)}"></i>`; left += v; return s; };
    const meter = seg('sp1', cv.spent, `spent ${usd(cv.spent)}`) + seg('cm', cv.committed, `committed (approved, running) ${usd(cv.committed)}`) + seg('es', est, `this estimate ${usd(est)}`) + seg('dr', cv.drafts, `other draft requests ${usd(cv.drafts)}`);
    const cost = `<div class="sbcost"><div class="sbcl"><b>Estimate</b><span>${nn(g.estimate.shots, 'shot')} to generate · ${usd(est)}</span><span class="sp"></span><span class="${over ? 'bad' : 'okc'}" title="spent + committed + this estimate, against the cap">${usd(total)} / cap ${usd(cv.cap)}</span></div>`
      + `<div class="sbmeter">${meter}${cv.cap ? `<b class="cap" style="left:${pc(cv.cap)}" title="cap ${usd(cv.cap)}"></b>` : ''}</div>`
      + `<div class="sbleg"><span><i class="sp1"></i>spent ${usd(cv.spent)}</span><span><i class="cm"></i>committed ${usd(cv.committed)}</span><span><i class="es"></i>this ${usd(est)}</span><span><i class="dr"></i>other drafts ${usd(cv.drafts)}</span></div>`
      + (!cv.cap ? '<div class="chwarn">The cap is $0: nothing paid can run. Set it in Review &gt; Costs (costs.json cap_usd).</div>' : over ? `<div class="chwarn">Over the cap by ${usd(total - cv.cap)}: turn some video shots into stills, drop shots, or raise the cap.</div>` : '') + '</div>';
    const grp = (title, rows, ok) => `<div class="sbgh"><b>${title}</b><i>${rows.length}</i></div>` + (rows.length ? rows.join('') : `<div class="sbgok">✓ ${ok}</div>`);
    const R = (go, a, b, c, link) => `<div class="sbgap" data-go="${esc(go)}"><span class="sbgt">${a}</span><span class="sbgx">${b}</span>${c ? `<span class="dim sbgc">${c}</span>` : ''}<a>${link} ›</a></div>`;
    return `<div class="lyvh"><span class="dim">${nn(g.total, 'gap')} across the stages${this.dirty ? ' · with your unsaved edits' : ''}</span><button data-a="fill" class="pri" title="a note asking the agent for draft requests (MCP gaps_get; also: the stage bar's Ask the agent…)">Ask the agent to fill the gaps</button></div>${cost}`
      + grp('Unscripted time', g.unscripted.map(x => R(`gap:${x.t0}`, esc(x.time), 'no scene', '', 'script')), 'every second of the song is scripted')
      + grp('Scenes without shots', g.no_shots.map(x => R(`scene:${x.scene}`, esc(x.scene), esc(x.title || 'untitled'), nn(x.beats, 'beat'), 'board')), 'every scene has shots')
      + grp('Shots without a frame', g.no_frame.map(x => R(`shot:${x.shot}`, esc(x.shot), esc(x.time), esc(x.scene || ''), 'draw')), 'every shot has a frame')
      + grp('Assets not approved', g.assets.map(a => R(`asset:${a.type}:${a.id}:${a.variant || ''}`, `<i class="sbat k-${esc(a.type)}">${TL[a.type]}</i>${esc(a.name)}`, `${a.variant ? esc(a.variant_name) + ' · ' : ''}${esc(a.why || '')}`, `${nn(a.shots.length, 'shot')}`, a.missing ? 'fix' : a.type === 'character' ? 'characters' : 'scenery')), 'every asset the shots need is approved')
      + (g.looks.length || this.worlds().length ? grp('Looks off their world', g.looks.map(l => R(`shot:${l.shot}`, esc(l.shot), `${esc(l.name)} · ${esc(l.why)}`, esc(l.world), 'shot')), 'every character wears the look of the shot\'s world') : '')
      + grp('Shots without a request or clip', g.no_request.map(x => R(`shot:${x.shot}`, esc(x.shot), `${esc(x.kind)} · ${x.gen === 'video' ? '▶ video' : '▣ still'}`, usd(x.usd), 'shot')), 'every shot has a request or a clip');
  }
  versionsHtml() {
    const vs = [...this.doc.versions].reverse(), { a, b } = this.ab;
    return `<div class="lyvh"><span class="dim">pick A and B, or click a row (it vs the one before)</span><button data-a="ab" ${a && b && a !== b ? '' : 'disabled'}>Compare A → B</button></div>` + (vs.length ? vs.map(v => `<div class="lyv${v.id === this.doc.current ? ' cur' : ''}" data-v="${esc(v.id)}">
      <span class="lyvid">${v.id === this.doc.current ? '●' : ''}${esc(v.id)}</span><span class="lyvm">${esc(v.message || (v.from ? 'restore ' + v.from : ''))}<i>${when(v.created)} ${v.via === 'agent' ? '· agent' : v.by ? '· ' + esc(v.by) : ''} · ${nn(v.shots.length, 'shot')}</i></span>
      <b data-ab="a" class="${a === v.id ? 'on' : ''}">A</b><b data-ab="b" class="${b === v.id ? 'on' : ''}">B</b>${v.id === this.doc.current ? '' : `<b data-a="restore" data-v="${esc(v.id)}" title="copy it as a new version">restore</b>`}</div>`).join('') : '<div class="dim lyno">No versions yet: the first “Save version” makes v1.</div>');
  }
  // ---------------------------------------------------------------- events
  wire() {
    const el = this.el;
    el.addEventListener('click', async (e) => {
      const t = e.target;
      if (t.closest('.sk')) return;   // the sketch tool handles its own clicks
      const act = t.closest('[data-a]')?.dataset.a, card = t.closest('.sbcard[data-shot]'), grp = t.closest('.sbscene[data-scene]'), ins = t.closest('.sbins');
      const sid = ins?.dataset.shot || card?.dataset.shot || this.sel;
      if (act === 'save') return this.save();
      if (act === 'discard') { if (await ui.confirm('Discard your unsaved storyboard edits?')) this.discard(); return; }
      if (act === 'drdiff') { this.compare = { a: this.doc.current, b: 'draft' }; return this.render(); }
      if (act === 'closediff') { this.compare = null; return this.render(); }
      if (act === 'restore') return this.restore(t.closest('[data-v]').dataset.v);
      if (act === 'ab') { this.compare = { ...this.ab }; return this.render(); }
      if (act === 'beats') return this.fromBeats();
      if (act === 'askboard') return this.askStoryboard();
      if (act === 'fill') return this.fillGaps();
      if (act === 'skclose') { if (await this.closeSketch()) this.render(); return; }
      if (act === 'skwin' && this.sk) { const { id, shot } = this.sk; if (this.sk.api.dirty) await this.sk.api.save().catch(() => {}); await this.closeSketch(true); this.render(); return this.openSketchFor(shot, id, { window: true }); }
      if (grp && !card && (act === 'frombeats' || act === 'addshot')) { const scId = grp.dataset.scene; return act === 'frombeats' ? this.fromBeats([scId]) : this.addShot(scId); }
      const cha = t.closest('[data-cha]'); if (cha) return this.editChapter(t.closest('[data-chapter]').dataset.chapter, cha.dataset.cha);
      const pick = t.closest('[data-pick]'); if (pick) return this.select(pick.dataset.pick);
      const go = t.closest('[data-go]'); if (go && !t.closest('button')) return this.go(go.dataset.go);
      const stg = t.closest('a[data-stage]'); if (stg) return WB().stages.open(stg.dataset.stage);
      const st = t.closest('[data-st]'); if (st && sid) return this.setStatus(sid, st.dataset.st);
      const nd = t.closest('[data-nudge]'); if (nd && sid) { const [w, d] = nd.dataset.nudge.split(':'); return this.nudge(sid, w, Number(d)); }
      const kd = t.closest('[data-kind]'); if (kd && sid) return this.setField(sid, 'kind', kd.dataset.kind, true);
      const gn = t.closest('[data-gen]'); if (gn && sid) return this.setField(sid, 'gen', gn.dataset.gen, true);
      const ad = t.closest('[data-add]'); if (ad && sid) { const [ty, id] = ad.dataset.add.split(':'); return this.addAsset(sid, ty, id); }
      if (card && act === 'draw') { this.sel = card.dataset.shot; return this.openSketchFor(card.dataset.shot, this.shot(card.dataset.shot)?.sketch || null); }
      if (card) { if (card.dataset.shot !== this.sel) return this.select(card.dataset.shot, { scroll: false }); return; }
      if (sid) {
        const s = this.shot(sid);
        if (act === 'draw') return this.openSketchFor(sid, s?.sketch || null);
        if (act === 'drawwin' && s?.sketch) return this.openSketchFor(sid, s.sketch, { window: true });
        if (act === 'skcopy' && s?.sketch) return this.copySketch(s.sketch);
        if (act === 'skpaste') return this.pasteSketch(sid);
        if (act === 'skrm') { if (this.sk?.shot === sid) await this.closeSketch(); return this.setField(sid, 'sketch', null, true); }
        if (act === 'rmasset') { const r = t.closest('[data-eid]'); return this.removeAsset(sid, r.dataset.type, r.dataset.eid); }
        if (act === 'reqgen') return this.requestGen(sid);
        if (act === 'reqok') return this.approveReq(t.closest('[data-r]').dataset.r);
        if (act === 'reqno') return this.rejectReq(t.closest('[data-r]').dataset.r);
        if (act === 'split') return this.split(sid);
        if (act === 'merge') return this.merge(sid);
        if (act === 'mvl' || act === 'mvr') return this.move(sid, act === 'mvl' ? -1 : 1);
        if (act === 'note') return this.noteOnShot(sid);
        if (act === 'del') return this.remove(sid);
      }
      const side = t.closest('[data-side]'); if (side) return this.setSide(side.dataset.side);
      const ab = t.closest('[data-ab]'); if (ab) { const v = ab.closest('[data-v]').dataset.v; this.ab[ab.dataset.ab] = this.ab[ab.dataset.ab] === v ? null : v; return this.renderSide(); }
      const vrow = t.closest('.lyv[data-v]');
      if (vrow) { const i = this.doc.versions.findIndex(v => v.id === vrow.dataset.v); const prev = this.doc.versions[i - 1]; this.compare = prev ? { a: prev.id, b: vrow.dataset.v } : { a: vrow.dataset.v, b: this.doc.current }; return this.render(); }
    });
    el.addEventListener('dblclick', (e) => { const c = e.target.closest('.sbcard[data-shot]'); if (c && e.target.closest('.sbfr')) { const s = this.shot(c.dataset.shot); this.openSketchFor(s.id, s.sketch || null); } });
    // field edits: text as you type (no re-render), times / selects on change
    el.addEventListener('input', (e) => {
      const t = e.target, sid = t.closest('.sbins')?.dataset.shot; if (!sid) return;
      if (t.matches('.sbin-text')) this.setField(sid, 'text', t.value);
      else if (t.matches('.sbin-title')) this.setField(sid, 'title', t.value);
      else if (t.matches('.sbin-cam')) this.setField(sid, 'camera', t.value);
    });
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('.sbsnap')) { this.snap = t.value; prefs.set('boardSnap', t.value); return this.renderBar(); }
      if (t.matches('.sbchsel')) { t.blur(); return this.setChapter(t.closest('[data-scene]').dataset.scene, t.value); }
      const sid = t.closest('.sbins')?.dataset.shot; if (!sid) return;
      if (t.matches('.sbanc')) return this.setAnchor(sid, t.dataset.edge, t.value);
      if (t.matches('.sbin-t0, .sbin-t1')) { const v = parseT(t.value); if (v == null) { toast('time: m:ss.mmm or seconds'); return this.render(); } return t.matches('.sbin-t0') ? this.setTimes(sid, v, null) : this.setTimes(sid, null, v); }
      if (t.matches('.sbin-kind')) { const k = t.value.trim().toLowerCase(); if (!SB.KIND_RE.test(k)) { toast('kind: a short lower-case word'); return this.render(); } return this.setField(sid, 'kind', k, true); }
      if (t.matches('.sbin-var')) { t.blur(); return this.setVariant(sid, t.closest('[data-eid]').dataset.eid, t.value); }
      if (t.matches('.sbin-world')) { t.blur(); return this.setWorld(sid, t.value); }
      if (t.matches('.sbin-add') && t.value) { t.blur(); const [ty, id] = t.value.split(':'); return this.addAsset(sid, ty, id); }
    });
    el.addEventListener('focusout', () => setTimeout(() => { if (this.pending && !this.typing()) this.render(); else if (!this.typing()) this.refreshCard(); }, 0));
    el.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t.closest('.sk')) return;
      if (t.matches('.lymsg')) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); this.save(); } return; }
      if (t.matches('input, textarea, select')) {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); t.blur(); this.save(); }
        else if (e.key === 'Enter' && t.matches('input')) { e.preventDefault(); t.blur(); }
        else if (e.key === 'Escape') t.blur();
        return;
      }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); return this.step(e.key === 'ArrowLeft' ? -1 : 1); }
      if (e.key === 'Escape' && this.sel) { e.stopPropagation(); this.select(null, { seek: false }); }
    });
  }
  // after typing in the Shot panel: the card of that shot follows (title, text, camera)
  refreshCard() {
    const s = this.shot(this.sel), c = s && this.el.querySelector(`.sbcard[data-shot="${CSS.escape(s.id)}"]`); if (!c) return;
    const sc = this.scene(s.scene), tmp = document.createElement('div'); tmp.innerHTML = this.cardHtml(s, sc); c.replaceWith(tmp.firstElementChild);
  }
}

// ------------------------------------------------------------------ proposals: what a pick does on a shot (core/proposals.js)
// an SVG -> the frame sketch's base layer (its underlay: the open frame, else the shot's frame / a new one); a text -> the
// shot's action in the draft
registerProposals('storyboard', async ({ target, item }) => {
  if (!S) await WB().stages.open('storyboard');
  const id = target.id, s = S.shot(id); if (!s) throw new Error(`shot ${id} is not in the draft`);
  if (S.sel !== id) S.select(id, { scroll: false });
  if (item.svg) {
    const ul = { src: item.svg, opacity: 0.6, fit: 'contain' };
    if (S.sk?.shot === id) { const api = S.sk.api, prev = api.get().underlay || null; api.setUnderlay(ul); return { what: `the base layer of ${S.sk.id}`, undo: () => { if (S.sk?.api === api) api.setUnderlay(prev); }, redo: () => { if (S.sk?.api === api) api.setUnderlay(ul); } }; }
    const api = await S.openSketchFor(id, s.sketch || null, { underlay: ul }); if (!api) return null;
    return { what: `the base layer of ${id}'s frame (draw over it, then Ctrl+S)`, undo: async () => { if (S.sk?.api === api) await S.closeSketch(true); S.render(); }, redo: () => S.openSketchFor(id, s.sketch || null, { underlay: ul }) };
  }
  if (target.kind !== 'shot') return null;
  const before = structuredClone(S.draft); S.edit(() => { s.text = item.text; }); const after = structuredClone(S.draft);
  return { what: `the action of ${id} (unsaved: Save version keeps it)`, undo: () => S.setDraft(before), redo: () => S.setDraft(after) };
});

// ------------------------------------------------------------------ commands (registered at load: core/rail.js imports this module)
const V = () => visible() && !!S;
const shotOf = (c) => (c?.shotId && S?.shot(c.shotId) ? c.shotId : null) || S?.sel || null;
const ensure = async () => { if (!visible()) await WB().stages.open('storyboard'); return S; };
commands.register([
  { id: 'storyboard.save', group: 'Storyboard', title: 'Save storyboard version', when: () => V() && S.dirty, run: () => S.save() },
  { id: 'storyboard.discard', group: 'Storyboard', title: 'Discard unsaved storyboard edits', when: () => V() && S.dirty, run: () => S.discard() },
  { id: 'storyboard.fromBeats', group: 'Storyboard', title: 'Shots from beats (scenes without shots)', run: async () => (await ensure())?.fromBeats() },
  { id: 'storyboard.ask', group: 'Storyboard', title: 'Ask the agent to storyboard', run: async () => (await ensure())?.askStoryboard() },
  { id: 'storyboard.fillGaps', group: 'Storyboard', title: 'Ask the agent to fill the gaps (draft generation requests)', run: async () => (await ensure())?.fillGaps() },
  { id: 'storyboard.gaps', group: 'Storyboard', title: 'Storyboard gaps (what is still missing, the estimate vs the cap)', run: async () => (await ensure())?.setSide('gaps') },
  { id: 'storyboard.openShot', group: 'Storyboard', title: 'Open shot in the storyboard…', run: async (c) => {
    const s = await ensure(); if (!s) return;
    const id = (c?.shotId && s.shot(c.shotId) ? c.shotId : null) || await ui.pick({ title: 'Open shot', items: s.sorted(s.draft).map(x => ({ label: `${x.id} ${x.title || x.text || ''}`.slice(0, 80), detail: `${x.scene || '-'} · ${clk(x.t0)}–${clk(x.t1)} · ${x.kind}`, value: x.id })) });
    if (id) s.focus(id);
  } },
  { id: 'storyboard.split', group: 'Storyboard', title: 'Split the shot at the beat', when: (c) => V() && !!shotOf(c), run: (c) => S.split(shotOf(c)) },
  { id: 'storyboard.merge', group: 'Storyboard', title: 'Merge the shot with the next', when: (c) => V() && !!shotOf(c), run: (c) => S.merge(shotOf(c)) },
  { id: 'storyboard.moveLeft', group: 'Storyboard', title: 'Move the shot earlier (swap)', when: (c) => V() && !!shotOf(c), run: (c) => S.move(shotOf(c), -1) },
  { id: 'storyboard.moveRight', group: 'Storyboard', title: 'Move the shot later (swap)', when: (c) => V() && !!shotOf(c), run: (c) => S.move(shotOf(c), 1) },
  { id: 'storyboard.delete', group: 'Storyboard', title: 'Remove the shot from the draft', when: (c) => V() && !!shotOf(c), run: (c) => S.remove(shotOf(c)) },
  { id: 'storyboard.frame', group: 'Storyboard', title: 'Draw / edit the shot\'s frame', when: (c) => V() && !!shotOf(c), run: (c) => S.openSketchFor(shotOf(c), S.shot(shotOf(c))?.sketch || null) },
  { id: 'storyboard.copyFrame', group: 'Storyboard', title: 'Copy the shot\'s frame', when: (c) => V() && !!S.shot(shotOf(c))?.sketch, run: (c) => S.copySketch(S.shot(shotOf(c)).sketch) },
  { id: 'storyboard.pasteFrame', group: 'Storyboard', title: 'Paste the copied frame into the shot', when: (c) => V() && !!shotOf(c), run: (c) => S.pasteSketch(shotOf(c)) },
  { id: 'storyboard.request', group: 'Storyboard', title: 'Request the shot\'s next generation (draft)', when: (c) => V() && !!shotOf(c), run: (c) => S.requestGen(shotOf(c)) },
  { id: 'storyboard.approve', group: 'Storyboard', title: 'Approve the shot', when: (c) => V() && !!shotOf(c) && store.state('shot:' + shotOf(c)) !== 'approved', run: (c) => S.setStatus(shotOf(c), 'approved') },
  { id: 'storyboard.note', group: 'Storyboard', title: 'Note on the shot (Notes column)', when: (c) => V() && !!shotOf(c), run: (c) => S.noteOnShot(shotOf(c)) },
  { id: 'storyboard.askNote', group: 'Storyboard', title: 'Ask the agent anything about the selected shot / the storyboard… (a note)', run: async () => (await ensure())?.ask() },
  // "+ shot": on a shot, a new one cut from it (on the grid); on a scene, one more (its last shot split, else one for the scene)
  { id: 'storyboard.addShot', group: 'Storyboard', title: 'Add a shot (this scene / after this shot)', when: (c) => V() && !!(c?.shotId || c?.sceneId || S.sel), run: (c) => c?.shotId && S.shot(c.shotId) ? S.split(c.shotId) : c?.sceneId ? S.addShot(c.sceneId) : S.split(S.sel) },
]);
// Ctrl+Enter / Alt+N: the rail's stage.save / stage.note ask the visible stage (core/rail.js)
window.WB = Object.assign(window.WB || {}, { stageActions: { ...(window.WB?.stageActions || {}), storyboard: { canSave: () => V() && S.dirty, save: () => S.save(), canNote: () => V(), note: () => S.nc.editCurrent() } } });
const ADD = { label: '+ Add', when: () => V(), submenu: [{ cmd: 'storyboard.addShot', label: '+ shot' }, '-', { cmd: 'notes.addHere', label: '+ note here' }] };
// a scene strip or a shot card of the board (contextArgs names both sbscene): + Add first
menus.contribute('sbscene', [ADD, 'storyboard.fromBeats', 'storyboard.askNote']);
menus.contribute('shot', ['-', 'storyboard.openShot', 'storyboard.frame', 'storyboard.split', 'storyboard.merge', 'storyboard.moveLeft', 'storyboard.moveRight', 'storyboard.copyFrame', 'storyboard.pasteFrame', 'storyboard.request', 'storyboard.note', 'storyboard.delete']);

export default {
  mount(el, ctx) { S = new Board(el, ctx); window.WB.storyboard = { focus: (id) => S.focus(id), focusChapter: (id) => S.focusChapter(id), get ws() { return S; } }; },
  show() { if (S && !S.typing()) S.render(); },
  get ws() { return S; },
};
