// MCP tools: job books, waves and pilot gates (lib/ops/batches.mjs, js/batches.js; ROADMAP_v4 D4). The agent reads the
// batches and proposes waves (drafts); approving a batch, marking it reviewed (which unlocks the next) and importing the
// job books are the director's, in the page (batch_act, jobbooks_import: no tool).
import { z } from 'zod';
import { mcp, op, wrap, project, by } from './_shared.mjs';

mcp.registerTool('batches_get', {
  title: 'Batches (waves) and their review gates',
  description: 'Read only. The batches of requests.json (waves of generation requests): per batch {id, name, wave, status draft | approved | reviewed, state locked | ready | running | review | done, why, '
    + 'gate {after: the batch it waits for, rule: review}, request_ids, totals {est_usd, drafts_usd, spent_usd, max_usd (its cap), left_usd}, verdicts (per request: picked | rejected | kept | pending | n/a), '
    + 'stats (the take ratio: takes made, used shots, takes_per_used_shot, spent_usd, used_s, usd_per_used_s)}; observed = what the reviewed waves measured; remaining = the waves not run yet re-estimated '
    + '(list_usd from the list prices, observed_usd = their seconds x the cost per used second measured); history = the requests imported from the job books (never run again); costs vs the cap. '
    + 'A locked batch never runs; the director approves a whole batch and marks it reviewed in the page (Review › Queue). Tell the director the observed numbers before the next wave.',
  inputSchema: { project, id: z.string().optional().describe('one batch id (b01)') },
}, wrap((a) => op('batches_get', a)));

mcp.registerTool('waves_propose', {
  title: 'Propose waves of shots (pilot first)',
  description: 'Propose generation waves from the storyboard gaps (shots without a request or clip, and shots whose draft requests are in no batch): a pilot first (pilot: the shot ids the director named, '
    + 'e.g. ["G02", "G07", "G15"]; default the first shots in song time), then waves of sizes (default [2, 4, 8]: 2 -> 4 -> 8 -> the rest). Each new shot gets the draft request gaps_get proposes (the start '
    + 'still first; takes x its list-price estimate); each wave becomes a DRAFT batch gated on the one before (it stays locked until the director marks the previous wave reviewed). dry_run: true = the plan only '
    + '(waves, shots, estimates, the cap, the observed take ratio and each wave re-estimated from it when a wave was reviewed already): show it to the director first. '
    + 'This never approves or unlocks anything: the director approves a batch as a whole ("Approve batch · $X") and reviews it in the page. Then run an approved batch with request_run {batch}.',
  inputSchema: { project, pilot: z.array(z.string()).optional().describe('the pilot wave\'s shot ids'), shots: z.array(z.string()).optional().describe('only these shots (default: every gap)'),
    sizes: z.array(z.number().int().min(1).max(50)).optional().describe('wave sizes after the pilot, default [2, 4, 8] (then the rest)'), takes: z.number().int().min(1).max(8).optional().describe('takes per request (default 1; 2 measures the take ratio)'),
    dry_run: z.boolean().optional().describe('the plan only: nothing is written'), by },
}, wrap((a) => op('waves_plan', { ...a, via: 'agent' })));
