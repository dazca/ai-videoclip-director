// The guided creation flow (docs/SPEC_v3_GUIDED.md): the seven stages and the lyrics model. Pure functions, no DOM and
// no Node APIs: the page (tabs/lyrics.js, core/rail.js) and the data layer (lib/store.mjs) import the same code, so
// both derive the same defaults, the same line ids and the same song timings.
//
// stages.json  {rev, stages: [{id, status, done_by?, via?, updated?, blockers[], note?}]}
//   id      lyrics | script | breakdown | characters | scenery | storyboard | final   (always all seven, in this order)
//   status  empty | in_progress | needs_you | done      (only the page sets done: serve.mjs stamps done_by/via "page")
//   A project without the file reads as derived: a stage whose files already hold content counts as done.
// lyrics.json  {rev, current: "v3", seq, versions: [{id, n, created, by, via, message, from?, sections: [{id, label,
//   lines: [{id, text, t?}]}]}], notes: [{id, line, w: [w0, w1] | null, quote, text, by, via, to?, kind?, status,
//   at, version, replies: [{id, text, by, via, at}], resolved_by?, resolved_at?}]}
//   A version is immutable; a save appends one and moves `current`; a restore appends a copy. Line ids are stable
//   across versions (a changed line keeps its id, so its timings and notes follow it); song.json lines use the same
//   ids. A project without the file reads as one version derived from song.json (ids = the song's line ids).
// scenes.json (stage 2, the script draft): js/scenes.js. breakdown.json (stage 3): js/breakdown.js. storyboard.json
// (stage 6): js/storyboard.js.
import { currentScript, gaps as scriptGaps, intakeOpen } from './scenes.js';
import { currentBreakdown, PROMOTABLE } from './breakdown.js';
import { currentBoard } from './storyboard.js';

export const STAGES = [
  { id: 'lyrics', title: 'Lyrics', n: 1, does: 'the poem: lines, sections, notes, versions; the song file when you have it' },
  { id: 'script', title: 'Script', n: 2, does: 'intake questions, then scenes bound to song time with beats, text and sketches' },
  { id: 'breakdown', title: 'Breakdown', n: 3, does: 'characters, locations, props, wardrobe and FX extracted from the script' },
  { id: 'characters', title: 'Characters', n: 4, does: 'identity sheets and looks per character, iterated with sketch + text' },
  { id: 'scenery', title: 'Scenery', n: 5, does: 'locations and props: bases, variants, iterations' },
  { id: 'storyboard', title: 'Storyboard', n: 6, does: 'shots per scene with frame sketches; the remaining gaps filled' },
  { id: 'final', title: 'Final', n: 7, does: 'everything still draft / changes / review, costs, ready-to-render checklist' },
];
export const STAGE_STATUSES = ['empty', 'in_progress', 'needs_you', 'done'];
export const STATUS_LABEL = { empty: 'empty', in_progress: 'in progress', needs_you: 'needs you', done: 'done' };
export const stageById = (id) => STAGES.find(s => s.id === id);

