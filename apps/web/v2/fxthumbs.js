// Live effect thumbnails for the Looks gallery: the real effects (engine/effects.js) on a small room silhouette, fed a
// pretend 124-128 BPM beat (engine/signals.js metronomeView) so each card moves like it would to music, drawn with the
// look of the Stage's LED renderer (preview.js: dark tape, a bright core, bloom and light on the wall) in a lighter
// version made for many small canvases. Cheap on purpose: only cards on screen are drawn, at most `max` of them move at
// once (the others keep their last frame), each at 30 frames a second or less, every animation frame has a small time
// budget, and nothing moves while the page scrolls, so scrolling stays smooth. Under reduced motion every card shows one
// still frame. If the engine can't load, each card gets a still gradient in its kind's colours instead.

// a compact living room (16 x 9 stage units, as layout.js): a ceiling cove, a TV backlight with a ring and a square
// frame either side, two floor poles and a floor strip. About 300 LEDs, enough to read every effect at thumbnail size.
const mk = (type, o) => Object.assign({ type, count: 40, rot: 0, start: 0, rev: false, dev: "thumb", from: null }, o);
const ROOM = [
  mk("free", { name: "Ceiling", count: 72, pts: [[0.4, 0.55], [3.9, 1.7], [12.1, 1.7], [15.6, 0.55]] }),
  mk("rect", { name: "TV", count: 64, cx: 8, cy: 4.35, w: 4.4, h: 2.5, size: 4.4 }),
  mk("circle", { name: "Ring", count: 30, cx: 4.35, cy: 4.1, size: 0.85 }),
  mk("rect", { name: "Frame", count: 28, cx: 11.65, cy: 4.1, w: 1.5, h: 1.5, size: 1.5 }),
  mk("pole", { name: "Pole left", count: 30, pts: [[1.7, 7.9], [1.7, 2.6]] }),
  mk("pole", { name: "Pole right", count: 30, pts: [[14.3, 7.9], [14.3, 2.6]] }),
  mk("line", { name: "Floor", count: 50, pts: [[3.2, 7.95], [12.8, 7.95]] }),
];
const TAG_GRAD = { drop: ["#ff4f8b", "#ff8a1f"], build: ["#f5b83d", "#ff5e3a"], calm: ["#5b8cff", "#00b3a5"], home: ["#ffb648", "#ff8a1f"], any: ["#16e0ff", "#ff2bd6"], "LedFx-like": ["#16e0ff", "#3d4dff"] };
const hashStr = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
const toHex = c => "#" + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");

let engineP = null;
const loadEngine = () => engineP ||= Promise.all([import("/engine/effects.js"), import("/engine/signals.js"), import("/engine/layout.js")])
  .then(([E, S, L]) => ({ createEffects: E.createEffects, metronomeView: S.metronomeView, buildSignals: S.buildSignals, layout: L.buildLayout(ROOM.map(s => ({ ...s }))) }));

// hue rotation and saturation, as the director applies an effect's settings (director.js colourMatrix)
function colourMatrix(hue, sat) {
  const a = hue * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), lr = 0.2126, lg = 0.7152, lb = 0.0722;
  const H = [lr + c * (1 - lr) - s * lr, lg - c * lg - s * lg, lb - c * lb + s * (1 - lb), lr - c * lr + s * 0.143, lg + c * (1 - lg) + s * 0.14, lb - c * lb - s * 0.283,
    lr - c * lr - s * (1 - lr), lg - c * lg + s * lg, lb + c * (1 - lb) + s * lb];
  const S = [lr * (1 - sat) + sat, lg * (1 - sat), lb * (1 - sat), lr * (1 - sat), lg * (1 - sat) + sat, lb * (1 - sat), lr * (1 - sat), lg * (1 - sat), lb * (1 - sat) + sat];
  const M = new Array(9); for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) M[r * 3 + k] = S[r * 3] * H[k] + S[r * 3 + 1] * H[3 + k] + S[r * 3 + 2] * H[6 + k];
  return M;
}

/**
 * @param {{custom?: object[], palette?: () => string, params?: (id:string) => object|null, tagOf?: (id:string) => string, max?: number, fps?: number}} o
 */
