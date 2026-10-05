// The default commands, keymap, menu bar and context menus of the workbench. Everything here goes through the public
// API (WB.commands.register, WB.menus.contribute), exactly as a tab module would.
import { commands } from './commands.js';
import { menus, openBar } from './menus.js';
import { palette, ui, cheatsheet } from './palette.js';
import { history } from './history.js';
import { selection } from './selection.js';
import { dock } from './dock.js';
import { projects, exporter, slugId } from './projects.js';
import { store, toast, PROJECT, prefs } from '../js/store.js';
import { fmt, upperBound } from '../js/timeline.js';
import { PAGES } from '../tabs/registry.js';
import { columnAt, visibleColumn, columns as noteColumns } from './notescol.js';
import { noteTime } from '../js/notes.js';
import { currentScript } from '../js/scenes.js';
import { axisAt } from './timemode.js';
import { connect, about } from './connect.js';   // F9 Help › Connect Claude…, F10 About (the real version + commit)

const REPO_URL = 'https://github.com/dazca/ai-videoclip-director';

const WB = () => window.WB;
const APPROVABLE = /^(shot|use|script|job|character|location|prop):/;
const song = () => store.song;
const avgJob = () => { const it = store.costs?.items || []; return it.length ? +(it.reduce((s, x) => s + x.usd, 0) / it.length).toFixed(2) : 0.5; };

// ------------------------------------------------------------------ helpers
export function sectionAt(t) { return song().sections.find(s => s.t0 <= t && t < s.t1) || song().sections[song().sections.length - 1]; }
export function lineIndexAt(t) { const L = song().lines; let i = upperBound(L.map(l => l.t0), t + 1) - 1; return Math.max(0, i); }
export function shotAt(t) { return store.shots.find(s => s.t0 <= t && t < s.t1) || null; }
export function timeOfKey(key) {
  const [k, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (k === 'shot') return store.shots.find(s => s.id === id)?.t0;
  if (k === 'use') return store.uses.find(u => u.id === id)?.t0;
  if (k === 'script') return store.script.lines.find(s => s.id === id)?.t0;
  if (k === 'note') { const n = store.notes.notes.find(x => x.id === id); return n ? noteTime(n, { song: song(), scenes: currentScript(store.scenes)?.scenes || [], shots: store.boardShots() }) ?? undefined : undefined; }
  if (k === 'section') return song().sections.find(s => s.id === id)?.t0;
  if (k === 'line') return song().lines.find(l => l.id === id)?.t0;
  return undefined;
}
function go(c, t) {
  const tl = c.tl; if (!tl) return;
  t = Math.max(0, Math.min(song().duration_ms, Math.round(t)));
  tl.seek(t);
  if (!tl.player.playing) { const y = tl.warp.y(t) - tl.scroller.scrollTop, vh = tl.scroller.clientHeight; if (y < tl.headH + 10 || y > vh - 20) tl.scrollToTime(t); }
}
const grid = (arr, t, dir) => dir > 0 ? arr[upperBound(arr, t + 1)] ?? song().duration_ms : arr[Math.max(0, upperBound(arr, t - 1) - 1)] ?? 0;
function targetKeys(c, filter = APPROVABLE) {
  if (c.item && !selection.keys.has(c.item)) return filter.test(c.item) ? [c.item] : [];
  const keys = selection.list().filter(k => filter.test(k));
  if (keys.length) return keys;
  if (c.item && filter.test(c.item)) return [c.item];
  return c.shot && filter.test('shot:x') ? ['shot:' + c.shot.id] : [];
}
function markLoop(tl) {
  for (const x of tl.byId.sections.body.querySelectorAll('.sec')) x.classList.toggle('looping', !!tl.loop && Number(x.dataset.t0) === tl.loop.t0 && Number(x.dataset.t1) === tl.loop.t1);
}
function setLoop(c, r) { c.tl.setLoop(r); if (r) prefs.set('lastLoop', r); markLoop(c.tl); toast(r ? `loop ${fmt(r.t0, true)} – ${fmt(r.t1, true)}` : 'loop off'); }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('copied: ' + text.slice(0, 60)); } catch (e) { toast('clipboard blocked: ' + text.slice(0, 60)); } }
async function request(kind, target, { prompt = '', est = 0, refs = [], ask = false, extra } = {}) {
  let p = prompt;
  if (ask) { p = await ui.prompt({ title: `${kind} · ${target || ''}: prompt draft (the agent refines it)`, value: prompt }); if (p == null) return; }
  const r = await store.addRequest({ kind, target, prompt: p, refs, est_cost: est, extra });
  toast(`request ${r.id} (${kind}) added as draft · Queue tab`);
  return r;
}
const shotOfUse = (u) => store.shots.find(s => s.clips.includes(u.id)) || shotAt(u.t0);
const tabs = () => WB().app;

// ------------------------------------------------------------------ commands
const T = 'timeline', TL = 'tl';
const C = [];
const add = (group, list) => { for (const x of list) C.push({ group, ...x }); };

