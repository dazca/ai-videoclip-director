// MCP tools: the composition data export (lib/ops/composition.mjs, exporters/composition-data.mjs; ROADMAP_v4 E9).
// Read only with respect to the director's decisions: it writes the export file and nothing else.
import { z } from 'zod';
import { mcp, op, wrap, project } from './_shared.mjs';

const mapRule = z.object({ from: z.string().describe('a prefix of the workbench media path ("gen/", "project/gen/out/", "" = any)'), to: z.string().describe('what replaces it in the composition ("assets/world/")') });

mcp.registerTool('composition_export', {
  title: 'Export the picks for the composition (edl.json)',
  description: 'Writes the workbench\'s picks as ONE versioned JSON a HyperFrames composition reads back with exporters/composition-data/reader.js (format director-workbench/composition-edl v1, '
    + 'docs/COMPOSITION_ROUNDTRIP.md): per storyboard shot (time order) its time range, clip-use ids, the picked take (file mapped under the composition\'s assets, its workbench source, request / take, '
    + 'in_ms / out_ms) or a placeholder {reason: unpicked | private | missing | unmapped}, the alternatives, the look per character and the variant per location / prop; plus the song\'s timing anchors '
    + '(bpm, beat / bar, first beat, sections, lines) and a sha256 checksum. Deterministic: the same picks give the same bytes (changed: false). '
    + 'It writes ONLY data/<project>/exports/<out> (default composition/edl.json): no approval, pick, request or project file changes, and it works on a project locked for render. '
    + 'Private media is never written: a private pick exports as a placeholder without its file name. out must stay inside exports/ (a path with "..", ".", a drive, a backslash: 400). '
    + 'Returns {path, abs, checksum, bytes, changed, counts {shots, picked, placeholders, private, unmapped}, warnings, map}. Use dry_run to see the counts without writing. '
    + 'Copy (or link) the file into the composition and its takes under the mapped folder; the picks themselves are the director\'s (takes_get, take_propose).',
  inputSchema: { project,
    out: z.string().optional().describe('the file inside the project\'s exports/ folder (default the remembered one, else "composition/edl.json")'),
    map: z.array(mapRule).max(20).optional().describe('file mapping rules, longest from first (default the director\'s, Settings in the export dialog; else [{from: "", to: "assets/"}])'),
    dry_run: z.boolean().optional().describe('compute and report, write nothing') },
}, wrap((a) => op('composition_export', a)));
