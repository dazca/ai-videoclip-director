// Media library (SPEC v2 section 7): every generated file from media.json in one dense grid. Filters by kind, entity,
// status and private; hover = scrub the video strip (and preview in the dock); click = show in the dock (pinned);
// right-click = WB.menus 'media' context (show on timeline, use as reference for…, copy path, open file location);
// drag a cell onto a "+ New look" form to use it as a reference.
import { store, mediaUrl, prefs } from '../js/store.js';
import { dock } from '../core/dock.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const KIND_ORDER = ['render', 'clip', 'still', 'avatar', 'body', 'motion', 'dancer', 'motion-ref', 'sheet', 'variation', 'contact', 'audio', 'ref'];
const mb = (n) => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' kB';

export function mediaCell(m, { size = '' } = {}) {
  const dur = m.duration_ms ? `${(m.duration_ms / 1000).toFixed(1)}s` : '';
  return `<div class="mc k-${m.kind} ${size}${m.private ? ' priv' : ''}" data-media="${esc(m.id)}" draggable="true" ${m.strip ? `data-strip="${esc(m.strip)}" data-n="${m.strip_n || 8}"` : ''}
    title="${esc(m.label)}\n${esc(m.path)}\n${m.kind} · ${mb(m.size)}${m.w ? ` · ${m.w}×${m.h}` : ''}${dur ? ' · ' + dur : ''}${m.entities.length ? '\n' + m.entities.join(' ') : ''}${m.shots.length ? '\nused in ' + m.shots.length + ' shot(s): ' + m.shots.slice(0, 8).join(' ') : ''}">
    <img src="${esc(mediaUrl(m.thumb))}" alt="" loading="lazy">${m.private ? '<i class="lock" title="private: crop of a real photo; local only, never exported">🔒</i>' : ''}
    <span class="ml">${esc(m.job || m.id)}${m.take != null ? '.' + m.take : ''}${dur ? ' · ' + dur : ''}</span>${m.status === 'used' ? `<span class="mu" title="used in ${m.shots.length} shot(s)">${m.shots.length}</span>` : m.status === 'picked' ? '<span class="mu pk" title="the director\'s pick">★</span>' : ''}</div>`;
}

export default {
  mount(el, ctx) {
    el.classList.add('pane', 'media');
    const f = Object.assign({ kind: '', ent: '', status: '', priv: 'show', q: '' }, prefs.get('mediaFilter', {}));
    const render = () => {
      const all = store.media;
      const counts = {}; for (const m of all) counts[m.kind] = (counts[m.kind] || 0) + 1;
      const ents = store.entities.filter(e => all.some(m => m.entities.includes(e.id)));
      const q = f.q.toLowerCase();
      const list = all.filter(m => (!f.kind || m.kind === f.kind) && (!f.ent || m.entities.includes(f.ent)) && (!f.status || m.status === f.status)
        && (f.priv === 'show' || (f.priv === 'hide' ? !m.private : m.private)) && (!q || (m.label + ' ' + m.path + ' ' + m.id).toLowerCase().includes(q)))
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
      const groups = {}; for (const m of list) (groups[m.kind] ||= []).push(m);
      el.innerHTML = `<div class="mbar"><span class="kinds"><a data-kind="" class="${!f.kind ? 'on' : ''}">all ${all.length}</a>${KIND_ORDER.filter(k => counts[k]).map(k => `<a data-kind="${k}" class="${f.kind === k ? 'on' : ''}">${k} ${counts[k]}</a>`).join('')}</span>
        <select data-f="ent"><option value="">any entity</option>${ents.map(e => `<option value="${esc(e.id)}" ${f.ent === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
        <select data-f="status">${[['', 'any status'], ['used', 'on the timeline'], ['picked', 'picked'], ['unused', 'unused'], ['private', 'private']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select data-f="priv">${[['show', 'private: show 🔒'], ['hide', 'private: hide'], ['only', 'private only']].map(([v, l]) => `<option value="${v}" ${f.priv === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input data-f="q" value="${esc(f.q)}" placeholder="filter…" size="12"><span class="dim">${list.length} shown</span></div>
        ${Object.entries(groups).map(([k, ms]) => `<div class="mg"><div class="mgh">${k} <span class="dim">${ms.length}</span></div><div class="mgrid">${ms.map(m => mediaCell(m, { size: ['sheet', 'contact', 'render'].includes(k) ? 'wide' : ['body', 'dancer', 'motion', 'motion-ref'].includes(k) ? 'tall' : '' })).join('')}</div></div>`).join('')}`;
    };
    const save = () => { prefs.set('mediaFilter', f); render(); };
    el.addEventListener('click', (e) => {
      const k = e.target.closest('[data-kind]'); if (k) { f.kind = k.dataset.kind; return save(); }
      const c = e.target.closest('[data-media]'); if (c) dock.show({ kind: 'media', id: c.dataset.media });
    });
    el.addEventListener('change', (e) => { const n = e.target.dataset.f; if (n && n !== 'q') { f[n] = e.target.value; save(); } });
    el.addEventListener('input', (e) => { if (e.target.dataset.f === 'q') { f.q = e.target.value; clearTimeout(this.t); this.t = setTimeout(() => { save(); const i = el.querySelector('[data-f=q]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 200); } });
    el.addEventListener('dragstart', (e) => { const c = e.target.closest('[data-media]'); if (c) { e.dataTransfer.setData('text/wb-media', store.mediaById[c.dataset.media].path); e.dataTransfer.effectAllowed = 'copy'; } });
    render();
    store.on((w) => { if (w === 'all') render(); });
    this.render = render;
  },
};