// what the project files already hold (the page passes its store, the server reads the files)
export function projectFacts({ song, script, shots, entities, lyrics, scenes, breakdown, storyboard }) {
  const ents = entities || [];
  const bitems = (currentBreakdown(breakdown)?.items || []).filter(i => !i.dropped);
  const sv = currentScript(scenes), dur = song?.duration_ms || 0;
  return {
    scenes: sv?.scenes?.length || 0, gapMs: sv ? scriptGaps(sv.scenes, dur).reduce((a, [x, y]) => a + y - x, 0) : dur,
    intakeOpen: scenes ? intakeOpen(scenes).length : 0,
    sceneAsks: (scenes?.notes || []).filter(n => n.status === 'open' && n.to === 'agent').length,
    lines: song?.lines?.length || 0, hasSong: !!song?.audio?.mix, timing: song?.timing || null,
    script: script?.lines?.length || 0, shots: shots?.length || 0,
    characters: ents.filter(e => e.kind === 'character').length, locations: ents.filter(e => e.kind === 'location').length,
    props: ents.filter(e => e.kind === 'prop').length,
    agentAsks: (lyrics?.notes || []).filter(n => n.status === 'open' && n.to === 'agent').length,
    items: bitems.length, itemsToPromote: bitems.filter(i => PROMOTABLE.includes(i.kind) && !breakdown?.states?.[i.id]?.entity_id).length,
    sceneryToPromote: bitems.filter(i => (i.kind === 'location' || i.kind === 'prop') && !breakdown?.states?.[i.id]?.entity_id).length,
    breakdownAsks: (breakdown?.notes || []).filter(n => n.status === 'open' && n.to === 'agent').length,
    // stage 6: the storyboard (a project without storyboard.json reads its shots from shots.json)
    ...(() => { const bs = currentBoard(storyboard)?.shots || [];
      return { boardShots: bs.length, scenesNoShots: sv && storyboard ? sv.scenes.filter(s => !bs.some(x => x.scene === s.id)).length : 0, shotsNoFrame: bs.filter(s => !s.sketch && !s.thumb).length,
        boardAsks: (storyboard?.notes || []).filter(n => n.status === 'open' && n.to === 'agent').length }; })(),
  };
}
// a project without stages.json: a stage counts as done when its files already hold content (existing productions)
export function deriveStages(f) {
  const has = { lyrics: f.lines > 0, script: f.script > 0 || f.scenes > 0, breakdown: (f.items || 0) + f.characters + f.locations + f.props > 0, characters: f.characters > 0,
    scenery: f.locations + f.props > 0, storyboard: f.shots > 0 || (f.boardShots || 0) > 0, final: false };
  return { rev: 0, derived: true, stages: STAGES.map(s => ({ id: s.id, status: has[s.id] ? 'done' : 'empty', ...(has[s.id] ? { done_by: 'derived' } : {}), blockers: [] })) };
}
// any stages.json (or none) -> all seven stages in order, unknown statuses read as empty
export function normStages(doc, facts) {
  if (!doc || !Array.isArray(doc.stages)) return deriveStages(facts || {});
  const by = new Map(doc.stages.filter(s => s && typeof s === 'object').map(s => [s.id, s]));
  return { ...doc, stages: STAGES.map(s => { const x = by.get(s.id) || {}; return { ...x, id: s.id, status: STAGE_STATUSES.includes(x.status) ? x.status : 'empty', blockers: Array.isArray(x.blockers) ? x.blockers : [] }; }) };
}
// what stands in the way of each stage (computed) plus what an agent wrote (stored blockers)
export function autoBlockers(stages, f) {
  const st = Object.fromEntries(stages.map(s => [s.id, s.status]));
  const need = (id) => st[id] === 'done' ? [] : [`${stageById(id).title.toLowerCase()} not done`];
  return {
    lyrics: [...(f.lines ? [] : ['no lyrics yet']), ...(f.lines && !f.hasSong ? ['no song file yet (timings estimated)'] : []), ...(f.agentAsks ? [`${f.agentAsks} open ask${f.agentAsks > 1 ? 's' : ''} for the agent`] : [])],
    script: [...need('lyrics'), ...(f.intakeOpen ? [`${f.intakeOpen} intake question${f.intakeOpen > 1 ? 's' : ''} open`] : []),
      ...(f.scenes ? (f.gapMs >= 1000 ? [`${Math.round(f.gapMs / 1000)} s unscripted`] : []) : ['no scenes yet']),
      ...(f.sceneAsks ? [`${f.sceneAsks} open ask${f.sceneAsks > 1 ? 's' : ''} for the agent`] : [])],
    breakdown: [...need('script'), ...(f.items || f.characters + f.locations + f.props ? [] : ['no items yet']), ...(f.breakdownAsks ? [`${f.breakdownAsks} open ask${f.breakdownAsks > 1 ? 's' : ''} for the agent`] : [])],
    characters: [...need('breakdown'), ...(f.itemsToPromote ? [`${f.itemsToPromote} breakdown item${f.itemsToPromote > 1 ? 's' : ''} not yet entities`] : [])], scenery: [...need('breakdown'), ...(f.sceneryToPromote ? [`${f.sceneryToPromote} location / prop item${f.sceneryToPromote > 1 ? 's' : ''} not yet entities`] : [])], storyboard: [...need('script'), ...(f.scenesNoShots ? [`${f.scenesNoShots} scene${f.scenesNoShots > 1 ? 's' : ''} without shots`] : []), ...(f.shotsNoFrame ? [`${f.shotsNoFrame} shot${f.shotsNoFrame > 1 ? 's' : ''} without a frame`] : []), ...(f.boardAsks ? [`${f.boardAsks} open ask${f.boardAsks > 1 ? 's' : ''} for the agent`] : [])],
    final: stages.filter(s => s.id !== 'final' && s.status !== 'done').length ? [`${stages.filter(s => s.id !== 'final' && s.status !== 'done').length} stages not done`] : [],
  };
}
export function stagesView(doc, facts) {
  const n = normStages(doc, facts), auto = autoBlockers(n.stages, facts);
  const stages = n.stages.map(s => ({ ...s, title: stageById(s.id).title, n: stageById(s.id).n, blockers_all: [...s.blockers, ...auto[s.id]] }));
  const next = stages.find(s => s.status === 'needs_you') || stages.find(s => s.status !== 'done') || null;
  return { rev: n.rev || 0, derived: !!n.derived, stages, next: next ? { id: next.id, title: next.title, status: next.status, blockers: next.blockers_all } : null };
}

