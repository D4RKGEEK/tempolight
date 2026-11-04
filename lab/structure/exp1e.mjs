import { E } from "./lib.mjs";
const { LiveAnalyser } = await import(E);
const syn = await import("/home/claude/tempolight/packages/engine/test/synth.js");
for (const [n, s] of [["synth edm (build 7.5, drop 15.0, outro 30.0)", syn.edm(22050)], ["majorPop (no build/drop; loud 15.5-31)", syn.majorPop(22050)]]) {
  const a = new LiveAnalyser(22050); let last = null; const tl = []; for (let i = 0; i < s.x.length; i += 512) { a.push(s.x.subarray(i, i + 512)); if (a.state !== last) { tl.push(`${a.t.toFixed(2)}:${a.state}`); last = a.state; } }
  console.log(n, "\n  ", tl.join(" ")); }
