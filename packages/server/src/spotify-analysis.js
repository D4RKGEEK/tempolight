// Spotify's audio analysis (GET /v1/audio-analysis/{id}) to Tempolight's beat map, the same shape preAnalyseCore()
// gives, so song memory, the show planner and songView() use it like any analysed song.
//
// Spotify stopped giving this to apps created after 27 November 2024 (they get 403); older apps may still have it.
// What it has: beats, bars, tatums (with confidences), sections (loudness, tempo, key), and segments (short sounds with
// their loudness curve, 12 pitch strengths and 12 timbre values). What it lacks: which hits are drums. So:
//   - the beat grid is a least-squares fit through Spotify's beats, and the bars set beat 1;
//   - kicks are beats where a segment starts with a hard attack (loudness rising >= 5 dB) and a dark, bass-heavy timbre;
//     snares are hard, bright attacks on beats 2 and 4; hi-hats are softer bright segments between the beats;
//   - loudness (20 ms steps) follows each segment's loudness_start -> loudness_max -> next segment;
//   - song parts: a bar is a drop when it is among the loudest, its section is clearly louder than the quiet ones and it
//     has kicks; the 2, 4 or 8 bars before a drop whose loudness rises are its build-up (as analysis.js does);
//   - key and mode from the track, chroma (for song memory) from the segments' pitches, mood from those and the drums.
// No I/O and no Node modules.
import { packChroma, moodOf } from "../../engine/src/index.js";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (arr, p) => { const s = Array.from(arr).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const median = a => pct(a, 0.5);

/** Is this an audio-analysis answer we can use? */
export function isAnalysis(j) { return !!(j && j.track && Array.isArray(j.beats) && j.beats.length >= 8 && Array.isArray(j.segments) && j.segments.length >= 8); }

/**
 * @param {object} j the JSON of GET /v1/audio-analysis/{id}
 * @param {number} [durHint] the track's length (s) if the analysis doesn't say
 * @returns the beat map (preAnalyseCore()'s shape) with `src: "spotify-analysis"`, or null if `j` isn't usable
 */
export function analysisToPre(j, durHint = 0) {
  if (!isAnalysis(j)) return null;
  const dur = num(j.track.duration) || durHint || (j.segments.at(-1).start + j.segments.at(-1).duration);
  const beatsT = j.beats.map(b => num(b.start)).filter(t => t != null && t >= 0 && t <= dur).sort((a, b) => a - b);
  // ---- grid: least squares through the beats (each numbered from the median beat length)
  const d = []; for (let i = 1; i < beatsT.length; i++) d.push(beatsT[i] - beatsT[i - 1]);
  let P = median(d.filter(x => x > 0.2 && x < 2)) || 60 / (num(j.track.tempo) || 120);
  let off = beatsT[0];
  for (let pass = 0; pass < 2; pass++) { // number the beats from the current grid, then fit; twice so a skipped beat can't bend it
    let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
    for (const t of beatsT) { const k = Math.round((t - off) / P), r = t - (off + k * P); if (Math.abs(r) > P * 0.25) continue; sx += k; sy += t; sxx += k * k; sxy += k * t; m++; }
    const den = m * sxx - sx * sx; if (m >= 8 && den > 0) { P = (m * sxy - sx * sy) / den; off = (sy - P * sx) / m; }
  }
  // beat 1: the bars' starts, as beat numbers
  const barStarts = (j.bars || []).map(b => num(b.start)).filter(t => t != null);
  const bib = [0, 0, 0, 0]; for (const t of barStarts) { const k = Math.round((t - off) / P); if (Math.abs(t - (off + k * P)) < P * 0.3) bib[((k % 4) + 4) % 4]++; }
  let barOff = bib.indexOf(Math.max(...bib));
  let bpm = 60 / P;
  if (bpm > 150) { // light shows read very fast tempos better at half time (as analysis.js): keep the beats that start bars
    const half = ((barOff % 2) + 2) % 2; off += half * P; P *= 2; bpm /= 2; barOff = ((barOff - half) / 2 % 4 + 4) % 4; // beats 0, 2 of the old bar are beats 0, 1 now
  }
  { const k = Math.floor(off / P); off -= k * P; barOff = (((barOff + k) % 4) + 4) % 4; } // the first beat at or after 0
  // ---- loudness, 20 ms steps
  const segs = j.segments.filter(s => num(s.start) != null && num(s.duration) != null).sort((a, b) => a.start - b.start);
  const N = Math.ceil(dur / 0.02), dB = new Float32Array(N).fill(-60);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], a = s.start, pk = a + Math.max(0, num(s.loudness_max_time) ?? 0), e = a + s.duration;
    const l0 = num(s.loudness_start) ?? -60, l1 = num(s.loudness_max) ?? l0, l2 = num(segs[i + 1]?.loudness_start) ?? num(s.loudness_end) ?? l0;
    for (let f = Math.max(0, Math.floor(a / 0.02)); f < Math.min(N, Math.ceil(e / 0.02)); f++) { const t = f * 0.02;
      dB[f] = t <= pk ? l0 + (l1 - l0) * (pk > a ? (t - a) / (pk - a) : 1) : l1 + (l2 - l1) * ((t - pk) / Math.max(1e-3, e - pk)); }
  }
  const amp = Float32Array.from(dB, v => Math.pow(10, Math.max(-60, Math.min(6, v)) / 20)), ref = pct(amp, 0.95) || 1;
  const env = Float32Array.from(amp, v => v / ref);
  // ---- drums from the segments
  const t1s = segs.map(s => (s.timbre && num(s.timbre[1])) ?? 0), brightMid = median(t1s);
  const loudTop = pct(segs.map(s => num(s.loudness_max) ?? -60), 0.9);
  const kicks = [], snares = [], hats = [];
  const nearBeat = t => { const k = Math.round((t - off) / P); return { k, r: Math.abs(t - (off + k * P)) }; };
  const bibOf = k => (((k - barOff) % 4) + 4) % 4;
  for (const s of segs) {
    const attack = (num(s.loudness_max) ?? -60) - (num(s.loudness_start) ?? -60), lm = num(s.loudness_max) ?? -60, br = (s.timbre && num(s.timbre[1])) ?? 0, t = s.start;
    const { k, r } = nearBeat(t), onBeat = r < 0.06, halfBeat = Math.abs(r - P / 2) < 0.06 || (!onBeat && r > P * 0.2);
    if (onBeat && attack >= 5 && lm > loudTop - 14 && br <= brightMid) kicks.push(t);
    else if (onBeat && attack >= 5 && br > brightMid && lm > loudTop - 14 && bibOf(k) % 2 === 1) snares.push(t);
    else if (halfBeat && br > brightMid && attack >= 2) hats.push(t);
  }
  // ---- bars and song parts
  const bars0 = (j.bars || []).filter(b => num(b.start) != null && num(b.duration) != null && b.duration > 0.2).map(b => ({ t0: b.start, t1: b.start + b.duration }));
  const meanEnv = (a, b) => { let s = 0, c = 0; for (let f = Math.max(0, Math.floor(a / 0.02)); f < Math.min(N, Math.ceil(b / 0.02)); f++) { s += env[f]; c++; } return c ? s / c : 0; };
  const count = (arr, a, b) => arr.filter(t => t >= a && t < b).length;
  for (const b of bars0) { b.rm = meanEnv(b.t0, b.t1); b.kicks = count(kicks, b.t0, b.t1); b.snares = count(snares, b.t0, b.t1); b.hats = count(hats, b.t0, b.t1); }
  const lo = pct(bars0.map(b => b.rm), 0.1), hi = pct(bars0.map(b => b.rm), 0.9);
  for (const b of bars0) b.rmN = Math.max(0, Math.min(1.2, (b.rm - lo) / ((hi - lo) || 1)));
  const sections = (j.sections || []).filter(s => num(s.start) != null).map(s => ({ t0: s.start, t1: s.start + (num(s.duration) || 0), loud: num(s.loudness) ?? -60 }));
  const secLoud = t => (sections.find(s => t >= s.t0 && t < s.t1) || { loud: null }).loud;
  const quiet = pct(sections.map(s => s.loud), 0.25);
  for (const b of bars0) { const sl = secLoud(b.t0 + 0.01);
    b.state = b.rm < 0.05 ? "silent" : b.rmN > 0.55 && b.kicks >= 3 && (sl == null || sections.length < 2 || sl >= quiet + 2) ? "drop" : "calm"; }
  for (let i = 1; i < bars0.length - 1; i++) if (bars0[i - 1].state === bars0[i + 1].state && bars0[i].state !== bars0[i - 1].state && bars0[i].state !== "silent") bars0[i].state = bars0[i - 1].state;
  for (let s = 1; s < bars0.length; s++) {
    if (bars0[s].state !== "drop" || bars0[s - 1].state === "drop") continue;
    const T = i => bars0[i].rmN + bars0[i].snares * 0.15 + bars0[i].hats * 0.05;
    let start = Math.max(0, s - 2), best = -1e9;
    for (const L of [2, 4, 8]) { if (s - L < 0) continue; let inside = 0, before = 0, nb = 0, blocked = false;
      for (let i = s - L; i < s; i++) { if (bars0[i].state === "drop") blocked = true; inside += T(i); }
      for (let i = s - 2 * L; i < s - L; i++) if (i >= 0) { before += T(i); nb++; }
      if (blocked) continue; const sc = (inside / L - (nb ? before / nb : 0)) * Math.sqrt(L); if (sc > best) { best = sc; start = s - L; } }
    for (let i = start; i < s; i++) if (bars0[i].state !== "drop" && bars0[i].state !== "silent") bars0[i].state = "build";
  }
  const drops = []; bars0.forEach((b, i) => { if (b.state === "drop" && (i === 0 || bars0[i - 1].state !== "drop")) drops.push(b.t0); });
  // ---- chroma (10 frames a second, as tonal.js makes them) from the segments' pitches, weighted by loudness
  const frames = new Float32Array(Math.floor(dur * 10) * 12); let si = 0;
  for (let f = 0; f < frames.length / 12; f++) { const t = f / 10 + 0.05; while (si + 1 < segs.length && segs[si + 1].start <= t) si++;
    const s = segs[si]; if (!s || !Array.isArray(s.pitches) || s.pitches.length !== 12) continue; const w = Math.pow(10, ((num(s.loudness_max) ?? -60) + 10) / 20);
    for (let k = 0; k < 12; k++) frames[f * 12 + k] = Math.max(0, num(s.pitches[k]) ?? 0) * w; }
  // ---- key, mood, style
  const key = num(j.track.key), mode = num(j.track.mode), keyConfidence = Math.round((num(j.track.key_confidence) ?? 0) * 100) / 100;
  const nBeats = Math.max(1, Math.floor((dur - off) / P)); let onBeat = 0;
  for (let k = 0; k < nBeats; k++) { const bt = off + k * P; if (kicks.some(t => Math.abs(t - bt) < 0.08)) onBeat++; }
  const kickFrac = onBeat / nBeats, hatRate = hats.length / dur, snareRate = snares.length / dur, onsetRate = (kicks.length + snares.length) / dur;
  const lv = Array.from(env).filter(v => v > 0.02), dyn = lv.length ? pct(lv, 0.9) / (pct(lv, 0.25) || 1e-6) : 1;
  const percussive = hatRate > 2 || snareRate > 3.2 || kickFrac > 0.4;
  const style = !percussive ? (dyn > 2.5 ? "emotional" : "chill") : drops.length && kickFrac > 0.25 && bpm >= 110 ? "party" : bpm < 102 ? "hiphop" : "poprock";
  const bright = Math.max(0, Math.min(1, 0.5 + (brightMid - 0) / 200));
  const mood = moodOf({ majorness: mode === 1 ? 0.7 : mode === 0 ? -0.7 : 0, confidence: keyConfidence, bright, onsetRate, bpm, hatRate, kickFrac });
  return {
    src: "spotify-analysis", bpm, P, off, barOff, dur, kicks, snares, hats, drops, env, style,
    bars: bars0.map(b => ({ t0: b.t0, t1: b.t1, state: b.state, level: Math.min(1, b.rmN) })),
    key: key != null && key >= 0 && key < 12 ? NAMES[key] : null, mode: mode === 1 ? "major" : mode === 0 ? "minor" : null, keyConfidence, mood, chroma: packChroma(frames),
    features: { kickFrac, dyn, onsetRate, hatRate, snareRate, bright },
  };
}
