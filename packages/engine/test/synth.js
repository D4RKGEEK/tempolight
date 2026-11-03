// A small deterministic synth that makes test songs with known structure, so analysis can be tested
// without shipping audio files. edm(): 128 BPM, 4 bars intro, 4 bars build-up (snare roll), 8 bars drop, 2 bars outro.
export function rng(seed = 7) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; }

export function edm(sr = 22050) {
  const bpm = 128, beat = 60 / bpm, bar = 4 * beat, bars = 18, n = Math.floor((bars * bar + 1) * sr), x = new Float32Array(n), r = rng();
  const put = (t, fn, dur) => { const i0 = Math.floor(t * sr); for (let k = 0; k < dur * sr && i0 + k < n; k++) x[i0 + k] += fn(k / sr); };
  let ph = 0;
  const kick = t => { ph = t === 0 ? 0 : ph + 2 * Math.PI * (45 + 90 * Math.exp(-t * 28)) / sr; return Math.sin(ph) * Math.exp(-t * 7); };
  let hp = 0; const hat = t => { const w = r(), y = w - hp; hp = w; return y * 0.35 * Math.exp(-t * 70); };
  const snare = g => t => (r() * 0.6 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 18) * g;
  const chords = [[220, 261.6, 329.6], [174.6, 220, 261.6], [130.8, 164.8, 196], [196, 246.9, 293.7]];
  for (let b = 0; b < bars; b++) {
    const t0 = b * bar, part = b < 4 ? "intro" : b < 8 ? "build" : b < 16 ? "drop" : "outro", ch = chords[b % 4];
    put(t0, t => ch.reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) * 0.05 * Math.min(1, t / 0.3), bar);
    for (let q = 0; q < 4; q++) put(t0 + q * beat + beat / 2, hat, 0.06);
    if (part === "build") { const div = [1, 2, 4, 8][b - 4], steps = b === 7 ? 3 * div : 4 * div;
      for (let s = 0; s < steps; s++) put(t0 + s * beat / div, snare(0.3 + 0.7 * ((b - 4) * 4 + s / div) / 16), 0.2); }
    if (part === "drop") for (let q = 0; q < 4; q++) {
      put(t0 + q * beat, kick, 0.4);
      if (q % 2) put(t0 + q * beat, snare(0.8), 0.2);
      let lp = 0; put(t0 + q * beat + 0.02, t => { const saw = 2 * ((ch[0] / 4 * t) % 1) - 1; lp += (saw - lp) * 0.05; return lp * 0.5; }, beat * 0.9);
    }
  }
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i])); for (let i = 0; i < n; i++) x[i] /= m;
  return { x, sr, bpm, dropStart: 8 * bar, bar };
}
