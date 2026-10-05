// Named sync points (ROADMAP_v4 E1): events.json, snapping to events, anchors and the re-time after the take. Pure
// functions, no DOM and no Node APIs: the page (js/eventscol.js, core/events.js, the script and storyboard stages) and the
// data layer (lib/ops/events.mjs) import the same code.
//
// events.json  {v: 2, rev, events: [Event], retimes: [Retime]}   (the server's only: written by the ops; the page acts
//              through the page-only events_act / retime_apply / retime_undo, an agent through event_add / retime_propose)
//   Event   {id "her_hi_there", name, t, kind: stop | spoken | voice | cue | custom | section, note, status: accepted |
//            proposed | dismissed, measured?: t, by, via, at, source_kind?, source?, retimed?: [{from, to, at, retime}]}
//           t = where the boundaries anchored to it sit now (integer ms of the song); measured = where it actually landed
//           in the chosen take (set by dragging it, typing it or "set to playhead"): a pending re-time while it differs.
//           An agent's event is "proposed" until the director accepts it; only accepted events are snap targets.
//           kind "section" = a section start written by an importer (not a snap target: the sections are their own).
//   Retime  {id "rt03", status: proposed | applied | undone | dismissed, moves: [{event, from, to}], why, by, via, at,
//            applied_at?, versions?: {scenes: [from, to] | null, storyboard: [from, to] | null}, rows?: [Row]}
//           a proposal (an agent's retime_propose) or a record of what the director applied (retime_apply), undone
//           (retime_undo: the boundaries back, the events pending again).
// A scene or a storyboard shot may carry anchors {t0?: event id, t1?: event id}: that boundary follows the event. A
// re-time moves every anchored boundary to the event's new time, and every boundary that sits exactly on a moving
// anchored one (a shared cut: the next scene's start, a scene's first / last shot) with it.
// The legacy events.json (an importer's array [{id, t, kind, note}], times in ms) reads as v2 with every event accepted.
export const KINDS = ['stop', 'spoken', 'voice', 'cue', 'custom'];
export const ALL_KINDS = [...KINDS, 'section'];
export const KIND_LABEL = { stop: 'stop', spoken: 'spoken', voice: 'voice', cue: 'cue', custom: 'custom', section: 'section' };
export const KIND_ICON = { stop: '■', spoken: '“', voice: '♪', cue: '▼', custom: '◆', section: '§' };
export const KIND_COLOR = { stop: '#f08080', spoken: '#9db7d6', voice: '#c3b2e8', cue: '#f5a524', custom: '#93c2a2', section: '#888' };
export const STATUSES = ['accepted', 'proposed', 'dismissed'];
export const EVENT_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const RETIME_ID = /^rt\d{1,4}$/;
// the kinds of an audio events.json (the first film's audio/out/final/events.json) and of the importers -> ours
const FROM_KIND = { stop: 'stop', silence: 'stop', spoken: 'spoken', voice: 'voice', male: 'voice', female: 'voice', line: 'voice', word: 'voice',
  cue: 'cue', drop: 'cue', beat: 'cue', count: 'cue', end: 'cue', custom: 'custom', section: 'section' };
export const mapKind = (k) => FROM_KIND[String(k || '').toLowerCase()] || 'custom';
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const str = (v, n) => String(v ?? '').slice(0, n);
const clock = (ms) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };
export const tc = clock;

