// Stage 1 workspace: the lyrics (docs/SPEC_v3_GUIDED.md). The poem as lines grouped by section tags, edited inline
// (double-click / Enter / F2 on a line, Tab to the next, Shift+Enter adds a line below); add / remove / reorder lines and
// sections; "Edit as text" for bulk edits and pasting. Edits collect in a draft (kept in this browser) until
// "Save version" (Ctrl+Enter): every save is a new version in lyrics.json, and the server moves song.json's lines to it
// (timings kept, the timeline lyrics column follows). The Notes column (core/notescol.js) on the right of the poem is
// row-aligned: a note sits on its line (or section); select words -> "+ note" (or Alt+N) pins it to them; "@agent" (or
// → agent) makes it an ask the agent reads (notes_get / lyrics_get). Right-click a line: + Add › line above / below,
// verse, section, note (undoable: Ctrl+Z). The Versions panel (bar: Versions) lists the versions with a word-level
// side-by-side diff of any two and restore (as a new version). Format and shared logic: js/flow.js, js/notes.js.
import { store, prefs, toast, esc, PROJECT, postJSON } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { commands } from '../core/commands.js';
import { ui } from '../core/palette.js';
import * as F from '../js/flow.js';
import { NotesColumn } from '../core/notescol.js';
import { history } from '../core/history.js';
import { menus } from '../core/menus.js';
import { stripHtml, register as registerProposals, offerPrepare } from '../core/proposals.js';
import { TimeAxis } from '../core/timemode.js';
import { upperBound } from '../js/warp.js';
import { versionsOf, currentVersionId } from '../js/songs.js';
import { openVersions, openBrief } from '../core/songver.js';
import { coverage, gateOn } from '../js/surfaces.js';

const WB = () => window.WB;
const visible = () => WB()?.app?.active() === 'stage' && WB().stages?.current() === 'lyrics';
const nowIso = () => new Date().toISOString().slice(0, 19);
const DKEY = 'lyricsDraft:' + PROJECT;
let S = null;   // the mounted workspace (one per page)

function songLines() { return new Map((store.song?.lines || []).map(l => [l.id, l])); }
const who = (x) => x.via === 'agent' ? `<span class="who ag" title="written through the agent tools">${esc(x.by && x.by !== 'agent' ? x.by + ' · agent' : 'agent')}</span>` : `<span class="who dr">${esc(x.by === 'import' ? 'import' : 'director')}</span>`;
const when = (at) => at ? esc(String(at).replace('T', ' ').slice(5, 16)) : '';

