// A minimal zip writer and a validating zip reader (G5: project zip export / import). No dependency: node:zlib's raw
// deflate and a CRC-32 table. Enough of PKWARE APPNOTE for what the workbench writes and reads:
//   - writer: store (media) or deflate (JSON / text) entries, UTF-8 names (flag bit 11), local headers with the sizes and
//     CRC up front (no data descriptors), one central directory, no zip64 (a project over 4 GB or 65535 files is refused)
//   - reader: random access through a file descriptor (a big zip never sits in memory: one entry at a time); refuses
//     zip64, multi-disk, encryption, methods other than store / deflate, symlinks, entries whose data ranges overlap or
//     run past the central directory (zip bombs by overlap), a local name that differs from the central one, and inflates
//     with maxOutputLength = the declared size (a bomb that lies about its size stops there); every CRC is checked
import fs from 'node:fs';
import zlib from 'node:zlib';

const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf, crc = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, crc) >>> 0;
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const U32 = 0xffffffff;
export class ZipError extends Error { constructor(msg) { super(msg); this.code = 400; } }
const bad = (m) => { throw new ZipError(m); };
function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// ------------------------------------------------------------------ writer
export class ZipWriter {
  constructor(file, { at = new Date() } = {}) { this.file = file; this.fd = fs.openSync(file, 'w'); this.off = 0; this.cd = []; this.names = new Set(); this.t = dosTime(at); }
  write(b) { fs.writeSync(this.fd, b, 0, b.length, this.off); this.off += b.length; }
  // name: a "/" path inside the zip; data: a Buffer; deflate: compress it (JSON, text)
  add(name, data, { deflate = false } = {}) {
    if (this.names.has(name.toLowerCase())) bad(`duplicate entry ${name}`);
    this.names.add(name.toLowerCase());
    if (this.cd.length >= 0xffff) bad('more than 65535 files: too many for a zip without zip64');
    const nb = Buffer.from(name, 'utf8'), crc = crc32(data);
    let body = data, method = 0;
    if (deflate) { const z = zlib.deflateRawSync(data, { level: 6 }); if (z.length < data.length) { body = z; method = 8; } }
    if (data.length >= U32 || body.length >= U32 || this.off + 30 + nb.length + body.length >= U32) bad('the project is over 4 GB: too big for a zip without zip64 (export without the private media or the snapshots, or move the large files to a media root)');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(method, 8);
    h.writeUInt16LE(this.t.time, 10); h.writeUInt16LE(this.t.date, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26); h.writeUInt16LE(0, 28);
    const at = this.off;
    this.write(h); this.write(nb); this.write(body);
    this.cd.push({ nb, crc, method, csize: body.length, usize: data.length, at });
  }
  finish() {
    const start = this.off;
    for (const e of this.cd) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(this.t.time, 12); c.writeUInt16LE(this.t.date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.usize, 24);
      c.writeUInt16LE(e.nb.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32); c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36);
      c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(e.at, 42);
      this.write(c); this.write(e.nb);
    }
    const size = this.off - start;
    if (this.off >= U32) bad('the zip is over 4 GB: too big without zip64');
    const z = Buffer.alloc(22);
    z.writeUInt32LE(0x06054b50, 0); z.writeUInt16LE(this.cd.length, 8); z.writeUInt16LE(this.cd.length, 10); z.writeUInt32LE(size, 12); z.writeUInt32LE(start, 16);
    this.write(z);
    fs.closeSync(this.fd); this.fd = null;
    return { bytes: this.off, files: this.cd.length };
  }
  abort() { if (this.fd != null) { try { fs.closeSync(this.fd); } catch (e) { /* closed */ } this.fd = null; } fs.rmSync(this.file, { force: true }); }
}

