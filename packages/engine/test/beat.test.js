// Beat tracking must not get worse than the saved baseline (scripts/beat-eval.js; baselines/beat.json).
// After an intentional improvement: npm run eval:beat -- --baseline write
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAll, readBaseline, checkBaseline } from "../../../scripts/beat-eval.js";

test("live beat tracking: no regression against the baseline (mean F -0.02, any song F -0.1)", { timeout: 120000 }, t => {
  const res = runAll({ wavs: false }), base = readBaseline(), chk = checkBaseline(res, base);
  t.diagnostic(`mean F ${chk.meanF} (baseline ${chk.baseMeanF}), CMLt ${res.mean.CMLt}, AMLt ${res.mean.AMLt}, downbeat ${res.mean.downbeat}, never locked ${res.mean.lockNever}/${res.mean.songs}`);
  for (const n of chk.notes) t.diagnostic(n);
  for (const r of res.songs) assert.ok(Number.isFinite(r.F) && r.F >= 0 && r.F <= 1, `${r.name}: F is a number in 0..1`);
  const measured = new Set(res.songs.map(r => r.name));
  assert.deepEqual(Object.keys(base.songs).filter(n => !measured.has(n)), [], "every baseline song was measured");
  assert.ok(chk.ok, `beat tracking got worse than the baseline:\n  ${chk.problems.join("\n  ")}\n(npm run eval:beat -- --baseline check for the table)`);
});
