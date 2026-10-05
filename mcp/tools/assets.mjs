// MCP tools: entities and stages 4-5: the character tools and the generic asset tools (lib/ops/assets.mjs).
// Registered on the shared server object when mcp/server.mjs imports this file.
import { z } from 'zod';
import { mcp, op, wrap, project, by, charId, treeId, assetType, assetTree } from './_shared.mjs';

// ------------------------------------------------------------------ entities
mcp.registerTool('entities_list', {
  title: 'List characters, locations, props', description: 'Entities with id, kind, name, status, role/description, thumbnail, face, look ids and image count. kind filters.',
  inputSchema: { project, kind: z.enum(['character', 'location', 'prop']).optional() },
}, wrap((a) => op('entities_list', a)));
mcp.registerTool('entity_get', {
  title: 'Get an entity', description: 'The full entity file (characters: face, body, sheets, looks[{id, name, garments, colors, images, clips, used, status, cost_usd}], motion, lives; locations: establishing, images[{path, angle, tod}], letter; props: hero, images, variants) plus the shots it appears in and its approval state.',
  inputSchema: { project, id: z.string() },
}, wrap((a) => op('entity_get', a)));
mcp.registerTool('entity_upsert', {
  title: 'Create or update an entity (and its looks)',
  description: 'Create or merge-update a character, location or prop. fields are merged into the entity JSON (e.g. {role, description, face, body, refs[], images[], establishing, hero, short (cast-chip letters), color, letter (locations), constants[] (a character: the details that must stay identical in every image, strings or {text, check (default true: on the identity checklist of check_add), label (a short name for the badge, "clip side")}, e.g. "a silver ring on the LEFT ring finger"; the photoreal recipe puts them into the identity lock; the director edits them in the Characters stage)}); image paths are relative to the project folder or under a configured media root. look upserts one entry of a character\'s looks[] by look.id ({id, name, garments[], colors[], images[], notes, status}). thumb_src makes the card thumbnail from an image/video.',
  inputSchema: { project, kind: z.enum(['character', 'location', 'prop']), id: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/), name: z.string().optional(),
    fields: z.record(z.any()).optional(), look: z.object({ id: z.string() }).passthrough().optional(), thumb_src: z.string().optional() },
}, wrap((a) => op('entity_upsert', a)));

// ------------------------------------------------------------------ stage 4: characters (identity + looks as iteration trees)