// ------------------------------------------------------------------ lyrics: text <-> structure
const LRC_TAG = /\[(\d+):(\d+(?:\.\d+)?)\]/g, LRC_LINE = /^\s*((?:\[\d+:\d+(?:\.\d+)?\]\s*)+)(.*)$/;
const HEAD = /^\s*(?:\[([^\]\d][^\]]*)\]|#+\s*(.+))\s*$/, META = /^\s*\[(ar|ti|al|by|offset|length|re|ve):/i;
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'part';
export const words = (text) => String(text || '').split(/\s+/).filter(Boolean);
// plain text (with [Verse 1] / # Chorus headers, blank lines between untagged blocks, optional LRC time tags) ->
// [{label, lines: [{text, t?}]}]; no ids yet
export function parseText(text) {
  const blocks = []; let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (META.test(raw)) continue;
    const l = LRC_LINE.exec(raw), h = !l && HEAD.exec(raw);
    if (h) { cur = { label: (h[1] || h[2]).trim(), lines: [], explicit: true }; blocks.push(cur); continue; }
    if (!raw.trim()) { if (cur && cur.lines.length && !cur.explicit) cur = null; continue; }
    let t = null, txt = raw.trim();
    if (l) { const m = [...l[1].matchAll(LRC_TAG)][0]; t = Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000); txt = l[2].trim(); if (!txt) continue; }
    if (!cur) { cur = { label: null, lines: [] }; blocks.push(cur); }
    cur.lines.push(t != null ? { text: txt, t } : { text: txt });
  }
  const bl = blocks.filter(b => b.lines.length || b.explicit);
  return bl.map((b, i) => ({ label: b.label || (bl.length === 1 ? 'Song' : `Part ${i + 1}`), lines: b.lines }));
}
export function versionText(v) {
  return (v?.sections || []).map(s => `[${s.label}]\n${s.lines.map(l => l.text).join('\n')}`).join('\n\n');
}
export const flatLines = (v) => (v?.sections || []).flatMap(s => s.lines.map(l => ({ ...l, section: s.id, label: s.label })));
const maxSeq = (doc, v) => Math.max(doc?.seq || 0, ...[...(doc?.versions || []), ...(v ? [v] : [])].flatMap(x => flatLines(x)).map(l => /^L(\d+)$/.exec(l.id)?.[1]).filter(Boolean).map(Number));
// longest common subsequence of two arrays (by key): pairs [i, j]
function lcs(a, b, key = (x) => x) {
  const n = a.length, m = b.length, A = a.map(key), B = b.map(key);
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { out.push([i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return out;
}
// blocks from parseText -> a version body with ids: unchanged lines keep their id; inside each changed stretch, edited
// lines take the ids of the removed ones in order (so a reworded line keeps its timings and notes); the rest are new
export function assignIds(blocks, prev, doc) {
  const old = flatLines(prev), fresh = blocks.flatMap((b, bi) => b.lines.map(l => ({ ...l, bi })));
  const norm = (x) => x.text.trim().toLowerCase().replace(/\s+/g, ' ');
  const pairs = lcs(old, fresh, norm);
  let seq = maxSeq(doc, prev); const nid = () => `L${++seq}`;
  const ids = new Array(fresh.length).fill(null);
  let pi = 0, pj = 0;
  for (const [i, j] of [...pairs, [old.length, fresh.length]]) {
    const gapOld = old.slice(pi, i), gapNew = fresh.slice(pj, j);
    gapNew.forEach((_, k) => { ids[pj + k] = gapOld[k]?.id || null; });
    if (j < fresh.length) ids[j] = old[i].id;
    pi = i + 1; pj = j + 1;
  }
  const seen = new Set();
  fresh.forEach((l, k) => { if (!ids[k] || seen.has(ids[k])) ids[k] = nid(); seen.add(ids[k]); });
  // sections: same label (first unused) keeps its id, else a slug of the label
  const prevSecs = [...(prev?.sections || [])], used = new Set();
  let k = 0;
  const sections = blocks.map((b) => {
    let s = prevSecs.find(x => x.label === b.label && !used.has(x.id));
    let id = s?.id || slug(b.label); for (let n = 2; used.has(id); n++) id = `${slug(b.label)}-${n}`;
    used.add(id);
    return { id, label: b.label, lines: b.lines.map(l => ({ id: ids[k++], text: l.text, ...(l.t != null ? { t: l.t } : {}) })) };
  });
  return { sections, seq };
}
// song.json -> the version a project without lyrics.json reads as (ids = the song's line ids, labels = section labels)
export function versionFromSong(song, labels = {}) {
  const sections = [], lab = (id) => labels[id] || song.sections?.find(s => s.id === id)?.label || id;
  for (const l of [...(song?.lines || [])].sort((a, b) => a.t0 - b.t0)) {
    const sid = l.section || song.sections?.find(s => s.t0 <= l.t0 && l.t0 < s.t1)?.id || 'song';
    let s = sections[sections.length - 1];
    if (!s || s.id !== sid) { let id = sid; for (let n = 2; sections.some(x => x.id === id); n++) id = `${sid}-${n}`; s = { id, label: lab(sid), lines: [] }; sections.push(s); }
    s.lines.push({ id: l.id, text: l.text });
  }
  return sections;
}
export function emptyLyrics() { return { rev: 0, current: null, seq: 0, versions: [], notes: [] }; }
// any lyrics.json (or none) -> a usable doc; a missing / empty one derives version v1 from song.json
export function normLyrics(doc, song, labels) {
  const d = doc && Array.isArray(doc.versions) ? { notes: [], seq: 0, ...doc } : { ...emptyLyrics(), ...(doc && typeof doc === 'object' ? { rev: doc.rev || 0 } : {}) };
  if (!Array.isArray(d.notes)) d.notes = [];
  if (!d.versions.length && song?.lines?.length) {
    d.versions = [{ id: 'v1', n: 1, created: null, by: 'import', via: 'import', message: 'from song.json', sections: versionFromSong(song, labels) }];
    d.current = 'v1'; d.derived = true;
  }
  if (d.versions.length && !d.versions.some(v => v.id === d.current)) d.current = d.versions[d.versions.length - 1].id;
  return d;
}
export const currentVersion = (doc) => doc?.versions?.find(v => v.id === doc.current) || null;
export function addVersion(doc, sections, { by = 'director', via, message = '', from, created } = {}) {
  const n = Math.max(0, ...doc.versions.map(v => v.n || Number(String(v.id).replace(/\D/g, '')) || 0)) + 1;
  const v = { id: `v${n}`, n, created: created || new Date().toISOString().slice(0, 19), by, ...(via ? { via } : {}), message: String(message || ''), ...(from ? { from } : {}), sections: structuredClone(sections) };
  doc.versions.push(v); doc.current = v.id; doc.seq = Math.max(doc.seq || 0, maxSeq(doc));
  delete doc.derived;
  return v;
}
export const sameBody = (a, b) => JSON.stringify(a?.sections || a) === JSON.stringify(b?.sections || b);
// a lyrics.json from the page or an agent: the shape the tools rely on (throws a message on a bad file)
export function checkLyrics(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.versions) || !Array.isArray(d.notes || [])) throw new Error('lyrics.json: {versions[], notes[]} expected');
  const ids = new Set();
  for (const v of d.versions) {
    if (!v || typeof v.id !== 'string' || ids.has(v.id) || !Array.isArray(v.sections)) throw new Error('lyrics.json: every version needs a unique id and sections[]');
    ids.add(v.id); const L = new Set();
    for (const s of v.sections) {
      if (!s || typeof s.id !== 'string' || typeof s.label !== 'string' || !Array.isArray(s.lines)) throw new Error(`lyrics.json: ${v.id}: a section needs id, label, lines[]`);
      for (const l of s.lines) { if (!l || typeof l.id !== 'string' || typeof l.text !== 'string' || L.has(l.id)) throw new Error(`lyrics.json: ${v.id}: every line needs a unique id and text`); L.add(l.id); }
    }
  }
  if (d.versions.length && !ids.has(d.current)) throw new Error('lyrics.json: current must name a version');
  return d;
}
// a note's words on the line as it reads now: the stored range when the quote still matches, else the quote found
// again on the line, else null (the text changed: the note stays on the line, unanchored)
export function anchorWords(lineText, note) {
  if (!note?.w) return null;
  const ws = words(lineText), [a, b] = note.w, q = words(note.quote || '');
  if (a >= 0 && b < ws.length && a <= b && (!q.length || ws.slice(a, b + 1).join(' ') === q.join(' '))) return [a, b];
  if (q.length) for (let i = 0; i + q.length <= ws.length; i++) if (ws.slice(i, i + q.length).join(' ') === q.join(' ')) return [i, i + q.length - 1];
  return null;
}

// ------------------------------------------------------------------ word-level diff of two texts
// tokens: words and line breaks; result [{op: '=' | '-' | '+', w}] ('\n' tokens mark line breaks)
export function wordDiff(a, b) {
  const tok = (t) => String(t || '').split('\n').flatMap((ln, i) => [...(i ? ['\n'] : []), ...words(ln)]);
  const A = tok(a), B = tok(b), P = lcs(A, B);
  const out = []; let i = 0, j = 0;
  for (const [x, y] of [...P, [A.length, B.length]]) {
    while (i < x) out.push({ op: '-', w: A[i++] });
    while (j < y) out.push({ op: '+', w: B[j++] });
    if (x < A.length) { out.push({ op: '=', w: A[x] }); i = x + 1; j = y + 1; }
  }
  return out;
}
export const diffStats = (ops) => ({ added: ops.filter(o => o.op === '+' && o.w !== '\n').length, removed: ops.filter(o => o.op === '-' && o.w !== '\n').length });

// ------------------------------------------------------------------ lyrics -> song.json lines (timings)
// placeholder length of a song-less project: ~4 s a line plus intro/outro, 1-10 min
export const placeholderMs = (n) => Math.min(600000, Math.max(60000, Math.round((n * 4000 + 16000) / 2000) * 2000));
export function beatGrid(durMs, bpm = 120, beatsPerBar = 4, offset = 0) {
  const beat = 60000 / bpm, beats = [], downbeats = [];
  for (let k = Math.ceil(-offset / beat); ; k++) { const t = Math.round(offset + k * beat); if (t > durMs) break; if (t < 0) continue; beats.push(t); if (((k % beatsPerBar) + beatsPerBar) % beatsPerBar === 0) downbeats.push(t); }
  return { bpm, beat_ms: +beat.toFixed(3), bar_ms: +(beat * beatsPerBar).toFixed(3), beats_per_bar: beatsPerBar, grid: { beats, downbeats } };
}
const spreadWords = (text, t0, t1) => { const ws = words(text), d = (t1 - t0) / Math.max(1, ws.length); return ws.map((w, j) => { const a = Math.round(t0 + j * d); return { w, t0: a, t1: Math.max(a + 1, Math.round(t0 + (j + 0.9) * d)), p: 0 }; }); };
// The song's lines follow the lyrics version: a line whose id and text are unchanged is kept as is (word timings,
// voice, everything); a reworded line keeps its t0/t1 and gets its words re-spread; a new line is placed between its
// timed neighbours (LRC tag first, if it has one) and marked timing "estimated". Without a song file (audio.mix null)
// every line is estimated over a placeholder duration and the sections are rebuilt from the lyrics sections; with one,
// the song's sections stay (they are musical) unless they came from the lyrics (sections_from "lyrics").
// Returns the new song object (or the same object when nothing changed).
export function syncSong(song, version, { reestimate = false } = {}) {
  const flat = flatLines(version);
  const hasAudio = !!song.audio?.mix;
  const s = structuredClone(song);
  let dur = s.duration_ms;
  if (!hasAudio) {
    const lastHint = Math.max(0, ...flat.map(l => l.t ?? 0));
    dur = Math.max(placeholderMs(flat.length), lastHint ? Math.ceil((lastHint + 10000) / 2000) * 2000 : 0);
    if (dur !== s.duration_ms || !s.grid?.beats?.length) Object.assign(s, beatGrid(dur, s.bpm || 120, s.beats_per_bar || 4));
    s.duration_ms = dur; s.placeholder_duration = true;
  }
  // without a song file every line is an estimate: re-spread them all (deterministic, so an unchanged text changes nothing)
  const old = new Map((reestimate || !hasAudio ? [] : s.lines || []).map(l => [l.id, l]));
  const out = flat.map(l => {
    const o = old.get(l.id);
    if (o && o.text === l.text) return { keep: true, line: o, l };
    if (o) return { line: { ...o, text: l.text, words: spreadWords(l.text, o.t0, o.t1) }, l };
    return { line: null, l };
  });
  // place the untimed ones: LRC hints first, then between timed neighbours (in lyric order)
  for (const x of out) if (!x.line && x.l.t != null && x.l.t < dur) x.hint = Math.round(x.l.t);
  const lo0 = Math.round(dur * 0.06), hi0 = Math.round(dur * 0.94);
  for (let i = 0; i < out.length; i++) {
    if (out[i].line || out[i].hint != null) continue;
    let j = i; while (j < out.length && !out[j].line && out[j].hint == null) j++;
    const prev = out[i - 1], next = out[j];
    const lo = prev ? (prev.line ? prev.line.t1 : prev.hint + 800) : lo0;
    let hi = next ? (next.line ? next.line.t0 : next.hint) : hi0;
    if (!prev && !next) hi = hi0;
    const n = j - i, step = Math.max((hi - lo) / n, 300);
    for (let k = 0; k < n; k++) out[i + k].hint = Math.round(lo + k * step), out[i + k].span = step;
    i = j - 1;
  }
  const est = (x) => Math.max(800, words(x.l.text).length * 450);
  const lines = out.map((x, i) => {
    if (x.line) return x.line;
    const t0 = Math.max(0, Math.min(dur - 2, x.hint));
    const nx = out.slice(i + 1).map(y => y.line ? y.line.t0 : y.hint).find(t => t != null && t > t0) ?? dur;
    const t1 = Math.max(t0 + 1, Math.min(dur, x.span ? t0 + Math.round(x.span * 0.85) : Math.min(nx - 50, t0 + est(x))));
    return { id: x.l.id, section: x.l.section, idx: 0, kind: 'sung', voice: 'none', t0, t1, text: x.l.text, timing: 'estimated', words: spreadWords(x.l.text, t0, t1) };
  });
  const fromLyrics = !hasAudio || s.sections_from === 'lyrics' || !s.sections?.length;
  if (fromLyrics) {
    // sections tile the song from the lyrics sections (start 300 ms before their first line; the first starts at 0)
    const secs = [];
    for (const sec of version.sections) {
      const L = lines.filter(l => sec.lines.some(x => x.id === l.id)); if (!L.length) continue;
      const t0 = secs.length ? Math.max(secs[secs.length - 1].t0 + 1, Math.min(...L.map(l => l.t0)) - 300) : 0;
      secs.push({ id: sec.id, label: sec.label, t0, t1: dur, energy: 0 });
    }
    secs.forEach((x, i) => { x.t1 = i + 1 < secs.length ? secs[i + 1].t0 : dur; });
    s.sections = secs.length ? secs : [{ id: 'song', label: 'Song', t0: 0, t1: dur, energy: 0 }];
    s.sections_from = 'lyrics';
    for (const l of lines) if (l.timing === 'estimated' || !hasAudio) { const sec = version.sections.find(x => x.lines.some(y => y.id === l.id)); if (sec) l.section = sec.id; }
  } else {
    for (const [i, x] of out.entries()) if (!x.keep) lines[i].section = s.sections.find(q => q.t0 <= lines[i].t0 && lines[i].t0 < q.t1)?.id || lines[i].section;
  }
  lines.sort((a, b) => a.t0 - b.t0);
  const kept = new Set(out.filter(x => x.keep).map(x => x.line)), idx = {};
  for (const l of lines) { if (!kept.has(l)) l.idx = idx[l.section] ?? 0; idx[l.section] = (idx[l.section] ?? 0) + 1; }
  s.lines = lines;
  const nEst = lines.filter(l => l.timing === 'estimated').length;
  if (!hasAudio || (nEst && nEst === lines.length)) s.timing = 'estimated';
  else if (nEst && s.timing !== 'estimated') s.timing = 'mixed';
  return JSON.stringify(s) === JSON.stringify(song) ? song : s;
}
// a fresh line id for an edit in progress (draft sections not yet saved as a version)
export const nextLineId = (doc, draft) => `L${maxSeq(doc, draft ? { sections: draft } : null) + 1}`;
