#!/usr/bin/env node
// Lazy media for an HTML package made by export.mjs (export.mjs --lazy-media calls this too).
//
//   node lazy/build.mjs <outDir> [--lead 15] [--first 10] [--min-kb 256] [--budget-mb 150] [--concurrency 3]
//   node lazy/build.mjs <outDir> --off          # take it out again (restores the entry HTML byte for byte)
//
// Injects lazy-media.js plus its schedule (from manifest.json usage.visible) into the PACKAGE copy of the entry HTML,
// as the first thing in <head>. That inline script is the only change: every other composition file stays
// byte-identical, and the composition sources are never touched. Static <img|video src> of scheduled files in the
// entry HTML are rewritten to data-hf-lazy (the loader puts them back). manifest.json records the rewrite (the entry's
// new sha256, original_sha256) and a `lazy_media` block: the settings, the scheduled files and the unobserved ones.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEGIN = '<!-- hyperframes-html lazy-media -->', END = '<!-- /hyperframes-html lazy-media -->';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const WHAT = 'lazy media loader + schedule injected (inline <script> first in <head>; static src of scheduled files -> data-hf-lazy)';

export function addLazyMedia(outDir, o = {}) {
  const OUT = resolve(outDir), MP = join(OUT, 'manifest.json');
  const M = JSON.parse(readFileSync(MP, 'utf8'));
  const entryPath = M.composition.entry, entryFile = join(OUT, entryPath);
  const entryAsset = M.assets.find((a) => a.path === entryPath);
  const original = stripLazy(readFileSync(entryFile, 'utf8'), entryAsset);
  M.rewrites = (M.rewrites || []).filter((r) => !(r.file === entryPath && r.what === WHAT));
  if (o.off) {
    writeFileSync(entryFile, original);
    finishAsset(entryAsset, entryFile, null, M);
    delete M.lazy_media;
    writeFileSync(MP, JSON.stringify(M, null, 1));
    return { off: true };
  }
  const cfg = {
    lead: num(o.lead, 15), first: num(o.first, 10), pad: num(o.pad, 0.25), keep: num(o.keep, 5),
    budget: Math.round(num(o.budgetMb, 150) * 1048576), conc: Math.max(1, Math.round(num(o.concurrency, 3))),
  };
  const minBytes = num(o.minKb, 256) * 1024;
  const entryDir = posix.dirname(entryPath);
  const sched = [], unobserved = [];
  for (const a of M.assets) {
    if ((a.kind !== 'image' && a.kind !== 'video') || a.bytes < minBytes) continue;
    const win = (a.usage && a.usage.visible) || [];
    if (!win.length) unobserved.push(a.path);
    sched.push([posix.relative(entryDir, a.path), a.kind, a.bytes, win]);
  }
  const rel = new Set(sched.map((s) => s[0]));
  // static <img|video ... src="scheduled"> in the entry HTML: parked the same way the hooks park runtime ones
  let html = original.replace(/<(img|video)\b[^>]*>/gi, (tag) => tag.replace(/(\s)src\s*=\s*("([^"]*)"|'([^']*)')/i, (m, sp, q, a, b) => {
    const v = a ?? b; let p; try { p = posix.normalize(decodeURIComponent(v.split(/[?#]/)[0])); } catch { p = v; }
    return rel.has(p) ? `${sp}data-hf-lazy=${q}` : m;
  }));
  const staticParked = (html.match(/data-hf-lazy=/g) || []).length;
  const js = readFileSync(join(HERE, 'lazy-media.js'), 'utf8');
  const block = `${BEGIN}<script>window.__HF_LAZY_CFG=${JSON.stringify({ ...cfg, assets: sched }).replace(/</g, '\\u003c')};\n${js}</script>${END}`;
  // after <meta charset> when it is there (it must stay in the first 1024 bytes), else right after <head>
  const at = /<meta\s+charset[^>]*>/i.exec(html) || /<head\b[^>]*>/i.exec(html);
  if (!at) throw new Error(`no <head> in ${entryPath}`);
  html = html.slice(0, at.index + at[0].length) + block + html.slice(at.index + at[0].length);
  writeFileSync(entryFile, html);
  const exported = sha(Buffer.from(original));
  finishAsset(entryAsset, entryFile, exported, M);
  M.rewrites.push({ file: entryPath, what: WHAT, from: exported, to: entryAsset && entryAsset.sha256 });
  const bytes = sched.reduce((s, x) => s + x[2], 0);
  M.lazy_media = {
    ...cfg, budget_mb: cfg.budget / 1048576, min_kb: minBytes / 1024, scheduled: sched.length, scheduled_bytes: bytes, static_parked: staticParked,
    first_window_bytes: sched.filter((s) => s[3].some(([a]) => a < cfg.first + cfg.pad)).reduce((s, x) => s + x[2], 0),
    unobserved, note: 'files >= min_kb load from about `lead` s before their visible ranges (a <video data-start> from its own timing); the first `first` s load first; over `budget` far media is parked again. Unobserved files (never on screen during the export pass) load only if one shows up on screen.',
  };
  writeFileSync(MP, JSON.stringify(M, null, 1));
  return { scheduled: sched.length, bytes, unobserved: unobserved.length, staticParked, cfg };
}

function num(v, d) { const n = Number(v); return v === undefined || v === null || v === '' || Number.isNaN(n) ? d : n; }
// the entry HTML without our block (static data-hf-lazy put back): the file export.mjs wrote
function stripLazy(s, asset) {
  const i = s.indexOf(BEGIN), j = s.indexOf(END);
  if (i < 0) return s;
  s = s.slice(0, i) + s.slice(j + END.length);
  s = s.replace(/<(img|video)[^>]*>/gi, (tag) => tag.replace(/(s)data-hf-lazy=/i, '$1src='));
  if (asset && asset.lazy_from_sha256 && sha(Buffer.from(s)) !== asset.lazy_from_sha256) throw new Error(`${asset.path}: removing the lazy block did not restore the exported file`);
  return s;
}
// manifest entry of the entry HTML: sha256/bytes of the file now; lazy_from_sha256 = the exported file before the block
function finishAsset(a, file, exported, M) {
  if (!a) return;
  const delta = statSync(file).size - a.bytes;
  a.sha256 = sha(readFileSync(file)); a.bytes += delta;
  for (const k of [a.kind, 'all']) if (M.totals && M.totals[k]) M.totals[k].bytes += delta;
  if (exported) a.lazy_from_sha256 = exported; else delete a.lazy_from_sha256;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), out = args[0];
  const val = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined; };
  if (!out || !existsSync(join(out, 'manifest.json'))) {
    console.error('usage: node lazy/build.mjs <outDir> [--lead 15] [--first 10] [--min-kb 256] [--budget-mb 150] [--concurrency 3] | --off');
    process.exit(2);
  }
  const r = addLazyMedia(out, { off: args.includes('--off'), lead: val('--lead'), first: val('--first'), minKb: val('--min-kb'), budgetMb: val('--budget-mb'), concurrency: val('--concurrency') });
  if (r.off) console.log('lazy media removed: the entry HTML is the exported file again');
  else console.log(`lazy media: ${r.scheduled} files (${(r.bytes / 1048576).toFixed(1)} MB) scheduled, lead ${r.cfg.lead} s, first ${r.cfg.first} s, budget ${(r.cfg.budget / 1048576).toFixed(0)} MB; ${r.unobserved} unobserved; ${r.staticParked} static src parked`);
}
