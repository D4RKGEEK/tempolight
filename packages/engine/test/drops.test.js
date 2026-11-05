import test from "node:test";
import assert from "node:assert/strict";
import { LiveAnalyser, songView, preAnalyseCore, createDirector, createEffects, buildLayout, exampleRoom, metronomeView } from "../src/index.js";
import { DropPredictor } from "../src/drops.js";
import { edm, majorPop, minorBallad } from "./synth.js";
import { feelSong } from "./feel-song.js";

// listen to a song live, 60 times a second; every frame's [t, nextDrop, dropConf]
function listen(song) {
  const an = new LiveAnalyser(song.sr), chunk = Math.round(song.sr / 60), out = [];
  for (let i = 0; i < song.x.length; i += chunk) { an.push(song.x.subarray(i, i + chunk)); const V = an.view(an.t); out.push([an.t, V.nextDrop, V.dropConf, V.dropSource]); }
  return { an, out };
}
// how long before drop d a sure prediction (conf >= 0.5) was already within 0.25 s of it, without a break
function lead(out, d) {
  let i = out.findIndex(([t]) => t >= d - 0.05); if (i < 0) return 0; let t0 = null;
  for (i--; i >= 0; i--) { const [t, at, c] = out[i]; if (at != null && c >= 0.5 && Math.abs(at - d) < 0.25) t0 = t; else break; }
  return t0 == null ? 0 : d - t0;
}
const sure = out => out.filter(([, at, c]) => at != null && c >= 0.5);

test("drop countdown: a build-up's drop is predicted live seconds ahead, on the beat", () => {
  const s = feelSong(), drops = s.truth.parts.filter(p => p.part === "drop").map(p => p.t0), { out } = listen(s);
  for (const d of drops) assert.ok(lead(out, d) >= 2, `drop at ${d}: right ${lead(out, d).toFixed(2)} s ahead`);
  const e = edm(22050), r = listen(e); assert.ok(lead(r.out, e.dropStart) >= 2, `edm(): ${lead(r.out, e.dropStart).toFixed(2)} s ahead`);
  assert.ok(out.every(([, at, , src]) => at == null ? src === null : src === "predicted"), "dropSource is predicted when there is a prediction");
});

test("drop countdown: no predictions in pop without build-ups or in a ballad", () => {
  for (const s of [majorPop(22050), minorBallad(22050)]) assert.equal(sure(listen(s).out).length, 0);
});

test("drop countdown: predictions don't flap, and a build-up that fizzles out cancels cleanly", () => {
  const s = feelSong(), { out } = listen(s);
  // each run of predictions changes its time at most twice (the phrase line, then the pre-drop dip)
  let runs = 0, changes = 0, worst = 0, prev = null;
  for (const [, at, c] of out) { const on = at != null && c >= 0.5; if (on && !prev) { runs++; changes = 0; } else if (on && Math.abs(at - prev) > 0.05) worst = Math.max(worst, ++changes); prev = on ? at : null; }
  assert.equal(runs, 2); assert.ok(worst <= 2, `changes in a run: ${worst}`);
  // a build-up that goes into a breakdown instead of a drop: the prediction ends a moment after the time it gave
  const f = feelSong(22050, 128, [["intro", 4], ["build", 4], ["break", 6], ["silence", 2]]), bar = f.truth.bar, end = 8 * bar, r = listen(f);
  const after = r.out.filter(([t]) => t > end + bar && t < end + 5 * bar);
  assert.ok(after.every(([, at]) => at == null), "nothing predicted once the build-up fizzled");
  const conf = r.out.filter(([, at]) => at != null).map(([, , c]) => c); assert.ok(conf.every(c => c >= 0 && c <= 1));
});

test("drop countdown: the predictor alone starts empty and resets", () => {
  const p = new DropPredictor(); assert.equal(p.next, null); assert.equal(p.conf, 0);
  const an = new LiveAnalyser(22050), s = feelSong(); an.push(s.x.subarray(0, 14 * 22050)); assert.ok(an.drops.next != null && an.drops.conf > 0.5, "predicting before the first drop");
  an.reset(); assert.equal(an.drops.next, null); assert.equal(an.view().nextDrop, null); assert.equal(an.view().dropConf, 0);
});

test("whole-song analysis: the next drop is known (dropConf 1, source memory)", async () => {
  const s = edm(22050), pre = await preAnalyseCore(s.x, s.sr), V = songView(pre, 5);
  assert.ok(Math.abs(V.nextDrop - s.dropStart) < 0.1); assert.equal(V.dropConf, 1); assert.equal(V.dropSource, "memory");
  const after = songView(pre, s.dropStart + 2); assert.equal(after.nextDrop, null); assert.equal(after.dropSource, null);
});

test("director: the lights build toward a drop in every variety, and only for a sure one", () => {
  const L = buildLayout(exampleRoom()), fx = createEffects(L), mean = c => c.reduce((a, b) => a + b, 0) / c.length, P = 60 / 128, bar = 4 * P;
  const view = (t, o) => ({ ...metronomeView(t, 128), state: t < 16 ? "build" : "drop", level: "mid", buildP: Math.min(1, Math.max(0, (t - 8) / 8)), dropT: t < 16 ? -9 : 16, nextDrop: t < 16 ? 16 : null, ...o });
  for (const variety of ["show", "one", "parts"]) {
    const D = createDirector(L, fx); D.settings.style = "party"; D.settings.variety = variety;
    if (variety !== "show") D.settings.look = { main: "shock", palette: "neon" };
    D.settings.mode = "auto"; let first = 0, last = 0, nf = 0, nl = 0, building = false;
    for (let t = 0; t < 16; t += 1 / 60) { const c = mean(D.frame(view(t), t)); if (t >= 8 && t < 8 + bar) { first += c; nf++; } if (t >= 16 - bar && t < 16 - P) { last += c; nl++; } if (t > 12) building ||= !!D.ramp?.building; }
    assert.ok(last / nl > 1.3 * first / nf, `${variety}: last bar ${(last / nl).toFixed(3)} vs first ${(first / nf).toFixed(3)}`);
    assert.ok(building, `${variety}: building`);
  }
  // a prediction under 0.5: no ramp, no dip
  const D = createDirector(L, fx); D.settings.style = "party";
  for (let t = 8; t < 16; t += 1 / 60) D.frame(view(t, { dropConf: 0.3, dropSource: "predicted" }), t);
  assert.ok(!D.ramp, "no ramp for an unsure prediction");
});
