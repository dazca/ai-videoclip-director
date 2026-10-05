// The lyric gate in the storyboard Shot panel (ROADMAP_v4 E2): "Lyrics on screen". For the selected shot: the lyric
// lines sung during it, each word red when it is on no surface at its time; the surfaces of this shot (where each line /
// word range shows: window title, chat, dialog, karaoke, taskbar, other) with ×; the agent's proposals with Accept / ×;
// and a one-line form to add one (click a word to set the range, Shift+click to extend it). Every act is surface_act
// (page only): a NEW storyboard version with shot.lyrics changed. Logic and shapes: js/surfaces.js; server:
// lib/ops/surfaces.mjs. Mounted by tabs/storyboard.js: mountSurfaces(host, {shot}).
import { store, esc, toast, postJSON } from '../js/store.js';
import * as SF from '../js/surfaces.js';
import * as SB from '../js/storyboard.js';

const ST = new Map();   // per shot: {line, a, b, kind, detail}
const savedShot = (id) => SB.boardShots(store.board).find(s => s.id === id) || null;
const linesIn = (s) => (store.song?.lines || []).filter(L => SF.lineWords(L).some(w => w.t0 < s.t1 && Math.max(w.t1, w.t0 + 1) > s.t0));

async function act(body) {
  const r = await postJSON('/api/op/surface_act', body), j = await r.json().catch(() => ({}));
  if (!r.ok) { toast('surface: ' + (j.error || `HTTP ${r.status}`)); return null; }
  return j;
}

export function surfacesHtml(shotId) {
  const s = savedShot(shotId);
  if (!s) return `<div class="sfx dim">save the storyboard first: surfaces live on a saved shot</div>`;
  const cov = SF.coverage(store.song, SB.boardShots(store.board)), byLine = new Map(cov.lines.map(l => [l.id, l])), L = linesIn(s), st = ST.get(s.id) || {};
  const lineId = L.some(l => l.id === st.line) ? st.line : L[0]?.id || '';
  const words = (l) => l.words.map(w => { const at = w.t0 < s.t1 && Math.max(w.t1, w.t0 + 1) > s.t0, sel = lineId === l.id && st.a != null && w.i >= st.a && w.i <= (st.b ?? st.a);
    return `<span class="sfw ${w.by.length ? 'on' : 'un'}${at ? '' : ' out'}${sel ? ' sel' : ''}" data-sfw="${esc(l.id)}:${w.i}" title="${esc(w.by.length ? w.by.map(b => `${b.shot} · ${b.where}`).join('\n') : at ? 'on no surface' : 'sung outside this shot')}">${esc(w.w)}</span>`; }).join(' ');
  const rows = L.map(Lr => { const l = byLine.get(Lr.id); return `<div class="sfrow${l.covered === l.n ? ' ok' : ''}"><i class="sfn">${l.covered}/${l.n}</i><span class="sfid">${esc(l.id)}</span> ${words(l)}</div>`; }).join('');
  const mine = (s.lyrics || []).map((e, i) => `<div class="sfe"><b>${esc(e.where)}</b><span class="dim">${esc(e.line)}${e.w ? ` · “${esc(SF.lineWords(store.song.lines.find(x => x.id === e.line)).slice(e.w[0], e.w[1] + 1).map(x => x.w).join(' '))}”` : ' · the whole line'}</span><b data-sf="rm" data-i="${i}" title="take it off this shot">×</b></div>`).join('');
  const props = SF.openProposals(store.surfaces, s.id).map(p => `<div class="sfp" data-p="${esc(p.id)}"><span class="who ag">agent</span><b>${esc(p.where)}</b><span class="dim">${esc(p.line)}${p.w ? ` w${p.w[0]}–${p.w[1]}` : ''} · ${esc(p.why)}</span><button data-sf="ok" class="pri" title="put it on the shot (a new storyboard version)">Accept</button><b data-sf="no" title="dismiss">×</b></div>`).join('');
  const kind = SF.WHERE.includes(st.kind) ? st.kind : 'window';
  const form = L.length ? `<div class="sfadd"><select class="sf-line" title="the lyric line">${L.map(l => `<option value="${esc(l.id)}"${l.id === lineId ? ' selected' : ''}>${esc(l.id)}</option>`).join('')}</select>`
    + `<span class="dim sfrng" title="click a word above to set the range, Shift+click to extend it">${st.a != null && lineId === st.line ? `w${st.a}–${st.b ?? st.a}` : 'whole line'}</span>`
    + `<select class="sf-kind">${SF.WHERE.map(k => `<option value="${k}"${k === kind ? ' selected' : ''}>${esc(SF.WHERE_LABEL[k])}</option>`).join('')}</select>`
    + `<input class="sf-detail" maxlength="100" placeholder="detail: Notepad, typed…" value="${esc(st.detail || '')}" spellcheck="false"><button data-sf="add">+ surface</button></div>` : '';
  return `<div class="sfx" data-shot="${esc(s.id)}">${rows || '<div class="dim">no lyric is sung during this shot</div>'}${mine}${props}${form}</div>`;
}

