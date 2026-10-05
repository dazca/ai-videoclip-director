// Named sync points (ROADMAP_v4 E1): events.json, anchors and the re-time after the take. Logic: js/events.js (shared
// with the page). events.json is the server's only (not a page save): every write goes through these ops.
//   events_get      read only: the events (kind, status, measured, the boundaries anchored to each), the pending re-time
//                   (events measured elsewhere than where their boundaries sit) as a plan, the re-time records
//   event_add       an agent's event: always "proposed" (the director accepts it in the page); never a snap target before
//   retime_propose  an agent's re-time: moves [{event, to}] (or from_measured) -> a "proposed" record with its plan; nothing moves
//   events_act      PAGE ONLY: add / update / measure / remove / accept / dismiss / import (from an audio events.json), dismiss a
//                   proposed re-time
//   retime_apply    PAGE ONLY: the re-time as ONE change (refused on a project locked for render, and until the page confirms each
//                   held item: an approved / locked shot or ok scene, a shared cut, a picked take that gets too short; a moved
//                   approved item goes back to review with a note; review #3 M2 / L1): a new scenes.json version and a new storyboard.json version with every
//                   anchored boundary (and the cuts that share it) at the event's new time; the events move (measured cleared)
//   retime_undo     PAGE ONLY: the same in reverse (new versions again); the events go back and are pending again
import path from 'node:path';
import * as E from '../../js/events.js';
import * as SC from '../../js/scenes.js';
import * as SB from '../../js/storyboard.js';
import { WbError, agentBy, fail, ms, mutate, nowIso, ops, projDir, read, readJSON, tc, withFileLock, write } from './_shared.mjs';
import { lockedOf } from './final.mjs';
import { addNote } from './notes.mjs';
import { scenesDoc } from './scenes.mjs';
import { boardDoc } from './storyboard.mjs';

const FILE = 'events.json';
export function eventsDoc(p) { return E.normEvents(readJSON(path.join(projDir(p), FILE), null, true)); }
function mutateEvents(p, fn) {
  return withFileLock(path.join(projDir(p), FILE), () => {
    const d = eventsDoc(p); delete d.legacy;
    const r = fn(d);
    d.events.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
    d.rev = (d.rev || 0) + 1; write(p, FILE, d); return r === undefined ? d : r;
  });
}
const pageOnly = (via, what) => { if (via !== 'page') fail(403, `${what} is the director's, in the page (the timeline's events column / Timeline › Re-time…): an agent proposes (event_add, retime_propose)`); };
// (approvals and the scene states feed the plan's `held` list: review #3 M2)
const ctx = (p) => { const sd = scenesDoc(p); return { song: read(p, 'song.json'), scenes: SC.currentScript(sd)?.scenes || [], shots: SB.boardShots(boardDoc(p)), approvals: read(p, 'approvals.json'), states: sd.states || {} }; };
const time = (v, name, song) => { const t = ms(v, name); if (t == null || !(t >= 0) || (song?.duration_ms && t > song.duration_ms)) fail(400, `${name}: a time inside the song (0–${tc(song?.duration_ms || 0)}), ms or m:ss.mmm`); return t; };
const kindOf = (k) => { if (k == null || k === '') return 'custom'; if (!E.KINDS.includes(k)) fail(400, `kind: one of ${E.KINDS.join(', ')}`); return k; };
const nameOf = (v) => { const s = String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim(); if (!s) fail(400, 'name: a short name ("her hi there", "stop 2")'); return s.slice(0, 120); };
const noteOf = (v) => String(v ?? '').slice(0, 2000);
const needEvent = (d, id) => { const e = d.events.find(x => x.id === id); if (!e) fail(404, `no event "${String(id).slice(0, 64)}" (events_get)`); return e; };
const view = (e, c) => ({ ...e, time: tc(e.t), ...(Number.isFinite(e.measured) ? { measured_time: tc(e.measured) } : {}), anchored: E.anchoredTo(e.id, c) });
const planView = (plan) => ({ moves: plan.moves.map(m => ({ ...m, from_time: tc(m.from), to_time: tc(m.to) })), rows: plan.rows, lines: E.planLines(plan), problems: plan.problems, beats_moved: plan.beats, held: plan.held || [] });
function movesOf(d, { moves, from_measured } = {}, song) {
  if (from_measured) return E.pendingEvents(d).map(e => ({ event: e.id, to: e.measured }));
  if (!Array.isArray(moves) || !moves.length || moves.length > 200) fail(400, 'moves: [{event, to}] (to = where the event really is: ms or m:ss.mmm), or from_measured: true');
  return moves.map((m, i) => { if (!m || typeof m !== 'object' || !E.EVENT_ID.test(String(m.event ?? ''))) fail(400, `moves[${i}]: {event: <event id>, to}`); const ev = needEvent(d, m.event); if (ev.status !== 'accepted') fail(409, `${ev.id} is ${ev.status}: only accepted events are re-timed (the director accepts it first)`); return { event: ev.id, to: time(m.to, `moves[${i}].to`, song) }; });
}

