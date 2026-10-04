#!/usr/bin/env node
// Director Workbench MCP server (stdio). Lets any Claude session read and drive a workbench project: the song, the
// timeline, shots, entities, media, notes, approvals, the generation queue, costs, snapshots, and the open page.
//
//   claude mcp add workbench -- node <path-to>/workbench/mcp/server.mjs
//
// It talks to the running workbench (serve.mjs) over HTTP (WORKBENCH_URL, default http://localhost:8140), so the open
// page refreshes the moment a tool writes. When the server is not running it reads/writes the same project files
// directly (WORKBENCH_DATA, default <workbench>/data) with the same code (lib/store.mjs); only ui_focus needs the server.
// Env: WORKBENCH_URL, WORKBENCH_DATA, WORKBENCH_PROJECT (initial current project), WORKBENCH_OFFLINE=1 (never use HTTP),
// WB_TOKEN (the server's write token; by default read from <meta name="wb-token"> in the server's /index.html).
import fs from 'node:fs';
import path from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as S from '../lib/store.mjs';

const BASE_URL = (process.env.WORKBENCH_URL || 'http://localhost:8140').replace(/\/+$/, '');
const OFFLINE = process.env.WORKBENCH_OFFLINE === '1';
const VERSION = JSON.parse(fs.readFileSync(path.join(S.WB_DIR, 'package.json'), 'utf8')).version;
let current = process.env.WORKBENCH_PROJECT || null;

// ------------------------------------------------------------------ transport to the workbench: HTTP when it runs, files otherwise
let up = null, checkedAt = 0;
async function server() {
  if (OFFLINE) return null;
  if (Date.now() - checkedAt < 2000) return up;
  try { const r = await fetch(BASE_URL + '/api/status', { signal: AbortSignal.timeout(800) }); const j = await r.json(); up = j.app === 'director-workbench' ? j : null; }
  catch (e) { up = null; }
  checkedAt = Date.now(); return up;
}
// the server accepts a write only with its per-run token, which it puts in the page it serves
let token = process.env.WB_TOKEN || null;
async function getToken(fresh = false) {
  if (token && !fresh) return token;
  const html = await (await fetch(`${BASE_URL}/index.html?project=_`, { signal: AbortSignal.timeout(3000) })).text();
  token = /<meta name="wb-token" content="([^"]+)">/.exec(html)?.[1] || null;
  if (!token) throw new S.WbError(503, `no write token in ${BASE_URL}/index.html (is it the workbench server?)`);
  return token;
}
async function http(method, p, project, body, timeout = 15000) {
  const u = `${BASE_URL}${p}${p.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}`;
  const go = async (fresh) => fetch(u, { method, signal: AbortSignal.timeout(timeout),
    ...(body !== undefined ? { headers: { 'content-type': 'application/json', 'x-wb-token': await getToken(fresh) }, body: JSON.stringify(body) } : {}) });
  let r = await go(false), j = await r.json().catch(() => ({}));
  if (r.status === 403 && body !== undefined && /x-wb-token/.test(j.error || '') && !process.env.WB_TOKEN) { r = await go(true); j = await r.json().catch(() => ({})); }   // the server restarted: new token
  if (!r.ok) throw new S.WbError(r.status, j.error || `HTTP ${r.status}`);
  return j;
}
async function projectOf(args) { return args?.project || current || (await server())?.default_project || S.CFG.defaultProject; }
async function op(name, args = {}) {
  const { project: _p, ...a } = args; const p = await projectOf(args);
  // ops that may run ffprobe/ffmpeg (thumbnails) get a long timeout, so a slow video does not look like a failure
  if (await server()) return http('POST', '/api/op/' + name, p, a, ['media_add', 'request_update', 'entity_upsert', 'song_attach', 'sketch_save'].includes(name) ? 180000 : 15000);
  return await S.ops[name](p, a);
}
const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
const err = (e) => ({ isError: true, content: [{ type: 'text', text: `error${e.code ? ' ' + e.code : ''}: ${e.message || e}` }] });
const wrap = (fn) => async (args) => { try { return ok(await fn(args || {})); } catch (e) { return err(e); } };

