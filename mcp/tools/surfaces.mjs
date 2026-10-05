// MCP tools: the lyric gate (lib/ops/surfaces.mjs, js/surfaces.js; ROADMAP_v4 E2). The agent reads the gate and proposes
// where a lyric line / word range appears on screen; accepting a surface is the director's, in the page (surface_act: no tool).
import { z } from 'zod';
import { mcp, op, wrap, project, by } from './_shared.mjs';

mcp.registerTool('surfaces_get', {
  title: 'The lyric gate: every word on a surface?',
  description: 'Read only. "Every sung or spoken word appears on a desktop surface at its time." For each lyric line of the song: its words with covered true / false and, '
    + 'when covered, on [{shot, where}] (the storyboard shot showing it and where: window title, chat, dialog, karaoke, taskbar, other); off_time = a surface on a shot that is '
    + 'not on screen when the word is sung (it does not count). Also: ok (all covered), total / covered word counts, uncovered runs [{line, w [first, last], time, text}], '
    + 'the shots with their surfaces (shot.lyrics [{line, w?, where}]), your proposals and their status. Filters: line, shot, uncovered (only lines with gaps). '
    + 'Fill the gaps with surface_propose; the director accepts in the page. Final\'s checklist line "every word on a surface" reads the same.',
  inputSchema: { project, line: z.string().optional().describe('one lyric line id ("verse/0")'), shot: z.string().optional().describe('one storyboard shot id'),
    uncovered: z.boolean().optional().describe('only the lines with uncovered words') },
}, wrap((a) => op('surfaces_get', a)));

mcp.registerTool('surface_propose', {
  title: 'Propose where lyrics appear on screen',
  description: 'Propose a surface for a lyric line (or a word range of it) on a storyboard shot: where the words appear on the desktop while they are sung. '
    + 'where = "<kind>" or "<kind>: <detail>", kind one of window (a window title), chat, dialog, karaoke, taskbar, other ("chat: Notepad, typed letter by letter"; ≤ 120 characters). '
    + 'w = [first, last] word index on the line (0-based; leave it out for the whole line). The words must be sung during the shot (else 400: pick the shot on screen then). '
    + 'Written to surfaces.json as an open proposal the director accepts or dismisses in the page (Storyboard › Shot › Lyrics on screen); the same surface again updates its why. '
    + 'This never writes the shot: shots_update ignores lyrics (warning).',
  inputSchema: { project, shot: z.string().describe('the storyboard shot on screen while the words are sung'), line: z.string().describe('the lyric line id (song_get / surfaces_get)'),
    w: z.array(z.number().int().min(0)).length(2).optional().describe('[first, last] word index on the line; omit for the whole line'),
    where: z.string().describe('"window: Untitled - Notepad" | "chat" | "dialog: Error 0x0" | "karaoke" | "taskbar" | "other: …"'),
    why: z.string().describe('one sentence: what the surface shows and why there'), by },
}, wrap((a) => op('surface_propose', a)));
