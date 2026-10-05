// Review rounds and revisions (docs/SPEC_v4_NOTES_ROUNDS.md §2, ROADMAP_v4 B6-B8). Pure functions, no DOM, no Node APIs:
// the page (core/rail.js, tabs/compare.js) and the data layer (lib/ops/rounds.mjs) use the same code.
//
// The director works in ROUNDS: notes collect in notes.json (`round` = the round being collected). "Send round to
// Claude" (page only) takes every open note of the director's, writes ONE ask (a note to the agent, ask "round") and
// bumps notes.json `round`; the agent applies the notes (round_get / round_absorb / round_reply / round_finish); the
// director then closes the round into a REVISION R<n>: an immutable project-wide snapshot (.snapshots/) + an index entry.
//
// revisions.json (written by the server only; not a page save)  {v: 1, rev, rounds: [Round], revisions: [Revision],
//   restores: [{at, revision, previous}]}
//   Round     {n, status: sent | finished | closed, sent_at, sent_by, notes: [note ids], ask: note id, base: snapshot id
//              (the state when it was sent), finished_at?, finished_by?, summary?, closed_at?, revision?}
//   Revision  {id "R3", n, round: n | null, created, summary, notes_absorbed: [ids], notes_replied: [ids],
//              files_changed: [paths], cost_usd (spent in all), cost_delta (since the previous revision), snapshot,
//              base: snapshot id | null, by, via, git?: {commit} | {skipped: why}}
// A note the agent absorbed in a round has absorbed_in = the revision that round becomes and change {stage, file?,
// version?, summary}: the compare view links each change to the note that caused it.
import { wordDiff } from './flow.js';

export const emptyRevisions = () => ({ v: 1, rev: 0, rounds: [], revisions: [], restores: [] });
export const normRevisions = (d) => (d && typeof d === 'object' && Array.isArray(d.revisions) ? { rounds: [], restores: [], ...d } : emptyRevisions());
// the round in flight (sent to the agent, or finished by it, not closed into a revision yet), or null
export const inFlight = (rv) => [...(rv?.rounds || [])].reverse().find(r => r.status === 'sent' || r.status === 'finished') || null;
export const nextRevisionId = (rv) => `R${(rv?.revisions || []).reduce((m, r) => Math.max(m, Number(String(r.id).slice(1)) || 0), 0) + 1}`;
export const lastRevision = (rv) => (rv?.revisions || []).at(-1) || null;

// the notes a round sends: every open note of the director's (the page, or imported from the old stores), not the
// agent's own notes and not an earlier round's ask
export const roundCandidates = (notes) => (notes?.notes || []).filter(n => n.status === 'open' && n.via !== 'agent' && n.ask !== 'round');

// how far the agent is with a round: absorbed (done), replied (an agent reply since the round was sent, still open),
// dismissed (by the director), left (open, no answer yet)
export function roundProgress(notes, round) {
  const out = { total: 0, absorbed: 0, replied: 0, dismissed: 0, left: 0 };
  if (!round) return out;
  const by = new Map((notes?.notes || []).map(n => [n.id, n]));
  for (const id of round.notes || []) {
    const n = by.get(id); out.total++;
    if (!n) { out.dismissed++; continue; }   // deleted by the director
    if (n.status === 'absorbed') out.absorbed++;
    else if (n.status === 'dismissed') out.dismissed++;
    else if ((n.replies || []).some(r => r.via === 'agent' && String(r.at || '') >= String(round.sent_at || ''))) out.replied++;
    else out.left++;
  }
  return out;
}
export const progressText = (p) => `${p.absorbed} absorbed · ${p.replied} replied · ${p.left} left${p.dismissed ? ` · ${p.dismissed} dismissed` : ''}`;

