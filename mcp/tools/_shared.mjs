// Shared by every mcp/tools/<domain>.mjs: the transport to the workbench (HTTP to serve.mjs when it runs, else the files
// through lib/store.mjs), the per-call warnings, the result wrapper, the schemas many tools use, and the one McpServer
// object the tool modules register on (mcp/server.mjs imports them, adds the resources and the prompt, and connects).
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as S from '../../lib/store.mjs';

export const BASE_URL = (process.env.WORKBENCH_URL || 'http://localhost:8140').replace(/\/+$/, '');
const OFFLINE = process.env.WORKBENCH_OFFLINE === '1';
const VERSION = JSON.parse(fs.readFileSync(path.join(S.WB_DIR, 'package.json'), 'utf8')).version;
let current = process.env.WORKBENCH_PROJECT || null;
// the session's current project (the projects tool, action "open")
export const setCurrent = (id) => { current = id; };
// the code this MCP server loaded (its own staleness), and the code the running workbench server reports (status.code,
// header x-wb-code on every /api response): when it differs from the files on disk, the server is stale
export const MCP_CODE = S.codeState({ mcp: true });
// per tool call: warnings added to the result (a stale server, an op done offline)
const callCtx = new AsyncLocalStorage();
export const warn = (msg) => { const w = callCtx.getStore()?.warnings; if (w && !w.includes(msg)) w.push(msg); };
export const STALE = (changed) => `the running workbench server (${BASE_URL}) runs older code than the files on disk${changed?.length ? ` (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''} changed)` : ''}: restart the server (node serve.mjs in the workbench folder), then reload the page`;
function checkServerCode(hash) { if (hash && hash !== S.codeState().hash) warn(STALE(up?.code?.changed)); }

// ------------------------------------------------------------------ transport to the workbench: HTTP when it runs, files otherwise
let up = null, checkedAt = 0;
export async function server() {
  if (OFFLINE) return null;
  if (Date.now() - checkedAt < 2000) return up;
  try { const r = await fetch(BASE_URL + '/api/status', { signal: AbortSignal.timeout(800) }); const j = await r.json(); up = j.app === 'director-workbench' ? j : null; }
  catch (e) { up = null; }
  checkedAt = Date.now(); return up;
}
// the next server() asks the server again instead of the answer cached for 2 s (the status tool)
export const recheckServer = () => { checkedAt = 0; };
// S9: the server accepts an agent's write with the AGENT token (header x-wb-agent-token), which it keeps in
// <data folder>/.wb-agent-token (or env WB_AGENT_TOKEN). The server can then always tell this MCP server from the page:
// whatever a tool sends, it is an agent (never the director). The data folder is the one the server reports
// (/api/status data_dir), else this process's (WORKBENCH_DATA). The page's token is never read.
let token = process.env.WB_AGENT_TOKEN || null;
async function getToken(fresh = false) {
  if (token && !fresh) return token;
  const dirs = [...new Set([up?.data_dir, S.DATA_ROOT].filter(Boolean))];
  for (const d of dirs) { try { const t = fs.readFileSync(path.join(d, '.wb-agent-token'), 'utf8').trim(); if (t) { token = t; return token; } } catch (e) { /* next */ } }
  throw new S.WbError(503, `no agent token: ${dirs.map(d => path.join(d, '.wb-agent-token')).join(' or ')} not found (the workbench server writes it at start; or set WB_AGENT_TOKEN)`);
}
export async function http(method, p, project, body, timeout = 15000) {
  const u = `${BASE_URL}${p}${p.includes('?') ? '&' : '?'}project=${encodeURIComponent(project)}`;
  if (body !== undefined && !up) await server();   // its data_dir: where the agent token is
  const go = async (fresh) => fetch(u, { method, signal: AbortSignal.timeout(timeout),
    ...(body !== undefined ? { headers: { 'content-type': 'application/json', 'x-wb-agent-token': await getToken(fresh) }, body: JSON.stringify(body) } : {}) });
  let r = await go(false), j = await r.json().catch(() => ({}));
  checkServerCode(r.headers.get('x-wb-code'));
  if (r.status === 403 && body !== undefined && /wrong token/.test(j.error || '') && !process.env.WB_AGENT_TOKEN) { r = await go(true); j = await r.json().catch(() => ({})); }   // the token file changed: read it again
  if (!r.ok) throw new S.WbError(r.status, j.error || `HTTP ${r.status}`);
  return j;
}
export async function projectOf(args) { return args?.project || current || (await server())?.default_project || S.CFG.defaultProject; }
export async function op(name, args = {}) {
  const { project: _p, ...a } = args; const p = await projectOf(args);
  // ops that may run ffprobe/ffmpeg (thumbnails) get a long timeout, so a slow video does not look like a failure
  if (await server()) {
    try { return await http('POST', '/api/op/' + name, p, a, ['media_add', 'media_update', 'media_import', 'media_scan', 'request_update', 'entity_upsert', 'song_attach', 'sketch_save', 'character_iteration_add', 'asset_iteration_add', 'look_create', 'variant_create', 'sheet_make', 'song_version_add', 'project_export', 'project_import'].includes(name) ? 180000 : 15000); }
    catch (e) {
      // the server runs older code that does not know this op: do it on the files directly (its file watcher still
      // reloads the open pages) and say so
      if (e.code === 404 && /^no such op/.test(e.message) && Object.hasOwn(S.ops, name)) { warn(`${STALE(up?.code?.changed)}. It does not know "${name}": done on the files directly (offline) instead`); S.lockGate(p, name, a); return await S.ops[name](p, a); }
      throw e;
    }
  }
  S.lockGate(p, name, a);   // offline: a project locked for render refuses agent writes here too (409)
  return await S.ops[name](p, a);
}
const warnBlock = (w) => (w.length ? [{ type: 'text', text: 'warning: ' + w.join('\nwarning: ') }] : []);
const ok = (v, w = []) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }, ...warnBlock(w)] });
const err = (e, w = []) => ({ isError: true, content: [{ type: 'text', text: `error${e.code ? ' ' + e.code : ''}: ${e.message || e}` }, ...warnBlock(w)] });
// every tool: its result, plus a "warning: ..." block when the server is stale or an op was done offline
export const wrap = (fn) => (args, extra) => callCtx.run({ warnings: [] }, async () => { const w = callCtx.getStore().warnings; try { return ok(await fn(args || {}, extra), w); } catch (e) { return err(e, w); } });

