// The stage rail (docs/SPEC_v3_GUIDED.md): one 18 px row under the top bar with the seven stages of the guided flow,
// a status dot each and a "next: ..." hint with what blocks it. The dot is computed from the content (js/flow.js
// stagesView "shown": empty / in progress / needs you / ready to mark done / done / done ⚠ changed since), never from
// the stored mark alone; the tooltip lists the counts and the blockers. Hidden with
// the top bar (`), or on its own (View > Stage rail). A click opens the stage workspace (tabs/stage.js); every action is
// a command (palette "Go to stage: Lyrics", Alt+Shift+1..7, right-click on a stage). Each stage shows its open notes
// (notes.json v2, the stage's Notes column) as a small count. At its right end: the review round (js/revisions.js;
// SPEC v4 §2): "Round N · K open notes" + "Send round to Claude" (one click, page only: every open note of the director's
// goes to the agent as one ask), then the agent's progress (absorbed / replied / left) while it works, then
// "Close revision R<n>" (page only), and a chip with the latest revision that opens Review › Compare.
//   WB.stages: { open(id), current(), view(), setStatus(id, status) }
//   WB.rounds: { state(), send(), close(summary?), restore(id) }
import { commands } from './commands.js';
import { menus } from './menus.js';
import { store, prefs, toast, esc, postJSON } from '../js/store.js';
import '../tabs/lyrics.js';   // registers the lyrics commands (palette, keys) before its workspace is first opened
import '../tabs/script.js';   // the same for the script stage
import '../tabs/breakdown.js';   // and the breakdown stage
import '../tabs/charstage.js';   // and the characters stage
import '../tabs/scenery.js';   // and the scenery stage (locations, props)
import '../tabs/storyboard.js';   // and the storyboard stage
import { STAGES, STATUS_LABEL, stagesView, projectFacts, stageById, stageTip } from '../js/flow.js';
import { openCounts } from '../js/notes.js';
import * as RV from '../js/revisions.js';

const WB = () => window.WB;
const facts = () => projectFacts({ song: store.song, script: store.script, shots: store.shots, entities: store.entities, lyrics: store.lyrics, scenes: store.scenes, breakdown: store.breakdown, storyboard: store.board, approvals: store.approvals, notes: store.notes });
const view = () => stagesView(store.stages, facts());
const current = () => { const s = prefs.get('stage', 'lyrics'); return stageById(s) ? s : 'lyrics'; };
const onStage = (c) => (c || WB().context()).tab === 'stage';

export const stages = {
  view, current,
  async open(id) { if (!stageById(id)) return; prefs.set('stage', id); await WB().app.show('stage'); document.dispatchEvent(new CustomEvent('wb:stage', { detail: id })); render(); },
  // the page's own act: a status change here is the director's (serve.mjs stamps via "page"; done only from here)
  // a "done" records whether the content was ready then (done_ok): a later regression reads "changed since"
  setStatus(id, status) {
    const ready = view().stages.find(x => x.id === id)?.content?.status === 'ready';
    return store.mutate('stages.json', (d) => { const s = d.stages.find(x => x.id === id); if (!s) return; s.status = status; if (status === 'done') s.done_ok = ready; else delete s.done_ok; }, { label: `stage ${id} ${STATUS_LABEL[status]}` })
      .then(() => toast(`${stageById(id).title}: ${STATUS_LABEL[status]}`));
  },
};

