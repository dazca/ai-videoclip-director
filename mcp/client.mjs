#!/usr/bin/env node
// The quickest way for any agent, script or shell to call a workbench MCP tool: spawns mcp/server.mjs over stdio with the
// official SDK client, calls one tool, prints its result, exits (1 on a tool error). Works from any folder.
//   node <workbench>/mcp/client.mjs <tool> ['<json args>'] [--project <id>] [--offline] [--url http://localhost:8140]
//   node <workbench>/mcp/client.mjs --list                       the tools and their one-line titles
//   node <workbench>/mcp/client.mjs status
//   node <workbench>/mcp/client.mjs requests_list '{"status":"draft"}' --project my-song
//   node <workbench>/mcp/client.mjs cost_record '{"usd":0.24,"via":"falgen","job":"HV1"}'     (a runner's hook)
//   node <workbench>/mcp/client.mjs wait_for '{"request":"r123","until":["approved","rejected"],"timeout_s":1800}'
// The JSON may also come from a file (@args.json) or stdin (-). Output: the tool's text (JSON for most tools); a
// "warning: ..." block (a stale server, an op done offline) goes to stderr. Env as for the server (WORKBENCH_URL,
// WORKBENCH_DATA, WORKBENCH_PROJECT, WORKBENCH_OFFLINE, WB_TOKEN).
// From another ESM script, import the SDK through a file URL (a bare specifier resolves only inside the workbench):
//   const { Client } = await import(pathToFileURL(path.join(WB, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the SDK from the workbench's own node_modules (pathToFileURL: Windows paths are not import specifiers)
const sdk = (p) => import(pathToFileURL(path.join(HERE, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);
const { Client } = await sdk('client/index.js');
const { StdioClientTransport } = await sdk('client/stdio.js');

const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(k); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (k) => { const i = argv.indexOf(k); if (i < 0) return false; argv.splice(i, 1); return true; };
const project = opt('--project'), url = opt('--url'), offline = flag('--offline'), list = flag('--list'), help = flag('--help') || flag('-h');
const [tool, raw] = argv;
if (help || (!tool && !list)) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); process.exit(tool || list ? 0 : 2); }
let args = {};
try {
  const text = raw == null ? '' : raw === '-' ? fs.readFileSync(0, 'utf8') : raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
  args = text.trim() ? JSON.parse(text) : {};
} catch (e) { console.error(`bad JSON arguments: ${e.message}`); process.exit(2); }
if (!args || typeof args !== 'object' || Array.isArray(args)) { console.error('the arguments must be a JSON object'); process.exit(2); }
if (project && args.project == null) args.project = project;

const env = { ...process.env, ...(project ? { WORKBENCH_PROJECT: project } : {}), ...(url ? { WORKBENCH_URL: url } : {}), ...(offline ? { WORKBENCH_OFFLINE: '1' } : {}) };
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, 'server.mjs')], env, stderr: 'inherit' });
const client = new Client({ name: 'workbench-cli', version: '1' });
let code = 0;
try {
  await client.connect(transport);
  if (list) {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name.padEnd(26)} ${t.title || ''}`);
  } else {
    // wait_for may block up to 30 min: the request timeout follows its timeout_s
    const timeout = tool === 'wait_for' ? (Math.min(1800, Number(args.timeout_s) || 600) + 60) * 1000 : 600000;
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout, resetTimeoutOnProgress: true });
    for (const c of r.content || []) {
      if (c.type !== 'text') { console.log(JSON.stringify(c)); continue; }
      if (c.text.startsWith('warning: ')) console.error(c.text); else console.log(c.text);
    }
    if (r.isError) code = 1;
  }
} catch (e) { console.error(`error: ${e.message || e}`); code = 1; }
finally { await client.close().catch(() => {}); }
process.exit(code);