export function createThumbs({ custom = [], palette = () => "auto", params = () => null, tagOf = () => "any", max = 12, fps = 30 } = {}) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const cards = new Map(), visible = new Set(); let E = null, fx = null, raf = 0, alive = true, failed = false, hovered = null;
  const frames = new Map(); let frameT = -1;
  const bands = new Float32Array(24), wave = new Float32Array(128), COL = { buf: null };

  const io = new IntersectionObserver(ents => { for (const e of ents) { const c = cards.get(e.target); if (!c) continue;
    if (e.isIntersecting) { c.w = e.boundingClientRect.width; c.h = e.boundingClientRect.height; visible.add(c); } else visible.delete(c); } wake(); }, { rootMargin: "80px 0px" });
  const ro = new ResizeObserver(ents => { for (const e of ents) { const c = cards.get(e.target); if (c) { c.w = e.contentRect.width; c.h = e.contentRect.height; c.drawn = false; } } wake(); });

  const ready = loadEngine().then(e => { if (!alive) return; E = e; build(custom); wake(); })
    .catch(err => { failed = true; for (const c of cards.values()) fallback(c); throw err; });
  ready.catch(() => {});
  function build(list) { fx = E.createEffects(E.layout, { custom: list }); COL.buf = new Float32Array(E.layout.N * 3); frames.clear(); }

  function fallback(c) { const [a, b] = TAG_GRAD[tagOf(c.id)] || TAG_GRAD.any; c.el.classList.add("is-static");
    c.el.style.background = `radial-gradient(60% 80% at 30% 40%, ${a}55, transparent 70%), radial-gradient(60% 80% at 75% 60%, ${b}4d, transparent 70%), #0b0a08`; }

  // the colours of one effect at time t, as 8-bit RGB per LED (shared by every card of that effect in this frame)
  function frameFor(id, t) {
    if (t !== frameT) { frameT = t; for (const f of frames.values()) f.fresh = false; }
    let f = frames.get(id); if (f && f.fresh) return f.rgb;
    if (!f) frames.set(id, f = { rgb: new Uint8Array(E.layout.N * 3), fresh: false });
    const h = hashStr(id), bpm = 124 + (h % 5), p = params(id) || {}, sp = p.speed ?? 1, tt = t * sp;
    const V = E.metronomeView(tt, bpm), beat = 60 / bpm, kickE = Math.exp(-(tt - V.kick) / 0.25), hatE = Math.exp(-(tt - V.hat) / 0.12);
    V.buildP = ((tt / beat) / 16) % 1; // a build-up every 16 beats: long enough to read, short enough to see it loop
    const tag = tagOf(id); if (tag === "calm") { V.state = "calm"; V.level = "low"; V.loud = 0.45; }
    for (let b = 0; b < 24; b++) bands[b] = b < 6 ? 0.25 + 0.75 * kickE : b < 16 ? 0.35 + 0.2 * Math.sin(tt * 2.1 + b) : 0.15 + 0.7 * hatE;
    for (let k = 0; k < 128; k++) wave[k] = Math.sin(2 * Math.PI * (k / 128 * 3 + tt * 1.7)) * (0.12 + 0.45 * kickE);
    const pn = palette(), P = fx.palettes, pal = pn === "auto" || !P[pn] ? P.auto[h % P.auto.length] : P[pn];
    const S = E.buildSignals(V, tt, { pal, fixed: pn !== "auto", bands, wave, bassL: 0.4 + 0.5 * kickE });
    S.text = "TEMPOLIGHT";
    const col = COL.buf; try { fx.render(id, S, col); } catch { col.fill(0); }
    const gain = (p.intensity ?? 1) * 1.15, hue = p.hue || 0, sat = p.saturation ?? 1, M = hue || sat !== 1 ? colourMatrix(hue, sat) : null, out = f.rgb;
    for (let i = 0; i < col.length; i += 3) { let r = col[i], g = col[i + 1], b = col[i + 2];
      if (M) { const r2 = M[0] * r + M[1] * g + M[2] * b, g2 = M[3] * r + M[4] * g + M[5] * b, b2 = M[6] * r + M[7] * g + M[8] * b; r = r2; g = g2; b = b2; }
      out[i] = r > 0 ? Math.min(255, 255 * (1 - Math.exp(-1.6 * r * gain))) : 0; out[i + 1] = g > 0 ? Math.min(255, 255 * (1 - Math.exp(-1.6 * g * gain))) : 0; out[i + 2] = b > 0 ? Math.min(255, 255 * (1 - Math.exp(-1.6 * b * gain))) : 0; }
    if (p.mirror) { const m = mirror(); for (let i = 0; i < m.length; i++) { const j = m[i]; if (j !== i) { out[i * 3] = out[j * 3]; out[i * 3 + 1] = out[j * 3 + 1]; out[i * 3 + 2] = out[j * 3 + 2]; } } }
    f.fresh = true; return out;
  }

  // left and right swapped: each LED on the right takes the colour of the nearest LED in its mirror image
  let MIR = null;
  function mirror() { if (MIR) return MIR; const { N, LX, LY } = E.layout; MIR = new Int32Array(N);
    for (let i = 0; i < N; i++) { MIR[i] = i; if (LX[i] <= 8) continue; let bd = 1e9; const tx = 16 - LX[i];
      for (let j = 0; j < N; j++) if (LX[j] <= 8) { const d = Math.abs(LX[j] - tx) + Math.abs(LY[j] - LY[i]); if (d < bd) { bd = d; MIR[i] = j; } } }
    return MIR; }

  // which neighbouring LEDs are joined into one continuous strip (the same layout for every card: worked out once)
  let SEG = null;
  function segments() { if (SEG) return SEG; const { N, LX, LY, LF, LL } = E.layout, out = [];
    for (let i = 1; i < N; i++) if (LF[i] === LF[i - 1]) out.push(i - 1, i);
    for (let f = 0, a = 0; a < N; f++) { let b = a; while (b + 1 < N && LF[b + 1] === LF[a]) b++; if (LL[a] && b > a + 2) out.push(b, a); a = b + 1; }
    return SEG = { idx: Int32Array.from(out), x: LX, y: LY }; }
  const key = (r, g, b) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4), rgbOf = k => `rgb(${((k >> 8) & 15) * 17},${((k >> 4) & 15) * 17},${(k & 15) * 17})`;
  function strokeGroups(ctx, groups, sx, sy) { const { idx, x, y } = SEG;
    for (const [k, list] of groups) { ctx.strokeStyle = rgbOf(k); ctx.beginPath(); for (const q of list) { const a = idx[q], b = idx[q + 1]; ctx.moveTo(x[a] * sx, y[a] * sy); ctx.lineTo(x[b] * sx, y[b] * sy); } ctx.stroke(); } }
  // one card's picture: the strips as dark tape, their light at 1/4 and 1/12 size scaled back up (bloom, and light on the
  // wall), then the strips themselves, going towards white where they are brightest
  function paint(c, f) {
    const { idx, x, y } = segments(), W = c.cv.width, H = c.cv.height, ctx = c.ctx;
    if (!c.low) { c.low = document.createElement("canvas"); c.lc = c.low.getContext("2d"); c.tiny = document.createElement("canvas"); c.tc = c.tiny.getContext("2d"); }
    const lw4 = Math.max(1, W >> 2), lh4 = Math.max(1, H >> 2), tw = Math.max(1, Math.round(W / 12)), th = Math.max(1, Math.round(H / 12));
    if (c.low.width !== lw4 || c.low.height !== lh4) { c.low.width = lw4; c.low.height = lh4; c.tiny.width = tw; c.tiny.height = th; }
    const lw = Math.max(1.6, W / 170), sx = W / 16, sy = H / 9;
    const lowG = new Map(), hiG = new Map(), hotG = new Map(), push = (m, k, q) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(q); };
    let lit = 0;
    for (let q = 0; q < idx.length; q += 2) { const a = idx[q] * 3, b = idx[q + 1] * 3, r = (f[a] + f[b]) >> 1, g = (f[a + 1] + f[b + 1]) >> 1, bl = (f[a + 2] + f[b + 2]) >> 1, m = Math.max(r, g, bl);
      lit += m; if (m < 8) continue; push(lowG, key(r, g, bl), q);
      const w = (m / 255) ** 2.2 * 0.6, lift = v => Math.min(255, Math.round(v * 1.6 + (255 - v) * w)); push(hiG, key(lift(r), lift(g), lift(bl)), q);
      if (m > 160) { const w2 = Math.min(0.85, w * 1.6), hot = v => Math.min(255, Math.round(v + (255 - v) * w2)); push(hotG, key(hot(r), hot(g), hot(bl)), q); } }
    lit = idx.length ? lit / (idx.length / 2) / 255 : 0;
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round"; ctx.lineWidth = lw; ctx.strokeStyle = "#1b1e25"; ctx.beginPath();
    for (let q = 0; q < idx.length; q += 2) { const a = idx[q], b = idx[q + 1]; ctx.moveTo(x[a] * sx, y[a] * sy); ctx.lineTo(x[b] * sx, y[b] * sy); } ctx.stroke();
    if (!lowG.size) return;
    const lc = c.lc, tc = c.tc; lc.globalCompositeOperation = "source-over"; lc.clearRect(0, 0, lw4, lh4); lc.globalCompositeOperation = "lighter"; lc.lineCap = "round"; lc.lineWidth = Math.max(1.5, lw * 0.9);
    strokeGroups(lc, lowG, lw4 / 16, lh4 / 9);
    tc.globalCompositeOperation = "source-over"; tc.clearRect(0, 0, tw, th); tc.imageSmoothingEnabled = true; tc.drawImage(c.low, 0, 0, tw, th);
    const gain = Math.max(0.6, Math.min(1.9, 1.9 - lit * 1.6));
    ctx.globalCompositeOperation = "lighter"; ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = Math.min(1, 0.75 * gain); ctx.drawImage(c.tiny, 0, 0, W, H); // light on the wall
    ctx.globalAlpha = Math.min(1, 0.6 * gain); ctx.drawImage(c.low, 0, 0, W, H);   // bloom around the strips
    ctx.globalAlpha = 1; ctx.lineCap = "butt"; ctx.lineWidth = lw; strokeGroups(ctx, hiG, sx, sy);
    ctx.lineWidth = lw * 0.4; strokeGroups(ctx, hotG, sx, sy);
  }
  function draw(c, t) {
    if (!c.cv) { c.cv = document.createElement("canvas"); c.el.appendChild(c.cv); c.ctx = c.cv.getContext("2d"); }
    const dpr = Math.min(1.25, devicePixelRatio || 1), W = Math.max(1, Math.round(c.w * dpr)), H = Math.max(1, Math.round(c.h * dpr));
    if (c.cv.width !== W || c.cv.height !== H) { c.cv.width = W; c.cv.height = H; }
    paint(c, frameFor(c.id, t));
  }

  const BUDGET = 6; // ms of drawing per animation frame; the rest of the frame stays free for scrolling and input
  let scrollAt = -1e9; const onScroll = () => { scrollAt = performance.now(); wake(); };
  addEventListener("scroll", onScroll, { capture: true, passive: true });
  function tick(now) {
    raf = 0; if (!alive || !E || document.hidden) return;
    const scrolling = now - scrollAt < 180, still = reduce.matches || scrolling, t = now / 1000, t0 = performance.now(), gap = 1000 / fps - 2;
    if (scrolling) { let fresh = false; for (const c of visible) if (!c.drawn) { fresh = true; break; } if (!fresh) { wake(); return; } } // while scrolling only new cards get a (still) frame
    let moving = 0, more = false;
    const order = hovered && visible.has(hovered) ? [hovered, ...[...visible].filter(c => c !== hovered)] : visible;
    for (const c of order) {
      if (!c.w || !c.h) continue;
      const anim = !still && moving < max; if (anim) moving++;
      if (c.drawn && (scrolling || !(anim && now - c.last >= gap))) { if (anim) more = true; continue; }
      if (performance.now() - t0 > (scrolling ? BUDGET / 2 : BUDGET)) { more = true; break; }
      draw(c, still || !anim ? (c.drawn ? t : 4.1) : t); c.last = now; c.drawn = true; if (anim) more = true;
    }
    if (more || scrolling) wake();
  }
  function wake() { if (!raf && alive && E) raf = requestAnimationFrame(tick); }
  const onVis = () => wake(), onMotion = () => { for (const c of cards.values()) c.drawn = false; wake(); };
  document.addEventListener("visibilitychange", onVis); reduce.addEventListener?.("change", onMotion);

  return {
    ready,
    /** Show effect `id` live in element `el` (an empty box with a size; the canvas is made the first time it shows). */
    attach(el, id) { const c = { el, id, cv: null, ctx: null, w: 0, h: 0, drawn: false, last: 0 }; cards.set(el, c); io.observe(el); ro.observe(el); if (failed) fallback(c); return c; },
    detach(el) { const c = cards.get(el); if (!c) return; io.unobserve(el); ro.unobserve(el); visible.delete(c); cards.delete(el); if (hovered === c) hovered = null; },
    /** Detach every card inside `root` (before its HTML is replaced). */
    clear(root) { for (const el of [...cards.keys()]) if (!root || root.contains(el)) this.detach(el); },
    /** The card under the pointer moves even when `max` cards already do. */
    hover(el) { hovered = el ? cards.get(el) || null : null; wake(); },
    /** Redraw everything (palette or effect settings changed). */
    refresh() { frames.clear(); for (const c of cards.values()) c.drawn = false; wake(); },
    setCustom(list) { custom = list; if (E) { build(list); this.refresh(); } },
    /** A palette's two colours as hex, for swatches (null until the engine has loaded). */
    paletteHex(name) { if (!fx) return null; const P = fx.palettes, p = P[name]; if (name === "auto" || !p) return P.auto.map(q => toHex(q[0])); return p.map(toHex); },
    destroy() { alive = false; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); cards.clear(); visible.clear(); document.removeEventListener("visibilitychange", onVis); removeEventListener("scroll", onScroll, { capture: true }); reduce.removeEventListener?.("change", onMotion); },
  };
}
