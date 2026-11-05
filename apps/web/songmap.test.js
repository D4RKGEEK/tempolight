import test from "node:test";
import assert from "node:assert/strict";
import { syncView, nextDrop, sectionAt, spanOf, mapKey, dropText } from "./songmap.js";

test("sync meter text from the status", () => {
  assert.deepEqual(syncView({ sync: { score: 92, state: "locked", hint: null, source: "live" } }), { state: "locked", label: "Locked", score: 92, hint: null, title: "Locked (92 of 100)" });
  assert.equal(syncView({ sync: { score: 30, state: "finding", hint: "Finding the beat…" } }).title, "Finding the beat (30 of 100): Finding the beat…");
  assert.equal(syncView({}).label, "Not hearing", "an older server without sync");
  assert.equal(syncView(null).state, "none");
});

test("song map helpers: next drop, section, span, which map", () => {
  const map = { dur: 200, drops: [30, 90], sections: [{ t0: 0, t1: 30, label: "A", state: "calm" }, { t0: 30, t1: 60, label: "B", state: "drop" }] };
  assert.deepEqual(nextDrop(map, 20, {}), { in: 10, at: 30, predicted: false, building: false });
  assert.equal(nextDrop(map, 95, {}), null);
  assert.deepEqual(nextDrop(map, 20, { drop: { next: 4, at: null, conf: 0.8, source: "predicted", building: true } }), { in: 4, at: 24, predicted: true, building: true }, "the status's drop wins");
  assert.equal(nextDrop(map, 20, { drop: { next: null } }).at, 30, "no prediction: the map's");
  assert.equal(dropText({ in: 3.2, predicted: true }), "Drop in about 4 s"); assert.equal(dropText({ in: 12, predicted: false }), "Next drop in 12 s"); assert.equal(dropText(null), "");
  assert.equal(sectionAt(map, 45).label, "B"); assert.equal(sectionAt(map, 70), null); assert.equal(sectionAt(map, null), null);
  assert.equal(spanOf(map), 200); assert.equal(spanOf({ dur: 10, growing: true }), 60); assert.ok(spanOf({ dur: 100, growing: true }) > 100);
  assert.equal(mapKey({ source: "song", song: { memId: "m1", name: "x" } }), "song:m1");
  assert.equal(mapKey({ source: "capture", recognised: { id: "m2" }, hearing: { via: "capture" } }), "mem:m2");
  assert.equal(mapKey({ source: "capture", hearing: { via: "capture" } }), "live");
  assert.equal(mapKey({ source: "idle", hearing: { via: null } }), null);
});