mcp.registerTool('character_get', {
  title: 'Get a character workspace (stage 4)',
  description: 'asset_get with type "character" (the same code; locations and props: asset_get). Without id: every character entity with its stage-4 status (base / iterating / identity approved / looks), the scenes it appears in (from the breakdown), open requests and nodes waiting for the director, plus the breakdown characters not yet entities (the director makes them in the page). With id: the base the director chose (text + refs: catalogue, Openverse with licence / creator / URL, private photos, sketches; each with its absolute `file`), the iteration trees ("identity" and one "look:<id>" per look): nodes {id, parent, image, file, request, kind, edit {text, sketch, png, mask, pins}, choice, private}, branches (horizontal strips), head and approved node; the looks; every request of this character with its status, refs (ref_files absolute), the edit text, the numbered pins and the sketch PNG / mask paths (absolute files) to send to the image model; to_run (approved, yours to run), to_register (done, waiting for character_iteration_add), waiting_for_director (nodes to keep / branch / revert), notes and asks_for_agent.',
  inputSchema: { project, id: charId.optional(), notes: z.enum(['open', 'resolved', 'all']).optional() },
}, wrap((a) => op('character_get', a)));
mcp.registerTool('character_iteration_add', {
  title: 'Register a generated image as a new node',
  description: 'After you ran an APPROVED request of this character (request_update queued -> running -> done with outputs and actual_cost_usd), register its output as a node of the tree the request names (char.tree, parent char.from). image = one of the request\'s outputs (default the first). The first node of a tree becomes its head; any later one waits for the director, who compares it with its parent and keeps, branches or reverts it in the page. Refused: a request that is not this character\'s, not approved by the director, not done; a locked (approved) tree; a look before the identity is approved. A node made from a private photo is private (its image is copied under private/). You never approve or choose.',
  inputSchema: { project, id: charId, request: z.string(), image: z.string().optional(), note: z.string().optional().describe('What you did (model, seed, anything the director should know).'), by },
}, wrap((a) => op('character_iteration_add', a)));
mcp.registerTool('character_note_add', {
  title: 'Note on a character',
  description: 'Pin a note to a character, one of its trees ("identity", "look:<id>") or a node (node id). reply_to = a note id adds your reply to its thread (answer the director\'s asks this way); resolve:true with reply_to closes it once you did what they asked. Notes are marked via "agent" and change nothing else. To ask the director to approve the identity or a look, say so in a note and show it with ui_focus view "stage".',
  inputSchema: { project, id: charId, text: z.string().optional(), tree: treeId.optional(), node: z.string().optional(), reply_to: z.string().optional(), resolve: z.boolean().optional(), by },
}, wrap((a) => op('character_note_add', a)));
mcp.registerTool('look_create', {
  title: 'Propose a look (costume) for a character',
  description: 'Add a look to a character\'s looks[] with status "review" (only the director approves looks, in the page). name, garments, colors, description; from_item = the breakdown wardrobe item it comes from. Its tree "look:<id>" starts from the approved identity: then propose the look sheet with request_create (kind "look-sheet", char {id, tree: "look:<id>", from: <approved identity node>, kind: "look"}, refs = the identity image + garment refs).',
  inputSchema: { project, id: charId, name: z.string(), look_id: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/).optional(), garments: z.array(z.string()).optional(), colors: z.array(z.string()).optional(),
    description: z.string().optional(), from_item: z.string().optional(), world: z.string().optional().describe('E6: the world this look is for ("on screen", "off screen", "dancing"): shots in that world then wear it.'), by },
}, wrap((a) => op('look_create', a)));
mcp.registerTool('look_world_propose', {
  title: 'Propose the world a look is for (E6)',
  description: 'LOOKS_PLAN as data: one look per world (on the screen / out of the screen / dancing) for each character. A look\'s world (`context`) decides which shots wear it: a shot in world W (its own context, else its scene\'s) dresses each cast character in their look tagged W, unless the shot overrides it. The world of an existing look is the director\'s: this writes a PROPOSAL on the look (world_proposal {world, why}) they accept or dismiss in the page (Characters stage, the look). world null proposes "no world". A new look gets its world directly with look_create world. Set a scene\'s world with scenes_update (context) and a shot\'s with shots_update (context); mismatches show in gaps_get (looks) and Final\'s checklist (looks).',
  inputSchema: { project, id: charId, look: z.string(), world: z.string().nullable(), why: z.string().optional(), by },
}, wrap((a) => op('look_world_propose', a)));

// ------------------------------------------------------------------ stages 4 and 5: every asset (characters, locations, props) on one code path

