// causal riser detector prototype on top of LiveAnalyser: rising centroid, rising high band, accelerating onsets, no bass
import { readWav, S, E } from "./lib.mjs";
const { LiveAnalyser } = await import(E);
const syn = await import("/home/claude/tempolight/packages/engine/test/synth.js");
function slope(arr) { const n = arr.length; if (n < 4) return 0; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { const [x, y] = arr[i]; sx += x; sy += y; sxx += x * x; sxy += x * y; } const d = n * sxx - sx * sx; return d ? (n * sxy - sx * sy) / d : 0; }
const clamp = v => Math.max(0, Math.min(1, v));
function run(name, x, sr, drops, builds) {
  const a = new LiveAnalyser(sr), H = []; const out = []; let nextT = 0, armed = null, preds = [];
  const orig = a.hop.bind(a); a.hop = function () { orig(); const m = this.mag, bz = this.binHz; let cs = 0, cw = 0, hi = 0, all = 0;
    for (let k = Math.ceil(200 / bz); k < Math.min(m.length, 10000 / bz); k++) { cs += m[k] * k * bz; cw += m[k]; if (k * bz > 3000) hi += m[k] * m[k]; all += m[k] * m[k]; }
    H.push([this.t, cw > 0 ? Math.log2(cs / cw) : 0, Math.log10(hi + 1e-12), this.snares.length ? this.snares.filter(s => this.t - s < 1).length : 0, Math.log10(all + 1e-12)]); if (H.length > 400) H.shift(); };
  for (let i = 0; i < x.length; i += 512) { a.push(x.subarray(i, i + 512)); const t = a.t; if (t < nextT || H.length < 50) continue; nextT = t + 0.25;
    const w = H.filter(h => t - h[0] < 4);
    const cS = slope(w.map(h => [h[0], h[1]])), hS = slope(w.map(h => [h[0], h[2]])), oS = slope(w.map(h => [h[0], h[3]])), lS = slope(w.map(h => [h[0], h[4]]));
    const bassy = a.domBase != null && a.domS - a.domBase > 0.5;
    const score = bassy ? 0 : 0.35 * clamp(cS / 0.12) + 0.35 * clamp(hS / 0.12) + 0.3 * clamp(oS / 0.6);
    out.push([t, score]);
  }
  // riser on: score > 0.45 for 1 s; report onset times
  const on = []; let run0 = null, state = false; for (const [t, s] of out) { if (s > 0.45) { if (run0 == null) run0 = t; if (!state && t - run0 >= 1) { state = true; on.push(t); } } else { run0 = null; if (state && s < 0.2) state = false; } }
  const inBuild = t => builds.some(([p, q]) => t >= p - 0.5 && t < q + 0.5);
  console.log(`${name}: riser onsets ${on.map(v => v.toFixed(1)).join(", ")} | drops at ${drops.join(", ")} | false (outside builds): ${on.filter(t => !inBuild(t)).length}`);
  for (const d of drops) { const s = out.filter(([t]) => t > d - 8 && t <= d).map(([t, v]) => `${(t - d).toFixed(1)}:${v.toFixed(2)}`).filter((_, i) => i % 4 === 0); console.log("   score before drop", d, s.join(" ")); }
  const fpS = out.filter(([t, v]) => !inBuild(t) && v > 0.45).length / out.filter(([t]) => !inBuild(t)).length; console.log(`   fraction of non-build time over threshold: ${(fpS * 100).toFixed(1)}%`);
}
const t2 = readWav(S + "/songs/track2.wav"); run("python EDM (noise sweep + roll)", t2.x, t2.sr, [15, 45], [[7.5, 15], [37.5, 45]]);
const e = syn.edm(22050); run("synth edm() (roll only)", e.x, 22050, [15], [[7.5, 15]]);
const p = syn.majorPop(22050); run("majorPop (no builds)", p.x, 22050, [], []);
const b = syn.minorBallad(22050); run("minorBallad (no builds)", b.x, 22050, [], []);