class Workspace {
  constructor(el, ctx) {
    this.el = el; this.ctx = ctx; this.side = prefs.get('lyricsSide', null) === 'versions' ? 'versions' : null;
    this.compare = null; this.textMode = false; this.editing = null; this.pending = false; this.sel = null; this.ab = { a: null, b: null };
    el.classList.add('lyws');
    el.innerHTML = `<div class="lymain"><div class="lybar"></div><div class="lysong"></div><div class="lypoem" tabindex="-1"></div></div>
      <div class="lyside"><div class="lytabs"><a data-side="versions">Versions</a><span class="sp"></span><a data-a="closeside" title="close the versions panel">×</a></div>
      <div class="lylist"></div></div>
      <button class="lyfab" style="display:none" title="note on the selected words (Alt+N)">+ note</button>`;
    this.$ = (s) => el.querySelector(s);
    this.loadDraft();
    this.wire();
    // the Notes column: one row per section tag and per line; the top row holds the notes on the whole poem
    // the poem keeps ~800 px, the Notes column takes the rest (up to 800 px; core/notescol.js width)
    // Time view (core/timemode.js): the lines on the timeline's axis, the section tags a band on the left; a section's notes
    // then sit in the top row (tagged with the section) so the cells stay one per time slot
    this.nc = new NotesColumn({ stage: 'lyrics', scroller: this.$('.lypoem'), active: () => !this.compare && !this.textMode && this.draft.length > 0, fixed: () => !!this.ta?.on,
      top: () => this.ta?.on ? { label: 'notes on the whole poem and its sections', targets: [{ stage: 'lyrics', kind: 'stage', id: null }],
        match: (n) => n.target.kind === 'stage' || n.target.kind === 'section', sub: (n) => n.target.kind === 'section' ? `[${this.draft.find(s => s.id === n.target.id)?.label || n.target.id}]` : '' }
        : { label: 'notes on the whole poem', targets: [{ stage: 'lyrics', kind: 'stage', id: null }] },
      rows: () => [...this.el.querySelectorAll(this.ta?.on ? '.lypoem .lyl' : '.lypoem .lyhead, .lypoem .lyl')].map(e => e.classList.contains('lyl')
        ? { el: e, targets: [{ stage: 'lyrics', kind: 'line', id: e.dataset.line }], sub: (n) => n.target.quote ? `“${n.target.quote}”${n.target.w && !F.anchorWords(this.findLine(e.dataset.line)?.l.text || '', n.target) ? ' (text changed)' : ''}` : '' }
        : { el: e, targets: [{ stage: 'lyrics', kind: 'section', id: e.closest('.lysec').dataset.sec }] }),
      current: () => { const s = this.sel, f = this.el.querySelector('.lyl:focus')?.dataset.line; const L = s && this.findLine(s.line)?.l;
        return L ? { stage: 'lyrics', kind: 'line', id: s.line, w: [s.w0, s.w1], quote: F.words(L.text).slice(s.w0, s.w1 + 1).join(' ') } : f ? { stage: 'lyrics', kind: 'line', id: f } : null; } });
    new ResizeObserver(() => { if (!this.editing) this.fill(); }).observe(this.$('.lypoem'));
    this.ta = new TimeAxis({ stage: 'lyrics', scroller: this.$('.lypoem'), nc: this.nc, rows: () => this.timeRows(), onApply: () => this.nc.schedule('place') });
    document.addEventListener('wb:timemode', (e) => { if (e.detail.stage === 'lyrics' && !this.editing) this.render(); });
    store.on((w) => { if (['lyrics', 'all', 'stages', 'notes', 'proposals', 'board'].includes(w)) { if (this.editing) this.pending = true; else this.render(); } });
    this.render();
  }
  get doc() { return store.lyrics; }
  // the Time view's rows: each line at its first word's time (song.json; the same t as the timeline's lyrics column) until
  // the next line, each section tag from its first line to the next section's; lines without a timing yet go after the end
  timeRows() {
    if (this.compare || this.textMode || !this.draft.length) return [];
    const tm = songLines(), dur = store.song?.duration_ms || 0;
    const t0of = (id) => { const L = tm.get(id); return L ? (L.words?.[0]?.t0 ?? L.t0) : null; };
    const after = (list) => { const a = [...new Set(list.filter(t => t != null))].sort((x, y) => x - y); return (t) => { const i = upperBound(a, t); return i < a.length ? a[i] : dur; }; };
    const lines = [...this.el.querySelectorAll('.lypoem .lyl')].map(e => ({ el: e, t0: t0of(e.dataset.line) }));
    const nextLine = after(lines.map(r => r.t0));
    for (const r of lines) if (r.t0 != null) r.t1 = nextLine(r.t0);
    const heads = [...this.el.querySelectorAll('.lypoem .lysec')].map(sec => { const ts = [...sec.querySelectorAll('.lyl')].map(e => t0of(e.dataset.line)).filter(t => t != null); return { el: sec.querySelector('.lyhead'), t0: ts.length ? Math.min(...ts) : null }; });
    const nextSec = after(heads.map(h => h.t0));
    for (const h of heads) if (h.t0 != null) h.t1 = nextSec(h.t0);
    return [...heads, ...lines];
  }
  // the notes on the poem (notes.json v2): open ones per line, for the word marks
  lineNotes() { const m = new Map(); for (const n of store.notesOn({ stage: 'lyrics', kind: 'line', status: 'open' })) (m.get(n.target.id) || m.set(n.target.id, []).get(n.target.id)).push(n); return m; }
  // a draft edit from "+ Add" (and the other structural edits): one undo step (Ctrl+Z puts the draft back)
  undoable(label, fn) {
    const before = structuredClone(this.draft); fn(); const after = structuredClone(this.draft);
    if (JSON.stringify(before) !== JSON.stringify(after)) history.push({ label, undo: () => this.setDraft(before), redo: () => this.setDraft(after) });
  }
  setDraft(d) { this.editing = null; this.draft = structuredClone(d); this.saveDraft(); this.render(); }
  get cur() { return F.currentVersion(this.doc); }
  // ---------------------------------------------------------------- the draft (unsaved edits, kept per project in this browser)
  loadDraft() {
    const d = prefs.get(DKEY, null);
    this.draft = d && d.base === (this.doc?.current || null) && Array.isArray(d.sections) ? d.sections : structuredClone(this.cur?.sections || []);
    this.base = this.doc?.current || null;
  }
  syncBase() {   // the current version moved (a save here, an agent's version, a restore): an untouched draft follows it
    if (this.base === (this.doc?.current || null) || this.busy) return;   // busy: our own save / restore is moving it
    if (!this.dirtyAgainst(this.base)) this.draft = structuredClone(this.cur?.sections || []);
    else toast(`lyrics: a new version (${this.doc.current}) arrived while you have unsaved edits; save makes yours the next version`);
    this.base = this.doc?.current || null; this.saveDraft();
  }
  dirtyAgainst(id) { const v = this.doc?.versions.find(x => x.id === id); return !F.sameBody(this.draft, v?.sections || []); }
  get dirty() { return !F.sameBody(this.draft, this.cur?.sections || []); }
  saveDraft() { if (this.dirty) prefs.set(DKEY, { base: this.base, sections: this.draft }); else prefs.set(DKEY, null); }
  edit(fn, keepEditing) { fn(this.draft); this.draft = this.draft.filter(s => s.lines.length || s.keep); this.saveDraft(); if (!keepEditing) this.render(); }
  findLine(id) { for (const s of this.draft) { const i = s.lines.findIndex(l => l.id === id); if (i >= 0) return { s, i, l: s.lines[i] }; } return null; }
  newLineId() { return F.nextLineId(this.doc, this.draft); }
  // ---------------------------------------------------------------- saving
  async save(message) {
    if (!this.dirty) return toast('lyrics: nothing to save');
    if (message == null) message = this.$('.lymsg')?.value.trim() || '';
    const body = structuredClone(this.draft).map(({ keep, ...s }) => ({ ...s, lines: s.lines.filter(l => l.text.trim()) })).filter(s => s.lines.length);
    try { F.checkLyrics({ versions: [{ id: 'x', sections: body }], notes: [], current: 'x' }); } catch (e) { return toast('not saved: ' + e.message); }
    let id = null; this.busy = true;
    try { await store.mutate('lyrics.json', (d) => { id = F.addVersion(d, body, { by: 'director', via: 'page', message }).id; }, { label: 'save lyrics version' }); } finally { this.busy = false; }
    this.base = this.doc.current; this.draft = structuredClone(this.cur?.sections || []); this.saveDraft();
    offerPrepare('lyrics');
    toast(`lyrics saved as ${id}${store.song?.audio?.mix ? ' · timings kept, new lines estimated' : ' · timings estimated (no song yet)'}`);
    this.render();
  }
  discard() { this.draft = structuredClone(this.cur?.sections || []); this.saveDraft(); this.render(); }
  restore(id) {
    const v = this.doc.versions.find(x => x.id === id); if (!v) return;
    this.busy = true;
    return store.mutate('lyrics.json', (d) => { F.addVersion(d, v.sections, { by: 'director', via: 'page', message: `restore ${id}`, from: id }); }, { label: `restore lyrics ${id}` })
      .finally(() => { this.busy = false; }).then(() => { this.base = this.doc.current; this.draft = structuredClone(this.cur.sections); this.saveDraft(); toast(`restored ${id} as ${this.doc.current}`); this.render(); });
  }
  // ---------------------------------------------------------------- notes (the Notes column: notes.json v2)
  // Alt+N / "+ note": the selected words, else the focused line, else the whole poem, typed in the Notes column
  noteOnSelection(line0) {
    const s = this.sel || this.readSelection();
    const line = line0 || s?.line || this.el.querySelector('.lyl:focus')?.dataset.line;
    const L = line && this.findLine(line)?.l;
    if (!L) return this.nc.edit({ stage: 'lyrics', kind: 'stage', id: null });
    const w = s?.line === line ? [s.w0, s.w1] : null, quote = w ? F.words(L.text).slice(w[0], w[1] + 1).join(' ') : '';
    this.clearSel();
    this.nc.edit({ stage: 'lyrics', kind: 'line', id: line, ...(w ? { w, quote } : {}) });
  }
  readSelection() {
    const sel = getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const node = (n) => (n?.nodeType === 3 ? n.parentElement : n);
    const a = node(sel.anchorNode)?.closest?.('.lyl .w'), b = node(sel.focusNode)?.closest?.('.lyl .w');
    const la = a?.closest('.lyl'), lb = b?.closest('.lyl');
    if (!a || !b || !la || !this.el.contains(la)) return null;
    let w0 = Number(a.dataset.i), w1 = Number(b.dataset.i);
    if (la !== lb) { const nw = la.querySelectorAll('.w').length; const first = la.compareDocumentPosition(lb) & Node.DOCUMENT_POSITION_FOLLOWING; w1 = first ? nw - 1 : 0; }
    if (w0 > w1) [w0, w1] = [w1, w0];
    return { line: la.dataset.line, w0, w1 };
  }
  clearSel() { this.sel = null; this.$('.lyfab').style.display = 'none'; try { getSelection().removeAllRanges(); } catch (e) { /* ignore */ } }
  setSide(s) { this.side = s === 'versions' ? 'versions' : null; prefs.set('lyricsSide', this.side); this.renderSide(); this.renderBar(); }
  // ---------------------------------------------------------------- rendering
  render() {
    this.pending = false;
    if (!this.doc) return;
    this.syncBase();
    this.renderBar(); this.renderSong();
    if (this.compare) this.renderDiff(); else if (this.textMode) this.renderText(); else this.renderPoem();
    this.renderSide();
    this.ta?.apply();
    this.fill();
  }
  // F5: a short poem spreads its lines over the height of the stage (up to 3x their height) instead of leaving the bottom
  // empty; a long one keeps the compact rows. Not in the Time view (rows sit on the timeline's axis there)
  fill() {
    const poem = this.$('.lypoem'); if (!poem) return;
    poem.style.setProperty('--lyfill', '0px');
    if (this.ta?.on || this.compare || this.textMode || !poem.clientHeight) return;
    // the poem's own height (the Notes column's layer spans the whole scroller, so scrollHeight cannot tell)
    const all = poem.querySelectorAll('.lyl, .lyhead'), rows = all.length, last = all[rows - 1];
    const used = last ? last.getBoundingClientRect().bottom - poem.getBoundingClientRect().top + poem.scrollTop : 0, free = poem.clientHeight - used - 44;
    const per = rows && free > 0 ? Math.min(28, Math.floor(free / rows)) : 0;
    if (per) poem.style.setProperty('--lyfill', per + 'px');
    this.nc?.schedule('place');
  }
  renderBar() {
    const v = this.cur, n = F.flatLines({ sections: this.draft }).length;
    const ver = v ? `<b>${esc(v.id)}</b> <span class="dim">${esc(v.message || '')}${v.created ? ' · ' + when(v.created) : ''} · ${v.via === 'agent' ? 'agent' : esc(v.by || '')}</span>` : '<span class="dim">no version yet</span>';
    this.$('.lybar').innerHTML = `${ver}<span class="dim">· ${n} lines · ${this.draft.length} sections</span><span class="sp"></span>`
      + (this.dirty ? `<span class="unsaved">unsaved edits</span><input class="lymsg" placeholder="what changed (optional)" spellcheck="false"><button data-a="save" class="pri" title="Ctrl+Enter: a new version">Save version</button><button data-a="drdiff" title="compare the current version with your edits">diff</button><button data-a="discard">Discard</button>` : '')
      + `<button data-a="text" class="${this.textMode ? 'on' : ''}" title="the whole poem as text with [Section] tags (paste, bulk edits)">Edit as text</button><button data-a="addsec" title="new section at the end">+ section</button><button data-a="compare" title="side-by-side word diff of two versions">Compare…</button><button data-a="versions" class="${this.side === 'versions' ? 'on' : ''}" title="the versions panel: diff any two, restore">Versions ${this.doc?.versions.length || 0}</button>`;
  }
  renderSong() {
    const s = store.song, has = !!s?.audio?.mix, n = s?.lines?.length || 0;
    // E7: the takes of the song (v1, v2…) and the Suno brief (core/songver.js)
    const nv = versionsOf(s).length, sv = ` · <a data-a="songvers" title="the takes of the song: add a Suno take, preview what moves, use it">${esc(currentVersionId(s))}${nv > 1 ? ` of ${nv}` : ''} · versions…</a> · <a data-a="suno" title="style + lyrics with section tags, to paste into Suno">Suno brief…</a>`;
    this.$('.lysong').innerHTML = has
      ? `song <b>${esc(s.audio.mix.split('/').pop())}</b> · ${fmt(s.duration_ms)} · ${s.bpm} bpm · timing ${esc(s.timing || 'imported')}${n ? '' : ' · no lines yet'} <a data-a="song" title="replace the song file">replace…</a>${sv}`
      : `<b>no song file yet</b> · timings are estimated over a ${fmt(s?.duration_ms || 0)} placeholder; add the song when you have it (lines keep their order, timings are re-estimated over the real song) <a data-a="song">Add song…</a> · <a data-a="suno" title="style + lyrics with section tags, to paste into Suno">Suno brief…</a>`;
    this.$('.lysong').classList.toggle('nosong', !has);
  }
  renderPoem() {
    const poem = this.$('.lypoem');
    if (!this.draft.length) {
      poem.innerHTML = `<div class="lyempty"><h4>Paste the lyrics</h4><textarea class="lypaste" rows="14" spellcheck="false" placeholder="[Verse 1]\nfirst line\nsecond line\n\n[Chorus]\n…"></textarea><div><button data-a="paste" class="pri">Save as the first version</button> <span class="dim">[Section] tags or blank lines split sections; LRC time tags are kept</span></div></div>`;
      return;
    }
    const tm = songLines(), byLine = this.lineNotes();
    // the lyric gate (E2): per line, how many of its words show on a surface (a shot's lyrics[]) at their time
    const cov = new Map(coverage(store.song, store.boardShots()).lines.map(x => [x.id, x]));
    const gate = (id) => { const c = cov.get(id); if (!c || !c.n || !gateOn(store.settings)) return '';   /* off for the project: no chip (review #3) */ const un = c.words.filter(w => !w.by.length).map(w => w.w);
      const kinds = [...new Set(c.words.flatMap(w => w.by.map(b => b.where.split(':')[0])))];
      return kinds.map(k => `<i class="lysfk" title="${esc(c.words.flatMap(w => w.by).filter(b => b.where.split(':')[0] === k).map(b => `${b.shot} · ${b.where}`).filter((x, i, a) => a.indexOf(x) === i).join('\n'))}">${esc(k)}</i>`).join('') + `<b class="lysf${c.covered === c.n ? ' ok' : ''}" data-sfgo="${esc(id)}" title="${esc(`on screen: ${c.covered} of ${c.n} words${un.length ? `
not on screen: ${un.join(' ')}` : ''}
(click: the shot in the storyboard)`)}">${c.covered}/${c.n}</b>`; };
    let k = 0;
    poem.innerHTML = this.draft.map((s, si) => `<div class="lysec" data-sec="${esc(s.id)}"><div class="lyhead"><span class="lytag" title="double-click to rename">[${esc(s.label)}]</span>
      <span class="lytools"><b data-s="up" title="move section up">↑</b><b data-s="down" title="move section down">↓</b><b data-s="add" title="add a line at the end">+</b><b data-s="ren" title="rename">✎</b><b data-s="del" title="delete the section">×</b></span></div>`
      + s.lines.map((l) => {
        k++; const t = tm.get(l.id), ns = byLine.get(l.id) || [], marks = new Set();
        for (const x of ns) { const r = x.target.w ? F.anchorWords(l.text, x.target) : null; if (r) for (let i = r[0]; i <= r[1]; i++) marks.add(i); }
        const ws = F.words(l.text).map((w, i) => `<span class="w${marks.has(i) ? ' nw' : ''}" data-i="${i}">${esc(w)}</span>`).join(' ');
        const changed = this.cur && !F.flatLines(this.cur).some(x => x.id === l.id && x.text === l.text);
        const pp = stripHtml({ stage: 'lyrics', kind: 'line', id: l.id }, { quiet: true, label: 'alternatives' });
        return `<div class="lyl${ns.length ? ' hasn' : ''}${changed ? ' chg' : ''}${pp ? ' hasp' : ''}" data-line="${esc(l.id)}" tabindex="0"><span class="lyn">${k}</span><span class="lyt" ${t ? `data-t="${t.t0}" title="${t.timing === 'estimated' ? 'estimated: ' : ''}${fmt(t.t0, true)} – ${fmt(t.t1, true)} (click: show in the timeline)"` : 'title="no timing yet (saved versions get one)"'}>${t ? (t.timing === 'estimated' ? '~' : '') + fmt(t.t0) : '·'}</span><span class="lytx">${ws || '<span class="dim">(empty)</span>'}</span>${gate(l.id)}
          <span class="lytools"><b data-l="up" title="move up (Alt+Up)">↑</b><b data-l="down" title="move down (Alt+Down)">↓</b><b data-l="add" title="add a line below (Shift+Enter)">+</b><b data-l="edit" title="edit (Enter, F2, double-click)">✎</b><b data-l="note" title="note on this line, in the Notes column (Alt+N; select words first to pin it to them)">✉</b><b data-l="propose" title="ask the agent for 3 alternatives to this line (proposals: you pick one)">◇</b><b data-l="del" title="delete the line">×</b></span>${pp}</div>`;
      }).join('') + `</div>`).join('');
    if (this.flash) { const e = poem.querySelector(`[data-line="${CSS.escape(this.flash)}"]`); e?.scrollIntoView({ block: 'center' }); e?.classList.add('flash'); setTimeout(() => e?.classList.remove('flash'), 1200); this.flash = null; }
  }
  renderText() {
    this.$('.lypoem').innerHTML = `<div class="lytext"><textarea spellcheck="false">${esc(F.versionText({ sections: this.draft }))}</textarea><div><button data-a="textok" class="pri">Apply to the draft</button> <button data-a="text">Cancel</button> <span class="dim">[Section] tags start sections; lines that keep their text keep their timings and notes, a reworded line keeps the id of the line it replaces</span></div></div>`;
    this.$('.lytext textarea').focus();
  }
  renderDiff() {
    const { a, b } = this.compare, va = this.doc.versions.find(v => v.id === a), vb = b === 'draft' ? { id: 'draft', sections: this.draft, message: 'your unsaved edits' } : this.doc.versions.find(v => v.id === b);
    if (!va || !vb) { this.compare = null; return this.renderPoem(); }
    const ops = F.wordDiff(F.versionText(va), F.versionText(vb)), st = F.diffStats(ops);
    const side = (keep, cls) => ops.filter(o => o.op === '=' || o.op === keep).map(o => o.w === '\n' ? '<br>' : o.op === '=' ? esc(o.w) + ' ' : `<span class="${cls}">${esc(o.w)}</span> `).join('');
    const hd = (v) => `<b>${esc(v.id)}</b> <span class="dim">${esc(v.message || '')}${v.created ? ' · ' + when(v.created) : ''}</span>`;
    this.$('.lypoem').innerHTML = `<div class="lydiff"><div class="lydh"><span>${hd(va)} → ${hd(vb)}</span><span class="dim"> · <span class="dst a">+${st.added}</span> <span class="dst d">−${st.removed}</span> words</span><span class="sp"></span>${b !== 'draft' && vb.id !== this.doc.current ? `<button data-a="restore" data-v="${esc(vb.id)}">Restore ${esc(vb.id)}</button>` : ''}${va.id !== this.doc.current ? `<button data-a="restore" data-v="${esc(va.id)}">Restore ${esc(va.id)}</button>` : ''}<button data-a="closediff">Close</button></div>
      <div class="lydc"><div class="lydl">${side('-', 'del')}</div><div class="lydr">${side('+', 'add')}</div></div></div>`;
  }
  renderSide() {
    const side = this.$('.lyside'); side.style.display = this.side === 'versions' ? '' : 'none';
    if (this.side !== 'versions') return;
    for (const a of this.el.querySelectorAll('.lytabs [data-side]')) { a.classList.add('on'); a.innerHTML = `Versions<i>${this.doc.versions.length}</i>`; }
    const list = this.$('.lylist'), vs = [...this.doc.versions].reverse(), { a, b } = this.ab;
    list.innerHTML = `<div class="lyvh"><span class="dim">pick A and B, or click a row (it vs the one before)</span><button data-a="ab" ${a && b && a !== b ? '' : 'disabled'}>Compare A → B</button></div>` + vs.map(v => `<div class="lyv${v.id === this.doc.current ? ' cur' : ''}" data-v="${esc(v.id)}">
      <span class="lyvid">${v.id === this.doc.current ? '●' : ''}${esc(v.id)}</span><span class="lyvm">${esc(v.message || (v.from ? 'restore ' + v.from : ''))}<i>${when(v.created)} ${v.via === 'agent' ? '· agent' : v.by ? '· ' + esc(v.by) : ''} · ${F.flatLines(v).length} lines</i></span>
      <b data-ab="a" class="${a === v.id ? 'on' : ''}">A</b><b data-ab="b" class="${b === v.id ? 'on' : ''}">B</b>${v.id === this.doc.current ? '' : `<b data-a="restore" data-v="${esc(v.id)}" title="copy it as a new version">restore</b>`}</div>`).join('');
  }
  // ---------------------------------------------------------------- inline editing
  editLine(id, { caretEnd = true } = {}) {
    const row = this.el.querySelector(`.lyl[data-line="${CSS.escape(id)}"]`), f = this.findLine(id); if (!row || !f) return;
    this.editing = { line: id };
    const tx = row.querySelector('.lytx'), inp = document.createElement('input'); inp.className = 'lyin'; inp.value = f.l.text; inp.spellcheck = false;
    tx.replaceWith(inp); inp.focus(); if (caretEnd) inp.setSelectionRange(inp.value.length, inp.value.length);
    let done = false;
    const finish = (how) => {
      if (done) return; done = true; this.editing = null;
      const v = inp.value.replace(/\s+/g, ' ').trim(), g = this.findLine(id);
      let at = null;   // where Shift+Enter puts the new line
      if (g && (how !== 'cancel' || !g.l.text)) {
        if (!v || how === 'cancel') { g.s.lines.splice(g.i, 1); at = { s: g.s, i: g.i }; } else { g.l.text = v; at = { s: g.s, i: g.i + 1 }; }
        if (how === 'below') { const nid = this.newLineId(); at.s.lines.splice(at.i, 0, { id: nid, text: '' }); this.edit(() => {}, true); this.render(); return this.editLine(nid); }
        this.edit(() => {}, true);
      }
      this.render();
      if (how === 'next') { const all = F.flatLines({ sections: this.draft }), i = all.findIndex(l => l.id === id); if (all[i + 1]) this.editLine(all[i + 1].id); }
      else if (how === 'save') this.save();
      else this.el.querySelector(`.lyl[data-line="${CSS.escape(id)}"]`)?.focus();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish('save'); }
      else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); finish('below'); }
      else if (e.key === 'Enter') { e.preventDefault(); finish('ok'); }
      else if (e.key === 'Tab') { e.preventDefault(); finish('next'); }
      else if (e.key === 'Escape') { e.preventDefault(); finish('cancel'); }
    });
    inp.addEventListener('blur', () => setTimeout(() => finish('ok'), 0));
  }
  editSection(id) {
    const s = this.draft.find(x => x.id === id), tag = this.el.querySelector(`.lysec[data-sec="${CSS.escape(id)}"] .lytag`); if (!s || !tag) return;
    this.editing = { sec: id };
    const inp = document.createElement('input'); inp.className = 'lyin lysin'; inp.value = s.label; tag.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; this.editing = null; const v = inp.value.replace(/[[\]]/g, '').trim(); if (ok && v) this.edit(() => { s.label = v; }); else this.render(); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    inp.addEventListener('blur', () => setTimeout(() => finish(true), 0));
  }
  moveLine(id, dir) {
    this.undoable(`move ${id}`, () => this.edit(() => {
      const f = this.findLine(id); if (!f) return;
      const si = this.draft.indexOf(f.s), j = f.i + dir;
      if (j >= 0 && j < f.s.lines.length) { const [l] = f.s.lines.splice(f.i, 1); f.s.lines.splice(j, 0, l); }
      else { const t = this.draft[si + dir]; if (!t) return; const [l] = f.s.lines.splice(f.i, 1); if (dir < 0) t.lines.push(l); else t.lines.unshift(l); }
    }));
    this.el.querySelector(`.lyl[data-line="${CSS.escape(id)}"]`)?.focus();
  }
  // "+ Add": a line below (above: before = true) a line, at the end of a section, or (no line) at the end of the poem
  addLineAfter(id, sec, { before = false } = {}) {
    const nid = this.newLineId();
    this.undoable(before ? `add a line above ${id}` : 'add a line', () => this.edit(() => {
      const f = id && this.findLine(id);
      if (f) f.s.lines.splice(f.i + (before ? 0 : 1), 0, { id: nid, text: '' });
      else { const s = this.draft.find(x => x.id === sec) || this.draft[this.draft.length - 1]; if (s) s.lines.push({ id: nid, text: '' }); else this.draft.push({ id: 'verse', label: 'Verse', lines: [{ id: nid, text: '' }] }); }
    }, true));
    this.compare = null; this.textMode = false; this.render(); this.editLine(nid);
  }
  // a new section (a label asked; verse = "Verse N" without asking) after the section of `after` (a line or section id), else at the end
  async addSection({ label, after } = {}) {
    if (label == null) label = await ui.prompt({ title: 'New section: label (Verse 2, Chorus, Bridge…)', placeholder: 'section label' }); if (!label) return;
    label = label.replace(/[[\]]/g, '').trim();
    let id = F.slug(label); for (let n = 2; this.draft.some(s => s.id === id); n++) id = `${F.slug(label)}-${n}`;
    const nid = this.newLineId();
    const at = after ? this.draft.findIndex(s => s.id === after || s.lines.some(l => l.id === after)) : -1;
    this.undoable(`add section [${label}]`, () => this.edit(() => { this.draft.splice(at >= 0 ? at + 1 : this.draft.length, 0, { id, label, lines: [{ id: nid, text: '' }] }); }, true));
    this.compare = null; this.textMode = false; this.render(); this.editLine(nid);
  }
  addVerse(after) { const n = this.draft.filter(s => /^verse\b/i.test(s.label)).length + 1; return this.addSection({ label: `Verse ${n}`, after }); }
  async songDialog() {
    const has = !!store.song?.audio?.mix;
    const p = await ui.prompt({ title: `${has ? 'Replace' : 'Add'} the song: path of the audio file on this machine (wav, mp3, m4a, flac, ogg)`, placeholder: 'C:\\music\\my-song.wav  or  audio/mix.wav (inside the project)' });
    if (!p) return;
    toast('reading the song (ffmpeg)…');
    const r = await postJSON('/api/op/song_attach', { path: p.trim().replace(/^"|"$/g, '') });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast('song not added: ' + (j.error || r.status));
    toast(`song added: ${fmt(j.duration_ms)} · ${j.lines} lines timed (${j.timing || 'estimated'})`);
  }
  // ---------------------------------------------------------------- events
  wire() {
    const el = this.el;
    el.addEventListener('click', async (e) => {
      const sfg = e.target.closest('[data-sfgo]');
      if (sfg) { const L = store.song.lines.find(x => x.id === sfg.dataset.sfgo), sh = L && store.boardShots().find(x => x.t0 <= L.t0 && L.t0 < x.t1); return WB().stages.open('storyboard').then(() => sh && WB().storyboard?.focus(sh.id)); }
      const t = e.target;
      const act = t.closest('[data-a]')?.dataset.a;
      if (act === 'save') return this.save();
      if (act === 'discard') { if (await ui.confirm('Discard your unsaved lyrics edits?')) this.discard(); return; }
      if (act === 'text') { this.textMode = !this.textMode; this.compare = null; return this.render(); }
      if (act === 'textok') { const v = this.$('.lytext textarea').value; const r = F.assignIds(F.parseText(v), { sections: this.draft }, this.doc); this.textMode = false; this.edit(() => { this.draft = r.sections; }); return; }
      if (act === 'addsec') return this.addSection();
      if (act === 'compare') return commands.run('lyrics.compare');
      if (act === 'drdiff') { this.compare = { a: this.doc.current, b: 'draft' }; this.textMode = false; return this.render(); }
      if (act === 'closediff') { this.compare = null; return this.render(); }
      if (act === 'restore') return this.restore(t.closest('[data-v]').dataset.v);
      if (act === 'ab') { this.compare = { ...this.ab }; this.textMode = false; return this.render(); }
      if (act === 'song') return this.songDialog();
      if (act === 'songvers') return openVersions();
      if (act === 'suno') return openBrief();
      if (act === 'paste') { const v = this.$('.lypaste').value; if (!v.trim()) return; this.draft = F.assignIds(F.parseText(v), null, this.doc).sections; this.saveDraft(); return this.save('first draft'); }
      if (act === 'versions') return this.setSide(this.side === 'versions' ? null : 'versions');
      if (act === 'closeside') return this.setSide(null);
      const ab = t.closest('[data-ab]'); if (ab) { const v = ab.closest('[data-v]').dataset.v; this.ab[ab.dataset.ab] = this.ab[ab.dataset.ab] === v ? null : v; return this.renderSide(); }
      const vrow = t.closest('.lyv[data-v]');
      if (vrow) { const i = this.doc.versions.findIndex(v => v.id === vrow.dataset.v); const prev = this.doc.versions[i - 1]; this.compare = prev ? { a: prev.id, b: vrow.dataset.v } : { a: vrow.dataset.v, b: this.doc.current }; this.textMode = false; return this.render(); }
      const tm = t.closest('.lyt[data-t]'); if (tm) return this.ctx.goto(Number(tm.dataset.t));
      if (t === this.$('.lyfab')) return this.noteOnSelection();
      const lb = t.closest('[data-l]'), id = t.closest('.lyl')?.dataset.line;
      if (lb && id) {
        const a = lb.dataset.l;
        if (a === 'up' || a === 'down') return this.moveLine(id, a === 'up' ? -1 : 1);
        if (a === 'add') return this.addLineAfter(id);
        if (a === 'edit') return this.editLine(id);
        if (a === 'del') return this.undoable(`delete ${id}`, () => this.edit((d) => { const f = this.findLine(id); f?.s.lines.splice(f.i, 1); }));
        if (a === 'note') { this.sel = null; return this.noteOnSelection(id); }
        if (a === 'propose') { if (!F.flatLines(this.cur).some(x => x.id === id)) return toast('save the lyrics first: proposals sit on a saved line'); return WB().proposals.more({ stage: 'lyrics', kind: 'line', id }); }
      }
      const sb = t.closest('[data-s]'), sid = t.closest('.lysec')?.dataset.sec;
      if (sb && sid) {
        const a = sb.dataset.s, i = this.draft.findIndex(s => s.id === sid);
        if (a === 'up' || a === 'down') { const j = i + (a === 'up' ? -1 : 1); if (j < 0 || j >= this.draft.length) return; return this.undoable(`move section ${sid}`, () => this.edit((d) => { const [s] = d.splice(i, 1); d.splice(j, 0, s); })); }
        if (a === 'add') return this.addLineAfter(null, sid);
        if (a === 'ren') return this.editSection(sid);
        if (a === 'del') { const n = this.draft[i].lines.length; if (n && !(await ui.confirm(`Delete section [${this.draft[i].label}] and its ${n} line(s) from the draft?`))) return; return this.undoable(`delete section ${sid}`, () => this.edit((d) => { d.splice(i, 1); })); }
      }
    });
    el.addEventListener('dblclick', (e) => {
      const tag = e.target.closest('.lytag'); if (tag) return this.editSection(tag.closest('.lysec').dataset.sec);
      const row = e.target.closest('.lyl'); if (row && !e.target.closest('.lytools, .lyt, input')) { e.preventDefault(); this.clearSel(); this.editLine(row.dataset.line); }
    });
    el.addEventListener('mouseup', () => setTimeout(() => {
      const s = this.readSelection(), fab = this.$('.lyfab');
      if (!s) { this.sel = null; fab.style.display = 'none'; return; }
      this.sel = s;
      const r = getSelection().getRangeAt(0).getBoundingClientRect(), host = this.el.getBoundingClientRect();
      fab.style.display = ''; fab.style.left = `${Math.min(host.width - 60, r.right - host.left + 4)}px`; fab.style.top = `${r.bottom - host.top + 2}px`;
    }, 0));
    el.addEventListener('focusin', (e) => { const l = e.target.closest?.('.lyl[data-line]'); if (l) this.lastLine = l.dataset.line; });
    el.addEventListener('keydown', (e) => {
      const row = e.target.closest?.('.lyl');
      if (e.target.matches('.lymsg')) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); this.save(); } return; }
      if (e.target.matches('textarea, .lypaste')) { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.$('[data-a=textok], [data-a=paste]')?.click(); } return; }
      if (!row || e.target !== row) return;
      const id = row.dataset.line, all = [...this.el.querySelectorAll('.lyl')], i = all.indexOf(row);
      const k = (f) => { e.preventDefault(); e.stopPropagation(); f(); };
      if ((e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) || e.key === 'F2') return k(() => this.editLine(id));
      if (e.key === 'Enter' && e.shiftKey) return k(() => this.addLineAfter(id));
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return k(() => this.moveLine(id, e.key === 'ArrowUp' ? -1 : 1));
      if (!e.altKey && !e.ctrlKey && e.key === 'ArrowUp' && all[i - 1]) return k(() => all[i - 1].focus());
      if (!e.altKey && !e.ctrlKey && e.key === 'ArrowDown' && all[i + 1]) return k(() => all[i + 1].focus());
      if (e.key === 'Delete' && !e.ctrlKey) return k(() => this.undoable(`delete ${id}`, () => this.edit(() => { const f = this.findLine(id); f?.s.lines.splice(f.i, 1); })));
    });
  }
  // "Ask the agent": an ask in the Notes column (on the selected words / line, else the whole poem)
  ask() { const t = this.nc.o.current() || { stage: 'lyrics', kind: 'stage', id: null }; this.clearSel(); this.nc.edit(t, { to: true }); }
}

