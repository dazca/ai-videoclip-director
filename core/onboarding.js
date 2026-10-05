// G8: the first-run onboarding, the system check and the boot error screen, in the page's language (core/i18n.js).
// - onboarding.maybe(): at boot, when /api/status first_run (the helper made the data folder, <data>/.wb-first-run, and the
//   director has no project of their own yet): the welcome screen. The three ways to start (a song -> the wizard on its song
//   step; lyrics only -> the wizard; the demo), Connect Claude…, where the data lives (the server's data folder, local only),
//   the system check of this computer, and the language. Any start, or "Not now", tells the server it was seen
//   (POST /api/onboarding {done}); Help › Welcome… shows it again any time.
// - health.open(): Help › System check… (also "How to fix…" on the ffmpeg bar): the server and its code, ffmpeg / ffprobe, the
//   fal key (optional: without it approved requests run as "Open in another app"), Claude (MCP), the data folder; each with what
//   to do. The live error bars (server down, stale code, no ffmpeg) are core/stale.js.
// - onboarding.loadError(project, e): the project could not load: why, what to run, Retry / Open the demo.
//   WB.onboarding { open, close, maybe, isOpen } · WB.health { open, facts }
import { store, PROJECT, postJSON, toast } from '../js/store.js';
import { commands } from './commands.js';
import { menus } from './menus.js';
import { connect, agent } from './connect.js';
import { wizard } from './wizard.js';
import { projects } from './projects.js';
import { openDialog, esc } from './dialog.js';
import { t, lang, setLang, LANGS } from './i18n.js';

