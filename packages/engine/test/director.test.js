// The director's feel layer: kick pump, energy contour, moments at drops, steady changes on the phrase grid.
import test from "node:test";
import assert from "node:assert/strict";
import { createDirector, buildLayout, exampleRoom, createEffects, metronomeView, songView, planShow } from "../src/index.js";
import { chooseStep, swapBars } from "../src/show.js";

const L = buildLayout(exampleRoom()), fx = createEffects(L);
const mean = c => { let s = 0; for (let i = 0; i < c.length; i++) s += 1 - Math.exp(-1.28 * c[i]); return s / c.length; };
const P = 60 / 128;

test("feel: the kick pumps the room in drops (punch), not with punch 0, gently in safe mode", () => {
  const ratio = settings => { const D = createDirector(L, fx); Object.assign(D.settings, { mode: "manual", effect: "tunnel" }, settings); let on = 0, off = 0;
    for (let t = 0; t < 8; t += 1 / 60) { const c = mean(D.frame({ ...metronomeView(t, 128), state: "drop" }, t)), ph = (t / P) % 1;
      if (t > 2 && ph < 0.08) on += c; if (t > 2 && ph > 0.85) off += c; } return on / off; };
  const full = ratio({}), none = ratio({ punch: 0 }), safe = ratio({ safe: true });
  assert.ok(full > 1.5, `the kick lands (${full.toFixed(2)})`); assert.ok(none < full * 0.75, `punch 0: no pump (${none.toFixed(2)})`);
  assert.ok(safe < full * 0.8, `safe mode pumps less (${safe.toFixed(2)})`);
});

test("feel: drops cut hard to a high-impact effect, the beat before dims, and the drop flashes in every style", () => {
  for (const style of ["party", "poprock"]) {
    const D = createDirector(L, fx); D.settings.style = style;
    const view = t => ({ ...metronomeView(t, 128), state: t < 8 ? "build" : "drop", level: t < 8 ? "mid" : "peak", buildP: Math.min(1, t / 8), dropT: t < 8 ? -9 : 8, nextDrop: t < 8 ? 8 : null });
    let before = 0, n = 0, dim = 0, nd = 0, flash = 0;
    for (let t = 0; t < 9; t += 1 / 60) { const m = mean(D.frame(view(t), t));
      if (t > 6.5 && t < 7.3) { before += m; n++; } if (t > 7.65 && t < 7.98) { dim += m; nd++; } if (t >= 8 && t < 8.1) flash = Math.max(flash, m); }
    assert.ok(dim / nd < 0.6 * before / n, `${style}: the last beat before the drop dims (${(dim / nd).toFixed(3)} vs ${(before / n).toFixed(3)})`);
    assert.ok(flash > 2 * before / n, `${style}: the drop flashes`);
    assert.equal(D.state.xfadeT, -99, `${style}: a hard cut, no crossfade`);
    assert.ok(fx.impact.includes(D.current), `${style}: opens with ${D.current}`);
  }
});

test("feel: effects change on the phrase grid, a flickering level doesn't change the pool, variations in drops", () => {
  // poprock (levels): the level flips every 0.3 s; it must hold most of a bar before the pool changes
  const D = createDirector(L, fx); D.settings.style = "poprock"; const seen = [];
  for (let t = 0; t < 30; t += 1 / 30) { D.frame({ ...metronomeView(t, 128), state: "calm", level: Math.floor(t / 0.3) % 2 ? "low" : "mid" }, t); if (seen.at(-1) !== D.current) seen.push(D.current); }
  assert.ok(seen.length <= 6, `few changes (${seen.join(", ")})`);
  // party drop: effects change every 4 bars, on 4-bar lines; every other 2 bars a variation
  const E = createDirector(L, fx); E.settings.style = "party"; const ch = []; let varied = 0;
  for (let t = 0; t < 40; t += 1 / 60) { const was = E.current; E.frame({ ...metronomeView(t, 128), state: "drop" }, t); if (E.current !== was) ch.push(t); if (E.state.vary) varied++; }
  assert.ok(ch.length >= 3, `changes ${ch.length}`);
  for (const t of ch) { const bars = t / (4 * P); assert.ok(Math.abs(bars - Math.round(bars / 4) * 4) < 0.05, `on a 4-bar line (${t.toFixed(2)} s)`); }
  assert.ok(varied > 0, "variations play between effect changes");
  assert.equal(swapBars(8, fx.styles.party, true), 4); assert.equal(swapBars(8, fx.styles.party, false), 4); assert.equal(swapBars(4, fx.styles.party, true), 2);
});

test("feel: liked effects still come round, banned ones never; the chooser works without a beat grid", () => {
  const D = createDirector(L, fx); D.settings.style = "party"; for (const id of fx.pools.drop) if (!["shock", "laser"].includes(id)) D.settings.prefs[id] = -1;
  const seen = new Set(); for (let t = 0; t < 60; t += 1 / 30) { D.frame({ ...metronomeView(t, 128), state: "drop" }, t); seen.add(D.current); }
  assert.deepEqual([...seen].sort(), ["laser", "shock"]);
  const s = { cur: null }; let changes = 0;
  for (let t = 0; t < 20; t += 0.05) if (chooseStep(s, fx, fx.styles.party, {}, t, { g: { has: false }, state: "drop", dropT: -9 })) changes++;
  assert.ok(changes >= 2 && changes <= 4, `no grid: changes on 2 s bars (${changes})`);
});

test("feel: kick strength from the analysis is optional and scales the kick", () => {
  const pre = { bpm: 128, P, off: 0, barOff: 0, style: "party", dur: 8, kicks: [0, P, 2 * P, 3 * P], snares: [], hats: [], drops: [], env: new Float32Array(400).fill(0.5), bars: [{ t0: 0, t1: 4 * P, state: "drop", level: 1 }] };
  assert.equal(songView(pre, P + 0.01).kickS, 1, "no kickStrength: every kick full");
  const v = songView({ ...pre, kickStrength: [1, 0.4, 1, 1] }, P + 0.01); assert.ok(v.kickS < 0.6, `a soft kick (${v.kickS})`);
  assert.ok(planShow(pre, fx).length >= 1);
});