add('File', [
  { id: 'file.new', title: 'New project…', run: () => WB().wizard.open() },
  { id: 'file.newEmpty', title: 'New empty project…', run: async () => { const n = await ui.prompt({ title: 'New empty project: id (letters, digits, - _)' }); if (!n) return; const id = slugId(n); try { await projects.create(id); projects.open(id); } catch (e) { toast('not created: ' + e.message); } } },
  { id: 'file.newFromTemplate', title: 'New from template…', run: async () => {
    await projects.refresh();
    const from = await ui.pick({ title: 'Template: copy which project (notes, approvals and requests start empty)?', items: projects.list.map(p => ({ label: p.id, detail: p.title, value: p.id })) }); if (!from) return;
    const n = await ui.prompt({ title: `New project from ${from}: id`, value: `${from}-new` }); if (!n) return;
    try { const id = await projects.duplicate(slugId(n), { from, template: true }); projects.open(id); } catch (e) { toast('not created: ' + e.message); }
  } },
  { id: 'file.open', title: 'Open project…', run: async () => { await projects.refresh(); const id = await ui.pick({ title: 'Open project', items: projects.list.map(p => ({ label: p.id, detail: `${p.title} · ${p.modified} · ${p.snapshots} snapshots`, value: p.id })) }); if (id) projects.open(id); } },
  { id: 'file.snapshot', title: 'Save snapshot…', keys: ['Ctrl+S'], global: true, run: async () => { const m = await ui.prompt({ title: `Snapshot of ${PROJECT}: message`, placeholder: 'what changed (Enter saves)' }); if (m == null) return; try { await projects.snapshot(m || 'snapshot'); } catch (e) { toast('snapshot failed: ' + e.message); } } },
  { id: 'file.saveAs', title: 'Save project as…', keys: ['Ctrl+Shift+S'], global: true, run: async () => { const n = await ui.prompt({ title: `Save ${PROJECT} as (copies the project folder, then opens the copy)`, value: `${PROJECT}-copy` }); if (!n) return; try { const id = await projects.duplicate(slugId(n)); projects.open(id); } catch (e) { toast('not saved: ' + e.message); } } },
  { id: 'file.duplicate', title: 'Duplicate project…', run: async () => { const n = await ui.prompt({ title: `Duplicate ${PROJECT} as (stays on this project)`, value: `${PROJECT}-copy` }); if (!n) return; try { const id = await projects.duplicate(slugId(n)); toast(`duplicated as ${id} (File > Open)`); } catch (e) { toast('not duplicated: ' + e.message); } } },
  { id: 'file.revert', title: 'Revert to snapshot…', run: async () => { await projects.refresh(); if (!projects.snaps.length) return toast('no snapshots yet (Ctrl+S)'); const id = await ui.pick({ title: 'Restore which snapshot? (the current state is snapshotted first)', items: projects.snaps.map(s => ({ label: s.message || s.id, detail: `${s.at.replace('T', ' ')}${s.auto ? ' · auto' : ''}`, value: s.id })) }); if (id) await projects.restore(id); } },
  { id: 'file.restore', title: (c) => `Restore ${c.snapshot || 'snapshot'}`, hidden: true, run: (c) => c.snapshot && projects.restore(c.snapshot) },
  { id: 'file.openId', title: (c) => `Open ${c.project || 'project'}`, hidden: true, run: (c) => c.project && projects.open(c.project) },
  { id: 'file.import', title: (c) => `Import ${c.what || 'song, stems, lyrics or images'}…`, hidden: true, run: async (c) => { const p = await ui.prompt({ title: `Import ${c.what}: path (relative to the base folder); the agent runs the importer`, placeholder: 'e.g. resources/song/new_mix.wav' }); if (p) request('import', c.what, { prompt: `import ${c.what} from ${p}`, refs: [p] }); } },
  { id: 'file.exportBundle', title: 'Export JSON bundle', run: () => exporter.bundle() },
  { id: 'file.exportCsv', title: 'Export shot list CSV', run: () => exporter.shotList() },
  { id: 'file.exportBoard', title: 'Export storyboard page (print to PDF)', run: () => exporter.storyboard() },
  { id: 'file.settings', title: 'Project settings', hidden: true, run: () => tabs().show('settings') },
  { id: 'file.delete', title: 'Delete a project…', run: async () => { await projects.refresh(); const id = await ui.pick({ title: 'Delete which project? (cannot be undone; the default project is protected)', items: projects.list.filter(p => !p.default).map(p => ({ label: p.id, detail: p.title, value: p.id })) }); if (!id) return; if (!(await ui.confirm(`Delete ${id} and all its snapshots?`))) return; try { await projects.remove(id); toast('deleted ' + id); if (id === PROJECT) projects.openDefault(); } catch (e) { toast('not deleted: ' + e.message); } } },
]);

add('Edit', [
  { id: 'edit.undo', title: () => `Undo${history.peek().undo ? ' ' + history.peek().undo : ''}`, keys: ['Ctrl+Z'], when: () => history.undoStack.length > 0, run: () => history.undo() },
  { id: 'edit.redo', title: () => `Redo${history.peek().redo ? ' ' + history.peek().redo : ''}`, keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], when: () => history.redoStack.length > 0, run: () => history.redo() },
  { id: 'edit.find', title: 'Find…', keys: ['Ctrl+F'], global: true, run: () => palette.open({ mode: 'find' }) },
  { id: 'edit.rename', title: 'Rename…', keys: ['F2'], when: (c) => !!(c.note || selection.list('note').length || c.section), run: async (c) => {
    const nid = c.note?.id || selection.ids('note')[0];
    if (nid) { const n = store.notes.notes.find(x => x.id === nid); const v = await ui.prompt({ title: `Edit note ${nid}`, value: n?.text || '' }); if (v != null && v !== n.text) store.editNote(nid, v); return; }
    const sid = selection.ids('section')[0]; const s = sid ? song().sections.find(x => x.id === sid) : c.section;
    const v = await ui.prompt({ title: `Rename section ${s.id}`, value: store.secLabel(s) }); if (v) store.setSection(s.id, { label: v });
  } },
  { id: 'edit.duplicate', title: 'Duplicate (request)', keys: ['Ctrl+D'], when: (c) => !!(c.item || selection.keys.size || c.shot || c.entity), run: (c) => { const k = c.item || selection.list()[0] || (c.entity ? `${c.entity.kind}:${c.entity.id}` : 'shot:' + c.shot.id); return request('duplicate', k, { prompt: `duplicate ${k} as a new variant`, est: /^(use|job)/.test(k) ? avgJob() : 0 }); } },
  { id: 'edit.delete', title: 'Delete', keys: ['Delete'], when: (c) => !!(c.note || selection.list('note').length || selection.list('request').length), run: (c) => {
    const notes = c.note && !selection.keys.has('note:' + c.note.id) ? [c.note.id] : selection.ids('note');
    if (notes.length) return store.deleteNotes(notes);
    const reqs = selection.ids('request'); if (reqs.length) return store.deleteRequests(reqs);
  } },
  { id: 'edit.approve', title: 'Approve', keys: ['A'], when: (c) => targetKeys(c).length > 0, run: (c) => store.setStates(targetKeys(c), 'approved') },
  { id: 'edit.changes', title: 'Request changes', keys: ['R'], when: (c) => targetKeys(c).length > 0, run: (c) => store.setStates(targetKeys(c), 'changes') },
  { id: 'edit.draft', title: 'Back to draft', when: (c) => targetKeys(c).length > 0, run: (c) => store.setStates(targetKeys(c), 'draft') },
  { id: 'edit.selectSection', title: 'Select section', when: TL, run: (c) => selection.setRange(c.section) },
  { id: 'edit.clearSel', title: 'Clear selection', when: 'sel', run: () => selection.clear() },
  { id: 'edit.copyTime', title: 'Copy time code', when: TL, run: (c) => copy(fmt(c.t, true)) },
  { id: 'edit.copyId', title: 'Copy id', when: (c) => !!c.item, run: (c) => copy(c.item.slice(c.item.indexOf(':') + 1)) },
  { id: 'edit.copyText', title: 'Copy text', when: (c) => !!(c.line || c.note), run: (c) => copy(c.note ? c.note.text : c.line.text) },
  { id: 'edit.paste', title: 'Paste (time code seeks, text becomes a note)', when: TL, run: async (c) => {
    let s = ''; try { s = (await navigator.clipboard.readText()).trim(); } catch (e) { s = await ui.prompt({ title: 'Paste here (clipboard blocked by the browser)' }) || ''; }
    const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s); if (m) return go(c, (Number(m[1]) * 60 + Number(m[2])) * 1000);
    if (s) store.addNote(c.t, s, song().lines[lineIndexAt(c.t)]?.id);
  } },
  { id: 'edit.settings', title: 'Settings…', keys: ['Ctrl+,'], global: true, checked: (c) => c.tab === 'settings', run: () => tabs().show('settings') },
  { id: 'edit.keybindings', title: 'Keyboard shortcuts…', run: () => { tabs().show('settings'); setTimeout(() => document.querySelector('.kb')?.scrollIntoView(), 50); } },
]);