// ------------------------------------------------------------------ schemas shared by many tools
export const project = z.string().optional().describe('Project id (a folder in data/). Default: the session\'s current project (see the `projects` tool, action "open"), else the server\'s default.');
export const time = z.union([z.number(), z.string()]).describe('Song time: integer milliseconds (61230) or "m:ss.mmm" ("1:01.23").');
export const by = z.string().optional().describe('Who is writing (default "agent"). Use "director" only when you relay the director\'s own words.');
export const stageId = z.enum(['lyrics', 'script', 'breakdown', 'characters', 'scenery', 'storyboard', 'final']);
export const charId = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/).describe('Character entity id (character_get without id lists them).');
export const treeId = z.string().regex(/^(identity|look:[A-Za-z0-9_][A-Za-z0-9_-]{0,63})$/).describe('"identity" or "look:<look id>".');
export const assetType = z.enum(['character', 'location', 'prop']);
export const assetTree = z.string().regex(/^(identity|base|look:[A-Za-z0-9_][A-Za-z0-9_-]{0,63}|variant:[A-Za-z0-9_][A-Za-z0-9_-]{0,63})$/).describe('A tree: the root ("identity" for a character, "base" for a location / prop) or a variant ("look:<id>" for a character, "variant:<id>" for a location / prop).');
export const pinsSchema = z.array(z.object({ n: z.number().optional(), x: z.number(), y: z.number(), text: z.string() }));

// the one MCP server: every mcp/tools/<domain>.mjs registers its tools on it when imported
export const mcp = new McpServer({ name: 'director-workbench', version: VERSION }, {
  instructions: 'Director Workbench: a time-synced view of a music video project (song, lyrics, script, shots, clips, characters/looks/locations/props, media, notes, approvals, a generation queue and a cost cap). '
    + 'Start with `status`, then `song_get` / `timeline_query`. All times are integer ms. Never spend money on generation unless a request in the queue is APPROVED by the director (request_run runs approved ones: dry_run first; it moves them queued -> running -> done with outputs and the actual cost). '
    + 'Use ui_focus to show the director what you are talking about in the open page. Read the resource workbench://docs/claude for the full workflow.',
});
