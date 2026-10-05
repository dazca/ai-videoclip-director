// File › Export composition data… (ROADMAP_v4 E9): the picks as edl.json for a HyperFrames composition.
// One command and this small dialog. It shows what the export holds now (composition_get: shots picked / placeholders /
// private, warnings), the file mapping (one rule a line, "from => to": the workbench media path prefix and the folder
// under the composition it becomes) and the file inside the project's exports/ folder; Export writes it
// (composition_export: that file only, deterministic, with a checksum). The map and the file are remembered in
// settings.json `composition` (the director's; the export reads them when no map is given). Format and adoption:
// docs/COMPOSITION_ROUNDTRIP.md; the composition reads the file with exporters/composition-data/reader.js.
// API: openCompExport(); WB.compExport = {open}.
import { commands } from './commands.js';
import { menus } from './menus.js';
import { store, toast, esc } from '../js/store.js';

const CSS = `.cxback{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding-top:8vh}
.cxdlg{width:min(620px,96vw);background:var(--bg2);border:1px solid var(--line);box-shadow:0 10px 30px rgba(0,0,0,.6);font:12px/16px "Segoe UI",Arial,sans-serif;color:var(--fg)}
.cxdlg .cxh{display:flex;gap:8px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--line)} .cxdlg .sp{flex:1}
.cxdlg .cxh i{cursor:pointer;font-style:normal;font-size:16px;color:var(--dim)}
.cxdlg .cxb{padding:6px 8px;display:grid;grid-template-columns:90px 1fr;gap:4px 8px;align-items:start}
.cxdlg textarea,.cxdlg .cxb input{font:12px Consolas,monospace;width:100%;box-sizing:border-box}
.cxdlg textarea{height:54px;resize:vertical} .cxdlg .cxsum b{color:var(--acc)} .cxdlg .cxw{color:var(--acc);font-size:11px}
.cxdlg .cxr{grid-column:1/-1;font-size:11px;word-break:break-all} .cxdlg .cxr.err{color:#f08080}
.cxdlg .cxf{display:flex;gap:6px;align-items:center;padding:4px 8px;border-top:1px solid var(--line2)}`;
// (an empty prefix reads "(any)": the rule for every path; review #3 LOW 13)
const mapText = (m) => (m || []).map(r => `${r.from || '(any)'} => ${r.to}`).join('\n');
const parseMap = (s) => String(s || '').split('\n').map(l => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('=>'); if (i < 0) throw new Error(`map line "${l.slice(0, 60)}": write "from => to"`); const from = l.slice(0, i).trim(); return { from: from === '(any)' ? '' : from, to: l.slice(i + 2).trim() }; });

let dlg = null;
export function openCompExport() { if (!dlg) dlg = new CompExportDialog(); dlg.show(); return dlg; }
class CompExportDialog {
  constructor() {
    if (!document.getElementById('cxcss')) { const st = document.createElement('style'); st.id = 'cxcss'; st.textContent = CSS; document.head.appendChild(st); }
    const el = this.el = document.createElement('div'); el.className = 'cxback';
    el.innerHTML = `<div class="cxdlg" role="dialog" aria-label="Export composition data">
      <div class="cxh"><b>Export composition data</b><span class="dim">edl.json for the HyperFrames composition · nothing is generated or paid</span><span class="sp"></span><i data-x="close" title="Esc">×</i></div>
      <div class="cxb"><span>Now</span><span class="cxsum dim">…</span>
        <span>File map</span><span><textarea name="map" spellcheck="false" placeholder="gen/ => assets/gen/"></textarea><span class="dim">one rule a line: workbench media path prefix => folder in the composition (longest first)</span></span>
        <span>File</span><span><input name="out" spellcheck="false"><span class="dim">inside the project's exports/ folder</span></span>
        <div class="cxr"></div></div>
      <div class="cxf"><label><input type="checkbox" name="remember" checked> remember map and file</label><span class="sp"></span><button data-x="export" class="pri">Export</button></div>
    </div>`;
    el.addEventListener('click', (e) => { const x = e.target.closest('[data-x]')?.dataset.x; if (e.target === el || x === 'close') return this.hide(); if (x === 'export') this.run(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.hide(); } });
  }
  async show() {
    if (!this.el.isConnected) document.body.appendChild(this.el);
    const c = store.settings?.composition || {};
    this.el.querySelector('[name=map]').value = mapText(c.map || [{ from: '', to: 'assets/' }]);
    this.el.querySelector('[name=out]').value = c.out || 'composition/edl.json';
    this.result('');
    try { this.summary(await store.op('composition_get', {})); } catch (e) { this.el.querySelector('.cxsum').textContent = e.message; }
    this.el.querySelector('[data-x=export]').focus();
  }
  hide() { this.el.remove(); }
  summary(r) {
    const n = r.counts || {};
    this.el.querySelector('.cxsum').innerHTML = `${n.shots} shots · <b>${n.picked} picked</b> · ${n.placeholders} placeholders${n.private ? ` (${n.private} private: never written)` : ''} · storyboard ${esc(r.storyboard || '–')}`
      + (r.warnings?.length ? `<div class="cxw">${r.warnings.map(esc).join('<br>')}</div>` : '');
  }
  result(html, err = false) { const r = this.el.querySelector('.cxr'); r.innerHTML = html; r.classList.toggle('err', err); }
  async run() {
    let map; try { map = parseMap(this.el.querySelector('[name=map]').value); } catch (e) { return this.result(esc(e.message), true); }
    const out = this.el.querySelector('[name=out]').value.trim();
    try {
      const r = await store.op('composition_export', { out, map });
      this.summary(r);
      this.result(`${r.changed ? 'written' : 'unchanged (same picks, same bytes)'}: <b>${esc(r.path)}</b> · ${r.bytes} bytes<br>${esc(r.checksum)}<br><span class="dim">${esc(r.abs)}</span>`);
      if (this.el.querySelector('[name=remember]').checked) await store.setSettings((s) => { s.composition = { map, out }; });
      toast(`composition data ${r.changed ? 'exported' : 'unchanged'}: ${r.counts.picked} of ${r.counts.shots} shots picked`);
    } catch (e) { this.result(esc(e.message), true); }
  }
}

commands.register({ id: 'file.exportComposition', group: 'File', title: 'Export composition data…', run: () => openCompExport() });
menus.contribute('menubar:File', ['-', 'file.exportComposition']);
window.WB = Object.assign(window.WB || {}, { compExport: { open: openCompExport } });
