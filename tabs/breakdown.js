// Stage 3 workspace: the breakdown (docs/SPEC_v3_GUIDED.md). The characters, locations, props, wardrobe and FX the
// script needs, each linked to the scenes (and beats) that need it. Two views of the same list: a LIST grouped by kind
// (click a row to edit it in place: name, kind, description, the scenes and beats it is linked to with a note each)
// and a MATRIX, items x scenes, where a click on a cell links / unlinks. Director tools: merge, rename, drop (soft,
// restorable), split, change kind, link / unlink; "Suggest from script" (a deterministic pre-pass over the scene text,
// beats and the intake answers who / where) and "Ask the agent to extract" (a note the agent reads with breakdown_get).
// Edits collect in a draft (kept in this browser) until "Save version" (Ctrl+Enter); item statuses (draft / review / ok)
// are saved at once. "Create entity" turns a character / location / prop item into an entity (Assets) and a wardrobe
// item into a look on a character: page only, nothing is generated or spent. The Notes column (core/notescol.js) on the
// right is row-aligned with the items (list and matrix); notes on a scene or the whole breakdown sit in its top row.
// Right-click: + Add › item (by kind) / note (undoable). Format: js/breakdown.js, js/notes.js.
import { store, prefs, toast, esc, PROJECT, postJSON } from '../js/store.js';
import { commands } from '../core/commands.js';
import { menus } from '../core/menus.js';
import { ui } from '../core/palette.js';
import * as F from '../js/flow.js';
import * as SC from '../js/scenes.js';
import * as BD from '../js/breakdown.js';
import { NotesColumn } from '../core/notescol.js';
import { TimeAxis, isTime, setMode } from '../core/timemode.js';
import { history } from '../core/history.js';

const WB = () => window.WB;
const visible = () => WB()?.app?.active() === 'stage' && WB().stages?.current() === 'breakdown';
const nowIso = () => new Date().toISOString().slice(0, 19);
const DKEY = 'bdDraft:' + PROJECT;
const when = (at) => at ? esc(String(at).replace('T', ' ').slice(5, 16)) : '';
const who = (x) => x.via === 'agent' ? `<span class="who ag" title="written through the agent tools">${esc(x.by && x.by !== 'agent' ? x.by + ' · agent' : 'agent')}</span>` : `<span class="who dr">${esc(x.by === 'import' ? 'import' : 'director')}</span>`;
const dot = (k) => `<i class="bdk k-${k}" title="${esc(BD.KIND_ONE[k])}"></i>`;
const ST_LABEL = { draft: 'draft', review: 'review', ok: 'ok' };
let S = null;

