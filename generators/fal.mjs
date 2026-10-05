// fal.ai generator (D3a: images): Nano Banana 2 (edit with refs, text-to-image without) and Seedream 5.0 Pro edit,
// through fal's queue API, the calls ported from ../project/gen/falgen.py (which runs in production):
//   submit   POST {QUEUE}/<endpoint>               {prompt, image_urls, ...}  -> {request_id, status_url, response_url}
//   status   GET  status_url                                                  -> {status: IN_QUEUE | IN_PROGRESS | COMPLETED}
//   response GET  response_url                                                -> {images: [{url, content_type}]}
//   refs     POST {STORAGE}/storage/upload/initiate?storage_type=fal-cdn-v3 {content_type, file_name} -> {upload_url, file_url},
//            then PUT the bytes to upload_url (fal's CDN; the request then names the file_url)
// The key travels only in the Authorization header of these calls, and only to the queue / storage origins (a
// status_url or response_url on another origin gets no key). It is never logged, returned or written: the handle,
// job.json and every error message are key-free (the runner redacts errors once more).
// Tests: WB_FAL_BASE points the queue AND the storage at a mock server, and only when WB_TEST=1 (tools/mock-fal.mjs).
// Video (h3, kling, motion control) is D3b: refused here with a clear message.
import fs from 'node:fs';
import path from 'node:path';
import { PRICES, price, modelOf } from '../js/prices.js';
export { modelOf };

const TEST = process.env.WB_TEST === '1' && process.env.WB_FAL_BASE;
export const QUEUE = TEST ? process.env.WB_FAL_BASE.replace(/\/+$/, '') : 'https://queue.fal.run';
export const STORAGE = TEST ? process.env.WB_FAL_BASE.replace(/\/+$/, '') : 'https://rest.alpha.fal.ai';
const ORIGINS = new Set([new URL(QUEUE).origin, new URL(STORAGE).origin]);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const SIZE = { '16:9': [2560, 1440], '9:16': [1440, 2560], '3:4': [1728, 2304], '1:1': [2048, 2048], '4:3': [2304, 1728] };   // seedream image_size (falgen)
const NB2_T2I = 'fal-ai/nano-banana-2';

const takesOf = (req) => Math.max(1, Math.min(8, Number(req?.takes) || 1));
const isEdit = (req) => /edit/.test(String(req?.kind || '')) || req?.asset?.kind === 'edit';
const nb2Tier = (req) => (['1K', '2K'].includes(req?.resolution) ? req.resolution : isEdit(req) ? '1K' : '2K');

