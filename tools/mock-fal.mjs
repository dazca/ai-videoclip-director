// A mock of fal.ai for the tests: NEVER call the real fal from a test (it spends real money). It mimics the calls
// generators/fal.mjs makes (ported from falgen.py): the queue (submit / status / response), the two-step storage upload
// of refs, and the CDN that serves the outputs (a placeholder PNG, or for video a small placeholder MP4 made with
// ffmpeg). The workbench reaches it only through WB_FAL_BASE=<url>, which generators/fal.mjs honours only when WB_TEST=1.
//   const m = await startMockFal({ key, polls: 2, slowMs: 0 });  ...  m.stats, m.bodies, m.uploadsMeta, m.close()
//   m.mode = 'ok' | 'fail-submit' (422 on submit) | 'fail-status' (COMPLETED with an error) | 'hang' (IN_PROGRESS forever)
//   m.failNext = n  the next n jobs submitted finish COMPLETED with an error (one failed take inside a request)
//   m.events        [{type: submit | response, id, endpoint, at}] in order (a test checks that video ran one at a time)
// Video endpoints (D3b) check the parameters each kind requires, as fal would (422 + detail otherwise):
//   minimax/h3-max/image-to-video             prompt, image_url (an uploaded file), duration (integer), resolution; end_image_url optional
//   fal-ai/kling-video/v3/pro/image-to-video  prompt, start_image_url, duration ("5": a string), generate_audio false; end_image_url optional
//   fal-ai/kling-video/v3/pro/motion-control  image_url (an uploaded image), video_url (an uploaded VIDEO), character_orientation video | image
// and answer {video: {url}} (an MP4 as long as the duration asked, 3 s for motion control).
// It records every Authorization header it sees, so a test can check that the key went to the queue and storage only
// (never to the CDN download) and that a wrong key is refused (401).
//   node tools/mock-fal.mjs [port]   runs it alone (key from MOCK_FAL_KEY, default "test-key")
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tinyPng } from './tiny-png.mjs';

