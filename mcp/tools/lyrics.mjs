// MCP tools: the guided flow (stages) and stage 1, the lyrics and the song file (lib/ops/lyrics.mjs).
// Registered on the shared server object when mcp/server.mjs imports this file.
import { z } from 'zod';
import { mcp, op, wrap, project, by, stageId } from './_shared.mjs';

// ------------------------------------------------------------------ the guided flow: stages and stage 1 (lyrics)

mcp.registerTool('stages_get', {
  title: 'Where the project stands in the guided flow',
  description: 'The seven stages (lyrics, script, breakdown, characters, scenery, storyboard, final), each {status empty/in_progress/needs_you/done, done_by, updated, blockers (yours), blockers_all (yours + computed: what is missing)}, the next stage to work on, and facts (lines, song attached?, script lines, shots, entities, open asks for the agent). Each stage also has shown (empty / in_progress / needs_you / ready = ready for the director to mark done / done / changed = marked done but the content no longer satisfies it, reason in changed) and content {status, blockers, hints, counts}, computed from the files. A project without stages.json reads as derived (content = in_progress, never done). Call it at the start of a session.',
  inputSchema: { project },
}, wrap((a) => op('stages_get', a)));
mcp.registerTool('stage_update', {
  title: 'Set a stage\'s status or blockers',
  description: 'Set a stage to in_progress (you are working on it), needs_you (the director must look or decide: say what in note) or empty, and/or replace its blockers (short strings shown on the stage rail). "done" is refused: only the director marks a stage done, in the page; a done stage cannot be moved by you (ask them to reopen it).',
  inputSchema: { project, stage: stageId, status: z.enum(['empty', 'in_progress', 'needs_you', 'done']).optional().describe('empty, in_progress or needs_you ("done" is refused with the reason: the director marks done in the page).'), blockers: z.array(z.string()).optional(), note: z.string().optional().describe('Why (shown in the stage workspace).'), by },
}, wrap((a) => op('stage_update', a)));
mcp.registerTool('lyrics_get', {
  title: 'Get the lyrics (stage 1)',
  description: 'The current lyrics version: text (with [Section] tags), sections [{id, label, lines [{id, text, t0?, t1?, timing?}]}] (line ids are stable across versions and equal the song.json line ids), the song state (has_audio, duration, placeholder_duration, timing), notes (default open; notes:"all") pinned to a line or a word range {id, line, w [first, last word index], quote, text, by, via (page = the director, agent = written through the tools), to?, status, replies[]}, and asks_for_agent: open notes the director addressed to you (the "Ask the agent" box): your to-do list for this stage. version picks an older version.',
  inputSchema: { project, version: z.string().optional(), notes: z.enum(['open', 'resolved', 'all']).optional() },
}, wrap((a) => op('lyrics_get', a)));
mcp.registerTool('lyrics_update', {
  title: 'Save a new lyrics version',
  description: 'Write the poem as a NEW version (versions are never overwritten): text = the whole poem with [Verse 1] / [Chorus] section tags (blank line = new block); or sections [{label, lines: ["text", ...]}]; or restore = an older version id (copied as a new version). Lines whose text is unchanged keep their ids, reworded lines keep the id of the line they replace (so their song timings and notes follow). The song.json lines follow at once (timeline lyrics column). Give a short message saying what you changed and why. Edit only what the director asked for or agreed to.',
  inputSchema: { project, text: z.string().optional(), sections: z.array(z.object({ label: z.string(), lines: z.array(z.string()) })).optional(), restore: z.string().optional(), message: z.string().optional(), by },
}, wrap((a) => op('lyrics_update', a)));
mcp.registerTool('lyrics_versions', {
  title: 'Lyrics versions and diffs',
  description: 'List the lyrics versions {id, created, by, via, message, from (restore), lines, current}; id = one version with its text; diff = [a, b] two version ids -> word-level diff (added/removed counts, the text with [-removed-] and {+added+} marks).',
  inputSchema: { project, id: z.string().optional(), diff: z.array(z.string()).length(2).optional() },
}, wrap((a) => op('lyrics_versions', a)));
mcp.registerTool('lyrics_note_add', {
  title: 'Note on a lyric line or words',
  description: 'Pin a note to a lyric line (line = line id from lyrics_get), optionally to a word range (words = [first, last] word index, or quote = the exact words), or with no line for the whole poem. reply_to = a note id adds your reply to its thread (use it to answer the director\'s notes and asks). Notes are marked via "agent"; they never change the poem (lyrics_update does).',
  inputSchema: { project, line: z.string().optional(), words: z.array(z.number().int().min(0)).length(2).optional(), quote: z.string().optional(), text: z.string(), reply_to: z.string().optional(), by },
}, wrap((a) => op('lyrics_note_add', a)));
mcp.registerTool('lyrics_note_resolve', {
  title: 'Resolve a lyrics note',
  description: 'Mark a lyrics note (or an ask for you) resolved, with an optional reply saying what you did; reopen:true reopens it. Resolve the director\'s notes only when you did what they asked.',
  inputSchema: { project, id: z.string(), reply: z.string().optional(), reopen: z.boolean().optional(), by },
}, wrap((a) => op('lyrics_note_resolve', a)));
mcp.registerTool('song_attach', {
  title: 'Add or replace the song file',
  description: 'Attach the song (an audio file: absolute path on this machine, relative to the project, or under a media root) to the project: copied into data/<project>/audio/, then waveform peaks, energy, beat grid (bpm, beats_per_bar, offset of the first downbeat in ms) and the real duration. A lyrics-only project gets every line re-timed over the real song (LRC tags in the lyrics win, else estimated; fix them before cutting); a project that had a song keeps its line timings. Needs ffmpeg.',
  inputSchema: { project, path: z.string(), bpm: z.number().min(20).max(400).optional(), beats_per_bar: z.number().int().min(1).optional(), offset: z.number().optional() },
}, wrap((a) => op('song_attach', a)));