export default {
  id: 'fal', label: 'fal.ai (cloud, paid)', kinds: ['image'],
  // key present? (the runner resolves it; this only says whether one was found and from where, never the key)
  configured(ctx) { return ctx?.keySource ? { ok: true, why: `key from ${ctx.keySource}` } : { ok: false, why: 'no fal key: set FAL_KEY in the environment of the server / runner, or fal_key_file in workbench.config.json (a file outside the project)' }; },
  supports(req) { const m = modelOf(req); return m === 'nb2' || m === 'seedream5' ? { ok: true } : { ok: false, why: `${PRICES[m]?.name || m} is video: the fal video runner is D3b (not built yet); run it outside the queue and report it with request_update` }; },
  // {usd (all takes), per_take, tool (endpoint), model, tier, takes, why} from js/prices.js (the one price table)
  estimate(req) {
    const model = modelOf(req), takes = takesOf(req), refs = (req?.refs || []).length;
    if (model === 'nb2') {
      const p = price('nb2', nb2Tier(req)), tool = refs ? p.endpoint : NB2_T2I;
      return { model, tier: p.tier, takes, per_take: p.usd, usd: +(p.usd * takes).toFixed(4), tool, why: `${p.name} ${p.tier} $${p.usd}${refs ? '' : ' (text-to-image, at the edit list price)'} x ${takes}, verified ${p.verified}` };
    }
    if (model === 'seedream5') {
      const p = price('seedream5', '2048'), per = +(p.usd + 0.0045 * Math.max(0, refs - 1)).toFixed(4);
      return { model, tier: p.tier, takes, per_take: per, usd: +(per * takes).toFixed(4), tool: p.endpoint, why: `${p.name} up to 2048² $${p.usd} + $0.0045 x ${Math.max(0, refs - 1)} extra refs, x ${takes}, verified ${p.verified}` };
    }
    const p = price(model); return { model, takes, per_take: null, usd: null, tool: p?.endpoint, why: 'video: D3b' };
  },
  // upload one local ref to fal's CDN -> its public URL
  async upload(absFile, ctx) {
    const ctype = MIME[path.extname(absFile).toLowerCase()] || 'application/octet-stream';
    const r = await call(`${STORAGE}/storage/upload/initiate?storage_type=fal-cdn-v3`, { method: 'POST', body: JSON.stringify({ content_type: ctype, file_name: path.basename(absFile) }) }, ctx);
    if (!r.upload_url || !r.file_url) throw new Error('fal storage: no upload_url / file_url');
    const put = await fetch(r.upload_url, { method: 'PUT', headers: { 'content-type': ctype }, body: fs.readFileSync(absFile), signal: AbortSignal.timeout(300000) });
    if (!put.ok) throw new Error(`fal storage PUT ${put.status}`);
    return r.file_url;
  },
  // the request body for one take (refs already uploaded: ctx.refUrls, in order, image 1 first)
  payload(req, refUrls) {
    const model = modelOf(req), aspect = SIZE[req?.aspect] ? req.aspect : '16:9';
    if (model === 'nb2') return { prompt: req.prompt, ...(refUrls.length ? { image_urls: refUrls } : {}), num_images: 1, aspect_ratio: aspect, resolution: nb2Tier(req), output_format: 'png' };
    const [w, h] = SIZE[aspect];
    return { prompt: req.prompt, image_urls: refUrls, num_images: 1, image_size: { width: w, height: h }, output_format: 'png' };
  },
  // -> handle {endpoint, request_id, status_url, response_url} (no key in it: it goes into job.json)
  async submit(req, ctx) {
    const sup = this.supports(req); if (!sup.ok) throw new Error(sup.why);
    const { tool } = this.estimate(req);
    const q = await call(`${QUEUE}/${tool}`, { method: 'POST', body: JSON.stringify(this.payload(req, ctx.refUrls || [])) }, ctx, 120000);
    if (!q.request_id || !q.status_url || !q.response_url) throw new Error('fal queue: no request_id / status_url / response_url');
    return { endpoint: tool, request_id: q.request_id, status_url: q.status_url, response_url: q.response_url };
  },
  // -> {status: queued | running | done | failed, error?}
  async poll(handle, ctx) {
    const s = await call(handle.status_url, { method: 'GET' }, ctx, 60000);
    if (s.status === 'COMPLETED') return s.error ? { status: 'failed', error: String(s.error).slice(0, 500) } : { status: 'done' };
    if (s.status === 'IN_PROGRESS') return { status: 'running' };
    if (s.status === 'IN_QUEUE') return { status: 'queued', position: s.queue_position };
    return { status: 'failed', error: `fal status ${JSON.stringify(s).slice(0, 300)}` };
  },
  // -> [{url, ext}] (downloaded by the runner, without the key)
  async fetch(handle, ctx) {
    const res = await call(handle.response_url, { method: 'GET' }, ctx, 120000);
    const urls = (res.images || []).map(x => x?.url).filter(u => typeof u === 'string' && /^(https?:|data:)/.test(u));
    if (!urls.length) throw new Error(`fal response without images: ${JSON.stringify(res).slice(0, 300)}`);
    return urls.map(url => ({ url, ext: /\.jpe?g(\?|$)/i.test(url) ? 'jpg' : /\.webp(\?|$)/i.test(url) ? 'webp' : 'png' }));
  },
};

// one authorised JSON call to fal (queue or storage origin only: the key never goes anywhere else)
async function call(url, { method, body }, ctx, timeout = 60000) {
  const u = new URL(url);
  if (!ORIGINS.has(u.origin)) throw new Error(`refusing to send the fal key to ${u.origin}`);
  if (!ctx?.key) throw new Error('no fal key');
  const r = await fetch(u, { method, headers: { authorization: `Key ${ctx.key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : {}), signal: AbortSignal.timeout(timeout) });
  const text = await r.text();
  if (!r.ok) throw new Error(`fal ${method} ${u.pathname} ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch (e) { throw new Error(`fal ${u.pathname}: not JSON (${text.slice(0, 120)})`); }
}
