// Create a workbench project from a song file + lyrics text (empty shots, entities, script, notes, requests).
//   node importers/new_project.mjs <id> --song <audio file> [--lyrics <file.txt|file.lrc>] [--title "Title"]
//        [--bpm 120] [--beats-per-bar 4] [--offset <ms of the first downbeat>] [--cap <USD>] [--render <video>] [--force]
//   node importers/new_project.mjs <id> --lyrics <file> [--title "Title"]      (no song yet: lyrics only; a placeholder
//        duration and estimated timings until a song is added with the song_attach op / MCP tool or the page)
// Needs ffmpeg on PATH (decodes the song for the waveform peaks and the energy curve).
// attachSong(project, file) adds or replaces the song of an existing project (the wizard, the song_attach op).
//
// Lyrics:
//   .lrc / lines starting with [mm:ss.xx]  -> timed lines (words spread evenly inside each line); several tags on one
//                                             line repeat it; an empty timed line ends the previous line; untimed lines
//                                             in an LRC are placed between their timed neighbours ("timing": "mixed")
//   plain text                             -> lines spread evenly over the song (marked "timing": "estimated";
//                                             fix them later, by hand or with a forced aligner, and re-write song.json)
//   [Verse 1] / [Chorus] / # Bridge headers start sections; otherwise every blank-line block is a section.
// The song and the render are copied into data/<id>/audio/ and data/<id>/render/ (paths relative to the project).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as S from '../lib/store.mjs';
import * as F from '../js/flow.js';

