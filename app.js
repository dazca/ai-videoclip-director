// Director workbench shell: a thin hideable top bar (menu bar + pages from tabs/registry.js + transport + gear), the
// pages (Timeline, Assets, Review with sub-views; Settings), the restore chevron for a hidden bar, and
// the wiring of the command system (core/): registry, keymap, menus, palette, history, selection, projects, dock.
import { store, prefs, toast, PROJECT, esc, postJSON } from './js/store.js';
import { PAGES } from './tabs/registry.js';
import { fmt } from './js/timeline.js';
import { installVerify } from './js/verify.js';
import { commands, keymap, setContextProvider, context } from './core/commands.js';
import { menus, renderMenuBar } from './core/menus.js';
import { palette, ui, cheatsheet } from './core/palette.js';
import { history } from './core/history.js';
import { selection } from './core/selection.js';
import { dock, sourceFromKey } from './core/dock.js';
import { projects, exporter } from './core/projects.js';
import { sectionAt, shotAt, lineIndexAt } from './core/defaults.js';
import './core/partb.js';
import './core/importmedia.js';   // File › Import media…, drop files on the page, "Use as…" (D8)
import { mountRail } from './core/rail.js';
import { wizard } from './core/wizard.js';
import { watchCode } from './core/stale.js';

const ctx = { store, timeline: null, goto: null };
window.WB = Object.assign(window.WB || {}, { store, ctx, commands, keymap, menus, palette, ui, cheatsheet, history, selection, dock, projects, exporter, context,
  requests: { create: (r) => store.addRequest(r) } });

const $top = document.getElementById('top'), $panes = document.getElementById('panes');
// pages (tabs/registry.js) + custom pages (Window > New page: one sub-view pinned as its own page, closable)
let custom = (prefs.get('customPages', []) || []).filter(p => p && p.view);
const subOf = prefs.get('subs', {}) || {};
let active = null;
const pages = {};   // page id -> {el, body, nav?}
const views = {};   // view id -> {el, mod}

const allPages = () => [...PAGES, ...custom.map(p => ({ ...p, custom: true }))];
const pageById = (id) => allPages().find(p => p.id === id);
const subDef = (id) => { for (const p of PAGES) { const s = p.subs?.find(x => x.id === id); if (s) return { page: p, sub: s }; } return null; };
const viewDef = (id) => subDef(id)?.sub || PAGES.find(p => p.id === id && !p.subs);
const viewOfPage = (p) => p.subs ? (p.subs.find(s => s.id === subOf[p.id]) || p.subs[0]).id : p.custom ? p.view : p.id;

function setTopbar(show) { document.body.classList.toggle('notop', !show); prefs.set('topbar', show); ctx.timeline?.requestRelayout(); document.dispatchEvent(new CustomEvent('wb:topbar')); }

function renderTop() {
  const nav = $top.querySelector('nav');
  const all = allPages();
  nav.innerHTML = all.filter(p => p.tab !== false).map(p => { const n = all.indexOf(p) + 1; return `<a data-tab="${esc(p.id)}" class="${p.id === active ? 'on' : ''}" title="${n <= 9 ? 'key ' + n : ''}">${esc(p.title)}${p.custom ? '<i data-close="' + esc(p.id) + '" title="close page">×</i>' : ''}</a>`; }).join('');
  $top.querySelector('[data-gear]')?.classList.toggle('on', active === 'settings');
}
function buildTop() {
  $top.innerHTML = `<nav></nav><a class="opennotes" data-cmd="notes.review" title="all open notes: yours and the agent's, in every stage and the timeline (Review › Notes). The rail's round counts only yours."></a><span class="proj" title="project (File > Open)">${esc(PROJECT)}</span><span class="tr"><button data-play title="Space">▶</button><span class="clock">0:00.000</span><button data-cmd="view.linear" title="T: linear time">lin</button><button data-cmd="view.zoomOut" title="-">−</button><button data-cmd="view.zoomIn" title="+">+</button><button data-cmd="view.palette" title="Ctrl+K: command palette">⌘</button><button data-cmd="view.topbar" title="\`: hide this bar (the small ⌄ at the top right brings it back)">⌃</button><button data-gear data-cmd="edit.settings" title="Settings (Ctrl+,)">⚙</button></span>`;
  let lastRefresh = 0;
  renderMenuBar($top).addEventListener('pointerover', () => { if (Date.now() - lastRefresh > 3000) { lastRefresh = Date.now(); projects.refresh(); } });
  renderTop();
  // restore control for a hidden top bar: a 12 px chevron in the top-right corner, faint until hovered
  const r = document.createElement('button'); r.id = 'toprestore'; r.textContent = '⌄';
  r.title = 'Show the top bar (`)'; r.setAttribute('aria-label', 'Show the top bar');
  r.addEventListener('click', (e) => { e.stopPropagation(); setTopbar(true); });
  document.body.appendChild(r);
}

