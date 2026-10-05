#!/usr/bin/env node
// Contact sheets from a shell (ROADMAP_v4 E8; lib/contact.mjs, the same code the workbench uses). Free and local (ffmpeg).
//   node tools/contact.mjs <video> <out.jpg> [--every 2] [--cols 6] [--from 61.5]     a frame every N s (labels: --from + media time)
//   node tools/contact.mjs <video> <out.jpg> --seams 73.888,118.664 [--fps 30]       -0.25 s, -1 frame, the seam, +1 frame, +0.25 s
//   node tools/contact.mjs --images a.png b.jpg c.mp4 <out.jpg> [--cols 3]            one tile per file (a video: its first frame)
// It writes only <out.jpg>. Inside a project prefer sheet_make (MCP) or the page: the sheet is then registered and reviewable.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../lib/contact.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const cols = Number(opt('--cols', 0)) || undefined, every = Number(opt('--every', 2)), from = Number(opt('--from', 0)), seams = opt('--seams', null), fps = Number(opt('--fps', 0)) || undefined;
const clock = (s) => { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };
if (!argv.length || argv.includes('--help')) { console.log(fileURLToPath(import.meta.url).split(path.sep).pop() + ': see the header of this file'); process.exit(argv.length ? 0 : 1); }
try {
  let r;
  if (argv[0] === '--images') {
    const files = argv.slice(1, -1), out = argv.at(-1);
    r = C.sheet(files.map(f => ({ src: path.resolve(f), kind: /\.(mp4|mov|webm|mkv)$/i.test(f) ? 'video' : 'image', t: 0, text: path.basename(f) })), path.resolve(out), { cols: cols || 3 });
  } else if (seams) {
    r = C.seamsSheet(path.resolve(argv[0]), path.resolve(argv[1]), seams.split(',').map(Number).filter(Number.isFinite).map(t => ({ t: t - from })), { fps, label: (s, f) => `${(from + s).toFixed(3)} f${f}` });
  } else r = C.videoSheet(path.resolve(argv[0]), path.resolve(argv[1]), { every, cols: cols || 6, label: (s) => clock(from + s) });
  console.log(`sheet: ${r.file} (${r.tiles} tiles, ${r.cols} x ${r.rows})`);
} catch (e) { console.error(e.message); process.exit(1); }
