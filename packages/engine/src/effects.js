// Effects library: 62 effects that work on any LED layout.
// Extracted from the playground (apps/playground). Each effect reads per-LED arrays from the layout
// and a signals object S (see signals.js) and writes linear RGB into COL.
/* eslint-disable */
export function createEffects(layout) {
  const { N, LX, LY, LS, LA, LU, LH, LR, LF, LL, LD, PX, PY, LG, shapes } = layout;
  let COL = new Float32Array(N * 3);
  const hex = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  const PAL = [["#ff2bd6", "#ff8a1f"], ["#16e0ff", "#3d4dff"], ["#b14bff", "#ff3b6b"], ["#20ffa8", "#16a3ff"], ["#ffd23f", "#ff3d3d"]].map(p => p.map(hex));
  const WHITE = [1, 0.97, 0.94];
  const PALSETS = { neon: ["#ff2bd6", "#16e0ff"], sunset: ["#ff5e3a", "#ffb648"], ocean: ["#0a6cff", "#00e5d0"], fire: ["#ff3d00", "#ffc400"],
    ice: ["#7cc8ff", "#e8f6ff"], forest: ["#19c37d", "#c6ff3d"], mono: ["#ffe2b8", "#fff4e6"] };
  let melodyHue = 0; // smoothed state for Melody Colour
  const G = (x, w) => Math.exp(-(x / w) * (x / w));
  const wrapd = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };
  function rainbow(x) { x = ((x % 1) + 1) % 1; return [Math.min(1, Math.max(0, Math.abs(x * 6 - 3) - 1)), Math.min(1, Math.max(0, 2 - Math.abs(x * 6 - 2))), Math.min(1, Math.max(0, 2 - Math.abs(x * 6 - 4)))]; }
  function add(i, c, k) { const j = i * 3; COL[j] += c[0] * k; COL[j + 1] += c[1] * k; COL[j + 2] += c[2] * k; }
  const hash = n => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };

  const FX = [
    { id: "aurora", name: "Aurora Drift", tag: "calm", run(S) { const a = hex("#2a10a0"), b = hex("#00b3a5");
        for (let i = 0; i < N; i++) { const m = 0.5 + 0.5 * Math.sin(2 * Math.PI * (LU[i] * 1.3 - S.t * 0.1) + LH[i] * 3); add(i, a, 0.4 * (1 - m)); add(i, b, 0.4 * m); } } },
    { id: "stars", name: "Hi-hat Starfield", tag: "calm", run(S) { FX[0].run(S); for (let i = 0; i < COL.length; i++) COL[i] *= 0.5;
        const e = Math.exp(-(S.t - S.hat) / 0.09), seed = Math.floor(S.hat * 100);
        if (e > 0.02) for (let i = 0; i < N; i++) if (hash(i * 7.3 + seed) < 0.1) add(i, WHITE, e * 1.3); } },
    { id: "lava", name: "Lava Breath", tag: "calm", run(S) { const a = hex("#ff3d00"), b = hex("#ff0055"), br = 0.24 + 0.08 * Math.sin(2 * Math.PI * S.g.barPhase);
        for (let i = 0; i < N; i++) { const m = 0.5 + 0.5 * Math.sin(2 * Math.PI * (LU[i] * 0.9 + S.t * 0.06) + Math.sin(LH[i] * 4 + S.t * 0.7) * 1.5); add(i, a, m * br); add(i, b, (1 - m) * br); } } },
    { id: "fill", name: "Tension Fill", tag: "build", run(S) { const p = S.buildP, col = [0.48 * (1 - p) + p, 0.24 * (1 - p) + 0.97 * p, 1];
        for (let i = 0; i < N; i++) { const pos = LL[i] ? LA[i] : LS[i]; if (pos < p) add(i, col, 0.25 + 0.9 * p); add(i, WHITE, G(pos - p, 0.025) * 1.2); } } },
    { id: "comets", name: "Snare Comets", tag: "build", run(S) { const base = hex("#5a2ccf"), p = S.buildP;
        for (let i = 0; i < N; i++) add(i, base, 0.08 * (1 - p));
        for (const e of S.snares) { const dt = S.t - e; if (dt < 0 || dt > 0.6) continue; const r = dt / 0.45, f = 1 - dt / 0.6;
          for (let i = 0; i < N; i++) add(i, WHITE, G(LS[i] - r, 0.05) * f * 0.9); } } },
    { id: "shock", name: "Kick Shockwave", tag: "drop", run(S) { const [A1, B1] = S.pal, dt = S.t - S.pulseT, r = dt / 0.4, f = Math.max(0, 1 - dt / 0.5);
        for (let i = 0; i < N; i++) { add(i, A1, 0.1 + 0.5 * S.pulse); add(i, B1, G(LR[i] - r, 0.08) * f * 1.8); } } },
    { id: "spin", name: "Ring Spinners", tag: "drop", run(S) { const [A1, B1] = S.pal, dir = S.pulseN % 2 ? -1 : 1, head = ((S.t / (S.g.P || 0.5)) * 0.5 * dir % 1 + 1) % 1;
        for (let i = 0; i < N; i++) { add(i, A1, 0.05 + 0.12 * S.pulse); add(i, B1, (G(wrapd(LA[i], head), 0.06) + G(wrapd(LA[i], (head + 0.5) % 1), 0.06)) * (1.2 + 0.8 * S.pulse)); } } },
    { id: "ping", name: "Ping-Pong Sweep", tag: "drop", run(S) { const [A1, B1] = S.pal, dt = S.t - S.pulseT, x = dt / 0.38, f = Math.max(0, 1 - dt / 0.45), flip = S.pulseN % 2;
        for (let i = 0; i < N; i++) { add(i, A1, 0.1 + 0.5 * S.pulse); add(i, B1, G((flip ? 1 - LU[i] : LU[i]) - x, 0.06) * f * 1.8); } } },
    { id: "strobe", name: "Snare Strobe", tag: "drop", run(S) { const [A1, B1] = S.pal, on = S.pulseN % 2, se = Math.exp(-(S.t - S.snare) / 0.06);
        for (let i = 0; i < N; i++) { add(i, (LF[i] % 2) === on ? A1 : B1, 0.15 + 0.7 * S.pulse); add(i, WHITE, se * 1.4); } } },
    { id: "fireworks", name: "Fireworks", tag: "drop", run(S) {
        for (const e of S.pulses) { const dt = S.t - e; if (dt < 0 || dt > 0.9) continue; const k = Math.round(e * 10), cx = 0.2 + 0.6 * hash(k), cy = 0.35 + 0.5 * hash(k + 3), col = rainbow(hash(k + 9)), r = dt * 0.7;
          for (let i = 0; i < N; i++) { const d = Math.hypot(LU[i] - cx, (LH[i] - cy) * 0.7); add(i, col, G(d - r, 0.04) * (1 - dt / 0.9) * 2); add(i, WHITE, G(d, 0.05) * Math.exp(-dt / 0.08) * 2); } } } },
    { id: "kaleido", name: "Kaleido Bars", tag: "drop", run(S) { const bar = Math.floor(S.g.idx / 4);
        for (let i = 0; i < N; i++) add(i, rainbow(bar * 0.25 + ((LA[i] * 6) % 1) * 0.25 + LR[i] * 0.3), 0.25 + 0.75 * S.pulse); } },
    { id: "chase", name: "Lap Chase", tag: "drop", run(S) { const ph = S.g.barPhase, se = Math.exp(-(S.t - S.snare) / 0.1), [A1, B1] = S.pal;
        for (let i = 0; i < N; i++) { const pos = LL[i] ? LA[i] : LS[i]; add(i, B1, G(wrapd(pos, ph), 0.05) * 1.6); add(i, A1, G(wrapd(pos, (ph + 0.5) % 1), 0.05) * 1.6); add(i, WHITE, se * 0.4); } } },
    { id: "eq", name: "EQ Everywhere", tag: "drop", run(S) {
        const lv = [S.bassL, S.kickE, S.snareE, S.hatE, S.pulse];
        for (let i = 0; i < N; i++) { let pos = LL[i] ? 1 - Math.abs(LA[i] - 0.5) * 2 : LS[i]; const l = lv[LF[i] % 5] * 0.95 + 0.05;
          if (pos < l) add(i, [Math.min(1, pos * 2), Math.min(1, 2 - pos * 2), 0.4], 0.9); } } },
    { id: "spiral", name: "Spiral Up", tag: "build", run(S) { const sp = 0.5 + 3 * S.buildP;
        for (let i = 0; i < N; i++) { const ph = ((LA[i] * 2 - S.t * sp) % 1 + 1) % 1; add(i, rainbow(S.t * 0.1 + LA[i] * 0.3), G(Math.min(ph, 1 - ph), 0.1) * (0.4 + 0.9 * S.buildP)); } } },
    { id: "classic", name: "Classic Spectrum", tag: "LedFx-like", run(S) {
        for (let i = 0; i < N; i++) { const pos = LL[i] ? Math.abs(LA[i] - 0.5) * 2 : Math.abs(LS[i] - 0.5) * 2; const b = S.bands[Math.min(23, Math.floor(pos * 23))]; add(i, rainbow(LS[i] + S.t * 0.1), b * b * 0.9); } } },
    // ---- calm, slow and emotional
    { id: "ocean", name: "Ocean Waves", tag: "calm", run(S) { const a = S.fixed ? S.pal[0] : hex("#0a3cff"), b = S.fixed ? S.pal[1] : hex("#00e5d0");
        for (let i = 0; i < N; i++) { const w1 = 0.5 + 0.5 * Math.sin(2 * Math.PI * (LU[i] * 2 - S.t * 0.15) + LH[i] * 4), w2 = 0.5 + 0.5 * Math.sin(2 * Math.PI * (LU[i] * 3.3 + S.t * 0.11) - LH[i] * 2), m = (w1 + w2) / 2;
          add(i, a, 0.12 + 0.25 * m); add(i, b, 0.3 * m * m * (0.5 + 0.7 * S.loud)); } } },
    { id: "twinkle", name: "Twinkle Stars", tag: "calm", run(S) { const dens = 0.6 + 0.8 * S.hatE;
        for (let i = 0; i < N; i++) { const ph = (S.t * 0.35 + hash(i * 3.1)) % 1, b = Math.pow(Math.max(0, Math.sin(ph * Math.PI * 2)), 10) * dens; add(i, hash(i * 1.7) < 0.5 ? S.pal[0] : WHITE, b * 1.1); add(i, [0.05, 0.04, 0.14], 1); } } },
    { id: "plasma", name: "Plasma Field", tag: "calm", run(S) {
        for (let i = 0; i < N; i++) { const u = LU[i], h = LH[i], t = S.t; const v = Math.sin(u * 7 + t * 0.6) + Math.sin(h * 6 - t * 0.8) + Math.sin((u + h) * 5 + t * 0.4) + Math.sin(Math.hypot(u - 0.5, h - 0.5) * 12 - t);
          add(i, rainbow(v * 0.125 + t * 0.03), 0.28 + 0.12 * S.g.env * S.punch); } } },
    { id: "flow", name: "Rainbow Flow", tag: "calm", run(S) { const sp = S.g.has ? 1 / (S.g.P * 8) : 0.15;
        for (let i = 0; i < N; i++) add(i, rainbow((LL[i] ? LA[i] : LS[i]) - S.t * sp), 0.3 + 0.15 * S.g.env * S.punch); } },
    { id: "heart", name: "Heartbeat", tag: "calm", run(S) { const ph = S.g.phase * (S.g.P || 0.5), e = Math.exp(-ph / 0.08) + (ph > 0.16 ? 0.7 * Math.exp(-(ph - 0.16) / 0.08) : 0), col = S.fixed ? S.pal[0] : hex("#ff1f4b");
        for (let i = 0; i < N; i++) add(i, col, 0.06 + 0.7 * e * (1 - LD[i] * 0.6)); } },
    { id: "melody", name: "Melody Colour", tag: "calm", run(S) { let bi = 6, bv = 0; for (let b = 6; b < 24; b++) if (S.bands[b] > bv) { bv = S.bands[b]; bi = b; }
        let d = (bi - 6) / 18 * 0.8 - melodyHue; melodyHue += d * 0.04;
        for (let i = 0; i < N; i++) add(i, rainbow(melodyHue + LU[i] * 0.12), 0.12 + 0.45 * S.loud); } },
    { id: "swell", name: "Tide Swell", tag: "calm", run(S) { const a = S.fixed ? S.pal[0] : hex("#ff8a3d"), b = S.fixed ? S.pal[1] : hex("#ffd6a0"), lvl = 0.15 + 0.9 * S.loud;
        for (let i = 0; i < N; i++) { const h = LH[i], w = 0.04 * Math.sin(LU[i] * 9 + S.t * 0.8); const k = h < lvl + w ? 1 : G(h - lvl - w, 0.06);
          add(i, h < lvl * 0.6 ? a : b, k * (0.15 + 0.6 * S.loud)); } } },
    { id: "candle", name: "Candlelight", tag: "calm", run(S) { const c = S.fixed ? S.pal[0] : hex("#ff9a3c");
        for (let i = 0; i < N; i++) { const f = 0.75 + 0.15 * Math.sin(S.t * 7.3 + hash(i) * 20) + 0.1 * Math.sin(S.t * 13.1 + hash(i + 5) * 30); add(i, c, (0.1 + 0.25 * S.loud) * f); } } },
    { id: "sunrise", name: "Sunrise", tag: "calm", run(S) {
        for (let i = 0; i < N; i++) { const h = LH[i], k = 0.2 + 0.8 * S.loud; const c = [1, 0.25 + 0.6 * h * k, 0.1 + 0.6 * Math.max(0, h - 0.6) * k];
          add(i, c, (0.15 + 0.65 * k) * (1.1 - h * 0.4)); } } },
    // ---- build-up
    { id: "mrain", name: "Code Rain", tag: "build", run(S) { const sp = 0.4 + 2.2 * S.buildP;
        for (let i = 0; i < N; i++) { const col = Math.floor(LU[i] * 48), y = 1 - ((S.t * sp * (0.7 + 0.6 * hash(col)) + hash(col + 11)) % 1), d = LH[i] - y;
          const b = d >= 0 ? (d < 0.35 ? Math.exp(-d / 0.08) : 0) : G(d, 0.01); add(i, [0.2, 1, 0.45], b * 0.9); add(i, WHITE, G(d, 0.012) * 0.8); } } },
    { id: "scanner", name: "Beat Scanner", tag: "build", run(S) { const pos = 0.5 + 0.5 * Math.sin(2 * Math.PI * S.t * (0.25 + 1.75 * S.buildP));
        for (let i = 0; i < N; i++) { add(i, [1, 0.1, 0.15], G(LU[i] - pos, 0.04) * 1.5 + 0.03); add(i, WHITE, 0.3 * S.snareE); } } },
    { id: "riser", name: "Riser Glow", tag: "build", run(S) { const p = S.buildP, col = [S.pal[0][0] * (1 - p) + p, S.pal[0][1] * (1 - p) + p, S.pal[0][2] * (1 - p) + p], lvl = p * 1.1;
        for (let i = 0; i < N; i++) { const h = LH[i], b = h < lvl ? 0.15 + 0.8 * p : G(h - lvl, 0.05); add(i, col, b * (0.85 + 0.15 * Math.sin(S.t * 40 * p + i))); } } },
    // ---- drop / high energy
    { id: "wipe", name: "Colour Wipe", tag: "drop", run(S) { const bar = Math.floor((S.g.idx - S.g.beatInBar) / 4), x = Math.min(1, S.g.barPhase * 4);
        const cn = rainbow(bar * 0.17), co = rainbow((bar - 1) * 0.17); for (let i = 0; i < N; i++) add(i, LU[i] < x ? cn : co, 0.25 + 0.6 * S.pulse); } },
    { id: "confetti", name: "Confetti", tag: "drop", run(S) { for (let i = 0; i < N; i++) add(i, S.pal[0], 0.05);
        for (const e of S.pulses) { const dt = S.t - e; if (dt < 0 || dt > 0.5) continue; const seed = Math.round(e * 100);
          for (let i = 0; i < N; i++) if (hash(i * 13.7 + seed) < 0.14) add(i, rainbow(hash(i + seed)), Math.exp(-dt / 0.18) * 1.6 * S.punch); } } },
    { id: "burst", name: "Strobe Burst", tag: "drop", run(S) { const [A1, B1] = S.pal;
        if (S.g.beatInBar === 3 && S.punch > 0.6) { const on = Math.floor(S.g.phase * 8) % 2 === 0; for (let i = 0; i < N; i++) add(i, WHITE, on ? 1.5 : 0); }
        else for (let i = 0; i < N; i++) add(i, LH[i] > 0.5 ? A1 : B1, 0.12 + 0.8 * S.pulse); } },
    { id: "split", name: "Split Swap", tag: "drop", run(S) { const [A1, B1] = S.pal, left = S.g.idx % 2 === 0;
        for (let i = 0; i < N; i++) { const isL = LU[i] < 0.5; add(i, isL ? A1 : B1, isL === left ? 0.2 + 1.0 * S.pulse : 0.05); } } },
    { id: "mirror", name: "Beat Mirror", tag: "drop", run(S) { const [A1, B1] = S.pal, b = S.g.beatInBar;
        for (let i = 0; i < N; i++) { const band = Math.min(3, Math.floor(Math.abs(LU[i] - 0.5) * 8)); add(i, band === b ? B1 : A1, band === b ? 0.4 + 1.2 * S.pulse : 0.08); } } },
    { id: "rings", name: "Shape Pulse", tag: "drop", run(S) { const [A1, B1] = S.pal, nS = Math.max(1, shapes.length), target = ((S.pulseN % nS) + nS) % nS, dt = S.t - S.pulseT;
        for (let i = 0; i < N; i++) { add(i, A1, 0.08); if (LF[i] === target) add(i, B1, G(LD[i] - dt / 0.3, 0.15) * Math.max(0, 1 - dt / 0.45) * 2 + 0.3 * Math.exp(-dt / 0.15)); } } },
    { id: "meteor", name: "Meteor Shower", tag: "drop", run(S) { for (let i = 0; i < N; i++) add(i, S.pal[0], 0.04);
        for (const e of S.pulses) { const dt = S.t - e; if (dt < 0 || dt > 0.8) continue; const head = dt / 0.55, rv = Math.round(e * 10) % 2, f = 1 - dt / 0.8;
          for (let i = 0; i < N; i++) { const pos = LL[i] ? LA[i] : LS[i], d = head - (rv ? 1 - pos : pos), b = d >= 0 ? Math.exp(-d / 0.12) : G(d, 0.01); add(i, S.pal[1], b * f * 1.4); add(i, WHITE, G(d, 0.015) * f); } } } },
    { id: "lightning", name: "Lightning", tag: "drop", run(S) { const dt = S.t - S.snare, seed = Math.round(S.snare * 100), nS = Math.max(1, shapes.length), target = Math.floor(hash(seed) * nS);
        const flick = dt < 0.35 && (Math.sin(dt * 90) + 1) / 2 > 0.4 ? Math.exp(-dt / 0.12) * 2.2 * S.punch : 0;
        for (let i = 0; i < N; i++) { add(i, [0.02, 0.03, 0.12], 1); add(i, [0.1, 0.2, 0.8], 0.3 * S.pulse); if (flick && (LF[i] === target || hash(i + seed) < 0.1)) add(i, [0.85, 0.9, 1], flick); } } },
    { id: "fire", name: "Fire Pit", tag: "drop", run(S) { const boost = 0.5 + 0.8 * S.bassL + 0.5 * S.pulse;
        for (let i = 0; i < N; i++) { const u = LU[i], h = LH[i], t = S.t; const n = (0.5 + 0.5 * Math.sin(u * 31 + t * 6.3 + Math.sin(h * 13 - t * 4.1) * 2.2)) * (0.5 + 0.5 * Math.sin(u * 17 - t * 3.7 + h * 7));
          const heat = Math.max(0, n * boost * (1.15 - h * 0.7)); add(i, heat < 0.5 ? [heat * 2, heat * 0.6, 0] : [1, 0.3 + (heat - 0.5) * 1.2, Math.max(0, heat - 0.85) * 2], 0.2 + heat * 0.9); } } },
    { id: "wave", name: "Waveform", tag: "any", run(S) { if (!S.wave) return; const L = S.wave.length;
        for (let i = 0; i < N; i++) add(i, rainbow(LU[i] * 0.8 + S.t * 0.05), Math.min(1.5, Math.abs(S.wave[Math.floor(LU[i] * (L - 1))]) * 3)); } },
  ];
  // ===== Effects pack 2: room-space particles, beams, simulations. Every effect works on any layout:
  // PX/PY = position in the room (PY 0 floor .. 1 ceiling, PX 0 .. 1.78 left to right), LG = position along the whole wiring chain.
  const FXS = {};                                   // per-effect state (particles etc.)
  function st(S, id, init) {                        // fresh state when an effect starts or the song jumps
    let o = FXS[id];
    if (!o || S.t < o.t - 0.05 || S.t - o.t > 0.6) { o = FXS[id] = Object.assign({ t: S.t }, init ? init() : {}); }
    o.dt = Math.min(0.05, Math.max(0, S.t - o.t)); o.t = S.t; return o;
  }
  function splat(px, py, r, c, k) {                 // soft round light at a room position
    if (k < 0.004) return; const r2 = r * r, lim = 3 * r;
    for (let i = 0; i < N; i++) { const dx = PX[i] - px; if (dx > lim || dx < -lim) continue; const dy = PY[i] - py; if (dy > lim || dy < -lim) continue;
      const w = Math.exp(-(dx * dx + dy * dy) / r2); if (w > 0.01) add(i, c, k * w); }
  }
  const RW = 16 / 9;                                // room width in PX units
  const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const rnd = Math.random;

  const FX2 = [
    // ---------------- ambient, slow, emotional (always gives light)
    { id: "fireflies", name: "Firefly Swarm", tag: "calm", run(S) {
        const o = st(S, "fireflies", () => ({ p: Array.from({ length: 42 }, () => ({ x: rnd() * RW, y: rnd(), a: rnd() * 6.28, s: 0.05 + rnd() * 0.08, ph: rnd() * 6.28 })) }));
        const act = 0.6 + 1.2 * S.loud, warm = S.fixed ? S.pal[0] : [1, 0.85, 0.3], cool = S.fixed ? S.pal[1] : [0.55, 1, 0.35];
        for (let i = 0; i < N; i++) add(i, [0.02, 0.05, 0.03], 1);
        o.p.forEach((f, k) => { f.a += (Math.sin(S.t * 0.7 + k) * 1.6) * o.dt; f.x += Math.cos(f.a) * f.s * act * o.dt; f.y += Math.sin(f.a) * f.s * act * o.dt * 0.7;
          if (f.x < 0 || f.x > RW) f.a = Math.PI - f.a; if (f.y < 0 || f.y > 1) f.a = -f.a; f.x = Math.min(RW, Math.max(0, f.x)); f.y = Math.min(1, Math.max(0, f.y));
          const glow = Math.pow(0.5 + 0.5 * Math.sin(S.t * (1.2 + k % 5 * 0.3) + f.ph), 3) * (0.6 + 0.8 * S.hatE + 0.4 * S.loud);
          splat(f.x, f.y, 0.07, k % 3 ? warm : cool, glow * 1.6); });
      } },
    { id: "northern", name: "Northern Lights", tag: "calm", run(S) {
        const g = S.fixed ? S.pal[0] : [0.1, 1, 0.55], p = S.fixed ? S.pal[1] : [0.55, 0.2, 1], t = S.t;
        for (let i = 0; i < N; i++) { const x = PX[i], y = PY[i];
          const curtain = 0.5 + 0.5 * Math.sin(x * 5.5 + 1.4 * Math.sin(t * 0.25 + x * 1.7) + 0.6 * Math.sin(t * 0.5 - x * 3.1));
          const shimmer = 0.75 + 0.25 * Math.sin(y * 18 - t * 3 + x * 4);
          const band = Math.pow(curtain, 2.2) * shimmer * (0.35 + 0.65 * y) * (0.55 + 0.6 * S.loud);
          add(i, lerp3(g, p, Math.min(1, y * 1.2)), band * 0.9); add(i, [0.01, 0.03, 0.06], 1); } } },
    { id: "rainglass", name: "Rain on Glass", tag: "calm", run(S) {
        const o = st(S, "rainglass", () => ({ d: Array.from({ length: 28 }, () => ({ x: rnd() * RW, y: rnd(), v: 0.03 + rnd() * 0.08, w: rnd() * 6 })) }));
        const c = S.fixed ? S.pal[1] : [0.6, 0.8, 1];
        for (let i = 0; i < N; i++) add(i, [0.02, 0.04, 0.12], 1 + 0.6 * S.loud);
        o.d.forEach(d => { d.y -= d.v * o.dt * (1 + 2 * S.loud) * (Math.sin(S.t * 2 + d.w) > 0.6 ? 2.5 : 0.6); if (d.y < -0.05) { d.y = 1.05; d.x = rnd() * RW; }
          splat(d.x + 0.01 * Math.sin(S.t + d.w), d.y, 0.035, c, 1.2); splat(d.x, d.y + 0.06, 0.03, c, 0.35); splat(d.x, d.y + 0.12, 0.025, c, 0.15); });
      } },
    { id: "lavablobs", name: "Lava Lamp", tag: "calm", run(S) {
        const t = S.t * 0.25, B = [0, 1, 2, 3, 4].map(k => [RW * (0.5 + 0.38 * Math.sin(t * (0.7 + k * 0.13) + k * 2.1)), 0.5 + 0.38 * Math.sin(t * (0.5 + k * 0.17) + k * 1.3), 0.03 + 0.012 * k]);
        const a = S.fixed ? S.pal[0] : [1, 0.25, 0.05], b = S.fixed ? S.pal[1] : [1, 0.75, 0.1];
        for (let i = 0; i < N; i++) { let f = 0; for (const [bx, by, r] of B) { const dx = PX[i] - bx, dy = PY[i] - by; f += r / (dx * dx + dy * dy + 1e-3); }
          const k = Math.min(1, Math.max(0, (f - 0.7) * 1.4)); add(i, lerp3(a, b, k), 0.12 + k * (0.7 + 0.3 * S.loud)); } } },
    { id: "breath", name: "Deep Breath", tag: "calm", run(S) {
        const ph = S.g.has ? ((S.g.idx - S.g.beatInBar) / 4 % 4 + S.g.barPhase) / 4 : S.t / 12;  // one breath every 4 bars
        const br = 0.25 + 0.55 * Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * ph), 1.5);
        for (let i = 0; i < N; i++) add(i, lerp3(S.pal[0], S.pal[1], PY[i]), br * (0.8 + 0.4 * S.loud)); } },
    { id: "hypno", name: "Hypno Spiral", tag: "calm", run(S) {
        const sp = 0.15 + 0.5 * S.loud + (S.g.has ? 0.25 / (S.g.P * 2) : 0);
        for (let i = 0; i < N; i++) { const dx = PX[i] - RW / 2, dy = PY[i] - 0.5, a = Math.atan2(dy, dx) / (2 * Math.PI), r = Math.log(Math.hypot(dx, dy) + 0.05);
          const v = ((a * 3 + r * 1.6 - S.t * sp) % 1 + 1) % 1; add(i, rainbow(a + S.t * 0.02), (0.08 + 0.7 * G(Math.min(v, 1 - v), 0.12)) * (0.6 + 0.5 * S.loud)); } } },

    // ---------------- build-ups
    { id: "pillars", name: "Rising Pillars", tag: "build", run(S) { const p = S.buildP, cols = 14;
        for (let i = 0; i < N; i++) { const c = Math.min(cols - 1, Math.floor(PX[i] / RW * cols)), stag = hash(c * 3.7) * 0.35, lvl = Math.max(0, p * 1.35 - stag);
          const y = PY[i], col = lerp3(S.pal[0], WHITE, p * p);
          add(i, col, y < lvl ? 0.18 + 0.7 * p : 0); add(i, WHITE, G(y - lvl, 0.025) * (0.6 + 1.2 * S.snareE)); } } },
    { id: "tstrobe", name: "Tension Strobe", tag: "build", run(S) { const p = S.buildP, rate = Math.pow(2, Math.floor(p * 4.99));  // 1,2,4,8,16 flashes per beat
        const on = (S.g.phase * rate) % 1 < 0.22, col = lerp3(S.pal[0], WHITE, p);
        for (let i = 0; i < N; i++) add(i, col, 0.05 + (on ? 0.25 + 1.0 * p : 0)); } },
    { id: "vortex", name: "Vortex Charge", tag: "build", run(S) { const p = S.buildP, tight = 1 + 6 * p, sp = 0.3 + 3 * p, reach = 1.2 - p;
        for (let i = 0; i < N; i++) { const dx = PX[i] - RW / 2, dy = PY[i] - 0.5, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx) / (2 * Math.PI);
          const v = ((a * 2 + d * tight - S.t * sp) % 1 + 1) % 1, arm = G(Math.min(v, 1 - v), 0.09);
          add(i, lerp3(S.pal[0], S.pal[1], d), arm * (0.3 + 0.9 * p) * (d < reach + 0.3 ? 1 : 0.2)); add(i, WHITE, G(d, 0.05 + 0.25 * p * p) * p * 1.5); } } },
    { id: "implode", name: "Implosion", tag: "build", run(S) {
        const o = st(S, "implode", () => ({ p: [] })), p = S.buildP;
        for (let k = 0; k < 2 + Math.floor(p * 10); k++) { const a = rnd() * 6.28, r = 0.9 + rnd() * 0.3; o.p.push({ x: RW / 2 + Math.cos(a) * r * RW / 2, y: 0.5 + Math.sin(a) * r * 0.6, c: rnd() < 0.5 ? 0 : 1 }); }
        for (let i = 0; i < N; i++) add(i, S.pal[0], 0.05);
        o.p = o.p.filter(q => { const dx = RW / 2 - q.x, dy = 0.5 - q.y, d = Math.hypot(dx, dy); const v = (0.2 + 1.8 * p) * o.dt / Math.max(d, 0.05);
          q.x += dx * v; q.y += dy * v; splat(q.x, q.y, 0.035, q.c ? S.pal[1] : WHITE, 1.1); return d > 0.03; }).slice(-220);
        splat(RW / 2, 0.5, 0.06 + 0.2 * p, WHITE, p * 1.8); } },

    // ---------------- high energy
    { id: "laser", name: "Laser Show", tag: "drop", run(S) {
        const bar = Math.floor((S.g.idx - S.g.beatInBar) / 4), pivots = [[RW / 2, -0.05], [0.05, 0.02], [RW - 0.05, 0.02]];
        const piv = bar % 3 === 0 ? [pivots[0]] : [pivots[1], pivots[2]], nb = 3 + bar % 3, spread = 0.9 + 0.4 * Math.sin(S.t * 0.7);
        const swing = Math.sin(2 * Math.PI * (S.g.barPhase + (S.g.idx % 2) * 0.1)) * 0.6, w = 0.028 + 0.03 * S.pulse;
        for (let i = 0; i < N; i++) add(i, S.pal[0], 0.03);
        piv.forEach(([px, py], pk) => { for (let b = 0; b < nb; b++) {
          const ang = Math.PI / 2 + (b - (nb - 1) / 2) * spread / nb * 2 + swing * (pk ? -1 : 1), cx = Math.cos(ang), cy = Math.sin(ang), col = b % 2 ? S.pal[1] : S.pal[0];
          for (let i = 0; i < N; i++) { const dx = PX[i] - px, dy = PY[i] - py, along = dx * cx + dy * cy; if (along < 0) continue;
            const perp = Math.abs(dx * cy - dy * cx); if (perp < 5 * w) add(i, col, G(perp, w) * (0.9 + 1.4 * S.pulse) + G(perp, w * 4) * 0.22); } } });
      } },
    { id: "hyper", name: "Hyperspace", tag: "drop", run(S) {
        const o = st(S, "hyper", () => ({ s: [] })), sp = 0.4 + 2.5 * S.pulse + 0.8 * S.loud;
        for (let k = 0; k < 3 + Math.floor(S.pulse * 8); k++) { const a = rnd() * 6.28; o.s.push({ a, r: 0.02, c: rnd() < 0.15 ? 1 : 0 }); }
        for (let i = 0; i < N; i++) add(i, [0.01, 0.0, 0.04], 1);
        o.s = o.s.filter(q => { q.r += q.r * sp * o.dt * 3 + 0.05 * o.dt; const x = RW / 2 + Math.cos(q.a) * q.r * 1.4, y = 0.5 + Math.sin(q.a) * q.r * 0.8;
          const k = Math.min(1, q.r * 2); splat(x, y, 0.02 + q.r * 0.03, q.c ? S.pal[1] : WHITE, k * 1.4);
          splat(RW / 2 + Math.cos(q.a) * q.r * 1.2, 0.5 + Math.sin(q.a) * q.r * 0.68, 0.02, q.c ? S.pal[1] : S.pal[0], k * 0.5); return q.r < 1.1; }).slice(-160);
      } },
    { id: "nova", name: "Supernova", tag: "drop", run(S) {
        const o = st(S, "nova", () => ({ bar: -1, x: RW / 2, y: 0.5, t0: -9, sp: [] }));
        const bar = Math.floor((S.g.idx - S.g.beatInBar) / 4);
        if (bar !== o.bar && S.g.beatInBar === 0) { o.bar = bar; o.x = RW * (0.25 + 0.5 * rnd()); o.y = 0.3 + 0.4 * rnd(); o.t0 = S.t;
          for (let k = 0; k < 40; k++) { const a = rnd() * 6.28, v = 0.2 + rnd() * 0.6; o.sp.push({ x: o.x, y: o.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1 }); } }
        const dt = S.t - o.t0, r = dt * 1.6;
        for (let i = 0; i < N; i++) { const d = Math.hypot(PX[i] - o.x, PY[i] - o.y), f = Math.max(0, 1 - dt / 1.6);
          add(i, [1, 0.2, 0.3], G(d - r, 0.05) * f * 1.6); add(i, [0.3, 1, 0.4], G(d - r * 0.93, 0.04) * f * 1.2); add(i, [0.3, 0.4, 1], G(d - r * 0.86, 0.05) * f * 1.4);
          add(i, WHITE, G(d, 0.08) * Math.exp(-dt / 0.15) * 2.5); add(i, S.pal[0], 0.04 + 0.2 * S.pulse * Math.max(0, 1 - d)); }
        o.sp = o.sp.filter(q => { q.x += q.vx * o.dt; q.y += q.vy * o.dt; q.vy -= 0.3 * o.dt; q.life -= o.dt * 0.6; splat(q.x, q.y, 0.025, S.pal[1], q.life * 1.3); return q.life > 0; });
      } },
    { id: "cannon", name: "Bass Cannon", tag: "drop", run(S) {
        const o = st(S, "cannon", () => ({ last: -9, sh: [], sp: [] }));
        if (S.pulseT > o.last + 0.05 && S.t - S.pulseT < 0.1) { o.last = S.pulseT; o.sh.push({ x: RW * (0.15 + 0.7 * rnd()), y: 0, vy: 1.6 + rnd() * 0.5, c: rainbow(rnd()) }); }
        for (let i = 0; i < N; i++) add(i, S.pal[0], 0.04 + 0.12 * S.pulse * (1 - PY[i]));
        o.sh = o.sh.filter(q => { q.y += q.vy * o.dt; q.vy -= 2.2 * o.dt; splat(q.x, q.y, 0.03, WHITE, 1.4);
          if (q.vy <= 0) { for (let k = 0; k < 26; k++) { const a = rnd() * 6.28, v = 0.15 + rnd() * 0.45; o.sp.push({ x: q.x, y: q.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, c: q.c, life: 1 }); } return false; } return true; });
        o.sp = o.sp.filter(q => { q.x += q.vx * o.dt; q.y += q.vy * o.dt; q.vy -= 0.45 * o.dt; q.life -= o.dt * 0.8; splat(q.x, q.y, 0.03, q.c, q.life * 1.5); return q.life > 0; }).slice(-300);
      } },
    { id: "disco", name: "Disco Ball", tag: "drop", run(S) {
        const rot = S.t * (0.25 + 0.15 * S.loud), spots = 70, flash = 0.8 + 1.4 * S.pulse;
        for (let i = 0; i < N; i++) add(i, S.pal[0], 0.04);
        for (let k = 0; k < spots; k++) { const lat = (hash(k) - 0.5) * 2.4, lon = hash(k + 99) * 6.283 + rot;
          if (Math.cos(lon) < -0.1) continue;  // only the side facing the room
          const x = RW / 2 + Math.sin(lon) * Math.cos(lat) * RW * 0.55, y = 0.55 + Math.sin(lat) * 0.5;
          splat(x, y, 0.028, k % 4 ? WHITE : S.pal[1], flash * (0.5 + 0.5 * Math.cos(lon))); } } },
    { id: "roomeq", name: "Room Equalizer", tag: "drop", run(S) {
        const o = st(S, "roomeq", () => ({ pk: new Float32Array(24) }));
        for (let b = 0; b < 24; b++) o.pk[b] = Math.max(S.bands[b], o.pk[b] - o.dt * 0.6);
        for (let i = 0; i < N; i++) { const pos = Math.abs(PX[i] / RW - 0.5) * 2, b = Math.min(23, Math.floor(pos * 24)), lvl = S.bands[b] * 1.05, y = PY[i];
          if (y < lvl) add(i, [Math.min(1, y * 2), Math.min(1, 2 - y * 2), 0.25], 0.85); add(i, WHITE, G(y - o.pk[b], 0.02) * 1.2); add(i, [0.03, 0.02, 0.06], 1); } } },
    { id: "rgbsplit", name: "RGB Split", tag: "drop", run(S) {
        const sep = 0.04 + 0.35 * S.pulse, base = S.t * 0.6;
        const ch = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) { const x = PX[i] / RW + (c - 1) * sep; const v = 0.5 + 0.5 * Math.sin(2 * Math.PI * (x * 2.5 - base) + PY[i] * 3);
          add(i, ch[c], Math.pow(v, 6) * 1.3); } } },
    { id: "glitch", name: "Glitch", tag: "drop", run(S) {
        const o = st(S, "glitch", () => ({ cuts: [], last: -9 }));
        for (let i = 0; i < N; i++) add(i, S.pal[0], 0.12 + 0.3 * S.pulse);
        if ((S.t - S.snare < 0.05 && S.snare !== o.last) || rnd() < 0.04 * (0.5 + S.loud)) { o.last = S.snare;
          for (let k = 0; k < 2 + Math.floor(rnd() * 4); k++) o.cuts.push({ a: rnd(), len: 0.02 + rnd() * 0.12, until: S.t + 0.05 + rnd() * 0.12, c: [rnd() < 0.5 ? 1 : 0, rnd() < 0.5 ? 1 : 0, 1], inv: rnd() < 0.3 }); }
        o.cuts = o.cuts.filter(c => S.t < c.until);
        for (const c of o.cuts) for (let i = 0; i < N; i++) { const g2 = LG[i]; if (g2 >= c.a && g2 < c.a + c.len) { const j = i * 3; if (c.inv) { COL[j] = 1 - Math.min(1, COL[j]); COL[j + 1] = 1 - Math.min(1, COL[j + 1]); COL[j + 2] = 1 - Math.min(1, COL[j + 2]); } else add(i, c.c, 1.4); } }
      } },
    { id: "snake", name: "Neon Snakes", tag: "drop", run(S) {
        const lap = S.g.has ? S.g.P * 16 : 6, len = 0.03 + 0.09 * S.loud + 0.04 * S.pulse, bar = Math.floor((S.g.idx - S.g.beatInBar) / 4);
        for (let i = 0; i < N; i++) add(i, S.pal[0], 0.03);
        for (let k = 0; k < 3; k++) { const head = ((S.t / lap) + k / 3) % 1, col = rainbow(bar * 0.13 + k * 0.33);
          for (let i = 0; i < N; i++) { let d = head - LG[i]; if (d < 0) d += 1; if (d < len) add(i, d < 0.004 ? WHITE : col, (1 - d / len) * 1.5); } } } },
    { id: "pong", name: "Pong", tag: "drop", run(S) {
        const o = st(S, "pong", () => ({ x: RW / 2, y: 0.5, vx: 0.7, vy: 0.45, tr: [], last: -9 }));
        if (S.pulseT !== o.last && S.t - S.pulseT < 0.08) { o.last = S.pulseT; const k = 1.25; o.vx *= k; o.vy *= k; }
        const sp = Math.hypot(o.vx, o.vy); if (sp > 0.7) { o.vx *= 1 - o.dt * 0.8; o.vy *= 1 - o.dt * 0.8; }
        o.x += o.vx * o.dt; o.y += o.vy * o.dt; if (o.x < 0 || o.x > RW) o.vx *= -1; if (o.y < 0 || o.y > 1) o.vy *= -1;
        o.tr.push([o.x, o.y]); if (o.tr.length > 18) o.tr.shift();
        for (let i = 0; i < N; i++) add(i, S.pal[0], 0.03);
        o.tr.forEach(([x, y], k) => splat(x, y, 0.05, S.pal[1], (k / o.tr.length) * 0.5)); splat(o.x, o.y, 0.06, WHITE, 1.8); } },
    { id: "ripple", name: "Ripple Pond", tag: "drop", run(S) {
        const o = st(S, "ripple", () => ({ r: [], lk: -9, ls: -9 }));
        if (S.pulseT !== o.lk && S.t - S.pulseT < 0.08) { o.lk = S.pulseT; o.r.push({ x: rnd() * RW, y: rnd(), t0: S.t, c: 0 }); }
        if (S.snare !== o.ls && S.t - S.snare < 0.08) { o.ls = S.snare; o.r.push({ x: rnd() * RW, y: rnd(), t0: S.t, c: 1 }); }
        o.r = o.r.filter(q => S.t - q.t0 < 1.4).slice(-8);
        for (let i = 0; i < N; i++) { let v = 0, w = 0; for (const q of o.r) { const a = S.t - q.t0, d = Math.hypot(PX[i] - q.x, PY[i] - q.y), env2 = Math.exp(-a / 0.5) * G(d - a * 0.7, 0.25);
            const s2 = Math.sin((d - a * 0.7) * 40) * env2; if (q.c) w += Math.max(0, s2); else v += Math.max(0, s2); }
          add(i, S.pal[0], 0.05 + v * 1.3); add(i, S.pal[1], w * 1.3); } } },
    { id: "balls", name: "Bouncing Balls", tag: "drop", run(S) {
        const o = st(S, "balls", () => ({ b: shapes.map(() => ({ y: 0, v: 0 })), last: -9 }));
        while (o.b.length < shapes.length) o.b.push({ y: 0, v: 0 });
        if (S.pulseT !== o.last && S.t - S.pulseT < 0.08) { o.last = S.pulseT; o.b.forEach((b, k) => { if (hash(k + S.pulseN) < 0.6) b.v = 1.4 + hash(k * 3 + S.pulseN) * 0.8; }); }
        o.b.forEach(b => { b.v -= 4 * o.dt; b.y += b.v * o.dt; if (b.y < 0) { b.y = 0; b.v = -b.v * 0.55; } });
        for (let i = 0; i < N; i++) { const b = o.b[LF[i]] || { y: 0 }, pos = LL[i] ? LA[i] : LS[i], c = rainbow(LF[i] * 0.17);
          add(i, c, G(pos - Math.min(1, b.y * 0.6), 0.05) * 1.6 + 0.04); } } },
    { id: "curtain", name: "Curtain Fall", tag: "drop", run(S) {
        const fall = S.g.phase, y0 = 1.1 - fall * 1.3, col = rainbow(S.g.idx * 0.11);
        for (let i = 0; i < N; i++) { const d = PY[i] - y0; add(i, col, (d >= 0 ? Math.exp(-d / 0.25) : G(d, 0.02)) * (0.6 + 0.9 * S.pulse)); add(i, S.pal[0], 0.04); } } },
    { id: "strobechase", name: "Strobe Chase", tag: "drop", run(S) {
        const nS = Math.max(1, shapes.length), step = Math.floor(S.g.phase * 4) + S.g.beatInBar * 4, target = step % nS, on = (S.g.phase * 4) % 1 < 0.4;
        for (let i = 0; i < N; i++) { add(i, S.pal[0], 0.05); if (LF[i] === target && on) add(i, LF[i] % 2 ? S.pal[1] : WHITE, 1.5); } } },
    { id: "kaleido2", name: "Mirror Kaleidoscope", tag: "drop", run(S) {
        const seg = 6 + 2 * (Math.floor((S.g.idx - S.g.beatInBar) / 4) % 3), rot = S.t * 0.2;
        for (let i = 0; i < N; i++) { const dx = PX[i] - RW / 2, dy = PY[i] - 0.5, r = Math.hypot(dx, dy);
          let a = (Math.atan2(dy, dx) + rot) / (2 * Math.PI) * seg; a = Math.abs((a % 1 + 1) % 1 - 0.5) * 2;
          const v = 0.5 + 0.5 * Math.sin(a * 6 + r * 14 - S.t * 3); add(i, rainbow(a * 0.3 + r * 0.6 + S.t * 0.05), Math.pow(v, 3) * (0.3 + 1.1 * S.pulse)); } } },
  ];

  FX.push(...FX2);
  const FXI = Object.fromEntries(FX.map((f, i) => [f.id, i]));
  const POOLS = { calm: ["northern", "aurora", "fireflies", "stars", "lavablobs", "ocean", "hypno", "lava", "twinkle", "plasma", "flow"],
    build: ["fill", "pillars", "comets", "vortex", "riser", "tstrobe", "implode", "mrain", "spiral", "scanner"],
    drop: ["laser", "shock", "hyper", "spin", "cannon", "ping", "nova", "confetti", "disco", "rgbsplit", "strobe", "snake", "fireworks", "roomeq", "wipe", "glitch",
           "kaleido2", "meteor", "ripple", "chase", "curtain", "split", "pong", "eq", "balls", "rings", "burst", "strobechase", "mirror", "lightning", "fire", "kaleido"] };
  // each music style listens for different things and uses its own effect pools
  const STYLES = {
    party: { name: "Party / EDM", mode: "sections", pools: POOLS, punch: 1, xfade: 0.3, every: 1, floor: 0.06 },
    poprock: { name: "Pop / Rock", mode: "levels", pools: { low: ["flow", "northern", "melody", "breath", "aurora"], mid: ["laser", "ping", "snake", "chase", "curtain", "mirror", "rgbsplit", "rings", "wipe", "meteor"],
      peak: ["nova", "shock", "cannon", "fireworks", "disco", "hyper", "confetti", "kaleido2", "spin", "fire"] }, punch: 0.85, xfade: 0.4, every: 1, floor: 0.07 },
    hiphop: { name: "Hip-hop / Trap", mode: "levels", pools: { low: ["lava", "lavablobs", "plasma", "heart"], mid: ["roomeq", "shock", "glitch", "rgbsplit", "ripple", "eq", "rings", "split"],
      peak: ["cannon", "nova", "laser", "fire", "glitch", "confetti", "ping", "meteor", "lightning"] }, punch: 1, xfade: 0.3, every: 1, floor: 0.07 },
    chill: { name: "Chill / Lo-fi", mode: "levels", pools: { low: ["fireflies", "rainglass", "ocean", "aurora", "twinkle"], mid: ["lavablobs", "hypno", "flow", "plasma", "melody", "northern"],
      peak: ["northern", "swell", "breath", "lava"] }, punch: 0.35, xfade: 1.2, every: 2, floor: 0.1 },
    emotional: { name: "Emotional / Ballad", mode: "levels", pools: { low: ["candle", "fireflies", "rainglass", "swell", "breath"], mid: ["swell", "northern", "melody", "lavablobs", "ocean"],
      peak: ["sunrise", "northern", "swell", "aurora"] }, punch: 0.1, xfade: 2.0, every: 2, floor: 0.12 },
  };

  function render(id, S, out) {
    if (out) COL = out;
    COL.fill(0);
    const fx = FX[FXI[id]];
    if (!fx) throw new Error(`Unknown effect: ${id}`);
    fx.run(S);
    return COL;
  }
  const list = FX.map(f => ({ id: f.id, name: f.name, tag: f.tag }));
  return { render, list, pools: POOLS, styles: STYLES, palettes: { auto: PAL, ...Object.fromEntries(Object.entries(PALSETS).map(([k, v]) => [k, v.map(hex)])) } };
}
