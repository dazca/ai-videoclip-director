// Media library (SPEC v2 section 7): every generated or imported file from media.json in one dense grid. Filters by kind,
// entity, status, linked / unlinked (D8: to an entity, a node, a shot, a clip use or a request), private, and a search;
// "compact" packs more cells; "Import media…" opens File › Import media (core/importmedia.js). Hover = scrub the video
// strip (and preview in the dock); click = show in the dock (pinned); right-click = WB.menus 'media' context (Use as…,
// show on timeline, use as reference for…, copy path, open file location); drag a cell onto a "+ New look" form to use
// it as a reference.
import { store, prefs } from '../js/store.js';
import { dock } from '../core/dock.js';
import { commands } from '../core/commands.js';

import { esc, mediaAttr } from '../core/esc.js';
const KIND_ORDER = ['render', 'clip', 'still', 'avatar', 'body', 'motion', 'dancer', 'motion-ref', 'sheet', 'variation', 'contact', 'audio', 'ref'];
// linked = the file is used somewhere: an entity / shot / clip-use link, a request, a "use as" (a node, a take, a start
// frame), or an asset node's image
export function linkedSet() {
  const nodes = new Set();
  for (const e of store.entities || []) for (const n of e?.iter?.nodes || []) if (n?.image) nodes.add(String(n.image).toLowerCase());
  return (m) => !!((m.entities || []).length || (m.shots || []).length || (m.uses || []).length || m.request || (m.use_as || []).length || nodes.has(String(m.path).toLowerCase()));
}
const mb = (n) => !Number.isFinite(n) ? '?' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' kB';

export function mediaCell(m, { size = '' } = {}) {
  const dur = Number(m.duration_ms) ? `${(Number(m.duration_ms) / 1000).toFixed(1)}s` : '';
  const ents = m.entities || [], shots = m.shots || [];
  return `<div class="mc k-${esc(m.kind)} ${size}${m.private ? ' priv' : ''}" data-media="${esc(m.id)}" draggable="true" ${m.strip ? `data-strip="${esc(m.strip)}" data-n="${Number(m.strip_n) || 8}"` : ''}
    title="${esc(m.label)}\n${esc(m.path)}\n${esc(m.kind)} · ${mb(m.size)}${m.w ? ` · ${esc(m.w)}×${esc(m.h)}` : ''}${dur ? ' · ' + dur : ''}${ents.length ? '\n' + esc(ents.join(' ')) : ''}${shots.length ? '\nused in ' + shots.length + ' shot(s): ' + esc(shots.slice(0, 8).join(' ')) : ''}">
    <img src="${mediaAttr(m.thumb)}" alt="" loading="lazy">${m.private ? '<i class="lock" title="private: crop of a real photo; local only, never exported">🔒</i>' : ''}
    ${(m.use_as || []).length ? `<span class="mlk" title="${esc(m.use_as.map(u => u.shot ? `${u.as === 'take' ? 'take' : 'start frame'} of ${u.shot}` : `${u.as} node ${u.node || ''} of ${u.entity}`).join(' · '))}">${esc(m.use_as.length > 1 ? m.use_as.length + '×' : m.use_as[0].shot ? (m.use_as[0].as === 'take' ? 'take' : 'frame') : m.use_as[0].as)}</span>` : ''}<span class="ml">${esc(m.job || m.id)}${m.take != null ? '.' + esc(m.take) : ''}${dur ? ' · ' + dur : ''}</span>${m.status === 'used' ? `<span class="mu" title="used in ${shots.length} shot(s)">${shots.length}</span>` : m.status === 'picked' ? '<span class="mu pk" title="the director\'s pick">★</span>' : ''}</div>`;
}

