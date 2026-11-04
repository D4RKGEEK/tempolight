import test from "node:test";
import assert from "node:assert/strict";
import { LiveAnalyser, createDirector, buildLayout, exampleRoom, createEffects, metronomeView } from "../src/index.js";
import { edm, ballad } from "./synth.js";

function listen(song, chunk = 512) {
  const A = new LiveAnalyser(song.sr), states = [];
  for (let i = 0; i < song.x.length; i += chunk) { A.push(song.x.subarray(i, i + chunk)); states.push([A.t, A.view().state]); }
  return { A, states, frac: (a, b, s) => { const w = states.filter(([t]) => t >= a && t < b); return w.filter(x => x[1] === s).length / Math.max(1, w.length); } };
}

test("live listening finds the tempo, the drop and the style of an EDM track", () => {
  const { A, frac } = listen(edm(22050));
  assert.ok(Math.abs(A.bpm - 128) < 2, `bpm ${A.bpm}`);
  assert.equal(A.style, "party");
  assert.ok(frac(18, 29, "drop") > 0.8, "drop section is heard as a drop");
  assert.equal(frac(0, 7, "drop"), 0, "the intro is not a drop");
});

test("live listening at 48 kHz (browser and sound cards) gives the same tempo", () => {
  const s = edm(48000), { A } = listen(s, 1024);
  assert.ok(Math.abs(A.bpm - 128) < 2, `bpm ${A.bpm}`);
});

test("a slow ballad is never treated as silence and gets a calm style", () => {
  const s = ballad(22050), { A, frac } = listen(s);
  assert.ok(["emotional", "chill"].includes(A.style), `style ${A.style}`);
  assert.ok(frac(2, s.x.length / s.sr - 1, "silent") < 0.05, "quiet music keeps the lights on");
});

test("director: quiet music never goes dark, idle shows the ambient effect, and auto mode follows song parts", () => {
  const L = buildLayout(exampleRoom()), fx = createEffects(L), D = createDirector(L, fx);
  const mean = c => c.reduce((a, b) => a + b, 0) / c.length;
  assert.ok(mean(D.frame(null, 10)) > 0.02, "idle: ambient effect is on");
  const s = ballad(22050), A = new LiveAnalyser(s.sr);
  let minLum = 9;
  for (let i = 0; i < s.x.length; i += 512) { A.push(s.x.subarray(i, i + 512)); if (A.t > 3) minLum = Math.min(minLum, mean(D.frame(A.view(), A.t, A.extras()))); }
  assert.ok(minLum > 0.02, `ballad never goes dark (min ${minLum.toFixed(3)})`);
  const D2 = createDirector(L, fx); D2.settings.style = "party";
  for (let t = 0; t < 4; t += 1 / 60) D2.frame({ ...metronomeView(t, 128), state: "drop" }, t);
  assert.ok(fx.pools.drop.includes(D2.current), `drop effect chosen (${D2.current})`);
  D2.settings.mode = "manual"; D2.settings.effect = "galaxy"; D2.frame(metronomeView(5, 128), 5);
  assert.equal(D2.current, "galaxy");
});

test("director: blackout, flash and photosensitivity limit", () => {
  const L = buildLayout(exampleRoom()), fx = createEffects(L), D = createDirector(L, fx);
  D.state.overlay.blackout = true; assert.equal(Math.max(...D.frame(null, 1)), 0); D.state.overlay.blackout = false;
  D.settings.mode = "manual"; D.settings.effect = "strobe"; D.settings.safe = true;
  let jumps = 0, prev = 0;
  for (let t = 0; t < 4; t += 1 / 60) { const c = D.frame(metronomeView(t, 175), t); const m = c.reduce((a, b) => a + b, 0) / c.length; if (m > prev * 1.8 + 0.12) jumps++; prev = m; }
  assert.ok(jumps <= 13, `at most ~3 big flashes a second in safe mode (got ${jumps} in 4 s)`);
});

test("director: banned effects never play, effect settings and zones apply", () => {
  const shapes = exampleRoom(); shapes[0].zone = "ceiling"; shapes[1].zone = "tv";
  const L = buildLayout(shapes), fx = createEffects(L), D = createDirector(L, fx);
  const drop = t => ({ ...metronomeView(t, 128), state: "drop" });
  D.settings.style = "party"; for (const id of fx.pools.drop) if (id !== "laser") D.settings.prefs[id] = -1;
  for (let t = 0; t < 20; t += 1 / 30) D.frame(drop(t), t);
  assert.equal(D.current, "laser", "only the effect that isn't banned plays");
  const sum = (c, idx) => idx.reduce((a, i) => a + c[i * 3] + c[i * 3 + 1] + c[i * 3 + 2], 0);
  const tv = [], ceil = []; for (let i = 0; i < L.N; i++) { if (L.LF[i] === 1) tv.push(i); if (L.LF[i] === 0) ceil.push(i); }
  D.settings.mode = "manual"; D.settings.effect = "aurora";
  const base = sum(D.frame(null, 3), tv);
  D.settings.params.aurora = { intensity: 2 }; assert.ok(Math.abs(sum(D.frame(null, 3), tv) / base - 2) < 0.05, "intensity doubles the light");
  D.settings.params.aurora = { hue: 120 }; const shifted = D.frame(null, 3); assert.ok(Math.abs(sum(shifted, tv) - base) / base < 0.5, "hue shift keeps roughly the same brightness");
  D.settings.params = {};
  D.settings.zones = [{ id: "tv", mode: "off" }, { id: "ceiling", mode: "follow", brightness: 0.5 }];
  const z = D.frame(null, 3); assert.equal(sum(z, tv), 0, "the TV zone is off");
  D.settings.zones = [{ id: "ceiling", mode: "follow", brightness: 1 }]; const full = sum(D.frame(null, 3), ceil);
  D.settings.zones = [{ id: "ceiling", mode: "follow", brightness: 0.5 }]; assert.ok(Math.abs(sum(D.frame(null, 3), ceil) / full - 0.5) < 0.02, "zone brightness");
  D.settings.zones = [{ id: "tv", mode: "effect", effect: "candle" }]; D.frame(null, 3); assert.ok(sum(D.frame(null, 3), tv) > 0, "zone runs its own effect");
});

