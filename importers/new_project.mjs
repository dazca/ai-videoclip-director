// Create a workbench project from a song file + lyrics text (empty shots, entities, script, notes, requests).
//   node importers/new_project.mjs <id> --song <audio file> [--lyrics <file.txt|file.lrc>] [--title "Title"]
//        [--bpm 120] [--beats-per-bar 4] [--offset <ms of the first downbeat>] [--cap <USD>] [--render <video>] [--force]
// Needs ffmpeg on PATH (decodes the song for the waveform peaks and the energy curve).
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
    // swap: move the old project aside, move the new one in, then delete the old one
    const old = fs.existsSync(d) ? `${d}.old-${Date.now().toString(36)}` : null;
    if (old) fs.renameSync(d, old);
    try { fs.renameSync(td, d); } catch (e) { if (old) fs.renameSync(old, d); throw e; }
    if (old) fs.rmSync(old, { recursive: true, force: true });
  } catch (e) { fs.rmSync(td, { recursive: true, force: true }); throw e; }
  return { id, duration_ms: durMs, sections: L.sections.length, lines: L.lines.length, timing: L.timing };
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
  if (!id || o.help) { console.log(fs.readFileSync(self, 'utf8').split('\n').slice(0, 13).join('\n')); process.exit(id ? 0 : 1); }
  try {
    const r = newProject(id, { song: o.song, lyrics: o.lyrics ? fs.readFileSync(o.lyrics, 'utf8') : '', title: o.title, bpm: o.bpm ?? 120,
      beatsPerBar: o['beats-per-bar'] ?? 4, offset: o.offset ?? 0, cap: o.cap ?? 20, render: o.render, force: !!o.force });
    console.log(`created data/${r.id}: ${(r.duration_ms / 1000).toFixed(1)} s, ${r.sections} sections, ${r.lines} lines (timing: ${r.timing})`);
    console.log(`open http://localhost:8140/?project=${r.id}   (node serve.mjs)`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
