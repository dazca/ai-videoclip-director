// A mock of fal.ai for the tests: NEVER call the real fal from a test (it spends real money). It mimics the calls
// generators/fal.mjs makes (ported from falgen.py): the queue (submit / status / response), the two-step storage upload
// of refs, and the CDN that serves the outputs (a placeholder PNG). The workbench reaches it only through
// WB_FAL_BASE=<url>, which generators/fal.mjs honours only when WB_TEST=1.
//   const m = await startMockFal({ key, polls: 2, slowMs: 0 });  ...  m.stats, m.bodies, m.close()
//   m.mode = 'ok' | 'fail-submit' (422 on submit) | 'fail-status' (COMPLETED with an error) | 'hang' (IN_PROGRESS forever)
// It records every Authorization header it sees, so a test can check that the key went to the queue and storage only
// (never to the CDN download) and that a wrong key is refused (401).
//   node tools/mock-fal.mjs [port]   runs it alone (key from MOCK_FAL_KEY, default "test-key")
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tinyPng } from './tiny-png.mjs';

export async function startMockFal({ key = 'test-key', polls = 2, slowMs = 0, port = 0 } = {}) {
  const stats = { submits: 0, uploads: 0, puts: 0, status: 0, responses: 0, downloads: 0, unauthorised: 0, keyOnCdn: 0 };
  const bodies = [], seen = [], jobs = new Map();
  const m = { stats, bodies, seen, mode: 'ok', url: '' };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), auth = req.headers.authorization || '';
    let body = ''; for await (const c of req) body += c;
    seen.push({ method: req.method, path: u.pathname, auth: !!auth });
    const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const authed = () => { if (auth === `Key ${key}`) return true; stats.unauthorised++; json(401, { detail: 'Unauthorized' }); return false; };
    if (slowMs) await new Promise(r => setTimeout(r, slowMs));
    // CDN: the outputs and the uploaded refs (public URLs: no key expected)
    if (req.method === 'GET' && u.pathname.startsWith('/cdn/')) { if (auth) stats.keyOnCdn++; stats.downloads++; res.writeHead(200, { 'content-type': 'image/png' }); return res.end(tinyPng(8, 6, [200, 120, 60])); }
    if (req.method === 'PUT' && u.pathname.startsWith('/upload/')) { if (auth) stats.keyOnCdn++; stats.puts++; res.writeHead(200); return res.end(); }
    if (req.method === 'POST' && u.pathname === '/storage/upload/initiate') {
      if (!authed()) return; stats.uploads++;
      const n = stats.uploads, j = JSON.parse(body || '{}');
      return json(200, { upload_url: `${m.url}/upload/${n}`, file_url: `${m.url}/cdn/ref${n}_${encodeURIComponent(j.file_name || 'x')}` });
    }
    const st = /^\/requests\/([^/]+)\/status$/.exec(u.pathname), rs = /^\/requests\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'GET' && st) {
      if (!authed()) return; stats.status++;
      const j = jobs.get(st[1]); if (!j) return json(404, { detail: 'no such request' });
      j.polls++;
      if (m.mode === 'hang') return json(200, { status: 'IN_PROGRESS' });
      if (j.polls < polls) return json(200, { status: j.polls === 1 ? 'IN_QUEUE' : 'IN_PROGRESS', queue_position: 0 });
      return json(200, m.mode === 'fail-status' ? { status: 'COMPLETED', error: 'mock: content policy' } : { status: 'COMPLETED' });
    }
    if (req.method === 'GET' && rs) { if (!authed()) return; stats.responses++; return json(200, { images: [{ url: `${m.url}/cdn/out_${rs[1]}.png`, content_type: 'image/png' }], seed: 1 }); }
    if (req.method === 'POST') {   // submit: POST /<endpoint>
      if (!authed()) return;
      if (m.mode === 'fail-submit') return json(422, { detail: 'mock: bad input' });
      stats.submits++; const id = `mock${stats.submits}`;
      let b = null; try { b = JSON.parse(body); } catch (e) { /* not JSON */ }
      bodies.push({ endpoint: u.pathname.slice(1), body: b });
      jobs.set(id, { polls: 0 });
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
