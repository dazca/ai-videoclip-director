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
import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as S from '../lib/store.mjs';

const BASE_URL = (process.env.WORKBENCH_URL || 'http://localhost:8140').replace(/\/+$/, '');
const OFFLINE = process.env.WORKBENCH_OFFLINE === '1';
const VERSION = JSON.parse(fs.readFileSync(path.join(S.WB_DIR, 'package.json'), 'utf8')).version;
let current = process.env.WORKBENCH_PROJECT || null;
// the code this MCP server loaded (its own staleness), and the code the running workbench server reports (status.code,
// header x-wb-code on every /api response): when it differs from the files on disk, the server is stale
const MCP_CODE = S.codeState({ mcp: true });
// per tool call: warnings added to the result (a stale server, an op done offline)
const callCtx = new AsyncLocalStorage();
const warn = (msg) => { const w = callCtx.getStore()?.warnings; if (w && !w.includes(msg)) w.push(msg); };
const STALE = (changed) => `the running workbench server (${BASE_URL}) runs older code than the files on disk${changed?.length ? ` (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''} changed)` : ''}: restart the server (node serve.mjs in the workbench folder), then reload the page`;
function checkServerCode(hash) { if (hash && hash !== S.codeState().hash) warn(STALE(up?.code?.changed)); }

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
  checkServerCode(r.headers.get('x-wb-code'));
  if (r.status === 403 && body !== undefined && /x-wb-token/.test(j.error || '') && !process.env.WB_TOKEN) { r = await go(true); j = await r.json().catch(() => ({})); }   // the server restarted: new token
  if (!r.ok) throw new S.WbError(r.status, j.error || `HTTP ${r.status}`);
  return j;
}
async function projectOf(args) { return args?.project || current || (await server())?.default_project || S.CFG.defaultProject; }
async function op(name, args = {}) {
  const { project: _p, ...a } = args; const p = await projectOf(args);
  // ops that may run ffprobe/ffmpeg (thumbnails) get a long timeout, so a slow video does not look like a failure
  if (await server()) {
    try { return await http('POST', '/api/op/' + name, p, a, ['media_add', 'media_update', 'request_update', 'entity_upsert', 'song_attach', 'sketch_save', 'character_iteration_add', 'asset_iteration_add', 'look_create', 'variant_create'].includes(name) ? 180000 : 15000); }
    catch (e) {
      // the server runs older code that does not know this op: do it on the files directly (its file watcher still
      // reloads the open pages) and say so
      if (e.code === 404 && /^no such op/.test(e.message) && Object.hasOwn(S.ops, name)) { warn(`${STALE(up?.code?.changed)}. It does not know "${name}": done on the files directly (offline) instead`); return await S.ops[name](p, a); }
      throw e;
    }
  }
  return await S.ops[name](p, a);
}
const warnBlock = (w) => (w.length ? [{ type: 'text', text: 'warning: ' + w.join('\nwarning: ') }] : []);
const ok = (v, w = []) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }, ...warnBlock(w)] });
const err = (e, w = []) => ({ isError: true, content: [{ type: 'text', text: `error${e.code ? ' ' + e.code : ''}: ${e.message || e}` }, ...warnBlock(w)] });
// every tool: its result, plus a "warning: ..." block when the server is stale or an op was done offline
const wrap = (fn) => (args, extra) => callCtx.run({ warnings: [] }, async () => { const w = callCtx.getStore().warnings; try { return ok(await fn(args || {}, extra), w); } catch (e) { return err(e, w); } });

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
  description: 'Where the workbench is and what this session is pointed at: server up/down (URL), whether it runs the code on disk (server.code.stale: restart it), the current project, the default project, how many pages are open (who will see ui_focus), the data folder, and the cost summary of the current project. Call this first. Every tool adds a "warning:" block when the server is stale or an op had to be done on the files directly.',
  inputSchema: { project },
}, wrap(async (a) => {
  checkedAt = 0; const s = await server(), p = await projectOf(a);
  let costs = null; try { costs = await op('costs_get', { project: p }); } catch (e) { costs = { error: e.message }; }
  const disk = S.codeState({ mcp: true }), mcpChanged = S.codeDiff(MCP_CODE, disk);
  const sc = s?.code ? { hash: s.code.hash, started: s.code.started, disk: S.codeState().hash, stale: s.code.hash !== S.codeState().hash, changed: s.code.changed || [] } : s ? { hash: null, stale: true, note: 'the server reports no code version: it predates this check' } : null;
  if (sc?.stale) warn(STALE(sc.changed));
  if (mcpChanged.length) warn(`this MCP server loaded older code than the files on disk (${mcpChanged.slice(0, 5).join(', ')} changed): reconnect it (/mcp in Claude Code, or restart the session) to get the new tools`);
  return { server: s ? { url: BASE_URL, up: true, pages_open: s.pages, pages_by_project: s.pages_by_project, code: sc, ...(sc?.stale ? { restart: 'restart the server: its code is older than the files on disk (node serve.mjs), then reload the page' } : {}) } : { url: BASE_URL, up: false, note: 'not running: tools read/write the files directly; start it with `node serve.mjs` (or npm start) in the workbench folder to let the director watch live' },
    mcp: { code: MCP_CODE.hash, stale: mcpChanged.length > 0, ...(mcpChanged.length ? { changed: mcpChanged } : {}) },
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
mcp.registerTool('media_update', {
  title: 'Relabel / re-link a registered file',
  description: 'Change a file already in the media index (media_add of an existing path returns "already indexed" and changes nothing): label, kind, the links (entities, shots, uses: each replaces the list), job / take (null clears), status used / picked / unused. private:true makes it private (local only, never exported; its public thumbnail is replaced by a private one); a private file never becomes public again (private:false is refused). Find it by id or path (media_list).',
  inputSchema: { project, id: z.string().optional(), path: z.string().optional(), label: z.string().optional(), kind: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(),
    entities: z.array(z.string()).optional(), shots: z.array(z.string()).optional(), uses: z.array(z.string()).optional(), job: z.string().nullable().optional(), take: z.number().int().nullable().optional(),
    status: z.enum(['used', 'picked', 'unused']).optional(), private: z.boolean().optional().describe('true only: a private flag only moves toward more private.') },
}, wrap((a) => op('media_update', a)));

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

// ------------------------------------------------------------------ stage 4: characters (identity + looks as iteration trees)
const charId = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/).describe('Character entity id (character_get without id lists them).');
const treeId = z.string().regex(/^(identity|look:[A-Za-z0-9_][A-Za-z0-9_-]{0,63})$/).describe('"identity" or "look:<look id>".');
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
    description: z.string().optional(), from_item: z.string().optional(), by },
}, wrap((a) => op('look_create', a)));

