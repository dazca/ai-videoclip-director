// MCP tools: stage 2: the intake, the script (scenes, beats) and the sketches (lib/ops/scenes.mjs).
// Registered on the shared server object when mcp/server.mjs imports this file.
import { z } from 'zod';
import { mcp, op, wrap, project, time, by } from './_shared.mjs';

// ------------------------------------------------------------------ stage 2: the script draft (intake, scenes, beats, sketches)
const beat = z.object({ id: z.string().optional(), t: time, text: z.string() });
const scene = z.object({ id: z.string().optional().describe('Scene id (sc01…). Leave out for a new scene.'), t0: time.optional(), t1: time.optional(), title: z.string().optional(), text: z.string().optional().describe('What happens: the visual description.'),
  beats: z.array(beat).optional().describe('Timed actions inside the scene (t between t0 and t1).'), sketches: z.array(z.string()).optional().describe('Sketch ids (sketch_list / sketch_save).'),
  anchors: z.object({ t0: z.string().optional(), t1: z.string().optional() }).optional().describe('E1: tie a boundary to a named event (events_get ids): {t0?: "her_hi_there"}; it takes the time of the event and follows it when the director re-times after the take') }).passthrough();
mcp.registerTool('script_get', {
  title: 'Get the script draft (stage 2)',
  description: 'The script: the current version\'s scenes [{id, t0, t1, time, title, text, line_ids, lines (the lyric lines inside, with text and times), beats [{id, t, text}], sketches [{id, png, files (absolute paths you can open), pins}], status draft/needs_you/ok, open_notes}], gaps (unscripted ranges with the lines in them: "fill the gaps" = cover them with scenes), coverage (0-1), intake summary, notes (default open), asks_for_agent (the director\'s asks, incl. kind "fill_gaps" with the gaps), and the versions. version = an older version; diff = [a, b] two version ids -> word diff + which scenes were added / removed / changed. A project without scenes.json reads as v1 derived from the old script.json.',
  inputSchema: { project, version: z.string().optional(), diff: z.array(z.string()).length(2).optional(), notes: z.enum(['open', 'resolved', 'all']).optional() },
}, wrap((a) => op('script_get', a)));
mcp.registerTool('scenes_update', {
  title: 'Write the script as a new version',
  description: 'Save a NEW version of the script (versions are never overwritten). One of: scenes = the full list of scenes (replaces the list in the new version); upsert = scenes to add (no id) or change (id + only the fields to change) plus remove = scene ids to drop; restore = an old version id (copied as a new version). Each scene is bound to song time: t0 < t1 in ms (or "m:ss.mmm"); snap "lines" | "bars" | "sections" | "events" snaps the times you give to the nearest lyric line / downbeat / section bound / named event (events: the boundary is also anchored to it); anchors {t0?, t1?: event id} tie a boundary to a named event (events_get) so a re-time after the take moves it. Beats are timed actions inside the scene; sketches are sketch ids. line_ids are filled from the song. status = {<scene id>: "draft" | "needs_you"} sets scene statuses ("ok" is the director\'s and refused). Give a short message saying what you changed. Returns the version, the remaining gaps and warnings (overlaps, missing sketch files).',
  inputSchema: { project, scenes: z.array(scene).optional(), upsert: z.array(scene).optional(), remove: z.array(z.string()).optional(), restore: z.string().optional(),
    status: z.record(z.enum(['draft', 'needs_you', 'ok'])).optional(), snap: z.enum(['off', 'lines', 'bars', 'sections', 'events']).optional(), message: z.string().optional(), by },
}, wrap((a) => op('scenes_update', a)));
mcp.registerTool('scene_note_add', {
  title: 'Note on a scene',
  description: 'Pin a note to a scene (scene id from script_get), optionally to one of its beats, or with no scene for the whole script. reply_to = a note id adds your reply to its thread (answer the director\'s notes and asks this way). Notes are marked via "agent"; they never change the script (scenes_update does).',
  inputSchema: { project, scene: z.string().optional(), beat: z.string().optional(), text: z.string(), reply_to: z.string().optional(), by },
}, wrap((a) => op('scene_note_add', a)));
mcp.registerTool('scene_note_resolve', {
  title: 'Resolve a scene note',
  description: 'Mark a scene note (or an ask for you, e.g. "fill the gaps") resolved, with an optional reply saying what you did; reopen:true reopens it. Resolve the director\'s asks only when you did what they asked.',
  inputSchema: { project, id: z.string(), reply: z.string().optional(), reopen: z.boolean().optional(), by },
}, wrap((a) => op('scene_note_resolve', a)));
mcp.registerTool('intake_get', {
  title: 'The script intake questions',
  description: 'The intake the script starts from: questions (mood, kind = story / performance / concept, who, where, era / look, references, must-haves, must-nots, budget) with the answers so far {answer, by, via (page = the director typed it), at, asked_in_chat, interpretation (your reading: interpretation_set; its status proposed / accepted / edited by the director)}, which are unanswered, and the cost summary (for the budget question). Ask the unanswered ones in the conversation, or ask the director to fill them in the page.',
  inputSchema: { project },
}, wrap((a) => op('intake_get', a)));
mcp.registerTool('intake_answer', {
  title: 'Record intake answers',
  description: 'Record the director\'s answers to intake questions: key + text, or answers = {<question id>: text} for several. Write only what the director said (by "director" when you relay their words); stamped via "agent". asked_in_chat:true marks the question(s) as asked in this conversation (the page shows it), with or without an answer.',
  inputSchema: { project, key: z.enum(['mood', 'kind', 'who', 'where', 'era', 'refs', 'must', 'mustnot', 'budget']).optional(), text: z.string().optional(), answers: z.record(z.string()).optional(), asked_in_chat: z.boolean().optional(), by },
}, wrap((a) => op('intake_answer', a)));
mcp.registerTool('sketch_get', {
  title: 'Get a sketch (image paths + pins)',
  description: 'A sketch drawn in the sketch tool: the flattened PNG and the mask PNG (relative paths and absolute files you can open to look at them), the numbered text pins [{n, x, y, text}] in image pixels (the director\'s callouts: "necklace, silver, thin"), the underlay, w/h, which scenes use it, and with full:true the whole vector JSON.',
  inputSchema: { project, id: z.string(), full: z.boolean().optional() },
}, wrap((a) => op('sketch_get', a)));
mcp.registerTool('sketch_list', {
  title: 'List sketches',
  description: 'Every sketch of the project (newest first) with its PNG / mask paths, pins and the scenes that use it; scene filters to one scene.',
  inputSchema: { project, scene: z.string().optional() },
}, wrap((a) => op('sketch_list', a)));
mcp.registerTool('sketch_save', {
  title: 'Save a sketch',
  description: 'Write a sketch: id (lower-case letters, digits, _ -), sketch = the vector JSON {w, h, paper, underlay, strokes[], mask[], pins[{n, x, y, text}]} (core/sketch/sketch.js format), png = the flattened image as base64 PNG, mask = the mask as base64 PNG or null. Saved as sketches/<id>.json/.png/.mask.png (under private/sketches/ when drawn over a private underlay) and registered in the media index (kind sketch, links {scenes, entities, shots}). Add it to a scene with scenes_update (sketches: [id]).',
  inputSchema: { project, id: z.string(), sketch: z.object({ w: z.number(), h: z.number() }).passthrough(), png: z.string(), mask: z.string().nullable().optional(),
    links: z.object({ scenes: z.array(z.string()).optional(), entities: z.array(z.string()).optional(), shots: z.array(z.string()).optional() }).optional(), label: z.string().optional(), by },
}, wrap((a) => op('sketch_save', a)));