add('View', [
  { id: 'view.palette', title: 'Command palette…', keys: ['Ctrl+K', 'Ctrl+Shift+P'], global: true, run: () => palette.open() },
  // ` toggles the bar; Esc never hides it (Esc only closes menus, dialogs, the palette, the cheat sheet). When hidden, a
  // 12 px chevron in the top-right corner brings it back (app.js), as do right-click > Show top bar and the palette.
  { id: 'view.topbar', title: () => document.body.classList.contains('notop') ? 'Show top bar' : 'Hide top bar', keys: ['`'], checked: () => !document.body.classList.contains('notop'), run: () => { if (cheatsheet.isOpen()) return cheatsheet.close(); tabs().setTopbar(document.body.classList.contains('notop')); } },
  { id: 'view.showTopbar', title: 'Show top bar', when: () => document.body.classList.contains('notop'), run: () => tabs().setTopbar(true) },
  { id: 'view.header', title: 'Column header: full / thin / hidden', keys: ['Alt+H'], when: TL, run: (c) => c.tl.cycleHeader() },
  { id: 'view.showHeader', title: 'Show column header', when: (c) => !!c.tl && c.tl.headerMode !== 0, run: (c) => c.tl.setHeaderMode(0) },
  { id: 'view.linear', title: 'Linear time (no warp)', keys: ['T', '0'], when: TL, checked: (c) => c.tl.linear, run: (c) => { c.tl.toggleLinear(); toast(c.tl.linear ? 'linear time' : 'warped time'); } },
  { id: 'view.follow', title: 'Follow playhead', keys: ['F'], when: TL, checked: (c) => c.tl.follow, run: (c) => { c.tl.follow = !c.tl.follow; toast(c.tl.follow ? 'follow on' : 'follow off'); } },
  { id: 'view.zoomIn', title: 'Zoom in (time)', keys: ['+', '='], when: TL, run: (c) => c.tl.zoomAt(1.25, c.tl.scroller.getBoundingClientRect().top + c.tl.headH + c.tl.readOffset()) },
  { id: 'view.zoomOut', title: 'Zoom out (time)', keys: ['-'], when: TL, run: (c) => c.tl.zoomAt(0.8, c.tl.scroller.getBoundingClientRect().top + c.tl.headH + c.tl.readOffset()) },
  { id: 'view.fit', title: 'Fit song to window', keys: ['Ctrl+0'], when: TL, run: (c) => { c.tl.fitRange(); if (c.tl.warp.total > c.tl.scroller.clientHeight + 4) toast(`fitted as far as the text allows (${Math.round(c.tl.warp.total)} px); T = linear time fits exactly`); } },
  { id: 'view.zoom100', title: 'Zoom 100 % (16 px/s floor)', keys: ['Ctrl+1'], when: TL, run: (c) => { const t = c.tl.timeAtRead(); c.tl.pxPerSec = 16; c.tl.save(); c.tl.relayout(); c.tl.scrollToTime(t); c.tl.drawLanes(); } },
  { id: 'view.zoomSection', title: 'Zoom to section', when: TL, run: (c) => { if (c.tab !== 'timeline') tabs().show('timeline'); c.tl.fitRange(c.section.t0, c.section.t1); } },
  { id: 'view.zoomSel', title: 'Zoom to selection', when: () => !!selection.range, run: (c) => c.tl.fitRange(selection.range.t0, selection.range.t1) },
  { id: 'view.dock', title: 'Preview dock', keys: ['P'], checked: () => dock.isOpen(), run: () => dock.toggle() },
  { id: 'view.video', title: 'Floating render video', keys: ['V'], when: TL, checked: (c) => !!c.tl.player.video, run: (c) => c.tl.player.toggleVideo() },
]);

add('Column', [
  { id: 'col.hide', title: (c) => `Hide column${c.col ? ' ' + c.col.def.title : ''}`, keys: ['H'], when: (c) => c.tab === T && !!c.col, run: (c) => c.tl.setHidden(c.col.id, true) },
  { id: 'col.showAll', title: 'Show all columns', keys: ['Shift+H'], when: TL, run: (c) => { for (const k of c.tl.cols) k.hidden = false; c.tl.save(); c.tl.applyColumns(); c.tl.relayout(); } },
  { id: 'col.collapse', title: 'Collapse to strip', when: (c) => !!c.col, checked: (c) => c.col.collapsed, run: (c) => { c.col.collapsed = !c.col.collapsed; c.tl.save(); c.tl.applyColumns(); c.tl.relayout(); } },
  { id: 'col.mode', title: 'Drives the time axis', when: (c) => c.col?.def.kind === 'text', checked: (c) => c.col.mode === 'drive', run: (c) => { c.col.mode = c.col.mode === 'drive' ? 'follow' : 'drive'; c.col.dirty = true; c.tl.save(); c.tl.applyColumns(); c.tl.relayout(); } },
  { id: 'col.moveLeft', title: 'Move left', when: (c) => !!c.col, run: (c) => c.tl.moveCol(c.col.id, -1) },
  { id: 'col.moveRight', title: 'Move right', when: (c) => !!c.col, run: (c) => c.tl.moveCol(c.col.id, 1) },
  { id: 'col.autofit', title: 'Auto-fit width', when: (c) => !!c.col, run: (c) => c.tl.autoFit(c.col.id) },
  { id: 'col.reset', title: 'Reset width and mode', when: (c) => !!c.col, run: (c) => { c.col.mode = c.col.def.mode ?? 'follow'; c.col.collapsed = false; c.col.dirty = true; c.tl.resetWidth(c.col.id); } },
  { id: 'col.settings', title: 'Column settings…', when: (c) => !!c.col, run: (c) => { tabs().show('settings'); setTimeout(() => document.getElementById('cs-' + c.col.id)?.scrollIntoView({ block: 'center' }), 50); } },
  { id: 'col.resetLayout', title: 'Reset layout (all columns)', when: TL, run: (c) => { prefs.set('layout', {}); prefs.set('colOrder', null); c.tl.layout = {}; const t = c.tl.timeAtRead(); c.tl.destroy(); c.tl.build(); c.tl.scrollToTime(t); } },
]);
for (let i = 1; i <= 9; i++) C.push({ group: 'Column', id: `col.toggle${i}`, hidden: true, title: (c) => `Toggle column ${i}${c.tl?.cols[i - 1] ? ' ' + c.tl.cols[i - 1].def.title : ''}`, keys: [`Alt+${i}`], when: TL, run: (c) => { const k = c.tl.cols[i - 1]; if (k) c.tl.setHidden(k.id, !k.hidden); } });

