// Shared helpers for export.mjs / verify.mjs / serve.mjs: a static server with mounts (range requests, request log,
// follows junctions/symlinks), the headless Chrome launcher, ffprobe, hashing and raw-frame decoding with ffmpeg.
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { findChrome as findAnyChrome } from '../../tools/chrome.mjs';

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
};
export const mimeOf = (p) => MIME[extname(p).toLowerCase()] || 'application/octet-stream';

export function kindOf(p) {
  const e = extname(p).toLowerCase(), m = mimeOf(p);
  if (e === '.html' || e === '.htm') return 'html';
  if (e === '.css') return 'css';
  if (e === '.js' || e === '.mjs') return 'script';
  if (e === '.json') return 'data';
  if (m.startsWith('font/')) return 'font';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'image';
  return 'other';
}

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// serve(mounts) -> {url, log[{path, method, status, bytes, file}], close()}.
// mounts: [{prefix: '/composition/', dir}] or [{prefix: '/x.html', file}] or [{prefix: '/a/', content: Map(path -> Buffer)}].
// The first matching prefix wins. fs.statSync / createReadStream follow junctions and symlinks.
export function serve(mounts, port = 0) {
  const log = [];
  const srv = createServer((req, res) => {
    let path; try { path = decodeURIComponent(req.url.split('?')[0]); } catch { path = req.url; }
    const rec = { path, method: req.method, status: 0, bytes: 0, file: null }; log.push(rec);
    let file = null, body = null;
    for (const m of mounts) {
      if (m.file && path === m.prefix) { file = m.file; break; }
      if (m.content && m.content.has(path)) { body = m.content.get(path); break; }
      if (m.dir && path.startsWith(m.prefix)) {
        const root = resolve(m.dir), f = normalize(join(root, path.slice(m.prefix.length) || 'index.html'));
        if (f !== root && !f.startsWith(root + sep)) { rec.status = 403; res.writeHead(403).end(); return; }
        file = f; break;
      }
    }
    if (body) { rec.status = 200; rec.bytes = body.length; res.writeHead(200, { 'Content-Type': mimeOf(path), 'Content-Length': body.length, 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : body); return; }
    let st; try { st = statSync(file); if (st.isDirectory()) throw 0; } catch { rec.status = 404; res.writeHead(404, { 'Cache-Control': 'no-store' }).end('not found'); return; }
    rec.file = file;
    const type = mimeOf(file), H = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (req.method === 'HEAD') { rec.status = 200; res.writeHead(200, { ...H, 'Content-Length': st.size }).end(); return; }
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range && st.size > 0) {
      let a = range[1] ? +range[1] : st.size - +range[2], b = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
      if (a < 0) a = 0;
      if (Number.isNaN(a) || Number.isNaN(b) || a > b || a >= st.size) { rec.status = 416; res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
      rec.status = 206; rec.bytes = b - a + 1;
      res.writeHead(206, { ...H, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
      try { createReadStream(file, { start: a, end: b }).on('error', () => res.destroy()).pipe(res); } catch { res.destroy(); }
    } else {
      rec.status = 200; rec.bytes = st.size;
      res.writeHead(200, { ...H, 'Content-Length': st.size });
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
  });
  return new Promise((ok) => srv.listen(port, '127.0.0.1', () => {
    const p = srv.address().port;
    ok({ port: p, url: `http://127.0.0.1:${p}/`, log, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) });
  }));
}

// A Chrome with proprietary codecs (H.264/AAC) matters here: $CHROME_PATH, then the Chrome for Testing builds that
// puppeteer / HyperFrames keep in ~/.cache/puppeteer (the renderer's own browser), then tools/chrome.mjs.
export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const kind of ['chrome-headless-shell', 'chrome']) {
    const base = join(homedir(), '.cache', 'puppeteer', kind);
    if (!existsSync(base)) continue;
    for (const v of readdirSync(base).sort().reverse()) for (const d of readdirSync(join(base, v))) for (const exe of [
      'chrome-headless-shell.exe', 'chrome-headless-shell', 'chrome.exe', 'chrome', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']) {
      const f = join(base, v, d, exe); if (existsSync(f) && statSync(f).isFile()) return f;
    }
  }
  return findAnyChrome();
}

export async function launch() {
  const { default: puppeteer } = await import('puppeteer-core');
  const exe = findChrome();
  if (!exe) throw new Error('no Chrome found: set CHROME_PATH');
  return puppeteer.launch({
    executablePath: exe, headless: true, protocolTimeout: 900000,
    args: ['--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
}

export function ffprobe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 1 << 24 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

const ratio = (s) => { if (!s || s === '0/0') return null; const [a, b] = String(s).split('/').map(Number); return b ? +(a / b).toFixed(3) : +a || null; };
const ALPHA_PIX = /^(rgba|bgra|argb|abgr|ya|yuva|gbrap|pal8|rgba64|bgra64|ya16)/;

// Media facts a compression step needs to decide per file.
export function mediaInfo(file, kind) {
  const j = ffprobe(file); if (!j) return { probe_error: true };
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic) || kind === 'image' && s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const f = j.format || {};
  const out = {};
  if (kind === 'image') {
    if (v) Object.assign(out, { codec: v.codec_name, width: v.width, height: v.height, pix_fmt: v.pix_fmt, has_alpha: ALPHA_PIX.test(v.pix_fmt || '') });
    return out;
  }
  const dur = Number(f.duration || (v && v.duration) || (a && a.duration)) || null;
  Object.assign(out, { container: f.format_name, duration: dur && +dur.toFixed(3), bitrate: Number(f.bit_rate) || null });
  if (v) {
    const alphaTag = (v.tags && (v.tags.alpha_mode || v.tags.ALPHA_MODE)) === '1';
    Object.assign(out, {
      codec: v.codec_name, profile: v.profile || null, width: v.width, height: v.height, fps: ratio(v.avg_frame_rate) || ratio(v.r_frame_rate),
      pix_fmt: v.pix_fmt, has_alpha: alphaTag || ALPHA_PIX.test(v.pix_fmt || ''), video_bitrate: Number(v.bit_rate) || null,
      frames: Number(v.nb_frames) || null,
    });
  }
  if (a) Object.assign(out, { audio_codec: a.codec_name, sample_rate: Number(a.sample_rate) || null, channels: a.channels || null, audio_bitrate: Number(a.bit_rate) || null });
  if (!v && a) out.codec = a.codec_name;
  out.has_video = !!v; out.has_audio = !!a;
  return out;
}

// PNG/JPEG buffer or file -> raw rgb24 at w x h (ffmpeg scales if needed).
export function rgb(input, w, h, seek = null) {
  const args = ['-v', 'error'];
  if (seek !== null) args.push('-ss', String(seek));
  args.push('-i', Buffer.isBuffer(input) ? 'pipe:0' : input, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
  return execFileSync('ffmpeg', args, { input: Buffer.isBuffer(input) ? input : undefined, maxBuffer: w * h * 3 + (1 << 20) });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const argv = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
export const flag = (k) => process.argv.includes(k);
