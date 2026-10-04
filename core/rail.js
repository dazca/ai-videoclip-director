// The stage rail (docs/SPEC_v3_GUIDED.md): one 18 px row under the top bar with the seven stages of the guided flow,
// a status dot each (empty / in progress / needs you / done) and a "next: ..." hint with what blocks it. Hidden with
// the top bar (`), or on its own (View > Stage rail). A click opens the stage workspace (tabs/stage.js); every action is
// a command (palette "Go to stage: Lyrics", Alt+Shift+1..7, right-click on a stage).
//   WB.stages: { open(id), current(), view(), setStatus(id, status) }
import { commands } from './commands.js';
import { menus } from './menus.js';
import { store, prefs, toast, esc } from '../js/store.js';
import '../tabs/lyrics.js';   // registers the lyrics commands (palette, keys) before its workspace is first opened
import '../tabs/script.js';   // the same for the script stage
import { STAGES, STATUS_LABEL, stagesView, projectFacts, stageById } from '../js/flow.js';

const WB = () => window.WB;
const facts = () => projectFacts({ song: store.song, script: store.script, shots: store.shots, entities: store.entities, lyrics: store.lyrics, scenes: store.scenes });
const view = () => stagesView(store.stages, facts());
const current = () => { const s = prefs.get('stage', 'lyrics'); return stageById(s) ? s : 'lyrics'; };
const onStage = (c) => (c || WB().context()).tab === 'stage';

export const stages = {
  view, current,
  async open(id) { if (!stageById(id)) return; prefs.set('stage', id); await WB().app.show('stage'); document.dispatchEvent(new CustomEvent('wb:stage', { detail: id })); render(); },
  // the page's own act: a status change here is the director's (serve.mjs stamps via "page"; done only from here)
  setStatus(id, status) {
    return store.mutate('stages.json', (d) => { const s = d.stages.find(x => x.id === id); if (s) s.status = status; }, { label: `stage ${id} ${STATUS_LABEL[status]}` })
      .then(() => toast(`${stageById(id).title}: ${STATUS_LABEL[status]}`));
  },
};

let el = null;
function render() {
  if (!el || !store.stages) return;
  const v = view(), cur = WB()?.app?.active() === 'stage' ? current() : null;
  const next = v.next;
  el.innerHTML = v.stages.map(s => `<a data-stage="${s.id}" class="st-${s.status}${s.id === cur ? ' on' : ''}" title="${esc(`${s.n} ${s.title}: ${STATUS_LABEL[s.status]}${s.done_by && s.status === 'done' ? ` (${s.done_by === 'derived' ? 'had content' : 'marked by the ' + s.done_by})` : ''}\n${stageById(s.id).does}${s.blockers_all.length ? '\n· ' + s.blockers_all.join('\n· ') : ''}\nAlt+Shift+${s.n} · right-click: status`)}"><i></i>${s.n} ${esc(s.title)}</a>`).join('')
    + `<span class="next" data-stage="${esc(next?.id || '')}" title="${esc(next ? `next: ${next.title}${next.blockers.length ? '\n· ' + next.blockers.join('\n· ') : ''}` : 'every stage is done')}">${next ? `next: <b>${esc(next.title)}</b>${next.blockers.length ? ' · ' + esc(next.blockers[0]) : ''}` : 'all stages done'}</span>`;
}
export function mountRail() {
  el = document.getElementById('rail');
  if (!el) { el = document.createElement('nav'); el.id = 'rail'; document.getElementById('top').after(el); }
  el.setAttribute('aria-label', 'stages');
  document.body.classList.toggle('norail', prefs.get('rail', true) === false);
  el.addEventListener('click', (e) => { const a = e.target.closest('[data-stage]'); if (a?.dataset.stage) stages.open(a.dataset.stage); });
  store.on((w) => { if (['stages', 'lyrics', 'scenes', 'all'].includes(w)) render(); });
  document.addEventListener('wb:page', render);
  render();
}

