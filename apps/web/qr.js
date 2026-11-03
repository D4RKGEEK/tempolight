// A small QR code maker (byte mode, error correction level M, versions 1 to 20), so phones can scan their way to
// the /phone page. Follows the QR Code standard (ISO/IEC 18004). qrMatrix(text) gives rows of booleans; qrSvg draws it.

const ECC_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];

function rawModules(v) { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; }
const dataCodewords = v => Math.floor(rawModules(v) / 8) - ECC_M[v] * BLOCKS_M[v];
function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 255; }
function rsDivisor(d) { const r = new Array(d).fill(0); r[d - 1] = 1; let root = 1;
  for (let i = 0; i < d; i++) { for (let j = 0; j < d; j++) { r[j] = gfMul(r[j], root); if (j + 1 < d) r[j] ^= r[j + 1]; } root = gfMul(root, 2); } return r; }
function rsRemainder(data, div) { const r = div.map(() => 0); for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => r[i] ^= gfMul(c, f)); } return r; }
function alignPositions(v, size) { if (v === 1) return []; const n = Math.floor(v / 7) + 2, step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, out = [6];
  for (let p = size - 7; out.length < n; p -= step) out.splice(1, 0, p); return out; }

export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let v = 1; for (; v <= 20; v++) if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v) * 8) break;
  if (v > 20) throw new Error("Text too long for a QR code");
  // data bits
  const bits = []; const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
  const cap = dataCodewords(v) * 8; put(0, Math.min(4, cap - bits.length)); put(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  // error correction, split into blocks and interleaved
  const nb = BLOCKS_M[v], ecl = ECC_M[v], raw = Math.floor(rawModules(v) / 8), nShort = nb - raw % nb, shortLen = Math.floor(raw / nb), div = rsDivisor(ecl), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) { const d = data.slice(k, k + shortLen - ecl + (i < nShort ? 0 : 1)); k += d.length; const e = rsRemainder(d, div); if (i < nShort) d.push(0); blocks.push(d.concat(e)); }
  const words = []; for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecl || j >= nShort) words.push(b[i]); });
  // function patterns
  const size = v * 4 + 17, M = [...Array(size)].map(() => new Array(size).fill(false)), F = [...Array(size)].map(() => new Array(size).fill(false));
  const set = (x, y, dark) => { M[y][x] = dark; F[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy)); if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4); }
  const al = alignPositions(v, size), last = al.length - 1;
  al.forEach((ax, i) => al.forEach((ay, j) => { if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
  const format = mask => { const d = (0 << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); const b = ((d << 10) | r) ^ 0x5412, bit = i => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i)); set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8)); for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i)); for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i)); set(8, size - 8, true); };
  format(0);
  if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); const b = (v << 12) | r;
    for (let i = 0; i < 18; i++) { const bit = ((b >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, bit); set(c, a, bit); } }
  // data in the zig-zag order
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) { if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) { const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!F[y][x] && i < words.length * 8) { M[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; } } }
  // pick the mask that leaves the fewest confusing patterns
  const masks = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => x * y % 2 + x * y % 3 === 0, (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
  const apply = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!F[y][x] && masks[m](x, y)) M[y][x] = !M[y][x]; };
  const penalty = () => { let p = 0, dark = 0;
    for (let a = 0; a < size; a++) for (const row of [true, false]) { let run = 1; for (let b = 1; b < size; b++) { const c = row ? M[a][b] : M[b][a], q = row ? M[a][b - 1] : M[b - 1][a];
      if (c === q) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = M[y][x]; if (c === M[y][x + 1] && c === M[y + 1][x] && c === M[y + 1][x + 1]) p += 3; }
    for (const row of M) for (const c of row) if (c) dark++; return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10; };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) { apply(m); format(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } apply(m); }
  apply(best); format(best);
  return M;
}

/** An SVG string of the QR code, with the quiet zone around it. */
export function qrSvg(text, { px = 6, dark = "#000", light = "#fff" } = {}) {
  const M = qrMatrix(text), n = M.length, q = 4, s = n + q * 2; let d = "";
  M.forEach((row, y) => row.forEach((c, x) => { if (c) d += `M${x + q} ${y + q}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s * px}" height="${s * px}" shape-rendering="crispEdges" role="img" aria-label="QR code for ${text.replace(/[<>&"]/g, "")}"><rect width="${s}" height="${s}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
