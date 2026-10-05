// The lyric gate (ROADMAP_v4 E2): "Every sung or spoken word appears on a desktop surface at its time … A script checks
// it." Pure functions, no DOM and no Node APIs: the page (the timeline's surface column, the Lyrics stage counts, the
// storyboard's Shot panel, Final's checklist) and the data layer (lib/ops/surfaces.mjs, surfaces_get) share them.
//
// A surface lives on a storyboard shot (storyboard.json, a NEW version for every change):
//   shot.lyrics [{line: <song line id>, w?: [first, last] word index (none = the whole line), where}]
//   where = "<kind>" or "<kind>: <detail>" (≤ 120 characters, no control characters), kind one of WHERE:
//           window (a window title) | chat | dialog | karaoke | taskbar | other. "chat: Notepad, typed letter by letter".
//   Only the director writes shot.lyrics (surface_act, page only); every other save carries them forward unchanged.
// surfaces.json (the server's; the page only reads it): the agent's proposals
//   {v: 1, rev, proposals [{id "sp03", shot, line, w?, where, why, by, via: "agent", at, status: open | accepted | dismissed,
//    decided_at?, decided_by?}]}
// A word is COVERED when a surface on a shot names it (its line, the word inside w) and the word's time overlaps the
// shot's time [t0, t1). A surface whose shot does not hold the word at its time does not cover it ("off time").
export const WHERE = ['window', 'chat', 'dialog', 'karaoke', 'taskbar', 'other'];
export const WHERE_LABEL = { window: 'window title', chat: 'chat', dialog: 'dialog', karaoke: 'karaoke', taskbar: 'taskbar', other: 'other' };
export const WHERE_MAX = 120, WHY_MAX = 600, PER_SHOT = 200;
const LINE_RE = /^[A-Za-z0-9_][A-Za-z0-9_:/.-]{0,127}$/;
const hasCtrl = (s) => [...s].some(c => { const n = c.charCodeAt(0); return n < 32 || n === 127 || n === 8232 || n === 8233; });
class SurfaceError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
const bad = (m, code) => { throw new SurfaceError(m, code); };
const words = (text) => String(text || '').split(/\s+/).filter(Boolean);

// "chat: Notepad" -> {kind: "chat", detail: "Notepad"}; an unknown kind reads as other with the whole text as detail
export function whereParts(where) {
  const s = String(where ?? ''), m = /^([a-z]+)(?:\s*:\s*([\s\S]*))?$/.exec(s), kind = m && WHERE.includes(m[1]) ? m[1] : null;
  return kind ? { kind, detail: (m[2] || '').trim() } : { kind: 'other', detail: s.trim() };
}
// the stored form of a where: "<kind>" | "<kind>: <detail>"; throws a message on what cannot be fixed
export function cleanWhere(v) {
  if (typeof v !== 'string' || !v.trim()) bad(`where: "<kind>" or "<kind>: <detail>", kind one of ${WHERE.join(', ')} ("chat: Notepad, typed")`);
  const s = v.trim().replace(/\s+/g, ' ');
  if (hasCtrl(v.replace(/[\n\r\t]/g, ' '))) bad('where: no control characters');
  if (s.length > WHERE_MAX) bad(`where: up to ${WHERE_MAX} characters`);
  const m = /^([a-z]+)(?:\s*:\s*(.*))?$/.exec(s);
  if (!m || !WHERE.includes(m[1])) bad(`where: starts with one of ${WHERE.join(', ')} (then ": <detail>" if you like): "${s.slice(0, 40)}"`);
  return m[2] ? `${m[1]}: ${m[2].trim()}` : m[1];
}
// one entry {line, w?, where}; lines (optional) = the song's lines, to check the line and the word range
export function cleanEntry(x, { lines } = {}) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) bad('a surface is {line, w?, where}');
  if (typeof x.line !== 'string' || !LINE_RE.test(x.line) || x.line.split('/').some(s => s === '' || s === '.' || s === '..')) bad(`line: a lyric line id ("verse/0"; song_get lists them)`);
  const out = { line: x.line };
  const L = lines ? lines.find(l => l.id === x.line) : null;
  if (lines && !L) bad(`no lyric line "${x.line.slice(0, 60)}" in the song (song_get lists the line ids)`, 404);
  if (x.w != null) {
    const w = Array.isArray(x.w) ? x.w.map(Number) : [];
    if (w.length !== 2 || !w.every(Number.isInteger) || w[0] < 0 || w[1] < w[0] || w[1] > 400) bad('w: [first, last] word index (0-based) on the line');
    const n = L ? lineWords(L).length : null;
    if (n != null && w[1] >= n) bad(`w: the line "${x.line}" has ${n} words (0..${n - 1})`);
    if (!(n != null && w[0] === 0 && w[1] === n - 1)) out.w = w;   // the whole line: no range
  }
  out.where = cleanWhere(x.where);
  return out;
}
// a shot's lyrics[] (storyboard.json): checked, duplicates (same line, range and where) dropped
export function cleanSurfaces(list, opt = {}) {
  if (list == null) return [];
  if (!Array.isArray(list)) bad('lyrics: a list of surfaces [{line, w?, where}]');
  if (list.length > PER_SHOT) bad(`lyrics: at most ${PER_SHOT} surfaces on a shot`);
  const out = [];
  for (const x of list) { const e = cleanEntry(x, opt); if (!out.some(y => sameEntry(y, e))) out.push(e); }
  return out;
}
export const sameEntry = (a, b) => a.line === b.line && String(a.w || '') === String(b.w || '') && a.where === b.where;

