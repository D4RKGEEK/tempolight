// STUB: replaced by scripts/effect-score.js
// How well each effect fits each song part (0-100), the tempos it looks best at, how much energy it carries, whether
// it is driven by the kick and needs a beat, and how busy it looks (0-1). AUTO: the effects automatic mode picks from,
// best first. This stub covers a few effects from the pools of effects.js; the generated file replaces it whole.
export const RATINGS = {
  shock: { drop: 92, build: 30, calm: 25, tempo: [110, 180], energy: "high", kickDriven: true, needsBeat: true, busy: 0.45 },
  laser: { drop: 88, build: 35, calm: 20, tempo: [115, 180], energy: "high", kickDriven: true, needsBeat: true, busy: 0.6 },
  tunnel: { drop: 84, build: 40, calm: 30, tempo: [100, 170], energy: "high", kickDriven: true, needsBeat: true, busy: 0.5 },
  spin: { drop: 80, build: 35, calm: 35, tempo: [100, 160], energy: "high", kickDriven: true, needsBeat: true, busy: 0.4 },
  ping: { drop: 82, build: 30, calm: 20, tempo: [110, 175], energy: "high", kickDriven: true, needsBeat: true, busy: 0.55 },
  cannon: { drop: 78, build: 25, calm: 15, tempo: [70, 150], energy: "high", kickDriven: true, needsBeat: true, busy: 0.35 },
  quake: { drop: 76, build: 30, calm: 25, tempo: [60, 110], energy: "high", kickDriven: true, needsBeat: true, busy: 0.3 },
  lighthouse: { drop: 66, build: 45, calm: 50, tempo: [80, 140], energy: "mid", kickDriven: false, needsBeat: true, busy: 0.3 },
  ripple: { drop: 62, build: 35, calm: 55, tempo: [70, 130], energy: "mid", kickDriven: true, needsBeat: true, busy: 0.35 },
  fill: { drop: 30, build: 90, calm: 20, tempo: [90, 180], energy: "mid", kickDriven: false, needsBeat: false, busy: 0.3 },
  riser: { drop: 25, build: 86, calm: 25, tempo: [60, 180], energy: "mid", kickDriven: false, needsBeat: false, busy: 0.2 },
  pillars: { drop: 35, build: 82, calm: 20, tempo: [100, 180], energy: "high", kickDriven: false, needsBeat: true, busy: 0.5 },
  countdown: { drop: 30, build: 80, calm: 15, tempo: [100, 180], energy: "mid", kickDriven: false, needsBeat: true, busy: 0.4 },
  helix: { drop: 40, build: 78, calm: 30, tempo: [90, 170], energy: "mid", kickDriven: false, needsBeat: false, busy: 0.45 },
  northern: { drop: 20, build: 25, calm: 90, tempo: [50, 140], energy: "low", kickDriven: false, needsBeat: false, busy: 0.25 },
  aurora: { drop: 15, build: 20, calm: 86, tempo: [50, 130], energy: "low", kickDriven: false, needsBeat: false, busy: 0.2 },
  galaxy: { drop: 30, build: 30, calm: 84, tempo: [60, 140], energy: "low", kickDriven: false, needsBeat: false, busy: 0.3 },
  candle: { drop: 5, build: 10, calm: 82, tempo: [40, 110], energy: "low", kickDriven: false, needsBeat: false, busy: 0.1 },
  ocean: { drop: 20, build: 25, calm: 80, tempo: [50, 130], energy: "low", kickDriven: false, needsBeat: false, busy: 0.3 },
  fireflies: { drop: 10, build: 15, calm: 78, tempo: [40, 120], energy: "low", kickDriven: false, needsBeat: false, busy: 0.2 },
  swell: { drop: 15, build: 30, calm: 76, tempo: [40, 110], energy: "low", kickDriven: false, needsBeat: false, busy: 0.15 },
  colorchord: { drop: 35, build: 30, calm: 72, tempo: [60, 140], energy: "mid", kickDriven: false, needsBeat: false, busy: 0.35 },
  lavablobs: { drop: 25, build: 20, calm: 74, tempo: [60, 130], energy: "low", kickDriven: false, needsBeat: false, busy: 0.25 },
};
export const AUTO = {
  drop: ["shock", "laser", "tunnel", "ping", "spin", "cannon", "quake", "lighthouse", "ripple"],
  build: ["fill", "riser", "pillars", "countdown", "helix"],
  calm: ["northern", "aurora", "galaxy", "candle", "ocean", "fireflies", "swell", "lavablobs", "colorchord"],
};
/** The rating of one effect, or null. */
export function rating(id) { return RATINGS[id] || null; }
