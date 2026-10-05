// "Open in another app" (D9): nothing is called and nothing is spent here. Running an approved request exports a
// prompt pack next to where the outputs go:
//   gen/<request>/pack/prompt.txt    the prompt (the page's "Copy prompt" puts the same text on the clipboard)
//   gen/<request>/pack/refs/NN_<name> the reference images, image 1 first
//   gen/<request>/pack/README.md     what to do, in which order
//   gen/<request>/results/           drop the images made in the other app here
// The request stays "running" (handed off) until results come back: run it again (Run in the Queue, request_run, or
// tools/run.mjs) and the files in results/ become its outputs (<id>_<take>.<ext>), at $0. Images made elsewhere can
// also come back through the import path (media_add + node_import_propose / "Import an image…").
// A request whose refs are private writes the pack under private/gen/ (local only, like every private file).
import fs from 'node:fs';
import path from 'node:path';

const IMG = /\.(png|jpe?g|webp)$/i;
const results = (dir) => { try { return fs.readdirSync(path.join(dir, 'results')).filter(n => IMG.test(n)).sort(); } catch (e) { return []; } };

export default {
  id: 'openwith', label: 'Open in another app (prompt pack, $0)', kinds: ['image', 'video', 'motion'],
  configured() { return { ok: true, why: 'exports a prompt pack (prompt, refs, README); results come back through results/ or an import' } ; },
  supports() { return { ok: true }; },
  estimate(req) { return { model: 'external', takes: 1, per_take: 0, usd: 0, tool: 'open-in-another-app', why: 'made in another app by you: nothing is paid through the workbench' }; },
  async submit(req, ctx) {
    const pack = path.join(ctx.dir, 'pack');
    fs.mkdirSync(path.join(pack, 'refs'), { recursive: true }); fs.mkdirSync(path.join(ctx.dir, 'results'), { recursive: true });
    fs.writeFileSync(path.join(pack, 'prompt.txt'), String(req.prompt || ''));
    const refs = (ctx.refFiles || []).map((abs, i) => { const n = `${String(i + 1).padStart(2, '0')}_${path.basename(abs)}`; fs.copyFileSync(abs, path.join(pack, 'refs', n)); return n; });
    const neg = req.recipe?.negative_prompt;
    fs.writeFileSync(path.join(pack, 'README.md'), [
      `# Request ${req.id} (${req.kind}${req.target ? ', ' + req.target : ''})`, '',
      `Approved in the Director Workbench; to be made in another app (nothing was paid through the workbench).`, '',
      '1. Open your image app (or a web UI) and paste the prompt: `prompt.txt` (the Queue\'s "Copy prompt" copies it too).',
      `2. Add the reference images from \`refs/\` in this order (image 1 first): ${refs.join(', ') || '(none)'}.`,
      ...(req.tool ? [`3. The workbench would have used \`${req.tool}\`; any model is fine.`] : []),
      ...(neg ? ['', `Negative prompt: ${neg}`] : []), '',
      `When done, save the images in \`${path.relative(path.dirname(ctx.dir), path.join(ctx.dir, 'results')).split(path.sep).join('/')}/\` (next to this pack)`,
      'and press Run on the request again (or `request_run`): they become its outputs at $0 and join its tree as nodes for you to keep or pick.', '',
    ].join('\n'));
    return { pack: path.relative(ctx.projectDir, pack).split(path.sep).join('/'), results: path.relative(ctx.projectDir, path.join(ctx.dir, 'results')).split(path.sep).join('/'), handoff: true };
  },
  async poll(handle, ctx) { return results(ctx.dir).length ? { status: 'done' } : { status: 'waiting' }; },
  async fetch(handle, ctx) { return results(ctx.dir).map(n => ({ file: path.join(ctx.dir, 'results', n), ext: path.extname(n).slice(1).toLowerCase().replace('jpeg', 'jpg') })); },
};