// a song line's words with times: song.json words, else the text spread over the line
export function lineWords(L) {
  if (Array.isArray(L?.words) && L.words.length) return L.words.map(w => ({ w: String(w.w ?? ''), t0: Math.round(Number(w.t0) || 0), t1: Math.round(Number(w.t1) || 0) }));
  const ws = words(L?.text), t0 = Number(L?.t0) || 0, t1 = Math.max(t0 + 1, Number(L?.t1) || t0 + 1), d = (t1 - t0) / Math.max(1, ws.length);
  return ws.map((w, j) => ({ w, t0: Math.round(t0 + j * d), t1: Math.round(t0 + (j + 1) * d) }));
}
const inRange = (e, i) => !e.w || (i >= e.w[0] && i <= e.w[1]);
const atTime = (wd, s) => wd.t0 < s.t1 && Math.max(wd.t1, wd.t0 + 1) > s.t0;

// the gate: every line of the song with each word covered or not -> {lines, total, covered, uncovered, ok, off}
//   lines [{id, text, t0, t1, n, covered, words [{w, i, t0, t1, by [{shot, where}], off? [{shot, where}]}]}]
//   uncovered [{line, w: [first, last], t0, t1, text}]: runs of uncovered words (what Final and surfaces_get list)
export function coverage(song, shots) {
  const S = (shots || []).filter(s => Array.isArray(s?.lyrics) && s.lyrics.length);
  const lines = [], uncovered = [], off = [];
  let total = 0, covered = 0;
  for (const L of song?.lines || []) {
    const ws = lineWords(L), out = ws.map((wd, i) => ({ ...wd, i, by: [] }));
    for (const s of S) for (const e of s.lyrics) {
      if (e.line !== L.id) continue;
      for (const x of out) if (inRange(e, x.i)) { if (atTime(x, s)) x.by.push({ shot: s.id, where: e.where }); else (x.off ||= []).push({ shot: s.id, where: e.where }); }
    }
    const c = out.filter(x => x.by.length).length;
    total += out.length; covered += c;
    lines.push({ id: L.id, text: L.text, t0: L.t0, t1: L.t1, n: out.length, covered: c, words: out });
    let run = null;
    for (const x of out) {
      if (!x.by.length) { if (run && run.w[1] === x.i - 1) { run.w[1] = x.i; run.t1 = x.t1; run.text += ' ' + x.w; } else uncovered.push(run = { line: L.id, w: [x.i, x.i], t0: x.t0, t1: x.t1, text: x.w }); }
      else run = null;
      if (x.off && !x.by.length) for (const o of x.off) if (!off.some(y => y.line === L.id && y.shot === o.shot)) off.push({ line: L.id, shot: o.shot, where: o.where });
    }
  }
  return { lines, total, covered, uncovered, off, ok: total > 0 && covered === total };
}
// the per-line count the Lyrics stage shows: {covered, n} by line id
export const lineCounts = (cov) => Object.fromEntries(cov.lines.map(l => [l.id, { covered: l.covered, n: l.n }]));
// the surfaces of a shot for a line, as text ("chat: Notepad (words 2–4)")
export const entryLabel = (e, L) => `${e.where}${e.w ? ` · “${lineWords(L).slice(e.w[0], e.w[1] + 1).map(x => x.w).join(' ')}”` : ''}`;

// surfaces.json
export function normSurfaces(d) {
  const o = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  return { v: 1, rev: Number(o.rev) || 0, proposals: (Array.isArray(o.proposals) ? o.proposals : []).filter(p => p && typeof p === 'object' && typeof p.id === 'string') };
}
export const nextProposalId = (d) => `sp${String(d.proposals.reduce((m, p) => Math.max(m, Number(/^sp(\d+)$/.exec(p.id)?.[1]) || 0), 0) + 1).padStart(2, '0')}`;
export const openProposals = (d, shot) => (d?.proposals || []).filter(p => p.status === 'open' && (!shot || p.shot === shot));
// the lyric gate is opt-in per project (review #3): settings.json lyric_gate; a project without the key keeps it on (the
// projects made before), a new one (data/_template/settings.json) starts with it off
export const gateOn = (settings) => settings?.lyric_gate !== false;
// the Final checklist line (C2): "every word on screen"
export function gateCheck(song, shots) {
  const c = coverage(song, shots), n = c.uncovered.length;
  return { ok: c.ok, total: c.total, covered: c.covered,
    detail: !c.total ? 'no lyrics' : c.ok ? `${c.total} words, all on screen at their time` : `${c.covered} of ${c.total} words on screen · ${n} uncovered run${n === 1 ? '' : 's'}`,
    gaps: c.uncovered.map(u => ({ label: `${u.line} “${u.text.length > 40 ? u.text.slice(0, 39) + '…' : u.text}”`, line: u.line, w: u.w, t0: u.t0 })) };
}
