// E7 song versions and the Suno brief (ROADMAP_v4). Pure functions, no DOM and no Node APIs: the Lyrics stage
// (core/songver.js) and the data layer (lib/ops/songs.mjs) share them. Nothing here (or anywhere) calls Suno: the director
// pastes the brief into Suno by hand and uploads the song it makes.
//
// song.json (the server's: never a page save) gains
//   versions: [{id "v2", label, source: suno | upload | import | other, audio (the file), duration_ms, bpm, beats_per_bar,
//               offset_ms, style?, exclude?, lyrics_prompt? (what was pasted into Suno), suno?{title, model, link},
//               lines: [{id, t0, t1}] (the lyric timings in THIS take), alignment {method: lrc | lines | stretch | offset |
//               current, matched, total, offset_ms?, scale?}, by, via, at}]
//   current_version: "v1"
// v1 is the song as it was before the first version was added (source "import"). Adding a version never changes the song;
// USING one (the director, in the page: song_version_use) switches the audio, the beat grid and the lyric timings, and
// moves every scene / shot boundary and named event through the same time map (one new scenes and storyboard version):
// the E1 re-time preview shows what moves before anything is written.
// review #3 M2 for song versions too: approved / locked shots, ok scenes and picked takes that get too short are `held`
import { heldOf } from './events.js';
export const VERSION_ID = /^v\d{1,4}$/;
export const SOURCES = ['suno', 'upload', 'import', 'other'];
export const STYLE_MAX = 1000, EXCLUDE_MAX = 1000, LYRICS_MAX = 5000, TITLE_MAX = 80;   // the Suno paste gates (custom mode, v4.5+)
const clock = (ms) => { const s = Math.max(0, ms || 0) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n);
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// the versions, with v1 made from the song as it is when none was recorded yet
export function versionsOf(song) {
  const vs = Array.isArray(song?.versions) ? song.versions : [];
  if (vs.length) return vs;
  return [{ id: 'v1', label: 'the song as imported', source: 'import', audio: song?.audio?.mix || null, duration_ms: song?.duration_ms || 0, bpm: song?.bpm || null,
    beats_per_bar: song?.beats_per_bar || 4, offset_ms: song?.grid?.beats?.[0] ?? 0, lines: (song?.lines || []).map(l => ({ id: l.id, t0: l.t0, t1: l.t1 })), alignment: { method: 'current' }, by: 'import', via: 'import', at: null }];
}
export const currentVersionId = (song) => song?.current_version || 'v1';
export const nextVersionId = (vs) => `v${vs.reduce((m, v) => Math.max(m, Number(/^v(\d+)$/.exec(v.id)?.[1]) || 0), 0) + 1}`;

