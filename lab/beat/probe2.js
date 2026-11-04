import { makeSong, SPECS } from "./songs.js";
import { LiveAnalyser } from "./src/live.js";
for (const nm of ["break", "house124", "boombap70"]) {
const s = makeSong(SPECS.find(x => x.name.startsWith(nm))); globalThis.LOGT = [];
const A = new LiveAnalyser(s.sr); for (let i = 0; i < s.x.length; i += 512) A.push(s.x.subarray(i, i + 512));
console.log(nm, LOGT.filter((_, i) => i % 3 === 0).map(l => `${l.t.toFixed(0)}s raw${l.raw} cur${Math.round(l.cur)} ${l.style} ${l.kicksrc?'K':'O'}${l.n}`).join(" | "));
}
