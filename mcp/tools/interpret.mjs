// MCP tools: E10, the agent's interpretation next to the director's verbatim words (lib/ops/interpret.mjs, js/interpret.js).
// The agent writes its reading; accepting or editing it is the director's, in the page (interpretation_act: no tool).
import { z } from 'zod';
import { mcp, op, wrap, project, by } from './_shared.mjs';

mcp.registerTool('interpretation_set', {
  title: 'Write your interpretation of an intake answer or a note',
  description: 'The director\'s words stay verbatim (an intake answer\'s text, a note\'s text); your reading of them goes next to them, marked as yours: '
    + 'what you understand they want, in concrete terms you will act on ("dream-pop, warm but sad" -> "slow dolly moves, tungsten practicals, '
    + 'no hard cuts in the verses"). key = an intake question id (it needs an answer first), or note = a note id (notes_get). Stored as '
    + 'interpretation {text, by, via: "agent", at, status: "proposed"}; the page shows it under the verbatim words, and the director accepts '
    + 'or edits it there (you cannot: no tool). Writing again replaces your proposal (an accepted one goes back to proposed); one the director '
    + 'edited is their words now (409: reply in a note instead). intake_get and notes_get return the interpretation with its status.',
  inputSchema: { project, key: z.enum(['mood', 'kind', 'who', 'where', 'era', 'refs', 'must', 'mustnot', 'budget']).optional().describe('the intake question'),
    note: z.string().optional().describe('a note id (notes_get)'), text: z.string().describe('your interpretation, up to 4000 characters'), by },
}, wrap((a) => op('interpretation_set', a)));
