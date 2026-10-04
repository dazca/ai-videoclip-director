// Stage 2 workspace: the script draft (docs/SPEC_v3_GUIDED.md). The song as a list in time order: each scene next to
// the lyric lines it covers, and every unscripted range as a gap row ("+ scene here"). A click opens a scene in place:
// title, from / to (snapped to lines, bars or sections), the text, timed beats, and its sketches (drawn inline with
// the sketch tool, or in a floating window; copy a sketch from one scene and paste it into another). Edits collect in
// a draft (kept in this browser) until "Save version" (Ctrl+Enter): every save is a new version in scenes.json. The
// scene status (draft / needs you / ok) is saved at once (ok = the director's). Side panel: the intake questions,
// notes per scene with threads and an "Ask the agent" box, versions with a side-by-side diff and restore. "Fill the
// gaps" writes an ask for the agent listing the unscripted ranges (MCP script_get, scenes_update). Format: js/scenes.js.
import { store, prefs, toast, esc, PROJECT, postJSON, mediaUrl } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { commands } from '../core/commands.js';
import { menus } from '../core/menus.js';
import { ui } from '../core/palette.js';
import * as F from '../js/flow.js';
import * as SC from '../js/scenes.js';

const WB = () => window.WB;
const visible = () => WB()?.app?.active() === 'stage' && WB().stages?.current() === 'script';
const nowIso = () => new Date().toISOString().slice(0, 19);
const DKEY = 'scenesDraft:' + PROJECT;
const when = (at) => at ? esc(String(at).replace('T', ' ').slice(5, 16)) : '';
const who = (x) => x.via === 'agent' ? `<span class="who ag" title="written through the agent tools">${esc(x.by && x.by !== 'agent' ? x.by + ' · agent' : 'agent')}</span>` : `<span class="who dr">${esc(x.by === 'import' ? 'import' : 'director')}</span>`;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
// "m:ss.mmm", "m:ss" or seconds -> ms (null when unreadable)
function parseT(s) {
  const v = String(s || '').trim(), m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(v);
  if (m) return Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000);
  return /^\d+(\.\d+)?$/.test(v) ? Math.round(Number(v) * 1000) : null;
}
const blobB64 = (b) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = () => bad(r.error); r.readAsDataURL(b); });
let SKM = null;   // core/sketch/sketch.js, loaded on first use
const sketchMod = async () => (SKM ||= await import('../core/sketch/sketch.js'));
let S = null;     // the mounted workspace (one per page)

