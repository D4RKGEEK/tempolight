// Learning the song while it plays (repeat.js): synthetic songs with known sections, listened to live.
// Real recordings: scripts/repeat-eval.js with TEMPOLIGHT_REAL_AUDIO set (skipped here when it isn't).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { LiveAnalyser } from "../src/index.js";
import { RepeatLearner } from "../src/repeat.js";
import { verseChorus, edmTrack, hiphop, throughComposed } from "./repeat-songs.js";
import { evalSong, evalReal, listen } from "../../../scripts/repeat-eval.js";

test("repeat: the second drop of a build-drop-break-build-drop track is counted down 4 s ahead, within a beat, from the repeat", () => {
  const r = evalSong(edmTrack());
  assert.ok(r.secondDropLead >= 4, `countdown ${r.secondDropLead} s ahead`);
  assert.ok(r.secondDropLeadRepeat >= 4, `repeat alone ${r.secondDropLeadRepeat} s ahead`);
});

test("repeat: the second chorus (pop) and the second hook (hip hop) are expected at least a bar ahead", () => {
  for (const s of [verseChorus(), hiphop()]) { const r = evalSong(s); assert.ok(r.secondChorusLeadBars >= 1, `${s.name}: ${r.secondChorusLeadBars} bars ahead`); }
});

test("repeat: nothing is predicted in through-composed pieces", () => {
  for (const s of [throughComposed(), throughComposed(22050, false)]) { const r = evalSong(s); assert.equal(r.wrongParts + r.wrongDrops, 0, `${s.name}: ${r.wrongParts} part changes, ${r.wrongDrops} drops wrong`); }
  const r = evalSong(throughComposed()); assert.equal(r.partPreds + r.dropPreds, 0);
});

test("repeat: V.repeat's shape, the drop source, the letters of repeated sections and the cost per unit", () => {
  const s = edmTrack(), { an, out } = listen(s), R = out.map(f => f[4]).find(v => v && v.conf >= 0.5);
  assert.ok(R); for (const k of ["matchAt", "conf", "nextPart", "nextDropIn", "label"]) assert.ok(k in R, k);
  assert.ok(out.some(f => f[3] === "repeat"), "the countdown took the repeat's drop time");
  const L = an.repeat.sectionList(), at = t => L.find(x => Math.abs(x.t0 - t) < 2.5)?.label;
  assert.equal(at(75), at(15), "the second build-up has the first one's letter"); assert.equal(at(90), at(30), "the second drop has the first one's letter");
  assert.notEqual(at(30), at(15));
  // (a garbage collection now and then makes one unit slow: most stay under 1 ms)
  assert.ok(an.repeat.slow / an.repeat.nUnits < 0.1, `${an.repeat.slow} of ${an.repeat.nUnits} units over 1 ms`);
});

test("repeat: a new song after 4 s of silence, a reset analyser or newSong() forgets the history", () => {
  const s = verseChorus(), an = new LiveAnalyser(s.sr), x = s.x.subarray(0, 40 * s.sr);
  an.push(x); assert.ok(an.repeat.units.length > 10);
  an.push(new Float32Array(6 * s.sr)); assert.equal(an.repeat.units.length, 0); assert.equal(an.repeat.resetReason, "silence");
  an.push(x); assert.ok(an.repeat.units.length > 5); an.reset(); an.push(x.subarray(0, 2 * s.sr)); assert.equal(an.repeat.resetReason, "source");
  an.repeat.newSong(); assert.equal(an.repeat.units.length, 0); assert.equal(an.view().repeat, null);
  const L = new RepeatLearner(); assert.equal(L.view(0), null); assert.deepEqual(L.sectionList(), []);
});

const REAL = process.env.TEMPOLIGHT_REAL_AUDIO;
test("repeat: real recordings (TEMPOLIGHT_REAL_AUDIO)", { skip: !REAL || !existsSync(REAL) ? "TEMPOLIGHT_REAL_AUDIO not set" : false }, () => {
  for (const f of readdirSync(REAL).filter(f => /\.wav$/i.test(f))) { const r = evalReal(path.join(REAL, f)); assert.ok(r.msPerUnit < 2, `${r.name}: ${r.msPerUnit} ms a unit`); }
});
