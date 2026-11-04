import fs from "node:fs";
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); const self = new Map(); const byId = new Map(p.nodes.map(n => [n.id, n]));
const dt = {}; for (let i = 0; i < p.samples.length; i++) dt[p.samples[i]] = (dt[p.samples[i]] || 0) + (p.timeDeltas[i] || 0);
let tot = 0; for (const n of p.nodes) { const t = (dt[n.id] || 0) / 1000; tot += t; const cf = n.callFrame, k = `${cf.functionName || "(anon)"} ${cf.url.split("/").slice(-1)[0]}:${cf.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + t); }
console.log("total ms", Math.round(tot)); [...self].sort((a, b) => b[1] - a[1]).slice(0, +process.argv[3] || 18).forEach(([k, v]) => console.log((v / tot * 100).toFixed(1).padStart(5) + "%", Math.round(v) + "ms", k));
