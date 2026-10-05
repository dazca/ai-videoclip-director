// E7 song versions and the Suno pipeline (ROADMAP_v4). Shapes and logic: js/songs.js. Nothing here calls Suno (or any
// network): the director pastes the brief into Suno by hand and brings the song back (an upload, or a file on this machine).
//   song_versions_get   read only: the versions (v1, v2…: source, audio, length, bpm, alignment, style / lyrics used), the
//                       current one, the Suno brief settings
//   song_version_add    a new take of the song as a version (agent or page): its file, source (suno | upload | other), the
//                       style / lyrics prompt it was made with, and how its lyrics line up: an LRC, measured line starts,
//                       an offset + scale, or (default) stretched to its length. Never changes the song: it is a candidate
//   song_version_plan   read only: what would move if a version were used (the E1 re-time preview's shape: every scene /
//                       shot boundary and named event, old -> new, problems), and how many lyric lines move
//   song_version_use    PAGE ONLY: switch to a version: the audio, beat grid, waveform and lyric timings, and every scene /
//                       shot boundary and event through the same time map (one new scenes and storyboard version)
//   song_upload         PAGE ONLY: an audio file the director drops (chunked, sniffed as audio) -> audio/versions/<name>
//   suno_brief          the brief to paste into Suno: style + exclude + title (settings.json suno) + the lyrics of the
//                       Lyrics stage with section tags, with the character gates; save: true stores the style texts
import fs from 'node:fs';
import path from 'node:path';
import * as SG from '../../js/songs.js';
import * as F from '../../js/flow.js';
import * as SC from '../../js/scenes.js';
import * as SB from '../../js/storyboard.js';
import { AUDIO, CFG, fail, ffprobe, isFlaggedPrivate, isMediaRootPath, isPrivate, mediaRootFile, mutate, nowIso, ops, projDir, read, relTo, withFileLock, write, writeJSON } from './_shared.mjs';
import { scenesDoc } from './scenes.mjs';
import { boardDoc } from './storyboard.mjs';
import { eventsDoc, mutateEvents, writePlan } from './events.mjs';
import { lyricsDoc } from './lyrics.mjs';

const pageOnly = (via, what) => { if (via !== 'page') fail(403, `${what} is the director's, in the page (Lyrics › Song versions…): an agent adds a version (song_version_add) and shows the plan (song_version_plan)`); };
const txt = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n);
const ctx = (p) => ({ scenes: SC.currentScript(scenesDoc(p))?.scenes || [], shots: SB.boardShots(boardDoc(p)), events: eventsDoc(p).events.filter(e => e.status !== 'dismissed') });
const AUDIO_EXT = /\.(wav|mp3|m4a|flac|ogg|aac)$/i;
// an audio file on this machine: absolute, project-relative or under a media root; never a PRIVATE path
function audioFile(p, src) {
  if (typeof src !== 'string' || !src.trim() || src.length > 1000 || /\0/.test(src)) fail(400, 'path: the audio file of the new take (wav, mp3, m4a, flac, ogg, aac)');
  src = src.trim().replace(/^"|"$/g, '');
  if (!AUDIO_EXT.test(src)) fail(400, 'path: an audio file (wav, mp3, m4a, flac, ogg, aac)');
  if (isPrivate(src)) fail(400, 'a PRIVATE path cannot be the song (it would be served and exported)');
  const pd = projDir(p);
  let abs;
  if (path.isAbsolute(src) || /^[A-Za-z]:[\\/]/.test(src)) abs = path.resolve(src);
  else { const rel = src.replace(/\\/g, '/'); if (rel.split('/').some(s => s === '..' || s === '.')) fail(400, 'path: no ".." or "."'); abs = isMediaRootPath(rel) ? mediaRootFile(rel) : path.join(pd, rel); }
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(404, 'no such file: ' + src);
  const inProj = path.relative(pd, abs), inBase = relTo(CFG.mediaBase, abs);
  let stored;
  if (!inProj.startsWith('..') && !path.isAbsolute(inProj)) stored = inProj.split(path.sep).join('/');
  else if (!inBase.startsWith('..') && isMediaRootPath(inBase)) stored = inBase;
  else {   // elsewhere on this machine: copied into the project (audio/versions/)
    const dir = path.join(pd, 'audio', 'versions'); fs.mkdirSync(dir, { recursive: true });
    let name = path.basename(abs).replace(/[^A-Za-z0-9_.-]+/g, '-'), n = 2; while (fs.existsSync(path.join(dir, name))) name = path.basename(abs).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/(\.\w+)$/, `-${n++}$1`);
    fs.copyFileSync(abs, path.join(dir, name)); abs = path.join(dir, name); stored = `audio/versions/${name}`;
  }
  if (isPrivate(stored) || isFlaggedPrivate(stored, [p])) fail(400, 'a PRIVATE file cannot be the song');
  return { abs, stored };
}
const resolveAudio = (p, stored) => (isMediaRootPath(stored) ? mediaRootFile(stored) : path.join(projDir(p), stored));
function mutateSong(p, fn) { return withFileLock(path.join(projDir(p), 'song.json'), () => { const s = read(p, 'song.json'); const r = fn(s); write(p, 'song.json', s); return r === undefined ? s : r; }); }
const versionView = (v, cur) => { const { lines, ...rest } = v; return { ...rest, lines: (lines || []).length, current: v.id === cur }; };
const needVersion = (song, id) => { if (typeof id !== 'string' || !SG.VERSION_ID.test(id)) fail(400, 'version: "v2" (song_versions_get lists them)'); const v = SG.versionsOf(song).find(x => x.id === id); if (!v) fail(404, `no song version "${id}"`); return v; };
function planFor(p, song, v) {
  const map = SG.mapTo(song, v), c = ctx(p);
  const plan = SG.songPlan({ map, ...c, dur: v.duration_ms, version: v.id });
  return { map, plan, lines_moved: SG.linesMoved(song.lines, map) };
}
const planOut = (plan, lm) => ({ summary: SG.planSummary(plan, lm), lines_moved: lm, rows: plan.rows.slice(0, 400), rows_total: plan.rows.length, problems: plan.problems, beats_moved: plan.beats,
  lines: plan.rows.slice(0, 60).map(r => `${r.kind} ${r.id}.${r.edge} ${SG.tc(r.from)} → ${SG.tc(r.to)}`) });
