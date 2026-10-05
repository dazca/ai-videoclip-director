#!/usr/bin/env node
// The npm helper (G7): one command for the page server, the MCP server and pairing, from a clone or from the package.
//   npx ai-videoclip-director [serve] [--data <dir>] [--port 8140] [--lan] [--no-open]   the page server (the default command)
//   npx ai-videoclip-director mcp [--data <dir>] [--port 8140]     the MCP server (stdio) for Claude Code; it also serves the page in
//                                                                  the same process when no workbench answers on the port
//   npx ai-videoclip-director connect [--data <dir>] [--port]      print how to connect Claude Code (the `claude mcp add` line)
//   npx ai-videoclip-director pair [--origin https://…] [--read-only] | --list | --revoke <id>
//                                                                  a one-time code for a page on another origin (the hosted app)
//   npx ai-videoclip-director --version | --help
// The data folder: --data, else WORKBENCH_DATA, else <this folder>/data when this is a clone (a git checkout or any folder outside
// node_modules), else ~/ai-videoclip-director (an npx install lives in a cache that can be wiped: the data must not). A first run
// makes it with the template and the demo (copied from the package), marks it for the page's onboarding and prints the URL and
// the Connect command. <data>/workbench.config.json is used when there is no WORKBENCH_CONFIG and no config next to this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(fs.readFileSync(path.join(WB, 'package.json'), 'utf8'));
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (k) => { const i = argv.indexOf(k); if (i < 0) return false; argv.splice(i, 1); return true; };
const err = (...a) => console.error(...a);
if (flag('--version') || flag('-v')) { console.log(PKG.version); process.exit(0); }
const help = flag('--help') || flag('-h');
const dataOpt = opt('--data'), portOpt = opt('--port'), origin = opt('--origin'), revokeId = opt('--revoke');
const lan = flag('--lan'), readOnly = flag('--read-only'), listPairs = flag('--list'), noOpen = flag('--no-open');
const cmd = argv.find(a => !a.startsWith('-')) || 'serve';
if (help || !['serve', 'mcp', 'connect', 'pair'].includes(cmd)) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).slice(0, 9).map(l => l.slice(3)).join('\n'));
  process.exit(help ? 0 : 2);
}
const PORT = Number(portOpt || process.env.PORT || 8140);
if (!(PORT > 0 && PORT < 65536)) { err(`--port: a port number (got ${portOpt})`); process.exit(2); }

