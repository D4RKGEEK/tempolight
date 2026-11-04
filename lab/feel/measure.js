// Feel metrics: run the real director + effects over a synthetic song (whole-song mode and live mode) and measure.
import { preAnalyseCore, buildLayout, exampleRoom, createEffects, createDirector, songView, LiveAnalyser, toRGB8, planShow } from "./engine/src/index.js";
import { longEdm } from "./song.js";

const FPS = 60, song = longEdm(), T = song.truth;
const pre = await preAnalyseCore(song.x, song.sr);
if (process.env.ORACLE) { // a perfect analysis: true grid, true song parts, true drops (isolates director + effects feel)
  const P = 60 / T.bpm, map = { intro: "calm", build: "build", drop: "drop", break: "calm", outro: "calm", silence: "silent" }, lev = { intro: 0.3, build: 0.6, drop: 1, break: 0.2, outro: 0.4, silence: 0 };
  Object.assign(pre, { bpm: T.bpm, P, off: 0, barOff: 0, style: "party", drops: T.parts.filter(p => p.part === "drop").map(p => p.t0), bars: [] });
  for (const p of T.parts) for (let t = p.t0; t < p.t1 - 1e-6; t += 4 * P) pre.bars.push({ t0: t, t1: t + 4 * P, state: map[p.part], level: lev[p.part] });
} else if (process.env.FIX) { // what the engine does with a correct beat grid and style (the analysis read half tempo)
  const P = 60 / T.bpm; Object.assign(pre, { bpm: T.bpm, P, off: 0, barOff: 0, style: "party" });
  const st = pre.bars; pre.bars = []; for (const b of st) { pre.bars.push({ ...b, t1: b.t0 + (b.t1 - b.t0) / 2 }); pre.bars.push({ ...b, t0: b.t0 + (b.t1 - b.t0) / 2 }); }
  for (const b of pre.bars) { const k = Math.round(b.t0 / (4 * P)); const d = b.t1 - b.t0; b.t0 = k * 4 * P; b.t1 = b.t0 + d; } }
const L = buildLayout(exampleRoom()), N = L.N;
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
const f2 = v => Math.round(v * 1000) / 1000;
const out = {};

// ---------- 1. analysis accuracy vs truth
const nearest = (arr, t) => { let b = 1e9; for (const v of arr) if (Math.abs(v - t) < Math.abs(b)) b = v - t; return b; };
const kErr = T.kicks.map(k => nearest(pre.kicks, k)).filter(e => Math.abs(e) < 0.1);
const sErr = T.snares.map(k => nearest(pre.snares, k)).filter(e => Math.abs(e) < 0.06);
const barErr = pre.bars.map(b => nearest(T.downbeats, b.t0));
out.analysis = { bpm: f2(pre.bpm), truthBpm: T.bpm, style: pre.style, kicksFound: `${kErr.length}/${T.kicks.length}`, kickBiasMs: f2(med(kErr) * 1000), kickFalse: pre.kicks.length - kErr.length,
  snaresFound: `${sErr.length}/${T.snares.length}`, snareBiasMs: f2(med(sErr) * 1000), barOffsetMs: f2(med(barErr) * 1000),
  drops: pre.drops.map(f2), truthDrops: T.parts.filter(p => p.part === "drop").map(p => f2(p.t0)),
  states: compress(pre.bars.map(b => b.state)) };
function compress(a) { const o = []; for (const s of a) { if (o.length && o.at(-1)[0] === s) o.at(-1)[1]++; else o.push([s, 1]); } return o.map(([s, n]) => `${s}x${n}`).join(" "); }

