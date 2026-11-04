// A real-input FFT for the offline analysis and the chroma tap. Pure JavaScript, no I/O.
//
// A real signal of n samples is packed into n/2 complex values (even samples as the real part, odd as the imaginary),
// transformed with an n/2-point radix-2 FFT, and the two halves are split apart again: the same spectrum as an
// n-point complex FFT for about 40% of the work. Twiddles are kept per stage (no strided table reads).

const cache = new Map();
/**
 * An FFT for real input of `n` samples (a power of two, at least 8).
 * mag(x, out): magnitudes of bins 0 .. n/2 - 1 of x (x is not changed; window it first) into out (length n/2).
 * @param {number} n
 * @returns {{n:number, mag:(x:ArrayLike<number>, out:Float32Array, top?:number)=>Float32Array}}
 */
export function realFFT(n) {
  let f = cache.get(n); if (f) return f;
  const H = n >> 1, rev = new Uint16Array(H);
  for (let i = 0, j = 0; i < H; i++) { rev[i] = j; let b = H >> 1; while (j & b) { j ^= b; b >>= 1; } j |= b; }
  const tw = [], wr = new Float64Array(H), wi = new Float64Array(H);
  for (let size = 4; size <= H; size <<= 1) { const h = size >> 1, t = new Float64Array(2 * h); for (let q = 0; q < h; q++) { t[2 * q] = Math.cos(-2 * Math.PI * q / size); t[2 * q + 1] = Math.sin(-2 * Math.PI * q / size); } tw.push(t); }
  for (let k = 0; k < H; k++) { wr[k] = Math.cos(-2 * Math.PI * k / n); wi[k] = Math.sin(-2 * Math.PI * k / n); }
  const zr = new Float64Array(H), zi = new Float64Array(H);
  /** @param {number} [top] only bins below this are needed (the rest of `out` is left as it was) */
  function mag(x, out, top = H) {
    for (let i = 0; i < H; i++) { const j = rev[i]; zr[j] = x[2 * i]; zi[j] = x[2 * i + 1]; }
    for (let s = 0; s < H; s += 2) { const a = zr[s], b = zr[s + 1], c = zi[s], d = zi[s + 1]; zr[s] = a + b; zr[s + 1] = a - b; zi[s] = c + d; zi[s + 1] = c - d; }
    let st = 0;
    for (let size = 4; size <= H; size <<= 1, st++) { const h = size >> 1, t = tw[st];
      for (let s = 0; s < H; s += size) for (let q = 0; q < h; q++) { const c = t[2 * q], sn = t[2 * q + 1], a = s + q, b = a + h;
        const tr = zr[b] * c - zi[b] * sn, ti = zr[b] * sn + zi[b] * c; zr[b] = zr[a] - tr; zi[b] = zi[a] - ti; zr[a] += tr; zi[a] += ti; } }
    out[0] = Math.abs(zr[0] + zi[0]);
    const kEnd = Math.min(top, H);
    for (let k = 1; k < kEnd; k++) { const ar = zr[k], ai = zi[k], br = zr[H - k], bi = -zi[H - k];
      const er = ar + br, ei = ai + bi, or = ai - bi, oi = br - ar; // 2 x (even part), 2 x (odd part / i)
      const re = (er + wr[k] * or - wi[k] * oi) * 0.5, im = (ei + wr[k] * oi + wi[k] * or) * 0.5;
      out[k] = Math.sqrt(re * re + im * im); }
    return out;
  }
  f = { n, mag }; cache.set(n, f); return f;
}
