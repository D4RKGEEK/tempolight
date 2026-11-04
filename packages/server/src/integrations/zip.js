// A small zip writer (deflate, no extras), for the Stream Deck plugin: a .streamDeckPlugin file is a zip of the
// plugin's folder. Used by scripts/package-streamdeck.js and by the download on the Integrations page.
import zlib from "node:zlib";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** @param {{name:string, data:Buffer}[]} entries names use "/" @returns {Buffer} */
export function zip(entries, { date = new Date(2026, 0, 1) } = {}) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1), dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = [], centrals = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8"), raw = Buffer.from(e.data), def = zlib.deflateRawSync(raw, { level: 9 }), store = def.length >= raw.length, body = store ? raw : def, crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(store ? 0 : 8, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, body); centrals.push(ch, name); off += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Reads a zip made by zip() (or any zip without data descriptors): [{name, data}]. For tests. */
export function unzip(buf) {
  const out = []; let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--; if (e < 0) throw new Error("not a zip");
  let p = buf.readUInt32LE(e + 16); const n = buf.readUInt16LE(e + 10);
  for (let i = 0; i < n; i++) { const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42), name = buf.subarray(p + 46, p + 46 + nl).toString("utf8");
    const lnl = buf.readUInt16LE(lo + 26), lxl = buf.readUInt16LE(lo + 28), data = buf.subarray(lo + 30 + lnl + lxl, lo + 30 + lnl + lxl + size);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data), crc: buf.readUInt32LE(p + 16) }); p += 46 + nl + xl + cl; }
  return out;
}

/** The plugin folder as a .streamDeckPlugin (a zip with the folder itself at the top). null when the folder isn't there. */
export function packFolder(dir) {
  if (!existsSync(dir)) return null; const base = path.basename(dir), entries = [];
  const walk = rel => { for (const f of readdirSync(path.join(dir, rel)).sort()) { const r = rel ? `${rel}/${f}` : f, abs = path.join(dir, r);
    if (/^\.|\.test\.js$|~$/.test(f)) continue; if (statSync(abs).isDirectory()) walk(r); else entries.push({ name: `${base}/${r}`, data: readFileSync(abs) }); } };
  walk(""); return zip(entries);
}