// ------------------------------------------------------------------ reader
// -> {entries: [{name, method, csize, usize, crc, dataAt, dir}], read(entry) -> Buffer, close()}
// limits: maxEntries, maxEntry (bytes of one entry, uncompressed), maxTotal (all entries, uncompressed)
export function openZip(file, { maxEntries = 20000, maxEntry = 512 * 1048576, maxTotal = 2048 * 1048576 } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const rd = (pos, n) => { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, pos); if (got !== n) bad('truncated zip'); return b; };
    if (size < 22) bad('not a zip (too short)');
    const tailN = Math.min(size, 22 + 0xffff), tail = rd(size - tailN, tailN);
    let e = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) bad('not a zip (no end of central directory)');
    const disk = tail.readUInt16LE(e + 4), cdDisk = tail.readUInt16LE(e + 6), n1 = tail.readUInt16LE(e + 8), n = tail.readUInt16LE(e + 10);
    const cdSize = tail.readUInt32LE(e + 12), cdAt = tail.readUInt32LE(e + 16);
    if (disk || cdDisk || n1 !== n) bad('multi-disk zips are not supported');
    if (n === 0xffff || cdSize === U32 || cdAt === U32) bad('zip64 is not supported');
    if (n > maxEntries) bad(`too many files (${n} > ${maxEntries})`);
    if (cdAt + cdSize > size - tailN + e) bad('the central directory runs past its end');
    const cd = rd(cdAt, cdSize), entries = [], seen = new Set();
    let p = 0, total = 0;
    for (let i = 0; i < n; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) bad('bad central directory entry');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), attrs = cd.readUInt32LE(p + 38), at = cd.readUInt32LE(p + 42);
      if (p + 46 + nl + xl + cl > cd.length) bad('bad central directory entry');
      const raw = cd.subarray(p + 46, p + 46 + nl), name = raw.toString('utf8');
      p += 46 + nl + xl + cl;
      if (flags & 1) bad(`${name}: encrypted entries are not supported`);
      if (csize === U32 || usize === U32 || at === U32) bad('zip64 is not supported');
      if (!Buffer.from(name, 'utf8').equals(raw)) bad('an entry name is not valid UTF-8');
      const type = (attrs >>> 16) & 0o170000;
      if (type === 0o120000) bad(`${name}: symbolic links are not allowed`);
      const dir = name.endsWith('/');
      if (!dir && method !== 0 && method !== 8) bad(`${name}: compression method ${method} is not supported (store or deflate only)`);
      if (method === 0 && csize !== usize) bad(`${name}: stored sizes differ`);
      if (usize > maxEntry) bad(`${name}: ${(usize / 1048576).toFixed(0)} MB, over the ${(maxEntry / 1048576).toFixed(0)} MB a file`);
      total += usize; if (total > maxTotal) bad(`over ${(maxTotal / 1048576).toFixed(0)} MB uncompressed in all: too big to import`);
      if (method === 8 && usize > 1048576 && usize / Math.max(1, csize) > 1000) bad(`${name}: a compression ratio over 1000:1 (a zip bomb?)`);
      const key = name.toLowerCase(); if (seen.has(key)) bad(`duplicate entry ${name}`); seen.add(key);
      // the local header: same name, data inside the file and before the central directory
      const lh = rd(at, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) bad(`${name}: bad local header`);
      const ln = lh.readUInt16LE(26), lx = lh.readUInt16LE(28);
      if (!rd(at + 30, ln).equals(raw)) bad(`${name}: the local name differs from the central directory`);
      const dataAt = at + 30 + ln + lx;
      if (dataAt + csize > cdAt) bad(`${name}: data runs into the central directory`);
      entries.push({ name, method, csize, usize, crc, at, dataAt, dir });
    }
    // no two entries share bytes (an overlapping-entries bomb)
    const byAt = [...entries].sort((a, b) => a.at - b.at);
    for (let i = 1; i < byAt.length; i++) if (byAt[i].at < byAt[i - 1].dataAt + byAt[i - 1].csize) bad(`${byAt[i].name}: overlaps ${byAt[i - 1].name}`);
    const read = (en) => {
      const raw = en.csize ? rd(en.dataAt, en.csize) : Buffer.alloc(0);
      let out;
      if (en.method === 0) out = raw;
      else { try { out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, en.usize) }); } catch (er) { bad(`${en.name}: does not inflate to its declared size (${er.code || er.message})`); } }
      if (out.length !== en.usize) bad(`${en.name}: ${out.length} bytes, the zip says ${en.usize}`);
      if (crc32(out) !== en.crc) bad(`${en.name}: CRC mismatch (a damaged zip)`);
      return out;
    };
    return { entries, read, close: () => fs.closeSync(fd) };
  } catch (e) { fs.closeSync(fd); throw e; }
}
