// MCP tools: take selection (lib/ops/takes.mjs, js/takes.js; ROADMAP_v4 D6). The agent reads the takes and proposes one
// with in / out points; the pick is the director's, in the page (take_act: no tool).
import { z } from 'zod';
import { mcp, op, wrap, project, time, by } from './_shared.mjs';

mcp.registerTool('takes_get', {
  title: 'Takes of a shot or a request',
  description: 'Read only. Every take of a storyboard shot (shot) or of a request (request): the registered media that can play in it (runner outputs gen/<request>/<request>_<take>.<ext>, '
    + 'and imported files linked to the shot, its clip uses or a request targeting "shot:<id>"): [{media, file, abs (absolute path: look at it), kind video | image, take, request, '
    + 'duration_ms, fps, w, h, thumb, source runner | import, picked, in_ms / out_ms when picked, alt_for [{t, note}]}]; picked = the director\'s pick on the shot '
    + '(shot.clip {request, take, file, in_ms, out_ms, note, alt [{take, file, t, note}]}) and how it fits the shot\'s length; proposals = your take proposals and their status. '
    + 'Review the takes (look at the files), then propose the best with take_propose. You never pick: the director does, in the page.',
  inputSchema: { project, shot: z.string().optional().describe('a shot id of the storyboard (storyboard_get)'), request: z.string().optional().describe('a request id: its outputs as takes') },
}, wrap((a) => op('takes_get', a)));

mcp.registerTool('take_propose', {
  title: 'Propose a take for a shot (in / out + why)',
  description: 'Propose which take a shot should use and the part of it (in_ms / out_ms: ms inside the take file, 0 <= in < out <= its duration_ms; leave out_ms out for the end; a still has no in / out), '
    + 'with why (what you saw: "take 0: the smile lands at 0.6 s; take 1 has a door wipe"). Name the take by media (id) or file (from takes_get), or by take (+ request when ambiguous). '
    + 'It must be a take of that shot (registered media linked to it). Written to takes.json as an open proposal the director picks with one click (or not); the same take and range again updates its why. '
    + 'This never picks: the pick and the shot\'s approval are the director\'s, in the page. To flag an alternative for a moment of the song, say it in why ("alternative for 139.84 s").',
  inputSchema: { project, shot: z.string(), media: z.string().optional().describe('media id of the take (takes_get)'), file: z.string().optional().describe('its file path (takes_get file)'),
    take: z.number().int().min(0).optional().describe('the take number (with request when the shot has several requests)'), request: z.string().optional(),
    in_ms: time.optional().describe('in-point inside the take (ms or m:ss.mmm); default 0'), out_ms: time.optional().describe('out-point inside the take; default its end'),
    why: z.string().describe('one or two sentences: what makes this take and range the right one'), by },
}, wrap((a) => op('take_propose', a)));
