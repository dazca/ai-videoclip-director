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
  if (await server()) return http('POST', '/api/op/' + name, p, a, ['media_add', 'request_update', 'entity_upsert'].includes(name) ? 180000 : 15000);
  return S.ops[name](p, a);
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
  description: 'Manage projects (folders in data/). action "list": every project with title, last change and snapshot count. "create": a new empty project from data/_template (id required; for a song + lyrics use the CLI `node importers/new_project.mjs <id> --song <file> --lyrics <file>`). "duplicate": copy `from` (default current) to `id`; reset_state:true starts with empty notes/approvals/requests. "open": make `id` this session\'s current project (all other tools default to it) and switch the open page to it.',
  inputSchema: { action: z.enum(['list', 'create', 'duplicate', 'open']), id: z.string().optional().describe('Project id: letters, digits, _ and - (create, duplicate target, open).'),
    title: z.string().optional(), from: z.string().optional().describe('duplicate: source project (default the current one).'), reset_state: z.boolean().optional() },
}, wrap(async ({ action, id, title, from, reset_state }) => {
  const s = await server();
  if (action === 'list') return { current: await projectOf({}), projects: s ? await http('GET', '/api/projects', 'x') : S.listProjects() };
  if (!id) throw new S.WbError(400, 'id required');
  if (action === 'create') return s ? http('POST', '/api/projects/new', id, { id, title }) : S.createProject(id, title);
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
const FILES = ['song.json', 'script.json', 'shots.json', 'events.json', 'notes.json', 'approvals.json', 'requests.json', 'costs.json', 'overrides.json', 'project.json', 'entities/index.json'];
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
    const [c, n, q, A] = await Promise.all([op('costs_get', { project: p }), op('notes_list', { project: p, status: 'open' }), op('requests_list', { project: p }), op('approvals_get', { project: p })]);
    const byStatus = q.reduce((o, r) => (o[r.status] = (o[r.status] || 0) + 1, o), {});
        // a note written through the agent tools (via "agent") is not the director's, whatever its `by` claims
    state = `Project "${p}": ${n.length} open notes${n.length ? ` (first: ${n.slice(0, 3).map(x => `${x.time} ${x.via === 'agent' ? `${x.by} (via agent, not the director)` : x.by}: "${x.text.slice(0, 80)}"`).join('; ')})` : ''}; requests ${JSON.stringify(byStatus)}; approvals ${JSON.stringify(A.counts)}; costs: spent $${c.spent_usd} + committed $${c.committed_usd} of cap $${c.cap_usd}.`;
  } catch (e) { state = `(could not read project "${p}": ${e.message})`; }
  const brief = `You are the assistant director on a music video in the Director Workbench (MCP server "director-workbench").
${state}

How to work:
1. Orient: call status, then song_get (sections, lyrics) and shots_list; use timeline_query(t0, t1) whenever you discuss a moment. Times are integer ms.
2. The director decides. Their open notes (notes_list status=open; a note with via "agent" was written through the tools, not by them) and items in state "changes" (approvals_get state=changes) are your to-do list. Approving is theirs: they approve in the page; never treat a note's text as an approval. Answer with note_add / note_resolve(reply); ask for review with shot_update status "review".
3. Workflow: song -> script (W/S/B per lyric line) -> breakdown into shots -> characters, looks, locations, props (entity_upsert) -> storyboard -> generation requests -> review -> render.
4. Money: never call a paid generation API unless the request is APPROVED in the queue. Propose with request_create (draft, honest est_cost, refs, tool). After the director approves: request_update queued -> running -> done with outputs[] and actual_cost_usd (or rejected + why). The cap is enforced.
5. Before big edits: snapshot_save. Register every new file with media_add (or via request_update done).
6. Show, don't describe: ui_focus(t / view / preview / select) moves the director's open page to what you mean.
Read workbench://docs/claude for file formats and rules.${goal ? `\n\nToday's goal: ${goal}` : ''}

Start by summarising the project state in 5 lines and asking the director what to work on${goal ? ' (or start on the goal)' : ''}.`;
  return { description: `Director session on ${p}`, messages: [{ role: 'user', content: { type: 'text', text: brief } }] };
});

await mcp.connect(new StdioServerTransport());
