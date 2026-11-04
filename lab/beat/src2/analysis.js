// Whole-song analysis. Pure JavaScript, no dependencies; runs in Node and in the browser.
import { songChroma, packChroma, keyOf, moodOf } from "./tonal.js";
export function lastLE(arr, t) { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
/**
 * Analyse a whole song once: onsets (kick, snare, hi-hat), tempo, beat grid, bars,
 * song parts (calm, build, drop, silent), a loudness envelope, a music style, the key and the mood
 * (and a compact chroma fingerprint for song memory).
 * @param {Float32Array} x mono samples (about 22 kHz is enough)
 * @param {number} sr sample rate of x
 * @param {(p:number)=>void} [onProgress] called with 0..1
 */
export async function preAnalyseCore(x, sr, onProgress) {
  const NF = 1024, HOP = 256, nFrames = Math.max(0, Math.floor((x.length - NF) / HOP));
  const dtF = HOP / sr, binHz = sr / NF, half = NF / 2;
  const win = new Float32Array(NF); for (let i = 0; i < NF; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NF);
  const re = new Float32Array(NF), im = new Float32Array(NF), mag = new Float32Array(half), prev = new Float32Array(half);
  const rev = new Uint16Array(NF); for (let i = 0, j = 0; i < NF; i++) { rev[i] = j; let b = NF >> 1; while (j & b) { j ^= b; b >>= 1; } j |= b; }
  const cosT = new Float32Array(half), sinT = new Float32Array(half); for (let i = 0; i < half; i++) { cosT[i] = Math.cos(-2 * Math.PI * i / NF); sinT[i] = Math.sin(-2 * Math.PI * i / NF); }
  function fft() {
    for (let i = 0; i < NF; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= NF; size <<= 1) { const h = size >> 1, step = NF / size;
      for (let s = 0; s < NF; s += size) for (let k = 0; k < h; k++) {
        const c = cosT[k * step], sn = sinT[k * step], a = s + k, b = a + h;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; } }
  }
  const bin = f => Math.max(1, Math.min(half - 1, Math.round(f / binHz)));
  const B = { k: [bin(40), bin(130)], low: [bin(40), bin(150)], mid: [bin(300), bin(2000)], high: [bin(4000), Math.min(half - 1, bin(11000))],
              s1: [bin(180), bin(320)], s2: [bin(1800), bin(5000)], h: [bin(7000), Math.min(half - 1, bin(11000))] };
  const F = { low: new Float32Array(nFrames), mid: new Float32Array(nFrames), high: new Float32Array(nFrames), rms: new Float32Array(nFrames),
              fk: new Float32Array(nFrames), fs: new Float32Array(nFrames), fh: new Float32Array(nFrames) };
  const mean = (a, b) => { let s = 0; for (let i = a; i <= b; i++) s += mag[i]; return s / (b - a + 1); };
  const flux = (a, b) => { let s = 0; for (let i = a; i <= b; i++) { const d = mag[i] - prev[i]; if (d > 0) s += d; } return s; };
  for (let f = 0; f < nFrames; f++) {
    const o = f * HOP; let e = 0;
    for (let i = 0; i < NF; i++) { const v = x[o + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    fft(); for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
    F.rms[f] = Math.sqrt(e / NF); F.low[f] = mean(...B.low); F.mid[f] = mean(...B.mid); F.high[f] = mean(...B.high);
    F.fk[f] = flux(...B.k); F.fs[f] = flux(...B.s1) * 0.6 + flux(...B.s2) * 0.4; F.fh[f] = flux(...B.h);
    prev.set(mag);
    if (f % 600 === 0) { onProgress && onProgress(f / nFrames * 0.9); await new Promise(r => setTimeout(r, 0)); }
  }
  const tOf = f => (f * HOP + NF * 0.5) / sr;
  const pct = (arr, p) => { const s = Array.from(arr).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
  // peak picking with a local adaptive threshold
  function pick(fl, minGap, k, strength) {
    const W = Math.round(0.35 / dtF), out = []; let sum = 0, cnt = 0, last = -1e9;
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
  const kicks = kicksRaw.filter(t => { const f = Math.min(nFrames - 1, Math.round((t * sr - NF * 0.5) / HOP) + 2); return F.low[f] > lowRef * 0.35; });
  const snares = pick(F.fs, 0.1, 1.5, 0.3), hats = pick(F.fh, 0.06, 1.4, 0.2);
  onProgress && onProgress(0.93);
  // tempo
  // tempo from kicks and snares together (backbeat genres need the snare), searched over 60-180 BPM
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
  const strong = src;
  let bpm = base, off = 0, bestScore = -1;
  for (const c0 of cands) {
    let fitB = c0, fitOff = 0, fitR = -1;
    for (let cand = c0 - 1; cand <= c0 + 1.001; cand += 0.05) {
      const Pc = 60 / cand; let sx = 0, sy = 0; for (const t of strong) { const a2 = 2 * Math.PI * t / Pc; sx += Math.cos(a2); sy += Math.sin(a2); }
      const r = Math.hypot(sx, sy) / Math.max(1, strong.length); if (r > fitR) { fitR = r; fitB = cand; fitOff = ((Math.atan2(sy, sx) / (2 * Math.PI) + 1) % 1) * Pc; }
    }
    const Pc = 60 / fitB; let hit = 0, tot = 0; const t0 = src[0] || 0, t1 = src[src.length - 1] || 0;
    for (let bt = fitOff + Math.ceil((t0 - fitOff) / Pc) * Pc; bt <= t1; bt += Pc) { tot++; const i = lastLE(src, bt + 0.07); if (i >= 0 && src[i] > bt - 0.07) hit++; }
    const cover = tot ? hit / tot : 0, score = fitR * Math.sqrt(cover) * Math.exp(-(((fitB - 112) / 80) ** 2));
    if (score > bestScore) { bestScore = score; bpm = fitB; off = fitOff; }
  }
  // with the tempo settled, lock the grid's phase to the kick drums when there are enough of them,
  // so off-beat hi-hats cannot pull beat 1 half a beat late
  if (kicks.length >= 8) { const Pk = 60 / bpm; let sx = 0, sy = 0; for (const t of kicks) { const a2 = 2 * Math.PI * t / Pk; sx += Math.cos(a2); sy += Math.sin(a2); }
    off = ((Math.atan2(sy, sx) / (2 * Math.PI) + 1) % 1) * Pk; }
  if (bpm > 150) bpm /= 2;   // light shows read very fast tempos better at half time
  const P = 60 / bpm, dur = x.length / sr;
  // per-beat features
  const nBeats = Math.floor((dur - off) / P);
  const frameOf = t => Math.max(0, Math.min(nFrames - 1, Math.round((t * sr - NF * 0.5) / HOP)));
  const beat = []; for (let k = 0; k < nBeats; k++) {
    const a = frameOf(off + k * P), b = Math.max(a + 1, frameOf(off + (k + 1) * P)); let lo = 0, rm = 0, hi = 0, md = 0;
    for (let f = a; f < b; f++) { lo += F.low[f]; rm += F.rms[f]; hi += F.high[f]; md += F.mid[f]; } const n = b - a;
    beat.push({ lo: lo / n, rm: rm / n, hi: hi / n, md: md / n });
  }
  // downbeat: new sections start on beat 1, so pick the offset with the biggest energy jumps
  const score = [0, 0, 0, 0];
  for (let k = 1; k < nBeats; k++) { const j = Math.max(0, beat[k].lo - beat[k - 1].lo) / (lowRef || 1) + Math.max(0, beat[k].rm - beat[k - 1].rm) / (rms90 || 1); score[k % 4] += j * j; }
  const barOff = score.indexOf(Math.max(...score));
  // bars
  const bars = []; for (let k = barOff; k + 4 <= nBeats; k += 4) {
    const t0 = off + k * P, t1 = t0 + 4 * P, bb = beat.slice(k, k + 4);
    const avg = key => bb.reduce((s, v) => s + v[key], 0) / 4;
    bars.push({ t0, t1, lo: avg("lo"), rm: avg("rm"), hi: avg("hi"), md: avg("md"),
      kicks: kicks.filter(t => t >= t0 && t < t1).length, snares: snares.filter(t => t >= t0 && t < t1).length });
  }
  const norm = key => { const v = bars.map(b => b[key]), lo = pct(v, 0.1), hi = pct(v, 0.9); bars.forEach(b => b[key + "N"] = Math.max(0, Math.min(1.2, (b[key] - lo) / ((hi - lo) || 1)))); };
  ["lo", "rm", "hi", "snares"].forEach(norm);
  bars.forEach(b => { b.dom = Math.log10((b.lo + 1e-9) / (b.md + 1e-9)); });
  norm("dom");
  bars.forEach(b => b.state = b.rmN < 0.05 && b.rm < rms50 * 0.3 ? "silent" : (b.loN > 0.55 && b.domN > 0.5 && b.rmN > 0.45 && b.kicks >= 3) ? "drop" : "calm");
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
  const rmsRef = pct(F.rms, 0.95);
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
  // key and mood (tonal.js): the song's average chroma against the 24 key profiles; valence and energy from the
  // mode, brightness, drums, onsets and tempo
  const ch = await songChroma(x, sr), avg = new Float64Array(12);
  for (let i = 0; i < ch.frames.length; i++) avg[i % 12] += ch.frames[i];
  const key = keyOf(avg), mood = moodOf({ majorness: key?.majorness, confidence: key?.confidence, bright: ch.bright, onsetRate, bpm, hatRate, kickFrac });
  onProgress && onProgress(1);
  return { key: key ? key.key : null, mode: key ? key.mode : null, keyConfidence: key ? key.confidence : 0, mood, chroma: packChroma(ch.frames),
            bpm, P, off, barOff, kicks, snares, hats, bars: bars.map(b => ({ t0: b.t0, t1: b.t1, state: b.state, level: Math.min(1, b.rmN) })), drops, env, dur,
           features: { kickFrac, dyn, onsetRate, hatRate, snareRate, bright: Math.round(ch.bright * 100) / 100 }, style };
}

