import { readWav, S, E } from "./lib.mjs";
const { LiveAnalyser } = await import(E);
const { x, sr } = readWav(S + "/songs/track2.wav");
const a = new LiveAnalyser(sr); let nextT = 0;
for (let i = 0; i < x.length; i += 512) { a.push(x.subarray(i, i + 512)); const t = a.t; if (t >= nextT) { nextT += 1;
  const loud = a.eFast / a.eMax, base = a.domBase, kicks2 = a.kicks.filter(k => t - k < 1.2).length, sr2 = a.snares.filter(k => t - k < 2).length / 2;
  console.log(`${t.toFixed(0).padStart(3)} ${a.state.padEnd(6)} loud ${loud.toFixed(2)} domS-base ${(a.domS - base).toFixed(2)} kicks1.2 ${kicks2} snare/s ${sr2} eF/eS ${(a.eFast / a.eSlow).toFixed(2)} hi ${(a.high / a.highMax).toFixed(2)} bpm ${a.bpm?.toFixed(1)}`); } }