// ------------------------------------------------------------------ stages 4 and 5: every asset (characters, locations, props) on one code path
const assetType = z.enum(['character', 'location', 'prop']);
const assetTree = z.string().regex(/^(identity|base|look:[A-Za-z0-9_][A-Za-z0-9_-]{0,63}|variant:[A-Za-z0-9_][A-Za-z0-9_-]{0,63})$/).describe('A tree: the root ("identity" for a character, "base" for a location / prop) or a variant ("look:<id>" for a character, "variant:<id>" for a location / prop).');
const pinsSchema = z.array(z.object({ n: z.number().optional(), x: z.number(), y: z.number(), text: z.string() }));
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

// ------------------------------------------------------------------ stage 6: the storyboard (shots per scene) and the gaps
const shotId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/).describe('Shot id (sh03; older shots.json ids like s2-wall stay).');
const entIds = z.array(z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/));
const shot = z.object({ id: shotId.optional().describe('Leave out for a new shot.'), scene: z.string().nullable().optional().describe('The scene it belongs to (script_get); a new shot without one goes to the scene at its middle.'),
  t0: time.optional(), t1: time.optional(), kind: z.string().optional().describe('wide, medium, close, insert, performance, xp-desktop (or another short lower-case word).'),
  title: z.string().optional(), text: z.string().optional().describe('The action: what we see.'), camera: z.string().optional().describe('Camera / motion: slow push in, handheld, locked-off…'),
  sketch: z.string().nullable().optional().describe('The frame sketch id (sketch_save, links {shots: [id]}).'), beats: z.array(z.string()).optional().describe('The scene beat ids this shot covers.'),
  cast: entIds.optional(), locations: entIds.optional(), props: entIds.optional(),
  variants: z.record(z.string().nullable()).optional().describe('{<entity id>: <variant / look id> | null (the root)}: only where the shot differs from the scene\'s pick.'),
  gen: z.enum(['still', 'video']).nullable().optional().describe('What it needs generated (default from the kind).'), clips: z.array(z.string()).optional() }).passthrough();