class Workspace {
  constructor(el, ctx) {
    this.el = el; this.ctx = ctx;
    this.view = prefs.get('bdView', 'list'); this.side = prefs.get('bdSide', null) === 'versions' ? 'versions' : null; this.kind = 'all'; this.scene = null; this.showDropped = prefs.get('bdDropped', true);
    this.filter = 'open'; this.open = null; this.sel = new Set(); this.compare = null; this.ab = { a: null, b: null }; this.pending = false; this.fresh = new Set();
    el.classList.add('bdws');
    el.innerHTML = `<div class="bdmain"><div class="lybar bdbar"></div><div class="bdsel"></div><div class="bdbody" tabindex="-1"></div></div>
      <div class="lyside bdside"><div class="lytabs"><a data-side="versions">Versions</a><span class="sp"></span><a data-a="closeside" title="close the versions panel">×</a></div><div class="lylist"></div></div>`;
    this.$ = (s) => el.querySelector(s);
    this.loadDraft();
    this.wire();
    // the Notes column: one row per item (with its editor when open; in the matrix, per row); scene notes in the top row
    const itemT = (id) => ({ stage: 'breakdown', kind: 'item', id });
    this.nc = new NotesColumn({ stage: 'breakdown', scroller: this.$('.bdbody'), active: () => !this.compare, fixed: () => !!this.ta?.on,
      top: () => ({ label: 'notes on the whole breakdown (and on scenes)', targets: [{ stage: 'breakdown', kind: 'stage', id: null }, ...(this.scene ? [{ stage: 'breakdown', kind: 'scene', id: this.scene }] : [])],
        match: (n) => n.target.kind === 'stage' || n.target.kind === 'scene', sub: (n) => n.target.kind === 'scene' ? n.target.id : '' }),
      rows: () => this.ta?.on ? [...this.el.querySelectorAll('.bdbody .bdtmr[data-scene]')].map(e => ({ el: e, targets: [{ stage: 'breakdown', kind: 'scene', id: e.dataset.scene }] }))
        : [...this.el.querySelectorAll('.bdbody .bdrow[data-item], .bdbody tr.bdmxr[data-item]')].map(e => {
        const ed = e.nextElementSibling?.matches('.bded') ? e.nextElementSibling : null;
        return { ...(ed ? { els: [e, ed] } : { el: e }), targets: [itemT(e.dataset.item)] }; }),
      current: () => this.open && this.item(this.open) ? itemT(this.open) : this.scene ? { stage: 'breakdown', kind: 'scene', id: this.scene } : null });
    // Time view (core/timemode.js): the matrix turned on its side, one row per scene on the timeline's axis (ordered and
    // sized by time), one narrow column per item
    this.ta = new TimeAxis({ stage: 'breakdown', scroller: this.$('.bdbody'), nc: this.nc, onApply: () => this.nc.schedule('place'), noSeek: '.bdtc, .bdtml, .bdtmh',
      rows: () => this.compare ? [] : [...this.el.querySelectorAll('.bdbody .bdtmr[data-scene]')].map(e => { const s = this.scenes.find(x => x.id === e.dataset.scene); return s ? { el: e, t0: s.t0, t1: s.t1 } : null; }).filter(Boolean) });
    document.addEventListener('wb:timemode', (e) => { if (e.detail.stage === 'breakdown' && !this.typing()) this.render(); });
    store.on((w) => { if (['breakdown', 'scenes', 'all'].includes(w)) { if (this.typing()) this.pending = true; else this.render(); } });
    this.render();
  }
  // a draft edit from "+ Add" (an item) and the other structural edits: one undo step (Ctrl+Z puts the draft back)
  undoable(label, fn) {
    const before = structuredClone(this.draft); const r = fn(); const after = structuredClone(this.draft);
    if (JSON.stringify(before) !== JSON.stringify(after)) history.push({ label, undo: () => this.setDraft(before), redo: () => this.setDraft(after) });
    return r;
  }
  setDraft(d) { this.draft = structuredClone(d); this.saveDraft(); this.render(); }
  get doc() { return store.breakdown; }
  get cur() { return BD.currentBreakdown(this.doc); }
  get scenes() { return SC.currentScript(store.scenes)?.scenes || []; }
  typing() { const a = document.activeElement; return !!a && this.el.contains(a) && a.matches('input, textarea, select'); }
  // ---------------------------------------------------------------- the draft (unsaved edits, kept per project in this browser)
  loadDraft() {
    const d = prefs.get(DKEY, null);
    this.draft = d && d.base === (this.doc?.current || null) && Array.isArray(d.items) ? d.items : structuredClone(this.cur?.items || []);
    this.base = this.doc?.current || null;
  }
  syncBase() {
    if (this.base === (this.doc?.current || null) || this.busy) return;
    const was = this.doc?.versions.find(x => x.id === this.base);
    if (BD.sameItems(this.draft, was?.items || [])) this.draft = structuredClone(this.cur?.items || []);
    else toast(`breakdown: a new version (${this.doc.current}) arrived while you have unsaved edits; save makes yours the next version`);
    this.base = this.doc?.current || null; this.saveDraft();
  }
  get dirty() { return !BD.sameItems(this.draft, this.cur?.items || []); }
  saveDraft() { if (this.dirty) prefs.set(DKEY, { base: this.base, items: this.draft }); else prefs.set(DKEY, null); }
  item(id) { return this.draft.find(i => i.id === id) || null; }
  edit(fn, { render = true } = {}) {
    fn(this.draft);
    for (const i of this.draft) BD.sortLinks(i, this.scenes);
    this.saveDraft();
    if (render) this.render(); else this.renderBar();
  }
  newId() { return BD.nextItemId(this.doc, this.draft); }
  // ---------------------------------------------------------------- saving
  async save(message) {
    if (!this.dirty) return toast('breakdown: nothing to save');
    if (message == null) message = this.$('.bdbar .lymsg')?.value.trim() || '';
    let body;
    try { body = this.draft.map(i => BD.cleanItem(i)); BD.checkBreakdown({ versions: [{ id: 'x', items: body }], current: 'x' }); } catch (e) { return toast('not saved: ' + e.message); }
    let id = null; this.busy = true;
    try { await store.mutate('breakdown.json', (d) => { id = BD.addBreakdownVersion(d, body, { by: 'director', via: 'page', message, script: store.scenes?.current || undefined }).id; }, { label: 'save breakdown version' }); } finally { this.busy = false; }
    this.base = this.doc.current; this.draft = structuredClone(this.cur?.items || []); this.fresh.clear(); this.saveDraft();
    toast(`breakdown saved as ${id}`);
    this.render();
  }
  discard() { this.draft = structuredClone(this.cur?.items || []); this.fresh.clear(); this.saveDraft(); this.render(); }
  restore(id) {
    const v = this.doc.versions.find(x => x.id === id); if (!v) return;
    this.busy = true;
    return store.mutate('breakdown.json', (d) => { BD.addBreakdownVersion(d, v.items, { by: 'director', via: 'page', message: `restore ${id}`, from: id, script: v.script }); }, { label: `restore breakdown ${id}` })
      .finally(() => { this.busy = false; }).then(() => { this.base = this.doc.current; this.draft = structuredClone(this.cur.items); this.saveDraft(); this.compare = null; toast(`restored ${id} as ${this.doc.current}`); this.render(); });
  }
  // ---------------------------------------------------------------- items
  targets(c) { const id = c?.itemId || this.open; return this.sel.size && (!id || this.sel.has(id)) ? [...this.sel] : id ? [id] : []; }
  focus(id) { this.compare = null; this.open = id; this.sel = new Set([id]); if (this.kind !== 'all' && this.item(id)?.kind !== this.kind) this.kind = 'all'; this.render(); this.el.querySelector(`.bdrow[data-item="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }); }
  async addItem(kind, scene) {
    kind ||= this.kind !== 'all' ? this.kind : await ui.pick({ title: 'New item: kind', items: BD.KINDS.map(k => ({ label: BD.KIND_ONE[k], value: k })) });
    if (!kind) return;
    const name = await ui.prompt({ title: `New ${BD.KIND_ONE[kind]}: name`, placeholder: 'name (Enter adds)' }); if (!name?.trim()) return;
    const id = this.newId(), sc = scene || this.scene;
    this.undoable(`add ${BD.KIND_ONE[kind]} ${id}`, () => this.edit((d) => { d.push({ id, kind, name: name.trim(), description: '', links: sc ? [{ scene: sc, beats: [] }] : [], source: 'director' }); }, { render: false }));
    this.fresh.add(id); this.view = this.view === 'matrix' ? 'matrix' : 'list'; this.focus(id);
    return id;
  }
  async rename(id) {
    const it = this.item(id); if (!it) return;
    const name = await ui.prompt({ title: `Rename ${it.id} “${it.name}”`, value: it.name }); if (!name?.trim() || name.trim() === it.name) return;
    this.edit(() => { it.aliases = [...new Set([...(it.aliases || []), it.name])].filter(a => a.toLowerCase() !== name.trim().toLowerCase()); if (!it.aliases.length) delete it.aliases; it.name = name.trim(); });
  }
  async setKind(ids) {
    const items = ids.map(i => this.item(i)).filter(Boolean); if (!items.length) return;
    const k = await ui.pick({ title: `Change kind of ${items.length > 1 ? items.length + ' items' : '“' + items[0].name + '”'}`, items: BD.KINDS.map(x => ({ label: BD.KIND_ONE[x], value: x })) }); if (!k) return;
    if (items.some(i => this.doc.states[i.id]?.entity_id)) return toast('an item made into an entity keeps its kind (unlink the entity first)');
    this.edit(() => { for (const i of items) { i.kind = k; if (k !== 'wardrobe') delete i.for; } });
  }
  drop(ids, on) {
    const items = ids.map(i => this.item(i)).filter(Boolean); if (!items.length) return;
    if (on == null) on = !items.every(i => i.dropped);
    this.undoable(`${on ? 'drop' : 'restore'} ${items.length} item(s)`, () => this.edit(() => { for (const i of items) { if (on) i.dropped = true; else delete i.dropped; } }));
    toast(`${items.length} item${items.length > 1 ? 's' : ''} ${on ? 'dropped (restore: same command)' : 'restored'}`);
  }
  async merge(ids) {
    let items = ids.map(i => this.item(i)).filter(Boolean);
    if (items.length === 1) {
      const other = await ui.pick({ title: `Merge “${items[0].name}” with…`, items: this.draft.filter(i => i.id !== items[0].id).map(i => ({ label: i.name, detail: `${BD.KIND_ONE[i.kind]} · ${i.id}`, value: i.id })) });
      if (!other) return; items.push(this.item(other));
    }
    if (items.length < 2) return toast('select two or more items to merge (Ctrl+click)');
    const linked = items.filter(i => this.doc.states[i.id]?.entity_id);
    if (linked.length > 1) return toast('two of these are already entities: unlink one first');
    const keep = linked[0]?.id || await ui.pick({ title: 'Merge: keep which name (and id)?', items: items.map(i => ({ label: i.name, detail: `${BD.KIND_ONE[i.kind]} · ${i.id} · ${i.links.length} scenes`, value: i.id })) });
    if (!keep) return;
    this.edit((d) => { const out = BD.mergeItems(d, keep, items.map(i => i.id)); d.splice(0, d.length, ...out); });
    this.sel = new Set([keep]); this.open = keep; this.render();
    toast(`merged ${items.length} items into “${this.item(keep).name}” (the others' names are kept as aliases)`);
  }
  async split(id) {
    const it = this.item(id); if (!it) return;
    const name = await ui.prompt({ title: `Split “${it.name}”: name of the new item`, value: `${it.name} (2)` }); if (!name?.trim()) return;
    const sc = it.links.length > 1 ? await ui.prompt({ title: `Scenes that go to “${name.trim()}” (the rest stay with “${it.name}”; empty = a copy with all)`, value: it.links.map(l => l.scene).join(' ') }) : '';
    if (sc == null) return;
    const move = String(sc).split(/[\s,]+/).filter(Boolean), nid = this.newId();
    if (move.length === it.links.length) move.length = 0;
    this.edit((d) => { const out = BD.splitItem(d, id, nid, name.trim(), move); d.splice(0, d.length, ...out); });
    this.fresh.add(nid); this.focus(nid);
  }
  toggle(id, scene) {
    const it = this.item(id); if (!it) return;
    let on; this.edit(() => { on = BD.toggleLink(it, scene); });
    return on;
  }
  setStatus(ids, status) {
    return store.mutate('breakdown.json', (d) => { for (const id of ids) d.states[id] = { ...(d.states[id] || {}), status, by: 'director', via: 'page', at: nowIso() }; }, { label: `item status ${status}` })
      .then(() => toast(`${ids.length > 1 ? ids.length + ' items' : ids[0]}: ${status}`));
  }
  // ---------------------------------------------------------------- suggest, ask, notes
  suggest() {
    const sc = this.scenes; if (!sc.length) return toast('no script yet: write scenes in the Script stage first');
    const sugg = BD.suggestItems(sc, store.scenes?.intake || {}, store.entities.map(e => e.name || e.id));
    const r = BD.mergeSuggestions(this.draft, sugg, (list) => BD.nextItemId(this.doc, list));
    if (!r.added.length && !r.updated.length) return toast('nothing new found in the script');
    this.edit((d) => { d.splice(0, d.length, ...r.items); });
    for (const id of [...r.added, ...r.updated]) this.fresh.add(id);
    toast(`suggested from the script: ${r.added.length} new, ${r.updated.length} with more scenes · review, then Save version`);
  }
  // notes (the Notes column, notes.json v2): on an item (saved or not: its id stays), else the scene / the whole breakdown
  noteOnItem(id = this.open) {
    const it = id && this.item(id);
    this.nc.edit(it ? { stage: 'breakdown', kind: 'item', id } : this.scene ? { stage: 'breakdown', kind: 'scene', id: this.scene } : { stage: 'breakdown', kind: 'stage', id: null });
  }
  ask() { const t = this.nc.o.current() || { stage: 'breakdown', kind: 'stage', id: null }; this.nc.edit(t, { to: true }); }
  extract() {
    if (!this.scenes.length) return toast('no script yet: write scenes in the Script stage first');
    if (store.notesOn({ stage: 'breakdown', status: 'open' }).some(n => n.ask === 'extract')) return toast('already asked: the agent has an open "extract" ask');
    const v = store.scenes?.current || 'the current version';
    const text = `Extract the breakdown from script ${v}: every character, location, prop, wardrobe item and FX the scenes need (scene text, beats, sketch pins, the intake). Link each to the scenes and beats that need it, keep what is here (merge duplicates, do not undo my drops), and save it as a new version.`;
    return store.noteAdd({ stage: 'breakdown', kind: 'stage', id: null }, text, { to: 'agent', ask: 'extract', version: this.doc.current }).then(() => toast('asked the agent to extract the breakdown (breakdown_get, breakdown_update)'));
  }
  setSide(s) { this.side = s === 'versions' ? 'versions' : null; prefs.set('bdSide', this.side); this.renderSide(); this.renderBar(); }
  // ---------------------------------------------------------------- entities (page only; nothing generated or spent)
  async promote(id) {
    const it = this.item(id); if (!it) return;
    if (this.dirty || !this.cur?.items.some(i => i.id === id)) return toast('save your edits first (Save version): an entity is made from a saved item');
    if (it.dropped) return toast('restore the item first');
    if (!BD.PROMOTABLE.includes(it.kind)) return toast('FX stays in the breakdown (it becomes shots and requests later)');
    const st = this.doc.states[id];
    if (st?.entity_id) return this.showEntity(st.entity_id);
    const body = { item: id };
    if (it.kind === 'wardrobe') {
      const forEnt = it.for && this.doc.states[it.for]?.entity_id;
      const chars = store.entities.filter(e => e.kind === 'character').sort((a, b) => (b.id === forEnt) - (a.id === forEnt));
      if (!chars.length) return toast('wardrobe becomes a look on a character: make the character an entity first');
      const c = await ui.pick({ title: `“${it.name}” becomes a look on which character?`, items: chars.map(e => ({ label: e.name || e.id, detail: `${e.id}${e.id === forEnt ? ' · the character it is for' : ''} · ${(e.looks || []).length} looks`, value: e.id })) });
      if (!c) return; body.character = c;
    } else {
      const same = (e) => e.kind === it.kind && [it.name, ...(it.aliases || [])].some(n => n.toLowerCase() === String(e.name || '').toLowerCase() || BD.slug(n) === e.id);
      const ents = store.entities.filter(e => e.kind === it.kind).sort((a, b) => same(b) - same(a));
      const pick = await ui.pick({ title: `“${it.name}” → ${BD.KIND_ONE[it.kind]} entity`, items: [
        ...ents.filter(same).map(e => ({ label: `Link to the existing ${BD.KIND_ONE[it.kind]} “${e.name || e.id}”`, detail: e.id, value: 'link:' + e.id })),
        { label: `Create a new ${BD.KIND_ONE[it.kind]} “${it.name}”`, detail: 'a draft entity in Assets: no images, nothing generated or spent', value: 'new' },
        ...ents.filter(e => !same(e)).map(e => ({ label: `Link to “${e.name || e.id}”`, detail: e.id, value: 'link:' + e.id })),
      ] });
      if (!pick) return; if (pick.startsWith('link:')) body.entity_id = pick.slice(5);
    }
    const r = await postJSON('/api/op/breakdown_promote', body), j = await r.json().catch(() => ({}));
    if (!r.ok) return toast('not made: ' + (j.error || r.status));
    toast(j.look_id ? `“${it.name}” is now look ${j.look_id} of ${j.entity_id}` : j.created ? `created ${BD.KIND_ONE[it.kind]} ${j.entity_id} (Assets)` : `linked to ${j.entity_id}`);
  }
  async unlink(id) {
    const st = this.doc.states[id]; if (!st?.entity_id) return;
    if (!(await ui.confirm(`Unlink ${id} from ${st.entity_id}${st.look_id ? ' / ' + st.look_id : ''}? (the entity stays in Assets)`))) return;
    const r = await postJSON('/api/op/breakdown_promote', { item: id, unlink: true }), j = await r.json().catch(() => ({}));
    toast(r.ok ? `${id} unlinked` : 'not unlinked: ' + (j.error || r.status));
  }
  async showEntity(eid) {
    const e = store.entities.find(x => x.id === eid); if (!e) return toast(`no entity ${eid}`);
    await WB().app.show(e.kind === 'character' ? 'characters' : e.kind + 's');
    document.dispatchEvent(new CustomEvent('wb:entity', { detail: eid }));
  }
  // ---------------------------------------------------------------- rendering
  render() {
    this.pending = false;
    if (!this.doc) return;
    this.syncBase();
    for (const id of [...this.sel]) if (!this.item(id)) this.sel.delete(id);
    if (this.open && !this.item(this.open)) this.open = null;
    this.renderBar(); this.renderSel();
    if (this.compare) this.renderDiff(); else if (isTime('breakdown')) this.renderTime(); else if (this.view === 'matrix') this.renderMatrix(); else this.renderList();
    this.renderSide();
    this.ta?.apply();
  }
  shown() {
    return this.draft.filter(i => (this.kind === 'all' || i.kind === this.kind) && (this.showDropped || !i.dropped) && (!this.scene || i.links.some(l => l.scene === this.scene)));
  }
  renderBar() {
    const v = this.cur, live = this.draft.filter(i => !i.dropped), msg = this.$('.bdbar .lymsg')?.value || '';
    const counts = BD.KINDS.map(k => [k, live.filter(i => i.kind === k).length]).filter(([, n]) => n);
    const ver = v ? `<b>${esc(v.id)}</b> <span class="dim">${esc(v.message || '')}${v.created ? ' · ' + when(v.created) : ''} · ${v.via === 'agent' ? 'agent' : esc(v.by || '')}${v.script && v.script !== store.scenes?.current ? ` · <span class="gapc" title="the script changed since this breakdown (made from ${esc(v.script)})">script now ${esc(store.scenes.current)}</span>` : ''}</span>` : '<span class="dim">no version yet</span>';
    const sc = this.scene && this.scenes.find(s => s.id === this.scene);
    this.$('.bdbar').innerHTML = `<span class="bdinfo">${ver}<span class="dim"> · ${counts.map(([k, n]) => `<a data-kind="${k}" title="${n} ${BD.KIND_LABEL[k]} (click: only these)" class="bdcnt${this.kind === k ? ' on' : ''}">${dot(k)}${n}</a>`).join(' ') || '0 items'}</span></span>`
      + (this.scene ? `<span class="bdscf" title="only the items this scene needs">in <b>${esc(this.scene)}</b>${sc?.title ? ' ' + esc(sc.title) : ''} <a data-a="unscene" title="all scenes">×</a></span>` : '') + '<span class="sp"></span>'
      + (this.dirty ? `<span class="unsaved">unsaved edits</span><input class="lymsg" placeholder="what changed (optional)" spellcheck="false" value="${esc(msg)}"><button data-a="save" class="pri" title="Ctrl+Enter: a new version">Save version</button><button data-a="drdiff" title="compare the current version with your edits">diff</button><button data-a="discard">Discard</button>` : '')
      + (isTime('breakdown') ? '' : `<span class="bdvw"><a data-view="list" class="${this.view === 'list' ? 'on' : ''}">List</a><a data-view="matrix" class="${this.view === 'matrix' ? 'on' : ''}" title="items x scenes: click a cell to link / unlink">Matrix</a></span>`)
      + `<select class="bdkind" title="kind">${['all', ...BD.KINDS].map(k => `<option value="${k}"${k === this.kind ? ' selected' : ''}>${k === 'all' ? 'all kinds' : BD.KIND_LABEL[k]}</option>`).join('')}</select>`
      + `<label class="dim" title="show dropped items (greyed; restorable)"><input type="checkbox" class="bddrop"${this.showDropped ? ' checked' : ''}>dropped</label>`
      + `<button data-a="add" title="a new item">+ item</button><button data-a="suggest" title="a first list from the scene text, beats and the intake (who, where): capitalised names, garments, objects, effects">Suggest from script</button><button data-a="versions" class="${this.side === 'versions' ? 'on' : ''}" title="the versions panel: diff any two, restore">Versions ${this.doc.versions.length}</button>`;
  }
  renderSel() {
    const el = this.$('.bdsel'), n = this.sel.size;
    if (n < 2) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    el.innerHTML = `<b>${n} selected</b><a data-a="merge">merge</a><a data-a="kindsel">change kind</a><a data-a="dropsel">drop / restore</a><a data-a="statsel" data-s="review">review</a><a data-a="statsel" data-s="ok">ok</a><span class="sp"></span><a data-a="selnone">clear (Esc)</a>`;
  }
  sceneChip(l) {
    const s = this.scenes.find(x => x.id === l.scene);
    return `<span class="bdsc${s ? '' : ' gone'}${this.scene === l.scene ? ' on' : ''}" data-scene="${esc(l.scene)}" title="${esc(s ? `${s.id} · ${SC.span(s.t0, s.t1)} · ${s.title}` : `${l.scene}: not in the current script`)}${l.beats.length ? esc('\nbeats ' + l.beats.join(', ')) : ''}${l.note ? esc('\n' + l.note) : ''}">${esc(l.scene)}${l.beats.length ? `<sup>${l.beats.length}</sup>` : ''}${l.note ? '*' : ''}</span>`;
  }
  rowHtml(it) {
    const st = this.doc.states[it.id] || {}, status = st.status || 'draft', saved = this.cur?.items.find(x => x.id === it.id), chg = !saved || JSON.stringify(saved) !== JSON.stringify(it);
    const ent = st.entity_id ? `<a class="bdent" data-ent="${esc(st.entity_id)}" title="open the entity in Assets">→ ${esc(store.entities.find(e => e.id === st.entity_id)?.name || st.entity_id)}${st.look_id ? ' / ' + esc(st.look_id) : ''}</a>` : '';
    const forIt = it.kind === 'wardrobe' && it.for ? this.item(it.for) : null;
    const head = `<div class="bdrow k-${it.kind}${it.dropped ? ' dropped' : ''}${this.sel.has(it.id) ? ' sel' : ''}${this.open === it.id ? ' open' : ''}${chg ? ' chg' : ''}${this.fresh.has(it.id) ? ' fresh' : ''}" data-item="${esc(it.id)}">`
      + `${dot(it.kind)}<span class="bdnm" title="${esc(it.id)}${it.aliases?.length ? esc(' · aka ' + it.aliases.join(', ')) : ''}">${esc(it.name)}</span>${it.aliases?.length ? `<span class="dim bdaka">${esc(it.aliases.join(', '))}</span>` : ''}${forIt ? `<span class="dim">for ${esc(forIt.name)}</span>` : ''}`
      + `<span class="bdst s-${status}" title="${status === 'ok' ? 'the director signed it off' : status === 'review' ? (st.via === 'agent' ? 'the agent asks you to look' : 'to review') : 'draft'}"><i></i>${status === 'draft' ? '' : ST_LABEL[status]}</span>${it.source === 'agent' ? '<span class="who ag" title="drafted by the agent">agent</span>' : ''}${ent}`
      + `<span class="bdscs">${it.links.map(l => this.sceneChip(l)).join('') || '<span class="dim">no scenes</span>'}</span>`
      + `${it.description && this.open !== it.id ? `<span class="bdds" title="${esc(it.description)}">${esc(it.description)}</span>` : ''}${it.dropped ? '<b class="bdrs" data-a="undrop" title="restore">restore</b>' : ''}</div>`;
    return head + (this.open === it.id ? this.editorHtml(it, st) : '');
  }
  editorHtml(it, st) {
    const status = st.status || 'draft', sb = (x) => `<button data-st="${x}" class="${status === x ? 'on s-' + x : ''}"${x === 'ok' ? ' title="the director signs this item off"' : ''}>${ST_LABEL[x]}</button>`;
    const chars = this.draft.filter(i => i.kind === 'character' && !i.dropped);
    const linked = new Set(it.links.map(l => l.scene));
    return `<div class="bded" data-item="${esc(it.id)}"><div class="bdef"><input class="bdin-name" value="${esc(it.name)}" spellcheck="false" title="name">`
      + `<select class="bdin-kind" title="kind">${BD.KINDS.map(k => `<option value="${k}"${k === it.kind ? ' selected' : ''}>${BD.KIND_ONE[k]}</option>`).join('')}</select>`
      + (it.kind === 'wardrobe' ? `<label class="dim">for <select class="bdin-for"><option value="">(nobody yet)</option>${chars.map(c => `<option value="${esc(c.id)}"${c.id === it.for ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : '')
      + `${sb('draft')}${sb('review')}${sb('ok')}<span class="sp"></span>`
      + (BD.PROMOTABLE.includes(it.kind) ? (st.entity_id ? `<a data-a="unlinkent" title="forget the link (the entity stays)">unlink entity</a>` : `<button data-a="promote" title="${it.kind === 'wardrobe' ? 'a look on a character' : 'a draft entity in Assets'}: nothing generated or spent">Create entity</button>`) : '')
      + `<b class="sctool" data-a="note" title="note on this item, in the Notes column (Alt+N)">✉</b><b class="sctool" data-a="split" title="split into two items">split</b><b class="sctool" data-a="merge1" title="merge with another item">merge</b><b class="sctool" data-a="drop" title="${it.dropped ? 'restore' : 'drop (soft: restorable)'}">${it.dropped ? 'restore' : 'drop'}</b><b class="sctool" data-a="close" title="close (Esc)">▴</b></div>`
      + `<textarea class="bdin-desc" rows="2" placeholder="what it is, what it looks like, why the script needs it" spellcheck="false">${esc(it.description)}</textarea>`
      + `<div class="scbh">scenes <select class="bdin-addsc"><option value="">+ link a scene…</option>${this.scenes.filter(s => !linked.has(s.id)).map(s => `<option value="${esc(s.id)}">${esc(s.id)} · ${SC.span(s.t0, s.t1)} ${esc(s.title)}</option>`).join('')}</select></div>`
      + it.links.map(l => { const s = this.scenes.find(x => x.id === l.scene);
        return `<div class="bdlk" data-scene="${esc(l.scene)}"><span class="bdlks${s ? '' : ' gone'}">${esc(l.scene)}</span><span class="bdlkt" title="${esc(s?.text || '')}">${s ? `${SC.span(s.t0, s.t1)} ${esc(s.title)}` : 'not in the current script'}</span>`
          + `<span class="bdbts">${(s?.beats || []).map(b => `<b class="bdbt${l.beats.includes(b.id) ? ' on' : ''}" data-beat="${esc(b.id)}" title="${esc(b.text)}">${esc(b.id)}</b>`).join('')}</span>`
          + `<input class="bdin-lnote" value="${esc(l.note || '')}" placeholder="why (optional)" spellcheck="false"><b class="sctool" data-a="unlink" title="unlink this scene">×</b></div>`; }).join('')
      + `</div>`;
  }
  renderList() {
    const body = this.$('.bdbody'), items = this.shown();
    if (!this.draft.length) {
      body.innerHTML = `<div class="scempty"><b>No breakdown yet.</b> ${this.scenes.length ? `The script has ${this.scenes.length} scene${this.scenes.length > 1 ? 's' : ''}: <a data-a="suggest">Suggest from script</a> (a first list, here and now) or <a data-a="extract">Ask the agent to extract</a> it; or add items by hand (<a data-a="add">+ item</a>).` : 'Write the script first (stage 2): every item is linked to the scenes that need it.'}</div>`;
      return;
    }
    const groups = BD.KINDS.filter(k => this.kind === 'all' || k === this.kind).map(k => [k, items.filter(i => i.kind === k)]).filter(([k, L]) => L.length || this.kind === k);
    body.innerHTML = `<div class="bdlist">${groups.map(([k, L]) => `<div class="bdgh k-${k}" data-kind="${k}">${dot(k)}<b>${BD.KIND_LABEL[k]}</b><span class="dim">${L.filter(i => !i.dropped).length}${L.some(i => i.dropped) ? ` + ${L.filter(i => i.dropped).length} dropped` : ''}</span><a data-a="addk" data-k="${k}">+ add</a></div>`
      + L.map(i => this.rowHtml(i)).join('')).join('')}</div>`
      + (this.scene && !items.length ? `<div class="scempty">No item linked to ${esc(this.scene)} yet.</div>` : '');
  }
  renderMatrix() {
    const body = this.$('.bdbody'), items = this.shown(), scenes = this.scenes;
    if (!items.length || !scenes.length) { this.renderList(); return; }
    const chars = new Set(this.draft.filter(i => i.kind === 'character' && !i.dropped).flatMap(i => i.links.map(l => l.scene)));
    const head = `<tr><th class="bdmxn"><span class="dim">${items.length} items × ${scenes.length} scenes</span></th>${scenes.map(s => `<th class="bdmxs${this.scene === s.id ? ' on' : ''}${chars.has(s.id) ? '' : ' nochar'}" data-scene="${esc(s.id)}" title="${esc(`${s.id} · ${SC.span(s.t0, s.t1)} · ${s.title}${chars.has(s.id) ? '' : '\n(no character yet)'}\nclick: only this scene's items · right-click: scene commands`)}">${esc(s.id.replace(/^sc/, ''))}</th>`).join('')}<th class="bdmxt" title="scenes linked">Σ</th></tr>`;
    let lastK = null;
    const rows = items.map(it => {
      const sep = it.kind !== lastK ? `<tr class="bdmxk"><td colspan="${scenes.length + 2}">${dot(it.kind)}${BD.KIND_LABEL[it.kind]}</td></tr>` : ''; lastK = it.kind;
      const by = new Map(it.links.map(l => [l.scene, l])), st = this.doc.states[it.id]?.status || 'draft';
      return sep + `<tr class="bdmxr${it.dropped ? ' dropped' : ''}${this.sel.has(it.id) ? ' sel' : ''}" data-item="${esc(it.id)}"><td class="bdmxn" title="${esc(`${it.id} · ${it.name}${it.description ? '\n' + it.description : ''}`)}">${dot(it.kind)}<span>${esc(it.name)}</span><i class="bdst s-${st}"><i></i></i></td>`
        + scenes.map(s => { const l = by.get(s.id); return `<td class="bdc${l ? ' on' : ''}${this.scene === s.id ? ' col' : ''}" data-scene="${esc(s.id)}" title="${esc(`${it.name} · ${s.id} ${s.title}`)}${l ? esc(`\nlinked${l.beats.length ? ' (beats ' + l.beats.join(', ') + ')' : ''}${l.note ? ': ' + l.note : ''}\nclick: unlink`) : '\nclick: link'}">${l ? (l.beats.length ? l.beats.length : '●') : ''}</td>`; }).join('')
        + `<td class="bdmxt">${it.links.length}</td></tr>`;
    }).join('');
    const foot = `<tr class="bdmxf"><td class="bdmxn dim">items per scene</td>${scenes.map(s => `<td>${items.filter(i => !i.dropped && i.links.some(l => l.scene === s.id)).length || ''}</td>`).join('')}<td></td></tr>`;
    body.innerHTML = `<div class="bdmxw"><table class="bdmx"><thead>${head}</thead><tbody>${rows}${foot}</tbody></table></div>`;
  }
  // the Time view: scenes (rows, on the timeline's axis: core/timemode.js) x items (columns); a cell links / unlinks
  renderTime() {
    const body = this.$('.bdbody'), items = this.shown(), scenes = [...this.scenes].sort((a, b) => a.t0 - b.t0);
    if (!items.length || !scenes.length) { this.renderList(); return; }
    const cols = `grid-template-columns: var(--bdl) repeat(${items.length}, 20px) 24px`, NL = String.fromCharCode(10);
    const head = `<div class="bdtmh" style="${cols}"><span class="bdtml dim">${scenes.length} scenes × ${items.length} items</span>${items.map(it => `<span class="bdtmi${it.dropped ? ' dropped' : ''}${this.sel.has(it.id) ? ' sel' : ''}" data-icol="${esc(it.id)}" title="${esc(`${it.id} · ${BD.KIND_ONE[it.kind]} · ${it.name}${it.description ? NL + it.description : ''}${NL}click: open it in the list`)}">${dot(it.kind)}<span>${esc(it.name)}</span></span>`).join('')}<span class="bdtmi dim" title="items per scene">Σ</span></div>`;
    const rows = scenes.map(s => {
      const n = items.filter(i => !i.dropped && i.links.some(l => l.scene === s.id)).length;
      return `<div class="bdtmr${this.scene === s.id ? ' on' : ''}" data-scene="${esc(s.id)}" style="${cols}"><span class="bdtml bdsc" data-scene="${esc(s.id)}" title="${esc(`${s.id} · ${SC.span(s.t0, s.t1)} · ${s.title}${NL}click: only this scene's items`)}"><b>${esc(s.id)}</b> ${esc(s.title || '')} <i>${SC.span(s.t0, s.t1)}</i></span>`
        + items.map(it => { const l = it.links.find(x => x.scene === s.id); return `<span class="bdtc${l ? ' on' : ''}${it.dropped ? ' dropped' : ''}" data-tc="${esc(it.id)}" data-scene="${esc(s.id)}" title="${esc(`${it.name} · ${s.id} ${s.title}${l ? `${NL}linked${l.beats.length ? ' (beats ' + l.beats.join(', ') + ')' : ''}${l.note ? ': ' + l.note : ''}${NL}click: unlink` : `${NL}click: link`}`)}">${l ? (l.beats.length || '●') : ''}</span>`; }).join('')
        + `<span class="bdtmt">${n || ''}</span></div>`;
    }).join('');
    body.innerHTML = `<div class="bdtm">${head}${rows}</div>`;
  }
  renderDiff() {
    const { a, b } = this.compare, va = this.doc.versions.find(v => v.id === a), vb = b === 'draft' ? { id: 'draft', items: this.draft, message: 'your unsaved edits' } : this.doc.versions.find(v => v.id === b);
    if (!va || !vb) { this.compare = null; return this.renderList(); }
    const ops = F.wordDiff(BD.breakdownText(va), BD.breakdownText(vb)), st = F.diffStats(ops), ch = BD.itemChanges(va, vb);
    const side = (keep, cls) => ops.filter(o => o.op === '=' || o.op === keep).map(o => o.w === '\n' ? '<br>' : o.op === '=' ? esc(o.w) + ' ' : `<span class="${cls}">${esc(o.w)}</span> `).join('');
    const hd = (v) => `<b>${esc(v.id)}</b> <span class="dim">${esc(v.message || '')}${v.created ? ' · ' + when(v.created) : ''}</span>`;
    const chs = [...ch.added.map(x => `<span class="dst a">+${esc(x)}</span>`), ...ch.changed.map(x => `<span class="dst c">~${esc(x)}</span>`), ...ch.removed.map(x => `<span class="dst d">−${esc(x)}</span>`)].join(' ');
    this.$('.bdbody').innerHTML = `<div class="lydiff"><div class="lydh"><span>${hd(va)} → ${hd(vb)}</span><span class="dim"> · <span class="dst a">+${st.added}</span> <span class="dst d">−${st.removed}</span> words${chs ? ' · items ' + chs : ''}</span><span class="sp"></span>${b !== 'draft' && vb.id !== this.doc.current ? `<button data-a="restore" data-v="${esc(vb.id)}">Restore ${esc(vb.id)}</button>` : ''}${va.id !== this.doc.current ? `<button data-a="restore" data-v="${esc(va.id)}">Restore ${esc(va.id)}</button>` : ''}<button data-a="closediff">Close</button></div>
      <div class="lydc"><div class="lydl">${side('-', 'del')}</div><div class="lydr">${side('+', 'add')}</div></div></div>`;
  }
  renderSide() {
    const side = this.$('.bdside'); side.style.display = this.side === 'versions' ? '' : 'none';
    if (this.side !== 'versions') return;
    for (const a of this.el.querySelectorAll('.lytabs [data-side]')) { a.classList.add('on'); a.innerHTML = `Versions<i>${this.doc.versions.length}</i>`; }
    const list = this.$('.lylist'), vs = [...this.doc.versions].reverse(), { a, b } = this.ab;
    list.innerHTML = `<div class="lyvh"><span class="dim">pick A and B, or click a row (it vs the one before)</span><button data-a="ab" ${a && b && a !== b ? '' : 'disabled'}>Compare A → B</button></div>` + (vs.length ? vs.map(v => `<div class="lyv${v.id === this.doc.current ? ' cur' : ''}" data-v="${esc(v.id)}">
      <span class="lyvid">${v.id === this.doc.current ? '●' : ''}${esc(v.id)}</span><span class="lyvm">${esc(v.message || (v.from ? 'restore ' + v.from : ''))}<i>${when(v.created)} ${v.via === 'agent' ? '· agent' : v.by ? '· ' + esc(v.by) : ''} · ${v.items.length} items${v.script ? ' · script ' + esc(v.script) : ''}</i></span>
      <b data-ab="a" class="${a === v.id ? 'on' : ''}">A</b><b data-ab="b" class="${b === v.id ? 'on' : ''}">B</b>${v.id === this.doc.current ? '' : `<b data-a="restore" data-v="${esc(v.id)}" title="copy it as a new version">restore</b>`}</div>`).join('') : '<div class="dim lyno">No versions yet: the first “Save version” makes v1.</div>');
  }
  // ---------------------------------------------------------------- events
  select(id, e) {
    if (e?.ctrlKey || e?.metaKey) { if (this.sel.has(id)) this.sel.delete(id); else this.sel.add(id); }
    else if (e?.shiftKey && this.sel.size) {
      const ids = this.shown().map(i => i.id), a = ids.indexOf([...this.sel].pop()), b = ids.indexOf(id);
      for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) this.sel.add(x);
    } else { this.sel = new Set([id]); this.open = this.open === id && this.view === 'list' ? null : id; }
    this.render();
  }
  wire() {
    const el = this.el;
    el.addEventListener('click', async (e) => {
      const t = e.target;
      const act = t.closest('[data-a]')?.dataset.a;
      const rowEl = t.closest('[data-item]'), iid = rowEl?.dataset.item;
      if (act === 'save') return this.save();
      if (act === 'discard') { if (await ui.confirm('Discard your unsaved breakdown edits?')) this.discard(); return; }
      if (act === 'drdiff') { this.compare = { a: this.doc.current, b: 'draft' }; return this.render(); }
      if (act === 'closediff') { this.compare = null; return this.render(); }
      if (act === 'compare') return commands.run('breakdown.compare');
      if (act === 'restore') return this.restore(t.closest('[data-v]').dataset.v);
      if (act === 'ab') { this.compare = { ...this.ab }; return this.render(); }
      if (act === 'add') return this.addItem();
      if (act === 'addk') return this.addItem(t.closest('[data-k]').dataset.k);
      if (act === 'suggest') return this.suggest();
      if (act === 'extract') return this.extract();
      if (act === 'versions') return this.setSide(this.side === 'versions' ? null : 'versions');
      if (act === 'closeside') return this.setSide(null);
      if (act === 'unscene') { this.scene = null; return this.render(); }
      if (act === 'merge') return this.merge([...this.sel]);
      if (act === 'kindsel') return this.setKind([...this.sel]);
      if (act === 'dropsel') return this.drop([...this.sel]);
      if (act === 'statsel') return this.setStatus([...this.sel].filter(id => this.cur?.items.some(i => i.id === id)), t.dataset.s);
      if (act === 'selnone') { this.sel.clear(); return this.render(); }
      const vw = t.closest('.bdvw [data-view]'); if (vw) { this.view = vw.dataset.view; prefs.set('bdView', this.view); this.compare = null; return this.render(); }
      const kc = t.closest('.bdcnt[data-kind]'); if (kc) { this.kind = this.kind === kc.dataset.kind ? 'all' : kc.dataset.kind; return this.render(); }
      const en = t.closest('[data-ent]'); if (en) return this.showEntity(en.dataset.ent);
      // matrix: a cell toggles the link, a scene header filters, a row name selects
      const tc = t.closest('.bdtc'); if (tc) { const id = tc.dataset.tc, on = this.toggle(id, tc.dataset.scene); toast(`${this.item(id).name} ${on ? '+' : '−'} ${tc.dataset.scene}`); return; }
      const ic = t.closest('[data-icol]'); if (ic) { setMode('breakdown', 'list'); this.view = 'list'; prefs.set('bdView', 'list'); return this.focus(ic.dataset.icol); }
      const cell = t.closest('td.bdc'); if (cell && iid) { const on = this.toggle(iid, cell.dataset.scene); toast(`${this.item(iid).name} ${on ? '+' : '−'} ${cell.dataset.scene}`); return; }
      const sh = t.closest('th.bdmxs, .bdsc[data-scene]'); if (sh) { this.scene = this.scene === sh.dataset.scene ? null : sh.dataset.scene; return this.render(); }
      if (iid && t.closest('.bded')) {
        const st = t.closest('[data-st]'); if (st) { if (!this.cur?.items.some(i => i.id === iid)) return toast('save the item first (Save version)'); return this.setStatus([iid], st.dataset.st); }
        const it = this.item(iid);
        if (act === 'close') { this.open = null; return this.render(); }
        if (act === 'note') return this.noteOnItem(iid);
        if (act === 'split') return this.split(iid);
        if (act === 'merge1') return this.merge([iid]);
        if (act === 'drop') return this.drop([iid]);
        if (act === 'promote') return this.promote(iid);
        if (act === 'unlinkent') return this.unlink(iid);
        if (act === 'unlink') { const sc = t.closest('[data-scene]').dataset.scene; return this.edit(() => BD.toggleLink(it, sc, false)); }
        const bt = t.closest('.bdbt[data-beat]');
        if (bt) { const l = it.links.find(x => x.scene === t.closest('[data-scene]').dataset.scene); return this.edit(() => { l.beats = l.beats.includes(bt.dataset.beat) ? l.beats.filter(b => b !== bt.dataset.beat) : [...l.beats, bt.dataset.beat]; }); }
        return;
      }
      if (act === 'undrop' && iid) return this.drop([iid], false);
      if (iid && (t.closest('.bdrow') || t.closest('td.bdmxn'))) return this.select(iid, e);
      const ab = t.closest('[data-ab]'); if (ab) { const v = ab.closest('[data-v]').dataset.v; this.ab[ab.dataset.ab] = this.ab[ab.dataset.ab] === v ? null : v; return this.renderSide(); }
      const vrow = t.closest('.lyv[data-v]');
      if (vrow) { const i = this.doc.versions.findIndex(v => v.id === vrow.dataset.v); const prev = this.doc.versions[i - 1]; this.compare = prev ? { a: prev.id, b: vrow.dataset.v } : { a: vrow.dataset.v, b: this.doc.current }; return this.render(); }
    });
    el.addEventListener('dblclick', (e) => { const n = e.target.closest('.bdrow .bdnm, td.bdmxn'); const id = n?.closest('[data-item]')?.dataset.item; if (id) this.rename(id); });
    el.addEventListener('input', (e) => {
      const t = e.target, iid = t.closest('.bded')?.dataset.item, it = iid && this.item(iid); if (!it) return;
      if (t.matches('.bdin-desc')) this.edit(() => { it.description = t.value; }, { render: false });
      else if (t.matches('.bdin-lnote')) { const l = it.links.find(x => x.scene === t.closest('[data-scene]').dataset.scene); if (l) this.edit(() => { if (t.value) l.note = t.value; else delete l.note; }, { render: false }); }
    });
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('.bdkind')) { this.kind = t.value; return this.render(); }
      if (t.matches('.bddrop')) { this.showDropped = t.checked; prefs.set('bdDropped', t.checked); return this.render(); }
      const iid = t.closest('.bded')?.dataset.item, it = iid && this.item(iid); if (!it) return;
      if (t.matches('.bdin-name')) { const v = t.value.trim(); if (v && v !== it.name) this.edit(() => { it.name = v; }); return; }
      if (t.matches('.bdin-kind')) { if (this.doc.states[iid]?.entity_id) { toast('an item made into an entity keeps its kind'); return this.render(); } return this.edit(() => { it.kind = t.value; if (t.value !== 'wardrobe') delete it.for; }); }
      if (t.matches('.bdin-for')) return this.edit(() => { if (t.value) it.for = t.value; else delete it.for; });
      if (t.matches('.bdin-addsc') && t.value) return this.edit(() => BD.toggleLink(it, t.value, true));
    });
    el.addEventListener('focusout', () => setTimeout(() => { if (this.pending && !this.typing()) this.render(); }, 0));
    el.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t.matches('.lymsg')) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); this.save(); } return; }
      if (t.matches('input, textarea, select')) {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); t.blur(); this.save(); }
        else if (e.key === 'Enter' && t.matches('input')) { e.preventDefault(); t.blur(); }
        else if (e.key === 'Escape') t.blur();
        return;
      }
      if (e.key === 'Escape' && (this.open || this.sel.size)) { e.stopPropagation(); this.open = null; this.sel.clear(); this.render(); }
    });
  }
}

