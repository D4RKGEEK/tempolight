// Hand-made show timelines: on top of a song's effect blocks (show.js), colour blocks that override the palette for
// a stretch of the song, one-shot cues at exact times (a flash, a strobe or blackout for some beats, a build-up, a
// drop) and brightness keyframes. Times are seconds on the song's clock, kept to the millisecond.
//
// Stored on a remembered song next to `show` (the effect blocks, unchanged, so older data keeps working):
//   colors: [{t0, t1, palette: "<id>"} | {t0, t1, colors: ["#rrggbb", "#rrggbb"]}]   sorted, never overlapping
//   cues:   [{t, type: "flash"|"strobe"|"blackout"|"build"|"drop", color?: "#rrggbb", beats?: number}]   sorted by t
//   bright: [{t, v}]   v from 0 to 1, a straight line between keyframes, held before the first and after the last
// No I/O: the server validates with cleanTimeline() and the director plays it with the helpers below.

export const CUE_TYPES = ["flash", "strobe", "blackout", "build", "drop"];
/** How long a cue lasts when it doesn't say, in beats (a flash is a single hit). */
export const CUE_BEATS = { flash: 0, strobe: 4, blackout: 2, build: 16, drop: 16 };
const HEX = /^#[0-9a-f]{6}$/i;
const r3 = v => Math.round(v * 1000) / 1000;
const num = v => typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
const bad = msg => { const e = new Error(msg); e.code = 400; throw e; };

/** The item of a sorted, non-overlapping list of {t0, t1} at time t (binary search), or null. */
export function rangeAt(list, t) {
  if (!list || !list.length) return null; let lo = 0, hi = list.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m].t1 <= t) lo = m + 1; else if (list[m].t0 > t) hi = m - 1; else return list[m]; }
  return null;
}

/** Brightness (0..1) at time t from keyframes, or null when there are none. */
export function brightAt(keys, t) {
  if (!keys || !keys.length) return null; if (t <= keys[0].t) return keys[0].v; const last = keys[keys.length - 1]; if (t >= last.t) return last.v;
  let lo = 0, hi = keys.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m].t <= t) lo = m; else hi = m; }
  const a = keys[lo], b = keys[hi]; return b.t > a.t ? a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t) : b.v;
}

/** A cue's length in seconds, with beat length P. */
export const cueLen = (c, P) => (c.beats ?? CUE_BEATS[c.type] ?? 0) * (P > 0 ? P : 0.5);

/**
 * What the lasting cues do at time t: strobe, blackout, a build-up (with its progress) or a drop.
 * Worked out from the song's clock alone, so a seek lands in the right state straight away.
 * @returns {{strobe:null|{t:number}, blackout:boolean, build:null|{t0:number, t1:number}, drop:null|number}}
 */
export function cuesAt(cues, t, P) {
  const out = { strobe: null, blackout: false, build: null, drop: null };
  if (!cues) return out;
  for (const c of cues) {
    if (c.t > t) break; const end = c.t + cueLen(c, P); if (t >= end) continue;
    if (c.type === "strobe") out.strobe = { t: c.t }; else if (c.type === "blackout") out.blackout = true;
    else if (c.type === "build") out.build = { t0: c.t, t1: end }; else if (c.type === "drop") out.drop = c.t;
  }
  return out;
}

/**
 * Fires one-shot cues (flashes) once each as the song's clock passes them. A cue only fires within `late` seconds
 * after its time, so a seek forward skips the cues in between instead of firing them all at once; the clock
 * wobbling back a little (a position correction) doesn't fire one again, and a seek back before a cue re-arms it.
 */
export function createCueFirer(late = 0.25) {
  let fired = new Set(), list = null;
  return {
    /** @param {object[]} cues @param {number} t @param {(cue:object, lateBy:number)=>void} fire */
    step(cues, t, fire) {
      if (cues !== list) { list = cues; const keep = new Set(); for (const c of cues || []) if (fired.has(c)) keep.add(c); fired = keep; }
      if (!cues) return;
      for (const c of fired) if (t < c.t - late) fired.delete(c); // the clock went back before it: it can play again
      for (const c of cues) {
        if (c.t > t) break; if (c.type !== "flash" || fired.has(c)) continue;
        if (t - c.t < late) { fired.add(c); fire(c, t - c.t); }
      }
    },
    reset() { fired = new Set(); },
    get fired() { return fired.size; },
  };
}

