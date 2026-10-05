// Named sync points in the page (ROADMAP_v4 E1): the director's acts on events.json (js/events.js) and the re-time after
// the take. Everything here is a page act through the server's page-only ops (events_act, retime_apply, retime_undo; an
// agent proposes with event_add / retime_propose, shown here to accept / apply).
//   + Named event here      right-click on the timeline (+ Add), a stage in its Time view, or a lyric word ("at “word”")
//   the event dialog        name, kind, time (locked while boundaries are anchored to it), measured (typed, = playhead,
//                           cleared), note; Accept (an agent's), Dismiss, Remove
//   Re-time after the take… (Timeline menu, the palette): the measured events and the agent's proposed re-times, the
//                           preview (every anchored boundary and the cuts that share it, old → new, problems), Apply = ONE
//                           undoable change (a new scenes and storyboard version; Ctrl+Z = retime_undo)
//   Import events…          an audio events.json (the first film's audio/out/final/events.json: seconds) as named events
//   Time view markers       a thin line per event across a stage in its Time view (core/timemode.js axisHooks)
// API: WB.events = {addAt(t, {name, kind}), edit(id), accept(id), dismiss(id), remove(id), measure(id, t | null),
//      openRetime(), openImport(), plan()}
import { commands } from './commands.js';
import { menus } from './menus.js';
import { history } from './history.js';
import { axisHooks } from './timemode.js';
import { store, toast, esc } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { currentScript } from '../js/scenes.js';
import * as E from '../js/events.js';

const WB = () => window.WB;
const CSS = `.evback{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding-top:7vh}
.evdlg{width:min(680px,96vw);max-height:84vh;display:flex;flex-direction:column;background:var(--bg2);border:1px solid var(--line);box-shadow:0 10px 30px rgba(0,0,0,.6);font:12px/16px "Segoe UI",Arial,sans-serif;color:var(--fg)}
.evdlg .evh{display:flex;gap:8px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--line)} .evdlg .sp{flex:1}
.evdlg .evh i{cursor:pointer;font-style:normal;font-size:16px;color:var(--dim)}
.evdlg .evb{padding:6px 8px;overflow:auto}
.evdlg .evg2{display:grid;grid-template-columns:90px 1fr;gap:4px 8px;align-items:center}
.evdlg input,.evdlg select,.evdlg textarea{font:12px "Segoe UI",Arial,sans-serif;box-sizing:border-box}
.evdlg input.tm{font-family:Consolas,monospace;width:110px} .evdlg textarea{width:100%;height:46px;resize:vertical}
.evdlg .evf{display:flex;gap:6px;align-items:center;padding:4px 8px;border-top:1px solid var(--line2);flex-wrap:wrap}
.evdlg table{border-collapse:collapse;width:100%;margin:2px 0 8px} .evdlg td,.evdlg th{padding:1px 6px;border-bottom:1px solid var(--line2);text-align:left;white-space:nowrap}
.evdlg th{color:var(--dim);font-weight:normal} .evdlg td.old{color:var(--dim)} .evdlg td.new{color:var(--acc)} .evdlg .why{color:var(--dim);font-size:11px}
.evdlg h4{margin:6px 0 2px;font-size:12px;color:var(--dim);font-weight:normal;text-transform:uppercase;letter-spacing:.04em}
.evdlg .err{color:#f08080} .evdlg .ok{color:#7fbf8f} .evdlg .dim{color:var(--dim)} .evdlg a{cursor:pointer;color:var(--acc)}
.evdlg .prop{border:1px dashed var(--line);padding:3px 6px;margin:3px 0}
.tmev{position:absolute;left:0;right:var(--ncw,0px);top:0;height:0;border-top:1px dashed var(--evc,#f5a524);z-index:5;pointer-events:none;opacity:.85}
.tmev span{position:absolute;right:2px;top:-12px;font-size:10px;line-height:11px;color:var(--evc,#f5a524);background:var(--bg);padding:0 3px;border:1px solid var(--evc,#f5a524);border-bottom:0}
.tmev.ghost{border-top-color:#f08080;opacity:.6}
.scanc,.sbanc{font-size:11px;max-width:170px;margin:0 6px 0 2px;background:var(--bg);color:var(--acc);border:1px solid var(--line2)}
.scanc-m{color:var(--acc);font-size:11px} .sbancs{display:flex;gap:8px;align-items:center}`;
const css = () => { if (!document.getElementById('evcss')) { const st = document.createElement('style'); st.id = 'evcss'; st.textContent = CSS; document.head.appendChild(st); } };
const parseT = (s) => { s = String(s ?? '').trim(); if (!s) return null; if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000); const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s); return m ? Math.round((Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) : null; };
const ctx = () => ({ scenes: currentScript(store.scenes)?.scenes || [], shots: store.boardShots(), song: store.song });
const ev = (id) => store.events.find(e => e.id === id) || null;
const playhead = () => Math.round(WB()?.timeline?.player.time() ?? 0);
async function act(body, okMsg) {
  try { const r = await store.op('events_act', body); if (okMsg) toast(okMsg); return r; } catch (e) { toast(`not done: ${e.message}`); throw e; }
}