test("vocal estimate: high for singing (even over drums), low for drums, a steady pad or piano", async () => {
  const { voice, pad } = await import("./synth.js");
  const avg = x => { const a = new LiveAnalyser(22050), v = []; for (let i = 0; i < x.length; i += 512) { a.push(x.subarray(i, i + 512)); if (a.t > 2) v.push(a.vocal); } return v.reduce((p, c) => p + c, 0) / v.length; };
  const e = edm(), drop = e.x.subarray(Math.floor(e.dropStart * e.sr), Math.floor((e.dropStart + 8) * e.sr)), sung = voice(22050, 8).x, mix = drop.map((d, i) => d * 0.6 + (sung[i] || 0) * 0.8);
  const r = { voice: avg(sung), mix: avg(mix), drums: avg(drop), pad: avg(pad(22050, 8).x), piano: avg(ballad().x.subarray(0, 22050 * 8)) };
  assert.ok(r.voice > 0.6, `voice ${r.voice}`); assert.ok(r.mix > 0.2, `voice over drums ${r.mix}`);
  for (const k of ["drums", "pad", "piano"]) assert.ok(r[k] < 0.12 && r[k] < r.mix / 2, `${k} ${r[k]}`);
});

test("song memory: recognise a remembered song from 12 s of live sound, and line it up with the kicks", async () => {
  const { preAnalyseCore, memoryEntry, memoryAnalysis, recognise, refineByKicks } = await import("../src/index.js");
  const song = edm(), e = memoryEntry("EDM", await preAnalyseCore(song.x, song.sr), "a"), b = memoryEntry("Ballad", await preAnalyseCore(ballad().x, 22050), "b");
  assert.ok(JSON.stringify(e).length < 40000, "entries are small"); assert.equal(memoryAnalysis(e).kicks.length, e.kicks.length);
  const a = new LiveAnalyser(22050), start = 8, x = song.x.subarray(start * 22050); let r = null;
  for (let i = 0; i < x.length && a.t < 16; i += 512) a.push(x.subarray(i, i + 512).map(v => v * 0.5));
  r = recognise(a.tap.q, [b, e], { bpm: a.bpm }); assert.ok(r && r.id === "a", "found the right song");
  const truth = start + a.t; assert.ok(Math.abs(r.pos - truth) < 0.3, `rough position ${r.pos} vs ${truth}`);
  const fine = refineByKicks(a.kicks, a.t, r.pos, e.kicks); assert.ok(Math.abs(fine.pos - truth) < 0.04, `refined ${fine.pos} vs ${truth}`);
  // an unrelated song heard live: never matched twice in step (the runtime needs two agreeing matches)
  const c = new LiveAnalyser(22050), bx = ballad().x; let prev = null, agree = 0;
  for (let i = 0; i < bx.length; i += 512) { c.push(bx.subarray(i, i + 512)); if ((i / 512) % 86 === 0 && c.t > 12) { const m = recognise(c.tap.q, [e]); if (m && prev && Math.abs(m.pos - (prev.pos + c.t - prev.t)) < 0.6) agree++; prev = m ? { ...m, t: c.t } : null; } }
  assert.equal(agree, 0, "no false recognition");
});

test("song memory live: a drumless ballad heard from the middle is recognised and followed; the view carries key and mood", async () => {
  const { preAnalyseCore, memoryEntry, recognise, matchAt } = await import("../src/index.js");
  const { minorBallad } = await import("./synth.js");
  const s = minorBallad(), e = memoryEntry("Ballad", await preAnalyseCore(s.x, s.sr), "b"), other = memoryEntry("EDM", await preAnalyseCore(edm().x, 22050), "e");
  const start = 33, x = s.x.subarray(start * 22050), a = new LiveAnalyser(22050); let r = null;
  for (let i = 0; i < x.length && a.t < 15; i += 512) a.push(x.subarray(i, i + 512));
  assert.ok(a.drumless(), "no drums heard");
  r = recognise(a.tap.q, [other, e], a.memoryQuery()); assert.ok(r && r.id === "b", "found the ballad");
  assert.ok(Math.abs(r.pos - (start + a.t)) < 0.35, `position ${r.pos} vs ${start + a.t}`);
  assert.equal(recognise(a.tap.q, [other, e], { bpm: a.bpm }), null, "loudness alone (as before) can't tell");
  for (let i = Math.round(a.t * 22050); i < x.length && a.t < 30; i += 512) a.push(x.subarray(i, i + 512)); // follow it
  const here = matchAt(a.tap.q, e, start + a.t, 0.2, a.memoryQuery()); assert.ok(here && here.score > 0.6 && Math.abs(here.pos - start - a.t) < 0.3, `still there (${here?.score})`);
  const V = a.view(); assert.equal(`${V.key} ${V.mode}`, "F# minor"); assert.ok(V.mood && V.mood.valence < 0.6 && V.mood.energy < 0.4, `calm, not happy (mood ${JSON.stringify(V.mood)})`);
});