add('Timeline', [
  { id: 'transport.play', title: 'Play / pause', keys: ['Space'], when: TL, run: (c) => { c.tl.player.audio.playbackRate = 1; c.tl.player.toggle(); } },
  { id: 'transport.playFrom', title: 'Play from here', when: TL, run: (c) => { c.tl.seek(c.t); c.tl.player.audio.playbackRate = 1; c.tl.player.play(); } },
  { id: 'transport.back', title: 'Shuttle back (2 s jumps; again = further)', keys: ['J'], when: TL, run: (c) => { const n = Date.now() - (c.tl._jT || 0) < 700 ? (c.tl._jN || 1) * 2 : 1; c.tl._jT = Date.now(); c.tl._jN = Math.min(8, n); go(c, c.tl.player.time() - 2000 * c.tl._jN); } },
  { id: 'transport.stop', title: 'Pause (shuttle stop)', keys: ['K'], when: TL, run: (c) => { c.tl.player.audio.playbackRate = 1; c.tl.player.pause(); } },
  { id: 'transport.fwd', title: 'Shuttle forward (again = faster)', keys: ['L'], when: TL, run: (c) => { const p = c.tl.player; if (!p.playing) { p.audio.playbackRate = 1; p.play(); } else p.audio.playbackRate = Math.min(4, p.audio.playbackRate * 2); toast(`× ${p.audio.playbackRate}`); } },
  { id: 'nav.prevBeat', title: 'Previous beat', keys: ['Left'], when: T, run: (c) => go(c, grid(song().grid.beats, c.t, -1)) },
  { id: 'nav.nextBeat', title: 'Next beat', keys: ['Right'], when: T, run: (c) => go(c, grid(song().grid.beats, c.t, 1)) },
  { id: 'nav.prevBar', title: 'Previous bar', keys: ['Shift+Left'], when: T, run: (c) => go(c, grid(song().grid.downbeats, c.t, -1)) },
  { id: 'nav.nextBar', title: 'Next bar', keys: ['Shift+Right'], when: T, run: (c) => go(c, grid(song().grid.downbeats, c.t, 1)) },
  { id: 'nav.prevFrame', title: 'Back 10 ms', keys: ['Alt+Left'], when: T, run: (c) => go(c, c.t - 10) },
  { id: 'nav.nextFrame', title: 'Forward 10 ms', keys: ['Alt+Right'], when: T, run: (c) => go(c, c.t + 10) },
  { id: 'nav.prevLine', title: 'Previous lyric line', keys: ['Up'], when: T, run: (c) => { const L = song().lines; if (!L.length) return; const i = lineIndexAt(c.t); go(c, L[c.t > L[i].t0 + 300 ? i : Math.max(0, i - 1)].t0); } },
  { id: 'nav.nextLine', title: 'Next lyric line', keys: ['Down'], when: T, run: (c) => { const L = song().lines; if (!L.length) return; const i = upperBound(L.map(l => l.t0), c.t + 1); if (i < L.length) go(c, L[i].t0); } },
  { id: 'nav.start', title: 'Go to start', keys: ['Home'], when: T, run: (c) => go(c, 0) },
  { id: 'nav.end', title: 'Go to end', keys: ['End'], when: T, run: (c) => go(c, song().duration_ms) },
  { id: 'nav.prevSection', title: 'Previous section', keys: ['['], when: T, run: (c) => { const S = song().sections, s = sectionAt(c.t), i = S.indexOf(s); go(c, c.t > s.t0 + 300 ? s.t0 : S[Math.max(0, i - 1)].t0); } },
  { id: 'nav.nextSection', title: 'Next section', keys: [']'], when: T, run: (c) => { const S = song().sections, i = S.indexOf(sectionAt(c.t)); if (i + 1 < S.length) go(c, S[i + 1].t0); } },
  { id: 'loop.in', title: 'Set loop in', keys: ['I'], when: TL, run: (c) => { const L = c.tl.loop; setLoop(c, { t0: c.t, t1: L && L.t1 > c.t ? L.t1 : sectionAt(c.t).t1 }); } },
  { id: 'loop.out', title: 'Set loop out', keys: ['O'], when: TL, run: (c) => { const L = c.tl.loop; setLoop(c, { t0: L && L.t0 < c.t ? L.t0 : sectionAt(c.t).t0, t1: c.t }); } },
  { id: 'loop.toggle', title: 'Loop on / off', keys: ['Shift+L'], when: TL, checked: (c) => !!c.tl.loop, run: (c) => { if (c.tl.loop) return setLoop(c, null); const last = prefs.get('lastLoop', null); const s = c.section; setLoop(c, last || { t0: s.t0, t1: s.t1 }); } },
  { id: 'loop.fromHere', title: 'Set loop from here', when: TL, run: (c) => { const L = c.tl.loop; setLoop(c, { t0: c.t, t1: L && L.t1 > c.t ? L.t1 : sectionAt(c.t).t1 }); } },
  { id: 'loop.section', title: 'Loop section', when: TL, run: (c) => { setLoop(c, { t0: c.section.t0, t1: c.section.t1 }); c.tl.seek(c.section.t0); } },
  { id: 'loop.line', title: 'Loop line', when: (c) => !!c.tl && !!c.line, run: (c) => { setLoop(c, { t0: c.line.t0, t1: c.line.t1 }); c.tl.seek(c.line.t0); } },
  { id: 'loop.selection', title: 'Loop selection', when: () => !!selection.range, run: (c) => setLoop(c, { ...selection.range }) },
  { id: 'marker.add', title: 'Add marker at the playhead', keys: ['M'], when: TL, run: (c) => store.addNote(c.t, '◆ marker', song().lines[lineIndexAt(c.t)]?.id, { kind: 'marker' }) },
  // "+ Add" on the timeline (right-click): a note typed in the notes column at the clicked time, a scene / a shot there
  { id: 'timeline.addNote', title: 'Add a note at this time (notes column)', when: TL, run: (c) => { if (c.tab !== 'timeline') tabs().show('timeline'); return c.tl.noteAt(c.t); } },
  { id: 'timeline.addScene', title: 'Add a scene here (script draft)', when: TL, run: async (c) => { const t = c.t; await WB().stages.open('script'); return WB().script?.ws?.addSceneHere(t); } },
  { id: 'timeline.addShot', title: 'Add a shot here (storyboard draft)', when: (c) => !!c.tl && !!currentScript(store.scenes)?.scenes?.length, run: async (c) => { const t = c.t; await WB().stages.open('storyboard'); return WB().storyboard?.ws?.addShotAt(t); } },
  { id: 'note.add', title: 'New note…', keys: ['N'], when: TL, run: async (c) => { const t = c.line && c.contextLine ? c.line.t0 : c.t; const v = await ui.prompt({ title: `Note at ${fmt(t, true)}`, placeholder: 'note text (Enter saves)' }); if (v) store.addNote(t, v, c.line?.id); } },
  { id: 'line.editTiming', title: 'Edit timing… (request)', when: (c) => !!c.line, run: async (c) => { const v = await ui.prompt({ title: `${c.line.id} "${c.line.text.slice(0, 40)}": new t0 t1 in ms (song.json is the importer's: this queues a request)`, value: `${c.line.t0} ${c.line.t1}` }); if (v) request('edit-timing', 'line:' + c.line.id, { prompt: `set ${c.line.id} to ${v}` }); } },
  { id: 'section.rename', title: 'Rename section…', when: (c) => !!c.section, run: async (c) => { const v = await ui.prompt({ title: `Rename section ${c.section.id}`, value: store.secLabel(c.section) }); if (v) store.setSection(c.section.id, { label: v }); } },
  { id: 'section.fold', title: 'Collapse section (fold)', when: (c) => !!c.tl && !!c.section, checked: (c) => c.tl.folds.has(c.section.id), run: (c) => c.tl.toggleFold(c.section.id) },
  { id: 'section.variant', title: 'Duplicate as variant (request)', when: (c) => !!c.section, run: (c) => request('section-variant', 'section:' + c.section.id, { ask: true, prompt: `variant of ${store.secLabel(c.section)}` }) },
]);

