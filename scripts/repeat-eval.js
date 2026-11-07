#!/usr/bin/env node
// Repeat evaluation: does the live analyser learn the song while it plays (packages/engine/src/repeat.js)? Synthetic
// songs with known sections (packages/engine/test/repeat-songs.js) go through the LiveAnalyser at 60 frames a second:
//   - EDM build-drop-break-build-drop: how long before the second drop the countdown had the right time (within a
//     beat, dropConf 0.5 or more), and how long before it the repeat alone had it;
//   - pop verse-chorus and hip hop verse-hook: how long before the second chorus / hook the repeat's next part change
//     was right (within a beat, conf 0.5 or more);
//   - through-composed pieces (with and without drums): predictions made at all (should be none);
//   - every song: predicted changes and drops that were wrong (not within a beat of a true one), and the time per unit.
// Real recordings: set TEMPOLIGHT_REAL_AUDIO to a folder of WAVs (never committed); each is listened to the same way
// and the repeats found are listed (when, which earlier time, the letter) with how many predicted drops and section
// changes came true (a drop heard, or a section line found, within a beat of it).
//
//   node scripts/repeat-eval.js            # report
//   node scripts/repeat-eval.js --json
//   TEMPOLIGHT_REAL_AUDIO=/path/to/wavs node scripts/repeat-eval.js
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LiveAnalyser } from "../packages/engine/src/index.js";
import { verseChorus, edmTrack, hiphop, throughComposed } from "../packages/engine/test/repeat-songs.js";

const r1 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
const mmss = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** Listen at 60 fps; every frame [t, nextDrop, dropConf, dropSource, repeat view]. */
export function listen(song) {
  const an = new LiveAnalyser(song.sr), chunk = Math.round(song.sr / 60), out = [];
  for (let i = 0; i < song.x.length; i += chunk) { an.push(song.x.subarray(i, i + chunk)); const V = an.view(an.t); out.push([an.t, V.nextDrop, V.dropConf, V.dropSource, V.repeat, V.dropT]); }
  return { an, out };
}
// how long before time d a prediction get(frame) was within tol of it without a break (conf already checked by get)
export function leadOf(out, d, get, tol) {
  let i = out.findIndex(([t]) => t >= d - 0.05); if (i < 0) i = out.length; let t0 = null;
  for (i--; i >= 0; i--) { const at = get(out[i]); if (at != null && Math.abs(at - d) <= tol) t0 = out[i][0]; else break; }
  return t0 == null ? 0 : d - t0;
}
const sureDrop = f => f[1] != null && f[2] >= 0.5 ? f[1] : null;
const repDrop = f => f[4] && f[4].conf >= 0.5 && f[4].nextDropAt != null ? f[4].nextDropAt : null;
const repPart = f => f[4] && f[4].conf >= 0.5 && f[4].nextPart ? f[4].nextPart.at : null;

/** Distinct predictions (part changes and drops from the repeat, conf 0.5 or more) and the repeats found. */
export function predictions(out) {
  const parts = [], drops = [], runs = [];
  const add = (list, at, t) => { const last = list[list.length - 1]; if (last && Math.abs(last.at - at) < 0.3) { last.last = t; return; } list.push({ at, first: t, last: t }); };
  let run = null;
  for (const f of out) { const R = f[4], t = f[0];
    if (R && R.conf >= 0.5) { const pa = repPart(f), dr = repDrop(f); if (pa != null && pa > t) add(parts, pa, t); if (dr != null && dr > t) add(drops, dr, t);
      if (!run || Math.abs(run.lag - R.lag) > 0.5 || t - run.t1 > 1) runs.push(run = { t0: t, t1: t, matchAt: R.matchAt, lag: R.lag, label: R.label, conf: R.conf }); else { run.t1 = t; run.conf = Math.max(run.conf, R.conf); run.label = R.label ?? run.label; } } }
  return { parts, drops, runs: runs.filter(r => r.t1 - r.t0 >= 1) };
}
const wrong = (list, truth, tol) => list.filter(p => !truth.some(x => Math.abs(x - p.at) <= tol)).length;

export function evalSong(song) {
  const { an, out } = listen(song), T = song.truth, tol = T.beat * 1.05, pr = predictions(out), R = an.repeat;
  const res = { name: song.name, dur: r1(song.dur), runs: pr.runs.length, partPreds: pr.parts.length, dropPreds: pr.drops.length,
    wrongParts: wrong(pr.parts, T.changes, tol), wrongDrops: wrong(pr.drops, T.drops, tol), msPerUnit: R && R.nUnits ? Math.round(R.ms / R.nUnits * 1000) / 1000 : null, msMax: R ? Math.round(R.msMax * 1000) / 1000 : null, over1ms: R && R.nUnits ? Math.round(R.slow / R.nUnits * 1000) / 10 : null,
    repeats: pr.runs.map(r => `${mmss(r.t0)}-${mmss(r.t1)} = ${mmss(r.matchAt)}… (${r.label ?? "?"}, ${r.conf})`), sections: R ? R.sectionList().map(s => `${s.label ?? "?"}@${mmss(s.t0)}`).join(" ") : "" };
  if (T.drops.length >= 2) { const d = T.drops[1]; res.secondDropLead = r1(leadOf(out, d, sureDrop, tol)); res.secondDropLeadRepeat = r1(leadOf(out, d, repDrop, tol)); res.firstDropLead = r1(leadOf(out, T.drops[0], sureDrop, tol)); }
  const ch = T.sections.filter(s => s.part === "drop"); if (ch.length >= 2 && T.drops.length < 2 || /verse/.test(song.name)) { const c2 = ch[1].t0; res.secondChorusLead = r1(leadOf(out, c2, repPart, tol)); res.secondChorusLeadBars = r1(res.secondChorusLead / T.bar); }
  return res;
}