// ------------------------------------------------------------------ compare helpers
// two lists of time-ranged items ({id, t0, t1, ...}) -> each item once, in time order: st added | removed | moved (its
// times changed) | changed (same times, other fields) | same; a / b = its {t0, t1} on each side
export function timelineChanges(A = [], B = [], { text = (x) => JSON.stringify(x) } = {}) {
  const a = new Map(A.map(x => [x.id, x])), b = new Map(B.map(x => [x.id, x])), out = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id), y = b.get(id);
    const st = !x ? 'added' : !y ? 'removed' : x.t0 !== y.t0 || x.t1 !== y.t1 ? 'moved' : text(x) !== text(y) ? 'changed' : 'same';
    const row = { id, st, a: x ? { t0: x.t0, t1: x.t1 } : null, b: y ? { t0: y.t0, t1: y.t1 } : null, title: (y || x).title || '', ...(y?.scene || x?.scene ? { scene: (y || x).scene } : {}), ...(y?.kind || x?.kind ? { kind: (y || x).kind } : {}) };
    if (x && y && text(x) !== text(y)) { row.diff = wordDiff(text(x), text(y)); if (st === 'moved') row.also_text = true; }
    out.push(row);
  }
  return out.sort((p, q) => ((p.b || p.a).t0 - (q.b || q.a).t0) || String(p.id).localeCompare(String(q.id)));
}
// two lyrics versions -> the changed lines (by their stable ids): + added, - removed, ~ reworded (with a word diff)
export function lineChanges(vA, vB) {
  const flat = (v) => (v?.sections || []).flatMap(s => s.lines.map((l, i) => ({ ...l, section: s.id, label: s.label, i })));
  const A = flat(vA), B = flat(vB), a = new Map(A.map(l => [l.id, l])), b = new Map(B.map(l => [l.id, l])), out = [];
  for (const l of B) {
    const o = a.get(l.id);
    if (!o) out.push({ id: l.id, op: '+', section: l.label, b: l.text });
    else if (o.text !== l.text) out.push({ id: l.id, op: '~', section: l.label, a: o.text, b: l.text, diff: wordDiff(o.text, l.text) });
  }
  for (const l of A) if (!b.has(l.id)) out.push({ id: l.id, op: '-', section: l.label, a: l.text });
  return out;
}
// a word diff [{op, w}] -> compact runs [{op, t}] (consecutive words of one op joined), for the page; an unchanged run
// keeps `ctx` words of context next to each change ("…" for the rest)
export function diffRuns(d, ctx = 5) {
  const out = [];
  for (const x of d || []) { const w = x.w === '\n' ? '⏎' : x.w, last = out.at(-1); if (last && last.op === x.op) last.w.push(w); else out.push({ op: x.op, w: [w] }); }
  return out.map((r, i) => {
    if (r.op !== '=' || r.w.length <= 2 * ctx + 1) return { op: r.op, t: r.w.join(' ') };
    const head = i > 0 ? r.w.slice(0, ctx) : [], tail = i < out.length - 1 ? r.w.slice(-ctx) : [];
    return { op: '=', t: [...head, '…', ...tail].join(' ') };
  });
}

// does a note point at a row of a stage (the compare view's link from a change to the note that caused it)
export function noteHits(n, stage, id, { section, scene } = {}) {
  const t = n?.target; if (!t) return false;
  if (stage === 'lyrics') return t.stage === 'lyrics' && ((t.kind === 'line' && t.id === id) || (t.kind === 'section' && section && t.id === section));
  if (stage === 'script') return t.stage === 'script' && (t.id === id || String(t.id || '').startsWith(id + '/'));
  if (stage === 'storyboard') return (t.stage === 'storyboard' || t.stage === 'final') && ((t.kind === 'shot' && t.id === id) || (t.kind === 'scene' && scene && t.id === scene));
  if (stage === 'breakdown') return t.stage === 'breakdown' && t.kind === 'item' && t.id === id;
  if (stage === 'assets') return (t.stage === 'characters' || t.stage === 'scenery') && String(t.id || '').split('/')[0] === id;
  return false;
}
