// Turns a room description (shapes on a 16 x 9 wall view) into per-LED arrays the effects read.
// Every effect works on any layout because it only uses these coordinates:
//   PX/PY  position in the room (PY 0 = floor, 1 = ceiling)    LS  position along its shape (0..1)
//   LA     angle around the shape's centre (0..1)              LD  distance from the shape's centre (0..1)
//   LG     position along the whole wiring chain (0..1)        LF  index of the shape the LED belongs to

export const STAGE_W = 16, STAGE_H = 9;
const LOOP_TYPES = new Set(["circle", "rect", "hex", "tri"]);

/** @typedef {{type:string, name?:string, count:number, pts?:number[][], cx?:number, cy?:number, size?:number,
 *  w?:number, h?:number, rot?:number, start?:number, rev?:boolean, cols?:number, rows?:number,
 *  dev?:string, from?:number|null}} Shape */

export function outline(s) {
  if (s.type === "line" || s.type === "pole" || s.type === "free") return s.pts;
  if (s.type === "matrix") { const w = s.w / 2, h = s.h / 2; return [[s.cx - w, s.cy - h], [s.cx + w, s.cy - h], [s.cx + w, s.cy + h], [s.cx - w, s.cy + h]]; }
  const r = s.size, a0 = (s.rot || 0) * Math.PI / 180, pts = [];
  if (s.type === "circle") {
    for (let k = 0; k < 96; k++) { const a = -Math.PI / 2 + a0 + k / 96 * Math.PI * 2; pts.push([s.cx + r * Math.cos(a), s.cy + r * Math.sin(a)]); }
  } else if (s.type === "rect") {
    const w = (s.w || s.size) / 2, h = (s.h || s.size) / 2, c = Math.cos(a0), sn = Math.sin(a0);
    for (const [x, y] of [[-w, -h], [w, -h], [w, h], [-w, h]]) pts.push([s.cx + x * c - y * sn, s.cy + x * sn + y * c]);
  } else {
    const n = s.type === "hex" ? 6 : 3, off = s.type === "hex" ? Math.PI / 6 : -Math.PI / 2;
    for (let k = 0; k < n; k++) { const a = off + a0 + k / n * Math.PI * 2; pts.push([s.cx + r * Math.cos(a), s.cy + r * Math.sin(a)]); }
  }
  return pts;
}

export function samplePath(pts, n, closed) {
  const P = closed ? pts.concat([pts[0]]) : pts, segL = []; let tot = 0;
  for (let i = 0; i < P.length - 1; i++) { const l = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); segL.push(l); tot += l; }
  const out = [];
  for (let k = 0; k < n; k++) {
    let d = closed ? tot * k / n : tot * k / Math.max(1, n - 1), i = 0;
    while (i < segL.length - 1 && d > segL[i]) { d -= segL[i]; i++; }
    const f = segL[i] ? Math.min(1, d / segL[i]) : 0;
    out.push([P[i][0] + (P[i + 1][0] - P[i][0]) * f, P[i][1] + (P[i + 1][1] - P[i][1]) * f]);
  }
  return out;
}

function matrixPts(s) { // serpentine wiring, like most LED matrices
  const pts = [];
  for (let r = 0; r < s.rows; r++) for (let k = 0; k < s.cols; k++) {
    const c = r % 2 ? s.cols - 1 - k : k;
    pts.push([s.cx - s.w / 2 + (s.cols > 1 ? c / (s.cols - 1) : 0.5) * s.w, s.cy - s.h / 2 + (s.rows > 1 ? r / (s.rows - 1) : 0.5) * s.h]);
  }
  return pts;
}

/** LED numbers on each controller: an explicit `from` wins, otherwise a shape continues after the previous one on that controller. */
export function segmentRanges(shapes) {
  const next = {};
  return shapes.map(s => { const a = s.from != null ? s.from : (next[s.dev] || 0), b = a + s.count - 1; next[s.dev] = Math.max(next[s.dev] || 0, b + 1); return { dev: s.dev, start: a, end: b }; });
}

