// Contact sheets with ffmpeg (ROADMAP_v4 E8; the first film's tools/sheet.mjs, generalised): one labelled tile per frame
// (a frame of a video at a time, an image, or a neutral tile with a label), then the tiles in a grid. Used by the render
// jobs (a contact sheet every N s + a seams sheet around each chapter seam: -0.25 s, -1 frame, the seam, +1 frame,
// +0.25 s, like azemar-exe-v1-seams.jpg), by sheet_make (a request's takes, the storyboard) and by tools/contact.mjs.
// Local only: ffmpeg / ffprobe on PATH, no network. Paths are the caller's (lib/ops/renders.mjs checks every one).
// Labels go through a text file next to the tiles (drawtext textfile=, relative to the temp folder: no quoting of the
// label in the filter graph); when drawtext is not available the tiles are made without labels.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const TILE_W = 320, TILE_H = 180, MAX_TILES = 144;
const run = (args, cwd) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000, windowsHide: true }); return { ok: r.status === 0, err: String(r.stderr || r.error?.message || '').trim().slice(0, 400) }; };
export function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,r_frame_rate,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  try { const j = JSON.parse(r.stdout || '{}'), v = (j.streams || []).find(s => s.codec_type === 'video') || {}, [a, b] = String(v.r_frame_rate || '').split('/').map(Number);
    return { dur: Number(j.format?.duration) || null, fps: a > 0 && b > 0 ? a / b : null, w: v.width || null, h: v.height || null }; } catch (e) { return { dur: null, fps: null, w: null, h: null }; }
}
const box = (w, h) => `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x222222`;
const label = (txt, size) => `drawtext=textfile=${txt}:x=6:y=6:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=3`;
// one tile: {src?, t? (s, for a video), text, kind: video | image | blank} -> tmp/<n>.jpg
function tile(tmp, n, x, w, h) {
  const out = `${String(n).padStart(4, '0')}.jpg`, txt = `${String(n).padStart(4, '0')}.txt`;
  fs.writeFileSync(path.join(tmp, txt), String(x.text || '').replace(/[\r\n]+/g, ' ').slice(0, 80));
  const fs1 = Math.max(10, Math.round(h / 11));
  const input = x.kind === 'blank' || !x.src ? ['-f', 'lavfi', '-i', `color=c=0x2c2c2c:s=${w}x${h}:d=1`]
    : x.kind === 'video' ? ['-ss', Math.max(0, x.t || 0).toFixed(3), '-i', x.src] : ['-i', x.src];
  let r = run([...input, '-frames:v', '1', '-vf', `${box(w, h)},${label(txt, fs1)}`, '-q:v', '4', out], tmp);
  if (!r.ok) r = run([...input, '-frames:v', '1', '-vf', box(w, h), '-q:v', '4', out], tmp);   // no drawtext (no font): unlabelled
  if (!r.ok && x.kind === 'video') r = run(['-sseof', '-0.05', '-i', x.src, '-frames:v', '1', '-vf', box(w, h), '-q:v', '4', out], tmp);   // past the end: the last frame
  if (!r.ok) r = run(['-f', 'lavfi', '-i', `color=c=0x402020:s=${w}x${h}:d=1`, '-frames:v', '1', '-q:v', '4', out], tmp);
  return r.ok;
}
// tiles [{src?, t?, text, kind}] -> one JPEG grid at out (cols wide); returns {file, tiles, cols, rows}
export function sheet(tiles, out, { cols = 5, w = TILE_W, h = TILE_H } = {}) {
  if (!tiles.length) throw new Error('nothing to put on the sheet');
  if (tiles.length > MAX_TILES) tiles = tiles.slice(0, MAX_TILES);
  cols = Math.max(1, Math.min(cols, tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(path.dirname(out), '.sheet-'));
  try {
    tiles.forEach((x, i) => tile(tmp, i, x, w, h));
    // pad the last row with blanks so the grid is whole
    for (let i = tiles.length; i < cols * rows; i++) tile(tmp, i, { kind: 'blank', text: '' }, w, h);
    const r = run(['-framerate', '1', '-start_number', '0', '-i', '%04d.jpg', '-vf', `tile=${cols}x${rows}:padding=4:margin=4:color=0x222222`, '-frames:v', '1', '-q:v', '3', 'sheet.jpg'], tmp);
    if (!r.ok) throw new Error('ffmpeg could not build the sheet: ' + r.err);
    fs.copyFileSync(path.join(tmp, 'sheet.jpg'), out);
    return { file: out, tiles: tiles.length, cols, rows };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
// a video, one frame every `every` s from its start; label(s) -> the tile text (default the media time)
export function videoSheet(src, out, { every = 2, cols = 6, label: lab = (s) => s.toFixed(2), maxTiles = 120 } = {}) {
  const pr = probe(src); if (!pr.dur) throw new Error('not a readable video: ' + path.basename(src));
  let step = every; while (pr.dur / step > maxTiles) step *= 2;
  const ts = []; for (let s = 0; s < pr.dur - 0.01; s += step) ts.push(+s.toFixed(3));
  const half = 0.5 / (pr.fps || 30);
  const tiles = ts.map(s => ({ src, t: Math.max(0, s - half), kind: 'video', text: lab(s) }));
  return { ...sheet(tiles, out, { cols }), times: ts, every: step, dur: pr.dur, fps: pr.fps };
}
// the frames around each seam (media seconds): -0.25 s, -1 frame, the seam, +1 frame, +0.25 s (one row per seam)
export function seamsSheet(src, out, seams, { fps, label: lab = (s, f) => `${s.toFixed(3)} f${f}` } = {}) {
  const pr = probe(src); if (!pr.dur) throw new Error('not a readable video: ' + path.basename(src));
  const F = fps || pr.fps || 30, last = Math.max(0, Math.floor(pr.dur * F) - 1), tiles = [], times = [];
  // whole frames: frame f is seeked at (f - 0.5) / F (an accurate seek gives the first frame at or after it), so a rounded
  // time never lands on the next frame
  for (const sm of seams) for (const d of [-Math.round(0.25 * F), -1, 0, 1, Math.round(0.25 * F)]) {
    const f = Math.min(Math.max(0, Math.round(sm.t * F) + d), last), s = f / F;
    times.push(+s.toFixed(4)); tiles.push({ src, t: Math.max(0, (f - 0.5) / F), kind: 'video', text: lab(s, f, sm) });
  }
  return { ...sheet(tiles, out, { cols: 5 }), times, fps: F };
}
