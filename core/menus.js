// Menus: popup menus with submenus (keyboard navigable), context-menu contributions, the compact menu bar.
// Item lists are described in core/commands.js (WB.menus.contribute). Rows 20 px, 12 px type, key hints on the right.
import { commands, context, keyLabel } from './commands.js';

const contrib = new Map();       // context -> [{items}]
export const BAR = ['File', 'Edit', 'View', 'Timeline', 'Generate', 'Window', 'Help'];

export const menus = {
  contribute(ctxName, items) {
    const rec = { items };
    if (!contrib.has(ctxName)) contrib.set(ctxName, []);
    contrib.get(ctxName).push(rec);
    return () => { const l = contrib.get(ctxName); const i = l.indexOf(rec); if (i >= 0) l.splice(i, 1); };
  },
  itemsFor(ctxName) { return (contrib.get(ctxName) || []).flatMap((r, i) => (i ? ['-'] : []).concat(r.items)); },
  // right-click: specific contexts first, then the generic ones, separated
  forContexts(names) {
    const out = [];
    for (const n of names) { const its = this.itemsFor(n); if (its.length) { if (out.length) out.push('-'); out.push(...its); } }
    return out;
  },
  open(items, at, c) { return openMenu(items, at, c || context()); },
  close: () => closeAll(),
  isOpen: () => stack.length > 0,
};

// ------------------------------------------------------------------ resolve items
function resolve(items, c, { hideDisabled }) {
  const out = [];
  const src = [];
  for (const it of (typeof items === 'function' ? items(c) : items) || []) { if (typeof it === 'function') src.push(...(safe(() => it(c)) || [])); else src.push(it); }
  for (let it of src) {
    if (it === '-') { if (out.length && out[out.length - 1].sep !== true) out.push({ sep: true }); continue; }
    if (typeof it === 'string') it = { cmd: it };
    let r;
    if (it.cmd) {
      const cmd = commands.get(it.cmd); if (!cmd) continue;
      const cc = it.args ? { ...c, ...it.args } : c;
      const en = commands.enabled(cmd, cc);
      if (!en && hideDisabled) continue;
      r = { label: it.label || commands.title(cmd, cc), keys: commands.keysFor(cmd.id)[0], disabled: !en, checked: cmd.checked ? !!safe(() => cmd.checked(cc)) : null,
        run: () => commands.run(cmd.id, { ...(c.__args || {}), ...(it.args || {}) }), id: cmd.id };
    } else {
      const en = it.when ? !!safe(() => it.when(c)) : true;
      if (!en && hideDisabled) continue;
      r = { label: typeof it.label === 'function' ? it.label(c) : it.label, keys: it.keys, disabled: !en || it.disabled, checked: it.checked ? !!safe(() => it.checked(c)) : null,
        run: it.run ? () => it.run(c) : null, submenu: it.submenu, detail: it.detail };
    }
    out.push(r);
  }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out;
}
const safe = (f) => { try { return f(); } catch (e) { return false; } };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

// ------------------------------------------------------------------ popup menus
const stack = [];   // open menus, root first: {el, rows, idx, c, opts}
let barState = null; // {name} when opened from the menu bar

function closeFrom(level) { while (stack.length > level) stack.pop().el.remove(); }
function closeAll() { closeFrom(0); if (barState) { barState.btn?.classList.remove('on'); barState = null; } document.removeEventListener('pointerdown', outside, true); }
function outside(e) { if (!stack.some(m => m.el.contains(e.target)) && !e.target.closest('.mbar')) closeAll(); }