// write the plan: a new scenes version and a new storyboard version (each only when something in it moves), both built and
// checked before either is written (under both files' locks); returns the versions [from, to]
function writePlan(p, plan, message) {
  const out = { scenes: null, storyboard: null }, song = read(p, 'song.json'), pd = projDir(p);
  return withFileLock(path.join(pd, 'scenes.json'), () => withFileLock(path.join(pd, 'storyboard.json'), () => {
    let sd = null, bd = null;
    try {
      if (plan.changed.scenes) {
        sd = scenesDoc(p); const from = sd.current;
        const body = plan.scenes.map(s => SC.cleanScene(s, song)).sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
        const v = SC.addScriptVersion(sd, body, { by: 'director', via: 'page', message, ...(from ? { from } : {}) }); delete sd.derived;
        SC.checkScenes(sd); out.scenes = [from, v.id];
      }
      if (plan.changed.shots) {
        bd = boardDoc(p); const from = bd.current;
        // the picks (shot.clip) ride along unchanged: the shots come from the current version
        const v = SB.addBoardVersion(bd, [...plan.shots].sort(SB.byTime), { by: 'director', via: 'page', message, ...(from ? { from } : {}), script: out.scenes?.[1] || scenesDoc(p).current || undefined }); delete bd.derived;
        SB.checkBoard(bd); out.storyboard = [from, v.id];
      }
    } catch (e) { fail(409, `re-time: ${e.message}`); }
    if (sd) { sd.rev = (sd.rev || 0) + 1; write(p, 'scenes.json', sd); }
    if (bd) { bd.rev = (bd.rev || 0) + 1; write(p, 'storyboard.json', bd); }
    return out;
  }));
}

// review #3 L1: a project locked for render moves no cut, not even the director's: they unlock first (Final stage)
function notLocked(p, what) { const L = lockedOf(p); if (L) fail(409, `the project is locked for render (${L.revision || 'locked'}): ${what} would change the locked cut. Unlock it first (Final stage › Unlock), then re-time`); }
// review #3 M2: every held item (approved / locked, a shared cut, a take too short: js/events.js heldOf) needs the director's
// explicit confirm (confirm: ["shot:s1-intro", ...], the dialog's ticks); one missing = 409 + the list, nothing written
function confirmGate(plan, confirm) {
  const ok = new Set(Array.isArray(confirm) ? confirm.map(String) : []), miss = (plan.held || []).filter(h => !ok.has(h.key));
  if (miss.length) throw Object.assign(new WbError(409, `confirm first: ${miss.map(h => `${h.key} (${h.reasons.map(r => E.HELD_LABEL[r] || r).join(', ')})`).join('; ')}: tick each one in the re-time preview`), { held: miss });
}
// after the write: a moved approved / locked shot goes back to review (approvals.json), a moved ok scene to needs you, each
// with a note on it saying why; returns what was sent back
function demote(p, plan, rid) {
  const back = (plan.held || []).filter(h => h.reasons.some(r => E.HELD_STATES.includes(r)));
  if (!back.length) return [];
  const at = nowIso(), why = (h) => `re-time ${rid} moved this ${h.kind} (${h.detail.filter(d => !/^shares|take covers/.test(d)).join('; ') || 'its cut'}): its approval was for the old timing, so it is back to ${h.kind === 'shot' ? 'review' : 'needs you'}. Approve it again once you have checked it.`;
  const shots = back.filter(h => h.kind === 'shot'), scenes = back.filter(h => h.kind === 'scene');
  if (shots.length) mutate(p, 'approvals.json', (d) => { d.items ||= {}; for (const h of shots) { const k = 'shot:' + h.id, was = d.items[k]?.state; d.items[k] = { ...(d.items[k] || {}), state: 'review', via: 'page', by: 'director', at, comment: `was ${was}: ${why(h)}`.slice(0, 600) }; } });
  if (scenes.length) mutate(p, 'scenes.json', (d) => { d.states ||= {}; for (const h of scenes) d.states[h.id] = { status: 'needs_you', by: 'director', via: 'page', at, why: `re-time ${rid}` }; });
  for (const h of back) { try { addNote(p, { target: h.kind === 'shot' ? { stage: 'storyboard', kind: 'shot', id: h.id } : { stage: 'script', kind: 'scene', id: h.id }, text: why(h), by: 'director', via: 'page' }); } catch (e) { /* the note is a courtesy: the state change above is what counts */ } }
  return back.map(h => h.key);
}

