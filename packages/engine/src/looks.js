// One look per song: a well-chosen effect (and palette) for the whole song, picked when the song is analysed, the way
// a person picks one LedFx effect and lets it run. The look is matched from the effect ratings (ratings.js) to the
// song's character: tempo against each effect's tempo range, style, energy and dynamics, how steady the kick is (a
// song without drums never gets an effect that needs a beat), and the mood (and key) for the palette. Liked effects
// count more, banned ones never, and effects rejected for this song are skipped. The pick is the same every time for
// a song (seeded by its name) but varies across songs: it is a seeded, weighted choice among the best few.
//
// The director (director.js) and planShow() (show.js) play a look through lookStep() (show.js); the liveliness comes
// from inside the effect, not from switching: speed follows the tempo, intensity rises through build-ups, the palette
// steps on phrase lines (phraseStep(): repeated sections get the same colour), drops vary every 2 bars, and the feel
// layer (kick pump, dip before the drop, drop flash) runs on top.
import { RATINGS, AUTO, rating } from "./ratings.js";
import { moodName } from "./tonal.js";

/** Bump when pickLook() chooses differently, so looks stored with songs (and not kept by hand) are picked again. */
export const LOOK_VERSION = 2;
export const VARIETIES = ["one", "parts", "show"];

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const r2 = v => Math.round(v * 100) / 100;
export function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const STYLE_E = { party: 0.8, hiphop: 0.7, poprock: 0.55, chill: 0.3, emotional: 0.15 };
const ENERGY = { low: 0.15, mid: 0.5, high: 0.85 };

/**
 * What kind of song this is, from a whole-song analysis (or a remembered one: memoryAnalysis()).
 * @returns {{kind:"character", bpm:number, style:string, kickFrac:number, drumless:boolean, energy:number, dynamic:boolean, drops:number, builds:boolean, vocal:number, mood:{valence:number, energy:number}|null, mode:string|null}}
 */
export function songCharacter(pre) {
  pre = pre || {};
  const f = pre.features || {}, bpm = pre.bpm > 0 ? pre.bpm : 120, P = pre.P > 0 ? pre.P : 60 / bpm, dur = pre.dur || 0;
  const bars = pre.bars || [], kicks = pre.kicks || [], sounding = bars.filter(b => b.state !== "silent");
  // the kick where the drums play: beats with a kick in the bars that have kicks on at least two beats (an intro and a
  // breakdown without drums don't make a four-on-the-floor song less so), and how much of the song has drums at all
  const off = pre.off || 0, hit = new Set(); for (const k of kicks) { const x = (k - off) / P, n = Math.round(x); if (Math.abs(x - n) * P < 0.08) hit.add(n); }
  const perBar = new Map(); for (const n of hit) { const b = Math.floor((n - (pre.barOff || 0)) / 4); perBar.set(b, (perBar.get(b) || 0) + 1); }
  let drumBars = 0, drumBeats = 0; for (const v of perBar.values()) if (v >= 2) { drumBars++; drumBeats += Math.min(4, v); }
  const nBars = sounding.length || Math.max(1, (dur - off) / P / 4), drumShare = clamp(drumBars / nBars);
  let kickFrac = drumBars ? drumBeats / (4 * drumBars) * Math.min(1, 0.4 + drumShare) : 0;
  if (!kicks.length && Number.isFinite(f.kickFrac)) kickFrac = f.kickFrac;
  const drumless = drumShare < 0.15 && kicks.length < dur * 0.3;
  const drops = (pre.drops || []).length, dropBars = sounding.filter(b => b.state === "drop"), rest = sounding.filter(b => b.state !== "drop");
  const lv = a => a.length ? a.reduce((s, b) => s + (b.level ?? b.energy ?? 0.5), 0) / a.length : 0;
  const contrast = dropBars.length && rest.length ? lv(dropBars) / Math.max(0.05, lv(rest)) : 1, share = sounding.length ? dropBars.length / sounding.length : 0;
  const dynamic = drops >= 1 && share > 0.04 && share < 0.8 && (contrast >= 1.35 || (f.dyn ?? 0) >= 2);
  const vocal = Number.isFinite(f.vocal) ? f.vocal : bars.length && bars.some(b => b.vocal != null) ? bars.filter(b => b.vocal).length / bars.length : 0;
  return characterOf({ bpm, style: pre.style, kickFrac, drumless, dynamic, drops, builds: bars.some(b => b.state === "build"), vocal, mood: pre.mood || null, mode: pre.mode || null });
}
/** A character from what live listening knows: {bpm, style, kickFrac, drumless, drops, dyn, vocal, mood, mode}. */
export function characterOf(o) {
  const bpm = o.bpm > 0 ? o.bpm : 120, kickFrac = clamp(o.kickFrac ?? 0.5), mood = o.mood && Number.isFinite(o.mood.energy) ? o.mood : null;
  let energy = STYLE_E[o.style] ?? 0.55;
  if (mood) energy = 0.55 * energy + 0.45 * mood.energy;
  energy = clamp(energy + 0.15 * (kickFrac - 0.5) + 0.08 * clamp((bpm - 115) / 40, -1, 1) - (o.drumless ? 0.15 : 0));
  // the tempo of a song without steady drums is a guess (often twice what it feels like): it doesn't count then
  const tempoSure = !o.drumless && !((o.style === "emotional" || o.style === "chill") && kickFrac < 0.7);
  return { kind: "character", bpm, tempoSure, style: o.style || "party", kickFrac, drumless: !!o.drumless, energy: r2(energy), dynamic: o.dynamic ?? ((o.drops || 0) >= 1 && (o.dyn ?? 0) >= 2),
    drops: o.drops || 0, builds: o.builds ?? (o.drops || 0) >= 1, vocal: clamp(o.vocal ?? 0), mood, mode: o.mode || null };
}

