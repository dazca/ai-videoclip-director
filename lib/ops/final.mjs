// Stage 7, final approvals (docs/SPEC_v3_GUIDED.md; ROADMAP_v4 C1-C4). Shapes and logic: js/final.js (shared with the page).
//   final_get     read only: everything not yet approved, grouped by stage (status, cost, open notes, why), the "ready to
//                 render" checklist (derived, never stored) and the costs against the cap (the merged ledger), the lock
//   final_lock    PAGE ONLY: "Lock for render": closes a revision (revision_close: an immutable snapshot, the final one),
//                 marks it final and the project locked (revisions.json `lock`); refused while the checklist fails unless
//                 the director confirms (`force`)
//   final_unlock  PAGE ONLY: the director unlocks (the lock is kept in `locks[]`)
//   lockGate      a locked project refuses every agent write (409 + why): serve.mjs calls it for /api/op, /api/save and
//                 /api/restore without the page's Origin, the MCP server for its offline ops. Reads stay open.
import path from 'node:path';
import * as FN from '../../js/final.js';
import * as F from '../../js/flow.js';
import { span } from '../../js/scenes.js';
import { fail, isFlaggedPrivate, isPrivate, nowIso, ops, projDir, read, readJSON, writeJSON } from './_shared.mjs';
import { notesDoc } from './notes.mjs';
import { lyricsDoc } from './lyrics.mjs';
import { scenesDoc } from './scenes.mjs';
import { breakdownDoc } from './breakdown.mjs';
import { boardDoc } from './storyboard.mjs';
import { costSummary } from './requests.mjs';
import { revDoc } from './rounds.mjs';

const entitiesAll = (p) => (read(p, 'entities/index.json') || []).filter(e => typeof e?.path === 'string' && !/\.\./.test(e.path))
  .map(e => { const x = readJSON(path.join(projDir(p), e.path), null); return x && typeof x === 'object' ? { ...x, id: e.id, kind: e.kind } : null; }).filter(Boolean);

export function finalInput(p) {
  const shotsJ = read(p, 'shots.json'), costs = read(p, 'costs.json');
  let ledger = null; try { ledger = costSummary(p); } catch (e) { /* a broken falgen link: costs.json only */ }
  return { song: read(p, 'song.json'), lyrics: lyricsDoc(p), stages: F.normStages(readJSON(path.join(projDir(p), 'stages.json'), null, true), {}),
    scenes: scenesDoc(p), breakdown: breakdownDoc(p), board: boardDoc(p), uses: shotsJ.uses || [], entities: entitiesAll(p),
    approvals: read(p, 'approvals.json'), requests: read(p, 'requests.json'), notes: notesDoc(p), revisions: revDoc(p), costs, ledger,
    media: read(p, 'media.json').items || [], settings: read(p, 'settings.json'), isPrivate: (x) => isPrivate(x) || isFlaggedPrivate(x, [p]) };
}
export const finalOf = (p) => FN.finalView(finalInput(p));

// ------------------------------------------------------------------ the lock: every agent write is refused while it holds
export const lockedOf = (p) => { try { return FN.lockOf(revDoc(p)); } catch (e) { return null; } };
const READ_OP = /_(get|list|versions|query|compare)$/;
export function lockGate(p, name, args = {}) {
  if (READ_OP.test(name) || name === 'final_lock' || name === 'final_unlock') return;   // reads; the lock's own page-only acts answer 403 themselves
  if (name === 'request_run' && args?.dry_run) return;                                   // a plan spends and writes nothing
  if (name === 'composition_export' || name === 'project_export' || name === 'project_import' || name === 'project_upload') return;   // G5: an export writes only exports/<zip>; an import / upload writes a NEW project                                             // E9: writes only exports/<file>, never a project file
  if (name === 'sheet_make' || name === 'sheet_review' || name === 'song_version_plan') return;   // E8: a sheet / a review of a render (renders.json, sheets/), the plan: read
  const L = lockedOf(p); if (!L) return;
  fail(409, `the project is locked for render (${L.revision || 'locked'} at ${String(L.at || '').replace('T', ' ')}): agents change nothing while it is locked (and the cut is not re-timed). `
    + 'Reads still work (final_get says what is locked and why). Only the director unlocks it, in the page (Final stage, "Unlock").');
}

