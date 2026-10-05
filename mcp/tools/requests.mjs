// MCP tools: approvals, the generation queue and costs (lib/ops/requests.mjs).
// Registered on the shared server object when mcp/server.mjs imports this file.
import { z } from 'zod';
import { mcp, op, warn, wrap, project, time, by, directorApproved, charId, treeId, assetType, assetTree, pinsSchema } from './_shared.mjs';

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
  title: 'List generation requests', description: 'The generation queue: {id, kind, target, prompt, refs[], est_cost, status draft/approved/queued/running/done/failed/rejected/withdrawn, by, at, outputs?, actual_cost_usd?, superseded_by?, log[]}. Only APPROVED requests may be run. rejected = the director said no; withdrawn = its author took the draft back (obsolete or superseded).',
  inputSchema: { project, status: z.enum(['draft', 'approved', 'queued', 'running', 'done', 'failed', 'rejected', 'withdrawn']).optional(), target: z.string().optional() },
}, wrap((a) => op('requests_list', a)));
mcp.registerTool('request_create', {
  title: 'Propose a generation', description: 'Add a DRAFT request to the queue (it costs nothing yet). The director reviews it in Review > Queue and approves it; only then may it run. Give a concrete prompt, the reference files, the tool/model you would use and an honest est_cost in USD (list prices: js/prices.js, CLAUDE.md "Prices"). recipe = the photoreal recipe (templates/photoreal_recipe.json, docs/PHOTOREAL.md): the prompt is built from blocks (references + identity lock, subject + wardrobe, action, place, light, camera, texture, medium, the avoid guard) for the model, est_cost and tool come from the price table when you leave them out; the blocks are stored with the request (recipe.blocks) and stay editable (request_update recipe). Returns the request with warnings[] (also shown on the request card): e.g. a look / variant sheet with from: null when no root (identity) is approved yet, unfilled recipe blocks, words from the avoid list.',
  inputSchema: { project, kind: z.string().describe('regenerate, new-costume, new-variant, generate, choose-take, set-in, edit-timing, swap-costume, section-variant, import…'),
    target: z.string().optional().describe('Item key it is about, e.g. "use:G05@20158", "character:ada".'), prompt: z.string().optional().describe('The prompt (required unless recipe builds it).'), refs: z.array(z.string()).optional(),
    est_cost: z.number().min(0).optional().describe('Estimated USD for ALL takes (required unless recipe: then from js/prices.js x takes).'),
    takes: z.number().int().min(1).max(8).optional().describe('How many images (candidates) to make (default 1); the runner writes gen/<request>/<id>_<take>.png.'),
    recipe: z.union([z.literal(true), z.object({ model: z.enum(['nb2', 'seedream5', 'h3max', 'kling3pro', 'klingmc']).optional().describe('nb2 (default) / seedream5 stills; h3max / kling3pro / klingmc video.'), framing: z.enum(['full_body', 'medium', 'close_up']).optional(),
      subject: z.string().optional(), wardrobe: z.string().optional(), action: z.string().optional(), place: z.string().optional(), light: z.string().optional(), camera: z.string().optional(), texture: z.string().optional(), grade: z.string().optional(),
      seconds: z.number().optional(), takes: z.number().int().min(1).max(8).optional().describe('How many images: the estimate covers all of them (same as the top-level takes).'), name: z.string().optional().describe('Default: the linked entity name.'), identity: z.boolean().optional().describe('Image 1 is the approved face / identity: adds the identity lock (default: detected from the asset link: refs[0] is the approved identity image or the from node). Without it a character request warns.'),
      constants: z.array(z.string()).optional().describe('The details that must stay identical (default: the linked entity constants[]): they go into the identity lock.'), blocks: z.record(z.string()).optional().describe('Edited block texts by block id (they win over the built ones; one that was not built, e.g. identity_lock without identity, is added with a warning). Ids: refs, identity_lock, constants, subject_wardrobe, action, location, light, camera, texture, medium, avoid (video: motion, camera, ambient, medium).') })]).optional()
      .describe('Build the prompt from the photoreal recipe (true = defaults). Character-agnostic: who it is comes from the linked entity (name, constants). Fields fill their block and keep the fixed sentences of the recipe (Location: / Light: + the shared-light sentence / the skin sentence of texture); only blocks replace a whole block text.'), tool: z.string().optional().describe('Provider/model you would use.'), look: z.object({}).passthrough().optional(), by,
    char: z.object({ id: charId, tree: treeId.optional(), from: z.string().nullable().optional().describe('DEPRECATED: use asset {type: "character", ...}. The node the edit starts from (null = the identity sheet from the base).'),
      kind: z.enum(['identity', 'edit', 'look']).optional(), text: z.string().optional(), sketch: z.string().optional().describe('Sketch id (sketch_save) drawn over the node image.'),
      png: z.string().optional(), mask: z.string().optional(), pins: z.array(z.object({ n: z.number().optional(), x: z.number(), y: z.number(), text: z.string() })).optional() }).optional()
      .describe('DEPRECATED (accepted with a warning, stored as asset): use asset {type: "character", id, tree, from, kind}.'),
    video: z.object({ model: z.enum(['h3max', 'kling3pro', 'klingmc']).optional().describe('h3max (default: MiniMax H3 Max i2v), kling3pro (Kling v3 Pro i2v, end frame, negative prompt), klingmc (Kling v3 Motion Control: a reference video drives the motion).'),
      start: z.string().optional().describe('The start frame: an APPROVED still (a node image or a registered image path).'), end: z.string().optional().describe('Optional end frame (h3max / kling3pro): make it by editing the start frame (same light, lens, place, wardrobe; only pose / expression / camera change).'),
      ref_video: z.string().optional().describe('klingmc: the reference video (a registered clip, 3-30 s, one person, one continuous shot, no camera move).'), seconds: z.number().int().optional().describe('Output length: h3max 5-10, kling3pro 3-15 (5-6 s default, PHOTOREAL), klingmc 3-30 (as long as the reference clip).'),
      orientation: z.enum(['video', 'image']).optional().describe('klingmc character_orientation (video: up to 30 s; image: up to 10 s).') }).optional()
      .describe('A VIDEO request (D3b): the frames / reference video and the seconds. refs become [start, end?, ref_video?] (what the runner uploads to fal storage), tool the model endpoint, est_cost $/s x seconds x takes from js/prices.js (the H3 promo price until 2026-10-15). The prompt is MOTION ONLY (what moves, one camera move; recipe {model, action, camera} builds it). With target "shot:<id>" the outputs are that shot\'s takes.'),
    asset: z.object({ type: assetType, id: charId, tree: assetTree.optional(), from: z.string().nullable().optional().describe('The node it starts from (null = the root sheet from the base; for a variant: the approved root node).'),
      kind: z.enum(['identity', 'base', 'edit', 'look', 'variant']).optional(), text: z.string().optional(), sketch: z.string().optional(), png: z.string().optional(), mask: z.string().optional(), pins: pinsSchema.optional() }).optional()
      .describe('Stages 4 and 5: the asset tree this generation grows, any type (an identity sheet, a look, a location base plate, a prop sheet, a variant, an edit); asset_iteration_add reads it back. The canonical link (char is deprecated).') },
}, wrap((a) => op('request_create', a)));
mcp.registerTool('request_update', {
  title: 'Advance or edit a request',
  description: 'Move a request through draft -> approved -> queued -> running -> done (or failed / rejected). To RUN approved requests, use request_run (the workbench runner does all of this for you); request_update is for runs made outside it. Rules enforced: draft -> approved is the director decision: by default they approve in the page (Review > Queue; show it with ui_focus view "queue"), and director_approved:true from you counts only when the owner enabled agent_approvals; queued/running need a recorded director approval; queued/running are refused when spent + committed + this est_cost would exceed the cost cap; done needs outputs (paths of the generated files) and actual_cost_usd (what the provider charged): the cost is recorded in costs.json and the outputs are registered as media (thumbnails made). rejected needs why. withdrawn: take back YOUR OWN obsolete draft (not one the director wrote; the director saying no is rejected), with why and superseded_by [what replaces it: request ids, proposals ip02, nodes]; back to draft re-opens it. Editing prompt/refs/est_cost of an approved request sends it back to draft (any other status in the same call is refused).',
  inputSchema: { project, id: z.string(), status: z.enum(['draft', 'approved', 'queued', 'running', 'done', 'failed', 'rejected', 'withdrawn']).optional(), prompt: z.string().optional(), refs: z.array(z.string()).optional(),
    est_cost: z.number().min(0).optional(), outputs: z.array(z.string()).optional(), actual_cost_usd: z.number().min(0).optional(), why: z.string().optional(), tool: z.string().optional(),
    director_approved: z.boolean().optional(), register_media: z.boolean().optional(), media_kind: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(),
    recipe: z.object({ blocks: z.record(z.string()).optional(), identity: z.boolean().optional().describe('Image 1 is the approved identity now (adds / removes the identity lock; default: detected again when refs change, else kept).'), takes: z.number().int().min(1).max(8).optional().describe('How many images; est_cost follows unless you give it.') }).passthrough().optional().describe('A request made from the recipe: edited blocks {<block id>: text} and / or fields (subject, wardrobe, action, place, light, camera, texture, grade), identity, takes; the prompt is rebuilt (an edit: an approved request goes back to draft). Blocks you edited keep their text; the others are rebuilt.'),
    superseded_by: z.array(z.string()).optional().describe('With status withdrawn: what replaces it (request ids, proposals like ip02, nodes).'),
    video: z.object({ model: z.enum(['h3max', 'kling3pro', 'klingmc']).optional(), start: z.string().optional(), end: z.string().nullable().optional(), ref_video: z.string().nullable().optional(), seconds: z.number().int().optional(), orientation: z.enum(['video', 'image']).optional() }).optional()
      .describe('A video request: change its frames / reference video / seconds (merged; end: null removes the end frame). refs and est_cost follow; an approved request goes back to draft.'), by },
}, wrap((a) => op('request_update', a)));
mcp.registerTool('costs_get', {
  title: 'Costs vs cap', description: 'Spending: one total (total_spent_usd) with per-source rows (sources: the workbench costs.json, plus, when project.json names a "falgen" folder, falgen ledger rows not already in costs.json and the part of its spent.json no ledger row itemises: deduplicated by job id), spent_usd (costs.json only), committed_usd (approved + queued + running estimates), drafts_usd, remaining_usd (cap - total - committed), falgen (the merge details, other ledger rows listed, not added), and the last 10 cost items. falgen.linked false = no falgen folder is linked (Settings > costs > falgen folder, or project.json "falgen"): a warning names any falgen gen/spent.json found near the project, whose spend is then NOT in the total. Check before proposing or running anything.',
  inputSchema: { project },
}, wrap(async (a) => { const r = await op('costs_get', a); for (const w of r.warnings || []) warn(w); return r; }));
mcp.registerTool('cost_record', {
  title: 'Record a cost spent outside the queue',
  description: 'Record money already spent outside the request lifecycle (a runner like falgen, work done before a request existed, a provider console) in costs.json, with its provenance: via (falgen, retro, manual, …), job (the runner\'s job id), take, tool, date, note, request (a request it belongs to; not one already done). The same job (+ take) is recorded once. It is NEVER an approval: no request is approved or moved, and a request\'s own cost is recorded by request_update done. Runners can call it from a shell: node <workbench>/mcp/client.mjs cost_record \'{"usd":0.24,"via":"falgen","job":"HV1"}\'.',
  inputSchema: { project, usd: z.number().min(0), via: z.string().regex(/^[a-z0-9_-]{1,32}$/), job: z.string().optional(), take: z.number().int().min(0).optional(),
    takes: z.number().int().min(1).max(64).optional().describe('How many takes (images) the job made, when usd is the whole job: a node imported from one take then shows its share (usd / takes), not the job total.'), tool: z.string().optional(),
    date: z.string().optional().describe('YYYY-MM-DD (default today).'), request: z.string().optional(), note: z.string().optional(), t: time.optional().describe('Where on the song it belongs (default: the request target, else 0).'), by },
}, wrap((a) => op('cost_record', a)));

