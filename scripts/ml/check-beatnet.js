#!/usr/bin/env node
// Checks the JavaScript BeatNet port (packages/engine/src/ml/beatnet.js) against the numpy reference that
// convert-beatnet.py writes with TLW_REF=ref.json, and times it.
//   TLW_REF=/tmp/ref.json python3 -I scripts/ml/convert-beatnet.py <model_1_weights.pt> <madmom dir> packages/engine/src/ml/weights/beatnet-1.tlw
//   node scripts/ml/check-beatnet.js /tmp/ref.json
import { readFileSync } from "node:fs";
import { BeatNet } from "../../packages/engine/src/ml/beatnet.js";

const ref = JSON.parse(readFileSync(process.argv[2], "utf8"));
const net = new BeatNet(readFileSync(new URL("../../packages/engine/src/ml/weights/beatnet-1.tlw", import.meta.url)));
const x = Float32Array.from(ref.x), feats = [], acts = [];
const t0 = performance.now();
net.push(x, a => { if (acts.length % ref.featEvery === 0) feats.push(Array.from(net.feat)); acts.push(Array.from(a)); });
const ms = performance.now() - t0;
let fe = 0, ae = 0;
for (let i = 0; i < Math.min(feats.length, ref.feats.length); i++) for (let k = 0; k < feats[i].length; k++) fe = Math.max(fe, Math.abs(feats[i][k] - ref.feats[i][k]));
for (let i = 0; i < Math.min(acts.length, ref.act.length); i++) for (let k = 0; k < 3; k++) ae = Math.max(ae, Math.abs(acts[i][k] - ref.act[i][k]));
console.log(`frames ${acts.length} (ref ${ref.act.length}); max |feature error| ${fe.toExponential(2)}; max |activation error| ${ae.toExponential(2)} (f16 weights)`);
console.log(`CPU ${(ms / (x.length / ref.sr)).toFixed(1)} ms per audio second`);
if (acts.length !== ref.act.length || fe > 1e-3 || ae > 0.02) { console.log("MISMATCH"); process.exit(1); }
console.log("OK");
