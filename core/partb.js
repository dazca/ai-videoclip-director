// Part B wiring (SPEC v2 sections 7-9), written only against the public API (WB.commands, WB.menus, WB.dock, WB.ui,
// WB.requests): preview commands and menus, hover-to-preview anywhere, hover-scrub strips, the Media context menu,
// and the compact "+ New look / angle / variant" form that drafts a generation request with a cost estimate.
import { commands } from './commands.js';
import { menus } from './menus.js';
import { ui } from './palette.js';
import { dock, sourceFromKey } from './dock.js';
import { projects } from './projects.js';
import { store, mediaUrl, toast, isPrivatePath } from '../js/store.js';

const WB = () => window.WB;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
export const media = (id) => store.mediaById[id];
const tabs = () => WB().app;

// ------------------------------------------------------------------ hover to preview (shots, clips, cast, media, cards)
const HOVER_SEL = '[data-dock], [data-media], [data-sel^="shot:"], [data-sel^="use:"], .cast[data-id], [data-ent]';
function hoverSource(el) {
  if (el.dataset.dock) return sourceFromKey(el.dataset.dock);
  if (el.dataset.media) return { kind: 'media', id: el.dataset.media };
  if (el.dataset.sel?.startsWith('shot:') || el.dataset.sel?.startsWith('use:')) return sourceFromKey(el.dataset.sel);
  if (el.classList.contains('cast')) return { kind: 'entity', id: el.dataset.id };
  if (el.dataset.ent) return { kind: 'entity', id: el.dataset.ent };
  return null;
}
let hoverEl = null, hoverTimer = 0, leaveTimer = 0;
export const HOVER_DELAY = 220;
document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const el = e.target.closest?.(HOVER_SEL);
  if (!el && hoverEl && !hoverEl.offsetParent) { hoverEl = null; clearTimeout(hoverTimer); dock.unhover(); }   // its tab was switched away
  if (!el || el.closest('.dock, .pop, .pal, .lookform')) return;
  if (el === hoverEl) return;
  hoverEl = el; clearTimeout(hoverTimer); clearTimeout(leaveTimer);
  if (!dock.isOpen() && !(dock.popped && !dock.popped.closed)) return;
  hoverTimer = setTimeout(() => { const s = hoverSource(el); if (s) dock.hover(s); }, HOVER_DELAY);
});
setInterval(() => { if (hoverEl && !hoverEl.offsetParent) { hoverEl = null; clearTimeout(hoverTimer); dock.unhover(); } }, 300);   // its tab was switched away
document.addEventListener('pointerout', (e) => {
  if (!hoverEl || hoverEl.contains(e.relatedTarget)) return;
  const was = hoverEl; hoverEl = null; clearTimeout(hoverTimer);
  const next = e.relatedTarget?.closest?.(HOVER_SEL);
  if (next && next !== was) return;          // moving to another previewable cell: its own timer replaces the source
  leaveTimer = setTimeout(() => dock.unhover(), 160);
});

// ------------------------------------------------------------------ hover-scrub: any element with data-strip="<thumbs/s_*.jpg>"
document.addEventListener('pointermove', (e) => {
  const el = e.target.closest?.('[data-strip]'); if (!el) return;
  let sc = el.querySelector(':scope > .scrub');
  if (!sc) { sc = document.createElement('i'); sc.className = 'scrub'; sc.style.backgroundImage = `url("${mediaUrl(el.dataset.strip)}")`; el.appendChild(sc); }
  const r = el.getBoundingClientRect(), n = Number(el.dataset.n || 8);
  const i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left) / r.width * n)));
  sc.style.backgroundPosition = `${(i / (n - 1)) * 100}% 0`; sc.style.display = 'block';
  el.dataset.frame = i;
}, { passive: true });
document.addEventListener('pointerout', (e) => { const el = e.target.closest?.('[data-strip]'); if (el && !el.contains(e.relatedTarget)) { const sc = el.querySelector(':scope > .scrub'); if (sc) sc.style.display = 'none'; } });

// ------------------------------------------------------------------ media context menu ('media' context; capture phase)
document.addEventListener('contextmenu', (e) => {
  if (e.shiftKey) return;
  const el = e.target.closest?.('[data-media]'); if (!el || el.closest('.pop, .pal')) return;
  e.preventDefault(); e.stopPropagation();
  const m = media(el.dataset.media); if (!m) return;
  const c = WB().context({ target: el, media: m }); c.__args = { target: el, media: m };
  menus.open(menus.forContexts(['media']), { x: e.clientX, y: e.clientY }, c);
}, true);