// ------------------------------------------------------------------ documents
export function emptyEvents() { return { v: 2, rev: 0, events: [], retimes: [] }; }
// one event of any origin -> the stored shape (null when it has no usable id or time)
export function normEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const id = String(e.id ?? ''), t = int(e.t);
  if (!EVENT_ID.test(id) || !(t >= 0)) return null;
  const kind = ALL_KINDS.includes(e.kind) ? e.kind : mapKind(e.kind);
  const out = { id, name: str(e.name || id, 120), t, kind, note: str(e.note, 2000), status: STATUSES.includes(e.status) ? e.status : 'accepted' };
  const m = int(e.measured); if (e.measured != null && m >= 0) out.measured = m;
  if (!ALL_KINDS.includes(e.kind) && e.kind != null) out.source_kind = str(e.kind, 24);
  else if (e.source_kind) out.source_kind = str(e.source_kind, 24);
  for (const k of ['by', 'via', 'at', 'source', 'accepted_at', 'accepted_by', 'measured_at', 'dismissed_at', 'edited_at']) if (typeof e[k] === 'string') out[k] = e[k].slice(0, 200);
  if (Array.isArray(e.retimed)) out.retimed = e.retimed.filter(r => r && Number.isFinite(r.from) && Number.isFinite(r.to)).slice(-20).map(r => ({ from: int(r.from), to: int(r.to), at: str(r.at, 40), ...(r.retime ? { retime: str(r.retime, 12) } : {}) }));
  return out;
}
// any events.json (an importer's array, a v2 doc, nothing) -> a v2 doc; events sorted by time, ids unique
export function normEvents(doc) {
  const legacy = Array.isArray(doc);
  const d = legacy ? { ...emptyEvents(), events: doc, legacy: true } : doc && typeof doc === 'object' ? { ...emptyEvents(), ...doc } : emptyEvents();
  const seen = new Set();
  d.events = (Array.isArray(d.events) ? d.events : []).map(normEvent).filter(e => e && !seen.has(e.id) && seen.add(e.id)).sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  d.retimes = (Array.isArray(d.retimes) ? d.retimes : []).filter(r => r && RETIME_ID.test(String(r.id)) && Array.isArray(r.moves));
  d.v = 2;
  return d;
}
export const eventsList = (doc) => normEvents(doc).events;
export const eventById = (doc, id) => (Array.isArray(doc) ? doc : doc?.events || []).find(e => e.id === id) || null;
// the events a boundary can snap / anchor to: accepted, not a section start
export const snapEvents = (doc) => (Array.isArray(doc) ? doc : doc?.events || []).filter(e => (e.status || 'accepted') === 'accepted' && e.kind !== 'section');
// events whose measured time differs from where their boundaries sit: a re-time is pending
export const pendingEvents = (doc) => (doc?.events || []).filter(e => e.status === 'accepted' && Number.isFinite(e.measured) && e.measured !== e.t);
// a new event id from its name: "Her: hi there" -> her_hi_there (-2, -3 … when taken)
export function slugId(name, taken = []) {
  const set = new Set(taken.map(x => (typeof x === 'string' ? x : x.id)));
  const base = String(name || 'event').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'event';
  let id = /^[a-z0-9_]/.test(base) ? base : 'ev_' + base;
  for (let n = 2; set.has(id); n++) id = `${base}-${n}`;
  return id;
}
export const nextRetimeId = (doc) => `rt${String((doc?.retimes || []).reduce((m, r) => Math.max(m, Number(String(r.id).slice(2)) || 0), 0) + 1).padStart(2, '0')}`;

