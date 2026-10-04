#!/usr/bin/env node
// Adds the interactive layer to an HTML package made by export.mjs (export.mjs --interactive calls this too).
//
//   node interactive/build.mjs <outDir> [--project <workbench project dir>]
//
// Writes, next to index.html (which stays the plain player):
//   interactive.html          the film in a same-origin iframe (composition/<entry>?standalone=1) + the overlay
//   interactive.js / .css     the layer (copied from this folder)
//   interactive.project.json  only with --project: shots, cast names, clip uses, lyric lines, script, notes
// Nothing under composition/ or _hyperframes/ is touched, and manifest.json is not rewritten.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrivate } from '../../../lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// paths that never leave the machine: the workbench PRIVATE rule (lib/store.mjs isPrivate: thumbs/priv_*, private/,
// the configured private_media regex), media flagged private in the project's media.json, and, so a config without
// private_media still holds them back, the owner's reference folders this layer always excluded
const LEGACY_PRIVATE = /(^|\/)gen\/refs\/|(^|\/)character-lab\/(refs|base)\//;

export function addInteractive(outDir, o = {}) {
  const OUT = resolve(outDir);
  const M = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
  const entry = (o.entry ? 'composition/' + o.entry : M.composition.entry).split('/').map(encodeURIComponent).join('/');
  const title = (o.title || M.composition.title || 'film') + ' · interactive';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const html = readFileSync(join(HERE, 'interactive.html'), 'utf8').replace('%TITLE%', () => esc(title)).replace('%ENTRY%', () => esc(entry + '?standalone=1'));
  writeFileSync(join(OUT, 'interactive.html'), html);
  copyFileSync(join(HERE, 'interactive.js'), join(OUT, 'interactive.js'));
  copyFileSync(join(HERE, 'interactive.css'), join(OUT, 'interactive.css'));
  const files = ['interactive.html', 'interactive.js', 'interactive.css'];
  if (o.project) {
    writeFileSync(join(OUT, 'interactive.project.json'), JSON.stringify(projectData(resolve(o.project))));
    files.push('interactive.project.json');
  }
  return files;
}

function projectData(dir) {
  const read = (f) => { const p = join(dir, f); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
  const shots = read('shots.json') || {}, song = read('song.json') || {}, script = read('script.json') || {}, notes = read('notes.json') || {}, ents = read('entities/index.json') || [];
  const norm = (p) => String(p).replace(/\\/g, '/');
  const flagged = new Set(((read('media.json') || {}).items || []).filter((m) => m && m.path && (m.private === true || m.status === 'private')).map((m) => norm(m.path)));
  const safe = (p) => (p && !isPrivate(norm(p)) && !LEGACY_PRIVATE.test(norm(p)) && !flagged.has(norm(p)) ? p : undefined);
  return {
    project: dir.split(/[\\/]/).pop(),
    shots: (shots.shots || []).map((s) => ({ id: s.id, t0: s.t0, t1: s.t1, section: s.section, kind: s.kind, title: s.title, cast: s.cast, locations: s.locations, clips: s.clips, note: s.note || undefined })),
    uses: (shots.uses || []).map((u) => ({ id: u.id, clip: u.clip, t0: u.t0, t1: u.t1, label: u.label, file: safe(u.file), start_image: safe(u.start_image), location: u.location })),
    lines: (song.lines || []).map((l) => ({ id: l.id, t0: l.t0, t1: l.t1, text: l.text })),
    script: (script.lines || []).map((s) => ({ id: s.id, t0: s.t0, lyric: s.lyric, action: s.action })),
    notes: (notes.notes || []).map((n) => ({ t: n.t, by: n.by, text: n.text, status: n.status })),
    entities: Object.fromEntries((Array.isArray(ents) ? ents : ents.entities || []).map((e) => [e.id, e.name || e.id])),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2], i = process.argv.indexOf('--project');
  if (!out || !existsSync(join(out, 'manifest.json'))) { console.error('usage: node interactive/build.mjs <outDir> [--project <dir>]'); process.exit(2); }
  const files = addInteractive(out, { project: i > 0 ? process.argv[i + 1] : null });
  console.log(`interactive layer: ${files.join(', ')}\n  open http://<server>/interactive.html (node serve.mjs ${out})`);
}