// ------------------------------------------------------------------ review rounds (the page's acts: send, close, restore)
async function act(op, body = {}) {
  const r = await postJSON('/api/op/' + op, body), j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(`${op.replace('_', ' ')}: ${j.error || r.status}`); throw new Error(j.error || r.status); }
  return j;
}
export const rounds = {
  // {phase: collecting | sent | finished, n, open (notes a send would take), live (the round in flight), progress, next (revision id), last}
  state() {
    const rv = store.revisions || RV.emptyRevisions(), live = RV.inFlight(rv);
    return { phase: live ? live.status : 'collecting', n: live ? live.n : store.notes?.round || 1, open: RV.roundCandidates(store.notes).length, live,
      progress: live ? RV.roundProgress(store.notes, live) : null, next: RV.nextRevisionId(rv), last: RV.lastRevision(rv), count: rv.revisions.length };
  },
  async send() { const j = await act('round_send'); toast(`Round ${j.round} sent to Claude: ${j.notes} note${j.notes > 1 ? 's' : ''} in one ask (${j.ask})`); return j; },
  async close(summary) { const j = await act('revision_close', summary ? { summary } : {}); toast(`${j.id} closed: ${j.notes_absorbed.length} absorbed · ${j.files_changed.length} file${j.files_changed.length === 1 ? '' : 's'}${j.cost_delta ? ` · +$${j.cost_delta.toFixed(2)}` : ''}`); return j; },
  async restore(id) { const j = await act('revision_restore', { id }); toast(`restored ${id} (the state before is snapshot ${j.previous}; notes kept)`); return j; },
};
function roundHtml() {
  if (!store.notes) return '';
  const s = rounds.state(), chip = s.last ? `<a class="rvc" data-rv="compare" title="${esc(`${s.last.id}: ${s.last.summary}\n${s.count} revision${s.count > 1 ? 's' : ''} · click: compare revisions`)}">${esc(s.last.id)}</a>` : '';
  if (s.phase === 'collecting') {
    return `<span class="rnd" data-phase="collecting" title="${esc(`Round ${s.n}: the notes you write in any stage collect here.\nSend round to Claude: every open note goes to the agent as one ask.`)}"><b>Round ${s.n}</b> · ${s.open} open note${s.open === 1 ? '' : 's'}`
      + `<button class="rbtn" data-rv="send"${s.open ? '' : ' disabled'}>Send round to Claude</button>${chip}</span>`;
  }
  const p = s.progress, done = p.absorbed + p.replied + p.dismissed, pct = p.total ? Math.round(100 * done / p.total) : 100;
  const bar = `<i class="rpb" title="${esc(RV.progressText(p))}"><u style="width:${pct}%"></u></i>`;
  const lbl = s.phase === 'sent' ? 'Claude working' : 'Claude finished';
  return `<span class="rnd" data-phase="${s.phase}" title="${esc(`Round ${s.n} sent ${String(s.live.sent_at).replace('T', ' ')}${s.live.summary ? `\nClaude: ${s.live.summary}` : ''}\nClose revision: snapshot the project as ${s.next} (compare and restore it later)`)}"><b>Round ${s.n}</b> · ${lbl} ${bar}`
    + `<span class="rpg"><em class="ab">${p.absorbed}</em> absorbed · <em class="rp">${p.replied}</em> replied · <em class="lf">${p.left}</em> left</span>`
    + `<button class="rbtn${s.phase === 'sent' ? ' sec' : ''}" data-rv="close">Close revision ${esc(s.next)}</button>${chip}</span>`;
}