const briefOf = (p, o = {}) => { const s = read(p, 'settings.json')?.suno || {}; return SG.sunoBrief({ version: F.currentVersion(lyricsDoc(p)), style: o.style ?? s.style ?? '', exclude: o.exclude ?? s.exclude ?? '', title: o.title ?? s.title ?? read(p, 'song.json').title ?? '' }); };

Object.assign(ops, {
  song_versions_get(p) {
    const song = read(p, 'song.json'), cur = SG.currentVersionId(song);
    return { current: cur, versions: SG.versionsOf(song).map(v => versionView(v, cur)), recorded: Array.isArray(song.versions) && song.versions.length > 0,
      suno: read(p, 'settings.json')?.suno || null,
      how: 'song_version_add {path, source, style, lyrics_prompt, lrc | lines | offset_ms + scale} adds a take; song_version_plan {version} shows what moves; only the director uses a version (Lyrics › Song versions…). Nothing calls Suno: suno_brief gives the text to paste' };
  },
  song_version_add(p, { path: src, source = 'suno', label, style, exclude, lyrics_prompt, suno, lrc, lines, offset_ms, scale, bpm, beats_per_bar, by = 'agent', via = 'agent' } = {}) {
    if (!SG.SOURCES.includes(source) || source === 'import') fail(400, 'source: suno | upload | other');
    const { abs, stored } = audioFile(p, src);
    const pr = ffprobe(abs); if (!(pr.dur > 1)) fail(415, `${path.basename(abs)}: not a readable audio file (ffprobe found no duration)`);
    const newDur = Math.round(pr.dur * 1000), song = read(p, 'song.json');
    if (bpm != null && !(Number(bpm) >= 30 && Number(bpm) <= 300)) fail(400, 'bpm: 30-300');
    if (beats_per_bar != null && !(Number.isInteger(beats_per_bar) && beats_per_bar >= 1 && beats_per_bar <= 16)) fail(400, 'beats_per_bar: 1-16');
    if (lrc != null && (typeof lrc !== 'string' || lrc.length > 200000)) fail(400, 'lrc: the timed lyrics text, up to 200 kB');
    if (lines != null && (!Array.isArray(lines) || lines.length > 2000)) fail(400, 'lines: [{id, t0}]');
    let al; try { al = SG.alignment(song, { lrc, lines, offset_ms, scale, newDur }); } catch (e) { fail(400, e.message); }
    const fromPage = via === 'page', who = fromPage ? 'director' : String(by || 'agent').slice(0, 40);
    const brief = source === 'suno' && (style == null || lyrics_prompt == null) ? briefOf(p) : null;
    const s0 = suno && typeof suno === 'object' ? suno : null;
    const off = al.alignment.method === 'offset' ? al.alignment.offset_ms : 0;
    const out = mutateSong(p, (s) => {
      const vs = SG.versionsOf(s).map(v => ({ ...v }));
      const cur = vs.find(v => v.id === SG.currentVersionId(s)); if (cur) cur.lines = (s.lines || []).map(l => ({ id: l.id, t0: l.t0, t1: l.t1 }));   // the current take's timings as they are now
      const id = SG.nextVersionId(vs);
      const v = { id, label: txt(label || `${source === 'suno' ? 'Suno take' : 'take'} ${id}`, 120), source, audio: stored, duration_ms: newDur, bpm: Number(bpm || s.bpm || 120), beats_per_bar: beats_per_bar || s.beats_per_bar || 4,
        offset_ms: Math.max(0, Math.round(Number(s.grid?.beats?.[0] ?? 0) + off)),
        ...((style ?? brief?.style) ? { style: txt(style ?? brief.style, 4000) } : {}), ...((exclude ?? brief?.exclude) ? { exclude: txt(exclude ?? brief.exclude, 4000) } : {}),
        ...((lyrics_prompt ?? brief?.lyrics) ? { lyrics_prompt: txt(lyrics_prompt ?? brief.lyrics, 12000) } : {}),
        ...(s0 ? { suno: { ...(s0.title ? { title: txt(s0.title, 120) } : {}), ...(s0.model ? { model: txt(s0.model, 40) } : {}), ...(s0.link && /^https:\/\/[^\s"'<>]{1,300}$/.test(String(s0.link)) ? { link: String(s0.link) } : {}) } } : {}),
        lines: SG.mapLines(s.lines, al.map).map(l => ({ id: l.id, t0: l.t0, t1: l.t1 })), alignment: al.alignment, by: who, via: fromPage ? 'page' : 'agent', at: nowIso() };
      vs.push(v); s.versions = vs; s.current_version ||= 'v1';
      return v;
    });
    const song2 = read(p, 'song.json'), pl = planFor(p, song2, out);
    return { version: versionView(out, song2.current_version), plan: planOut(pl.plan, pl.lines_moved), note: 'a candidate: nothing moved. The director previews and uses it in the page (Lyrics › Song versions…); measure the events after (E1) if the cuts must land on the new take\'s stops' };
  },
  song_version_plan(p, { version } = {}) {
    const song = read(p, 'song.json'), v = needVersion(song, version);
    if (v.id === SG.currentVersionId(song)) return { version: v.id, current: true, summary: 'this is the song in use: nothing moves', rows: [], problems: [] };
    const { plan, lines_moved } = planFor(p, song, v);
    return { version: v.id, from: SG.currentVersionId(song), ...planOut(plan, lines_moved) };
  },
  async song_version_use(p, { version, via } = {}) {
    pageOnly(via, 'using a song version');
    const song = read(p, 'song.json'), v = needVersion(song, version), from = SG.currentVersionId(song);
    if (v.id === from) fail(409, `${v.id} is already the song in use`);
    const abs = resolveAudio(p, v.audio); if (!abs || !fs.existsSync(abs)) fail(404, `${v.audio}: the file of ${v.id} is gone`);
    const { map, plan, lines_moved } = planFor(p, song, v);
    if (plan.problems.length) fail(409, `not used: ${plan.problems.join('; ')}`);
    const I = await import('../../importers/new_project.mjs');
    const x = I.decode(abs), durMs = Math.round(x.length / 22050 * 1000);
    const g = I.grid(durMs, Number(v.bpm || song.bpm || 120), Number(v.beats_per_bar || song.beats_per_bar || 4), Number(v.offset_ms || 0));
    const pd = projDir(p), backup = read(p, 'song.json');
    // the song first (the scenes / shots are checked against its new length), then the script and storyboard versions; a
    // failure there puts the song back
    mutateSong(p, (s) => {
      const vs = SG.versionsOf(s).map(y => ({ ...y }));
      const cur = vs.find(y => y.id === from); if (cur) cur.lines = (s.lines || []).map(l => ({ id: l.id, t0: l.t0, t1: l.t1 }));
      Object.assign(s, { duration_ms: durMs, ...g, audio: { ...(s.audio || {}), mix: v.audio, stems: s.audio?.stems || [] }, lines: SG.mapLines(s.lines, map), timing: `${v.id} (${v.alignment?.method || 'mapped'})`, versions: vs, current_version: v.id,
        sections: (s.sections || []).map(sec => ({ ...sec, t0: map(sec.t0), t1: Math.max(map(sec.t0) + 1, map(sec.t1)) })) });
      delete s.placeholder_duration;
    });
    let versions;
    try { versions = (plan.changed.scenes || plan.changed.shots) ? writePlan(p, plan, `song ${from} → ${v.id}: ${SG.planSummary(plan, lines_moved)}`.slice(0, 300)) : { scenes: null, storyboard: null }; }
    catch (e) { writeJSON(path.join(pd, 'song.json'), backup); throw e; }
    if (plan.changed.events) mutateEvents(p, (d) => { const at = nowIso(); for (const r of plan.rows.filter(y => y.kind === 'event')) { const e = d.events.find(y => y.id === r.id); if (!e) continue; e.t = r.to; if (Number.isFinite(e.measured)) e.measured = map(e.measured); (e.retimed ||= []).push({ from: r.from, to: r.to, at, song: v.id }); if (e.retimed.length > 20) e.retimed.shift(); } });
    fs.mkdirSync(path.join(pd, 'peaks'), { recursive: true });
    writeJSON(path.join(pd, 'peaks', 'mix.json'), I.peaks(x, 'mix', v.audio));
    writeJSON(path.join(pd, 'energy.json'), I.energy(x));
    return { version: v.id, from, duration_ms: durMs, versions, ...planOut(plan, lines_moved) };
  },
  song_upload(p, { upload, name, size, offset, data, done = false, via } = {}) {
    pageOnly(via, 'uploading a song file');
    if (typeof upload !== 'string' || !/^[a-z0-9]{8,40}$/.test(upload)) fail(400, 'upload: an id of 8-40 lower-case letters and digits');
    if (!Number.isInteger(size) || size <= 0 || size > 300 * 1048576) fail(413, 'size: up to 300 MB');
    if (!Number.isInteger(offset) || offset < 0) fail(400, 'offset: where this chunk starts');
    if (typeof data !== 'string' || data.length > 8.2e6) fail(413, 'a chunk is at most 6 MB');
    const buf = Buffer.from(data, 'base64'), dir = path.join(projDir(p), '.uploads'), part = path.join(dir, upload + '.audio.part');
    fs.mkdirSync(dir, { recursive: true });
    if (offset === 0) { if (!audioSniff(buf)) fail(415, `${String(name || 'the file').slice(0, 80)}: not an audio file (MP3, WAV, M4A, FLAC, OGG; judged by its bytes)`); fs.writeFileSync(part, Buffer.alloc(0)); }
    let have = 0; try { have = fs.statSync(part).size; } catch (e) { fail(409, 'unknown upload: start again at offset 0'); }
    if (offset !== have) fail(409, `expected offset ${have}`);
    if (have + buf.length > size) { fs.rmSync(part, { force: true }); fail(413, `more bytes than the declared size (${size})`); }
    fs.appendFileSync(part, buf);
    if (!done) return { upload, received: have + buf.length, size };
    if (have + buf.length !== size) { fs.rmSync(part, { force: true }); fail(400, 'incomplete upload'); }
    let head = Buffer.alloc(16); { const fd = fs.openSync(part, 'r'); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd); }
    const ext = audioSniff(head); if (!ext) { fs.rmSync(part, { force: true }); fail(415, 'not an audio file'); }
    const base = String(name || 'song').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'song';
    const out = path.join(projDir(p), 'audio', 'versions'); fs.mkdirSync(out, { recursive: true });
    let fn = `${base}.${ext}`, n = 2; while (fs.existsSync(path.join(out, fn))) fn = `${base}-${n++}.${ext}`;
    fs.renameSync(part, path.join(out, fn));
    return { path: `audio/versions/${fn}`, size };
  },
  suno_brief(p, { style, exclude, title, save = false, by = 'agent' } = {}) {
    for (const [k, v] of [['style', style], ['exclude', exclude], ['title', title]]) if (v != null && (typeof v !== 'string' || v.length > 6000)) fail(400, `${k}: text`);
    const b = briefOf(p, { style, exclude, title });
    if (save) mutate(p, 'settings.json', (s) => { s.suno = { ...(s.suno || {}), ...(style != null ? { style: b.style } : {}), ...(exclude != null ? { exclude: b.exclude } : {}), ...(title != null ? { title: b.title } : {}), by: String(by).slice(0, 40), at: nowIso() }; });
    return { ...b, saved: !!save, note: 'paste it into Suno yourself (custom mode); nothing here calls Suno. Bring the song back with song_version_add (or the page\'s upload)' };
  },
});
// audio by its first bytes -> an extension, or null
export function audioSniff(b) {
  if (!b || b.length < 12) return null;
  const s = (a, z) => b.toString('latin1', a, z);
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'wav';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(4, 8) === 'ftyp' && /^(M4A |M4B |mp42|isom|dash)/.test(s(8, 12))) return 'm4a';
  return null;
}
