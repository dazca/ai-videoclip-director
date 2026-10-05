// The request runner (ROADMAP_v4 D3a images, D3b video, D3c retakes / stale locks): runs APPROVED generation requests through a generator plugin (generators/<id>.mjs:
// fal = the paid cloud, openwith = a prompt pack for another app, comfyui = a stub), one runner for the page's Run
// buttons, an agent's request_run and tools/run.mjs: the same approval rule, cap and ledger.
//   - only a request with a director approval on record runs (approved, or failed and retried: the approval holds);
//     a draft, rejected or done one is refused. The runner never approves anything;
//   - the cap is re-checked when it is claimed (request_update queued: spent + committed + this <= cap_usd), and the
//     generator's estimate must not exceed the est_cost the director approved;
//   - approved -> queued -> running -> done (outputs + actual cost) or failed (why); a handed-off request (openwith)
//     stays running until its results come back;
//   - outputs: data/<p>/gen/<request>/<id>_<take>.<ext> + job.json (private/gen/... when a ref is private); a take whose
//     file exists is skipped, a take already submitted is polled again instead of paid twice (re-run safe);
//   - the cap is checked again before every take is submitted (a cost recorded meanwhile can stop the next take);
//   - up to N at once (default 2; video requests in their own lane, 1 at a time by default); dry_run plans and checks
//     without any call, file or status change;
//   - video (D3b, js/video.js): the start frame (+ end frame) or the reference video go up to fal storage, priced per
//     second of output (video.seconds x $/s, the H3 promo by date), 25 min timeout per take, .mp4 outputs probed (fps,
//     duration in job.json and media.json): with a shot target they are that shot's takes (D6);
//   - retake (D3c): a done request with a failed take runs that take again (request_run retake: true, the Queue's
//     "Retry take N"), never the done ones; its cost is recorded once per take (costs.json item <request>#<take>), within
//     the approved est_cost and the cap;
//   - batches (D4, js/batches.js): a request in a batch runs only when its batch is approved (as a whole) and unlocked
//     (a gated batch waits until the director marks the batch before it reviewed): a locked batch never runs; the batch's
//     cap (max_usd) holds across its runs; request_run {batch} runs one batch, all: true runs batch by batch. A history
//     request (imported from a falgen job book) never runs;
//   - stale locks (a runner that died) are removed when a plan is made: a lock whose process is gone or whose heartbeat
//     (refreshed while polling) is older than 10 min;
//   - the actual cost is recorded ONCE, by request_update done (costs.json item id = the request id, via "runner"), which
//     the merged ledger (costs_get) counts once; outputs are registered as media and linked to the request's asset tree
//     (asset_iteration_add: nodes the director keeps or picks; a node_import_propose proposal when a tree refuses).
// The fal key: env FAL_KEY, else workbench.config.json fal_key_file (a file outside the workbench and the data folder).
// It goes only into the generator's Authorization header: never logged, returned, or written to job.json; every error
// message is redacted before it is stored or shown.
// THIS module talks to the network (the generators); lib/ops/ itself never does.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CFG, DATA_ROOT, IMAGE, VIDEO, RUNNABLE, WB_DIR, appendCost, approvalOk, privateUploadOk, fail, ffprobe, isFlaggedPrivate, isMediaRootPath, isPrivate, mutate, nowIso, ops, projDir, read, readJSON, timeOfKey, writeJSON } from './ops/_shared.mjs';
import { refFile } from './ops/assets.mjs';
import { registerOutput } from './ops/requests.mjs';
import { MODELS as VIDEO_MODELS, videoOf, videoRefs } from '../js/video.js';
import * as A from '../js/assets.js';
import * as BT from '../js/batches.js';
import { genKindOf } from '../js/prices.js';
import fal from '../generators/fal.mjs';
import openwith from '../generators/openwith.mjs';
import comfyui from '../generators/comfyui.mjs';

export const GENERATORS = { fal, openwith, comfyui };
export const GEN_KINDS = ['image', 'video', 'motion'];
export const runEvents = new EventEmitter();   // serve.mjs forwards these to the open pages (SSE {project, run})
const TEST = process.env.WB_TEST === '1';
const POLL_MS = (TEST && Number(process.env.WB_RUN_POLL_MS)) || 4000;
const TIMEOUT_MS = (TEST && Number(process.env.WB_RUN_TIMEOUT_MS)) || 25 * 60 * 1000;   // falgen's 1500 s
const STALE_MS = (TEST && Number(process.env.WB_RUN_STALE_MS)) || 10 * 60 * 1000;      // a lock without a heartbeat for this long is stale
// the price date (the H3 promo ends on its day): today; tests may set WB_TEST_DATE (only with WB_TEST=1)
const priceDate = () => (TEST && process.env.WB_TEST_DATE) || undefined;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const r4 = (x) => +Number(x || 0).toFixed(4);

