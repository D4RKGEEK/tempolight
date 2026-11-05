// A small deterministic synth that makes test songs with known structure, so analysis can be tested
// without shipping audio files. edm(): 128 BPM, 4 bars intro, 4 bars build-up (snare roll), 8 bars drop, 2 bars outro.
export function rng(seed = 7) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; }

export function edm(sr = 22050, o = {}) {
  const bpm = 128, beat = 60 / bpm, bar = 4 * beat, bars = 18, n = Math.floor((bars * bar + 1) * sr), x = new Float32Array(n), r = rng();
  // o.kickLeft: also a stereo version (l, r) with the kick in the left channel only and everything else in both
  const xk = o.kickLeft ? new Float32Array(n) : null;
  const put = (t, fn, dur, into = x) => { const i0 = Math.floor(t * sr); for (let k = 0; k < dur * sr && i0 + k < n; k++) into[i0 + k] += fn(k / sr); };
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
      put(t0 + q * beat, kick, 0.4, xk || x);
      if (q % 2) put(t0 + q * beat, snare(0.8), 0.2);
      let lp = 0; put(t0 + q * beat + 0.02, t => { const saw = 2 * ((ch[0] / 4 * t) % 1) - 1; lp += (saw - lp) * 0.05; return lp * 0.5; }, beat * 0.9);
    }
  }
  if (xk) { const l = new Float32Array(n), rr = new Float32Array(n); let m = 0; for (let i = 0; i < n; i++) { l[i] = x[i] + xk[i]; rr[i] = x[i]; m = Math.max(m, Math.abs(l[i]), Math.abs(rr[i])); }
    for (let i = 0; i < n; i++) { l[i] /= m; rr[i] /= m; x[i] = (l[i] + rr[i]) / 2; }
    return { x, l, r: rr, sr, bpm, dropStart: 8 * bar, bar, chords: ["Am", "F", "C", "G"] }; }
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i])); for (let i = 0; i < n; i++) x[i] /= m;
  return { x, sr, bpm, dropStart: 8 * bar, bar, chords: ["Am", "F", "C", "G"] }; // (one chord a bar, in this order)
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

/**
 * piece(): a tonal piece in a known key, with a melody that never repeats exactly (a seeded walk on the scale), a
 * bass line and soft chords. Drumless by default (a ballad); drums: true adds kick, snare and hi-hat.
 * minorBallad(): F# minor, 64 BPM, no drums, quiet verse, louder chorus. majorPop(): D major, 116 BPM, drums.
 * @param {{tonic:number, mode:"major"|"minor", bpm:number, bars:number, seed?:number, drums?:boolean, prog?:number[]}} o
 *   tonic: pitch class (C = 0); prog: scale degrees (0-based) of each bar's chord, repeated
 */
export function piece(o, sr = 22050) {
  const { tonic, mode, bpm, bars, seed = 5, drums = false } = o, beat = 60 / bpm, bar = 4 * beat, n = Math.floor((bars * bar + 1) * sr), x = new Float32Array(n), r = rng(seed);
  const scale = mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  const prog = o.prog || (mode === "major" ? [0, 4, 5, 3, 0, 3, 4, 4] : [0, 5, 2, 6, 0, 3, 4, 0]);
  const midi = (deg, oct) => { const d = ((deg % 7) + 7) % 7, o2 = Math.floor(deg / 7); let s = scale[d]; if (mode === "minor" && d === 6 && o.leading) s = 11; return 12 * (oct + o2 + 1) + tonic + s; };
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  const put = (t, fn, dur) => { const i0 = Math.floor(t * sr); for (let k = 0; k < dur * sr && i0 + k < n; k++) x[i0 + k] += fn(k / sr); };
  const tone = (f, decay, g, h2 = 0.35, h3 = 0.12) => t => (Math.sin(2 * Math.PI * f * t) + h2 * Math.sin(4 * Math.PI * f * t) + h3 * Math.sin(6 * Math.PI * f * t)) * Math.exp(-t * decay) * g * Math.min(1, t / 0.005);
  let ph = 0; const kick = t => { ph = t === 0 ? 0 : ph + 2 * Math.PI * (45 + 90 * Math.exp(-t * 28)) / sr; return Math.sin(ph) * Math.exp(-t * 7) * 0.9; };
  let hp = 0; const hat = t => { const w = r(), y = w - hp; hp = w; return y * 0.25 * Math.exp(-t * 70); };
  const snare = t => (r() * 0.5 + Math.sin(2 * Math.PI * 190 * t) * 0.3) * Math.exp(-t * 18);
  let mel = 7 + 2; // melody position on the scale (degrees from the tonic, octave 4)
  for (let b = 0; b < bars; b++) {
    const t0 = b * bar, deg = prog[b % prog.length], sec = Math.floor(b / 8) % 2, g = sec ? 1 : 0.45;
    // chord: root, third, fifth (minor's V chord gets the raised seventh, as in harmonic minor)
    const triad = [deg, deg + 2, deg + 4].map(d => { let m = midi(d, 3); if (mode === "minor" && ((d % 7) + 7) % 7 === 6 && deg === 4) m += 1; return m; });
    for (const m of triad) { const w = 2 * Math.PI * hz(m); put(t0, t => Math.sin(w * t) * 0.035 * g * Math.min(1, t / 0.4) * Math.min(1, (bar - t) / 0.2), bar); }
    put(t0, tone(hz(midi(deg, 2)), 0.8, 0.16 * g), bar); put(t0 + 2 * beat, tone(hz(midi(deg + (r() > 0 ? 4 : 0), 2)), 1, 0.1 * g), 2 * beat);
    const steps = drums ? 8 : 6; // melody: eighths (or triplet-ish for the ballad), chord tones on strong steps
    for (let q = 0; q < steps; q++) {
      const strong = q % (steps / 2) === 0, rr = r();
      if (strong) { const ct = [deg, deg + 2, deg + 4].map(d => d + 7); mel = ct.reduce((a, c) => Math.abs(c - mel) < Math.abs(a - mel) ? c : a, ct[0]); }
      else mel += rr > 0.33 ? 1 : rr < -0.33 ? -1 : (rr > 0 ? 2 : -2);
      mel = Math.max(5, Math.min(16, mel)); if (r() < -0.75 && !strong) continue; // a rest now and then
      put(t0 + q * bar / steps, tone(hz(midi(mel, 4)), 2.2, 0.13 * g), bar / steps * 1.6);
    }
    if (drums) for (let q = 0; q < 4; q++) { put(t0 + q * beat, kick, 0.4); if (q % 2) put(t0 + q * beat, snare, 0.2); put(t0 + q * beat + beat / 2, hat, 0.06); }
  }
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i])); for (let i = 0; i < n; i++) x[i] /= m;
  return { x, sr, bpm, key: ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"][tonic], mode };
}
export const minorBallad = (sr = 22050, seed = 5) => piece({ tonic: 6, mode: "minor", bpm: 64, bars: 20, seed }, sr);
export const majorPop = (sr = 22050, seed = 9) => piece({ tonic: 2, mode: "major", bpm: 116, bars: 24, seed, drums: true }, sr);
