// Whole-song analysis. Pure JavaScript, no dependencies; runs in Node and in the browser.
import { songChroma, packChroma, keyOf, moodOf, barChords, tonicHint } from "./tonal.js";
import { realFFT } from "./fft.js";
import { sectionsOf, barFeature } from "./structure.js";
export function lastLE(arr, t) { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const r2 = v => Math.round(v * 100) / 100;
/**
 * Analyse a whole song once: onsets (kick, snare, hi-hat), tempo, beat grid, bars, song parts (calm, build, drop,
 * silent), a loudness envelope, a music style, the key and the mood (and a compact chroma fingerprint for song memory);
 * per bar its energy, danceability, chord and whether someone sings; sections with repeat labels, and the phrase grid.
 * @param {Float32Array} x mono samples (about 22 kHz is enough)
 * @param {number} sr sample rate of x
 * @param {(p:number)=>void} [onProgress] called with 0..1
 */
export async function preAnalyseCore(x, sr, onProgress) {
  const NF = 1024, HOP = 256, nFrames = Math.max(0, Math.floor((x.length - NF) / HOP));
  const dtF = HOP / sr, binHz = sr / NF, half = NF / 2, fft = realFFT(NF);
  const win = new Float32Array(NF); for (let i = 0; i < NF; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF);
  const buf = new Float32Array(NF), mag = new Float32Array(half), prev = new Float32Array(half);
  const bin = f => Math.max(1, Math.min(half - 1, Math.round(f / binHz)));
  const B = { k: [bin(40), bin(130)], low: [bin(40), bin(150)], mid: [bin(300), bin(2000)], high: [bin(4000), Math.min(half - 1, bin(11000))],
              s1: [bin(180), bin(320)], s2: [bin(1800), bin(5000)], h: [bin(7000), Math.min(half - 1, bin(11000))] };
  const F = { low: new Float32Array(nFrames), mid: new Float32Array(nFrames), high: new Float32Array(nFrames), rms: new Float32Array(nFrames),
              fk: new Float32Array(nFrames), fs: new Float32Array(nFrames), fh: new Float32Array(nFrames), voc: new Float32Array(nFrames) };
  const mean = (a, b) => { let s = 0; for (let i = a; i <= b; i++) s += mag[i]; return s / (b - a + 1); };
  const flux = (a, b) => { let s = 0; for (let i = a; i <= b; i++) { const d = mag[i] - prev[i]; if (d > 0) s += d; } return s; };
  const voc = vocalTracker(mag, binHz, NF, 2 * dtF);
  for (let f = 0; f < nFrames; f++) {
    const o = f * HOP; let e = 0;
    for (let i = 0; i < NF; i++) { const v = x[o + i]; buf[i] = v * win[i]; e += v * v; }
    fft.mag(buf, mag);
    F.rms[f] = Math.sqrt(e / NF); F.low[f] = mean(...B.low); F.mid[f] = mean(...B.mid); F.high[f] = mean(...B.high);
    F.fk[f] = flux(...B.k); F.fs[f] = flux(...B.s1) * 0.6 + flux(...B.s2) * 0.4; F.fh[f] = flux(...B.h);
    if (f & 1) F.voc[f] = F.voc[f - 1] = voc(F.rms[f] > 0.0015); // the singing estimate, as live listening's low-power mode makes it (every 2nd hop)
    prev.set(mag);
    if (f % 600 === 0) { onProgress && onProgress(f / nFrames * 0.85); await new Promise(r => setTimeout(r, 0)); }
  }
  const tOf = f => (f * HOP + NF * 0.5) / sr;
  const frameOf = t => Math.max(0, Math.min(nFrames - 1, Math.round((t * sr - NF * 0.5) / HOP)));
  const pct = (arr, p) => { const s = Array.from(arr).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
  // peak picking with a local adaptive threshold
  function pick(fl, minGap, k, strength) {
    const W = Math.round(0.35 / dtF), out = []; let last = -1e9;
    const cs = new Float64Array(fl.length + 1); for (let i = 0; i < fl.length; i++) cs[i + 1] = cs[i] + fl[i];
    const peaks = [];
    for (let i = 1; i < fl.length - 1; i++) {
      const a = Math.max(0, i - W), b = Math.min(fl.length, i + W + 1), m = (cs[b] - cs[a]) / (b - a);
      if (fl[i] > m * k && fl[i] >= fl[i - 1] && fl[i] > fl[i + 1]) peaks.push(i);
    }
    const ref = pct(peaks.map(i => fl[i]), 0.9);
    for (const i of peaks) { if (fl[i] < ref * strength) continue; const t = tOf(i); if (t - last >= minGap) { out.push(t); last = t; } }
    return out;
  }
  // kicks: low-band transients that also carry real low energy
  const lowRef = pct(F.low, 0.9), rms90 = pct(F.rms, 0.9), rms50 = pct(F.rms, 0.5);
  const kicksRaw = pick(F.fk, 0.2, 1.6, 0.3);
  const kickFrame = t => Math.min(nFrames - 1, Math.round((t * sr - NF * 0.5) / HOP) + 2);
  const kicks = kicksRaw.filter(t => F.low[kickFrame(t)] > lowRef * 0.35);
  const snares = pick(F.fs, 0.1, 1.5, 0.3), hats = pick(F.fh, 0.06, 1.4, 0.2);
  // how hard each kick hits: its low-band flux (the strongest frame of the hit) against the song's strong kicks
  const kFlux = kicks.map(t => { const f = frameOf(t); let m = 0; for (let j = Math.max(0, f - 1); j <= Math.min(nFrames - 1, f + 2); j++) m = Math.max(m, F.fk[j]); return m; });
  const kRef = pct(kFlux, 0.9) || 1, kickStrength = kFlux.map(v => r2(clamp(v / kRef)));
  onProgress && onProgress(0.88);
  // the notes, 10 times a second (key, chords, downbeats, sections and the song-memory fingerprint)
  const ch = await songChroma(x, sr); onProgress && onProgress(0.95);

  // ---- tempo
  // from kicks and snares together (backbeat genres need the snare), searched over 60-180 BPM
  const src = kicks.concat(snares).sort((a, b) => a - b);
  const hist = new Float32Array(241);
  for (let i = 0; i < src.length; i++) for (let j = i + 1; j < src.length && src[j] - src[i] < 4; j++) {
    const d = src[j] - src[i]; if (d < 0.28) continue;
    for (let m = 1; m <= 4; m++) { const p = d / m; if (p < 0.333 || p > 1.0) continue; const bpm = 60 / p, c = Math.round((bpm - 60) * 2);
      for (let k = Math.max(0, c - 4); k <= Math.min(240, c + 4); k++) hist[k] += Math.exp(-((((60 + k / 2) - bpm) / 0.7) ** 2)) / m; }
  }
  let best = 0, bi = 120; for (let k = 0; k <= 240; k++) { const v = hist[k] * Math.exp(-((((60 + k / 2) - 112) / 55) ** 2)); if (v > best) { best = v; bi = k; } }
  // octave check: the right tempo has onsets locked in phase AND on most beats (so 64 vs 128, 70 vs 140 resolve)
  const base = 60 + bi / 2, cands = [base, base * 2, base / 2, base * 1.5, base / 1.5, base * 4 / 3, base * 0.75].filter(b => b >= 58 && b <= 185);
  const coherence = (ts, bpmC) => { const Pc = 60 / bpmC; let sx = 0, sy = 0; for (const t of ts) { const a2 = 2 * Math.PI * t / Pc; sx += Math.cos(a2); sy += Math.sin(a2); }
    return { r: Math.hypot(sx, sy) / Math.max(1, ts.length), off: ((Math.atan2(sy, sx) / (2 * Math.PI) + 1) % 1) * Pc }; };
  function tryTempo(c0) {
    let fitB = c0, fitOff = 0, fitR = -1;
    for (let k = -20; k <= 20; k++) { const cand = c0 + k * 0.05, c = coherence(src, cand); if (c.r > fitR) { fitR = c.r; fitB = cand; fitOff = c.off; } }
    const Pc = 60 / fitB; let hit = 0, tot = 0; const t0 = src[0] || 0, t1 = src[src.length - 1] || 0;
    for (let bt = fitOff + Math.ceil((t0 - fitOff) / Pc) * Pc; bt <= t1; bt += Pc) { tot++; const i = lastLE(src, bt + 0.07); if (i >= 0 && src[i] > bt - 0.07) hit++; }
    const cover = tot ? hit / tot : 0;
    return { bpm: fitB, off: fitOff, score: fitR * Math.sqrt(cover) * Math.exp(-(((fitB - 112) / 80) ** 2)) };
  }
  const tried = cands.map(tryTempo); let pickT = tried.reduce((a, b) => b.score > a.score ? b : a, { score: -1, bpm: base, off: 0 });
  // a slow reading of a song with long stretches without drums (an EDM intro and break, or a ballad's verse) scores
  // too well: on a half-time grid there are fewer beats to miss. Below 90 BPM the double-time reading wins when it
  // scores at least 0.6 of the best (a real 70 BPM groove keeps its backbeat on the slow grid and scores far below that)
  if (pickT.bpm < 90) { const dbl = tried.find(c => Math.abs(c.bpm - 2 * pickT.bpm) < 2) || tryTempo(2 * pickT.bpm); if (dbl.score >= 0.6 * pickT.score) pickT = dbl; }
  let bpm = pickT.bpm, off = pickT.off;
  // the grid, fitted to the drums (the kicks when there are enough of them: off-beat hi-hats cannot pull beat 1 half a
  // beat late): a least-squares line through the hits that fall near grid lines, fitted first over the first 8 s with
  // drums, then over a stretch that grows until it covers the song. Each step's grid is precise enough to number the
  // beats across the next stretch, even over a drumless break, so a 4-minute song drifts by a millisecond at most
  // instead of tens (a search over tempos would find several near-equal fits when the drums come in separate parts)
  const ref = kicks.length >= 16 ? kicks : src;
  if (ref.length >= 8) {
    let P = 60 / bpm, a = 0; while (a + 7 < ref.length && ref[a + 7] - ref[a] > 8) a++;
    const tA = ref[a]; let span = 8, ok = false;
    { const w = ref.filter(t => t >= tA && t < tA + span), c = coherence(w, bpm); off = c.off; }
    for (let it = 0; it < 40; it++) {
      const tEnd = tA + span, all = tEnd >= ref[ref.length - 1] && tA <= ref[0];
      for (const tol of all ? [0.06, 0.04, 0.03] : [0.07]) {
        let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
        for (const t of ref) { if (t < tA - span || t > tEnd) continue; const k = Math.round((t - off) / P); if (Math.abs(t - (off + k * P)) > tol) continue; sx += k; sy += t; sxx += k * k; sxy += k * t; n++; }
        const d = n * sxx - sx * sx; if (n < 8 || !(d > 0)) break;
        const P2 = (n * sxy - sx * sy) / d; if (!(Math.abs(P2 / P - 1) < 0.01)) break;
        P = P2; off = (sy - P * sx) / n; ok = true;
      }
      if (all) break; span *= 1.6;
    }
    if (ok) { bpm = 60 / P; off = ((off % P) + P) % P; if (off > P - 0.02) off = Math.max(0, off - P); } // (a grid starting a hair before 0 starts at 0)
  }
  if (bpm > 150) bpm /= 2;   // light shows read very fast tempos better at half time
  const P = 60 / bpm, dur = x.length / sr;

  // ---- per-beat features
  const nBeats = Math.max(0, Math.floor((dur - off) / P));
  const nCh = ch.n, chAt = t => Math.max(0, Math.min(nCh - 1, Math.round(t * 10) - 1)); // the chroma frame whose window ends nearest t
  const beat = []; for (let k = 0; k < nBeats; k++) {
    const a = frameOf(off + k * P), b = Math.max(a + 1, frameOf(off + (k + 1) * P)); let lo = 0, rm = 0, hi = 0, md = 0;
    for (let f = a; f < b; f++) { lo += F.low[f]; rm += F.rms[f]; hi += F.high[f]; md += F.mid[f]; } const n = b - a;
    const c = new Float32Array(12), c0 = chAt(off + k * P + 0.15), c1 = Math.max(c0, chAt(off + (k + 1) * P)); // (from where this beat's notes fill the window)
    for (let j = c0; j <= c1; j++) for (let q = 0; q < 12; q++) c[q] += ch.frames[j * 12 + q];
    beat.push({ lo: lo / n, rm: rm / n, hi: hi / n, md: md / n, c });
  }
  // downbeat: new sections start on beat 1, so pick the offset with the biggest energy jumps; chords change on beat 1
  // too, so a change of notes from one beat to the next counts as well
  const score = [0, 0, 0, 0];
  for (let k = 1; k < nBeats; k++) { const j = Math.max(0, beat[k].lo - beat[k - 1].lo) / (lowRef || 1) + Math.max(0, beat[k].rm - beat[k - 1].rm) / (rms90 || 1);
    score[k % 4] += j * j + 0.25 * (1 - cosine(beat[k].c, beat[k - 1].c)) ** 2; }
  const barOff = score.indexOf(Math.max(...score));
  // bars
  const rmsRef = pct(F.rms, 0.95);
  const near = (arr, t, tol) => { const i = lastLE(arr, t + tol); return i >= 0 && arr[i] > t - tol; };
  const bars = []; for (let k = barOff; k + 4 <= nBeats; k += 4) {
    const t0 = off + k * P, t1 = t0 + 4 * P, bb = beat.slice(k, k + 4);
    const avg = key => bb.reduce((s, v) => s + v[key], 0) / 4, c = new Float64Array(12); for (const b of bb) for (let q = 0; q < 12; q++) c[q] += b.c[q];
    const fa = frameOf(t0), fb = Math.max(fa + 1, frameOf(t1)); let vs = 0; for (let f = fa; f < fb; f++) vs += F.voc[f];
    let kOn = 0, bk = 0, pulse = 0; for (let q = 0; q < 4; q++) { const bt = t0 + q * P; if (near(kicks, bt, 0.07)) kOn++; if (q % 2 && near(snares, bt, 0.07)) bk++; }
    for (let q = 0; q < 8; q++) { const bt = t0 + q * P / 2; if (near(kicks, bt, 0.05) || near(snares, bt, 0.05) || near(hats, bt, 0.05)) pulse++; }
    bars.push({ t0, t1, lo: avg("lo"), rm: avg("rm"), hi: avg("hi"), md: avg("md"), c, voc: vs / (fb - fa), kOn, bk, pulse,
      kicks: kicks.filter(t => t >= t0 && t < t1).length, snares: snares.filter(t => t >= t0 && t < t1).length, hats: hats.filter(t => t >= t0 && t < t1).length });
  }
  const norm = key => { const v = bars.map(b => b[key]), lo = pct(v, 0.1), hi = pct(v, 0.9); bars.forEach(b => b[key + "N"] = Math.max(0, Math.min(1.2, (b[key] - lo) / ((hi - lo) || 1)))); };
  ["lo", "rm", "hi", "snares"].forEach(norm);
  bars.forEach(b => { b.dom = Math.log10((b.lo + 1e-9) / (b.md + 1e-9)); });
  norm("dom");
  // (silent: next to nothing, not just much quieter than the rest: a soft intro before long drops is still music)
  bars.forEach(b => b.state = b.rmN < 0.05 && b.rm < Math.min(rms50 * 0.3, rmsRef * 0.05) ? "silent" : (b.loN > 0.55 && b.domN > 0.5 && b.rmN > 0.45 && b.kicks >= 3) ? "drop" : "calm");
  for (let j = 1; j < bars.length - 1; j++) if (bars[j - 1].state === bars[j + 1].state && bars[j].state !== bars[j - 1].state && bars[j].state !== "silent") bars[j].state = bars[j - 1].state;
  // build-ups: the run of rising tension right before each drop
  for (let s = 1; s < bars.length; s++) {
    if (bars[s].state !== "drop" || bars[s - 1].state === "drop") continue;
    const T = j => j < 0 ? 0 : bars[j].snaresN + bars[j].hiN * 2 + bars[j].rmN * 0.5;
    // builds are phrase-length (2, 4 or 8 bars): pick the length with the strongest rise versus the bars before it
    let start = Math.max(0, s - 2), bestScore = -1e9;
    for (const L of [2, 4, 8]) {
      if (s - L < 0) continue; let inside = 0, before = 0, nb = 0, blocked = false;
      for (let j = s - L; j < s; j++) { if (bars[j].state === "drop") blocked = true; inside += T(j); }
      for (let j = s - 2 * L; j < s - L; j++) if (j >= 0) { before += T(j); nb++; }
      if (blocked) continue;
      const sc = (inside / L - (nb ? before / nb : 0)) * Math.sqrt(L);
      if (sc > bestScore) { bestScore = sc; start = s - L; }
    }
    for (let j = start; j < s; j++) if (bars[j].state !== "drop") bars[j].state = "build";
  }
  const drops = []; bars.forEach((b, j) => { if (b.state === "drop" && (j === 0 || bars[j - 1].state !== "drop")) drops.push(b.t0); });
  const env = new Float32Array(Math.ceil(dur / 0.02)); // loudness envelope, 20 ms steps
  for (let i = 0; i < env.length; i++) env[i] = F.rms[frameOf(i * 0.02)] / (rmsRef || 1);
  // song character, used to pick a lighting style
  let onBeat = 0; for (let k = 0; k < nBeats; k++) { const bt = off + k * P, i = lastLE(kicks, bt + 0.08); if (i >= 0 && kicks[i] > bt - 0.08) onBeat++; }
  const kickFrac = nBeats ? onBeat / nBeats : 0;
  const lv = Array.from(env).filter(v => v > 0.02), dyn = lv.length ? pct(lv, 0.9) / (pct(lv, 0.25) || 1e-6) : 1;
  const onsetRate = (kicks.length + snares.length) / Math.max(1, dur);
  const hatRate = hats.length / Math.max(1, dur), snareRate = snares.length / Math.max(1, dur);
  const percussive = hatRate > 2 || snareRate > 3.2;
  let style;
  if (!percussive) style = dyn > 2.5 ? "emotional" : "chill";
  else if (drops.length >= 1 && kickFrac > 0.25 && bpm >= 110) style = "party";
  else if (bpm < 102) style = "hiphop";
  else style = "poprock";

  // ---- per bar: energy (loudness against the song's loud parts), danceability (a steady kick on the beats, a backbeat,
  // a busy eighth-note pulse, at a tempo people dance to, and loud enough), chord, and whether someone sings
  const tempoFit = Math.exp(-(((bpm - 122) / 45) ** 2));
  const chords = barChords(ch.frames, 10, bars.map(b => ({ t0: b.t0 + 0.1, t1: b.t1 + 0.1 })), ch.bass); // (frame i ends at (i + 1) / 10 s)
  for (const [i, b] of bars.entries()) {
    b.energy = r2(clamp(b.rm / (rmsRef || 1)));
    b.dance = b.state === "silent" ? 0 : r2(clamp(Math.sqrt(tempoFit) * (0.45 * b.kOn / 4 + 0.15 * b.bk / 2 + 0.2 * b.pulse / 8 + 0.2 * Math.min(1, b.energy * 1.3))));
    b.chord = chords[i]; b.vocal = b.voc > 0.35;
  }
  // ---- sections (self-similarity of bars, Foote novelty) and the phrase grid
  const S = sectionsOf(bars.map(b => barFeature(b.c, b.rm / (rmsRef || 1), b.kicks, b.snares, b.hats)), bars.map(b => b.state));
  const sections = S.sections.map(s => ({ t0: bars[s.bar0].t0, t1: bars[s.bar1 - 1].t1, bar0: s.bar0, bar1: s.bar1, label: s.label, state: s.state }));
  // ---- key and mood (tonal.js): the song's average chroma against the 24 key profiles, the tonic told apart from its
  // relative by the bass and by the chords that start sections and phrases; valence and energy from the mode, brightness,
  // drums, onsets and tempo
  const avg = new Float64Array(12), bassAvg = new Float64Array(12);
  for (let i = 0; i < ch.frames.length; i++) { avg[i % 12] += ch.frames[i]; bassAvg[i % 12] += ch.bass[i]; }
  const starts = new Set(sections.map(s => s.bar0)); for (let j = S.phrase.first; j < bars.length; j += 4) starts.add(j);
  const sounding = bars.map((b, i) => b.state !== "silent" && chords[i] != null ? i : -1).filter(i => i >= 0);
  if (sounding.length) { starts.add(sounding[0]); starts.add(sounding[sounding.length - 1]); }
  const hint = tonicHint({ bass: bassAvg, starts: [...starts].filter(j => j < bars.length && bars[j].state !== "silent").map(j => chords[j]) });
  const key = keyOf(avg, hint), mood = moodOf({ majorness: key?.majorness, confidence: key?.confidence, bright: ch.bright, onsetRate, bpm, hatRate, kickFrac });
  const danceN = bars.filter(b => b.state !== "silent"), dance = danceN.length ? r2(danceN.reduce((s, b) => s + b.dance, 0) / danceN.length) : 0;
  onProgress && onProgress(1);
  return { key: key ? key.key : null, mode: key ? key.mode : null, keyConfidence: key ? key.confidence : 0, mood, chroma: packChroma(ch.frames),
            bpm, P, off, barOff, kicks, kickStrength, snares, hats, drops, env, dur, style,
            bars: bars.map(b => ({ t0: b.t0, t1: b.t1, state: b.state, level: Math.min(1, b.rmN), energy: b.energy, dance: b.dance, chord: b.chord, vocal: b.vocal })),
            sections, phrase: S.phrase,
            features: { kickFrac, dyn, onsetRate, hatRate, snareRate, bright: r2(ch.bright), dance, vocal: r2(bars.length ? bars.filter(b => b.vocal).length / bars.length : 0) } };
}
function cosine(a, b) { let xy = 0, xx = 0, yy = 0; for (let k = 0; k < 12; k++) { xy += a[k] * b[k]; xx += a[k] * a[k]; yy += b[k] * b[k]; } return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 1; }

// Is someone singing? The same estimate as live listening's (live.js): a clear tone in the 150-1000 Hz range whose
// pitch wanders (vibrato, melody), with its harmonics filling 300-3,500 Hz, held rather than plucked. Called once per
// step of dt seconds on the current magnitude spectrum; returns the smoothed estimate, 0..1.
function vocalTracker(m, binHz, NF, dt) {
  const band = (lo, hi) => { let s = 0; const a = Math.max(1, Math.floor(lo / binHz)), b = Math.min(m.length - 1, Math.ceil(hi / binHz)); for (let i = a; i <= b; i++) s += m[i]; return s / (b - a + 1); };
  const a = Math.max(1, Math.floor(250 / binHz)), b = Math.min(m.length - 2, Math.ceil(3500 / binHz)), pa = Math.max(2, Math.floor(150 / binHz)), pb = Math.ceil(1000 / binHz);
  const ph = [], ah = [], keep = Math.round(0.5 / dt); let vocal = 0;
  return loud => {
    let sum = 0, logSum = 0, peaks = 0, n = 0;
    for (let i = a; i <= b; i++) { const v = m[i] / NF + 1e-9; sum += v; logSum += Math.log(v); n++; if (m[i] > m[i - 1] && m[i] >= m[i + 1] && m[i] > 3 * (m[i - 2] + m[i + 2] + 1e-9) / 2) peaks += m[i] / NF; }
    const flat = Math.exp(logSum / n) / (sum / n), tonal = clamp(1 - flat * 1.6), peakShare = peaks / sum;
    const share = band(250, 3500) / Math.max(1e-7 * NF, band(40, 250) * 0.5 + band(250, 3500) + band(3500, 10000));
    let pi = pa; for (let i = pa; i <= pb; i++) if (m[i] > m[pi]) pi = i;
    const y0 = Math.log(m[pi - 1] / NF + 1e-9), y1 = Math.log(m[pi] / NF + 1e-9), y2 = Math.log(m[pi + 1] / NF + 1e-9), off = clamp(0.5 * (y0 - y2) / (y0 - 2 * y1 + y2 || 1e-9), -0.5, 0.5);
    ph.push(m[pi] / NF > 1e-5 ? Math.log2((pi + off) * binHz) : 0); ah.push(y1 - 0.25 * (y0 - y2) * off); if (ph.length > keep) { ph.shift(); ah.shift(); }
    let d1 = 0, d2 = 0, prevD = null, fall = 0, nf = 0;
    for (let i = 1; i < ph.length; i++) { const d = ph[i] - ph[i - 1]; if (!ph[i] || !ph[i - 1] || Math.abs(d) > 0.06) { prevD = null; continue; } d1 += Math.abs(d); if (prevD != null) d2 += Math.abs(d - prevD); prevD = d;
      const da = ah[i] - ah[i - 1]; if (Math.abs(da) < 0.25) { fall -= da; nf++; } }
    const fade = nf > 2 ? fall / nf / dt : 0, held = clamp((1.2 - fade) / 0.7);
    const wander = Math.min(1, d1 / 0.08) * clamp((1.1 - d2 / Math.max(1e-6, d1)) / 0.6);
    const raw = loud ? Math.min(1, peakShare * 2.5) * Math.min(1, share * 1.6) * wander * held * (0.5 + 0.5 * tonal) : 0;
    vocal += (Math.min(1, raw * 2.2) - vocal) * (1 - Math.exp(-dt / 0.25)); return vocal;
  };
}