// ------------------------------------------------------------------ the key (never leaves this module except into a generator call)
const within = (root, abs) => { const r = path.relative(root, abs); return !r.startsWith('..') && !path.isAbsolute(r); };
export function falKey() {
  const env = String(process.env.FAL_KEY || '').trim();
  if (env) return { key: env, source: 'the environment (FAL_KEY)' };
  if (!CFG.falKeyFile) return { key: null, source: null };
  const abs = path.resolve(CFG.file ? path.dirname(CFG.file) : WB_DIR, CFG.falKeyFile);
  if (within(WB_DIR, abs) || within(DATA_ROOT, abs)) return { key: null, source: null, why: 'fal_key_file must be outside the workbench folder and the data folder (never a project file)' };
  const relBase = path.relative(CFG.mediaBase, abs).split(path.sep).join('/');
  if (!relBase.startsWith('..') && isMediaRootPath(relBase)) return { key: null, source: null, why: 'fal_key_file must not be under a served media root' };
  let text = ''; try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return { key: null, source: null, why: 'fal_key_file could not be read' }; }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const kv = lines.find(l => /^FAL_KEY\s*=/.test(l)), key = (kv ? kv.replace(/^FAL_KEY\s*=\s*/, '') : lines.length === 1 && !lines[0].includes('=') ? lines[0] : '').replace(/^["']|["']$/g, '').trim();
  return key ? { key, source: 'fal_key_file (workbench.config.json)' } : { key: null, source: null, why: 'fal_key_file has no FAL_KEY= line' };
}
const redactor = (key) => (s) => { s = String(s ?? ''); return key && key.length >= 4 ? s.split(key).join('***') : s; };

// ------------------------------------------------------------------ which generator runs a request
export { genKindOf };
// Settings > Generator (settings.json generators {image, video, motion}; default fal)
export function selectedGenerators(p) {
  const s = read(p, 'settings.json')?.generators || {};
  return Object.fromEntries(GEN_KINDS.map(k => [k, GENERATORS[s[k]] ? s[k] : 'fal']));
}
// a handed-off request stays with the generator it went to (switching Settings must never send it to a paid one)
export function generatorFor(p, req) { const kind = genKindOf(req), h = req?.handoff?.generator, id = GENERATORS[h] ? h : selectedGenerators(p)[kind]; return { kind, id, gen: GENERATORS[id] }; }
const genCtx = (id) => { if (id !== 'fal') return {}; const k = falKey(); return { key: k.key, keySource: k.source, keyWhy: k.why }; };
// for Settings > Generator and the tools: every generator, whether it is ready, the selection per kind (never the key)
export function generatorsInfo(p) {
  const k = falKey();
  return { selected: selectedGenerators(p), kinds: GEN_KINDS,
    generators: Object.values(GENERATORS).map(g => { const c = g.configured(g.id === 'fal' ? { keySource: k.source } : {}); return { id: g.id, label: g.label, kinds: g.kinds, ready: c.ok, why: g.id === 'fal' && !c.ok && k.why ? `${c.why} (${k.why})` : c.why }; }),
    fal_key: k.source ? { found: true, source: k.source } : { found: false, ...(k.why ? { why: k.why } : {}) },
    built: { image: ['fal (nb2, seedream)', 'openwith'], video: ['fal (h3max, kling3pro: start + end frame, per second)', 'openwith'], motion: ['fal (klingmc: a reference video, per second)', 'openwith'] } };
}

// ------------------------------------------------------------------ outputs
const privateReq = (p, r) => (r.refs || []).some(x => isPrivate(x) || isFlaggedPrivate(x, [p]));
function outDir(p, r) { const rel = `${privateReq(p, r) ? 'private/' : ''}gen/${r.id}`; return { rel, abs: path.join(projDir(p), ...rel.split('/')) }; }
const OUT_RE = (id) => new RegExp(`^${id}_(\\d+)\\.(png|jpe?g|webp|mp4)$`, 'i');
function haveTakes(abs, id) { try { return fs.readdirSync(abs).map(n => [n, OUT_RE(id).exec(n)]).filter(([, m]) => m).map(([n, m]) => ({ take: Number(m[1]), name: n })).sort((a, b) => a.take - b.take); } catch (e) { return []; } }
const isMp4Bytes = (b) => b.length > 12 && b.slice(4, 8).toString() === 'ftyp';   // MP4 / MOV: an ftyp box first
const isImageBytes = (b) => b.length > 12 && ((b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0xff && b[1] === 0xd8) || (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP'));

// ------------------------------------------------------------------ plan (what a run would do; also the dry run)
// the takes of a done request that failed (job.json) and have no file: what a retake runs again
export function failedTakes(p, r) {
  const out = outDir(p, r), have = new Set(haveTakes(out.abs, r.id).map(x => x.take)), job = readJSON(path.join(out.abs, 'job.json'), null);
  return (job?.takes || []).map((t, i) => (t && t.status === 'failed' && !have.has(i) ? i : null)).filter(x => x != null);
}
export function planOne(p, r, costs, { retake = false } = {}) {
  if (!r) return { ok: false, why: 'no such request' };
  const base = { id: r.id, kind: r.kind, target: r.target || null, status: r.status, approved_usd: Number(r.est_cost) || 0 };
  const no = (why) => ({ ...base, ok: false, why });
  if (!ID_RE.test(r.id)) return no('bad request id');
  if (BT.isHistory(r)) return no(`history: imported from the job book ${r.history.book || ''} (done before the workbench); it never runs again`);
  const retaking = retake && r.status === 'done';
  if (retake && !retaking) return no(`${r.status}: retake runs the failed takes of a DONE request (an approved or failed one runs with a plain run)`);
  if (!retaking && !RUNNABLE.includes(r.status)) return no(r.status === 'draft' ? 'draft: only approved requests run; the director approves it in Review > Queue (an agent cannot)'
    : r.status === 'done' && failedTakes(p, r).length ? `done, with failed take${failedTakes(p, r).length > 1 ? 's' : ''} ${failedTakes(p, r).join(', ')}: run it with retake: true to run only those again (the done takes are kept)` : `${r.status}: only approved requests run`);
  if (!approvalOk(r)) return no('no director approval on record (approved in the page after its last draft): the director approves it in Review > Queue');
  const { kind, id: gid, gen } = generatorFor(p, r), ctx = genCtx(gid);
  const conf = gen.configured(ctx); if (!conf.ok) return no(`generator ${gid}: ${conf.why}${ctx.keyWhy ? ` (${ctx.keyWhy})` : ''}`);
  const sup = gen.supports(r); if (!sup.ok) return no(`generator ${gid}: ${sup.why}`);
  const est = gen.estimate(r, { date: priceDate() });
  if (est.usd == null) return no(`generator ${gid}: no estimate (${est.why})`);
  if (!retaking && est.usd > base.approved_usd + 0.005) return no(`the run would cost $${r4(est.usd)} (${est.why}) but $${base.approved_usd} was approved: correct est_cost with request_update (it goes back to draft) and ask the director to approve it again`);
  const refs = [], missing = [];
  for (const x of r.refs || []) { const abs = refFile(p, x); if (!abs) missing.push(x); else refs.push({ rel: x, abs }); }
  if (missing.length) return no(`refs not found: ${missing.join(', ')}`);
  const vm = VIDEO_MODELS[est.model] ? est.model : null, v = vm ? videoOf(r, vm) : null;
  if (gid === 'fal' && !vm && refs.some(x => !IMAGE.test(x.abs))) return no('fal images take image refs only (a video ref goes with a video model: video.ref_video, motion control)');
  if (gid === 'fal' && vm) {
    // the files the payload names must be the ones uploaded (refs = start, end, reference video, in that order)
    const want = videoRefs(v);
    if (want.join('|') !== (r.refs || []).join('|')) return no(`refs must be the video's files in order (start frame${v.end ? ', end frame' : ''}${v.ref_video ? ', reference video' : ''}: ${want.join(', ')}): request_update video {...} sets them (it goes back to draft)`);
    if (refs.some(x => x.rel !== v.ref_video && !IMAGE.test(x.abs)) || (v.ref_video && !VIDEO.test(refFile(p, v.ref_video) || ''))) return no('the start / end frames must be images and the reference video a video file');
    // motion control: the output is as long as the reference clip, billed per second: the approved seconds must cover it
    if (v.ref_video) { const d = ffprobe(refFile(p, v.ref_video)).dur; if (d && Math.ceil(d - 0.25) > v.seconds) return no(`the reference video is ${d.toFixed(1)} s but ${v.seconds} s were approved: fal bills the output seconds (as long as the clip); set video.seconds to ${Math.ceil(d - 0.25)} (request_update: back to draft) or trim the clip`); }
  }
  // fal takes refs as URLs: each one is uploaded to fal's storage (a public CDN URL). A private ref (a real photo) leaves
  // this machine only with the director's tick in Review > Queue, "allow uploading private refs" (never an agent's)
  const priv = refs.filter(x => isPrivate(x.rel) || isFlaggedPrivate(x.rel, [p]));
  if (gid === 'fal' && priv.length && !privateUploadOk(r)) return no(`${priv.length} private ref${priv.length > 1 ? 's' : ''} (${priv.map(x => x.rel).join(', ')}) would be uploaded to fal storage (a public URL): the director ticks "allow uploading private refs" on this request in Review > Queue, or the refs change`);
  const out = outDir(p, r), have = haveTakes(out.abs, r.id);
  const vinfo = v ? { video: { model: v.model, seconds: v.seconds, start: v.start, end: v.end, ref_video: v.ref_video, ...(v.orientation ? { orientation: v.orientation } : {}), per_s: est.per_s } } : {};
  if (retaking) {
    // a retake: only the failed takes, within what was approved (the done takes + these <= est_cost) and the cap
    const takes = failedTakes(p, r); if (!takes.length) return no('done, and no take failed: nothing to retake');
    const usd = r4(est.per_take * takes.length), paid = Number(r.actual_cost_usd) || 0;
    if (paid + usd > base.approved_usd + 0.005) return no(`retaking ${takes.length} take${takes.length > 1 ? 's' : ''} ($${usd}) on top of the $${paid} spent would pass the $${base.approved_usd} approved: ask the director for a new request`);
    const fits = !!costs.cap_usd && costs.total_spent_usd + costs.committed_usd + usd <= costs.cap_usd + 1e-9;
    return { ...base, ok: true, retake: takes, generator: gid, gen_kind: kind, model: est.model, tool: est.tool, takes: est.takes, per_take_usd: est.per_take, est_usd: usd, why: `retake ${takes.join(', ')}: ${est.why}`, ...vinfo,
      refs: refs.map(x => x.rel), out_dir: out.rel, have_takes: have.map(x => x.take), resume: true, cap: { fits, spent_usd: costs.total_spent_usd, committed_others_usd: costs.committed_usd, cap_usd: costs.cap_usd } };
  }
  // the cap as request_update queued will check it: spent + every other committed request + this one's approved estimate
  const live = ['approved', 'queued', 'running'].includes(r.status), others = r4(costs.committed_usd - (live ? base.approved_usd : 0));
  const fits = !costs.cap_usd ? base.approved_usd === 0 : costs.total_spent_usd + others + base.approved_usd <= costs.cap_usd + 1e-9;
  return { ...base, ok: true, generator: gid, gen_kind: kind, model: est.model, tool: est.tool, takes: est.takes, per_take_usd: est.per_take, est_usd: r4(est.usd), why: est.why, ...vinfo,
    refs: refs.map(x => x.rel), out_dir: out.rel, have_takes: have.map(x => x.take), resume: ['queued', 'running'].includes(r.status) || r.status === 'failed',
    cap: { fits: ['queued', 'running'].includes(r.status) || fits, spent_usd: costs.total_spent_usd, committed_others_usd: others, cap_usd: costs.cap_usd } };
}
export function planRun(p, { ids, all, batch, retake = false, clean = true } = {}) {
  const stale = clean ? cleanStaleLocks(p) : [];
  const doc = read(p, 'requests.json'), R = doc.items || [], costs = ops.costs_get(p);
  let list = ids;
  if (batch != null) {
    const b = BT.batchById(doc, batch); if (!b) fail(404, `no batch "${String(batch).slice(0, 40)}"`);
    list = (b.request_ids || []).filter(id => { const r = R.find(x => x.id === id); return r && (retake ? r.status === 'done' && failedTakes(p, r).length : !['done', 'rejected', 'withdrawn'].includes(r.status)); });
  } else if (all) {
    list = R.filter(r => (retake ? r.status === 'done' && failedTakes(p, r).length : r.status === 'approved')).map(r => r.id);
    // batch by batch: the requests of earlier batches first (in no batch: first)
    const order = (id) => BT.batchesOf(doc).findIndex(b => (b.request_ids || []).includes(id));
    list = list.map((id, k) => [id, k]).sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1]).map(x => x[0]);
  }
  if (!Array.isArray(list) || (!list.length && !all && batch == null)) fail(400, 'ids: the approved request ids to run (or all: true for every approved one, or batch: a batch id)');
  // batches (D4): a locked or unapproved batch never runs (said first: it is why the request waits)
  const items = [...new Set(list.map(String))].map(id => {
    const r = R.find(x => x.id === id); if (!r) return { id, ok: false, why: `no request "${id}"` };
    const why = BT.gateRefusal(doc, id); if (why) return { id, kind: r.kind, target: r.target || null, status: r.status, ok: false, why };
    return planOne(p, r, costs, { retake });
  });
  // each batch's cap (max_usd) minus what it spent and what of it is running already bounds this run
  const budget = new Map();
  for (const x of items) {
    if (!x.ok) continue;
    const b = BT.batchOfRequest(doc, x.id); if (!b || b.max_usd == null) continue;
    if (!budget.has(b.id)) { const bt = BT.batchTotals(b, doc), live = BT.requestsOf(b, doc).filter(r => BT.LIVE.includes(r.status) && !items.some(i => i.id === r.id)); budget.set(b.id, b.max_usd - bt.spent_usd - live.reduce((s, r) => s + (Number(r.est_cost) || 0), 0)); }
    const left = budget.get(b.id);
    if (x.est_usd > left + 1e-9) { x.ok = false; x.why = `over the batch cap of ${b.name || b.id}: ${x.est_usd.toFixed(3)} > ${Math.max(0, left).toFixed(3)} left of max_usd ${b.max_usd} (the director raises it in Review › Queue)`; continue; }
    budget.set(b.id, left - x.est_usd); x.batch = b.id;
  }
  const ok = items.filter(x => x.ok), total = r4(ok.reduce((s, x) => s + x.est_usd, 0));
  return { items, runnable: ok.length, est_total_usd: total, ...(batch != null ? { batch } : {}), ...(retake ? { retake: true } : {}), ...(stale.length ? { stale_locks_removed: stale } : {}), costs: { cap_usd: costs.cap_usd, total_spent_usd: costs.total_spent_usd, committed_usd: costs.committed_usd, remaining_usd: costs.remaining_usd } };
}

// ------------------------------------------------------------------ locks (one runner per request, across processes)
// .lock = {pid, at, beat (ms: refreshed while the run polls)}. Stale = its process is gone (or it is this process but no
// run of ours holds it), or no heartbeat for STALE_MS (a hung or killed runner whose pid was reused)
const active = new Set();
function lockStale(f, key) {
  const o = readJSON(f, {}) || {};
  if (o.pid === process.pid) return !active.has(key);
  let alive = false; try { if (o.pid) { process.kill(o.pid, 0); alive = true; } } catch (er) { alive = er.code === 'EPERM'; }
  const beat = Number(o.beat) || Date.parse(o.at ? o.at + 'Z' : '') || 0;
  return !alive || (beat && Date.now() - beat > STALE_MS);
}
function lock(abs, key) {
  if (active.has(key)) return false;
  fs.mkdirSync(abs, { recursive: true });
  const f = path.join(abs, '.lock');
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: nowIso(), beat: Date.now() }), { flag: 'wx' }); active.add(key); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (!lockStale(f, key)) return false;
      fs.rmSync(f, { force: true });   // left by a runner that is gone: take it over
    }
  }
  return false;
}
function heartbeat(abs) { try { fs.writeFileSync(path.join(abs, '.lock'), JSON.stringify({ pid: process.pid, at: nowIso(), beat: Date.now() })); } catch (e) { /* the folder went away */ } }
function unlock(abs, key) { active.delete(key); fs.rmSync(path.join(abs, '.lock'), { force: true }); }
// remove the stale locks of a project (gen/*/.lock and private/gen/*/.lock) and clear a retake marker no run holds
// -> [request ids whose lock was removed]
export function cleanStaleLocks(p) {
  const out = [];
  for (const rel of ['gen', 'private/gen']) {
    const dir = path.join(projDir(p), ...rel.split('/'));
    let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && ID_RE.test(d.name)).map(d => d.name); } catch (e) { continue; }
    for (const id of names) { const f = path.join(dir, id, '.lock'); if (fs.existsSync(f) && lockStale(f, `${p}/${id}`)) { fs.rmSync(f, { force: true }); out.push(id); } }
  }
  const R = read(p, 'requests.json').items || [];
  if (R.some(r => r.retaking && !active.has(`${p}/${r.id}`) && !fs.existsSync(path.join(outDir(p, r).abs, '.lock')))) {
    try { mutate(p, 'requests.json', (d) => { for (const r of d.items) if (r.retaking && !active.has(`${p}/${r.id}`) && !fs.existsSync(path.join(outDir(p, r).abs, '.lock'))) delete r.retaking; }); } catch (e) { /* busy: next time */ }
  }
  return out;
}

