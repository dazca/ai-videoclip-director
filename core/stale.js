// The thin warning bar on top of the page (G8: the error states, in the page's language):
//   - down:   the server stopped answering (the change feed dropped, /api/status fails): what to run; it goes away by itself
//             when the server is back (polled every 2 s while down; the page then re-reads everything);
//   - stale:  the server runs older code than the files on disk (/api/status code.stale: serve.mjs, lib/, js/, tabs/ or core/
//             changed after it started, so the page's JS may call ops the server does not know yet): restart it;
//   - reload: the server restarted with new code after this page loaded;
//   - ffmpeg: ffmpeg / ffprobe not on PATH (/api/status tools): once per session, with "How to fix…" (Help › System check…).
// Checked at boot, every 30 s, whenever the change feed reconnects or drops.
import { esc, toast } from '../js/store.js';
import { t } from './i18n.js';

let bootHash = null, bar = null, dismissed = '', down = false, downTimer = 0;
const RANK = { down: 3, stale: 2, reload: 2, ffmpeg: 1 };
const kind = (key) => String(key || '').split(':')[0];
function show(key, html, { reload = true, how = false } = {}) {
  if (dismissed === key) return;
  if (bar && (RANK[kind(bar.dataset.key)] || 0) > (RANK[kind(key)] || 0)) return;   // a more urgent message stays
  if (!bar) { bar = document.createElement('div'); bar.id = 'stalebar'; bar.setAttribute('role', 'alert'); document.body.prepend(bar); }
  bar.dataset.key = key; bar.innerHTML = html + '<span class="sp"></span>' + (how ? `<button data-a="how">${esc(t('err.how'))}</button>` : '')
    + (reload ? `<button data-a="reload" title="reload the page">${esc(t('err.reload'))}</button>` : '') + '<b data-a="x" title="hide until it changes">×</b>';
  document.body.classList.add('stale');
}
function hide(k) { if (k && kind(bar?.dataset.key) !== k) return; bar?.remove(); bar = null; document.body.classList.remove('stale'); }
async function status() { try { const r = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(4000) }); return r.ok ? await r.json() : null; } catch (e) { return null; } }
function wentDown() {
  if (!down) { down = true; show('down', `<b>${esc(t('err.downTitle'))}</b> ${esc(t('err.downDo'))}`, { reload: false }); document.body.dataset.server = 'down'; }
  clearTimeout(downTimer); downTimer = setTimeout(checkCode, 2000);
}
export async function checkCode() {
  const st = await status();
  if (!st) { wentDown(); return null; }
  if (down) { down = false; delete document.body.dataset.server; hide('down'); toast(t('err.back')); }
  const c = st?.code; if (!c) return st;
  bootHash ||= c.hash;
  const files = `${(c.changed || []).slice(0, 4).join(', ')}${(c.changed || []).length > 4 ? ', …' : ''}`;
  if (c.stale) { hide('ffmpeg'); show(`stale:${c.disk}`, `<b>${esc(t('err.stale'))}</b> ${esc(t('err.staleDo', { files }))}`); }
  else if (c.hash !== bootHash) { hide('ffmpeg'); show(`reload:${c.hash}`, `<b>${esc(t('err.reloadPage'))}</b> ${esc(t('err.reloadDo'))}`); }
  else if (st.tools && (!st.tools.ffmpeg || !st.tools.ffprobe) && !seenFfmpeg()) { hide('stale'); hide('reload'); show('ffmpeg', `<b>${esc(t('err.noFfmpeg'))}</b> ${esc(t('err.noFfmpegDo'))}`, { reload: false, how: true }); }
  else if (bar && kind(bar.dataset.key) !== 'down') hide();
  return st;
}
const seenFfmpeg = () => { try { return !!sessionStorage.getItem('wb:ffmpegSeen'); } catch (e) { return false; } };
export function watchCode() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('#stalebar [data-a]')?.dataset.a; if (!a) return;
    if (a === 'reload') location.reload();
    if (a === 'how') window.WB?.health?.open();
    if (a === 'x') { dismissed = bar?.dataset.key || ''; if (kind(dismissed) === 'ffmpeg') { try { sessionStorage.setItem('wb:ffmpegSeen', '1'); } catch (er) { /* ignore */ } } hide(); }
  });
  document.addEventListener('wb:reconnect', () => checkCode());
  document.addEventListener('wb:disconnect', () => { clearTimeout(downTimer); downTimer = setTimeout(checkCode, 600); });
  setInterval(() => { if (!down) checkCode(); }, 30000);
  return checkCode();
}
