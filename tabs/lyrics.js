// Stage 1 workspace: the lyrics (docs/SPEC_v3_GUIDED.md). The poem as lines grouped by section tags, edited inline
// (double-click / Enter / F2 on a line, Tab to the next, Shift+Enter adds a line below); add / remove / reorder lines and
// sections; "Edit as text" for bulk edits and pasting. Edits collect in a draft (kept in this browser) until
// "Save version" (Ctrl+Enter): every save is a new version in lyrics.json, and the server moves song.json's lines to it
// (timings kept, the timeline lyrics column follows). Side panel: notes pinned to a line or to selected words (select
// words -> "+ note" or Alt+N), threads with replies, resolve; an "Ask the agent" box (a note addressed to the agent,
// read with the MCP tool lyrics_get); versions with a word-level side-by-side diff of any two and restore (as a new
// version). Format and shared logic: js/flow.js.
import { store, prefs, toast, esc, PROJECT, postJSON } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { commands } from '../core/commands.js';
import { ui } from '../core/palette.js';
import * as F from '../js/flow.js';

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
    this.el = el; this.ctx = ctx; this.side = prefs.get('lyricsSide', 'notes'); this.filter = 'open';
    this.compare = null; this.textMode = false; this.editing = null; this.pending = false; this.sel = null; this.ab = { a: null, b: null };
    el.classList.add('lyws');
    el.innerHTML = `<div class="lymain"><div class="lybar"></div><div class="lysong"></div><div class="lypoem" tabindex="-1"></div></div>
      <div class="lyside"><div class="lytabs"><a data-side="notes">Notes</a><a data-side="versions">Versions</a><span class="sp"></span><select class="lyflt" title="which notes"><option value="open">open</option><option value="all">all</option><option value="resolved">resolved</option></select></div>
      <div class="lylist"></div>
      <div class="lyask"><textarea rows="2" placeholder="Ask the agent… (about the selected words, the line, or the whole poem; Ctrl+Enter sends)"></textarea><button data-a="ask" title="writes a note addressed to the agent (MCP lyrics_get lists it); nothing is generated or paid">Ask the agent</button></div></div>
      <button class="lyfab" style="display:none" title="note on the selected words (Alt+N)">+ note</button>`;
    this.$ = (s) => el.querySelector(s);
    this.loadDraft();
    this.wire();
    store.on((w) => { if (['lyrics', 'all', 'stages'].includes(w)) { if (this.editing) this.pending = true; else this.render(); } });
    this.render();
  }
  get doc() { return store.lyrics; }
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
  // ---------------------------------------------------------------- notes
  addNote({ line = null, w = null, quote = '', text, to }) {
    return store.mutate('lyrics.json', (d) => {
      const n = d.notes.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, '')) || 0), 0) + 1;
      d.notes.push({ id: `ln${String(n).padStart(2, '0')}`, line, w, quote, text, by: 'director', ...(to ? { to, kind: 'request' } : {}), status: 'open', at: nowIso(), version: d.current, replies: [] });
    }, { label: to ? 'ask the agent' : 'lyrics note' });
  }
  reply(id, text) { return store.mutate('lyrics.json', (d) => { const n = d.notes.find(x => x.id === id); if (n) (n.replies ||= []).push({ id: `${n.id}.${(n.replies?.length || 0) + 1}`, text, by: 'director', at: nowIso() }); }, { label: 'reply ' + id }); }
  resolve(id) { return store.mutate('lyrics.json', (d) => { const n = d.notes.find(x => x.id === id); if (n) { n.status = n.status === 'open' ? 'resolved' : 'open'; n.resolved_by = 'director'; n.resolved_at = nowIso(); } }, { label: 'resolve ' + id }); }
  async noteOnSelection() {
    const s = this.sel || this.readSelection();
    const line = s?.line || this.el.querySelector('.lyl:focus')?.dataset.line;
    if (!line) return toast('select words in a line (or focus a line) first');
    const L = this.findLine(line)?.l; if (!L) return;
    const w = s?.line === line ? [s.w0, s.w1] : null, quote = w ? F.words(L.text).slice(w[0], w[1] + 1).join(' ') : '';
    const text = await ui.prompt({ title: w ? `Note on “${quote}”` : `Note on the line “${L.text.slice(0, 50)}”`, placeholder: 'note (Enter saves)' });
    if (!text) return;
    await this.addNote({ line, w, quote, text }); this.clearSel(); this.setSide('notes');
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
  setSide(s) { this.side = s; prefs.set('lyricsSide', s); this.renderSide(); }
  // ---------------------------------------------------------------- rendering
  render() {
    this.pending = false;
    if (!this.doc) return;
    this.syncBase();
    this.renderBar(); this.renderSong();
    if (this.compare) this.renderDiff(); else if (this.textMode) this.renderText(); else this.renderPoem();
    this.renderSide();
  }
  renderBar() {
    const v = this.cur, n = F.flatLines({ sections: this.draft }).length;
    const ver = v ? `<b>${esc(v.id)}</b> <span class="dim">${esc(v.message || '')}${v.created ? ' · ' + when(v.created) : ''} · ${v.via === 'agent' ? 'agent' : esc(v.by || '')}</span>` : '<span class="dim">no version yet</span>';
    this.$('.lybar').innerHTML = `${ver}<span class="dim">· ${n} lines · ${this.draft.length} sections</span><span class="sp"></span>`
      + (this.dirty ? `<span class="unsaved">unsaved edits</span><input class="lymsg" placeholder="what changed (optional)" spellcheck="false"><button data-a="save" class="pri" title="Ctrl+Enter: a new version">Save version</button><button data-a="drdiff" title="compare the current version with your edits">diff</button><button data-a="discard">Discard</button>` : '')
      + `<button data-a="text" class="${this.textMode ? 'on' : ''}" title="the whole poem as text with [Section] tags (paste, bulk edits)">Edit as text</button><button data-a="addsec" title="new section at the end">+ section</button><button data-a="compare" title="side-by-side word diff of two versions">Compare…</button>`;
  }
  renderSong() {
    const s = store.song, has = !!s?.audio?.mix, n = s?.lines?.length || 0;
    this.$('.lysong').innerHTML = has
      ? `song <b>${esc(s.audio.mix.split('/').pop())}</b> · ${fmt(s.duration_ms)} · ${s.bpm} bpm · timing ${esc(s.timing || 'imported')}${n ? '' : ' · no lines yet'} <a data-a="song" title="replace the song file">replace…</a>`
      : `<b>no song file yet</b> · timings are estimated over a ${fmt(s?.duration_ms || 0)} placeholder; add the song when you have it (lines keep their order, timings are re-estimated over the real song) <a data-a="song">Add song…</a>`;
    this.$('.lysong').classList.toggle('nosong', !has);
  }
  renderPoem() {
    const poem = this.$('.lypoem');
    if (!this.draft.length) {
      poem.innerHTML = `<div class="lyempty"><h4>Paste the lyrics</h4><textarea class="lypaste" rows="14" spellcheck="false" placeholder="[Verse 1]\nfirst line\nsecond line\n\n[Chorus]\n…"></textarea><div><button data-a="paste" class="pri">Save as the first version</button> <span class="dim">[Section] tags or blank lines split sections; LRC time tags are kept</span></div></div>`;
      return;
    }
    const tm = songLines(), notes = this.doc.notes.filter(x => x.status === 'open'), byLine = new Map();
    for (const x of notes) if (x.line) (byLine.get(x.line) || byLine.set(x.line, []).get(x.line)).push(x);
    let k = 0;
    poem.innerHTML = this.draft.map((s, si) => `<div class="lysec" data-sec="${esc(s.id)}"><div class="lyhead"><span class="lytag" title="double-click to rename">[${esc(s.label)}]</span>
      <span class="lytools"><b data-s="up" title="move section up">↑</b><b data-s="down" title="move section down">↓</b><b data-s="add" title="add a line at the end">+</b><b data-s="ren" title="rename">✎</b><b data-s="del" title="delete the section">×</b></span></div>`
      + s.lines.map((l) => {
        k++; const t = tm.get(l.id), ns = byLine.get(l.id) || [], marks = new Set();
        for (const x of ns) { const r = F.anchorWords(l.text, x); if (r) for (let i = r[0]; i <= r[1]; i++) marks.add(i); }
        const ws = F.words(l.text).map((w, i) => `<span class="w${marks.has(i) ? ' nw' : ''}" data-i="${i}">${esc(w)}</span>`).join(' ');
        const changed = this.cur && !F.flatLines(this.cur).some(x => x.id === l.id && x.text === l.text);
        return `<div class="lyl${ns.length ? ' hasn' : ''}${changed ? ' chg' : ''}" data-line="${esc(l.id)}" tabindex="0"><span class="lyn">${k}</span><span class="lyt" ${t ? `data-t="${t.t0}" title="${t.timing === 'estimated' ? 'estimated: ' : ''}${fmt(t.t0, true)} – ${fmt(t.t1, true)} (click: show in the timeline)"` : 'title="no timing yet (saved versions get one)"'}>${t ? (t.timing === 'estimated' ? '~' : '') + fmt(t.t0) : '·'}</span><span class="lytx">${ws || '<span class="dim">(empty)</span>'}</span>${ns.length ? `<span class="lynb" title="${ns.length} open note(s)">${ns.length}</span>` : ''}
          <span class="lytools"><b data-l="up" title="move up (Alt+Up)">↑</b><b data-l="down" title="move down (Alt+Down)">↓</b><b data-l="add" title="add a line below (Shift+Enter)">+</b><b data-l="edit" title="edit (Enter, F2, double-click)">✎</b><b data-l="note" title="note on this line (Alt+N; select words first to pin it to them)">✉</b><b data-l="del" title="delete the line">×</b></span></div>`;
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
    for (const a of this.el.querySelectorAll('.lytabs [data-side]')) { a.classList.toggle('on', a.dataset.side === this.side); const n = a.dataset.side === 'notes' ? this.doc.notes.filter(x => x.status === 'open').length : this.doc.versions.length; a.innerHTML = `${a.dataset.side === 'notes' ? 'Notes' : 'Versions'}<i>${n}</i>`; }
    this.$('.lyflt').style.display = this.side === 'notes' ? '' : 'none'; this.$('.lyflt').value = this.filter;
    this.$('.lyask').style.display = this.side === 'notes' ? '' : 'none';
    const list = this.$('.lylist');
    if (this.side === 'versions') {
      const vs = [...this.doc.versions].reverse(), { a, b } = this.ab;
      list.innerHTML = `<div class="lyvh"><span class="dim">pick A and B, or click a row (it vs the one before)</span><button data-a="ab" ${a && b && a !== b ? '' : 'disabled'}>Compare A → B</button></div>` + vs.map(v => `<div class="lyv${v.id === this.doc.current ? ' cur' : ''}" data-v="${esc(v.id)}">
        <span class="lyvid">${v.id === this.doc.current ? '●' : ''}${esc(v.id)}</span><span class="lyvm">${esc(v.message || (v.from ? 'restore ' + v.from : ''))}<i>${when(v.created)} ${v.via === 'agent' ? '· agent' : v.by ? '· ' + esc(v.by) : ''} · ${F.flatLines(v).length} lines</i></span>
        <b data-ab="a" class="${a === v.id ? 'on' : ''}">A</b><b data-ab="b" class="${b === v.id ? 'on' : ''}">B</b>${v.id === this.doc.current ? '' : `<b data-a="restore" data-v="${esc(v.id)}" title="copy it as a new version">restore</b>`}</div>`).join('');
      return;
    }
    const lines = F.flatLines({ sections: this.draft }), order = new Map(lines.map((l, i) => [l.id, i]));
    const ns = this.doc.notes.filter(x => this.filter === 'all' || x.status === this.filter).sort((x, y) => (order.get(x.line) ?? -1) - (order.get(y.line) ?? -1) || String(x.at).localeCompare(String(y.at)));
    list.innerHTML = ns.length ? ns.map(x => {
      const L = lines.find(l => l.id === x.line), r = L ? F.anchorWords(L.text, x) : null;
      const where = !x.line ? 'whole poem' : !L ? `${esc(x.line)} (not in the draft)` : `l.${order.get(x.line) + 1}${x.quote ? ` “${esc(x.quote)}”${x.w && !r ? ' <i class="dim">(text changed)</i>' : ''}` : ''}`;
      return `<div class="lynote ${x.status}${x.to === 'agent' ? ' ask' : ''}" data-note="${esc(x.id)}" data-line="${esc(x.line || '')}">
        <div class="lynh">${who(x)}${x.to === 'agent' ? '<span class="to">→ agent</span>' : ''}<a data-go="${esc(x.line || '')}">${where}</a><span class="sp"></span><span class="dim">${when(x.at)}</span><b data-a="resolve" title="${x.status === 'open' ? 'resolve' : 'reopen'}">${x.status === 'open' ? '✓' : '↺'}</b></div>
        <div class="lynt">${esc(x.text)}</div>${(x.replies || []).map(rp => `<div class="lynr">${who(rp)} ${esc(rp.text)} <span class="dim">${when(rp.at)}</span></div>`).join('')}
        <input class="lyrep" placeholder="reply (Enter)" spellcheck="false"></div>`;
    }).join('') : `<div class="dim lyno">${this.filter === 'open' ? 'No open notes. Select words in a line and press “+ note” (Alt+N), or ask the agent below.' : 'No notes.'}</div>`;
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
    this.edit(() => {
      const f = this.findLine(id); if (!f) return;
      const si = this.draft.indexOf(f.s), j = f.i + dir;
      if (j >= 0 && j < f.s.lines.length) { const [l] = f.s.lines.splice(f.i, 1); f.s.lines.splice(j, 0, l); }
      else { const t = this.draft[si + dir]; if (!t) return; const [l] = f.s.lines.splice(f.i, 1); if (dir < 0) t.lines.push(l); else t.lines.unshift(l); }
    });
    this.el.querySelector(`.lyl[data-line="${CSS.escape(id)}"]`)?.focus();
  }
  addLineAfter(id, sec) {
    const nid = this.newLineId();
    this.edit(() => { if (id) { const f = this.findLine(id); f.s.lines.splice(f.i + 1, 0, { id: nid, text: '' }); } else { const s = this.draft.find(x => x.id === sec); s.lines.push({ id: nid, text: '' }); } }, true);
    this.render(); this.editLine(nid);
  }
  async addSection() {
    const label = await ui.prompt({ title: 'New section: label (Verse 2, Chorus, Bridge…)', placeholder: 'section label' }); if (!label) return;
    let id = F.slug(label); for (let n = 2; this.draft.some(s => s.id === id); n++) id = `${F.slug(label)}-${n}`;
    const nid = this.newLineId();
    this.edit(() => { this.draft.push({ id, label: label.replace(/[[\]]/g, '').trim(), lines: [{ id: nid, text: '' }] }); }, true);
    this.compare = null; this.textMode = false; this.render(); this.editLine(nid);
  }
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
      if (act === 'paste') { const v = this.$('.lypaste').value; if (!v.trim()) return; this.draft = F.assignIds(F.parseText(v), null, this.doc).sections; this.saveDraft(); return this.save('first draft'); }
      if (act === 'ask') return this.ask();
      if (act === 'resolve') return this.resolve(t.closest('[data-note]').dataset.note);
      const side = t.closest('[data-side]'); if (side) return this.setSide(side.dataset.side);
      const ab = t.closest('[data-ab]'); if (ab) { const v = ab.closest('[data-v]').dataset.v; this.ab[ab.dataset.ab] = this.ab[ab.dataset.ab] === v ? null : v; return this.renderSide(); }
      const vrow = t.closest('.lyv[data-v]');
      if (vrow) { const i = this.doc.versions.findIndex(v => v.id === vrow.dataset.v); const prev = this.doc.versions[i - 1]; this.compare = prev ? { a: prev.id, b: vrow.dataset.v } : { a: vrow.dataset.v, b: this.doc.current }; this.textMode = false; return this.render(); }
      const go = t.closest('[data-go]'); if (go?.dataset.go) { this.compare = null; this.textMode = false; this.flash = go.dataset.go; return this.render(); }
      const tm = t.closest('.lyt[data-t]'); if (tm) return this.ctx.goto(Number(tm.dataset.t));
      if (t === this.$('.lyfab')) return this.noteOnSelection();
      const lb = t.closest('[data-l]'), id = t.closest('.lyl')?.dataset.line;
      if (lb && id) {
        const a = lb.dataset.l;
        if (a === 'up' || a === 'down') return this.moveLine(id, a === 'up' ? -1 : 1);
        if (a === 'add') return this.addLineAfter(id);
        if (a === 'edit') return this.editLine(id);
        if (a === 'del') return this.edit((d) => { const f = this.findLine(id); f?.s.lines.splice(f.i, 1); });
        if (a === 'note') { this.sel = null; this.el.querySelector(`.lyl[data-line="${CSS.escape(id)}"]`)?.focus(); return this.noteOnSelection(); }
      }
      const sb = t.closest('[data-s]'), sid = t.closest('.lysec')?.dataset.sec;
      if (sb && sid) {
        const a = sb.dataset.s, i = this.draft.findIndex(s => s.id === sid);
        if (a === 'up' || a === 'down') { const j = i + (a === 'up' ? -1 : 1); if (j < 0 || j >= this.draft.length) return; return this.edit((d) => { const [s] = d.splice(i, 1); d.splice(j, 0, s); }); }
        if (a === 'add') return this.addLineAfter(null, sid);
        if (a === 'ren') return this.editSection(sid);
        if (a === 'del') { const n = this.draft[i].lines.length; if (n && !(await ui.confirm(`Delete section [${this.draft[i].label}] and its ${n} line(s) from the draft?`))) return; return this.edit((d) => { d.splice(i, 1); }); }
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
    el.addEventListener('keydown', (e) => {
      const row = e.target.closest?.('.lyl');
      if (e.target.matches('.lyrep')) { e.stopPropagation(); if (e.key === 'Enter' && e.target.value.trim()) { this.reply(e.target.closest('[data-note]').dataset.note, e.target.value.trim()); e.target.value = ''; } if (e.key === 'Escape') e.target.blur(); return; }
      if (e.target.matches('.lyask textarea')) { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.ask(); } return; }
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
      if (e.key === 'Delete' && !e.ctrlKey) return k(() => this.edit(() => { const f = this.findLine(id); f?.s.lines.splice(f.i, 1); }));
    });
    this.$('.lyflt').addEventListener('change', (e) => { this.filter = e.target.value; this.renderSide(); });
    this.$('.lylist').addEventListener('mouseover', (e) => {
      const n = e.target.closest('.lynote'); for (const x of this.el.querySelectorAll('.lyl.hl')) x.classList.remove('hl');
      if (n?.dataset.line) this.el.querySelector(`.lyl[data-line="${CSS.escape(n.dataset.line)}"]`)?.classList.add('hl');
    });
  }
  async ask() {
    const ta = this.$('.lyask textarea'), text = ta.value.trim(); if (!text) { ta.focus(); return; }
    const s = this.sel, L = s ? this.findLine(s.line)?.l : null;
    await this.addNote({ line: L ? s.line : null, w: L ? [s.w0, s.w1] : null, quote: L ? F.words(L.text).slice(s.w0, s.w1 + 1).join(' ') : '', text, to: 'agent' });
    ta.value = ''; this.clearSel(); toast('asked the agent (a note it reads with lyrics_get)');
  }
}

// ------------------------------------------------------------------ commands (registered at load: core/rail.js imports this module)
const L = (c) => visible() && !!S;
commands.register([
  { id: 'lyrics.save', group: 'Lyrics', title: 'Save lyrics version', when: () => L() && S.dirty, run: () => S.save() },
  { id: 'lyrics.discard', group: 'Lyrics', title: 'Discard unsaved lyrics edits', when: () => L() && S.dirty, run: () => S.discard() },
  { id: 'lyrics.note', group: 'Lyrics', title: 'Note on the selected words / line', when: () => L(), run: () => S.noteOnSelection() },
  { id: 'lyrics.text', group: 'Lyrics', title: 'Edit lyrics as text', checked: () => !!S?.textMode, when: () => L(), run: () => { S.textMode = !S.textMode; S.compare = null; S.render(); } },
  { id: 'lyrics.addSection', group: 'Lyrics', title: 'Add a lyrics section…', when: () => L(), run: () => S.addSection() },
  { id: 'lyrics.compare', group: 'Lyrics', title: 'Compare lyrics versions…', when: () => !!store.lyrics?.versions?.length, run: async () => {
    if (!visible()) await WB().stages.open('lyrics');
    const vs = [...store.lyrics.versions].reverse().map(v => ({ label: v.id, detail: `${v.message || ''} ${v.created ? v.created.replace('T', ' ') : ''}`, value: v.id }));
    const a = await ui.pick({ title: 'Compare: older version (A)', items: vs }); if (!a) return;
    const b = await ui.pick({ title: `Compare ${a} with (B)`, items: [{ label: 'your unsaved edits', detail: 'draft', value: 'draft' }, ...vs.filter(v => v.value !== a)] }); if (!b) return;
    S.compare = { a, b }; S.textMode = false; S.render();
  } },
  { id: 'lyrics.ask', group: 'Lyrics', title: 'Ask the agent about the lyrics…', run: async () => { if (!visible()) await WB().stages.open('lyrics'); S?.setSide('notes'); S?.$('.lyask textarea')?.focus(); } },
  { id: 'lyrics.addSong', group: 'Lyrics', title: () => store.song?.audio?.mix ? 'Replace the song file…' : 'Add the song file…', run: async () => { if (!visible()) await WB().stages.open('lyrics'); S?.songDialog(); } },
]);

// Ctrl+Enter and Alt+N in a stage workspace are the rail's stage.save / stage.note (core/rail.js): they ask the visible stage
window.WB = Object.assign(window.WB || {}, { stageActions: { ...(window.WB?.stageActions || {}), lyrics: { canSave: () => L() && S.dirty, save: () => S.save(), canNote: () => L(), note: () => S.noteOnSelection() } } });

export default {
  mount(el, ctx) { S = new Workspace(el, ctx); },
  show() { if (S && !S.editing) S.render(); },
  get ws() { return S; },
};
