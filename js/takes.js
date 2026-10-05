// Take selection (ROADMAP_v4 D6). Pure functions, no DOM and no Node APIs: the page (tabs/takes.js, the Shot panel of
// tabs/storyboard.js, the timeline clip column, Final) and the data layer (lib/ops/takes.mjs) import the same code.
//
// A TAKE is one registered media file (media.json) that can play in a shot: a runner output of a request
// (gen/<request>/<request>_<take>.<ext>, media `request` / `job` = the request id, `take` = its index) or an imported file
// linked to the shot (media `shots`), to one of its clip uses (`uses`, or `job` = the use's clip) or to a request that
// targets the shot ("shot:<id>"). Renders, audio, sketches and sheets are never takes.
//
// The PICK is the director's (page only: take_act) and lives on the storyboard shot, saved through a new version:
//   shot.clip {request: id | null, take: n | null, file: <media path>, media: <media id>, kind: video | image,
//              in_ms, out_ms (video: 0 <= in < out <= the take's duration; image: 0 and null), note,
//              alt: [{take, file?, t (song ms), note}], by, via: "page", at, proposal?}
// An alternative is "another take for a moment of the song" (TAKES.md: "take 2 waves with a bigger smile, alternative
// for 139.84"). Approval stays separate (approvals.json "shot:<id>").
//
// takes.json (the server's; the page reads it): {v: 1, rev, proposals: [{id "tp03", shot, request, take, file, media,
// in_ms, out_ms, why, by, via: "agent", at, status: open | picked | dismissed, decided_at?}]}. The agent proposes
// (take_propose), the director picks with one click; the agent never picks.
export const NOT_TAKES = ['render', 'audio', 'sketch', 'sheet', 'catalog', 'ref'];
export const VIDEO_RE = /\.(mp4|webm|mov|mkv)$/i, IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
export const NOTE_MAX = 500, ALT_NOTE_MAX = 300, WHY_MAX = 400, ALT_MAX = 12;
export const DEFAULT_FPS = 24;
const PATH_RE = /^[\w./@() +-]{1,400}$/;
const isInt = (v) => Number.isInteger(v);

export const isTakeMedia = (m) => !!m && typeof m.path === 'string' && !NOT_TAKES.includes(m.kind) && (VIDEO_RE.test(m.path) || IMAGE_RE.test(m.path));
export const takeKind = (m) => VIDEO_RE.test(m?.path || m?.file || '') ? 'video' : 'image';
const reqIds = (requests) => (requests?.items || requests || []).map(r => r.id);
// the request a media file came from: its `request`, else its `job` when a request has that id
export function requestOf(m, requests) { if (m?.request) return String(m.request); return m?.job && reqIds(requests).includes(m.job) ? String(m.job) : null; }
// the take number of a media file within its request / job (null for a loose import)
export const takeNo = (m) => isInt(m?.take) ? m.take : null;

