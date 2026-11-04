// Camera LED mapping: light one LED at a time, find it in the camera picture, and turn the positions into a room
// shape. Pure functions (no DOM) so they can be tested; the Room page's camera screen uses them.

/** Grey levels (0-255) from RGBA image data. */
export function toGray(rgba, out = new Float32Array(rgba.length / 4)) { for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = 0.3 * rgba[i] + 0.59 * rgba[i + 1] + 0.11 * rgba[i + 2]; return out; }

/**
 * Where is the lit LED? Compares a frame with the dark frame and returns the centre of the brightest spot.
 * @returns {{x:number, y:number, strength:number}|null} x, y from 0 to 1
 */
export function detectSpot(frame, dark, w, h, { minDiff = 40 } = {}) {
  let max = 0, mi = -1;
  for (let i = 0; i < frame.length; i++) { const d = frame[i] - dark[i]; if (d > max) { max = d; mi = i; } }
  if (max < minDiff) return null;
  // centroid of the bright pixels near the brightest one (a reflection elsewhere doesn't pull it away)
  const mx = mi % w, my = (mi / w) | 0, R = Math.max(4, Math.round(Math.min(w, h) * 0.08)), cut = max * 0.55;
  let sx = 0, sy = 0, sw = 0;
  for (let y = Math.max(0, my - R); y < Math.min(h, my + R + 1); y++) for (let x = Math.max(0, mx - R); x < Math.min(w, mx + R + 1); x++) {
    const d = frame[y * w + x] - dark[y * w + x]; if (d > cut) { sx += x * d; sy += y * d; sw += d; } }
  // a second, equally bright spot far away means it's ambiguous (a mirror, a window): skip this LED
  for (let i = 0; i < frame.length; i++) { const x = i % w, y = (i / w) | 0; if ((Math.abs(x - mx) > R * 2 || Math.abs(y - my) > R * 2) && frame[i] - dark[i] > max * 0.8) return null; }
  return { x: (sx / sw + 0.5) / w, y: (sy / sw + 0.5) / h, strength: max };
}

/** Which LEDs to sample: all of them for short strips, otherwise about `max` spread evenly (always the first and last). */
export function sampleIndices(n, max = 80) { if (n <= max) return [...Array(n).keys()]; const out = []; for (let k = 0; k < max; k++) out.push(Math.round(k * (n - 1) / (max - 1))); return [...new Set(out)]; }

/**
 * Positions for every LED from the sampled ones: straight lines between found samples; LEDs before the first or
 * after the last found sample sit on it. Returns null when fewer than two were found.
 * @param {{i:number, p:[number,number]|null}[]} samples @param {number} n
 */
export function fillPositions(samples, n) {
  const ok = samples.filter(s => s.p).sort((a, b) => a.i - b.i); if (ok.length < 2) return null;
  const out = [];
  for (let i = 0, k = 0; i < n; i++) {
    while (k + 1 < ok.length - 1 && ok[k + 1].i <= i) k++;
    const a = ok[k], b = ok[Math.min(k + 1, ok.length - 1)];
    if (i <= ok[0].i) { out.push(ok[0].p.slice()); continue; } if (i >= ok.at(-1).i) { out.push(ok.at(-1).p.slice()); continue; }
    const f = b.i === a.i ? 0 : (i - a.i) / (b.i - a.i); out.push([a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f]);
  }
  return out;
}

/** Camera positions (0-1, y down, picture aspect `aspect` = width/height) into the 16 × 9 wall view, centred, with a margin. */
export function toStage(pts, aspect = 4 / 3, W = 16, H = 9, margin = 0.6) {
  const xs = pts.map(p => p[0] * aspect), ys = pts.map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = Math.min((W - 2 * margin) / Math.max(1e-3, x1 - x0), (H - 2 * margin) / Math.max(1e-3, y1 - y0)), ox = (W - (x1 - x0) * k) / 2, oy = (H - (y1 - y0) * k) / 2;
  return pts.map((p, i) => [Math.round((ox + (xs[i] - x0) * k) * 1000) / 1000, Math.round((oy + (ys[i] - y0) * k) * 1000) / 1000]);
}