// ------------------------------------------------------------------ the look / angle / variant form
const COST = { image: 0.24, sheet: 0.31, clip: 0.78 };
export function openLookForm(entity, { mode = 'new', look = null, refs = [] } = {}) {
  document.querySelector('.lookform')?.remove();
  const e = typeof entity === 'string' ? store.entityById[entity] : entity; if (!e) return;
  const isChar = e.kind === 'character', isLoc = e.kind === 'location';
  const what = isChar ? 'look' : isLoc ? 'angle / time of day' : 'variant';
  const base = look ? (e.looks || []).find(l => l.id === look) : null;
  const title = mode === 'dup' ? `Duplicate look "${base?.name}"` : mode === 'variant' ? `Variant of "${base?.name}"` : `New ${what} · ${e.name}`;
  const st = { refs: [...new Set([...(base ? base.images.slice(0, 2) : []), ...refs])], colors: base ? [...base.colors] : [] };
  const f = document.createElement('div'); f.className = 'lookform';
  f.innerHTML = `<div class="lh"><b>${esc(title)}</b><i data-x="close" title="Esc">×</i></div>
    <label><span>name</span><input name="name" value="${esc(mode === 'dup' ? base.name + ' copy' : mode === 'variant' ? base.name + ' variant' : '')}" placeholder="${isChar ? 'e.g. rainy commute' : isLoc ? 'e.g. desk from behind, dusk' : 'e.g. board with LEDs on'}"></label>
    ${isChar ? `<label><span>garments</span><input name="garments" value="${esc(base ? base.garments.join(', ') : '')}" placeholder="comma separated: yellow raincoat, grey beanie, ..."></label>
    <label><span>colours</span><span class="cols"></span><input type="color" name="col" value="#1c2541" title="add a colour"></label>` : ''}
    ${isLoc ? `<label><span>time of day</span><select name="tod">${['8 a.m.', 'morning', 'day', 'dusk', 'night', 'late night', 'early morning'].map(t => `<option>${t}</option>`).join('')}</select></label>
    <label><span>angle</span><input name="angle" placeholder="${esc((e.angles || []).slice(0, 3).join(' / '))}"></label>` : ''}
    <label><span>refs</span><span class="refs" title="drop images from Media or files here"></span><button data-x="pick">+ from Media</button></label>
    <label><span>notes</span><textarea name="notes" rows="2" placeholder="what changes, where it is used, mood"></textarea></label>
    <label><span>also</span><span class="opts">${isChar ? `<label><input type="checkbox" name="sheet" checked> turnaround sheet +$${COST.sheet}</label>` : ''}<label><input type="checkbox" name="takes" checked> 2 takes</label>${isChar && base?.used?.length ? `<label><input type="checkbox" name="reshoot"> re-shoot ${base.used.length} shot(s)</label>` : ''}</span></label>
    <div class="lf"><span class="est"></span><button data-x="ok" class="pri">Create draft request</button></div>`;
  document.body.appendChild(f);
  const $ = (n) => f.querySelector(`[name=${n}]`);
  const est = () => {
    let usd = COST.image * ($('takes')?.checked ? 1 : 0.5);
    if ($('sheet')?.checked) usd += COST.sheet;
    if ($('reshoot')?.checked) usd += (base.stills?.length || 1) * COST.image + (base.clips?.length || 0) * COST.clip;
    return +usd.toFixed(2);
  };
  const paint = () => {
    f.querySelector('.refs').innerHTML = st.refs.map((p, i) => { const m = store.mediaByPath[p]; return `<span class="rf" title="${esc(p)}">${isPrivatePath(p) ? '<i class="lock">🔒</i>' : ''}${m || !/^upload:/.test(p) ? `<img src="${esc(mediaUrl(m?.thumb || p))}" alt="">` : `<em>${esc(p.slice(7))}</em>`}<b data-rm="${i}">×</b></span>`; }).join('') || '<span class="dim">drop images here</span>';
    const cols = f.querySelector('.cols'); if (cols) cols.innerHTML = st.colors.map((c, i) => `<i style="background:${esc(c)}" title="${esc(c)} (click to remove)" data-rc="${i}"></i>`).join('');
    const total = (store.costs?.items || []).reduce((s, x) => s + x.usd, 0) + (store.requests?.items || []).filter(r => ['approved', 'queued'].includes(r.status)).reduce((s, r) => s + (r.est_cost || 0), 0);
    f.querySelector('.est').textContent = `est. $${est().toFixed(2)} · spent+queued $${total.toFixed(2)} / cap $${store.costs?.cap_usd ?? '?'}`;
  };
  paint();
  f.addEventListener('input', paint);
  $('col')?.addEventListener('change', (ev) => { st.colors.push(ev.target.value); paint(); });
  f.addEventListener('click', async (ev) => {
    const rm = ev.target.closest('[data-rm]'); if (rm) { st.refs.splice(Number(rm.dataset.rm), 1); return paint(); }
    const rc = ev.target.closest('[data-rc]'); if (rc) { st.colors.splice(Number(rc.dataset.rc), 1); return paint(); }
    const x = ev.target.closest('[data-x]')?.dataset.x;
    if (x === 'close') return f.remove();
    if (x === 'pick') {
      const items = store.media.filter(m => /\.(png|jpe?g)$/i.test(m.path) && m.kind !== 'contact').sort((a, b) => (b.entities.includes(e.id) ? 1 : 0) - (a.entities.includes(e.id) ? 1 : 0))
        .map(m => ({ label: m.label, detail: `${m.kind}${m.private ? ' · private' : ''} · ${m.entities.join(' ')}`, value: m.path }));
      const p = await ui.pick({ title: `reference image for ${e.name}`, items }); if (p && !st.refs.includes(p)) st.refs.push(p); paint(); return;
    }
    if (x === 'ok') {
      const name = $('name').value.trim() || `${what} ${new Date().toISOString().slice(5, 10)}`;
      const garments = ($('garments')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
      const look_ = { name, garments, colors: st.colors, notes: $('notes').value.trim(), mode, variant_of: mode === 'variant' ? base?.id : null, duplicate_of: mode === 'dup' ? base?.id : null,
        tod: $('tod')?.value, angle: $('angle')?.value?.trim(), takes: $('takes')?.checked ? 2 : 1, sheet: !!$('sheet')?.checked, reshoot: $('reshoot')?.checked ? base.used.map(u => u.shot) : [] };
      const prompt = isChar ? `${e.name}: ${mode === 'variant' ? 'variant of "' + base.name + '": ' : mode === 'dup' ? 'copy of "' + base.name + '": ' : 'new look '}"${name}"${garments.length ? ' — ' + garments.join(', ') : ''}${st.colors.length ? ' · colours ' + st.colors.join(' ') : ''}. Full body on chroma green, same identity.${look_.notes ? ' ' + look_.notes : ''}`
        : isLoc ? `${e.name}: new ${look_.angle || 'angle'} at ${look_.tod}: ${name}. Match the existing location exactly.${look_.notes ? ' ' + look_.notes : ''}`
        : `${e.name}: new variant "${name}".${look_.notes ? ' ' + look_.notes : ''}`;
      const r = await WB().requests.create({ kind: isChar ? 'new-costume' : 'new-variant', target: `${e.kind}:${e.id}`, prompt, refs: st.refs, est_cost: est(), extra: { look: look_ } });
      toast(`draft request ${r.id}: ${name} · est $${est().toFixed(2)} · Queue tab`);
      f.remove();
      document.dispatchEvent(new CustomEvent('wb:request', { detail: r }));
      return r;
    }
  });
  f.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); f.remove(); } if (ev.key === 'Enter' && ev.ctrlKey) f.querySelector('[data-x=ok]').click(); });
  // drag-drop: media cells (text/wb-media = path) or files from the OS (recorded by name: the agent asks for the path)
  const drop = f.querySelector('.refs');
  f.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
  f.addEventListener('dragleave', () => drop.classList.remove('over'));
  f.addEventListener('drop', (ev) => {
    ev.preventDefault(); drop.classList.remove('over');
    const p = ev.dataTransfer.getData('text/wb-media');
    if (p) { if (!st.refs.includes(p)) st.refs.push(p); }
    else for (const file of ev.dataTransfer.files || []) st.refs.push('upload:' + file.name);
    paint();
  });
  $('name').focus();
  return f;
}

