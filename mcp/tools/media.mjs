// MCP tools: D8, importing existing images and video (lib/ops/media.mjs). media_scan reads a file or folder under a
// media root (with falgen's / the runner's job.json: prompt, model, refs, takes, cost); media_import registers files in
// place. Uploads (media_upload) and "use as" a node / a shot's take / start frame (media_use) are the director's, in the
// page: no tool. An agent proposes a "use as" with node_import_propose (a node) or a note on the shot.
import { z } from 'zod';
import { mcp, op, wrap, project } from './_shared.mjs';

const kind = z.string().regex(/^[a-z0-9_-]{1,32}$/).describe('still, clip, sheet, ref, render… (default: still for an image, clip for a video).');

mcp.registerTool('media_scan', {
  title: 'Look into a folder of existing images / video',
  description: 'Read only. A file or folder under a configured media root (base-relative like "project/gen/out" or "project/gen/out/A1", or absolute inside the media base): '
    + 'files [{path, name, type image|video (by its bytes), ext, size, private (the PRIVATE rule / flagged), registered (media id or null), kind, job, take, label}], '
    + 'jobs [{id, runner falgen|workbench, kind, model, endpoint, prompt, notes, refs [{path, private}], files, takes, cost {status: recorded | counted | not_counted | unknown, usd, source: workbench | falgen | ledger | job.json | estimate, why, offer (the cost_record args when not_counted)}}] '
    + '(a generation output tree: each <id>/job.json), skipped (not media, or the bytes disagree with the name), counts. Paths outside the media roots: 403. Nothing is opened but job.json and the first bytes of each media file.',
  inputSchema: { project, path: z.string().describe('A file or folder under a media root.'), recursive: z.boolean().optional().describe('default true (4 levels).'), limit: z.number().int().min(1).max(2000).optional() },
}, wrap((a) => op('media_scan', a)));

mcp.registerTool('media_import', {
  title: 'Register existing files under a media root (in place)',
  description: 'Register files (or every media file in a folder) that already exist under a media root, IN PLACE (never copied), so they show in Assets › Media and can be used: '
    + 'thumbnails, kind, label, job / take recovered from a job.json next to them (falgen out/<id>/ or the runner\'s gen/<request>/), cost_usd = the job\'s cost per take when known, `request` links them to a request. '
    + 'private: a file whose path matches the PRIVATE rule, or that is already flagged private, stays private (private:false is refused, 403); private:true makes them private. Non-media files (by their bytes): 415; outside the media roots: 403. '
    + 'Nothing is registered unless every file passes. Returns imported, already (registered before), jobs with their cost, and costs_not_counted (cost_record each; the same job is recorded once). '
    + '"Use as" (an identity / look / base / variant node, a shot\'s take or start frame) is the director\'s in the page: propose a node with node_import_propose {id, tree, media, why}, a take / start frame with a note on the shot.',
  inputSchema: { project, paths: z.array(z.string()).min(1).max(500).optional().describe('Files or folders under a media root.'),
    items: z.array(z.object({ path: z.string(), kind: kind.optional(), label: z.string().max(300).optional(), private: z.boolean().optional() })).min(1).max(500).optional().describe('Per file: kind / label / private (instead of paths).'),
    kind: kind.optional(), label: z.string().max(300).optional().describe('A label (one file only; else from job.json or the file name).'), private: z.boolean().optional(),
    entities: z.array(z.string()).optional().describe('Entity ids the files show (links, not nodes).'), request: z.string().optional().describe('A request id the files belong to (retro-registered outputs).'),
    job_links: z.boolean().optional().describe('Read job.json next to the files for job / take / label / cost (default true).') },
}, wrap((a) => op('media_import', a)));
