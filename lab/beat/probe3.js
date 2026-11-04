import { readFileSync } from "node:fs";
import { LiveAnalyser } from "./src2/live.js";
const buf = readFileSync("track2.wav"), T = JSON.parse(readFileSync("track2.json","utf8"));
const n = (buf.length - 44) / 4, x = new Float32Array(n >> 1);
for (let i = 0; i < x.length; i++) { let v = 0; for (let k = 0; k < 2; k++) for (let c = 0; c < 2; c++) v += buf.readInt16LE(44 + ((2 * i + k) * 2 + c) * 2); x[i] = v / 32768 / 4; }
globalThis.KLOG = []; const A = new LiveAnalyser(22050); for (let i = 0; i < x.length; i += 512) A.push(x.subarray(i, i + 512));
const near = KLOG.filter(l => T.events.kick.some(k => Math.abs(l.t - k) < 0.06));
console.log("kick-band detect() fired near", near.length, "of", T.events.kick.length, "truth kicks");
const c = k => near.filter(l => !l[k]).length; console.log("fail loudEnough", c("loud"), "fail kpb>4*hpb", c("hf"), "fail lowRise>1.35", near.filter(l => l.rise <= 1.35).length, "fail mid", c("mid"));
console.log("median kpb/hpb", near.map(l => l.ratio).sort((a,b)=>a-b)[near.length>>1].toFixed(2), "median lowRise", near.map(l=>l.rise).sort((a,b)=>a-b)[near.length>>1].toFixed(2));