mcp.registerTool('asset_get', {
  title: 'Get an asset workspace (characters, locations, props: stages 4 and 5)',
  description: 'Without id: every asset of the type (all three types when type is left out) with its status (base / iterating / approved (identity for a character) / variants (looks)), the scenes it appears in (from the breakdown), open requests and nodes waiting for the director, plus the breakdown items of those kinds not yet entities. With id (type optional): the base the director chose (text + refs: catalogue, Openverse with licence / creator / URL, private photos, sketches; each with its absolute `file`), root_tree and root_approved, the variants (looks[] for a character: garments, colors; variants[] for a location / prop: axes {angle, tod, weather} or {angle, state}, the scenes you proposed it for), the iteration trees (the root and one per variant): nodes {id, parent, from_identity, image, file, request, kind, edit {text, sketch, png, mask, pins}, choice, private}, branches (horizontal strips), head, approved; scenes = every scene that uses it [{scene, t0, t1, title, variant (null = the root), variant_name, source director / agent / default, image}] (what the storyboard reads); the requests with status, refs (ref_files absolute), the edit text, pins and sketch PNG / mask files; to_run (approved, yours to run), to_register (done, waiting for asset_iteration_add), waiting_for_director, notes and asks_for_agent.',
  inputSchema: { project, type: assetType.optional(), id: charId.optional().describe('Entity id (asset_get without id lists them).'), notes: z.enum(['open', 'resolved', 'all']).optional() },
}, wrap((a) => op('asset_get', a)));
mcp.registerTool('asset_iteration_add', {
  title: 'Register a generated image as a new node (any asset)',
  description: 'After you ran an APPROVED request of this asset (request_update queued -> running -> done with outputs and actual_cost_usd), register its output as a node of the tree the request names (asset.tree, parent asset.from; a character\'s char link works too). image = one of the request\'s outputs (default the first). The first node of a tree becomes its head; any later one waits for the director, who compares it with its parent and keeps, branches or reverts it in the page. Refused: a request that is not this asset\'s, not approved by the director, not done; a locked (approved) tree; a variant before the root is approved. A node made from a private photo is private (its image is copied under private/). You never approve or choose. type defaults to the request\'s.',
  inputSchema: { project, type: assetType.optional(), id: charId, request: z.string(), image: z.string().optional(), note: z.string().optional().describe('What you did (model, seed, anything the director should know).'), by },
}, wrap((a) => op('asset_iteration_add', a)));
mcp.registerTool('asset_note_add', {
  title: 'Note on an asset (character, location, prop)',
  description: 'Pin a note to an asset, one of its trees, a node (node id) or its use in a scene (scene id). reply_to = a note id adds your reply to its thread (answer the director\'s asks this way); resolve:true with reply_to closes it once you did what they asked. Notes are marked via "agent" and change nothing else. To ask the director to approve the base / identity or a variant, or to pick the variant a scene uses, say so in a note and show it with ui_focus view "stage".',
  inputSchema: { project, type: assetType, id: charId, text: z.string().optional(), tree: assetTree.optional(), node: z.string().optional(), scene: z.string().optional(), reply_to: z.string().optional(), resolve: z.boolean().optional(), by },
}, wrap((a) => op('asset_note_add', a)));
mcp.registerTool('variant_create', {
  title: 'Propose a variant (location / prop) or a look (character)',
  description: 'Add a variant with status "review" (only the director approves variants, in the page). A location: axes {angle: wide / medium / reverse / a custom word, tod: dawn / day / dusk / night, weather: clear / overcast / rain / fog / snow / a custom word}; a prop: axes {angle, state: broken / lit / wet / open / a custom word}; name defaults to the axes ("reverse · night · rain"), variant_id to them ("reverse-night-rain"); description = notes for the prompt; scenes = the scene ids you propose it for (the scene picker shows them as the agent\'s proposal; the director\'s pick wins). A character: this is look_create (name, garments, colors). Its tree "variant:<id>" ("look:<id>") starts from the approved root: then propose its sheet with request_create (asset {type, id, tree: "variant:<id>", from: <approved base node>, kind: "variant"}, refs = the base image first).',
  inputSchema: { project, type: assetType, id: charId, name: z.string().optional(), axes: z.object({ angle: z.string().optional(), tod: z.string().optional(), weather: z.string().optional(), state: z.string().optional() }).optional(),
    variant_id: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/).optional(), description: z.string().optional(), scenes: z.array(z.string()).optional(), from_item: z.string().optional(),
    garments: z.array(z.string()).optional(), colors: z.array(z.string()).optional(), by },
}, wrap((a) => op('variant_create', a)));
const refItem = z.union([z.string(), z.object({ path: z.string(), source: z.enum(['catalog', 'openverse', 'photo', 'sketch', 'media']).optional(), title: z.string().optional() }).passthrough()]);
mcp.registerTool('base_propose', {
  title: 'Propose a base (what the first sheet starts from)',
  description: 'The base of a character / location / prop (the description and the reference images its identity sheet / base plate starts from) is the director\'s. This writes a PROPOSAL they accept in one click in the page (Characters / Scenery stage, the identity / base tab: "Accept base"; it then becomes the base) or dismiss. text = the description (e.g. the identity text); refs = files already in the project or under a media root (media_list paths), catalog/... paths, or {path, source: catalog | openverse | photo | sketch | media}; a photo must already be private. One proposal per asset (a new one replaces it). You never set the base yourself. Show it with ui_focus view "stage".',
  inputSchema: { project, type: assetType.optional().describe('Default: the entity\'s kind.'), id: charId, text: z.string().optional(), refs: z.array(refItem).optional(), why: z.string().optional().describe('Why this base (shown to the director).'), by },
}, wrap((a) => op('base_propose', a)));
mcp.registerTool('node_import_propose', {
  title: 'Propose an existing image as a tree node',
  description: 'For an image that already exists and is registered (media_list / media_add): a legacy approved look, an output generated outside the queue (falgen, before a request existed). Proposes it as a node of a tree (tree "identity" / "base" = the root, e.g. the identity head; "look:<id>" / "variant:<id>"); the director accepts it in the page (the node is made with origin "imported" and its provenance: media, job, request, cost row) or dismisses it. No request, nothing is spent or approved. A look / variant tree can be accepted only once the root is approved (propose the root import first). The spend of such outputs is recorded separately with cost_record (via, job), never as an approval. why = what the image is and where it came from.',
  inputSchema: { project, type: assetType.optional(), id: charId, tree: assetTree.optional().describe('Default: the root tree.'), media: z.string().describe('A media id or path (media_list).'), why: z.string(), by },
}, wrap((a) => op('node_import_propose', a)));
