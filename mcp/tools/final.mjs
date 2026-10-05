// MCP tools: stage 7, final approvals (lib/ops/final.mjs, js/final.js; ROADMAP_v4 C1-C4). Read only: approving, requesting
// changes and "Lock for render" / "Unlock" are the director's, in the page (no tool for final_lock / final_unlock).
import { z } from 'zod';
import { mcp, op, wrap, project } from './_shared.mjs';

mcp.registerTool('final_get', {
  title: 'Final approvals: what is left',
  description: 'Read only. What stands between the project and the render: {ready, locked (the lock {revision, at, summary} or null), failing [check ids], '
    + 'checklist [{id: scripted | shots | frames | takes (every shot has a picked take) | lyrics (every word on a surface: the lyric gate, surfaces_get) | assets | notes | round | cap | export, ok, label, detail, warn?, gaps [the rows that fail]}] (derived from the files, never stored), '
    + 'counts {total, draft, review, changes, notes, by_group}, costs {cap, spent (the merged ledger), committed, drafts, to_request (shots without a request or clip), est_remaining, projected, left, within, projected_within, warnings}, '
    + 'pending [{key, group (lyrics | script | breakdown | characters | scenery | storyboard | requests), kind, id, title, sub, time?, status (the file\'s word), st (draft | review | changes), why, est_usd, spent_usd, notes_open, approvable}]}. '
    + 'Use it to tell the director what is left and to pick your next task (draft requests, answer notes, propose shots or assets). You cannot approve anything: the director approves in the page (Final stage). '
    + 'A locked project refuses every write (409) until the director unlocks it.',
  inputSchema: { project,
    group: z.enum(['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'requests']).optional().describe('only this group of the pending list'),
    status: z.enum(['draft', 'review', 'changes']).optional().describe('only rows in this state'),
    notes: z.boolean().optional().describe('only rows with open notes'),
    limit: z.number().optional().describe('max pending rows (default 200)') },
}, wrap((a) => op('final_get', a)));