export default {
  mount(el, ctx) {
    el.classList.add('pane', 'media');
    const f = Object.assign({ kind: '', ent: '', status: '', priv: 'show', link: '', compact: false, q: '' }, prefs.get('mediaFilter', {}));
    const render = () => {
      const all = store.media, linked = linkedSet();
      el.classList.toggle('compact', !!f.compact);
      const counts = {}; for (const m of all) counts[m.kind] = (counts[m.kind] || 0) + 1;
      const ents = store.entities.filter(e => all.some(m => (m.entities || []).includes(e.id)));
      const q = f.q.toLowerCase();
      const list = all.filter(m => (!f.kind || m.kind === f.kind) && (!f.ent || (m.entities || []).includes(f.ent)) && (!f.status || m.status === f.status)
        && (f.priv === 'show' || (f.priv === 'hide' ? !m.private : m.private)) && (!f.link || (f.link === 'linked') === linked(m))
        && (!q || `${m.label} ${m.path} ${m.id} ${m.job || ''}`.toLowerCase().includes(q)))
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
      const groups = {}; for (const m of list) (groups[m.kind] ||= []).push(m);
      el.innerHTML = `<div class="mbar"><span class="kinds"><a data-kind="" class="${!f.kind ? 'on' : ''}">all ${all.length}</a>${KIND_ORDER.filter(k => counts[k]).map(k => `<a data-kind="${esc(k)}" class="${f.kind === k ? 'on' : ''}">${k} ${counts[k]}</a>`).join('')}</span>
        <select data-f="ent"><option value="">any entity</option>${ents.map(e => `<option value="${esc(e.id)}" ${f.ent === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
        <select data-f="status">${[['', 'any status'], ['used', 'on the timeline'], ['picked', 'picked'], ['unused', 'unused'], ['private', 'private']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select data-f="priv">${[['show', 'private: show 🔒'], ['hide', 'private: hide'], ['only', 'private only']].map(([v, l]) => `<option value="${v}" ${f.priv === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select data-f="link">${[['', 'linked or not'], ['linked', 'linked'], ['unlinked', 'unlinked']].map(([v, l]) => `<option value="${v}" ${f.link === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input data-f="q" value="${esc(f.q)}" placeholder="search…" size="12"><label title="smaller cells"><input type="checkbox" data-f="compact" ${f.compact ? 'checked' : ''}> compact</label><span class="dim">${list.length} shown</span><span style="flex:1"></span><button data-x="import" title="File › Import media…: drop files, or read a folder under a media root">Import media…</button></div>
        ${Object.entries(groups).map(([k, ms]) => `<div class="mg"><div class="mgh">${esc(k)} <span class="dim">${ms.length}</span></div><div class="mgrid">${ms.map(m => mediaCell(m, { size: ['sheet', 'contact', 'render'].includes(k) ? 'wide' : ['body', 'dancer', 'motion', 'motion-ref'].includes(k) ? 'tall' : '' })).join('')}</div></div>`).join('')}`;
    };
    const save = () => { prefs.set('mediaFilter', f); render(); };
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-x=import]')) return commands.run('file.importMedia', {});
      const k = e.target.closest('[data-kind]'); if (k) { f.kind = k.dataset.kind; return save(); }
      const c = e.target.closest('[data-media]'); if (c) dock.show({ kind: 'media', id: c.dataset.media });
    });
    el.addEventListener('change', (e) => { const n = e.target.dataset.f; if (n && n !== 'q') { f[n] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; save(); } });
    el.addEventListener('input', (e) => { if (e.target.dataset.f === 'q') { f.q = e.target.value; clearTimeout(this.t); this.t = setTimeout(() => { save(); const i = el.querySelector('[data-f=q]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 200); } });
    el.addEventListener('dragstart', (e) => { const c = e.target.closest('[data-media]'); if (c) { e.dataTransfer.setData('text/wb-media', store.mediaById[c.dataset.media].path); e.dataTransfer.effectAllowed = 'copy'; } });
    render();
    store.on((w) => { if (w === 'all') render(); });
    document.addEventListener('wb:media-used', () => render());
    this.render = render;
  },
};