// ------------------------------------------------------------------ snapping and anchors
// the nearest snap event to t (null when there is none within maxMs)
export function nearestEvent(t, events, maxMs = Infinity) {
  let best = null, d = Infinity;
  for (const e of snapEvents(events)) { const x = Math.abs(e.t - t); if (x < d) { d = x; best = e; } }
  return d <= maxMs ? best : null;
}
// snap t to the nearest named event within maxMs (0 and the end of the song count too): {t, event: id | null}. Farther than
// that, t stays (rounded): an edge far from every event is not dragged onto one (unlike the beat grid, events are sparse)
export const SNAP_EVENT_MS = 1000;
export function snapToEvent(t, song, events, maxMs = SNAP_EVENT_MS) {
  let best = Math.round(t), d = maxMs, ev = null;
  for (const x of [0, song?.duration_ms || 0]) { const e = Math.abs(x - t); if (e <= d) { d = e; best = x; ev = null; } }
  for (const e of snapEvents(events)) { const x = Math.abs(e.t - t); if (x <= d) { d = x; best = e.t; ev = e.id; } }
  return { t: best, event: ev };
}
// a scene's / shot's anchors, cleaned: {t0?, t1?} with event ids, or null
export function anchorsOf(x) {
  const a = x?.anchors; if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const out = {}; for (const k of ['t0', 't1']) if (typeof a[k] === 'string' && EVENT_ID.test(a[k])) out[k] = a[k];
  return Object.keys(out).length ? out : null;
}
export function checkAnchors(a, where) {
  if (a == null) return;
  if (typeof a !== 'object' || Array.isArray(a)) throw new Error(`${where}: anchors must be {t0?: event id, t1?: event id}`);
  for (const [k, v] of Object.entries(a)) if (!['t0', 't1'].includes(k) || typeof v !== 'string' || !EVENT_ID.test(v)) throw new Error(`${where}: anchors.${String(k).slice(0, 8)} must name an event id`);
}
// keep a draft item's anchors true after its time changed: with snap "events" an edge that lands on an event is anchored
// to it; an anchored edge that no longer sits on its event loses the anchor. Mutates x; returns x.anchors (or null).
export function reanchor(x, events, { snap } = {}) {
  const a = { ...(anchorsOf(x) || {}) }, list = Array.isArray(events) ? events : events?.events || [];
  for (const k of ['t0', 't1']) {
    const ev = a[k] && list.find(e => e.id === a[k]);
    if (a[k] && (!ev || ev.t !== x[k])) delete a[k];
    if (!a[k] && snap === 'events') { const e = snapEvents(list).find(y => y.t === x[k]); if (e) a[k] = e.id; }
  }
  if (Object.keys(a).length) x.anchors = a; else delete x.anchors;
  return x.anchors || null;
}
// an item written by an agent or a page save, with the events known: an anchored edge takes its event's time (the anchor
// wins over the time given); an anchor to an unknown event is dropped (warning); snap "events" anchors the edges it snaps
// onto an event. Mutates x (t0 / t1 / anchors); returns the warnings.
export function settleAnchors(x, events, { snap, song, what = 'item' } = {}) {
  const list = Array.isArray(events) ? events : events?.events || [], warnings = [];
  const a = { ...(anchorsOf(x) || {}) };
  for (const k of ['t0', 't1']) {
    if (a[k]) {
      const ev = list.find(e => e.id === a[k] && (e.status || 'accepted') === 'accepted');
      if (!ev) { warnings.push(`${what}: anchor ${k} → "${a[k]}" is not an accepted named event: dropped`); delete a[k]; continue; }
      if (ev.t !== x[k]) { warnings.push(`${what}: ${k} ${clock(x[k])} → ${clock(ev.t)} (anchored to ${ev.id})`); x[k] = ev.t; }
    } else if (snap === 'events') {
      const s = snapToEvent(x[k], song, list); x[k] = s.t; if (s.event) a[k] = s.event;
    }
  }
  if (Object.keys(a).length) x.anchors = a; else delete x.anchors;
  return warnings;
}
// every boundary anchored to an event: [{kind: scene | shot, id, edge, t}]
export function anchoredTo(eventId, { scenes = [], shots = [] } = {}) {
  const out = [];
  for (const [kind, list] of [['scene', scenes], ['shot', shots]]) for (const x of list) for (const k of ['t0', 't1']) if (x.anchors?.[k] === eventId) out.push({ kind, id: x.id, edge: k, t: x[k] });
  return out;
}

