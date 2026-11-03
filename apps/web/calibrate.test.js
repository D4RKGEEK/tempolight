import test from "node:test";
import assert from "node:assert/strict";
import { analyseCalibration, offsetFromDelay } from "./calibrate.js";

function recording(delayMs, noise = 0.01, sr = 48000) {
  const n = sr * 5, ref = new Float32Array(n), mic = new Float32Array(n), d = Math.round(delayMs / 1000 * sr);
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) mic[i] = rnd() * noise;
  for (let k = 0; k < 8; k++) { const s = Math.round((0.6 + k * 0.45) * sr); for (let i = 0; i < 200; i++) { const v = rnd() * Math.exp(-i / 40); ref[s + i] = v; if (s + d + i < n) mic[s + d + i] += v * 0.3; } }
  return { mic, ref, sr };
}

test("timing fix: finds the speaker-to-microphone delay from clicks", () => {
  for (const ms of [12, 85, 230]) { const r = recording(ms), a = analyseCalibration(r.mic, r.ref, r.sr);
    assert.ok(a.ok, `measurement ok at ${ms} ms`); assert.ok(Math.abs(a.delayMs - ms) < 3, `${ms} ms measured as ${a.delayMs.toFixed(1)}`); assert.equal(a.sent, 8); }
});
test("timing fix: says so when the microphone heard nothing", () => {
  const r = recording(100); r.mic.fill(0); for (let i = 0; i < r.mic.length; i++) r.mic[i] = Math.sin(i) * 0.001;
  assert.equal(analyseCalibration(r.mic, r.ref, r.sr).ok, false);
});
test("timing fix: Bluetooth delay moves the lights later", () => {
  assert.ok(offsetFromDelay(260, 20) < -150, "a 260 ms Bluetooth speaker needs the lights about 200 ms later");
  assert.ok(Math.abs(offsetFromDelay(40, 20)) <= 20, "wired speakers need almost nothing");
});
