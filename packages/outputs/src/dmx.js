// DMX fixtures: built-in profiles (a list of channels each), and writing a fixture's state into a 512-channel
// universe. No Node.js modules here: the runtime uses it on a PC or Pi and in the browser demo. The packets
// themselves are E1.31 / Art-Net (e131.js) with one full universe per device.
//
// A fixture's state is what it should do, whatever its channels are:
//   {r, g, b (0-255), dimmer (0-1), pan, tilt (0-1 of the fixture's range), shutter: "open"|"closed"|"strobe",
//    strobe (0-1 rate, 0 = steady), gobo (index into gobos), laser (bool), pattern (index into patterns), fog (0-1)}
// and each channel type takes its part of it.

export const DMX_CHANNELS = 512;

/** Channel types a profile (or a custom fixture) is made of. */
export const CHANNEL_TYPES = ["red", "green", "blue", "white", "amber", "dimmer", "strobe", "shutter", "pan", "pan-fine", "tilt", "tilt-fine",
  "speed", "colorwheel", "gobo", "laser", "pattern", "fog", "fixed", "none"];

// a typical colour wheel and gobo wheel; real fixtures differ, so a custom fixture can give its own
export const DEFAULT_WHEEL = [{ value: 0, color: [255, 255, 255] }, { value: 14, color: [255, 0, 0] }, { value: 28, color: [255, 128, 0] },
  { value: 42, color: [255, 255, 0] }, { value: 56, color: [0, 255, 0] }, { value: 70, color: [0, 255, 255] }, { value: 84, color: [0, 0, 255] }, { value: 98, color: [255, 0, 255] }];
export const DEFAULT_GOBOS = [0, 16, 32, 48, 64, 80, 96, 112]; // the first is "open" (no gobo)
export const DEFAULT_PATTERNS = [0, 32, 64, 96, 128, 160, 192, 224];
export const DEFAULT_SHUTTER = { open: 255, closed: 0, strobe: [64, 95] }; // strobe: slow..fast

const head = (bits16, wheel) => [...(bits16 ? ["pan", "pan-fine", "tilt", "tilt-fine"] : ["pan", "tilt"]), "speed", "dimmer", "shutter", ...(wheel ? ["colorwheel"] : ["red", "green", "blue"]), "gobo"];
/** Built-in profiles. `kind` decides how the fixture follows the music. */
export const DMX_PROFILES = {
  rgb: { name: "RGB par", kind: "par", channels: ["red", "green", "blue"] },
  rgbw: { name: "RGBW par", kind: "par", channels: ["red", "green", "blue", "white"] },
  rgba: { name: "RGBA par", kind: "par", channels: ["red", "green", "blue", "amber"] },
  dimmer: { name: "Dimmer", kind: "dimmer", channels: ["dimmer"] },
  strobe: { name: "Strobe (intensity, rate)", kind: "strobe", channels: ["dimmer", "strobe"] },
  "moving-head": { name: "Moving head, 8-bit, RGB", kind: "head", channels: head(false, false) },
  "moving-head-16": { name: "Moving head, 16-bit, RGB", kind: "head", channels: head(true, false) },
  "moving-head-wheel": { name: "Moving head, 8-bit, colour wheel", kind: "head", channels: head(false, true) },
  "moving-head-wheel-16": { name: "Moving head, 16-bit, colour wheel", kind: "head", channels: head(true, true) },
  laser: { name: "Laser (on/off, pattern)", kind: "laser", channels: ["laser", "pattern"] },
  fog: { name: "Fog machine", kind: "fog", channels: ["fog"] },
  custom: { name: "Custom (your channel list)", kind: "custom", channels: [] },
};

/** A channel as {type, value?}: "red", "fixed:128" and {type: "fixed", value: 128} all work. */
export function normChannel(c) {
  if (typeof c === "string") { const [type, v] = c.split(":"); return v !== undefined ? { type, value: Math.max(0, Math.min(255, Math.round(Number(v) || 0))) } : { type }; }
  if (c && typeof c === "object") return c.value !== undefined ? { type: String(c.type), value: Math.max(0, Math.min(255, Math.round(Number(c.value) || 0))) } : { type: String(c.type) };
  return { type: "none" };
}
/** The kind a channel list behaves as (for custom fixtures). */
export function kindOf(channels) {
  const t = new Set(channels.map(c => normChannel(c).type));
  if (t.has("pan") || t.has("tilt")) return "head";
  if (t.has("laser")) return "laser";
  if (t.has("fog")) return "fog";
  if (t.has("red") || t.has("green") || t.has("blue") || t.has("white") || t.has("amber")) return "par";
  if (t.has("strobe")) return "strobe";
  return "dimmer";
}
/** Everything needed to drive a fixture: {kind, channels: [{type, value?}], wheel, gobos, patterns, shutter, panRange, tiltRange}. */
export function fixtureProfile(f) {
  const p = DMX_PROFILES[f.profile] || DMX_PROFILES.rgb, raw = f.profile === "custom" ? f.channels || [] : p.channels, channels = raw.map(normChannel);
  return { kind: f.profile === "custom" ? kindOf(channels) : p.kind, channels, wheel: f.wheel || DEFAULT_WHEEL, gobos: f.gobos || DEFAULT_GOBOS, patterns: f.patterns || DEFAULT_PATTERNS,
    shutter: { ...DEFAULT_SHUTTER, ...(f.shutter || {}) }, panRange: f.panRange || 540, tiltRange: f.tiltRange || 270 };
}
export const channelCount = f => fixtureProfile(f).channels.length;