// ------------------------------------------------------------------ a small dialog shell
function dialog(title, sub, bodyHtml, footHtml) {
  css();
  const el = document.createElement('div'); el.className = 'evback';
  el.innerHTML = `<div class="evdlg" role="dialog" aria-label="${esc(title)}"><div class="evh"><b>${esc(title)}</b><span class="dim">${esc(sub || '')}</span><span class="sp"></span><i data-x="close" title="Esc">×</i></div>
    <div class="evb">${bodyHtml}</div><div class="evf">${footHtml}</div></div>`;
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-x=close]')) el.remove(); });
  el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') el.remove(); });
  document.body.appendChild(el);
  return el;
}

// ------------------------------------------------------------------ the event dialog (add / edit)
function eventDialog({ id = null, t = 0, name = '', kind = 'stop', note = '' } = {}) {
  const e = id ? ev(id) : null, cx = ctx(), anchored = e ? E.anchoredTo(e.id, cx) : [];
  const kinds = E.KINDS.map(k => `<option value="${k}"${(e?.kind || kind) === k ? ' selected' : ''}>${E.KIND_ICON[k]} ${E.KIND_LABEL[k]}</option>`).join('');
  const el = dialog(e ? `Event ${e.id}` : 'New named event', e ? `${e.status}${e.via === 'agent' ? ' · by the agent' : ''}` : 'a sync point a cut can land on',
    `<div class="evg2"><span>Name</span><input name="name" value="${esc(e?.name ?? name)}" spellcheck="false" placeholder="her hi there">
      <span>Kind</span><select name="kind">${kinds}</select>
      <span>Time</span><span><input class="tm" name="t" value="${fmt(e?.t ?? t, true)}"${anchored.length ? ' disabled' : ''} spellcheck="false"> ${anchored.length ? `<span class="dim">⚓ ${anchored.length} boundar${anchored.length === 1 ? 'y follows' : 'ies follow'} it: ${esc(anchored.map(a => `${a.kind} ${a.id}.${a.edge}`).join(', '))} (set the measured time and re-time)</span>` : '<a data-x="tplay">= playhead</a>'}</span>
      ${e ? `<span>Measured</span><span><input class="tm" name="measured" value="${Number.isFinite(e.measured) ? fmt(e.measured, true) : ''}" placeholder="where it landed" spellcheck="false"> <a data-x="mplay">= playhead</a> · <a data-x="mclear">clear</a> <span class="dim">where it really landed in the chosen take</span></span>` : ''}
      <span>Note</span><textarea name="note" spellcheck="false" placeholder="what is heard there">${esc(e?.note ?? note)}</textarea></div><div class="evr"></div>`,
    `${e?.status === 'proposed' ? '<button data-x="accept" class="pri">Accept</button><button data-x="dismiss">Dismiss</button>' : ''}${e ? '<button data-x="remove">Remove</button>' : ''}<span class="sp"></span>${e && Number.isFinite(e.measured) && e.measured !== e.t ? '<button data-x="retime">Re-time…</button>' : ''}<button data-x="save" class="${e?.status === 'proposed' ? '' : 'pri'}">${e ? 'Save' : 'Add event'}</button>`);
  const $ = (s) => el.querySelector(s), err = (m) => { $('.evr').innerHTML = `<span class="err">${esc(m)}</span>`; };
  el.addEventListener('click', async (x) => {
    const k = x.target.closest('[data-x]')?.dataset.x; if (!k || k === 'close') return;
    try {
      if (k === 'tplay') { $('[name=t]').value = fmt(playhead(), true); return; }
      if (k === 'mplay') { $('[name=measured]').value = fmt(playhead(), true); return; }
      if (k === 'mclear') { $('[name=measured]').value = ''; return; }
      if (k === 'accept') { await api.accept(e.id); el.remove(); return; }
      if (k === 'dismiss') { await api.dismiss(e.id); el.remove(); return; }
      if (k === 'remove') { await api.remove(e.id); el.remove(); return; }
      if (k === 'retime') { el.remove(); openRetime(); return; }
      if (k === 'save') {
        const nm = $('[name=name]').value.trim(), tt = parseT($('[name=t]').value), kd = $('[name=kind]').value, nt = $('[name=note]').value;
        if (!nm) return err('a name, please'); if (tt == null) return err('time: m:ss.mmm or seconds');
        if (!e) { const r = await act({ act: 'add', name: nm, t: tt, kind: kd, note: nt }, `event added at ${fmt(tt, true)}`); el.remove(); return r; }
        const ms = $('[name=measured]').value.trim(), mt = ms ? parseT(ms) : null; if (ms && mt == null) return err('measured: m:ss.mmm or seconds');
        await act({ act: 'update', id: e.id, name: nm, kind: kd, note: nt, ...(anchored.length ? {} : { t: tt }) });
        if ((mt ?? null) !== (e.measured ?? null)) await act({ act: 'measure', id: e.id, measured: mt });
        toast(`event ${e.id} saved`); el.remove();
      }
    } catch (er) { err(er.message || String(er)); }
  });
  setTimeout(() => $('[name=name]').focus(), 0);
  return el;
}

