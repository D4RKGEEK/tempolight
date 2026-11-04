import { makeSong, SPECS } from "./songs.js";
import { run } from "./eval.js";
import { edm } from "/home/claude/tempolight/packages/engine/test/synth.js";
const e = edm(); const eb = []; for (let t = 0; t < e.x.length / e.sr - 0.5; t += 4 * 60 / 128) eb.push(t);
const list = [{ name: "edm()", x: e.x, sr: e.sr, truth: { downbeats: eb } }, ...SPECS.filter(s => /house128|halftime drop|break|boombap/.test(s.name)).map(s => makeSong(s))];
for (const s of list) { const R = run(s.x, s.sr); const d = s.truth.downbeats.filter(t => t > 10 && t < s.x.length / s.sr - 2);
  const h = [0, 0, 0, 0]; for (const t of d) { const g = R.A.grid(t + 0.03); if (g.has) h[g.beatInBar]++; }
  console.log(s.name.padEnd(36), "barOff", R.A.barOff, "dropT", R.A.dropT.toFixed(1), "beatInBar at true downbeats", h); }