const getJSON = async (u) => { try { const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(5000) }); return r.ok ? await r.json() : null; } catch (e) { return null; } };
// what the check shows: the server's status, the generators (the fal key: where it was found, never the key), the last agent write
async function facts() {
  const st = await getJSON('/api/status');
  const gens = st ? await store.generators().catch(() => null) : null;
  const la = st ? await agent.refresh(true) : undefined;
  return { st, gens, agent: la };
}
function checkRows(f) {
  const row = (id, ok, name, state, fix) => `<tr data-chk="${id}" class="${ok === true ? 'ok' : ok === false ? 'no' : 'opt'}"><td class="chki">${ok === true ? '✓' : ok === false ? '✕' : '–'}</td><td class="chkn">${esc(name)}</td><td>${esc(state)}${fix ? `<div class="chkf">${esc(fix)}</div>` : ''}</td></tr>`;
  const st = f.st;
  if (!st) return row('server', false, t('chk.server'), t('chk.serverDown'), t('err.downDo'));
  const ff = !!(st.tools?.ffmpeg && st.tools?.ffprobe), fal = f.gens?.fal_key;
  return row('server', true, t('chk.server'), t('chk.serverOk', { v: st.version || '?' }))
    + row('code', !st.code?.stale, t('chk.code'), st.code?.stale ? t('chk.codeStale') : t('chk.codeOk'))
    + row('ffmpeg', ff, t('chk.ffmpeg'), ff ? t('chk.ffmpegOk') : t('chk.ffmpegNo'), ff ? '' : t('chk.ffmpegFix'))
    + row('fal', fal?.found ? true : null, t('chk.fal'), fal?.found ? t('chk.falOk', { src: fal.source || '' }) : t('chk.falNo'), fal?.found ? '' : t('chk.falFix'))
    + row('agent', f.agent ? true : null, t('chk.agent'), f.agent ? t('chk.agentOk', { what: f.agent.what }) : t('chk.agentNo'))
    + (st.data_dir ? row('data', true, t('chk.data'), st.data_dir) : '');
}
const CSS = `.obg{position:fixed;inset:0;z-index:68;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;padding:5vh 12px;overflow:auto}
.ob{width:min(860px,100%);background:var(--bg2);border:1px solid var(--line);box-shadow:0 12px 40px rgba(0,0,0,.6);font:13px/1.45 "Segoe UI",Arial,sans-serif;color:var(--fg)}
.obh{display:flex;align-items:center;gap:10px;padding:14px 18px 6px} .obh h2{margin:0;font-size:19px;font-weight:600;color:#e9ecef} .obh .sp{flex:1}
.obh select{height:22px} .oblead{margin:0 18px 12px;color:var(--dim);max-width:680px}
.obsec{margin:0 18px;padding:10px 0;border-top:1px solid var(--line2)} .obsec>b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin-bottom:8px}
.obways{display:grid;grid-template-columns:repeat(3,1fr);gap:10px} .obway{display:block;text-align:left;height:auto;padding:12px;border:1px solid var(--line);background:var(--bg3);cursor:pointer;line-height:1.4}
.obway:hover,.obway:focus-visible{border-color:var(--acc);outline:none} .obway b{display:block;font-size:14px;color:#f1f3f5;margin-bottom:4px} .obway span{color:var(--dim);font-size:12px} .obway i{font-style:normal;color:var(--acc);font-size:18px;float:right}
.obrow{display:flex;gap:12px;align-items:flex-start} .obrow p{margin:0;flex:1;color:var(--dim)} .obrow button{height:24px;padding:0 10px;cursor:pointer}
.obpath{display:block;margin-top:4px;font:12px Consolas,monospace;color:#e9d5a8;word-break:break-all}
.chk{border-collapse:collapse;width:100%;font-size:12px} .chk td{padding:3px 6px;vertical-align:top;border-bottom:1px solid var(--line2)} .chki{width:16px;font-weight:700}
.chk tr.ok .chki{color:#7fcf95} .chk tr.no .chki{color:#f08a7a} .chk tr.opt .chki{color:var(--dim)} .chkn{width:190px;color:#dfe2e6} .chkf{color:var(--dim);font-size:11.5px;margin-top:2px}
.obf{display:flex;align-items:center;gap:8px;padding:10px 18px 14px;border-top:1px solid var(--line2)} .obf .sp{flex:1} .obf button{height:24px;padding:0 12px;cursor:pointer} .obf .dim{font-size:11.5px}
.loaderr{max-width:680px;margin:12vh auto;padding:20px 24px;background:var(--bg2);border:1px solid #6a3a32;font:13px/1.5 "Segoe UI",Arial,sans-serif;color:var(--fg)}
.loaderr h2{margin:0 0 6px;font-size:17px;color:#f0a090} .loaderr pre{white-space:pre-wrap;color:var(--dim);font-size:12px} .loaderr button{height:24px;padding:0 12px;margin-right:8px;cursor:pointer}
@media (max-width:700px){.obways{grid-template-columns:1fr}.obrow{flex-direction:column}}`;
const css = () => { if (!document.getElementById('obcss')) { const s = document.createElement('style'); s.id = 'obcss'; s.textContent = CSS; document.head.appendChild(s); } };

