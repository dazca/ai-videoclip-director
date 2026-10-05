// Self-checks exposed on window.WB for headless verification (and for an agent driving the page):
//   WB.alignTest(times?)  for each time: where it is actually drawn in every visible column (DOM rects for text,
//                         the painted canvas row for lanes, the playhead element), compared with y(t). Max deviation in px.
//   WB.perfResize(col, widths)  time per width step: re-warp + forced layout.
import { store } from './store.js';

export function installVerify(ctx) {
  const WB = window.WB;

  WB.pickTimes = () => {
    const tl = ctx.timeline, lyr = tl.byId.lyrics;
    const out = [];
    const wrapped = lyr.items.filter(it => !it.first);            // wrapped visual lines ("letters jump")
    if (wrapped.length) out.push(wrapped[Math.floor(wrapped.length * 0.2)].t0, wrapped[Math.floor(wrapped.length * 0.7)].t0);
    const notesT = new Set(store.notes.notes.map(n => n.target?.t));
    const nl = store.song.lines.find(l => notesT.has(l.t0) && l.t0 > 20000); if (nl) out.push(nl.t0);
    const S = store.song.sections, L = store.song.lines;
    for (const i of [3, 10]) if (S[i]) out.push(S[i].t0);          // section starts = shot cuts = downbeats
    for (let k = 1; out.length < 5 && k <= 8; k++) {                  // then lyric line onsets, else section starts
      const t = L.length ? L[(out.length * 17 + k) % L.length].t0 : S[k % S.length]?.t0;
      if (t != null && !out.includes(t)) out.push(t);
    }
    return out.slice(0, 5);
  };

  WB.alignTest = (times) => {
    const tl = ctx.timeline;
    times = times || WB.pickTimes();
    const rows = [];
    for (const t of times) {
      tl.scrollToTime(t); tl.drawLanes(); tl.seek(t);
      const sheetTop = tl.sheet.getBoundingClientRect().top;
      const ref = tl.warp.y(t);
      const m = { playhead: tl.playhead.getBoundingClientRect().top - sheetTop };
      for (const c of tl.cols) {
        if (c.hidden) continue;
        if (c.def.kind === 'lane' || c.strip) {
          // the canvas row whose painted time span contains t, offset by where the canvas really is on the page
          const { dpr, rows: n } = tl.lastRows;
          let r = 0; while (r < n && tl.rowsT[r + 1] <= t) r++;
          const canvasTop = c.canvas.getBoundingClientRect().top - sheetTop;
          m[c.id] = canvasTop + r / dpr;
        } else {
          const it = c.items.find(x => x.t0 === t);
          if (it) m[c.id] = it.el.getBoundingClientRect().top - sheetTop;
        }
      }
      const devs = Object.values(m).map(v => Math.abs(v - ref));
      // a time with nothing measured counts as a failure (Math.max() of nothing is -Infinity)
      rows.push({ t, ref: +ref.toFixed(2), maxDev: devs.length ? +Math.max(...devs).toFixed(3) : Infinity, n: devs.length, cols: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, +v.toFixed(2)])) });
    }
    const worst = rows.length ? Math.max(...rows.map(r => r.maxDev)) : Infinity;
    return { pass: worst <= 1, worstPx: worst, rows };
  };

  WB.perfResize = (col, widths) => {
    const tl = ctx.timeline, out = [];
    for (const w of widths) {
      const t0 = performance.now();
      tl.setWidth(col, w);
      void document.body.offsetHeight;               // include the browser's own layout of the moved items
      out.push(+(performance.now() - t0).toFixed(2));
    }
    return out;
  };
}
