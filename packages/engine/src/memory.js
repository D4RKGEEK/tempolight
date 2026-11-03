// Song memory: songs Tempolight has analysed before (played through the app) are remembered, and recognised when
// they play again from anywhere else (Spotify, a DJ, the radio) while it listens live. Once a song is recognised,
// the lights follow its stored beat map, so build-ups and drops are known ahead of time, as if it were played here.
//
// Recognition compares the loudness shape of the last 12 seconds with each remembered song (10 values a second, as
// changes in log loudness so the volume doesn't matter), then lines up the kicks heard with the stored kicks to get
// the position to within a few milliseconds.
import { lastLE } from "./analysis.js";

const RATE = 10, WIN = 120; // fingerprint: 10 values a second; a match looks at the last 12 seconds

const logq = v => Math.max(0, Math.min(255, Math.round((Math.log10(v + 1e-4) + 4) / 4 * 255)));
/** Loudness envelope (any rate) to fingerprint bytes at 10 a second. */
export function fingerprint(env, step = 0.02) { const k = Math.max(1, Math.round(1 / RATE / step)), out = new Uint8Array(Math.floor(env.length / k));
  for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += env[i * k + j]; out[i] = logq(s / k); } return out; }
// high-pass: the change from the average of the last second, so only the shape counts
function shape(q, a = 0, b = q.length) { const out = new Float32Array(b - a); let m = q[a] || 0;
  for (let i = a; i < b; i++) { m += (q[i] - m) * 0.2; out[i - a] = Math.max(-25, Math.min(25, q[i] - m)); } return out; } // clipped: one big jump (a song's end) can't decide the match alone

const r3 = v => Math.round(v * 1000) / 1000;
const b64 = u8 => typeof Buffer !== "undefined" ? Buffer.from(u8).toString("base64") : btoa(String.fromCharCode(...u8));
const unb64 = s => typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** A compact copy of a song analysis to remember (about 10-20 kB). */
export function memoryEntry(name, pre, id) {
  const env10 = new Float32Array(Math.floor(pre.env.length / 5)); for (let i = 0; i < env10.length; i++) { let s = 0; for (let j = 0; j < 5; j++) s += pre.env[i * 5 + j]; env10[i] = s / 5; }
  return { id, name: String(name).slice(0, 120), bpm: r3(pre.bpm), P: pre.P, off: pre.off, barOff: pre.barOff, style: pre.style, dur: r3(pre.dur), drops: pre.drops.map(r3),
    kicks: pre.kicks.map(r3), snares: pre.snares.map(r3), hats: pre.hats.filter((_, i) => i % 2 === 0).map(r3), bars: pre.bars.map(b => ({ t0: r3(b.t0), t1: r3(b.t1), state: b.state, level: Math.round(b.level * 100) / 100 })),
    env: b64(Uint8Array.from(env10, v => Math.min(255, Math.round(Math.sqrt(Math.min(1, v / 1.5)) * 255)))), fp: b64(fingerprint(pre.env)), at: Date.now() };
}
/** Back to an analysis that songView() can use. */
export function memoryAnalysis(e) {
  const env10 = unb64(e.env), env = new Float32Array(env10.length * 5);
  for (let i = 0; i < env.length; i++) { const v = env10[Math.floor(i / 5)] / 255; env[i] = v * v * 1.5; }
  return { bpm: e.bpm, P: e.P, off: e.off, barOff: e.barOff, style: e.style, dur: e.dur, drops: e.drops, kicks: e.kicks, snares: e.snares, hats: e.hats, bars: e.bars, env };
}

/**
 * Which remembered song is this, and where in it are we?
 * @param {ArrayLike<number>} live fingerprint bytes of what was heard, oldest first (at least 12 s)
 * @param {{id:string, fp:string|Uint8Array, bpm:number}[]} entries
 * @param {{bpm?:number}} [o] the live tempo, if known, to skip songs that can't be it
 * @returns {{id:string, pos:number, score:number}|null} pos: seconds into the song at the end of `live`
 */