// ------------------------------------------------------------------ run
const emit = (p, id, x) => runEvents.emit('run', { project: p, run: { id, at: nowIso(), ...x } });
async function download(src, dest) {
  let bytes;
  if (src.file) bytes = fs.readFileSync(src.file);
  else { const r = await fetch(src.url, { signal: AbortSignal.timeout(600000) }); if (!r.ok) throw new Error(`download ${r.status}`); bytes = Buffer.from(await r.arrayBuffer()); }
  if (/\.mp4$/i.test(dest) ? !isMp4Bytes(bytes) : !isImageBytes(bytes)) throw new Error(/\.mp4$/i.test(dest) ? 'the output is not an MP4 video' : 'the output is not an image (PNG / JPEG / WebP)');
  fs.writeFileSync(dest, bytes);
}
// the cap before a take is submitted: spent (now, every source) + committed (this request's approved estimate among them)
// must stay within the cap; a retake (not committed: the request is done) adds its own take
function capBeforeTake(p, extra = 0) {
  const c = ops.costs_get(p);
  return !c.cap_usd || c.total_spent_usd + c.committed_usd + extra > c.cap_usd + 1e-9 ? `over the cap before this take: spent $${c.total_spent_usd} + committed $${c.committed_usd}${extra ? ` + this take $${extra}` : ''} > cap $${c.cap_usd}` : null;
}

