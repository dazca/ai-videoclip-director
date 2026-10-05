// Video generation requests (ROADMAP_v4 D3b): what a video request carries and what it costs. Pure functions, no DOM
// and no Node APIs: the Queue's request form, lib/ops/requests.mjs (request_create / request_update video), lib/run.mjs
// and generators/fal.mjs read the same code. Prices come from js/prices.js (per second, with the H3 promo date).
//
// A video request: {kind: "shot-video" | "motion" | ..., target: "shot:<id>", prompt (MOTION ONLY: what moves, one camera
// move; docs/PHOTOREAL.md §6), tool (the endpoint), takes?, est_cost (= $/s x seconds x takes), refs (= videoRefs: the
// files the runner uploads, start frame first), video: {model, start, end?, ref_video?, seconds, orientation?}}
//   - h3max      MiniMax H3 Max image-to-video: start frame (+ optional end frame), 5-10 s
//   - kling3pro  Kling v3 Pro image-to-video: start frame (+ optional end frame), 3-15 s, negative prompt
//   - klingmc    Kling v3 Motion Control: the character still + a reference video (performance transfer); the output is
//                as long as the reference clip, so seconds must cover it (the runner probes the clip)
// The end frame is made by editing the start frame (same light, lens, place, wardrobe; only pose / expression / camera
// change): pick an edit of the start frame, or nothing for a free end.
import { PRICES, price } from './prices.js';

export const VIDEO_RE = /\.(mp4|mov|webm|mkv)$/i, IMAGE_RE = /\.(png|jpe?g|webp)$/i;
export const MODELS = {
  h3max: { kind: 'i2v', min: 5, max: 10, def: 6, end: true, seconds: [5, 6, 8, 10] },
  kling3pro: { kind: 'i2v', min: 3, max: 15, def: 5, end: true, seconds: [3, 4, 5, 6, 8, 10, 12, 15] },
  klingmc: { kind: 'motion', min: 3, max: 30, def: 5, end: false, ref_video: true, seconds: [3, 4, 5, 6, 8, 10, 12, 15, 20, 30] },
};
export const ORIENTATIONS = { video: 'follow the reference video (up to 30 s; face element)', image: 'follow the still (up to 10 s; prompted camera moves)' };
export const isVideoModel = (m) => !!MODELS[m];
const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);

// the video spec of a request (its `video`, else derived from refs / recipe for an older request) -> {model, start, end,
// ref_video, seconds, orientation}
export function videoOf(req, model) {
  const v = req?.video && typeof req.video === 'object' ? req.video : {}, refs = Array.isArray(req?.refs) ? req.refs : [];
  const m = MODELS[v.model] ? v.model : MODELS[model] ? model : MODELS[req?.recipe?.model] ? req.recipe.model : 'h3max', M = MODELS[m];
  const start = str(v.start) ?? refs.find(r => IMAGE_RE.test(String(r))) ?? null;
  const ref_video = M.ref_video ? (str(v.ref_video) ?? refs.find(r => VIDEO_RE.test(String(r))) ?? null) : null;
  const end = M.end ? (str(v.end) ?? null) : null;
  const s = Number(v.seconds ?? req?.recipe?.seconds ?? req?.seconds);
  return { model: m, start, end, ref_video, seconds: Number.isFinite(s) && s > 0 ? Math.round(s) : M.def, ...(m === 'klingmc' ? { orientation: v.orientation === 'image' ? 'image' : 'video' } : {}) };
}
// the files a video request uploads, in order (start frame first)
export const videoRefs = (v) => [v.start, v.end, v.ref_video].filter(Boolean);
// what is wrong with a video spec (empty = fine): the runner, request_create and the form say the same thing
export function videoProblems(v) {
  const M = MODELS[v?.model], out = [];
  if (!M) return [`video.model: one of ${Object.keys(MODELS).join(', ')}`];
  if (!v.start) out.push('no start frame: pick an approved still (a node or a registered image) as video.start');
  else if (!IMAGE_RE.test(v.start)) out.push(`the start frame must be an image (png / jpg / webp): ${v.start}`);
  if (v.end && !IMAGE_RE.test(v.end)) out.push(`the end frame must be an image: ${v.end}`);
  if (M.ref_video && !v.ref_video) out.push('motion control needs a reference video (video.ref_video: a registered clip, 3-30 s, one person, no cuts)');
  if (v.ref_video && !VIDEO_RE.test(v.ref_video)) out.push(`the reference video must be a video file (mp4 / mov / webm): ${v.ref_video}`);
  const max = v.model === 'klingmc' && v.orientation === 'image' ? 10 : M.max;
  if (!(Number.isInteger(v.seconds) && v.seconds >= M.min && v.seconds <= max)) out.push(`seconds: ${M.min}-${max} for ${PRICES[v.model].name}${v.model === 'klingmc' ? ` (orientation ${v.orientation})` : ''}`);
  return out;
}
// the estimate of a video request: $/s (on the date: the H3 promo ends 2026-10-15) x seconds x takes
export function videoEstimate(v, { takes = 1, date } = {}) {
  const p = price(v.model, null, { date }); if (!p) return null;
  const n = Math.max(1, Math.min(8, Number(takes) || 1)), per = +(p.usd * v.seconds).toFixed(4);
  return { model: v.model, tier: p.tier, tool: p.endpoint, per_s: p.usd, seconds: v.seconds, takes: n, per_take: per, usd: +(per * n).toFixed(4), ...(p.promo_until ? { promo_until: p.promo_until } : {}), verified: p.verified,
    why: `${p.name} $${p.usd}/s${p.promo_until ? ` (promo until ${p.promo_until}, then $${PRICES[v.model].usd[p.tier]}/s)` : ''} x ${v.seconds} s${n > 1 ? ` x ${n} takes` : ''}, list price verified ${p.verified}` };
}
