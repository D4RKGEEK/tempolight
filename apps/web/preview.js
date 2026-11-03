// Room preview that looks like real LEDs in a dark room: diffused strips drawn as continuous lines with a hot,
// nearly white core where they're bright, a tight bloom around them, and soft light spilling onto the wall.
// Unlit strips stay visible as dark tape, like in a real room. The glow is a bloom pyramid (halve, then add back up),
// which blurs smoothly for almost no cost, even on phones.

export function createRenderer(cv) {
  const ctx = cv.getContext("2d");
  const low = document.createElement("canvas"), lctx = low.getContext("2d");      // LED colours at 1/4 size
  let pyr = [];                                                                    // 1/8, 1/16, 1/32, 1/64 size copies for the blur
  function levels(w, h) {
    if (pyr.length && pyr[0].src === w) return pyr;
    pyr = []; for (let k = 1; k <= 4; k++) { const cv2 = document.createElement("canvas"); cv2.width = Math.max(1, w >> k); cv2.height = Math.max(1, h >> k);
      const c = cv2.getContext("2d"); c.imageSmoothingEnabled = true; pyr.push({ cv: cv2, c, w: cv2.width, h: cv2.height, src: w }); }
    return pyr;
  }
  const glowC = document.createElement("canvas"), gctx = glowC.getContext("2d");  // all the glow, combined at 1/4 size
  let segCache = { L: null, segs: null, dots: null }, W = 0, H = 0;

  // which neighbouring LEDs are joined into one continuous strip
  function segments(L) {
    if (segCache.L === L) return segCache;
    const segs = [], dots = [], shapes = L.shapes || [];
    const byShape = new Map(); for (let i = 0; i < L.N; i++) { const s = L.shape[i]; if (!byShape.has(s)) byShape.set(s, []); byShape.get(s).push(i); }
    for (const [s, idx] of byShape) {
      if ((shapes[s]?.type) === "matrix") { dots.push(...idx); continue; }
      const d = []; for (let k = 1; k < idx.length; k++) d.push(Math.hypot(L.x[idx[k]] - L.x[idx[k - 1]], L.y[idx[k]] - L.y[idx[k - 1]]));
      const med = d.length ? d.slice().sort((a, b) => a - b)[d.length >> 1] : 0.1, thr = Math.max(0.05, med * 3);
      for (let k = 1; k < idx.length; k++) if (d[k - 1] < thr) segs.push(idx[k - 1], idx[k]);
      if (idx.length > 3) { const a = idx[0], b = idx[idx.length - 1]; if (Math.hypot(L.x[a] - L.x[b], L.y[a] - L.y[b]) < thr) segs.push(b, a); }
      if (idx.length === 1) dots.push(idx[0]);
    }
    segCache = { L, segs, dots }; return segCache;
  }

  /**
   * @param {{N:number,x:ArrayLike<number>,y:ArrayLike<number>,shape:ArrayLike<number>,shapes?:any[]}} L layout (stage units 16 x 9)
   * @param {Uint8Array|null} f RGB bytes per LED, or null when nothing is streaming
   * @param {number} dpr
   */
  function draw(L, f, dpr, { selected = -1 } = {}) {
    if (cv.width !== W || cv.height !== H) { W = cv.width; H = cv.height; low.width = glowC.width = Math.max(1, W >> 2); low.height = glowC.height = Math.max(1, H >> 2); }
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; ctx.clearRect(0, 0, W, H); // the dark wall is the stage's CSS background
    if (!L || !L.N) return;
    const live = f && f.length === L.N * 3, sx = W / 16, sy = H / 9, { segs, dots } = segments(L);
    const lw = Math.max(2, Math.min(W / 300, 4.5 * dpr)), col = i => live ? [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]] : [0, 0, 0];

    // 1. the strips themselves, unlit: dark tape on the wall
    ctx.lineCap = "round"; ctx.lineWidth = lw; ctx.strokeStyle = "#1b1e25"; ctx.beginPath();
    for (let k = 0; k < segs.length; k += 2) { const a = segs[k], b = segs[k + 1]; ctx.moveTo(L.x[a] * sx, L.y[a] * sy); ctx.lineTo(L.x[b] * sx, L.y[b] * sy); }
    ctx.stroke();
    for (const i of dots) { ctx.fillStyle = "#1b1e25"; ctx.fillRect(L.x[i] * sx - lw, L.y[i] * sy - lw, lw * 2, lw * 2); }
    if (!live) return;

    // 2. light at 1/4 size, then blurred twice: a tight bloom and a wide spill onto the wall
    const lx = low.width / 16, ly = low.height / 9;
    lctx.globalCompositeOperation = "source-over"; lctx.clearRect(0, 0, low.width, low.height);
    lctx.globalCompositeOperation = "lighter"; lctx.lineCap = "round"; lctx.lineWidth = Math.max(1.5, lw * 0.6);
    // segments are grouped by (rounded) colour, so a frame is a few hundred strokes instead of thousands
    const groups = new Map(), hotGroups = new Map(), lowGroups = new Map(), key = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const push = (m, k, k4) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(k4); };
    let lit = 0;
    for (let k = 0; k < segs.length; k += 2) { const a = segs[k], b = segs[k + 1];
      const r = (f[a * 3] + f[b * 3]) >> 1, g = (f[a * 3 + 1] + f[b * 3 + 1]) >> 1, bl = (f[a * 3 + 2] + f[b * 3 + 2]) >> 1, m = Math.max(r, g, bl);
      lit += m;
      if (m < 6) continue;
      push(lowGroups, key(r, g, bl), k);
      if (m < 10) continue;
      const w = Math.pow(m / 255, 2.2) * 0.6, lift = v => Math.min(255, Math.round(v * 1.6 + (255 - v) * w));
      push(groups, key(lift(r), lift(g), lift(bl)), k);
      if (m > 150) { const w2 = Math.min(0.85, w * 1.6), hot = v => Math.min(255, Math.round(v + (255 - v) * w2)); push(hotGroups, key(hot(r), hot(g), hot(bl)), k); }
    }
    lit = segs.length ? lit / (segs.length / 2) / 255 : 0; // 0 = dark room, 1 = every LED at full
    const rgbOf = k => `rgb(${((k >> 10) & 31) * 8 + 4},${((k >> 5) & 31) * 8 + 4},${(k & 31) * 8 + 4})`;
    const strokeGroups = (c, m, scx, scy) => { for (const [k, list] of m) { c.strokeStyle = rgbOf(k); c.beginPath();
      for (const q of list) { const a = segs[q], b = segs[q + 1]; c.moveTo(L.x[a] * scx, L.y[a] * scy); c.lineTo(L.x[b] * scx, L.y[b] * scy); } c.stroke(); } };
    strokeGroups(lctx, lowGroups, lx, ly);
    for (const i of dots) { const c = col(i); if (Math.max(...c) < 6) continue; lctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; lctx.fillRect(L.x[i] * lx - 1, L.y[i] * ly - 1, 2, 2); }

    // bloom pyramid, as in game engines: halve the light 4 times (each halving averages 2 x 2 pixels, so it stays smooth),
    // then add the levels back up one doubling at a time. The small levels become the light thrown on the wall.
    const lv = levels(low.width, low.height); let src = low;
    for (const l of lv) { l.c.globalCompositeOperation = "source-over"; l.c.globalAlpha = 1; l.c.clearRect(0, 0, l.w, l.h); l.c.drawImage(src, 0, 0, l.w, l.h); src = l.cv; }
    for (let k = lv.length - 1; k > 0; k--) { const up = lv[k - 1]; up.c.globalCompositeOperation = "lighter"; up.c.globalAlpha = 0.6; up.c.drawImage(lv[k].cv, 0, 0, up.w, up.h); }
    const gw = glowC.width, gh = glowC.height; gctx.globalCompositeOperation = "source-over"; gctx.globalAlpha = 1; gctx.clearRect(0, 0, gw, gh);
    // how much of the light is lit decides the gain: a few lit LEDs glow strongly, a fully lit room doesn't blow out to white
    const gain = Math.max(0.55, Math.min(1.8, 1.8 - lit * 1.6));
    gctx.globalCompositeOperation = "lighter"; gctx.globalAlpha = Math.min(1, gain); gctx.drawImage(lv[0].cv, 0, 0, gw, gh);   // bloom and wall light
    if (gain > 1) { gctx.globalAlpha = gain - 1; gctx.drawImage(lv[0].cv, 0, 0, gw, gh); }
    gctx.globalAlpha = 0.35 * gain; gctx.drawImage(lv[3].cv, 0, 0, gw, gh);                                                      // wide light on the wall
    gctx.globalAlpha = 0.35; gctx.drawImage(low, 0, 0);                                                                          // halo hugging the strip
    ctx.globalCompositeOperation = "lighter"; ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 1; ctx.drawImage(glowC, 0, 0, W, H); // one full-size step

    // 3. the diffused strip: a continuous coloured line, going towards white where it's brightest (like a camera sees it)
    ctx.globalCompositeOperation = "lighter"; ctx.lineWidth = lw; ctx.lineCap = "butt"; // butt ends: neighbouring segments don't double up into beads
    strokeGroups(ctx, groups, sx, sy);
    ctx.lineWidth = lw * 0.4; strokeGroups(ctx, hotGroups, sx, sy);   // the hot centre a camera sees on bright LEDs
    for (const i of dots) { const c = col(i), m = Math.max(...c); if (m < 6) continue; const w = Math.pow(m / 255, 2.2) * 0.6, lift = v => Math.min(255, Math.round(v * 1.6 + (255 - v) * w));
      ctx.fillStyle = `rgb(${lift(c[0])},${lift(c[1])},${lift(c[2])})`; ctx.beginPath(); ctx.arc(L.x[i] * sx, L.y[i] * sy, lw * 0.9, 0, 6.283); ctx.fill(); }

    if (selected >= 0) { ctx.strokeStyle = "#f5a524"; ctx.lineWidth = 1.2 * dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (let i = 0; i < L.N; i++) if (L.shape[i] === selected) { x0 = Math.min(x0, L.x[i]); y0 = Math.min(y0, L.y[i]); x1 = Math.max(x1, L.x[i]); y1 = Math.max(y1, L.y[i]); }
      if (x1 >= x0) { const p = 0.18; ctx.strokeRect((x0 - p) * sx, (y0 - p) * sy, (x1 - x0 + 2 * p) * sx, (y1 - y0 + 2 * p) * sy); } ctx.setLineDash([]); }
  }
  return { draw };
}
