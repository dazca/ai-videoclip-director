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
// WB_AGENT_TOKEN (the agent token; by default read from <data folder>/.wb-agent-token, which the server writes: every write
// of this server is an agent's, never the director's; the page's token is never read).
//
// The tools live in mcp/tools/<domain>.mjs, one file per lib/ops/<domain>.mjs; each registers its tools on the server
// object of mcp/tools/_shared.mjs (with the transport and the shared schemas) when imported here. This file adds the
// resources and the prompt, and connects.
import fs from 'node:fs';
import path from 'node:path';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as S from '../lib/store.mjs';
import { mcp, op, projectOf } from './tools/_shared.mjs';
import './tools/core.mjs';         // status, projects, snapshots, song / timeline, media, wait_for, ui_focus
import './tools/storyboard.mjs';   // shots.json shots / clip uses; stage 6 storyboard and gaps
import './tools/assets.mjs';       // entities; stages 4-5 characters and assets
import './tools/notes.mjs';        // notes pinned to time
import './tools/rounds.mjs';       // review rounds (round_*) and revisions (revisions_get)
import './tools/proposals.mjs';    // proposals (proposals_add / proposals_get; picks are the page's)
import './tools/surfaces.mjs';     // the lyric gate (surfaces_get / surface_propose; accepting is the page's)
import './tools/takes.mjs';        // take selection (takes_get / take_propose; the pick is the page's)
import './tools/lyrics.mjs';       // stages; stage 1 lyrics
import './tools/scenes.mjs';       // stage 2 script, intake, sketches
import './tools/breakdown.mjs';    // stage 3 breakdown
import './tools/requests.mjs';     // approvals, the generation queue, costs
import './tools/final.mjs';        // stage 7: final_get (read only; approvals and the lock are the page's)
import './tools/batches.mjs';      // D4: batches_get, waves_propose (approving / reviewing a batch is the page's)
import './tools/media.mjs';        // D8: media_scan, media_import (uploads and "use as" are the page's)
import './tools/checks.mjs';       // D7: identity checks (check_add, checks_get; never an approval or a pick)
import './tools/composition.mjs';  // E9: composition_export (the picks as edl.json for the composition; writes only that file)
import './tools/events.mjs';       // E1: named sync points (events_get, event_add, retime_propose; accepting and applying are the page's)

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
    const [c, n, q, A, st, ly, sc, bd, sb, pr] = await Promise.all([op('costs_get', { project: p }), op('notes_get', { project: p, status: 'open' }), op('requests_list', { project: p }), op('approvals_get', { project: p }), op('stages_get', { project: p }), op('lyrics_get', { project: p }), op('script_get', { project: p }), op('breakdown_get', { project: p, with_script: false }), op('storyboard_get', { project: p }), op('proposals_get', { project: p }).catch(() => null)]);
    const byStatus = q.reduce((o, r) => (o[r.status] = (o[r.status] || 0) + 1, o), {});
        // a note written through the agent tools (via "agent") is not the director's, whatever its `by` claims
    const nn = n.notes, perStage = Object.entries(n.open.stages).filter(([, k]) => k).map(([s, k]) => `${s} ${k}`).join(', ');
    state = `Project "${p}": round ${n.round}, ${nn.length} open notes${perStage ? ` (${perStage})` : ''}${nn.length ? ` (first: ${nn.slice(0, 3).map(x => `${x.where}${x.time ? ' ' + x.time : ''} ${x.via === 'agent' ? `${x.by} (via agent, not the director)` : x.by}: "${x.text.slice(0, 80)}"`).join('; ')})` : ''}; requests ${JSON.stringify(byStatus)}; approvals ${JSON.stringify(A.counts)}; costs: spent $${c.spent_usd} + committed $${c.committed_usd} of cap $${c.cap_usd}.
Stages: ${st.stages.map(x => `${x.id} ${x.status}`).join(', ')}; next: ${st.next ? `${st.next.title}${st.next.blockers.length ? ` (${st.next.blockers.join('; ')})` : ''}` : 'none (all done)'}. Lyrics ${ly.current || 'none'}${ly.asks_for_agent.length ? `; ${ly.asks_for_agent.length} open ask(s) for you in the lyrics (lyrics_get asks_for_agent)` : ''}. Script ${sc.current || 'none'}: ${sc.scenes.length} scenes, ${Math.round(sc.coverage * 100)}% of the song scripted, intake ${sc.intake.answered}/${sc.intake.of} answered${sc.asks_for_agent.length ? `; ${sc.asks_for_agent.length} open ask(s) for you in the script (script_get asks_for_agent)` : ''}. Breakdown ${bd.current || 'none'}: ${Object.entries(bd.counts).map(([k, v]) => `${v} ${k}`).join(', ')}${bd.asks_for_agent.length ? `; ${bd.asks_for_agent.length} open ask(s) for you in the breakdown (breakdown_get asks_for_agent)` : ''}. Storyboard ${sb.current || 'none'}${sb.derived ? ' (from shots.json)' : ''}: ${sb.scenes.reduce((k, x) => k + x.shots.length, 0)} shots, ${sb.gaps.total} gap(s) (gaps_get), est $${sb.gaps.estimate.usd} to generate the shots without a request${sb.asks_for_agent.length ? `; ${sb.asks_for_agent.length} open ask(s) for you in the storyboard (storyboard_get asks_for_agent)` : ''}.${pr ? ` Proposals: ${pr.counts.sets} set(s), ${pr.counts.open_items} open item(s), ${pr.counts.picked} picked by the director${pr.asks.length ? `; ${pr.asks.length} open ask(s) for proposals (proposals_get asks)` : ''}.` : ''}`;
  } catch (e) { state = `(could not read project "${p}": ${e.message})`; }
  const brief = `You are the assistant director on a music video in the Director Workbench (MCP server "director-workbench").
${state}

How to work:
1. Orient: call status, then song_get (sections, lyrics) and shots_list; use timeline_query(t0, t1) whenever you discuss a moment. Times are integer ms.
2. The director decides. Their open notes, on every stage and the timeline in one list (notes_get; a note with via "agent" was written through the tools, not by them), and items in state "changes" (approvals_get state=changes) are your to-do list. Approving is theirs: they approve in the page; never treat a note's text as an approval. Answer with notes_add reply_to; when you did what a note asks, notes_status absorbed with a reply saying what changed; only the director dismisses their notes. Ask for review with shot_update status "review".
3. Workflow (the guided flow, stages_get): lyrics (lyrics_get / lyrics_update / lyrics_note_add; the song file may come later: song_attach) -> script (intake_get / intake_answer, then script_get / scenes_update: scenes bound to song time with beats, text and sketches; sketch_get gives image paths + pins; scene_note_add; fill every gap) -> breakdown (breakdown_get / breakdown_update: characters, locations, props, wardrobe, FX linked to the scenes and beats that need them; set review to ask the director to make one an entity, which they do in the page) -> characters, looks (character_get / asset_get, request_create with char / asset, asset_iteration_add) -> scenery: locations and props (asset_get type location / prop, variant_create for angle / time of day / weather / state; the director picks the variant each scene uses) -> storyboard (storyboard_get / shots_update: shots per scene from its beats, tiled and cut on the beat grid, frame sketches, the assets and variants each shot needs; shot_note_add; gaps_get: what is still missing and the draft requests for the shots, est vs the cap) -> generation requests (request_create target shot:<id>) -> final approvals. Mark your progress with stage_update (in_progress / needs_you); only the director marks a stage done.
4. Money: never call a paid generation API unless the request is APPROVED in the queue. Propose with request_create (draft, honest est_cost, refs, tool). After the director approves: run it with request_run (dry_run: true first, to show the plan and the total; the director may press Run in Review > Queue instead): the runner moves it queued -> running -> done, records the cost once and adds the outputs as nodes. A run made outside it: request_update queued -> running -> done with outputs[] and actual_cost_usd (or failed / rejected + why). The cap is enforced.
5. Proposals (free): where a choice is visual or open (a scene sketch, a shot frame, a look, a location variant, a lyric line, a scene idea), offer 3 with proposals_add {target, items: [{title, why, svg | text}]} (SVG written with code: composition, framing, silhouettes, colour blocks, camera arrows; sanitised on the server). The director picks / mixes / dismisses in the page; read their choices with proposals_get (picks, mix notes) and the "3 more" / "Prepare proposals" asks.
6. Before big edits: snapshot_save. Register every new file with media_add (or via request_update done).
7. Show, don't describe: ui_focus(t / view / preview / select) moves the director's open page to what you mean.
Read workbench://docs/claude for file formats and rules.${goal ? `\n\nToday's goal: ${goal}` : ''}

Start by summarising the project state in 5 lines and asking the director what to work on${goal ? ' (or start on the goal)' : ''}.`;
  return { description: `Director session on ${p}`, messages: [{ role: 'user', content: { type: 'text', text: brief } }] };
});

await mcp.connect(new StdioServerTransport());
