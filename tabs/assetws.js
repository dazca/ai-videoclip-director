// The asset workspace (docs/SPEC_v3_GUIDED.md, stages 4 and 5): ONE code path for characters (tabs/charstage.js),
// locations and props (tabs/scenery.js). Left: the assets the breakdown found (with the scenes each appears in and where
// it stands: base / iterating / root approved / variants). Right, per asset:
//   Root      (Identity for a character, Base for a location or a prop) the BASE: pick from the CC0 catalogue, an
//             Openverse search (CC0 / public domain by default; licence, creator and URL recorded), a description, the
//             user's own photos (uploaded or a local path: private/, never exported) and a sketch; then "Request ...": a
//             draft generation request with an honest estimate. Request -> Approve (here, the director) -> the agent
//             runs it (MCP) -> the output comes back as a node of the ITERATION TREE (horizontal strips, one per
//             branch). A node: Edit (text + a sketch drawn over the image + an optional mask + numbered pins) -> a
//             request; a new node opens side by side with its parent (A/B slider, toggle or side by side): Keep /
//             Branch / Revert. "Approve" locks the tree (page only).
//   Variants  (Looks for a character) one iteration tree per variant, starting from the approved root: a character's
//             looks (wardrobe items of the breakdown are draft looks); a location's angle / time of day / weather; a
//             prop's angle / state.
//   Scenes    the scenes that use the asset (breakdown links) and the variant each one needs (the storyboard reads it).
//   Notes     every note on this asset, one row per thing it is on (the asset, a tree, a node, a scene's use), and the
//             history of every act.
// The Notes column (core/notescol.js) on the right is row-aligned: the asset's notes in its top row, a node's on the
// strip of its branch (or on the open node, with numbered pins on its image: "📍 pin" then click the image), a scene's
// on its row in Scenes. Right-click a node: + Add › note on this node.
// Everything the director decides goes through POST /api/op/asset_act (the server accepts it from this page only);
// requests are saved in requests.json like the Queue's. Formats: js/assets.js.
import { store, prefs, toast, esc, mediaUrl, postJSON, isPrivatePath } from '../js/store.js';
import { ui } from '../core/palette.js';
import { commands } from '../core/commands.js';
import { menus } from '../core/menus.js';
import * as A from '../js/assets.js';
import * as BD from '../js/breakdown.js';
import * as SC from '../js/scenes.js';
import * as N from '../js/notes.js';
import { NotesColumn } from '../core/notescol.js';
import { stripHtml, register as registerProposals } from '../core/proposals.js';

