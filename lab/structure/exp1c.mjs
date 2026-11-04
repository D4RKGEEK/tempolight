import { readWav, S, E } from "./lib.mjs";
import fs from "node:fs";
const { LiveAnalyser, preAnalyseCore } = await import(E);
const syn = await import("/home/claude/tempolight/packages/engine/test/synth.js");
function score(name, x, sr, truth, lat = 0.06) { const a = new LiveAnalyser(sr), all = [];
  for (let i = 0; i < x.length; i += 512) { a.push(x.subarray(i, i + 512)); for (const k of a.kicks) if (!all.includes(k)) all.push(k); }
  let hit = 0; const errs = []; for (const k of truth) { const n = all.find(v => Math.abs(v - k) < lat); if (n != null) { hit++; errs.push(n - k); } }
  const fp = all.filter(v => !truth.some(k => Math.abs(k - v) < lat)).length; errs.sort((p, q) => p - q);
  console.log(`${name}: live kicks ${hit}/${truth.length} (${(100 * hit / truth.length).toFixed(0)}%), false ${fp}, median offset ${(1000 * (errs[errs.length >> 1] ?? 0)).toFixed(0)} ms`); }
const { x, sr } = readWav(S + "/songs/track2.wav"), meta = JSON.parse(fs.readFileSync(S + "/songs/track2.json"));
score("python EDM (sidechain, bass)", x, sr, meta.events.kick);
const e = syn.edm(22050), beat = 60 / 128, tk = []; for (let b = 8; b < 16; b++) for (let q = 0; q < 4; q++) tk.push(b * 4 * beat + q * beat);
score("synth.js edm()", e.x, 22050, tk);
const p = syn.majorPop(22050), pb = 60 / 116, pk = []; for (let b = 0; b < 24; b++) for (let q = 0; q < 4; q++) pk.push(b * 4 * pb + q * pb); score("synth.js majorPop()", p.x, 22050, pk);
