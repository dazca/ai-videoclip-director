#!/usr/bin/env node
// Run APPROVED generation requests from a shell: the same runner as the Queue's Run buttons and the MCP tool request_run
// (lib/run.mjs; generators/ picked per kind in Settings > Generator, fal by default).
//   node tools/run.mjs --project <p> <request id> [...]   run these (approved ones only)
//   node tools/run.mjs --project <p> --all                 every approved request, batch by batch
//   node tools/run.mjs --project <p> --batch b02           one batch (wave): approved and unlocked only, within its cap
//   ... --dry-run                                          the plan and the total: nothing is called, written or spent
//   ... --parallel 2                                       at most N image requests at once (default 2, max 4)
//   ... --video-parallel 1                                 at most N video requests at once (default 1, max 4)
//   ... --max-usd 2                                        a cap for this batch (the rest refused)
//   ... --retake                                           the FAILED takes of done requests only (their done takes are kept)
// The fal key: FAL_KEY in the environment, or fal_key_file in workbench.config.json (a file outside the workbench); it
// is never printed. Works on the files directly (a running server's page follows through its file watcher). Prints one
// line per request and a summary line; exits 1 when something was refused or failed.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2), flag = (f) => { const i = argv.indexOf(f); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = (f) => { const i = argv.indexOf(f); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
if (flag('--help') || flag('-h')) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
const project = opt('--project'), parallel = Number(opt('--parallel') || 2), videoParallel = Number(opt('--video-parallel') || 1), dry = flag('--dry-run'), all = flag('--all'), retake = flag('--retake'), maxUsd = opt('--max-usd'), batch = opt('--batch');
const S = await import('../lib/store.mjs');
const p = project || S.CFG.defaultProject, ids = argv.filter(a => !a.startsWith('--'));
if (!all && !batch && !ids.length) { console.error('give request ids, --all or --batch <id> (see --help)'); process.exit(2); }
try {
  const r = await S.ops.request_run(p, { ...(batch ? { batch } : all ? { all: true } : { ids }), dry_run: dry, parallel, video_parallel: videoParallel, retake, ...(maxUsd != null ? { max_usd: Number(maxUsd) } : {}), wait: true, by: 'cli' });
  const $ = (x) => `$${(Number(x) || 0).toFixed(3)}`;
  if (dry) {
    for (const x of r.items) console.log(x.ok ? `PLAN  ${x.id}  ${x.generator} ${x.tool} x${x.takes}${x.video ? ` ${x.video.seconds} s @ $${x.video.per_s}/s` : ''}${x.retake ? ` retake ${x.retake.join(',')}` : ''}  est ${$(x.est_usd)} (approved ${$(x.approved_usd)})${x.have_takes.length ? `  takes on disk: ${x.have_takes.join(',')}` : ''}${x.cap.fits ? '' : '  OVER THE CAP'}  -> ${x.out_dir}/` : `NO    ${x.id}  ${x.why}`);
    console.log(`total est ${$(r.est_total_usd)} · spent ${$(r.costs.total_spent_usd)} · committed ${$(r.costs.committed_usd)} · cap ${$(r.costs.cap_usd)} · dry run: nothing called, written or spent`);
  } else {
    for (const x of r.refused) console.log(`NO    ${x.id}  ${x.why}`);
    for (const x of r.results) console.log(`${x.status.toUpperCase().padEnd(5)} ${x.id}  ${x.status === 'done' ? `${x.outputs.join(', ')}  ${$(x.actual_cost_usd)}` : x.why || x.pack || ''}`);
    console.log(`spent now ${$(r.costs.total_spent_usd)} of cap ${$(r.costs.cap_usd)}`);
  }
  const bad = (r.refused || []).length || (r.results || []).some(x => !['done', 'handed_off'].includes(x.status));
  process.exitCode = bad ? 1 : 0;
} catch (e) { console.error(`error ${e.code || ''}: ${e.message}`); process.exitCode = 1; }
// the runner's fetches keep no handles open; leave when done
setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
