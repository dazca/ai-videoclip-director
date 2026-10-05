// F8: ONE stage bar, the same on every stage workspace (tabs/stage.js renders it above each stage). Fixed slots, left to
// right, at the same x on every stage (the name and the status have fixed widths):
//   [n · Stage] [● status] [Mark done | Reopen] [Needs you] [primary] [Ask the agent…] [Send round N (k)] [blockers / the
//   agent's stage note …] [List | Time] [‹ prev] [next ›]
// - status: computed from the content (js/flow.js stagesView), the stored mark in its tooltip;
// - Mark done (Reopen once done) and the "Needs you" flag: the director's (only here and on the rail);
// - primary: the stage's own main act, WB.stageActions[stage].primary {label, title, can(), run()} when the stage offers
//   one (Final: Lock for render…), else "Save version" (characters / scenery: "Send edit request"), = stage.save (Ctrl+Enter);
// - Ask the agent…: the stage's asks (a menu; each writes a note the agent reads);
// - Send round: the review round (core/rail.js WB.rounds): "Send round N (k)" while collecting, "Close revision R<n>" once
//   the agent finished, "Round N: Claude working" in between; the same commands as the rail's buttons;
// - List | Time: the stages with a Time view (core/timemode.js); the slot is kept empty elsewhere;
// - ‹ prev / next ›: always both slots (an empty one at the ends).
//   stageBar.render(bar, stageId) · stageBar.bind(bar) · stageBar.refreshPrimary(bar)
//   SLOTS (the data-slot names, in order; tools/verify-layout.mjs (v26) checks every stage has them at the same x)
import { esc } from '../js/store.js';
import { STAGES, STATUS_LABEL, stageById, stageTip } from '../js/flow.js';
import { TIME_STAGES, isTime, setMode } from './timemode.js';
import { menus } from './menus.js';
import { commands } from './commands.js';