// ------------------------------------------------------------------ the runner (lib/run.mjs, generators/)
mcp.registerTool('request_run', {
  title: 'Run approved generation requests',
  description: 'Run APPROVED requests through the workbench runner (the same one as the Run buttons of the page and tools/run.mjs): the generator chosen in Settings > Generator for the kind of the request (fal by default: Nano Banana 2 / Seedream images; video: H3 Max / Kling v3 image-to-video from a start frame (+ end frame), Kling Motion Control from a reference video, priced per second; "openwith" exports a prompt pack instead). Only requests the director approved run (a draft, rejected or done one is refused with why; you cannot approve); the cap is re-checked when each one is claimed; each goes queued -> running -> done (outputs in gen/<request>/ registered as media, linked to its asset tree as nodes the director keeps or picks, the actual cost recorded once in costs.json) or failed (why; run it again to retry: existing outputs are skipped and a submitted job is polled, not paid twice). A DONE request with a failed take (takes_failed): retake: true runs only those takes again (within the approved est_cost; each take\'s cost recorded once). The cap is checked again before every take. Up to 2 images at once; video 1 at a time (video_parallel). Batches (waves, D4: batches_get): a request in a batch runs only when its batch is approved and unlocked; a history request (imported from a job book) never runs. ALWAYS call it first with dry_run: true and tell the director the plan and the total; dry_run spends nothing and changes nothing. Without wait it returns at once (started / refused): then wait_for {request, until: ["done", "failed"]}. When the workbench server is not running (offline), pass wait: true or use node tools/run.mjs. The fal key comes from the environment (FAL_KEY) or workbench.config.json fal_key_file; you never see it.',
  inputSchema: { project, ids: z.array(z.string()).optional().describe('The approved request ids to run.'), all: z.boolean().optional().describe('Every approved request (instead of ids), batch by batch.'),
    batch: z.string().optional().describe('A batch (wave) id from batches_get: run its approved requests within its cap (max_usd). A batch runs only once the director approved it as a whole and it is unlocked (the batch before it reviewed): a locked batch never runs.'),
    dry_run: z.boolean().optional().describe('Plan only: generator, model, endpoint, takes, estimate, cap, existing outputs, refusals; nothing is called, written or spent.'),
    wait: z.boolean().optional().describe('Return when the runs finish (default: return at once and let them run).'), parallel: z.number().int().min(1).max(4).optional().describe('At most this many image requests at once (default 2).'),
    video_parallel: z.number().int().min(1).max(4).optional().describe('At most this many video requests at once (default 1).'),
    retake: z.boolean().optional().describe('Run the FAILED takes of done requests again (their done takes are kept, not paid again).'),
    max_usd: z.number().min(0).optional().describe('A cap for this batch: requests are taken in order until their estimates would pass it; the rest are refused (run them later).'), by },
}, wrap(async (a, extra) => {
  // wait: the runs go on in the server (or this process, offline); poll the queue until each one has finished
  const since = new Date(Date.now() - 1000).toISOString().slice(0, 19);
  const { wait, ...rest } = a, r = await op('request_run', rest);
  if (!wait || rest.dry_run || !r.started?.length) return r;
  const ids = r.started.map(x => x.id), t0 = Date.now();
  for (;;) {
    const items = (await op('requests_list', { project: a.project })).filter(x => ids.includes(x.id));
    // still approved = not claimed yet, unless its run was refused since (the cap, the approval: last_run)
    const busy = items.filter(x => x.retaking || x.status === 'queued' || (x.status === 'running' && !x.handoff) || (x.status === 'approved' && !(x.last_run && x.last_run.at >= since)));
    if (!busy.length || Date.now() - t0 > 30 * 60 * 1000) return { ...r, finished: !busy.length, results: items.map(({ id, status, outputs, actual_cost_usd, why, handoff, linked, last_run, takes_failed }) => ({ id, status: status === 'approved' && last_run?.at >= since ? last_run.status : status, outputs, actual_cost_usd, why: status === 'approved' ? last_run?.why : why, handoff, linked, ...(takes_failed ? { takes_failed } : {}) })), costs: await op('costs_get', { project: a.project }) };
    const token = extra?._meta?.progressToken;   // progress keeps a client that resets its timeout on progress waiting
    if (token !== undefined) extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((Date.now() - t0) / 1000), message: `running ${busy.map(x => x.id).join(', ')}` } }).catch(() => {});
    await new Promise(ok => setTimeout(ok, 1500));
  }
}));
mcp.registerTool('generators_get', {
  title: 'Generators (Settings > Generator)',
  description: 'The generator plugins (fal, openwith = "Open in another app", comfyui = not configured yet), which one runs each kind (image / video / motion; the director picks it in Settings > Generator), whether each is ready, and whether a fal key was found (and where: env or key file; never the key itself).',
  inputSchema: { project },
}, wrap((a) => op('generators_get', a)));