// ------------------------------------------------------------------ commands
const lookOf = (c) => { const el = c.target?.closest?.('[data-look]'); if (!el) return null; const [eid, lid] = el.dataset.look.split('/'); const e = store.entityById[eid]; return e ? { e, l: e.looks.find(x => x.id === lid) } : null; };
const clipOf = (c) => c.use?.clip || (c.media?.kind === 'clip' ? c.media.job : null);
async function goShots(ids) {
  if (!ids?.length) return;
  const t = Math.min(...ids.map(i => store.shots.find(s => s.id === i)?.t0 ?? Infinity));
  await WB().ctx.goto(t);
  WB().selection.set(ids.map(i => 'shot:' + i));
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('copied: ' + text); } catch (e) { toast('clipboard blocked: ' + text); } }

commands.register([
  { id: 'dock.film', group: 'View', title: 'Preview: Film (render at the playhead)', checked: () => dock.isOpen() && dock.mode() === 'film', run: () => { dock.open(); dock.film(); } },
  { id: 'dock.pin', group: 'View', title: 'Preview: pin the current source', checked: () => dock.pinned, run: () => { dock.open(); dock.pin(); } },
  { id: 'dock.popout', group: 'View', title: 'Preview: pop out to a window', run: () => { dock.open(); dock.popout(); } },
  { id: 'dock.corner', group: 'View', hidden: true, title: (c) => `Dock ${c.corner}`, checked: (c) => dock.geo.corner === c.corner, run: (c) => { dock.setCorner(c.corner); dock.open(); } },
  { id: 'media.compare', group: 'View', title: 'Compare takes side by side', when: (c) => !!clipOf(c), run: (c) => dock.show({ kind: 'compare', id: clipOf(c), in_ms: c.use?.in_ms }) },
  { id: 'media.show', group: 'View', title: 'Show in preview', when: (c) => !!c.media, run: (c) => dock.show({ kind: 'media', id: c.media.id }) },
  { id: 'media.timeline', group: 'View', title: 'Show on timeline', when: (c) => !!c.media?.shots?.length, run: (c) => goShots(c.media.shots) },
  { id: 'media.copyPath', group: 'Edit', title: 'Copy path', when: (c) => !!c.media, run: (c) => copy(c.media.path) },
  { id: 'media.reveal', group: 'Edit', title: 'Open file location', when: (c) => !!c.media, run: (c) => projects.reveal(c.media.path) },
  { id: 'media.tab', group: 'Window', title: 'Media library', run: () => tabs().show('media') },
  { id: 'entity.page', group: 'View', title: (c) => c.entity?.kind === 'character' ? 'Open character page' : 'Open', when: (c) => !!c.entity, run: async (c) => { const t = c.entity.kind === 'character' ? 'characters' : c.entity.kind + 's'; await tabs().show(t); document.dispatchEvent(new CustomEvent('wb:entity', { detail: c.entity.id })); } },
  { id: 'entity.sheet', group: 'View', title: 'Show sheet in preview', when: (c) => !!c.entity, run: (c) => dock.show({ kind: 'entity', id: c.entity.id }) },
  { id: 'entity.newLook', group: 'Generate', title: (c) => c.entity?.kind === 'location' ? 'New angle / time of day…' : c.entity?.kind === 'prop' ? 'New variant…' : 'New look…', when: (c) => !!c.entity, run: (c) => openLookForm(c.entity) },
  { id: 'look.duplicate', group: 'Generate', title: 'Duplicate look…', when: (c) => !!lookOf(c), run: (c) => { const x = lookOf(c); openLookForm(x.e, { mode: 'dup', look: x.l.id }); } },
  { id: 'look.variant', group: 'Generate', title: 'Variant of this look…', when: (c) => !!lookOf(c), run: (c) => { const x = lookOf(c); openLookForm(x.e, { mode: 'variant', look: x.l.id }); } },
  { id: 'look.timeline', group: 'View', title: 'Show where this look is used', when: (c) => !!lookOf(c)?.l?.used?.length, run: (c) => goShots(lookOf(c).l.used.map(u => u.shot)) },
  { id: 'look.preview', group: 'View', title: 'Preview look', when: (c) => !!lookOf(c), run: (c) => { const x = lookOf(c); dock.show({ kind: 'look', id: `${x.e.id}/${x.l.id}` }); } },
]);

