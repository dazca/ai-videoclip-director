// MCP tools: approvals, the generation queue and costs (lib/ops/requests.mjs).
// Registered on the shared server object when mcp/server.mjs imports this file.
import { z } from 'zod';
import { mcp, op, wrap, project, time, by, directorApproved, charId, treeId, assetType, assetTree, pinsSchema } from './_shared.mjs';

const key = z.string().regex(/^[a-z-]+:.+/).describe('An item key "kind:id": shot:<id>, use:<clip use id e.g. G05@20158>, job:<clip id>, script:<s07>, section:<id>, character:<id>, location:<id>, prop:<id>.');

// ------------------------------------------------------------------ approvals
mcp.registerTool('approvals_get', {
  title: 'Get approval states', description: 'Approval records {"kind:id": {state, by, at, comment?}} with counts per state. States: draft, review, changes, approved, locked; an item without a record is draft. Filter by keys, key prefix ("shot:", "use:"), or state ("changes" = the director wants something redone).',
  inputSchema: { project, keys: z.array(key).optional(), prefix: z.string().optional(), state: z.string().optional() },
}, wrap((a) => op('approvals_get', a)));
mcp.registerTool('approve', {
  title: 'Approve items', description: 'Set items to approved. Approval is the DIRECTOR\'s decision: call this only when the director explicitly approved these items in this conversation, with director_approved:true. Refused unless the owner enabled agent approvals (workbench.config.json agent_approvals); by default the director approves in the page (show the items with ui_focus). The record is marked via "agent". To ask for a review instead, use shot_update status "review".',
  inputSchema: { project, keys: z.array(key).min(1), comment: z.string().optional(), by, director_approved: directorApproved },
}, wrap((a) => op('set_states', { ...a, state: 'approved', by: a.by || 'agent' })));
mcp.registerTool('request_changes', {
  title: 'Request changes', description: 'Set items to "changes" with a comment saying what must change (the director\'s words, or your review finding). The item shows red in the status column.',
  inputSchema: { project, keys: z.array(key).min(1), comment: z.string(), by },
}, wrap((a) => op('set_states', { ...a, state: 'changes' })));