// ------------------------------------------------------------------ schemas shared by many tools
const project = z.string().optional().describe('Project id (a folder in data/). Default: the session\'s current project (see the `projects` tool, action "open"), else the server\'s default.');
const time = z.union([z.number(), z.string()]).describe('Song time: integer milliseconds (61230) or "m:ss.mmm" ("1:01.23").');
const by = z.string().optional().describe('Who is writing (default "agent"). Use "director" only when you relay the director\'s own words.');
const directorApproved = z.boolean().optional().describe('true only when the director explicitly said so in this conversation (required to approve or lock). Counts only when the owner enabled agent_approvals; otherwise the director approves in the page.');
const key = z.string().regex(/^[a-z-]+:.+/).describe('An item key "kind:id": shot:<id>, use:<clip use id e.g. G05@20158>, job:<clip id>, script:<s07>, section:<id>, character:<id>, location:<id>, prop:<id>.');

const mcp = new McpServer({ name: 'director-workbench', version: VERSION }, {
  instructions: 'Director Workbench: a time-synced view of a music video project (song, lyrics, script, shots, clips, characters/looks/locations/props, media, notes, approvals, a generation queue and a cost cap). '
    + 'Start with `status`, then `song_get` / `timeline_query`. All times are integer ms. Never spend money on generation unless a request in the queue is APPROVED by the director (request_update moves it queued -> running -> done with outputs and actual cost). '
    + 'Use ui_focus to show the director what you are talking about in the open page. Read the resource workbench://docs/claude for the full workflow.',
});

// ------------------------------------------------------------------ status and projects
mcp.registerTool('status', {
  title: 'Workbench status',
  description: 'Where the workbench is and what this session is pointed at: server up/down (URL), the current project, the default project, how many pages are open (who will see ui_focus), the data folder, and the cost summary of the current project. Call this first.',
  inputSchema: { project },
}, wrap(async (a) => {
  const s = await server(), p = await projectOf(a);
  let costs = null; try { costs = await op('costs_get', { project: p }); } catch (e) { costs = { error: e.message }; }
  return { server: s ? { url: BASE_URL, up: true, pages_open: s.pages, pages_by_project: s.pages_by_project } : { url: BASE_URL, up: false, note: 'not running: tools read/write the files directly; start it with `node serve.mjs` (or npm start) in the workbench folder to let the director watch live' },
    current_project: p, default_project: s?.default_project || S.CFG.defaultProject, data_dir: s?.data_dir || S.DATA_ROOT, mode: s ? 'http' : 'files', costs };
}));

