// Shared beat maps: checking what an install sends, and deciding when two of them agree. No I/O (index.js does that),
// so it is the same in the Worker and in Tempolight's tests.
//
// A map (format 1) is what Tempolight learned for a track, on the track's clock (seconds from its start):
//   {v: 1, dur, bpm, P, off, barOff, style, kicks: [s], snares: [s], hats: [s], drops: [s],
//    bars: [[t0, t1, "c"|"b"|"d"|"s", level 0..1]], env: base64 loudness (10 a second, 1 byte each),
//    key, mode, keyConfidence, mood: {valence, energy}, cov: [[from, to]]}   (c calm, b build-up, d drop, s silent)
// Nothing in it says who sent it or what the track is called.

export const MAX_BYTES = 32 * 1024;
const STATES = { c: 1, b: 1, d: 1, s: 1 };
const KEYS = new Set(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]);
const STYLES = new Set(["party", "poprock", "hiphop", "chill", "emotional"]);
const fin = v => typeof v === "number" && Number.isFinite(v);
const r3 = v => Math.round(v * 1000) / 1000;

/** A Spotify track ID: 22 letters and digits. */
export const isTrackId = s => typeof s === "string" && /^[0-9A-Za-z]{22}$/.test(s);
/** An install ID as Tempolight makes it: 32 hex digits. */
export const isInstallId = s => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);

/**
 * Check a map: every number finite and in range, times sorted and inside the track, the grid consistent with the tempo.
 * @returns {{ok:true, map:object} | {ok:false, error:string}} map: a clean copy with only the known fields
 */
export function checkMap(m) {
  const bad = error => ({ ok: false, error });
  if (!m || typeof m !== "object" || Array.isArray(m)) return bad("not a map");
  if (m.v !== 1) return bad("unknown map format (v must be 1)");
  const { dur, bpm, P, off, barOff } = m;
  if (!fin(dur) || dur < 20 || dur > 1800) return bad("dur: 20 to 1800 seconds");
  if (!fin(bpm) || bpm < 50 || bpm > 220) return bad("bpm: 50 to 220");
  if (!fin(P) || Math.abs(P * bpm / 60 - 1) > 0.002) return bad("P must be 60 / bpm");
  if (!fin(off) || off < 0 || off >= P + 1e-6) return bad("off: 0 to P");
  if (!Number.isInteger(barOff) || barOff < 0 || barOff > 3) return bad("barOff: 0 to 3");
  const times = (k, max) => { const a = m[k] ?? []; if (!Array.isArray(a) || a.length > max) return null;
    let last = -1; for (const t of a) { if (!fin(t) || t < 0 || t > dur + 0.5 || t < last) return null; last = t; } return a.map(r3); };
  const kicks = times("kicks", 4000), snares = times("snares", 4000), hats = times("hats", 6000), drops = times("drops", 200);
  if (!kicks || !snares || !hats || !drops) return bad("kicks, snares, hats and drops: sorted times inside the track");
  if (!Array.isArray(m.bars) || m.bars.length > 2000) return bad("bars: a list");
  const bars = []; let lastT = -1;
  for (const b of m.bars) { if (!Array.isArray(b) || b.length !== 4) return bad("a bar is [t0, t1, state, level]");
    const [t0, t1, st, lv] = b; if (!fin(t0) || !fin(t1) || t0 < lastT - 0.05 || t1 <= t0 || t1 - t0 > 20 || t1 > dur + 1 || !STATES[st] || !fin(lv) || lv < 0 || lv > 1) return bad("a bar is out of range");
    lastT = t1; bars.push([r3(t0), r3(t1), st, Math.round(lv * 100) / 100]); }
  if (typeof m.env !== "string" || m.env.length > 24000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(m.env)) return bad("env: base64");
  if (!Array.isArray(m.cov) || !m.cov.length || m.cov.length > 50) return bad("cov: a list of [from, to]");
  const cov = []; for (const c of m.cov) { if (!Array.isArray(c) || c.length !== 2 || !fin(c[0]) || !fin(c[1]) || c[0] < 0 || c[1] <= c[0] || c[1] > dur + 1) return bad("cov: [from, to] inside the track"); cov.push([r3(c[0]), r3(c[1])]); }
  const out = { v: 1, dur: r3(dur), bpm: Math.round(bpm * 1e4) / 1e4, P: Math.round(P * 1e6) / 1e6, off: Math.round(off * 1e6) / 1e6, barOff, style: STYLES.has(m.style) ? m.style : "poprock",
    kicks, snares, hats, drops, bars, env: m.env, cov,
    key: KEYS.has(m.key) ? m.key : null, mode: m.mode === "major" || m.mode === "minor" ? m.mode : null, keyConfidence: fin(m.keyConfidence) ? Math.max(0, Math.min(1, m.keyConfidence)) : 0,
    mood: m.mood && fin(m.mood.valence) && fin(m.mood.energy) ? { valence: Math.max(0, Math.min(1, m.mood.valence)), energy: Math.max(0, Math.min(1, m.mood.energy)) } : null };
  return { ok: true, map: out };
}

export const coverSec = m => m.cov.reduce((n, c) => n + c[1] - c[0], 0);
function overlap(a, b) { const out = []; for (const x of a.cov) for (const y of b.cov) { const lo = Math.max(x[0], y[0]), hi = Math.min(x[1], y[1]); if (hi > lo) out.push([lo, hi]); } return out; }
const inside = (ranges, t) => ranges.some(r => t >= r[0] && t <= r[1]);

/**
 * Do two maps of the same track agree? Tempo within 1%, the beats within 30 ms of each other in the middle of what both
 * heard, and the drops roughly the same (each drop either heard has one in the other within 2 s, for at least 60% of
 * them; or neither has any). They must share at least 20 s.
 */
export function agree(a, b) {
  if (Math.abs(a.bpm - b.bpm) / b.bpm > 0.01) return false;
  const ov = overlap(a, b), len = ov.reduce((n, r) => n + r[1] - r[0], 0); if (len < 20) return false;
  const big = ov.reduce((x, r) => (r[1] - r[0] > x[1] - x[0] ? r : x)), tm = (big[0] + big[1]) / 2;
  const beatA = a.off + Math.round((tm - a.off) / a.P) * a.P; // a's beat nearest the middle, and b's beat nearest that
  const beatB = b.off + Math.round((beatA - b.off) / b.P) * b.P;
  if (Math.abs(beatA - beatB) > 0.03) return false;
  const da = a.drops.filter(t => inside(ov, t)), db = b.drops.filter(t => inside(ov, t));
  if (!da.length && !db.length) return true;
  const hit = (xs, ys) => xs.filter(t => ys.some(u => Math.abs(u - t) <= 2)).length;
  return (hit(da, db) + hit(db, da)) / (da.length + db.length) >= 0.6;
}

/**
 * The confirmed map from the submissions for one track ({install, map}, one per install): the map that the most other
 * installs agree with, when at least two installs (it and one more) do. Of those, the one that covers the most of the
 * track is served. @returns {{map:object, installs:number} | null}
 */
export function consensus(subs) {
  let best = null;
  for (const s of subs) {
    const group = subs.filter(o => o === s || agree(s.map, o.map)), installs = new Set(group.map(o => o.install)).size;
    if (installs < 2) continue;
    const rep = group.reduce((x, o) => (coverSec(o.map) > coverSec(x.map) ? o : x));
    if (!best || installs > best.installs || (installs === best.installs && coverSec(rep.map) > coverSec(best.map))) best = { map: rep.map, installs };
  }
  return best;
}
