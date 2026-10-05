// MCP tools: status, projects, snapshots, the song and the timeline, the media index, wait_for and ui_focus (lib/ops/core.mjs; wait_for and ui_focus talk to the server).
// Registered on the shared server object when mcp/server.mjs imports this file.
import { z } from 'zod';
import * as S from '../../lib/store.mjs';
import { mcp, op, wrap, http, server, recheckServer, projectOf, setCurrent, warn, STALE, BASE_URL, MCP_CODE, project, time, stageId } from './_shared.mjs';

// ------------------------------------------------------------------ status and projects
mcp.registerTool('status', {
  title: 'Workbench status',
  description: 'Where the workbench is and what this session is pointed at: server up/down (URL), whether it runs the code on disk (server.code.stale: restart it), the current project, the default project, how many pages are open (who will see ui_focus), the data folder, and the cost summary of the current project. Call this first. Every tool adds a "warning:" block when the server is stale or an op had to be done on the files directly.',
  inputSchema: { project },
}, wrap(async (a) => {
  recheckServer(); const s = await server(), p = await projectOf(a);
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
    S.projDir(id); const prev = await projectOf({}); setCurrent(id);
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
}, wrap(async (a) => { const p = await projectOf(a); return (await server()) ? http('POST', '/api/restore', p, { snapshot: a.snapshot, by: 'agent' }) : (S.lockGate(p, 'snapshot_restore'), S.restore(p, a.snapshot, { agent: true })); }));

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

// ------------------------------------------------------------------ media
mcp.registerTool('media_list', {
  title: 'List media', description: 'The media index (every generated or imported file): {id, path, kind, label, entities, shots, take, job, status used/picked/unused/private, private, duration_ms, w, h, thumb, cost_usd}. Filters: kind (render, clip, still, avatar, sheet, variation, motion, dancer, contact, audio, ref…), entity id, status, shot id, linked ("linked": used by an entity / node / shot / clip use / request / "use as"; "unlinked": not), private, q (text in id/label/path/job). Imported files carry `imported` {by, via, at, from}, a request link `request`, and the director’s "use as" `use_as` [{shot, as: take | start_frame} | {entity, tree, node, as}]. Paged (limit, offset).',
  inputSchema: { project, kind: z.string().optional(), entity: z.string().optional(), status: z.string().optional(), shot: z.string().optional(), q: z.string().optional(), linked: z.enum(['linked', 'unlinked']).optional(), private: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() },
}, wrap((a) => op('media_list', a)));
mcp.registerTool('media_add', {
  title: 'Register a generated file',
  description: 'Add a new file to the media index so it appears in Assets > Media, the preview dock and context menus; makes its thumbnail (and an 8-frame scrub strip for videos) with ffmpeg. path: absolute, relative to the project folder, or under a media root; files outside both are copied into data/<project>/media/<kind>/ (copy:false refuses instead). Link it with entities, shots, uses, job (the request or clip id), take and request (the request it is an output of); the fps of a video is recorded. Files whose path matches the PRIVATE rule (or private:true) stay local and are never exported.',
  inputSchema: { project, path: z.string(), kind: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional().describe('render, clip, still, sheet, variation, audio, ref… (default still).'), label: z.string().optional(),
    entities: z.array(z.string()).optional(), shots: z.array(z.string()).optional(), uses: z.array(z.string()).optional(), job: z.string().optional(), take: z.number().int().optional(),
    status: z.enum(['used', 'picked', 'unused']).optional(), cost_usd: z.number().optional(), private: z.boolean().optional(), copy: z.boolean().optional(),
    request: z.string().regex(/^[\w@.:-]{1,80}$/).optional().describe('the request id this file is an output of (its take in takes_get); the fps of a video is probed and recorded') },
}, wrap((a) => op('media_add', a)));
mcp.registerTool('media_update', {
  title: 'Relabel / re-link a registered file',
  description: 'Change a file already in the media index (media_add of an existing path returns "already indexed" and changes nothing): label, kind, the links (entities, shots, uses: each replaces the list), job / take (null clears), status used / picked / unused. private:true makes it private (local only, never exported; its public thumbnail is replaced by a private one); a private file never becomes public again (private:false is refused). Find it by id or path (media_list).',
  inputSchema: { project, id: z.string().optional(), path: z.string().optional(), label: z.string().optional(), kind: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(),
    entities: z.array(z.string()).optional(), shots: z.array(z.string()).optional(), uses: z.array(z.string()).optional(), job: z.string().nullable().optional(), take: z.number().int().nullable().optional(),
    status: z.enum(['used', 'picked', 'unused']).optional(), private: z.boolean().optional().describe('true only: a private flag only moves toward more private.') },
}, wrap((a) => op('media_update', a)));

mcp.registerTool('wait_for', {
  title: 'Wait until a request, stage or note changes',
  description: 'Block until the item changes, instead of polling: request = a request id (its status), requests = several request ids (returns on the FIRST that changes: changed_ids, statuses), stage = a stage id (its status), note = a note id of any stage (its status open / absorbed / dismissed; a reply counts as a change). until = the statuses to wait for (e.g. ["approved", "rejected"]); default: any change from the status it has now. Returns at once when it already is in until. Wakes on the server\'s change feed (SSE) when the server runs, else polls the files. timeout_s up to 1800 (default 600): then it returns {timed_out: true} with the current state. Sends progress notifications while waiting (clients that reset their timeout on progress keep waiting). If the workbench code changes during the wait (on disk, or the server restarts with other code) it returns at once with code_changed: true (restart / reconnect, then wait again); pages_open says whether the director has the project open.',
  inputSchema: { project, request: z.string().optional(), requests: z.array(z.string()).min(1).max(50).optional().describe('Several request ids: returns when the FIRST of them changes (or reaches until); changed lists which.'),
    stage: stageId.optional(), note: z.string().optional(), until: z.array(z.string()).optional(), timeout_s: z.number().min(1).max(1800).optional() },
}, wrap(async (a, extra) => {
  const p = await projectOf(a), which = ['request', 'requests', 'stage', 'note'].filter(k => a[k] != null);
  if (which.length !== 1) throw new S.WbError(400, 'give exactly one of request, requests, stage, note');
  const kind = which[0], id = a[kind], timeout = Math.min(1800, Math.max(1, a.timeout_s ?? 600)) * 1000;
  const until = a.until?.length ? a.until : null;
  const look = async () => {
    if (kind === 'requests') {
      const all = await op('requests_list', { project: p }), items = id.map(x => all.find(r => r.id === x) || null);
      const missing = id.filter((x, i) => !items[i]); if (missing.length) throw new S.WbError(404, `no request ${missing.map(x => `"${x}"`).join(', ')}`);
      const statuses = Object.fromEntries(items.map(r => [r.id, r.status]));
      return { status: statuses, key: JSON.stringify(statuses), statuses, items };
    }
    if (kind === 'request') { const r = (await op('requests_list', { project: p })).find(x => x.id === id); if (!r) throw new S.WbError(404, `no request "${id}"`); return { status: r.status, key: r.status, item: r }; }
    if (kind === 'stage') { const st = (await op('stages_get', { project: p })).stages.find(x => x.id === id); if (!st) throw new S.WbError(404, `no stage "${id}"`); return { status: st.status, key: st.status, item: st }; }
    const n = (await op('notes_get', { project: p, note: id })).notes[0];
    return { status: n.status, key: `${n.status}/${(n.replies || []).length}`, item: n };
  };
  const t0 = Date.now(), first = await look();
  // requests: the ids that changed (from the start, or into until)
  const hits = (s) => (kind !== 'requests' ? null : id.filter(x => (until ? until.includes(s.statuses[x]) : s.statuses[x] !== first.statuses[x])));
  const done = (s) => (kind === 'requests' ? hits(s).length > 0 : until ? until.includes(s.status) : s.key !== first.key);
  const view = (s) => (kind === 'requests' ? { statuses: s.statuses, changed_ids: hits(s), items: s.items.filter(r => hits(s).includes(r.id)) } : { item: s.item });
  const label = kind === 'requests' ? 'requests' : kind;
  if (until && done(first)) return { [label]: id, status: first.status, changed: false, already: true, waited_s: 0, ...view(first) };
  // the code under the wait: a long wait cannot tell "nothing changed" from "the workbench code changed under me" unless it
  // watches it. When the code on disk (or the running server's) changes during the wait, it returns at once: code_changed
  const code0 = S.codeState().hash, srv0 = (await server())?.code?.hash || null;
  const codeMoved = async () => { const d = S.codeState().hash; if (d !== code0) return { disk: d }; recheckServer(); const s = (await server())?.code?.hash || null; return s && srv0 && s !== srv0 ? { server: s } : null; };
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
      const pages = async () => (await server())?.pages_by_project?.[p] ?? 0;
      if (left <= 0) { const s = await look(); return { [label]: id, status: s.status, changed: s.key !== first.key, timed_out: true, waited_s: Math.round((Date.now() - t0) / 1000), pages_open: await pages(), ...view(s) }; }
      await new Promise(ok => { const t = setTimeout(ok, Math.min(left, sse ? 10000 : 2000)); wake = () => { clearTimeout(t); ok(); }; });
      const s = await look();
      if (done(s)) return { [label]: id, from: first.status, status: s.status, changed: true, waited_s: Math.round((Date.now() - t0) / 1000), ...view(s) };
      const moved = await codeMoved();
      if (moved) {
        warn(moved.disk ? 'the workbench code on disk changed during this wait (a pull, a merge, an edit): the running server is now stale; restart it (node serve.mjs) and reconnect the MCP server, then wait again' : 'the workbench server restarted with other code during this wait: reconnect the MCP server if its tools changed, then wait again');
        return { [label]: id, status: s.status, changed: s.key !== first.key, code_changed: true, ...moved, waited_s: Math.round((Date.now() - t0) / 1000), pages_open: await pages(), ...view(s) };
      }
      if (token !== undefined && Date.now() - lastProgress > 15000) { lastProgress = Date.now(); extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((Date.now() - t0) / 1000), total: Math.round(timeout / 1000), message: `waiting for ${kind} ${kind === 'requests' ? id.join(', ') : id} (${kind === 'requests' ? s.key : s.status})` } }).catch(() => {}); }
    }
  } finally { ctl.abort(); }
}));

