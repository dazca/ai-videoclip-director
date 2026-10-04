// Characters / Locations / Props (SPEC v2 section 8): images do the talking. Characters = cards with a big face, the
// full body and a strip of head angles / expressions cropped from the 3x3 sheets; click = character page (identity
// sheet, LOOKS as cards with "+ New look", expressions, motion clips, lives). Locations = establishing image + angles /
// times of day + clips shot there + "+ New angle / time of day". Props = hero image + "+ New variant".
// Every image carries data-media (hover = dock preview, right-click = media menu); cards carry data-ent (entity menu).
import { store, mediaUrl, isPrivatePath, prefs } from '../js/store.js';
import { fmt } from '../js/timeline.js';
import { openLookForm } from '../core/partb.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const M = (p) => store.mediaByPath[p];
const lock = (p) => isPrivatePath(p) ? '<i class="lock" title="private: crop of a real photo; local only, never exported">🔒</i>' : '';
const thumb = (p) => mediaUrl(M(p)?.thumb || p);
export function im(p, cls = '', label = '') {
  if (!p) return `<div class="im ${cls} none"></div>`;
  const m = M(p);
  return `<div class="im ${cls}" ${m ? `data-media="${esc(m.id)}"` : `data-dock="image:${esc(p)}"`} ${m?.strip ? `data-strip="${esc(m.strip)}" data-n="${m.strip_n}"` : ''} title="${esc(label || m?.label || p)}">${lock(p)}<img src="${esc(thumb(p))}" alt="" loading="lazy">${label ? `<span class="il">${esc(label)}</span>` : ''}</div>`;
}
// one cell of a 3x3 sheet, cropped with CSS from the sheet's 600 px thumbnail
function cells(p, n = 9, cls = 'c3') {
  const m = M(p); if (!m) return '';
  return Array.from({ length: n }, (_, i) => `<i class="${cls}" data-media="${esc(m.id)}" title="${esc(m.label)} · cell ${i + 1}" style="background-image:url('${esc(mediaUrl(m.thumb))}');background-position:${(i % 3) * 50}% ${Math.floor(i / 3) * 50}%"></i>`).join('');
}
const chip = (k) => { const s = store.state(k); return `<span class="chip s-${s}" data-k="${esc(k)}" title="${s} (click to cycle)">${s}</span>`; };
function used(list, max = 10) {
  if (!list?.length) return '<span class="dim">not on the timeline</span>';
  return list.slice(0, max).map(u => `<a data-t="${u.t}" data-dock="shot:${esc(u.shot)}" title="${esc(u.shot)} at ${fmt(u.t, true)}">${esc(u.shot)}</a>`).join(' ') + (list.length > max ? ` <span class="dim">+${list.length - max}</span>` : '');
}
const sw = (cols) => (cols || []).map(c => `<i class="sw" style="background:${esc(c)}" title="${esc(c)}"></i>`).join('');
const usd = (n) => n ? `$${n.toFixed(2)}` : '';
const clipMedia = (g) => { const take = store.uses.find(u => u.clip === g)?.take ?? 0; return store.media.find(m => m.kind === 'clip' && m.job === g && m.take === take); };