export async function runOne(p, plan, { by = 'runner' } = {}) {
  const red = redactor(falKey().key), id = plan.id, key = `${p}/${id}`;
  const r0 = (read(p, 'requests.json').items || []).find(x => x.id === id);
  const { gen, id: gid } = generatorFor(p, r0), out = outDir(p, r0), retake = Array.isArray(plan.retake) ? plan.retake : null;
  const clearRetake = () => { if (retake) try { mutate(p, 'requests.json', (d) => { const x = d.items.find(i => i.id === id); if (x) delete x.retaking; }); } catch (e) { /* stale cleanup clears it */ } };
  if (!lock(out.abs, key)) return { id, status: 'skipped', why: 'already running (another run holds it)' };   // (its retake marker is the holder's)
  const jobFile = path.join(out.abs, 'job.json'), job = readJSON(jobFile, null) || { request: id, generator: gid, model: plan.model, endpoint: plan.tool, refs: plan.refs, takes: [], started: nowIso() };
  const saveJob = () => writeJSON(jobFile, job);   // key-free by construction (handles, URLs, errors are redacted)
  try {
    // claim: queued re-checks the approval and the cap (402 over the cap), then running. A retake does not move the done
    // request: its approval is checked again here, the cap before its take
    let r = r0;
    if (retake) { if (r.status !== 'done' || !approvalOk(r)) throw Object.assign(new Error('retake: the request is not done on a director approval'), { code: 403 }); }
    else {
      if (['approved', 'failed'].includes(r.status)) r = ops.request_update(p, { id, status: 'queued', by }).request;
      if (r.status === 'queued') r = ops.request_update(p, { id, status: 'running', by }).request;
    }
    emit(p, id, { phase: 'running', takes: plan.takes, generator: gid, ...(retake ? { retake } : {}), ...(plan.video ? { video: { model: plan.video.model, seconds: plan.video.seconds } } : {}) });
    Object.assign(job, { generator: gid, model: plan.model, endpoint: plan.tool, est_usd: retake ? job.est_usd ?? plan.est_usd : plan.est_usd, price_why: plan.why, by, resumed_at: job.takes.length ? nowIso() : undefined, ...(plan.video ? { video: plan.video } : {}) });
    if (retake) (job.retakes ||= []).push({ at: nowIso(), takes: retake, by });
    const ctx = { ...genCtx(gid), dir: out.abs, projectDir: projDir(p), refFiles: (r.refs || []).map(x => refFile(p, x)), date: priceDate() };
    let handedOff = null; const newFiles = [];
    for (let t = 0; t < plan.takes; t++) {
      if (retake && !retake.includes(t)) continue;   // a retake: the done takes are never run again
      const have = haveTakes(out.abs, id).find(x => x.take === t);
      if (have) { job.takes[t] = { ...(job.takes[t] || {}), take: t, status: 'done', file: have.name, usd: job.takes[t]?.usd ?? plan.per_take_usd, skipped: true }; emit(p, id, { phase: 'skip', take: t, takes: plan.takes }); continue; }
      let tk = job.takes[t] || { take: t };
      if (retake && tk.status === 'failed') tk = tk.handle && !tk.provider_failed ? { take: t, handle: tk.handle, status: 'submitted', submitted_at: tk.submitted_at } : { take: t };
      try {
        if (!tk.handle) {
          // the cap again before every paid submit (a cost recorded since the claim can stop the next take)
          if (gid === 'fal') { const over = capBeforeTake(p, retake ? plan.per_take_usd : 0); if (over) throw Object.assign(new Error(over), { cap: true }); }
          if (gid === 'fal' && ctx.refFiles.length && !job.ref_urls) {   // the refs go to fal's CDN once per request
            emit(p, id, { phase: 'upload', take: t, takes: plan.takes });
            job.ref_urls = []; for (const f of ctx.refFiles) job.ref_urls.push(await gen.upload(f, ctx)); saveJob();
          }
          ctx.refUrls = job.ref_urls || [];
          emit(p, id, { phase: 'submit', take: t, takes: plan.takes });
          tk = { take: t, status: 'submitted', handle: await gen.submit(r, ctx), submitted_at: nowIso() };
          job.takes[t] = tk; saveJob();
        }
        const t0 = Date.now(); let st;
        for (;;) {
          heartbeat(out.abs);
          st = await gen.poll(tk.handle, ctx).catch(e => ({ status: 'error', error: e.message }));
          if (st.status === 'done' || st.status === 'failed' || st.status === 'waiting') break;
          emit(p, id, { phase: st.status === 'error' ? 'retrying' : st.status, take: t, takes: plan.takes, s: Math.round((Date.now() - t0) / 1000) });
          if (Date.now() - t0 > TIMEOUT_MS) { st = { status: 'failed', timeout: true, error: `timeout after ${Math.round(TIMEOUT_MS / 60000)} min (the job may still finish at the provider: run it again to poll it, not pay again)` }; break; }
          await sleep(POLL_MS);
        }
        if (st.status === 'waiting') { handedOff = tk.handle; tk.status = 'handed_off'; job.takes[t] = tk; break; }
        // the provider said failed: a retry submits again; a timeout keeps the handle (a retry polls it, never pays twice)
        if (st.status === 'failed') throw Object.assign(new Error(st.error || 'failed at the provider'), { provider: !st.timeout });
        const files = await gen.fetch(tk.handle, ctx);
        const names = [];
        for (const [k, f] of files.entries()) { const n = `${id}_${t + k}.${f.ext || 'png'}`; await download(f, path.join(out.abs, n)); names.push(n); }
        // a video: its frame rate and length (job.json; media.json gets them again when it is registered)
        const pr = /\.mp4$/i.test(names[0]) ? ffprobe(path.join(out.abs, names[0])) : null;
        job.takes[t] = { ...tk, status: 'done', file: names[0], ...(names.length > 1 ? { files: names } : {}), usd: plan.per_take_usd, ...(plan.video ? { seconds: plan.video.seconds } : {}), ...(pr ? { fps: pr.fps, duration_ms: pr.dur != null ? Math.round(pr.dur * 1000) : null } : {}), done_at: nowIso() };
        newFiles.push({ take: t, names });
        if (names.length > 1) t += names.length - 1;
        emit(p, id, { phase: 'take_done', take: t, takes: plan.takes });
      } catch (e) {
        job.takes[t] = { ...(e.provider ? {} : tk), take: t, status: 'failed', ...(e.provider ? { provider_failed: true } : {}), ...(e.cap ? { cap: true } : {}), error: red(e.message).slice(0, 500), failed_at: nowIso() };
        emit(p, id, { phase: 'take_failed', take: t, takes: plan.takes, error: red(e.message).slice(0, 200) });
      }
      saveJob();
    }
    if (retake) return finishRetake(p, id, plan, job, saveJob, newFiles, out, by);
    if (handedOff) {
      job.handoff = handedOff; saveJob();
      mutate(p, 'requests.json', (d) => { const x = d.items.find(i => i.id === id); if (x) Object.assign(x, { handoff: { generator: gid, ...handedOff }, at: nowIso() }); });
      emit(p, id, { phase: 'handed_off', pack: handedOff.pack });
      return { id, status: 'handed_off', pack: handedOff.pack, results: handedOff.results, note: 'make the images in the other app, save them in the results folder, then run this request again' };
    }
    const done = haveTakes(out.abs, id), outputs = done.map(x => `${out.rel}/${x.name}`);
    const usd = r4(job.takes.filter(x => x?.status === 'done').reduce((s, x) => s + (Number(x.usd) || 0), 0));
    job.finished = nowIso(); job.actual_usd = usd; saveJob();
    if (!outputs.length) {
      const why = red(job.takes.map(x => x?.error).filter(Boolean).join('; ') || 'no output').slice(0, 900);
      ops.request_update(p, { id, status: 'failed', why, by });
      emit(p, id, { phase: 'failed', why });
      return { id, status: 'failed', why };
    }
    const res = ops.request_update(p, { id, status: 'done', outputs, actual_cost_usd: usd, tool: plan.tool, generator: gid, by });
    const linked = linkOutputs(p, res.request, by);
    const failedT = job.takes.map((x, i) => (x?.status === 'failed' ? i : null)).filter(x => x != null);
    mutate(p, 'requests.json', (d) => { const x = d.items.find(i => i.id === id); if (x) { x.generator = gid; if (linked) x.linked = linked; if (failedT.length) x.takes_failed = failedT; else delete x.takes_failed; } });
    emit(p, id, { phase: 'done', outputs: res.request.outputs, usd, linked });
    return { id, status: 'done', outputs: res.request.outputs, actual_cost_usd: usd, takes_failed: job.takes.filter(x => x?.status === 'failed').length, linked };
  } catch (e) {
    const why = red(e.message).slice(0, 900);
    emit(p, id, { phase: 'refused', why, code: e.code });
    // claimed (running) but crashed before any take: back to failed so it can be retried; a refused claim (402 cap,
    // 403 approval) leaves the request as it was
    try { const cur = (read(p, 'requests.json').items || []).find(x => x.id === id); if (cur?.status === 'running' || cur?.status === 'queued') ops.request_update(p, { id, status: 'failed', why, by }); } catch (er) { /* leave it */ }
    const status = e.code === 402 || e.code === 403 ? 'refused' : 'failed';
    // the Queue and request_run (wait) read why the last run did not start
    try { mutate(p, 'requests.json', (d) => { const x = d.items.find(i => i.id === id); if (x) x.last_run = { at: nowIso(), status, why: why.slice(0, 300) }; }); } catch (er) { /* leave it */ }
    return { id, status, code: e.code || 500, why };
  } finally { unlock(out.abs, key); clearRetake(); }
}

