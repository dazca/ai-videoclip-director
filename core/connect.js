// Help › Connect Claude… (F9) and Help › About (F10).
// Connect: exactly how to connect a Claude Code chat to this workbench: the `claude mcp add` command with this checkout's
// absolute path, WHERE the agent token lives (its file path: the token's value is never fetched, shown or copied, so it
// cannot leak into a screenshot or an export; the MCP server reads the file itself), the `mcp/client.mjs` quick test, a
// copy button for each, and the connection state (pages open, the last agent write). Paths come from GET /api/connect
// (local only); on a static host (no server) the dialog shows the same steps with <workbench> placeholders.
// About: the one version string (package.json `version`) and the git commit this checkout is at (/api/status `commit`).
//   connect.open() · about.open()   (commands help.connect / help.about)
import { openDialog, copyText, esc } from './dialog.js';
import { PROJECT } from '../js/store.js';

const getJSON = async (u) => { try { const r = await fetch(u, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch (e) { return null; } };
const fwd = (p) => String(p || '').replace(/\\/g, '/');
const q = (p) => (/[\s"']/.test(p) ? `"${p}"` : p);
const ago = (at) => {
  if (!at) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(at + 'Z').getTime()) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
// the three steps as {id, label, text, note}: the text is what the copy button copies (never a token)
export function connectSteps(c) {
  const server = c ? fwd(c.server) : '<workbench>/mcp/server.mjs', client = c ? fwd(c.client) : '<workbench>/mcp/client.mjs';
  const url = c && !c.default_url ? c.url : null;
  return [
    { id: 'add', label: '1 · Add the MCP server to Claude Code (run once, in a terminal)', text: `claude mcp add workbench${url ? ` --env WORKBENCH_URL=${url}` : ''} -- node ${q(server)}`,
      note: 'then, in a Claude Code chat, /mcp lists "workbench"; ask it to call the status tool' },
    { id: 'token', label: '2 · The agent token: where it is (the MCP server reads this file itself)', text: c ? fwd(c.token_file) : '<data folder>/.wb-agent-token',
      note: c?.token_from_env ? 'this server takes it from WB_AGENT_TOKEN: give the MCP server the same variable. Never paste the token into a chat.'
        : `${c && !c.token_file_exists ? 'not written yet (the server writes it at start). ' : ''}Agents write with it and never as the director. Never paste the token into a chat or a file.` },
    { id: 'test', label: '3 · Quick test from any shell', text: `node ${q(client)} status${url ? ` --url ${url}` : ''}${PROJECT ? ` --project ${PROJECT}` : ''}`,
      note: 'prints the server, the project and the costs as JSON; exit code 1 on an error' },
  ];
}
function stateHtml(c) {
  if (!c) return '<span class="cn-off">no workbench server answered (a static copy?): start it with <code>npm start</code> in the workbench folder</span>';
  const la = c.last_agent;
  return `<span class="cn-on">server ${esc(c.url)}</span> · ${c.pages} page${c.pages === 1 ? '' : 's'} open · `
    + (la ? `last agent write: <b>${esc(la.what)}</b>${la.project ? ` on ${esc(la.project)}` : ''} <span class="dim" title="${esc(la.at)}">${esc(ago(la.at))}</span>` : '<span class="dim">no agent write since the server started</span>');
}
export const connect = {
  async open() {
    const c = await getJSON('api/connect');
    const steps = connectSteps(c);
    const d = openDialog({ id: 'connect', title: 'Connect Claude', wide: true,
      html: `<p class="cn-lead">Any Claude Code chat can drive this workbench through its MCP server: it reads and writes the same project files, and you see every change here, live.</p>`
        + steps.map(s => `<div class="cnstep" data-step="${s.id}"><div class="cnl">${esc(s.label)}</div><div class="cnrow"><code class="cncode">${esc(s.text)}</code><button data-copy="${s.id}" title="copy">copy</button></div><div class="cnn dim">${esc(s.note)}</div></div>`).join('')
        + `<div class="cnstate" data-state="1">${stateHtml(c)}</div><div class="cnfoot"><a data-refresh="1">refresh</a><span class="sp"></span><span class="dim">the agent rules: README › MCP, CLAUDE.md</span></div>` });
    d.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-copy]');
      if (b) { const s = steps.find(x => x.id === b.dataset.copy); const ok = await copyText(s.text); b.textContent = ok ? 'copied' : 'select + Ctrl+C'; setTimeout(() => { b.textContent = 'copy'; }, 1500); return; }
      if (e.target.closest('[data-refresh]')) { const n = await getJSON('api/connect'); d.el.querySelector('[data-state]').innerHTML = stateHtml(n); }
    });
    return d;
  },
};
export const about = {
  async open() {
    const [pkg, st] = await Promise.all([getJSON('package.json'), getJSON('api/status')]);
    const version = st?.version || pkg?.version || null, commit = st?.commit || null;
    const n = window.WB?.commands?.list?.().length || 0;
    const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
    return openDialog({ id: 'about', title: 'About the workbench',
      html: `<div class="abt"><b class="abn">Director Workbench</b> <span class="abv" data-version="${esc(version || '')}">${esc(version ? 'v' + version : 'version unknown')}</span>`
        + `<table class="abtab">${row('version', esc(version || 'unknown (package.json not readable)'))}${row('commit', commit ? `<code data-commit="${esc(commit)}">${esc(commit)}</code>` : '<span class="dim">not available (no git checkout, or git not on PATH)</span>')}`
        + `${row('project', esc(PROJECT || ''))}${row('commands', String(n))}${st?.code ? row('server code', `<code>${esc(String(st.code.hash || '').slice(0, 12))}</code> · started ${esc(String(st.code.started || '').replace('T', ' '))}${st.code.stale ? ' · <b class="stw">stale: restart the server</b>' : ''}`) : row('server', '<span class="dim">none (static copy)</span>')}</table>`
        + `<p class="dim">MIT licence · <a href="https://github.com/dazca/ai-videoclip-director" target="_blank" rel="noopener">source on GitHub</a></p></div>` });
  },
};
window.WB = Object.assign(window.WB || {}, { connect, about });
export default { connect, about };