// every take of a shot: media linked to it, to its clip uses (or their clip's job), or to a request that targets it.
// uses = shots.json uses (EDL), requests = requests.json. -> [{media, file, kind, take, request, job, label, duration_ms,
// w, h, thumb, strip, private, source: runner | import, why[]}], sorted by request then take
// links = the director's "use as" of D8 for this shot (shotLinks below; lib/ops/media.mjs shotMediaLinks): media marked
// "use as shot take" are takes of it (why "use_as"), the start frame is flagged (why "start_frame")
export function takesForShot(shot, { media = [], requests = [], uses = [], links = null } = {}) {
  if (!shot) return [];
  const L = links || shotLinks(media, shot.id), useAs = new Set((L.takes || []).map(x => x.media)), sf = L.start_frame?.media ?? null;
  const R = requests?.items || requests || [], mine = new Set(R.filter(r => r.target === `shot:${shot.id}`).map(r => r.id));
  const useIds = new Set(shot.clips || []), clipJobs = new Set((uses || []).filter(u => useIds.has(u.id)).map(u => u.clip).filter(Boolean));
  const out = [];
  for (const m of media) {
    if (!isTakeMedia(m)) continue;
    const why = [];
    if ((m.shots || []).includes(shot.id)) why.push('shot');
    const rq = requestOf(m, R);
    if (rq && mine.has(rq)) why.push('request');
    if ((m.uses || []).some(u => useIds.has(u)) || (m.job && clipJobs.has(m.job))) why.push('clip');
    if (useAs.has(m.id)) why.push('use_as');
    if (sf != null && sf === m.id) why.push('start_frame');
    if (why.length) out.push(takeView(m, R, why));
  }
  return sortTakes(out);
}
// D8: the director's "use as" links of a shot, from media.json items' use_as[] {shot, as: take | start_frame, by, at}
// -> {shot, takes: [{media, path, kind, private, at, by}], start_frame: {...} | null}
export function shotLinks(media, shotId) {
  const out = { shot: shotId, takes: [], start_frame: null };
  for (const m of media || []) for (const u of m.use_as || []) {
    if (u.shot !== shotId) continue;
    const x = { media: m.id, path: m.path, kind: m.kind, private: !!m.private, at: u.at, by: u.by };
    if (u.as === 'take') out.takes.push(x); else if (u.as === 'start_frame') out.start_frame = x;
  }
  return out;
}
// every take of one request (its registered outputs)
export function takesForRequest(reqId, { media = [], requests = [] } = {}) {
  const R = requests?.items || requests || [], r = R.find(x => x.id === reqId), outs = new Set((r?.outputs || []).map(String));
  return sortTakes(media.filter(m => isTakeMedia(m) && (requestOf(m, R) === reqId || m.job === reqId || outs.has(m.path))).map(m => takeView(m, R, ['request'])));
}
function takeView(m, R, why) {
  const request = requestOf(m, R);
  return { media: m.id, file: m.path, kind: takeKind(m), take: takeNo(m), request, job: m.job ?? null, label: m.label || m.id, duration_ms: isInt(m.duration_ms) ? m.duration_ms : null,
    fps: Number(m.fps) > 0 ? Number(m.fps) : null, w: m.w ?? null, h: m.h ?? null, thumb: m.thumb || null, strip: m.strip || null, private: !!m.private,
    source: request || m.request || /^gen\//.test(m.path) ? 'runner' : 'import', why };
}
const sortTakes = (l) => l.sort((a, b) => String(a.request || a.job || '').localeCompare(String(b.request || b.job || '')) || (a.take ?? 999) - (b.take ?? 999) || a.file.localeCompare(b.file));
// a short name for a take: "C1.1", "rq7.0", or the file name
export const takeName = (t) => t ? (t.request || t.job ? `${t.request || t.job}.${t.take ?? '?'}` : String(t.file || '').split('/').pop()) : '';

// ------------------------------------------------------------------ frames and times
export const frameMs = (fps) => 1000 / (Number(fps) > 0 ? Number(fps) : DEFAULT_FPS);
export function snapFrame(ms, fps, dur) { const f = frameMs(fps), v = Math.round(Math.round(ms / f) * f); return Math.max(0, dur ? Math.min(dur, v) : v); }
export const secs = (ms, d = 2) => `${(Math.max(0, ms) / 1000).toFixed(d)} s`;

// ------------------------------------------------------------------ the pick: shape (storyboard.json) and full checks (take_act)
// the stored shape, checked without the media index (checkBoard / cleanShot): throws a message
export function shapeClip(c, where = 'clip') {
  if (c == null) return null;
  if (typeof c !== 'object' || Array.isArray(c)) throw new Error(`${where}: an object {request, take, file, in_ms, out_ms, alt[]}`);
  if (typeof c.file !== 'string' || !PATH_RE.test(c.file) || c.file.split('/').some(x => x === '..' || x === '.' || x === '') || /^[/\\]/.test(c.file)) throw new Error(`${where}.file: a registered media path`);
  if (c.request != null && (typeof c.request !== 'string' || !/^[\w@.:-]{1,80}$/.test(c.request))) throw new Error(`${where}.request: a request id or null`);
  if (c.media != null && (typeof c.media !== 'string' || c.media.length > 120)) throw new Error(`${where}.media: a media id`);
  if (c.take != null && (!isInt(c.take) || c.take < 0 || c.take > 999)) throw new Error(`${where}.take: an integer or null`);
  if (!isInt(c.in_ms) || c.in_ms < 0) throw new Error(`${where}.in_ms: an integer >= 0`);
  if (c.out_ms != null && (!isInt(c.out_ms) || c.out_ms <= c.in_ms)) throw new Error(`${where}.out_ms: an integer > in_ms (or null for a still)`);
  if (c.note != null && (typeof c.note !== 'string' || c.note.length > NOTE_MAX)) throw new Error(`${where}.note: up to ${NOTE_MAX} characters`);
  if (c.alt != null && (!Array.isArray(c.alt) || c.alt.length > ALT_MAX)) throw new Error(`${where}.alt: up to ${ALT_MAX} alternatives`);
  for (const [i, a] of (c.alt || []).entries()) {
    if (!a || typeof a !== 'object') throw new Error(`${where}.alt[${i}]: {take, t, note}`);
    if (a.take != null && (!isInt(a.take) || a.take < 0)) throw new Error(`${where}.alt[${i}].take: an integer or null`);
    if (!isInt(a.t) || a.t < 0) throw new Error(`${where}.alt[${i}].t: song time in integer ms`);
    if (a.file != null && (typeof a.file !== 'string' || !PATH_RE.test(a.file) || a.file.split('/').includes('..'))) throw new Error(`${where}.alt[${i}].file: a registered media path`);
    if (a.note != null && (typeof a.note !== 'string' || a.note.length > ALT_NOTE_MAX)) throw new Error(`${where}.alt[${i}].note: up to ${ALT_NOTE_MAX} characters`);
  }
  return c;
}
// a pick against the media index and the song: the file is a registered take of the project (not a render / audio),
// in / out inside the take's duration (a still: 0 / null), alternatives inside the song and registered. Returns the
// clean clip (request / take / kind from the media entry, never from the caller); throws {code, message}.
export function checkClip(input, { media = [], requests = [], song = null, durationOf = null } = {}) {
  const err = (code, message) => Object.assign(new Error(message), { code });
  if (!input || typeof input !== 'object') throw err(400, 'clip: {file | media, in_ms, out_ms, note?, alt?}');
  const find = (file, id) => media.find(m => (id != null && m.id === id) || (file != null && String(m.path).toLowerCase() === String(file).replace(/\\/g, '/').toLowerCase()));
  const m = find(input.file, input.media);
  if (!m) throw err(404, `the take must be a registered media file of the project (media.json): ${String(input.file ?? input.media).slice(0, 120)} is not (media_add / media_list)`);
  if (!isTakeMedia(m)) throw err(400, `${m.id} is a ${m.kind} (${m.path}), not a take: a video or still output / import`);
  const kind = takeKind(m), num = (v, n) => { if (v == null || v === '') return null; const x = Number(v); if (!Number.isFinite(x)) throw err(400, `${n}: integer ms`); return Math.round(x); };
  let in_ms = num(input.in_ms, 'in_ms') ?? 0, out_ms = num(input.out_ms, 'out_ms');
  if (kind === 'video') {
    const dur = isInt(m.duration_ms) && m.duration_ms > 0 ? m.duration_ms : (durationOf ? durationOf(m) : null);
    if (!(dur > 0)) throw err(400, `${m.id}: its duration is unknown (ffprobe): in / out cannot be checked`);
    if (out_ms == null) out_ms = dur;
    if (in_ms < 0 || out_ms > dur || out_ms <= in_ms) throw err(400, `in / out must stay inside the take: 0 <= in_ms < out_ms <= ${dur} ms (got ${in_ms}, ${out_ms})`);
  } else { if (in_ms !== 0 || (out_ms != null && out_ms !== 0)) throw err(400, `${m.id} is a still: no in / out (in_ms 0, out_ms null)`); in_ms = 0; out_ms = null; }
  const note = input.note == null ? '' : String(input.note);
  if (note.length > NOTE_MAX) throw err(400, `note: up to ${NOTE_MAX} characters`);
  const dur = song?.duration_ms || Infinity, alt = [];
  if (input.alt != null && (!Array.isArray(input.alt) || input.alt.length > ALT_MAX)) throw err(400, `alt: up to ${ALT_MAX} alternatives [{take | file | media, t, note}]`);
  for (const [i, a] of (input.alt || []).entries()) {
    if (!a || typeof a !== 'object') throw err(400, `alt[${i}]: {file | media | take, t, note}`);
    const t = num(a.t, `alt[${i}].t`);
    if (t == null || t < 0 || t > dur) throw err(400, `alt[${i}].t: a time of the song (0..${dur} ms)`);
    let am = a.file != null || a.media != null ? find(a.file, a.media) : null;
    if ((a.file != null || a.media != null) && !am) throw err(404, `alt[${i}]: not a registered media file`);
    if (!am && a.take != null) am = media.find(x => isTakeMedia(x) && requestOf(x, requests) === requestOf(m, requests) && (m.job ? x.job === m.job : true) && x.take === Number(a.take)) || null;
    if (am && !isTakeMedia(am)) throw err(400, `alt[${i}]: ${am.id} is not a take`);
    const an = a.note == null ? '' : String(a.note); if (an.length > ALT_NOTE_MAX) throw err(400, `alt[${i}].note: up to ${ALT_NOTE_MAX} characters`);
    alt.push({ take: am ? takeNo(am) : (a.take == null ? null : Number(a.take)), ...(am ? { file: am.path } : {}), t, note: an });
  }
  return { request: requestOf(m, requests), take: takeNo(m), file: m.path, media: m.id, kind, in_ms, out_ms, note, alt };
}
export const sameClip = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
// the clip's length on screen (ms) and how it compares with the shot's
export function clipLen(c) { return c && c.out_ms != null ? c.out_ms - c.in_ms : null; }
export function fitNote(c, shot) {
  const L = clipLen(c), S = shot ? shot.t1 - shot.t0 : null;
  if (L == null || !S) return '';
  const d = L - S;
  return Math.abs(d) < 40 ? 'fits the shot' : d < 0 ? `${secs(-d, 1)} short of the shot (${secs(S, 1)})` : `${secs(d, 1)} longer than the shot (${secs(S, 1)}): the cut trims it`;
}

// ------------------------------------------------------------------ takes.json (proposals) and the Final checklist
export function normTakes(d) {
  const o = d && typeof d === 'object' && !Array.isArray(d) ? { v: 1, rev: d.rev || 0, proposals: Array.isArray(d.proposals) ? d.proposals.filter(x => x && typeof x === 'object') : [] } : { v: 1, rev: 0, proposals: [] };
  return o;
}
export const nextProposalId = (d) => `tp${String(Math.max(0, ...(d.proposals || []).map(x => Number(/^tp(\d+)$/.exec(x.id)?.[1]) || 0)) + 1).padStart(2, '0')}`;
export const openProposals = (d, shot) => (d?.proposals || []).filter(x => x.status === 'open' && (!shot || x.shot === shot));
// the "takes picked" line of the Final checklist (js/final.js may include it; tabs/final.js shows it): shots that need
// footage (gen still / video, or any shot with takes) against those with a pick
export function takesChecklist(shots) {
  const all = shots || [], picked = all.filter(s => s.clip && s.clip.file);
  return { id: 'takes', label: 'takes picked', done: picked.length, total: all.length, ok: all.length > 0 && picked.length === all.length, missing: all.filter(s => !s.clip?.file).map(s => s.id) };
}
