// How the lights follow a song must not get worse than the saved baseline (scripts/feel-eval.js; baselines/feel.json).
// The roadmap's targets are printed as a report, not tested: main doesn't meet them yet. The looks (varieties "one"
// and "parts": one effect for the song, or one per song part) must meet the targets that apply to them, and "one"
// must hardly change effect.
// After an intentional improvement: npm run eval:feel -- --baseline write
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFeel, readBaseline, checkBaseline, targetReport, varietyReport } from "../../../scripts/feel-eval.js";

let R = null; const run = async () => (R ||= await runFeel());

test("feel: no regression against the baseline (whole-song and live, every variety)", { timeout: 120000 }, async t => {
  const r = await run(), chk = checkBaseline(r, readBaseline()), tg = targetReport(r);
  t.diagnostic(`targets met: ${tg.filter(x => x.pass).length}/${tg.length}`);
  for (const x of tg) t.diagnostic(`${x.pass ? "PASS" : "FAIL"} ${x.name}: ${JSON.stringify(x.value)} (aim ${x.aim})`);
  assert.ok(r.whole.changes > 0 && Number.isFinite(r.whole.lum.drop), "the director ran and changed effects");
  const bad = chk.filter(c => !c.ok);
  assert.equal(bad.length, 0, `worse than the baseline:\n  ${bad.map(c => `${c.name}: ${JSON.stringify(c.now)} (baseline ${JSON.stringify(c.base)})`).join("\n  ")}\n(npm run eval:feel -- --baseline check)`);
});

test("feel: a look (one effect for the song, or one per part) feels as strong, and one look hardly changes", { timeout: 120000 }, async t => {
  const vr = varietyReport(await run());
  for (const x of vr) t.diagnostic(`${x.pass ? "PASS" : "FAIL"} ${x.variety}: ${x.name}: ${JSON.stringify(x.value)} (aim ${x.aim})`);
  assert.ok(vr.length >= 18, "both varieties ran");
  const bad = vr.filter(x => !x.pass);
  assert.equal(bad.length, 0, bad.map(x => `${x.variety}: ${x.name} ${JSON.stringify(x.value)}, aim ${x.aim}`).join("; "));
});
