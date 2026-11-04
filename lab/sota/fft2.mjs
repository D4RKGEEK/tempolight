const E = await import("/home/claude/tempolight/packages/engine/src/index.js");
const now = () => performance.now(), NF = 1024, N = 30000, src = new Float64Array(NF); for (let i = 0; i < NF; i++) src[i] = Math.sin(i * 0.3) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF)) + Math.sin(i * 0.031) * 0.3;
const res = {}; const A = new E.LiveAnalyser(22050);
const copyIn = (re, im) => { for (let i = 0; i < NF; i++) { re[i] = src[i]; im[i] = 0; } };
let t0 = now(); for (let k = 0; k < N; k++) copyIn(A.re, A.im); const copyUs = (now() - t0) * 1000 / N; res.copyUs = +copyUs.toFixed(2);
t0 = now(); for (let k = 0; k < N; k++) { copyIn(A.re, A.im); A.fft(); } res.current_radix2_f32 = +((now() - t0) * 1000 / N - copyUs).toFixed(2);
const ref = Array.from({ length: NF / 2 + 1 }, (_, k) => Math.hypot(A.re[k], A.im[k]));
const mk = (n, T) => { const rev = new Uint16Array(n); for (let i = 0, j = 0; i < n; i++) { rev[i] = j; let b = n >> 1; while (j & b) { j ^= b; b >>= 1; } j |= b; }
  const tw = new T(n * 2); let o = 0; const offs = []; for (let size = 2; size <= n; size <<= 1) { offs.push(o); const h = size >> 1; for (let q = 0; q < h; q++) { tw[o++] = Math.cos(-2 * Math.PI * q / size); tw[o++] = Math.sin(-2 * Math.PI * q / size); } } return { rev, tw, offs }; };
function fftC(re, im, n, { rev, tw, offs }) {
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let s = 0; s < n; s += 2) { const a = re[s], b = re[s + 1], c = im[s], d = im[s + 1]; re[s] = a + b; re[s + 1] = a - b; im[s] = c + d; im[s + 1] = c - d; }
  let st = 1; for (let size = 4; size <= n; size <<= 1, st++) { const h = size >> 1, o = offs[st];
    for (let s = 0; s < n; s += size) for (let q = 0; q < h; q++) { const c = tw[o + 2 * q], sn = tw[o + 2 * q + 1], a = s + q, b = a + h;
      const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; } } }
for (const [nm, T] of [["f32", Float32Array], ["f64", Float64Array]]) { const tb = mk(NF, T), re = new T(NF), im = new T(NF);
  t0 = now(); for (let k = 0; k < N; k++) { copyIn(re, im); fftC(re, im, NF, tb); } res["stageTwiddle_" + nm] = +((now() - t0) * 1000 / N - copyUs).toFixed(2);
  let e = 0; for (let k = 0; k <= NF / 2; k++) e = Math.max(e, Math.abs(Math.hypot(re[k], im[k]) - ref[k])); res["err_" + nm] = e.toExponential(1); }
// real FFT via half-size complex
for (const [nm, T] of [["f32", Float32Array], ["f64", Float64Array]]) {
  const H = NF / 2, tb = mk(H, T), zr = new T(H), zi = new T(H), Xr = new T(H + 1), Xi = new T(H + 1), wr = new T(H), wi = new T(H);
  for (let k = 0; k < H; k++) { wr[k] = Math.cos(-2 * Math.PI * k / NF); wi[k] = Math.sin(-2 * Math.PI * k / NF); }
  const run = () => { for (let i = 0; i < H; i++) { zr[i] = src[2 * i]; zi[i] = src[2 * i + 1]; } fftC(zr, zi, H, tb);
    Xr[0] = zr[0] + zi[0]; Xi[0] = 0; Xr[H] = zr[0] - zi[0]; Xi[H] = 0;
    for (let k = 1; k < H; k++) { const ar = zr[k], ai = zi[k], br = zr[H - k], bi = -zi[H - k]; const er = (ar + br) / 2, ei = (ai + bi) / 2, or_ = (ai - bi) / 2, oi = -(ar - br) / 2;
      Xr[k] = er + wr[k] * or_ - wi[k] * oi; Xi[k] = ei + wr[k] * oi + wi[k] * or_; } };
  t0 = now(); for (let k = 0; k < N; k++) run(); res["realFFT_half_" + nm + "_inclCopy"] = +((now() - t0) * 1000 / N).toFixed(2);
  let e = 0; for (let k = 0; k <= H; k++) e = Math.max(e, Math.abs(Math.hypot(Xr[k], Xi[k]) - ref[k])); res["errReal_" + nm] = e.toExponential(1); }
// magnitude: sqrt vs hypot
const re = new Float32Array(NF).map((_, i) => Math.sin(i)), im = new Float32Array(NF).map((_, i) => Math.cos(i * 1.1)), mag = new Float32Array(NF / 2);
t0 = now(); for (let k = 0; k < N; k++) for (let i = 0; i < 512; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]); res.magSqrt = +((now() - t0) * 1000 / N).toFixed(2);
t0 = now(); for (let k = 0; k < N; k++) for (let i = 0; i < 512; i++) mag[i] = Math.hypot(re[i], im[i]); res.magHypot = +((now() - t0) * 1000 / N).toFixed(2);
console.log(JSON.stringify(res));
