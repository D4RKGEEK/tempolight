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

/** ballad(): 70 BPM, piano-like notes and a soft pad, no drums; a quiet verse then a louder chorus. */
export function ballad(sr = 22050) {
  const bpm = 70, beat = 60 / bpm, bars = 12, n = Math.floor((bars * 4 * beat + 1) * sr), x = new Float32Array(n), r = rng(3);
  const put = (t, fn, dur) => { const i0 = Math.floor(t * sr); for (let k = 0; k < dur * sr && i0 + k < n; k++) x[i0 + k] += fn(k / sr); };
  const chords = [[220, 277.2, 329.6], [185, 220, 277.2], [146.8, 185, 220], [164.8, 207.7, 246.9]];
  for (let b = 0; b < bars; b++) {
    const t0 = b * 4 * beat, ch = chords[b % 4], g = b < 6 ? 0.35 : 1;
    put(t0, t => ch.reduce((s, f) => s + Math.sin(2 * Math.PI * f / 2 * t), 0) * 0.04 * g * Math.min(1, t / 0.8), 4 * beat);
    for (let q = 0; q < 8; q++) { const f = ch[(q + (r() > 0 ? 1 : 0)) % 3] * (q % 4 === 3 ? 2 : 1);
      put(t0 + q * beat / 2, t => (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * Math.exp(-t * 2.5) * 0.12 * g, beat * 1.5); }
  }
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i])); for (let i = 0; i < n; i++) x[i] /= m;
  return { x, sr, bpm };
}

/** voice(): a sung vowel ("ah") with a wandering melody and vibrato: harmonics shaped by formants at 700, 1,200 and 2,600 Hz. */
export function voice(sr = 22050, seconds = 8, gain = 1) {
  const n = Math.floor(seconds * sr), x = new Float32Array(n), notes = [220, 247, 262, 247, 196, 220, 294, 262], r = rng(11); let ph = 0;
  const formant = f => [[700, 130, 1], [1200, 160, 0.5], [2600, 200, 0.25]].reduce((s, [c, bw, a]) => s + a / (1 + ((f - c) / bw) ** 2), 0);
  for (let i = 0; i < n; i++) { const t = i / sr, k = Math.min(notes.length - 1, Math.floor(t / (seconds / notes.length))), f0 = notes[k] * (1 + 0.025 * Math.sin(2 * Math.PI * 5.5 * t));
    ph += 2 * Math.PI * f0 / sr; let v = 0; for (let h = 1; h * f0 < 4000; h++) v += Math.sin(h * ph) * formant(h * f0) / h ** 0.3;
    x[i] = (v * 0.15 + r() * 0.004) * gain * Math.min(1, t * 4); }
  return { x, sr };
}
/** pad(): a steady synth chord, the same notes for the whole time. */
export function pad(sr = 22050, seconds = 8) {
  const n = Math.floor(seconds * sr), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; x[i] = [220, 277.2, 329.6].reduce((s, f) => s + Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t), 0) * 0.12 * Math.min(1, t * 2); }
  return { x, sr };
}
/** pluck(): a guitar-like plucked melody with finger vibrato: each note starts hard and fades, harmonics fading faster. */
export function pluck(sr = 22050, seconds = 8) {
  const n = Math.floor(seconds * sr), x = new Float32Array(n), notes = [440, 494, 523, 494, 392, 440, 587, 523], len = seconds / notes.length; let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / sr, k = Math.min(notes.length - 1, Math.floor(t / len)), nt = t - k * len, f0 = notes[k] * (1 + 0.02 * Math.sin(2 * Math.PI * 5.5 * t));
    ph += f0 / sr; let v = 0; for (let h = 1; h < 12; h++) v += Math.sin(2 * Math.PI * h * ph) / h * Math.exp(-nt * (1 + h * 0.6)); x[i] = v * 0.2; }
  return { x, sr };
}
