#!/usr/bin/env node
// Feel evaluation: how the lights follow a song. A one-minute synthetic EDM song with known parts and kicks
// (packages/engine/test/feel-song.js: intro, build, drop, breakdown, build, drop, outro, silence) goes through the
// real engine on the example room at 60 fps, twice:
//   whole-song mode: preAnalyseCore -> songView -> director -> effects (a file played in the app)
//   live mode:       LiveAnalyser -> view -> director -> effects (the microphone or line-in)
// and the brightness of every frame is measured against the truth. Zero dependencies; deterministic (Math.random
// is seeded while the engine runs).
//
//   node scripts/feel-eval.js                     # metrics, targets report
//   node scripts/feel-eval.js --json
//   node scripts/feel-eval.js --baseline check    # compare with packages/engine/test/baselines/feel.json (exit 1 if worse)
//   node scripts/feel-eval.js --baseline write    # save the baseline (after an intentional improvement)
//   node scripts/feel-eval.js --effects           # also list which effect showed when
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preAnalyseCore, buildLayout, exampleRoom, createEffects, createDirector, songView, LiveAnalyser, toRGB8 } from "../packages/engine/src/index.js";
import { rng } from "../packages/engine/test/synth.js";
import { feelSong } from "../packages/engine/test/feel-song.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE = path.join(root, "packages/engine/test/baselines/feel.json");
const FPS = 60;

const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * p)] : null; };
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const r3 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
const r1 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;

// ---------------------------------------------------------------- run the engine, record every frame
function runEngine(song, pre, L, mode) {
  const savedRandom = Math.random; Math.random = (r => () => (r() + 1) / 2)(rng(42)); // effects use Math.random: seed it
  try {
    const N = L.N, fx = createEffects(L), D = createDirector(L, fx);
    const an = mode === "live" ? new LiveAnalyser(song.sr) : null, chunk = Math.round(song.sr / FPS);
    const nF = Math.floor(song.dur * FPS), lum = new Float32Array(nF), cur = [], states = [], c8 = new Uint8Array(N * 3);
    let pos = 0;
    for (let f = 0; f < nF; f++) {
      const now = (f + 1) / FPS; // the moment the frame is shown, on the audio clock (no network or LED delay)
      let V, t, extra = {};
      if (an) {
        an.push(song.x.subarray(pos, Math.min(song.x.length, pos + chunk))); pos += chunk;
        t = an.t; V = an.view(t, { predict: true }); extra = an.extras();
        if (V.state === "silent" && V.quietFor > 8) V = null; // the runtime's idle fade (idleAfterSec default 8)
      } else { t = now; V = songView(pre, t); }
      const col = D.frame(V, t, extra, now); toRGB8(col, c8, 0.8);
      let s = 0; for (let i = 0; i < c8.length; i++) s += c8[i]; lum[f] = s / c8.length / 255;
      if (!cur.length || cur.at(-1).id !== D.showing) cur.push({ id: D.showing, t: now });
      if (V && (!states.length || states.at(-1).s !== V.state)) states.push({ s: V.state, t: now });
    }
    return { lum, cur, states, nF };
  } finally { Math.random = savedRandom; }
}

