// fal.ai generator: images (D3a: Nano Banana 2 edit with refs / text-to-image without, Seedream 5.0 Pro edit) and video
// (D3b: MiniMax H3 Max image-to-video, Kling v3 Pro image-to-video with an optional end frame, Kling v3 Motion Control
// with a reference video), through fal's queue API, the calls ported from ../project/gen/falgen.py (which runs in
// production; the endpoints and prices are js/prices.js's, the video spec js/video.js's):
//   submit   POST {QUEUE}/<endpoint>               {prompt, image_urls, ...}  -> {request_id, status_url, response_url}
//   status   GET  status_url                                                  -> {status: IN_QUEUE | IN_PROGRESS | COMPLETED}
//   response GET  response_url                                                -> {images: [{url, content_type}]} | {video: {url}}
//   refs     POST {STORAGE}/storage/upload/initiate?storage_type=fal-cdn-v3 {content_type, file_name} -> {upload_url, file_url},
//            then PUT the bytes to upload_url (fal's CDN; the request then names the file_url)
// The key travels only in the Authorization header of these calls, and only to the queue / storage origins (a
// status_url or response_url on another origin gets no key). It is never logged, returned or written: the handle,
// job.json and every error message are key-free (the runner redacts errors once more).
// Tests: WB_FAL_BASE points the queue AND the storage at a mock server, and only when WB_TEST=1 (tools/mock-fal.mjs).
// Video payloads (falgen h3 / kling / mc): every frame and the reference video go up to fal storage first (refUrls, in
// the order of req.refs = js/video.js videoRefs: start, end, reference video), then
//   h3max      {prompt, image_url, duration: int, resolution: "768P", prompt_expansion_mode: "disabled", end_image_url?}
//   kling3pro  {prompt, start_image_url, duration: "5", generate_audio: false, negative_prompt, end_image_url?}
//   klingmc    {image_url, video_url, character_orientation, prompt, keep_original_sound: false}
// priced per second of output (js/prices.js x video.seconds; the H3 promo by date); outputs are .mp4.
import fs from 'node:fs';
import path from 'node:path';
import { PRICES, price, modelOf } from '../js/prices.js';
import { MODELS as VIDEO_MODELS, videoOf, videoProblems, videoEstimate } from '../js/video.js';
export { modelOf };

const TEST = process.env.WB_TEST === '1' && process.env.WB_FAL_BASE;
export const QUEUE = TEST ? process.env.WB_FAL_BASE.replace(/\/+$/, '') : 'https://queue.fal.run';
export const STORAGE = TEST ? process.env.WB_FAL_BASE.replace(/\/+$/, '') : 'https://rest.alpha.fal.ai';
const ORIGINS = new Set([new URL(QUEUE).origin, new URL(STORAGE).origin]);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
const KLING_NEG = 'blur, distort, low quality, text, letters, logos, extra fingers, morphing face';   // falgen's default
const SIZE = { '16:9': [2560, 1440], '9:16': [1440, 2560], '3:4': [1728, 2304], '1:1': [2048, 2048], '4:3': [2304, 1728] };   // seedream image_size (falgen)
const NB2_T2I = 'fal-ai/nano-banana-2';

const takesOf = (req) => Math.max(1, Math.min(8, Number(req?.takes) || 1));
const isEdit = (req) => /edit/.test(String(req?.kind || '')) || req?.asset?.kind === 'edit';
const nb2Tier = (req) => (['1K', '2K'].includes(req?.resolution) ? req.resolution : isEdit(req) ? '1K' : '2K');