let el = null;
function render() {
  if (!el || !store.stages) return;
  const v = view(), cur = WB()?.app?.active() === 'stage' ? current() : null;
  const next = v.next, oc = openCounts(store.notes);
  el.innerHTML = v.stages.map(s => { const k = oc.stages[s.id] || 0; return `<a data-stage="${s.id}" data-shown="${s.shown}" class="st-${s.shown}${s.id === cur ? ' on' : ''}" title="${esc(`${stageTip(s)}${k ? `\n${k} open note${k > 1 ? 's' : ''}` : ''}\n${stageById(s.id).does}\nAlt+Shift+${s.n} · right-click: status`)}"><i></i>${s.n} ${esc(s.title)}${s.shown === 'changed' ? '<b class="stw">⚠</b>' : ''}${k ? `<b class="rnc" title="${k} open note${k > 1 ? 's' : ''}">${k}</b>` : ''}</a>`; }).join('')
    + `<span class="next" data-stage="${esc(next?.id || '')}" title="${esc(next ? `next: ${next.title}${next.blockers.length ? '\n· ' + next.blockers.join('\n· ') : ''}` : 'every stage is done')}">${next ? `next: <b>${esc(next.title)}</b>${next.blockers.length ? ' · ' + esc(next.blockers[0]) : ''}` : 'all stages done'}</span>`
    + roundHtml();
}
export function mountRail() {
  el = document.getElementById('rail');
  if (!el) { el = document.createElement('nav'); el.id = 'rail'; document.getElementById('top').after(el); }
  el.setAttribute('aria-label', 'stages');
  document.body.classList.toggle('norail', prefs.get('rail', true) === false);
  el.addEventListener('click', (e) => {
    const r = e.target.closest('[data-rv]');
    if (r) { if (r.disabled) return; const k = r.dataset.rv; commands.run(k === 'send' ? 'round.send' : k === 'close' ? 'revision.close' : 'revision.compare'); return; }
    const a = e.target.closest('[data-stage]'); if (a?.dataset.stage) stages.open(a.dataset.stage);
  });
  store.on((w) => { if (['stages', 'lyrics', 'scenes', 'breakdown', 'board', 'entities', 'approvals', 'notes', 'revisions', 'all'].includes(w)) render(); });
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
  { id: 'stage.save', group: 'Stages', title: 'Save a version (lyrics / script / breakdown / storyboard) / send the edit request (characters, scenery)', keys: ['Ctrl+Enter'], global: true, when: (c) => onStage(c) && !!WB().stageActions?.[current()]?.canSave(), run: () => WB().stageActions[current()].save() },
  { id: 'stage.note', group: 'Stages', title: 'Note (lyrics: the selected words; script: the open scene; breakdown: the open item; storyboard: the selected shot)', keys: ['Alt+N'], when: (c) => onStage(c) && !!WB().stageActions?.[current()]?.canNote(), run: () => WB().stageActions[current()].note() },
  { id: 'view.rail', group: 'View', title: 'Stage rail', checked: () => !document.body.classList.contains('norail'), run: () => { const off = !document.body.classList.contains('norail'); document.body.classList.toggle('norail', off); prefs.set('rail', !off); WB().timeline?.requestRelayout(); } },
);
// the review round: one command per act (palette, File menu, the rail's buttons)
C.push(
  { id: 'round.send', group: 'Review', title: () => { const s = rounds.state(); return `Send round ${s.n} to Claude (${s.open} open note${s.open === 1 ? '' : 's'})`; }, when: () => { const s = rounds.state(); return s.phase === 'collecting' && s.open > 0; }, run: () => rounds.send().catch(() => {}) },
  { id: 'revision.close', group: 'Review', title: () => { const s = rounds.state(); return s.live ? `Close revision ${s.next} (round ${s.n})` : `Close revision ${s.next} (a checkpoint, no round)`; }, run: () => rounds.close().catch(() => {}) },
  { id: 'revision.compare', group: 'Review', title: 'Compare revisions', run: () => WB().app.show('compare') },
  { id: 'revision.git', group: 'Review', title: 'Mirror revisions to git (data/<project>/.history)', checked: () => store.settings?.revisions_git === true,
    run: () => store.setSettings((d) => { d.revisions_git = d.revisions_git !== true; }).then(() => toast(`git mirror of revisions: ${store.settings?.revisions_git ? 'on (needs git on PATH)' : 'off'}`)) },
);
commands.register(C);
const goItems = () => STAGES.map(s => ({ cmd: `stage.${s.id}`, label: `${s.n} ${s.title}` }));
menus.contribute('stage', ['stage.open', 'stage.done', 'stage.reopen', 'stage.progress', 'stage.needsYou', '-', { label: 'Go to stage', submenu: goItems }, 'stage.next', 'view.rail']);
menus.contribute('menubar:View', ['-', 'view.rail', { label: 'Stages', submenu: () => [...goItems(), '-', 'stage.next'] }]);
menus.contribute('menubar:Window', ['-', { label: 'Stages', submenu: () => [...goItems(), '-', 'stage.next', 'stage.done', 'stage.reopen'] }]);
menus.contribute('global', ['-', { label: 'Go to stage', submenu: goItems }]);
menus.contribute('menubar:File', ['-', 'round.send', 'revision.close', 'revision.compare', 'revision.git']);
window.WB = Object.assign(window.WB || {}, { stages, rounds });