export function recognise(live, entries, o = {}) {
  if (live.length < WIN) return null;
  const x = shape(live, live.length - WIN), xs = Math.sqrt(x.reduce((s, v) => s + v * v, 0)); if (xs < 30) return null; // too flat to tell (silence, a drone)
  let best = null;
  for (const e of entries) {
    if (o.bpm && e.bpm) { const r = o.bpm / e.bpm; if (![0.5, 1, 2].some(k => Math.abs(r / k - 1) < 0.06)) continue; }
    const fp = typeof e.fp === "string" ? (e._fp ||= unb64(e.fp)) : e.fp; if (fp.length < WIN) continue;
    const y = e._shape ||= shape(fp); const n = y.length - WIN + 1, sc = new Float32Array(n);
    for (let s = 0; s < n; s++) { let xy = 0, yy = 0; for (let i = 0; i < WIN; i++) { const v = y[s + i]; xy += x[i] * v; yy += v * v; } sc[s] = yy > 0 ? xy / (xs * Math.sqrt(yy)) : 0; }
    let bi = 0; for (let s = 1; s < n; s++) if (sc[s] > sc[bi]) bi = s;
    let second = 0; for (let s = 0; s < n; s++) if (Math.abs(s - bi) > 20 && sc[s] > second) second = sc[s]; // somewhere else in the song (2 s away or more)
    const score = sc[bi], margin = score - second;
    if (score > (o.min ?? 0.6) && margin > 0.08 && (!best || score > best.score)) best = { id: e.id, pos: (bi + WIN) / RATE, score, margin };
  }
  return best;
}

/**
 * Fine-tune a position with the kicks: shift until the kicks heard (live times) land on the song's stored kicks.
 * @param {number[]} liveKicks recent kick times on the live clock @param {number} liveT the live clock now
 * @param {number} pos the song position now (rough) @param {number[]} songKicks
 * @returns {{pos:number, hits:number}}
 */
export function refineByKicks(liveKicks, liveT, pos, songKicks, range = 0.2) {
  const recent = liveKicks.filter(k => liveT - k < 10 && liveT - k > 0.05); if (recent.length < 4 || !songKicks.length) return { pos, hits: 0 };
  let best = { pos, hits: -1, err: 9 };
  for (let d = -range; d <= range + 1e-9; d += 0.005) {
    let hits = 0, err = 0;
    for (const k of recent) { const st = pos + d - (liveT - k), i = lastLE(songKicks, st); const near = Math.min(i >= 0 ? st - songKicks[i] : 9, i + 1 < songKicks.length ? songKicks[i + 1] - st : 9);
      if (near < 0.03) { hits++; err += near; } }
    if (hits > best.hits || (hits === best.hits && err < best.err)) best = { pos: pos + d, hits, err };
  }
  return best.hits >= Math.max(3, recent.length * 0.5) ? { pos: best.pos, hits: best.hits } : { pos, hits: 0 };
}

/** Collects the live fingerprint from an analyser's loudness, 10 values a second. */
export class FingerprintTap {
  constructor(seconds = 20) { this.max = seconds * RATE; this.q = []; this.acc = 0; this.n = 0; this.nextT = null; }
  /** call once per analyser hop with its time and RMS (same scale as whole-song analysis is not needed: only the shape counts) */
  push(t, rms) { if (this.nextT == null) this.nextT = t + 1 / RATE; this.acc += rms; this.n++;
    if (t >= this.nextT) { this.q.push(logq(this.acc / this.n * 4)); if (this.q.length > this.max) this.q.shift(); this.acc = 0; this.n = 0; this.nextT += 1 / RATE; if (t - this.nextT > 1) this.nextT = t + 1 / RATE; } }
  reset() { this.q = []; this.acc = 0; this.n = 0; this.nextT = null; }
}