export default {
  id: 'fal', label: 'fal.ai (cloud, paid)', kinds: ['image', 'video', 'motion'],
  // key present? (the runner resolves it; this only says whether one was found and from where, never the key)
  configured(ctx) { return ctx?.keySource ? { ok: true, why: `key from ${ctx.keySource}` } : { ok: false, why: 'no fal key: set FAL_KEY in the environment of the server / runner, or fal_key_file in workbench.config.json (a file outside the project)' }; },
  supports(req) {
    const m = modelOf(req);
    if (m === 'nb2' || m === 'seedream5') return { ok: true };
    if (!VIDEO_MODELS[m]) return { ok: false, why: `${PRICES[m]?.name || m}: not a fal model the workbench runs` };
    const bad = videoProblems(videoOf(req, m)); return bad.length ? { ok: false, why: bad.join('; ') } : { ok: true };
  },
  // {usd (all takes), per_take, tool (endpoint), model, tier, takes, why} from js/prices.js (the one price table); video:
  // per second x video.seconds, at the price of `date` (default today: the H3 promo ends on its day)
  estimate(req, { date } = {}) {
    const model = modelOf(req), takes = takesOf(req), refs = (req?.refs || []).length;
    if (VIDEO_MODELS[model]) { const v = videoOf(req, model), e = videoEstimate(v, { takes, date }); return { model, tier: e.tier, takes, per_take: e.per_take, usd: e.usd, tool: e.tool, seconds: v.seconds, per_s: e.per_s, why: e.why, video: true }; }
    if (model === 'nb2') {
      const p = price('nb2', nb2Tier(req)), tool = refs ? p.endpoint : NB2_T2I;
      return { model, tier: p.tier, takes, per_take: p.usd, usd: +(p.usd * takes).toFixed(4), tool, why: `${p.name} ${p.tier} $${p.usd}${refs ? '' : ' (text-to-image, at the edit list price)'} x ${takes}, verified ${p.verified}` };
    }
    if (model === 'seedream5') {
      const p = price('seedream5', '2048'), per = +(p.usd + 0.0045 * Math.max(0, refs - 1)).toFixed(4);
      return { model, tier: p.tier, takes, per_take: per, usd: +(per * takes).toFixed(4), tool: p.endpoint, why: `${p.name} up to 2048² $${p.usd} + $0.0045 x ${Math.max(0, refs - 1)} extra refs, x ${takes}, verified ${p.verified}` };
    }
    const p = price(model); return { model, takes, per_take: null, usd: null, tool: p?.endpoint, why: `no fal price for ${model}` };
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
    if (VIDEO_MODELS[model]) {
      const v = videoOf(req, model), refs = req.refs || [], url = (f) => { const i = refs.indexOf(f); if (i < 0 || !refUrls[i]) throw new Error(`video: ${f} was not uploaded (not in refs)`); return refUrls[i]; };
      if (model === 'klingmc') return { image_url: url(v.start), video_url: url(v.ref_video), character_orientation: v.orientation, prompt: req.prompt || '', keep_original_sound: false };
      if (model === 'h3max') return { prompt: req.prompt, image_url: url(v.start), duration: v.seconds, resolution: '768P', prompt_expansion_mode: 'disabled', ...(v.end ? { end_image_url: url(v.end) } : {}) };
      return { prompt: req.prompt, start_image_url: url(v.start), duration: String(v.seconds), generate_audio: false, negative_prompt: req.recipe?.negative_prompt || KLING_NEG, ...(v.end ? { end_image_url: url(v.end) } : {}) };
    }
    if (model === 'nb2') return { prompt: req.prompt, ...(refUrls.length ? { image_urls: refUrls } : {}), num_images: 1, aspect_ratio: aspect, resolution: nb2Tier(req), output_format: 'png' };
    const [w, h] = SIZE[aspect];
    return { prompt: req.prompt, image_urls: refUrls, num_images: 1, image_size: { width: w, height: h }, output_format: 'png' };
  },
  // -> handle {endpoint, request_id, status_url, response_url} (no key in it: it goes into job.json)
  async submit(req, ctx) {
    const sup = this.supports(req); if (!sup.ok) throw new Error(sup.why);
    const { tool } = this.estimate(req, { date: ctx.date });
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
    if (res.video !== undefined || /video|motion/.test(handle.endpoint || '')) {   // video: {video: {url}} (falgen)
      const u = res.video?.url;
      if (typeof u !== 'string' || !/^(https?:|data:)/.test(u)) throw new Error(`fal response without a video: ${JSON.stringify(res).slice(0, 300)}`);
      return [{ url: u, ext: 'mp4' }];
    }
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