function readWav(file) {
  const b = readFileSync(file); let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) { const id = b.toString("ascii", o, o + 4), len = b.readUInt32LE(o + 4); if (id === "fmt ") fmt = o + 8; if (id === "data") { data = { o: o + 8, len: Math.min(len, b.length - o - 8) }; break; } o += 8 + len + (len & 1); }
  const ch = b.readUInt16LE(fmt + 2), sr = b.readUInt32LE(fmt + 4), bits = b.readUInt16LE(fmt + 14), n = Math.floor(data.len / (bits / 8) / ch), x = new Float32Array(n);
  if (bits !== 16) throw new Error(`${file}: 16-bit WAV only`);
  for (let i = 0; i < n; i++) { let v = 0; for (let c = 0; c < ch; c++) v += b.readInt16LE(data.o + (i * ch + c) * 2); x[i] = v / ch / 32768; }
  return { x, sr };
}
export function evalReal(file) {
  const w = readWav(file), { an, out } = listen(w), pr = predictions(out), R = an.repeat, P = an.beat.P || 0.5;
  const heard = []; let last = -9; for (const f of out) if (f[5] > last + 1) { last = f[5]; heard.push(f[5]); }
  const lines = R.sectionList().map(s => s.t0);
  const okDrops = pr.drops.filter(p => heard.some(h => Math.abs(h - p.at) <= 1.05 * P)).length, okParts = pr.parts.filter(p => lines.some(h => Math.abs(h - p.at) <= 1.05 * P)).length;
  return { name: path.basename(file, ".wav"), dur: r1(w.x.length / w.sr), bpm: r1(an.bpm), repeats: pr.runs.map(r => `${mmss(r.t0)}-${mmss(r.t1)} = ${mmss(r.matchAt)}… (${r.label ?? "?"}, ${r.conf})`), hook: pr.runs.length > 0,
    sections: R.sectionList().map(s => `${s.label ?? "?"}@${mmss(s.t0)}`).join(" "), dropPreds: pr.drops.length, dropsTrue: okDrops, partPreds: pr.parts.length, partsTrue: okParts,
    leadsDrop: pr.drops.filter(p => heard.some(h => Math.abs(h - p.at) <= 1.05 * P)).map(p => r1(p.at - p.first)), leadsPart: pr.parts.filter(p => lines.some(h => Math.abs(h - p.at) <= 1.05 * P)).map(p => r1(p.at - p.first)),
    drops: heard.map(mmss).join(" "), msPerUnit: R.nUnits ? Math.round(R.ms / R.nUnits * 1000) / 1000 : null };
}

export function runAll() {
  const songs = [verseChorus(), edmTrack(), hiphop(), throughComposed(), throughComposed(22050, false)].map(evalSong);
  const dir = process.env.TEMPOLIGHT_REAL_AUDIO, real = dir && existsSync(dir) ? readdirSync(dir).filter(f => /\.wav$/i.test(f)).sort().map(f => evalReal(path.join(dir, f))) : null;
  return { songs, real };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = performance.now(), r = runAll();
  if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 1));
  else {
    for (const s of r.songs) {
      console.log(`\n${s.name} (${s.dur} s): ${s.runs} repeat(s); part changes predicted ${s.partPreds} (wrong ${s.wrongParts}), drops ${s.dropPreds} (wrong ${s.wrongDrops}); ${s.msPerUnit} ms a unit (worst ${s.msMax}, ${s.over1ms} % over 1 ms)`);
      if (s.secondDropLead != null) console.log(`  second drop: countdown right ${s.secondDropLead} s ahead (repeat alone ${s.secondDropLeadRepeat} s); first drop ${s.firstDropLead} s`);
      if (s.secondChorusLead != null) console.log(`  second chorus/hook: change predicted ${s.secondChorusLead} s (${s.secondChorusLeadBars} bars) ahead`);
      console.log(`  sections: ${s.sections}`); for (const x of s.repeats) console.log(`  repeat ${x}`);
    }
    if (r.real) for (const s of r.real) {
      console.log(`\n[real] ${s.name} (${s.dur} s, ${s.bpm} BPM): ${s.repeats.length} repeat(s), hook found: ${s.hook ? "yes" : "no"}; drops predicted ${s.dropPreds} (came ${s.dropsTrue}, leads ${s.leadsDrop.join(", ")}), part changes ${s.partPreds} (found ${s.partsTrue}, leads ${s.leadsPart.join(", ")}); ${s.msPerUnit} ms a unit`);
      console.log(`  drops heard: ${s.drops}`); console.log(`  sections: ${s.sections}`); for (const x of s.repeats) console.log(`  repeat ${x}`);
    }
    else console.log("\n(real recordings: set TEMPOLIGHT_REAL_AUDIO to a folder of WAVs)");
    console.log(`\n(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
}