add('Notes', [
  { id: 'notes.addHere', title: 'Add a note here (Notes column)', when: (c) => !!(c.ncCol || visibleColumn()), run: (c) => { const col = c.ncCol || visibleColumn(); return c.ncTarget ? col.edit(c.ncTarget) : col.editCurrent(); } },
  { id: 'notes.column', title: 'Notes column (every stage)', checked: () => [...noteColumns][0]?.on ?? true, run: () => { const on = !([...noteColumns][0]?.on ?? true); for (const c of noteColumns) { c.setOn(on); break; } if (!noteColumns.size) prefs.set('ncOn', on); toast(on ? 'notes column on' : 'notes column off'); } },
  { id: 'notes.review', title: 'All notes (Review › Notes)', run: () => tabs().show('notes') },
]);

add('Item', [
  { id: 'item.preview', title: 'Preview', when: (c) => !!(c.shot || c.use || c.entity), run: (c) => { const x = c.use || c.shot; if (x) dock.show({ kind: c.use ? 'clip' : 'shot', src: x.thumb, title: x.id, t: x.t0 }); else dock.show({ kind: 'entity', src: c.entity.thumb, title: c.entity.name }); } },
  { id: 'item.showInClips', title: 'Show in Clips', when: (c) => !!c.use, run: async (c) => { await tabs().show('clips'); const r = document.getElementById('clip-' + c.use.clip); r?.scrollIntoView({ block: 'center' }); r?.classList.add('flash'); setTimeout(() => r?.classList.remove('flash'), 1200); } },
  { id: 'clip.setIn', title: 'Set in-point… (request)', when: (c) => !!c.use, run: async (c) => { const v = await ui.prompt({ title: `${c.use.id}: new in-point (s) for take ${c.use.take}`, value: (c.use.in_ms / 1000).toFixed(2) }); if (v) request('set-in', 'use:' + c.use.id, { prompt: `in-point ${v} s`, extra: { in_s: Number(v) } }); } },
  { id: 'clip.take', title: (c) => `Use take ${c.take}`, hidden: true, when: (c) => !!c.use, run: (c) => request('choose-take', 'use:' + c.use.id, { prompt: `use take ${c.take} of ${c.use.clip} (now ${c.use.take})`, extra: { take: c.take } }) },
  { id: 'gen.regenerate', title: 'Regenerate (queue a request)', group: 'Generate', when: (c) => targetKeys(c, /^(shot|use|job|character|location|prop):/).length > 0, run: (c) => { const ks = targetKeys(c, /^(shot|use|job|character|location|prop):/); return Promise.all(ks.map(k => request('regenerate', k, { prompt: `regenerate ${k}`, est: avgJob(), refs: refsOf(k) }))); } },
  { id: 'item.reveal', title: 'Open file location', when: (c) => !!(c.use || c.entity?.refs?.length), run: (c) => projects.reveal(c.use ? c.use.file || c.use.start_image : c.entity.refs[0]) },
  { id: 'entity.open', title: 'Open', when: (c) => !!c.entity, run: async (c) => { const tab = c.entity.kind === 'character' ? 'characters' : c.entity.kind + 's'; await tabs().show(tab); const card = document.querySelector(`[data-ent="${CSS.escape(c.entity.id)}"]`); card?.scrollIntoView({ block: 'center' }); card?.classList.add('flash'); setTimeout(() => card?.classList.remove('flash'), 1200); } },
  { id: 'entity.archive', title: 'Archive', when: (c) => !!c.entity, run: (c) => store.setStates([`${c.entity.kind}:${c.entity.id}`], 'archived') },
  { id: 'cast.swap', title: (c) => `Swap to ${c.look}`, hidden: true, when: (c) => !!c.entity, run: (c) => request('swap-costume', c.shot ? 'shot:' + c.shot.id : `${c.entity.kind}:${c.entity.id}`, { prompt: `${c.entity.name}: use look "${c.look}"`, extra: { entity: c.entity.id, look: c.look } }) },
]);
function refsOf(k) { const [kind, id] = [k.split(':')[0], k.slice(k.indexOf(':') + 1)]; if (kind === 'use') { const u = store.uses.find(x => x.id === id); return u ? [u.file, u.start_image].filter(Boolean) : []; } const e = store.entityById?.[id]; return e?.refs?.slice(0, 4) || []; }

