// Review › Compare (SPEC v4 §2; ROADMAP_v4 B8): two revisions side by side, per stage. Left: the revisions (R<n> with
// their round, summary, notes absorbed, files and cost; a click compares one with the one before; restore takes two
// clicks). Right: A → B (default: the latest revision against the previous one, or "R0", the state before the first
// round): the lyric lines changed (word diff), scenes and shots added / removed / moved on a mini time line, breakdown
// items, asset tree heads as image A / B, the cost delta, and the notes absorbed in between: each change carries chips
// of the notes that caused it (absorbed_in + the agent's change summary). The data comes from POST /api/op/revision_compare
// (the snapshots are not served to the page); restoring is POST /api/op/revision_restore (page only).
import { store, esc, mediaUrl, postJSON } from '../js/store.js';

const clock = (ms) => { const s = Math.max(0, ms || 0) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const usd = (x) => `$${(Number(x) || 0).toFixed(2)}`;
const sgn = (x) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}$${Math.abs(Number(x) || 0).toFixed(2)}`;
const day = (s) => s ? String(s).replace('T', ' ').slice(5, 16) : '';
const ST = { added: '+', removed: '−', moved: '↔', changed: '~', dropped: '⌫', same: '' };
const runs = (rs) => (rs || []).map(r => r.op === '=' ? `<span>${esc(r.t)}</span>` : r.op === '+' ? `<ins>${esc(r.t)}</ins>` : `<del>${esc(r.t)}</del>`).join(' ');

export default {
  mount(el) {
    el.classList.add('pane', 'cmp');
    el.innerHTML = '<div class="cmpl"></div><div class="cmpr"><div class="cmph"></div><div class="cmpb"></div></div>';
    const $ = (s) => el.querySelector(s);
    let sel = { a: null, b: null }, auto = true, data = null, seq = 0, armed = null;   // auto: follow the newest revision
    const rv = () => store.revisions || { revisions: [], rounds: [] };
    const options = () => {
      const R = rv().revisions, o = [{ id: 'now', label: 'now (the files as they are)' }];
      for (const r of [...R].reverse()) o.push({ id: r.id, label: `${r.id} · ${r.summary}`.slice(0, 70) });
      if (R.some(r => r.base)) o.push({ id: 'R0', label: 'R0 · before round 1' });
      return o;
    };
    const defaults = () => {
      const R = rv().revisions;
      if (!R.length) return { a: null, b: null };
      const b = R.at(-1).id, a = R.length > 1 ? R.at(-2).id : R[0].base ? 'R0' : 'now';
      return a === 'now' ? { a: b, b: 'now' } : { a, b };
    };
    const list = () => {
      const R = rv().revisions, live = (rv().rounds || []).find(r => r.status === 'sent' || r.status === 'finished');
      $('.cmpl').innerHTML = `<div class="cmplh"><b>Revisions</b> <span class="dim">${R.length || 'none yet'}</span>${store.settings?.revisions_git ? ' <span class="dim" title="each revision is also a commit in data/&lt;project&gt;/.history">· git</span>' : ''}</div>`
        + (live ? `<div class="cmpr0 live" title="the round in flight becomes the next revision when you close it"><b>round ${esc(live.n)}</b> <span class="dim">${esc(live.status === 'sent' ? 'with Claude' : 'finished: close it on the rail')}</span></div>` : '')
        + [...R].reverse().map((r, i, arr) => `<div class="cmpr0${sel.b === r.id ? ' on' : ''}${sel.a === r.id ? ' isa' : ''}" data-rid="${esc(r.id)}" data-prev="${esc(arr[i + 1]?.id || (r.base ? 'R0' : ''))}">
            <div><b>${esc(r.id)}</b> <span class="dim">${esc(day(r.created))}${r.round ? ` · round ${esc(r.round)}` : ''}</span><a class="rst" data-restore="${esc(r.id)}" title="restore the project files to ${esc(r.id)} (the current state is snapshotted first; notes are kept)">${armed === r.id ? 'confirm restore?' : 'restore'}</a></div>
            <div class="cmps">${esc(r.summary || '')}</div>
            <div class="dim">${r.notes_absorbed.length} absorbed${r.notes_replied?.length ? ` · ${r.notes_replied.length} replied` : ''} · ${r.files_changed.length} file${r.files_changed.length === 1 ? '' : 's'}${r.cost_delta ? ` · ${sgn(r.cost_delta)}` : ''}${r.git?.commit ? ` · git ${esc(r.git.commit)}` : ''}</div></div>`).join('')
        + (R.some(r => r.base) ? `<div class="cmpr0 r0${sel.a === 'R0' ? ' isa' : ''}"><b>R0</b> <span class="dim">before round 1</span></div>` : '')
        + (R.length ? '' : '<p class="dim">Write notes in any stage, <b>Send round to Claude</b> (stage rail), and when Claude is done <b>Close revision</b>: each revision is a snapshot of the whole project you can compare and restore here.</p>');
    };
    const head = () => {
      const opts = options(), o = (v) => opts.map(x => `<option value="${esc(x.id)}"${x.id === v ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
      const d = data, n = d ? d.notes.length : 0;
      $('.cmph').innerHTML = !sel.b ? '' : `<select class="cmpa" title="A: the older side">${o(sel.a)}</select> → <select class="cmpb2" title="B: the newer side">${o(sel.b)}</select>`
        + (d ? ` <span class="cmpsum">${[d.lyrics.lines.length && `lyrics ${d.lyrics.lines.length} line${d.lyrics.lines.length > 1 ? 's' : ''}`, d.script.changed && `script ${d.script.changed}`, d.storyboard.changed && `storyboard ${d.storyboard.changed}`,
          d.breakdown.length && `breakdown ${d.breakdown.length}`, d.assets.length && `assets ${d.assets.length}`, d.cost.delta && `cost ${sgn(d.cost.delta)}`].filter(Boolean).map(x => `<b>${esc(x)}</b>`).join(' · ') || 'no change'} · ${n} note${n === 1 ? '' : 's'} absorbed</span>` : ' <span class="dim">…</span>');
    };
    const chips = (ids) => (ids || []).map(id => { const n = data.notes.find(x => x.id === id); return `<a class="cmpn" data-note="${esc(id)}" title="${esc(n ? `${n.where}: “${n.text}”${n.change ? `\n→ ${n.change.summary}` : ''}` : id)}">✓ ${esc(id)}</a>`; }).join('');
    const lane = (items, side, dur) => `<div class="cmpln"><i>${side.toUpperCase()}</i>${items.filter(x => x[side]).map(x => { const r = x[side], l = 100 * r.t0 / dur, w = Math.max(0.4, 100 * (r.t1 - r.t0) / dur);
      return `<span class="tb st-${x.st}" style="left:${l}%;width:${w}%" title="${esc(`${x.id} ${clock(r.t0)}–${clock(r.t1)} ${x.title || ''} (${x.st})`)}">${esc(x.id)}</span>`; }).join('')}</div>`;
    const timeline = (key, title, d) => {
      const S = d[key], ch = S.items.filter(x => x.st !== 'same'); if (!ch.length) return `<h4>${title} <span class="dim">no change (${S.b})</span></h4>`;
      const dur = Math.max(d.duration_ms, ...S.items.map(x => Math.max(x.a?.t1 || 0, x.b?.t1 || 0)), 1);
      return `<h4>${title} <span class="dim">${S.a} → ${S.b} · ${ch.length} changed</span></h4><div class="cmptl">${lane(S.items, 'a', dur)}${lane(S.items, 'b', dur)}</div>`
        + ch.map(x => `<div class="cmprow st-${x.st}"><b class="sy">${ST[x.st]}</b><b>${esc(x.id)}</b> <span class="dim">${x.a && x.b && x.st === 'moved' ? `${clock(x.a.t0)}–${clock(x.a.t1)} → ${clock(x.b.t0)}–${clock(x.b.t1)}` : `${clock((x.b || x.a).t0)}–${clock((x.b || x.a).t1)}`}</span> ${esc(x.title || '')}${x.kind ? ` <span class="dim">${esc(x.kind)}</span>` : ''}${chips(x.notes)}${x.runs ? `<div class="cmpdf">${runs(x.runs)}</div>` : ''}</div>`).join('');
    };
    const body = () => {
      const d = data, B = $('.cmpb');
      if (!sel.b) { B.innerHTML = ''; return; }
      if (!d) { B.innerHTML = '<p class="dim">loading…</p>'; return; }
      if (d.error) { B.innerHTML = `<p class="dim">${esc(d.error)}</p>`; return; }
      const L = d.lyrics.lines;
      const ly = !L.length ? `<h4>Lyrics <span class="dim">no change (${esc(d.lyrics.b || '—')})</span></h4>` : `<h4>Lyrics <span class="dim">${esc(d.lyrics.a)} → ${esc(d.lyrics.b)} · ${L.length} line${L.length > 1 ? 's' : ''}</span></h4>`
        + L.map(l => `<div class="cmprow op${l.op === '+' ? 'a' : l.op === '-' ? 'r' : 'c'}"><b class="sy">${l.op === '~' ? '~' : l.op === '+' ? '+' : '−'}</b><span class="dim">${esc(l.section || '')} ${esc(l.id)}</span> ${l.runs ? runs(l.runs) : l.op === '+' ? `<ins>${esc(l.b)}</ins>` : `<del>${esc(l.a)}</del>`}${chips(l.notes)}</div>`).join('');
      const bd = !d.breakdown.length ? '<h4>Breakdown <span class="dim">no change</span></h4>' : `<h4>Breakdown <span class="dim">${d.breakdown.length} item${d.breakdown.length > 1 ? 's' : ''}</span></h4>`
        + d.breakdown.map(x => `<div class="cmprow st-${x.st}"><b class="sy">${ST[x.st] || '~'}</b><b>${esc(x.name)}</b> <span class="dim">${esc(x.kind)} ${esc(x.id)}${x.was ? ` · was “${esc(x.was)}”` : ''}${x.fields?.length ? ' · ' + esc(x.fields.join(', ')) : ''}</span>${x.links_added?.length ? ` <ins>+${esc(x.links_added.join(' +'))}</ins>` : ''}${x.links_removed?.length ? ` <del>−${esc(x.links_removed.join(' −'))}</del>` : ''}${chips(x.notes)}</div>`).join('');
      const img = (s, k) => s ? `<figure><div class="im">${s.image ? `<img src="${esc(mediaUrl(s.image))}" alt="" loading="lazy">` : '<span class="dim">no image</span>'}</div><figcaption>${k} ${esc(s.node)}${s.approved ? ' ✓' : ''}${s.private ? ' 🔒' : ''}</figcaption></figure>` : `<figure><div class="im"><span class="dim">—</span></div><figcaption>${k} none</figcaption></figure>`;
      const as = !d.assets.length ? '<h4>Assets <span class="dim">no change</span></h4>' : `<h4>Assets <span class="dim">${d.assets.length} change${d.assets.length > 1 ? 's' : ''}: image A / B</span></h4><div class="cmpab">`
        + d.assets.map(x => `<div class="cmpas st-${x.st}"><div class="cmpat"><b>${esc(x.name)}</b> <span class="dim">${esc(x.kind)}${x.tree ? ' · ' + esc(x.tree) : ''}${x.nodes_added ? ` · +${x.nodes_added} node${x.nodes_added > 1 ? 's' : ''}` : ''}${x.approved ? ` · approved ${esc(x.approved.a || '—')} → ${esc(x.approved.b || '—')}` : ''}</span>${chips(x.notes)}</div>${x.tree ? `<div class="cmpim">${img(x.a, 'A')}<b class="ar">→</b>${img(x.b, 'B')}</div>` : `<div class="dim">${esc(x.st)}</div>`}</div>`).join('') + '</div>';
      const c = d.cost, co = !c.delta && !c.items.length ? `<h4>Cost <span class="dim">no new spend (${usd(c.b)} in all)</span></h4>` : `<h4>Cost <span class="dim">${usd(c.a)} → ${usd(c.b)}</span> <b class="${c.delta > 0 ? 'cmpup' : ''}">${sgn(c.delta)}</b></h4>`
        + c.items.slice(0, 12).map(x => `<div class="cmprow"><span class="dim">${esc(x.id)}</span> ${usd(x.usd)} ${esc(x.tool || '')}${x.request ? ` <span class="dim">${esc(x.request)}</span>` : ''}${x.note ? ` <span class="dim">${esc(x.note)}</span>` : ''}</div>`).join('');
      const nt = !d.notes.length ? '' : `<h4>Notes absorbed <span class="dim">${d.notes.length}: what each one changed</span></h4>`
        + d.notes.map(n => `<div class="cmprow cmpnote" id="cmpn-${esc(n.id)}"><b class="sy">✓</b><b>${esc(n.id)}</b> <span class="dim">${esc(n.where)} · ${esc(n.absorbed_in)}</span> “${esc(n.text.length > 160 ? n.text.slice(0, 159) + '…' : n.text)}”${n.change ? ` → <i>${esc(n.change.summary)}</i>${n.change.file ? ` <span class="dim">${esc(n.change.file)}${n.change.version ? ' ' + esc(n.change.version) : ''}</span>` : ''}` : ''}</div>`).join('');
      B.innerHTML = ly + timeline('script', 'Script', d) + timeline('storyboard', 'Storyboard', d) + bd + as + co + nt;
    };
    const load = async () => {
      const my = ++seq; data = null; head(); body();
      if (!sel.b) return;
      try {
        const r = await postJSON('/api/op/revision_compare', { a: sel.a, b: sel.b }), j = await r.json();
        if (my !== seq) return;
        data = r.ok ? j : { error: j.error || `HTTP ${r.status}` };
      } catch (e) { if (my === seq) data = { error: String(e.message || e) }; }
      list(); head(); body();
    };
    const render = () => { if (auto || !sel.b || (sel.b !== 'now' && !rv().revisions.some(r => r.id === sel.b))) { sel = defaults(); auto = true; } list(); load(); };
    el.addEventListener('change', (e) => {
      if (e.target.matches('.cmpa')) { sel.a = e.target.value; auto = false; list(); load(); }
      if (e.target.matches('.cmpb2')) { sel.b = e.target.value; auto = false; list(); load(); }
    });
    el.addEventListener('click', (e) => {
      const rs = e.target.closest('[data-restore]');
      if (rs) {
        const id = rs.dataset.restore;
        if (armed !== id) { armed = id; list(); setTimeout(() => { if (armed === id) { armed = null; list(); } }, 4000); return; }
        armed = null; window.WB.rounds.restore(id).then(() => load()).catch(() => {}); return;
      }
      const n = e.target.closest('[data-note]');
      if (n) { const t = el.querySelector(`#cmpn-${CSS.escape(n.dataset.note)}`); if (t) { t.scrollIntoView({ block: 'nearest' }); t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); } return; }
      const row = e.target.closest('[data-rid]');
      if (row) { auto = false; sel = { a: row.dataset.prev || 'now', b: row.dataset.rid }; if (sel.a === 'now') sel = { a: row.dataset.rid, b: 'now' }; list(); load(); }
    });
    store.on((w) => { if (w === 'revisions' || w === 'all') render(); });
    this._render = render;
    render();
    this.api = { select: (a, b) => { sel = { a, b }; auto = false; list(); return load(); }, data: () => data, sel: () => ({ ...sel }) };
    window.WB = Object.assign(window.WB || {}, { compare: this.api });
  },
  show() { this._render?.(); },
};