// a retake's end: the new outputs registered as media (takes of the shot / request), linked to the asset tree, each take's
// cost recorded once (costs.json <request>#<take>, via runner), the request's outputs / actual cost / takes_failed updated;
// it stays done
function finishRetake(p, id, plan, job, saveJob, newFiles, out, by) {
  const cur = (read(p, 'requests.json').items || []).find(x => x.id === id), t0 = timeOfKey(p, cur.target) ?? 0;
  const added = [], recorded = [];
  for (const { take, names } of newFiles) {
    const usd = plan.per_take_usd;
    if (appendCost(p, { id: `${id}#${take}`, t: t0, usd, tool: plan.tool, date: nowIso().slice(0, 10), request: id, take, via: 'runner', generator: plan.generator, job: id, retake: true }, (x) => x.id === `${id}#${take}` || (x.request === id && x.take === take))) recorded.push({ take, usd });
    for (const n of names) { const rel = `${out.rel}/${n}`; try { added.push(registerOutput(p, cur, rel, { take, usd: +(usd / names.length).toFixed(3) }).path); } catch (e) { added.push(rel); } }
  }
  const usd = r4(recorded.reduce((s, x) => s + x.usd, 0));
  const failedT = job.takes.map((x, i) => (x?.status === 'failed' ? i : null)).filter(x => x != null);
  job.finished = nowIso(); job.actual_usd = r4((Number(job.actual_usd) || 0) + usd); saveJob();
  const linked = added.length ? linkOutputs(p, { ...cur, outputs: added }, by) : null;
  mutate(p, 'requests.json', (d) => {
    const x = d.items.find(i => i.id === id); if (!x) return;
    const tk = (o) => Number(/_(\d+)\.[a-z0-9]+$/i.exec(o)?.[1] ?? 1e9);
    x.outputs = [...new Set([...(x.outputs || []), ...added])].sort((a, b) => tk(a) - tk(b));x.actual_cost_usd = r4((Number(x.actual_cost_usd) || 0) + usd);
    if (failedT.length) x.takes_failed = failedT; else delete x.takes_failed;
    if (linked) x.linked = { ...(x.linked || linked), nodes: [...(x.linked?.nodes || []), ...linked.nodes], proposals: [...(x.linked?.proposals || []), ...linked.proposals] };
    delete x.retaking; x.at = nowIso();
    (x.log ||= []).push({ at: nowIso(), by, via: 'agent', retake: plan.retake, done: newFiles.map(f => f.take), usd });
  });
  const why = failedT.length ? job.takes.filter(x => x?.status === 'failed').map(x => x.error).join('; ').slice(0, 300) : undefined;
  emit(p, id, { phase: 'done', retake: plan.retake, outputs: added, usd, ...(why ? { why } : {}) });
  return { id, status: added.length ? 'done' : 'failed', retake: plan.retake, outputs: added, actual_cost_usd: usd, takes_failed: failedT.length, ...(why ? { why } : {}) };
}

