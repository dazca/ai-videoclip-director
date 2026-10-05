#!/usr/bin/env node
// Composition data export (ROADMAP_v4 E9): the workbench's picks as ONE versioned JSON file a HyperFrames composition can
// read back (exporters/composition-data/reader.js), so a take picked in the page changes the render. The format is
// documented in docs/COMPOSITION_ROUNDTRIP.md ("edl.json, version 1").
//
//   node exporters/composition-data.mjs --project <id> [--out composition/edl.json] [--map "gen/=assets/gen/,=assets/"]
//
// What it writes: data/<project>/exports/<out> (default exports/composition/edl.json), and nothing else: never a project
// file, never a media file, never an approval. The same project state gives the same bytes (no clock, sorted keys
// where order is free) and the file carries a sha256 checksum of its own body.
//   - one row per storyboard shot (the current version), in time order: id, t0 / t1 (song ms), scene, kind, title, the
//     clip-use ids it covers (shots.json `uses`, e.g. "G05@20158"), the picked take (file mapped under the composition's
//     assets, its workbench source, request / take, kind, in_ms / out_ms) or a placeholder {reason: unpicked | private |
//     missing | unmapped, label, and (E5) the placeholder FRAME: id, kind, time, text, cast, world and `svg`, the same neutral
//     16:9 frame the workbench draws (js/placeholder.js), so the composition can show it until the take lands}, the
//     alternatives, and the look / variant of every asset chip (js/storyboard.js resolveAsset; E6: the look of the shot's
//     world) with `world` when the shot has one; E3: `chapters` [{id, name, scenes, owner, file, status, shots, picked,
//     placeholders}] with their derived build status
//   - the song's timing anchors: duration, bpm, beat / bar length, first beat / downbeat, sections, line ids and times
//   - PRIVATE media is never written: a picked take that is private (the PRIVATE path rule, or private:true in
//     media.json) exports as a placeholder with reason "private" and no file name; a private alternative is dropped
// The file mapping: [{from, to}] rules on the take's workbench media path, longest `from` first (`to` + the rest of the
// path). Default [{from: "", to: "assets/"}]. Where it comes from: the `map` argument, else settings.json
// `composition.map` (the page's dialog), else project.json `composition.map`, else the default.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as SB from '../js/storyboard.js';
import { cleanRel, fail, inside, isFlaggedPrivate, isPrivate, projDir, read, readJSON, writeAtomic } from '../lib/ops/_shared.mjs';
import { boardDoc } from '../lib/ops/storyboard.mjs';
import { scenesDoc } from '../lib/ops/scenes.mjs';
import { currentScript } from '../js/scenes.js';
import { placeholderFor } from '../js/placeholder.js';
import { chaptersView } from '../js/chapters.js';

export const FORMAT = 'director-workbench/composition-edl', VERSION = 1;
export const DEFAULT_OUT = 'composition/edl.json', DEFAULT_MAP = [{ from: '', to: 'assets/' }];
export const EXPORTS = 'exports';
const OUT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,159}\.json$/;