// ------------------------------------------------------------------ the open page
mcp.registerTool('ui_focus', {
  title: 'Show something in the open page',
  description: 'Point the director\'s open workbench page at something while you talk about it: t (seek + scroll the timeline), range [t0, t1] (select a time range), view (a page or sub-view: timeline, assets, characters, locations, props, media, clips, review, approvals, queue, notes, costs, settings), select (item keys to highlight), preview (shows in the preview dock: an item key like "use:G05@20158", "shot:c1-desk", "character:ada", "media:<media id>", "compare:<clip id>", or a file path), message (a toast), play (true/false). Needs the server; returns how many pages showed it. With no page open it is queued (queued: true) and shown when the director next opens the project (the latest one, within 2 h).',
  inputSchema: { project, t: time.optional(), range: z.array(time).length(2).optional(), view: z.string().optional(), select: z.array(z.string()).optional(), preview: z.string().optional(), message: z.string().optional(), play: z.boolean().optional() },
}, wrap(async (a) => {
  if (!(await server())) throw new S.WbError(503, `the workbench server is not running at ${BASE_URL} (start it: node serve.mjs); nothing to show`);
  const p = await projectOf(a); const { project: _p, ...cmd } = a;
  if (cmd.t != null) cmd.t = S.ms(cmd.t, 't'); if (cmd.range) cmd.range = cmd.range.map(x => S.ms(x));
  const r = await http('POST', '/api/ui', p, cmd);
  return { ...r, project: p, note: r.pages ? (r.delivered ? 'shown' : 'pages are open but did not confirm in time') : `no page is open on project ${p}: queued, the next page that opens it shows this (within 2 h; a newer ui_focus replaces it). Tell the director to open ${BASE_URL}/?project=${p}` };
}));
