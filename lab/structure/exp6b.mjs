import { E } from "./lib.mjs";
const { preAnalyseCore } = await import(E);
const syn = await import("/home/claude/tempolight/packages/engine/test/synth.js");
const verse = [0, 5, 3, 4], chorus = [3, 4, 0, 0], prog = [...verse, ...verse, ...chorus, ...chorus, ...verse, ...verse, ...chorus, ...chorus];
const vc = syn.piece({ tonic: 7, mode: "major", bpm: 100, bars: 32, seed: 4, drums: true, prog }, 22050); const pre = await preAnalyseCore(vc.x, 22050);
console.log(pre.bpm, pre.off, pre.barOff, pre.bars.length, pre.key, pre.mode, pre.bars.map(b => b.state[0]).join(""));
