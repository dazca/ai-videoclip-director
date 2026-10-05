// Data store: loads the project files, saves the writable ones through the server, listens for file changes.
// Writable (shared with the agent, each {rev, ...}): approvals.json, notes.json, requests.json, overrides.json, settings.json,
// lyrics.json, stages.json (the guided flow: js/flow.js), scenes.json (stage 2, the script draft: js/scenes.js), breakdown.json
// (stage 3: js/breakdown.js), storyboard.json (stage 6: js/storyboard.js; its shots are what the timeline shots column
// shows); a missing guided-flow file reads as derived from the other files.
// Every page edit goes through store.mutate(), which records an undo step (core/history.js) unless {record:false}.
// the server redirects a bare / to ?project=<its default project>
// same id rule as the server (lib/store.mjs validId); anything else falls back to the demo
import { normLyrics, normStages, projectFacts } from './flow.js';
import { normScenes } from './scenes.js';
import { normBreakdown } from './breakdown.js';
import { normBoard, boardShots } from './storyboard.js';
const QP = new URLSearchParams(location.search).get('project');
export const PROJECT = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(QP || '') ? QP : 'demo';
export const DATA = `data/${PROJECT}/`;
export const api = (p) => `${p}${p.includes('?') ? '&' : '?'}project=${encodeURIComponent(PROJECT)}`;
// HTML escape for every project value put into innerHTML (attributes included)
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
// every page write to the server goes through here (the one place to attach auth headers)
export const postJSON = (path, body) => fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// server config (GET /api/config, read at boot): the media roots and the PRIVATE path rule of this machine
export const config = { media_roots: [], default_project: null };
// a path under one of the configured media roots is base-relative (served at /media/<path>); anything else is
// relative to the project's data folder
export function mediaUrl(p) {
  if (!p) return '';
  const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
  if (config.media_roots.some(r => p === r || p.startsWith(r.replace(/\/?$/, '/')))) return '/media/' + enc(p);
  if (/^(https?:|data:|blob:|\/)/.test(p)) return p;
  return DATA + enc(p);
}

async function getJSON(name, dflt) {
  const r = await fetch(DATA + name, { cache: 'no-cache' });
  if (!r.ok) { if (dflt !== undefined) return structuredClone(dflt); throw new Error(`${name}: ${r.status}`); }
  const j = await r.json();
  return j == null && dflt !== undefined ? structuredClone(dflt) : j;
}

function b64ToInt8(s) { const bin = atob(s); const a = new Int8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = (bin.charCodeAt(i) << 24) >> 24; return a; }

// file -> store field, and the default content when the file does not exist yet
export const WRITABLE = {
  'approvals.json': ['approvals', { rev: 0, states: ['draft', 'review', 'changes', 'approved', 'locked', 'archived'], items: {} }],
  'notes.json': ['notes', { rev: 0, notes: [] }],
  'requests.json': ['requests', { rev: 0, items: [] }],
  'overrides.json': ['overrides', { rev: 0, sections: {} }],
  'settings.json': ['settings', { rev: 0, keybindings: {} }],
  'lyrics.json': ['lyrics', null],
  'stages.json': ['stages', null],
  'scenes.json': ['scenes', null],
  'breakdown.json': ['breakdown', null],
  'storyboard.json': ['board', null],
};
// derived defaults of the guided-flow files (need the song / entities, so they run after those are loaded)
const NORM = {
  'lyrics.json': (s, v) => normLyrics(v, s.song, Object.fromEntries(Object.entries(s.overrides?.sections || {}).filter(([, x]) => x?.label).map(([k, x]) => [k, x.label]))),
  'scenes.json': (s, v) => normScenes(v, s.song, s.script),
  'breakdown.json': (s, v) => normBreakdown(v),
  'storyboard.json': (s, v) => normBoard(v, { shots: s.shots }, s.scenes),
  'stages.json': (s, v) => normStages(v, projectFacts({ song: s.song, script: s.script, shots: s.shots, entities: s.entities, lyrics: s.lyrics, scenes: s.scenes, breakdown: s.breakdown, storyboard: s.board })),
};
const FULL = /^(song|events|energy|script|shots|costs|media)\.json$|^entities\//;
// PRIVATE files (e.g. crops of real photos): shown only in the local page (lock badge), never exported (see
// core/projects.js exporter). Always thumbs/priv_* and any path with a private/ folder, plus the server's private_media rule.
export let PRIVATE_RE = /(^|\/)thumbs\/priv_|(^|\/)private\//;
export const isPrivatePath = (p) => typeof p === 'string' && PRIVATE_RE.test(p);
const nowIso = () => new Date().toISOString().slice(0, 19);

