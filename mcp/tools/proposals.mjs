// MCP tools: proposals (lib/ops/proposals.mjs, js/proposals.js; docs/SPEC_v4_NOTES_ROUNDS.md §3). The agent adds sets
// of free choices and reads the director's picks; picking, mixing and dismissing are the director's, in the page: there
// is no tool for proposal_act.
import { z } from 'zod';
import { mcp, op, wrap, project, by } from './_shared.mjs';

const target = z.object({
  stage: z.enum(['lyrics', 'script', 'storyboard', 'characters', 'scenery']),
  kind: z.enum(['line', 'section', 'scene', 'shot', 'asset', 'tree']),
  id: z.string(),
}).describe('What the proposals are for: a scene sketch or idea {stage: "script", kind: "scene", id: "sc02"}; a shot frame {stage: "storyboard", kind: "shot", id}; a lyric line {stage: "lyrics", kind: "line", id: "verse/0"}; a look {stage: "characters", kind: "tree", id: "ada/look:night"}; a location variant {stage: "scenery", kind: "tree", id: "studio/variant:dusk"}; an asset {kind: "asset", id}.');

mcp.registerTool('proposals_add', {
  title: 'Add proposals',
  description: 'Attach a set of choices to a target so the director picks instead of starting from a blank page: by default 3 items, each {title (≤80), why (one line of rationale), svg | text}. svg = a small SVG you write with code (composition, framing, rule-of-thirds silhouettes, colour blocks, a camera arrow; a viewBox like "0 0 160 90" for 16:9; ≤64 KB): it is sanitised on the server with an allow-list (shapes, paths, text, gradients, markers, <use href="#id">; no script, foreignObject, image, links, on* handlers, external refs or url() except url(#id)); a rejected SVG returns the reason, fix and retry. text = a short alternative (a lyric line, a scene idea, a shot action). Free: no image model. Answers an open "3 more" ask on the same target. Returns what changed (the set id, the files written). Picking is the director\'s, in the page.',
  inputSchema: { project, target, items: z.array(z.object({ title: z.string(), why: z.string().optional(), svg: z.string().optional(), text: z.string().optional() })).min(1).max(6), by },
}, wrap((a) => op('proposals_add', a)));

mcp.registerTool('proposals_get', {
  title: 'Get proposals',
  description: 'The proposal sets (newest first) with each item\'s status (open | picked | mixed | dismissed), its SVG file (svg, svg_file, svg_url) or text, the director\'s picks (`picks`: what they chose, and for a mix the note saying what to change) and the open asks for proposals (`asks`: a "3 more" on a target, or a stage-wide "Prepare proposals"). Filters: target, stage, open (only sets with an open item), set. Read only.',
  inputSchema: { project, target: target.optional(), stage: z.enum(['lyrics', 'script', 'storyboard', 'characters', 'scenery']).optional(), open: z.boolean().optional(), set: z.string().optional() },
}, wrap((a) => op('proposals_get', a)));
