// Per-effect feel: each pooled effect rendered alone over the part of the song it is meant for (oracle analysis).
import { buildLayout, exampleRoom, createEffects, songView, buildSignals, toRGB8 } from "./engine/src/index.js";
import { longEdm } from "./song.js";
const FPS = 60, song = longEdm(), T = song.truth, P = 60 / T.bpm;
const map = { intro: "calm", build: "build", drop: "drop", break: "calm", outro: "calm", silence: "silent" };
const pre = { bpm: T.bpm, P, off: 0, barOff: 0, style: "party", drops: T.parts.filter(p => p.part === "drop").map(p => p.t0), bars: [], kicks: T.kicks, snares: T.snares, hats: T.hats, dur: song.dur,
  env: new Float32Array(Math.ceil(song.dur / 0.02)) };
for (const p of T.parts) for (let t = p.t0; t < p.t1 - 1e-6; t += 4 * P) pre.bars.push({ t0: t, t1: t + 4 * P, state: map[p.part], level: p.part === "drop" ? 1 : 0.3 });
for (let i = 0; i < pre.env.length; i++) { const t = i * 0.02, p = T.parts.find(q => t >= q.t0 && t < q.t1)?.part; pre.env[i] = p === "silence" ? 0 : p === "drop" ? 0.8 : 0.3; }
const L = buildLayout(exampleRoom()), N = L.N, fx = createEffects(L), c8 = new Uint8Array(N * 3), prev = new Uint8Array(N * 3);
const bands = new Float32Array(24);
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const part = name => T.parts.find(p => p.part === name);
function run(id, pt) {
  const lum = [], low = [], high = [], act = [], ts = [];
  for (let t = pt.t0; t < pt.t1; t += 1 / FPS) {
    const V = songView(pre, t), kickAge = t - V.kick; bands.fill(0); if (pt.part === "drop") { const e = Math.exp(-Math.max(0, kickAge) / 0.15); for (let b = 0; b < 6; b++) bands[b] = 0.4 + 0.6 * e; for (let b = 6; b < 24; b++) bands[b] = 0.3; }
    const S = buildSignals(V, t, { pal: fx.palettes.auto[0], bands, bassL: pt.part === "drop" ? 0.5 + 0.5 * Math.exp(-Math.max(0, kickAge) / 0.2) : 0.1 });
    toRGB8(fx.render(id, S), c8, 0.8);
    let s = 0, lo = 0, nl = 0, hi = 0, nh = 0, d = 0;
    for (let i = 0; i < N; i++) { const v = (c8[i * 3] + c8[i * 3 + 1] + c8[i * 3 + 2]) / 765; s += v; if (L.PY[i] < 0.45) { lo += v; nl++; } else if (L.PY[i] > 0.7) { hi += v; nh++; } }
    for (let i = 0; i < c8.length; i++) d += Math.abs(c8[i] - prev[i]); prev.set(c8);
    lum.push(s / N); low.push(lo / nl); high.push(hi / nh); act.push(d / c8.length / 255); ts.push(t);
  }
  const idx = t => Math.max(0, Math.min(ts.length - 1, Math.round((t - pt.t0) * FPS)));
  const win = (a, t0, t1) => a.slice(idx(t0), idx(t1) + 1);
  const kc = [], lg = [], hg = [];
  for (const k of T.kicks) { if (k < pt.t0 + 0.2 || k > pt.t1 - 0.2) continue;
    const pk = Math.max(...win(lum, k, k + 0.12)), tr = Math.min(...win(lum, k - 0.12, k - 0.02)); kc.push((pk - tr) / Math.max(1e-3, pk));
    lg.push(Math.max(...win(low, k, k + 0.12)) - Math.min(...win(low, k - 0.12, k - 0.02))); hg.push(Math.max(...win(high, k, k + 0.12)) - Math.min(...win(high, k - 0.12, k - 0.02))); }
  const q = (pt.t1 - pt.t0) / 4, m = a => a.reduce((x, y) => x + y, 0) / a.length;
  const sn = []; for (const s of T.snares) { if (s < pt.t0 + 0.1 || s > pt.t1 - 0.1) continue; sn.push(m(win(act, s, s + 0.05)) - m(win(act, s - 0.05, s - 0.02))); }
  return { id, lum: m(lum), kick: kc.length ? med(kc) : null, lowG: lg.length ? med(lg) : null, highG: hg.length ? med(hg) : null,
    rise: m(win(lum, pt.t1 - q, pt.t1 - 0.3)) / Math.max(1e-3, m(win(lum, pt.t0, pt.t0 + q))), act: m(act) * 1000, snare: sn.length ? med(sn) * 1000 : null };
}
const r3 = v => v == null ? "-" : (Math.round(v * 100) / 100).toFixed(2);
for (const [pool, pn] of [["drop", "drop"], ["build", "build"], ["calm", "intro"]]) {
  const rows = fx.pools[pool].map(id => run(id, pn === "build" ? T.parts[1] : part(pn)));
  rows.sort((a, b) => (b.kick ?? b.rise) - (a.kick ?? a.rise));
  console.log(`\n== ${pool} pool (${rows.length}) over ${pn}`);
  console.log("id          lum   kickC  lowG  highG  rise  act  snare");
  for (const r of rows) console.log(r.id.padEnd(11), r3(r.lum), " ", r3(r.kick), " ", r3(r.lowG), " ", r3(r.highG), " ", r3(r.rise), r3(r.act).padStart(5), r3(r.snare));
  const ks = rows.filter(r => r.kick != null).map(r => r.kick); if (ks.length) console.log("kick contrast <0.15:", rows.filter(r => r.kick < 0.15).map(r => r.id).join(","), "| median", r3(med(ks)));
  const lw = rows.filter(r => r.lowG != null); if (lw.length) console.log("effects whose kick lands lower than higher:", lw.filter(r => r.lowG > r.highG * 1.3).length, "/", lw.length);
}
