// Projects and snapshots (server endpoints in serve.mjs), plus the exports (JSON bundle, shot list CSV, storyboard).
// Projects live in workbench/data/<id>/; snapshots in data/<id>/.snapshots/<timestamp>-<slug>/ (small JSON files only).
import { store, PROJECT, api, mediaUrl, toast, prefs, isPrivatePath, postJSON, config, esc } from '../js/store.js';

// GET reads directly; every write goes through the page's shared write helper (it carries the write token)
async function call(path, body) {
  const r = await (body === undefined ? fetch(api(path)) : postJSON(path, body));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
const validId = (s) => /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(s || '');
export const slugId = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

export const projects = {
  current: PROJECT,
  list: [], snaps: [],
  async refresh() {
    try { [this.list, this.snaps] = await Promise.all([call('/api/projects'), call('/api/snapshots')]); } catch (e) { /* static hosting */ }
    return this;
  },
  recent() { return prefs.get('recentProjects', []).filter(id => id !== PROJECT); },
  remember() { prefs.set('recentProjects', [PROJECT, ...prefs.get('recentProjects', []).filter(x => x !== PROJECT)].slice(0, 8)); },
  open(id) { const u = new URL(location.href); u.searchParams.set('project', id); location.href = u.toString(); },
  // the server's default project (a bare / redirects there when the page has not read /api/config)
  openDefault() { if (config.default_project) this.open(config.default_project); else location.href = location.pathname.replace(/[^/]*$/, ''); },
  async create(id) { if (!validId(id)) throw new Error('bad id'); await call('/api/projects/new', { id }); await this.refresh(); return id; },
  async duplicate(to, { from = PROJECT, template = false } = {}) { if (!validId(to)) throw new Error('bad id'); await call('/api/projects/duplicate', { from, to, reset_state: template }); await this.refresh(); return to; },
  async remove(id) { await call('/api/projects/delete', { id }); await this.refresh(); },
  async snapshot(message) { const m = await call('/api/snapshot', { message }); await this.refresh(); toast(`snapshot saved: ${m.message || m.id}`); return m; },
  async restore(id) { const r = await call('/api/restore', { snapshot: id }); await this.refresh(); toast(`restored ${id} (previous state kept as ${r.previous})`); return r; },
  async reveal(path) { try { await call('/api/reveal', { path }); } catch (e) { toast('cannot open: ' + e.message); } },
};

// ------------------------------------------------------------------ exports
function download(name, text, type = 'application/json') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const fmt = (ms) => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };
const csv = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// a path is private by the PRIVATE rule or when media.json flags it (e.g. a sheet generated from a private photo)
const priv = (x) => isPrivatePath(x) || (typeof x === 'string' && store.mediaByPath?.[x]?.private === true);
function scrub(v) {
  if (Array.isArray(v)) return v.filter(x => !priv(x) && !(x && typeof x === 'object' && (x.private === true || priv(x.path) || priv(x.image)))).map(scrub);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { if (k === 'private_refs' || k === 'private_media' || priv(x)) continue; o[k] = scrub(x); } return o; }
  return v;
}
export const exporter = {
  // everything exported goes through scrub(): private media (crops of real photos) never leave the machine
  bundleData() {
    const { song, events, energy, script, scenes, shots, uses, costs, notes, approvals, requests, overrides, entities, media, board } = store;
    return scrub({ project: PROJECT, exported: new Date().toISOString(), song, events, energy, script, scenes, shots: { shots, uses }, storyboard: board, costs, notes, approvals, requests, overrides, entities, media: (media || []).filter(m => !m.private) });
  },
  bundle() { download(`${PROJECT}-bundle.json`, JSON.stringify(this.bundleData(), null, 1)); },
  shotList() {
    // the storyboard's shots (storyboard.json, else shots.json)
    const rows = [['id', 'scene', 't0', 't1', 'start', 'end', 'section', 'kind', 'gen', 'title', 'text', 'camera', 'cast', 'locations', 'props', 'clips', 'frame', 'state']];
    for (const s of store.boardShots()) rows.push([s.id, s.scene || '', s.t0, s.t1, fmt(s.t0), fmt(s.t1), s.section || '', s.kind, s.gen || '', s.title || '', s.text || '', s.camera || '', (s.cast || []).join(' '), (s.locations || []).join(' '), (s.props || []).join(' '), (s.clips || []).join(' '), s.sketch || '', store.state('shot:' + s.id)]);
    download(`${PROJECT}-shots.csv`, rows.map(r => r.map(csv).join(',')).join('\n'), 'text/csv');
  },
  storyboard() {
    const base = location.origin + location.pathname.replace(/[^/]*$/, '');
    const abs = (p) => { const u = mediaUrl(p); return /^(https?:|data:image\/|blob:)/.test(u) ? u : u.startsWith('/') ? location.origin + u : base + u; };
    // the page is meant to be printed and shared: private thumbs (crops of real photos) stay out, like in bundleData()
    const pub = (p) => p && !isPrivatePath(p) && !store.mediaByPath?.[p]?.private;
    const html = `<!doctype html><meta charset="utf-8"><title>${esc(PROJECT)} storyboard</title><style>
      body{font:11px/1.3 "Segoe UI",Arial,sans-serif;margin:8mm;color:#111} h1{font-size:14px;margin:0 0 6px}
      .g{display:grid;grid-template-columns:repeat(4,1fr);gap:6px} .s{break-inside:avoid;border:1px solid #bbb;padding:3px}
      .s img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#eee} .s b{font-size:11px} .s i{color:#666;font-style:normal}
      @page{size:A4 landscape;margin:8mm}</style>
      <h1>${esc(PROJECT)} · storyboard · ${store.boardShots().length} shots · ${new Date().toISOString().slice(0, 10)}</h1><div class="g">${store.boardShots().map(s => { const f = s.sketch ? store.mediaById?.['sketch-' + s.sketch]?.path || `sketches/${s.sketch}.png` : s.thumb;
        return `<div class="s">${pub(f) ? `<img src="${esc(abs(f))}">` : '<img alt="">'}<b>${esc(s.id)}</b> <i>${fmt(s.t0)}–${fmt(s.t1)}${s.scene ? ' · ' + esc(s.scene) : ''} · ${esc(s.kind)} · ${esc(store.state('shot:' + s.id))}</i><div>${esc(s.title && s.text ? `${s.title}: ${s.text}` : s.title || s.text || '')}</div>${s.camera ? `<div><i>${esc(s.camera)}</i></div>` : ''}</div>`; }).join('')}</div>`;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const w = window.open(url, '_blank'); if (!w) { URL.revokeObjectURL(url); download(`${PROJECT}-storyboard.html`, html, 'text/html'); return; }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
};