// ------------------------------------------------------------------ commands (registered at load: core/rail.js imports this module)
const V = () => visible() && !!S;
const ensure = async () => { if (!visible()) await WB().stages.open('breakdown'); return S; };
const T = (c) => S ? S.targets(c) : [];
const one = (c) => T(c).length === 1 ? T(c)[0] : (c?.itemId || S?.open || null);
const itemOf = (c) => one(c) && S?.item(one(c));
commands.register([
  { id: 'breakdown.save', group: 'Breakdown', title: 'Save breakdown version', when: () => V() && S.dirty, run: () => S.save() },
  { id: 'breakdown.discard', group: 'Breakdown', title: 'Discard unsaved breakdown edits', when: () => V() && S.dirty, run: () => S.discard() },
  { id: 'breakdown.suggest', group: 'Breakdown', title: 'Breakdown: suggest items from the script', run: async () => (await ensure())?.suggest() },
  { id: 'breakdown.extract', group: 'Breakdown', title: 'Ask the agent to extract the breakdown from the script', run: async () => (await ensure())?.extract() },
  { id: 'breakdown.add', group: 'Breakdown', title: 'Breakdown: new item…', run: async () => (await ensure())?.addItem() },
  { id: 'breakdown.matrix', group: 'Breakdown', title: 'Breakdown: matrix view (items × scenes)', checked: () => S?.view === 'matrix', run: async () => { const s = await ensure(); s.view = s.view === 'matrix' ? 'list' : 'matrix'; prefs.set('bdView', s.view); s.compare = null; s.render(); } },
  { id: 'breakdown.compare', group: 'Breakdown', title: 'Compare breakdown versions…', when: () => !!store.breakdown?.versions?.length, run: async () => {
    await ensure();
    const vs = [...store.breakdown.versions].reverse().map(v => ({ label: v.id, detail: `${v.message || ''} ${v.created ? v.created.replace('T', ' ') : ''}`, value: v.id }));
    const a = await ui.pick({ title: 'Compare: older version (A)', items: vs }); if (!a) return;
    const b = await ui.pick({ title: `Compare ${a} with (B)`, items: [{ label: 'your unsaved edits', detail: 'draft', value: 'draft' }, ...vs.filter(v => v.value !== a)] }); if (!b) return;
    S.compare = { a, b }; S.render();
  } },
  { id: 'breakdown.open', group: 'Breakdown', title: 'Open breakdown item…', run: async (c) => {
    await ensure();
    const id = c?.itemId || await ui.pick({ title: 'Open breakdown item', items: S.draft.map(i => ({ label: i.name, detail: `${BD.KIND_ONE[i.kind]} · ${i.id} · ${i.links.map(l => l.scene).join(' ')}`, value: i.id })) });
    if (id) { S.view = 'list'; S.focus(id); }
  } },
  { id: 'breakdown.sceneItems', group: 'Breakdown', title: (c) => `Breakdown items in ${c?.sceneId ? 'scene ' + c.sceneId : 'this scene'}`, when: (c) => !!c?.sceneId, run: async (c) => { const s = await ensure(); s.scene = c.sceneId; s.compare = null; s.render(); } },
  { id: 'breakdown.rename', group: 'Breakdown', title: 'Rename the item', when: (c) => V() && !!itemOf(c), run: (c) => S.rename(one(c)) },
  { id: 'breakdown.kind', group: 'Breakdown', title: 'Change the kind…', when: (c) => V() && T(c).length > 0, run: (c) => S.setKind(T(c)) },
  { id: 'breakdown.merge', group: 'Breakdown', title: (c) => T(c).length > 1 ? `Merge ${T(c).length} items` : 'Merge with…', when: (c) => V() && T(c).length > 0, run: (c) => S.merge(T(c)) },
  { id: 'breakdown.split', group: 'Breakdown', title: 'Split the item…', when: (c) => V() && !!itemOf(c), run: (c) => S.split(one(c)) },
  { id: 'breakdown.drop', group: 'Breakdown', title: (c) => T(c).every(id => S.item(id)?.dropped) ? 'Restore (undrop)' : 'Drop (soft: restorable)', when: (c) => V() && T(c).length > 0, run: (c) => S.drop(T(c)) },
  { id: 'breakdown.promote', group: 'Breakdown', title: (c) => itemOf(c)?.kind === 'wardrobe' ? 'Create entity: a look on a character…' : 'Create entity…', when: (c) => V() && !!itemOf(c) && BD.PROMOTABLE.includes(itemOf(c).kind) && !store.breakdown?.states?.[one(c)]?.entity_id, run: (c) => S.promote(one(c)) },
  { id: 'breakdown.showEntity', group: 'Breakdown', title: 'Show the entity', when: (c) => V() && !!store.breakdown?.states?.[one(c)]?.entity_id, run: (c) => S.showEntity(store.breakdown.states[one(c)].entity_id) },
  { id: 'breakdown.unlinkEntity', group: 'Breakdown', title: 'Unlink the entity', hidden: true, when: (c) => V() && !!store.breakdown?.states?.[one(c)]?.entity_id, run: (c) => S.unlink(one(c)) },
  { id: 'breakdown.note', group: 'Breakdown', title: 'Note on the item (Notes column)', when: (c) => V() && !!itemOf(c), run: (c) => S.noteOnItem(one(c)) },
  { id: 'breakdown.ask', group: 'Breakdown', title: 'Ask the agent anything about the breakdown… (a note)', run: async () => (await ensure())?.ask() },
  { id: 'breakdown.versions', group: 'Breakdown', title: 'Breakdown versions panel', checked: () => S?.side === 'versions', when: () => V(), run: () => S.setSide(S.side === 'versions' ? null : 'versions') },
  // "+ Add" an item of a kind (in the right-clicked scene when there is one)
  ...BD.KINDS.map(k => ({ id: `breakdown.add_${k}`, group: 'Breakdown', title: `Breakdown: add a ${BD.KIND_ONE[k]}…`, hidden: true, when: () => V(), run: (c) => S.addItem(k, c?.sceneId) })),
  { id: 'breakdown.ok', group: 'Breakdown', title: 'Mark the item ok', when: (c) => V() && T(c).length > 0, run: (c) => S.setStatus(T(c).filter(id => S.cur?.items.some(i => i.id === id)), 'ok') },
  { id: 'breakdown.review', group: 'Breakdown', title: 'Flag the item: review', hidden: true, when: (c) => V() && T(c).length > 0, run: (c) => S.setStatus(T(c).filter(id => S.cur?.items.some(i => i.id === id)), 'review') },
]);
// Ctrl+Enter / Alt+N: the rail's stage.save / stage.note ask the visible stage (core/rail.js)
window.WB = Object.assign(window.WB || {}, { stageActions: { ...(window.WB?.stageActions || {}), breakdown: { canSave: () => V() && S.dirty, save: () => S.save(), canNote: () => V(), note: () => S.nc.editCurrent() } } });
const ADD = { label: '+ Add', when: () => V(), submenu: [...BD.KINDS.map(k => ({ cmd: `breakdown.add_${k}`, label: `+ ${BD.KIND_ONE[k]}` })), '-', { cmd: 'notes.addHere', label: '+ note here' }] };
menus.contribute('bdstage', [ADD, 'breakdown.ask', 'breakdown.versions']);
menus.contribute('bditem', [ADD, 'breakdown.open', 'breakdown.rename', 'breakdown.kind', 'breakdown.merge', 'breakdown.split', 'breakdown.drop', '-', 'breakdown.promote', 'breakdown.showEntity', 'breakdown.unlinkEntity', '-', 'breakdown.note', 'breakdown.ok', 'breakdown.review']);
menus.contribute('scene', ['-', 'breakdown.sceneItems']);

export default {
  mount(el, ctx) { S = new Workspace(el, ctx); window.WB.breakdown = { focus: (id) => S.focus(id), get ws() { return S; } }; },
  show() { if (S && !S.typing()) S.render(); },
  get ws() { return S; },
};