// a page with sub-views (Assets, Review): left sub-nav (name + count); Assets adds a search box and a status filter
function buildPage(p) {
  const el = document.createElement('div'); el.className = 'pgwrap'; el.dataset.page = p.id; $panes.appendChild(el);
  const rec = { el, body: el };
  if (p.subs) {
    el.classList.add('hassub');
    el.innerHTML = `<div class="subnav" role="tablist"></div><div class="subarea">${p.search ? `<div class="asbar"><input class="asq" placeholder="search ${p.title.toLowerCase()}: names, ids, garments, paths…" spellcheck="false"><select class="asst"><option value="">any status</option><option value="draft">draft</option><option value="approved">approved</option><option value="changes">changes</option></select><span class="dim asn"></span></div>` : ''}<div class="subbody"></div></div>`;
    rec.nav = el.querySelector('.subnav'); rec.body = el.querySelector('.subbody');
    if (p.search) {
      const q = el.querySelector('.asq'), st = el.querySelector('.asst');
      const f = prefs.get('assetFilter', { q: '', st: '' }) || {}; q.value = f.q || ''; st.value = f.st || '';
      const upd = () => { prefs.set('assetFilter', { q: q.value, st: st.value }); applyAssetFilter(rec); };
      q.addEventListener('input', upd); st.addEventListener('change', upd);
      q.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { q.value = ''; upd(); q.blur(); } });
      let raf = 0; new MutationObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => applyAssetFilter(rec)); }).observe(rec.body, { childList: true, subtree: true });
    }
  }
  return (pages[p.id] = rec);
}
function renderSubnav(p) {
  const rec = pages[p.id]; if (!rec?.nav) return;
  const cur = viewOfPage(p);
  rec.nav.innerHTML = p.subs.map(s => { let n = ''; try { n = s.count?.(store) ?? ''; } catch (e) { /* data not loaded yet */ } return `<a data-sub="${esc(s.id)}" class="${s.id === cur ? 'on' : ''}" role="tab">${esc(s.title)}<i>${esc(n)}</i></a>`; }).join('');
}
// Assets search: hide the cards / rows of the visible view that do not match (text, ids, titles, status chip)
const ITEM_SEL = '.cgrid > .card, .lgrid > .lc:not(.add), .lib > .lb.card, .pgrid > .pc, .mgrid > .mc, table.tbl tr[id^="clip-"]';
function applyAssetFilter(rec) {
  const q = (rec.el.querySelector('.asq')?.value || '').trim().toLowerCase(), st = rec.el.querySelector('.asst')?.value || '';
  const v = [...rec.body.children].find(x => x.classList.contains('tabpane') && x.style.display !== 'none'); if (!v) return;
  let shown = 0, total = 0;
  for (const it of v.querySelectorAll(ITEM_SEL)) {
    total++;
    const hay = q ? (it.textContent + ' ' + (it.title || '') + ' ' + (it.dataset.ent || '') + ' ' + (it.dataset.media || '') + ' ' + [...it.querySelectorAll('[title],[data-media],[data-ent]')].slice(0, 12).map(x => `${x.title} ${x.dataset.media || ''} ${x.dataset.ent || ''}`).join(' ')).toLowerCase() : '';
    const ok = (!q || q.split(/\s+/).every(w => hay.includes(w))) && (!st || !!it.querySelector('.chip.s-' + st));
    if (it.classList.contains('nomatch') === ok) it.classList.toggle('nomatch', !ok);
    if (ok) shown++;
  }
  const n = rec.el.querySelector('.asn'); if (n) n.textContent = q || st ? `${shown} of ${total}` : '';
}

