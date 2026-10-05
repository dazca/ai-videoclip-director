// Command palette (Ctrl+K / Ctrl+Shift+P), find (Ctrl+F), and two small dialogs built on the same box:
// ui.prompt (one line of text) and ui.pick (fuzzy chooser). Also the cheat sheet overlay (?).
// One input row + up to 16 result rows of 20 px; Up/Down, PageUp/PageDown, Enter, Esc.
import { commands, context, keyLabel } from './commands.js';
import { noteTime } from '../js/notes.js';
import { currentScript } from '../js/scenes.js';
import { store } from '../js/store.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const fmt = (ms) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };

// fuzzy score: every query char in order; bonus for word starts and runs; -1 = no match
export function fuzzy(q, s) {
  if (!q) return 0;
  q = q.toLowerCase(); const t = s.toLowerCase();
  const direct = t.indexOf(q); if (direct >= 0) return 1000 - direct * 2 - t.length * 0.1 + (direct === 0 || /\W/.test(t[direct - 1]) ? 200 : 0);
  let score = 0, j = 0, run = 0;
  for (let i = 0; i < t.length && j < q.length; i++) {
    if (t[i] === q[j]) { run++; score += 10 + run * 5 + (i === 0 || /[\s.\-_/:]/.test(t[i - 1]) ? 30 : 0); j++; } else run = 0;
  }
  return j === q.length ? score - t.length * 0.1 : -1;
}

let box = null;
function closeBox(v) { if (!box) return; const b = box; box = null; b.el.remove(); b.resolve?.(v); }
function finish(onPick, r) { if (box) { box.el.remove(); box = null; } onPick(r); }
export const isOpen = () => !!box;

// generic box: source(q) -> rows [{label, detail, keys, group, value, run?}]
function openBox({ placeholder, value = '', source, onPick, freeText = false, title }) {
  closeBox(null);
  const el = document.createElement('div'); el.className = 'pal';
  el.innerHTML = `${title ? `<div class="pt">${esc(title)}</div>` : ''}<input spellcheck="false" placeholder="${esc(placeholder || '')}"><div class="pl"></div>`;
  document.body.appendChild(el);
  const inp = el.querySelector('input'), list = el.querySelector('.pl');
  let rows = [], idx = 0;
  const render = () => {
    rows = source ? source(inp.value) : [];
    idx = Math.min(idx, Math.max(0, rows.length - 1));
    list.innerHTML = rows.slice(0, 200).map((r, i) => `<div class="pr${i === idx ? ' hl' : ''}${r.disabled ? ' dis' : ''}" data-i="${i}"><span class="g">${esc(r.group || '')}</span><span class="lb">${esc(r.label)}${r.detail ? ` <i>${esc(r.detail)}</i>` : ''}</span><span class="ky">${esc(keyLabel(r.keys || ''))}</span></div>`).join('')
      || (source && !freeText ? '<div class="pr dis"><span class="lb">no match</span></div>' : '');
    list.querySelector('.hl')?.scrollIntoView({ block: 'nearest' });
  };
  const move = (d) => { if (!rows.length) return; idx = Math.max(0, Math.min(rows.length - 1, idx + d)); for (const x of list.children) x.classList.toggle('hl', Number(x.dataset.i) === idx); list.querySelector('.hl')?.scrollIntoView({ block: 'nearest' }); };
  inp.addEventListener('input', () => { idx = 0; render(); });
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeBox(null); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); move(10); }
    else if (e.key === 'PageUp') { e.preventDefault(); move(-10); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[idx];
      if (r && !r.disabled) finish(onPick, r);
      else if (freeText) finish(onPick, { value: inp.value, free: true });
    }
  });
  list.addEventListener('pointerdown', (e) => { const r = e.target.closest('.pr[data-i]'); if (!r) return; e.preventDefault(); const row = rows[Number(r.dataset.i)]; if (row && !row.disabled) finish(onPick, row); });
  inp.addEventListener('blur', () => setTimeout(() => { if (box && box.el === el && !el.contains(document.activeElement)) closeBox(null); }, 150));
  box = { el, resolve: null };
  inp.value = value; render(); inp.focus(); inp.select();
  return box;
}

// ------------------------------------------------------------------ the palette
function commandRows(q) {
  const c = context();
  const rec = commands.recent();
  const rows = [];
  for (const cmd of commands.list()) {
    if (cmd.hidden || !commands.enabled(cmd, c)) continue;
    const title = commands.title(cmd, c);
    const hay = `${title} ${cmd.group} ${cmd.id}`;
    const s = q ? fuzzy(q, `${title}`) * 1.2 : 0;
    const s2 = q ? Math.max(s, fuzzy(q, hay)) : 0;
    if (q && s2 < 0) continue;
    const r = rec.indexOf(cmd.id);
    rows.push({ label: title, group: cmd.group, keys: commands.keysFor(cmd.id)[0], id: cmd.id, score: s2 + (r >= 0 ? 60 - r * 4 : 0) });
  }
  rows.sort((a, b) => b.score - a.score || a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  return rows;
}
function findRows(q) {
  if (!q || q.length < 2) return [{ label: 'type to find lyrics, script, notes, shots, clips, entities, ids', disabled: true }];
  const out = [];
  const add = (group, label, detail, t, extra) => { const s = Math.max(fuzzy(q, label), fuzzy(q, detail || '') - 50); if (s >= 0) out.push({ group, label, detail, t, score: s, ...extra }); };
  for (const l of store.song.lines) add('lyric', l.text, `${l.id} · ${fmt(l.t0)}`, l.t0);
  for (const s of store.script.lines) add('script', `${s.id} ${s.action}`, fmt(s.t0), s.t0);
  const nctx = { song: store.song, scenes: currentScript(store.scenes)?.scenes || [], shots: store.boardShots() };
  for (const n of store.notes.notes) { const t = noteTime(n, nctx); add('note', n.text, `${n.via === 'agent' ? 'agent' : 'director'} · ${n.target.stage}${t != null ? ' · ' + fmt(t) : ''}`, t, { key: 'note:' + n.id, stage: n.target.stage }); }
  for (const s of store.shots) add('shot', `${s.id} ${s.title || ''}`, fmt(s.t0), s.t0, { key: 'shot:' + s.id });
  for (const u of store.uses) add('clip', `${u.id} ${u.label || ''}`, fmt(u.t0), u.t0, { key: 'use:' + u.id });
  for (const s of store.song.sections) add('section', `${store.secLabel(s)} (${s.id})`, fmt(s.t0), s.t0);
  for (const e of store.entities) add(e.kind, `${e.name} (${e.id})`, e.role || e.description || '', null, { tab: e.kind === 'character' ? 'characters' : e.kind + 's' });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 200);
}

