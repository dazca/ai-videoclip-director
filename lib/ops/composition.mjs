// E9: the composition data export (exporters/composition-data.mjs; format: docs/COMPOSITION_ROUNDTRIP.md).
//   composition_export   the workbench's picks (shot, take file + in / out, looks, placeholders, the song's anchors) as
//                        ONE versioned JSON with a checksum, written to data/<project>/exports/<out> (default
//                        exports/composition/edl.json) and nothing else. Read only with respect to everything the
//                        director decides: no approval, pick, request or project file is touched; private media is
//                        never written (a private pick becomes a placeholder). Page and agent alike, except that
//                        (review #3 L2) THE file the render reads (the director's remembered `out`, else the default) and
//                        its map are the director's: on a project locked for render an agent may not write it (409;
//                        another out inside exports/ is fine), and an agent's export of it uses the map the director
//                        remembered in the page (settings.json `composition`; another map: 403). An agent's save of
//                        settings.json keeps the server's `composition` (serve.mjs): the map changes only by a page act.
//   composition_get      read only: what an export would write now (counts, warnings, checksum, the remembered map / out)
import { fail, ops } from './_shared.mjs';
import { DEFAULT_OUT, exportComposition, settingsOf } from '../../exporters/composition-data.mjs';
import { lockedOf } from './final.mjs';

const normOut = (o) => String(o ?? '').replace(/^(\.\/)+/, '').replace(/\/+/g, '/');
const mapKey = (m) => JSON.stringify((Array.isArray(m) ? m : []).map(r => [String(r?.from ?? ''), String(r?.to ?? '')]));
Object.assign(ops, {
  composition_export(p, { out, map, dry_run, via } = {}) {
    if (via !== 'page' && !dry_run) {
      const st = settingsOf(p), theFile = normOut(st.out ?? DEFAULT_OUT), target = normOut(out ?? st.out ?? DEFAULT_OUT);
      if (target === theFile) {
        const L = lockedOf(p);
        if (L) fail(409, `the project is locked for render (${L.revision || 'locked'}): exports/${theFile} is the file the render reads, and only the director re-exports it (File › Export composition data…, in the page). An agent may export to another file inside exports/ (out: "agent/edl.json")`);
        if (map != null && st.map != null && mapKey(map) !== mapKey(st.map)) fail(403, `the file map of exports/${theFile} is the director's (remembered in the page's export dialog): export without "map" (it uses theirs), or to another out ("agent/edl.json")`);
      }
    }
    return exportComposition(p, { out, map, dry_run: !!dry_run });
  },
  composition_get(p, { out, map } = {}) { const s = settingsOf(p); return { ...exportComposition(p, { out, map, dry_run: true }), remembered: s }; },
});