const refTargets = () => store.entities.filter(e => !/^[dh]\d$/.test(e.id)).map(e => ({ label: `${e.name}`, detail: e.kind, run: (c) => openLookForm(e, { refs: [c.media.path] }) }));
menus.contribute('media', ['media.show', 'media.compare', 'media.timeline', { label: 'Use as reference for…', when: (c) => /\.(png|jpe?g)$/i.test(c.media?.path || ''), submenu: refTargets }, '-', 'media.copyPath', 'media.reveal']);
menus.contribute('clip', ['media.compare']);
menus.contribute('shot', [{ label: 'Compare takes', when: (c) => !!c.shot?.clips?.length, submenu: (c) => [...new Set(c.shot.clips.map(u => u.split('@')[0]))].map(g => ({ label: g, run: () => dock.show({ kind: 'compare', id: g }) })) }]);
menus.contribute('entity', ['-', 'entity.page', 'entity.newLook', 'entity.sheet', 'look.preview', 'look.duplicate', 'look.variant', 'look.timeline']);
menus.contribute('cast', ['entity.sheet']);
menus.contribute('menubar:View', ['-', { label: 'Preview dock', submenu: ['view.dock', 'dock.film', 'dock.pin', 'dock.popout', '-', ...['br', 'bl', 'tr', 'tl'].map(k => ({ cmd: 'dock.corner', args: { corner: k }, label: { br: 'bottom right', bl: 'bottom left', tr: 'top right', tl: 'top left' }[k] }))] }]);
menus.contribute('menubar:Window', ['media.tab']);
menus.contribute('menubar:Generate', ['-', 'entity.newLook']);

window.WB = Object.assign(window.WB || {}, { lookForm: openLookForm });
