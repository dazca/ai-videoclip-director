// Entity library tab (characters, locations, props): reference images, status chip, where it is used.
import { store, mediaUrl } from '../js/store.js';
import { fmt } from '../js/timeline.js';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

export function usedIn(e) {
  if (e.kind === 'character' && /^[dh]\d$/.test(e.id)) return store.shots.filter(s => s.characters_raw.some(c => c.toUpperCase().startsWith(e.id.toUpperCase()))).map(s => ({ t: s.t0, label: s.id }));
  if (e.kind === 'character') return store.shots.filter(s => s.cast.includes(e.id)).map(s => ({ t: s.t0, label: s.id }));
  if (e.kind === 'location') return store.uses.filter(u => u.location === e.letter).map(u => ({ t: u.t0, label: u.clip }));
  const imgs = new Set((e.refs || []).map(r => r.split('/')[3]));
  return store.uses.filter(u => imgs.has(u.start_image.split('/')[3])).map(u => ({ t: u.t0, label: u.clip }));
}

export function entityTab(kind) {
  let root;
  const render = () => {
    const list = store.entities.filter(e => e.kind === kind);
    root.innerHTML = `<div class="cards">${list.map(e => {
      const k = `${e.kind}:${e.id}`, s = store.state(k), used = usedIn(e);
      return `<div class="card" data-ent="${esc(e.id)}" data-sel="${esc(k)}">
        <div class="ph">${e.thumb ? `<img src="${mediaUrl(e.thumb)}" alt="">` : '<span class="none">no image</span>'}</div>
        <div class="tx"><div class="hd"><span class="chip s-${s}" data-k="${esc(k)}" title="${s} (click to cycle)">${s}</span> <b>${esc(e.name)}</b>${e.private_refs ? ' <i class="priv" title="reference folder is private: never publish">private refs</i>' : ''}</div>
        <div class="ds">${esc(e.role || e.description || '')}</div>
        ${e.identity ? `<div class="ds dim">${esc(e.identity)}</div>` : ''}
        <div class="refs">${(e.refs || []).map(r => `<a href="${mediaUrl(r)}" target="_blank" title="${esc(r)}">${esc(r.split('/').pop())}</a>`).join(' ')}</div>
        <div class="used">${used.length ? used.slice(0, 40).map(u => `<a data-t="${u.t}" title="go to ${fmt(u.t, true)}">${esc(u.label)} ${fmt(u.t)}</a>`).join(' ') : '<span class="dim">not placed on the timeline</span>'}</div></div></div>`;
    }).join('')}</div>`;
  };
  return {
    mount(el, ctx) {
      root = el; el.classList.add('pane');
      render();
      el.addEventListener('click', (ev) => {
        const c = ev.target.closest('.chip[data-k]'); if (c) return store.cycle(c.dataset.k);
        const a = ev.target.closest('a[data-t]'); if (a) ctx.goto(Number(a.dataset.t));
      });
      store.on((w) => { if (w === 'approvals' || w === 'all') render(); });
    },
  };
}