// ------------------------------------------------------------------ the re-time dialog
let rtEl = null;
export function plan(moves) {
  const m = moves || E.pendingEvents(store.eventsDoc).map(e => ({ event: e.id, to: e.measured }));
  return E.retimePlan({ moves: m, events: store.events, ...ctx() });
}
const planTable = (p) => p.rows.length
  ? `<table class="rtrows"><tr><th>boundary</th><th>old</th><th></th><th>new</th><th>why</th></tr>${p.rows.map(r => `<tr data-row="${esc(`${r.kind}:${r.id}:${r.edge}`)}"><td>${r.kind} <b>${esc(r.id)}</b>.${r.edge === 't0' ? 'start' : 'end'}</td><td class="old">${fmt(r.from, true)}</td><td>→</td><td class="new">${fmt(r.to, true)}</td><td class="why">${r.why === 'anchored' ? '⚓ anchored to' : 'shares the cut of'} ${esc(r.event)}</td></tr>`).join('')}</table>`
  : '<div class="dim">no scene or shot boundary is anchored to these events (anchor them in the script / storyboard: snap "events")</div>';
export function openRetime() {
  css(); rtEl?.remove();
  const D = store.eventsDoc, pend = E.pendingEvents(D), props = D.retimes.filter(r => r.status === 'proposed'), last = [...D.retimes].reverse().find(r => r.status === 'applied');
  const p = plan();
  const body = `<h4>Measured events (${pend.length})</h4>`
    + (pend.length ? `<table><tr><th>event</th><th>now</th><th></th><th>measured</th><th></th></tr>${pend.map(e => `<tr data-ev="${esc(e.id)}"><td>${E.KIND_ICON[e.kind] || ''} <b>${esc(e.name)}</b></td><td class="old">${fmt(e.t, true)}</td><td>→</td><td><input class="tm" value="${fmt(e.measured, true)}" spellcheck="false"></td><td><a data-x="mplay">= playhead</a> · <a data-x="mclear">clear</a></td></tr>`).join('')}</table>`
      : '<div class="dim">none: drag an event in the timeline\'s events column (or set its measured time) to where it landed in the chosen take</div>')
    + (pend.length ? `<h4>Preview: what moves</h4>${planTable(p)}${p.problems.length ? `<div class="err">cannot apply: ${esc(p.problems.join('; '))}</div>` : ''}` : '')
    + (props.length ? `<h4>Proposed by the agent (${props.length})</h4>${props.map(r => { const q = plan(r.moves.map(m => ({ event: m.event, to: m.to }))); return `<div class="prop" data-rt="${esc(r.id)}"><b>${esc(r.id)}</b> ${esc(r.moves.map(m => `${m.event} ${fmt(m.from, true)} → ${fmt(m.to, true)}`).join(', '))}${r.why ? `<div class="why">${esc(r.why)}</div>` : ''}${planTable(q)}${q.problems.length ? `<div class="err">${esc(q.problems.join('; '))}</div>` : ''}<button data-x="rtapply" class="pri"${q.problems.length || !q.moves.length ? ' disabled' : ''}>Apply ${esc(r.id)}</button> <button data-x="rtdismiss">Dismiss</button></div>`; }).join('')}` : '')
    + (last ? `<div class="dim" style="margin-top:6px">last applied: ${esc(last.id)} (${esc((last.applied_at || '').replace('T', ' '))}) · scenes ${esc((last.versions?.scenes || []).join(' → ') || '–')} · storyboard ${esc((last.versions?.storyboard || []).join(' → ') || '–')} (Ctrl+Z undoes it)</div>` : '')
    + '<div class="rtres"></div>';
  rtEl = dialog('Re-time after the take', 'move every boundary anchored to the measured events · uses the saved script and storyboard', body,
    `<span class="dim">one undoable change: a new scenes and storyboard version (Ctrl+Z)</span><span class="sp"></span><button data-x="apply" class="pri"${!pend.length || p.problems.length || !p.rows.length ? ' disabled' : ''}>Apply re-time${p.rows.length ? ` (${p.rows.length} boundar${p.rows.length === 1 ? 'y' : 'ies'})` : ''}</button>`);
  const res = (h, bad) => { const r = rtEl.querySelector('.rtres'); r.innerHTML = h; r.className = 'rtres ' + (bad ? 'err' : 'ok'); };
  rtEl.addEventListener('change', async (x) => {
    const row = x.target.closest('tr[data-ev]'); if (!row || !x.target.matches('input')) return;
    const t = parseT(x.target.value); if (t == null) return res('measured: m:ss.mmm or seconds', true);
    await api.measure(row.dataset.ev, t); openRetime();
  });
  rtEl.addEventListener('click', async (x) => {
    const k = x.target.closest('[data-x]')?.dataset.x; if (!k || k === 'close') return;
    const row = x.target.closest('tr[data-ev]'), rt = x.target.closest('[data-rt]')?.dataset.rt;
    try {
      if (k === 'mplay' && row) { await api.measure(row.dataset.ev, playhead()); return openRetime(); }
      if (k === 'mclear' && row) { await api.measure(row.dataset.ev, null); return openRetime(); }
      if (k === 'rtdismiss') { await act({ act: 'retime_dismiss', retime: rt }, `${rt} dismissed`); return openRetime(); }
      if (k === 'apply' || k === 'rtapply') {
        const body = k === 'apply' ? { moves: E.pendingEvents(store.eventsDoc).map(e => ({ event: e.id, to: e.measured })) } : { retime: rt };
        const r = await apply(body);
        openRetime(); rtEl.querySelector('.rtres').className = 'rtres ok';
        rtEl.querySelector('.rtres').innerHTML = `applied ${esc(r.retime)}: ${r.plan.rows.length} boundaries · scenes ${esc((r.versions.scenes || []).join(' → ') || 'unchanged')} · storyboard ${esc((r.versions.storyboard || []).join(' → ') || 'unchanged')} (Ctrl+Z undoes it)`;
      }
    } catch (er) { res(esc(er.message || String(er)), true); }
  });
  return rtEl;
}
// the re-time as one undo step (history.push): undo = retime_undo, redo = retime_apply of the same record
async function apply(body) {
  const r = await store.op('retime_apply', body);
  const id = r.retime;
  history.push({ label: `re-time ${id}`, undo: () => store.op('retime_undo', { retime: id }), redo: () => store.op('retime_apply', { retime: id }) });
  toast(`re-time ${id}: ${r.plan.rows.length} boundaries moved (a new scenes / storyboard version)`);
  return r;
}