// ---------- 2. run the director
function run(mode, opts = {}) {
  const fx = createEffects(L), D = createDirector(L, fx); Object.assign(D.settings, opts.settings || {});
  if (opts.show) D.settings.plan = planShow(pre, fx, {});
  const an = mode === "live" ? new LiveAnalyser(song.sr) : null, chunk = Math.round(song.sr / FPS);
  const nF = Math.floor(song.dur * FPS), lum = new Float32Array(nF), hue = new Float32Array(nF), low = new Float32Array(nF), high = new Float32Array(nF), cur = [], states = [], pdiff = new Float32Array(nF);
  const c8 = new Uint8Array(N * 3), prev8 = new Uint8Array(N * 3); let pos = 0;
  for (let f = 0; f < nF; f++) {
    const now = (f + 1) / FPS; // the moment the frame is shown (audio clock) — no network/LED delay here
    let V, t, extra = {};
    if (mode === "live") { an.push(song.x.subarray(pos, Math.min(song.x.length, pos + chunk))); pos += chunk; t = an.t + (opts.offset || 0); V = an.view(t, { predict: opts.predict !== false }); extra = an.extras(); if (V.state === "silent" && V.quietFor > 8) V = null; }
    else { t = now + (opts.offset || 0); V = songView(pre, t); }
    const col = D.frame(V, t, extra, now); if (opts.post) opts.post(col, V, t, now); toRGB8(col, c8, 0.8);
    let s = 0, r = 0, g = 0, b = 0, lo = 0, nl = 0, hi = 0, nh = 0, d = 0;
    for (let i = 0; i < N; i++) { const v = (c8[i * 3] + c8[i * 3 + 1] + c8[i * 3 + 2]) / 765; s += v; r += c8[i * 3]; g += c8[i * 3 + 1]; b += c8[i * 3 + 2];
      if (L.PY[i] < 0.45) { lo += v; nl++; } else if (L.PY[i] > 0.7) { hi += v; nh++; } }
    for (let i = 0; i < c8.length; i++) d += Math.abs(c8[i] - prev8[i]); prev8.set(c8);
    lum[f] = s / N; low[f] = lo / nl; high[f] = hi / nh; pdiff[f] = d / c8.length / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0; if (mx > mn) { h = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4; } hue[f] = ((h * 60) + 360) % 360;
    if (!cur.length || cur.at(-1).id !== D.showing) cur.push({ id: D.showing, t: now });
    if (V && (!states.length || states.at(-1).s !== V.state)) states.push({ s: V.state, t: now });
  }
  return { lum, hue, low, high, cur, states, pdiff, nF };
}

const partAt = t => T.parts.find(p => t >= p.t0 && t < p.t1)?.part || "end";
function metrics(R) {
  const { lum, low, high, pdiff, nF } = R, at = t => Math.max(0, Math.min(nF - 1, Math.round(t * FPS) - 1));
  const win = (a, t0, t1) => { const o = []; for (let f = at(t0); f <= at(t1); f++) o.push(a[f]); return o; };
  // kick response: peak in [k, k+120ms] vs trough in [k-120ms, k); lag = time of the biggest frame-to-frame rise after the kick
  const kc = [], lag = [];
  for (const k of T.kicks) { if (partAt(k) !== "drop") continue;
    const pk = Math.max(...win(lum, k, k + 0.12)), tr = Math.min(...win(lum, k - 0.12, k - 1 / FPS)); kc.push((pk - tr) / Math.max(1e-3, pk));
    let bf = 0, bd = -1; for (let f = at(k - 0.05); f <= at(k + 0.2); f++) { const dd = lum[f] - lum[f - 1]; if (dd > bd) { bd = dd; bf = f; } } lag.push(((bf + 1) / FPS - k) * 1000); }
  // snare response in builds: frame diff energy right after a snare vs right before
  const sc = []; for (const s of T.snares) { if (partAt(s) !== "build") continue; sc.push(mean(win(pdiff, s, s + 0.06)) - mean(win(pdiff, s - 0.06, s - 1 / FPS))); }
  // parts
  const lumOf = part => mean(T.parts.filter(p => p.part === part).flatMap(p => win(lum, p.t0 + 0.2, p.t1 - 0.2)));
  const builds = T.parts.filter(p => p.part === "build"), drops = T.parts.filter(p => p.part === "drop");
  const buildRise = builds.map(p => { const q = (p.t1 - p.t0) / 4; return f2(mean(win(lum, p.t1 - q, p.t1 - 0.5)) / Math.max(1e-3, mean(win(lum, p.t0, p.t0 + q)))); });
  const buildAct = builds.map(p => { const q = (p.t1 - p.t0) / 4; return f2(mean(win(pdiff, p.t1 - q, p.t1 - 0.5)) / Math.max(1e-4, mean(win(pdiff, p.t0, p.t0 + q)))); });
  const preDropDip = drops.map(p => f2(mean(win(lum, p.t0 - 0.4, p.t0 - 0.02)) / Math.max(1e-3, mean(win(lum, p.t0 - 2, p.t0 - 0.5)))));
  const dropImpact = drops.map(p => f2(Math.max(...win(lum, p.t0, p.t0 + 0.25)) / Math.max(1e-3, med(win(lum, p.t0 + 2, p.t1)))));
  // effect changes
  const ch = R.cur.slice(1).map(c => c.t), bar = T.bar, onDown = ch.filter(t => { const x = (t % bar) / bar; return x < 0.04 || x > 0.985; });
  const onPhrase = ch.filter(t => { const x = (t % (4 * bar)) / (4 * bar); return x < 0.01 || x > 0.996; }); // 4-bar phrase lines
  const perPart = {}; for (const p of T.parts) { const n = ch.filter(t => t >= p.t0 && t < p.t1).length; perPart[p.part] = (perPart[p.part] || 0) + n / ((p.t1 - p.t0) / bar); }
  for (const k in perPart) perPart[k] = f2(perPart[k] / T.parts.filter(p => p.part === k).length);
  // short-lived effects (< 1 bar) = flicker
  const short = R.cur.slice(1, -1).filter((c, i) => R.cur[i + 2].t - c.t < bar).length;
  // colour: hue jump at 4-bar phrase lines vs elsewhere (circular, frames 0.3 s apart)
  const hd = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const hueAt = [], hueOff = []; for (let t = 4 * bar; t < song.dur - 1; t += bar) { const j = hd(R.hue[at(t - 0.15)], R.hue[at(t + 0.15)]); if (Math.round(t / bar) % 4 === 0) hueAt.push(j); else hueOff.push(j); }
  // flicker: large luminance swings per second outside drops (|dL| > 0.12 within one frame)
  let flk = 0, flkN = 0; for (let f = 1; f < nF; f++) { const p = partAt((f + 1) / FPS); if (p === "drop") continue; flkN++; if (Math.abs(lum[f] - lum[f - 1]) > 0.12) flk++; }
  // spatial: on kicks, where does the added light go? low (floor/poles bottom) vs high (ceiling)
  const kLow = [], kHigh = []; for (const k of T.kicks) { if (partAt(k) !== "drop") continue; kLow.push(Math.max(...win(low, k, k + 0.12)) - Math.min(...win(low, k - 0.12, k - 0.02))); kHigh.push(Math.max(...win(high, k, k + 0.12)) - Math.min(...win(high, k - 0.12, k - 0.02))); }
  return { kickContrast: f2(med(kc)), kickContrastP10: f2([...kc].sort((a, b) => a - b)[Math.floor(kc.length * 0.1)]), kickLagMs: f2(med(lag)), snareActivityGain: f2(med(sc) * 1000),
    lum: { intro: f2(lumOf("intro")), build: f2(lumOf("build")), drop: f2(lumOf("drop")), break: f2(lumOf("break")), outro: f2(lumOf("outro")), silence: f2(lumOf("silence")) },
    buildRise, buildActivityRise: buildAct, preDropDip, dropImpact,
    changes: ch.length, changesPerBar: perPart, onDownbeat: f2(onDown.length / Math.max(1, ch.length)), on4BarPhrase: f2(onPhrase.length / Math.max(1, ch.length)), shortBlocks: short,
    hueJumpPhrase: f2(mean(hueAt)), hueJumpOther: f2(mean(hueOff)), flickerPerSecNonDrop: f2(flk / (flkN / FPS)),
    stateChanges: R.states.length, kickLowGain: f2(med(kLow)), kickHighGain: f2(med(kHigh)),
    effects: R.cur.map(c => `${c.t.toFixed(1)}:${c.id}`).join(" ") };
}

