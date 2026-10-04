#!/usr/bin/env node
// Security regressions for exporters/hyperframes-html (F07 confinement, F08 backslash traversal, F12 private filter).
// Scratch dirs under os.tmpdir() only, a stub --hyperframes dist, no network.   node tools/security-exporter.mjs
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChrome } from '../exporters/hyperframes-html/lib.mjs';

const WB = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPORT = join(WB, 'exporters', 'hyperframes-html', 'export.mjs');
const T = mkdtempSync(join(tmpdir(), 'wb-sec-exp-'));
let fails = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!cond) fails++; };
const put = (f, s) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, s); };
const run = (args, env = {}) => new Promise((res) => {
  const p = spawn(process.execPath, args, { cwd: T, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => out += d);
  const k = setTimeout(() => p.kill(), 90000);
  p.on('close', (code) => { clearTimeout(k); res({ code, out }); });
});
const files = (d) => readdirSync(d, { recursive: true }).map((f) => join(d, f)).filter((f) => statSync(f).isFile());

// ---- stub HyperFrames dist: the player loads src into an iframe, injects the runtime from its (rewritten) CDN URL
const HF = join(T, 'hf', 'dist');
put(join(HF, 'hyperframe.runtime.iife.js'), 'window.__hf = { stub: true };\n');
put(join(HF, 'hyperframes-player.global.js'), `(() => {
const RT = "https://cdn.jsdelivr.net/npm/@hyperframes/core@0.0.1/dist/hyperframe.runtime.iife.js";
customElements.define('hyperframes-player', class extends HTMLElement {
  connectedCallback() {
    const f = document.createElement('iframe'); f.style.cssText = 'width:100%;height:100%;border:0';
    f.onload = () => {
      const d = f.contentDocument, r = d.querySelector('[data-composition-id]');
      const s = d.createElement('script'); s.src = RT; s.onload = () => { this.assetsReady = true; }; d.head.appendChild(s);
      this.duration = Number(r && r.getAttribute('data-duration')) || 1;
      this.compositionWidth = Number(r && r.getAttribute('data-width')) || 320; this.compositionHeight = Number(r && r.getAttribute('data-height')) || 180;
      this.ready = true;
    };
    f.src = this.getAttribute('src'); this.appendChild(f);
  }
  seek() {} play() {} pause() {}
});
})();
`);
const comp = (body) => `<!doctype html><html><head><title>t</title></head><body>
<div data-composition-id="c" data-width="320" data-height="180" data-duration="1">${body}</div></body></html>`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const exportArgs = (c, o) => [EXPORT, c, o, '--hyperframes', HF, '--sample-fps', '2'];

try {
  const chrome = findChrome();
  if (!chrome) console.log('SKIP browser cases (a), (b), clean: no Chromium found (set CHROME_PATH)');
  else {
    // ---- clean fixture: export still works, runtime comes from the vendored copy (the CDN URL is never fetched)
    {
      const C = join(T, 'clean', 'comp'), O = join(T, 'clean', 'out');
      put(join(C, 'index.html'), comp('<img src="a.png" style="width:100px;height:100px">')); put(join(C, 'a.png'), PNG);
      const r = await run(exportArgs(C, O));
      ok('clean: export exits 0', r.code === 0, r.code === 0 ? '' : r.out.slice(-800));
      const M = existsSync(join(O, 'manifest.json')) && JSON.parse(readFileSync(join(O, 'manifest.json'), 'utf8'));
      ok('clean: asset packaged byte-identical', M && M.assets.some((a) => a.path === 'composition/a.png') && readFileSync(join(O, 'composition', 'a.png')).equals(PNG));
      ok('clean: vendored runtime injected, no external URLs', M && M.player.runtime_injected_during_pass === true && M.external.length === 0, M ? JSON.stringify(M.external) : '');
    }
    // ---- (a) F07: the composition's JS cannot reach another loopback server
    {
      let hits = 0; const dummy = createServer((q, s) => { hits++; s.end('x'); });
      dummy.on('connection', () => hits++); dummy.on('upgrade', (q, sock) => { hits++; sock.destroy(); });
      await new Promise((r) => dummy.listen(0, '127.0.0.1', r));
      const P = dummy.address().port, U = `http://127.0.0.1:${P}`;
      const C = join(T, 'a', 'comp'), O = join(T, 'a', 'out');
      put(join(C, 'index.html'), comp(`<script>
fetch('${U}/api/op/note_add?project=demo', { method: 'POST', mode: 'no-cors', body: '{"t":1,"text":"x"}' }).catch(() => {});
fetch('${U}/get').catch(() => {}); new Image().src = '${U}/img.png'; try { new WebSocket('ws://127.0.0.1:${P}/ws'); } catch {}
new Worker(URL.createObjectURL(new Blob(["fetch('${U}/worker').catch(() => {})"], { type: 'text/javascript' })));
</script>`));
      const r = await run(exportArgs(C, O));
      await new Promise((r) => setTimeout(r, 300)); dummy.close();
      ok('(a) export exits 0', r.code === 0, r.code === 0 ? '' : r.out.slice(-800));
      ok('(a) dummy loopback server received 0 connections', hits === 0, `hits=${hits}`);
      const M = existsSync(join(O, 'manifest.json')) && JSON.parse(readFileSync(join(O, 'manifest.json'), 'utf8'));
      ok('(a) blocked URLs listed as external', M && M.external.includes(`${U}/api/op/note_add?project=demo`) && M.external.includes(`${U}/get`), M ? JSON.stringify(M.external) : '');
    }
    // ---- (b) F08: backslash references stay inside the composition and OUT/composition
    {
      const B = join(T, 'b', 't1'), C = join(B, 'comp'), O = join(B, 'deep', 'out');
      put(join(B, 'leak.txt'), 'DUMMY-LEAK'); put(join(T, 'b', 'w.txt'), 'DUMMY-W');
      put(join(C, 'index.html'), comp('<img src="x\\..\\..\\leak.txt"><img src="x\\..\\..\\..\\w.txt"><script>const f = "x\\\\..\\\\..\\\\leak.txt";</script>'));
      const before = new Set(files(join(T, 'b')));
      const r = await run(exportArgs(C, O));
      ok('(b) export exits 0', r.code === 0, r.code === 0 ? '' : r.out.slice(-800));
      const stray = files(join(T, 'b')).filter((f) => !before.has(f) && !f.startsWith(join(O, 'composition') + '\\') && !f.startsWith(join(O, 'composition') + '/')
        && !['index.html', 'manifest.json'].includes(relative(O, f)) && !relative(O, f).startsWith('_hyperframes'));
      ok('(b) no file written outside OUT/composition', !stray.length, stray.join(', '));
      const M = existsSync(join(O, 'manifest.json')) && JSON.parse(readFileSync(join(O, 'manifest.json'), 'utf8'));
      ok('(b) leak not packaged', M && !M.assets.some((a) => /leak|w\.txt/.test(a.path)) && !files(O).some((f) => /DUMMY/.test(readFileSync(f, 'utf8'))));
      ok('(b) refs listed in outside_refs', M && M.outside_refs.some((s) => s.includes('leak.txt')) && M.outside_refs.some((s) => s.includes('w.txt')), M ? JSON.stringify(M.outside_refs) : '');
    }
  }

  // ---- (c) F12: addInteractive drops config private_media and media.json private:true paths (child: env before import)
  {
    const C = join(T, 'c'), PKG = join(C, 'pkg'), PRJ = join(C, 'proj');
    put(join(C, 'cfg.json'), JSON.stringify({ private_media: '^faces/' }));
    put(join(PKG, 'manifest.json'), JSON.stringify({ composition: { entry: 'composition/index.html', title: 't' } }));
    put(join(PRJ, 'shots.json'), JSON.stringify({ uses: [{ id: 'v1', clip: 'G1', t0: 0, t1: 1, file: 'faces/dummy.png', start_image: 'media/still/flagged.jpg' },
      { id: 'v2', clip: 'G2', t0: 1, t1: 2, file: 'media/still/ok.jpg' }] }));
    put(join(PRJ, 'media.json'), JSON.stringify({ items: [{ path: 'media/still/flagged.jpg', private: true }, { path: 'media/still/ok.jpg' }] }));
    const build = pathToFileURL(join(WB, 'exporters', 'hyperframes-html', 'interactive', 'build.mjs')).href;
    const r = await run(['--input-type=module', '-e', `const { addInteractive } = await import(${JSON.stringify(build)}); addInteractive(${JSON.stringify(PKG)}, { project: ${JSON.stringify(PRJ)} });`],
      { WORKBENCH_CONFIG: join(C, 'cfg.json'), WORKBENCH_DATA: join(C, 'data'), WORKBENCH_MEDIA_BASE: join(C, 'media') });
    ok('(c) addInteractive runs', r.code === 0, r.out.slice(-500));
    const J = existsSync(join(PKG, 'interactive.project.json')) ? readFileSync(join(PKG, 'interactive.project.json'), 'utf8') : '';
    ok('(c) interactive.project.json has neither private path', J && !J.includes('faces/dummy.png') && !J.includes('flagged.jpg') && J.includes('media/still/ok.jpg'), J.slice(0, 300));
  }
} finally {
  rmSync(T, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exitCode = fails ? 1 : 0;
