// MCP tools: the project as a zip (lib/ops/projectio.mjs; ROADMAP_v4 G5). An agent's export never includes private media
// (the schema has no such switch; the op refuses it with 403 anyway); an import always makes a NEW project with the
// director's approvals demoted. Uploading a file and a new project from an uploaded song are the page's (no tool).
import { z } from 'zod';
import { mcp, op, wrap, project } from './_shared.mjs';

mcp.registerTool('project_export', {
  title: 'Export the project as a zip',
  description: 'Writes the project as ONE zip (format director-workbench/project-zip v1) into data/<project>/exports/<project>-<stamp>.zip: every JSON file, the sketches, peaks, '
    + 'thumbnails and the media the project registers or points at, plus workbench-export.json (each file with its size and sha256). PRIVATE media (the PRIVATE rule, media '
    + 'flagged private) is never in an agent\'s export, and every JSON file is scrubbed of private paths: only the director can make a personal backup with private media, in the page. '
    + '`snapshots: true` adds .snapshots/. Media under a media root are not copied (listed as external). Returns {path, url, abs, files, bytes, zip_bytes, private_excluded, '
    + 'unregistered_skipped, external}; `dry_run` = the counts, nothing written. The zip can be imported elsewhere with project_import (a NEW project; approvals arrive as review).',
  inputSchema: { project, snapshots: z.boolean().optional().describe('include the snapshots (.snapshots/)'), dry_run: z.boolean().optional().describe('counts and sizes only') },
}, wrap((a) => op('project_export', a)));

mcp.registerTool('project_import', {
  title: 'Import a project zip as a NEW project',
  description: 'Imports a workbench project zip (made by project_export or the page\'s File › Export project as zip…) as a NEW project, never over an existing one (409). '
    + '`path`: the zip under a project\'s exports folder ("data/<project>/exports/<file>.zip") or under a configured media root (a private path is the director\'s, in the page). '
    + 'Everything is validated before anything is written: unsafe paths (zip-slip: "..", absolute, drive, backslash, dot-folders, symlinks), sizes, the manifest\'s checksums '
    + '(every file listed with the same size and sha256, nothing extra), JSON and ids. The director\'s decisions do not travel: approvals approved / locked arrive as review, '
    + 'every request as draft (the old status in `imported.status`), batches as draft, approved looks / variants as review, approved tree nodes unset, scenes ok -> needs_you, '
    + 'items ok -> review, stages done -> in_progress, the render lock and command dropped; costs are kept as history. `id`: the new project id (default the zip\'s, else '
    + '<id>-import). `dry_run` = what it would do. Returns {id, from, files, bytes, demoted {approvals, requests, ...}}. Then `projects {action: "open", id}`.',
  inputSchema: { project, path: z.string().describe('the .zip: "data/<project>/exports/<file>.zip" or a path under a media root'),
    id: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/).optional().describe('the NEW project id'), title: z.string().max(200).optional(), dry_run: z.boolean().optional() },
}, wrap((a) => op('project_import', a)));