const SR = 22050;
// decode to mono float32 at SR with ffmpeg
export function decode(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${r.error?.message || r.stderr?.toString()}`);
  const b = r.stdout, n = Math.floor(b.length / 4);
  if (!n) throw new Error(`ffmpeg decoded no audio from ${file}`);
  // a Float32Array view needs a 4-byte aligned offset (small buffers come from Node's shared pool): copy otherwise
  return b.byteOffset % 4 ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 4)) : new Float32Array(b.buffer, b.byteOffset, n);
}
// peaks/<id>.json: min/max per 5 ms bin, int8 (value/127*scale), base64 (the page's waveform lanes)
export function peaks(x, id, source) {
  const bin = SR * 0.005, n = Math.ceil(x.length / bin), mn = new Float32Array(n), mx = new Float32Array(n);
  let peak = 1e-6;
  for (let i = 0; i < n; i++) {
    let a = Infinity, b = -Infinity; const e = Math.min(x.length, Math.round((i + 1) * bin));
    for (let k = Math.round(i * bin); k < e; k++) { const v = x[k]; if (v < a) a = v; if (v > b) b = v; }
    mn[i] = a === Infinity ? 0 : a; mx[i] = b === -Infinity ? 0 : b; peak = Math.max(peak, Math.abs(mn[i]), Math.abs(mx[i]));
  }
  const q = (arr) => Buffer.from(Int8Array.from(arr, v => Math.max(-127, Math.min(127, Math.round(v / peak * 127)))).buffer).toString('base64');
  return { id, source, bin_ms: 5, n, scale: peak, encoding: 'int8 base64, value/127*scale', min: q(mn), max: q(mx) };
}
// energy.json: RMS at 24 fps (0-1) and a crude onset strength (positive RMS change, 0-1)
export function energy(x) {
  const fps = 24, hop = SR / fps, n = Math.ceil(x.length / hop), rms = [];
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = Math.round(i * hop); k < Math.min(x.length, Math.round((i + 1) * hop)); k++) { s += x[k] * x[k]; c++; } rms.push(Math.sqrt(s / Math.max(1, c))); }
  const top = Math.max(1e-6, ...rms), r = rms.map(v => v / top);
  const on = r.map((v, i) => Math.max(0, v - (r[i - 1] ?? 0))); const ot = Math.max(1e-6, ...on);
  return { fps, rms: r.map(v => +v.toFixed(2)), onset: on.map(v => +(v / ot).toFixed(2)) };
}
export function grid(durMs, bpm, beatsPerBar, offsetMs) {
  const beat = 60000 / bpm, beats = [], downbeats = [];
  const k0 = Math.ceil(-offsetMs / beat), k1 = Math.floor((durMs - offsetMs) / beat) + 1;   // bounded: never loops forever
  for (let k = k0; k <= k1; k++) { const t = Math.round(offsetMs + k * beat); if (t > durMs) break; if (t < 0) continue; beats.push(t); if (((k % beatsPerBar) + beatsPerBar) % beatsPerBar === 0) downbeats.push(t); }
  return { bpm, beat_ms: +beat.toFixed(3), bar_ms: +(beat * beatsPerBar).toFixed(3), beats_per_bar: beatsPerBar, grid: { beats, downbeats } };
}
// G6: the tempo and the first downbeat from the song itself (no dependency): an onset envelope at 100 fps (positive change
// of the log energy), its autocorrelation over 60-200 BPM weighted toward 120 (so a half / double tempo loses), refined by a
// parabola; the beat phase is where the onsets line up best, the downbeat the strongest of beats_per_bar phases.
// -> {bpm, offset_ms, confidence 0-1} or null when the song has no clear beat (confidence < 0.2)
export function tempo(x, beatsPerBar = 4) {
  const fps = 100, hop = SR / fps, n = Math.floor(x.length / hop);
  if (n < fps * 6) return null;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const a = Math.round(i * hop), b = Math.round((i + 1) * hop); for (let k = a; k < b; k++) s += x[k] * x[k]; e[i] = Math.log(1e-9 + s / Math.max(1, b - a)); }
  const o = new Float32Array(n); let mean = 0;
  for (let i = 1; i < n; i++) { o[i] = Math.max(0, e[i] - e[i - 1]); mean += o[i]; }
  mean /= n; for (let i = 0; i < n; i++) o[i] -= mean;
  { const c = Float32Array.from(o); for (let i = 2; i < n - 2; i++) o[i] = (c[i - 2] + 2 * c[i - 1] + 3 * c[i] + 2 * c[i + 1] + c[i + 2]) / 9; }   // a beat between two frames still lines up
  const lo = Math.floor(fps * 60 / 200), hi = Math.ceil(fps * 60 / 60), ac = new Float64Array(hi + 2);
  for (let L = lo - 1; L <= hi + 1; L++) { let s = 0; for (let i = 0; i + L < n; i++) s += o[i] * o[i + L]; ac[L] = s / (n - L); }
  let best = -1, bv = -Infinity;
  for (let L = lo; L <= hi; L++) {
    const w = Math.exp(-0.5 * (Math.log2((fps * 60 / L) / 120) / 0.9) ** 2);
    const v = ac[L] * w;
    if (v > bv) { bv = v; best = L; }
  }
  if (best < 0 || ac[best] <= 0) return null;
  let a0 = 0; for (let i = 0; i < n; i++) a0 += o[i] * o[i]; a0 /= n;
  const confidence = ac[best] / Math.max(1e-12, a0);   // the normalised autocorrelation at the beat: ~0 for noise, ~1 for a click track
  if (confidence < 0.2) return null;
  const a = ac[best - 1], b = ac[best], c = ac[best + 1], den = a - 2 * b + c, shift = den ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
  let bpm = fps * 60 / (best + shift);
  bpm = Math.abs(bpm - Math.round(bpm)) < 0.35 ? Math.round(bpm) : +bpm.toFixed(1);
  const beat = fps * 60 / bpm, score = (ph) => { let s = 0; for (let t = ph; t < n; t += beat) s += o[Math.round(t)] || 0; return s; };
  let ph = 0, pv = -Infinity;
  for (let p = 0; p < beat; p += 0.5) { const v = score(p); if (v > pv) { pv = v; ph = p; } }
  let db = 0, dv = -Infinity;
  for (let k = 0; k < beatsPerBar; k++) { let s = 0; for (let t = ph + k * beat; t < n; t += beat * beatsPerBar) s += o[Math.round(t)] || 0; if (s > dv) { dv = s; db = k; } }
  return { bpm, offset_ms: Math.round((ph + db * beat) / fps * 1000), confidence: +confidence.toFixed(2) };
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
// lyrics text -> {sections, lines} (times in ms, inside [0, durMs])
export function parseLyrics(text, durMs) {
  const blocks = []; let cur = null, timed = false, last = null;
  const LRC = /^\s*((?:\[\d+:\d+(?:\.\d+)?\]\s*)+)(.*)$/, TAG = /\[(\d+):(\d+(?:\.\d+)?)\]/g, HEAD = /^\s*(?:\[([^\]\d][^\]]*)\]|#+\s*(.+))\s*$/, META = /^\s*\[(ar|ti|al|by|offset|length|re|ve):/i;
  const ends = [];   // empty timed lines: the end of the line before them
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (META.test(raw)) continue;
    const h = HEAD.exec(raw), l = LRC.exec(raw);
    if (h && !l) { cur = { label: (h[1] || h[2]).trim(), lines: [], explicit: true }; blocks.push(cur); continue; }
    if (!raw.trim()) { if (cur && cur.lines.length && !cur.explicit) cur = null; continue; }
    if (l) {
      timed = true;
      const ts = [...l[1].matchAll(TAG)].map(m => Math.min(Math.max(0, durMs - 1), Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000)));
      if (!l[2].trim()) { ends.push(...ts); continue; }
      if (!cur) { cur = { label: null, lines: [] }; blocks.push(cur); }
      for (const t0 of ts) cur.lines.push(last = { text: l[2].trim(), t0 });
    } else {
      if (!cur) { cur = { label: null, lines: [] }; blocks.push(cur); }
      cur.lines.push(last = { text: raw.trim() });
    }
  }
  let bl = blocks.filter(b => b.lines.length);
  if (!bl.length) return { sections: [{ id: 'song', label: 'Song', t0: 0, t1: durMs, energy: 0 }], lines: [], timing: 'none' };
  const all = bl.flatMap(b => b.lines);
  const est = (x) => Math.max(800, x.text.split(/\s+/).length * 450);
  let mixed = false;
  if (!timed) {          // spread evenly between 6 % and 94 % of the song
    const a = durMs * 0.06, span = durMs * 0.88, step = span / all.length;
    all.forEach((x, i) => { x.t0 = Math.round(a + i * step); x.t1 = Math.round(a + (i + 0.85) * step); });
  } else {
    // untimed lines in an LRC: spread between their timed neighbours (in file order), flagged as estimated
    for (let i = 0; i < all.length; i++) {
      if (all[i].t0 != null) continue;
      let j = i; while (j < all.length && all[j].t0 == null) j++;
      const lo = i ? all[i - 1].t0 : 0, hi = Math.max(lo, j < all.length ? all[j].t0 : durMs), step = (hi - lo) / (j - i + 1);
      for (let k = i; k < j; k++) { all[k].t0 = Math.min(Math.max(0, durMs - 1), Math.round(lo + (k - i + 1) * step)); all[k].estimated = true; }
      mixed = true; i = j;
    }
    // t1: an end marker before the next line wins, else the next line - 50 ms, capped by a length estimate
    const byT = [...all].sort((p, q) => p.t0 - q.t0); ends.sort((p, q) => p - q);
    byT.forEach((x, i) => {
      const nx = byT[i + 1]?.t0 ?? durMs, end = ends.find(e => e > x.t0 && e <= nx);
      x.t1 = end != null ? end : Math.min(nx - 50, x.t0 + est(x));
    });
  }
  all.forEach(x => { x.t1 = Math.min(durMs, Math.max(x.t0 + 1, x.t1)); });
  // blocks in time order (lines sorted inside each); a block that cannot get its own section joins the previous one
  bl.forEach(b => b.lines.sort((p, q) => p.t0 - q.t0));
  bl = bl.map((b, i) => ({ ...b, i })).sort((p, q) => p.lines[0].t0 - q.lines[0].t0 || p.i - q.i);
  const kept = [];
  for (const b of bl) {
    const prev = kept[kept.length - 1], t0 = prev ? Math.max(prev.t0 + 1, b.lines[0].t0 - 300) : 0;
    if (prev && (t0 > b.lines[0].t0 || t0 >= durMs)) { prev.lines.push(...b.lines); prev.lines.sort((p, q) => p.t0 - q.t0); continue; }
    kept.push({ ...b, t0 });
  }
  const used = new Map(), sections = [], lines = [];
  kept.forEach((b, i) => {
    const label = b.label || (kept.length === 1 ? 'Song' : `Part ${b.i + 1}`);
    let id = slug(label); const n = (used.get(id) || 0) + 1; used.set(id, n); if (n > 1) id = `${id}-${n}`;
    // the first section starts at 0, sections tile the song
    sections.push({ id, label, t0: b.t0, t1: i === kept.length - 1 ? durMs : kept[i + 1].t0, energy: 0 });
    b.lines.forEach((x, k) => {
      const ws = x.text.split(/\s+/).filter(Boolean), d = (x.t1 - x.t0) / Math.max(1, ws.length);
      lines.push({ id: `${id}/${k}`, section: id, idx: k, kind: 'sung', voice: 'none', t0: x.t0, t1: x.t1, text: x.text,
        ...(x.estimated ? { timing: 'estimated' } : {}),
        words: ws.map((w, j) => { const t0 = Math.round(x.t0 + j * d); return { w, t0, t1: Math.max(t0 + 1, Math.round(x.t0 + (j + 0.9) * d)), p: 0 }; }) });
    });
  });
  return { sections, lines, timing: !timed ? 'estimated' : mixed ? 'mixed' : 'lrc' };
}

function copyInto(project, src, sub) {
  const dir = path.join(S.projDir(project), sub); fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(src).replace(/[^\w.() -]+/g, '_'); fs.copyFileSync(src, path.join(dir, name)); return `${sub}/${name}`;
}

// the whole import; returns the project id. Used by the CLI below and by tools/make_demo.mjs
// Everything is decoded and built in a temporary project first; with force the old folder is replaced only on success.
export function newProject(id, { song, lyrics = '', title, bpm = 120, beatsPerBar = 4, offset = 0, cap = 20, render, force = false }) {
  if (!S.validId(id)) throw new Error('id: letters, digits, _ and - (max 64)');
  if (!song || !fs.existsSync(song)) throw new Error('--song <audio file> is required and must exist');
  if (render && !fs.existsSync(render)) throw new Error(`--render ${render} does not exist`);
  [bpm, beatsPerBar, offset, cap] = [bpm, beatsPerBar, offset, cap].map(Number);
  if (!Number.isFinite(bpm) || bpm <= 20 || bpm > 400) throw new Error('--bpm must be a number in (20, 400]');
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) throw new Error('--beats-per-bar must be an integer >= 1');
  if (!Number.isFinite(offset)) throw new Error('--offset must be a number (ms)');
  if (!Number.isFinite(cap) || cap < 0) throw new Error('--cap must be a number >= 0 (USD)');
  const d = S.projDir(id, false);
  if (fs.existsSync(d) && !force) throw new Error(`data/${id} exists (pass --force to replace it)`);
  const x = decode(song), durMs = Math.round(x.length / SR * 1000);
  const L = parseLyrics(lyrics, durMs);
  const tmp = `_import-${process.pid}-${Date.now().toString(36)}`, td = S.projDir(tmp, false);
  try {
    S.createProject(tmp, title || id);
    const mix = copyInto(tmp, song, 'audio');
    const rnd = render ? copyInto(tmp, render, 'render') : null;
    fs.mkdirSync(path.join(td, 'peaks'), { recursive: true });
    S.writeJSON(path.join(td, 'peaks', 'mix.json'), peaks(x, 'mix', mix));
    S.writeJSON(path.join(td, 'energy.json'), energy(x));
    S.writeJSON(path.join(td, 'song.json'), { title: title || id, duration_ms: durMs, ...grid(durMs, bpm, beatsPerBar, offset),
      audio: { mix, render: rnd, stems: [] }, timing: L.timing, sections: L.sections, lines: L.lines });
    S.writeJSON(path.join(td, 'events.json'), L.sections.map(s => ({ id: 'section_' + s.id, t: s.t0, kind: 'section', note: `${s.label} starts` })));
    const C = S.readJSON(path.join(td, 'costs.json'), {}); S.writeJSON(path.join(td, 'costs.json'), { ...C, cap_usd: cap });
    S.writeJSON(path.join(td, 'stages.json'), { rev: 1, stages: F.STAGES.map(x => ({ id: x.id, status: x.id === 'lyrics' && L.lines.length ? 'in_progress' : 'empty', blockers: [] })) });
    // swap: move the old project aside, move the new one in, then delete the old one
    const old = fs.existsSync(d) ? `${d}.old-${Date.now().toString(36)}` : null;
    if (old) fs.renameSync(d, old);
    try { fs.renameSync(td, d); } catch (e) { if (old) fs.renameSync(old, d); throw e; }
    if (old) fs.rmSync(old, { recursive: true, force: true });
  } catch (e) { fs.rmSync(td, { recursive: true, force: true }); throw e; }
  return { id, duration_ms: durMs, sections: L.sections.length, lines: L.lines.length, timing: L.timing };
}

// add or replace the song of an existing project (a lyrics-only one from the wizard, or a new mix): the file is copied
// into audio/ (unless it is already in the project or under a media root), then peaks, energy, beat grid and duration
// are rebuilt and the lyric lines get timings: a project that had no song gets every line re-estimated over the real
// duration (LRC tags in the lyrics win), a project that had one keeps the timings it has.
export function attachSong(project, src, { bpm, beatsPerBar, offset, estimate = false } = {}) {
  if (!src || typeof src !== 'string') throw new S.WbError(400, 'path of the song file required');
  if (!/\.(wav|mp3|m4a|flac|ogg|aac)$/i.test(src)) throw new S.WbError(400, 'the song must be an audio file (wav, mp3, m4a, flac, ogg, aac)');
  if (S.isPrivate(src)) throw new S.WbError(400, 'a PRIVATE path cannot be the song (it would be served and exported)');
  const pd = S.projDir(project);
  const abs = path.isAbsolute(src) ? path.resolve(src) : S.resolveMedia(project, src.replace(/\\/g, '/'));
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new S.WbError(404, 'no such file: ' + src);
  const song = S.read(project, 'song.json'), had = !!song.audio?.mix;
  const x = decode(abs), durMs = Math.round(x.length / SR * 1000);
  const inProj = path.relative(pd, abs), inRoot = path.relative(S.CFG.mediaBase, abs).split(path.sep).join('/');
  const mix = !inProj.startsWith('..') && !path.isAbsolute(inProj) ? inProj.split(path.sep).join('/') : S.isMediaRootPath(inRoot) && !inRoot.startsWith('..') ? inRoot : copyInto(project, abs, 'audio');
  fs.mkdirSync(path.join(pd, 'peaks'), { recursive: true });
  S.writeJSON(path.join(pd, 'peaks', 'mix.json'), peaks(x, 'mix', mix));
  S.writeJSON(path.join(pd, 'energy.json'), energy(x));
  // G6: no bpm given and estimate asked (the page's new project from a song): the tempo and the first downbeat from the song
  const est = estimate && !bpm ? tempo(x, Number(beatsPerBar || song.beats_per_bar || 4)) : null;
  if (est) { bpm = est.bpm; if (offset == null) offset = est.offset_ms; }
  const g = grid(durMs, Number(bpm || song.bpm || 120), Number(beatsPerBar || song.beats_per_bar || 4), Number(offset || 0));
  const next = { ...song, duration_ms: durMs, ...g, audio: { ...(song.audio || {}), mix, stems: song.audio?.stems || [] } };
  delete next.placeholder_duration;
  if (had) next.lines = (next.lines || []).map(l => ({ ...l, t0: Math.min(l.t0, durMs - 2), t1: Math.min(Math.max(l.t1, l.t0 + 1), durMs) }));
  S.write(project, 'song.json', next);
  const sync = S.syncLyrics(project, { reestimate: !had });
  return { project, mix, duration_ms: durMs, bpm: g.bpm, replaced: had, ...(estimate ? { beats: est ? { source: 'estimated', bpm: est.bpm, offset_ms: est.offset_ms, confidence: est.confidence } : { source: bpm ? 'given' : 'default', bpm: g.bpm } } : {}), lines: sync.lines ?? next.lines.length, timing: S.read(project, 'song.json').timing || null };
}

// ------------------------------------------------------------------ CLI
const self = fileURLToPath(import.meta.url);
const real = (p) => { try { p = fs.realpathSync(p); } catch (e) { p = path.resolve(p); } return process.platform === 'win32' ? p.toLowerCase() : p; };
if (process.argv[1] && real(process.argv[1]) === real(self)) {
  const s = { type: 'string' };
  let a;
  try {
    a = parseArgs({ allowPositionals: true, options: { song: s, lyrics: s, title: s, bpm: s, 'beats-per-bar': s, offset: s, cap: s, render: s, force: { type: 'boolean' }, help: { type: 'boolean' } } });
  } catch (e) { console.error(e.message); process.exit(1); }
  const o = a.values, id = a.positionals[0];
  if (!id || o.help) { console.log(fs.readFileSync(self, 'utf8').split('\n').slice(0, 16).join('\n')); process.exit(id ? 0 : 1); }
  try {
    if (!o.song) {
      if (!o.lyrics) throw new Error('give --song <audio file>, --lyrics <file>, or both');
      const r = await S.createGuidedProject({ id, title: o.title, lyrics: fs.readFileSync(o.lyrics, 'utf8'), bpm: o.bpm });
      console.log(`created data/${r.id}: lyrics only, ${r.lines} lines (placeholder duration, estimated timings; add the song later)`);
      process.exit(0);
    }
    const r = newProject(id, { song: o.song, lyrics: o.lyrics ? fs.readFileSync(o.lyrics, 'utf8') : '', title: o.title, bpm: o.bpm ?? 120,
      beatsPerBar: o['beats-per-bar'] ?? 4, offset: o.offset ?? 0, cap: o.cap ?? 20, render: o.render, force: !!o.force });
    console.log(`created data/${r.id}: ${(r.duration_ms / 1000).toFixed(1)} s, ${r.sections} sections, ${r.lines} lines (timing: ${r.timing})`);
    console.log(`open http://localhost:8140/?project=${r.id}   (node serve.mjs)`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
