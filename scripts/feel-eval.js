#!/usr/bin/env node
// Feel evaluation: how the lights follow a song. A one-minute synthetic EDM song with known parts and kicks
// (packages/engine/test/feel-song.js: intro, build, drop, breakdown, build, drop, outro, silence) goes through the
// real engine on the example room at 60 fps, twice:
//   whole-song mode: preAnalyseCore -> songView -> director -> effects (a file played in the app)
//   live mode:       LiveAnalyser -> view -> director -> effects (the microphone or line-in)
// and the brightness of every frame is measured against the truth. Zero dependencies; deterministic (Math.random
// is seeded while the engine runs). Both run for each variety of automatic mode: "show" (whole, live: effects change
// with the song), and "one" and "parts" (varieties.one / varieties.parts: the song's look, looks.js; whole-song mode
// gets it from pickLook(), live mode picks its own as it listens).
// The drop countdown (drops.js) is measured too: on the feel song and four more synthetic songs (synth.js edm(),
// long-edm.js, majorPop(), minorBallad()) through the LiveAnalyser alone, how long before each drop the prediction
// (dropConf 0.5 or more) already had the right time, and how many predictions were wrong; and in every run, the build
// ramp: how much brighter the last bar of a build-up is than its first.
//
//   node scripts/feel-eval.js                     # metrics, targets report
//   node scripts/feel-eval.js --json
//   node scripts/feel-eval.js --baseline check    # compare with packages/engine/test/baselines/feel.json (exit 1 if worse)
//   node scripts/feel-eval.js --baseline write    # save the baseline (after an intentional improvement)
//   node scripts/feel-eval.js --effects           # also list which effect showed when
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preAnalyseCore, buildLayout, exampleRoom, createEffects, createDirector, songView, LiveAnalyser, toRGB8, pickLook } from "../packages/engine/src/index.js";
import { rng, edm, majorPop, minorBallad } from "../packages/engine/test/synth.js";
import { longEdm } from "../packages/engine/test/long-edm.js";
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
export function runEngine(song, pre, L, mode, variety = "show") {
  const savedRandom = Math.random; Math.random = (r => () => (r() + 1) / 2)(rng(42)); // effects use Math.random: seed it
  try {
    const N = L.N, fx = createEffects(L), D = createDirector(L, fx);
    D.settings.variety = variety;
    if (variety !== "show" && mode !== "live") D.settings.look = pickLook(pre, { seed: "feel", available: fx.list.map(e => e.id) });
    const an = mode === "live" ? new LiveAnalyser(song.sr) : null, chunk = Math.round(song.sr / FPS);
    const nF = Math.floor(song.dur * FPS), lum = new Float32Array(nF), cur = [], states = [], c8 = new Uint8Array(N * 3), pred = [];
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
      if (an) pred.push([t, V ? V.nextDrop : null, V ? V.dropConf || 0 : 0]);
    }
    return { lum, cur, states, nF, pred, look: D.look ? { ...D.look } : null };
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
  // build ramp: a build-up's last bar (without its last beat, the planned dip) against its first bar
  const buildRamp = T.parts.filter((p, i) => p.part === "build" && T.parts[i + 1]?.part === "drop").map(p => r3(mean(win(p.t1 - bar, p.t1 - T.beat)) / Math.max(1e-3, mean(win(p.t0 + 0.05, p.t0 + bar)))));
  return {
    kickContrast: r3(med(kc)), kickContrastP10: r3(pctl(kc, 0.1)), kickLagMs: r1(med(lag)),
    lum: Object.fromEntries(["intro", "build", "drop", "break", "outro", "silence"].map(p => [p, r3(lumOf(p))])),
    dropBreak: r3(lumOf("drop") / Math.max(1e-3, lumOf("break"))),
    preDropDip, preDropDipWorst: r3(Math.max(...preDropDip)), dropImpact, dropImpactMin: r3(Math.min(...dropImpact)),
    buildRamp, buildRampMin: r3(Math.min(...buildRamp)),
    changes: ch.length, changesPerMin: r1(ch.length / (dur / 60)), onDownbeat: ch.length ? r3(onDown / ch.length) : null, on4Bar: ch.length ? r3(on4 / ch.length) : null, shortEffects: short,
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

// the drop countdown: pred = [[t, nextDrop, dropConf]] on the analyser's clock. A prediction counts once dropConf is
// 0.5 or more. lead: how long before a true drop the prediction had already been right (within 0.25 s) without a
// break; first: how long before it the first warning came (a countdown that ended at this drop); a run of predictions
// (with no break) that didn't end at a true drop is a false one.
export function countdown(pred, drops) {
  const runs = []; let cur = null;
  for (const [t, at, c] of pred) { if (at != null && c >= 0.5) { if (!cur) runs.push(cur = { t0: t, items: [] }); cur.items.push([t, at]); } else cur = null; }
  const lead = [], first = []; let falseN = 0;
  for (const r of runs) { const last = r.items.at(-1)[1]; if (!drops.some(d => Math.abs(d - last) < 0.3)) falseN++; }
  for (const d of drops) {
    const r = runs.find(x => Math.abs(x.items.at(-1)[1] - d) < 0.3 && x.items.at(-1)[0] >= d - 1);
    if (!r) { lead.push(0); first.push(0); continue; }
    let k = r.items.length - 1; while (k > 0 && Math.abs(r.items[k - 1][1] - d) < 0.25) k--;
    lead.push(r1(Math.max(0, d - r.items[k][0]))); first.push(r1(Math.max(0, d - r.t0)));
  }
  return { lead, first, falseN };
}
function listenOnly(song) { const an = new LiveAnalyser(song.sr), chunk = Math.round(song.sr / FPS), pred = [];
  for (let i = 0; i < song.x.length; i += chunk) { an.push(song.x.subarray(i, i + chunk)); const t = an.t, V = an.view(t); pred.push([t, V.nextDrop, V.dropConf || 0]); }
  return pred; }
/** The drop countdown on the other test songs (the feel song's is measured in its live run). */
export function countdownSongs() {
  const out = {}, e = edm(22050), L = longEdm(22050);
  out.edm = countdown(listenOnly(e), [e.dropStart]);
  out.longEdm = countdown(listenOnly(L), L.truth.parts.filter(p => p.part === "drop").map(p => p.t0));
  out.majorPop = countdown(listenOnly(majorPop(22050)), []);
  out.ballad = countdown(listenOnly(minorBallad(22050)), []);
  return out;
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
  { const fc = countdown(Lv.pred, truthDrops), so = countdownSongs(), edmLeads = [...fc.lead, ...so.edm.lead, ...so.longEdm.lead];
    out.countdown = { feel: fc, ...so, leadMin: Math.min(...edmLeads), leadMedian: r1(med(edmLeads)), falseEdm: fc.falseN + so.edm.falseN + so.longEdm.falseN, falseCalm: so.majorPop.falseN + so.ballad.falseN }; }
  const fxs = R => R.cur.map(c => `${c.t.toFixed(2)}:${c.id}`).join(" ");
  if (effects) { out.whole.effects = fxs(S); out.live.effects = fxs(Lv); out.live.states = Lv.states.map(s => `${s.t.toFixed(2)}:${s.s}`).join(" "); }
  out.varieties = {};
  for (const v of ["one", "parts"]) {
    const Sv = runEngine(song, pre, L, "song", v), Lvv = runEngine(song, pre, L, "live", v), lw = measure(Lvv, T, song.dur);
    out.varieties[v] = { look: Sv.look && [Sv.look.main, Sv.look.drop, Sv.look.build, Sv.look.calm, Sv.look.palette].join("/"), liveLook: Lvv.look && [Lvv.look.main, Lvv.look.palette].join("/"),
      whole: measure(Sv, T, song.dur), live: { ...lw, ...liveDrops(Lvv.states, T) } };
    if (effects) { out.varieties[v].whole.effects = fxs(Sv); out.varieties[v].live.effects = fxs(Lvv); }
  }
  return out;
}

// ---------------------------------------------------------------- real music (local only)
// TEMPOLIGHT_REAL_AUDIO: a folder of your own songs as 16-bit mono .wav files (or one file). Never committed, never in
// the baseline: a report only, skipped when the variable is unset. Per song: the share of time in each song part, how
// often the style changed after it was first chosen, and when a countdown (dropConf 0.5 or more, the drop within 8 s)
// first showed. Aims: "build" at most 15% of a song, at most 1 style change, no countdowns on hip hop or acoustic songs.
export function realMusic(dir = process.env.TEMPOLIGHT_REAL_AUDIO) {
  if (!dir || !existsSync(dir)) return null;
  const files = statSync(dir).isDirectory() ? readdirSync(dir).filter(f => /\.wav$/i.test(f)).sort().map(f => path.join(dir, f)) : [dir];
  return files.map(file => {
    const buf = readFileSync(file), sr = buf.readUInt32LE(24), n = (buf.length - 44) >> 1, x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = buf.readInt16LE(44 + 2 * i) / 32768;
    const an = new LiveAnalyser(sr), parts = {}, cds = []; let on = false, last = null, changes = 0, k = 0;
    for (let i = 0; i < n; i += 512) {
      an.push(x.subarray(i, i + 512)); const t = i / sr; if (t < 3) continue; const V = an.view(an.sampleT);
      if (++k % 43 === 0) { parts[V.state] = (parts[V.state] || 0) + 1; if (V.styleSure) { if (last && V.style !== last) changes++; last = V.style; } }
      const lead = V.nextDrop != null ? V.nextDrop - an.sampleT : null, show = lead != null && V.dropConf >= 0.5 && lead <= 8 && lead > 0;
      if (show && !on) cds.push(Math.round(t)); on = show;
    }
    const tot = Object.values(parts).reduce((a, b) => a + b, 0) || 1, pc = p => Math.round(100 * (parts[p] || 0) / tot);
    return { song: path.basename(file, ".wav"), seconds: Math.round(n / sr), style: last, styleChanges: changes, build: pc("build"), drop: pc("drop"), calm: pc("calm"), countdowns: cds };
  });
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
  ["live pre-drop dip (worst drop)", r => r.live.preDropDipWorst, v => v <= 0.7, "<= 0.7"],
  ["build ramp, last bar / first bar (worst)", r => r.whole.buildRampMin, v => v >= 1.5, ">= 1.5"],
  ["live build ramp, last bar / first bar (worst)", r => r.live.buildRampMin, v => v >= 1.5, ">= 1.5"],
  ["drop countdown lead, EDM songs (shortest, s)", r => r.countdown?.leadMin, v => v >= 2, ">= 2"],
  ["drop countdown: false predictions, pop + ballad", r => r.countdown?.falseCalm, v => v === 0, "0"],
];
export function targetReport(r) { return TARGETS.map(([name, get, ok, aim]) => { const v = get(r); return { name, value: v, aim, pass: v != null && ok(v) }; }); }
/** The aims that apply to a look (varieties "one" and "parts"): the feel must be as strong with one effect, and
 *  "one" must hardly change effect. These are tested (feel.test.js). */
export const VARIETY_TARGETS = [
  ["drop kick contrast, median", m => m.whole.kickContrast, v => v >= 0.40, ">= 0.40"],
  ["drop kick contrast, 10th percentile", m => m.whole.kickContrastP10, v => v >= 0.25, ">= 0.25"],
  ["drop / breakdown brightness", m => m.whole.dropBreak, v => v >= 1.8, ">= 1.8"],
  ["pre-drop dip (worst drop)", m => m.whole.preDropDipWorst, v => v <= 0.7, "<= 0.7"],
  ["effects shorter than one bar", m => m.whole.shortEffects, v => v === 0, "0"],
  ["live: effects shorter than one bar", m => m.live.shortEffects, v => v === 0, "0"],
  ["live: drop kick contrast, median", m => m.live.kickContrast, v => v >= 0.40, ">= 0.40"],
  ["build ramp, last bar / first bar (worst)", m => m.whole.buildRampMin, v => v >= 1.5, ">= 1.5"],
  ["live: build ramp, last bar / first bar (worst)", m => m.live.buildRampMin, v => v >= 1.5, ">= 1.5"],
];
const CPM = { one: 2, parts: 8 }; // effect changes a minute at most, whole song and live
export function varietyReport(r) {
  const out = [];
  for (const [v, m] of Object.entries(r.varieties || {})) {
    for (const [name, get, ok, aim] of VARIETY_TARGETS) { const x = get(m); out.push({ variety: v, name, value: x, aim, pass: x != null && ok(x) }); }
    for (const k of ["whole", "live"]) { const x = m[k].changesPerMin; out.push({ variety: v, name: `${k === "live" ? "live: " : ""}effect changes per minute`, value: x, aim: `<= ${CPM[v]}`, pass: x != null && x <= CPM[v] }); }
  }
  return out;
}

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
  ["live: pre-drop dip (worst)", r => r.live.preDropDipWorst, Lo(0.15)],
  ["whole: build ramp (worst)", r => r.whole.buildRampMin, H(0.15)],
  ["live: build ramp (worst)", r => r.live.buildRampMin, H(0.15)],
  ["countdown: lead on EDM songs (shortest, s)", r => r.countdown?.leadMin, H(0.5)],
  ["countdown: lead on EDM songs (median, s)", r => r.countdown?.leadMedian, H(0.5)],
  ["countdown: false predictions on EDM songs", r => r.countdown?.falseEdm, Lo(0)],
  ["countdown: false predictions on pop and ballad", r => r.countdown?.falseCalm, Lo(0)],
  ...["one", "parts"].flatMap(v => [
    [`${v}: kick contrast median`, r => r.varieties?.[v]?.whole.kickContrast, H(0.05)],
    [`${v}: drop / breakdown brightness`, r => r.varieties?.[v]?.whole.dropBreak, (n, b) => n < b * 0.85],
    [`${v}: pre-drop dip (worst)`, r => r.varieties?.[v]?.whole.preDropDipWorst, Lo(0.15)],
    [`${v}: drop impact (weakest)`, r => r.varieties?.[v]?.whole.dropImpactMin, (n, b) => n < b * 0.8],
    [`${v}: effect changes`, r => r.varieties?.[v]?.whole.changes, Lo(1)],
    [`${v}: live kick contrast median`, r => r.varieties?.[v]?.live.kickContrast, H(0.05)],
    [`${v}: live effect changes`, r => r.varieties?.[v]?.live.changes, Lo(1)],
  ]),
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
  if (mode === "write") { const strip = m => { const { effects: _a, states: _b, ...x } = m; return x; }; mkdirSync(path.dirname(BASELINE), { recursive: true });
    const vs = Object.fromEntries(Object.entries(r.varieties || {}).map(([k, m]) => [k, { ...m, whole: strip(m.whole), live: strip(m.live) }]));
    writeFileSync(BASELINE, JSON.stringify({ about: "Feel baseline (scripts/feel-eval.js). Rewrite with: npm run eval:feel -- --baseline write", ...r, whole: strip(r.whole), live: strip(r.live), varieties: vs }, null, 1) + "\n"); }
  const chk = mode === "check" ? checkBaseline(r, readBaseline()) : null;
  if (args.includes("--json")) { console.log(JSON.stringify({ ...r, targets: tg, looks: varietyReport(r), ...(chk ? { baseline: chk } : {}) }, null, 1)); }
  else {
    const v = x => x == null ? "-" : Array.isArray(x) ? x.map(v).join(", ") : String(x);
    console.log(`song: ${r.song.seconds} s at ${r.song.bpm} BPM, drops at ${v(r.song.drops)} s`);
    console.log(`analysis: ${r.analysis.bpm} BPM (${r.analysis.bpmOk ? "right" : "wrong"}), drops at ${v(r.analysis.drops)} s, style ${r.analysis.style}`);
    const runs = [["whole song", r.whole], ["live", r.live]];
    for (const [k, m] of Object.entries(r.varieties || {})) runs.push([`variety "${k}", whole song (look ${m.look})`, m.whole], [`variety "${k}", live (look ${m.liveLook})`, m.live]);
    for (const [label, m] of runs) {
      console.log(`\n${label}:`);
      console.log(`  kick contrast median ${v(m.kickContrast)}, p10 ${v(m.kickContrastP10)}; kick-to-light lag ${v(m.kickLagMs)} ms`);
      console.log(`  brightness: ${Object.entries(m.lum).map(([k, x]) => `${k} ${v(x)}`).join(", ")}; drop/breakdown ${v(m.dropBreak)}`);
      console.log(`  pre-drop dip ${v(m.preDropDip)}; drop impact ${v(m.dropImpact)}`);
      console.log(`  effect changes ${m.changes} (${v(m.changesPerMin)} a minute): on downbeat ${v(m.onDownbeat)}, on 4-bar line ${v(m.on4Bar)}; shorter than a bar ${m.shortEffects}`);
      console.log(`  build ramp (last bar / first bar of each build-up) ${v(m.buildRamp)}`);
      if (m.dropDelayMs) console.log(`  drop delay ${v(m.dropDelayMs)} ms; missed ${m.missedDrops}; false drops ${m.falseDrops}`);
      if (m.effects) console.log(`  effects: ${m.effects}`); if (m.states) console.log(`  states: ${m.states}`);
    }
    if (r.countdown) { const c = r.countdown; console.log(`\ndrop countdown (live): right time ahead of each drop (s), first warning (s), false predictions`);
      for (const k of ["feel", "edm", "longEdm", "majorPop", "ballad"]) console.log(`  ${k.padEnd(9)} lead ${v(c[k].lead)}; first ${v(c[k].first)}; false ${c[k].falseN}`);
      console.log(`  EDM songs: shortest lead ${v(c.leadMin)} s, median ${v(c.leadMedian)} s; false: EDM ${c.falseEdm}, pop + ballad ${c.falseCalm}`); }
    console.log(`\ntargets (roadmap): ${tg.filter(x => x.pass).length}/${tg.length} met`);
    for (const x of tg) console.log(`  ${x.pass ? "PASS" : "FAIL"}  ${x.name.padEnd(38)} ${v(x.value).padEnd(8)} aim ${x.aim}`);
    const vr = varietyReport(r); console.log(`\nlooks (varieties one, parts): ${vr.filter(x => x.pass).length}/${vr.length} met`);
    for (const x of vr) console.log(`  ${x.pass ? "PASS" : "FAIL"}  ${(x.variety + ": " + x.name).padEnd(44)} ${v(x.value).padEnd(8)} aim ${x.aim}`);
    if (chk) { console.log(`\nbaseline check: ${chk.every(c => c.ok) ? "OK" : "WORSE"}`); for (const c of chk) console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(36)} ${v(c.now).padEnd(8)} baseline ${v(c.base)}`); }
    const rm = realMusic();
    if (rm) { console.log(`\nreal music (TEMPOLIGHT_REAL_AUDIO): build <= 15%, style changes <= 1, countdowns only for EDM`);
      for (const m of rm) console.log(`  ${m.song.padEnd(22)} ${String(m.seconds).padStart(4)} s  ${String(m.style).padEnd(9)} changes ${m.styleChanges}  build ${String(m.build).padStart(2)}%  drop ${String(m.drop).padStart(2)}%  calm ${String(m.calm).padStart(3)}%  countdowns ${m.countdowns.join(", ") || "none"}${m.build > 15 || m.styleChanges > 1 ? "  (over the aim)" : ""}`); }
    if (mode === "write") console.log(`\nbaseline written: ${path.relative(root, BASELINE)}`);
    console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
  if (chk && !chk.every(c => c.ok)) process.exit(1);
}
