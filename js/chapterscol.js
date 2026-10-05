// The timeline's chapters band (ROADMAP_v4 E3): one block per chapter of storyboard.json `chapters` (js/chapters.js) over
// its scenes' time, with its name, owner and DERIVED build status (planned / generating / built / approved) and how many
// shots still render as placeholders. Click = seek to its start; double-click = open it in the storyboard.
import { fmt } from './timeline.js';
import { esc } from './store.js';
import { currentScript } from './scenes.js';
import { chaptersView } from './chapters.js';

const CSS = `.tl .col-chapters .it{overflow:hidden}
.tl .chp{height:100%;box-sizing:border-box;border-left:3px solid var(--chc,#777);border-top:1px solid var(--chc,#777);background:color-mix(in srgb,var(--chc,#777) 14%,transparent);font-size:11px;line-height:13px;padding:0 2px;cursor:pointer;overflow:hidden}
.tl .chp b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.tl .chp i{display:block;font-style:normal;font-size:10px;color:var(--chc,#aaa);white-space:nowrap}
.tl .chp span{display:block;font-size:10px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl .chp.st-planned{--chc:#8a8f98}.tl .chp.st-generating{--chc:#f5a524}.tl .chp.st-built{--chc:#5aa9e6}.tl .chp.st-approved{--chc:#46a758}`;

export function chaptersColumn(tl, store) {
  if (typeof document !== 'undefined' && !document.getElementById('chcolcss')) { const st = document.createElement('style'); st.id = 'chcolcss'; st.textContent = CSS; document.head.appendChild(st); }
  return {
    id: 'chapters', title: 'chapters', kind: 'text', w: 74, hidden: true, mode: 'follow', stripColor: '#5aa9e6',
    build(c) {
      c.body.innerHTML = ''; c.items = [];
      const view = chaptersView(store.board, { scenes: currentScript(store.scenes)?.scenes || [], shots: store.boardShots(), approvals: store.approvals, requests: store.requests });
      for (const ch of view) {
        if (ch.t0 == null) continue;
        const e = document.createElement('div'); e.className = 'it';
        e.innerHTML = `<div class="chp st-${esc(ch.status)}" data-act="seek" data-t="${ch.t0}" data-sel="chapter:${esc(ch.id)}" title="${esc(`${ch.id} ${ch.name} · ${fmt(ch.t0, true)}–${fmt(ch.t1, true)} · ${ch.status}: ${ch.why}${ch.owner ? '\nowner: ' + ch.owner : ''}${ch.file ? '\nbuilt in: ' + ch.file : ''}\n(double-click: open in the storyboard)`)}"><b>${esc(ch.name)}</b><i>${esc(ch.status)}${ch.shots ? ` ${ch.picked}/${ch.shots}` : ''}</i>${ch.owner ? `<span>${esc(ch.owner)}</span>` : ''}</div>`;
        c.body.appendChild(e); c.items.push({ t0: ch.t0, t1: ch.t1, el: e, x: ch });
      }
    },
    act(c, a) { if (a.dataset.act === 'seek') tl.seek(Number(a.dataset.t)); },
    refresh(c, what) { if (!['board', 'scenes', 'approvals', 'requests'].includes(what)) return false; this.build(c); return true; },
    dblclick(c, t) {
      const ch = chaptersView(store.board, { scenes: currentScript(store.scenes)?.scenes || [], shots: store.boardShots() }).find(x => x.t0 != null && x.t0 <= t && t < x.t1);
      window.WB?.stages?.open('storyboard').then(() => ch && window.WB.storyboard?.focusChapter?.(ch.id));
    },
  };
}