// ---------------------------------------------------------------- metrics
function measure(R, T, dur) {
  const { lum, nF } = R, at = t => Math.max(1, Math.min(nF - 1, Math.round(t * FPS) - 1));
  const win = (t0, t1) => { const o = []; for (let f = at(t0); f <= at(t1); f++) o.push(lum[f]); return o; };
  const partAt = t => T.parts.find(p => t >= p.t0 && t < p.t1)?.part || "end";
  // kicks in the drops: contrast = (peak in the 120 ms after the kick - trough in the 120 ms before) / peak;
  // lag = when the biggest frame-to-frame rise near the kick happens
  const kc = [], lag = [];
  for (const k of T.kicks) {
    if (partAt(k) !== "drop") continue;
    const pk = Math.max(...win(k, k + 0.12)), tr = Math.min(...win(k - 0.12, k - 1 / FPS)); kc.push((pk - tr) / Math.max(1e-3, pk));
    let bf = 0, bd = -Infinity; for (let f = at(k - 0.05); f <= at(k + 0.2); f++) { const d = lum[f] - lum[f - 1]; if (d > bd) { bd = d; bf = f; } }
    lag.push(((bf + 1) / FPS - k) * 1000);
  }
  const lumOf = part => mean(T.parts.filter(p => p.part === part).flatMap(p => win(p.t0 + 0.2, p.t1 - 0.2)));
  const drops = T.parts.filter(p => p.part === "drop");
  // pre-drop dip: the last 0.4 s before a drop against the 1.5 s before that (a dip makes the drop hit harder)
  const preDropDip = drops.map(p => r3(mean(win(p.t0 - 0.4, p.t0 - 0.02)) / Math.max(1e-3, mean(win(p.t0 - 2, p.t0 - 0.5)))));
  // drop impact: the brightest frame in the first 0.25 s of a drop against the drop's typical brightness
  const dropImpact = drops.map(p => r3(Math.max(...win(p.t0, p.t0 + 0.25)) / Math.max(1e-3, med(win(p.t0 + 2, p.t1)))));
  // effect changes: on a downbeat (within -28/+75 ms of a bar line) and on a 4-bar line (within -30/+75 ms)
  const ch = R.cur.slice(1).map(c => c.t), bar = T.bar;
  const near = (t, len, before, after) => { const x = ((t % len) + len) % len; return x <= after || len - x <= before; };
  const onDown = ch.filter(t => near(t, bar, 0.03, 0.075)).length, on4 = ch.filter(t => near(t, 4 * bar, 0.03, 0.075)).length;
  const short = R.cur.slice(1, -1).filter((c, i) => R.cur[i + 2].t - c.t < bar - 0.05).length; // an effect that showed for less than a bar
  return {
    kickContrast: r3(med(kc)), kickContrastP10: r3(pctl(kc, 0.1)), kickLagMs: r1(med(lag)),
    lum: Object.fromEntries(["intro", "build", "drop", "break", "outro", "silence"].map(p => [p, r3(lumOf(p))])),
    dropBreak: r3(lumOf("drop") / Math.max(1e-3, lumOf("break"))),
    preDropDip, preDropDipWorst: r3(Math.max(...preDropDip)), dropImpact, dropImpactMin: r3(Math.min(...dropImpact)),
    changes: ch.length, onDownbeat: ch.length ? r3(onDown / ch.length) : null, on4Bar: ch.length ? r3(on4 / ch.length) : null, shortEffects: short,
  };
}
// live: when does the analyser call the drop? The first "drop" within a bar before to 4 bars after a true drop is
// that drop (delay = how late); any other switch into "drop" is a false drop.
function liveDrops(states, T) {
  const drops = T.parts.filter(p => p.part === "drop"), entries = states.filter(s => s.s === "drop").map(s => s.t), used = new Set(), delays = [];
  for (const p of drops) {
    const i = entries.findIndex((t, k) => !used.has(k) && t >= p.t0 - T.bar && t <= p.t0 + 4 * T.bar);
    if (i < 0) delays.push(null); else { used.add(i); delays.push(r1((entries[i] - p.t0) * 1000)); }
  }
  const got = delays.filter(d => d != null);
  return { dropDelayMs: delays, dropDelayWorstMs: got.length ? Math.max(...got) : null, missedDrops: delays.length - got.length, falseDrops: entries.length - used.size };
}