class Workspace {
  constructor(el, ctx) {
    this.el = el; this.ctx = ctx; this.side = prefs.get('scriptSide', 'intake'); this.filter = 'open'; this.scope = 'all';
    this.open = prefs.get('scriptOpen:' + PROJECT, null); this.snap = prefs.get('scriptSnap', 'lines');
    this.compare = null; this.ab = { a: null, b: null }; this.pending = false; this.sk = null; this.skVer = {};
    el.classList.add('scws');
    el.innerHTML = `<div class="scmain"><div class="lybar scbar"></div><div class="sclist" tabindex="-1"></div></div>
      <div class="lyside scside"><div class="lytabs"><a data-side="intake">Intake</a><a data-side="notes">Notes</a><a data-side="versions">Versions</a></div>
      <div class="lylist"></div>
      <div class="lyask"><textarea rows="2" placeholder="Ask the agent… (Ctrl+Enter sends)"></textarea><button data-a="ask" title="writes a note addressed to the agent (MCP script_get lists it); nothing is generated or paid">Ask the agent</button></div></div>`;
    this.$ = (s) => el.querySelector(s);
    this.skHost = document.createElement('div'); this.skHost.className = 'scskhost';
    this.loadDraft();
    this.wire();
    store.on((w) => { if (['scenes', 'all', 'song', 'media'].includes(w)) { if (this.typing()) this.pending = true; else this.render(); } });
    this.render();
  }
  get doc() { return store.scenes; }
  get cur() { return SC.currentScript(this.doc); }
  get song() { return store.song; }
  typing() { const a = document.activeElement; return !!a && this.el.contains(a) && a.matches('input, textarea, select') && !a.closest('.sk'); }
  // ---------------------------------------------------------------- the draft (unsaved edits, kept per project in this browser)
  loadDraft() {
    const d = prefs.get(DKEY, null);
    this.draft = d && d.base === (this.doc?.current || null) && Array.isArray(d.scenes) ? d.scenes : structuredClone(this.cur?.scenes || []);
    this.base = this.doc?.current || null;
  }
  syncBase() {
    if (this.base === (this.doc?.current || null) || this.busy) return;
    if (!this.dirtyAgainst(this.base)) this.draft = structuredClone(this.cur?.scenes || []);
    else toast(`script: a new version (${this.doc.current}) arrived while you have unsaved edits; save makes yours the next version`);
    this.base = this.doc?.current || null; this.saveDraft();
  }
  dirtyAgainst(id) { const v = this.doc?.versions.find(x => x.id === id); return !SC.sameScenes(this.draft, v?.scenes || []); }
  get dirty() { return !SC.sameScenes(this.draft, this.cur?.scenes || []); }
  saveDraft() { if (this.dirty) prefs.set(DKEY, { base: this.base, scenes: this.draft }); else prefs.set(DKEY, null); }
  scene(id) { return this.draft.find(s => s.id === id) || null; }
  // a change to the draft: fn(draft); the scene list is re-sorted, line ids follow the song
  edit(fn, { render = true } = {}) {
    fn(this.draft);
    for (const s of this.draft) s.line_ids = SC.linesIn(this.song, s.t0, s.t1).map(l => l.id);
    this.draft.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
    this.saveDraft();
    if (render) this.render(); else this.renderBar();
  }
  // ---------------------------------------------------------------- saving
  async save(message) {
    if (!this.dirty) return toast('script: nothing to save');
    if (message == null) message = this.$('.scbar .lymsg')?.value.trim() || '';
    let body;
    try { body = this.draft.map(s => SC.cleanScene(s, this.song)); SC.checkScenes({ versions: [{ id: 'x', scenes: body }], current: 'x' }); } catch (e) { return toast('not saved: ' + e.message); }
    let id = null; this.busy = true;
    try { await store.mutate('scenes.json', (d) => { id = SC.addScriptVersion(d, body, { by: 'director', via: 'page', message }).id; }, { label: 'save script version' }); } finally { this.busy = false; }
    this.base = this.doc.current; this.draft = structuredClone(this.cur?.scenes || []); this.saveDraft();
    toast(`script saved as ${id}`);
    this.render();
  }
  discard() { this.draft = structuredClone(this.cur?.scenes || []); this.saveDraft(); this.render(); }
  restore(id) {
    const v = this.doc.versions.find(x => x.id === id); if (!v) return;
    this.busy = true;
    return store.mutate('scenes.json', (d) => { SC.addScriptVersion(d, v.scenes, { by: 'director', via: 'page', message: `restore ${id}`, from: id }); }, { label: `restore script ${id}` })
      .finally(() => { this.busy = false; }).then(() => { this.base = this.doc.current; this.draft = structuredClone(this.cur.scenes); this.saveDraft(); this.compare = null; toast(`restored ${id} as ${this.doc.current}`); this.render(); });
  }
  // ---------------------------------------------------------------- scenes
  focus(id) { this.compare = null; this.setOpen(id); this.render(); this.el.querySelector(`.scrow[data-scene="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }); }
  setOpen(id) {
    if (this.sk && this.sk.scene !== id) this.closeSketch();
    this.open = id; prefs.set('scriptOpen:' + PROJECT, id);
  }
  addScene(t0, t1) {
    const dur = this.song.duration_ms, g = SC.gaps(this.draft, dur, 1);
    if (t0 == null) {   // the first gap, else after the open scene, else at the playhead
      const at = g[0] || [this.ctx.timeline?.player.time() ?? 0, dur];
      t0 = at[0]; t1 = at[1];
    }
    const sec = (this.song.sections || []).find(s => s.t0 <= t0 && t0 < s.t1);
    if (t1 == null || (sec && t1 > sec.t1 && sec.t1 - t0 >= 1000)) t1 = sec ? Math.min(t1 ?? dur, sec.t1) : Math.min(dur, t0 + 8000);
    if (t1 - t0 < 200) t1 = Math.min(dur, t0 + 4000);
    if (t1 <= t0) return toast('no room for a scene there');
    const id = SC.nextSceneId(this.doc, this.draft);
    this.edit((d) => { d.push({ id, t0, t1, title: '', text: '', line_ids: [], beats: [], sketches: [] }); }, { render: false });
    this.focus(id);
    setTimeout(() => this.el.querySelector('.sccard.open .scin-title')?.focus(), 0);
  }
  async deleteScene(id) {
    const s = this.scene(id); if (!s) return;
    if ((s.text || s.beats.length || s.sketches.length) && !(await ui.confirm(`Remove scene ${id}${s.title ? ` “${s.title}”` : ''} from the draft? (saved versions keep it)`))) return;
    if (this.open === id) this.setOpen(null);
    this.edit((d) => { d.splice(d.indexOf(s), 1); });
  }
  setTimes(id, t0, t1) {
    const s = this.scene(id), dur = this.song.duration_ms; if (!s) return;
    t0 = SC.snapTime(t0 ?? s.t0, this.song, this.snap); t1 = SC.snapTime(t1 ?? s.t1, this.song, this.snap);
    t0 = Math.max(0, Math.min(dur, t0)); t1 = Math.max(0, Math.min(dur, t1));
    if (t1 <= t0) { toast('a scene needs from < to'); return this.render(); }
    this.edit(() => { s.t0 = t0; s.t1 = t1; for (const b of s.beats) b.t = Math.max(t0, Math.min(t1, b.t)); });
  }
  setStatus(id, status) {
    return store.mutate('scenes.json', (d) => { d.states[id] = { status, by: 'director', via: 'page', at: nowIso() }; }, { label: `scene ${id} ${status}` })
      .then(() => toast(`${id}: ${SC.SCENE_STATUS_LABEL[status]}`));
  }
  addBeat(id) {
    const s = this.scene(id); if (!s) return;
    const last = s.beats[s.beats.length - 1], t = Math.min(s.t1, last ? last.t + Math.max(500, Math.round((s.t1 - last.t) / 2)) : s.t0);
    const bid = SC.nextBeatId(s);
    this.edit(() => { s.beats.push({ id: bid, t, text: '' }); s.beats.sort((a, b) => a.t - b.t); });
    setTimeout(() => this.el.querySelector(`.scbr[data-beat="${bid}"] .scin-btx`)?.focus(), 0);
  }
  // ---------------------------------------------------------------- notes
  addNote({ scene = null, text, to, kind, gaps }) {
    return store.mutate('scenes.json', (d) => {
      d.notes.push({ id: SC.nextNoteId(d), scene, text, by: 'director', ...(to ? { to, kind: kind || 'request' } : {}), ...(gaps ? { gaps } : {}), status: 'open', at: nowIso(), version: d.current, replies: [] });
    }, { label: to ? 'ask the agent' : 'scene note' });
  }
  reply(id, text) { return store.mutate('scenes.json', (d) => { const n = d.notes.find(x => x.id === id); if (n) (n.replies ||= []).push({ id: `${n.id}.${(n.replies?.length || 0) + 1}`, text, by: 'director', at: nowIso() }); }, { label: 'reply ' + id }); }
  resolve(id) { return store.mutate('scenes.json', (d) => { const n = d.notes.find(x => x.id === id); if (n) { n.status = n.status === 'open' ? 'resolved' : 'open'; n.resolved_by = 'director'; n.resolved_at = nowIso(); } }, { label: 'resolve ' + id }); }
  async noteOnScene(id = this.open) {
    const s = id && this.scene(id); if (!s) return toast('open a scene first');
    const text = await ui.prompt({ title: `Note on ${s.id}${s.title ? ` “${s.title}”` : ''}`, placeholder: 'note (Enter saves)' }); if (!text) return;
    await this.addNote({ scene: s.id, text }); this.setSide('notes');
  }
  async ask() {
    const ta = this.$('.lyask textarea'), text = ta.value.trim(); if (!text) { ta.focus(); return; }
    await this.addNote({ scene: this.open && this.cur?.scenes.some(s => s.id === this.open) ? this.open : null, text, to: 'agent' });
    ta.value = ''; toast('asked the agent (a note it reads with script_get)');
  }
  fillGaps() {
    if (this.dirty) return toast('save your edits first: the agent reads the saved version');
    const g = SC.gaps(this.cur?.scenes || [], this.song.duration_ms);
    if (!g.length) return toast('every second of the song is scripted');
    if (this.doc.notes.some(n => n.status === 'open' && n.kind === 'fill_gaps' && JSON.stringify(n.gaps) === JSON.stringify(g))) return toast('already asked: the agent has an open "fill the gaps" ask for these ranges');
    const text = `Fill the gaps: script the unscripted ranges ${g.map(([a, b]) => SC.span(a, b)).join(', ')} so every second of the song is covered (keep the existing scenes; snap to lines or bars).`;
    return this.addNote({ text, to: 'agent', kind: 'fill_gaps', gaps: g }).then(() => { this.setSide('notes'); toast(`asked the agent to fill ${g.length} gap${g.length > 1 ? 's' : ''}`); });
  }
  setSide(s) { this.side = s; prefs.set('scriptSide', s); this.renderSide(); }
  // ---------------------------------------------------------------- intake
  setAnswer(k, text) { return store.mutate('scenes.json', (d) => { d.intake[k] = { ...(d.intake[k] || {}), text }; }, { label: 'intake ' + k }); }
  // ---------------------------------------------------------------- sketches
  skPaths(id) { const m = store.mediaById?.[`sketch-${id}`]; return { png: m?.path || `sketches/${id}.png`, json: m?.sketch || `sketches/${id}.json` }; }
  skUrl(id) { return `${mediaUrl(this.skPaths(id).png)}?v=${this.skVer[id] || store.mediaById?.[`sketch-${id}`]?.updated || ''}`; }
  async skLoad(id) { const r = await fetch(`${mediaUrl(this.skPaths(id).json)}?v=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) throw new Error(`sketch ${id}: ${r.status}`); return r.json(); }
  newSketchId(sceneId) { return `sk-${String(sceneId).toLowerCase().replace(/[^a-z0-9_-]/g, '')}-${Date.now().toString(36).slice(-5)}`; }
  // the sketch tool's save: the files go to the server at once; a new sketch joins the scene (a new version when the
  // draft had no other edits, else in the draft)
  async saveSketch(sceneId, sk, png, mask) {
    const r = await postJSON('/api/op/sketch_save', { id: sk.id, sketch: sk, png: await blobB64(png), mask: mask ? await blobB64(mask) : null, links: { scenes: [sceneId] } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast('sketch not saved: ' + (j.error || r.status)); throw new Error(j.error || r.status); }
    this.skVer[sk.id] = Date.now();
    const s = this.scene(sceneId);
    if (s && !s.sketches.includes(sk.id)) {
      const clean = !this.dirty;
      this.edit(() => { s.sketches.push(sk.id); }, { render: false });
      if (clean) await this.save(`sketch ${sk.id} on ${sceneId}`); else { this.render(); toast(`sketch ${sk.id} saved · Save version keeps it in the script`); }
    } else { this.render(); toast(`sketch ${sk.id} saved${j.private ? ' (private: drawn over a private image)' : ''}`); }
    return j;
  }
  async openSketchFor(sceneId, sketchId, { window: win = false } = {}) {
    const M = await sketchMod(), s = this.scene(sceneId); if (!s) return;
    let sketch = null;
    if (sketchId) { try { sketch = await this.skLoad(sketchId); } catch (e) { return toast(e.message); } }
    const id = sketchId || this.newSketchId(sceneId);
    const opts = { sketch: sketch || undefined, id, w: 1280, h: 720, resolve: mediaUrl, title: `Sketch ${id} · ${sceneId}${s.title ? ' ' + s.title : ''}`,
      save: (sk, png, mask) => this.saveSketch(sceneId, sk, png, mask),
      onDuplicate: (copy) => { copy.id = this.newSketchId(sceneId); M.openSketch({ sketch: copy, resolve: mediaUrl, title: `Sketch ${copy.id} (copy) · ${sceneId}`, save: (sk, png, mask) => this.saveSketch(sceneId, sk, png, mask) }); } };
    if (win) { if (this.sk?.id === id) this.closeSketch(true); return M.openSketch(opts); }
    if (this.sk && !(await this.closeSketch())) return;
    this.setOpen(sceneId);
    this.skHost.innerHTML = `<div class="scskbar"><b>${esc(id)}</b><span class="dim">${sketch ? '' : 'new sketch · '}draw, P = pin a note, M = mask; Ctrl+S saves</span><span class="sp"></span><a data-a="skwin">open in window</a><a data-a="skclose">close</a></div><div class="scskbody"></div>`;
    const api = M.mountSketch(this.skHost.querySelector('.scskbody'), opts);
    this.sk = { api, id, scene: sceneId };
    this.render();
    api.el.focus({ preventScroll: true });
    return api;
  }
  async closeSketch(force = false) {
    if (!this.sk) return true;
    if (!force && this.sk.api.dirty && !(await ui.confirm(`Close sketch ${this.sk.id} without saving?`))) return false;
    this.sk.api.destroy(); this.sk = null; this.skHost.innerHTML = ''; this.skHost.remove(); return true;
  }
  async copySketch(id) {
    const M = await sketchMod();
    try { const s = await this.skLoad(id); M.clipboard.set({ w: s.w, h: s.h, strokes: s.strokes || [], mask: s.mask || [], pins: s.pins || [], underlay: s.underlay || null, from: id }); toast(`copied sketch ${id}: paste it into another scene`); }
    catch (e) { toast(e.message); }
  }
  // paste the copied sketch: into the sketch being edited (merged), else as a new sketch of the scene
  async pasteSketch(sceneId = this.open) {
    const M = await sketchMod(), clip = M.clipboard.get(); const s = sceneId && this.scene(sceneId);
    if (!s) return toast('open a scene first');
    if (!clip) return toast('nothing copied: copy a sketch first (its "copy" link, or Ctrl+C in the sketch tool)');
    if (this.sk && this.sk.scene === sceneId) { this.sk.api.paste(clip); return; }
    const sk = M.normalize({ id: this.newSketchId(sceneId), w: clip.w, h: clip.h, paper: '#ffffff', underlay: clip.underlay || null, strokes: clip.strokes, mask: clip.mask, pins: clip.pins, title: `from ${clip.from || 'clipboard'}` });
    const png = await new Promise(async (ok) => (await M.renderSketch(sk, { resolve: mediaUrl })).toBlob(ok, 'image/png'));
    const mask = sk.mask.length ? await new Promise((ok) => M.renderMask(sk).toBlob(ok, 'image/png')) : null;
    await this.saveSketch(sceneId, sk, png, mask);
  }
  // ---------------------------------------------------------------- rendering
  render() {
    this.pending = false;
    if (!this.doc || !this.song) return;
    this.syncBase();
    this.renderBar();
    if (this.compare) this.renderDiff(); else this.renderList();
    this.renderSide();
  }
  renderBar() {
    const v = this.cur, dur = this.song.duration_ms, g = SC.gaps(this.draft, dur), cov = SC.coverage(this.draft, dur);
    const msg = this.$('.scbar .lymsg')?.value || '';   // the bar is rebuilt while you type in a scene: keep the message
    const ver = v ? `<b>${esc(v.id)}</b> <span class="dim">${esc(v.message || '')}${v.created ? ' · ' + when(v.created) : ''} · ${v.via === 'agent' ? 'agent' : esc(v.by || '')}</span>` : '<span class="dim">no version yet</span>';
    this.$('.scbar').innerHTML = `${ver}<span class="dim">· ${this.draft.length} scenes · <span class="${cov >= 0.999 ? 'okc' : 'gapc'}">${Math.round(cov * 100)}% scripted</span>${g.length ? ` · ${g.length} gap${g.length > 1 ? 's' : ''}` : ''}</span><span class="sp"></span>`
      + (this.dirty ? `<span class="unsaved">unsaved edits</span><input class="lymsg" placeholder="what changed (optional)" spellcheck="false" value="${esc(msg)}"><button data-a="save" class="pri" title="Ctrl+Enter: a new version">Save version</button><button data-a="drdiff" title="compare the current version with your edits">diff</button><button data-a="discard">Discard</button>` : '')
      + `<label class="dim" title="new times snap to the nearest lyric line, downbeat or section bound">snap <select class="scsnap">${SC.SNAPS.map(x => `<option${x === this.snap ? ' selected' : ''}>${x}</option>`).join('')}</select></label><button data-a="addscene" title="a new scene in the first gap">+ scene</button><button data-a="fill" title="ask the agent to script every unscripted range">Fill the gaps</button><button data-a="compare" title="side-by-side diff of two versions">Compare…</button>`;
  }
  renderList() {
    const list = this.$('.sclist'), song = this.song, dur = song.duration_ms;
    const rows = [...this.draft.map(s => ({ t0: s.t0, t1: s.t1, s })), ...SC.gaps(this.draft, dur, 1).map(([a, b]) => ({ t0: a, t1: b, gap: true }))].sort((a, b) => a.t0 - b.t0 || (a.gap ? -1 : 1));
    if (!rows.length || (!this.draft.length && rows.length === 1)) {
      list.innerHTML = `<div class="scempty"><b>No scenes yet.</b> Answer the intake (right), then draft the scenes here (<a data-a="addscene">+ scene</a>) or ask the agent to draft them (<a data-a="fill">Fill the gaps</a>): every scene is bound to a stretch of the song.</div>`
        + (rows[0] ? this.rowHtml(rows[0]) : '');
      return this.placeSketch();
    }
    const openNotes = new Map(); for (const n of this.doc.notes) if (n.status === 'open' && n.scene) openNotes.set(n.scene, (openNotes.get(n.scene) || 0) + 1);
    list.innerHTML = rows.map(r => this.rowHtml(r, openNotes)).join('');
    this.placeSketch();
    if (this.flash) { const e = list.querySelector(`[data-scene="${CSS.escape(this.flash)}"]`); e?.scrollIntoView({ block: 'center' }); e?.classList.add('flash'); setTimeout(() => e?.classList.remove('flash'), 1200); this.flash = null; }
  }
  linesHtml(t0, t1) {
    const L = SC.linesIn(this.song, t0, t1);
    return L.length ? L.map(l => `<div class="scl"><span class="lyt" data-t="${l.t0}" title="${fmt(l.t0, true)} (click: show in the timeline)">${l.timing === 'estimated' ? '~' : ''}${fmt(l.t0)}</span><span>${esc(l.text)}</span></div>`).join('') : '<div class="scl dim">(no lyrics)</div>';
  }
  rowHtml(r, openNotes = new Map()) {
    if (r.gap) return `<div class="scrow gap" data-gap="${r.t0},${r.t1}"><div class="sclines">${this.linesHtml(r.t0, r.t1)}</div><div class="scgap"><span>unscripted ${SC.span(r.t0, r.t1)} · ${secs(r.t1 - r.t0)}</span><a data-a="addgap">+ scene here</a></div></div>`;
    const s = r.s, st = SC.sceneStatus(this.doc, s.id), saved = this.cur?.scenes.find(x => x.id === s.id), chg = !saved || JSON.stringify(saved) !== JSON.stringify(s);
    const open = this.open === s.id, nn = openNotes.get(s.id) || 0;
    const sk = s.sketches.map(k => `<div class="scsk${this.sk?.id === k ? ' on' : ''}" data-sk="${esc(k)}"><img loading="lazy" src="${esc(this.skUrl(k))}" alt="" title="${esc(k)}"><span>${esc(k.replace(/^sk-/, ''))}</span>${open ? `<span class="sckl"><b data-a="skedit" title="edit inline">edit</b><b data-a="skwin" title="edit in a floating window">window</b><b data-a="skcopy" title="copy: paste it into another scene">copy</b><b data-a="skrm" title="remove from this scene (the files stay)">×</b></span>` : ''}</div>`).join('');
    const head = `<span class="scid">${esc(s.id)}</span>`;
    let card;
    if (!open) {
      card = `<div class="sccard s-${st}${chg ? ' chg' : ''}" data-a="open" title="click: edit this scene"><div class="sch">${head}<b class="sct">${esc(s.title) || '<i class="dim">untitled</i>'}</b><span class="sctime">${SC.span(s.t0, s.t1)} · ${secs(s.t1 - s.t0)}</span><span class="scst s-${st}" title="${SC.SCENE_STATUS_LABEL[st]}"><i></i>${SC.SCENE_STATUS_LABEL[st]}</span>${nn ? `<span class="lynb" title="${nn} open note(s)">${nn}</span>` : ''}</div>`
        + (s.text ? `<div class="sctx">${esc(s.text)}</div>` : '')
        + (s.beats.length ? `<div class="scbeats">${s.beats.map(b => `<div><span class="lyt" data-t="${b.t}">${fmt(b.t)}</span>${esc(b.text)}</div>`).join('')}</div>` : '')
        + (sk ? `<div class="scsks">${sk}</div>` : '') + `</div>`;
    } else {
      const sb = (x, l) => `<button data-st="${x}" class="${st === x ? 'on s-' + x : ''}" title="${x === 'ok' ? 'the director signs this scene off' : ''}">${l}</button>`;
      card = `<div class="sccard open s-${st}${chg ? ' chg' : ''}"><div class="sch">${head}<input class="scin-title" value="${esc(s.title)}" placeholder="title" spellcheck="false"><span class="scst s-${st}"><i></i></span>${sb('draft', 'draft')}${sb('needs_you', 'needs you')}${sb('ok', 'ok')}<b class="sctool" data-a="note" title="note on this scene (Alt+N)">✉${nn ? ' ' + nn : ''}</b><b class="sctool" data-a="del" title="remove the scene from the draft">×</b><b class="sctool" data-a="close" title="close (Esc)">▴</b></div>
        <div class="scf"><label>from <input class="scin-t0" value="${fmt(s.t0, true)}" spellcheck="false"></label><label>to <input class="scin-t1" value="${fmt(s.t1, true)}" spellcheck="false"></label><span class="dim">${secs(s.t1 - s.t0)} · ${s.line_ids.length} line${s.line_ids.length === 1 ? '' : 's'} · snap ${esc(this.snap)}</span><a data-a="t0play" title="set from to the playhead">from = playhead</a><a data-a="t1play" title="set to to the playhead">to = playhead</a></div>
        <textarea class="scin-text" rows="3" placeholder="what happens: the visual description (who, where, action, camera, mood)" spellcheck="false">${esc(s.text)}</textarea>
        <div class="scbh">beats <a data-a="addbeat">+ beat</a></div>
        ${s.beats.map(b => `<div class="scbr" data-beat="${esc(b.id)}"><input class="scin-bt" value="${fmt(b.t, true)}" spellcheck="false" title="time inside the scene"><input class="scin-btx" value="${esc(b.text)}" placeholder="action at this moment" spellcheck="false"><b data-a="delbeat" title="remove">×</b></div>`).join('')}
        <div class="scbh">sketches <a data-a="sknew">+ new sketch</a><a data-a="skpaste" title="paste the copied sketch (a new sketch of this scene; into the open sketch when one is open)">paste</a></div>
        ${sk ? `<div class="scsks">${sk}</div>` : ''}<div class="scskslot"></div></div>`;
    }
    return `<div class="scrow${open ? ' open' : ''}" data-scene="${esc(s.id)}"><div class="sclines">${this.linesHtml(s.t0, s.t1)}</div>${card}</div>`;
  }
  // the inline sketch editor lives in a persistent element moved into the open scene's slot (a re-render never
  // destroys an unsaved drawing)
  placeSketch() {
    if (!this.sk) return;
    const slot = this.el.querySelector(`.scrow[data-scene="${CSS.escape(this.sk.scene)}"] .scskslot`);
    if (slot) slot.appendChild(this.skHost); else if (!this.skHost.isConnected) this.$('.sclist').appendChild(this.skHost);
  }
  renderDiff() {
    const { a, b } = this.compare, va = this.doc.versions.find(v => v.id === a), vb = b === 'draft' ? { id: 'draft', scenes: this.draft, message: 'your unsaved edits' } : this.doc.versions.find(v => v.id === b);
    if (!va || !vb) { this.compare = null; return this.renderList(); }
    const ops = F.wordDiff(SC.scriptText(va), SC.scriptText(vb)), st = F.diffStats(ops), ch = SC.sceneChanges(va, vb);
    const side = (keep, cls) => ops.filter(o => o.op === '=' || o.op === keep).map(o => o.w === '\n' ? '<br>' : o.op === '=' ? esc(o.w) + ' ' : `<span class="${cls}">${esc(o.w)}</span> `).join('');
    const hd = (v) => `<b>${esc(v.id)}</b> <span class="dim">${esc(v.message || '')}${v.created ? ' · ' + when(v.created) : ''}</span>`;
    const chs = [...ch.added.map(x => `<span class="dst a">+${esc(x)}</span>`), ...ch.changed.map(x => `<span class="dst c">~${esc(x)}</span>`), ...ch.removed.map(x => `<span class="dst d">−${esc(x)}</span>`)].join(' ');
    if (this.sk) this.skHost.remove();
    this.$('.sclist').innerHTML = `<div class="lydiff"><div class="lydh"><span>${hd(va)} → ${hd(vb)}</span><span class="dim"> · <span class="dst a">+${st.added}</span> <span class="dst d">−${st.removed}</span> words${chs ? ' · scenes ' + chs : ''}</span><span class="sp"></span>${b !== 'draft' && vb.id !== this.doc.current ? `<button data-a="restore" data-v="${esc(vb.id)}">Restore ${esc(vb.id)}</button>` : ''}${va.id !== this.doc.current ? `<button data-a="restore" data-v="${esc(va.id)}">Restore ${esc(va.id)}</button>` : ''}<button data-a="closediff">Close</button></div>
      <div class="lydc"><div class="lydl">${side('-', 'del')}</div><div class="lydr">${side('+', 'add')}</div></div></div>`;
  }
  renderSide() {
    const open = this.doc.notes.filter(x => x.status === 'open').length, unanswered = SC.intakeOpen(this.doc).length;
    for (const a of this.el.querySelectorAll('.lytabs [data-side]')) {
      a.classList.toggle('on', a.dataset.side === this.side);
      const n = a.dataset.side === 'notes' ? open : a.dataset.side === 'versions' ? this.doc.versions.length : `${SC.INTAKE.length - unanswered}/${SC.INTAKE.length}`;
      a.innerHTML = `${{ intake: 'Intake', notes: 'Notes', versions: 'Versions' }[a.dataset.side]}<i>${n}</i>`;
    }
    this.$('.lyask').style.display = this.side === 'notes' ? '' : 'none';
    const ta = this.$('.lyask textarea'), os = this.open && this.scene(this.open);
    ta.placeholder = os ? `Ask the agent about ${os.id}${os.title ? ' “' + os.title + '”' : ''}… (Ctrl+Enter sends)` : 'Ask the agent about the whole script… (Ctrl+Enter sends)';
    const list = this.$('.lylist');
    if (this.side === 'intake') {
      list.innerHTML = `<div class="lyvh"><span class="dim">${unanswered ? `${unanswered} of ${SC.INTAKE.length} open · answer here or in a chat with the agent` : 'all answered'}</span><button data-a="askdraft" title="ask the agent to draft the scenes from these answers">Ask for a draft</button></div>`
        + SC.INTAKE.map(q => { const a = this.doc.intake[q.id] || {};
          return `<div class="scq${a.text ? ' done' : ''}" data-q="${q.id}"><div class="scqh"><b>${esc(q.q)}</b>${a.asked ? `<span class="to" title="${esc(`asked by ${a.asked.via === 'agent' ? 'the agent' : 'the director'} ${a.asked.at || ''}`)}">asked in chat</span>` : ''}<span class="sp"></span>${a.text ? who(a) : ''}</div><textarea rows="2" placeholder="${esc(q.hint)}" spellcheck="false">${esc(a.text || '')}</textarea></div>`; }).join('');
      return;
    }
    if (this.side === 'versions') {
      const vs = [...this.doc.versions].reverse(), { a, b } = this.ab;
      list.innerHTML = `<div class="lyvh"><span class="dim">pick A and B, or click a row (it vs the one before)</span><button data-a="ab" ${a && b && a !== b ? '' : 'disabled'}>Compare A → B</button></div>` + (vs.length ? vs.map(v => `<div class="lyv${v.id === this.doc.current ? ' cur' : ''}" data-v="${esc(v.id)}">
        <span class="lyvid">${v.id === this.doc.current ? '●' : ''}${esc(v.id)}</span><span class="lyvm">${esc(v.message || (v.from ? 'restore ' + v.from : ''))}<i>${when(v.created)} ${v.via === 'agent' ? '· agent' : v.by ? '· ' + esc(v.by) : ''} · ${v.scenes.length} scenes</i></span>
        <b data-ab="a" class="${a === v.id ? 'on' : ''}">A</b><b data-ab="b" class="${b === v.id ? 'on' : ''}">B</b>${v.id === this.doc.current ? '' : `<b data-a="restore" data-v="${esc(v.id)}" title="copy it as a new version">restore</b>`}</div>`).join('') : '<div class="dim lyno">No versions yet: the first “Save version” makes v1.</div>');
      return;
    }
    const order = new Map(this.draft.map((s, i) => [s.id, i]));
    const ns = this.doc.notes.filter(x => (this.filter === 'all' || x.status === this.filter) && (this.scope === 'all' || x.scene === this.open))
      .sort((x, y) => (order.get(x.scene) ?? -1) - (order.get(y.scene) ?? -1) || String(x.at).localeCompare(String(y.at)));
    const opt = (v, l, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`;
    list.innerHTML = `<div class="lyvh"><span class="dim">${ns.length} note${ns.length === 1 ? '' : 's'}</span><select class="scscope" title="whose notes">${opt('all', 'all scenes', this.scope)}${opt('scene', 'the open scene', this.scope)}</select><select class="scflt" title="which notes">${opt('open', 'open', this.filter)}${opt('all', 'all', this.filter)}${opt('resolved', 'resolved', this.filter)}</select></div>` + (ns.length ? ns.map(x => {
      const s = x.scene && this.scene(x.scene), where = !x.scene ? (x.kind === 'fill_gaps' ? 'fill the gaps' : 'whole script') : s ? `${esc(s.id)}${s.title ? ' ' + esc(s.title) : ''}${x.beat ? ' / ' + esc(x.beat) : ''}` : `${esc(x.scene)} (not in the draft)`;
      return `<div class="lynote ${x.status}${x.to === 'agent' ? ' ask' : ''}" data-note="${esc(x.id)}" data-scene="${esc(x.scene || '')}">
        <div class="lynh">${who(x)}${x.to === 'agent' ? '<span class="to">→ agent</span>' : ''}<a data-go="${esc(x.scene || '')}">${where}</a><span class="sp"></span><span class="dim">${when(x.at)}</span><b data-a="resolve" title="${x.status === 'open' ? 'resolve' : 'reopen'}">${x.status === 'open' ? '✓' : '↺'}</b></div>
        <div class="lynt">${esc(x.text)}</div>${(x.replies || []).map(rp => `<div class="lynr">${who(rp)} ${esc(rp.text)} <span class="dim">${when(rp.at)}</span></div>`).join('')}
        <input class="lyrep" placeholder="reply (Enter)" spellcheck="false"></div>`;
    }).join('') : `<div class="dim lyno">${this.filter === 'open' ? 'No open notes. Open a scene and press ✉ (Alt+N), or ask the agent below.' : 'No notes.'}</div>`);
  }
  // ---------------------------------------------------------------- events
  wire() {
    const el = this.el;
    el.addEventListener('click', async (e) => {
      const t = e.target;
      if (t.closest('.sk')) return;   // the sketch tool handles its own clicks
      const tm = t.closest('.lyt[data-t]'); if (tm) return this.ctx.goto(Number(tm.dataset.t));
      const row = t.closest('.scrow'), sid = row?.dataset.scene;
      const st = t.closest('[data-st]'); if (st && sid) return this.setStatus(sid, st.dataset.st);
      const skEl = t.closest('[data-sk]'), skId = skEl?.dataset.sk;
      const act = t.closest('[data-a]')?.dataset.a;
      if (act === 'save') return this.save();
      if (act === 'discard') { if (await ui.confirm('Discard your unsaved script edits?')) this.discard(); return; }
      if (act === 'drdiff') { this.compare = { a: this.doc.current, b: 'draft' }; return this.render(); }
      if (act === 'closediff') { this.compare = null; return this.render(); }
      if (act === 'compare') return commands.run('script.compare');
      if (act === 'restore') return this.restore(t.closest('[data-v]').dataset.v);
      if (act === 'ab') { this.compare = { ...this.ab }; return this.render(); }
      if (act === 'addscene') return this.addScene();
      if (act === 'addgap') { const [a, b] = row.dataset.gap.split(',').map(Number); return this.addScene(a, b); }
      if (act === 'fill') return this.fillGaps();
      if (act === 'ask') return this.ask();
      if (act === 'askdraft') return this.addNote({ text: 'Draft the scenes from the intake answers: cover the whole song, each scene bound to its lines, with beats and a short visual description.', to: 'agent', kind: 'request' }).then(() => { this.setSide('notes'); toast('asked the agent for a draft'); });
      if (act === 'resolve') return this.resolve(t.closest('[data-note]').dataset.note);
      if (act === 'skclose') return this.closeSketch().then(ok => ok && this.render());
      if (act === 'skwin' && !skId && this.sk) { const { id, scene } = this.sk; if (this.sk.api.dirty) await this.sk.api.save().catch(() => {}); await this.closeSketch(true); this.render(); return this.openSketchFor(scene, id, { window: true }); }
      if (act === 'open' && sid) { this.setOpen(sid); return this.render(); }
      if (act === 'close') { this.setOpen(null); return this.render(); }
      if (sid) {
        if (act === 'del') return this.deleteScene(sid);
        if (act === 'note') return this.noteOnScene(sid);
        if (act === 'addbeat') return this.addBeat(sid);
        if (act === 'delbeat') { const bid = t.closest('[data-beat]').dataset.beat; return this.edit(() => { const s = this.scene(sid); s.beats = s.beats.filter(b => b.id !== bid); }); }
        if (act === 't0play' || act === 't1play') { const tp = this.ctx.timeline?.player.time() ?? 0; return act === 't0play' ? this.setTimes(sid, tp, null) : this.setTimes(sid, null, tp); }
        if (act === 'sknew') return this.openSketchFor(sid, null);
        if (act === 'skpaste') return this.pasteSketch(sid);
        if (skId && act === 'skedit') return this.openSketchFor(sid, skId);
        if (skId && act === 'skwin') return this.openSketchFor(sid, skId, { window: true });
        if (skId && act === 'skcopy') return this.copySketch(skId);
        if (skId && act === 'skrm') { if (this.sk?.id === skId) await this.closeSketch(); return this.edit(() => { const s = this.scene(sid); s.sketches = s.sketches.filter(k => k !== skId); }); }
        if (skId && !t.closest('[data-a]')) return this.openSketchFor(sid, skId);
      }
      const side = t.closest('[data-side]'); if (side) return this.setSide(side.dataset.side);
      const ab = t.closest('[data-ab]'); if (ab) { const v = ab.closest('[data-v]').dataset.v; this.ab[ab.dataset.ab] = this.ab[ab.dataset.ab] === v ? null : v; return this.renderSide(); }
      const vrow = t.closest('.lyv[data-v]');
      if (vrow) { const i = this.doc.versions.findIndex(v => v.id === vrow.dataset.v); const prev = this.doc.versions[i - 1]; this.compare = prev ? { a: prev.id, b: vrow.dataset.v } : { a: vrow.dataset.v, b: this.doc.current }; return this.render(); }
      const go = t.closest('[data-go]'); if (go?.dataset.go) { this.compare = null; this.flash = go.dataset.go; this.setOpen(go.dataset.go); return this.render(); }
    });
    // field edits: text as you type (no re-render), times / title on change
    el.addEventListener('input', (e) => {
      const t = e.target, sid = t.closest('.scrow')?.dataset.scene, s = sid && this.scene(sid); if (!s) return;
      if (t.matches('.scin-text')) this.edit(() => { s.text = t.value; }, { render: false });
      else if (t.matches('.scin-title')) this.edit(() => { s.title = t.value; }, { render: false });
      else if (t.matches('.scin-btx')) { const b = s.beats.find(x => x.id === t.closest('[data-beat]').dataset.beat); if (b) this.edit(() => { b.text = t.value; }, { render: false }); }
    });
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('.scsnap')) { this.snap = t.value; prefs.set('scriptSnap', t.value); return this.renderList(); }
      if (t.matches('.scflt')) { this.filter = t.value; return this.renderSide(); }
      if (t.matches('.scscope')) { this.scope = t.value; return this.renderSide(); }
      if (t.matches('.scq textarea')) { const k = t.closest('[data-q]').dataset.q; if ((this.doc.intake[k]?.text || '') !== t.value) this.setAnswer(k, t.value.trim()); return; }
      const sid = t.closest('.scrow')?.dataset.scene, s = sid && this.scene(sid); if (!s) return;
      if (t.matches('.scin-t0, .scin-t1')) { const v = parseT(t.value); if (v == null) { toast('time: m:ss.mmm or seconds'); return this.render(); } return t.matches('.scin-t0') ? this.setTimes(sid, v, null) : this.setTimes(sid, null, v); }
      if (t.matches('.scin-bt')) {
        const b = s.beats.find(x => x.id === t.closest('[data-beat]').dataset.beat), v = parseT(t.value);
        if (!b || v == null) { toast('time: m:ss.mmm or seconds'); return this.render(); }
        return this.edit(() => { b.t = Math.max(s.t0, Math.min(s.t1, v)); s.beats.sort((x, y) => x.t - y.t); });
      }
    });
    el.addEventListener('focusout', () => setTimeout(() => { if (this.pending && !this.typing()) this.render(); }, 0));
    el.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t.closest('.sk')) return;
      if (t.matches('.lyrep')) { e.stopPropagation(); if (e.key === 'Enter' && t.value.trim()) { this.reply(t.closest('[data-note]').dataset.note, t.value.trim()); t.value = ''; } if (e.key === 'Escape') t.blur(); return; }
      if (t.matches('.lyask textarea')) { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.ask(); } return; }
      if (t.matches('.lymsg')) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); this.save(); } return; }
      if (t.matches('input, textarea, select')) {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); t.blur(); this.save(); }
        else if (e.key === 'Enter' && t.matches('input')) { e.preventDefault(); t.blur(); }
        else if (e.key === 'Escape') { t.blur(); }
        return;
      }
      if (e.key === 'Escape' && this.open) { e.stopPropagation(); this.setOpen(null); this.render(); }
    });
    el.addEventListener('mouseover', (e) => {
      const n = e.target.closest('.lynote'); for (const x of this.el.querySelectorAll('.scrow.hl')) x.classList.remove('hl');
      if (n?.dataset.scene) this.el.querySelector(`.scrow[data-scene="${CSS.escape(n.dataset.scene)}"]`)?.classList.add('hl');
    });
  }
}

// ------------------------------------------------------------------ commands (registered at load: core/rail.js imports this module)
const V = () => visible() && !!S;
const sceneOf = (c) => c?.sceneId || S?.open || null;
const ensure = async () => { if (!visible()) await WB().stages.open('script'); return S; };
commands.register([
  { id: 'script.save', group: 'Script', title: 'Save script version', when: () => V() && S.dirty, run: () => S.save() },
  { id: 'script.discard', group: 'Script', title: 'Discard unsaved script edits', when: () => V() && S.dirty, run: () => S.discard() },
  { id: 'script.addScene', group: 'Script', title: 'Add a scene (first gap)', run: async () => (await ensure())?.addScene() },
  { id: 'script.fillGaps', group: 'Script', title: 'Fill the gaps: ask the agent to script the unscripted ranges', run: async () => (await ensure())?.fillGaps() },
  { id: 'script.compare', group: 'Script', title: 'Compare script versions…', when: () => !!store.scenes?.versions?.length, run: async () => {
    await ensure();
    const vs = [...store.scenes.versions].reverse().map(v => ({ label: v.id, detail: `${v.message || ''} ${v.created ? v.created.replace('T', ' ') : ''}`, value: v.id }));
    const a = await ui.pick({ title: 'Compare: older version (A)', items: vs }); if (!a) return;
    const b = await ui.pick({ title: `Compare ${a} with (B)`, items: [{ label: 'your unsaved edits', detail: 'draft', value: 'draft' }, ...vs.filter(v => v.value !== a)] }); if (!b) return;
    S.compare = { a, b }; S.render();
  } },
  { id: 'script.intake', group: 'Script', title: 'Script intake questions', run: async () => { (await ensure())?.setSide('intake'); S?.$('.scq:not(.done) textarea')?.focus(); } },
  { id: 'script.ask', group: 'Script', title: 'Ask the agent about the script…', run: async () => { (await ensure())?.setSide('notes'); S?.$('.lyask textarea')?.focus(); } },
  { id: 'script.note', group: 'Script', title: 'Note on the open scene', when: (c) => V() && !!sceneOf(c), run: (c) => S.noteOnScene(sceneOf(c)) },
  { id: 'script.openScene', group: 'Script', title: 'Open scene…', hidden: false, run: async (c) => {
    await ensure();
    const id = c?.sceneId || await ui.pick({ title: 'Open scene', items: S.draft.map(s => ({ label: `${s.id} ${s.title || ''}`, detail: SC.span(s.t0, s.t1), value: s.id })) });
    if (id) S.focus(id);
  } },
  { id: 'script.newSketch', group: 'Script', title: 'New sketch for the open scene', when: (c) => V() && !!sceneOf(c), run: (c) => S.openSketchFor(sceneOf(c), null) },
  { id: 'script.pasteSketch', group: 'Script', title: 'Paste the copied sketch into the open scene', when: (c) => V() && !!sceneOf(c), run: (c) => S.pasteSketch(sceneOf(c)) },
  { id: 'script.deleteScene', group: 'Script', title: 'Remove the scene from the draft', when: (c) => V() && !!sceneOf(c), run: (c) => S.deleteScene(sceneOf(c)) },
  { id: 'script.sceneOk', group: 'Script', title: 'Mark the scene ok', when: (c) => V() && !!sceneOf(c) && SC.sceneStatus(store.scenes, sceneOf(c)) !== 'ok', run: (c) => S.setStatus(sceneOf(c), 'ok') },
  { id: 'script.sceneNeedsYou', group: 'Script', title: 'Flag the scene: needs you', hidden: true, when: (c) => V() && !!sceneOf(c), run: (c) => S.setStatus(sceneOf(c), 'needs_you') },
]);
// Ctrl+Enter / Alt+N: the rail's stage.save / stage.note ask the visible stage (core/rail.js)
window.WB = Object.assign(window.WB || {}, { stageActions: { ...(window.WB?.stageActions || {}), script: { canSave: () => V() && S.dirty, save: () => S.save(), canNote: () => V() && !!S.open, note: () => S.noteOnScene() } } });
menus.contribute('scene', ['script.openScene', 'script.note', 'script.newSketch', 'script.pasteSketch', '-', 'script.sceneOk', 'script.sceneNeedsYou', 'script.deleteScene']);

export default {
  mount(el, ctx) { S = new Workspace(el, ctx); window.WB.script = { focus: (id) => S.focus(id), get ws() { return S; } }; },
  show() { if (S && !S.typing()) S.render(); },
  get ws() { return S; },
};