// ------------------------------------------------------------------ characters
function charGrid() {
  const C = store.entities.filter(e => e.kind === 'character');
  const leads = C.filter(e => !e.life_of), lives = C.filter(e => e.life_of && e.id.startsWith('avatar')), dancers = C.filter(e => /^[dh]\d$/.test(e.id));
  const lead = (e) => `<div class="cc card lead" data-ent="${esc(e.id)}" data-open="${esc(e.id)}">
      <div class="ch">${chip('character:' + e.id)}<b>${esc(e.name)}</b> <span class="dim">${(e.looks || []).length} looks · ${(e.motion || []).length} dances${e.lives ? ' · ' + e.lives.length + ' lives' : ''}</span>${e.private_refs?.length ? ' <i class="lock" title="has private identity refs (local only)">🔒</i>' : ''}</div>
      <div class="cb">${im(e.face, 'face')}${im(e.body, 'body')}<div class="strip">${cells(e.sheets?.angles?.[0])}${cells(e.sheets?.expressions?.[0])}${!e.sheets?.angles ? (e.sheets?.['full body'] || []).map(p => im(p, 'sq')).join('') + (e.looks || []).flatMap(l => l.images.slice(2, 4)).map(p => im(p, 'sq')).join('') : ''}</div></div>
      <div class="cr">${esc(e.role || '')}</div></div>`;
  const life = (e) => `<div class="cc card life" data-ent="${esc(e.id)}" data-open="${esc(e.id)}"><div class="ch">${chip('character:' + e.id)}<b>${esc(e.name)}</b></div>${im(e.face, 'wide')}<div class="cu">${used(e.looks?.[0]?.used, 4)}</div></div>`;
  const dancer = (e) => { const mo = e.motion?.[0]; return `<div class="cc card life" data-ent="${esc(e.id)}"><div class="ch">${chip('character:' + e.id)}<b>${esc(e.name)}</b> <span class="dim">${esc(mo?.name || '')}</span></div>${im(mo?.dancer || mo?.clip, 'wide fit')}<div class="cu">${used(mo?.used, 4)}</div></div>`; };
  return `<div class="lib"><div class="sec">leads</div><div class="cgrid">${leads.map(lead).join('')}</div>
    ${lives.length ? `<div class="sec">lives of ${esc([...new Set(lives.map(e => store.entityById[e.life_of]?.name || e.life_of))].join(', '))} <span class="dim">(avatars: the same person in another life; each is a look of the lead)</span></div><div class="cgrid sm">${lives.map(life).join('')}</div>` : ''}
    ${dancers.length ? `<div class="sec">dancers <span class="dim">(motion-transfer loops; hover to scrub)</span></div><div class="cgrid sm">${dancers.map(dancer).join('')}</div>` : ''}</div>`;
}
function lookCard(e, l) {
  const hero = l.images.find(p => /b_variations|H0/.test(p)) || l.images[0];
  return `<div class="lc" data-ent="${esc(e.id)}" data-look="${esc(e.id)}/${esc(l.id)}" data-dock="look:${esc(e.id)}/${esc(l.id)}">
    ${im(hero, 'lim')}<div class="lt">${l.images.filter(p => p !== hero).slice(0, 4).map(p => im(p, 'mini')).join('')}</div>
    <div class="ln"><b>${esc(l.name)}</b>${l.base ? ' <span class="tag">base</span>' : ''}${l.variant_of ? ` <span class="tag" title="variant of ${esc(l.variant_of)}">var</span>` : ''}</div>
    <div class="lg">${esc((l.garments || []).join(' · '))}</div>
    <div class="lm">${sw(l.colors)} <span class="chip s-${l.status === 'approved' ? 'approved' : 'draft'}">${l.status}</span> <span class="dim">${usd(l.cost_usd)}</span></div>
    <div class="lu">${used(l.used, 6)}</div></div>`;
}
function charPage(e) {
  const sheets = Object.entries(e.sheets || {});
  const allExpr = (e.sheets?.expressions || []);
  const requests = (store.requests?.items || []).filter(r => r.target === `character:${e.id}` && r.kind === 'new-costume');
  return `<div class="lib page"><div class="pbar" data-ent="${esc(e.id)}"><a data-back>‹ characters</a> ${chip('character:' + e.id)}<b>${esc(e.name)}</b> <span class="dim">${esc(e.role || '')}</span>${e.life_of ? ` <span class="dim">· a life of</span> <a data-open="${esc(e.life_of)}">${esc(store.entityById[e.life_of]?.name)}</a>` : ''}</div>
    <div class="sec">identity sheet</div>
    <div class="idrow">${im(e.face, 'face xl')}${im(e.body, 'body xl')}${sheets.map(([k, ps]) => ps.slice(0, 2).map((p, i) => im(p, 'sheet', i ? '' : k)).join('')).join('')}</div>
    ${e.identity ? `<div class="idtx">${esc(e.identity)}</div>` : ''}
    ${e.private_refs?.length ? `<div class="sec">private identity refs <span class="dim">(crops of real photos: this machine only, never exported)</span></div><div class="prow">${[...e.private_refs, ...(e.private_media || []).map(id => store.mediaById[id]?.path).filter(Boolean)].filter((p, i, a) => a.indexOf(p) === i).map((p, i, a) => i < 18 ? im(p, 'priv') : i === 18 ? `<span class="dim more">+${a.length - 18} in Media (private)</span>` : '').join('')}</div>` : ''}
    <div class="sec">looks <span class="dim">${(e.looks || []).length} · right-click a look: duplicate, variant, where used</span></div>
    <div class="lgrid">
      <div class="lc add" data-newlook="${esc(e.id)}" title="design a new costume: draft generation request with a cost estimate"><span class="plus">+</span><b>New look</b><span class="dim">name, garments, colours, refs</span></div>${(e.looks || []).map(l => lookCard(e, l)).join('')}
      ${requests.map(r => `<div class="lc req" title="${esc(r.prompt)}"><div class="im lim none"><span>requested</span></div><div class="ln"><b>${esc(r.look?.name || r.extra?.look?.name || r.prompt.slice(0, 40))}</b></div><div class="lg">${esc((r.look?.garments || []).join(' · '))}</div><div class="lm">${sw(r.look?.colors)} <span class="chip">${esc(r.status)}</span> <span class="dim">${usd(r.est_cost)}</span></div></div>`).join('')}
</div>
    ${allExpr.length ? `<div class="sec">expressions</div><div class="erow">${allExpr.slice(0, 3).map(p => cells(p, 9, 'c3 e')).join('')}</div>` : ''}
    ${e.sheets?.angles ? `<div class="sec">head angles</div><div class="erow">${e.sheets.angles.slice(0, 2).map(p => cells(p, 9, 'c3 e')).join('')}</div>` : ''}
    ${(e.motion || []).length ? `<div class="sec">motion clips <span class="dim">(hover to scrub)</span></div><div class="mrow">${e.motion.map(mo => `<div class="mo">${im(mo.clip, 'tall', mo.id + ' · ' + mo.name)}${mo.dancer ? im(mo.dancer, 'tall', 'sprite') : ''}${im(mo.source, 'tall', 'source')}<div class="lu">${used(mo.used, 5)}</div></div>`).join('')}</div>` : ''}
    ${(e.lives || []).length ? `<div class="sec">lives</div><div class="cgrid sm">${e.lives.map(id => store.entityById[id]).filter(Boolean).map(a => `<div class="cc card life" data-ent="${esc(a.id)}" data-open="${esc(a.id)}">${im(a.face, 'wide')}<div class="ch"><b>${esc(a.name)}</b></div></div>`).join('')}</div>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ locations, props
function locations() {
  return `<div class="lib">${store.entities.filter(e => e.kind === 'location').map(e => {
    const imgs = e.images || [];
    return `<div class="lb card" data-ent="${esc(e.id)}" id="ent-${esc(e.id)}"><div class="ch">${chip('location:' + e.id)}<b>${esc(e.name)}</b> <span class="dim">${esc(e.description || '')} · ${imgs.length} images · ${e.angles?.length || 0} angles · ${(e.times || []).join(', ')}</span></div>
      <div class="lrow">${im(e.establishing, 'est', 'establishing')}<div class="lims">${imgs.slice(1).map(x => im(x.path, 'w16', `${x.angle} · ${x.tod}`)).join('')}
        <div class="im w16 add" data-newlook="${esc(e.id)}" title="request a new angle or time of day"><span class="plus">+</span><b>New angle / time of day</b></div></div></div>
      <div class="crow"><span class="dim">clips shot here</span> ${(e.clips || []).map(c => { const m = clipMedia(c.clip); return m ? `<div class="im w16s" data-media="${esc(m.id)}" data-strip="${esc(m.strip || '')}" data-n="8" title="${esc(c.clip)}: ${c.used.length} uses"><img src="${esc(mediaUrl(m.thumb))}" alt="" loading="lazy"><span class="il">${esc(c.clip)} · ${c.used.length}</span></div>` : ''; }).join('')}</div></div>`;
  }).join('')}</div>`;
}
function props() {
  return `<div class="lib"><div class="pgrid">${store.entities.filter(e => e.kind === 'prop').map(e => `<div class="pc card" data-ent="${esc(e.id)}" id="ent-${esc(e.id)}">
    ${im(e.hero || e.refs?.[0], 'hero')}<div class="ch">${chip('prop:' + e.id)}<b>${esc(e.name)}</b></div><div class="cr">${esc(e.description || '')}</div>
    <div class="lt">${(e.images || []).slice(1).map(x => im(x.path, 'mini')).join('')}<div class="im mini add" data-newlook="${esc(e.id)}" title="New variant"><span class="plus">+</span></div></div>
    <div class="lu">${[...new Set((e.images || []).flatMap(x => x.clips))].map(g => `<a data-dock="compare:${esc(g)}">${esc(g)}</a>`).join(' ')}</div></div>`).join('')}</div></div>`;
}

// ------------------------------------------------------------------ the tab modules
export function libraryTab(kind) {
  let root, page = kind === 'character' ? prefs.get('charPage', null) : null, ctxRef;
  const render = () => {
    const keepScroll = root.scrollTop;
    if (kind === 'character') root.innerHTML = page && store.entityById[page] ? charPage(store.entityById[page]) : charGrid();
    else root.innerHTML = kind === 'location' ? locations() : props();
    root.scrollTop = keepScroll;
  };
  const open = (id) => {
    const e = store.entityById[id]; if (!e) return;
    if (kind === 'character') { page = e.kind === 'character' ? id : null; prefs.set('charPage', page); render(); root.scrollTop = 0; return; }
    const el = root.querySelector(`#ent-${CSS.escape(id)}`); el?.scrollIntoView({ block: 'start' }); el?.classList.add('flash'); setTimeout(() => el?.classList.remove('flash'), 1200);
  };
  return {
    mount(el, ctx) {
      root = el; ctxRef = ctx; el.classList.add('pane', 'library');
      render();
      el.addEventListener('click', (ev) => {
        const c = ev.target.closest('.chip[data-k]'); if (c) return store.cycle(c.dataset.k);
        const a = ev.target.closest('a[data-t]'); if (a) return ctxRef.goto(Number(a.dataset.t));
        if (ev.target.closest('[data-back]')) { page = null; prefs.set('charPage', null); return render(); }
        const n = ev.target.closest('[data-newlook]'); if (n) return openLookForm(n.dataset.newlook);
        const m = ev.target.closest('[data-media]');
        if (m && !ev.target.closest('[data-open]')) return window.WB.dock.show({ kind: 'media', id: m.dataset.media });
        const o = ev.target.closest('[data-open]'); if (o) return open(o.dataset.open);
      });
      el.addEventListener('dragstart', (ev) => { const m = ev.target.closest('[data-media]'); if (m) ev.dataTransfer.setData('text/wb-media', store.mediaById[m.dataset.media].path); });
      store.on((w) => { if (['approvals', 'requests', 'all'].includes(w)) render(); });
      document.addEventListener('wb:entity', (ev) => { if (store.entityById[ev.detail]?.kind === kind) open(ev.detail); });
    },
    show() { render(); },
    open,
  };
}