// a small placeholder MP4 of d seconds (ffmpeg; cached per length)
const MP4 = new Map();
export function placeholderMp4(d = 5) {
  d = Math.max(1, Math.min(30, Math.round(Number(d) || 5)));
  if (MP4.has(d)) return MP4.get(d);
  const f = path.join(os.tmpdir(), `wb-mockfal-${process.pid}-${d}s.mp4`);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=160x90:rate=24`, '-t', String(d), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', f]);
  let b = null; try { b = fs.readFileSync(f); fs.rmSync(f, { force: true }); } catch (e) { /* no ffmpeg */ }
  if (!b || b.length < 100) throw new Error('mock fal: ffmpeg is needed for the placeholder video');
  MP4.set(d, b); return b;
}

const VIDEO_EP = {
  'minimax/h3-max/image-to-video': (b, up) => [
    !(typeof b.prompt === 'string' && b.prompt.trim()) && 'prompt required',
    !up(b.image_url, 'image') && 'image_url: an uploaded image (fal storage) required',
    !Number.isInteger(b.duration) && 'duration: an integer number of seconds',
    !b.resolution && 'resolution required',
    b.end_image_url != null && !up(b.end_image_url, 'image') && 'end_image_url: an uploaded image'],
  'fal-ai/kling-video/v3/pro/image-to-video': (b, up) => [
    !(typeof b.prompt === 'string' && b.prompt.trim()) && 'prompt required',
    !up(b.start_image_url, 'image') && 'start_image_url: an uploaded image required',
    !(typeof b.duration === 'string' && /^\d+$/.test(b.duration)) && 'duration: a string like "5"',
    b.generate_audio !== false && 'generate_audio: false (silent price)',
    b.end_image_url != null && !up(b.end_image_url, 'image') && 'end_image_url: an uploaded image'],
  'fal-ai/kling-video/v3/pro/motion-control': (b, up) => [
    !up(b.image_url, 'image') && 'image_url: an uploaded image required',
    !up(b.video_url, 'video') && 'video_url: an uploaded video (fal storage) required',
    !['video', 'image'].includes(b.character_orientation) && 'character_orientation: video | image'],
};

export async function startMockFal({ key = 'test-key', polls = 2, slowMs = 0, port = 0 } = {}) {
  const stats = { submits: 0, uploads: 0, puts: 0, status: 0, responses: 0, downloads: 0, unauthorised: 0, keyOnCdn: 0, rejected: 0, videoSubmits: 0 };
  const bodies = [], seen = [], jobs = new Map(), uploadsMeta = [], rejects = [], events = [];
  const m = { stats, bodies, seen, uploadsMeta, rejects, events, mode: 'ok', failNext: 0, url: '' };
  // a file_url the storage handed out, of this kind (image / video, by the content type it was initiated with)
  const uploaded = (u, kind) => { const x = typeof u === 'string' && uploadsMeta.find(y => y.file_url === u); return !!x && String(x.content_type).startsWith(kind + '/'); };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), auth = req.headers.authorization || '';
    let body = ''; for await (const c of req) body += c;
    seen.push({ method: req.method, path: u.pathname, auth: !!auth });
    const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const authed = () => { if (auth === `Key ${key}`) return true; stats.unauthorised++; json(401, { detail: 'Unauthorized' }); return false; };
    if (slowMs) await new Promise(r => setTimeout(r, slowMs));
    // CDN: the outputs and the uploaded refs (public URLs: no key expected)
    if (req.method === 'GET' && u.pathname.startsWith('/cdn/')) {
      if (auth) stats.keyOnCdn++; stats.downloads++;
      const v = /^\/cdn\/vid_(\d+)s_/.exec(u.pathname);
      if (v) { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(placeholderMp4(Number(v[1]))); }
      res.writeHead(200, { 'content-type': 'image/png' }); return res.end(tinyPng(8, 6, [200, 120, 60]));
    }
    if (req.method === 'PUT' && u.pathname.startsWith('/upload/')) { if (auth) stats.keyOnCdn++; stats.puts++; const x = uploadsMeta.find(y => y.n === Number(u.pathname.slice(8))); if (x) x.bytes = Buffer.byteLength(body, 'latin1'); res.writeHead(200); return res.end(); }
    if (req.method === 'POST' && u.pathname === '/storage/upload/initiate') {
      if (!authed()) return; stats.uploads++;
      const n = stats.uploads, j = JSON.parse(body || '{}');
      const file_url = `${m.url}/cdn/ref${n}_${encodeURIComponent(j.file_name || 'x')}`;
      uploadsMeta.push({ n, content_type: j.content_type, file_name: j.file_name, file_url });
      return json(200, { upload_url: `${m.url}/upload/${n}`, file_url });
    }
    const st = /^\/requests\/([^/]+)\/status$/.exec(u.pathname), rs = /^\/requests\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'GET' && st) {
      if (!authed()) return; stats.status++;
      const j = jobs.get(st[1]); if (!j) return json(404, { detail: 'no such request' });
      j.polls++;
      if (m.mode === 'hang') return json(200, { status: 'IN_PROGRESS' });
      if (j.polls < polls) return json(200, { status: j.polls === 1 ? 'IN_QUEUE' : 'IN_PROGRESS', queue_position: 0 });
      return json(200, m.mode === 'fail-status' || j.fail ? { status: 'COMPLETED', error: 'mock: content policy' } : { status: 'COMPLETED' });
    }
    if (req.method === 'GET' && rs) {
      if (!authed()) return; stats.responses++;
      const j = jobs.get(rs[1]); events.push({ type: 'response', id: rs[1], endpoint: j?.endpoint, at: Date.now() });
      if (j?.video) return json(200, { video: { url: `${m.url}/cdn/vid_${j.seconds}s_${rs[1]}.mp4`, content_type: 'video/mp4' }, seed: 1 });
      return json(200, { images: [{ url: `${m.url}/cdn/out_${rs[1]}.png`, content_type: 'image/png' }], seed: 1 });
    }
    if (req.method === 'POST') {   // submit: POST /<endpoint>
      if (!authed()) return;
      if (m.mode === 'fail-submit') return json(422, { detail: 'mock: bad input' });
      let b = null; try { b = JSON.parse(body); } catch (e) { /* not JSON */ }
      const ep = u.pathname.slice(1), vcheck = VIDEO_EP[ep];
      if (vcheck) {
        const bad = vcheck(b || {}, uploaded).filter(Boolean);
        if (bad.length) { stats.rejected++; rejects.push({ endpoint: ep, bad }); return json(422, { detail: bad.map(msg => ({ msg })) }); }
      }
      stats.submits++; const id = `mock${stats.submits}`;
      bodies.push({ endpoint: ep, body: b });
      const job = { polls: 0, fail: m.failNext > 0, endpoint: ep }; events.push({ type: 'submit', id, endpoint: ep, at: Date.now() });
      if (job.fail) m.failNext--;
      if (vcheck) { stats.videoSubmits++; job.video = true; job.seconds = ep.endsWith('motion-control') ? 3 : Number(b.duration) || 5; }
      jobs.set(id, job);
      return json(200, { request_id: id, status_url: `${m.url}/requests/${id}/status`, response_url: `${m.url}/requests/${id}` });
    }
    json(404, { detail: 'not found' });
  });
  await new Promise(ok => srv.listen(port, '127.0.0.1', ok));
  m.url = `http://127.0.0.1:${srv.address().port}`;
  m.close = () => new Promise(ok => { srv.closeAllConnections?.(); srv.close(() => ok()); });
  return m;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = await startMockFal({ key: process.env.MOCK_FAL_KEY || 'test-key', port: Number(process.argv[2] || 0) });
  console.log(`mock fal on ${m.url} (WB_TEST=1 WB_FAL_BASE=${m.url})`);
}
