// One-line help with a "?" popover (ROADMAP_v4 F5): empty states and stage help read as ONE line; the longer explanation
// opens on the "?" (click, or Enter / Space on it; Esc or a click elsewhere closes it). No library: <details> + CSS.
//   help(line, more)   -> HTML: `line` (trusted HTML: escape project values yourself) and `more` (trusted HTML) in the popover
// Only one popover is open at a time.
export const help = (line, more) => `<span class="hlp">${line}${more ? `<details class="hlpd"><summary title="more" aria-label="more help">?</summary><div class="hlppop">${more}</div></details>` : ''}</span>`;

const closeAll = (except) => { for (const d of document.querySelectorAll('details.hlpd[open]')) if (d !== except) d.open = false; };
document.addEventListener('click', (e) => { closeAll(e.target.closest?.('details.hlpd')); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.querySelector('details.hlpd[open]')) { closeAll(null); e.stopPropagation(); } }, true);
// the popover is fixed to the window (a panel's overflow cannot clip it), under the "?", kept inside the window
document.addEventListener('toggle', (e) => {
  const d = e.target; if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('hlpd') || !d.open) return;
  const pop = d.querySelector('.hlppop'), q = d.querySelector('summary').getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(4, Math.min(innerWidth - w - 4, q.left - 6)) + 'px';
  pop.style.top = (q.bottom + 4 + h > innerHeight - 4 ? Math.max(4, q.top - h - 4) : q.bottom + 4) + 'px';
}, true);
