// MCP tools: stage 3: the breakdown (lib/ops/breakdown.mjs).
// Registered on the shared server object when mcp/server.mjs imports this file.
import { z } from 'zod';
import { mcp, op, wrap, project, by } from './_shared.mjs';

// ------------------------------------------------------------------ stage 3: the breakdown (characters, locations, props, wardrobe, FX)
const bdLink = z.union([z.string(), z.object({ scene: z.string().describe('Scene id from script_get / breakdown_get (sc01…).'), beats: z.array(z.string()).optional().describe('Beat ids inside that scene (b1…).'), note: z.string().optional().describe('Why this scene needs it (optional).') })]);
const bdItem = z.object({ id: z.string().optional().describe('Item id (bi01…). Leave out for a new item.'), kind: z.enum(['character', 'location', 'prop', 'wardrobe', 'fx']).optional(), name: z.string().optional(),
  description: z.string().optional().describe('What it is / looks like, in a sentence or two.'), links: z.array(bdLink).optional().describe('The scenes (and beats) that need it: [{scene, beats?, note?}] or scene ids.'),
  aliases: z.array(z.string()).optional(), for: z.string().optional().describe('Wardrobe: the character item id it belongs to.'), dropped: z.boolean().optional().describe('Soft delete (the director can restore it).') }).passthrough();
mcp.registerTool('breakdown_get', {
  title: 'Get the breakdown (stage 3)',
  description: 'The breakdown: the current version\'s items [{id, kind character/location/prop/wardrobe/fx, name, description, links [{scene, beats, note?}], source agent/director, aliases, for (wardrobe -> character item), dropped, status draft/review/ok, entity_id / look_id once the director made it an entity}], counts per kind, the matrix (scenes with the item ids each needs), scenes_without_characters, the existing entities (to match names), notes (default open), asks_for_agent (kind "extract" = draft the breakdown from the script), versions, and with_script (default true) everything to extract from: the current script scenes with text, beats and sketches (PNG path + numbered pins, the director\'s callouts) and the intake answers who / where / era / must / must-not. script_changed says when the script moved on since this version. version = an older version; diff = [a, b] -> word diff + items added / removed / changed; kind / scene filter the items.',
  inputSchema: { project, version: z.string().optional(), diff: z.array(z.string()).length(2).optional(), notes: z.enum(['open', 'resolved', 'all']).optional(),
    kind: z.enum(['character', 'location', 'prop', 'wardrobe', 'fx']).optional(), scene: z.string().optional(), with_script: z.boolean().optional() },
}, wrap((a) => op('breakdown_get', a)));
mcp.registerTool('breakdown_update', {
  title: 'Write the breakdown as a new version',
  description: 'Save a NEW version of the breakdown (versions are never overwritten). One of: items = the full list (replaces the list in the new version); upsert = items to add (no id) or change (id + only the fields to change) plus remove = item ids to drop from the list (prefer dropped:true, which the director can restore); restore = an old version id. Each item: kind (character, location, prop, wardrobe, fx), name, description, links to the scenes and beats that need it ({scene, beats?, note?}; scene ids never get reused), aliases, for (wardrobe: the character item it belongs to). Extract from script_get / breakdown_get script (scene text, beats, sketch pins) and the intake; one item per distinct thing, merge duplicates. New items are marked source "agent". status = {<item id>: "draft" | "review"} ("ok" is the director\'s and refused; "review" asks them to look, e.g. to make it an entity). You cannot create entities from here: the director does it in the page. Give a short message. Returns the version and warnings (unknown scenes or beats, duplicate names, wardrobe without its character).',
  inputSchema: { project, items: z.array(bdItem).optional(), upsert: z.array(bdItem).optional(), remove: z.array(z.string()).optional(), restore: z.string().optional(),
    status: z.record(z.enum(['draft', 'review', 'ok'])).optional(), message: z.string().optional(), by },
}, wrap((a) => op('breakdown_update', a)));
mcp.registerTool('breakdown_note_add', {
  title: 'Note on a breakdown item',
  description: 'Pin a note to a breakdown item (item id from breakdown_get), or a scene (scene id), or neither for the whole breakdown. reply_to = a note id adds your reply to its thread (answer the director\'s notes and asks this way). Notes are marked via "agent"; they never change the breakdown (breakdown_update does).',
  inputSchema: { project, item: z.string().optional(), scene: z.string().optional(), text: z.string(), reply_to: z.string().optional(), by },
}, wrap((a) => op('breakdown_note_add', a)));
mcp.registerTool('breakdown_note_resolve', {
  title: 'Resolve a breakdown note',
  description: 'Mark a breakdown note (or an ask for you, e.g. "extract the breakdown") resolved, with an optional reply saying what you did; reopen:true reopens it. Resolve the director\'s asks only when you did what they asked.',
  inputSchema: { project, id: z.string(), reply: z.string().optional(), reopen: z.boolean().optional(), by },
}, wrap((a) => op('breakdown_note_resolve', a)));