if (process.env.EXP) {
  // EXPERIMENT (harness only): 1) energy contour: auto-gain each frame toward a target level per song part;
  // 2) sidechain pump on kicks in drops so every drop effect breathes with the kick.
  const mk = (gainOn, pumpOn) => { let ema = 0.2, gEma = 1; return (col, V, t) => { if (!V) return;
    let m = 0; for (let i = 0; i < col.length; i++) m += Math.min(2, col[i]); m /= col.length; ema += (m - ema) * (1 - Math.exp(-(1 / FPS) / 1.5));
    const tgt = V.state === "drop" ? 0.32 : V.state === "build" ? 0.1 + 0.22 * (V.buildP || 0) : V.state === "silent" ? ema : 0.09;
    const g = gainOn ? Math.max(0.4, Math.min(2.5, tgt / Math.max(0.01, ema))) : 1; gEma += (g - gEma) * (1 - Math.exp(-(1 / FPS) / 0.5));
    const pump = pumpOn && V.state === "drop" ? 0.55 + 0.45 * Math.exp(-Math.max(0, t - V.kick) / 0.16) : 1;
    for (let i = 0; i < col.length; i++) col[i] *= gEma * pump; }; };
  for (const [name, a, b] of [["gain", 1, 0], ["pump", 0, 1], ["gain+pump", 1, 1]]) { const r = metrics(run("song", { post: mk(a, b) })); delete r.effects; console.error(name, JSON.stringify(r)); }
}
if (process.env.LIVEEXP) { const r = metrics(run("live", { settings: { style: "party" } })); console.error("live style=party", JSON.stringify({ ...r, effects: undefined })); console.error(r.effects); process.exit(0); }
out.song = metrics(run("song"));
out.songShow = metrics(run("song", { show: true }));
out.live = metrics(run("live"));
out.liveNoPredict = metrics(run("live", { predict: false }));
out.liveStates = run("live").states.map(s => `${s.t.toFixed(1)}:${s.s}`).join(" ");
console.log(JSON.stringify(out, null, 1));