// ------------------------------------------------------------------ the data folder (+ first run)
const installed = WB.split(path.sep).includes('node_modules');
const DATA = path.resolve(dataOpt || process.env.WORKBENCH_DATA || (installed ? path.join(os.homedir(), 'ai-videoclip-director') : path.join(WB, 'data')));
process.env.WORKBENCH_DATA = DATA;
if (!process.env.WORKBENCH_CONFIG && !fs.existsSync(path.join(WB, 'workbench.config.json')) && fs.existsSync(path.join(DATA, 'workbench.config.json'))) process.env.WORKBENCH_CONFIG = path.join(DATA, 'workbench.config.json');
// a first run = this data folder has never been served (no agent token yet): copy what is missing, mark it for the onboarding
function setup() {
  const fresh = !fs.existsSync(path.join(DATA, '.wb-agent-token'));
  const made = [];
  fs.mkdirSync(DATA, { recursive: true });
  for (const d of ['_template', 'demo']) {
    const src = path.join(WB, 'data', d), dst = path.join(DATA, d);
    if (path.resolve(src) === path.resolve(dst) || fs.existsSync(dst) || !fs.existsSync(src)) continue;
    fs.cpSync(src, dst, { recursive: true, filter: (s) => !/[\\/]\.(snapshots|history)([\\/]|$)/.test(s) }); made.push(d);
  }
  if (fresh) fs.writeFileSync(path.join(DATA, '.wb-first-run'), new Date().toISOString() + '\n');
  return { fresh, made };
}
const q = (p) => (/[\s"']/.test(p) ? `"${p}"` : p);
const fwd = (p) => p.replace(/\\/g, '/');
// how Claude Code starts the MCP server: this file with "mcp" (stable for a clone; for an npx install the cache path may change, so
// the npx form is printed too)
const self = fwd(path.join(WB, 'bin', 'cli.mjs'));
const extra = () => `${DATA !== path.join(WB, 'data') ? ` --data ${q(fwd(DATA))}` : ''}${PORT !== 8140 ? ` --port ${PORT}` : ''}`;
function connectLines() {
  const x = extra();
  return [`claude mcp add workbench -- node ${q(self)} mcp${x}`,
    ...(installed ? [`(or, once published: claude mcp add workbench -- npx -y ${PKG.name} mcp${x})`] : [])];
}
function banner(url, { fresh, made }) {
  err('');
  err(`  Director Workbench ${PKG.version}`);
  err(`  open   ${url}/`);
  err(`  data   ${DATA}${made.length ? `  (made: ${made.join(', ')})` : ''}`);
  err(`  claude ${connectLines()[0]}`);
  if (connectLines()[1]) err(`         ${connectLines()[1]}`);
  err(`  pair   node ${q(self)} pair${extra()}   (a one-time code for a page on another origin)`);
  if (fresh) err('  first run: the page opens with a short onboarding (start from a song, from lyrics, or open the demo)');
  err('');
}
async function probe() {
  try { const r = await fetch(`http://localhost:${PORT}/api/status`, { signal: AbortSignal.timeout(1200) }); const j = await r.json(); return j.app === 'director-workbench' ? j : null; }
  catch (e) { return null; }
}
// the page server in THIS process (serve.mjs reads its port and flags from argv / env)
async function startServer({ quiet = false } = {}) {
  process.env.WB_HELPER = '1'; process.env.PORT = String(PORT);
  process.argv = [process.argv[0], path.join(WB, 'serve.mjs'), ...(lan ? ['--lan'] : [])];
  if (quiet) console.log = (...a) => console.error(...a);   // stdout belongs to the MCP protocol
  const m = await import(pathToFileURL(path.join(WB, 'serve.mjs')).href);
  return m.ready;
}

if (cmd === 'connect') {
  console.log('Connect a Claude Code chat to the workbench (run once, in a terminal):\n');
  for (const l of connectLines()) console.log('  ' + l);
  console.log(`\nThen in Claude Code: /mcp lists "workbench"; ask it to call the status tool.\nThe agent token stays in ${path.join(DATA, '.wb-agent-token')} (the MCP server reads it; never paste it into a chat).`);
  console.log(`Quick test: node ${q(fwd(path.join(WB, 'mcp', 'client.mjs')))} status${PORT !== 8140 ? ` --url http://localhost:${PORT}` : ''}`);
  process.exit(0);
}
if (cmd === 'pair') {
  const PR = await import(pathToFileURL(path.join(WB, 'lib', 'pairing.mjs')).href);
  fs.mkdirSync(DATA, { recursive: true });
  try {
    if (listPairs) {
      const l = PR.list(DATA);
      if (!l.pairings.length) console.log('no paired pages');
      for (const p of l.pairings) console.log(`${p.id}  ${p.origin}  ${p.scope}  paired ${p.created}  last used ${p.last_used}`);
      if (l.pending_codes.length) console.log(`${l.pending_codes.length} unused code(s) pending`);
    } else if (revokeId) { PR.revoke(DATA, revokeId); console.log(`revoked ${revokeId}: that page can no longer reach this helper`); }
    else {
      const c = PR.createCode(DATA, { origin, scope: readOnly ? 'read' : 'director' });
      console.log(`\n  pairing code   ${c.code}\n`);
      console.log(`  Type it into the hosted page (Connect this computer…). It works once, until ${c.expires.replace('T', ' ')} (10 minutes)${c.origin ? `, for ${c.origin} only` : ''}.`);
      console.log(`  Scope: ${c.scope === 'read' ? 'read only' : 'the page acts as you, the director (never your private files)'}. Revoke it later in Settings › Paired pages, or: pair --revoke <id>.`);
      console.log(`  The helper must be running (npx ${PKG.name}) on port ${PORT}.\n`);
    }
  } catch (e) { err(`pair: ${e.message}`); process.exit(1); }
  process.exit(0);
}
const first = setup();
if (cmd === 'serve') {
  if (await probe()) { err(`a workbench already answers on http://localhost:${PORT}/ (use it, or pass --port <another>)`); process.exit(1); }
  try { await startServer(); }
  catch (e) { err(`cannot listen on port ${PORT}: ${e.code === 'EADDRINUSE' ? 'it is in use (pass --port <another>)' : e.message}`); process.exit(1); }
  banner(`http://localhost:${PORT}`, first);
  if (first.fresh && !noOpen && !process.env.CI) {   // the first run opens the browser once
    const { spawn } = await import('node:child_process');
    const url = `http://localhost:${PORT}/`;
    try { (process.platform === 'win32' ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }) : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' })).on('error', () => {}).unref(); } catch (e) { /* no browser: the URL is printed */ }
  }
}
if (cmd === 'mcp') {
  // one process when possible: no workbench on the port -> serve the page here too; one already there -> use it; the port taken by
  // something else -> the MCP server alone, on the files (offline)
  process.env.WORKBENCH_URL = process.env.WORKBENCH_URL || `http://localhost:${PORT}`;
  if (!(await probe())) {
    try { await startServer({ quiet: true }); err(`workbench: serving the page at http://localhost:${PORT}/ from this MCP process (data ${DATA})`); }
    catch (e) { process.env.WORKBENCH_OFFLINE = '1'; err(`workbench: port ${PORT} is taken by something else: the MCP server works on the files (offline); pass --port <another> to serve the page`); }
  }
  await import(pathToFileURL(path.join(WB, 'mcp', 'server.mjs')).href);
}
