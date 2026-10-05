// Job books, waves and pilot gates (ROADMAP_v4 D4; logic in js/batches.js). requests.json `batches[]` groups requests into
// waves: the director approves a whole batch at once (its total against the cap), the runner runs it batch by batch within
// its cap (max_usd), and a gated batch stays locked until the director marks the batch before it reviewed (its takes picked
// or rejected). The waves come from the storyboard gaps (2 -> 4 -> 8 -> rest shots; a pilot first), re-estimated from the
// take ratio the earlier waves measured. The first film's falgen job books (<falgen dir>/jobs_*.json) are imported as
// history: done requests linked to their registered outputs, never run again, costing nothing new.
//   batches_get   read only: the batches with their gate, totals, verdicts, take-ratio stats; the remaining waves re-estimated
//   waves_plan    propose waves (dry_run: the plan only); the agent's waves_propose tool and the page's "Plan waves" call it.
//                 It writes draft requests + draft batches, never an approval
//   batch_act     PAGE ONLY: approve (the whole batch), verdict (a request's takes rejected / kept), review (unlocks the
//                 next), cap, dismiss
//   jobbooks_import  the falgen job books as history requests (dry_run: anyone; the import: page only)
import fs from 'node:fs';
import path from 'node:path';
import * as B from '../../js/batches.js';
import * as SB from '../../js/storyboard.js';
import { CFG, fail, mutate, nowIso, ops, projDir, read, readJSON, withFileLock, write } from './_shared.mjs';
import { costSummary, falgenSource } from './requests.mjs';
import { boardDoc } from './storyboard.mjs';
import { readJob } from './media.mjs';

const shotsNow = (p) => SB.boardShots(boardDoc(p));
const span = (s) => { const f = (ms) => { const x = Math.max(0, ms) / 1000, m = Math.floor(x / 60); return `${m}:${(x - m * 60).toFixed(1).padStart(4, '0')}`; }; return `${f(s.t0)}–${f(s.t1)}`; };
const usd = (x) => `$${(Number(x) || 0).toFixed(2)}`;
const pageOnly = (via, what) => { if (via !== 'page') fail(403, `only the director ${what}, in the page (Review › Queue): an agent cannot. batches_get shows the batches; propose waves with waves_propose`); };
const capView = (c, add = 0) => ({ cap_usd: c.cap_usd, spent_usd: c.total_spent_usd, committed_usd: c.committed_usd, this_usd: +Number(add).toFixed(2), after_usd: +(c.total_spent_usd + c.committed_usd + add).toFixed(2), over_cap: c.total_spent_usd + c.committed_usd + add > c.cap_usd + 1e-9 });

// one batch as batches_get / the page show it
function batchView(doc, b, shots) {
  const g = B.gateState(b, doc);
  return { id: b.id, name: b.name, wave: b.wave ?? null, status: b.status, state: g.state, why: g.why, gate: b.gate || { after: null, rule: 'review' }, request_ids: b.request_ids || [], shots: b.shots || [],
    totals: B.batchTotals(b, doc), verdicts: B.verdicts(b, doc, shots), stats: B.batchStats(b, doc, shots), max_usd: b.max_usd ?? null,
    by: b.by, via: b.via, at: b.at, ...(b.approved_at ? { approved_at: b.approved_at } : {}), ...(b.reviewed_at ? { reviewed_at: b.reviewed_at } : {}) };
}
// the shots a wave may take: storyboard gaps (no open request, no clip) and shots whose draft requests are in no batch yet
function candidates(p, doc) {
  const shots = shotsNow(p), inBatch = new Set(B.batchesOf(doc).flatMap(b => b.request_ids || [])), items = doc.items || [];
  const batchedShots = new Set(items.filter(r => inBatch.has(r.id)).map(B.shotOf).filter(Boolean));
  const gaps = new Map((ops.gaps_get(p).proposals || []).map(x => [x.shot, x]));
  const out = [];
  for (const s of shots) {
    if (batchedShots.has(s.id)) continue;
    const drafts = items.filter(r => r.target === `shot:${s.id}` && r.status === 'draft' && !inBatch.has(r.id));
    const gp = gaps.get(s.id);
    if (!drafts.length && !gp) continue;
    const q = gp?.requests?.[0];
    out.push({ shot: s.id, time: span(s), t0: s.t0, t1: s.t1, seconds: +((s.t1 - s.t0) / 1000).toFixed(2), kind: s.kind, title: s.title || s.text?.slice(0, 80) || '',
      requests: drafts.map(r => r.id), est_usd: drafts.length ? +drafts.reduce((a, r) => a + (Number(r.est_cost) || 0), 0).toFixed(2) : q ? q.est_cost : 0,
      draft: drafts.length ? null : q ? { kind: q.kind, tool: q.tool, est_usd: q.est_cost, why: q.why, prompt: q.prompt, refs: q.refs.filter(x => !String(x).startsWith('(')), gen: gp.gen } : null,
      ...(gp?.not_approved ? { not_approved: gp.not_approved.length } : {}) });
  }
  return out;
}