export function mountSurfaces(host, { shot }) {
  host.innerHTML = surfacesHtml(shot);
  if (host._sfWired) return; host._sfWired = true;
  const state = () => { const id = host.querySelector('.sfx')?.dataset.shot; if (!id) return null; if (!ST.has(id)) ST.set(id, {}); return { id, st: ST.get(id) }; };
  const rerender = () => { const id = host.querySelector('.sfx')?.dataset.shot; if (id) host.innerHTML = surfacesHtml(id); };
  host.addEventListener('click', async (e) => {
    const x = state(); if (!x) return; const { id, st } = x;
    const w = e.target.closest('[data-sfw]');
    if (w) { const [line, i] = [w.dataset.sfw.slice(0, w.dataset.sfw.lastIndexOf(':')), Number(w.dataset.sfw.slice(w.dataset.sfw.lastIndexOf(':') + 1))];
      if (e.shiftKey && st.line === line && st.a != null) { st.a = Math.min(st.a, i); st.b = Math.max(st.b ?? st.a, i); } else { st.line = line; st.a = i; st.b = i; }
      return rerender(); }
    const a = e.target.closest('[data-sf]')?.dataset.sf; if (!a) return;
    e.stopPropagation();
    if (a === 'rm') { const j = await act({ act: 'remove', shot: id, index: Number(e.target.dataset.i) }); if (j) toast(`${id}: surface removed · ${j.version}`); }
    if (a === 'ok' || a === 'no') { const p = e.target.closest('[data-p]').dataset.p, j = await act({ act: a === 'ok' ? 'accept' : 'dismiss', proposal: p }); if (j) toast(a === 'ok' ? `${id}: ${p} accepted · ${j.version}` : `${p} dismissed`); }
    if (a === 'add') {
      const line = host.querySelector('.sf-line')?.value, kind = host.querySelector('.sf-kind')?.value, detail = host.querySelector('.sf-detail')?.value.trim() || '';
      const where = detail ? `${kind}: ${detail}` : kind, w = st.line === line && st.a != null ? [st.a, st.b ?? st.a] : undefined;
      const j = await act({ act: 'add', shot: id, line, ...(w ? { w } : {}), where });
      if (j) { st.a = st.b = null; st.detail = ''; toast(j.unchanged ? `${id}: already there` : `${id}: ${line} on "${where}" · ${j.version}`); }
    }
  });
  host.addEventListener('change', (e) => { const x = state(); if (!x) return; if (e.target.matches('.sf-line')) { x.st.line = e.target.value; x.st.a = x.st.b = null; rerender(); } if (e.target.matches('.sf-kind')) x.st.kind = e.target.value; });
  host.addEventListener('input', (e) => { const x = state(); if (x && e.target.matches('.sf-detail')) x.st.detail = e.target.value; });
  host.addEventListener('keydown', (e) => { if (e.target.matches('.sf-detail')) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); host.querySelector('[data-sf="add"]')?.click(); } } });
}
