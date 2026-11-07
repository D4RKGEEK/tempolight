// Synthetic songs with known sections, for learning the song while it plays (repeat.js): a pop verse-chorus song, an
// EDM build-drop-break-build-drop track, a hip hop verse-hook song, and through-composed pieces where no section ever
// comes back (nothing should be predicted there). Deterministic. Each returns {x, sr, name, dur, truth: {bpm, beat,
// bar, sections: [{name, part, t0, t1, bar0, bar1}], drops: [t], changes: [t]}}: changes are the section starts after
// the first; drops the starts of sections whose part is "drop".
import { rng } from "./synth.js";

const hz = m => 440 * Math.pow(2, (m - 69) / 12);
// chords as MIDI root + quality (0 major, 1 minor), voiced in octave 3-4
const triad = (root, minor) => [root, root + (minor ? 3 : 4), root + 7].map(hz);
const PROG = {
  verse: [[57, 1], [53, 0], [48, 0], [55, 0]],   // Am F C G
  chorus: [[53, 0], [55, 0], [52, 1], [57, 1]],  // F G Em Am
  bridge: [[50, 1], [52, 1], [53, 0], [55, 0]],  // Dm Em F G
  hook: [[50, 1], [58, 0], [53, 0], [57, 1]],    // Dm Bb F Am
  edm: [[57, 1], [53, 0], [48, 0], [55, 0]],
};

/**
 * arrange(plan): plan is [[name, bars, spec]], spec: {prog, part, pad, kick: positions in beats, snare, hat, bass,
 * lead: seed of a melody (same seed, same melody), roll: a build-up's snare roll, gain}.
 */
export function arrange(name, bpm, plan, seed = 3, sr = 22050) {
  const beat = 60 / bpm, bar = 4 * beat, bars = plan.reduce((s, p) => s + p[1], 0), n = Math.floor((bars * bar + 1) * sr), x = new Float32Array(n), r = rng(seed);
  const put = (t, fn, dur, g = 1) => { const i0 = Math.floor(t * sr); for (let k = 0; k < dur * sr && i0 + k < n; k++) x[i0 + k] += fn(k / sr) * g; };
  const kick = () => { let ph = 0; return t => { ph = t === 0 ? 0 : ph + 2 * Math.PI * (45 + 90 * Math.exp(-t * 28)) / sr; return Math.sin(ph) * Math.exp(-t * 7); }; };
  const hat = () => { let hp = 0; return t => { const w = r(), y = w - hp; hp = w; return y * 0.3 * Math.exp(-t * 70); }; };
  const snare = g => t => (r() * 0.6 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 18) * g;
  const tone = (f, decay, h2 = 0.4, h3 = 0.2) => t => (Math.sin(2 * Math.PI * f * t) + h2 * Math.sin(4 * Math.PI * f * t) + h3 * Math.sin(6 * Math.PI * f * t)) * Math.exp(-t * decay) * Math.min(1, t / 0.005);
  const truth = { bpm, beat, bar, sections: [], drops: [], changes: [] };
  let b0 = 0;
  for (const [sname, nb, s] of plan) {
    const t0s = b0 * bar; truth.sections.push({ name: sname, part: s.part || "calm", t0: t0s, t1: (b0 + nb) * bar, bar0: b0, bar1: b0 + nb });
    if (b0 > 0) truth.changes.push(t0s); if (s.part === "drop") truth.drops.push(t0s);
    const mr = s.lead != null ? rng(s.lead) : null, g = s.gain ?? 1;
    for (let j = 0; j < nb; j++) {
      const t0 = (b0 + j) * bar, [root, minor] = (s.prog || PROG.verse)[j % (s.prog || PROG.verse).length], ch = triad(root, minor);
      if (s.pad !== false) put(t0, t => ch.reduce((a, f) => a + Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t), 0) * 0.04 * Math.min(1, t / 0.2) * Math.min(1, (bar - t) / 0.05), bar, (s.pad ?? 1) * g);
      for (const p of s.kick || []) put(t0 + p * beat, kick(), 0.4, 0.9 * g);
      for (const p of s.snare || []) put(t0 + p * beat, snare(0.7), 0.2, g);
      for (const p of s.hat || []) put(t0 + p * beat, hat(), 0.06, g);
      if (s.bass) for (let q = 0; q < 4; q++) { let lp = 0; const f = hz(root - 24); put(t0 + q * beat + 0.02, t => { const saw = 2 * ((f * t) % 1) - 1; lp += (saw - lp) * 0.06; return lp * 0.45; }, beat * 0.85, g); }
      if (s.roll) { const k = j / nb, div = k < 0.25 ? 1 : k < 0.5 ? 2 : k < 0.75 ? 4 : 8, steps = j === nb - 1 ? 3 * div : 4 * div;
        for (let q = 0; q < steps; q++) put(t0 + q * beat / div, snare(0.25 + 0.75 * (j + q / (4 * div)) / nb), 0.2, g); }
      if (mr) { // a melody: eighths on chord and scale tones, the same notes every time this section comes (its seed)
        const scale = [0, 2, 3, 5, 7, 8, 10], base = 69;
        for (let q = 0; q < 8; q++) { const rr = mr(); if (rr < -0.6) continue; const d = Math.floor((rr + 1) * 3.5) % 7, f = hz(base + scale[d] + (q % 4 === 0 ? 0 : 12 * (rr > 0.5 ? 1 : 0)));
          put(t0 + q * beat / 2, tone(f, 3), beat * 0.6, 0.11 * (s.leadGain ?? 1) * g); } }
    }
    b0 += nb;
  }
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(x[i])); for (let i = 0; i < n; i++) x[i] = x[i] / m + r() * 0.001;
  return { x, sr, name, dur: n / sr, truth };
}

