// MCP tools: E4 render jobs and E8 contact sheets + second opinions (lib/ops/renders.mjs, js/renders.js). The agent proposes
// a render and reviews sheets; setting the render command, starting and cancelling a render are the director's, in the page
// (render_config / render_start / render_cancel: no tool), and asking for a second opinion is the director's button.
import { z } from 'zod';
import { mcp, op, wrap, project, time, by } from './_shared.mjs';

mcp.registerTool('renders_get', {
  title: 'Render jobs, settings and sheets',
  description: 'Read only. The render settings the director set (the command as an argv list with {placeholders}, its folder, the warm-up, the RAM floor, workers, size; '
    + 'set: false = none yet), the machine (free RAM now, the render lock: one render at a time), the render jobs (requests of kind "render": scope excerpt | chapter | full, '
    + 't0 / t1, status draft | running | done | failed, run {phase waiting_ram | warming | rendering | sheets | done | failed, ram, out, sheets, revision}, outputs, '
    + 'the log\'s tail of a running one, or of `id`), the etiquette\'s order (chapters not rendered yet: the full film comes after them), and the sheets with their latest '
    + 'review and open second-opinion asks. A render is local and costs $0, but it is heavy: you propose one (render_propose) and the director starts it in the page.',
  inputSchema: { project, id: z.string().optional().describe('a render request id: its full log tail'), log_lines: z.number().int().optional() },
}, wrap((a) => op('renders_get', a)));

mcp.registerTool('render_propose', {
  title: 'Propose a render job',
  description: 'A render job as a DRAFT request of kind "render" in the queue: scope "excerpt" (t0 / t1, at most 20 s: PRODUCTION.md), "chapter" (a storyboard chapter id: '
    + 'its scenes\' time range) or "full" (the whole song; the etiquette renders every chapter first). why = what it is for ("check the seam ch2 -> ch3"). '
    + 'You never start it and never give a command: the director presses Render… in the page (Final › Renders or Review › Queue) after a confirm, and the workbench runs '
    + 'THEIR render command (one at a time, only with enough free RAM, the warm-up first). Its outputs (the MP4, a contact sheet, a seams sheet) are registered as media '
    + 'linked to the request and the revision; then review the sheets (sheets_get, sheet_review).',
  inputSchema: { project, scope: z.enum(['excerpt', 'chapter', 'full']), t0: time.optional(), t1: time.optional(), chapter: z.string().optional(), why: z.string().optional(), by },
}, wrap((a) => op('render_propose', { ...a, t0: ms(a.t0), t1: ms(a.t1) })));

mcp.registerTool('sheet_make', {
  title: 'Make a contact sheet',
  description: 'A contact sheet with ffmpeg (free, local): from "render" (id = a done render request: one frame every `every` s of the range t0 / t1 inside it, labelled with '
    + 'the song time), "request" (id = a request: its takes, one tile each) or "storyboard" (one tile per shot in t0 / t1: its picked take, frame sketch or thumbnail, else a '
    + 'placeholder with its id). Written to sheets/<generated id>.jpg (private/sheets/ when a source is private), registered as media (kind sheet) and in renders.json '
    + 'with the time of each frame. Returns the absolute file: look at it.',
  inputSchema: { project, from: z.enum(['render', 'request', 'storyboard']), id: z.string().optional(), t0: time.optional(), t1: time.optional(), every: z.number().optional(), cols: z.number().int().optional(), title: z.string().optional(), by },
}, wrap((a) => op('sheet_make', { ...a, t0: ms(a.t0), t1: ms(a.t1) })));

mcp.registerTool('sheets_get', {
  title: 'Contact sheets to review',
  description: 'Read only. The sheets (or one: sheet) with the absolute file and, per frame, its song time and what it should show: the scene (title, text), the storyboard shot '
    + '(title, kind, text, cast) and the lyric line sung then; the constants checklist of every character on screen (with the approved identity image); the reviews so far '
    + 'and the open "second opinion" asks (notes to you, ask "review", about "sheet:<id>"). Open the file, compare each frame, then sheet_review.',
  inputSchema: { project, sheet: z.string().optional() },
}, wrap((a) => op('sheets_get', a)));

mcp.registerTool('sheet_review', {
  title: 'Review a contact sheet (second opinion)',
  description: 'Your review of a sheet against the script and the constants: verdict ok | issues | fail, items [{t (song ms of the frame), shot?, constant? (the constant or '
    + '"likeness" / "lyric" / "continuity"), ok, note}] (one per thing you checked; "ok" only when every item holds), note (the summary). Stored in renders.json with the sheet '
    + '(via agent); it absorbs the open second-opinion asks on that sheet with your summary as the reply. Advice only: it never approves, rejects or picks anything.',
  inputSchema: { project, sheet: z.string(), verdict: z.enum(['ok', 'issues', 'fail']),
    items: z.array(z.object({ t: time.optional(), shot: z.string().optional(), constant: z.string().optional(), ok: z.boolean(), note: z.string().optional() })).optional(), note: z.string().optional(), by },
}, wrap((a) => op('sheet_review', { ...a, ...(a.items ? { items: a.items.map(x => ({ ...x, ...(x.t != null ? { t: ms(x.t) } : {}) })) } : {}) })));

// "m:ss.mmm" -> ms (the ops take ms)
function ms(v) {
  if (v == null || typeof v === 'number') return v;
  const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(v).trim());
  return m ? Math.round((Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) : Number(v);
}