function openMenu(items, at, c, opts = {}) {
  if (!opts.level) closeFrom(0);
  const level = opts.level || 0;
  const rows = resolve(items, c, { hideDisabled: !!opts.hideDisabled });
  const el = document.createElement('div'); el.className = 'pop'; el.setAttribute('role', 'menu');
  el.innerHTML = rows.length ? rows.map((r, i) => r.sep ? '<div class="ps"></div>' :
    `<div class="pi${r.disabled ? ' dis' : ''}" data-i="${i}" role="menuitem"><span class="ck">${r.checked ? '✓' : ''}</span><span class="lb">${esc(r.label)}${r.detail ? ` <i>${esc(r.detail)}</i>` : ''}</span><span class="ky">${r.submenu ? '' : esc(keyLabel(r.keys || ''))}</span><span class="ar">${r.submenu ? '›' : ''}</span></div>`).join('')
    : '<div class="pi dis"><span class="ck"></span><span class="lb">(nothing here)</span></div>';
  document.body.appendChild(el);
  // place inside the viewport (submenus flip to the left when needed)
  const W = innerWidth, H = innerHeight, r = el.getBoundingClientRect();
  let x = at.x, y = at.y;
  if (x + r.width > W) x = at.flipX != null ? at.flipX - r.width : W - r.width - 1;
  if (y + r.height > H) y = Math.max(0, H - r.height - 1);
  el.style.left = Math.max(0, x) + 'px'; el.style.top = Math.max(0, y) + 'px';
  const m = { el, rows, idx: -1, c, opts, level };
  stack[level] = m;
  if (level === 0) setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  let hoverT = 0;
  el.addEventListener('pointermove', (e) => {
    const row = e.target.closest('.pi[data-i]'); if (!row) return;
    const i = Number(row.dataset.i); if (i === m.idx) return;
    setIdx(m, i); clearTimeout(hoverT);
    hoverT = setTimeout(() => { if (m.rows[i].submenu) openSub(m, i); else closeFrom(level + 1); }, 90);
  });
  el.addEventListener('click', (e) => {
    const row = e.target.closest('.pi[data-i]'); if (!row) return;
    activate(m, Number(row.dataset.i));
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return m;
}
function setIdx(m, i) {
  m.idx = i;
  for (const x of m.el.querySelectorAll('.pi')) x.classList.toggle('hl', Number(x.dataset.i) === i);
}
function openSub(m, i) {
  closeFrom(m.level + 1);
  const row = m.el.querySelector(`.pi[data-i="${i}"]`); const r = row.getBoundingClientRect();
  const sub = openMenu(m.rows[i].submenu, { x: r.right - 1, y: r.top - 3, flipX: m.el.getBoundingClientRect().left + 1 }, m.c, { level: m.level + 1, hideDisabled: m.opts.hideDisabled });
  return sub;
}
function activate(m, i) {
  const r = m.rows[i]; if (!r || r.sep || r.disabled) return;
  if (r.submenu) { const s = openSub(m, i); setIdx(s, firstEnabled(s, 0, 1)); return; }
  closeAll();
  r.run?.();
}
function firstEnabled(m, from, dir) {
  const n = m.rows.length;
  for (let k = 0; k < n; k++) { const i = ((from + k * dir) % n + n) % n; if (!m.rows[i].sep && !m.rows[i].disabled) return i; }
  return -1;
}

// keyboard: the topmost menu gets the keys first (capture phase, before the keymap)
document.addEventListener('keydown', (e) => {
  if (!stack.length) return;
  const m = stack[stack.length - 1];
  const k = e.key;
  const eat = () => { e.preventDefault(); e.stopPropagation(); };
  if (k === 'ArrowDown') { eat(); setIdx(m, firstEnabled(m, m.idx + 1, 1)); }
  else if (k === 'ArrowUp') { eat(); setIdx(m, firstEnabled(m, m.idx < 0 ? m.rows.length - 1 : m.idx - 1, -1)); }
  else if (k === 'ArrowRight') {
    eat();
    if (m.idx >= 0 && m.rows[m.idx].submenu) { const s = openSub(m, m.idx); setIdx(s, firstEnabled(s, 0, 1)); }
    else if (barState) barMove(1);
  } else if (k === 'ArrowLeft') {
    eat();
    if (stack.length > 1) closeFrom(stack.length - 1); else if (barState) barMove(-1);
  } else if (k === 'Enter' || k === ' ') { eat(); if (m.idx >= 0) activate(m, m.idx); }
  else if (k === 'Escape') { eat(); if (stack.length > 1) closeFrom(stack.length - 1); else closeAll(); }
  else if (k === 'Tab') { eat(); }
  else if (k.length === 1 && /\w/.test(k) && !e.ctrlKey && !e.altKey) {
    // type-ahead: first row starting with the letter
    eat(); const L = k.toLowerCase(); const n = m.rows.length;
    for (let s = 1; s <= n; s++) { const i = (m.idx + s) % n; const r = m.rows[i]; if (!r.sep && !r.disabled && String(r.label).toLowerCase().startsWith(L)) { setIdx(m, i); break; } }
  }
}, true);

// ------------------------------------------------------------------ menu bar (lives in the hideable top bar)
let barEl = null;
export function renderMenuBar(host) {
  barEl = document.createElement('span'); barEl.className = 'mbar';
  barEl.innerHTML = BAR.map(n => `<b data-m="${n}">${n}</b>`).join('');
  host.prepend(barEl);
  barEl.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    e.preventDefault();
    if (barState && barState.name === b.dataset.m) { closeAll(); return; }
    openBar(b.dataset.m);
  });
  barEl.addEventListener('pointerover', (e) => { const b = e.target.closest('[data-m]'); if (b && barState && barState.name !== b.dataset.m) openBar(b.dataset.m); });
  return barEl;
}
export function openBar(name, { keyboard = false } = {}) {
  const host = barEl || document.querySelector('.mbar'); if (!host) return;
  closeAll();
  const btn = host.querySelector(`[data-m="${name}"]`); btn.classList.add('on');
  const r = btn.getBoundingClientRect();
  const m = openMenu(menus.itemsFor('menubar:' + name), { x: r.left, y: r.bottom }, context(), { level: 0 });
  barState = { name, btn };
  if (keyboard) setIdx(m, firstEnabled(m, 0, 1));
  return m;
}
function barMove(d) { const i = BAR.indexOf(barState.name); openBar(BAR[(i + d + BAR.length) % BAR.length], { keyboard: true }); }
