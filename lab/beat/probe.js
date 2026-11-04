import { makeSong, SPECS } from "./songs.js";
import { run } from "./eval.js";
const pick = n => makeSong(SPECS.find(s => s.name.startsWith(n)));
for (const n of ["house128", "house124", "boombap70", "dnb174", "break"]) {
  const s = pick(n), R = run(s.x, s.sr);
  // which beat-in-bar kicks are missed
  const miss = [0,0,0,0], tot=[0,0,0,0]; const B = s.truth.beats;
  for (const k of s.truth.kicks) { const bi = B.findIndex(b => Math.abs(b-k)<1e-6); const q = bi>=0? bi%4 : -1; if (q<0) continue; tot[q]++; if (!R.kicks.some(d => Math.abs(d.t-k)<0.06)) miss[q]++; }
  console.log(n, "style", R.A.style, "final bpm", R.A.bpm, "missed kicks by beat-in-bar", miss, "/", tot);
  console.log("  bpm trace (every 2s):", R.trace.filter((_, i) => i % 8 === 0).map(x => Math.round(x.bpm*10)/10).join(" "));
}