Object.assign(ops, {
  // read only: every batch (gate state, totals, verdicts, take-ratio stats), what the reviewed waves measured, the remaining
  // waves re-estimated, the history imported from the job books, the rules
  batches_get(p, { id } = {}) {
    const doc = read(p, 'requests.json'), shots = shotsNow(p);
    if (id != null && !B.batchById(doc, id)) fail(404, `no batch "${String(id).slice(0, 40)}" (batches_get lists them)`);
    const list = B.batchesOf(doc).filter(b => !id || b.id === id).map(b => batchView(doc, b, shots));
    const hist = (doc.items || []).filter(B.isHistory);
    return { batches: list, observed: B.observed(doc, shots), remaining: B.reestimate(doc, shots),
      history: { requests: hist.length, books: [...new Set(hist.map(r => r.history.book))], stats: B.takeStats(hist, shots) },
      unbatched_drafts: (doc.items || []).filter(r => r.status === 'draft' && !B.batchOfRequest(doc, r.id)).map(r => r.id),
      costs: capView(costSummary(p)),
      rules: 'batches are waves of requests: the director approves a whole batch at once and marks it reviewed (its takes picked or rejected) in the page; the next batch stays locked until then and a locked batch never runs. Propose waves with waves_propose (drafts only); run an approved batch with request_run {batch}; never approve or unlock' };
  },
  // waves from the storyboard gaps: 2 -> 4 -> 8 -> rest shots (sizes), the pilot first (pilot: shot ids, else the first
  // shots in song time); each shot's draft request (the first one gaps_get proposes, takes x its estimate) is created, or
  // its existing unbatched drafts are used; each wave is a draft batch gated on the one before. dry_run: the plan only.
  waves_plan(p, { shots, pilot = [], sizes = B.WAVE_SIZES, takes = 1, dry_run = false, by, via } = {}) {
    const page = via === 'page', who = String(by || (page ? 'director' : 'agent')).slice(0, 60);
    if (shots != null && (!Array.isArray(shots) || shots.some(x => typeof x !== 'string' || !SB.SHOT_ID.test(x)))) fail(400, 'shots: a list of storyboard shot ids (default: every gap)');
    if (!Array.isArray(pilot) || pilot.some(x => typeof x !== 'string' || !SB.SHOT_ID.test(x))) fail(400, 'pilot: the shot ids of the pilot wave (e.g. ["G02", "G07", "G15"])');
    if (!Array.isArray(sizes) || !sizes.length || sizes.length > 8 || sizes.some(n => !Number.isInteger(n) || n < 1 || n > 50)) fail(400, 'sizes: wave sizes, e.g. [2, 4, 8] (then the rest)');
    if (!Number.isInteger(takes) || takes < 1 || takes > 8) fail(400, 'takes: takes per request, 1-8 (the estimate covers every take)');
    const doc = read(p, 'requests.json'), cands = candidates(p, doc), byShot = new Map(cands.map(c => [c.shot, c]));
    const skipped = [];
    for (const x of [...(shots || []), ...pilot]) if (!byShot.has(x)) skipped.push({ shot: x, why: shotsNow(p).some(s => s.id === x) ? 'has an open request, a clip or is in a batch already (not a gap)' : 'no such shot in the current storyboard' });
    const pool = cands.filter(c => !shots || shots.includes(c.shot) || pilot.includes(c.shot)).map(c => c.shot);
    if (!pool.length) return { dry_run: !!dry_run, waves: [], skipped, candidates: cands, note: 'no shot to plan: every storyboard shot has a request, a clip or a batch (gaps_get)' };
    const groups = B.planWaves(pool, { pilot, sizes });
    const prevLast = B.batchesOf(doc).at(-1)?.id || null, base = B.batchesOf(doc).length;
    const est = (c) => c.requests.length ? c.est_usd : +((c.draft?.est_usd || 0) * takes).toFixed(2);
    const waves = groups.map((g, i) => {
      const list = g.map(id => byShot.get(id));
      return { n: base + i + 1, name: B.waveName(base + i + 1, g.length, i === 0 && pilot.length > 0), shots: list.map(c => ({ shot: c.shot, time: c.time, kind: c.kind, seconds: c.seconds, est_usd: est(c), requests: c.requests, new: c.requests.length ? null : c.draft?.kind || null })),
        est_usd: +list.reduce((a, c) => a + est(c), 0).toFixed(2), seconds: +list.reduce((a, c) => a + c.seconds, 0).toFixed(2) };
    });
    const shotsAll = shotsNow(p), ob = B.observed(doc, shotsAll);
    if (ob.usd_per_used_s != null) for (const w of waves) w.observed_usd = +(w.seconds * ob.usd_per_used_s).toFixed(2);
    const total = +waves.reduce((a, w) => a + w.est_usd, 0).toFixed(2), c = costSummary(p);
    const plan = { waves, total_usd: total, takes, cap: capView(c, total), observed: ob, skipped };
    if (dry_run) return { dry_run: true, ...plan, candidates: cands, note: 'dry run: nothing written. Without dry_run the requests are created as drafts and the waves as draft batches (gated, wave after wave); only the director approves a batch' };
    const at = nowIso(), made = [];
    const out = mutate(p, 'requests.json', (d) => {
      d.batches = B.batchesOf(d);
      const inBatch = new Set(d.batches.flatMap(b => b.request_ids || []));
      let after = d.batches.at(-1)?.id || null;
      return waves.map((w, i) => {
        const ids = [];
        for (const s of w.shots) {
          const c = byShot.get(s.shot);
          if (c.requests.length) { for (const id of c.requests) if (!inBatch.has(id) && d.items.some(r => r.id === id && r.status === 'draft')) ids.push(id); continue; }
          const q = c.draft; if (!q) continue;
          const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
          d.items.push({ id, kind: q.kind, target: `shot:${s.shot}`, prompt: q.prompt, refs: q.refs, est_cost: +(q.est_usd * takes).toFixed(4), status: 'draft', by: who, at, tool: q.tool, est_why: q.why + (takes > 1 ? ` x ${takes} takes` : ''),
            ...(takes > 1 ? { takes } : {}), shot: { id: s.shot, gen: q.gen }, log: [{ at, by: who, via: page ? 'page' : 'agent', status: 'draft', wave: true }] });
          ids.push(id); made.push(id);
        }
        const b = { id: B.nextBatchId(d), name: w.name, wave: w.n, request_ids: ids, shots: w.shots.map(s => s.shot), gate: { after, rule: 'review' }, status: 'draft', verdicts: {}, by: who, via: page ? 'page' : 'agent', at };
        d.batches.push(b); after = b.id; return b.id;
      });
    });
    return { ...plan, batches: out, requests_created: made, gated_after: prevLast,
      note: `${out.length} draft batch${out.length > 1 ? 'es' : ''} (${out.join(', ')}), ${made.length} draft request${made.length === 1 ? '' : 's'}: nothing is approved. The director approves ${out[0]} as a whole in Review › Queue; each next wave unlocks when they mark the one before reviewed` };
  },
  // PAGE ONLY: the director's acts on a batch
  batch_act(p, { act, id, request, verdict, max_usd, via, by = 'director' } = {}) {
    pageOnly(via, 'approves, reviews (unlocks) or changes a batch');
    if (!['approve', 'verdict', 'review', 'cap', 'dismiss'].includes(act)) fail(400, 'act: approve | verdict | review | cap | dismiss');
    const shots = shotsNow(p), at = nowIso(), who = String(by || 'director').slice(0, 60);
    let costs = null;
    if (act === 'approve') { const d0 = read(p, 'requests.json'), b0 = B.batchById(d0, id); if (b0) costs = costSummary(p); }
    const r = mutate(p, 'requests.json', (d) => {
      const b = B.batchById(d, id); if (!b) fail(404, `no batch "${String(id).slice(0, 40)}"`);
      const g = B.gateState(b, d);
      if (act === 'approve') {
        if (g.state === 'locked') fail(409, `${b.name || b.id}: ${g.why}`);
        if (b.status === 'reviewed') fail(409, `${b.name || b.id} is reviewed (closed)`);
        const drafts = B.requestsOf(b, d).filter(x => x.status === 'draft');
        if (!drafts.length && b.status === 'approved') fail(409, `${b.name || b.id} is approved already`);
        if (max_usd != null && !(Number(max_usd) >= 0)) fail(400, 'max_usd: the batch cap, USD >= 0');
        for (const x of drafts) { x.status = 'approved'; x.at = at; (x.log ||= []).push({ at, by: who, via: 'page', status: 'approved', batch: b.id }); }
        const total = +B.requestsOf(b, d).filter(x => ['approved', 'queued', 'running', 'done', 'failed'].includes(x.status)).reduce((a, x) => a + (Number(x.est_cost) || 0), 0).toFixed(4);
        Object.assign(b, { status: 'approved', approved_at: at, approved_by: who, max_usd: max_usd != null ? Number(max_usd) : Math.ceil(total * 100 - 1e-6) / 100 });
        return { batch: b.id, approved: drafts.map(x => x.id), total_usd: +drafts.reduce((a, x) => a + (Number(x.est_cost) || 0), 0).toFixed(2), max_usd: b.max_usd };
      }
      if (act === 'verdict') {
        if (!(b.request_ids || []).includes(request)) fail(404, `${request} is not in ${b.id}`);
        if (b.status === 'reviewed') fail(409, `${b.name || b.id} is reviewed (closed): its verdicts stay`);
        const rq = d.items.find(x => x.id === request);
        if (rq?.status !== 'done') fail(409, `${request} is ${rq?.status}: only a done request's takes are rejected or kept`);
        if (verdict != null && !B.VERDICTS.includes(verdict)) fail(400, 'verdict: rejected | kept | null (undo)');
        b.verdicts ||= {};
        if (verdict == null) delete b.verdicts[request]; else b.verdicts[request] = { verdict, by: who, via: 'page', at };
        return { batch: b.id, request, verdict: verdict ?? null };
      }
      if (act === 'review') {
        if (g.state !== 'review') fail(409, `${b.name || b.id} is ${g.state}: ${g.state === 'review' ? '' : 'it is reviewed once every request ran'}`);
        const open = B.undecided(b, d, shots);
        if (open.length) fail(409, `pick a take (Storyboard › Shot › Takes, Review › Takes) or reject the takes of ${open.map(x => x.id).join(', ')} first`);
        Object.assign(b, { status: 'reviewed', reviewed_at: at, reviewed_by: who, stats: B.batchStats(b, d, shots) });
        const next = B.batchesOf(d).filter(x => x.gate?.after === b.id).map(x => x.id);
        return { batch: b.id, reviewed: true, stats: b.stats, unlocked: next };
      }
      if (act === 'cap') {
        if (!(Number(max_usd) >= 0) || max_usd === '' || max_usd == null) fail(400, 'max_usd: the batch cap, USD >= 0');
        b.max_usd = Number(max_usd); return { batch: b.id, max_usd: b.max_usd };
      }
      // dismiss a draft batch: its requests stay drafts (in no batch); a batch gated on it now waits for what it waited for
      if (b.status !== 'draft') fail(409, `${b.name || b.id} is ${b.status}: only a draft batch is dismissed`);
      d.batches = B.batchesOf(d).filter(x => x.id !== b.id);
      for (const x of d.batches) if (x.gate?.after === b.id) x.gate = { ...x.gate, after: b.gate?.after || null };
      return { batch: b.id, dismissed: true, requests_kept: b.request_ids || [] };
    });
    if (act === 'approve' && costs) r.cap = capView(costs, r.total_usd);
    return r;
  },
  // the falgen job books (<falgen dir>/jobs_*.json, the folder linked in project.json / Settings > costs) as history requests:
  // status done, linked to their outputs that are registered media, never run again; nothing is recorded in costs.json
  // (each job's money is shown where the merged ledger has it: recorded / counted / not counted)
  jobbooks_import(p, { dry_run = false, via } = {}) {
    if (!dry_run) pageOnly(via, 'imports the job books');
    const src = falgenSource(p);
    if (!src) fail(409, 'no falgen folder is linked: Settings › costs › falgen folder (or project.json "falgen"): its jobs_*.json are the job books');
    if (src.error) fail(400, src.error);
    const dirAbs = path.resolve(CFG.mediaBase, src.dir);
    let books = []; try { books = fs.readdirSync(dirAbs).filter(f => /^jobs_[\w.-]{1,60}\.json$/.test(f)).sort(); } catch (e) { fail(404, `${src.dir}: not readable`); }
    const doc = read(p, 'requests.json'), media = read(p, 'media.json').items || [], byPath = new Map(media.map(m => [String(m.path).toLowerCase(), m]));
    const shotsAll = shotsNow(p), uses = read(p, 'shots.json').uses || [];
    const have = new Map((doc.items || []).map(r => [r.id, r])), rows = [], skipped = [];
    for (const book of books) {
      const j = readJSON(path.join(dirAbs, book), null);
      const jobs = Array.isArray(j?.jobs) ? j.jobs : [];
      if (!jobs.length) { skipped.push({ book, why: 'no jobs[]' }); continue; }
      for (const job of jobs) {
        const jid = String(job?.id || '');
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(jid)) { skipped.push({ book, job: jid.slice(0, 40), why: 'not a usable job id' }); continue; }
        const outAbs = path.join(dirAbs, 'out', jid);
        if (!fs.existsSync(path.join(outAbs, 'job.json')) && !fs.existsSync(outAbs)) { skipped.push({ book, job: jid, why: 'no outputs (never ran)' }); continue; }
        const prev = have.get(jid), mine = prev && B.isHistory(prev) && prev.history.job === jid;
        if (mine || rows.some(x => x.history.job === jid)) { skipped.push({ book, job: jid, why: `imported already (${prev?.history?.book || book})` }); continue; }
        const rid = prev ? `${jid}-${book.replace(/^jobs_|\.json$/g, '').replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 64) : jid;
        if (have.has(rid)) { skipped.push({ book, job: jid, why: `request id ${rid} is taken` }); continue; }
        let info = null; try { info = fs.existsSync(path.join(outAbs, 'job.json')) ? readJob(p, outAbs) : null; } catch (e) { info = null; }
        let files = info?.files?.length ? info.files : []; if (!files.length) { try { files = fs.readdirSync(outAbs).filter(f => f.startsWith(jid + '_') && /\.(png|jpe?g|webp|mp4|mov|webm)$/i.test(f)).sort(); } catch (e) { /* none */ } }
        const rels = files.map(f => `${src.dir}/out/${jid}/${f}`), reg = rels.map(x => byPath.get(x.toLowerCase())).filter(Boolean);
        const kind = job.kind === 'video' ? (/^(mc|klingmc)$/i.test(job.model || '') || job.video ? 'motion' : 'shot-video') : 'image';
        const useIds = new Set(uses.filter(u => u.clip === jid).map(u => u.id)), sh = shotsAll.filter(s => (s.clips || []).some(c => useIds.has(c)));
        const cost = info?.cost || { status: 'unknown', usd: null, source: null };
        const refs = (Array.isArray(job.refs) ? job.refs : [job.image, job.video]).filter(x => typeof x === 'string').slice(0, 30);
        rows.push({ id: rid, kind, target: sh.length === 1 ? `shot:${sh[0].id}` : null, prompt: String(job.prompt || '').slice(0, 8000), refs, est_cost: Number(cost.usd) || 0,
          status: 'done', by: 'import', at: nowIso(), tool: info?.endpoint || job.model || null, ...(files.length > 1 ? { takes: files.length } : {}), outputs: reg.map(m => m.path), actual_cost_usd: Number(cost.usd) || 0,
          history: { source: 'falgen', book, job: jid, dir: `${src.dir}/out/${jid}`, files: files.length, registered: reg.length, ...(job.notes ? { notes: String(job.notes).slice(0, 2000) } : {}), ...(Array.isArray(job.after) ? { after: job.after.map(String).slice(0, 20) } : {}),
            ...(sh.length > 1 ? { shots: sh.map(s => s.id) } : {}), cost: { status: cost.status, source: cost.source, usd: cost.usd ?? null, counted: ['recorded', 'counted'].includes(cost.status), why: cost.why || null } },
          log: [{ at: nowIso(), by: 'director', via: dry_run ? 'agent' : 'page', status: 'done', history: true, why: `imported from the job book ${book}: never run again, no new cost` }], _media: reg.filter(m => !m.request && m.job !== rid).map(m => m.id) });
      }
    }
    const view = rows.map(({ _media, prompt, ...r }) => ({ id: r.id, kind: r.kind, target: r.target, book: r.history.book, files: r.history.files, registered: r.history.registered, cost: r.history.cost }));
    const summary = { books, imported: view, skipped, outputs_linked: rows.reduce((a, r) => a + r.outputs.length, 0), cost_usd_shown: +rows.reduce((a, r) => a + (r.actual_cost_usd || 0), 0).toFixed(3),
      not_counted_usd: +rows.filter(r => !r.history.cost.counted).reduce((a, r) => a + (r.actual_cost_usd || 0), 0).toFixed(3),
      note: 'history: status done, never run again; nothing is added to costs.json (the merged ledger counts falgen once). A job whose money is not counted yet: record it with cost_record (media_scan offers the args)' };
    if (dry_run) return { dry_run: true, ...summary };
    if (rows.length) {
      mutate(p, 'requests.json', (d) => { for (const { _media, ...r } of rows) if (!d.items.some(x => x.id === r.id)) d.items.push(r); });
      const link = rows.flatMap(r => r._media.map(m => [m, r.id]));
      if (link.length) withFileLock(path.join(projDir(p), 'media.json'), () => { const m = read(p, 'media.json'); for (const [mid, rid] of link) { const x = (m.items || []).find(y => y.id === mid); if (x && !x.request) x.request = rid; } write(p, 'media.json', m); });
    }
    return summary;
  },
});