// ------------------------------------------------------------------ proposals: a picked text replaces the line in the draft (core/proposals.js)
registerProposals('lyrics', async ({ target, item }) => {
  if (!S) await WB().stages.open('lyrics');
  if (target.kind !== 'line' || item.svg) return null;
  const f = S.findLine(target.id); if (!f) throw new Error(`line ${target.id} is not in the draft`);
  const before = structuredClone(S.draft); S.edit(() => { f.l.text = item.text.replace(/\s+/g, ' ').trim(); }); const after = structuredClone(S.draft);
  return { what: `line ${target.id} (unsaved: Save version keeps it)`, undo: () => S.setDraft(before), redo: () => S.setDraft(after) };
});

// ------------------------------------------------------------------ commands (registered at load: core/rail.js imports this module)
const L = (c) => visible() && !!S;
// the line / section a command acts on: the right-clicked row (c.lineId / c.secId), else the focused line or selected words
// (from the palette: the line last focused, else the last line of the poem)
const lineOf = (c) => c?.lineId || S?.el.querySelector('.lyl:focus')?.dataset.line || S?.sel?.line || (S?.lastLine && S.findLine(S.lastLine) ? S.lastLine : null) || S?.draft.at(-1)?.lines.at(-1)?.id || null;
const secOf = (c) => c?.secId || (lineOf(c) && S?.draft.find(s => s.lines.some(l => l.id === lineOf(c)))?.id) || null;
commands.register([
  { id: 'lyrics.save', group: 'Lyrics', title: 'Save lyrics version', when: () => L() && S.dirty, run: () => S.save() },
  { id: 'lyrics.discard', group: 'Lyrics', title: 'Discard unsaved lyrics edits', when: () => L() && S.dirty, run: () => S.discard() },
  { id: 'lyrics.note', group: 'Lyrics', title: 'Note on the selected words / line (Notes column)', when: () => L(), run: (c) => S.noteOnSelection(c?.lineId) },
  { id: 'lyrics.addLineAbove', group: 'Lyrics', title: 'Add a lyric line above', when: (c) => L() && !S.textMode && !S.compare && !!lineOf(c), run: (c) => S.addLineAfter(lineOf(c), null, { before: true }) },
  { id: 'lyrics.addLineBelow', group: 'Lyrics', title: 'Add a lyric line below', when: (c) => L() && !S.textMode && !S.compare && !!(lineOf(c) || secOf(c)), run: (c) => lineOf(c) ? S.addLineAfter(lineOf(c)) : S.addLineAfter(null, secOf(c)) },
  { id: 'lyrics.addVerse', group: 'Lyrics', title: 'Add a verse (after this section)', when: () => L() && !S.textMode, run: (c) => S.addVerse(secOf(c) || undefined) },
  { id: 'lyrics.text', group: 'Lyrics', title: 'Edit lyrics as text', checked: () => !!S?.textMode, when: () => L(), run: () => { S.textMode = !S.textMode; S.compare = null; S.render(); } },
  { id: 'lyrics.addSection', group: 'Lyrics', title: 'Add a lyrics section…', when: () => L(), run: (c) => S.addSection({ after: secOf(c) || undefined }) },
  { id: 'lyrics.compare', group: 'Lyrics', title: 'Compare lyrics versions…', when: () => !!store.lyrics?.versions?.length, run: async () => {
    if (!visible()) await WB().stages.open('lyrics');
    const vs = [...store.lyrics.versions].reverse().map(v => ({ label: v.id, detail: `${v.message || ''} ${v.created ? v.created.replace('T', ' ') : ''}`, value: v.id }));
    const a = await ui.pick({ title: 'Compare: older version (A)', items: vs }); if (!a) return;
    const b = await ui.pick({ title: `Compare ${a} with (B)`, items: [{ label: 'your unsaved edits', detail: 'draft', value: 'draft' }, ...vs.filter(v => v.value !== a)] }); if (!b) return;
    S.compare = { a, b }; S.textMode = false; S.render();
  } },
  { id: 'lyrics.ask', group: 'Lyrics', title: 'Ask the agent anything about the lyrics… (a note)', run: async () => { if (!visible()) await WB().stages.open('lyrics'); S?.ask(); } },
  { id: 'lyrics.versions', group: 'Lyrics', title: 'Lyrics versions panel', checked: () => S?.side === 'versions', when: () => L(), run: () => S.setSide(S.side === 'versions' ? null : 'versions') },
  { id: 'lyrics.addSong', group: 'Lyrics', title: () => store.song?.audio?.mix ? 'Replace the song file…' : 'Add the song file…', run: async () => { if (!visible()) await WB().stages.open('lyrics'); S?.songDialog(); } },
]);