const tempoFit = (r, c) => { if (c.tempoSure === false) return 0; const bpm = c.bpm, [lo, hi] = r.tempo || [0, 999], d = bpm < lo ? lo - bpm : bpm > hi ? bpm - hi : 0; return d ? -Math.min(30, d * 0.8) : 8; };
// how well an effect fits the song as its one look: the song part it suits (drops for energetic songs, calm parts for
// quiet ones), its energy against the song's, its tempo range, the kick, and how busy it is
function fitMain(r, c) {
  const e = c.energy; let s = r.drop * e + r.calm * (1 - e);
  s -= 30 * Math.abs((ENERGY[r.energy] ?? 0.5) - e);
  s += tempoFit(r, c);
  if (r.kickDriven) s += c.kickFrac > 0.7 ? 12 : c.kickFrac < 0.35 ? -18 : 0;
  if (r.needsBeat && c.tempoSure === false) s -= 25; // no steady drums: an effect that waits for the beat waits a lot
  s += ((r.busy ?? 0.4) - 0.4) * 30 * (e - 0.5);
  return s;
}
const fitPart = part => (r, c) => {
  let s = r[part] + tempoFit(r, c);
  if (part === "drop" && r.kickDriven) s += c.kickFrac > 0.6 ? 8 : -8;
  if (part === "calm") s -= (r.busy ?? 0.3) * 15;
  if (part === "build") s -= 15 * Math.abs((ENERGY[r.energy] ?? 0.5) - c.energy);
  return s;
};

/**
 * The look for a song.
 * @param {object} src a song analysis (preAnalyseCore / memoryAnalysis) or a character (songCharacter / characterOf)
 * @param {{prefs?:Record<string,number>, nudge?:Record<string,number>, exclude?:string[], seed?:string|number, available?:Iterable<string>, used?:Record<string,number>}} [o]
 *   prefs: effect id -> 1 liked / -1 banned; nudge: id -> -1..1 (soft, from "Not this one" and "Keep"); exclude: effects
 *   rejected for this song; seed: the song's name or id; available: the effect ids that exist (all rated ones if not given)
 * @returns {{main:string, drop:string|null, build:string|null, calm:string, palette:string, params:{speed?:number, intensity?:number}, why:string[], v:number}|null}
 */
export function pickLook(src, o = {}) {
  const c = src && src.kind === "character" ? src : songCharacter(src), prefs = o.prefs || {}, nudge = o.nudge || {};
  const avail = o.available ? new Set(o.available) : null, ex = new Set(o.exclude || []);
  const rnd = mulberry(hashStr(o.seed ?? `${Math.round(c.bpm)}:${c.style}`));
  const usable = id => !!rating(id) && (!avail || avail.has(id)) && prefs[id] !== -1 && !(c.drumless && rating(id).needsBeat);
  // used: effect id -> how many other remembered songs already have it as their look, so a library doesn't end up
  // with the same effect on every similar song (a soft push, at most 5 uses counted)
  const used = o.used || {};
  const choose = (ids, score, k = 4) => {
    const cand = [...new Set(ids)].filter(id => usable(id) && !ex.has(id)).map(id => ({ id, s: score(rating(id), c) + (prefs[id] === 1 ? 15 : 0) + 20 * clamp(nudge[id] || 0, -1, 1) - 5 * Math.min(5, used[id] || 0) }))
      .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1)).slice(0, k);
    if (!cand.length) return null;
    const w = cand.map(x => Math.exp((x.s - cand[0].s) / 8)), sum = w.reduce((a, b) => a + b, 0); let u = rnd() * sum;
    for (let i = 0; i < cand.length; i++) { u -= w[i]; if (u <= 0) return cand[i].id; } return cand[0].id;
  };
  const liked = Object.keys(prefs).filter(id => prefs[id] === 1 && rating(id));
  const main = choose([...AUTO.drop, ...AUTO.calm, ...liked], fitMain);
  if (!main) return null;
  const rm = rating(main), others = id => id !== main;
  const calm = rm.calm >= 65 || c.energy < 0.38 ? main : choose(AUTO.calm.filter(others), fitPart("calm")) || main;
  // a drop effect of its own only where the drops really stand out and the main effect isn't already a big one
  // (not for a calm song: a ballad's loud chorus keeps its gentle look, the feel layer lifts it)
  const drop = c.dynamic && c.energy >= 0.38 && !(rm.drop >= 75 && rm.energy === "high") ? choose(AUTO.drop.filter(id => others(id) && !(c.drumless && rating(id).needsBeat)), fitPart("drop"), 3) : null;
  const build = c.builds && c.energy >= 0.38 ? choose(AUTO.build.filter(others), fitPart("build"), 3) : null;
  const params = {}; if (!rm.needsBeat) params.speed = c.tempoSure === false ? 0.85 : r2(clamp(c.bpm / 120, 0.75, 1.3));
  if (c.energy > 0.7) params.intensity = 1.1; else if (c.energy < 0.3) params.intensity = 0.9;
  return { main, drop, build, calm, palette: paletteFor(c, rnd), params, why: whyOf(c, main, prefs), v: LOOK_VERSION };
}