let box = null;
export const onboarding = {
  isOpen: () => !!box,
  close() { box?.remove(); box = null; },
  async seen() { await postJSON('/api/onboarding', { done: true }).catch(() => {}); },
  async maybe() {
    const st = await getJSON('/api/status');
    if (!st?.first_run) return false;
    await this.open(); return true;
  },
  async open() {
    css(); this.close();
    box = document.createElement('div'); box.className = 'obg';
    box.innerHTML = `<div class="ob" role="dialog" aria-modal="true" aria-label="${esc(t('ob.title'))}" data-lang="${lang()}">
      <div class="obh"><h2>${esc(t('ob.title'))}</h2><span class="sp"></span><label class="dim">${esc(t('ob.lang'))} <select data-ob-lang>${LANGS.map(l => `<option value="${l.id}"${l.id === lang() ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label></div>
      <p class="oblead">${esc(t('ob.lead'))}</p>
      <div class="obsec"><b>${esc(t('ob.start'))}</b><div class="obways">
        <button class="obway" data-ob="song"><i>♪</i><b>${esc(t('ob.song'))}</b><span>${esc(t('ob.songDo'))}</span></button>
        <button class="obway" data-ob="lyrics"><i>¶</i><b>${esc(t('ob.lyrics'))}</b><span>${esc(t('ob.lyricsDo'))}</span></button>
        <button class="obway" data-ob="demo"><i>▶</i><b>${esc(t('ob.demo'))}</b><span>${esc(t('ob.demoDo'))}</span></button></div></div>
      <div class="obsec"><b>${esc(t('ob.connect'))}</b><div class="obrow"><p>${esc(t('ob.connectDo'))}</p><button data-ob="connect">${esc(t('ob.connectBtn'))}</button></div></div>
      <div class="obsec"><b>${esc(t('ob.data'))}</b><div class="obrow"><p>${esc(t('ob.dataDo'))}<code class="obpath" data-ob-data>…</code></p></div></div>
      <div class="obsec"><b>${esc(t('ob.check'))}</b><table class="chk" data-ob-check><tr><td class="dim">…</td></tr></table></div>
      <div class="obf"><span class="dim">${esc(t('ob.again'))}</span><span class="sp"></span><button data-ob="close">${esc(t('ob.notNow'))}</button></div></div>`;
    document.body.appendChild(box);
    box.querySelector('[data-ob=song]').focus({ preventScroll: true });
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ob]'); if (!b) return;
      const a = b.dataset.ob;
      if (a === 'connect') return connect.open();
      await this.seen(); this.close();
      if (a === 'song') wizard.open({ start: 'song' });
      if (a === 'lyrics') wizard.open();
      if (a === 'demo') { if (PROJECT === 'demo') toast(t('ob.demo')); else projects.open('demo'); }
    });
    box.addEventListener('change', (e) => { if (e.target.matches('[data-ob-lang]')) setLang(e.target.value); });
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); this.seen(); this.close(); } });
    const f = await facts();
    if (!box) return;
    box.querySelector('[data-ob-data]').textContent = f.st?.data_dir || t('ob.dataUnknown');
    box.querySelector('[data-ob-check]').innerHTML = checkRows(f);
    box.dataset.ready = '1';
  },
  // the project did not load (the server is down, the project is missing or broken): what happened and what to do
  loadError(project, e) {
    css();
    const d = document.createElement('div'); d.className = 'loaderr'; d.setAttribute('role', 'alert');
    d.innerHTML = `<h2>${esc(t('err.loadTitle', { p: project }))}</h2><p>${esc(t('err.loadDo'))}</p><pre>${esc(String(e?.message || e))}</pre>`
      + `<button data-le="retry">${esc(t('err.retry'))}</button>${project !== 'demo' ? `<button data-le="demo">${esc(t('err.openDemo'))}</button>` : ''}`;
    d.addEventListener('click', (ev) => { const b = ev.target.closest('[data-le]'); if (!b) return; if (b.dataset.le === 'retry') location.reload(); else location.href = '/?project=demo'; });
    document.body.replaceChildren(d); document.body.dataset.loaderr = '1';
  },
};
export const health = {
  facts,
  async open() {
    css();
    const d = openDialog({ id: 'health', title: t('chk.title'), wide: true, html: `<table class="chk" data-chk-table><tr><td class="dim">…</td></tr></table><div class="wbdlgf"><span class="sp"></span><button data-chk-again>${esc(t('chk.recheck'))}</button></div>` });
    const fill = async () => { const f = await facts(); if (d.el.isConnected) { d.el.querySelector('[data-chk-table]').innerHTML = checkRows(f); d.el.dataset.ready = '1'; } };
    d.el.addEventListener('click', (e) => { if (e.target.closest('[data-chk-again]')) { d.el.dataset.ready = ''; fill(); } });
    await fill(); return d;
  },
};
commands.register([
  { id: 'help.welcome', group: 'Help', title: () => t('help.welcome'), run: () => onboarding.open() },
  { id: 'help.health', group: 'Help', title: () => t('help.health'), run: () => health.open() },
]);
menus.contribute('menubar:Help', ['help.welcome', 'help.health']);
window.WB = Object.assign(window.WB || {}, { onboarding, health });