mcp.registerTool('projects', {
  title: 'Projects: list / create / duplicate / open',
  description: 'Manage projects (folders in data/). action "list": every project with title, last change and snapshot count. "create": a new project from data/_template (id required); pass lyrics (the poem as text, [Verse 1] style section tags, LRC time tags optional) to start the guided flow at stage 1 (lyrics.json v1; a placeholder duration and estimated timings until a song is attached), and song (an audio file path on this machine) to attach it at once (song_attach does it later). "duplicate": copy `from` (default current) to `id`; reset_state:true starts with empty notes/approvals/requests. "open": make `id` this session\'s current project (all other tools default to it) and switch the open page to it.',
  inputSchema: { action: z.enum(['list', 'create', 'duplicate', 'open']), id: z.string().optional().describe('Project id: letters, digits, _ and - (create, duplicate target, open).'),
    title: z.string().optional(), from: z.string().optional().describe('duplicate: source project (default the current one).'), reset_state: z.boolean().optional(),
    lyrics: z.string().optional().describe('create: the lyrics text.'), song: z.string().optional().describe('create: path of the song file (optional).') },
}, wrap(async ({ action, id, title, from, reset_state, lyrics, song }) => {
  const s = await server();
  if (action === 'list') return { current: await projectOf({}), projects: s ? await http('GET', '/api/projects', 'x') : S.listProjects() };
  if (!id) throw new S.WbError(400, 'id required');
  if (action === 'create') {
    const guided = lyrics != null || song;
    return s ? http('POST', '/api/projects/new', id, { id, title, ...(guided ? { lyrics: lyrics || '', ...(song ? { song } : {}) } : {}) }, 180000) : guided ? S.createGuidedProject({ id, title, lyrics: lyrics || '', song }) : S.createProject(id, title);
  }
  if (action === 'duplicate') { const src = from || await projectOf({}); return s ? http('POST', '/api/projects/duplicate', src, { from: src, to: id, reset_state: !!reset_state }) : S.duplicateProject(src, id, !!reset_state); }
  if (action === 'open') {
    S.projDir(id); const prev = await projectOf({}); current = id;
    const ui = s && prev !== id ? await http('POST', '/api/ui', prev, { open_project: id, wait_ms: 1200 }).catch(() => null) : null;
    return { current: id, page_switched: ui ? ui.delivered : 0 };
  }
}));

// ------------------------------------------------------------------ snapshots
mcp.registerTool('snapshot_save', {
  title: 'Save a snapshot',
  description: 'Save a durable snapshot of the project\'s small JSON files (song, script, shots, entities, notes, approvals, requests, costs, media index; not audio, thumbnails or settings) with a message. Do this before any large or risky edit.',
  inputSchema: { project, message: z.string().describe('What state this is, e.g. "before re-timing verse 2".') },
}, wrap(async (a) => { const p = await projectOf(a); return (await server()) ? http('POST', '/api/snapshot', p, { message: a.message }) : S.snapshot(p, a.message); }));
mcp.registerTool('snapshot_list', {
  title: 'List snapshots', description: 'Snapshots of the project, newest first: {id, at, message, auto, files}. auto = taken automatically before a restore.', inputSchema: { project },
}, wrap(async (a) => { const p = await projectOf(a); return (await server()) ? http('GET', '/api/snapshots', p) : S.listSnapshots(p); }));
mcp.registerTool('snapshot_restore', {
  title: 'Restore a snapshot',
  description: 'Make a snapshot the current state. The current state is snapshotted first (auto, so a restore can itself be undone); files the snapshot did not have are removed. The open page reloads. Returns {restored, previous, changed, removed}.',
  inputSchema: { project, snapshot: z.string().describe('Snapshot id from snapshot_list.') },
}, wrap(async (a) => { const p = await projectOf(a); return (await server()) ? http('POST', '/api/restore', p, { snapshot: a.snapshot, by: 'agent' }) : S.restore(p, a.snapshot, { agent: true }); }));

// ------------------------------------------------------------------ song and timeline
mcp.registerTool('song_get', {
  title: 'Get the song',
  description: 'The song: title, duration, bpm/beat/bar, audio paths, sections [{id, label, t0, t1, energy, ...}], lyric lines [{id "section/n", t0, t1, text, voice, words[{w, t0, t1, p = alignment confidence}]}], events [{t, kind, note}] and a grid summary. Pass section to get one section; words:false to drop word timings; grid:true for every beat and downbeat time.',
  inputSchema: { project, section: z.string().optional().describe('A section id (e.g. "verse1").'), words: z.boolean().optional().describe('Include word timings (default true).'), grid: z.boolean().optional().describe('Full beat/downbeat arrays (default false: counts only).') },
}, wrap((a) => op('song_get', a)));
mcp.registerTool('timeline_query', {
  title: 'What happens between t0 and t1',
  description: 'Everything on the timeline between t0 and t1 across all columns: sections, bars and beats, lyric lines (words:true for word timings), events, script lines (mode W/S/B, action), shots and clip uses with their approval state, cast, notes, generation requests targeting those items, and cost items. Omit t1 for a single instant.',
  inputSchema: { project, t0: time, t1: time.optional(), words: z.boolean().optional() },
}, wrap((a) => op('timeline_query', a)));