Object.assign(ops, {
  events_get(p, { kind, status, t0, t1, id } = {}) {
    const d = eventsDoc(p), c = ctx(p);
    const a = t0 != null ? ms(t0, 't0') : null, b = t1 != null ? ms(t1, 't1') : null;
    const list = d.events.filter(e => (!id || e.id === id) && (!kind || e.kind === kind) && (status ? e.status === status : e.status !== 'dismissed') && (a == null || e.t >= a) && (b == null || e.t <= b));
    const pend = E.pendingEvents(d);
    const plan = pend.length ? E.retimePlan({ moves: pend.map(e => ({ event: e.id, to: e.measured })), events: d.events, ...c }) : null;
    return {
      events: list.map(e => view(e, c)),
      counts: Object.fromEntries(E.STATUSES.map(s => [s, d.events.filter(e => e.status === s).length])),
      pending: plan ? planView(plan) : null,
      retimes: d.retimes.slice(-20).reverse(),
      kinds: E.KINDS,
      rules: 'Named events are the song\'s sync points (stops, spoken lines, voice changes, cues). Scene and shot boundaries anchor to them (scenes_update / shots_update anchors {t0?, t1?} or snap "events"). '
        + 'measured = where the event really landed in the chosen take; the director re-times (moves the anchored boundaries) in the page. You add events with event_add (proposed until the director accepts) and propose re-times with retime_propose; applying a re-time and accepting events are the director\'s.',
    };
  },
  // an agent's event (proposed; the page uses events_act add)
  event_add(p, { id, name, t, kind, note, measured, why, by = 'agent' } = {}) {
    const song = read(p, 'song.json');
    const ev = { name: nameOf(name), t: time(t, 't', song), kind: kindOf(kind), note: noteOf(note || why), status: 'proposed', by: agentBy(by), via: 'agent', at: nowIso() };   // L3
    if (measured != null) ev.measured = time(measured, 'measured', song);
    if (id != null && !E.EVENT_ID.test(String(id))) fail(400, 'id: letters, digits, _ . - (up to 64; e.g. her_hi_there)');
    return mutateEvents(p, (d) => {
      if (d.events.length >= 2000) fail(409, 'events.json holds 2000 events already (the most an agent may add): ask the director');   // review #3 I5
      const evId = id != null ? String(id) : E.slugId(ev.name, d.events);
      if (d.events.some(e => e.id === evId)) fail(409, `event "${evId}" exists (events_get): pick another id`);
      const e = E.normEvent({ id: evId, ...ev }); d.events.push(e);
      return { event: e, changed: `events.json: proposed ${e.id} at ${tc(e.t)}`, note: 'proposed: the director accepts it in the page (timeline › events); only then can boundaries snap / anchor to it' };
    });
  },
  // an agent's re-time proposal: the moves and what they would move; nothing moves until the director applies it
  retime_propose(p, { moves, from_measured, why, by = 'agent' } = {}) {
    const c = ctx(p);
    return mutateEvents(p, (d) => {
      const mv = movesOf(d, { moves, from_measured }, c.song);
      if (!mv.length) fail(400, 'nothing to re-time: no event is measured elsewhere than its time (give moves [{event, to}])');
      const plan = E.retimePlan({ moves: mv, events: d.events, ...c });
      if (plan.problems.length) fail(400, `this re-time cannot be applied: ${plan.problems.join('; ')}`);
      if (!plan.moves.length) fail(400, 'every event is already at that time');
      const rec = { id: E.nextRetimeId(d), status: 'proposed', moves: plan.moves.map(({ event, from, to }) => ({ event, from, to })), why: String(why || '').slice(0, 2000), by: agentBy(by), via: 'agent', at: nowIso(), rows: plan.rows, held: plan.held };   // L3
      d.retimes.push(rec);
      return { retime: rec.id, plan: planView(plan), changed: `events.json: re-time ${rec.id} proposed (${plan.rows.length} boundaries)`, note: 'the director applies it in the page (Timeline › Re-time…); nothing has moved' };
    });
  },
  // PAGE ONLY: the director's acts on the events
  events_act(p, { act, id, name, t, kind, note, measured, events, unit, include_sections, retime, via } = {}) {
    pageOnly(via, 'changing the named events');
    const c = ctx(p), song = c.song;
    if (!['add', 'update', 'measure', 'remove', 'accept', 'dismiss', 'import', 'retime_dismiss'].includes(act)) fail(400, 'act: add | update | measure | remove | accept | dismiss | import | retime_dismiss');
    return mutateEvents(p, (d) => {
      const W = { by: 'director', via: 'page', at: nowIso() };
      if (act === 'add') {
        if (id != null && !E.EVENT_ID.test(String(id))) fail(400, 'id: letters, digits, _ . - (up to 64)');
        const nm = nameOf(name), evId = id != null ? String(id) : E.slugId(nm, d.events);
        if (d.events.some(e => e.id === evId)) fail(409, `event "${evId}" exists`);
        const e = E.normEvent({ id: evId, name: nm, t: time(t, 't', song), kind: kindOf(kind), note: noteOf(note), status: 'accepted', ...W, ...(measured != null ? { measured: time(measured, 'measured', song) } : {}) });
        d.events.push(e); return { event: e };
      }
      if (act === 'import') {
        let r; try { r = E.importList(events, { song, unit: ['s', 'ms', 'auto'].includes(unit) ? unit : 'auto', includeSections: !!include_sections, taken: d.events }); } catch (e) { fail(400, e.message); }
        if (r.events.length > 2000) fail(400, 'at most 2000 events at once');
        for (const x of r.events) d.events.push(E.normEvent({ ...x, status: 'accepted', ...W, source: 'import' }));
        return { added: r.events.length, skipped: r.skipped, unit: r.unit, ids: r.events.map(x => x.id) };
      }
      if (act === 'retime_dismiss') {
        const x = d.retimes.find(y => y.id === retime); if (!x) fail(404, `no re-time "${String(retime).slice(0, 12)}"`);
        if (x.status !== 'proposed') fail(409, `${x.id} is ${x.status}`);
        x.status = 'dismissed'; x.decided_at = W.at; return { retime: x };
      }
      const e = needEvent(d, id), anchored = E.anchoredTo(e.id, c);
      if (act === 'measure') { if (measured == null || measured === '') delete e.measured; else e.measured = time(measured, 'measured', song); e.measured_at = W.at; return { event: e, anchored }; }
      if (act === 'accept') { if (e.status === 'accepted') return { event: e, unchanged: true }; e.status = 'accepted'; e.accepted_by = 'director'; e.accepted_at = W.at; return { event: e }; }
      if (act === 'dismiss') { if (anchored.length) fail(409, `${anchored.length} boundaries are anchored to ${e.id}: unanchor them first`); e.status = 'dismissed'; e.dismissed_at = W.at; return { event: e }; }
      if (act === 'remove') { if (anchored.length) fail(409, `${anchored.length} boundaries are anchored to ${e.id} (${anchored.map(x => `${x.kind} ${x.id}.${x.edge}`).slice(0, 4).join(', ')}): unanchor them first`); d.events.splice(d.events.indexOf(e), 1); return { removed: e.id }; }
      // update: name / kind / note; a new t only while nothing is anchored to it (else measure it and re-time)
      if (name != null) e.name = nameOf(name);
      if (kind != null) e.kind = kindOf(kind);
      if (note != null) e.note = noteOf(note);
      if (t != null) { const nt = time(t, 't', song); if (nt !== e.t && anchored.length) fail(409, `${anchored.length} boundaries are anchored to ${e.id}: set its measured time and re-time instead`); e.t = nt; }
      e.edited_at = W.at;
      return { event: e };
    });
  },
  // PAGE ONLY: the re-time as one change (a new scenes and storyboard version); moves [{event, to}], from_measured, or a
  // record: a proposed re-time (the agent's) or an undone one (redo)
  retime_apply(p, { moves, from_measured, retime, confirm, via } = {}) {
    pageOnly(via, 'applying a re-time');
    notLocked(p, 'a re-time');
    const c = ctx(p);
    return mutateEvents(p, (d) => {
      let rec = null, mv;
      if (retime != null) {
        rec = d.retimes.find(x => x.id === retime); if (!rec) fail(404, `no re-time "${String(retime).slice(0, 12)}"`);
        if (!['proposed', 'undone'].includes(rec.status)) fail(409, `${rec.id} is ${rec.status}`);
        if (rec.status === 'undone') for (const m of rec.moves) if (needEvent(d, m.event).t !== m.from) fail(409, `${m.event} moved since ${rec.id} was undone`);
        mv = rec.moves.map(m => ({ event: m.event, to: m.to }));
      } else mv = movesOf(d, { moves, from_measured }, c.song);
      const plan = E.retimePlan({ moves: mv, events: d.events, ...c });
      if (plan.problems.length) fail(409, `not applied: ${plan.problems.join('; ')}`);
      if (!plan.moves.length) fail(400, 'nothing to re-time: every event is already at that time');
      confirmGate(plan, confirm);
      const at = nowIso(), versions = writePlan(p, plan, E.planMessage(plan));
      if (!rec) { rec = { id: E.nextRetimeId(d), status: 'applied', moves: [], why: '', by: 'director', via: 'page', at }; d.retimes.push(rec); }
      const back = demote(p, plan, rec.id);
      Object.assign(rec, { status: 'applied', moves: plan.moves.map(({ event, from, to }) => ({ event, from, to })), applied_at: at, applied_by: 'director', versions, rows: plan.rows, confirmed: (plan.held || []).map(h => h.key), back_to_review: back });
      for (const m of plan.moves) { const e = needEvent(d, m.event); e.t = m.to; delete e.measured; (e.retimed ||= []).push({ from: m.from, to: m.to, at, retime: rec.id }); if (e.retimed.length > 20) e.retimed.shift(); }
      return { retime: rec.id, versions, plan: planView(plan), back_to_review: back };
    });
  },
  // PAGE ONLY: undo an applied re-time: the boundaries back (new versions), the events back to where they were, pending again
  retime_undo(p, { retime, confirm, via } = {}) {
    pageOnly(via, 'undoing a re-time');
    notLocked(p, 'undoing a re-time');
    const c = ctx(p);
    return mutateEvents(p, (d) => {
      const rec = d.retimes.find(x => x.id === retime); if (!rec) fail(404, `no re-time "${String(retime).slice(0, 12)}"`);
      if (rec.status !== 'applied') fail(409, `${rec.id} is ${rec.status}: only an applied re-time is undone`);
      for (const m of rec.moves) if (needEvent(d, m.event).t !== m.to) fail(409, `${m.event} moved since ${rec.id}: undo the later re-time first`);
      const plan = E.retimePlan({ moves: rec.moves.map(m => ({ event: m.event, to: m.from })), events: d.events, ...c });
      if (plan.problems.length) fail(409, `not undone: ${plan.problems.join('; ')}`);
      confirmGate(plan, confirm);
      const at = nowIso(), versions = writePlan(p, plan, `undo ${rec.id}: ${E.planMessage(plan)}`), back = demote(p, plan, `undo of ${rec.id}`);
      for (const m of rec.moves) { const e = needEvent(d, m.event); e.t = m.from; e.measured = m.to; (e.retimed ||= []).push({ from: m.to, to: m.from, at, retime: rec.id }); }
      Object.assign(rec, { status: 'undone', undone_at: at, undo_versions: versions });
      return { retime: rec.id, versions, plan: planView(plan), back_to_review: back };
    });
  },
});
