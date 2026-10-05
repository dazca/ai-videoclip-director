// MCP tools: review rounds and revisions (lib/ops/rounds.mjs, js/revisions.js; docs/SPEC_v4_NOTES_ROUNDS.md §2).
// The director sends a round and closes / restores revisions in the page only: there is no tool for round_send,
// revision_close or revision_restore. An agent reads the round, applies its notes, absorbs or replies, and finishes.
import { z } from 'zod';
import { mcp, op, wrap, project, by } from './_shared.mjs';

const STAGES = ['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'final', 'timeline'];

mcp.registerTool('round_get', {
  title: 'Get the review round',
  description: 'The review round the director sent you ("Send round to Claude" in the page): {round, status sent | finished, sent_at, ask (the one note to you that lists it), becomes (the revision it will be, e.g. "R3"), progress {total, absorbed, replied, dismissed, left}, stages: {<stage>: [{id, where, target, text, by, status, time?, replies, change?, content}]}}. `content` is what the note points at, inlined: the lyric line and its version, the scene (time, title, text, beats), the breakdown item, the asset / node (image file), the shot (time, kind, text, camera), the lyric at a timeline time. When no round was sent: status "collecting" (nothing to do yet). Work the notes with the stage tools (each save is a new version), then round_absorb / round_reply each note and round_finish.',
  inputSchema: { project, stage: z.enum(STAGES).optional().describe('only this stage\'s notes') },
}, wrap((a) => op('round_get', a)));
mcp.registerTool('round_absorb', {
  title: 'Absorb a round note',
  description: 'You did what a note of the round asks: it becomes absorbed (with your summary as its reply) and is linked to the change, so the compare view shows which note caused which change. change {stage (where you changed it), file? (e.g. "lyrics.json", "scenes.json", "entities/characters/ada.json"), version? (the version you saved, e.g. "v4"), summary ("line 7 rewritten", "scene sc04 split in two")}. Only for a note of the round in flight (round_get); never absorb a note you did not act on: round_reply instead.',
  inputSchema: { project, note: z.string().describe('the note id (round_get)'), change: z.object({ stage: z.enum(STAGES), file: z.string().optional(), version: z.string().optional(), summary: z.string() }), by },
}, wrap((a) => op('round_absorb', a)));
mcp.registerTool('round_reply', {
  title: 'Reply to a round note',
  description: 'For a note of the round you could not (or should not) apply: your reply goes into its thread and the note stays open for the director (it counts as "replied" in the round\'s progress). Say why and what you need.',
  inputSchema: { project, note: z.string(), text: z.string(), by },
}, wrap((a) => op('round_reply', a)));
mcp.registerTool('round_finish', {
  title: 'Finish the review round',
  description: 'Say you are done with the round: summary = what you changed and what is left (it answers the round\'s ask). The director then reviews and closes the revision in the page. This never approves, closes or spends anything; call it once, after every note is absorbed or replied.',
  inputSchema: { project, summary: z.string(), by },
}, wrap((a) => op('round_finish', a)));
mcp.registerTool('revisions_get', {
  title: 'Revisions and compare',
  description: 'The project\'s revisions R1, R2, … (each an immutable project-wide snapshot the director closed after a round: {id, round, created, summary, notes_absorbed, notes_replied, files_changed, cost_usd, cost_delta, snapshot, git?}), the round in flight with its progress, and the round being collected. compare: [a, b] ("R<n>", "R0" = before the first round, "now" = the files now) returns per stage what changed: lyric lines (+ - ~ with word runs), scenes and shots added / removed / moved / changed on the time line, breakdown items, asset tree heads (image A / B), the cost delta, and the notes absorbed in between, each change linked to its notes. Read only; restoring a revision is the director\'s (in the page).',
  inputSchema: { project, compare: z.array(z.string()).length(2).optional() },
}, wrap((a) => op('revisions_get', a)));