export const store = {
  project: PROJECT,
  song: null, events: null, energy: null, script: null, shots: null, uses: null, costs: null,
  notes: null, approvals: null, requests: null, overrides: null, settings: null, entities: [], media: [], mediaById: {}, mediaByPath: {}, peaks: {},
  listeners: new Set(),
  onMutate: null,                 // set by core/history.js: (entry) => void
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  // iterate a copy: a listener may unsubscribe and subscribe again (the timeline rebuilds on "all"); iterating the live
  // Set would visit the new subscription and rebuild forever
  emit(what) { for (const fn of [...this.listeners]) fn(what); },

  async loadAll() {
    try { const r = await fetch('/api/config', { cache: 'no-cache' }); if (r.ok) { Object.assign(config, await r.json()); if (config.private_re) PRIVATE_RE = new RegExp(config.private_re, 'i'); } } catch (e) { /* static hosting */ }
    const [song, events, energy, script, shots, costs, index] = await Promise.all(
      ['song.json', 'events.json', 'energy.json', 'script.json', 'shots.json', 'costs.json', 'entities/index.json'].map(f => getJSON(f)));
    Object.assign(this, { song, events, energy, script, shots: shots.shots, uses: shots.uses, costs });
    await Promise.all(Object.entries(WRITABLE).map(async ([f, [field, d]]) => {
      const v = await getJSON(f, d);
      if (this._saving[f]) this._missed.add(f); else this[field] = v;   // a save is in flight: re-read it after
    }));
    this.entities = await Promise.all(index.map(e => getJSON(e.path)));
    for (const f of ['lyrics.json', 'scenes.json', 'breakdown.json', 'storyboard.json', 'stages.json']) this[WRITABLE[f][0]] = NORM[f](this, this[WRITABLE[f][0]]);
    this.entityById = Object.fromEntries(this.entities.map(e => [e.id, e]));
    this.media = (await getJSON('media.json', { items: [] })).items || [];
    this.mediaById = Object.fromEntries(this.media.map(m => [m.id, m]));
    this.mediaByPath = Object.fromEntries(this.media.map(m => [m.path, m]));
    if (song.audio?.mix) await this.loadPeaks(['mix']);
  },
  async loadPeaks(ids) {
    await Promise.all(ids.filter(id => !this.peaks[id]).map(async id => {
      const p = await getJSON(`peaks/${id}.json`, null);
      if (p) this.peaks[id] = { binMs: p.bin_ms, n: p.n, min: b64ToInt8(p.min), max: b64ToInt8(p.max), levels: null };
    }));
  },
  // a file can be caught mid-write (Windows falls back to an in-place copy when a reader holds it): retry
  async reload(files, retry = 2) {
    try { await this._reload(files); } catch (e) { if (retry) { await new Promise(r => setTimeout(r, 250)); return this.reload(files, retry - 1); } console.warn('reload failed', files, e); }
  },
  async _reload(files) {
    if (files.includes('*')) files = [...files.filter(f => f !== '*'), ...Object.keys(WRITABLE)];   // unknown change: re-check the shared state
    if (files.some(f => FULL.test(f))) { await this.loadAll(); this.emit('all'); return; }
    for (const file of files) {
      // our own saves come back here too: apply only when the file differs from what the page has (agent edit, restore)
      // while a page save of that file is in flight the fetched copy may predate it: re-read once the save settles
      if (WRITABLE[file]) { const [field, d] = WRITABLE[file]; let v = await getJSON(file, d); if (NORM[file]) v = NORM[file](this, v); if (this._saving[file]) { this._missed.add(file); continue; } if (JSON.stringify(v) !== JSON.stringify(this[field])) { this[field] = v; this.emit(field); } }
      else if (/^peaks\//.test(file)) { const id = file.slice(6, -5); delete this.peaks[id]; await this.loadPeaks([id]); this.emit('peaks'); }
    }
    // a storyboard still derived from shots.json places its shots in the scenes: follow a new script
    if (files.includes('scenes.json') && this.board?.derived) { const b = NORM['storyboard.json'](this, null); b.rev = this.board.rev; if (JSON.stringify(b) !== JSON.stringify(this.board)) { this.board = b; this.emit('board'); } }
  },
  listen() {
    try {
      const es = new EventSource(api('/api/events'));
      let pending = new Set(), timer = 0, opened = false;
      // after a reconnect (server restart) re-read everything: changes made while disconnected sent no event
      es.onopen = () => { if (opened) this.reload(['song.json']); opened = true; };
      es.onmessage = (ev) => {
        const { project, file, ui } = JSON.parse(ev.data);
        if (project !== PROJECT && project !== '*') return;
        if (ui) { document.dispatchEvent(new CustomEvent('wb:ui', { detail: ui })); return; }   // live UI channel (an agent's ui_focus)
        pending.add(file); clearTimeout(timer);
        timer = setTimeout(() => { const f = [...pending]; pending = new Set(); this.reload(f); }, 150);   // a restore touches many files: one reload
      };
    } catch (e) { /* static hosting: no live updates */ }
  },

  // ---- the storyboard's shots (storyboard.json, else shots.json): the timeline shots / cast / status columns
  boardShots() { return this.board ? boardShots(this.board) : [...(this.shots || [])]; },
  // ---- approvals
  state(key) { return this.approvals?.items[key]?.state || 'draft'; },
  setState(key, state, comment) { return this.setStates([key], state, comment); },
  setStates(keys, state, comment) {
    return this.mutate('approvals.json', (d) => {
      for (const key of keys) d.items[key] = { ...(d.items[key] || {}), state, by: 'director', at: nowIso(), ...(comment ? { comment } : {}) };
    }, { label: `${state} ${keys.length === 1 ? keys[0] : keys.length + ' items'}` });
  },
  // click on a chip: draft/review -> approved -> changes -> draft; locked (or an unknown state) does not move
  cycle(key) {
    const next = { draft: 'approved', review: 'approved', approved: 'changes', changes: 'draft' }[this.state(key)];
    if (!next) { toast(`${key} is ${this.state(key)}: not changed by a click`); return Promise.resolve(); }
    return this.setState(key, next);
  },
  // ---- notes
  addNote(t, text, line_id, extra) {
    return this.mutate('notes.json', (d) => {
      const n = d.notes.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, '')) || 0), 0) + 1;
      d.notes.push({ id: `n${String(n).padStart(2, '0')}`, t: Math.round(t), line_id: line_id || null, by: 'director', text, status: 'open', at: nowIso(), ...(extra || {}) });
      d.notes.sort((a, b) => a.t - b.t);
    }, { label: 'add note' });
  },
  toggleNote(id) {
    return this.mutate('notes.json', (d) => { const x = d.notes.find(n => n.id === id); if (x) x.status = x.status === 'open' ? 'resolved' : 'open'; }, { label: 'toggle note ' + id });
  },
  editNote(id, text) { return this.mutate('notes.json', (d) => { const x = d.notes.find(n => n.id === id); if (x) x.text = text; }, { label: 'edit note ' + id }); },
  deleteNotes(ids) { return this.mutate('notes.json', (d) => { d.notes = d.notes.filter(n => !ids.includes(n.id)); }, { label: `delete ${ids.length} note(s)` }); },
  // ---- generation requests (the page never calls paid APIs; the agent picks up approved ones)
  addRequest(r) {
    const id = `r${Date.now().toString(36)}`;
    const item = { id, kind: r.kind, target: r.target || null, prompt: r.prompt || '', refs: r.refs || [], est_cost: r.est_cost ?? 0, status: 'draft', by: 'director', at: nowIso(), ...(r.extra || {}) };
    return this.mutate('requests.json', (d) => { d.items.push(item); }, { label: `request ${r.kind}` }).then(() => item);
  },
  setRequest(id, patch) { return this.mutate('requests.json', (d) => { const x = d.items.find(i => i.id === id); if (x) Object.assign(x, patch, { at: nowIso() }); }, { label: `request ${id} ${patch.status || 'edit'}` }); },
  deleteRequests(ids) { return this.mutate('requests.json', (d) => { d.items = d.items.filter(i => !ids.includes(i.id)); }, { label: `delete ${ids.length} request(s)` }); },
  // ---- section overrides (label, colour); song.json stays the importer's
  secLabel(s) { return this.overrides?.sections?.[s.id]?.label || s.label; },
  setSection(id, patch) { return this.mutate('overrides.json', (d) => { d.sections ||= {}; d.sections[id] = { ...(d.sections[id] || {}), ...patch }; }, { label: `section ${id}` }); },
  // ---- settings (keybindings); not undoable
  setSettings(fn) { return this.mutate('settings.json', fn, { record: false }); },

  // optimistic local change, then POST with base_rev; on conflict re-apply the change on the server copy once
  async mutate(file, fn, { label = file, record = true } = {}) {
    const field = WRITABLE[file][0];
    const before = this[field];
    const local = structuredClone(before); fn(local); if (local && typeof local === 'object') delete local.derived;
    const base = before.rev || 0;
    this[field] = local; this.emit(field);
    if (record) this.onMutate?.({ file, field, label, before, after: local });
    this._saving[file] = (this._saving[file] || 0) + 1;
    let saved = local;
    try {
      let r = await postJSON('/api/save/' + file, { base_rev: base, data: local });
      if (r.status === 409) {
        const server = NORM[file] ? NORM[file](this, await r.json()) : await r.json(), cur = structuredClone(server); fn(cur); delete cur.derived;
        r = await postJSON('/api/save/' + file, { base_rev: cur.rev || 0, data: cur });
        this[field] = r.ok ? cur : server;      // a failed retry shows the server copy, not the unsaved change
        saved = cur;
      }
      if (!r.ok) throw new Error(await r.text());
      const rev = (await r.json()).rev;
      // adopt the new rev only on the object that was saved; anything else here (a later edit, a reload) is re-read
      if (this[field] === saved) saved.rev = rev; else this._missed.add(file);
    } catch (e) { console.warn('save failed', file, e); toast(`not saved: ${file} (${e.message || e})`); this._missed.add(file); }
    finally {
      if (!--this._saving[file] && this._missed.delete(file)) this.reload([file]);
      this.emit(field);
    }
  },
  _saving: {},            // file -> saves in flight
  _missed: new Set(),     // files whose reload was skipped (or whose save failed) while a save was in flight
};

// toasts stack in one bottom-centre column (newest at the bottom, at most 4); the same message again restarts its timer
// instead of drawing a second copy on top of the first
export function toast(msg) {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  let el = [...box.children].find(x => x.textContent === String(msg));
  if (el) el.remove(); else { el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; }
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  clearTimeout(el._t); el._t = setTimeout(() => el.remove(), 3000);
}

// localStorage, wrapped (private windows / blocked storage must not break the page)
export const prefs = {
  get(k, d) { try { const v = localStorage.getItem('wb:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('wb:' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};
