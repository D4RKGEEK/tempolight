// @tempolight/engine: song analysis, room layout and effects. No I/O, no dependencies:
// the same code runs in the browser playground, in tests and on a PC or Raspberry Pi.
export { preAnalyseCore, lastLE } from "./analysis.js";
export { buildLayout, exampleRoom, segmentRanges, outline, samplePath, STAGE_W, STAGE_H } from "./layout.js";
export { createEffects, createLetterbox } from "./effects.js";
export { songView, metronomeView, buildSignals, gridAt } from "./signals.js";
export { LiveAnalyser } from "./live.js";
export { DropPredictor } from "./drops.js";
export { LookaheadTimeline } from "./lookahead.js";
export { memoryEntry, memoryAnalysis, recognise, matchAt, refineByKicks, fingerprint, FingerprintTap, drumlessEntry, chromaMatch } from "./memory.js";
export { ChromaTap, keyOf, moodOf, moodName, moodPalette, hearsLabel, packChroma, unpackChroma } from "./tonal.js";
export { createDirector, idleSignals } from "./director.js";
export { planShow, showAt, chooseStep, SHOW_VERSION } from "./show.js";
export { pickLook, songCharacter, characterOf, lookEffect, lookLabel, LOOK_VERSION, VARIETIES, RATINGS, AUTO, rating } from "./looks.js";
export { cleanTimeline, rangeAt, brightAt, cuesAt, cueLen, createCueFirer, blockPalette, CUE_TYPES, CUE_BEATS } from "./timeline.js";
export { ROOM_PRESETS, buildPreset } from "./presets.js";

/** Convert linear effect output (0..~2) to 8-bit RGB with a soft roll-off and a brightness factor. */
export function toRGB8(col, out, brightness = 1) {
  const n = col.length; out = out || new Uint8Array(n);
  for (let i = 0; i < n; i++) { const v = col[i] * brightness; out[i] = v > 0 ? Math.min(255, Math.round(255 * (1 - Math.exp(-1.6 * v)))) : 0; }
  return out;
}
