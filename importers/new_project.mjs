// Create a workbench project from a song file + lyrics text (empty shots, entities, script, notes, requests).
//   node importers/new_project.mjs <id> --song <audio file> [--lyrics <file.txt|file.lrc>] [--title "Title"]
//        [--bpm 120] [--beats-per-bar 4] [--offset <ms of the first downbeat>] [--cap <USD>] [--render <video>] [--force]
// Needs ffmpeg on PATH (decodes the song for the waveform peaks and the energy curve).
//
// Lyrics:
//   .lrc / lines starting with [mm:ss.xx]  -> timed lines (words spread evenly inside each line)
//   plain text                             -> lines spread evenly over the song (marked "timing": "estimated";
//                                             fix them later, by hand or with a forced aligner, and re-write song.json)
//   [Verse 1] / [Chorus] / # Bridge headers start sections; otherwise every blank-line block is a section.
// The song and the render are copied into data/<id>/audio/ and data/<id>/render/ (paths relative to the project).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as S from '../lib/store.mjs';

const SR = 22050;
// decode to mono float32 at SR with ffmpeg
export function decode(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${r.error?.message || r.stderr?.toString()}`);
  const b = r.stdout; return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
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
  let k0 = Math.ceil(-offsetMs / beat);
  for (let k = k0; ; k++) { const t = Math.round(offsetMs + k * beat); if (t > durMs) break; if (t < 0) continue; beats.push(t); if (((k % beatsPerBar) + beatsPerBar) % beatsPerBar === 0) downbeats.push(t); }
  return { bpm, beat_ms: +beat.toFixed(3), bar_ms: +(beat * beatsPerBar).toFixed(3), beats_per_bar: beatsPerBar, grid: { beats, downbeats } };
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
// lyrics text -> {sections, lines} (times in ms, inside [0, durMs])
export function parseLyrics(text, durMs) {
  const blocks = []; let cur = null, timed = false;
  const LRC = /^\s*\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/, HEAD = /^\s*(?:\[([^\]\d][^\]]*)\]|#+\s*(.+))\s*$/, META = /^\s*\[(ar|ti|al|by|offset|length|re|ve):/i;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (META.test(raw)) continue;
    const h = HEAD.exec(raw), l = LRC.exec(raw);
    if (h && !l) { cur = { label: (h[1] || h[2]).trim(), lines: [], explicit: true }; blocks.push(cur); continue; }
    if (!raw.trim()) { if (cur && cur.lines.length && !cur.explicit) cur = null; continue; }
    if (!cur) { cur = { label: null, lines: [] }; blocks.push(cur); }
    if (l) { timed = true; cur.lines.push({ text: l[3].trim(), t0: Math.round((Number(l[1]) * 60 + Number(l[2])) * 1000) }); }
    else cur.lines.push({ text: raw.trim() });
  }
  const bl = blocks.filter(b => b.lines.length);
  if (!bl.length) return { sections: [{ id: 'song', label: 'Song', t0: 0, t1: durMs, energy: 0 }], lines: [], timing: 'none' };
  const all = bl.flatMap(b => b.lines);
  if (!timed || all.some(x => x.t0 == null)) {          // spread evenly between 6 % and 94 % of the song
    const a = durMs * 0.06, span = durMs * 0.88, step = span / all.length;
    all.forEach((x, i) => { x.t0 = Math.round(a + i * step); x.t1 = Math.round(a + (i + 0.85) * step); });
  } else all.forEach((x, i) => { const nx = all[i + 1]?.t0 ?? durMs; x.t1 = Math.min(nx - 50, x.t0 + Math.max(800, x.text.split(/\s+/).length * 450)); });
  const used = new Map(), sections = [], lines = [];
  bl.forEach((b, i) => {
    const label = b.label || (bl.length === 1 ? 'Song' : `Part ${i + 1}`);
    let id = slug(label); const n = (used.get(id) || 0) + 1; used.set(id, n); if (n > 1) id = `${id}-${n}`;
    const t0 = i === 0 ? 0 : Math.max(0, b.lines[0].t0 - 300), t1 = i === bl.length - 1 ? durMs : Math.max(t0 + 1, bl[i + 1].lines[0].t0 - 300);
    sections.push({ id, label, t0, t1, energy: 0 });
    b.lines.forEach((x, k) => {
      const ws = x.text.split(/\s+/).filter(Boolean), d = (x.t1 - x.t0) / Math.max(1, ws.length);
      lines.push({ id: `${id}/${k}`, section: id, idx: k, kind: 'sung', voice: 'none', t0: x.t0, t1: x.t1, text: x.text,
        words: ws.map((w, j) => ({ w, t0: Math.round(x.t0 + j * d), t1: Math.round(x.t0 + (j + 0.9) * d), p: 0 })) });
    });
  });
  // the first section starts at 0, sections tile the song
  for (let i = 0; i < sections.length - 1; i++) sections[i].t1 = sections[i + 1].t0;
  return { sections, lines, timing: timed ? 'lrc' : 'estimated' };
}

function copyInto(project, src, sub) {
  const dir = path.join(S.projDir(project), sub); fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(src).replace(/[^\w.() -]+/g, '_'); fs.copyFileSync(src, path.join(dir, name)); return `${sub}/${name}`;
}

// the whole import; returns the project id. Used by the CLI below and by tools/make_demo.mjs
export function newProject(id, { song, lyrics = '', title, bpm = 120, beatsPerBar = 4, offset = 0, cap = 20, render, force = false }) {
  if (!S.validId(id)) throw new Error('id: letters, digits, _ and - (max 64)');
  if (!song || !fs.existsSync(song)) throw new Error('--song <audio file> is required and must exist');
  const d = S.projDir(id, false);
  if (fs.existsSync(d)) { if (!force) throw new Error(`data/${id} exists (pass --force to replace it)`); fs.rmSync(d, { recursive: true, force: true }); }
  S.createProject(id, title || id);
  const x = decode(song), durMs = Math.round(x.length / SR * 1000);
  const mix = copyInto(id, song, 'audio');
  const rnd = render ? copyInto(id, render, 'render') : null;
  fs.mkdirSync(path.join(d, 'peaks'), { recursive: true });
  S.writeJSON(path.join(d, 'peaks', 'mix.json'), peaks(x, 'mix', mix));
  S.writeJSON(path.join(d, 'energy.json'), energy(x));
  const L = parseLyrics(lyrics, durMs);
  S.writeJSON(path.join(d, 'song.json'), { title: title || id, duration_ms: durMs, ...grid(durMs, bpm, beatsPerBar, offset),
    audio: { mix, render: rnd, stems: [] }, timing: L.timing, sections: L.sections, lines: L.lines });
  S.writeJSON(path.join(d, 'events.json'), L.sections.map(s => ({ id: 'section_' + s.id, t: s.t0, kind: 'section', note: `${s.label} starts` })));
  const C = S.readJSON(path.join(d, 'costs.json'), {}); S.writeJSON(path.join(d, 'costs.json'), { ...C, cap_usd: Number(cap) });
  return { id, duration_ms: durMs, sections: L.sections.length, lines: L.lines.length, timing: L.timing };
}

// ------------------------------------------------------------------ CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), id = a.find(x => !x.startsWith('--') && !a[a.indexOf(x) - 1]?.startsWith('--')) || a[0];
  const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  if (!id || a.includes('--help')) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 13).join('\n')); process.exit(id ? 0 : 1); }
  const lyr = opt('lyrics');
  const r = newProject(id, { song: opt('song'), lyrics: lyr ? fs.readFileSync(lyr, 'utf8') : '', title: opt('title'), bpm: Number(opt('bpm', 120)),
    beatsPerBar: Number(opt('beats-per-bar', 4)), offset: Number(opt('offset', 0)), cap: Number(opt('cap', 20)), render: opt('render'), force: a.includes('--force') });
  console.log(`created data/${r.id}: ${(r.duration_ms / 1000).toFixed(1)} s, ${r.sections} sections, ${r.lines} lines (timing: ${r.timing})`);
  console.log(`open http://localhost:8140/?project=${r.id}   (node serve.mjs)`);
}