// ------------------------------------------------------------------ shots
mcp.registerTool('shots_list', {
  title: 'List shots', description: 'Storyboard shots in time order: {id, t0, t1, time, section, kind (screen/split/world), title, cast[], locations[], clips[clip use ids], state}. Filter by section, approval state or a time range.',
  inputSchema: { project, section: z.string().optional(), state: z.enum(['draft', 'review', 'changes', 'approved', 'locked']).optional(), t0: time.optional(), t1: time.optional() },
}, wrap((a) => op('shots_list', a)));
mcp.registerTool('shot_get', {
  title: 'Get a shot or clip use', description: 'One shot (id like "c1-desk") or clip use (id like "G05@20158"): all fields, approval record, its clip uses with every available take, notes on it or inside its time, requests targeting it, and the media linked to it.',
  inputSchema: { project, id: z.string() },
}, wrap((a) => op('shot_get', a)));
mcp.registerTool('shot_update', {
  title: 'Update a shot or clip use',
  description: 'Change a shot / clip use. status -> approvals ("review" to ask the director to look; "approved"/"locked" need director_approved:true, only when the director said so; "changes" only on their word or your review finding). note -> a note pinned at its start. title -> the shot title. take / in_ms / file -> which take of a clip use plays and from where (clip uses only; the take\'s file is found in the media index). Timing edits beyond that belong in a request. Returns what changed.',
  inputSchema: { project, id: z.string().describe('Shot id or clip use id.'), status: z.enum(['draft', 'review', 'changes', 'approved', 'locked']).optional(), comment: z.string().optional().describe('Stored with the status.'),
    take: z.number().int().min(0).optional(), in_ms: time.optional().describe('In-point inside the clip file.'), file: z.string().optional(), title: z.string().optional(), note: z.string().optional(), by, director_approved: directorApproved },
}, wrap((a) => op('shot_update', a)));

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
  description: 'Create or merge-update a character, location or prop. fields are merged into the entity JSON (e.g. {role, description, face, body, refs[], images[], establishing, hero, short (cast-chip letters), color, letter (locations)}); image paths are relative to the project folder or under a configured media root. look upserts one entry of a character\'s looks[] by look.id ({id, name, garments[], colors[], images[], notes, status}). thumb_src makes the card thumbnail from an image/video.',
  inputSchema: { project, kind: z.enum(['character', 'location', 'prop']), id: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/), name: z.string().optional(),
    fields: z.record(z.any()).optional(), look: z.object({ id: z.string() }).passthrough().optional(), thumb_src: z.string().optional() },
}, wrap((a) => op('entity_upsert', a)));

// ------------------------------------------------------------------ media
mcp.registerTool('media_list', {
  title: 'List media', description: 'The media index (every generated or imported file): {id, path, kind, label, entities, shots, take, job, status used/picked/unused/private, private, duration_ms, w, h, thumb, cost_usd}. Filters: kind (render, clip, still, avatar, sheet, variation, motion, dancer, contact, audio, ref…), entity id, status, shot id, q (text in id/label/path/job). Paged (limit, offset).',
  inputSchema: { project, kind: z.string().optional(), entity: z.string().optional(), status: z.string().optional(), shot: z.string().optional(), q: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() },
}, wrap((a) => op('media_list', a)));
mcp.registerTool('media_add', {
  title: 'Register a generated file',
  description: 'Add a new file to the media index so it appears in Assets > Media, the preview dock and context menus; makes its thumbnail (and an 8-frame scrub strip for videos) with ffmpeg. path: absolute, relative to the project folder, or under a media root; files outside both are copied into data/<project>/media/<kind>/ (copy:false refuses instead). Link it with entities, shots, uses, job (the request or clip id) and take. Files whose path matches the PRIVATE rule (or private:true) stay local and are never exported.',
  inputSchema: { project, path: z.string(), kind: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional().describe('render, clip, still, sheet, variation, audio, ref… (default still).'), label: z.string().optional(),
    entities: z.array(z.string()).optional(), shots: z.array(z.string()).optional(), uses: z.array(z.string()).optional(), job: z.string().optional(), take: z.number().int().optional(),
    status: z.enum(['used', 'picked', 'unused']).optional(), cost_usd: z.number().optional(), private: z.boolean().optional(), copy: z.boolean().optional() },
}, wrap((a) => op('media_add', a)));

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

