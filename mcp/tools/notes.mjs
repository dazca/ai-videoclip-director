// MCP tools: notes pinned to song time (lib/ops/notes.mjs).
// Registered on the shared server object when mcp/server.mjs imports this file.
import { z } from 'zod';
import { mcp, op, wrap, project, time, by } from './_shared.mjs';

// ------------------------------------------------------------------ notes
mcp.registerTool('notes_list', {
  title: 'List notes', description: 'Notes pinned to song time: {id, t, time, line_id, by (director/agent/…), text, status open/resolved, about?, reply_to?}. Filter by status, author, time range. Open director notes are your to-do list.',
  inputSchema: { project, status: z.enum(['open', 'resolved']).optional(), by: z.string().optional(), t0: time.optional(), t1: time.optional() },
}, wrap((a) => op('notes_list', a)));
mcp.registerTool('note_add', {
  title: 'Add a note', description: 'Pin a note at a song time (it attaches to the lyric line there unless line_id is given). Use it to answer the director, flag a problem, or leave a decision on the timeline. about = an item key it refers to (e.g. "shot:c1-desk").',
  inputSchema: { project, t: time, text: z.string(), line_id: z.string().optional(), about: z.string().optional(), by },
}, wrap((a) => op('note_add', a)));
mcp.registerTool('note_resolve', {
  title: 'Resolve a note', description: 'Mark a note resolved (reopen:true reopens it). reply adds your answer as a new note at the same time, linked by reply_to. Resolve a director note only when you did what it asked.',
  inputSchema: { project, id: z.string(), reply: z.string().optional(), reopen: z.boolean().optional(), by },
}, wrap((a) => op('note_resolve', a)));