const RFILE = 'revisions.json';
function mutateRev(p, fn) { const d = revDoc(p); const r = fn(d); d.rev = (d.rev || 0) + 1; writeJSON(path.join(projDir(p), RFILE), d); return r === undefined ? d : r; }
const pageOnly = (via, what) => { if (via !== 'page') fail(403, `only the director ${what}, in the page (Final stage): an agent cannot. final_get says what is left`); };
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

Object.assign(ops, {
  final_get(p, { group, status, notes, limit = 200 } = {}) {
    if (group != null && !FN.GROUPS.some(g => g.id === group)) fail(400, `group: one of ${FN.GROUPS.map(g => g.id).join(', ')}`);
    if (status != null && !FN.ST.includes(status)) fail(400, `status: one of ${FN.ST.join(', ')}`);
    const v = finalOf(p), lim = Math.max(1, Math.min(1000, Number(limit) || 200));
    const rows = v.rows.filter(r => (!group || r.group === group) && (!status || r.st === status) && (!notes || r.notes_open));
    const out = (r) => ({ key: r.key, group: r.group, kind: r.kind, id: r.id, title: r.title, ...(r.sub ? { sub: r.sub } : {}), ...(r.t0 != null ? { time: span(r.t0, r.t1) } : {}),
      status: r.status, st: r.st, why: r.why, est_usd: r.est_usd ?? null, spent_usd: r.spent_usd ?? null, notes_open: r.notes_open,
      approvable: !!r.act?.approve, ...(r.thumb && !r.private && !isPrivate(r.thumb) && !isFlaggedPrivate(r.thumb, [p]) ? { thumb: r.thumb } : {}) });
    return {
      ready: v.ready, locked: v.lock, failing: v.failing,
      checklist: v.checklist.map(c => ({ id: c.id, ok: c.ok, label: c.label, detail: c.detail, ...(c.warn ? { warn: c.warn } : {}), gaps: c.gaps.map(g => g.label), ...(c.more ? { more: c.more } : {}) })),
      counts: v.counts, costs: v.costs, chapters: v.chapters || [],
      pending: rows.slice(0, lim).map(out), ...(rows.length > lim ? { more: rows.length - lim } : {}),
      rules: 'read only. Every approval here is the director\'s, in the page (Final stage: Approve / Request changes, or approve the selected rows); you cannot approve. '
        + 'Help close the gaps: draft requests (request_create), answer the open notes (notes_get / notes_status), propose shots or assets; set "review" and say why in a note to ask for a look. '
        + 'A locked project (locked != null) refuses every write (409) until the director unlocks it.',
    };
  },
  final_lock(p, { via, summary, force = false } = {}) {
    pageOnly(via, 'locks the project for render');
    if (summary != null && (typeof summary !== 'string' || summary.length > 2000)) fail(400, 'summary: up to 2000 characters');
    const L = lockedOf(p); if (L) fail(409, `already locked (${L.revision})`);
    const v = finalOf(p);
    if (!v.ready && force !== true) fail(409, `the checklist fails (${v.failing.join(', ')}): fix it, or confirm "lock anyway" in the page`);
    const sum = String(summary || '').trim() || `Locked for render${v.ready ? '' : ` (anyway: ${v.failing.join(', ')} failing)`}`;
    const entry = ops.revision_close(p, { via: 'page', summary: sum });
    const lock = { at: nowIso(), revision: entry.id, snapshot: entry.snapshot, summary: clip(sum, 300), by: 'director', via: 'page', ready: v.ready, ...(v.ready ? {} : { failing: v.failing }), pending: v.counts.total };
    mutateRev(p, (d) => {
      const r = d.revisions.find(x => x.id === entry.id); if (r) r.final = true;
      d.lock = lock; (d.locks ||= []).push({ ...lock });
    });
    return { locked: lock, revision: entry.id, snapshot: entry.snapshot };
  },
  final_unlock(p, { via } = {}) {
    pageOnly(via, 'unlocks the project');
    const L = lockedOf(p); if (!L) fail(409, 'not locked');
    const at = nowIso();
    mutateRev(p, (d) => { const h = (d.locks || []).findLast(x => x.revision === L.revision && !x.unlocked_at); if (h) Object.assign(h, { unlocked_at: at, unlocked_by: 'director' }); d.lock = null; });
    return { unlocked: L.revision, at };
  },
});