/** @param {Shape[]} shapes */
export function buildLayout(shapes) {
  const all = [], chainStart = [];
  shapes.forEach((s, si) => {
    const loop = LOOP_TYPES.has(s.type);
    if (s.type === "matrix") s.count = s.cols * s.rows;
    let pts = s.type === "matrix" ? matrixPts(s) : samplePath(outline(s), s.count, loop);
    if (loop && s.start) { const k = Math.round(s.start * pts.length) % pts.length; pts = pts.slice(k).concat(pts.slice(0, k)); }
    if (s.rev) pts = loop ? [pts[0]].concat(pts.slice(1).reverse()) : pts.slice().reverse();
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    chainStart.push(all.length);
    pts.forEach((p, k) => {
      const along = loop ? k / pts.length : (pts.length > 1 ? k / (pts.length - 1) : 0);
      const ang = (loop || s.type === "matrix") ? ((Math.atan2(p[1] - cy, p[0] - cx) / (2 * Math.PI)) + 1.25) % 1 : along;
      all.push([p[0], p[1], along, ang, si, loop ? 1 : 0, Math.hypot(p[0] - cx, p[1] - cy)]);
    });
  });
  const N = all.length, maxD = {};
  all.forEach(a => { maxD[a[4]] = Math.max(maxD[a[4]] || 1e-6, a[6]); });
  const f32 = () => new Float32Array(N);
  const L = { N, shapes, chainStart, LX: f32(), LY: f32(), LS: f32(), LA: f32(), LU: f32(), LH: f32(), LR: f32(), LD: f32(), PX: f32(), PY: f32(), LG: f32(),
    LF: new Int16Array(N), LL: new Uint8Array(N) };
  all.forEach((a, i) => {
    L.LX[i] = a[0]; L.LY[i] = a[1]; L.LS[i] = a[2]; L.LA[i] = a[3]; L.LF[i] = a[4]; L.LL[i] = a[5]; L.LD[i] = a[6] / maxD[a[4]];
    L.LU[i] = a[0] / STAGE_W; L.LH[i] = 1 - a[1] / STAGE_H; L.LR[i] = Math.hypot((a[0] - 8) / STAGE_W, (a[1] - 3.6) / STAGE_W) / 0.5;
    L.PX[i] = a[0] / STAGE_H; L.PY[i] = 1 - a[1] / STAGE_H; L.LG[i] = N > 1 ? i / (N - 1) : 0;
  });
  return L;
}

/** The "living room" example used by the playground, tests and demos. */
export function exampleRoom() {
  const mk = (type, o) => Object.assign({ type, count: 60, rot: 0, start: 0, rev: false, dev: "WLED Living Room", from: null }, o);
  return [
    mk("free", { name: "Ceiling cove", count: 200, pts: [[0.1, 0.06], [3.75, 1.66], [12.25, 1.66], [15.9, 0.06]], dev: "WLED Ceiling" }),
    mk("rect", { name: "TV backlight", count: 110, cx: 8, cy: 3.6, w: 3.3, h: 1.85, size: 3.3 }),
    mk("circle", { name: "Ring light", count: 60, cx: 5.1, cy: 3.3, size: 0.75 }),
    mk("rect", { name: "Square frame", count: 60, cx: 10.9, cy: 3.3, w: 1.4, h: 1.4, size: 1.4 }),
    mk("hex", { name: "Hexagon 1", count: 30, cx: 7.4, cy: 2.25, size: 0.3, dev: "WLED Shelf" }),
    mk("hex", { name: "Hexagon 2", count: 30, cx: 8.0, cy: 2.25, size: 0.3, dev: "WLED Shelf" }),
    mk("hex", { name: "Hexagon 3", count: 30, cx: 8.6, cy: 2.25, size: 0.3, dev: "WLED Shelf" }),
    mk("pole", { name: "Pole left", count: 45, pts: [[3.98, 5.85], [3.98, 1.9]] }),
    mk("pole", { name: "Pole right", count: 45, pts: [[12.02, 5.85], [12.02, 1.9]] }),
    mk("line", { name: "Floor strip", count: 100, pts: [[3.85, 5.86], [12.15, 5.86]] }),
  ];
}
