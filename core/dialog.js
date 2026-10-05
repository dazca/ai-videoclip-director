// A small modal dialog (Help › Connect Claude…, Help › About): a title bar with ×, a body of HTML, Esc / a click outside
// closes it. One at a time.   const d = openDialog({id, title, html, wide?}); d.el, d.body, d.close()
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
let open = null;
export function openDialog({ id, title, html, wide = false }) {
  open?.close();
  const back = document.createElement('div'); back.className = 'wbdlgb';
  back.innerHTML = `<div class="wbdlg${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-dlg="${esc(id)}" tabindex="-1"><div class="wbdlgh"><b>${esc(title)}</b><span class="sp"></span><a data-dlgx="1" title="close (Esc)">×</a></div><div class="wbdlgc">${html}</div></div>`;
  const el = back.firstElementChild;
  const close = () => { back.remove(); removeEventListener('keydown', key, true); if (open?.el === el) open = null; };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-dlgx]')) close(); });
  addEventListener('keydown', key, true);
  document.body.appendChild(back); el.focus({ preventScroll: true });
  open = { el, body: el.querySelector('.wbdlgc'), close };
  return open;
}
// a confirm that shows its whole explanation (the palette's one-line confirm cuts long texts): resolves true / false.
//   await confirmDialog({id, title, html, ok: 'Make public', cancel: 'Cancel'})
export function confirmDialog({ id = 'confirm', title, html, ok = 'OK', cancel = 'Cancel' }) {
  return new Promise((done) => {
    let answered = false;
    const d = openDialog({ id, title, html: `${html}<div class="wbdlgf"><span class="sp"></span><button data-cf="no">${esc(cancel)}</button><button data-cf="yes" class="pri">${esc(ok)}</button></div>` });
    const finish = (v) => { if (answered) return; answered = true; d.close(); done(v); };
    d.el.addEventListener('click', (e) => { const b = e.target.closest('[data-cf]'); if (b) finish(b.dataset.cf === 'yes'); });
    // Esc / a click outside close it: that is a no
    new MutationObserver((_, o) => { if (!d.el.isConnected) { o.disconnect(); finish(false); } }).observe(document.body, { childList: true });
    d.el.querySelector('[data-cf=yes]')?.focus();
  });
}
// copy a text: the async clipboard (localhost is a secure context), else a hidden textarea + execCommand
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
  const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove(); return ok;
}
export { esc };
