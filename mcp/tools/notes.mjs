// MCP tools: notes, ONE model for every stage and the timeline (lib/ops/notes.mjs, js/notes.js; notes.json v2).
// notes_get / notes_add / notes_status are the model's tools; notes_list / note_add / note_resolve are the old timeline
// tools (aliases that write v2). The per-stage note tools (lyrics_note_*, scene_note_*, ...) live with their stage.
// Registered on the shared server object when mcp/server.mjs imports this file.
import { z } from 'zod';
import { mcp, op, wrap, project, time, by } from './_shared.mjs';

const STAGES = ['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'final', 'timeline'];
const target = z.object({
  stage: z.enum(STAGES),
  kind: z.string().describe('per stage: lyrics stage | section | line; script stage | scene | beat; breakdown stage | item | scene; characters / scenery stage | asset | tree | node | use; storyboard stage | scene | shot; final stage | shot; timeline time'),
  id: z.string().nullable().optional().describe('the row: a line id ("verse/2"), a scene ("sc03"), a beat ("sc03/b2"), an item ("bi04"), an asset ("ada"), a node ("ada/n03"), a tree ("ada/look:night-out"), a use ("ada/sc02": the asset in a scene), a shot ("sh07"); none for "stage" and "time"'),
  w: z.array(z.number().int()).length(2).optional().describe('lyrics line: [first, last] word index'),
  quote: z.string().optional().describe('lyrics line: the exact words (instead of w)'),
  t: time.optional().describe('timeline: the song time (required); elsewhere optional'),
  pin: z.object({ x: z.number(), y: z.number() }).optional().describe('a point on the image of an asset / node / shot frame: fractions 0..1'),
  line: z.string().optional().describe('timeline: the lyric line at that time'),
});

// ------------------------------------------------------------------ the one model
mcp.registerTool('notes_get', {
  title: 'Get notes (every stage)',
  description: 'The notes of every stage and the timeline, from one list (notes.json v2): {id, target {stage, kind, id, w?, quote?, t?, pin?}, where (a readable target), t / time (when the target has a song time), text, by, via (page = the director, agent = written through the tools), status open / absorbed / dismissed, round, replies[], to? "agent" + ask? (an ask for you: request, fill_gaps, extract, storyboard), gaps?}. Filters: stage, kind, id (the row), note (one note id), status (default open; "all"), to ("agent": the asks), by. Also `open`: counts per stage. Open notes by the director are your to-do list.',
  inputSchema: { project, stage: z.enum(STAGES).optional(), kind: z.string().optional(), id: z.string().optional(), note: z.string().optional(), status: z.enum(['open', 'absorbed', 'dismissed', 'all']).optional(), to: z.string().optional(), by: z.string().optional() },
}, wrap((a) => op('notes_get', a)));
mcp.registerTool('notes_add', {
  title: 'Add a note (any stage)',
  description: 'Write a note on any row of any stage: target {stage, kind, id, ...} (see notes_get; the row must exist: a lyric line of the current version, a scene / beat of the current script, a breakdown item, an asset / node / tree, a shot; a timeline note needs t). reply_to = a note id adds your reply to its thread instead (answer the director this way). Notes are marked via "agent"; they never change the content (the stage tools do). to "agent" is only for asks the director writes; you rarely need it.',
  inputSchema: { project, target: target.optional(), text: z.string(), reply_to: z.string().optional(), to: z.string().optional(), ask: z.enum(['request', 'fill_gaps', 'extract', 'storyboard']).optional(), by },
}, wrap((a) => op('notes_add', a)));
mcp.registerTool('notes_status', {
  title: 'Absorb / reopen a note',
  description: 'Set a note\'s status: "absorbed" = you did what it asks (give reply = what changed, e.g. "line 7 rewritten in v4"); "open" reopens it; "dismissed" only for your own notes: the director\'s notes are dismissed by the director in the page (403). Never absorb a director\'s note you did not act on: reply instead.',
  inputSchema: { project, id: z.string(), status: z.enum(['absorbed', 'open', 'dismissed']), reply: z.string().optional(), by },
}, wrap((a) => op('notes_status', a)));

// ------------------------------------------------------------------ the timeline (old tools, v2 underneath)
mcp.registerTool('notes_list', {
  title: 'List timeline notes',
  description: 'The timeline\'s notes (pinned to a song time) in the old shape: {id, t, time, line_id, by, via, text, status open / resolved, about?, reply_to?} (replies are listed as their own rows with reply_to). Filter by status, author, time range. notes_get has every stage\'s notes.',
  inputSchema: { project, status: z.enum(['open', 'resolved']).optional(), by: z.string().optional(), t0: time.optional(), t1: time.optional() },
}, wrap((a) => op('notes_list', a)));
mcp.registerTool('note_add', {
  title: 'Add a timeline note',
  description: 'Pin a note at a song time (it attaches to the lyric line there unless line_id is given). Use it to answer the director, flag a problem, or leave a decision on the timeline. about = an item key it refers to (e.g. "shot:c1-desk"). reply_to = a note id: your reply in its thread. (notes_add writes on any stage.)',
  inputSchema: { project, t: time.optional(), text: z.string(), line_id: z.string().optional(), about: z.string().optional(), reply_to: z.string().optional(), by },
}, wrap((a) => op('note_add', a)));
mcp.registerTool('note_resolve', {
  title: 'Resolve a timeline note',
  description: 'Mark a note resolved (= absorbed: you did what it asked; reopen:true reopens it). reply adds your answer to its thread. Resolve a director note only when you did what it asked.',
  inputSchema: { project, id: z.string(), reply: z.string().optional(), reopen: z.boolean().optional(), by },
}, wrap((a) => op('note_resolve', a)));