async function mountView(id, host) {
  let v = views[id];
  if (!v) {
    const def = viewDef(id); if (!def) return null;
    const el = document.createElement('div'); el.className = 'tabpane'; el.dataset.tab = id; host.appendChild(el);
    v = views[id] = { el, mod: null };
    v.mod = (await def.load()).default;
    v.mod.mount(el, ctx);
  } else if (v.el.parentNode !== host) host.appendChild(v.el);       // a custom page borrowed it: move it here
  for (const x of host.children) if (x.classList.contains('tabpane')) x.style.display = x === v.el ? '' : 'none';
  return v;
}

// show(id): a page id, a sub-view id (opens its page on that sub-view: 'characters', 'queue', 'media'…) or a custom page
async function show(id) {
  let p = pageById(id);
  if (!p) { const s = subDef(id); if (!s) return; p = s.page; subOf[p.id] = id; prefs.set('subs', subOf); }
  active = p.id; prefs.set('activeTab', id);
  const rec = pages[p.id] || buildPage(p);
  for (const [k, r] of Object.entries(pages)) r.el.style.display = k === p.id ? '' : 'none';
  renderSubnav(p);
  renderTop();
  document.dispatchEvent(new CustomEvent('wb:page', { detail: p.id }));
  const v = await mountView(viewOfPage(p), rec.body);
  if (active !== p.id || !v?.mod) return;
  v.mod.show?.(ctx);
  if (p.search) applyAssetFilter(rec);
}
const view = () => { const p = pageById(active); return p ? viewOfPage(p) : null; };
function newPage(viewId) {
  const d = viewDef(viewId); if (!d) return;
  const id = 'p:' + viewId;
  if (!custom.some(p => p.id === id)) { custom.push({ id, title: d.title, view: viewId }); prefs.set('customPages', custom); }
  return show(id);
}
function closePage(id) {
  const p = custom.find(x => x.id === id); if (!p) return;
  custom = custom.filter(x => x.id !== id); prefs.set('customPages', custom);
  const v = views[p.view], owner = subDef(p.view)?.page;
  if (v && owner) { const host = pages[owner.id] || buildPage(owner); host.body.appendChild(v.el); v.el.style.display = 'none'; if (active !== owner.id) host.el.style.display = 'none'; }
  pages[id]?.el.remove(); delete pages[id];
  if (active === id) show('timeline'); else renderTop();
}
function registerSub(pageId, sub) { const p = PAGES.find(x => x.id === pageId); if (!p?.subs) return; p.subs = p.subs.filter(s => s.id !== sub.id).concat(sub); if (pages[pageId]) renderSubnav(p); }

ctx.goto = async (t) => { await show('timeline'); ctx.timeline.seek(t); ctx.timeline.scrollToTime(t); };
window.WB.app = { show, setTopbar, active: () => active, view, pages: allPages, subsOf: (id) => PAGES.find(p => p.id === id)?.subs || [], subDef, newPage, closePage, registerSub, custom: () => custom.slice() };

// the default context every command sees: playhead time, what is under it, selection, hovered column
setContextProvider((args) => {
  const tl = ctx.timeline;
  const t = args.t ?? (tl ? Math.round(tl.player.time()) : 0);
  const base = { tab: active, view: view(), tl, store, sel: selection, t, col: tl?.hoverCol && !tl.hoverCol.hidden ? tl.hoverCol : null };
  if (store.song) {
    base.section = sectionAt(t);
    base.line = store.song.lines.length ? store.song.lines[lineIndexAt(t)] : null;
    base.shot = shotAt(t);
  }
  return { ...base, ...args };
});

$top.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) { e.stopPropagation(); return closePage(c.dataset.close); }
  const a = e.target.closest('[data-tab]'); if (a) return show(a.dataset.tab);
  const cmd = e.target.closest('[data-cmd]'); if (cmd) return commands.run(cmd.dataset.cmd);
  if (e.target.closest('[data-play]')) commands.run('transport.play');
});
$panes.addEventListener('click', (e) => { const s = e.target.closest('.subnav [data-sub]'); if (s) show(s.dataset.sub); });
// keep the sub-nav counts fresh
store.on(() => { const p = pageById(active); if (p?.subs) renderSubnav(p); });
// the top bar's "N open notes" (every stage and the timeline; the rail has the count per stage; a sent round's ask is not a note)
function renderOpenNotes() { const a = $top.querySelector('.opennotes'); if (!a || !store.notes) return; const k = store.notes.notes.filter(n => n.status === 'open' && n.ask !== 'round').length; a.textContent = k ? `all open notes: ${k}` : 'no open notes'; a.classList.toggle('none', !k); }
store.on((w) => { if (w === 'notes' || w === 'all') renderOpenNotes(); });