add('Generate', [
  { id: 'gen.newCostume', title: 'New costume / look… (request)', when: (c) => !!(c.entity || selection.list().some(k => /^(character|location|prop):/.test(k))), run: (c) => { const e = c.entity || store.entityById[selection.list().find(k => /^(character|location|prop):/.test(k)).split(':')[1]]; return request(e.kind === 'character' ? 'new-costume' : 'new-variant', `${e.kind}:${e.id}`, { ask: true, prompt: `${e.name}: new ${e.kind === 'character' ? 'look' : 'variant'}: `, refs: (e.refs || []).slice(0, 4), est: 0.3 }); } },
  { id: 'gen.request', title: 'Request generation…', run: (c) => { const k = c.item || selection.list()[0] || (c.entity ? `${c.entity.kind}:${c.entity.id}` : c.shot ? 'shot:' + c.shot.id : null); return request('generate', k, { ask: true, prompt: k ? `for ${k}: ` : '', est: avgJob(), refs: k ? refsOf(k) : [] }); } },
  { id: 'gen.queue', title: 'Generation queue', run: () => tabs().show('queue') },
  { id: 'gen.approveDrafts', title: 'Approve all draft requests', when: () => (store.requests?.items || []).some(r => r.status === 'draft'), run: async () => { const ids = store.requests.items.filter(r => r.status === 'draft').map(r => r.id); if (!(await ui.confirm(`Approve ${ids.length} draft request(s)? The agent will run them.`))) return; await store.mutate('requests.json', (d) => { for (const r of d.items) if (ids.includes(r.id)) r.status = 'approved'; }, { label: `approve ${ids.length} requests` }); } },
]);

add('Window', [
  { id: 'window.tab', title: (c) => `Show ${c.tabId}`, hidden: true, run: (c) => tabs().show(c.tabId) },
  { id: 'window.newPage', title: 'New page…', run: async () => {
    const items = tabs().pages().filter(p => p.subs).flatMap(p => p.subs.map(s => ({ label: s.title, detail: `from ${p.title}`, value: s.id })));
    const v = await ui.pick({ title: 'New page: show which view as its own page? (close it with × on its tab)', items }); if (v) tabs().newPage(v);
  } },
  { id: 'window.closePage', title: 'Close page', when: (c) => tabs()?.custom().some(p => p.id === c.tab), run: (c) => tabs().closePage(c.tab) },
  { id: 'window.cheat', title: 'Keyboard cheat sheet', group: 'Help', keys: ['?'], run: () => cheatsheet.toggle() },
  { id: 'help.readme', title: 'README (how it works, files, API)', group: 'Help', run: () => window.open(REPO_URL + '#readme', '_blank', 'noopener') },
  { id: 'help.source', title: 'Source code on GitHub', group: 'Help', run: () => window.open(REPO_URL, '_blank', 'noopener') },
  { id: 'help.issue', title: 'Report a problem or suggest a feature', group: 'Help', run: () => window.open(REPO_URL + '/issues/new', '_blank', 'noopener') },
  { id: 'help.menu', title: 'Open the menu bar (keyboard)', group: 'Help', keys: ['F10'], run: () => { tabs().setTopbar(true); openBar('File', { keyboard: true }); } },
  // the version is package.json's, from the server's /api/status (review #2 F10); none shown when the server does not say
  { id: 'help.connect', title: 'Connect Claude…', group: 'Help', run: () => connect.open() },
  { id: 'help.about', title: 'About the workbench', group: 'Help', run: () => about.open() },
]);
// 1..9 = pages in registry order (1 Timeline, 2 Assets, 3 Review, 4 Settings, then custom pages); Alt+1..9 = columns
for (let i = 1; i <= 9; i++) C.push({ group: 'Window', id: `window.tab${i}`, title: () => { const p = tabs()?.pages()[i - 1]; return `Page ${i}${p ? ': ' + p.title : ''}`; }, keys: [String(i)], when: () => !!tabs()?.pages()[i - 1], checked: (c) => tabs().pages()[i - 1]?.id === c.tab, run: () => tabs().show(tabs().pages()[i - 1].id) });
// one command per sub-view ("Assets: Characters", "Review: Queue"…), for the palette and the Window menu
for (const p of PAGES) for (const sub of p.subs || []) C.push({ group: 'Window', id: `go.${sub.id}`, title: `${p.title}: ${sub.title}`, checked: (c) => c.view === sub.id, run: () => tabs().show(sub.id) });
const PAGE_SUBMENUS = () => PAGES.filter(p => p.subs).map(p => ({ label: p.title, submenu: () => p.subs.map(s => commands.get(`go.${s.id}`) ? { cmd: `go.${s.id}`, label: s.title } : { label: s.title, run: () => tabs().show(s.id) }) }));

commands.register(C);

// ------------------------------------------------------------------ menu bar
const projectItems = () => projects.list.length ? projects.list.map(p => ({ label: p.id, detail: p.id === PROJECT ? '(open)' : p.modified.slice(0, 10), checked: () => p.id === PROJECT, run: () => projects.open(p.id) })) : [{ label: '(no list: server offline?)', disabled: true }];
menus.contribute('menubar:File', [
  'file.new', 'file.newEmpty', 'file.newFromTemplate', { label: 'Open', submenu: projectItems }, { label: 'Recent projects', submenu: () => { const r = projects.recent(); return r.length ? r.map(id => ({ label: id, run: () => projects.open(id) })) : [{ label: '(none yet)', disabled: true }]; } },
  '-', 'file.snapshot', { label: 'Revert to snapshot', submenu: () => projects.snaps.length ? projects.snaps.slice(0, 30).map(s => ({ label: s.message || s.id, detail: s.at.replace('T', ' ').slice(0, 16) + (s.auto ? ' auto' : ''), run: () => projects.restore(s.id) })).concat(projects.snaps.length > 30 ? ['-', 'file.revert'] : []) : [{ label: '(no snapshots yet: Ctrl+S)', disabled: true }] },
  '-', 'file.saveAs', 'file.duplicate',
  '-', 'file.importMedia', { label: 'Import', submenu: ['song', 'stems', 'lyrics', 'images'].map(w => ({ cmd: 'file.import', args: { what: w }, label: `${w}…` })) },
  { label: 'Export', submenu: [{ cmd: 'file.exportPackage', label: 'Interactive HTML package…' }, '-', 'file.exportBundle', 'file.exportCsv', 'file.exportBoard'] },
  '-', 'file.delete',
]);
menus.contribute('menubar:Edit', ['edit.undo', 'edit.redo', '-', 'edit.find', 'edit.rename', 'edit.duplicate', 'edit.delete', '-', 'edit.approve', 'edit.changes', 'edit.draft', '-', 'edit.selectSection', 'edit.clearSel', 'edit.copyTime', '-', 'edit.settings', 'edit.keybindings']);
menus.contribute('columns', [(c) => (c.tl?.cols || []).map((k, i) => ({ label: k.def.title, keys: i < 9 ? `Alt+${i + 1}` : '', checked: () => !k.hidden, run: () => c.tl.setHidden(k.id, !k.hidden) })),
  '-', 'col.showAll', 'view.linear', 'view.header', 'col.resetLayout']);
