import { S, E, readWav } from "./lib.mjs";
const { preAnalyseCore, unpackChroma, LiveAnalyser } = await import(E);
const syn = await import("/home/claude/tempolight/packages/engine/test/synth.js");
const N = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"], T = [];
for (let r = 0; r < 12; r++) for (const [q, iv] of [["", [0, 4, 7]], ["m", [0, 3, 7]]]) { const v = new Float64Array(12); for (const i of iv) v[(r + i) % 12] = 1; v[r] = 1.2; T.push({ name: N[r] + q, v }); }
const best = c => { let b = null, bs = -9; for (const t of T) { let xy = 0, xx = 0, yy = 0, mc = c.reduce((a, b) => a + b) / 12, mt = t.v.reduce((a, b) => a + b) / 12; for (let k = 0; k < 12; k++) { xy += (c[k] - mc) * (t.v[k] - mt); xx += (c[k] - mc) ** 2; yy += (t.v[k] - mt) ** 2; } const r = xy / Math.sqrt(xx * yy || 1); if (r > bs) { bs = r; b = t.name; } } return b; };
async function run(name, x, sr, barLen, truthOf, nb, startBar = 0) { const pre = await preAnalyseCore(x, sr), ch = unpackChroma(pre.chroma); let ok = 0, n = 0; const got = [];
  for (let b = startBar; b < nb; b++) { const c = new Float64Array(12); for (let j = Math.floor(b * barLen * 5) + 1; j < Math.floor((b + 1) * barLen * 5) - 1; j++) for (let k = 0; k < 12; k++) c[k] += ch[j * 12 + k]; const g = best(c), w = truthOf(b); if (w == null) continue; got.push(g); n++; if (g === w) ok++; }
  console.log(`${name}: per-bar chord ${ok}/${n} right (${(100 * ok / n).toFixed(0)}%) :: ${got.slice(0, 12).join(" ")}`); }
const t2 = readWav(S + "/songs/track2.wav"); await run("python EDM (Am F C G)", t2.x, t2.sr, 60 / 128 * 4, b => ["Am", "F", "C", "G"][b % 4], 33);
await run("synth edm (Am F C G)", syn.edm(22050).x, 22050, 60 / 128 * 4, b => ["Am", "F", "C", "G"][b % 4], 17);
const deg = [0, 4, 5, 3, 0, 3, 4, 4], maj = [0, 2, 4, 5, 7, 9, 11], qual = d => [0, 3, 4].includes(d) ? "" : "m";
await run("majorPop D major I V vi IV..", syn.majorPop(22050).x, 22050, 60 / 116 * 4, b => { const d = deg[b % 8]; return N[(2 + maj[d]) % 12] + qual(d); }, 24);