/** Run the whole evaluation. */
export async function runFeel({ effects = false } = {}) {
  const song = feelSong(), T = song.truth, L = buildLayout(exampleRoom());
  const pre = await preAnalyseCore(song.x, song.sr);
  const S = runEngine(song, pre, L, "song"), Lv = runEngine(song, pre, L, "live");
  const sm = measure(S, T, song.dur), lm = measure(Lv, T, song.dur), ld = liveDrops(Lv.states, T);
  const truthDrops = T.parts.filter(p => p.part === "drop").map(p => r3(p.t0));
  const out = {
    song: { seconds: r1(song.dur), bpm: T.bpm, drops: truthDrops },
    analysis: { bpm: r3(pre.bpm), bpmOk: Math.abs(pre.bpm / T.bpm - 1) <= 0.02, drops: (pre.drops || []).map(r3), style: pre.style },
    whole: sm,
    live: { ...lm, ...ld },
  };
  if (effects) { out.whole.effects = S.cur.map(c => `${c.t.toFixed(2)}:${c.id}`).join(" "); out.live.effects = Lv.cur.map(c => `${c.t.toFixed(2)}:${c.id}`).join(" "); out.live.states = Lv.states.map(s => `${s.t.toFixed(2)}:${s.s}`).join(" "); }
  return out;
}

// ---------------------------------------------------------------- targets (roadmap) and baseline
/** The roadmap's aims. main doesn't meet them all yet: they are a progress report, not a test. */
export const TARGETS = [
  ["analysis BPM within 2% of the truth", r => r.analysis.bpmOk, v => v === true, "yes"],
  ["drop kick contrast, median", r => r.whole.kickContrast, v => v >= 0.40, ">= 0.40"],
  ["drop kick contrast, 10th percentile", r => r.whole.kickContrastP10, v => v >= 0.25, ">= 0.25"],
  ["effect changes on a downbeat", r => r.whole.onDownbeat, v => v >= 0.90, ">= 90%"],
  ["effect changes on a 4-bar line", r => r.whole.on4Bar, v => v >= 0.75, ">= 75%"],
  ["effects shorter than one bar", r => r.whole.shortEffects, v => v === 0, "0"],
  ["drop / breakdown brightness", r => r.whole.dropBreak, v => v >= 1.8, ">= 1.8"],
  ["pre-drop dip (worst drop)", r => r.whole.preDropDipWorst, v => v <= 0.7, "<= 0.7"],
  ["live drop delay (worst drop, ms)", r => r.live.missedDrops ? null : r.live.dropDelayWorstMs, v => v != null && v <= 150, "<= 150"],
];
export function targetReport(r) { return TARGETS.map(([name, get, ok, aim]) => { const v = get(r); return { name, value: v, aim, pass: v != null && ok(v) }; }); }

// [label, getter, worse(now, base)] — "no worse than the baseline by a margin"
const H = (m) => (n, b) => n < b - m, Lo = (m) => (n, b) => n > b + m;
export const GUARDS = [
  ["analysis BPM within 2%", r => r.analysis.bpmOk, (n, b) => b === true && n !== true],
  ["whole: kick contrast median", r => r.whole.kickContrast, H(0.05)],
  ["whole: kick contrast p10", r => r.whole.kickContrastP10, H(0.05)],
  ["whole: kick-to-light lag ms", r => r.whole.kickLagMs, Lo(17)],
  ["whole: changes on downbeat", r => r.whole.onDownbeat, H(0.1)],
  ["whole: changes on 4-bar line", r => r.whole.on4Bar, H(0.1)],
  ["whole: effects shorter than a bar", r => r.whole.shortEffects, Lo(1)],
  ["whole: drop / breakdown brightness", r => r.whole.dropBreak, (n, b) => n < b * 0.85],
  ["whole: pre-drop dip (worst)", r => r.whole.preDropDipWorst, Lo(0.15)],
  ["whole: drop impact (weakest)", r => r.whole.dropImpactMin, (n, b) => n < b * 0.8],
  ["live: kick contrast median", r => r.live.kickContrast, H(0.05)],
  ["live: drop delay ms (worst)", r => r.live.dropDelayWorstMs, Lo(150)],
  ["live: missed drops", r => r.live.missedDrops, Lo(0)],
  ["live: false drops", r => r.live.falseDrops, Lo(1)],
  ["live: effect changes", r => r.live.changes, (n, b) => n > b * 1.25 + 2],
  ["live: effects shorter than a bar", r => r.live.shortEffects, (n, b) => n > b * 1.25 + 2],
];
/** Each guard: ok unless the value got worse than the baseline by more than its margin. A value that is missing now
 *  (no drop found) but was there in the baseline counts as worse. */