menus.contribute('menubar:View', ['view.palette', '-', 'view.topbar', 'view.header', 'view.showHeader', 'view.linear', 'view.follow', '-', 'view.zoomIn', 'view.zoomOut', 'view.fit', 'view.zoom100', 'view.zoomSection', 'view.zoomSel', '-',
  { label: 'Columns', submenu: () => menus.itemsFor('columns') }, 'col.showAll', 'col.hide', '-', 'view.dock', 'view.video']);
menus.contribute('menubar:Timeline', ['transport.play', 'transport.back', 'transport.stop', 'transport.fwd', '-',
  { label: 'Step', submenu: ['nav.prevBeat', 'nav.nextBeat', 'nav.prevBar', 'nav.nextBar', 'nav.prevFrame', 'nav.nextFrame'] },
  'nav.prevLine', 'nav.nextLine', 'nav.prevSection', 'nav.nextSection', 'nav.start', 'nav.end', '-',
  'loop.in', 'loop.out', 'loop.toggle', 'loop.section', 'loop.selection', '-', 'marker.add', 'note.add', 'section.fold', 'section.rename']);
menus.contribute('menubar:Generate', ['gen.regenerate', 'gen.newCostume', 'gen.request', '-', 'gen.queue', 'gen.approveDrafts', '-',
  { label: () => { const it = store.requests?.items || []; const q = it.filter(r => r.status === 'approved' || r.status === 'queued').reduce((s, r) => s + (r.est_cost || 0), 0); const spent = (store.costs?.items || []).reduce((s, x) => s + x.usd, 0); return `spent $${spent.toFixed(0)} + queued $${q.toFixed(2)} / cap $${store.costs?.cap_usd ?? '?'}`; }, disabled: true }]);
menus.contribute('menubar:Window', [() => tabs().pages().slice(0, 9).map((p, i) => `window.tab${i + 1}`),
  ...PAGE_SUBMENUS(), '-', 'window.newPage', 'window.closePage', '-', 'view.dock', 'view.palette', 'view.topbar']);
menus.contribute('menubar:Help', ['window.cheat', 'view.palette', 'edit.keybindings', 'help.menu', '-', 'help.connect', '-', 'help.readme', 'help.source', 'help.issue', 'help.about']);

// ------------------------------------------------------------------ context menus
// the timeline's + Add comes first on any right-click on the sheet (contextArgs puts "tladd" before the item's own context)
menus.contribute('tladd', [{ label: '+ Add', submenu: [{ cmd: 'timeline.addNote', label: '+ note at this time' }, { cmd: 'timeline.addScene', label: '+ scene here' }, { cmd: 'timeline.addShot', label: '+ shot here' }, { cmd: 'events.addHere', label: '+ Named event here' }] }]);
menus.contribute('timeline', ['marker.add', 'note.add', 'loop.fromHere', 'edit.selectSection', 'view.zoomSection', 'edit.copyTime']);
menus.contribute('ruler', ['transport.playFrom', 'loop.section', 'loop.selection', 'view.zoomSel']);
menus.contribute('lyric', ['transport.playFrom', 'loop.line', { cmd: 'note.add', args: { contextLine: true }, label: 'Add note to this line…' }, 'line.editTiming', 'edit.copyText']);
menus.contribute('section', ['section.rename', { label: 'Colour', submenu: (c) => [['default', null], ['red', '#c0504d'], ['amber', '#d19a2a'], ['green', '#4f9a5f'], ['teal', '#3f9a9a'], ['blue', '#4f79c0'], ['violet', '#8a63c0'], ['pink', '#c0639a'], ['grey', '#777777']]
  .map(([n, hex]) => ({ label: n, checked: () => (store.overrides?.sections?.[c.section.id]?.color || null) === hex, run: () => store.setSection(c.section.id, { color: hex }) })) },
  'loop.section', 'section.fold', 'section.variant']);
const itemMenu = ['item.preview', 'item.showInClips', { label: 'Choose take', when: (c) => !!c.use, submenu: (c) => [0, 1, 2].map(k => ({ cmd: 'clip.take', args: { take: k }, label: `take ${k}${k === c.use.take ? ' (in use)' : ''}` })) },
  'clip.setIn', '-', 'edit.approve', 'edit.changes', 'gen.regenerate', 'edit.duplicate', '-', 'item.reveal', 'edit.copyId'];
menus.contribute('shot', itemMenu);
menus.contribute('clip', itemMenu);
const looksOf = (e) => (e.looks || e.costumes || []).map(l => typeof l === 'string' ? l : l.name || l.id);
menus.contribute('cast', ['entity.open', { label: 'Swap costume', submenu: (c) => { const L = looksOf(c.entity); return [...(L.length ? L.map(l => ({ cmd: 'cast.swap', args: { look: l }, label: l })) : [{ label: '(no looks yet)', disabled: true }]), '-', 'gen.newCostume']; } }, 'item.preview']);
menus.contribute('note', ['edit.rename', 'edit.delete', 'edit.copyText', { label: 'Done (absorbed)', checked: (c) => c.note.status !== 'open', run: (c) => store.toggleNote(c.note.id) }, { label: 'Dismiss', when: (c) => c.note.status === 'open', run: (c) => store.noteStatus(c.note.id, 'dismissed') }]);
menus.contribute('header', ['col.hide', 'col.collapse', 'col.mode', { label: 'Width', submenu: (c) => [3, 10, 24, 40, 60, 90, 120, 180, 240, 320].map(w => ({ label: `${w} px`, checked: () => Math.round(c.col.vw) === w, run: () => c.tl.setWidth(c.col.id, w) })).concat(['-', 'col.autofit']) },
  'col.moveLeft', 'col.moveRight', '-', 'col.settings', 'col.reset']);
menus.contribute('entity', ['entity.open', 'item.preview', 'edit.duplicate', 'gen.newCostume', 'gen.request', '-', 'edit.approve', 'edit.changes', 'entity.archive', 'item.reveal']);
menus.contribute('empty', ['view.showTopbar', 'view.showHeader', 'edit.paste', { label: 'Show hidden columns', when: (c) => !!c.tl?.cols.some(k => k.hidden), submenu: (c) => c.tl.cols.filter(k => k.hidden).map(k => ({ label: k.def.title, run: () => c.tl.setHidden(k.id, false) })).concat(['-', 'col.showAll']) }]);
menus.contribute('global', ['edit.undo', 'edit.redo', '-', 'view.palette', 'edit.find', 'window.cheat', '-', 'view.showTopbar']);
// any row with a Notes column: "+ Add › + note here" (a context with its own + Add menu lists it there)
menus.contribute('noterow', [(c) => c.hasAdd ? [] : [{ label: '+ Add', submenu: [{ cmd: 'notes.addHere', label: '+ note here' }] }]]);
menus.contribute('menubar:View', ['-', 'notes.column', 'notes.review']);

