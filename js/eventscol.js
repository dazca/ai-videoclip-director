// The timeline's events column (ROADMAP_v4 E1): the named sync points of events.json (js/events.js) at their song time.
// One row per event (an importer's section starts are left to the sections column): its kind icon, name, ⚓n = the scene /
// shot boundaries anchored to it, a proposed (agent) event dashed with "accept"; an event measured elsewhere than its time
// (the chosen take moved it) shows "→ m:ss.mmm" and a ghost row at the measured time, until the director re-times.
// Click = seek; drag an event up / down = set its measured time (the ghost line shows where); double-click an event = edit,
// an empty spot = "+ Named event here". Right-click: the event's menu (core/events.js). The page acts go through
// WB.events (core/events.js: events_act, page only).
import { el, fmt } from './timeline.js';
import { esc } from './store.js';
import * as E from './events.js';
import { currentScript } from './scenes.js';

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const CSS = `.tl .col-events .it{overflow:visible}
.tl .evn{font-size:11px;line-height:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--fg);cursor:grab;border-top:1px solid var(--evc,#f5a524);padding-left:1px}
.tl .evn i{font-style:normal;color:var(--evc,#f5a524);display:inline-block;width:11px}
.tl .evn b{font-weight:normal}
.tl .evn .anc{color:var(--acc);margin-left:3px;font-size:10px}
.tl .evn .ms{color:#f08080;margin-left:3px;font-size:10px}
.tl .evn .acc{margin-left:4px;font-size:10px;padding:0 3px;border:1px solid var(--acc);color:var(--acc);cursor:pointer}
.tl .evn.st-proposed{border-top-style:dashed;color:var(--dim);font-style:italic}
.tl .evn.dragging{opacity:.5}
.tl .evg{font-size:10px;line-height:12px;color:#f08080;border-top:1px dashed #f08080;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.evdrag{position:fixed;height:0;border-top:1px dashed #f08080;z-index:40;pointer-events:none}
.evdrag span{position:absolute;right:0;top:-14px;font:11px Consolas,monospace;background:#f08080;color:#000;padding:0 3px}`;

export function eventsColumn(tl, store) {
  if (!document.getElementById('evcolcss')) { const st = document.createElement('style'); st.id = 'evcolcss'; st.textContent = CSS; document.head.appendChild(st); }
  const ctxOf = () => ({ scenes: currentScript(store.scenes)?.scenes || [], shots: store.boardShots() });
  const W = () => window.WB?.events;
  return {
    id: 'events', title: 'events', kind: 'text', w: 104, mode: 'follow', stripColor: '#f5a524',
    build(c) {
      c.body.innerHTML = ''; c.items = [];
      const cx = ctxOf(), list = store.events.filter(e => e.status !== 'dismissed' && e.kind !== 'section');
      const rows = [];
      for (const e of list) {
        rows.push({ t0: e.t, e });
        if (Number.isFinite(e.measured) && e.measured !== e.t) rows.push({ t0: e.measured, e, ghost: true });
      }
      rows.sort((a, b) => a.t0 - b.t0 || (a.ghost ? 1 : -1));
      for (const r of rows) {
        const e = r.e, node = el('div', 'it');
        if (r.ghost) node.innerHTML = `<div class="evg" data-act="seek" data-t="${num(e.measured)}" data-ev="${esc(e.id)}" title="${esc(`${e.name}: measured at ${fmt(e.measured, true)} (its boundaries are still at ${fmt(e.t, true)}): Timeline › Re-time… moves them`)}">↳ ${esc(e.name)} measured</div>`;
        else {
          const n = E.anchoredTo(e.id, cx).length, pend = Number.isFinite(e.measured) && e.measured !== e.t;
          node.innerHTML = `<div class="evn k-${esc(e.kind)} st-${esc(e.status)}${pend ? ' pend' : ''}" style="--evc:${E.KIND_COLOR[e.kind] || '#f5a524'}" data-act="seek" data-t="${num(e.t)}" data-ev="${esc(e.id)}" data-sel="event:${esc(e.id)}"`
            + ` title="${esc(`${e.name} (${e.id}) · ${E.KIND_LABEL[e.kind] || e.kind} · ${fmt(e.t, true)}${pend ? ` · measured ${fmt(e.measured, true)}` : ''}${e.status === 'proposed' ? ' · proposed by the agent' : ''}${n ? ` · ${n} boundar${n === 1 ? 'y' : 'ies'} anchored` : ''}${e.note ? '\n' + e.note : ''}\n(drag: set where it really landed · double-click: edit · right-click: more)`)}">`
            + `<i>${E.KIND_ICON[e.kind] || '·'}</i><b>${esc(e.name)}</b>${n ? `<span class="anc" title="anchored boundaries">⚓${n}</span>` : ''}${pend ? `<span class="ms">→ ${fmt(e.measured, true)}</span>` : ''}${e.status === 'proposed' ? '<span class="acc" data-act="evacc" title="proposed by the agent: accept it (then boundaries can snap / anchor to it)">✓</span>' : ''}</div>`;
        }
        c.body.appendChild(node); c.items.push({ t0: r.t0, el: node, x: r });
      }
      if (!c._evDrag) { c._evDrag = true; bindDrag(c); }
    },
    ticks: () => store.events.filter(e => e.status !== 'dismissed' && e.kind !== 'section').map(e => ({ t0: e.t })),
    act(c, a) {
      if (a.dataset.act === 'evacc') { W()?.accept(a.closest('[data-ev]').dataset.ev); return; }
      if (a.dataset.act === 'seek') tl.seek(Number(a.dataset.t));
    },
    refresh(c, what) { if (!['events', 'scenes', 'board'].includes(what)) return false; this.build(c); return true; },
    dblclick(c, t, e) { const ev = e.target.closest('[data-ev]'); if (ev) W()?.edit(ev.dataset.ev); else W()?.addAt(t); },
  };

  // drag an event row: its measured time follows the pointer (the timeline's inverse map); a plain click still seeks
  function bindDrag(c) {
    c.el.addEventListener('pointerdown', (e) => {
      const row = e.button === 0 && !e.shiftKey && e.target.closest('.evn[data-ev]'); if (!row || e.target.closest('[data-act=evacc]')) return;
      const id = row.dataset.ev, y0 = e.clientY; let on = false, line = null, t = null;
      const move = (ev) => {
        if (!on && Math.abs(ev.clientY - y0) < 4) return;
        if (!on) { on = true; row.classList.add('dragging'); line = document.createElement('div'); line.className = 'evdrag'; line.innerHTML = '<span></span>'; document.body.appendChild(line); }
        t = Math.max(0, Math.min(store.song.duration_ms, tl.timeAtClientY(ev.clientY)));
        const r = tl.sheet.getBoundingClientRect(), y = r.top + tl.warp.y(t);
        Object.assign(line.style, { left: Math.max(0, tl.root.getBoundingClientRect().left) + 'px', width: tl.root.clientWidth + 'px', top: y + 'px' });
        line.firstChild.textContent = `${id} measured ${fmt(t, true)}`;
      };
      const stop = () => {
        removeEventListener('pointermove', move); removeEventListener('pointerup', stop); removeEventListener('pointercancel', stop);
        if (!on) return;
        row.classList.remove('dragging'); line?.remove();
        tl._dragged = true; setTimeout(() => { tl._dragged = false; }, 0);
        if (t != null) W()?.measure(id, t);
      };
      addEventListener('pointermove', move); addEventListener('pointerup', stop); addEventListener('pointercancel', stop);
    });
  }
}