// the palette from the mood (as the mood colours do: warm for happy, soft green and teal for calm and major, deep
// blue for sad, red and magenta for tense), else from the style and the key
const PAL_FOR = { happy: ["sunset", "fire", "neon"], calmUp: ["forest", "ocean", "ice"], sad: ["ocean", "ice", "mono"], tense: ["neon", "fire", "ice"] };
const PAL_STYLE = { party: ["neon", "fire"], hiphop: ["fire", "neon"], poprock: ["sunset", "neon"], chill: ["ocean", "forest"], emotional: ["sunset", "mono"] };
function paletteFor(c, rnd) {
  let list;
  if (c.mood) { const v = c.mood.valence, e = c.mood.energy; list = PAL_FOR[v >= 0.5 ? (e >= 0.5 ? "happy" : "calmUp") : (e >= 0.5 ? "tense" : "sad")]; }
  else list = c.mode === "minor" && c.energy < 0.5 ? ["ocean", "ice"] : PAL_STYLE[c.style] || ["neon", "sunset"];
  if (c.vocal > 0.45 && c.energy < 0.5 && !list.includes("sunset")) list = ["sunset", ...list]; // a voice up front: warm light
  return rnd() < 0.65 ? list[0] : list[1] || list[0];
}
function whyOf(c, main, prefs) {
  const tempo = c.tempoSure === false ? "" : c.bpm >= 124 ? "fast" : c.bpm <= 96 ? "slow" : "";
  const beat = c.drumless ? "no drums" : c.tempoSure === false ? "no steady drums" : c.kickFrac > 0.7 ? "four-on-the-floor" : c.kickFrac < 0.35 ? "light drums" : "steady beat";
  const out = [[tempo, beat].filter(Boolean).join(" "), c.energy >= 0.62 ? "high energy" : c.energy < 0.38 ? "calm" : "mid energy"];
  if (c.dynamic) out.push("big drops");
  if (c.vocal > 0.45) out.push("vocals");
  const m = moodName(c.mood); if (m) out.push(m);
  if (prefs[main] === 1) out.push("you like it");
  return out;
}

/** The effect a look plays for a song part ("calm", "build", "drop"; "silent" keeps calm) in a variety ("one", "parts"). */
export function lookEffect(look, variety, part) {
  if (!look) return null;
  if (variety === "parts") return (part === "drop" ? look.drop : part === "build" ? look.build : look.calm) || look.main;
  return part === "drop" && look.drop ? look.drop : look.main;
}
/** "Kick Shockwave · Sunset (fast four-on-the-floor, high energy)". names: effect id -> name. */
export function lookLabel(look, names = {}) {
  if (!look) return null; const p = look.palette ? look.palette[0].toUpperCase() + look.palette.slice(1) : null;
  return `${names[look.main] || look.main}${p ? ` · ${p}` : ""}${look.why && look.why.length ? ` (${look.why.slice(0, 2).join(", ")})` : ""}`;
}
/**
 * Which colour step of the look's palette plays now: a step on phrase lines. With sections (whole-song analysis), each
 * section label has its own step (a chorus that comes back has the same colour) and a long section steps again every
 * 16 bars; without (live listening), every 16 bars.
 */
export function phraseStep(V) {
  const s = V && V.section;
  if (s && s.label) { const n = s.label.charCodeAt(0) - 65 + (s.label.length > 1 ? 26 : 0); return Math.max(0, n) + Math.floor(Math.max(0, (V.barI ?? s.bar0) - s.bar0) / 16); }
  const g = V && V.g; if (!g || !g.has) return 0;
  return Math.floor((g.idx - g.beatInBar) / 4 / 16);
}
/** Show mode: only the effects automatic mode is meant to pick (AUTO), plus custom and liked ones; the whole pool if that leaves fewer than two. */
const ALL_AUTO = new Set([...AUTO.drop, ...AUTO.build, ...AUTO.calm]);
export function autoPool(list, keep) {
  const out = (list || []).filter(id => ALL_AUTO.has(id) || (keep && keep.has(id)));
  return out.length >= 2 ? out : list || [];
}
export { RATINGS, AUTO, rating };
