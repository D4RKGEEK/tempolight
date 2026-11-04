// bar-synchronous self-similarity + checkerboard novelty + repetition (lag) detection, offline from preAnalyseCore output
import { S, E, readWav } from "./lib.mjs";
const { preAnalyseCore, unpackChroma } = await import(E);
const syn = await import("/home/claude/tempolight/packages/engine/test/synth.js");
const sr = 22050;
function barFeats(pre) { const ch = unpackChroma(pre.chroma), nCh = ch.length / 12, F = [];
  const P = pre.P, start = pre.off + pre.barOff * P;
  for (let t0 = start; t0 + 4 * P <= pre.dur + 1e-6; t0 += 4 * P) { const t1 = t0 + 4 * P, v = new Float64Array(12 + 4);
    for (let j = Math.floor(t0 * 5); j < Math.min(nCh, Math.floor(t1 * 5)); j++) for (let k = 0; k < 12; k++) v[k] += ch[j * 12 + k];
    let e = 0, n = 0; for (let i = Math.floor(t0 / 0.02); i < Math.min(pre.env.length, t1 / 0.02); i++) { e += pre.env[i]; n++; }
    const cnt = (a) => a.filter(t => t >= t0 && t < t1).length;
    let s = 0; for (let k = 0; k < 12; k++) s += v[k] * v[k]; s = Math.sqrt(s) || 1; for (let k = 0; k < 12; k++) v[k] /= s;
    v[12] = Math.log10((e / (n || 1)) + 1e-3) * 1.5; v[13] = cnt(pre.kicks) / 4; v[14] = cnt(pre.snares) / 8; v[15] = cnt(pre.hats) / 8; F.push({ t0, v }); }
  return F; }
const cos = (a, b) => { let xy = 0, xx = 0, yy = 0; for (let i = 0; i < a.length; i++) { xy += a[i] * b[i]; xx += a[i] * a[i]; yy += b[i] * b[i]; } return xy / Math.sqrt(xx * yy || 1); };
const dist = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) ** 2; return Math.exp(-d / 0.5); };
function analyse(name, pre, truthB, truthLabels) {
  const F = barFeats(pre), n = F.length, M = F.map(a => F.map(b => dist(a.v, b.v)));
  // checkerboard novelty, kernel half-width w bars
  const nov = (w) => F.map((_, i) => { let s = 0, c = 0; for (let a = -w; a < w; a++) for (let b = -w; b < w; b++) { const p = i + a, q = i + b; if (p < 0 || q < 0 || p >= n || q >= n) continue; s += ((a < 0) === (b < 0) ? 1 : -1) * M[p][q]; c++; } return c ? s / c : 0; });
  const N = nov(2), N4 = nov(4), comb = N.map((v, i) => v + N4[i]);
  const thr = Math.max(...comb) * 0.3, peaks = []; for (let i = 1; i < n - 1; i++) if (comb[i] > thr && comb[i] >= comb[i - 1] && comb[i] > comb[i + 1]) peaks.push(i);
  const hit = truthB.filter(b => peaks.some(p => Math.abs(p - b) <= 0)).length, near = truthB.filter(b => peaks.some(p => Math.abs(p - b) <= 1)).length;
  console.log(`${name}: ${n} bars; novelty boundaries at bars [${peaks}] | truth [${truthB}] | exact ${hit}/${truthB.length}, +-1 bar ${near}/${truthB.length}, extra ${peaks.filter(p => !truthB.some(b => Math.abs(p - b) <= 1)).length}`);
  // segment by peaks, then cluster segments by mean-similarity -> labels (A, B, ...) = repetition
  const cuts = [0, ...peaks, n], segs = []; for (let i = 0; i + 1 < cuts.length; i++) segs.push([cuts[i], cuts[i + 1]]);
  const sim = (s, u) => { let a = 0, c = 0; const L = Math.min(s[1] - s[0], u[1] - u[0]); for (let k = 0; k < L; k++) { a += M[s[0] + k][u[0] + k]; c++; } return c ? a / c : 0; };
  const lab = []; let next = 0; for (let i = 0; i < segs.length; i++) { let best = -1, bs = 0; for (let j = 0; j < i; j++) { const v = sim(segs[i], segs[j]); if (v > bs) { bs = v; best = j; } } lab.push(bs > 0.6 ? lab[best] : String.fromCharCode(65 + next++)); }
  console.log(`   segments: ${segs.map((s, i) => `${s[0]}-${s[1]}:${lab[i]}`).join(" ")}  truth: ${truthLabels}`);
  // phrase: are boundaries on multiples of 4/8 bars from the first downbeat?
  console.log(`   boundaries on a 4-bar phrase grid: ${peaks.filter(p => p % 4 === 0).length}/${peaks.length}`);
}
const t2 = readWav(S + "/songs/track2.wav"); analyse("python EDM", await preAnalyseCore(t2.x, sr), [4, 8, 16, 20, 24, 32], "0-4 intro,4-8 build,8-16 drop,16-20 break,20-24 build,24-32 drop,32-34 outro");
// a verse/chorus song: piece() with a chorus progression that recurs (A B A B with real chord repetition)
const verse = [0, 5, 3, 4], chorus = [3, 4, 0, 0];
const prog = [...verse, ...verse, ...chorus, ...chorus, ...verse, ...verse, ...chorus, ...chorus]; // 32 bars, sections of 8
const vc = syn.piece({ tonic: 7, mode: "major", bpm: 100, bars: 32, seed: 4, drums: true, prog }, sr);
analyse("verse/chorus piece (G major)", await preAnalyseCore(vc.x, sr), [8, 16, 24], "0-8 V,8-16 C,16-24 V,24-32 C (loudness also alternates every 8 bars)");
