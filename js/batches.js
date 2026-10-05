// Job books, waves and pilot gates (ROADMAP_v4 D4). Pure functions, no DOM and no Node APIs: the page (tabs/queue.js,
// tabs/waves.js), the data layer (lib/ops/batches.mjs, lib/ops/requests.mjs) and the runner (lib/run.mjs) share them.
//
// requests.json  {rev, items: [Request], batches: [Batch]}   (batches: written by the server only; a page save keeps its copy)
//   Batch {id "b03", name "Wave 1 · pilot", wave: n, request_ids: [ids], shots: [shot ids planned],
//          gate: {after: <batch id> | null, rule: "review"}, status: draft | approved | reviewed,
//          max_usd?: the batch cap (set when approved: its total), verdicts: {<request id>: {verdict: rejected | kept, at}},
//          by, via, at, approved_at?, reviewed_at?, stats? (the take-ratio numbers when it was reviewed)}
// What the Queue shows (gateState): locked (the batch it waits for is not reviewed yet) | ready (to approve, or approved and
// waiting to run) | running | review (every request ran: pick or reject the takes, then "Mark reviewed") | done (reviewed).
// The director approves a whole batch at once and marks it reviewed (page only: batch_act); a locked batch never runs.
// A History request (imported from a falgen job book: `history {book, job, ...}`, status done) never runs and costs nothing new.
export const BATCH_ID = /^b\d{2,4}$/;
export const WAVE_SIZES = [2, 4, 8];
export const TERMINAL = ['done', 'failed', 'rejected', 'withdrawn'];
export const LIVE = ['queued', 'running'];
export const VERDICTS = ['rejected', 'kept'];
export const STATES = ['locked', 'ready', 'running', 'review', 'done'];
const r2 = (x) => +(Number(x) || 0).toFixed(2), r3 = (x) => +(Number(x) || 0).toFixed(3);
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const itemsOf = (doc) => (Array.isArray(doc) ? doc : doc?.items) || [];

export const batchesOf = (doc) => (Array.isArray(doc?.batches) ? doc.batches : []);
export const batchById = (doc, id) => batchesOf(doc).find(b => b.id === id) || null;
export const batchOfRequest = (doc, rid) => batchesOf(doc).find(b => (b.request_ids || []).includes(rid)) || null;
export const nextBatchId = (doc) => `b${String(Math.max(0, ...batchesOf(doc).map(b => Number(/^b(\d+)$/.exec(b.id)?.[1]) || 0)) + 1).padStart(2, '0')}`;
export const shotOf = (r) => (/^shot:/.test(r?.target || '') ? r.target.slice(5) : null);
export const isHistory = (r) => !!(r && r.history && typeof r.history === 'object');
export const requestsOf = (b, doc) => { const by = new Map(itemsOf(doc).map(r => [r.id, r])); return (b?.request_ids || []).map(id => by.get(id)).filter(Boolean); };

