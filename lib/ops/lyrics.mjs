// The guided flow (stages.json) and stage 1, the lyrics (lyrics.json): project facts, stage status, lyrics versions
// and notes, the song file (song_attach), syncing song.json lines, and new guided projects (createGuidedProject).
import fs from 'node:fs';
import path from 'node:path';
import * as F from '../../js/flow.js';
import * as SB from '../../js/storyboard.js';
import { AUDIO, fail, nextId, nowIso, ops, projDir, read, readJSON, write } from './_shared.mjs';
import { createProject } from './core.mjs';
import { scenesDoc } from './scenes.mjs';
import { addNote, notesDoc, replyNote, setStatus, stageAsks, stageNotes } from './notes.mjs';
import { legacyView } from '../../js/notes.js';

// ------------------------------------------------------------------ the guided flow: stages + lyrics (docs/SPEC_v3_GUIDED.md)
// Formats and the shared logic live in js/flow.js (the page imports the same file). Rules: an agent may set a stage to
// empty / in_progress / needs_you and write blockers; only the page marks a stage done (serve.mjs stamps done_by/via
// "page" on /api/save/stages.json) and an agent cannot move a done stage. Every lyrics save is a new version; the song's
// lines follow the current version (syncLyrics), keeping the timings of lines that still exist.
export function projectFacts(p) {
  const d = projDir(p), idx = readJSON(path.join(d, 'entities', 'index.json'), []) || [];
  let scenes = null; try { scenes = scenesDoc(p); } catch (e) { /* a broken scenes.json: the facts read as no script */ }
  const breakdown = readJSON(path.join(d, 'breakdown.json'), null);
  let storyboard = null; try { storyboard = SB.normBoard(readJSON(path.join(d, 'storyboard.json'), null), read(p, 'shots.json'), scenes); } catch (e) { /* read as no storyboard */ }
  // the full entity files (their identity / base trees decide stages 4-5, like the page) and the Assets approvals
  const ents = idx.map(e => (typeof e?.path === 'string' && /^entities\/(characters|locations|props)\/[A-Za-z0-9_][A-Za-z0-9_-]{0,63}\.json$/.test(e.path) && readJSON(path.join(d, e.path), null)) || e);
  let notes = null; try { notes = notesDoc(p); } catch (e) { /* a broken notes.json: the asks read from the old stores */ }
  return F.projectFacts({ song: read(p, 'song.json'), script: read(p, 'script.json'), shots: read(p, 'shots.json').shots, entities: ents, lyrics: readJSON(path.join(d, 'lyrics.json'), null), scenes, breakdown, storyboard, approvals: readJSON(path.join(d, 'approvals.json'), null), notes });
}
const sectionLabels = (p) => Object.fromEntries(Object.entries(read(p, 'overrides.json').sections || {}).filter(([, v]) => v?.label).map(([k, v]) => [k, v.label]));
export function lyricsDoc(p) { return F.normLyrics(readJSON(path.join(projDir(p), 'lyrics.json'), null, true), read(p, 'song.json'), sectionLabels(p)); }
// read-modify-write lyrics.json (a derived doc is written the first time anything changes)
function mutateLyrics(p, fn) {
  const d = lyricsDoc(p); const r = fn(d); delete d.derived;
  F.checkLyrics(d); d.rev = (d.rev || 0) + 1; write(p, 'lyrics.json', d); return r === undefined ? d : r;
}
// an empty stage becomes in_progress once its file holds something (a project without stages.json stays derived)
export function startStage(p, id) {
  const cur = readJSON(path.join(projDir(p), 'stages.json'), null);
  if (!cur || F.normStages(cur, projectFacts(p)).stages.find(s => s.id === id)?.status !== 'empty') return;
  mutateStages(p, (d) => { const s = d.stages.find(x => x.id === id); s.status = 'in_progress'; s.updated = nowIso(); });
}
function mutateStages(p, fn) {
  const cur = readJSON(path.join(projDir(p), 'stages.json'), null, true);
  const d = F.normStages(cur, projectFacts(p)); delete d.derived;
  const r = fn(d); d.rev = (cur?.rev || 0) + 1; write(p, 'stages.json', d); return r === undefined ? d : r;
}
// song.json lines <- the current lyrics version; writes only when something changed. An empty lyrics stage becomes
// in_progress once there is a poem.
export function syncLyrics(p, { reestimate = false } = {}) {
  const doc = lyricsDoc(p), v = F.currentVersion(doc); if (!v) return { changed: false };
  const song = read(p, 'song.json'), next = F.syncSong(song, v, { reestimate });
  if (next !== song) write(p, 'song.json', next);
  const st = readJSON(path.join(projDir(p), 'stages.json'), null);
  if (F.flatLines(v).length && F.normStages(st, projectFacts(p)).stages[0].status === 'empty') mutateStages(p, (d) => { d.stages[0].status = 'in_progress'; d.stages[0].updated = nowIso(); });
  return { changed: next !== song, lines: next.lines.length, timing: next.timing || null, duration_ms: next.duration_ms, has_audio: !!next.audio?.mix };
}
// the page saved a shared file (serve.mjs calls this after the write)
export function afterPageSave(p, name, data, cur) {
  if (name === 'breakdown.json' && (data.versions || []).length) startStage(p, 'breakdown');
  if (name === 'storyboard.json' && (data.versions || []).some(v => v.via === 'page')) startStage(p, 'storyboard');
  if (name === 'lyrics.json') {
    const a = (cur.versions || []).find(v => v.id === cur.current), b = (data.versions || []).find(v => v.id === data.current);
    if (!a || !F.sameBody(a, b)) syncLyrics(p);
  }
}
const lineIndex = (v) => { const m = new Map(); for (const l of F.flatLines(v)) m.set(l.id, l); return m; };
function noteView(n, v) {
  const l = lineIndex(v).get(n.line);
  return { ...n, line_text: l?.text ?? null, section: l?.label ?? null, words_now: l ? F.anchorWords(l.text, n) : null, ...(l || !n.line ? {} : { detached: 'the line is not in the current version' }) };
}
Object.assign(ops, {
  stages_get(p) {
    const f = projectFacts(p);
    return { ...F.stagesView(readJSON(path.join(projDir(p), 'stages.json'), null, true), f), facts: f,
      rules: 'agents may set empty / in_progress / needs_you and blockers (stage_update); only the director marks a stage done, in the page (stage rail or the stage workspace)' };
  },
  stage_update(p, { stage, status, blockers, note, by = 'agent' } = {}) {
    if (!F.stageById(stage)) fail(400, `stage must be one of ${F.STAGES.map(s => s.id).join(', ')}`);
    if (status != null && !F.STAGE_STATUSES.includes(status)) fail(400, `status must be one of ${F.STAGE_STATUSES.join(', ')}`);
    if (status === 'done') fail(403, 'only the director marks a stage done, in the page (stage rail or the stage workspace). Set needs_you and say why (note); show it with ui_focus view "stage"');
    if (blockers != null && (!Array.isArray(blockers) || blockers.some(b => typeof b !== 'string'))) fail(400, 'blockers: a list of short strings');
    return mutateStages(p, (d) => {
      const s = d.stages.find(x => x.id === stage);
      if (s.status === 'done' && status && status !== 'done') fail(409, `stage ${stage} is done (the director marked it): ask them to reopen it in the page`);
      if (status) s.status = status;
      if (blockers) s.blockers = blockers.map(String).slice(0, 12);
      if (note != null) s.note = String(note);
      Object.assign(s, { updated: nowIso(), updated_by: by });
      if (s.status !== 'done') s.via = 'agent';
      return { stage: { ...s }, next: F.stagesView(d, projectFacts(p)).next };
    });
  },
  lyrics_get(p, { version, notes = 'open' } = {}) {
    const doc = lyricsDoc(p), v = version ? doc.versions.find(x => x.id === version) : F.currentVersion(doc);
    if (version && !v) fail(404, `no version "${version}" (lyrics_versions lists them)`);
    const song = read(p, 'song.json'), timing = new Map(song.lines.map(l => [l.id, l]));
    const ns = stageNotes(p, 'lyrics', 'lyrics', { status: notes });
    return { current: doc.current, version: v ? { id: v.id, created: v.created, by: v.by, via: v.via, message: v.message } : null, derived: !!doc.derived,
      text: F.versionText(v),
      sections: (v?.sections || []).map(s => ({ id: s.id, label: s.label, lines: s.lines.map(l => { const t = timing.get(l.id); return { id: l.id, text: l.text, ...(t ? { t0: t.t0, t1: t.t1, ...(t.timing ? { timing: t.timing } : {}) } : {}) }; }) })),
      song: { has_audio: !!song.audio?.mix, duration_ms: song.duration_ms, placeholder_duration: !!song.placeholder_duration, timing: song.timing || null },
      versions: doc.versions.length, notes: ns.map(n => noteView(n, v)),
      asks_for_agent: stageAsks(p, 'lyrics').map(n => legacyView(n, 'lyrics')).map(n => ({ id: n.id, line: n.line, quote: n.quote, text: n.text, replies: n.replies?.length || 0 })),
      notes_note: 'notes live in notes.json (one list for every stage: notes_get / notes_add / notes_status); these are the lyrics ones in the old shape' };
  },
  // a new version from text (with [Section] tags) or from sections [{label, lines: [{id?, text}]}], or a copy of an
  // older version (restore); ids of unchanged / reworded lines are kept; the song's lines follow
  lyrics_update(p, { text, sections, restore, message = '', by = 'agent' } = {}) {
    if ([text, sections, restore].filter(x => x != null).length !== 1) fail(400, 'give exactly one of text, sections or restore');
    let r;
    mutateLyrics(p, (d) => {
      const prev = F.currentVersion(d);
      let body;
      if (restore != null) { const old = d.versions.find(v => v.id === restore); if (!old) fail(404, `no version "${restore}"`); body = structuredClone(old.sections); }
      else if (text != null) { if (typeof text !== 'string' || text.length > 200000) fail(400, 'text: a string up to 200 kB'); body = F.assignIds(F.parseText(text), prev, d).sections; }
      else {
        if (!Array.isArray(sections)) fail(400, 'sections: [{label, lines: [{id?, text}]}]');
        const blocks = sections.map(s => ({ label: String(s?.label || 'Part'), lines: (s?.lines || []).map(l => ({ text: String(typeof l === 'string' ? l : l?.text || '').replace(/\s*\n\s*/g, ' ').trim() })).filter(l => l.text) }));
        body = F.assignIds(blocks, prev, d).sections;
      }
      if (prev && F.sameBody(prev.sections, body)) { r = { version: prev.id, unchanged: true }; return; }
      const v = F.addVersion(d, body, { by, via: 'agent', message: restore ? (message || `restore ${restore}`) : message, ...(restore ? { from: restore } : {}) });
      r = { version: v.id, lines: F.flatLines(v).length, sections: v.sections.length };
    });
    return { ...r, song: syncLyrics(p) };
  },
  lyrics_versions(p, { diff, id } = {}) {
    const doc = lyricsDoc(p);
    if (diff) {
      if (!Array.isArray(diff) || diff.length !== 2) fail(400, 'diff: [older version id, newer version id]');
      const [a, b] = diff.map(x => doc.versions.find(v => v.id === x)); if (!a || !b) fail(404, `no such version: ${diff.join(', ')}`);
      const d = F.wordDiff(F.versionText(a), F.versionText(b));
      const show = d.map(o => o.w === '\n' ? (o.op === '-' ? '' : '\n') : o.op === '=' ? o.w : o.op === '-' ? `[-${o.w}-]` : `{+${o.w}+}`).join(' ').replace(/ ?\n ?/g, '\n');
      return { a: a.id, b: b.id, ...F.diffStats(d), diff: show };
    }
    if (id) { const v = doc.versions.find(x => x.id === id); if (!v) fail(404, `no version "${id}"`); return { ...v, text: F.versionText(v), current: v.id === doc.current }; }
    return { current: doc.current, derived: !!doc.derived, versions: doc.versions.map(v => ({ id: v.id, created: v.created, by: v.by, via: v.via, message: v.message, from: v.from, lines: F.flatLines(v).length, current: v.id === doc.current })) };
  },
  // a note on a line (or a word range of it), a reply in a thread (reply_to), or an ask for the agent (to "agent"):
  // written to notes.json v2 (target {stage: "lyrics", kind: "line", id, w, quote}), answered in the old shape
  lyrics_note_add(p, { line, words, quote, text, reply_to, to, by = 'agent' } = {}) {
    if (!text || typeof text !== 'string') fail(400, 'text required');
    if (reply_to) { const r = replyNote(p, reply_to, text, { by }); return { note: r.note.id, reply: r.reply }; }
    const d = lyricsDoc(p), v = F.currentVersion(d), L = line ? lineIndex(v).get(line) : null;
    if (line && !L) fail(404, `no line "${line}" in the current version (lyrics_get lists the line ids)`);
    let w = null, q = '';
    if (L && (words || quote)) {
      const ws = F.words(L.text);
      if (words) { const [a, b] = (Array.isArray(words) ? words : []).map(Number); if (!(a >= 0 && b >= a && b < ws.length)) fail(400, `words: [first, last] word index on the line (0..${ws.length - 1})`); w = [a, b]; }
      else { const at = F.anchorWords(L.text, { w: [-1, -1], quote }); if (!at) fail(404, `"${quote}" is not on line ${line}`); w = at; }
      q = ws.slice(w[0], w[1] + 1).join(' ');
    }
    const n = addNote(p, { target: L ? { stage: 'lyrics', kind: 'line', id: line, ...(w ? { w, quote: q } : {}) } : { stage: 'lyrics', kind: 'stage' }, text, to, version: d.current, by });
    return noteView(legacyView(n, 'lyrics'), v);
  },
  lyrics_note_resolve(p, { id, reply, reopen = false, by = 'agent' } = {}) {
    return legacyView(setStatus(p, id, reopen ? 'open' : 'absorbed', { reply, by }).note, 'lyrics');
  },
  // add (or replace) the song file: decode, waveform peaks, energy, beat grid, duration; the lyric lines get timings
  // (LRC tags when the lyrics had them, else estimated, as the importer does)
  async song_attach(p, { path: src, bpm, beats_per_bar, offset } = {}) {
    const I = await import('../../importers/new_project.mjs');
    return I.attachSong(p, src, { bpm, beatsPerBar: beats_per_bar, offset });
  },
});
// a new project from the wizard (page) or the projects tool: lyrics text (optional) and a song file (optional, a path
// on this machine); without a song the project has a placeholder duration and estimated timings until one is added
export async function createGuidedProject({ id, title, lyrics = '', song, bpm } = {}) {
  if (typeof lyrics !== 'string' || lyrics.length > 200000) fail(400, 'lyrics: text up to 200 kB');
  if (song != null && (typeof song !== 'string' || !AUDIO.test(song))) fail(400, 'song: path of an audio file (wav, mp3, m4a, flac, ogg)');
  createProject(id, title);
  try {
    write(id, 'stages.json', { rev: 1, stages: F.STAGES.map(x => ({ id: x.id, status: 'empty', blockers: [] })) });
    const s = read(id, 'song.json');
    write(id, 'song.json', { ...s, ...(bpm ? F.beatGrid(s.duration_ms, Number(bpm) || 120, s.beats_per_bar || 4) : {}), title: title || id });
    if (lyrics.trim()) {
      const doc = F.emptyLyrics(); const body = F.assignIds(F.parseText(lyrics), null, doc).sections;
      F.addVersion(doc, body, { by: 'director', via: 'page', message: 'first draft' }); doc.rev = 1;
      write(id, 'lyrics.json', doc);
      syncLyrics(id);
    }
    const attached = song ? await ops.song_attach(id, { path: song, bpm }) : null;
    return { id, title: title || id, lines: read(id, 'song.json').lines.length, song: attached };
  } catch (e) { fs.rmSync(projDir(id, false), { recursive: true, force: true }); throw e; }
}
