// Reads a ".tlw" weight file (Tempolight weights), made by scripts/ml/convert-*.py. Pure JavaScript, no I/O: pass the
// file's bytes (a Uint8Array or ArrayBuffer from readFileSync, fetch() or a base64 string decoded by the caller).
//
// Layout: "TLW1", a uint32 header length H, H bytes of JSON {meta, tensors: [{name, shape, dtype, offset}]}, then the
// tensor data (4-byte aligned; offsets from the end of the header). dtype "f16" and "f32" become Float32Array, "u16"
// stays Uint16Array.

const f16 = (() => { // half float -> float, by table: 65,536 entries
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return t;
})();

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{meta: object, t: Record<string, {shape:number[], data:Float32Array|Uint16Array}>}}
 */
export function readWeights(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "TLW1") throw new Error("not a TLW1 weight file");
  const H = dv.getUint32(4, true), head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + H))), base = 8 + H, t = {};
  for (const d of head.tensors) {
    const n = d.shape.reduce((a, b) => a * b, 1), o = base + d.offset; let data;
    if (d.dtype === "f32") { data = new Float32Array(n); for (let i = 0; i < n; i++) data[i] = dv.getFloat32(o + 4 * i, true); }
    else if (d.dtype === "f16") { data = new Float32Array(n); for (let i = 0; i < n; i++) data[i] = f16[dv.getUint16(o + 2 * i, true)]; }
    else if (d.dtype === "u16") { data = new Uint16Array(n); for (let i = 0; i < n; i++) data[i] = dv.getUint16(o + 2 * i, true); }
    else throw new Error(`unknown dtype ${d.dtype}`);
    t[d.name] = { shape: d.shape, data };
  }
  return { meta: head.meta, t };
}