const clamp01 = v => v > 0 ? (v < 1 ? v : 1) : 0;
const byte = v => Math.max(0, Math.min(255, Math.round(v)));
function nearestWheel(wheel, r, g, b) {
  let best = wheel[0], bd = Infinity; const m = Math.max(r, g, b, 1), R = r / m * 255, G = g / m * 255, B = b / m * 255;
  for (const w of wheel) { const d = (w.color[0] - R) ** 2 + (w.color[1] - G) ** 2 + (w.color[2] - B) ** 2; if (d < bd) { bd = d; best = w; } }
  return best.value;
}

/**
 * Write one fixture's state into a universe. `out` is 512 bytes; f.address is 1-based (DMX numbering).
 * Colours: with white or amber channels, the shared part of R, G and B moves to them. With a dimmer channel next
 * to colour channels (moving heads), the colour is written at full strength and the dimmer sets the brightness.
 */
export function writeFixture(out, f, st, prof = fixtureProfile(f)) {
  const ch = prof.channels, types = new Set(ch.map(c => c.type));
  let r = st.r || 0, g = st.g || 0, b = st.b || 0, w = 0, a = 0;
  if (types.has("dimmer") && (types.has("red") || types.has("green") || types.has("blue"))) { const m = Math.max(r, g, b); if (m > 0) { r = r / m * 255; g = g / m * 255; b = b / m * 255; } }
  if (types.has("white")) { w = Math.min(r, g, b); r -= w; g -= w; b -= w; }
  if (types.has("amber")) { a = Math.min(r, g / 0.5); r -= a; g -= a * 0.5; } // amber is about (255, 128, 0)
  const pan = Math.round(clamp01(st.pan ?? 0.5) * 65535), tilt = Math.round(clamp01(st.tilt ?? 0.5) * 65535), sixteen = types.has("pan-fine") || types.has("tilt-fine");
  const sh = prof.shutter, rate = clamp01(st.strobe || 0);
  ch.forEach((c, i) => {
    const at = f.address - 1 + i; if (at < 0 || at >= DMX_CHANNELS) return;
    let v = 0;
    switch (c.type) {
      case "red": v = r; break; case "green": v = g; break; case "blue": v = b; break; case "white": v = w; break; case "amber": v = a; break;
      case "dimmer": v = clamp01(st.dimmer ?? 0) * 255; break;
      case "strobe": v = rate > 0 ? 10 + rate * 245 : 0; break; // 0: steady (no strobing) on most fixtures
      case "shutter": v = st.shutter === "strobe" ? sh.strobe[0] + rate * (sh.strobe[1] - sh.strobe[0]) : st.shutter === "closed" ? sh.closed : sh.open; break;
      case "pan": v = sixteen ? pan >> 8 : pan / 257; break; case "pan-fine": v = pan & 255; break;
      case "tilt": v = sixteen ? tilt >> 8 : tilt / 257; break; case "tilt-fine": v = tilt & 255; break;
      case "speed": v = c.value ?? 0; break; // pan/tilt speed: 0 is fastest on most heads; the movement itself is smoothed here
      case "colorwheel": v = nearestWheel(prof.wheel, st.r || 0, st.g || 0, st.b || 0); break;
      case "gobo": v = prof.gobos[Math.max(0, st.gobo || 0) % prof.gobos.length]; break;
      case "laser": v = st.laser ? (c.value ?? 255) : 0; break;
      case "pattern": v = prof.patterns[Math.max(0, st.pattern || 0) % prof.patterns.length]; break;
      case "fog": v = clamp01(st.fog || 0) * 255; break;
      case "fixed": v = c.value ?? 0; break;
      default: v = 0;
    }
    out[at] = byte(v);
  });
  return out;
}

/** Fixtures in a universe whose channels overlap: [[nameA, nameB], ...]. */
export function overlaps(fixtures) {
  const out = [], spans = fixtures.map(f => [f.address, f.address + channelCount(f) - 1, f.name]);
  for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) if (spans[i][0] <= spans[j][1] && spans[j][0] <= spans[i][1]) out.push([spans[i][2], spans[j][2]]);
  return out;
}