// the batch's gate, as the Queue and the runner read it -> {state, why, after?}
export function gateState(b, doc) {
  if (!b) return { state: 'ready', why: '' };
  if (b.status === 'reviewed') return { state: 'done', why: `reviewed${b.reviewed_at ? ' ' + String(b.reviewed_at).replace('T', ' ').slice(0, 16) : ''}` };
  const prev = b.gate?.after ? batchById(doc, b.gate.after) : null;
  if (prev && prev.status !== 'reviewed') return { state: 'locked', after: prev.id, why: `locked until the director marks ${prev.name || prev.id} reviewed (its takes picked or rejected)` };
  const R = requestsOf(b, doc);
  if (R.some(r => LIVE.includes(r.status) || r.retaking)) return { state: 'running', why: 'running' };
  if (b.status === 'approved' && R.length && R.every(r => TERMINAL.includes(r.status))) return { state: 'review', why: 'every request ran: pick or reject the takes, then Mark reviewed' };
  return { state: 'ready', why: b.status === 'approved' ? 'approved: ready to run' : 'ready to approve (the whole batch at once)' };
}
// why a request may not run (null = its batch lets it): a locked batch never runs; a batch runs once approved as a whole
export function gateRefusal(doc, rid) {
  const r = itemsOf(doc).find(x => x.id === rid);
  if (isHistory(r)) return `${rid} is history (imported from the job book ${r.history.book || ''}): it never runs again`;
  const b = batchOfRequest(doc, rid); if (!b) return null;
  const g = gateState(b, doc);
  if (g.state === 'locked') return `in ${b.name || b.id} (${b.id}), ${g.why}`;
  if (b.status === 'reviewed') return `${b.name || b.id} (${b.id}) is reviewed (closed): a new wave runs again`;
  if (b.status !== 'approved') return `${b.name || b.id} (${b.id}) is not approved: the director approves the whole batch in Review › Queue ("Approve batch")`;
  return null;
}
// money of a batch: its estimate (every request), the drafts, what ran (actual), its cap and what is left of it
export function batchTotals(b, doc) {
  const R = requestsOf(b, doc), by = {};
  for (const r of R) by[r.status] = (by[r.status] || 0) + 1;
  const est = r2(sum(R.filter(r => !['rejected', 'withdrawn'].includes(r.status)), r => r.est_cost));
  const spent = r3(sum(R, r => r.actual_cost_usd));
  const live = r2(sum(R.filter(r => ['approved', ...LIVE].includes(r.status)), r => r.est_cost));
  return { n: R.length, by, est_usd: est, drafts_usd: r2(sum(R.filter(r => r.status === 'draft'), r => r.est_cost)), approved_usd: live, spent_usd: spent,
    max_usd: b?.max_usd ?? null, left_usd: b?.max_usd != null ? r3(b.max_usd - spent) : null, shots: [...new Set(R.map(shotOf).filter(Boolean))].length };
}
// per request: has the director decided its takes? picked (the shot's clip is one of its takes), rejected / kept (their
// verdict in the batch), n/a (failed, rejected or withdrawn: no takes), pending (done, undecided), not run
export function verdicts(b, doc, shots = []) {
  const S = new Map(shots.map(s => [s.id, s]));
  return requestsOf(b, doc).map(r => {
    const shot = shotOf(r), s = shot ? S.get(shot) : null, v = b.verdicts?.[r.id]?.verdict;
    const picked = !!(s?.clip && s.clip.request === r.id);
    const verdict = picked ? 'picked' : v && VERDICTS.includes(v) ? v : r.status === 'done' ? 'pending' : TERMINAL.includes(r.status) ? 'n/a' : 'not run';
    return { id: r.id, status: r.status, shot, verdict, takes: (r.outputs || []).length, ...(picked ? { clip: { take: s.clip.take, in_ms: s.clip.in_ms, out_ms: s.clip.out_ms } } : {}) };
  });
}
export const undecided = (b, doc, shots) => verdicts(b, doc, shots).filter(v => v.verdict === 'pending' || v.verdict === 'not run');
// the seconds a pick uses: its in / out (a video), else the shot's length (a still, or no out-point)
export function usedSeconds(s) {
  const c = s?.clip; if (!c) return 0;
  if (c.out_ms != null && c.in_ms != null && c.out_ms > c.in_ms) return (c.out_ms - c.in_ms) / 1000;
  return Math.max(0, ((s.t1 || 0) - (s.t0 || 0)) / 1000);
}
// the take ratio of some requests (a batch, or the history): takes made, shots that use one of them, takes per used shot,
// what they cost and the cost per second that made it into the film
export function takeStats(R, shots = []) {
  const S = new Map(shots.map(s => [s.id, s])), done = R.filter(r => r.status === 'done');
  const ids = new Set(R.map(r => r.id));
  const usedShots = [...new Set(R.map(shotOf).filter(Boolean))].map(id => S.get(id)).filter(s => s?.clip && ids.has(s.clip.request));
  const takes = sum(done, r => (isHistory(r) && Number.isInteger(r.history.files) ? r.history.files : (r.outputs || []).length));
  const spent = r3(sum(R, r => r.actual_cost_usd)), used_s = +sum(usedShots, usedSeconds).toFixed(2);
  return { requests: R.length, ran: done.length, shots: [...new Set(R.map(shotOf).filter(Boolean))].length, takes, used_shots: usedShots.length,
    takes_per_used_shot: usedShots.length ? +(takes / usedShots.length).toFixed(2) : null, spent_usd: spent, used_s,
    usd_per_used_s: used_s > 0 ? +(spent / used_s).toFixed(3) : null };
}
export const batchStats = (b, doc, shots) => takeStats(requestsOf(b, doc), shots);
// what the waves done so far measured (review or done batches), and the remaining waves re-estimated from it:
// observed_usd = the seconds the wave's shots fill x the cost per used second measured (list_usd = the list-price estimate)
export function observed(doc, shots = []) {
  const from = batchesOf(doc).filter(b => ['review', 'done'].includes(gateState(b, doc).state));
  const R = from.flatMap(b => requestsOf(b, doc)), st = takeStats(R, shots);
  return { from: from.map(b => b.id), ...st };
}
export function reestimate(doc, shots = []) {
  const ob = observed(doc, shots), S = new Map(shots.map(s => [s.id, s]));
  return batchesOf(doc).filter(b => ['locked', 'ready'].includes(gateState(b, doc).state)).map(b => {
    const R = requestsOf(b, doc).filter(r => !TERMINAL.includes(r.status)), ids = [...new Set([...(b.shots || []), ...R.map(shotOf).filter(Boolean)])];
    const seconds = +sum(ids.map(id => S.get(id)).filter(Boolean), s => (s.t1 - s.t0) / 1000).toFixed(2), list = r2(sum(R, r => r.est_cost));
    return { id: b.id, name: b.name, shots: ids.length, seconds, list_usd: list, observed_usd: ob.usd_per_used_s != null ? r2(seconds * ob.usd_per_used_s) : null,
      ratio: ob.usd_per_used_s != null && list ? +((seconds * ob.usd_per_used_s) / list).toFixed(2) : null };
  });
}
// waves of shots: the pilot (the director's choice, else the first `sizes[0]`), then the next sizes, then the rest
export function planWaves(shotIds, { pilot = [], sizes = WAVE_SIZES } = {}) {
  const ids = [...new Set(shotIds)], P = (pilot || []).filter(x => ids.includes(x)), rest = ids.filter(x => !P.includes(x));
  const sz = (Array.isArray(sizes) && sizes.length ? sizes : WAVE_SIZES).map(n => Math.max(1, Math.round(Number(n) || 1)));
  const waves = [];
  let queue = rest, i = 0;
  if (P.length) { waves.push(P); i = 1; } else if (queue.length) { waves.push(queue.slice(0, sz[0])); queue = queue.slice(sz[0]); i = 1; }
  for (; queue.length && i < sz.length; i++) { waves.push(queue.slice(0, sz[i])); queue = queue.slice(sz[i]); }
  if (queue.length) waves.push(queue);
  return waves.filter(w => w.length);
}
export const waveName = (n, count, pilot) => `Wave ${n}${n === 1 && pilot ? ' · pilot' : ''} (${count} shot${count === 1 ? '' : 's'})`;