// ------------------------------------------------------------------ commands
const C = STAGES.map(s => ({ id: `stage.${s.id}`, group: 'Stages', title: `Go to stage: ${s.title}`, keys: [`Alt+Shift+${s.n}`],
  checked: (c) => c.tab === 'stage' && current() === s.id, run: () => stages.open(s.id) }));
const target = (c) => c.stageId || (onStage(c) ? current() : null);
C.push(
  { id: 'stage.next', group: 'Stages', title: () => `Go to the next stage${view().next ? ': ' + view().next.title : ''}`, when: () => !!view().next, run: () => stages.open(view().next.id) },
  { id: 'stage.open', group: 'Stages', title: (c) => `Open ${stageById(target(c))?.title || 'stage'}`, hidden: true, when: (c) => !!target(c), run: (c) => stages.open(target(c)) },
  { id: 'stage.done', group: 'Stages', title: (c) => `Mark ${stageById(target(c))?.title || 'stage'} done`, when: (c) => !!target(c) && view().stages.find(s => s.id === target(c))?.status !== 'done', run: (c) => stages.setStatus(target(c), 'done') },
  { id: 'stage.reopen', group: 'Stages', title: (c) => `Reopen ${stageById(target(c))?.title || 'stage'}`, when: (c) => !!target(c) && view().stages.find(s => s.id === target(c))?.status === 'done', run: (c) => stages.setStatus(target(c), 'in_progress') },
  { id: 'stage.progress', group: 'Stages', title: 'Mark stage in progress', hidden: true, when: (c) => !!target(c) && view().stages.find(s => s.id === target(c))?.status !== 'in_progress', run: (c) => stages.setStatus(target(c), 'in_progress') },
  { id: 'stage.needsYou', group: 'Stages', title: 'Flag stage: needs you', hidden: true, when: (c) => !!target(c) && view().stages.find(s => s.id === target(c))?.status !== 'needs_you', run: (c) => stages.setStatus(target(c), 'needs_you') },
  // one key per act across the stage workspaces: each stage module offers WB.stageActions[<stage>] {canSave, save, canNote, note}
  { id: 'stage.save', group: 'Stages', title: 'Save a version (lyrics / script)', keys: ['Ctrl+Enter'], global: true, when: (c) => onStage(c) && !!WB().stageActions?.[current()]?.canSave(), run: () => WB().stageActions[current()].save() },
  { id: 'stage.note', group: 'Stages', title: 'Note (lyrics: the selected words; script: the open scene)', keys: ['Alt+N'], when: (c) => onStage(c) && !!WB().stageActions?.[current()]?.canNote(), run: () => WB().stageActions[current()].note() },
  { id: 'view.rail', group: 'View', title: 'Stage rail', checked: () => !document.body.classList.contains('norail'), run: () => { const off = !document.body.classList.contains('norail'); document.body.classList.toggle('norail', off); prefs.set('rail', !off); WB().timeline?.requestRelayout(); } },
);
commands.register(C);
const goItems = () => STAGES.map(s => ({ cmd: `stage.${s.id}`, label: `${s.n} ${s.title}` }));
menus.contribute('stage', ['stage.open', 'stage.done', 'stage.reopen', 'stage.progress', 'stage.needsYou', '-', { label: 'Go to stage', submenu: goItems }, 'stage.next', 'view.rail']);
menus.contribute('menubar:View', ['-', 'view.rail', { label: 'Stages', submenu: () => [...goItems(), '-', 'stage.next'] }]);
menus.contribute('menubar:Window', ['-', { label: 'Stages', submenu: () => [...goItems(), '-', 'stage.next', 'stage.done', 'stage.reopen'] }]);
menus.contribute('global', ['-', { label: 'Go to stage', submenu: goItems }]);
window.WB = Object.assign(window.WB || {}, { stages });