// ------------------------------------------------------------------ alignment: where each lyric line starts in the new take
// an LRC text ("[01:02.50] words") -> [{t, text}] (lines without a time are skipped; section tags too)
export function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]; if (!tags.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').trim(); if (!words) continue;
    for (const m of tags) out.push({ t: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text: words });
  }
  return out.sort((a, b) => a.t - b.t);
}
// the song's lines and the timed lines of the new take, matched by their words in order (longest common subsequence)
// -> pairs [{id, from (t0 now), to (t0 in the take)}]
export function matchLrc(lines, timed) {
  const a = lines.map(l => norm(l.text)), b = timed.map(x => norm(x.text)), n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] && a[i] === b[j]) { out.push({ id: lines[i].id, from: lines[i].t0, to: timed[j].t }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return out;
}
// knots [{from, to}] (strictly increasing in both) -> t -> t': piecewise linear between knots, from 0 -> 0 to the first and
// from the last to the end (oldDur -> newDur), clamped to [0, newDur]. Pairs that break the order are dropped (a line sung earlier than the one before it cannot be a stretch).
export function timeMap(pairs, { oldDur, newDur } = {}) {
  const k = [];
  for (const p of [...pairs].sort((x, y) => x.from - y.from)) { const last = k.at(-1); if (!last || (p.from > last.from && p.to > last.to)) k.push({ from: p.from, to: p.to }); }
  const clamp = (t) => Math.max(0, Math.min(newDur ?? Infinity, Math.round(t)));
  const f = (t) => {
    if (!k.length) return clamp(t);
    if (oldDur != null && t >= oldDur) return newDur ?? clamp(t);
    if (t <= k[0].from) return clamp(k[0].from > 0 ? t * k[0].to / k[0].from : k[0].to);   // the start of the song stays its start
    for (let i = 1; i < k.length; i++) if (t <= k[i].from) { const a = k[i - 1], b = k[i]; return clamp(a.to + (t - a.from) * (b.to - a.to) / (b.from - a.from)); }
    const z = k.at(-1), end = oldDur != null && newDur != null && oldDur > z.from ? (t - z.from) * (newDur - z.to) / (oldDur - z.from) : t - z.from;
    return clamp(z.to + end);
  };
  f.knots = k; return f;
}
export const linearMap = ({ offset_ms = 0, scale = 1, newDur, oldDur } = {}) => { const f = (t) => (oldDur != null && t >= oldDur && newDur != null ? newDur : Math.max(0, Math.min(newDur ?? Infinity, Math.round(offset_ms + t * scale)))); f.knots = []; return f; };
// how a new take lines up with the song now: {lrc} | {lines: [{id, t0}]} | {offset_ms, scale} (default: stretch to the new
// length) -> {map, alignment}
export function alignment(song, { lrc, lines, offset_ms, scale, newDur } = {}) {
  const cur = song?.lines || [], oldDur = song?.duration_ms || 0;
  if (lrc != null && String(lrc).trim()) {
    const timed = parseLrc(lrc); if (!timed.length) throw new Error('lrc: no timed line ("[mm:ss.xx] words")');
    const pairs = matchLrc(cur, timed), map = timeMap(pairs, { oldDur, newDur });
    return { map, alignment: { method: 'lrc', matched: map.knots.length, total: cur.length } };
  }
  if (Array.isArray(lines) && lines.length) {
    const byId = new Map(cur.map(l => [l.id, l])), pairs = [];
    for (const x of lines) { const l = byId.get(x?.id), t = Math.round(Number(x?.t0)); if (l && Number.isFinite(t) && t >= 0 && (newDur == null || t <= newDur)) pairs.push({ id: l.id, from: l.t0, to: t }); }
    if (!pairs.length) throw new Error('lines: [{id (a song line id), t0 (ms in the new take)}], none matched');
    const map = timeMap(pairs, { oldDur, newDur });
    return { map, alignment: { method: 'lines', matched: map.knots.length, total: cur.length } };
  }
  if (offset_ms != null || scale != null) {
    const o = Math.round(Number(offset_ms) || 0), s = scale == null ? 1 : Number(scale);
    if (!(s > 0.25 && s < 4)) throw new Error('scale: 0.25-4');
    return { map: linearMap({ offset_ms: o, scale: s, newDur, oldDur }), alignment: { method: 'offset', offset_ms: o, scale: s, matched: 0, total: cur.length } };
  }
  const s = oldDur && newDur ? newDur / oldDur : 1;
  return { map: linearMap({ scale: s, newDur, oldDur }), alignment: { method: 'stretch', scale: +s.toFixed(5), matched: 0, total: cur.length } };
}
// the song's lines through a map: each line's start / end mapped, its words spread the same way inside it
export function mapLines(lines, map) {
  return (lines || []).map(l => {
    const t0 = map(l.t0), t1 = Math.max(t0 + 1, map(l.t1)), k = (t1 - t0) / Math.max(1, l.t1 - l.t0);
    return { ...l, t0, t1, ...(Array.isArray(l.words) ? { words: l.words.map(w => ({ ...w, t0: Math.round(t0 + (w.t0 - l.t0) * k), t1: Math.round(t0 + (w.t1 - l.t0) * k) })) } : {}) };
  });
}
// the map from the song now to a stored version: its own line timings where it has them, else the version's alignment knots
export function mapTo(song, v) {
  const byId = new Map((v.lines || []).map(l => [l.id, l]));
  const pairs = (song?.lines || []).filter(l => byId.has(l.id)).map(l => ({ id: l.id, from: l.t0, to: byId.get(l.id).t0 }));
  return timeMap(pairs, { oldDur: song?.duration_ms || 0, newDur: v.duration_ms });
}

// ------------------------------------------------------------------ what moves: the E1 re-time preview's shape
// map + {scenes, shots, events, song (now), dur (new)} -> {rows [{kind: scene | shot | event, id, edge, from, to, event (the
// version id), why: "song"}], scenes, shots, events (moved copies), problems, beats, changed, moves: []}
export function songPlan({ map, scenes = [], shots = [], events = [], dur, version = 'song', approvals = null, states = null } = {}) {
  const sc = structuredClone(scenes), sh = structuredClone(shots), ev = structuredClone(events), rows = [], problems = [];
  for (const [kind, list] of [['scene', sc], ['shot', sh]]) for (const x of list) for (const edge of ['t0', 't1']) {
    const to = map(x[edge]); if (to !== x[edge]) { rows.push({ kind, id: x.id, edge, from: x[edge], to, event: version, why: 'song' }); x[edge] = to; }
  }
  let beats = 0;
  for (const s of sc) for (const b of s.beats || []) { const t = Math.max(s.t0, Math.min(s.t1, map(b.t))); if (t !== b.t) { b.t = t; beats++; } }
  for (const e of ev) { if (!Number.isFinite(e.t)) continue; const to = map(e.t); if (to !== e.t) { rows.push({ kind: 'event', id: e.id, edge: 't', from: e.t, to, event: version, why: 'song' }); e.t = to; } }
  for (const [kind, list] of [['scene', sc], ['shot', sh]]) for (const x of list) if (!(x.t0 >= 0 && x.t1 > x.t0 && (!dur || x.t1 <= dur))) problems.push(`${kind} ${x.id} would be ${clock(x.t0)}–${clock(x.t1)}: no length left in the new take`);
  rows.sort((a, b) => a.from - b.from || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const held = heldOf(rows.filter(r => r.kind !== 'event'), { scenes, shots: sh, approvals, states });
  return { moves: [], rows, scenes: sc, shots: sh, events: ev, problems, beats, held, changed: { scenes: rows.some(r => r.kind === 'scene') || beats > 0, shots: rows.some(r => r.kind === 'shot'), events: rows.some(r => r.kind === 'event') } };
}
export const planSummary = (plan, linesMoved) => `${linesMoved} lyric line${linesMoved === 1 ? '' : 's'} · ${plan.rows.filter(r => r.kind === 'scene').length} scene and ${plan.rows.filter(r => r.kind === 'shot').length} shot boundaries · ${plan.rows.filter(r => r.kind === 'event').length} events move`;
export const linesMoved = (lines, map) => (lines || []).filter(l => map(l.t0) !== l.t0).length;

// ------------------------------------------------------------------ the Suno brief: style + lyrics with section tags
// from the lyrics stage's current version (js/flow.js shape): every section as its [tag] (a cue section without lines, like
// "[Stop - the beat cuts out for one bar]", stays a tag: not sung), then its lines. -> the texts, counts and gates
export function sunoBrief({ version, style = '', exclude = '', title = '' } = {}) {
  const secs = version?.sections || [];
  const lyrics = secs.map(s => [`[${String(s.label || 'Part').replace(/[\[\]]/g, '')}]`, ...(s.lines || []).map(l => String(l.text || '').trim()).filter(Boolean)].join('\n')).join('\n\n');
  const st = str(style, 4000).trim(), ex = str(exclude, 4000).trim(), ti = str(title, 400).trim();
  const counts = { style: st.length, exclude: ex.length, lyrics: lyrics.length, title: ti.length };
  const gates = [['style', STYLE_MAX], ['exclude', EXCLUDE_MAX], ['lyrics', LYRICS_MAX], ['title', TITLE_MAX]].map(([k, max]) => ({ field: k, count: counts[k], max, ok: counts[k] <= max }));
  const warnings = [];
  if (!st) warnings.push('style is empty: describe genre, tempo, key, instruments, voices and the arc (Suno "Styles")');
  if (!lyrics.trim()) warnings.push('no lyrics yet (the Lyrics stage)');
  for (const g of gates) if (!g.ok) warnings.push(`${g.field}: ${g.count} characters, over the ${g.max} Suno takes`);
  const cues = secs.filter(s => !(s.lines || []).length).length;
  const text = `STYLE (paste into "Styles"):\n${st}\n\n${ex ? `EXCLUDE (paste into "Exclude styles"):\n${ex}\n\n` : ''}${ti ? `TITLE:\n${ti}\n\n` : ''}LYRICS (paste into "Lyrics"):\n${lyrics}\n`;
  return { style: st, exclude: ex, title: ti, lyrics, text, counts, gates, ok: gates.every(g => g.ok) && !!st && !!lyrics.trim(), warnings, sections: secs.length, cues };
}
export const tc = clock;