// ------------------------------------------------------------------ arguments
// the export file, relative to data/<project>/exports/: letters, digits, _ . - and /, ending in .json; no "." / ".." /
// empty segment, no backslash, drive or leading slash. Throws 400.
export function checkOut(out) {
  const o = out == null || out === '' ? DEFAULT_OUT : out;
  if (typeof o !== 'string' || !OUT_RE.test(o) || !cleanRel(o) || o.split('/').some(s => s === '')) fail(400, `out: a .json path inside the project's exports/ folder ("${DEFAULT_OUT}"), without "..", ".", a drive, a backslash or a leading slash`);
  return o;
}
// the file mapping: up to 20 {from, to}; both relative and clean (no "..", no leading slash, no backslash, no drive)
export function checkMap(map) {
  if (map == null) return null;
  if (!Array.isArray(map) || map.length > 20) fail(400, 'map: a list of up to 20 {from, to} rules');
  const ok = (s) => typeof s === 'string' && s.length <= 200 && (s === '' || (cleanRel(s) && !/^\//.test(s) && !/:/.test(s) && !s.split('/').slice(0, -1).some(x => x === '')));
  return map.map((r, i) => {
    if (!r || typeof r !== 'object' || !ok(r.from ?? '') || !ok(r.to ?? '')) fail(400, `map[${i}]: {from, to}: relative paths without "..", ".", a drive, a backslash or a leading slash`);
    return { from: String(r.from ?? ''), to: String(r.to ?? '') };
  });
}
// a workbench media path -> the composition's path (the longest matching `from`), or null when no rule matches
export function mapFile(file, map) {
  const r = [...map].sort((a, b) => b.from.length - a.from.length).find(x => file.startsWith(x.from));
  return r ? r.to + file.slice(r.from.length) : null;
}

// ------------------------------------------------------------------ the document (pure: no file system)
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
export const checksumOf = (doc) => { const { checksum: _c, ...body } = doc; return 'sha256:' + createHash('sha256').update(JSON.stringify(body)).digest('hex'); };
// input: {project, title, song, board (storyboard doc), entities, approvals, media (media.json items), isPrivate(path)}
export function buildEdl({ project, title = null, song, board, scenes = [], entities = [], approvals = null, requests = null, media = [], isPrivate: priv = () => false }, { map = DEFAULT_MAP } = {}) {
  const v = SB.currentBoard(board), shots = [...(v?.shots || [])].sort(SB.byTime);
  const byPath = new Map(media.filter(m => typeof m?.path === 'string').map(m => [m.path.replace(/\\/g, '/').toLowerCase(), m]));
  const mediaOf = (f) => byPath.get(String(f).replace(/\\/g, '/').toLowerCase()) || null;
  const secret = (f) => { const m = mediaOf(f); return priv(f) || !!m?.private; };
  const warnings = [], counts = { shots: shots.length, picked: 0, placeholders: 0, private: 0, unmapped: 0 };
  const rows = shots.map((s) => {
    const looks = {}, variants = {};
    let world = null;
    for (const a of SB.shotAssets(s, entities, approvals, scenes)) { (a.type === 'character' ? looks : variants)[a.id] = a.missing ? null : a.variant; if (a.world) world = a.world; }
    world ||= s.context || scenes.find(x => x.id === s.scene)?.context || null;
    const row = { id: s.id, t0: s.t0, t1: s.t1, scene: s.scene ?? null, kind: s.kind, title: s.title || '', uses: [...(s.clips || [])], ...(world ? { world } : {}) };
    const c = s.clip, label = s.title || s.id;
    let reason = null;
    if (!c?.file) reason = 'unpicked';
    else if (secret(c.file)) reason = 'private';
    else if (!mediaOf(c.file)) reason = 'missing';
    else if (mapFile(c.file, map) == null) reason = 'unmapped';
    if (reason) {
      counts.placeholders++; if (reason === 'private') counts.private++; if (reason === 'unmapped') counts.unmapped++;
      if (reason === 'missing') warnings.push(`${s.id}: the picked take is no longer in media.json: a placeholder`);
      if (reason === 'unmapped') warnings.push(`${s.id}: no map rule covers the picked take: a placeholder`);
      // E5: the placeholder frame (made from the shot's own text: never a file name, so a private take does not leak)
      const ph = placeholderFor(s, { entities, scenes, reason });
      Object.assign(row, { status: 'placeholder', placeholder: { reason, label, id: ph.id, kind: ph.kind, time: ph.time, text: ph.text, cast: ph.cast, world: ph.world, svg: ph.svg } });
    } else {
      counts.picked++;
      Object.assign(row, { status: 'picked', take: { file: mapFile(c.file, map), source: c.file, media: c.media ?? null, request: c.request ?? null, take: c.take ?? null,
        kind: c.kind || (/\.(png|jpe?g|webp|gif)$/i.test(c.file) ? 'image' : 'video'), in_ms: c.in_ms ?? 0, out_ms: c.out_ms ?? null } });
      const alt = (c.alt || []).filter(a => !(a.file && secret(a.file))).map(a => {
        const f = a.file ? mapFile(a.file, map) : null;
        return { t: a.t, take: a.take ?? null, file: f, ...(a.file && f != null ? { source: a.file } : {}), note: a.note || '' };
      }).sort((a, b) => a.t - b.t);
      if (alt.length) row.alt = alt;
    }
    row.looks = sortKeys(looks); row.variants = sortKeys(variants);
    return row;
  });
  const g = song?.grid || {};
  const doc = {
    format: FORMAT, version: VERSION, about: 'docs/COMPOSITION_ROUNDTRIP.md in the Director Workbench',
    project, title: title || song?.title || project, storyboard: v?.id || null, units: { time: 'ms' }, map,
    song: { duration_ms: song?.duration_ms ?? null, bpm: song?.bpm ?? null, beat_ms: song ? SB.beatMs(song) : null, bar_ms: song ? SB.barMs(song) : null,
      beats_per_bar: song?.beats_per_bar ?? 4, first_beat_ms: g.beats?.[0] ?? null, first_downbeat_ms: g.downbeats?.[0] ?? null,
      sections: (song?.sections || []).map(x => ({ id: x.id, label: x.label ?? x.id, t0: x.t0, t1: x.t1 })),
      lines: (song?.lines || []).map(x => ({ id: x.id, t0: x.t0, t1: x.t1 })) },
    counts, shots: rows, warnings,
    chapters: chaptersView(board, { scenes, shots, approvals, requests }).map(c => ({ id: c.id, name: c.name, scenes: c.scenes, t0: c.t0, t1: c.t1, owner: c.owner || null, file: c.file || null, status: c.status, shots: c.shots, picked: c.picked, placeholders: c.placeholders })),
  };
  doc.checksum = checksumOf(doc);
  return doc;
}

// ------------------------------------------------------------------ the project -> the file
const entitiesOf = (p) => (read(p, 'entities/index.json') || []).filter(e => typeof e?.path === 'string' && !/\.\./.test(e.path))
  .map(e => { const x = readJSON(path.join(projDir(p), e.path), null); return x && typeof x === 'object' ? { ...x, id: e.id, kind: e.kind } : null; }).filter(Boolean);
export function settingsOf(p) {
  const s = (read(p, 'settings.json') || {}).composition, j = (readJSON(path.join(projDir(p), 'project.json'), {}) || {}).composition;
  return { map: s?.map ?? j?.map ?? null, out: s?.out ?? j?.out ?? null };
}
export function edlOf(p, { map } = {}) {
  const st = settingsOf(p), M = checkMap(map ?? st.map) || DEFAULT_MAP;
  const meta = readJSON(path.join(projDir(p), 'project.json'), {}) || {};
  return buildEdl({ project: p, title: meta.title || null, song: read(p, 'song.json'), board: boardDoc(p), scenes: currentScript(scenesDoc(p))?.scenes || [], entities: entitiesOf(p), approvals: read(p, 'approvals.json'), requests: read(p, 'requests.json'),
    media: read(p, 'media.json').items || [], isPrivate: (x) => isPrivate(x) || isFlaggedPrivate(x, [p]) }, { map: M });
}
// writes data/<p>/exports/<out> only; returns {path, abs, checksum, bytes, changed, counts, warnings}
export function exportComposition(p, { out, map, dry_run = false } = {}) {
  const o = checkOut(out ?? settingsOf(p).out), pd = projDir(p), root = path.join(pd, EXPORTS);
  const abs = inside(root, o);
  if (!abs || abs === root) fail(400, 'out: a path inside the project\'s exports/ folder');
  const doc = edlOf(p, { map }), bytes = JSON.stringify(doc, null, 1) + '\n';
  let prev = null; try { prev = fs.readFileSync(abs, 'utf8'); } catch (e) { /* first export */ }
  if (!dry_run) {
    // a junction / symlink inside exports/ must not lead the write anywhere else: checked on the nearest existing folder
    // BEFORE any folder is made (review #3 I4: no directory is created through a pre-planted junction), and again after
    fs.mkdirSync(root, { recursive: true });
    const real = (x) => fs.realpathSync.native(x), rr = real(root);
    let up = path.dirname(abs); while (!fs.existsSync(up) && up.startsWith(root + path.sep)) up = path.dirname(up);
    const ru = real(up); if (ru !== rr && !ru.startsWith(rr + path.sep)) fail(400, 'out: the folder leads outside the project\'s exports/ folder');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const rd = real(path.dirname(abs));
    if (rd !== rr && !rd.startsWith(rr + path.sep)) fail(400, 'out: the folder leads outside the project\'s exports/ folder');
    try { if (fs.lstatSync(abs).isSymbolicLink()) fail(400, 'out: a link, not a file'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (prev !== bytes) writeAtomic(abs, bytes);
  }
  return { path: `${EXPORTS}/${o}`, abs, checksum: doc.checksum, bytes: Buffer.byteLength(bytes), changed: prev !== bytes, dry_run: !!dry_run,
    format: `${FORMAT} v${VERSION}`, storyboard: doc.storyboard, map: doc.map, counts: doc.counts, warnings: doc.warnings };
}

// ------------------------------------------------------------------ CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const { CFG } = await import('../lib/ops/_shared.mjs');   // (not lib/store.mjs: it imports this file)
  const project = arg('--project') || CFG.defaultProject, m = arg('--map');
  const map = m == null ? undefined : m.split(',').filter(Boolean).map(r => { const i = r.indexOf('='); return { from: r.slice(0, i), to: r.slice(i + 1) }; });
  try { console.log(JSON.stringify(exportComposition(project, { out: arg('--out'), map, dry_run: process.argv.includes('--dry-run') }), null, 1)); }
  catch (e) { console.error(`error ${e.code || ''}: ${e.message}`); process.exit(1); }
}
