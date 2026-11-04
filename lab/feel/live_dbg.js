import { LiveAnalyser } from "./engine/src/index.js";
import { longEdm } from "./song.js";
const s = longEdm(), an = new LiveAnalyser(s.sr), ch = Math.round(s.sr / 60); let last = "", lv = [];
for (let p = 0, f = 0; p < s.x.length; p += ch, f++) { an.push(s.x.subarray(p, p + ch)); const V = an.view(an.t, { predict: true });
  const k = `${V.style}/${V.level}/${V.state}`; if (k !== last) { lv.push(`${an.t.toFixed(1)}:${k}`); last = k; } }
console.log(lv.length, "changes of style/level/state"); console.log(lv.join("  "));
console.log("bpm", an.bpm.toFixed(2), "phase", an.phase.toFixed(3), "barOff", an.barOff);
