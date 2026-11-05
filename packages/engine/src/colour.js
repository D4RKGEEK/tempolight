// Chord colours: within the palette that is showing (the mood's colours, the song's look, an automatic palette), the
// colours step with the song's chords. Each chord has a stable place: its root on the circle of fifths from the key's
// tonic turns the palette round the colour wheel (15° a fifth), odd steps swap its two colours (so neighbouring chords
// differ clearly), and minor chords are a little darker and cooler. A step happens on the bar line (at most one a
// bar) and eases in over about a beat; the same chords give the same colours, so a repeated section looks the same.
// Pure JavaScript, no I/O.
import { NAMES } from "./tonal.js";

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

/** Where a chord's root sits from the key's tonic on the circle of fifths: -5..6 (0 the tonic, 1 a fifth up, -1 a fourth). */
export function fifthsFrom(root, tonic) { const f = ((((root - tonic) * 7) % 12) + 12) % 12; return f > 6 ? f - 12 : f; }

function hueTurn(deg) { // CSS hue-rotate as a 3x3 matrix
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [.213 + c * .787 - s * .213, .715 - c * .715 - s * .715, .072 - c * .072 + s * .928, .213 - c * .213 + s * .143, .715 + c * .285 + s * .140, .072 - c * .072 - s * .283, .213 - c * .213 - s * .787, .715 - c * .715 + s * .715, .072 + c * .928 + s * .072];
}

/**
 * The palette for a chord, from a two-colour palette.
 * @param {number[][]} base [[r,g,b],[r,g,b]] 0..1 @param {number} chord 0..23 (tonal.js CHORDS) @param {number} [tonic] the key's tonic (C = 0)
 * @returns {number[][]}
 */
export function chordPalette(base, chord, tonic = 0) {
  const root = chord >> 1, minor = chord & 1, f = fifthsFrom(root, tonic), M = hueTurn(15 * f);
  let v = base.map(([r, g, b]) => [M[0] * r + M[1] * g + M[2] * b, M[3] * r + M[4] * g + M[5] * b, M[6] * r + M[7] * g + M[8] * b].map(x => clamp(x)));
  if (f & 1) v = [v[1], v[0]];
  if (minor) v = v.map(([r, g, b]) => { const m = Math.max(r, g, b); return [r * 0.8, g * 0.88, clamp(b * 0.95 + 0.06 * m)]; });
  return v;
}

/** The tonic of a key name ("A", "F#"...), or null. */
export const tonicOf = key => { const i = key ? NAMES.indexOf(key) : -1; return i >= 0 ? i : null; };

/** A colour-step key for the part of the song: repeated sections (the same label) get the same one; null without sections. */
export function sectionKey(V) { const s = V && V.section; if (!s || !s.label) return null; return Math.max(0, s.label.charCodeAt(0) - 65 + (s.label.length > 1 ? 26 : 0)); }

/**
 * The director's chord colours. update() every frame, with the palette it would show; it returns the palette to show
 * instead, or null (chord colours off, or no chord known: today's colours).
 */
export function createChordColours() {
  const st = { chord: null, ref: null, bar: null, stepBar: null, lastChordBar: null, cur: null, wall: null, steps: 0, stepT: -9 };
  const barOf = (V, t) => { if (V.barI != null && V.barI >= 0) return V.barI; const g = V.g; if (g && g.has) return Math.floor((g.idx - g.beatInBar) / 4); return Math.floor(t / 2); };
  function release(base, k) {
    st.chord = null; st.stepBar = null; if (!st.cur) return null;
    let d = 0; for (let c = 0; c < 2; c++) for (let i = 0; i < 3; i++) { st.cur[c][i] += (base[c][i] - st.cur[c][i]) * k; d = Math.max(d, Math.abs(base[c][i] - st.cur[c][i])); }
    if (d < 0.01) { st.cur = null; return null; } return st.cur;
  }
  /**
   * @param {object|null} V the music now (V.chord: 0..23 or null; V.barI or V.g for the bar; V.key for the tonic)
   * @param {number} t music clock @param {number} wall steady clock @param {number[][]} base the palette showing @param {boolean} on
   */
  function update(V, t, wall, base, on) {
    const dt = clamp(wall - (st.wall ?? wall), 0, 0.5); st.wall = wall;
    const P = (V && V.g && V.g.has && V.g.P) || 0.5, k = 1 - Math.exp(-dt / Math.max(0.08, P / 3)); // ~95% of the way in a beat
    if (!on || !V || V.state === "silent" && (V.quietFor ?? 0) > 4) { st.ref = on && V ? st.ref : null; st.lastChordBar = null; return release(base, k); }
    const bar = barOf(V, t), c = typeof V.chord === "number" && V.chord >= 0 && V.chord < 24 ? V.chord : null;
    if (st.bar != null && bar < st.bar) { st.stepBar = null; st.lastChordBar = null; } // the clock went back (a seek)
    st.bar = bar;
    if (c != null) {
      st.lastChordBar = bar;
      // one step a bar at most, and only for a chord that differs from the one showing
      if (c !== st.chord && st.stepBar !== bar) {
        const kt = tonicOf(V.key); st.ref = kt != null ? kt : st.ref ?? (c >> 1); // the key's tonic, or the first chord heard
        st.chord = c; st.stepBar = bar; st.steps++; st.stepT = t; }
    } else if (st.chord != null && (st.lastChordBar == null || bar - st.lastChordBar > 2)) return release(base, k); // no chord for 2 bars: today's colours
    if (st.chord == null) return release(base, k);
    const target = chordPalette(base, st.chord, st.ref ?? 0);
    if (!st.cur) st.cur = base.map(x => x.slice());
    for (let ci = 0; ci < 2; ci++) for (let i = 0; i < 3; i++) st.cur[ci][i] += (target[ci][i] - st.cur[ci][i]) * k;
    return st.cur;
  }
  function reset() { st.chord = null; st.ref = null; st.bar = null; st.stepBar = null; st.lastChordBar = null; st.cur = null; }
  return { update, reset, state: st };
}