// ---------------------------------------------------------------- validation (used by the server for PUT)
function ranges(list, end, what, each) {
  if (!Array.isArray(list)) bad(`${what} is a list`); if (list.length > 500) bad(`At most 500 ${what}`);
  const out = list.map(x => { if (!x || typeof x !== "object") bad(`Each of ${what} is an object`); const t0 = num(x.t0), t1 = num(x.t1);
    if (!(Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 && t0 >= 0)) bad(`Each of ${what} needs 0 <= t0 < t1`);
    if (t0 >= end) bad(`One of ${what} starts after the song ends`); return { t0: r3(t0), t1: r3(Math.min(t1, end)), ...each(x) }; }).sort((a, b) => a.t0 - b.t0);
  for (let i = 1; i < out.length; i++) if (out[i].t0 < out[i - 1].t1 - 1e-3) bad(`${what[0].toUpperCase() + what.slice(1)} overlap`);
  for (let i = 1; i < out.length; i++) if (out[i].t0 < out[i - 1].t1) out[i - 1].t1 = out[i].t0; // within a millisecond: touching
  return out;
}

/**
 * Check and tidy a timeline sent by the app. Fields left out are not returned (the caller keeps what it had).
 * @param {{show?:any, colors?:any, cues?:any, bright?:any}} body
 * @param {{dur:number, effects:Set<string>, palettes:Record<string, any>}} o
 * @returns {{show?:object[], colors?:object[], cues?:object[], bright?:object[]}}
 */
export function cleanTimeline(body, { dur, effects, palettes }) {
  const end = (dur || 0) + 1, out = {};
  if (body.show !== undefined) {
    if (!Array.isArray(body.show) || !body.show.length) bad("show is a list of {t0, t1, effect}");
    out.show = ranges(body.show, end, "blocks", x => { const effect = String(x.effect); if (!effects.has(effect)) bad(`Unknown effect "${effect}"`); return { part: String(x.part || "calm").slice(0, 10), effect }; });
  }
  if (body.colors !== undefined) out.colors = ranges(body.colors, end, "colour blocks", x => {
    if (x.colors !== undefined) { const c = Array.isArray(x.colors) ? x.colors.map(String) : []; if (c.length < 1 || c.length > 2 || !c.every(v => HEX.test(v))) bad("A colour block's colors are one or two #rrggbb colours");
      return { colors: (c.length === 1 ? [c[0], c[0]] : c).map(v => v.toLowerCase()) }; }
    const p = String(x.palette || ""); if (!palettes[p] || p === "auto") bad(`Unknown palette "${p}"`); return { palette: p }; });
  if (body.cues !== undefined) {
    if (!Array.isArray(body.cues)) bad("cues is a list"); if (body.cues.length > 500) bad("At most 500 cues");
    out.cues = body.cues.map(x => { if (!x || typeof x !== "object") bad("Each cue is an object"); const t = num(x.t), type = String(x.type);
      if (!(Number.isFinite(t) && t >= 0 && t <= end)) bad("A cue's time is in the song"); if (!CUE_TYPES.includes(type)) bad(`Unknown cue "${type}": ${CUE_TYPES.join(", ")}`);
      const c = { t: r3(t), type };
      if (x.color !== undefined && x.color !== null && x.color !== "") { if (type !== "flash" || !HEX.test(String(x.color))) bad("Only a flash has a colour, as #rrggbb"); c.color = String(x.color).toLowerCase(); }
      if (x.beats !== undefined && x.beats !== null && type !== "flash") { const b = num(x.beats); if (!(Number.isFinite(b) && b >= 0.25 && b <= 128)) bad("A cue lasts 0.25 to 128 beats"); c.beats = Math.round(b * 100) / 100; }
      return c; }).sort((a, b) => a.t - b.t);
  }
  if (body.bright !== undefined) {
    if (!Array.isArray(body.bright)) bad("bright is a list of {t, v}"); if (body.bright.length > 500) bad("At most 500 brightness keyframes");
    out.bright = body.bright.map(x => { const t = num(x?.t), v = num(x?.v); if (!(Number.isFinite(t) && t >= 0 && t <= end)) bad("A keyframe's time is in the song");
      if (!(Number.isFinite(v) && v >= 0 && v <= 1)) bad("A keyframe's brightness is 0 to 1"); return { t: r3(t), v: Math.round(v * 1000) / 1000 }; }).sort((a, b) => a.t - b.t);
  }
  return out;
}

/** The colours (linear 0..1 RGB pairs) of a colour block, or null. */
export function blockPalette(b, palettes) {
  if (!b) return null;
  if (b.colors) return b.colors.map(h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]);
  return palettes[b.palette] || null;
}
