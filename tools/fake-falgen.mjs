// A fake falgen-style generation tree for the D8 import tests (v17, test:mcp, test:security). Never calls fal: the
// images are made in memory (tools/tiny-png.mjs), the video by ffmpeg when it is on PATH (else bytes with an MP4 header).
//   makeFakeFalgen(base) -> {base, config}   writes, under base/ (the media base):
//     project/gen/out/A1/  A1_0_0.png A1_0_1.png job.json   nb2 2K x2; its cost is a row of project/LEDGER.md ($0.24)
//     project/gen/out/G01/ G01_0.mp4 job.json               a video job (h3 6 s); no ledger row: an estimate
//     project/gen/out/P9/  P9_0_0.png job.json              under the PRIVATE rule (private_media)
//     project/gen/out/A1/  notes.txt, fake.png (text named .png)   skipped by the scan, refused by the import
//     project/gen/refs/face.png                             a private ref (named by the jobs, never opened)
//     project/gen/spent.json, project/LEDGER.md             falgen's own totals
//     outside/secret.png                                    outside the media roots
//   config: {media_base, media_roots, private_media} for a WORKBENCH_CONFIG file
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tinyPng } from './tiny-png.mjs';

const W = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); };
// a 160x90 frame with a few bands of colour (so a thumbnail shows something)
function frame([r, g, b]) {
  try { const o = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')}:s=160x90,drawbox=x=50:y=20:w=60:h=50:color=white@0.8:t=fill`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 1 << 24, timeout: 20000 }); if (o.status === 0 && o.stdout?.length > 8) return o.stdout; } catch (e) { /* no ffmpeg */ }
  return tinyPng(160, 90, [r, g, b]);
}
export function makeFakeFalgen(base) {
  const out = path.join(base, 'project', 'gen', 'out');
  const refs = ['project/gen/refs/face.png', 'project/gen/out/I5/I5_0_0.png'];
  W(path.join(out, 'A1', 'A1_0_0.png'), frame([40, 90, 160]));
  W(path.join(out, 'A1', 'A1_0_1.png'), frame([160, 70, 40]));
  W(path.join(out, 'A1', 'job.json'), JSON.stringify({ job: { id: 'A1', kind: 'image', model: 'nb2', aspect: '16:9', resolution: '2K', n: 2, refs,
    prompt: 'HOODIE HACKER: the same desk and framing as the last reference image, at night: the man sits hunched at a beige CRT in a black hoodie, the screen glows a soft flat green and lights his face from below. Locked camera.', notes: 'verse-4 still' },
  endpoint: 'fal-ai/nano-banana-2/edit', log: [{ take: 0, ok: true, request_id: 'req-a1' }], files: ['A1_0_0.png', 'A1_0_1.png'] }, null, 1));
  W(path.join(out, 'A1', 'notes.txt'), 'not media');
  W(path.join(out, 'A1', 'fake.png'), '<html><script>alert(1)</script></html>');
  let mp4 = null;
  try { const t = path.join(out, 'G01', 'G01_0.mp4'); fs.mkdirSync(path.dirname(t), { recursive: true }); const o = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=12:duration=1', '-pix_fmt', 'yuv420p', t], { timeout: 30000 }); if (o.status === 0) mp4 = t; } catch (e) { /* no ffmpeg */ }
  if (!mp4) { const b = Buffer.alloc(64); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); W(path.join(out, 'G01', 'G01_0.mp4'), b); }
  W(path.join(out, 'G01', 'job.json'), JSON.stringify({ job: { id: 'G01', kind: 'video', model: 'h3', image: 'project/gen/out/A1/A1_0_0.png', duration: 6, resolution: '768P', takes: 1, notes: 'eyes open just after the boot sound' },
    endpoint: 'minimax/h3/image-to-video', log: [{ take: 0, ok: true, request_id: 'req-g01' }], files: ['G01_0.mp4'] }, null, 1));
  W(path.join(out, 'P9', 'P9_0_0.png'), frame([90, 40, 120]));
  W(path.join(out, 'P9', 'job.json'), JSON.stringify({ job: { id: 'P9', kind: 'image', model: 'nb2', resolution: '1K', n: 1, refs: ['project/gen/refs/face.png'], prompt: 'a private test frame' }, endpoint: 'fal-ai/nano-banana-2/edit', log: [{ take: 0, ok: true }], files: ['P9_0_0.png'] }, null, 1));
  W(path.join(base, 'project', 'gen', 'refs', 'face.png'), tinyPng(8, 8, [200, 160, 140]));
  W(path.join(base, 'project', 'gen', 'spent.json'), JSON.stringify({ total: 0.24 }));
  W(path.join(base, 'project', 'LEDGER.md'), '# Ledger\n\n| date | job | tool | items | usd | note |\n|---|---|---|---|---|---|\n| 2026-10-04 | A1 | fal A1 via falgen | | 0.24 | gen total 0.24 |\n');
  W(path.join(base, 'outside', 'secret.png'), tinyPng(4, 4, [255, 0, 0]));
  return { base, config: { media_base: base, media_roots: ['project/gen/out/', 'project/gen/refs/'], private_media: '^(project/gen/refs/|project/gen/out/P9/)' } };
}
// standalone: node tools/fake-falgen.mjs <dir>   (a tree to try File › Import media by hand)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const dir = path.resolve(process.argv[2] || 'fake-falgen');
  console.log(JSON.stringify(makeFakeFalgen(dir).config, null, 1));
}