export const palette = {
  open({ mode = 'commands', query = '' } = {}) {
    if (mode === 'find') {
      return openBox({ placeholder: 'find: lyrics, script, notes, shot/clip ids, entities', value: query, source: findRows, onPick: (r) => {
        if (r.tab) return commands.run('window.tab', { tabId: r.tab });
        if (r.t == null && r.stage && r.stage !== 'timeline') return window.WB.stages.open(r.stage);
        if (r.t != null) { window.WB.ctx.goto(r.t); if (r.key) window.WB.selection.set([r.key]); }
      } });
    }
    return openBox({ placeholder: 'run a command…  (Ctrl+F finds, ? lists keys)', value: query, source: commandRows, onPick: (r) => commands.run(r.id) });
  },
  close: () => closeBox(null),
  isOpen,
};

export const ui = {
  prompt({ title, value = '', placeholder = '' }) {
    return new Promise((resolve) => {
      const b = openBox({ title, placeholder: placeholder || 'Enter to confirm, Esc to cancel', value, freeText: true, source: null, onPick: (r) => resolve(r.value) });
      b.resolve = (v) => resolve(v);
    });
  },
  pick({ title, items, placeholder = 'filter…' }) {
    return new Promise((resolve) => {
      const b = openBox({ title, placeholder, source: (q) => items.map(it => ({ ...it, score: q ? Math.max(fuzzy(q, it.label), fuzzy(q, it.detail || '') - 50) : 0 })).filter(it => it.score >= 0).sort((a, b) => b.score - a.score), onPick: (r) => resolve(r.value) });
      b.resolve = (v) => resolve(v);
    });
  },
  confirm(title) { return ui.pick({ title, items: [{ label: 'Yes', value: true }, { label: 'Cancel', value: false }], placeholder: '' }).then(v => !!v); },
};

// ------------------------------------------------------------------ cheat sheet (?)
let sheet = null;
export const cheatsheet = {
  isOpen: () => !!sheet,
  toggle() { sheet ? this.close() : this.open(); },
  close() { sheet?.remove(); sheet = null; },
  open() {
    this.close();
    const groups = {};
    for (const cmd of commands.list()) { if (cmd.hidden) continue; const keys = commands.keysFor(cmd.id); if (!keys.length) continue; (groups[cmd.group] ||= []).push({ t: commands.title(cmd, context()), keys }); }
    const mouse = [['wheel', 'scroll time'], ['Ctrl+wheel / pinch', 'zoom time at the cursor'], ['Shift+wheel', 'scroll columns sideways'], ['Alt+wheel, Ctrl+Shift+wheel', 'widen / narrow the column under the cursor'],
      ['middle-drag', 'pan'], ['drag on the ruler', 'select a time range'], ['click / Shift+click', 'seek + select / extend selection'], ['right-click', 'context menu'],
      ['double-click header', 'auto-fit width'], ['double-click separator', 'reset width'], ['drag header', 'reorder columns'], ['drag separator', 'resize (down to 3 px)'],
      ['⌄ top-right corner', 'show the hidden top bar'], ['⌄ on the time ruler', 'show the hidden column header'], ['⚙ (far right of the bar)', 'Settings']];
    sheet = document.createElement('div'); sheet.className = 'cheat';
    sheet.innerHTML = `<div class="ch">keys <i>(pages: 1 Timeline · 2 Assets · 3 Review · 4 Settings · rebind in Settings (Ctrl+,) · Esc or ? closes)</i></div><div class="cc">${Object.entries(groups).map(([g, l]) => `<section><h5>${esc(g)}</h5>${l.map(x => `<div title="${esc(x.keys.join(' · ') + '  ' + x.t)}"><kbd>${x.keys.map(k => esc(keyLabel(k))).join(' · ')}</kbd><span>${esc(x.t)}</span></div>`).join('')}</section>`).join('')}
      <section class="mouse"><h5>Mouse</h5>${mouse.map(([k, t]) => `<div><kbd>${esc(k)}</kbd><span>${esc(t)}</span></div>`).join('')}</section></div>`;
    sheet.addEventListener('pointerdown', (e) => { if (e.target === sheet) this.close(); });
    document.body.appendChild(sheet);
  },
};