// ------------------------------------------------------------------ the re-time
// moves [{event, to}] (from = the event's t now) -> what moves where. rows [{kind: scene | shot, id, edge, from, to, event,
// why: anchored | shared}], the moved scenes and shots (copies), problems (a boundary would cross another: nothing is
// written while there are problems), and beats moved back inside their scene.
// approvals (approvals.json) and states (scenes.json states) feed `held` (review #3 M2, heldOf below).
export function retimePlan({ moves = [], events = [], scenes = [], shots = [], song, approvals = null, states = null } = {}) {
  const list = Array.isArray(events) ? events : events?.events || [], problems = [];
  const M = new Map();
  for (const m of moves) {
    const ev = list.find(e => e.id === m?.event), to = int(m?.to);
    if (!ev) { problems.push(`no event "${String(m?.event).slice(0, 64)}"`); continue; }
    if (!(to >= 0) || (song?.duration_ms && to > song.duration_ms)) { problems.push(`${ev.id}: ${m?.to} is outside the song`); continue; }
    if (to !== ev.t) M.set(ev.id, { event: ev.id, name: ev.name, from: ev.t, to });
  }
  const sc = structuredClone(scenes), sh = structuredClone(shots), rows = [], seen = new Set(), at = [];
  const items = [...sc.map(x => ['scene', x]), ...sh.map(x => ['shot', x])];
  for (const [kind, x] of items) for (const edge of ['t0', 't1']) {
    const m = M.get(x.anchors?.[edge]); if (!m) continue;
    rows.push({ kind, id: x.id, edge, from: x[edge], to: m.to, event: m.event, why: 'anchored' }); seen.add(`${kind}:${x.id}:${edge}`); at.push({ t: x[edge], m });
  }
  for (const [kind, x] of items) for (const edge of ['t0', 't1']) {
    const key = `${kind}:${x.id}:${edge}`; if (seen.has(key) || x.anchors?.[edge]) continue;
    const s = at.find(z => Math.abs(z.t - x[edge]) <= 1);
    if (s) { rows.push({ kind, id: x.id, edge, from: x[edge], to: s.m.to, event: s.m.event, why: 'shared' }); seen.add(key); }
  }
  for (const r of rows) (r.kind === 'scene' ? sc : sh).find(y => y.id === r.id)[r.edge] = r.to;
  let beats = 0;
  for (const s of sc) for (const b of s.beats || []) { const t = Math.max(s.t0, Math.min(s.t1, b.t)); if (t !== b.t) { b.t = t; beats++; } }
  const dur = song?.duration_ms || Infinity;
  for (const [kind, x] of items) if (rows.some(r => r.kind === kind && r.id === x.id) && !(x.t0 >= 0 && x.t1 > x.t0 && x.t1 <= dur)) problems.push(`${kind} ${x.id} would be ${clock(x.t0)}–${clock(x.t1)}: no length left`);
  // the shots of a moved scene must stay inside it
  for (const s of sh) { const c = s.scene && sc.find(y => y.id === s.scene); if (c && rows.some(r => (r.kind === 'scene' && r.id === c.id) || (r.kind === 'shot' && r.id === s.id)) && (s.t0 < c.t0 - 1 || s.t1 > c.t1 + 1)) problems.push(`shot ${s.id} would leave its scene ${c.id}`); }
  rows.sort((a, b) => a.from - b.from || (a.kind === b.kind ? 0 : a.kind === 'scene' ? -1 : 1) || a.id.localeCompare(b.id));
  const held = heldOf(rows, { scenes, shots: sh, approvals, states });
  return { moves: [...M.values()], rows, scenes: sc, shots: sh, problems, beats, held, changed: { scenes: rows.some(r => r.kind === 'scene') || beats > 0, shots: rows.some(r => r.kind === 'shot') } };
}
// review #3 M2: what a re-time must NOT move silently. Per item (key "shot:<id>" / "scene:<id>") the reasons:
//   approved / locked   a shot approved or locked in approvals.json (a scene marked ok in scenes.json): its approval was for
//                       the old timing; applying sends it back to review (a scene: needs you) with a note
//   shared              an unanchored cut that moves only because it sits on an anchored one (a neighbour)
//   take                the picked take (shot.clip) no longer covers the shot's new length
// The page lists them in red and the director confirms each one; retime_apply refuses (409) a plan with an unconfirmed one.
export const HELD_STATES = ['approved', 'locked'];
export function heldOf(rows, { scenes = [], shots = [], approvals, states } = {}) {
  const by = new Map();
  const add = (kind, id, why, detail) => { const k = `${kind}:${id}`; if (!by.has(k)) by.set(k, { key: k, kind, id, reasons: [], detail: [] }); const h = by.get(k); if (!h.reasons.includes(why)) { h.reasons.push(why); if (detail) h.detail.push(detail); } };
  for (const r of rows) {
    const st = r.kind === 'shot' ? approvals?.items?.['shot:' + r.id]?.state : states?.[r.id]?.status === 'ok' ? 'approved' : null;
    if (HELD_STATES.includes(st)) add(r.kind, r.id, st, `${r.kind === 'scene' ? 'marked ok' : st}: its ${r.edge === 't0' ? 'start' : 'end'} ${clock(r.from)} → ${clock(r.to)}`);
    if (r.why === 'shared') add(r.kind, r.id, 'shared', `shares the cut of ${r.event} (not anchored)`);
  }
  for (const s of shots) {
    const c = s.clip; if (!c || c.kind !== 'video' || !Number.isFinite(c.in_ms) || !Number.isFinite(c.out_ms) || !rows.some(r => r.kind === 'shot' && r.id === s.id)) continue;
    if (c.out_ms - c.in_ms < s.t1 - s.t0) add('shot', s.id, 'take', `the picked take covers ${((c.out_ms - c.in_ms) / 1000).toFixed(2)} s of the new ${((s.t1 - s.t0) / 1000).toFixed(2)} s`);
  }
  return [...by.values()];
}
export const HELD_LABEL = { approved: 'approved', locked: 'locked', shared: 'shares the cut', take: 'take too short' };
// a plan as short text lines (the dialog, the tool's answer, a version message)
export const planLines = (plan) => plan.rows.map(r => `${r.kind} ${r.id}.${r.edge} ${clock(r.from)} → ${clock(r.to)} (${r.why === 'anchored' ? 'anchored to' : 'shares the cut of'} ${r.event})`);
export const planMessage = (plan) => `re-time: ${plan.moves.map(m => `${m.event} ${clock(m.from)} → ${clock(m.to)}`).join(', ')}`.slice(0, 300);

