/* =====================================================================================================================
   Director Workbench: command registry and keymap (Part A).  Everything the user can do is a COMMAND; the menu bar,
   the palette (Ctrl+K), context menus, the cheat sheet (?) and the keybindings table are all built from this registry.
   Tab modules (Part B: preview dock, Media, Characters...) extend the UI only through this API, exposed on window.WB:

   WB.commands.register(cmd | cmd[])        add or replace commands
       cmd = { id: 'group.name',             stable id; used by menus and by settings.json keybindings
               title: 'Approve',             label in menus / palette (a function (c) => string is allowed)
               group: 'Edit',                File | Edit | View | Timeline | Generate | Window | Help | Column | ...
               keys: ['A'],                  default bindings (see "key names" below), [] for none
               when: (c) => bool | 'timeline' | 'tl' | 'sel',   enabled? ('timeline' = timeline tab active,
                                             'tl' = timeline exists, 'sel' = something selected); false hides it in
                                             context menus, greys it in the menu bar, skips it for keys and palette
               checked: (c) => bool,         tick in menus (toggles)
               global: true,                 also fires while typing in an input (e.g. palette, save)
               hidden: true,                 not listed in the palette / cheat sheet (still bindable)
               run: (c) => any }             c = WB.context(args), see below
   WB.commands.run(id, args?)               run with the default context merged with args; returns run()'s result
   WB.commands.get(id) / list()             lookup; list() is every registered command
   WB.commands.enabled(id, c?)              evaluate `when`
   WB.commands.keysFor(id)                  effective keys: the settings.json override, else the defaults
   WB.context(args?)                        { tab, t (playhead ms), tl, store, sel (WB.selection), section, line,
                                             shot, use, col (hovered column), target (DOM element), ...args }
                                             right-click menus pass { t, target, col, section, line, shot, use,
                                             entity, note, header } for what was clicked
   WB.keymap.set(id, keys[]) / reset(id) / resetAll() / conflicts()   persisted in data/<project>/settings.json
                                             as { keybindings: { "<id>": ["Ctrl+K", ...] } }; conflicts() = [{key,
                                             ids[]}] for keys bound to several commands
   WB.keymap.combo(KeyboardEvent)           normalised key name of an event (for capture UIs)

   WB.menus.contribute(context, items)      add items to a context menu or a menu-bar menu (core/menus.js)
       context: 'timeline' (any right-click on the sheet), 'ruler', 'lyric', 'section', 'shot', 'clip', 'cast',
                'note', 'header', 'entity', 'empty', or a menu-bar menu 'menubar:File' ... 'menubar:Help'
       items:   [ 'commandId'                                      a command (title, keys, when, checked from it)
                | { cmd: 'commandId', args?: {...}, label? }        a command with extra context args
                | { label, run(c), when?(c), checked?(c), keys? }   an ad-hoc item
                | { label, submenu: items | (c) => items }          a submenu (built lazily when opened)
                | '-' ]                                             a separator
       contribute() returns a function that removes the contribution.
   WB.menus.open(items, {x, y}, c?)         open any item list as a popup menu at a point
   WB.ui.prompt({title, value?, placeholder?}) -> Promise<string|null>    one-line input (palette style)
   WB.ui.pick({title, items:[{label, detail?, value}]}) -> Promise<value|null>   fuzzy chooser (palette style)
   WB.palette.open({mode?: 'commands'|'find', query?})                   the command palette / find
   WB.selection: { keys:Set, range:{t0,t1}|null, set(keys), add(key), toggle(key), clear(), setRange(r) }
                 keys are approval-style ids: 'shot:c1-desk', 'use:G05@20158', 'script:s07', 'note:n03',
                 'section:verse1', 'line:verse1/3', 'character:dani', 'request:r...'
   WB.dock: { open(), close(), toggle(), isOpen(), show(source), el, body }   PLACEHOLDER (core/dock.js): Part B
                 replaces the implementation and keeps this interface. source = {kind, src?, title?, t?, ...}
   WB.requests.create({kind, target, prompt, refs, est_cost})  -> draft entry in requests.json (Queue tab)

   Key names: modifiers in the order Ctrl+Alt+Shift+, then A-Z, 0-9, F1-F12, Space, Enter, Escape, Tab, Backspace,
   Delete, Home, End, PageUp, PageDown, Left, Right, Up, Down, or the printed symbol ([ ] ? + - = ` , . / ...).
   Printed symbols never carry Shift ("?" not "Shift+/"); letters do ("Shift+H"). Meta (Cmd) counts as Ctrl.
   ===================================================================================================================== */
import { store } from '../js/store.js';

const reg = new Map();
const NAMED_WHEN = {
  timeline: (c) => c.tab === 'timeline' && !!c.tl,
  tl: (c) => !!c.tl,
  sel: (c) => !!c.sel && (c.sel.keys.size > 0 || !!c.sel.range),
};

let contextFn = (args) => ({ ...args });
export function setContextProvider(fn) { contextFn = fn; }
export const context = (args) => contextFn(args || {});

