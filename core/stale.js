// The stale-code bar: a thin warning on top of the page when the server runs older code than the files on disk (its
// /api/status code.stale: someone changed serve.mjs, lib/, js/, tabs/ or core/ after it started, so the page's JS may
// call ops the server does not know yet), or when the server restarted with new code after this page loaded (reload).
// Checked at boot, every 30 s and whenever the change feed reconnects.
import { esc } from '../js/store.js';

let bootHash = null, bar = null, dismissed = '';
function show(key, html) {
  if (dismissed === key) return;
  if (!bar) { bar = document.createElement('div'); bar.id = 'stalebar'; bar.setAttribute('role', 'alert'); document.body.prepend(bar); }
  bar.dataset.key = key; bar.innerHTML = html + '<span class="sp"></span><button data-a="reload" title="reload the page">Reload</button><b data-a="x" title="hide until it changes">×</b>';
  document.body.classList.add('stale');
}
function hide() { bar?.remove(); bar = null; document.body.classList.remove('stale'); }
export async function checkCode() {
  let st; try { st = await (await fetch('/api/status', { cache: 'no-store' })).json(); } catch (e) { return null; }
  const c = st?.code; if (!c) return st;
  bootHash ||= c.hash;
  if (c.stale) show(`stale:${c.disk}`, `<b>Restart the server.</b> The workbench code changed on disk after it started (${esc((c.changed || []).slice(0, 4).join(', '))}${(c.changed || []).length > 4 ? ', …' : ''}): this page may ask for things it does not know yet. Restart <code>node serve.mjs</code>, then reload.`);
  else if (c.hash !== bootHash) show(`reload:${c.hash}`, '<b>Reload the page.</b> The server restarted with new code since this page loaded.');
  else hide();
  return st;
}
export function watchCode() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('#stalebar [data-a]')?.dataset.a; if (!a) return;
    if (a === 'reload') location.reload();
    if (a === 'x') { dismissed = bar?.dataset.key || ''; hide(); }
  });
  document.addEventListener('wb:reconnect', () => checkCode());
  setInterval(checkCode, 30000);
  return checkCode();
}