// ------------------------------------------------------------------ generation requests (the queue) and costs
mcp.registerTool('requests_list', {
  title: 'List generation requests', description: 'The generation queue: {id, kind, target, prompt, refs[], est_cost, status draft/approved/queued/running/done/rejected, by, at, outputs?, actual_cost_usd?, log[]}. Only APPROVED requests may be run.',
  inputSchema: { project, status: z.enum(['draft', 'approved', 'queued', 'running', 'done', 'rejected']).optional(), target: z.string().optional() },
}, wrap((a) => op('requests_list', a)));
mcp.registerTool('request_create', {
  title: 'Propose a generation', description: 'Add a DRAFT request to the queue (it costs nothing yet). The director reviews it in Review > Queue and approves it; only then may it run. Give a concrete prompt, the reference files, the tool/model you would use and an honest est_cost in USD (list prices: js/prices.js, CLAUDE.md "Prices"). recipe = the photoreal recipe (templates/photoreal_recipe.json, docs/PHOTOREAL.md): the prompt is built from blocks (references + identity lock, subject + wardrobe, action, place, light, camera, texture, medium, the avoid guard) for the model, est_cost and tool come from the price table when you leave them out; the blocks are stored with the request (recipe.blocks) and stay editable (request_update recipe). Returns the request with warnings[] (also shown on the request card): e.g. a look / variant sheet with from: null when no root (identity) is approved yet, unfilled recipe blocks, words from the avoid list.',
  inputSchema: { project, kind: z.string().describe('regenerate, new-costume, new-variant, generate, choose-take, set-in, edit-timing, swap-costume, section-variant, import…'),
    target: z.string().optional().describe('Item key it is about, e.g. "use:G05@20158", "character:ada".'), prompt: z.string().optional().describe('The prompt (required unless recipe builds it).'), refs: z.array(z.string()).optional(),
    est_cost: z.number().min(0).optional().describe('Estimated USD (required unless recipe: then from js/prices.js).'),
    recipe: z.union([z.literal(true), z.object({ model: z.enum(['nb2', 'seedream5', 'h3max', 'kling3pro', 'klingmc']).optional().describe('nb2 (default) / seedream5 stills; h3max / kling3pro / klingmc video.'), framing: z.enum(['full_body', 'medium', 'close_up']).optional(),
      subject: z.string().optional(), wardrobe: z.string().optional(), action: z.string().optional(), place: z.string().optional(), light: z.string().optional(), camera: z.string().optional(), texture: z.string().optional(), grade: z.string().optional(),
      seconds: z.number().optional(), name: z.string().optional(), identity: z.boolean().optional().describe('Image 1 is the approved face / identity (default: detected from the asset link).'), blocks: z.record(z.string()).optional().describe('Edited block texts by block id (they win over the built ones).') })]).optional()
      .describe('Build the prompt from the photoreal recipe (true = defaults).'), tool: z.string().optional().describe('Provider/model you would use.'), look: z.object({}).passthrough().optional(), by,
    char: z.object({ id: charId, tree: treeId.optional(), from: z.string().nullable().optional().describe('DEPRECATED: use asset {type: "character", ...}. The node the edit starts from (null = the identity sheet from the base).'),
      kind: z.enum(['identity', 'edit', 'look']).optional(), text: z.string().optional(), sketch: z.string().optional().describe('Sketch id (sketch_save) drawn over the node image.'),
      png: z.string().optional(), mask: z.string().optional(), pins: z.array(z.object({ n: z.number().optional(), x: z.number(), y: z.number(), text: z.string() })).optional() }).optional()
      .describe('DEPRECATED (accepted with a warning, stored as asset): use asset {type: "character", id, tree, from, kind}.'),
    asset: z.object({ type: assetType, id: charId, tree: assetTree.optional(), from: z.string().nullable().optional().describe('The node it starts from (null = the root sheet from the base; for a variant: the approved root node).'),
      kind: z.enum(['identity', 'base', 'edit', 'look', 'variant']).optional(), text: z.string().optional(), sketch: z.string().optional(), png: z.string().optional(), mask: z.string().optional(), pins: pinsSchema.optional() }).optional()
      .describe('Stages 4 and 5: the asset tree this generation grows, any type (an identity sheet, a look, a location base plate, a prop sheet, a variant, an edit); asset_iteration_add reads it back. The canonical link (char is deprecated).') },
}, wrap((a) => op('request_create', a)));
mcp.registerTool('request_update', {
  title: 'Advance or edit a request',
  description: 'Move a request through draft -> approved -> queued -> running -> done (or rejected). Rules enforced: draft -> approved is the director decision: by default they approve in the page (Review > Queue; show it with ui_focus view "queue"), and director_approved:true from you counts only when the owner enabled agent_approvals; queued/running need a recorded director approval; queued/running are refused when spent + committed + this est_cost would exceed the cost cap; done needs outputs (paths of the generated files) and actual_cost_usd (what the provider charged): the cost is recorded in costs.json and the outputs are registered as media (thumbnails made). rejected needs why. Editing prompt/refs/est_cost of an approved request sends it back to draft (any other status in the same call is refused).',
  inputSchema: { project, id: z.string(), status: z.enum(['draft', 'approved', 'queued', 'running', 'done', 'rejected']).optional(), prompt: z.string().optional(), refs: z.array(z.string()).optional(),
    est_cost: z.number().min(0).optional(), outputs: z.array(z.string()).optional(), actual_cost_usd: z.number().min(0).optional(), why: z.string().optional(), tool: z.string().optional(),
    director_approved: z.boolean().optional(), register_media: z.boolean().optional(), media_kind: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(),
    recipe: z.object({ blocks: z.record(z.string()).optional() }).passthrough().optional().describe('A request made from the recipe: edited blocks {<block id>: text} and / or fields (subject, wardrobe, action, place, light, camera, texture, grade); the prompt is rebuilt (an edit: an approved request goes back to draft).'), by },
}, wrap((a) => op('request_update', a)));
mcp.registerTool('costs_get', {
  title: 'Costs vs cap', description: 'Spending: one total (total_spent_usd) with per-source rows (sources: the workbench costs.json, plus, when project.json names a "falgen" folder, falgen ledger rows not already in costs.json and the part of its spent.json no ledger row itemises: deduplicated by job id), spent_usd (costs.json only), committed_usd (approved + queued + running estimates), drafts_usd, remaining_usd (cap - total - committed), falgen (the merge details, other ledger rows listed, not added), and the last 10 cost items. Check before proposing or running anything.',
  inputSchema: { project },
}, wrap((a) => op('costs_get', a)));
mcp.registerTool('cost_record', {
  title: 'Record a cost spent outside the queue',
  description: 'Record money already spent outside the request lifecycle (a runner like falgen, work done before a request existed, a provider console) in costs.json, with its provenance: via (falgen, retro, manual, …), job (the runner\'s job id), take, tool, date, note, request (a request it belongs to; not one already done). The same job (+ take) is recorded once. It is NEVER an approval: no request is approved or moved, and a request\'s own cost is recorded by request_update done. Runners can call it from a shell: node <workbench>/mcp/client.mjs cost_record \'{"usd":0.24,"via":"falgen","job":"HV1"}\'.',
  inputSchema: { project, usd: z.number().min(0), via: z.string().regex(/^[a-z0-9_-]{1,32}$/), job: z.string().optional(), take: z.number().int().min(0).optional(), tool: z.string().optional(),
    date: z.string().optional().describe('YYYY-MM-DD (default today).'), request: z.string().optional(), note: z.string().optional(), t: time.optional().describe('Where on the song it belongs (default: the request target, else 0).'), by },
}, wrap((a) => op('cost_record', a)));
