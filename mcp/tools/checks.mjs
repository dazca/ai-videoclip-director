// MCP tools: identity checks (lib/ops/checks.mjs, js/checks.js; ROADMAP_v4 D7). The agent looks at an output next to the
// approved identity and writes what it saw against the character's constants checklist; the director sees a badge on the
// node / take and decides. A check never approves, rejects or picks anything.
import { z } from 'zod';
import { mcp, op, wrap, project, by } from './_shared.mjs';

const target = z.object({ kind: z.enum(['node', 'take', 'media']), id: z.string() })
  .describe('What you checked: node "<character>/<node>" (an iteration node, e.g. "ada/n05"), take "<shot>/<media id>" (a take of a storyboard shot: takes_get), media "<media id>" (any registered image or video). The "identity check" ask names it for each output.');

mcp.registerTool('check_add', {
  title: 'Write an identity check (vision, against the constants checklist)',
  description: 'After looking at an output (open the file) next to the character\'s approved identity image, write what you saw: one item per constant of its checklist '
    + '(checks_get {entity} gives the checklist, the identity image and the absolute files) with ok true / false and a short note ("clip on the RIGHT side"), plus "likeness" for the face as a whole; '
    + 'verdict ok (every constant holds), drift (it holds but is drifting) or fail. It shows as a badge on the node / take ("identity ok", "drift", "✗ clip side"; hover: the items). '
    + 'When every output of an "identity check" ask is checked, the ask is absorbed with the results. Writes checks.json only: it NEVER approves, rejects or picks anything; the director decides. '
    + 'score is the optional local face-embedding score (tools/face-score.md), only if such a tool ran; never invent one.',
  inputSchema: { project, target,
    against: z.object({ entity: z.string().describe('the character id'), node: z.string().optional().describe('the node compared with (default: its approved identity node)') }),
    verdict: z.enum(['ok', 'drift', 'fail']),
    items: z.array(z.object({ constant: z.union([z.string(), z.number().int()]).describe('a constant of the checklist (its text, its label, or its index), or "likeness"'), ok: z.boolean(), note: z.string().optional() })).optional(),
    note: z.string().optional().describe('one or two sentences for the director'),
    score: z.object({ model: z.string(), value: z.number(), threshold: z.number().optional(), metric: z.string().optional() }).optional().describe('ONLY from a local face-embedding tool that actually ran (tools/face-score.md)'),
    by },
}, wrap((a) => op('check_add', a)));

mcp.registerTool('checks_get', {
  title: 'Identity checks, open asks and the checklists',
  description: 'Read only. enabled = the project asks for identity checks when outputs land (settings.json identity_checks, the director\'s switch in the Characters stage); '
    + 'checks (filter by target, entity, verdict), latest = the badge per target, asks = the open "identity check" asks with each output (file, absolute path, the target to name) and what is still unchecked, '
    + 'checklist per character: its approved identity node + image (absolute: look at it) and the constants to check (+ "likeness").',
  inputSchema: { project, target: target.optional(), entity: z.string().optional(), verdict: z.enum(['ok', 'drift', 'fail']).optional(), limit: z.number().int().min(1).max(1000).optional() },
}, wrap((a) => op('checks_get', a)));