const WB = () => window.WB;
const OPENVERSE = 'https://api.openverse.org/v1/images/';
let SKM = null; const sketchMod = async () => (SKM ||= await import('../core/sketch/sketch.js'));
const blobB64 = (b) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, '')); r.onerror = () => bad(r.error); r.readAsDataURL(b); });
// a ref / node image -> URL: catalogue paths live under the workbench (/catalog/...), the rest in the project
const imgUrl = (p) => !p ? '' : /^catalog\//i.test(p) ? '/' + p.split('/').map(encodeURIComponent).join('/') : mediaUrl(p);
const lock = (p, priv) => (priv || isPrivatePath(p)) ? '<i class="chlock" title="private: local only, never exported">🔒</i>' : '';
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;
const when = (at) => at ? esc(String(at).replace('T', ' ').slice(5, 16)) : '';
const STEPS = ['draft', 'approved', 'running', 'done'];
const op = async (name, body) => { const r = await postJSON('/api/op/' + name, body), j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const nn = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// what the page says per type (the data words are js/assets.js TYPE)
export const UI = {
  character: { tabs: [['identity', 'Identity'], ['looks', 'Looks'], ['scenes', 'Scenes'], ['notes', 'Notes']], rootTab: 'identity', vTab: 'looks',
    describe: 'describe the character: age, build, face, hair, skin, how they move, what they wear by default, era… (with or without references)',
    ovHint: 'search Openverse (e.g. mannequin pose walking, costume plate 1920s)', sketchHint: 'draw the character (over the first catalogue body you picked, if any): the sketch becomes a reference',
    photoWarn: '🔒 Photos of you or your friends are stored under <code>private/</code> in this project, flagged private: shown only on this machine, never exported or shared. Use them only with the person\'s consent.',
    editHint: 'e.g. add a thin silver necklace (pin 1); messier hair; a pin on the lapel', baseWhat: 'what the identity sheet starts from: combine any of these' },
  location: { tabs: [['base', 'Base'], ['variants', 'Variants'], ['scenes', 'Scenes'], ['notes', 'Notes']], rootTab: 'base', vTab: 'variants',
    describe: 'describe the place: interior / exterior, era, size, materials, colours, light sources, what is in it, the mood… (with or without references)',
    ovHint: 'search Openverse (e.g. bus interior night, harbour pier fog, 1970s kitchen)', sketchHint: 'draw the place: a floor plan or the view, where the light comes from, P = pin a note',
    photoWarn: '🔒 Photos of a real place (scouting, a friend\'s flat) are stored under <code>private/</code> in this project, flagged private: shown only on this machine, never exported or shared.',
    editHint: 'e.g. wet asphalt (pin 1); add a bus stop sign here; warmer window light', baseWhat: 'what the base plate starts from: combine any of these' },
  prop: { tabs: [['base', 'Base'], ['variants', 'Variants'], ['scenes', 'Scenes'], ['notes', 'Notes']], rootTab: 'base', vTab: 'variants',
    describe: 'describe the object: what it is, size, materials, colours, wear, markings, era… (with or without references)',
    ovHint: 'search Openverse (e.g. old letter envelope, brass oil lamp, cassette recorder)', sketchHint: 'draw the object: shape, details, P = pin a note',
    photoWarn: '🔒 Photos of a real object are stored under <code>private/</code> in this project, flagged private: shown only on this machine, never exported or shared.',
    editHint: 'e.g. a crack across the glass (pin 1); brighter flame; a wax seal', baseWhat: 'what the prop sheet starts from: combine any of these' },
};

export class AssetWorkspace {
  // opts: {types: ['character'] | ['location', 'prop'], stage, pref: prefs prefix, title: list title (one type)}
  constructor(el, opts) {
    this.el = el; this.types = opts.types; this.stage = opts.stage; this.pf = opts.pref;
    this.cur = prefs.get(this.pf + 'Cur', null); this.tab = prefs.get(this.pf + 'Tab', null); this.vid = null; this.sel = null;
    this.mode = 'view'; this.ab = prefs.get(this.pf + 'AB', 'slider'); this.abPos = 50; this.abShow = 'B';
    this.src = prefs.get(this.pf + 'Src', 'catalog'); this.drafts = {}; this.cat = null; this.catKind = {}; this.catQ = ''; this.ov = { q: '', lic: 'cc0,pdm', res: null, busy: false, msg: '' };
    this.sk = null; this.pending = false; this.vf = null;
    el.classList.add('chws');
    el.innerHTML = '<div class="chlist"></div><div class="chmain"><div class="lybar chbar"></div><div class="chbody" tabindex="-1"></div></div>';
    this.$ = (s) => el.querySelector(s);
    this.skHost = document.createElement('div'); this.skHost.className = 'chsk';
    this.wire();
    this.nc = new NotesColumn({ stage: this.stage, scroller: this.$('.chbody'), active: () => !!this.ent(),
      scope: (n) => n.target.kind === 'stage' || this.mine(n),
      top: () => { const e = this.ent(); return { label: e ? `notes on ${e.name || e.id}` : 'notes', targets: e ? [this.tg('asset'), { stage: this.stage, kind: 'stage', id: null }] : [{ stage: this.stage, kind: 'stage', id: null }],
        match: (n) => n.target.kind === 'asset' || n.target.kind === 'stage', sub: (n) => n.target.kind === 'stage' ? `all ${this.stage}` : '' }; },
      rows: () => this.noteRows(), current: () => this.sel ? this.tg('node', this.sel) : null });
    store.on((w) => { if (['all', 'requests', 'breakdown', 'scenes', 'notes', 'proposals'].includes(w)) { if (this.typing()) this.pending = true; else this.render(); } });
    this.render();
  }
  // ---------------------------------------------------------------- notes (notes.json v2, the Notes column)
  // a target on this asset: tg('asset'), tg('node', 'n03'), tg('tree', 'look:x'), tg('use', 'sc02')
  tg(kind, sub, extra) { const e = this.ent(); return { stage: this.stage, kind, id: kind === 'asset' ? e.id : `${e.id}/${sub}`, ...(extra || {}) }; }
  mine(n, e = this.ent()) { return !!e && N.assetStage(e.kind) === n.target.stage && (n.target.id === e.id || String(n.target.id || '').startsWith(e.id + '/')); }
  myNotes(status) { return store.notesOn({ stage: this.stage, ...(status ? { status } : {}) }).filter(n => this.mine(n)); }
  nodePins(nodeId) { return this.myNotes().filter(n => n.target.kind === 'node' && n.target.pin && N.splitId(n.target.id)[1] === nodeId && n.status !== 'dismissed'); }
  // the rows: the open node (its notes and pins), the branches of the tree shown (each with its nodes' notes; the first
  // with the tree's), the scenes (Scenes tab), the things notes are on (Notes tab)
  noteRows() {
    const e = this.ent(); if (!e) return [];
    const out = [], sub = (n) => N.splitId(n.target.id)[1];
    const np = this.el.querySelector('.chbody .chnp[data-node]');
    if (np) { const id = np.dataset.node, pins = this.nodePins(id); out.push({ el: np, targets: [this.tg('node', id)], match: (n) => n.target.kind === 'node' && sub(n) === id, sub: (n) => n.target.pin ? `📍${pins.indexOf(pins.find(x => x.id === n.id)) + 1}` : '' }); }
    const tree = this.tree;
    [...this.el.querySelectorAll('.chbody .chstrip')].forEach((st, i) => {
      const ids = [...st.querySelectorAll('[data-node]')].map(x => x.dataset.node);
      out.push({ el: st, targets: [...ids.map(id => this.tg('node', id)), ...(i === 0 ? [this.tg('tree', tree)] : [])],
        match: (n) => (n.target.kind === 'node' && ids.includes(sub(n))) || (i === 0 && n.target.kind === 'tree' && sub(n) === tree),
        sub: (n) => n.target.kind === 'node' ? sub(n) + (n.target.pin ? ' 📍' : '') : 'tree',
        targetAt: (x) => { const d = x.closest?.('[data-node]'); return d ? this.tg('node', d.dataset.node) : this.tg('tree', tree); } });
    });
    for (const r of this.el.querySelectorAll('.chbody .asuse[data-scene]')) out.push({ el: r, targets: [this.tg('use', r.dataset.scene)] });
    for (const r of this.el.querySelectorAll('.chbody .chnrow[data-tk]')) { const [kind, id] = r.dataset.tk.split('|'); out.push({ el: r, targets: [{ stage: this.stage, kind, id }], sub: (n) => n.target.pin ? '📍' : '' }); }
    return out;
  }
  typing() { const a = document.activeElement; return !!a && this.el.contains(a) && a.matches('input:not([type=range]):not([type=checkbox]), textarea, select') && !this.sk?.api.el.contains(a); }
  // ---------------------------------------------------------------- data
  get assets() { return store.entities.filter(e => this.types.includes(e.kind)); }
  ent(id = this.cur) { return store.entities.find(e => e.id === id && this.types.includes(e.kind)) || null; }
  get type() { return this.ent()?.kind || this.types[0]; }
  get T() { return A.TYPE[this.type]; }
  get U() { return UI[this.type]; }
  iter(e = this.ent()) { return A.normIter(e?.iter); }
  get tree() { return this.tab === this.U.vTab && this.vid ? A.variantTree(this.type, this.vid) : this.T.root; }
  // the requests of an asset, each with its link as `char` (the stage-4 name the rendering reads)
  reqs(e = this.ent()) { return e ? A.assetRequests(store.requests, e.kind, e.id).map(r => ({ ...r, char: A.linkOf(r) })) : []; }
  vlist(e = this.ent()) { return A.variants(e, e?.kind); }
  bdItems() { const b = store.breakdown, v = BD.currentBreakdown(b); return { b, items: (v?.items || []).filter(i => !i.dropped) }; }
  itemOf(e) { const { b, items } = this.bdItems(); const id = Object.entries(b?.states || {}).find(([k, s]) => s?.entity_id === e.id && items.find(i => i.id === k)?.kind === e.kind)?.[0]; return id ? items.find(i => i.id === id) : null; }
  scenesOf(e) { const it = this.itemOf(e); return it ? BD.itemScenes(it) : e.breakdown?.scenes || []; }
  // every asset the stage knows, per type: entities (in breakdown order first) + breakdown items not yet entities
  rows(type) {
    const { b, items } = this.bdItems(), out = [], seen = new Set();
    for (const it of items.filter(i => i.kind === type)) {
      const eid = b.states?.[it.id]?.entity_id, e = eid && store.entities.find(x => x.id === eid && x.kind === type);
      if (e) { seen.add(e.id); out.push({ e, item: it, scenes: BD.itemScenes(it) }); } else out.push({ e: null, item: it, scenes: BD.itemScenes(it) });
    }
    for (const e of this.assets.filter(x => x.kind === type)) if (!seen.has(e.id)) out.push({ e, item: null, scenes: e.breakdown?.scenes || [] });
    return out;
  }
  allRows() { return this.types.flatMap(t => this.rows(t)); }
  draft(e = this.ent()) { return (this.drafts[e.id] ||= { text: e.base?.text || '', refs: structuredClone(e.base?.refs || []) }); }
  baseDirty(e = this.ent()) { const d = this.drafts[e?.id]; return !!d && JSON.stringify({ t: d.text, r: d.refs.map(r => r.path) }) !== JSON.stringify({ t: e.base?.text || '', r: (e.base?.refs || []).map(r => r.path) }); }
  // ---------------------------------------------------------------- acts (the server accepts them from this page only)
  async act(act, body = {}) { try { return await op('asset_act', { type: this.type, id: this.cur, act, ...body }); } catch (e) { toast('not done: ' + e.message); throw e; } }
  async saveBase() {
    const e = this.ent(), d = this.draft(e);
    await this.act('base', { base: { text: d.text, refs: d.refs } });
    delete this.drafts[e.id]; toast(`${e.name}: base saved (${d.refs.length} refs)`);
  }
  // the link a page request carries: `asset` {type, id, tree, from, kind, ...} (the old `char` name is no longer written)
  link(e, l) { return { asset: { type: e.kind, ...l } }; }
  async requestRoot() {
    const e = this.ent(), d = this.draft(e), T = this.T;
    if (!d.refs.length && !d.text.trim()) return toast(`pick a base first: a catalogue image, an Openverse image, photos, a sketch, or a description`);
    if (A.treeState(this.iter(e), T.root).approved) return toast(`the ${T.rootWord} is approved (locked): unlock it first`);
    if (this.baseDirty(e) || !e.base) await this.saveBase();
    const base = this.ent()?.base || { text: d.text, refs: d.refs }, est = A.estimate(T.gen.root, { type: e.kind });
    const r = await store.addRequest({ kind: T.req.root, target: `${e.kind}:${e.id}`, prompt: A.rootPrompt(e.kind, e, base), refs: base.refs.map(x => x.path), est_cost: est.usd,
      extra: { tool: est.tool, est_why: est.why, ...this.link(e, { id: e.id, tree: T.root, from: null, kind: T.gen.root, text: base.text || '', pins: [] }) } });
    toast(`draft request ${r.id}: ${T.sheetWord} of ${e.name} · est ${usd(est.usd)} · approve it here, then Run it (Review › Queue) or let the agent run it`);
  }
  requestIdentity() { return this.requestRoot(); }
  approveReq(id) { return store.setRequest(id, { status: 'approved' }).then(() => toast(`request ${id} approved: the agent may run it now (MCP)`)); }
  rejectReq(id) { return store.setRequest(id, { status: 'rejected', why: 'rejected by the director' }).then(() => toast(`request ${id} rejected`)); }
  async choose(node, choice) { await this.act('choose', { node, choice }); toast(`${node}: ${{ kept: 'kept (the new head)', branch: 'kept as a branch', reverted: 'reverted (the head stays)' }[choice]}`); this.mode = 'view'; }
  async approveTree(tree = this.tree, node) {
    const it = this.iter(), n = A.nodeById(it, node || A.treeState(it, tree).head);
    if (!n) return toast('nothing to approve yet');
    if (it.nodes.some(x => x.tree === tree && A.pending(it, x))) { if (!(await ui.confirm(`There are new nodes you have not decided on. Approve ${n.id} anyway?`))) return; }
    await this.act('approve', { tree, node: n.id });
    toast(A.isRoot(tree) ? `${this.T.rootWord} approved (${n.id}): locked; ${this.T.vWords} start from it` : `${this.T.vWord} approved (${n.id})`);
  }
  async unlock(tree = this.tree) { if (!(await ui.confirm(`Unlock ${A.isRoot(tree) ? 'the ' + this.T.rootWord : 'this ' + this.T.vWord} so it can change again?`))) return; await this.act('unlock', { tree }); toast('unlocked'); }
  setVariant(vid) { this.tab = this.U.vTab; this.vid = vid; prefs.set(this.pf + 'Tab', this.tab); }
  // the agent's proposals (base_propose, node_import_propose): one click accepts, the director's act
  async acceptBase() { const e = this.ent(); await this.act('base_accept'); delete this.drafts[e.id]; toast(`${e.name}: the proposed base is the base now`); }
  async dismissBase() { await this.act('base_dismiss'); toast('base proposal dismissed'); }
  async acceptImport(id) { const r = await this.act('import_accept', { proposal: id }); this.sel = r.node; this.mode = 'view'; toast(`imported as ${r.node} (head of ${r.tree}): no request, nothing paid`); }
  async dismissImport(id) { await this.act('import_dismiss', { proposal: id }); toast(`proposal ${id} dismissed`); }
  // import any registered image as a node of the open tree (a legacy look, an output made outside the queue)
  async importImage(tree = this.tree) {
    const e = this.ent(); if (!e) return;
    const it = this.iter(e), T = this.T;
    if (A.treeState(it, tree).approved) return toast('this tree is approved (locked): unlock it first');
    if (!A.isRoot(tree) && !A.approvedNode(it, T.root)) return toast(`approve the ${T.rootWord} first (or import an image as it): a ${T.vWord} starts from it`);
    const used = new Set(it.nodes.filter(n => n.tree === tree).map(n => n.image.toLowerCase()));
    const imgs = store.media.filter(m => /\.(png|jpe?g|webp|gif)$/i.test(m.path) && !used.has(String(m.path).toLowerCase()) && m.kind !== 'sketch' && m.kind !== 'ref');
    const mine = (m) => (m.entities || []).includes(e.id);
    const items = [...imgs.filter(mine), ...imgs.filter(m => !mine(m))].map(m => ({ label: `${mine(m) ? '● ' : ''}${m.label || m.id}`, detail: [m.kind, m.job ? 'job ' + m.job : '', m.private ? 'private' : '', m.path].filter(Boolean).join(' · '), value: m.id }));
    if (!items.length) return toast('no registered images: the agent registers files with media_add');
    const id = await ui.pick({ title: `Import an image as a node of ${tree} (${e.name}): no request, nothing paid`, items }); if (!id) return;
    const r = await this.act('import', { tree, media: id }); this.sel = r.node; this.mode = 'view';
    toast(`${id} imported as ${r.node}: the head of ${tree}${r.provenance?.cost ? ` (cost on record: $${Number(r.provenance.cost.usd).toFixed(2)}, ${r.provenance.cost.source})` : ''}`);
  }
  async newVariant() {
    const e = this.ent(); if (!e) return;
    if (e.kind !== 'character') { this.setVariant(this.vid); this.vf = { axes: {}, name: '', notes: '' }; this.sel = null; this.render(); this.$('.asvf')?.scrollIntoView({ block: 'nearest' }); return; }
    const name = await ui.prompt({ title: `New look for ${e.name}: name`, placeholder: 'e.g. Red raincoat (Enter)' }); if (!name?.trim()) return;
    const garments = await ui.prompt({ title: `“${name}”: garments (comma separated)`, placeholder: 'raincoat, black jeans, boots' });
    const r = await this.act('look_new', { name: name.trim(), garments: garments || '' });
    this.setVariant(r.look); toast(`look ${r.look} added (draft)`);
  }
  newLook() { return this.newVariant(); }
  async createVariant() {
    const f = this.vf, e = this.ent(); if (!f || !e) return;
    const axes = {}; for (const k of this.T.axes) { const v = String(f.axes[k] || '').trim(); if (v) axes[k] = v; }
    if (!Object.keys(axes).length && !f.name.trim()) return toast(`pick at least one ${this.T.axes.map(a => A.AXES[a].label).join(' / ')}, or give a name`);
    const r = await this.act('variant_new', { axes, name: f.name.trim(), notes: f.notes.trim() });
    this.vf = null; this.setVariant(r.variant); this.sel = null; toast(`variant ${r.variant} added (draft): request its sheet from the approved base`);
  }
  async makeLookFromItem(itemId) {
    const r = await postJSON('/api/op/breakdown_promote', { item: itemId, character: this.cur }), j = await r.json().catch(() => ({}));
    if (!r.ok) return toast('not made: ' + (j.error || r.status));
    this.setVariant(j.look_id); toast(`wardrobe item is now look ${j.look_id}`);
  }
  async requestVariant(vid = this.vid) {
    const e = this.ent(), T = this.T, v = this.vlist(e).find(x => x.id === vid), it = this.iter(e), rn = A.approvedNode(it, T.root);
    if (!v) return;
    if (!rn) return toast(`approve the ${T.rootWord} first: a ${T.vWord} starts from it`);
    const est = A.estimate(T.gen.variant, { type: e.kind });
    const extra = e.kind === 'character' ? { look: { id: v.id, name: v.name, garments: v.garments || [], colors: v.colors || [] } } : { variant: { id: v.id, name: v.name, axes: v.axes || {} } };
    const r = await store.addRequest({ kind: T.req.variant, target: `${e.kind}:${e.id}`, prompt: A.variantPrompt(e.kind, e, v, rn), refs: [rn.image, ...(v.images || []).filter(x => x !== rn.image)], est_cost: est.usd,
      extra: { tool: est.tool, est_why: est.why, ...extra, ...this.link(e, { id: e.id, tree: A.variantTree(e.kind, v.id), from: rn.id, kind: T.gen.variant, text: '', pins: [] }) } });
    toast(`draft request ${r.id}: ${T.vWord} sheet “${v.name}” · est ${usd(est.usd)}`);
  }
  requestLook(vid) { return this.requestVariant(vid); }
  async setUse(scene, variant) { if (variant === '__clear') await this.act('use', { scene, clear: true }); else await this.act('use', { scene, variant: variant || null }); toast(`${scene}: ${variant === '__clear' ? 'pick cleared' : variant ? this.vlist().find(v => v.id === variant)?.name || variant : this.T.rootWord}`); }
  // ---------------------------------------------------------------- base sources
  async loadCatalog() { if (this.cat) return; try { this.cat = await (await fetch('/catalog/catalog.json')).json(); } catch (e) { this.cat = { kinds: [], items: [] }; } this.render(); }
  toggleRef(ref) {
    const d = this.draft(), i = d.refs.findIndex(r => r.path === ref.path);
    if (i >= 0) d.refs.splice(i, 1); else d.refs.push(ref);
    this.render();
  }
  async searchOpenverse(q = this.ov.q) {
    this.ov.q = q = String(q || '').trim(); if (!q) return;
    if (this.ov.busy) return; this.ov.busy = true; this.ov.msg = 'searching Openverse…'; this.render();
    try {
      const u = `${OPENVERSE}?q=${encodeURIComponent(q)}&license=${encodeURIComponent(this.ov.lic)}&page_size=20&mature=false`;
      const r = await fetch(u, { headers: { accept: 'application/json' } });
      if (r.status === 429) throw new Error('Openverse limit reached (20 a minute, 200 a day for anonymous use): try again later');
      if (!r.ok) throw new Error(`Openverse: HTTP ${r.status}`);
      const j = await r.json();
      this.ov.res = (j.results || []).filter(x => !x.mature && !(x.unstable__sensitivity || []).length);
      this.ov.msg = `${this.ov.res.length} of ${j.result_count ?? '?'} results · ${this.ov.lic === 'cc0,pdm' ? 'CC0 and public domain only' : 'CC0, public domain and CC BY (credit required)'}`;
    } catch (e) { this.ov.res = this.ov.res || []; this.ov.msg = e.message; }
    finally { this.ov.busy = false; this.render(); }
  }
  async useOpenverse(id) {
    const x = (this.ov.res || []).find(r => r.id === id); if (!x) return;
    const e = this.ent(); this.ov.msg = `fetching “${x.title || x.id}”…`; this.render();
    try {
      // the thumbnail is served by api.openverse.org (CORS *, allowed by the page's CSP); the full image stays at its URL
      const b = await (await fetch(x.thumbnail || `${OPENVERSE}${x.id}/thumb/`)).blob();
      if (!/^image\//.test(b.type)) throw new Error('not an image');
      const lic = `${String(x.license || '').toUpperCase()}${x.license_version ? ' ' + x.license_version : ''}`;
      const j = await op('ref_upload', { type: e.kind, id: e.id, kind: 'openverse', name: `ov-${String(x.id).slice(0, 8)}`, data: await blobB64(b),
        meta: { title: x.title || '', licence: lic, licence_url: x.license_url || '', creator: x.creator || '', url: x.foreign_landing_url || '', original: x.url || '', attribution: x.attribution || '', openverse_id: x.id } });
      this.draft(e).refs.push({ ...j.ref, source: 'openverse' });
      this.ov.msg = `added “${x.title || x.id}” (${lic}${x.creator ? ', ' + x.creator : ''}) · check the licence on its page before you publish`;
    } catch (er) { this.ov.msg = 'not added: ' + er.message; }
    this.render();
  }
  async addPhotos(files) {
    const e = this.ent(); let n = 0;
    for (const f of files) {
      if (!/^image\//.test(f.type)) { toast(`${f.name}: not an image`); continue; }
      try { const j = await op('ref_upload', { type: e.kind, id: e.id, kind: 'photo', name: f.name, data: await blobB64(f) }); this.draft(e).refs.push(j.ref); n++; } catch (er) { toast(`${f.name}: ${er.message}`); }
    }
    if (n) toast(`${n} photo${n > 1 ? 's' : ''} added: stored under private/, never exported`);
    this.render();
  }
  async addPhotoPath(p) {
    const e = this.ent(); if (!p?.trim()) return;
    try { const j = await op('ref_upload', { type: e.kind, id: e.id, kind: 'photo', name: p.split(/[\\/]/).pop(), path: p.trim() }); this.draft(e).refs.push(j.ref); toast('photo added (private)'); } catch (er) { toast('not added: ' + er.message); }
    this.render();
  }
  // ---------------------------------------------------------------- the sketch tool (base sketch, or an edit over a node)
  async openSketch(kind, node = null) {
    if (this.sk && !(await this.closeSketch())) return;
    const M = await sketchMod(), e = this.ent();
    const id = `sk-${e.id}-${node ? node.id : 'base'}-${Date.now().toString(36).slice(-5)}`.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const cat = this.draft(e).refs.find(r => r.source === 'catalog');
    const under = node ? { src: node.image, opacity: 1, fit: 'contain' } : cat ? { src: '/' + cat.path, opacity: 0.35, fit: 'contain' } : null;
    this.mode = kind === 'edit' ? 'edit' : this.mode;
    this.skHost.innerHTML = `<div class="scskbar"><b>${esc(id)}</b><span class="dim">${node ? `draw over ${esc(node.id)}: pen marks what to change, M = mask the region, P = pin a note (“${esc(this.U.editHint.replace(/^e\.g\. /, '').split(';')[0])}”)` : esc(this.U.sketchHint)}</span><span class="sp"></span><a data-a="skclose">close</a></div><div class="scskbody"></div>`;
    this.sk = { id, kind, node: node?.id || null, saved: null, api: null };
    this.render();
    this.sk.api = M.mountSketch(this.skHost.querySelector('.scskbody'), { id, ...(node ? {} : { w: 1024, h: e.kind === 'location' ? 576 : 1024 }), underlay: under, resolve: imgUrl, title: id,
      save: (sk, png, mask) => this.saveSketch(sk, png, mask) });
    this.sk.api.el.focus({ preventScroll: true });
    return this.sk.api;
  }
  async saveSketch(sk, png, mask) {
    const e = this.ent();
    const j = await op('sketch_save', { id: sk.id, sketch: sk, png: await blobB64(png), mask: mask ? await blobB64(mask) : null, links: { entities: [e.id] }, label: `${e.name} ${this.sk?.node ? 'edit of ' + this.sk.node : 'base sketch'}` });
    if (this.sk?.id === sk.id) { this.sk.saved = { ...j, pins: A.cleanPins(sk.pins) }; this.sk.api.markClean?.(); }
    if (this.sk?.kind === 'base' && !this.draft(e).refs.some(r => r.path === j.png)) { this.draft(e).refs.push({ path: j.png, source: 'sketch', title: `sketch ${sk.id}`, ...(j.private ? { private: true } : {}) }); toast(`sketch ${sk.id} added to the base`); this.render(); }
    return j;
  }
  async closeSketch(force = false) {
    if (!this.sk) return true;
    if (!force && this.sk.api?.dirty && !(await ui.confirm(`Close sketch ${this.sk.id} without saving?`))) return false;
    this.sk.api?.destroy(); this.sk = null; this.skHost.innerHTML = ''; this.skHost.remove(); if (this.mode === 'edit') this.mode = 'view'; this.render(); return true;
  }
  async requestEdit() {
    const e = this.ent(), it = this.iter(e), node = A.nodeById(it, this.sk?.node); if (!node) return toast('open a node and press Edit first');
    if (A.treeState(it, node.tree).approved) return toast('this tree is approved (locked): unlock it first');
    const text = this.$('.chedtext')?.value.trim() || '';
    const sk = this.sk.api.get();
    if (!text && !sk.strokes.length && !sk.pins.length && !sk.mask.length) return toast('say what to change: text, marks on the image, a mask or pins');
    let saved = this.sk.saved;
    if (!saved || this.sk.api.dirty) saved = await this.sk.api.save();
    saved = this.sk.saved || saved;
    const pins = A.cleanPins(sk.pins), mask = !!saved.mask, est = A.estimate('edit', { mask, type: e.kind });
    const r = await store.addRequest({ kind: this.T.req.edit, target: `${e.kind}:${e.id}`, prompt: A.editPromptFor(e.kind, e, node, { text, pins, mask }), refs: [node.image, saved.png, ...(saved.mask ? [saved.mask] : [])], est_cost: est.usd,
      extra: { tool: est.tool, est_why: est.why, ...this.link(e, { id: e.id, tree: node.tree, from: node.id, kind: 'edit', text, sketch: sk.id, png: saved.png, ...(saved.mask ? { mask: saved.mask } : {}), pins }) } });
    toast(`draft request ${r.id}: edit of ${node.id} · est ${usd(est.usd)} · approve it here`);
    await this.closeSketch(true);
  }
  // ---------------------------------------------------------------- rendering
  render() {
    this.pending = false;
    if (!store.entities) return;
    if (!this.ent()) { const f = this.allRows().find(r => r.e); this.cur = f ? f.e.id : null; }
    const e = this.ent();
    if (!this.U.tabs.some(([k]) => k === this.tab)) this.tab = this.U.rootTab;
    if (e && this.tab === this.U.vTab && !this.vlist(e).some(l => l.id === this.vid)) this.vid = this.vlist(e)[0]?.id || null;
    if (this.sel && !A.nodeById(this.iter(), this.sel)) { this.sel = null; this.mode = 'view'; }
    this.renderList(); this.renderBar(); this.renderBody();
  }
  renderList() {
    const sc = SC.currentScript(store.scenes)?.scenes || [];
    const chip = (id) => { const s = sc.find(x => x.id === id); return `<span class="bdsc" title="${esc(s ? `${s.id} · ${SC.span(s.t0, s.t1)} · ${s.title}` : id)}">${esc(id.replace(/^sc/, ''))}</span>`; };
    const row = (r) => {
      if (!r.e) return `<div class="chrow ghost" data-item="${esc(r.item.id)}" title="a breakdown ${esc(r.item.kind)}, not an entity yet: Breakdown > Create entity"><i class="chdot s-none"></i><span class="chnm">${esc(r.item.name)}</span><span class="chst">not an entity</span><a data-a="toitem" data-i="${esc(r.item.id)}">make…</a><div class="chsc">${r.scenes.map(chip).join('')}</div></div>`;
      const st = A.assetStatus(r.e, store.requests, r.e.kind);
      return `<div class="chrow${r.e.id === this.cur ? ' on' : ''}" data-ent="${esc(r.e.id)}"${r.e.kind === 'character' ? ` data-char="${esc(r.e.id)}"` : ''}><i class="chdot s-${st.key}" title="${esc(st.label)}"></i><span class="chnm">${esc(r.e.name || r.e.id)}</span><span class="chst s-${st.key}">${esc(st.label)}</span>${st.waiting ? `<span class="lynb" title="${st.waiting} new node(s): keep / branch / revert">${st.waiting}</span>` : ''}${st.open ? `<span class="chq" title="${st.open} open request(s): draft, approved or running">${st.open} req</span>` : ''}${(() => { const it = A.normIter(r.e.iter), k = (it.base_proposal ? 1 : 0) + (it.proposals || []).filter(x => x.status === 'open').length; return k ? `<span class="chq chpq" title="the agent proposes ${k} thing(s): accept or dismiss">${k} prop</span>` : ''; })()}<div class="chsc">${r.scenes.map(chip).join('') || '<span class="dim">no scenes</span>'}</div></div>`;
    };
    let h = '';
    for (const t of this.types) {
      const rows = this.rows(t), T = A.TYPE[t], n = rows.filter(r => r.e).length, g = rows.length - n;
      h += `<div class="chlh"><b>${T.Titles}</b><span class="dim">${n}${g ? ` + ${g} not yet entities` : ''}</span></div>`
        + (rows.length ? rows.map(row).join('') : `<div class="scempty">No ${T.plural} yet. In the Breakdown stage, “Create entity” on a ${t} item makes one.</div>`);
    }
    this.$('.chlist').innerHTML = h;
  }
  renderBar() {
    const e = this.ent(), bar = this.$('.chbar');
    if (!e) { bar.innerHTML = `<span class="dim">no ${this.types.map(t => t).join(' / ')} selected</span>`; return; }
    const T = this.T, U = this.U, it = this.iter(e), st = A.assetStatus(e, store.requests, e.kind), rA = A.treeState(it, T.root).approved, notes = this.myNotes('open').length;
    const label = (k, l) => k === U.rootTab ? `${l}${rA ? ' ✓' : ''}` : k === U.vTab ? `${l} ${this.vlist(e).length}` : k === 'notes' ? `${l} ${notes || ''}` : k === 'scenes' ? `${l} ${A.sceneUses(e, this.scenesOf(e), [], e.kind).length || ''}` : l;
    const tab = (k, l) => `<a data-tab="${k}" class="${this.tab === k ? 'on' : ''}">${label(k, l)}</a>`;
    const tree = this.tree, tA = A.treeState(it, tree).approved, word = A.isRoot(tree) ? T.rootWord : T.vWord;
    const desc = e.kind === 'character' ? e.role : e.description;
    bar.innerHTML = `${this.types.length > 1 ? `<span class="askind k-${e.kind}">${esc(T.title)}</span>` : ''}<b>${esc(e.name || e.id)}</b><span class="chst s-${st.key}">${esc(st.label)}</span>${desc ? `<span class="dim chrole" title="${esc(desc)}">${esc(desc)}</span>` : ''}`
      + `<span class="bdvw chtabs">${U.tabs.map(([k, l]) => tab(k, l)).join('')}</span><span class="sp"></span>`
      + ((this.tab === U.rootTab || this.tab === U.vTab) && A.treeNodes(it, tree).length ? (tA ? `<span class="chok" title="approved by the director: locked">✓ ${word} approved (${esc(tA)})</span><button data-a="unlock" title="allow changes again (page only)">Unlock</button>`
        : `<button data-a="approve" class="pri" title="the director signs it off and locks it (page only; agents cannot)">Approve ${word}${A.treeState(it, tree).head ? ' (' + esc(A.treeState(it, tree).head) + ')' : ''}</button>`) : '')
      + (this.tab === U.vTab ? `<button data-a="newlook">+ New ${T.vWord}</button>` : '');
  }
  renderBody() {
    const body = this.$('.chbody'), e = this.ent();
    const keep = body.scrollTop;
    if (!e) { body.innerHTML = `<div class="scempty"><b>No ${this.types.join(' or ')} yet.</b> They come from the breakdown (stage 3): open it and use “Create entity” on an item${this.allRows().length ? ', or click “make…” on the left' : ''}.</div>`; return; }
    const U = this.U;
    body.innerHTML = this.tab === 'notes' ? this.notesHtml(e) : this.tab === 'scenes' ? this.scenesHtml(e) : this.tab === U.vTab ? this.variantsHtml(e) : this.rootHtml(e);
    const slot = body.querySelector('.chskslot'); if (slot && this.sk) slot.appendChild(this.skHost);
    body.scrollTop = keep;
    const ab = body.querySelector('.chab'); if (ab) ab.style.setProperty('--ab', this.abPos + '%');
  }
  // the root tab: base (until the first node), requests, the tree, the open node
  rootHtml(e) {
    const T = this.T, it = this.iter(e), nodes = A.treeNodes(it, T.root);
    const reqs = this.reqs(e).filter(r => r.char.tree === T.root);
    return this.proposalHtml(e, it, T.root) + (nodes.length ? `<details class="chbasefold"${this.showBase ? ' open' : ''}><summary>base: ${(e.base?.refs || []).length} refs${e.base?.text ? ' · ' + esc(e.base.text.slice(0, 80)) : ''} <span class="dim">(click to change; a new ${esc(T.sheetWord)} starts a new root)</span></summary>${this.baseHtml(e)}</details>` : this.baseHtml(e))
      + this.reqsHtml(reqs) + this.treeHtml(it, T.root) + this.nodeHtml(e, it);
  }
  // the agent's base proposal (root tab) and its import proposals for this tree: accept / dismiss in one click
  proposalHtml(e, it, tree) {
    // proposals (core/proposals.js): moods / layouts / texts for this look or variant tree (and, on the root tab, for
    // the asset itself); the director picks, the agent reads the pick (proposals_get)
    let h = A.isRoot(tree) ? stripHtml(this.tg('asset'), { quiet: true, label: e.name || e.id }) + stripHtml(this.tg('tree', tree), { quiet: true, label: this.T.rootWord })
      : stripHtml(this.tg('tree', tree), { label: `${this.T.vWord} moods` });
    const bp = A.isRoot(tree) ? it.base_proposal : null;
    if (bp) h += `<div class="chprop base"><div class="chprh"><b>The agent proposes a base</b><span class="dim">${esc(bp.by || 'agent')} · ${when(bp.at)}${e.base ? ' · replaces the current base' : ''}</span><span class="sp"></span><button data-a="bpaccept" class="pri" title="it becomes the base (your act; the agent cannot set it)">Accept base</button><button data-a="bpdismiss">Dismiss</button></div>`
      + (bp.text ? `<div class="chprt">“${esc(bp.text)}”</div>` : '') + ((bp.refs || []).length ? `<div class="chpicked">${bp.refs.map(r => `<span class="chref" title="${esc([r.title, r.source, r.path].filter(Boolean).join(' · '))}">${lock(r.path, r.private)}<img src="${esc(imgUrl(r.path))}" alt=""><span><b>${esc(r.source)}</b></span></span>`).join('')}</div>` : '')
      + (bp.why ? `<div class="dim chprw">why: ${esc(bp.why)}</div>` : '') + '</div>';
    for (const pr of (Array.isArray(it.proposals) ? it.proposals : []).filter(x => x.status === 'open' && x.tree === tree)) {
      const c = pr.provenance?.cost, blocked = !A.isRoot(tree) && !A.approvedNode(it, this.T.root);
      h += `<div class="chprop imp" data-prop="${esc(pr.id)}">${lock(pr.path, pr.private)}<img src="${esc(imgUrl(pr.path))}" alt=""><div class="chprb"><div class="chprh"><b>The agent proposes ${esc(pr.media)} as a node of ${esc(tree)}</b><span class="dim">${esc(pr.id)} · ${when(pr.at)}</span></div>`
        + `<div class="chprt">${esc(pr.why || '')}</div><div class="dim">imported, no request: ${[pr.provenance?.job ? 'job ' + esc(pr.provenance.job) : '', pr.provenance?.request ? 'request ' + esc(pr.provenance.request) : '', c ? `cost on record ${usd(c.usd)} (${esc(c.source)}${c.via ? ' via ' + esc(c.via) : ''})` : 'no cost row found'].filter(Boolean).join(' · ')}</div>`
        + `<div class="chprf"><button data-a="ipaccept" data-p="${esc(pr.id)}" class="pri"${blocked ? ' disabled' : ''} title="${blocked ? esc('approve the ' + this.T.rootWord + ' first') : 'make it a node (the head of this tree); your act'}">Accept as node</button><button data-a="ipdismiss" data-p="${esc(pr.id)}">Dismiss</button>${blocked ? `<span class="dim">approve the ${esc(this.T.rootWord)} first</span>` : ''}</div></div></div>`;
    }
    return h;
  }
  baseHtml(e) {
    const T = this.T, d = this.draft(e), srcs = [['catalog', 'Catalogue'], ['openverse', 'Openverse'], ['text', 'Describe'], ['photos', 'Photos'], ['sketch', 'Sketch']];
    const est = A.estimate(T.gen.root, { type: e.kind }), locked = !!A.treeState(this.iter(e), T.root).approved;
    const picked = d.refs.map((r, i) => `<span class="chref" title="${esc([r.title, r.source, r.licence, r.creator, r.url].filter(Boolean).join(' · '))}">${lock(r.path, r.private)}<img src="${esc(imgUrl(r.path))}" alt=""><span><b>${esc(r.source)}</b>${r.licence ? ' · ' + esc(r.licence) : ''}${r.creator ? ' · ' + esc(r.creator) : ''}</span><b data-a="rmref" data-i="${i}" title="remove">×</b></span>`).join('');
    return `<div class="chbase"><div class="chbh"><b>Base</b><span class="dim">${esc(this.U.baseWhat)}</span><span class="bdvw chsrc">${srcs.map(([k, l]) => `<a data-src="${k}" class="${this.src === k ? 'on' : ''}">${l}</a>`).join('')}</span></div>`
      + `<div class="chsrcbody">${this.srcHtml(e, d)}</div>`
      + `<div class="chpicked"><span class="dim">base:</span>${picked || '<span class="dim">no references yet</span>'}${d.text ? `<span class="chtxt" title="${esc(d.text)}">“${esc(d.text.slice(0, 120))}”</span>` : ''}</div>`
      + `<div class="chbf">${this.baseDirty(e) ? '<span class="unsaved">unsaved base</span><button data-a="savebase">Save base</button>' : ''}<button data-a="reqid" class="pri"${locked ? ' disabled' : ''} title="${esc(`a DRAFT generation request (nothing runs or is paid until you approve it): ${est.tool}, ${est.why}`)}">Request ${esc(T.sheetWord)} · est ${usd(est.usd)}</button><span class="dim">${esc(est.tool)}</span></div></div>`;
  }
  srcHtml(e, d) {
    const has = (p) => d.refs.some(r => r.path === p), U = this.U;
    if (this.src === 'catalog') {
      if (!this.cat) { this.loadCatalog(); return '<span class="dim">loading the catalogue…</span>'; }
      const kind = this.catKind[e.kind] || A.TYPE[e.kind].catKind;
      const q = this.catQ.toLowerCase(), items = this.cat.items.filter(x => (kind === 'all' || x.kind === kind) && !(x.tags || []).includes('unclothed-schematic') && (!q || `${x.title} ${(x.tags || []).join(' ')}`.toLowerCase().includes(q)));
      return `<div class="chsrcbar"><select class="chcatkind">${['all', ...this.cat.kinds].map(k => `<option${k === kind ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select><input class="chcatq" placeholder="filter (tags, title)" value="${esc(this.catQ)}" spellcheck="false"><span class="dim">${items.length} items · CC0 / public domain (catalog/LICENSES.md)</span></div>`
        + `<div class="chgrid">${items.slice(0, 80).map(x => `<div class="chtile${has('catalog/' + x.file) ? ' on' : ''}" data-cat="${esc(x.id)}" title="${esc(`${x.title}\n${x.licence} · ${x.author}\n${x.source}`)}"><img src="${esc('/catalog/' + x.file)}" alt="" loading="lazy"><span>${esc(x.title)}</span></div>`).join('')}</div>`;
    }
    if (this.src === 'openverse') {
      const res = this.ov.res;
      const people = e.kind === 'character' && (res || []).some(x => x.category === 'photograph');
      return `<div class="chsrcbar"><input class="chovq" placeholder="${esc(U.ovHint)}" value="${esc(this.ov.q)}" spellcheck="false"><select class="chovlic" title="licences"><option value="cc0,pdm"${this.ov.lic === 'cc0,pdm' ? ' selected' : ''}>CC0 + public domain</option><option value="cc0,pdm,by"${this.ov.lic !== 'cc0,pdm' ? ' selected' : ''}>+ CC BY (credit)</option></select><button data-a="ovsearch"${this.ov.busy ? ' disabled' : ''}>Search</button><span class="dim chovmsg">${esc(this.ov.msg || 'searched from your browser, straight at api.openverse.org (20 a minute)')}</span></div>`
        + (people ? '<div class="chwarn">A free licence does not cover a person\'s likeness: use a photo of a person as a pose or wardrobe guide, not as an identity.</div>' : '')
        + `<div class="chgrid">${(res || []).map(x => `<div class="chtile ov" data-ov="${esc(x.id)}" title="${esc(`${x.title || ''}\n${x.license} ${x.license_version || ''} · ${x.creator || '?'} · ${x.source || ''}\n${x.foreign_landing_url || ''}`)}"><img src="${esc(x.thumbnail || '')}" alt="" loading="lazy" referrerpolicy="no-referrer"><span><b class="chlic">${esc(String(x.license || '').toUpperCase())}</b> ${esc(x.creator || x.source || '')}</span></div>`).join('')}</div>`;
    }
    if (this.src === 'text') return `<textarea class="chbtext" rows="4" placeholder="${esc(U.describe)}" spellcheck="false">${esc(d.text)}</textarea>`;
    if (this.src === 'photos') return `<div class="chsrcbar"><label class="chfile"><input type="file" class="chphotos" accept="image/png,image/jpeg,image/webp,image/gif" multiple><b>Upload photos…</b></label><span class="dim">or a file on this machine</span><input class="chppath" placeholder="C:\\photos\\${e.kind === 'character' ? 'friend' : e.kind === 'location' ? 'place' : 'object'}.jpg" spellcheck="false"><button data-a="ppath">Add</button></div>`
      + `<div class="chwarn priv">${U.photoWarn}</div>`;
    if (this.src === 'sketch') return this.sk?.kind === 'base' ? '<div class="chskslot"></div>' : `<div class="chsrcbar"><button data-a="skbase">Draw a sketch…</button><span class="dim">${esc(U.sketchHint)}: the sketch becomes a reference</span></div>`;
    return '';
  }
  reqsHtml(reqs) {
    if (!reqs.length) return '';
    const it = this.iter(), T = this.T;
    const rows = [...reqs].reverse().map(r => {
      const i = r.status === 'rejected' ? -1 : r.status === 'queued' ? 1 : STEPS.indexOf(r.status), nodes = it.nodes.filter(n => n.request === r.id);
      const steps = STEPS.map((s, k) => `<span class="chstep${k <= i ? ' done' : ''}${k === i ? ' cur' : ''}">${s}</span>`).join('<i>›</i>');
      const act = r.status === 'draft' ? `<button data-a="reqok" data-r="${esc(r.id)}" class="pri" title="approve: the agent may run it and spend up to the estimate (page only)">Approve ${usd(r.est_cost)}</button><button data-a="reqno" data-r="${esc(r.id)}">Reject</button>`
        : ['approved', 'queued'].includes(r.status) ? '<span class="dim">approved: Run it in Review › Queue (or the agent: request_run)</span>' : r.status === 'running' ? '<span class="dim">running…</span>'
        : r.status === 'done' ? (nodes.length ? `<span>→ ${nodes.map(n => `<a data-node="${esc(n.id)}">${esc(n.id)}</a>`).join(' ')}</span>` : '<span class="dim">done · the agent registers the output</span>') : `<span class="dim">${esc(r.why || '')}</span>`;
      const vid = A.treeVariant(r.char.tree), vname = r.look?.name || r.variant?.name || vid;
      const warns = (r.warnings || []).length ? `<div class="chreqw">${r.warnings.map(w => `<span>⚠ ${esc(w)}</span>`).join('')}</div>` : '';
      return `<div class="chreq s-${esc(r.status)}${warns ? ' warn' : ''}" data-r="${esc(r.id)}"><b>${esc(r.kind)}</b><span class="dim">${esc(r.id)}${r.char.from ? ' · from ' + esc(r.char.from) : ''}</span><span class="chsteps">${r.status === 'rejected' ? '<span class="chstep cur rej">rejected</span>' : steps}</span><span class="chreqt" title="${esc(r.prompt)}">${esc(r.char.text || (vid && r.char.kind !== 'edit' ? `${T.vWord} sheet “${vname}” from ${r.char.from}` : r.prompt))}</span>${r.char.pins?.length ? `<span class="dim">${r.char.pins.length} pin${r.char.pins.length > 1 ? 's' : ''}</span>` : ''}${r.char.mask ? '<span class="dim">mask</span>' : ''}<span class="dim">${usd(r.est_cost)}${r.actual_cost_usd != null ? ' / ' + usd(r.actual_cost_usd) : ''}</span>${act}${warns}</div>`;
    });
    return `<div class="chreqs"><div class="chsh">requests <span class="dim">request → approve (you) → Run (Review › Queue, or the agent) → a new node</span></div>${rows.join('')}</div>`;
  }
  nodeWord(n) { return { identity: 'identity sheet', sheet: 'identity sheet', base: this.T.sheetWord, look: 'look sheet', variant: 'variant sheet' }[n.kind] || ''; }
  treeHtml(it, tree) {
    const strips = A.branches(it, tree), st = A.treeState(it, tree), T = this.T;
    const imp = A.treeState(it, tree).approved ? '' : `<button data-a="importimg" data-tree="${esc(tree)}" title="make any registered image (a legacy look, an output made outside the queue) a node of this tree: no request, nothing paid">Import an image…</button>`;
    if (!strips.length) return `<div class="chtree empty"><span class="dim">no ${A.isRoot(tree) ? T.sheetWord : T.vWord + ' sheet'} yet${this.reqs().some(r => r.char.tree === tree && A.OPEN_REQ.includes(r.status)) ? ': requested' : ''}</span>${imp}</div>`;
    const open = this.reqs().filter(r => r.char.tree === tree && A.OPEN_REQ.includes(r.status));
    const card = (n) => {
      const cls = [n.id === st.head ? 'head' : '', n.id === st.approved ? 'appr' : '', A.pending(it, n) ? 'new' : '', n.choice === 'reverted' ? 'rev' : '', n.choice === 'branch' ? 'br' : '', n.id === this.sel ? 'on' : ''].filter(Boolean).join(' ');
      const ghosts = open.filter(r => r.char.from === n.id).map(r => `<span class="chghost" title="${esc(r.char.text || r.prompt)}">${esc(r.status)}</span>`).join('');
      return `<div class="chnode ${cls}" data-node="${esc(n.id)}" title="${esc(`${n.id}${n.edit?.text ? ': ' + n.edit.text : ''}\n${n.choice || (A.pending(it, n) ? 'new: keep, branch or revert' : '')}${n.id === st.head ? '\nhead' : ''}${n.id === st.approved ? '\napproved' : ''}`)}">${lock(n.image, n.private)}<img src="${esc(imgUrl(n.image))}" alt="" loading="lazy"><span class="chnl"><b>${esc(n.id)}</b>${n.id === st.approved ? '<i class="ok">✓</i>' : n.id === st.head ? '<i class="hd">●</i>' : A.pending(it, n) ? '<i class="nw">new</i>' : ''}${n.edit?.pins?.length ? `<i class="pn">${n.edit.pins.length}📌</i>` : ''}${n.origin === 'imported' ? '<i class="im" title="imported: an existing image, no request">⇩</i>' : ''}</span><span class="chne">${esc(n.edit?.text || this.nodeWord(n))}</span>${ghosts}</div>`;
    };
    return `<div class="chtree"><div class="chsh">tree <span class="dim">${nn(A.treeNodes(it, tree).length, 'node')} · ${strips.length} branch${strips.length > 1 ? 'es' : ''} · ● head ✓ approved · ⇩ imported · click a node</span>${imp}</div>`
      + strips.map((s, i) => `<div class="chstrip"><span class="chfork">${s.fork ? `↳ ${esc(s.fork)}` : i ? 'root' : 'main'}</span>${s.nodes.map(card).join('<i class="charr">›</i>')}</div>`).join('') + '</div>';
  }
  nodeHtml(e, it) {
    const n = A.nodeById(it, this.sel); if (!n) return '';
    const parent = A.nodeById(it, n.parent) || A.nodeById(it, n.from_identity), st = A.treeState(it, n.tree), locked = !!st.approved;
    const isPending = A.pending(it, n), word = A.isRoot(n.tree) ? this.T.rootWord : this.T.vWord;
    const head = `<div class="chnh"><b>${esc(n.id)}</b><span class="dim">${esc(n.kind)} · ${n.via === 'agent' ? 'agent' : esc(n.by || '')} · ${when(n.at)} · ${esc(n.request || (n.origin === 'imported' ? 'imported' : ''))}</span>${n.id === st.head ? '<span class="chok">head</span>' : ''}${n.choice ? `<span class="dim">${esc(n.choice)}</span>` : ''}<span class="sp"></span>`
      + (parent ? `<button data-a="cmp" class="${this.mode === 'compare' ? 'on' : ''}" title="side by side with ${esc(parent.id)}">Compare with ${esc(parent.id)}</button>` : '')
      + (!locked ? `<button data-a="edit" class="${this.mode === 'edit' ? 'on' : ''}" title="text + a sketch over this image + an optional mask + pins → a draft request">Edit from ${esc(n.id)}</button>` : '')
      + (!locked && n.id !== st.head && !isPending ? `<button data-a="tohead" title="continue from this node (revert to it)">Make head</button>` : '')
      + (!locked && n.id === st.head && A.treeNodes(it, n.tree).length ? `<button data-a="approve" class="pri">Approve ${word}</button>` : '')
      + `<button data-a="nnote" title="a note on this node, in the Notes column (Alt+N)">✉</button><button data-a="pinnote" class="${this.pinMode ? 'on' : ''}" title="pin a note on the image: click here, then on the image">📍 pin</button><b class="sctool" data-a="nclose" title="close (Esc)">▴</b></div>`;
    const pv = n.provenance, prov = n.origin === 'imported' ? `<div class="chnedit"><span class="dim">imported (no request):</span> ${esc(pv?.media || '')} <span class="dim">${esc(pv?.path || '')}</span>${pv?.job ? ` · job ${esc(pv.job)}` : ''}${pv?.request ? ` · request ${esc(pv.request)}` : ''} · ${pv?.cost ? `cost on record ${usd(pv.cost.usd)} (${esc(pv.cost.source)}${pv.cost.via ? ' via ' + esc(pv.cost.via) : ''})` : 'no cost row'}${n.proposal ? ` · proposed by ${esc(n.proposed_by || 'agent')} (${esc(n.proposal)})` : ''}${n.note ? ` · ${esc(n.note)}` : ''}</div>` : '';
    const edit = n.edit && (n.edit.text || n.edit.pins?.length || n.edit.png || n.edit.mask) ? `<div class="chnedit"><span class="dim">edit:</span> ${esc(n.edit.text || '(sketch only)')}${(n.edit.pins || []).map(p => `<span class="chpin"><b>${p.n}</b>${esc(p.text)}</span>`).join('')}${n.edit.png ? ` <a href="${esc(imgUrl(n.edit.png))}" target="_blank" rel="noopener">sketch</a>` : ''}${n.edit.mask ? ` <a href="${esc(imgUrl(n.edit.mask))}" target="_blank" rel="noopener">mask</a>` : ''}${n.note ? `<span class="dim"> · agent: ${esc(n.note)}</span>` : ''}</div>` : '';
    let main = '';
    if (this.mode === 'edit' && this.sk?.node === n.id) {
      const est = A.estimate('edit', { mask: !!this.sk.api?.get().mask.length, type: e.kind });
      main = `<div class="chedit"><div class="chskslot"></div><div class="chedside"><b>What to change</b><textarea class="chedtext" rows="5" placeholder="${esc(this.U.editHint)}" spellcheck="false">${esc(this.edText || '')}</textarea>
        <div class="dim">Draw on the image to show where; <b>M</b> paints a mask (only that region changes); <b>P</b> pins a numbered note. Every mark goes with the request.</div>
        <button data-a="reqedit" class="pri" title="${esc(`${est.tool}: ${est.why}`)}">Request edit · est ${usd(est.usd)}</button><span class="dim">${esc(est.tool)}</span><a data-a="skclose">cancel</a></div></div>`;
    } else if ((this.mode === 'compare' || isPending) && parent) {
      main = this.compareHtml(parent, n, isPending && !locked);
    } else {
      const pins = this.nodePins(n.id).map((x, i) => `<i class="chnpin${x.status === 'open' ? '' : ' done'}" data-nid="${esc(x.id)}" style="left:${(x.target.pin.x * 100).toFixed(2)}%;top:${(x.target.pin.y * 100).toFixed(2)}%" title="${esc(`${i + 1}: ${x.text}`)}">${i + 1}</i>`).join('');
      main = `<div class="chbig">${lock(n.image, n.private)}<span class="chpinw${this.pinMode ? ' pinning' : ''}" title="${this.pinMode ? 'click where the note goes' : ''}"><img src="${esc(imgUrl(n.image))}" alt="">${pins}</span></div>`;
    }
    return `<div class="chnp" data-node="${esc(n.id)}">${head}${prov}${edit}${main}</div>`;
  }
  compareHtml(a, b, choose) {
    const md = this.ab, img = (n) => `<img src="${esc(imgUrl(n.image))}" alt="">`;
    const modes = `<span class="bdvw">${[['slider', 'Slider'], ['toggle', 'Toggle'], ['side', 'Side by side']].map(([k, l]) => `<a data-ab="${k}" class="${md === k ? 'on' : ''}">${l}</a>`).join('')}</span>`;
    const bar = `<div class="chcmpbar"><span>A <b>${esc(a.id)}</b> → B <b>${esc(b.id)}</b>${b.edit?.text ? ': ' + esc(b.edit.text) : ''}</span>${modes}<span class="sp"></span>`
      + (choose ? `<button data-a="keep" class="pri" title="B becomes the head">Keep ${esc(b.id)}</button><button data-a="branch" title="keep B on a side branch; the head stays ${esc(a.id)}">Branch</button><button data-a="revert" title="drop B; the head stays ${esc(a.id)}">Revert</button>` : '') + '</div>';
    let view;
    if (md === 'side') view = `<div class="chside"><div><span class="chlab">A ${esc(a.id)}</span>${img(a)}</div><div><span class="chlab">B ${esc(b.id)}</span>${img(b)}</div></div>`;
    else if (md === 'toggle') view = `<div class="chab toggle" data-show="${this.abShow}"><div class="chabA">${img(a)}</div><div class="chabB">${img(b)}</div><span class="chlab">${this.abShow === 'A' ? 'A ' + esc(a.id) : 'B ' + esc(b.id)}</span><button data-a="abflip" class="chflip" title="switch A / B">A ⇄ B</button></div>`;
    else view = `<div class="chab slider"><div class="chabB">${img(b)}</div><div class="chabA">${img(a)}</div><i class="chabline"></i><span class="chlab l">A ${esc(a.id)}</span><span class="chlab r">B ${esc(b.id)}</span><input type="range" class="chabr" min="0" max="100" value="${this.abPos}" aria-label="A/B position"></div>`;
    return `<div class="chcmp">${bar}${view}</div>`;
  }
  // the variants tab: one card per variant (looks for a character), the new-variant form, the open variant's tree
  variantsHtml(e) {
    const T = this.T, it = this.iter(e), rn = A.approvedNode(it, T.root), vs = this.vlist(e), isC = e.kind === 'character';
    const uses = A.sceneUses(e, this.scenesOf(e), SC.currentScript(store.scenes)?.scenes || [], e.kind);
    const card = (l) => {
      const t = A.variantTree(e.kind, l.id), h = A.headNode(it, t), ap = A.treeState(it, t).approved, sc = uses.filter(u => u.variant === l.id).map(u => u.scene);
      const sub = isC ? esc((l.garments || []).join(', ')) : l.name === A.axesName(l.axes) ? '' : Object.entries(l.axes || {}).map(([k, v]) => `<i class="asax-${esc(k)}" title="${esc(A.AXES[k]?.label || k)}">${esc(v)}</i>`).join('');
      const from = l.from === 'breakdown' || l.breakdown ? 'from the breakdown' : l.from === 'agent' ? 'proposed by the agent' : '';
      return `<div class="chlook${l.id === this.vid ? ' on' : ''}" data-look="${esc(l.id)}">${h ? `${lock(h.image, h.private)}<img src="${esc(imgUrl(h.image))}" alt="">` : (l.images || [])[0] ? `<img src="${esc(imgUrl(l.images[0]))}" alt="">` : '<div class="chnoimg">no sheet yet</div>'}<span class="chln"><b>${esc(l.name || l.id)}</b> <span class="bdst s-${l.status === 'approved' ? 'ok' : l.status === 'review' ? 'review' : 'draft'}"><i></i>${esc(l.status || 'draft')}</span></span><span class="dim chlg">${[sub, from].filter(Boolean).join(' · ')}</span><span class="dim">${nn(A.treeNodes(it, t).length, 'node')}${ap ? ' · ✓' : ''}${(it.proposals || []).some(x => x.status === 'open' && x.tree === t) ? ' · <b class="chpq">proposal</b>' : ''}${sc.length ? ` · ${sc.map(s => esc(s.replace(/^sc/, '#'))).join(' ')}` : ''}</span></div>`;
    };
    let ghosts = '';
    if (isC) {
      const { b, items } = this.bdItems(), myItem = Object.entries(b.states || {}).find(([, s]) => s.entity_id === e.id)?.[0];
      ghosts = items.filter(i => i.kind === 'wardrobe' && i.for && i.for === myItem && !b.states?.[i.id]?.entity_id)
        .map(i => `<div class="chlook ghost" data-witem="${esc(i.id)}" title="a wardrobe item of the breakdown for ${esc(e.name)}: a draft look to start"><div class="chnoimg">wardrobe</div><span class="chln"><b>${esc(i.name)}</b></span><span class="dim chlg">${esc(i.links.map(x => x.scene).join(' '))}</span><a data-a="mklook" data-i="${esc(i.id)}">make it a look</a></div>`).join('');
    }
    let h = rn ? '' : `<div class="chwarn">Approve the ${T.rootWord} first (${cap(this.U.rootTab)} tab): every ${T.vWord} starts from the approved ${T.sheetWord}. You can prepare ${T.vWords} now.</div>`;
    h += `<div class="chlooks">${vs.map(card).join('')}${ghosts}<div class="chlook add" data-a="newlook"><span class="plus">+</span><b>New ${T.vWord}</b><span class="dim">${isC ? 'name, garments' : T.axes.map(a => A.AXES[a].label).join(', ')}</span></div></div>`;
    if (this.vf && !isC) h += this.variantFormHtml(e);
    const l = vs.find(x => x.id === this.vid);
    if (l) {
      const t = A.variantTree(e.kind, l.id), est = A.estimate(T.gen.variant, { type: e.kind }), nodes = A.treeNodes(it, t), reqs = this.reqs(e).filter(r => r.char.tree === t);
      const info = isC ? esc((l.garments || []).join(', ')) : esc(A.axesText(l.axes) || '');
      h += `<div class="chsh lookh"><b>${esc(l.name)}</b><span class="dim">${info}${l.notes ? ' · ' + esc(l.notes) : ''}${!isC && l.scenes?.length ? ' · proposed for ' + esc(l.scenes.join(' ')) : ''}</span>${!nodes.length ? `<button data-a="reqlook" class="pri"${rn ? '' : ' disabled'} title="${esc(`a DRAFT request from the approved ${T.rootWord}: ${est.tool}, ${est.why}`)}">Request ${T.vWord} sheet · est ${usd(est.usd)}</button>` : ''}</div>`;
      h += this.proposalHtml(e, it, t) + this.reqsHtml(reqs) + this.treeHtml(it, t) + this.nodeHtml(e, it);
    }
    return h;
  }
  variantFormHtml(e) {
    const T = this.T, f = this.vf, ax = A.cleanAxes(e.kind, f.axes);
    const row = (k) => { const X = A.AXES[k], v = f.axes[k] || '', custom = v && !X.opts.includes(v);
      return `<div class="asax"><span class="asaxl">${esc(X.label)}</span><a data-ax="${k}" data-v="" class="${v ? '' : 'on'}">any</a>${X.opts.map(o => `<a data-ax="${k}" data-v="${esc(o)}" class="${v === o ? 'on' : ''}">${esc(o)}</a>`).join('')}${X.custom ? `<input class="asaxc${custom ? ' on' : ''}" data-ax="${k}" placeholder="custom" value="${custom ? esc(v) : ''}" spellcheck="false">` : ''}</div>`; };
    return `<div class="asvf"><div class="chsh"><b>New ${T.vWord}</b><span class="dim">its own tree, from the approved ${esc(T.sheetWord)} · pick any axes</span></div>${T.axes.map(row).join('')}`
      + `<div class="asvff"><input class="asvname" placeholder="name: ${esc(A.axesName(ax) || 'e.g. Pier at night')}" value="${esc(f.name)}" spellcheck="false"><input class="asvnotes" placeholder="notes for the prompt (optional): e.g. neon reflections on the wet ground" value="${esc(f.notes)}" spellcheck="false"><button data-a="vcreate" class="pri">Create ${T.vWord}</button><a data-a="vcancel">cancel</a><span class="dim">id: ${esc(A.axesId(ax) || '…')}</span></div></div>`;
  }
  // the scenes tab: the scenes that use this asset (breakdown links) and the variant each needs (the director's pick)
  scenesHtml(e) {
    const T = this.T, sc = SC.currentScript(store.scenes)?.scenes || [], vs = this.vlist(e), it = this.iter(e);
    const uses = A.sceneUses(e, this.scenesOf(e), sc, e.kind);
    const thumb = (vid) => { const p = A.variantImage(e, vid, e.kind); return p ? `<img src="${esc(imgUrl(p))}" alt="" loading="lazy">` : '<span class="chnoimg">no sheet</span>'; };
    const src = { director: '<span class="who dr">you</span>', agent: '<span class="who ag">agent</span>', default: `<span class="dim">default</span>` };
    const opts = (u) => `<option value=""${u.variant ? '' : ' selected'}>${esc(cap(T.rootWord))}${A.treeState(it, T.root).approved ? ' ✓' : ''}</option>`
      + vs.map(v => `<option value="${esc(v.id)}"${u.variant === v.id ? ' selected' : ''}>${esc(v.name || v.id)}${v.status === 'approved' ? ' ✓' : ''}</option>`).join('')
      + (u.source === 'director' ? '<option value="__clear">(clear my pick)</option>' : '');
    const text = (id) => sc.find(s => s.id === id)?.text || '';
    const rows = uses.map(u => `<div class="asuse" data-scene="${esc(u.scene)}"><span class="bdsc">${esc(u.scene.replace(/^sc/, ''))}</span><span class="dim asut">${u.missing ? 'not in the script' : esc(SC.span(u.t0, u.t1))}</span><span class="asutl" title="${esc(u.title || '')}">${esc(u.title || u.scene)}</span>`
      + `<span class="asuth">${thumb(u.variant)}</span><select class="asusesel" data-scene="${esc(u.scene)}" title="the ${esc(T.vWord)} this scene needs">${opts(u)}</select><span class="asusrc">${src[u.source]}</span><span class="dim asutx" title="${esc(text(u.scene))}">${esc(text(u.scene))}</span></div>`).join('');
    const others = sc.filter(s => !uses.some(u => u.scene === s.id));
    return `<div class="chsh">scenes <span class="dim">which ${esc(T.vWord)} each scene needs · the storyboard reads it · from the breakdown links and your picks</span></div>`
      + (rows || `<div class="scempty">No scene uses ${esc(e.name)} yet: link it in the Breakdown, or add a scene here.</div>`)
      + (others.length ? `<div class="asuse add"><span class="dim">add a scene</span><select class="asuseadd"><option value="">…</option>${others.map(s => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(SC.span(s.t0, s.t1))} · ${esc(s.title)}</option>`).join('')}</select></div>` : '');
  }
  // the Notes tab: one row per thing this asset's notes are on (the Notes column holds the notes), then the history
  notesHtml(e) {
    const it = this.iter(e), seen = new Map();
    for (const n of this.myNotes()) { if (n.target.kind === 'asset') continue; const k = `${n.target.kind}|${n.target.id}`; if (!seen.has(k)) seen.set(k, n.target); }
    const label = (t) => { const s = N.splitId(t.id)[1]; return t.kind === 'node' ? `node ${s}${A.nodeById(it, s) ? ' · ' + (A.nodeById(it, s).tree) : ' · gone'}` : t.kind === 'tree' ? `tree ${s}` : t.kind === 'use' ? `in scene ${s}` : t.kind; };
    const rows = [...seen.values()].map(t => `<div class="chnrow" data-tk="${esc(t.kind)}|${esc(t.id)}"><span>${esc(label(t))}</span>${t.kind === 'node' && A.nodeById(it, N.splitId(t.id)[1]) ? `<a data-node="${esc(N.splitId(t.id)[1])}">open</a>` : ''}</div>`).join('');
    return `<div class="chnotes"><div class="chsh">notes <span class="dim">on ${esc(e.name)} (top row of the Notes column), its trees, nodes and scenes · click a cell to write · Alt+N on the open node</span></div>${rows || '<div class="dim lyno">No notes on its trees, nodes or scenes yet.</div>'}`
      + `<div class="chsh">history <span class="dim">(every act, newest first)</span></div>` + it.log.slice(-30).reverse().map(x => `<div class="chlog"><span class="dim">${when(x.at)}</span> ${x.via === 'agent' ? 'agent' : 'director'} <b>${esc(x.act)}</b> ${esc(x.tree || '')} ${esc(x.node || '')} <span class="dim">${esc(x.detail || '')}</span></div>`).join('') + '</div>';
  }
  // ---------------------------------------------------------------- events
  async select(id) { if (id === this.cur) return; if (this.sk && !(await this.closeSketch())) return; this.cur = id; prefs.set(this.pf + 'Cur', id); this.sel = null; this.mode = 'view'; this.vid = null; this.vf = null; this.render(); }
  selectChar(id) { return this.select(id); }
  setTab(t) { this.tab = t; prefs.set(this.pf + 'Tab', t); this.sel = null; this.mode = 'view'; this.render(); }
  openNode(id, mode) {
    const n = A.nodeById(this.iter(), id); if (!n) return;
    if (n.tree !== this.tree) { if (A.isRoot(n.tree)) this.tab = this.U.rootTab; else { this.tab = this.U.vTab; this.vid = A.treeVariant(n.tree); } }
    this.sel = id; this.mode = mode || (A.pending(this.iter(), n) ? 'compare' : 'view'); this.render();
    this.el.querySelector('.chnp')?.scrollIntoView({ block: 'nearest' });
  }
  wire() {
    const el = this.el;
    el.addEventListener('click', async (ev) => {
      const t = ev.target, a = t.closest('[data-a]')?.dataset.a;
      const row = t.closest('.chrow[data-ent]'); if (row) return this.select(row.dataset.ent);
      if (a === 'toitem') { await WB().stages.open('breakdown'); return WB().breakdown?.focus(t.closest('[data-i]').dataset.i); }
      const tab = t.closest('.chtabs [data-tab]'); if (tab) return this.setTab(tab.dataset.tab);
      const src = t.closest('.chsrc [data-src]'); if (src) { this.src = src.dataset.src; prefs.set(this.pf + 'Src', this.src); return this.render(); }
      const abm = t.closest('[data-ab]'); if (abm) { this.ab = abm.dataset.ab; prefs.set(this.pf + 'AB', this.ab); return this.render(); }
      const axl = t.closest('.asax a[data-ax]'); if (axl && this.vf) { this.vf.axes[axl.dataset.ax] = axl.dataset.v; return this.render(); }
      if (t.closest('.chbasefold > summary')) { this.showBase = !t.closest('details').open; return; }
      if (a === 'abflip') { this.abShow = this.abShow === 'A' ? 'B' : 'A'; return this.render(); }
      if (a === 'approve') return this.approveTree(this.tree, this.sel && A.nodeById(this.iter(), this.sel)?.tree === this.tree ? this.sel : undefined);
      if (a === 'unlock') return this.unlock();
      if (a === 'newlook') return this.newVariant();
      if (a === 'vcreate') return this.createVariant();
      if (a === 'vcancel') { this.vf = null; return this.render(); }
      if (a === 'mklook') return this.makeLookFromItem(t.dataset.i);
      if (a === 'reqlook') return this.requestVariant();
      if (a === 'savebase') return this.saveBase();
      if (a === 'reqid') return this.requestRoot();
      if (a === 'rmref') { this.draft().refs.splice(Number(t.dataset.i), 1); return this.render(); }
      if (a === 'ovsearch') return this.searchOpenverse(this.$('.chovq')?.value);
      if (a === 'ppath') return this.addPhotoPath(this.$('.chppath')?.value);
      if (a === 'skbase') return this.openSketch('base');
      if (a === 'skclose') return this.closeSketch();
      if (a === 'bpaccept') return this.acceptBase();
      if (a === 'bpdismiss') return this.dismissBase();
      if (a === 'ipaccept') return this.acceptImport(t.dataset.p);
      if (a === 'ipdismiss') return this.dismissImport(t.dataset.p);
      if (a === 'importimg') return this.importImage(t.dataset.tree);
      if (a === 'reqok') return this.approveReq(t.dataset.r);
      if (a === 'reqno') return this.rejectReq(t.dataset.r);
      if (a === 'reqedit') return this.requestEdit();
      if (a === 'edit') { this.edText = ''; return this.openSketch('edit', A.nodeById(this.iter(), this.sel)); }
      if (a === 'cmp') { this.mode = this.mode === 'compare' ? 'view' : 'compare'; return this.render(); }
      if (a === 'keep' || a === 'branch' || a === 'revert') return this.choose(this.sel, { keep: 'kept', branch: 'branch', revert: 'reverted' }[a]);
      if (a === 'tohead') { await this.act('head', { node: this.sel }); return toast(`${this.sel} is the head`); }
      if (a === 'nclose') { if (this.sk) await this.closeSketch(); this.sel = null; this.mode = 'view'; return this.render(); }
      if (a === 'nnote') return this.nc.edit(this.tg('node', this.sel));
      if (a === 'pinnote') { this.pinMode = !this.pinMode; if (this.mode !== 'view') this.mode = 'view'; return this.render(); }
      // pin mode: a click on the open node's image pins a note there (x, y as fractions of the image)
      const pimg = this.pinMode && t.closest('.chpinw img');
      if (pimg) { const r = pimg.getBoundingClientRect(); this.pinMode = false; this.render(); return this.nc.edit(this.tg('node', this.sel, { pin: { x: +((ev.clientX - r.left) / r.width).toFixed(4), y: +((ev.clientY - r.top) / r.height).toFixed(4) } })); }
      const pin = t.closest('.chnpin[data-nid]'); if (pin) { const c = this.nc.layer.querySelector(`[data-nid="${CSS.escape(pin.dataset.nid)}"]`); c?.scrollIntoView({ block: 'nearest' }); c?.classList.add('flash'); setTimeout(() => c?.classList.remove('flash'), 1200); return; }
      const cat = t.closest('[data-cat]'); if (cat) { const x = this.cat.items.find(i => i.id === cat.dataset.cat); return this.toggleRef({ path: 'catalog/' + x.file, source: 'catalog', title: x.title, licence: x.licence, creator: x.author, url: x.source, catalog_id: x.id }); }
      const ov = t.closest('[data-ov]'); if (ov) return this.useOpenverse(ov.dataset.ov);
      const lk = t.closest('.chlook[data-look]'); if (lk) { this.vid = lk.dataset.look; this.sel = null; this.mode = 'view'; return this.render(); }
      const nd = t.closest('[data-node]'); if (nd && !t.closest('.chnp')) return this.openNode(nd.dataset.node);
      if (nd && t.closest('.chreq')) return this.openNode(nd.dataset.node);
    });
    el.addEventListener('input', (ev) => {
      const t = ev.target;
      if (t.matches('.chabr')) { this.abPos = Number(t.value); t.closest('.chab').style.setProperty('--ab', this.abPos + '%'); return; }
      if (t.matches('.chbtext')) { this.draft().text = t.value; this.$('.chbf') && (this.$('.chbf').querySelector('.unsaved') || this.renderBodyLater()); return; }
      if (t.matches('.chcatq')) { this.catQ = t.value; clearTimeout(this._cq); this._cq = setTimeout(() => { const pos = t.selectionStart; this.render(); const n = this.$('.chcatq'); n?.focus(); n?.setSelectionRange(pos, pos); }, 250); }
      if (t.matches('.chedtext')) this.edText = t.value;
      if (this.vf && t.matches('.asaxc')) this.vf.axes[t.dataset.ax] = t.value;
      if (this.vf && t.matches('.asvname')) this.vf.name = t.value;
      if (this.vf && t.matches('.asvnotes')) this.vf.notes = t.value;
    });
    el.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.matches('.chcatkind')) { this.catKind[this.type] = t.value; return this.render(); }
      if (t.matches('.chovlic')) { this.ov.lic = t.value; return; }
      if (t.matches('.chphotos')) return this.addPhotos([...t.files]);
      if (t.matches('.asusesel')) { t.blur(); return this.setUse(t.dataset.scene, t.value); }
      if (t.matches('.asuseadd') && t.value) { t.blur(); return this.setUse(t.value, ''); }
      if (t.matches('.asaxc') && this.vf) { t.blur(); return this.render(); }
    });
    el.addEventListener('keydown', (ev) => {
      const t = ev.target;
      if (this.sk?.api?.el.contains(t)) return;
      if (t.matches('.chovq')) { ev.stopPropagation(); if (ev.key === 'Enter') this.searchOpenverse(t.value); return; }
      if (t.matches('.asvname, .asvnotes, .asaxc')) { ev.stopPropagation(); if (ev.key === 'Enter') { if (t.matches('.asaxc')) this.vf.axes[t.dataset.ax] = t.value; this.createVariant(); } if (ev.key === 'Escape') { this.vf = null; this.render(); } return; }
      if (t.matches('input, textarea, select')) { ev.stopPropagation(); if (ev.key === 'Escape') t.blur(); if (ev.key === 'Enter' && t.matches('.chppath')) this.addPhotoPath(t.value); return; }
      if (ev.key === 'Escape' && this.pinMode) { ev.stopPropagation(); this.pinMode = false; return this.render(); }
      if (ev.key === 'Escape' && this.sel) { ev.stopPropagation(); this.sel = null; this.mode = 'view'; this.render(); }
    });
    el.addEventListener('focusout', () => setTimeout(() => { if (this.pending && !this.typing()) this.render(); }, 0));
  }
  renderBodyLater() { clearTimeout(this._rb); this._rb = setTimeout(() => { if (!this.typing()) this.renderBar(); const f = this.$('.chbf'); if (f && !f.querySelector('.unsaved')) f.insertAdjacentHTML('afterbegin', '<span class="unsaved">unsaved base</span><button data-a="savebase">Save base</button>'); }, 150); }
}

// a pick on a look / variant / asset is the director's choice: recorded (proposal_act), the agent reads it with
// proposals_get and makes the sheet request from it; nothing else changes in the page
for (const st of ['characters', 'scenery']) registerProposals(st, async () => ({ what: 'the agent reads your pick (proposals_get) for the next sheet' }));

// ------------------------------------------------------------------ commands (registered at load: core/rail.js imports the stage modules)
// one set per workspace: pre "chars" (Characters) or "scenery" (Scenery); ids {root, approve, newV} name the acts
export function assetCommands({ pre, group, stage, get, ids, root, vWord, what }) {
  const visible = () => WB()?.app?.active() === 'stage' && WB().stages?.current() === stage;
  const V = () => visible() && !!get();
  const ensure = async () => { if (!visible()) await WB().stages.open(stage); return get(); };
  const node = (c) => { const S = get(); return (c?.nodeId && A.nodeById(S?.iter(), c.nodeId)) || (S?.sel && A.nodeById(S.iter(), S.sel)) || null; };
  const rootTree = () => get()?.T.root;
  commands.register([
    { id: `${pre}.open`, group, title: `${group}: open a ${what}…`, run: async () => {
      const s = await ensure(); const id = await ui.pick({ title: `Open ${what}`, items: s.assets.map(e => ({ label: e.name || e.id, detail: `${e.kind} · ${A.assetStatus(e, store.requests, e.kind).label}`, value: e.id })) });
      if (id) s.select(id);
    } },
    { id: `${pre}.${ids.root}`, group, title: `${group}: request the ${root} (draft)`, when: () => V() && !!get().ent(), run: () => get().requestRoot() },
    { id: `${pre}.${ids.approve}`, group, title: `${group}: approve the ${root.split(' ')[0]} (lock)`, when: () => V() && !!get().ent() && !!A.treeState(get().iter(), rootTree()).head && !A.treeState(get().iter(), rootTree()).approved, run: () => get().approveTree(rootTree()) },
    { id: `${pre}.${ids.newV}`, group, title: `${group}: new ${vWord}…`, when: () => V() && !!get().ent(), run: () => get().newVariant() },
    { id: `${pre}.edit`, group, title: `${group}: edit from this node (sketch + mask + pins)`, when: (c) => V() && !!node(c) && !A.treeState(get().iter(), node(c).tree).approved, run: (c) => { const S = get(); S.sel = node(c).id; S.edText = ''; S.openSketch('edit', node(c)); } },
    { id: `${pre}.compare`, group, title: `${group}: compare with the parent (A/B)`, when: (c) => V() && !!node(c)?.parent, run: (c) => get().openNode(node(c).id, 'compare') },
    { id: `${pre}.keep`, group, title: `${group}: keep the new node (it becomes the head)`, when: (c) => V() && A.pending(get().iter(), node(c)), run: (c) => get().choose(node(c).id, 'kept') },
    { id: `${pre}.branch`, group, title: `${group}: keep the new node as a branch`, when: (c) => V() && A.pending(get().iter(), node(c)), run: (c) => get().choose(node(c).id, 'branch') },
    { id: `${pre}.revert`, group, title: `${group}: revert (drop the new node)`, when: (c) => V() && A.pending(get().iter(), node(c)), run: (c) => get().choose(node(c).id, 'reverted') },
    { id: `${pre}.noteNode`, group, title: `${group}: note on this node (Notes column)`, when: (c) => V() && !!node(c), run: (c) => { const S = get(); S.nc.edit(S.tg('node', node(c).id)); } },
    { id: `${pre}.pinNote`, group, title: `${group}: pin a note on the open node's image`, when: () => V() && !!get().sel, run: () => { const S = get(); S.pinMode = true; S.mode = 'view'; S.render(); } },
    { id: `${pre}.abFlip`, group, title: `${group}: A/B compare mode (slider, toggle, side by side)`, when: () => V() && get().mode === 'compare', run: () => { const S = get(); S.ab = { slider: 'toggle', toggle: 'side', side: 'slider' }[S.ab]; prefs.set(S.pf + 'AB', S.ab); S.render(); } },
  ]);
  window.WB = Object.assign(window.WB || {}, { stageActions: { ...(window.WB?.stageActions || {}), [stage]: { canSave: () => V() && !!get().sk && get().mode === 'edit', save: () => get().requestEdit(), canNote: () => V() && !!get().ent(), note: () => get().nc.editCurrent() } } });
  menus.contribute('chnode', [(c) => V() ? [{ label: '+ Add', submenu: [{ cmd: `${pre}.noteNode`, label: '+ note on this node' }, { cmd: `${pre}.pinNote`, label: '+ pinned note (click the image)' }, '-', { cmd: 'notes.addHere', label: '+ note here' }] }] : []]);
}
