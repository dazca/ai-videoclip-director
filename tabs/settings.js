// Settings: zoom floor, linear mode, header mode, columns (visibility, width), and the keybindings of every command
// (stored in data/<project>/settings.json, conflicts flagged in red).
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
export default {
  mount(el, ctx) {
    el.classList.add('pane', 'settings'); this.el = el; this.filter = '';
    window.WB.store.on((w) => { if ((w === 'settings' || w === 'all') && el.style.display !== 'none') this.renderKeys(); });
  },
  show(ctx) {
    const tl = ctx.timeline, el = this.el; if (!tl) return;
    el.innerHTML = `<h4>view</h4><table class="tbl"><tr><td>min px / second (floor)</td><td><input type=number data-x=pps value="${tl.pxPerSec.toFixed(1)}" min=2 max=800 step=1></td></tr>
      <tr><td>linear time (no warp)</td><td><input type=checkbox data-x=lin ${tl.linear ? 'checked' : ''}></td></tr>
      <tr><td>column header</td><td><select data-x=hdr>${['full', 'thin', 'hidden'].map((n, i) => `<option value=${i} ${i === tl.headerMode ? 'selected' : ''}>${n}</option>`).join('')}</select></td></tr></table>
      <h4>columns</h4><table class="tbl">${tl.cols.map(c => `<tr id="cs-${c.id}"><td>${esc(c.def.title)}</td><td><input type=checkbox data-c="${c.id}" ${c.hidden ? '' : 'checked'}> width <input type=number data-w="${c.id}" value="${Math.round(c.w)}" min=3 style="width:5em"> ${c.def.kind === 'text' ? c.mode : 'lane'}</td></tr>`).join('')}
      <tr><td></td><td><button data-x=reset>reset layout and preferences</button></td></tr></table>
      <h4 class="kb">keybindings <i class="dim">(project settings.json · click + then press the keys · Esc cancels)</i></h4>
      <div class="kbbar"><input class="kbf" placeholder="filter commands" value="${esc(this.filter)}"> <button data-x=kbreset>reset all to defaults</button> <span class="kbc"></span></div>
      <table class="tbl kbt"></table>`;
    this.renderKeys();
    el.querySelector('.kbf').addEventListener('input', (e) => { this.filter = e.target.value; this.renderKeys(); });
    el.onchange = (e) => {
      const d = e.target.dataset;
      if (d.x === 'pps') { tl.pxPerSec = Number(e.target.value) || 16; tl.save(); tl.relayout(); }
      if (d.x === 'lin') tl.toggleLinear();
      if (d.x === 'hdr') { tl.headerMode = Number(e.target.value); tl.applyHeaderMode(); tl.save(); }
      if (d.c) tl.setHidden(d.c, !e.target.checked);
      if (d.w) tl.setWidth(d.w, Math.max(3, Number(e.target.value)));
    };
    el.onclick = (e) => {
      const t = e.target, K = window.WB.keymap;
      if (t.dataset.x === 'reset') {
        try { Object.keys(localStorage).filter(k => k.startsWith('wb:')).forEach(k => localStorage.removeItem(k)); } catch (er) { /* ignore */ }
        location.reload();
      }
      if (t.dataset.x === 'kbreset') K.resetAll();
      const row = t.closest('tr[data-id]'); if (!row) return;
      const id = row.dataset.id, keys = window.WB.commands.keysFor(id);
      if (t.dataset.rm != null) K.set(id, keys.filter((_, i) => i !== Number(t.dataset.rm)));
      if (t.dataset.k === 'reset') K.reset(id);
      if (t.dataset.k === 'add') this.capture(t, id, keys);
    };
  },
  capture(btn, id, keys) {
    btn.textContent = 'press keys…'; btn.classList.add('cap');
    const on = (e) => {
      const combo = window.WB.keymap.combo(e); if (!combo) return;           // wait for a non-modifier key
      e.preventDefault(); e.stopImmediatePropagation();
      removeEventListener('keydown', on, true);
      if (combo === 'Escape') { this.renderKeys(); return; }
      if (!keys.includes(combo)) window.WB.keymap.set(id, [...keys, combo]); else this.renderKeys();
    };
    addEventListener('keydown', on, true);
  },
  renderKeys() {
    const tb = this.el?.querySelector('.kbt'); if (!tb) return;
    const { commands, keymap } = window.WB;
    const q = this.filter.toLowerCase();
    const list = commands.list().filter(c => !c.hidden || c.keys.length).filter(c => !q || `${commands.title(c)} ${c.group} ${c.id} ${commands.keysFor(c.id).join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id));
    const conf = keymap.conflicts();
    this.el.querySelector('.kbc').innerHTML = conf.length ? `<span class="bad">${conf.length} conflict${conf.length > 1 ? 's' : ''}: ${conf.map(c => `${esc(c.key)} (${c.ids.join(', ')})`).join('; ')}</span>` : '<span class="dim">no conflicts</span>';
    tb.innerHTML = `<tr><th>group</th><th>command</th><th>keys</th><th></th></tr>` + list.map(c => {
      const keys = commands.keysFor(c.id), custom = !!window.WB.store.settings?.keybindings?.[c.id];
      const cf = keymap.conflictsFor(c.id);
      return `<tr data-id="${c.id}"><td class="dim">${esc(c.group)}</td><td title="${c.id}">${esc(commands.title(c))}</td>
        <td>${keys.map((k, i) => `<span class="kc${cf.some(x => x.key === k) ? ' bad' : ''}" title="${cf.filter(x => x.key === k).map(x => 'also: ' + x.others.join(', ')).join('')}">${esc(k)}<b data-rm="${i}" title="remove">×</b></span>`).join('')}<button data-k="add" title="add a key">+</button></td>
        <td>${custom ? '<button data-k="reset" title="back to the default keys">default</button>' : ''}${cf.length ? ` <span class="bad">conflict: ${esc(cf.map(x => x.key + ' → ' + x.others.join(', ')).join('; '))}</span>` : ''}</td></tr>`;
    }).join('');
  },
};