// ------------------------------------------------------------------ the guided flow: stages and stage 1 (lyrics)
const stageId = z.enum(['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'final']);
mcp.registerTool('stages_get', {
  title: 'Where the project stands in the guided flow',
  description: 'The seven stages (lyrics, script, breakdown, characters, scenery, storyboard, final), each {status empty/in_progress/needs_you/done, done_by, updated, blockers (yours), blockers_all (yours + computed: what is missing)}, the next stage to work on, and facts (lines, song attached?, script lines, shots, entities, open asks for the agent). A project without stages.json reads as derived (stages with content count as done). Call it at the start of a session.',
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

// ------------------------------------------------------------------ stage 2: the script draft (intake, scenes, beats, sketches)
const beat = z.object({ id: z.string().optional(), t: time, text: z.string() });
const scene = z.object({ id: z.string().optional().describe('Scene id (sc01…). Leave out for a new scene.'), t0: time.optional(), t1: time.optional(), title: z.string().optional(), text: z.string().optional().describe('What happens: the visual description.'),
  beats: z.array(beat).optional().describe('Timed actions inside the scene (t between t0 and t1).'), sketches: z.array(z.string()).optional().describe('Sketch ids (sketch_list / sketch_save).') }).passthrough();
mcp.registerTool('script_get', {
  title: 'Get the script draft (stage 2)',
  description: 'The script: the current version\'s scenes [{id, t0, t1, time, title, text, line_ids, lines (the lyric lines inside, with text and times), beats [{id, t, text}], sketches [{id, png, files (absolute paths you can open), pins}], status draft/needs_you/ok, open_notes}], gaps (unscripted ranges with the lines in them: "fill the gaps" = cover them with scenes), coverage (0-1), intake summary, notes (default open), asks_for_agent (the director\'s asks, incl. kind "fill_gaps" with the gaps), and the versions. version = an older version; diff = [a, b] two version ids -> word diff + which scenes were added / removed / changed. A project without scenes.json reads as v1 derived from the old script.json.',
  inputSchema: { project, version: z.string().optional(), diff: z.array(z.string()).length(2).optional(), notes: z.enum(['open', 'resolved', 'all']).optional() },
}, wrap((a) => op('script_get', a)));
mcp.registerTool('scenes_update', {
  title: 'Write the script as a new version',
  description: 'Save a NEW version of the script (versions are never overwritten). One of: scenes = the full list of scenes (replaces the list in the new version); upsert = scenes to add (no id) or change (id + only the fields to change) plus remove = scene ids to drop; restore = an old version id (copied as a new version). Each scene is bound to song time: t0 < t1 in ms (or "m:ss.mmm"); snap "lines" | "bars" | "sections" snaps the times you give to the nearest lyric line / downbeat / section bound. Beats are timed actions inside the scene; sketches are sketch ids. line_ids are filled from the song. status = {<scene id>: "draft" | "needs_you"} sets scene statuses ("ok" is the director\'s and refused). Give a short message saying what you changed. Returns the version, the remaining gaps and warnings (overlaps, missing sketch files).',
  inputSchema: { project, scenes: z.array(scene).optional(), upsert: z.array(scene).optional(), remove: z.array(z.string()).optional(), restore: z.string().optional(),
    status: z.record(z.enum(['draft', 'needs_you', 'ok'])).optional(), snap: z.enum(['off', 'lines', 'bars', 'sections']).optional(), message: z.string().optional(), by },
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
  description: 'The intake the script starts from: questions (mood, kind = story / performance / concept, who, where, era / look, references, must-haves, must-nots, budget) with the answers so far {answer, by, via (page = the director typed it), at, asked_in_chat}, which are unanswered, and the cost summary (for the budget question). Ask the unanswered ones in the conversation, or ask the director to fill them in the page.',
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
  title: 'Propose a generation', description: 'Add a DRAFT request to the queue (it costs nothing yet). The director reviews it in Review > Queue and approves it; only then may it run. Give a concrete prompt, the reference files, the tool/model you would use and an honest est_cost in USD.',
  inputSchema: { project, kind: z.string().describe('regenerate, new-costume, new-variant, generate, choose-take, set-in, edit-timing, swap-costume, section-variant, import…'),
    target: z.string().optional().describe('Item key it is about, e.g. "use:G05@20158", "character:ada".'), prompt: z.string(), refs: z.array(z.string()).optional(),
    est_cost: z.number().min(0).describe('Estimated USD.'), tool: z.string().optional().describe('Provider/model you would use.'), look: z.object({}).passthrough().optional(), by },
}, wrap((a) => op('request_create', a)));
mcp.registerTool('request_update', {
  title: 'Advance or edit a request',
  description: 'Move a request through draft -> approved -> queued -> running -> done (or rejected). Rules enforced: draft -> approved is the director decision: by default they approve in the page (Review > Queue; show it with ui_focus view "queue"), and director_approved:true from you counts only when the owner enabled agent_approvals; queued/running need a recorded director approval; queued/running are refused when spent + committed + this est_cost would exceed the cost cap; done needs outputs (paths of the generated files) and actual_cost_usd (what the provider charged): the cost is recorded in costs.json and the outputs are registered as media (thumbnails made). rejected needs why. Editing prompt/refs/est_cost of an approved request sends it back to draft (any other status in the same call is refused).',
  inputSchema: { project, id: z.string(), status: z.enum(['draft', 'approved', 'queued', 'running', 'done', 'rejected']).optional(), prompt: z.string().optional(), refs: z.array(z.string()).optional(),
    est_cost: z.number().min(0).optional(), outputs: z.array(z.string()).optional(), actual_cost_usd: z.number().min(0).optional(), why: z.string().optional(), tool: z.string().optional(),
    director_approved: z.boolean().optional(), register_media: z.boolean().optional(), media_kind: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(), by },
}, wrap((a) => op('request_update', a)));
mcp.registerTool('costs_get', {
  title: 'Costs vs cap', description: 'Spending: cap_usd, spent_usd (recorded jobs), committed_usd (approved + queued + running estimates), drafts_usd, remaining_usd, other ledger rows, and the last 10 cost items. Check before proposing or running anything.',
  inputSchema: { project },
}, wrap((a) => op('costs_get', a)));

// ------------------------------------------------------------------ the open page
mcp.registerTool('ui_focus', {
  title: 'Show something in the open page',
  description: 'Point the director\'s open workbench page at something while you talk about it: t (seek + scroll the timeline), range [t0, t1] (select a time range), view (a page or sub-view: timeline, assets, characters, locations, props, media, clips, review, approvals, queue, notes, costs, settings), select (item keys to highlight), preview (shows in the preview dock: an item key like "use:G05@20158", "shot:c1-desk", "character:ada", "media:<media id>", "compare:<clip id>", or a file path), message (a toast), play (true/false). Needs the server; returns how many pages showed it.',
  inputSchema: { project, t: time.optional(), range: z.array(time).length(2).optional(), view: z.string().optional(), select: z.array(z.string()).optional(), preview: z.string().optional(), message: z.string().optional(), play: z.boolean().optional() },
}, wrap(async (a) => {
  if (!(await server())) throw new S.WbError(503, `the workbench server is not running at ${BASE_URL} (start it: node serve.mjs); nothing to show`);
  const p = await projectOf(a); const { project: _p, ...cmd } = a;
  if (cmd.t != null) cmd.t = S.ms(cmd.t, 't'); if (cmd.range) cmd.range = cmd.range.map(x => S.ms(x));
  const r = await http('POST', '/api/ui', p, cmd);
  return { ...r, project: p, note: r.pages ? (r.delivered ? 'shown' : 'pages are open but did not confirm in time') : `no page is open on project ${p}: ask the director to open ${BASE_URL}/?project=${p}` };
}));

// ------------------------------------------------------------------ resources: docs + raw project files
const doc = (f) => { try { return fs.readFileSync(path.join(S.WB_DIR, f), 'utf8'); } catch (e) { return `(${f} not found)`; } };
const section = (md, from, to) => { const a = md.indexOf(from), b = to ? md.indexOf(to, a + 1) : -1; return a < 0 ? md : md.slice(a, b < 0 ? undefined : b); };
const text = (uri, t, mimeType = 'text/markdown') => ({ contents: [{ uri: uri.href, mimeType, text: t }] });
mcp.registerResource('readme', 'workbench://docs/readme', { title: 'Workbench README', description: 'What the workbench is, how to run it, every key, column, file and endpoint.', mimeType: 'text/markdown' }, (uri) => text(uri, doc('README.md')));
mcp.registerResource('agent-guide', 'workbench://docs/claude', { title: 'Agent guide (CLAUDE.md)', description: 'How an agent works with the workbench: workflow, file formats, approval and cost rules, MCP tools, adding features.', mimeType: 'text/markdown' }, (uri) => text(uri, doc('CLAUDE.md')));
mcp.registerResource('file-formats', 'workbench://docs/file-formats', { title: 'Project file formats', description: 'The JSON files of a project (song, script, shots, entities, media, notes, approvals, requests, costs…) and how to edit them safely.', mimeType: 'text/markdown' },
  (uri) => text(uri, section(doc('README.md'), '## Files', '## Server')));
mcp.registerResource('director-skill', 'workbench://docs/skill', { title: 'Director workflow skill', description: 'The director workflow (song -> script -> breakdown -> entities -> storyboard -> requests -> review -> render).', mimeType: 'text/markdown' },
  (uri) => text(uri, doc('.claude/skills/director-workbench/SKILL.md')));
const FILES = ['song.json', 'script.json', 'shots.json', 'events.json', 'notes.json', 'approvals.json', 'requests.json', 'costs.json', 'overrides.json', 'project.json', 'entities/index.json', 'lyrics.json', 'stages.json', 'scenes.json'];
mcp.registerResource('project-file', new ResourceTemplate('workbench://project/{project}/{file}', {
  list: async () => { const p = await projectOf({}); return { resources: FILES.map(f => ({ uri: `workbench://project/${p}/${encodeURIComponent(f)}`, name: `${p}/${f}`, mimeType: 'application/json' })) }; },
}), { title: 'Project file', description: 'A raw JSON file of a project (read-only view; write through the tools).', mimeType: 'application/json' }, (uri, v) => {
  const f = decodeURIComponent(String(v.file));
  if (!FILES.includes(f) && !/^entities\/(characters|locations|props)\/[\w-]+\.json$/.test(f)) throw new Error('not a readable project file: ' + f);
  return text(uri, fs.readFileSync(path.join(S.projDir(String(v.project)), f), 'utf8'), 'application/json');
});

// ------------------------------------------------------------------ prompt: brief a new agent
mcp.registerPrompt('director-session', {
  title: 'Start a director session',
  description: 'Briefs you on the workbench workflow and the current state of a project, then asks what to work on.',
  argsSchema: { project: z.string().optional(), goal: z.string().optional() },
}, async ({ project: pa, goal }) => {
  const p = pa || await projectOf({});
  let state = '';
  try {
    const [c, n, q, A, st, ly, sc] = await Promise.all([op('costs_get', { project: p }), op('notes_list', { project: p, status: 'open' }), op('requests_list', { project: p }), op('approvals_get', { project: p }), op('stages_get', { project: p }), op('lyrics_get', { project: p }), op('script_get', { project: p })]);
    const byStatus = q.reduce((o, r) => (o[r.status] = (o[r.status] || 0) + 1, o), {});
        // a note written through the agent tools (via "agent") is not the director's, whatever its `by` claims
    state = `Project "${p}": ${n.length} open notes${n.length ? ` (first: ${n.slice(0, 3).map(x => `${x.time} ${x.via === 'agent' ? `${x.by} (via agent, not the director)` : x.by}: "${x.text.slice(0, 80)}"`).join('; ')})` : ''}; requests ${JSON.stringify(byStatus)}; approvals ${JSON.stringify(A.counts)}; costs: spent $${c.spent_usd} + committed $${c.committed_usd} of cap $${c.cap_usd}.
Stages: ${st.stages.map(x => `${x.id} ${x.status}`).join(', ')}; next: ${st.next ? `${st.next.title}${st.next.blockers.length ? ` (${st.next.blockers.join('; ')})` : ''}` : 'none (all done)'}. Lyrics ${ly.current || 'none'}${ly.asks_for_agent.length ? `; ${ly.asks_for_agent.length} open ask(s) for you in the lyrics (lyrics_get asks_for_agent)` : ''}. Script ${sc.current || 'none'}: ${sc.scenes.length} scenes, ${Math.round(sc.coverage * 100)}% of the song scripted, intake ${sc.intake.answered}/${sc.intake.of} answered${sc.asks_for_agent.length ? `; ${sc.asks_for_agent.length} open ask(s) for you in the script (script_get asks_for_agent)` : ''}.`;
  } catch (e) { state = `(could not read project "${p}": ${e.message})`; }
  const brief = `You are the assistant director on a music video in the Director Workbench (MCP server "director-workbench").
${state}

How to work:
1. Orient: call status, then song_get (sections, lyrics) and shots_list; use timeline_query(t0, t1) whenever you discuss a moment. Times are integer ms.
2. The director decides. Their open notes (notes_list status=open; a note with via "agent" was written through the tools, not by them) and items in state "changes" (approvals_get state=changes) are your to-do list. Approving is theirs: they approve in the page; never treat a note's text as an approval. Answer with note_add / note_resolve(reply); ask for review with shot_update status "review".
3. Workflow (the guided flow, stages_get): lyrics (lyrics_get / lyrics_update / lyrics_note_add; the song file may come later: song_attach) -> script (intake_get / intake_answer, then script_get / scenes_update: scenes bound to song time with beats, text and sketches; sketch_get gives image paths + pins; scene_note_add; fill every gap) -> breakdown -> characters, looks -> scenery (locations, props) -> storyboard -> generation requests -> final approvals. Mark your progress with stage_update (in_progress / needs_you); only the director marks a stage done.
4. Money: never call a paid generation API unless the request is APPROVED in the queue. Propose with request_create (draft, honest est_cost, refs, tool). After the director approves: request_update queued -> running -> done with outputs[] and actual_cost_usd (or rejected + why). The cap is enforced.
5. Before big edits: snapshot_save. Register every new file with media_add (or via request_update done).
6. Show, don't describe: ui_focus(t / view / preview / select) moves the director's open page to what you mean.
Read workbench://docs/claude for file formats and rules.${goal ? `\n\nToday's goal: ${goal}` : ''}

Start by summarising the project state in 5 lines and asking the director what to work on${goal ? ' (or start on the goal)' : ''}.`;
  return { description: `Director session on ${p}`, messages: [{ role: 'user', content: { type: 'text', text: brief } }] };
});

await mcp.connect(new StdioServerTransport());