// the contexts whose menu has its own "+ Add" submenu (with "+ note here" in it)
const ADD_CTX = new Set(['lyline', 'lysec', 'lystage', 'scene', 'scgap', 'sbscene', 'shot', 'bditem', 'bdstage', 'chnode']);
// right-click: work out what was clicked, select it, open the menu for its contexts
export function contextArgs(target, clientX, clientY) {
  const tl = WB().timeline, names = [], args = { target };
  const head = target.closest('.tl .head');
  if (head && tl) { names.push('header'); args.col = tl.byId[head.dataset.col]; return { names, args }; }
  const ent = target.closest('[data-ent]');
  // the DOM can briefly hold ids a live reload just removed: an unknown entity / line / clip falls back to the generic menus
  const entity = ent && store.entityById?.[ent.dataset.ent];
  if (entity) { names.push('entity'); args.entity = entity; args.item = `${entity.kind}:${entity.id}`; return { names, args }; }
  if (tl && target.closest('.tl .sheet')) {
    const colEl = target.closest('.col'); args.col = colEl ? tl.byId[colEl.dataset.col] : tl.colAtClientX(clientX);
    args.t = tl.timeAtClientY(clientY);
    const selEl = target.closest('[data-sel]'); if (selEl) args.item = selEl.dataset.sel;
    const cast = target.closest('.cast[data-id]');
    if (cast) { names.push('cast'); args.entity = store.entityById[cast.dataset.id]; args.shot = shotAt(args.t); args.item = `character:${cast.dataset.id}`; }
    else if (selEl) {
      const [k, id] = [args.item.slice(0, args.item.indexOf(':')), args.item.slice(args.item.indexOf(':') + 1)];
      const line = k === 'line' && song().lines.find(l => l.id === id);
      if (line) { names.push('lyric'); args.line = line; const w = target.closest('span[data-t]'); args.t = w ? Number(w.dataset.t) : line.t0; }
      const section = k === 'section' && song().sections.find(s => s.id === id);
      if (section) { names.push('section'); args.section = section; }
      // a shot of the storyboard (storyboard.json) or of shots.json
      const shot = k === 'shot' && (store.shots.find(s => s.id === id) || store.boardShots().find(s => s.id === id));
      if (shot) { names.push('shot'); args.shot = shot; args.shotId = id; }
      const use = k === 'use' && store.uses.find(u => u.id === id);
      if (use) { names.push('clip'); args.use = use; args.shot = shotOfUse(use); }
      const note = k === 'note' && store.notes.notes.find(n => n.id === id);
      if (note) { names.push('note'); args.note = note; }
      if (k === 'scene') { names.push('scene'); args.sceneId = id; }
    }
    if (args.col && (args.col.def.kind === 'lane' || args.col.strip)) names.push('ruler');
    names.push('timeline');
    if (!selEl && !cast) names.push('empty');
    names.unshift('tladd');
    return { names, args };
  }
  // the stage rail (core/rail.js) and a stage workspace (tabs/stage.js)
  const st = target.closest('#rail [data-stage]');
  if (st?.dataset.stage) { names.push('stage'); args.stageId = st.dataset.stage; return { names, args }; }
  // a stage in its Time view (core/timemode.js): "+ Add at m:ss" first, at the time under the pointer (as on the timeline)
  const ax = axisAt(target);
  if (ax?.on && !target.closest('.nclayer, .ncstage')) { args.t = ax.timeAt(clientY); args.tmAxis = ax; names.push('tmadd'); }
  // the stage workspaces' rows: a lyric line / section tag (tabs/lyrics.js), a gap of the script, a storyboard scene, the
  // breakdown, and the Notes column (core/notescol.js) row under the pointer ("+ note here")
  const ly = target.closest('.lyws .lyl[data-line]');
  if (ly) { names.push('lyline'); args.lineId = ly.dataset.line; }
  const lh = !ly && target.closest('.lyws .lyhead');
  if (lh) { names.push('lysec'); args.secId = lh.closest('.lysec')?.dataset.sec; }
  if (!ly && !lh && target.closest('.lyws .lypoem')) names.push('lystage');
  const gp = target.closest('.scws .scrow.gap[data-gap]');
  if (gp) { names.push('scgap'); args.gap = gp.dataset.gap.split(',').map(Number); }
  const sbs = target.closest('.sbws .sbscene[data-scene]');
  if (sbs?.dataset.scene) { names.push('sbscene'); args.sceneId = sbs.dataset.scene; }
  if (target.closest('.bdws .bdbody') && !target.closest('.bdws [data-item]')) names.push('bdstage');
  const col = columnAt(target), row = col?.rowAt(target);
  if (row) { names.push('noterow'); args.ncCol = col; args.ncTarget = col.targetAt(target); }
  const cn = target.closest('.chws [data-node]');   // a node of a character's iteration tree (tabs/charstage.js)
  if (cn?.dataset.node) { names.push('chnode'); args.nodeId = cn.dataset.node; }
  const bi = target.closest('.bdws [data-item]');   // an item in the breakdown stage (tabs/breakdown.js)
  if (bi?.dataset.item) { names.push('bditem'); args.itemId = bi.dataset.item; }
  const sh = target.closest('.sbws [data-shot]');   // a shot in the storyboard stage (tabs/storyboard.js)
  if (sh?.dataset.shot) { names.push('shot'); args.shotId = sh.dataset.shot; args.item = 'shot:' + sh.dataset.shot; args.shot = store.boardShots().find(s => s.id === sh.dataset.shot) || null; }
  const sc = sbs ? null : target.closest('.scws [data-scene], .bdws [data-scene]');   // a scene in the script stage (tabs/script.js) or a breakdown matrix column
  if (sc?.dataset.scene) { names.push('scene'); args.sceneId = sc.dataset.scene; }
  if (target.closest('.stagews')) { names.push('stage'); args.stageId = WB().stages?.current(); }
  args.hasAdd = names.some(n => ADD_CTX.has(n));
  names.push('global');
  return { names, args };
}
document.addEventListener('contextmenu', (e) => {
  if (e.shiftKey || e.target.closest('input, textarea, select, .pop, .pal')) return;   // Shift+right-click = the browser's menu
  e.preventDefault();
  const { names, args } = contextArgs(e.target, e.clientX, e.clientY);
  if (args.item && names[0] !== 'cast' && !selection.keys.has(args.item)) selection.set([args.item]);
  const c = WB().context(args); c.__args = args;
  menus.open(menus.forContexts(names), { x: e.clientX, y: e.clientY }, c);
  WB().lastContext = { names, args };
}, false);
