// Assets / clips: every generated clip with its start image, takes and the places it is used (EDL).
import { store } from '../js/store.js';
import { esc, mediaAttr } from '../core/esc.js';
import { fmt } from '../js/timeline.js';
// every take of a clip: from the media index (kind clip, job = clip id), else the files the uses point at
const takeFiles = (id, us) => {
  const m = store.media.filter(x => x.kind === 'clip' && x.job === id && x.take != null).sort((a, b) => a.take - b.take).map(x => [x.take, x.path]);
  return m.length ? m : [...new Map(us.map(u => [u.take, u.file]))].sort((a, b) => a[0] - b[0]);
};
export default {
  mount(el, ctx) {
    el.classList.add('pane');
    const render = () => {
      const by = {};
      for (const u of store.uses) (by[u.clip] ||= []).push(u);
      el.innerHTML = `<table class="tbl"><tr><th>clip</th><th>frame</th><th>takes</th><th>uses (song time · take · in-point)</th><th>state</th></tr>${Object.keys(by).sort().map(id => {
        const us = by[id], u0 = us[0], takes = [...new Set(us.map(u => u.take))];
        const st = esc(store.state('job:' + id));
        return `<tr id="clip-${esc(id)}"><td><b>${esc(id)}</b><div class="dim">loc ${esc(u0.location)}</div></td><td><img class="th" src="${mediaAttr(u0.thumb)}" alt=""></td>
          <td>${takeFiles(id, us).map(([t, f]) => `<a href="${mediaAttr(f)}" target="_blank" class="${takes.includes(t) ? 'picked' : 'dim'}">take ${esc(t)}</a>`).join(' ')}</td>
          <td>${us.map(u => `<a data-t="${Number(u.t0) || 0}" title="${esc(u.label)}">${fmt(u.t0, true)} · ${esc(u.take)} · +${((Number(u.in_ms) || 0) / 1000).toFixed(2)}</a>`).join('<br>')}</td>
          <td><span class="chip s-${st}" data-k="job:${esc(id)}">${st}</span></td></tr>`;
      }).join('')}</table>`;
    };
    render();
    el.addEventListener('click', (e) => { const c = e.target.closest('.chip[data-k]'); if (c) return store.cycle(c.dataset.k); const a = e.target.closest('a[data-t]'); if (a) ctx.goto(Number(a.dataset.t)); });
    store.on((w) => { if (w === 'approvals' || w === 'all') render(); });
  },
};