// the outputs join the request's asset tree as nodes (the first one is the head of an empty tree; later ones wait for
// the director to keep or pick); a tree that refuses (locked, a look before the identity) gets an import proposal
function linkOutputs(p, r, by) {
  const link = A.linkOf(r); if (!link) return null;
  const type = link.type || 'character', nodes = [], proposals = [], warnings = [];
  const media = read(p, 'media.json').items || [];
  for (const o of r.outputs || []) {
    try { const x = ops.asset_iteration_add(p, { type, id: link.id, request: r.id, image: o, by }); nodes.push(x.node.id); }
    catch (e) {
      const m = media.find(x => x.path === o) || (read(p, 'media.json').items || []).find(x => x.path === o);
      if (!m) { warnings.push(`${o}: ${e.message}`); continue; }
      try { const x = ops.node_import_propose(p, { type, id: link.id, tree: link.tree, media: m.id, why: `output of the approved request ${r.id} (${r.tool || r.kind}); not added as a node: ${e.message}`, by }); proposals.push(x.proposal.id); }
      catch (er) { warnings.push(`${o}: ${er.message}`); }
    }
  }
  return { type, id: link.id, tree: link.tree, nodes, proposals, ...(warnings.length ? { warnings } : {}) };
}

// run a plan's runnable requests: images N at once (parallel, default 2), video in its own lane (video_parallel, default
// 1: a take runs for minutes and costs dollars)
export async function runPlan(p, plan, { parallel = 2, video_parallel = 1, by = 'runner' } = {}) {
  const ok = plan.items.filter(x => x.ok), results = [];
  const lane = (queue, n) => Array.from({ length: Math.min(n, queue.length) }, async () => { for (let x; (x = queue.shift());) results.push(await runOne(p, x, { by })); });
  const vids = ok.filter(x => x.video), imgs = ok.filter(x => !x.video);
  await Promise.all([...lane(imgs, Math.max(1, Math.min(4, Number(parallel) || 2))), ...lane(vids, Math.max(1, Math.min(4, Number(video_parallel) || 1)))]);
  return results;
}