mcp.registerTool('storyboard_get', {
  title: 'Get the storyboard (stage 6)',
  description: 'The storyboard: the script\'s scenes in song time [{id, time, title, text, status, beats [{id, t, text}], needs (the cast / locations / props the breakdown links to the scene, with the variant the scene uses), shots}], each shot {id, scene, t0, t1, time, bars, kind, title, text, camera, beats, cast, locations, props, variants (per-shot overrides), gen still/video, clips, status (approvals: draft/review/changes/approved/locked), frame {sketch, png, file (absolute), pins} or {thumb}, assets [{type, id, name, variant, variant_name, source scene/shot/director/agent/default, approved, image, file, why}], requests (target shot:<id>), estimate}; outside_script (shots whose scene is gone); the beat grid; gaps (counts + estimate; gaps_get has the rows); notes (default open); asks_for_agent (kind storyboard = propose shots, fill_gaps = draft requests); versions. A project without storyboard.json reads its shots from shots.json (v1, derived). version = an older one; diff = [a, b] -> word diff + shots added / removed / changed; scene filters.',
  inputSchema: { project, version: z.string().optional(), diff: z.array(z.string()).length(2).optional(), scene: z.string().optional(), notes: z.enum(['open', 'resolved', 'all']).optional() },
}, wrap((a) => op('storyboard_get', a)));
mcp.registerTool('shots_update', {
  title: 'Write the storyboard as a new version',
  description: 'Save a NEW version of the storyboard (versions are never overwritten). One of: shots = the full list; upsert = shots to add (no id: a new id sh<n>) or change (id + only the fields to change) plus remove = shot ids; restore = an old version id. A shot is bound to song time (t0 < t1, ms or "m:ss.mmm") and to a scene; the shots of a scene TILE it (re-tiled unless tile:false: the first starts with the scene, each ends where the next starts, the last ends with the scene); snap "beats" | "bars" puts the times you give on the beat grid. Propose shots from the scene beats (one per beat or group of beats) with kind, the action, camera / motion, cast / locations / props (entity ids; variants only where the shot differs from the scene) and a frame sketch (sketch_save first). status = {<shot id>: "draft" | "review" | "changes"} (approved / locked are the director\'s, in the page: 403). Give a short message. Returns the version, warnings (unknown scenes, entities, variants, sketches, beats; boundaries moved by tiling) and the gaps left.',
  inputSchema: { project, shots: z.array(shot).optional(), upsert: z.array(shot).optional(), remove: z.array(z.string()).optional(), restore: z.string().optional(),
    status: z.record(z.enum(['draft', 'review', 'changes', 'approved', 'locked'])).optional(), snap: z.enum(['beats', 'bars', 'off']).optional(), tile: z.boolean().optional(), message: z.string().optional(), by },
}, wrap((a) => op('shots_update', a)));
mcp.registerTool('shot_note_add', {
  title: 'Note on a shot',
  description: 'Pin a note to a shot (shot id from storyboard_get), or a scene, or neither for the whole storyboard. reply_to = a note id adds your reply to its thread (answer the director\'s notes and asks this way). Notes are marked via "agent"; they never change the storyboard (shots_update does).',
  inputSchema: { project, shot: z.string().optional(), scene: z.string().optional(), text: z.string(), reply_to: z.string().optional(), to: z.string().optional(), by },
}, wrap((a) => op('shot_note_add', a)));
mcp.registerTool('shot_note_resolve', {
  title: 'Resolve a storyboard note',
  description: 'Mark a storyboard note (or an ask for you: "storyboard", "fill the gaps") resolved, with an optional reply saying what you did; reopen:true reopens it. Resolve the director\'s asks only when you did what they asked.',
  inputSchema: { project, id: z.string(), reply: z.string().optional(), reopen: z.boolean().optional(), by },
}, wrap((a) => op('shot_note_resolve', a)));
mcp.registerTool('gaps_get', {
  title: 'What is still missing (stage 6 gaps) and what filling it costs',
  description: 'Everything still missing across the stages: unscripted time, scenes without shots, shots without a frame, assets the shots need that are not approved (with the shots that need them), shots without a generation request or clip; proposals = for each of those shots the draft requests to create (request_create: kind shot-still / shot-video, target "shot:<id>", prompt, refs = the approved variant / look images + the frame sketch (ref_files absolute), tool, honest est_cost; a video needs its still first), with the assets not yet approved; estimate = the total against the cap (spent + committed + this, over_cap); asks_for_agent = the director\'s "fill the gaps" asks. Nothing is created or spent by this call.',
  inputSchema: { project },
}, wrap((a) => op('gaps_get', a)));

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
mcp.registerTool('wait_for', {
  title: 'Wait until a request, stage or note changes',
  description: 'Block until the item changes, instead of polling: request = a request id (its status), stage = a stage id (its status), note = a timeline note id (its status; a reply counts as a change). until = the statuses to wait for (e.g. ["approved", "rejected"]); default: any change from the status it has now. Returns at once when it already is in until. Wakes on the server\'s change feed (SSE) when the server runs, else polls the files. timeout_s up to 1800 (default 600): then it returns {timed_out: true} with the current state. Sends progress notifications while waiting (clients that reset their timeout on progress keep waiting).',
  inputSchema: { project, request: z.string().optional(), stage: stageId.optional(), note: z.string().optional(), until: z.array(z.string()).optional(), timeout_s: z.number().min(1).max(1800).optional() },
}, wrap(async (a, extra) => {
  const p = await projectOf(a), which = ['request', 'stage', 'note'].filter(k => a[k] != null);
  if (which.length !== 1) throw new S.WbError(400, 'give exactly one of request, stage, note');
  const kind = which[0], id = a[kind], timeout = Math.min(1800, Math.max(1, a.timeout_s ?? 600)) * 1000;
  const look = async () => {
    if (kind === 'request') { const r = (await op('requests_list', { project: p })).find(x => x.id === id); if (!r) throw new S.WbError(404, `no request "${id}"`); return { status: r.status, key: r.status, item: r }; }
    if (kind === 'stage') { const st = (await op('stages_get', { project: p })).stages.find(x => x.id === id); if (!st) throw new S.WbError(404, `no stage "${id}"`); return { status: st.status, key: st.status, item: st }; }
    const all = await op('notes_list', { project: p }), n = all.find(x => x.id === id); if (!n) throw new S.WbError(404, `no note "${id}"`);
    const replies = all.filter(x => x.reply_to === id); return { status: n.status, key: `${n.status}/${replies.length}`, item: { ...n, replies } };
  };
  const t0 = Date.now(), first = await look(), until = a.until?.length ? a.until : null;
  const done = (s) => (until ? until.includes(s.status) : s.key !== first.key);
  if (until && done(first)) return { [kind]: id, status: first.status, changed: false, already: true, waited_s: 0, item: first.item };
  // wake on the change feed when the server runs; poll the files (or the server) as a backstop
  let wake = () => {}; const ctl = new AbortController(); let sse = false;
  if (await server()) {
    sse = true;
    fetch(`${BASE_URL}/api/events?project=${encodeURIComponent(p)}`, { signal: ctl.signal }).then(async (r) => { const rd = r.body.getReader(); for (;;) { const x = await rd.read(); if (x.done) break; wake(); } }).catch(() => { sse = false; });
  }
  const token = extra?._meta?.progressToken; let lastProgress = Date.now();
  try {
    for (;;) {
      const left = timeout - (Date.now() - t0);
      if (left <= 0) { const s = await look(); return { [kind]: id, status: s.status, changed: s.key !== first.key, timed_out: true, waited_s: Math.round((Date.now() - t0) / 1000), item: s.item }; }
      await new Promise(ok => { const t = setTimeout(ok, Math.min(left, sse ? 10000 : 2000)); wake = () => { clearTimeout(t); ok(); }; });
      const s = await look();
      if (done(s)) return { [kind]: id, from: first.status, status: s.status, changed: true, waited_s: Math.round((Date.now() - t0) / 1000), item: s.item };
      if (token !== undefined && Date.now() - lastProgress > 15000) { lastProgress = Date.now(); extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((Date.now() - t0) / 1000), total: Math.round(timeout / 1000), message: `waiting for ${kind} ${id} (${s.status})` } }).catch(() => {}); }
    }
  } finally { ctl.abort(); }
}));

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
const FILES = ['song.json', 'script.json', 'shots.json', 'events.json', 'notes.json', 'approvals.json', 'requests.json', 'costs.json', 'overrides.json', 'project.json', 'entities/index.json', 'lyrics.json', 'stages.json', 'scenes.json', 'breakdown.json', 'storyboard.json'];
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
    const [c, n, q, A, st, ly, sc, bd, sb] = await Promise.all([op('costs_get', { project: p }), op('notes_list', { project: p, status: 'open' }), op('requests_list', { project: p }), op('approvals_get', { project: p }), op('stages_get', { project: p }), op('lyrics_get', { project: p }), op('script_get', { project: p }), op('breakdown_get', { project: p, with_script: false }), op('storyboard_get', { project: p })]);
    const byStatus = q.reduce((o, r) => (o[r.status] = (o[r.status] || 0) + 1, o), {});
        // a note written through the agent tools (via "agent") is not the director's, whatever its `by` claims
    state = `Project "${p}": ${n.length} open notes${n.length ? ` (first: ${n.slice(0, 3).map(x => `${x.time} ${x.via === 'agent' ? `${x.by} (via agent, not the director)` : x.by}: "${x.text.slice(0, 80)}"`).join('; ')})` : ''}; requests ${JSON.stringify(byStatus)}; approvals ${JSON.stringify(A.counts)}; costs: spent $${c.spent_usd} + committed $${c.committed_usd} of cap $${c.cap_usd}.
Stages: ${st.stages.map(x => `${x.id} ${x.status}`).join(', ')}; next: ${st.next ? `${st.next.title}${st.next.blockers.length ? ` (${st.next.blockers.join('; ')})` : ''}` : 'none (all done)'}. Lyrics ${ly.current || 'none'}${ly.asks_for_agent.length ? `; ${ly.asks_for_agent.length} open ask(s) for you in the lyrics (lyrics_get asks_for_agent)` : ''}. Script ${sc.current || 'none'}: ${sc.scenes.length} scenes, ${Math.round(sc.coverage * 100)}% of the song scripted, intake ${sc.intake.answered}/${sc.intake.of} answered${sc.asks_for_agent.length ? `; ${sc.asks_for_agent.length} open ask(s) for you in the script (script_get asks_for_agent)` : ''}. Breakdown ${bd.current || 'none'}: ${Object.entries(bd.counts).map(([k, v]) => `${v} ${k}`).join(', ')}${bd.asks_for_agent.length ? `; ${bd.asks_for_agent.length} open ask(s) for you in the breakdown (breakdown_get asks_for_agent)` : ''}. Storyboard ${sb.current || 'none'}${sb.derived ? ' (from shots.json)' : ''}: ${sb.scenes.reduce((k, x) => k + x.shots.length, 0)} shots, ${sb.gaps.total} gap(s) (gaps_get), est $${sb.gaps.estimate.usd} to generate the shots without a request${sb.asks_for_agent.length ? `; ${sb.asks_for_agent.length} open ask(s) for you in the storyboard (storyboard_get asks_for_agent)` : ''}.`;
  } catch (e) { state = `(could not read project "${p}": ${e.message})`; }
  const brief = `You are the assistant director on a music video in the Director Workbench (MCP server "director-workbench").
${state}

How to work:
1. Orient: call status, then song_get (sections, lyrics) and shots_list; use timeline_query(t0, t1) whenever you discuss a moment. Times are integer ms.
2. The director decides. Their open notes (notes_list status=open; a note with via "agent" was written through the tools, not by them) and items in state "changes" (approvals_get state=changes) are your to-do list. Approving is theirs: they approve in the page; never treat a note's text as an approval. Answer with note_add / note_resolve(reply); ask for review with shot_update status "review".
3. Workflow (the guided flow, stages_get): lyrics (lyrics_get / lyrics_update / lyrics_note_add; the song file may come later: song_attach) -> script (intake_get / intake_answer, then script_get / scenes_update: scenes bound to song time with beats, text and sketches; sketch_get gives image paths + pins; scene_note_add; fill every gap) -> breakdown (breakdown_get / breakdown_update: characters, locations, props, wardrobe, FX linked to the scenes and beats that need them; set review to ask the director to make one an entity, which they do in the page) -> characters, looks (character_get / asset_get, request_create with char / asset, asset_iteration_add) -> scenery: locations and props (asset_get type location / prop, variant_create for angle / time of day / weather / state; the director picks the variant each scene uses) -> storyboard (storyboard_get / shots_update: shots per scene from its beats, tiled and cut on the beat grid, frame sketches, the assets and variants each shot needs; shot_note_add; gaps_get: what is still missing and the draft requests for the shots, est vs the cap) -> generation requests (request_create target shot:<id>) -> final approvals. Mark your progress with stage_update (in_progress / needs_you); only the director marks a stage done.
4. Money: never call a paid generation API unless the request is APPROVED in the queue. Propose with request_create (draft, honest est_cost, refs, tool). After the director approves: request_update queued -> running -> done with outputs[] and actual_cost_usd (or rejected + why). The cap is enforced.
5. Before big edits: snapshot_save. Register every new file with media_add (or via request_update done).
6. Show, don't describe: ui_focus(t / view / preview / select) moves the director's open page to what you mean.
Read workbench://docs/claude for file formats and rules.${goal ? `\n\nToday's goal: ${goal}` : ''}

Start by summarising the project state in 5 lines and asking the director what to work on${goal ? ' (or start on the goal)' : ''}.`;
  return { description: `Director session on ${p}`, messages: [{ role: 'user', content: { type: 'text', text: brief } }] };
});

await mcp.connect(new StdioServerTransport());