// live UI channel: an agent's ui_focus (MCP) -> POST /api/ui -> SSE -> here. Apply it, then ack so the agent knows a
// page showed it. {open_project?, view?, t?, range?: [t0, t1], select?: [keys], preview?: key | source | path, message?, play?}
document.addEventListener('wb:ui', async (e) => {
  const u = e.detail || {};
  const ack = () => postJSON('/api/ui/ack', { id: u.id }).catch(() => {});
  try {
    if (u.open_project && u.open_project !== PROJECT) { await ack(); return projects.open(u.open_project); }
    if (u.view) await show(u.view);
    const t = u.t ?? u.range?.[0];
    if (t != null && ctx.timeline) {
      if (!u.view) await show('timeline');
      ctx.timeline.seek(Number(t)); ctx.timeline.scrollToTime(Number(t)); ctx.timeline.drawLanes();
    }
    if (u.range && ctx.timeline) selection.setRange({ t0: Number(u.range[0]), t1: Number(u.range[1]) });
    if (u.select) selection.set(u.select);
    if (u.preview) {
      const s = typeof u.preview === 'object' ? u.preview
        : /^[a-z]+:/.test(u.preview) ? sourceFromKey(u.preview)
        : store.mediaByPath[u.preview] ? { kind: 'media', id: store.mediaByPath[u.preview].id } : { src: u.preview };
      dock.show(s);
    }
    if (u.play === true) ctx.timeline?.player.play(); else if (u.play === false) ctx.timeline?.player.pause();
    if (u.message) toast(u.message);
    if (u.queued_at) toast(`the agent asked to show this at ${String(u.queued_at).slice(11, 16)}, while no page was open`);
  } catch (er) { console.warn('ui command failed', u, er); }
  ack();
});

document.addEventListener('wb:play', (e) => { const b = $top.querySelector('[data-play]'); if (b) b.textContent = e.detail ? '❚❚' : '▶'; });
setInterval(() => { const c = $top.querySelector('.clock'); if (c && ctx.timeline) c.textContent = fmt(ctx.timeline.player.time(), true); }, 100);

// keys: overlays (menus, palette, cheat sheet capture) first, then the keymap
addEventListener('keydown', (e) => {
  if (e.defaultPrevented || (e.repeat && !/^(Arrow|Page)|^[-+=]$/.test(e.key))) return;   // held letters do not re-approve
  if (cheatsheet.isOpen() && (e.key === 'Escape' || e.key === '?')) { e.preventDefault(); cheatsheet.close(); return; }
  if (menus.isOpen() || palette.isOpen()) return;
  keymap.handle(e);
});

(async function boot() {
  const t0 = performance.now();
  buildTop();
  try { await store.loadAll(); } catch (e) {
    const pre = document.createElement('pre'); pre.className = 'err';
    pre.textContent = `could not load data for project "${PROJECT}": ${e.message}\nRun: node serve.mjs (in the workbench folder) and open http://localhost:8140/`;
    document.body.replaceChildren(pre); return;
  }
  keymap.rebuild();
  renderOpenNotes();
  mountRail();
  const tData = performance.now() - t0;
  if (document.fonts) await document.fonts.ready;
  setTopbar(prefs.get('topbar', true));
  const want = prefs.get('activeTab', 'timeline');
  await show('timeline');
  if (want !== 'timeline' && (pageById(want) || subDef(want))) await show(want);
  store.listen();
  watchCode();
  installVerify(ctx);
  projects.remember(); projects.refresh();
  if (prefs.get('dock', false)) dock.open();
  document.title = `${PROJECT} · Director Workbench`;
  window.WB.boot = { dataMs: tData, firstRenderMs: performance.now() - t0, timelineBuildMs: ctx.timeline.perf.firstRender };
  document.body.dataset.ready = '1';
  // an empty project (no lyrics, no lines): the new-project wizard, on its lyrics step, to fill this one
  if (!store.song.lines.length && !store.lyrics?.versions?.length) {
    let seen = false; try { seen = !!sessionStorage.getItem('wb:wizSeen:' + PROJECT); sessionStorage.setItem('wb:wizSeen:' + PROJECT, '1'); } catch (e) { /* storage blocked */ }
    if (!seen) wizard.open({ fill: !PROJECT.startsWith('_') });
  }
})();
export { toast };