// Ctrl+Enter and Alt+N in a stage workspace are the rail's stage.save / stage.note (core/rail.js): they ask the visible stage
window.WB = Object.assign(window.WB || {}, { stageActions: { ...(window.WB?.stageActions || {}), lyrics: { canSave: () => L() && S.dirty, save: () => S.save(), canNote: () => L(), note: () => S.noteOnSelection() } } });
// right-click a line / a section tag: + Add (core/defaults.js contextArgs names them "lyline" / "lysec")
const ADD = { label: '+ Add', submenu: [{ cmd: 'lyrics.addLineAbove', label: '+ line above' }, { cmd: 'lyrics.addLineBelow', label: '+ line below' }, { cmd: 'lyrics.addVerse', label: '+ verse' }, { cmd: 'lyrics.addSection', label: '+ section…' }, '-', { cmd: 'notes.addHere', label: '+ note here' }] };
menus.contribute('lyline', [ADD, 'lyrics.note', 'lyrics.ask']);
menus.contribute('lysec', [ADD]);
menus.contribute('lystage', [{ label: '+ Add', submenu: [{ cmd: 'lyrics.addVerse', label: '+ verse' }, { cmd: 'lyrics.addSection', label: '+ section…' }, '-', { cmd: 'notes.addHere', label: '+ note here' }] }, 'lyrics.ask', 'lyrics.versions']);

export default {
  mount(el, ctx) { S = new Workspace(el, ctx); },
  show() { if (S && !S.editing) S.render(); },
  get ws() { return S; },
};