const E8 = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], OFF = [0.5, 1.5, 2.5, 3.5];

/** Pop, 112 BPM: intro, verse, chorus, verse, chorus, bridge, chorus, outro. */
export function verseChorus(sr = 22050) {
  const V = { prog: PROG.verse, part: "calm", kick: [0, 2], snare: [1, 3], hat: E8, bass: true, lead: 11, leadGain: 0.6, gain: 0.7 };
  const C = { prog: PROG.chorus, part: "drop", kick: [0, 1, 2, 3], snare: [1, 3], hat: E8, bass: true, lead: 23, leadGain: 1.2, pad: 1.6 };
  return arrange("verse-chorus", 112, [["intro", 4, { prog: PROG.verse, pad: 1, hat: OFF, gain: 0.5 }], ["verse", 8, V], ["chorus", 8, C], ["verse", 8, V], ["chorus", 8, C],
    ["bridge", 4, { prog: PROG.bridge, part: "calm", hat: E8, pad: 1.4, lead: 5, gain: 0.6 }], ["chorus", 8, C], ["outro", 4, { prog: PROG.verse, pad: 1, gain: 0.4 }]], 3, sr);
}

/** EDM, 128 BPM: intro 8, build 8, drop 16, break 8, build 8, drop 16, outro 8. */
export function edmTrack(sr = 22050) {
  const I = { prog: PROG.edm, kick: [0, 1, 2, 3], hat: OFF, gain: 0.6 }, B = { prog: PROG.edm, part: "build", hat: OFF, roll: true, pad: 1.2, gain: 0.8 };
  const D = { prog: PROG.edm, part: "drop", kick: [0, 1, 2, 3], snare: [1, 3], hat: OFF, bass: true, lead: 41 };
  return arrange("edm build-drop", 128, [["intro", 8, I], ["build", 8, B], ["drop", 16, D], ["break", 8, { prog: PROG.edm, pad: 1.6, lead: 41, leadGain: 0.5, gain: 0.6 }],
    ["build", 8, B], ["drop", 16, D], ["outro", 8, { ...I, gain: 0.5 }]], 4, sr);
}

/** Hip hop, 90 BPM: intro, verse 16, hook 8, verse 16, hook 8, outro. */
export function hiphop(sr = 22050) {
  const V = { prog: PROG.verse, part: "calm", kick: [0, 0.75, 2.5], snare: [1, 3], hat: E8, bass: true, pad: 0.6, lead: 7, leadGain: 0.4 };
  const H = { prog: PROG.hook, part: "drop", kick: [0, 0.75, 2, 2.5], snare: [1, 3], hat: E8, bass: true, pad: 1.4, lead: 17, leadGain: 1.3 };
  return arrange("hiphop verse-hook", 90, [["intro", 4, { prog: PROG.hook, pad: 1, gain: 0.5 }], ["verse", 16, V], ["hook", 8, H], ["verse", 16, V], ["hook", 8, H], ["outro", 4, { prog: PROG.hook, pad: 1, gain: 0.4 }]], 5, sr);
}

/** Through-composed: every 8 bars new chords, a new melody and a new groove; nothing comes back. */
export function throughComposed(sr = 22050, drums = true) {
  const progs = [[[57, 1], [53, 0], [48, 0], [55, 0]], [[50, 1], [55, 0], [60, 0], [52, 1]], [[62, 0], [59, 1], [55, 0], [57, 0]], [[49, 1], [54, 1], [56, 0], [61, 0]], [[51, 0], [58, 0], [56, 0], [55, 1]], [[60, 1], [56, 0], [63, 0], [58, 0]]];
  const grooves = [{ kick: [0, 2], snare: [1, 3], hat: E8 }, { kick: [0, 1.5, 2.5], snare: [1, 3], hat: OFF }, { kick: [0, 1, 2, 3], snare: [2], hat: E8 }, { kick: [0, 0.75, 2], snare: [1, 3.5], hat: [0, 1, 2, 3] }, { kick: [0, 2.5], snare: [1, 3], hat: E8 }, { kick: [0, 1, 2, 3], snare: [1, 3], hat: OFF }];
  const plan = progs.map((p, i) => [`part ${i + 1}`, 8, { prog: p, lead: 100 + i, ...(drums ? grooves[i] : {}), bass: drums && i % 2 === 0, pad: 0.8 + 0.2 * i, gain: 0.6 + 0.08 * i }]);
  return arrange(drums ? "through-composed" : "through-composed drumless", drums ? 118 : 76, plan, 9, sr);
}

export const REPEAT_SONGS = [verseChorus, edmTrack, hiphop, throughComposed, sr => throughComposed(sr, false)];