export function checkBaseline(r, base) {
  return GUARDS.map(([name, get, worse]) => {
    const n = get(r), b = get(base);
    const bad = b == null ? false : n == null ? true : worse(n, b);
    return { name, now: n, base: b, ok: !bad };
  });
}
export function readBaseline(file = BASELINE) { return JSON.parse(readFileSync(file, "utf8")); }

// ---------------------------------------------------------------- main
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), mi = args.indexOf("--baseline"), mode = mi >= 0 ? args[mi + 1] : null;
  if (mode && !["write", "check"].includes(mode)) { console.error("--baseline write|check"); process.exit(2); }
  const t0 = performance.now(), r = await runFeel({ effects: args.includes("--effects") }), tg = targetReport(r);
  if (mode === "write") { const { effects: _a, ...w } = r.whole, { effects: _b, states: _c, ...l } = r.live; mkdirSync(path.dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, JSON.stringify({ about: "Feel baseline (scripts/feel-eval.js). Rewrite with: npm run eval:feel -- --baseline write", ...r, whole: w, live: l }, null, 1) + "\n"); }
  const chk = mode === "check" ? checkBaseline(r, readBaseline()) : null;
  if (args.includes("--json")) { console.log(JSON.stringify({ ...r, targets: tg, ...(chk ? { baseline: chk } : {}) }, null, 1)); }
  else {
    const v = x => x == null ? "-" : Array.isArray(x) ? x.map(v).join(", ") : String(x);
    console.log(`song: ${r.song.seconds} s at ${r.song.bpm} BPM, drops at ${v(r.song.drops)} s`);
    console.log(`analysis: ${r.analysis.bpm} BPM (${r.analysis.bpmOk ? "right" : "wrong"}), drops at ${v(r.analysis.drops)} s, style ${r.analysis.style}`);
    for (const [label, m] of [["whole song", r.whole], ["live", r.live]]) {
      console.log(`\n${label}:`);
      console.log(`  kick contrast median ${v(m.kickContrast)}, p10 ${v(m.kickContrastP10)}; kick-to-light lag ${v(m.kickLagMs)} ms`);
      console.log(`  brightness: ${Object.entries(m.lum).map(([k, x]) => `${k} ${v(x)}`).join(", ")}; drop/breakdown ${v(m.dropBreak)}`);
      console.log(`  pre-drop dip ${v(m.preDropDip)}; drop impact ${v(m.dropImpact)}`);
      console.log(`  effect changes ${m.changes}: on downbeat ${v(m.onDownbeat)}, on 4-bar line ${v(m.on4Bar)}; shorter than a bar ${m.shortEffects}`);
      if (m.dropDelayMs) console.log(`  drop delay ${v(m.dropDelayMs)} ms; missed ${m.missedDrops}; false drops ${m.falseDrops}`);
      if (m.effects) console.log(`  effects: ${m.effects}`); if (m.states) console.log(`  states: ${m.states}`);
    }
    console.log(`\ntargets (roadmap): ${tg.filter(x => x.pass).length}/${tg.length} met`);
    for (const x of tg) console.log(`  ${x.pass ? "PASS" : "FAIL"}  ${x.name.padEnd(38)} ${v(x.value).padEnd(8)} aim ${x.aim}`);
    if (chk) { console.log(`\nbaseline check: ${chk.every(c => c.ok) ? "OK" : "WORSE"}`); for (const c of chk) console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(36)} ${v(c.now).padEnd(8)} baseline ${v(c.base)}`); }
    if (mode === "write") console.log(`\nbaseline written: ${path.relative(root, BASELINE)}`);
    console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
  if (chk && !chk.every(c => c.ok)) process.exit(1);
}
