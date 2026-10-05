// Identity check badges (ROADMAP_v4 D7) on iteration nodes (tabs/assetws.js) and take cards (tabs/takes.js): the latest
// check's verdict ("identity ok" / "drift" / "✗ clip side"); hovering (or focusing) a badge shows its items in one shared
// popover (fixed, so a scrolling strip never clips it). Information for the director only: a check never approves,
// rejects or picks anything. Data: store.checks (checks.json, the server's), logic js/checks.js.
import { store, esc } from '../js/store.js';
import * as C from '../js/checks.js';

const entOf = (id) => (store.entities || []).find(e => e.id === id) || null;
const when = (at) => String(at || '').replace('T', ' ').slice(5, 16);
// a badge for the newest of these checks (null: no badge); `count` earlier checks are listed in the popover
export function badgeHtml(list) {
  const c = list?.[0]; if (!c) return '';
  const b = C.badge(c, entOf(c.against?.entity));
  return `<span class="ckb ck-${b.cls}" data-ck="${esc(c.id)}" tabindex="0" aria-label="${esc(`identity check: ${b.label}`)}">${esc(b.label)}${list.length > 1 ? `<i>${list.length}</i>` : ''}</span>`;
}
export const nodeBadge = (entId, node) => badgeHtml(C.nodeChecks(store.checks, entId, node, store.media || []));
export const takeBadge = (shotId, mediaId) => badgeHtml(C.takeChecks(store.checks, shotId, mediaId));

function popHtml(c) {
  const ent = entOf(c.against?.entity), b = C.badge(c, ent), same = (store.checks?.checks || []).filter(x => C.targetKey(x.target) === C.targetKey(c.target) && x.id !== c.id);
  const items = (c.items || []).map(i => `<li class="${i.ok ? 'ok' : 'no'}"><b>${i.ok ? '✓' : '✗'}</b> ${esc(i.constant)}${i.note ? ` <i>${esc(i.note)}</i>` : ''}</li>`).join('');
  return `<div class="ckph"><span class="ckb ck-${b.cls}">${esc(b.label)}</span><b>identity check ${esc(c.id)}</b><span class="dim">${esc(c.by || 'agent')} · ${esc(when(c.created))}</span></div>`
    + `<div class="dim">${esc(c.target.kind)} ${esc(c.target.id)} against ${esc(ent?.name || c.against?.entity || '')} ${esc(c.against?.node || '')} · verdict ${esc(c.verdict)}</div>`
    + (items ? `<ul>${items}</ul>` : '<div class="dim">no constants were checked</div>')
    + (c.note ? `<div class="ckpn">${esc(c.note)}</div>` : '')
    + (c.score ? `<div class="dim">face score ${esc(c.score.model)}: ${esc(c.score.value)}${c.score.threshold != null ? ` (threshold ${esc(c.score.threshold)})` : ''}</div>` : '')
    + (same.length ? `<div class="dim">${same.length} earlier check${same.length > 1 ? 's' : ''}: ${same.slice(-4).map(x => esc(`${x.id} ${x.verdict}`)).join(', ')}</div>` : '')
    + '<div class="dim ckpf">the director decides: a check never approves, rejects or picks</div>';
}
let pop = null;
function show(el) {
  const c = (store.checks?.checks || []).find(x => x.id === el.dataset.ck); if (!c) return;
  pop ||= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'ckpop' });
  pop.innerHTML = popHtml(c); pop.style.display = 'block';
  const r = el.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = `${Math.max(4, Math.min(innerWidth - w - 4, r.left))}px`;
  pop.style.top = `${r.bottom + 4 + h < innerHeight ? r.bottom + 4 : Math.max(4, r.top - h - 4)}px`;
}
const hide = () => { if (pop) pop.style.display = 'none'; };
let wired = false;
export function wireCheckPopover() {
  if (wired) return; wired = true;
  document.addEventListener('mouseover', (ev) => { const b = ev.target.closest?.('.ckb[data-ck]'); if (b) show(b); else if (!ev.target.closest?.('.ckpop')) hide(); });
  document.addEventListener('focusin', (ev) => { const b = ev.target.closest?.('.ckb[data-ck]'); if (b) show(b); });
  document.addEventListener('focusout', (ev) => { if (ev.target.closest?.('.ckb[data-ck]')) hide(); });
  document.addEventListener('scroll', hide, true);
}
