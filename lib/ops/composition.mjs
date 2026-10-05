// E9: the composition data export (exporters/composition-data.mjs; format: docs/COMPOSITION_ROUNDTRIP.md).
//   composition_export   the workbench's picks (shot, take file + in / out, looks, placeholders, the song's anchors) as
//                        ONE versioned JSON with a checksum, written to data/<project>/exports/<out> (default
//                        exports/composition/edl.json) and nothing else. Read only with respect to everything the
//                        director decides: no approval, pick, request or project file is touched; private media is
//                        never written (a private pick becomes a placeholder). Allowed on a project locked for render
//                        (lockGate): exporting for the render is what a lock is for. Page and agent alike.
//   composition_get      read only: what an export would write now (counts, warnings, checksum, the remembered map / out)
import { ops } from './_shared.mjs';
import { exportComposition, settingsOf } from '../../exporters/composition-data.mjs';

Object.assign(ops, {
  composition_export(p, { out, map, dry_run } = {}) { return exportComposition(p, { out, map, dry_run: !!dry_run }); },
  composition_get(p, { out, map } = {}) { const s = settingsOf(p); return { ...exportComposition(p, { out, map, dry_run: true }), remembered: s }; },
});