// ------------------------------------------------------------------ import an audio events.json
export function openImport() {
  const el = dialog('Import events', 'an audio events.json [{id, t, kind, note}] (the first film\'s audio/out/final/events.json: t in seconds)',
    `<div class="evg2"><span>File</span><input type="file" name="file" accept=".json,application/json">
      <span>or paste</span><textarea name="json" spellcheck="false" placeholder='[{"id": "her_hi_there", "t": 141.86, "kind": "line", "note": "…"}]'></textarea>
      <span>Times in</span><select name="unit"><option value="auto">auto (seconds when they fit the song)</option><option value="s">seconds</option><option value="ms">milliseconds</option></select>
      <span></span><label><input type="checkbox" name="sections"> also the section starts (the sections column has them)</label></div><div class="evr dim"></div>`,
    '<span class="sp"></span><button data-x="import" class="pri">Import</button>');
  const $ = (s) => el.querySelector(s);
  let list = null;
  const preview = () => {
    try { list = JSON.parse($('[name=json]').value || 'null'); if (!list) { $('.evr').textContent = ''; return; } const r = E.importList(list, { song: store.song, unit: $('[name=unit]').value, includeSections: $('[name=sections]').checked, taken: store.events }); $('.evr').innerHTML = `${r.events.length} new events (times in ${r.unit === 's' ? 'seconds' : 'ms'}) · ${r.skipped.length} skipped (sections, already there, outside the song)`; }
    catch (e) { list = null; $('.evr').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  };
  $('[name=file]').addEventListener('change', async (x) => { const f = x.target.files?.[0]; if (f) { $('[name=json]').value = await f.text(); preview(); } });
  for (const s of ['[name=json]', '[name=unit]', '[name=sections]']) $(s).addEventListener('input', preview);
  el.addEventListener('click', async (x) => {
    if (x.target.closest('[data-x]')?.dataset.x !== 'import') return;
    preview(); if (!Array.isArray(list)) { $('.evr').innerHTML = '<span class="err">a JSON list, please</span>'; return; }
    try { const r = await act({ act: 'import', events: list, unit: $('[name=unit]').value, include_sections: $('[name=sections]').checked }); toast(`imported ${r.added} events (${r.skipped.length} skipped)`); el.remove(); }
    catch (e) { $('.evr').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
  });
  return el;
}

// ------------------------------------------------------------------ the acts
const api = {
  addAt(t, o = {}) { return eventDialog({ t: Math.max(0, Math.round(t ?? playhead())), ...o }); },
  edit(id) { if (!ev(id)) return toast(`no event ${id}`); return eventDialog({ id }); },
  accept(id) { return act({ act: 'accept', id }, `event ${id} accepted: boundaries can snap / anchor to it`); },
  dismiss(id) { return act({ act: 'dismiss', id }, `event ${id} dismissed`); },
  remove(id) { return act({ act: 'remove', id }, `event ${id} removed`); },
  measure(id, t) { return act({ act: 'measure', id, measured: t == null ? null : Math.round(t) }, t == null ? `${id}: measured time cleared` : `${id} measured at ${fmt(t, true)} · Timeline › Re-time… moves its boundaries`); },
  openRetime, openImport, plan,
};
window.WB = Object.assign(window.WB || {}, { events: api });
css();   // the stages' anchor selects and the Time view markers use it too

// ------------------------------------------------------------------ commands and menus
const evId = (c) => (typeof c.item === 'string' && c.item.startsWith('event:') ? c.item.slice(6) : c.eventId || null);
const wordAt = (c) => c.target?.closest?.('.col-lyrics span[data-t]');
commands.register([
  { id: 'events.addHere', group: 'Timeline', title: (c) => `+ Named event at ${fmt(c?.t ?? 0, true)}`, when: () => !!store.song, run: (c) => api.addAt(c.t) },
  { id: 'events.addAtWord', group: 'Timeline', hidden: true, title: (c) => `+ Named event at “${(wordAt(c)?.textContent || 'this word').slice(0, 30)}”`, when: (c) => !!wordAt(c),
    run: (c) => { const w = wordAt(c); return api.addAt(Number(w.dataset.t), { name: w.textContent.replace(/[^\p{L}\p{N}' -]/gu, '').trim(), kind: 'spoken' }); } },
  { id: 'events.edit', group: 'Timeline', hidden: true, title: 'Edit event…', when: (c) => !!evId(c), run: (c) => api.edit(evId(c)) },
  { id: 'events.measurePlayhead', group: 'Timeline', hidden: true, title: (c) => `Measured = playhead (${fmt(c?.tl?.player.time() ?? 0, true)})`, when: (c) => !!evId(c) && ev(evId(c))?.status === 'accepted', run: (c) => api.measure(evId(c), playhead()) },
  { id: 'events.measureClear', group: 'Timeline', hidden: true, title: 'Clear the measured time', when: (c) => Number.isFinite(ev(evId(c))?.measured), run: (c) => api.measure(evId(c), null) },
  { id: 'events.accept', group: 'Timeline', hidden: true, title: 'Accept the agent\'s event', when: (c) => ev(evId(c))?.status === 'proposed', run: (c) => api.accept(evId(c)) },
  { id: 'events.dismiss', group: 'Timeline', hidden: true, title: 'Dismiss', when: (c) => ev(evId(c))?.status === 'proposed', run: (c) => api.dismiss(evId(c)) },
  { id: 'events.remove', group: 'Timeline', hidden: true, title: 'Remove the event', when: (c) => !!ev(evId(c)), run: (c) => api.remove(evId(c)) },
  { id: 'events.retime', group: 'Timeline', title: () => { const n = E.pendingEvents(store.eventsDoc).length, k = (store.eventsDoc?.retimes || []).filter(r => r.status === 'proposed').length; return `Re-time after the take…${n || k ? ` (${[n ? `${n} measured` : '', k ? `${k} proposed` : ''].filter(Boolean).join(', ')})` : ''}`; }, when: () => !!store.eventsDoc, run: () => openRetime() },
  { id: 'events.import', group: 'Timeline', title: 'Import events (audio events.json)…', when: () => !!store.song, run: () => openImport() },
]);
menus.contribute('tladd', [(c) => (evId(c) ? ['events.edit', 'events.measurePlayhead', 'events.measureClear', 'events.accept', 'events.dismiss', 'events.retime', 'events.remove'] : [])]);
menus.contribute('lyric', ['events.addAtWord']);
menus.contribute('menubar:Timeline', ['-', 'events.retime', 'events.import']);

// ------------------------------------------------------------------ the Time view: a thin line per event on every stage axis
axisHooks.add((ax) => {
  for (const m of ax.sc.querySelectorAll(':scope > .tmev')) m.remove();
  if (!ax.on || !ax.visible) return;
  css();
  const W = ax.tl.warp, off = ax.off, frag = document.createDocumentFragment();
  for (const e of store.events) {
    if (e.status !== 'accepted' || e.kind === 'section') continue;
    for (const [t, ghost] of [[e.t, false], ...(Number.isFinite(e.measured) && e.measured !== e.t ? [[e.measured, true]] : [])]) {
      const m = document.createElement('div'); m.className = 'tmev' + (ghost ? ' ghost' : ''); m.dataset.ev = e.id;
      m.style.setProperty('--evc', E.KIND_COLOR[e.kind] || '#f5a524'); m.style.transform = `translateY(${off + W.y(t)}px)`;
      m.innerHTML = `<span>${E.KIND_ICON[e.kind] || ''} ${esc(e.name)}${ghost ? ' (measured)' : ''}</span>`;
      frag.appendChild(m);
    }
  }
  ax.sc.appendChild(frag);
});
store.on((w) => { if (w === 'events' || w === 'all') for (const a of WB()?.timeMode?.axes?.() || []) a.apply(); });