// ------------------------------------------------------------------ import from an audio events.json
// a list [{id, t, kind, note}] (the first film's audio/out/final/events.json: t in SECONDS) -> events to add. unit "s" |
// "ms" | "auto" (seconds when every t is below the song's length in seconds + 1 and some t has a fraction or the largest is
// under 1000); sections skipped unless includeSections; ids kept (made unique against `taken`).
export function importList(list, { song, unit = 'auto', includeSections = false, taken = [] } = {}) {
  if (!Array.isArray(list)) throw new Error('events: a JSON list [{id, t, kind, note}] expected');
  const ts = list.map(e => Number(e?.t)).filter(Number.isFinite);
  const durS = (song?.duration_ms || 0) / 1000;
  const sec = unit === 's' || (unit === 'auto' && ts.length > 0 && ts.every(t => t <= durS + 1) && (ts.some(t => !Number.isInteger(t)) || Math.max(...ts) < 1000));
  const ids = new Set(taken.map(x => (typeof x === 'string' ? x : x.id))), out = [], skipped = [];
  for (const e of list) {
    const t = Number(e?.t); if (!e || !Number.isFinite(t)) { skipped.push(String(e?.id ?? '?')); continue; }
    const kind = mapKind(e.kind);
    if (kind === 'section' && !includeSections) { skipped.push(String(e.id)); continue; }
    const ms = Math.round(sec ? t * 1000 : t);
    if (ms < 0 || (song?.duration_ms && ms > song.duration_ms)) { skipped.push(String(e.id)); continue; }
    let id = EVENT_ID.test(String(e.id ?? '')) ? String(e.id) : slugId(e.name || e.id || kind, [...ids]);
    if (ids.has(id)) { skipped.push(id); continue; }   // already there: kept as it is
    ids.add(id);
    out.push({ id, name: str(e.name || e.id, 120), t: ms, kind, note: str(e.note, 2000), ...(kind !== e.kind && e.kind ? { source_kind: str(e.kind, 24) } : {}) });
  }
  return { events: out, skipped, unit: sec ? 's' : 'ms' };
}

// the "anchor" select of a boundary (the script's scene card, the storyboard's shot panel): "no anchor" + every snap event;
// esc = the page's HTML escape
export function anchorSelect(x, edge, events, esc, cls) {
  const list = snapEvents(events); if (!list.length) return '';
  const cur = x?.anchors?.[edge] || '';
  return `<select class="${cls}" data-edge="${edge}" title="anchor the ${edge === 't0' ? 'start' : 'end'} to a named event: it takes the event's time and follows it when you re-time after the take">`
    + `<option value="">${cur ? '⚓ unanchor' : '⚓ anchor…'}</option>${list.map(e => `<option value="${esc(e.id)}"${e.id === cur ? ' selected' : ''}>⚓ ${esc(e.name)} · ${clock(e.t)}</option>`).join('')}</select>`;
}