export const SLOTS = ['name', 'status', 'mark', 'flag', 'primary', 'ask', 'round', 'info', 'time', 'prev', 'next'];
// what "Ask the agent…" offers on each stage (commands; each one writes a note the agent reads)
export const ASKS = {
  lyrics: ['lyrics.ask', 'proposals.prepare'],
  script: ['script.askDraft', 'script.fillGaps', 'script.ask', 'proposals.prepare'],
  breakdown: ['breakdown.extract', 'breakdown.ask'],
  characters: ['proposals.prepare', { cmd: 'stage.note', label: 'Ask the agent anything about the open character… (a note)' }],
  scenery: ['proposals.prepare', { cmd: 'stage.note', label: 'Ask the agent anything about the open location / prop… (a note)' }],
  storyboard: ['storyboard.ask', 'storyboard.fillGaps', 'storyboard.askNote', 'proposals.prepare'],
  final: [{ cmd: 'stage.note', label: 'Ask the agent anything about the final list… (a note)' }],
};
const SAVE_LABEL = { characters: 'Send edit request', scenery: 'Send edit request' };
const WB = () => window.WB;
function primaryOf(id) {
  const a = WB().stageActions?.[id];
  if (a?.primary) return { label: a.primary.label, title: a.primary.title || a.primary.label, can: () => !!a.primary.can?.(), run: () => a.primary.run() };
  return { label: SAVE_LABEL[id] || 'Save version', title: `${SAVE_LABEL[id] ? 'send the edit request of the open sketch' : 'save your edits as a new version'} (Ctrl+Enter)`, can: () => !!a?.canSave?.(), run: () => a?.save?.() };
}
function roundSlot() {
  const R = WB().rounds; if (!R) return '<span data-slot="round"></span>';
  let s; try { s = R.state(); } catch (e) { return '<span data-slot="round"></span>'; }
  if (s.phase === 'collecting') return `<button data-slot="round" data-rv="send" class="sgrnd"${s.open ? '' : ' disabled'} title="${esc(`Round ${s.n}: every open note of yours (in any stage) goes to the agent as one ask`)}">Send round ${s.n} (${s.open})</button>`;
  if (s.phase === 'sent') return `<button data-slot="round" data-rv="close" class="sgrnd sec" title="${esc(`Round ${s.n} is with Claude. Close revision ${s.next}: snapshot the project now`)}">Round ${s.n}: Claude working</button>`;
  return `<button data-slot="round" data-rv="close" class="sgrnd" title="${esc(`Claude finished round ${s.n}: close revision ${s.next} (snapshot, compare later)`)}">Close revision ${esc(s.next)}</button>`;
}
export const stageBar = {
  render(bar, id) {
    const v = WB().stages.view(), s = v.stages.find(x => x.id === id), d = stageById(id), i = STAGES.findIndex(x => x.id === id);
    const ready = s.content?.status === 'ready', flagged = s.status === 'needs_you', done = s.status === 'done';
    const mark = s.status !== 'empty' && s.status !== s.shown ? `\nmarked: ${STATUS_LABEL[s.status]}` : '';
    const p = primaryOf(id), prev = STAGES[i - 1], next = STAGES[i + 1];
    bar.dataset.stage = id;
    bar.innerHTML = `<b data-slot="name" class="sgname">${d.n} · ${esc(d.title)}</b>`
      + `<span data-slot="status" class="sgst st-${s.shown}" data-shown="${s.shown}" title="${esc(stageTip(s) + mark)}"><i></i>${esc(s.shown_label)}</span>`
      + (done ? `<button data-slot="mark" data-st="in_progress" class="sgb1" title="${esc(s.changed ? `back to in progress (${s.changed})` : 'back to in progress')}">Reopen</button>`
        : `<button data-slot="mark" data-st="done" class="sgb1" title="${esc(ready ? 'sign this stage off (only you can)' : `sign this stage off (only you can). Not ready yet: ${s.content?.blockers.join('; ')}. Marked anyway, it shows done ⚠ until the content is ready`)}">Mark done</button>`)
      + `<button data-slot="flag" data-st="${flagged ? 'in_progress' : 'needs_you'}" class="sgb2${flagged ? ' on' : ''}" title="${flagged ? 'flagged: needs you (click: clear the flag)' : 'flag it for later: it shows "needs you" on the rail'}">Needs you</button>`
      + `<button data-slot="primary" class="sgpri" title="${esc(p.title)}"${p.can() ? '' : ' disabled'}>${esc(p.label)}</button>`
      + `<button data-slot="ask" class="sgask" data-ask="1" title="ask the agent: a note it reads (MCP), from this stage">Ask the agent…</button>`
      + roundSlot()
      + `<span data-slot="info" class="dim sgbl" title="${esc(stageTip(s))}">${s.changed ? `<b class="stw">⚠ ${esc(s.changed)}</b> · ` : ''}${s.blockers_all.length ? esc(s.blockers_all.join(' · ')) : 'nothing blocking'}${s.note ? ` · <span class="sgnote" title="${esc(`${s.updated_by || ''} ${s.updated || ''}`)}">${s.via === 'agent' ? 'agent: ' : ''}${esc(s.note)}</span>` : ''}</span>`
      + (TIME_STAGES.includes(id) ? `<span data-slot="time" class="sgtm" title="${esc(`List: the stage's own list (the default). Time: ${id === 'final' ? 'the rows grouped by song section, in time order' : "the rows on the timeline's time axis (the same y for the same ms); a click on an empty spot seeks"}. Alt+T`)}"><a data-tm="list" class="${isTime(id) ? '' : 'on'}">List</a><a data-tm="time" class="${isTime(id) ? 'on' : ''}">Time</a></span>` : '<span data-slot="time" class="sgtm none"></span>')
      + `<a data-slot="prev" class="sgnv"${prev ? ` data-go="${prev.id}" title="Alt+Shift+${prev.n}"` : ''}>${prev ? `‹ ${esc(prev.title)}` : ''}</a>`
      + `<a data-slot="next" class="sgnv"${next ? ` data-go="${next.id}" title="Alt+Shift+${next.n}"` : ''}>${next ? `${esc(next.title)} ›` : ''}</a>`;
  },
  // the primary button follows the stage's draft (dirty / clean) without a full re-render
  refreshPrimary(bar) { const b = bar.querySelector('[data-slot=primary]'), id = bar.dataset.stage; if (b && id) { const p = primaryOf(id); b.disabled = !p.can(); if (b.textContent !== p.label) b.textContent = p.label; } },
  bind(bar) {
    bar.addEventListener('click', (e) => {
      const id = WB().stages.current();
      const b = e.target.closest('[data-st]'); if (b) return WB().stages.setStatus(id, b.dataset.st);
      const g = e.target.closest('[data-go]'); if (g) return WB().stages.open(g.dataset.go);
      const tm = e.target.closest('[data-tm]'); if (tm) return setMode(id, tm.dataset.tm);
      const pr = e.target.closest('[data-slot=primary]'); if (pr && !pr.disabled) return primaryOf(id).run();
      const rv = e.target.closest('[data-rv]'); if (rv && !rv.disabled) return commands.run(rv.dataset.rv === 'send' ? 'round.send' : 'revision.close');
      const ak = e.target.closest('[data-ask]'); if (ak) { const r = ak.getBoundingClientRect(); menus.open(ASKS[id] || [], { x: r.left, y: r.bottom }); }
    });
  },
};