export const commands = {
  register(list) {
    for (const cmd of [].concat(list)) {
      if (!cmd?.id || typeof cmd.run !== 'function') throw new Error('command needs id and run');
      reg.set(cmd.id, { group: 'Other', keys: [], ...cmd });
    }
    keymap.rebuild();
  },
  get: (id) => reg.get(id),
  list: () => [...reg.values()],
  title(cmd, c) { return typeof cmd.title === 'function' ? cmd.title(c || context()) : cmd.title; },
  enabled(id, c) {
    const cmd = typeof id === 'string' ? reg.get(id) : id; if (!cmd) return false;
    const w = cmd.when; if (!w) return true;
    c = c || context();
    try { return typeof w === 'string' ? !!NAMED_WHEN[w]?.(c) : !!w(c); } catch (e) { return false; }
  },
  run(id, args) {
    const cmd = reg.get(id); if (!cmd) { console.warn('no command', id); return; }
    const c = context(args);
    if (!this.enabled(cmd, c)) return;
    recent.unshift(id); recent = [...new Set(recent)].slice(0, 12);
    try { localStorage.setItem('wb:recentCmds', JSON.stringify(recent)); } catch (e) { /* ignore */ }
    return cmd.run(c);
  },
  keysFor(id) { const o = store.settings?.keybindings?.[id]; return o || reg.get(id)?.keys || []; },
  recent: () => recent,
};
let recent = []; try { recent = JSON.parse(localStorage.getItem('wb:recentCmds') || '[]'); } catch (e) { /* ignore */ }

// ------------------------------------------------------------------ keymap
export const keymap = {
  byKey: new Map(),             // combo -> [ids]
  rebuild() {
    this.byKey = new Map();
    for (const cmd of reg.values()) for (const k of commands.keysFor(cmd.id)) {
      const n = normalize(k); if (!n) continue;
      if (!this.byKey.has(n)) this.byKey.set(n, []);
      this.byKey.get(n).push(cmd.id);
    }
  },
  conflicts() { return [...this.byKey].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids })); },
  conflictsFor(id) { const out = []; for (const k of commands.keysFor(id)) { const ids = this.byKey.get(normalize(k)) || []; if (ids.length > 1) out.push({ key: k, others: ids.filter(x => x !== id) }); } return out; },
  async set(id, keys) {
    await store.setSettings((d) => { d.keybindings ||= {}; d.keybindings[id] = keys.map(normalize).filter(Boolean); });
    this.rebuild();
  },
  async reset(id) { await store.setSettings((d) => { if (d.keybindings) delete d.keybindings[id]; }); this.rebuild(); },
  async resetAll() { await store.setSettings((d) => { d.keybindings = {}; }); this.rebuild(); },
  combo: comboFromEvent,
  normalize,
  // dispatch a keydown: first enabled command bound to the combo wins
  handle(e) {
    const combo = comboFromEvent(e); if (!combo) return false;
    const ids = this.byKey.get(combo); if (!ids) return false;
    // typing: the event's target OR the focused element is a field (a key never runs a command inside an input), and an IME
    // composition is typing too (review #3 walk blocker 1)
    const FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable=true]';
    const typing = e.isComposing || !!e.target.closest?.(FIELD) || !!document.activeElement?.closest?.(FIELD);
    const c = context();
    for (const id of ids) {
      const cmd = reg.get(id);
      if (typing && !cmd.global) continue;
      if (!commands.enabled(cmd, c)) continue;
      e.preventDefault(); e.stopPropagation();
      commands.run(id);
      return true;
    }
    return false;
  },
};
store.on((w) => { if (w === 'settings' || w === 'all') keymap.rebuild(); });

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift'];
const KEY_ALIAS = { ' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Del: 'Delete', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Plus: '+' };
const isSymbol = (k) => k.length === 1 && !/[A-Za-z0-9]/.test(k);
export function comboFromEvent(e) {
  let k = e.key;
  if (!k || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(k)) return null;
  k = KEY_ALIAS[k] || k;
  // Alt (and Alt+Shift) can turn letters/digits into other characters on some layouts: use the physical key then
  if (e.altKey && /^(Key[A-Z]|Digit\d)$/.test(e.code) && (k.length !== 1 || !/[A-Za-z0-9]/.test(k))) k = e.code.slice(-1);
  if (k.length === 1) k = k.toUpperCase();
  const altGr = e.getModifierState?.('AltGraph');
  const sym = isSymbol(k);
  const mods = [];
  if ((e.ctrlKey || e.metaKey) && !(altGr && sym)) mods.push('Ctrl');
  if (e.altKey && !(altGr && sym)) mods.push('Alt');
  if (e.shiftKey && !sym) mods.push('Shift');
  return [...mods, k].join('+');
}
export function normalize(s) {
  if (!s) return '';
  const parts = String(s).split('+'); let key = parts.pop();
  if (key === '' && parts.length && parts[parts.length - 1] === '') { parts.pop(); key = '+'; }   // "Ctrl++"
  key = KEY_ALIAS[key] || key; if (key.length === 1) key = key.toUpperCase();
  const mods = new Set(parts.map(p => ({ control: 'Ctrl', ctrl: 'Ctrl', cmd: 'Ctrl', meta: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift' }[p.toLowerCase()] || p)));
  if (isSymbol(key)) mods.delete('Shift');
  return [...MOD_ORDER.filter(m => mods.has(m)), key].join('+');
}
// short label for a key hint ("Ctrl+Shift+Z" stays; "Space" -> "Space")
export const keyLabel = (k) => k.replace(/\bLeft\b/, '←').replace(/\bRight\b/, '→').replace(/\bUp\b/, '↑').replace(/\bDown\b/, '↓');
