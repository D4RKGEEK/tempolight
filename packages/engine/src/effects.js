// Effects library: 94 effects that work on any LED layout.
// Extracted from the playground (apps/playground). Each effect reads per-LED arrays from the layout
// and a signals object S (see signals.js) and writes linear RGB into COL.
/* eslint-disable */
/**
 * Finds a film's black bars (letterbox above and below, pillarbox at the sides) in screen-sync pictures, so the room
 * gets the picture and not the bars. A row or column at the edge counts as a bar while it has stayed black: it is
 * picture again the moment anything shows in it, and only turns back into a bar after 20 s of black, so a dark scene
 * or a fade to black doesn't shrink the picture. At most 40% is cut from each side; an all-black picture isn't cut.
 */
export function createLetterbox({ black = 28, holdMs = 20000 } = {}) {
  let rows = null, cols = null, key = "", last = 0;
  return function update(sc) {
    const { w, h, px } = sc, at = sc.at ?? 0, k = `${w}x${h}`;
    if (k !== key || at - last > 3000 || at < last) { key = k; rows = new Float64Array(h).fill(-Infinity); cols = new Float64Array(w).fill(-Infinity); } // a new share: start again
    last = at;
    for (let y = 0, q = 0; y < h; y++) for (let x = 0; x < w; x++, q += 3) if (px[q] > black || px[q + 1] > black || px[q + 2] > black) { rows[y] = at; cols[x] = at; } // when each row and column last showed something
    const bar = t => at - t > holdMs, edge = (a, n) => { if (a.every(bar)) return [0, n - 1]; let i0 = 0, i1 = n - 1; const lim = Math.floor(n * 0.4);
      while (i0 < lim && bar(a[i0])) i0++; while (n - 1 - i1 < lim && bar(a[i1])) i1--; return [i0, i1]; };
    const [y0, y1] = edge(rows, h), [x0, x1] = edge(cols, w); return { x0, x1, y0, y1 };
  };
}

export function createEffects(layout, opts = {}) {
  const { N, LX, LY, LS, LA, LU, LH, LR, LF, LL, LD, PX, PY, LG, shapes } = layout;
  let COL = new Float32Array(N * 3);
  const hex = h => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  const PAL = [["#ff2bd6", "#ff8a1f"], ["#16e0ff", "#3d4dff"], ["#b14bff", "#ff3b6b"], ["#20ffa8", "#16a3ff"], ["#ffd23f", "#ff3d3d"]].map(p => p.map(hex));
  const WHITE = [1, 0.97, 0.94];
  const PALSETS = { neon: ["#ff2bd6", "#16e0ff"], sunset: ["#ff5e3a", "#ffb648"], ocean: ["#0a6cff", "#00e5d0"], fire: ["#ff3d00", "#ffc400"],
    ice: ["#7cc8ff", "#e8f6ff"], forest: ["#19c37d", "#c6ff3d"], mono: ["#ffe2b8", "#fff4e6"] };
  PALSETS.mood = ["#ff8a1f", "#7b2fff"]; // "mood": every effect takes the music's mood colours (director.js, tonal.js); these until a mood is known
  let melodyHue = 0, chordHue = 0, vocalLvl = 0, chorusSlow = 0.5, chorusFast = 0.5; // smoothed state for Melody Colour, Colour Chord, Vocal Glow, Chorus Bloom
  const G = (x, w) => Math.exp(-(x / w) * (x / w));
  const wrapd = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };
  function rainbow(x) { x = ((x % 1) + 1) % 1; return [Math.min(1, Math.max(0, Math.abs(x * 6 - 3) - 1)), Math.min(1, Math.max(0, 2 - Math.abs(x * 6 - 2))), Math.min(1, Math.max(0, 2 - Math.abs(x * 6 - 4)))]; }
  function add(i, c, k) { const j = i * 3; COL[j] += c[0] * k; COL[j + 1] += c[1] * k; COL[j + 2] += c[2] * k; }
  const hash = n => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };

  /** A user-made effect: {id, name, tag, pattern, axis, drive, colors: "palette"|[hex, hex], speed, width, bg, cycles} */
  function customEffect(d) {
    if (!d || typeof d.id !== "string" || !d.id || !CUSTOM_PATTERNS.includes(d.pattern)) return null;
    const AX = { along: LS, x: Float32Array.from(PX, v => v / 1.7778), y: PY, around: LA, centre: LD }[d.axis] || LS;
    // the numbers come from saved files and backups too: anything missing, not a number or out of range gets a sensible value
    const num = (v, lo, hi, def) => { const x = typeof v === "number" ? v : v == null || v === "" ? NaN : Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : def; };
    const speed = num(d.speed, 0.1, 8, 1), w = num(d.width, 0.01, 1, 0.15), bg = num(d.bg, 0, 0.5, 0.05), cyc = num(d.cycles, 0.25, 8, 1);
    const fixed = Array.isArray(d.colors) && d.colors.length === 2 && d.colors.every(c => /^#[0-9a-f]{6}$/i.test(c)) ? d.colors.map(hex) : null;
    const drive = S => d.drive === "kick" ? S.kickE : d.drive === "bass" ? S.bassL : d.drive === "loud" ? S.loud : d.drive === "time" ? 1 : S.pulse;
    const phase = S => d.drive === "time" ? S.t * speed * 0.25 : (S.g.idx + S.g.phase) * speed / 4; // beat-driven patterns move one step a bar at speed 1
    return { id: d.id, name: String(d.name || "My effect").slice(0, 40), tag: ["calm", "build", "drop", "home"].includes(d.tag) ? d.tag : "drop", custom: true, run(S) {
      const [A, B] = fixed || S.pal, dv = Math.max(0, Math.min(1.5, drive(S) || 0)), ph = phase(S) || 0, gph = d.pattern === "gradient" ? ph * 0.25 : 0;
      for (let i = 0; i < N; i++) { const u = AX[i]; let k = 0;
        switch (d.pattern) {
          case "wave": k = (0.5 + 0.5 * Math.sin(2 * Math.PI * (u * cyc - ph))) * (0.35 + 0.65 * dv); break;
          case "chase": { const pos = ((ph % 1) + 1) % 1; k = G(Math.min(Math.abs(u - pos), 1 - Math.abs(u - pos)), w) * (0.5 + 0.7 * dv); break; }
          case "pulse": k = dv * (1 - Math.min(1, Math.abs(u - 0.5) * 2 * (1 - w))); break;
          case "sparkle": k = hash(i * 13.7 + Math.floor(S.t * 12 * speed)) < w * (0.3 + dv) ? 1.2 * (0.4 + dv) : 0; break;
          case "fill": { const lvl = Math.min(1, dv); k = u <= lvl ? 0.9 : G(u - lvl, 0.03) * 0.8; break; }
          case "breathe": k = (0.5 + 0.5 * Math.sin(2 * Math.PI * S.t * speed * 0.2)) * (0.6 + 0.4 * dv); break;
          default: k = 0.5 * (0.4 + 0.6 * dv); // gradient
        }
        const m = ((u * cyc + gph) % 1 + 1) % 1, a = bg + (1 - bg) * k, j = i * 3; // the colour between A and B, without a new array per LED
        COL[j] += (A[0] + (B[0] - A[0]) * m) * a; COL[j + 1] += (A[1] + (B[1] - A[1]) * m) * a; COL[j + 2] += (A[2] + (B[2] - A[2]) * m) * a;
      } } };
  }
  const CUSTOM_PATTERNS = ["wave", "chase", "pulse", "sparkle", "fill", "breathe", "gradient"];

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


  // ---- v0.2 effects
  const FX3 = [
    { id: "tunnel", name: "Warp Tunnel", tag: "drop", run(S) { const [A1, B1] = S.pal, P = S.g.P || 0.5;
        for (let i = 0; i < N; i++) { const d = Math.hypot(PX[i] - RW / 2, PY[i] - 0.5) * 1.6;
          for (let k = 0; k < 3; k++) { const e = S.g.beatT - k * P, dt = S.t - e; if (dt < 0) continue; const r = dt / (P * 3) * 1.4;
            add(i, k % 2 ? B1 : A1, G(d - r, 0.05 + 0.04 * r) * (1 - dt / (P * 3)) * (1.3 + S.pulse)); }
          add(i, A1, 0.04 + 0.2 * S.kickE * G(d, 0.25)); } } },
    { id: "galaxy", name: "Spiral Galaxy", tag: "calm", run(S) { const a = S.fixed ? S.pal[0] : hex("#7a3cff"), b = S.fixed ? S.pal[1] : hex("#ff7ad9"), core = [1, 0.85, 0.7];
        for (let i = 0; i < N; i++) { const dx = PX[i] - RW / 2, dy = PY[i] - 0.5, r = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
          const arm = 0.5 + 0.5 * Math.cos(2 * ang - r * 9 + S.t * 0.35), m = Math.pow(arm, 3) * Math.exp(-r * 1.6);
          add(i, r < 0.5 ? a : b, 0.06 + m * (0.5 + 0.5 * (S.bassL || 0))); add(i, core, G(r, 0.12) * (0.25 + 0.3 * S.pulse)); } } },
    { id: "storm", name: "Thunderstorm", tag: "build", run(S) { const blue = hex("#1a3cff"), dt = S.t - S.snare, seed = Math.round(S.snare * 100);
        for (let i = 0; i < N; i++) { const y = ((PY[i] + S.t * (0.7 + 0.6 * hash(Math.floor(PX[i] * 40)))) % 1), drop = G(y - 0.5, 0.04) * 0.5;
          add(i, blue, 0.05 + drop * (0.3 + S.loud)); }
        if (dt >= 0 && dt < 0.35) { const x0 = 0.15 + hash(seed) * (RW - 0.3), on = dt < 0.06 || (dt > 0.12 && dt < 0.18);
          if (on) for (let i = 0; i < N; i++) add(i, WHITE, G(PX[i] - x0 - Math.sin(PY[i] * 20 + seed) * 0.05, 0.08) * 1.8 + 0.25); } } },
    { id: "colorchord", name: "Colour Chord", tag: "calm", run(S) {
        let sx = 0, sy = 0; for (let b = 4; b < 20; b++) { const a = (b % 12) / 12 * 2 * Math.PI, w = S.bands[b] * S.bands[b]; sx += Math.cos(a) * w; sy += Math.sin(a) * w; }
        const target = (Math.atan2(sy, sx) / (2 * Math.PI) + 1) % 1; let d = target - chordHue; d -= Math.round(d); chordHue = ((chordHue + d * 0.04) % 1 + 1) % 1;
        const c1 = rainbow(chordHue), c2 = rainbow(chordHue + 0.12), lv = 0.18 + 0.45 * S.loud;
        for (let i = 0; i < N; i++) { const m = 0.5 + 0.5 * Math.sin(2 * Math.PI * (LS[i] - S.t * 0.08) + LF[i]); add(i, c1, lv * m); add(i, c2, lv * (1 - m) * 0.7); } } },
    { id: "quake", name: "Bass Quake", tag: "drop", run(S) { const [A1, B1] = S.pal, bl = S.bassL || 0, dt = S.t - S.pulseT;
        for (let i = 0; i < N; i++) { const h = PY[i], front = dt * 2.2, wave = G(h - front, 0.12) * Math.max(0, 1 - dt / 0.6);
          add(i, A1, (0.08 + 0.9 * bl * bl) * Math.max(0, 1 - h * 1.2)); add(i, B1, wave * 1.6 * S.punch); } } },
    { id: "embers", name: "Rising Embers", tag: "calm", run(S) { const a = hex("#ff4a00"), b = hex("#ffb000");
        const o = st(S, "embers", () => ({ p: Array.from({ length: 36 }, () => ({ x: rnd() * RW, y: rnd(), v: 0.04 + rnd() * 0.06, w: rnd() * 6.28 })) }));
        for (let i = 0; i < N; i++) add(i, a, 0.05 * Math.max(0, 1 - PY[i] * 2));
        for (const p of o.p) { p.y += p.v * o.dt * (1 + 2 * S.loud + 2 * S.kickE); p.x += Math.sin(S.t * 1.3 + p.w) * 0.02 * o.dt; if (p.y > 1.05) { p.y = -0.03; p.x = rnd() * RW; }
          splat(p.x, p.y, 0.035, p.w > 3 ? a : b, 0.9 * (1 - p.y * 0.7)); } } },
    { id: "tiles", name: "Beat Tiles", tag: "drop", run(S) { const [A1, B1] = S.pal, cols = 6, rows = 3, n = cols * rows, k = S.g.idx, e = S.pulse;
        const lit = [hash(k) * n | 0, hash(k + 0.5) * n | 0, hash(k - 1) * n | 0];
        for (let i = 0; i < N; i++) { const c = Math.min(cols - 1, PX[i] / RW * cols | 0), r = Math.min(rows - 1, PY[i] * rows | 0), id = r * cols + c;
          add(i, (c + r) % 2 ? A1 : B1, 0.05); if (id === lit[0]) add(i, B1, 0.3 + 1.4 * e); else if (id === lit[1]) add(i, A1, 0.2 + 0.9 * e); else if (id === lit[2]) add(i, WHITE, 0.25 * e); } } },
    { id: "helix", name: "Double Helix", tag: "build", run(S) { const [A1, B1] = S.pal, p = S.buildP, tw = S.t * (1 + 4 * p);
        for (let i = 0; i < N; i++) { const pos = LL[i] ? LA[i] : LS[i], y = LH[i] * 2 - 1, s1 = Math.sin(2 * Math.PI * pos * 3 + tw), s2 = Math.sin(2 * Math.PI * pos * 3 + tw + Math.PI);
          const w = 0.2; add(i, A1, G(LD[i] * 2 - 1 - s1, w) * (0.3 + p) + G(y - s1 * 0.6, w) * 0.2); add(i, B1, G(LD[i] * 2 - 1 - s2, w) * (0.3 + p) + G(y - s2 * 0.6, w) * 0.2); add(i, WHITE, S.snareE * 0.3 * p); } } },
    { id: "countdown", name: "Drop Countdown", tag: "build", run(S) { const p = S.buildP, steps = 8, lit = Math.floor(p * steps), [A1, B1] = S.pal, blink = S.g.phase < 0.25;
        for (let i = 0; i < N; i++) { const pos = LL[i] ? LA[i] : LS[i], seg = Math.floor(pos * steps);
          if (seg < lit) add(i, seg % 2 ? A1 : B1, 0.35 + 0.6 * p); else if (seg === lit && blink) add(i, WHITE, 1.2); else add(i, A1, 0.03); } } },
    { id: "solar", name: "Solar Flare", tag: "drop", run(S) { const sun = [1, 0.55, 0.12], flare = [1, 0.9, 0.6], cx = RW / 2, cy = 1.0, rot = S.t * 0.3;
        for (let i = 0; i < N; i++) { const dx = PX[i] - cx, dy = PY[i] - cy, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx) + rot;
          const rays = Math.pow(0.5 + 0.5 * Math.cos(a * 12), 6) * Math.exp(-r * 1.2), dt = S.t - S.pulseT, ring = G(r - dt * 1.8, 0.08) * Math.max(0, 1 - dt / 0.7);
          add(i, sun, 0.08 + G(r, 0.35) * 0.6 + rays * (0.3 + 0.9 * S.pulse)); add(i, flare, ring * 1.5 * S.punch); } } },
    { id: "zigzag", name: "Zigzag Beams", tag: "drop", run(S) { const [A1, B1] = S.pal, bar = Math.floor((S.g.idx - S.g.beatInBar) / 4), ph = S.g.barPhase;
        for (let i = 0; i < N; i++) { const u = PX[i] / RW, x1 = Math.abs(((ph * 2 + 0.0) % 2) - 1), x2 = 1 - x1, zig = Math.abs(((PY[i] * 3 + bar * 0.5) % 2) - 1) * 0.15;
          add(i, A1, G(u - x1 - zig, 0.035) * (1 + S.pulse)); add(i, B1, G(u - x2 + zig, 0.035) * (1 + S.pulse)); add(i, A1, 0.04 + 0.15 * S.kickE); } } },
    { id: "sparks", name: "Welding Sparks", tag: "drop", run(S) { const hot = [1, 0.75, 0.35];
        const o = st(S, "sparks", () => ({ s: [], last: -9 }));
        if (S.pulseT !== o.last && S.t - S.pulseT < 0.05) { o.last = S.pulseT; const x0 = 0.1 + rnd() * (RW - 0.2), y0 = 0.4 + rnd() * 0.5;
          for (let k = 0; k < 14; k++) { const a = rnd() * 6.28, v = 0.3 + rnd() * 0.7; o.s.push({ x: x0, y: y0, vx: Math.cos(a) * v, vy: Math.sin(a) * v + 0.4, life: 0.6 + rnd() * 0.5 }); } }
        for (const p of o.s) { p.vy -= 1.6 * o.dt; p.x += p.vx * o.dt; p.y += p.vy * o.dt; p.life -= o.dt; }
        o.s = o.s.filter(p => p.life > 0 && p.y > -0.1).slice(-80);
        for (let i = 0; i < N; i++) add(i, S.pal[0], 0.04 + 0.1 * S.kickE);
        for (const p of o.s) splat(p.x, p.y, 0.025, p.life > 0.5 ? WHITE : hot, Math.min(1.5, p.life * 2)); } },
  ];
  FX2.push(...FX3);


  // ---- v0.3 effects
  // Portal's light source is the TV: the biggest rectangle in the room (or else the biggest shape)
  const portalSrc = (() => { let best = 0, bc = -1; shapes.forEach((sh, i) => { const sc = (sh.type === "rect" ? 1e6 : 0) + (sh.count || 0); if (sc > bc) { bc = sc; best = i; } });
    let x = 0, y = 0, n = 0; for (let i = 0; i < N; i++) if (LF[i] === best) { x += PX[i]; y += PY[i]; n++; } return { shape: best, x: n ? x / n : RW / 2, y: n ? y / n : 0.5 }; })();
  const easeOut = x => 1 - (1 - x) * (1 - x);
  // the box the LEDs actually fill: corners and centre come from the real room, not the whole wall view
  const BB = (() => { let x0 = 9, x1 = -9, y0 = 9, y1 = -9; for (let i = 0; i < N; i++) { x0 = Math.min(x0, PX[i]); x1 = Math.max(x1, PX[i]); y0 = Math.min(y0, PY[i]); y1 = Math.max(y1, PY[i]); }
    if (!N) { x0 = 0; x1 = RW; y0 = 0; y1 = 1; } return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, r: Math.max(0.1, Math.hypot(x1 - x0, y1 - y0) / 2) }; })();
  // corners snap to the LED nearest each corner of that box, so a ball "landing in a corner" lands on real lights
  const CORNERS = [[BB.x0, BB.y0], [BB.x1, BB.y0], [BB.x1, BB.y1], [BB.x0, BB.y1]].map(([x, y]) => { let bi = -1, bd = 1e9;
    for (let i = 0; i < N; i++) { const d = Math.hypot(PX[i] - x, PY[i] - y); if (d < bd) { bd = d; bi = i; } } return bi < 0 ? [x, y] : [PX[bi], PY[bi]]; });
  const FX4 = [
    // -- use the room's real layout
    { id: "lighthouse", name: "Lighthouse", tag: "drop", run(S) { const [A1, B1] = S.pal, ang = S.g.barPhase * 2 * Math.PI - Math.PI / 2, w = 0.3 + 0.12 * S.pulse;
        for (let i = 0; i < N; i++) { const a = Math.atan2(PY[i] - BB.cy, PX[i] - BB.cx); let d = Math.abs(a - ang) % (2 * Math.PI); d = Math.min(d, 2 * Math.PI - d);
          const r = (Math.hypot(PX[i] - BB.cx, PY[i] - BB.cy) / BB.r * 0.7), beam = G(d, w) * (0.6 + 1.2 * S.pulse) * Math.min(1, r * 3 + 0.3), back = G(Math.PI - d, w * 1.5) * 0.25;
          add(i, A1, 0.05 + back); add(i, B1, beam); if (beam > 0.6) add(i, WHITE, (beam - 0.6) * 0.8); } } },
    { id: "corner", name: "Corner Bounce", tag: "drop", run(S) { const k = ((S.pulseN % 4) + 4) % 4, from = CORNERS[(k + 3) % 4], to = CORNERS[k], dt = S.t - S.pulseT;
        const p = easeOut(Math.max(0, Math.min(1, dt / ((S.g.P || 0.5) * 0.45)))), x = from[0] + (to[0] - from[0]) * p, y = from[1] + (to[1] - from[1]) * p, [A1, B1] = S.pal;
        for (let i = 0; i < N; i++) add(i, A1, 0.04);
        splat(x, y, 0.22, B1, 1.8); splat(x, y, 0.06, WHITE, 0.4 + 0.8 * S.pulse);
        if (p >= 1) splat(to[0], to[1], 0.12 + 0.3 * dt, A1, Math.max(0, 1 - dt * 2)); } },
    { id: "gravity", name: "Gravity", tag: "drop", run(S) { const [A1, B1] = S.pal;
        const o = st(S, "gravity", () => ({ p: Array.from({ length: 48 }, (_, k) => ({ x: rnd() * RW, y: rnd(), vy: 0, c: k % 2 })), last: -9 }));
        const kick = S.pulseT !== o.last && S.t - S.pulseT < 0.06; if (kick) o.last = S.pulseT;
        for (const q of o.p) { q.vy -= 2.2 * o.dt; q.y += q.vy * o.dt; if (q.y < 0.03) { q.y = 0.03; q.vy = -q.vy * 0.35; } if (q.y > 1) { q.y = 1; q.vy = 0; }
          if (kick && q.y < 0.25) q.vy = 1.1 + rnd() * 0.9 * (0.5 + S.punch); }
        for (let i = 0; i < N; i++) add(i, A1, 0.03 + 0.4 * S.kickE * Math.max(0, 0.3 - PY[i]));
        for (const q of o.p) splat(q.x, q.y, 0.05, q.c ? A1 : B1, 1.2); } },
    { id: "collision", name: "Wave Collision", tag: "build", run(S) { const [A1, B1] = S.pal, half = (S.g.barPhase * 2) % 1, f = easeOut(half) * (BB.x1 - BB.x0) / 2, meet = half > 0.85 ? (half - 0.85) / 0.15 : 0;
        for (let i = 0; i < N; i++) { const x = PX[i], r = Math.hypot(x - RW / 2, PY[i] - 0.5);
          add(i, A1, G(x - BB.x0 - f, 0.06) * (0.8 + S.buildP)); add(i, B1, G(BB.x1 - x - f, 0.06) * (0.8 + S.buildP));
          if (meet > 0) add(i, WHITE, G(r - meet * 0.6, 0.08) * (1 - meet) * 2); add(i, WHITE, S.snareE * 0.25 * G(r, 0.3)); add(i, A1, 0.03); } } },
    { id: "portal", name: "Portal", tag: "drop", run(S) { const { shape, x: cx, y: cy } = portalSrc, [A1, B1] = S.pal, P = S.g.P || 0.5, dt = S.t - S.pulseT;
        for (let i = 0; i < N; i++) { if (LF[i] === shape) { add(i, rainbow(LS[i] + S.t * 0.4), 0.5 + 1.2 * S.pulse); continue; }
          const r = Math.hypot(PX[i] - cx, PY[i] - cy), flow = ((r * 3 - S.t / P * 0.5) % 1 + 1) % 1;
          add(i, flow < 0.5 ? A1 : B1, G(flow - 0.25, 0.12) * Math.exp(-r * 0.9) * (0.4 + S.pulse)); add(i, WHITE, G(r - dt * 1.5, 0.07) * Math.max(0, 1 - dt / 0.6)); add(i, A1, 0.03); } } },
    { id: "stadium", name: "Stadium Wave", tag: "drop", run(S) { const front = S.g.barPhase, [A1, B1] = S.pal;
        for (let i = 0; i < N; i++) { const a = (Math.atan2(PY[i] - BB.cy, PX[i] - BB.cx) / (2 * Math.PI) + 1.25) % 1, d = ((front - a) % 1 + 1) % 1; // 0 at the front of the wave
          const crowd = d < 0.22 ? Math.sin(d / 0.22 * Math.PI) : 0; add(i, A1, 0.08 + 0.08 * S.kickE); add(i, lerp3(A1, B1, crowd), crowd * (1 + 0.6 * S.pulse)); if (crowd > 0.8) add(i, WHITE, (crowd - 0.8) * 2); } } },
    // -- follow the song
    { id: "vocal", name: "Vocal Glow", tag: "calm", run(S) { let v = 0; for (let b = 8; b <= 15; b++) v += S.bands[b]; v /= 8; if (S.vocal != null) v = 0.25 * v + 0.9 * S.vocal; vocalLvl += (v - vocalLvl) * 0.12;
        const warm = S.fixed ? S.pal[0] : [1, 0.55, 0.32], soft = S.fixed ? S.pal[1] : [1, 0.3, 0.45], lv = 0.12 + 0.9 * vocalLvl;
        for (let i = 0; i < N; i++) { const m = 0.5 + 0.5 * Math.sin(2 * Math.PI * (LU[i] * 0.8 - S.t * 0.05) + LH[i] * 2); add(i, warm, lv * (0.6 + 0.4 * m)); add(i, soft, lv * 0.3 * (1 - m)); } } },
    { id: "chorus", name: "Chorus Bloom", tag: "drop", run(S) { chorusSlow += (S.loud - chorusSlow) * 0.004; chorusFast += (S.loud - chorusFast) * 0.05;
        const bloom = Math.max(0, Math.min(1, (chorusFast - chorusSlow) * 4 + (S.loud > 0.75 ? 0.4 : 0))), spread = 0.08 + 0.6 * bloom;
        for (let i = 0; i < N; i++) { add(i, rainbow(S.t * 0.03 + LU[i] * spread + LF[i] * 0.05 * bloom), 0.12 + 0.5 * bloom + 0.4 * S.pulse * bloom); add(i, WHITE, S.hatE * 0.15 * bloom); } } },
    { id: "rewind", name: "Drop Rewind", tag: "build", run(S) { const [A1, B1] = S.pal, din = S.dropIn ?? 99, since = S.sinceDrop ?? 99;
        for (let i = 0; i < N; i++) { const r = (Math.hypot(PX[i] - BB.cx, PY[i] - BB.cy) / BB.r * 0.7);
          if (since >= 0 && since < 0.9) { add(i, WHITE, G(r - since * 1.6, 0.06 + since * 0.1) * (1 - since / 0.9) * 2.2); add(i, B1, 0.3 * (1 - since / 0.9)); continue; }
          const pull = din < 2 ? 1 - din / 2 : S.buildP * 0.6, ph = ((r * 4 + S.t * (0.6 + 3 * pull)) % 1 + 1) % 1; // rings rush inwards, faster as the drop nears
          add(i, ph < 0.5 ? A1 : B1, G(ph - 0.5, 0.1) * (0.25 + 0.9 * pull) * (1 - Math.min(1, r) * pull) + 0.02); } } },
    { id: "bassrain", name: "Bass Rain", tag: "drop", run(S) { const [A1, B1] = S.pal, o = st(S, "bassrain", () => ({ d: [], last: -9 }));
        if (S.pulseT !== o.last && S.t - S.pulseT < 0.06) { o.last = S.pulseT; const n = 6 + Math.round(10 * (S.bassL || 0.5)); for (let k = 0; k < n; k++) o.d.push({ x: rnd() * RW, y: 1.02, v: 0.5 + rnd() * 0.6, c: rnd() < 0.5 }); }
        for (const q of o.d) { q.v += 1.5 * o.dt; q.y -= q.v * o.dt; } o.d = o.d.filter(q => q.y > -0.05).slice(-90);
        for (let i = 0; i < N; i++) add(i, A1, 0.03 + 1.5 * S.kickE * Math.max(0, 0.15 - PY[i]));
        for (const q of o.d) { splat(q.x, q.y, 0.035, q.c ? A1 : B1, 1.3); splat(q.x, q.y + 0.06, 0.03, q.c ? A1 : B1, 0.5); } } },
    { id: "beatcount", name: "Beat Counter", tag: "drop", run(S) { const [A1, B1] = S.pal, b = S.g.beatInBar, nS = shapes.length, e = Math.exp(-S.g.phase * (S.g.P || 0.5) / 0.25);
        for (let i = 0; i < N; i++) { const slot = nS >= 4 ? LF[i] % 4 : Math.min(3, Math.floor(LS[i] * 4));
          if (b === 0) add(i, WHITE, 0.2 + 1.2 * e); else if (slot <= b) add(i, slot === b ? B1 : A1, slot === b ? 0.4 + 1.1 * e : 0.35); else add(i, A1, 0.04); } } },
    { id: "specrings", name: "Spectrum Rings", tag: "drop", run(S) {
        for (let i = 0; i < N; i++) { const pos = LL[i] ? Math.abs(LA[i] - 0.5) * 2 : LS[i], b = S.bands[Math.min(23, Math.floor(pos * 23.99))];
          add(i, rainbow(pos * 0.7 + LF[i] * 0.11 + S.t * 0.03), 0.04 + b * b * 1.3); if (b > 0.85) add(i, WHITE, (b - 0.85) * 3); } } },
    { id: "neon", name: "Neon Sign", tag: "calm", run(S) { const nS = Math.max(1, shapes.length), bar = Math.floor((S.g.idx - S.g.beatInBar) / 4);
        for (let i = 0; i < N; i++) { const s = LF[i], flick = hash(Math.floor(S.t * 18) + s * 7.7) < 0.03 ? 0.15 : 1, buzz = 0.92 + 0.08 * Math.sin(S.t * 2 * Math.PI * 1.7 + s);
          const on = nS < 3 || hash(s * 1.7 + bar * 0.37) > 0.25; add(i, rainbow(hash(s * 3.1) * 0.9 + 0.75), (on ? 0.75 : 0.05) * flick * buzz * (0.8 + 0.3 * S.pulse)); if (on) add(i, WHITE, 0.08 * flick); } } },
    // -- everyday (pick these by hand: they follow the clock, not the music)
    { id: "boxbreath", name: "Box Breathing", tag: "home", run(S) { const c = ((S.t % 16) + 16) % 16, ph = Math.floor(c / 4), k = (c % 4) / 4; // breathe in, hold, out, hold: 4 s each
        const level = ph === 0 ? k : ph === 1 ? 1 : ph === 2 ? 1 - k : 0, ease = 0.5 - 0.5 * Math.cos(level * Math.PI), a = S.fixed ? S.pal[0] : hex("#4fb3ff"), b = S.fixed ? S.pal[1] : hex("#8a7dff");
        for (let i = 0; i < N; i++) { const fill = PY[i] < ease * 1.05 ? 1 : G(PY[i] - ease, 0.08); add(i, lerp3(a, b, PY[i]), 0.06 + 0.55 * fill * (0.4 + 0.6 * ease)); } } },
    { id: "focus", name: "Focus Timer", tag: "home", run(S) { const o = st(S, "focus", () => ({ el: 0 })); o.el += o.dt; // 25 minutes of work, then a 5-minute break
        const cyc = o.el % 1800, work = cyc < 1500, p = work ? cyc / 1500 : (cyc - 1500) / 300, warm = [1, 0.78, 0.55], green = [0.2, 1, 0.55];
        for (let i = 0; i < N; i++) {
          if (work) { add(i, warm, LG[i] < p ? 0.32 : 0.05); add(i, WHITE, G(LG[i] - p, 0.004) * 0.9); if (cyc > 1490) add(i, warm, 0.3 * (0.5 + 0.5 * Math.sin(o.el * 6))); }
          else add(i, green, 0.1 + 0.25 * (0.5 + 0.5 * Math.sin(o.el * 2 * Math.PI / 8))); } } },
    { id: "wakeup", name: "Wake-up Sunrise", tag: "home", run(S) { const o = st(S, "wakeup", () => ({ el: 0 })); o.el += o.dt; const p = Math.min(1, 0.05 + o.el / 1200); // 20 minutes, from a faint glow
        const c = p < 0.4 ? lerp3([0.35, 0.02, 0], [1, 0.25, 0.02], p / 0.4) : p < 0.8 ? lerp3([1, 0.25, 0.02], [1, 0.65, 0.3], (p - 0.4) / 0.4) : lerp3([1, 0.65, 0.3], [1, 0.92, 0.8], (p - 0.8) / 0.2);
        const h = 0.15 + p * 1.1; for (let i = 0; i < N; i++) add(i, c, (0.02 + 0.98 * p) * Math.min(1, Math.max(0.15, (h - PY[i]) * 1.5 + 0.3))); } },
    // -- party
    { id: "cannons", name: "Colour Cannons", tag: "drop", run(S) {
        for (let i = 0; i < N; i++) add(i, S.pal[0], 0.04);
        for (const e of S.pulses) { const dt = S.t - e; if (dt < 0 || dt > 0.8) continue; const k = Math.round(e * 10), c0 = CORNERS[((k % 4) + 4) % 4], p = easeOut(Math.min(1, dt / 0.5));
          const tx = BB.cx + (hash(k) - 0.5) * 0.6, ty = BB.cy + (hash(k + 1) - 0.5) * 0.4, x = c0[0] + (tx - c0[0]) * p, y = c0[1] + (ty - c0[1]) * p;
          splat(x, y, 0.1 + 0.25 * p, rainbow(hash(k + 5)), 2 * (1 - dt / 0.8)); splat(c0[0], c0[1], 0.15, WHITE, Math.exp(-dt / 0.08) * 1.5); } } },
    { id: "scatter", name: "Strobe Scatter", tag: "drop", run(S) { const step = Math.floor(S.g.phase * 2) + S.g.idx * 2, on = (S.g.phase * 2) % 1 < 0.35, nS = Math.max(1, shapes.length), [A1, B1] = S.pal;
        for (let i = 0; i < N; i++) { const seg = nS >= 3 ? LF[i] : Math.floor(LS[i] * 6); add(i, A1, 0.04);
          if (on && hash(seg * 13.1 + step) < 0.35) add(i, hash(seg + step * 0.7) < 0.5 ? WHITE : B1, 1.4 * S.punch); } } },
    { id: "scope", name: "Oscilloscope", tag: "drop", run(S) { const w = S.wave, L = w ? w.length : 0, col = S.fixed ? S.pal[0] : hex("#39ff8a");
        for (let i = 0; i < N; i++) { const u = PX[i] / RW, v = L ? w[Math.min(L - 1, Math.floor(u * (L - 1)))] * 2.5 : Math.sin(u * 12 + S.t * 3) * 0.3 * (0.3 + S.pulse);
          const y = 0.5 + Math.max(-0.48, Math.min(0.48, v)); add(i, col, G(PY[i] - y, 0.035) * 1.4 + 0.02); add(i, WHITE, G(PY[i] - y, 0.012) * 0.5); } } },
  ];
  FX2.push(...FX4);
  // ---- text on LED matrix panels: a 5x7 font, scrolling (song name, BPM, clock or your own text: Settings → Text)
  const FONT = {" ":[0,0,0,0,0],"0":[62,81,73,69,62],"1":[0,66,127,64,0],"2":[66,97,81,73,70],"3":[33,65,69,75,49],"4":[24,20,18,127,16],"5":[39,69,69,69,57],"6":[60,74,73,73,48],"7":[1,113,9,5,3],"8":[54,73,73,73,54],"9":[6,73,73,41,30],"A":[126,17,17,17,126],"B":[127,73,73,73,54],"C":[62,65,65,65,34],"D":[127,65,65,34,28],"E":[127,73,73,73,65],"F":[127,9,9,9,1],"G":[62,65,73,73,122],"H":[127,8,8,8,127],"I":[0,65,127,65,0],"J":[32,64,65,63,1],"K":[127,8,20,34,65],"L":[127,64,64,64,64],"M":[127,2,12,2,127],"N":[127,4,8,16,127],"O":[62,65,65,65,62],"P":[127,9,9,9,6],"Q":[62,65,81,33,94],"R":[127,9,25,41,70],"S":[70,73,73,73,49],"T":[1,1,127,1,1],"U":[63,64,64,64,63],"V":[31,32,64,32,31],"W":[63,64,56,64,63],"X":[99,20,8,20,99],"Y":[7,8,112,8,7],"Z":[97,81,73,69,67],":":[0,54,54,0,0],".":[0,96,96,0,0],"-":[8,8,8,8,8],"!":[0,0,95,0,0],"/":[32,16,8,4,2],"'":[0,5,3,0,0],"&":[54,73,85,34,80],"?":[2,1,81,9,6],",":[0,80,48,0,0],"+":[8,8,62,8,8],"#":[20,127,20,127,20],"(":[0,28,34,65,0],")":[0,65,34,28,0]};
  const MC = new Int16Array(N).fill(-1), MR = new Int16Array(N).fill(-1), MCOLS = new Int16Array(N);
  shapes.forEach((sh, si) => { if (sh.type !== "matrix") return; const x0 = sh.cx - sh.w / 2, y0 = sh.cy - sh.h / 2, dx = sh.w / Math.max(1, sh.cols - 1), dy = sh.h / Math.max(1, sh.rows - 1);
    for (let i = 0; i < N; i++) if (LF[i] === si) { MC[i] = Math.round((LX[i] - x0) / dx); MR[i] = Math.round((LY[i] - y0) / dy); MCOLS[i] = sh.cols; } });
  const hasMatrix = MC.some(v => v >= 0);
  // ---- screen sync: colours from a shared screen (a film, a game, a music video), mapped over the room like a big ambilight
  const SCR = new Float32Array(N * 3), letterbox = createLetterbox(); let scLast = null, crop = null;
  FX2.push({ id: "screen", name: "Screen Sync", tag: "home", run(S) {
    const sc = S.screen;
    if (!sc) { for (let i = 0; i < N; i++) add(i, S.pal[i % 2], 0.08 + 0.06 * Math.sin(S.t * 1.5 + LS[i] * 6)); return; } // nothing shared yet
    if (sc !== scLast) { scLast = sc; crop = letterbox(sc); } // once per new picture, not per frame
    const { w, px } = sc, { x0, x1, y0, y1 } = crop;
    for (let i = 0; i < N; i++) {
      const u = (PX[i] - BB.x0) / Math.max(1e-3, BB.x1 - BB.x0), v = 1 - (PY[i] - BB.y0) / Math.max(1e-3, BB.y1 - BB.y0);
      const cx = Math.min(x1, Math.max(x0, Math.round(x0 + u * (x1 - x0)))), cy = Math.min(y1, Math.max(y0, Math.round(y0 + v * (y1 - y0)))); let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = cx + dx, y = cy + dy; if (x < x0 || y < y0 || x > x1 || y > y1) continue; const q = (y * w + x) * 3; r += px[q]; g += px[q + 1]; b += px[q + 2]; n++; }
      r /= n * 255; g /= n * 255; b /= n * 255;
      const m = (r + g + b) / 3, sat = 1.25; r = Math.max(0, m + (r - m) * sat); g = Math.max(0, m + (g - m) * sat); b = Math.max(0, m + (b - m) * sat); // a little richer than the screen
      const j = i * 3; SCR[j] += (r - SCR[j]) * 0.35; SCR[j + 1] += (g - SCR[j + 1]) * 0.35; SCR[j + 2] += (b - SCR[j + 2]) * 0.35; // smooth, so it doesn't flicker
      COL[j] += SCR[j]; COL[j + 1] += SCR[j + 1]; COL[j + 2] += SCR[j + 2];
    }
  } });
  FX2.push({ id: "text", name: "Text Scroller", tag: "home", run(S) {
    const txt = String(S.text || "TEMPOLIGHT").toUpperCase(), cols = []; for (const ch of txt) { const g = FONT[ch] || FONT["?"]; cols.push(...g, 0); } cols.push(0, 0, 0, 0, 0, 0);
    const off = Math.floor(S.t * 8), [A1, B1] = S.pal;
    for (let i = 0; i < N; i++) {
      if (MC[i] < 0) { add(i, A1, 0.05 + 0.1 * S.pulse); continue; }
      const mc = MCOLS[i], len = cols.length + mc, xi = (((MC[i] + off) % len) + len) % len - mc, row = MR[i] - 1; // text enters from the right; // a row of space above the letters
      const bits = xi >= 0 && xi < cols.length ? cols[xi] : 0;
      if (row >= 0 && row < 7 && (bits >> row) & 1) add(i, lerp3(A1, B1, MC[i] / Math.max(1, mc - 1)), 1 + 0.4 * S.pulse); else add(i, A1, 0.02);
    }
    if (!hasMatrix) for (let i = 0; i < N; i++) add(i, B1, 0.12 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (LS[i] - S.t * 0.2))));
  } });


  FX.push(...FX2);
  // ---- your own effects, built from parts in the Effects page (no code): a pattern, what moves it, a direction, colours
  // a custom effect can't replace a built-in one, and each id counts once (backups and hand-edited files can have anything)
  const taken = new Set(FX.map(f => f.id)), customs = (Array.isArray(opts.custom) ? opts.custom.slice(0, 100) : []).map(customEffect).filter(c => c && !taken.has(c.id) && taken.add(c.id));
  FX.push(...customs);
  // effects that hit hard on every kick across the whole room: a drop opens with one of these
  const IMPACT = ["shock", "burst", "ping", "eq", "chase", "glitch", "kaleido", "portal", "laser", "wipe", "split", "zigzag", "nova", "lightning"];
  // each effect's usual brightness in its own kind of song part (mean of the output after the LED roll-off, example
  // room). The director starts from these to even effects out, then learns what they do in the user's room.
  const LUM = { aurora: .163, stars: .106, lava: .116, fill: .326, comets: .177, shock: .255, spin: .206, ping: .238, strobe: .302, fireworks: .103, kaleido: .252, chase: .174, eq: .198,
    spiral: .069, classic: .078, ocean: .153, twinkle: .165, plasma: .174, flow: .186, heart: .097, melody: .129, swell: .057, candle: .096, sunrise: .203, mrain: .055, scanner: .22,
    riser: .238, wipe: .236, confetti: .073, burst: .304, split: .181, mirror: .147, rings: .077, meteor: .108, lightning: .132, fire: .088, fireflies: .146, northern: .107,
    rainglass: .144, lavablobs: .37, breath: .261, hypno: .092, pillars: .244, tstrobe: .162, vortex: .145, implode: .318, laser: .2, hyper: .122, nova: .121, cannon: .094, disco: .07,
    roomeq: .153, rgbsplit: .226, glitch: .207, snake: .13, pong: .038, ripple: .152, balls: .065, curtain: .117, strobechase: .07, kaleido2: .109, tunnel: .165, galaxy: .138,
    storm: .219, colorchord: .162, quake: .133, embers: .021, tiles: .08, helix: .282, countdown: .211, solar: .264, zigzag: .157, sparks: .093, lighthouse: .119, corner: .083,
    gravity: .158, collision: .181, portal: .215, stadium: .177, vocal: .247, chorus: .278, rewind: .067, bassrain: .059, beatcount: .33, specrings: .13, neon: .259, cannons: .215,
    scatter: .109, scope: .074 };
  const FXI = Object.fromEntries(FX.map((f, i) => [f.id, i]));
  const POOLS = { calm: ["northern", "galaxy", "vocal", "aurora", "embers", "neon", "colorchord", "fireflies", "stars", "lavablobs", "ocean", "hypno", "lava", "twinkle", "plasma", "flow"],
    build: ["fill", "rewind", "countdown", "pillars", "collision", "helix", "comets", "storm", "vortex", "riser", "tstrobe", "implode", "mrain", "spiral", "scanner"],
    drop: ["laser", "lighthouse", "tunnel", "shock", "cannons", "hyper", "quake", "portal", "solar", "corner", "stadium", "bassrain", "spin", "cannon", "ping", "nova", "confetti", "disco", "rgbsplit", "strobe", "snake", "fireworks", "roomeq", "wipe", "glitch",
           "kaleido2", "sparks", "gravity", "meteor", "tiles", "beatcount", "ripple", "zigzag", "specrings", "scatter", "chase", "curtain", "split", "pong", "eq", "balls", "rings", "burst", "strobechase", "mirror", "lightning", "fire", "kaleido"] };
  // each music style listens for different things and uses its own effect pools. The feel (director.js): pump = how
  // much the kick pumps the room in drops, moment = how big the drop flash and the dim before it are, dyn = how much
  // brightness follows the song part (calm low, build rising, drop full) and how much effects are evened out
  const STYLES = {
    party: { name: "Party / EDM", mode: "sections", pools: POOLS, punch: 1, xfade: 0.3, every: 1, floor: 0.06, pump: 1, moment: 1, dyn: 1 },
    poprock: { name: "Pop / Rock", mode: "levels", pools: { low: ["flow", "vocal", "northern", "melody", "breath", "aurora"], mid: ["laser", "stadium", "lighthouse", "beatcount", "ping", "snake", "chase", "curtain", "mirror", "rgbsplit", "rings", "wipe", "meteor"],
      peak: ["nova", "chorus", "tunnel", "shock", "cannons", "cannon", "fireworks", "solar", "portal", "disco", "hyper", "confetti", "kaleido2", "spin", "fire"] }, punch: 0.85, xfade: 0.4, every: 1, floor: 0.07, pump: 0.8, moment: 0.85, dyn: 0.85 },
    hiphop: { name: "Hip-hop / Trap", mode: "levels", pools: { low: ["lava", "lavablobs", "plasma", "heart", "embers"], mid: ["quake", "bassrain", "roomeq", "shock", "tiles", "beatcount", "gravity", "glitch", "rgbsplit", "ripple", "eq", "rings", "split"],
      peak: ["cannon", "nova", "laser", "fire", "glitch", "confetti", "ping", "meteor", "lightning"] }, punch: 1, xfade: 0.3, every: 1, floor: 0.07, pump: 1, moment: 1, dyn: 1 },
    chill: { name: "Chill / Lo-fi", mode: "levels", pools: { low: ["fireflies", "rainglass", "ocean", "aurora", "twinkle", "embers"], mid: ["galaxy", "neon", "vocal", "colorchord", "lavablobs", "hypno", "flow", "plasma", "melody", "northern"],
      peak: ["northern", "swell", "breath", "lava"] }, punch: 0.35, xfade: 1.2, every: 2, floor: 0.1, pump: 0.3, moment: 0.4, dyn: 0.5 },
    emotional: { name: "Emotional / Ballad", mode: "levels", pools: { low: ["candle", "vocal", "fireflies", "rainglass", "swell", "breath"], mid: ["swell", "vocal", "northern", "melody", "colorchord", "lavablobs", "ocean"],
      peak: ["sunrise", "northern", "swell", "aurora"] }, punch: 0.1, xfade: 2.0, every: 2, floor: 0.12, pump: 0, moment: 0.25, dyn: 0.4 },
  };

  for (const c of customs) { if (c.tag === "home") continue; (POOLS[c.tag] ||= []).push(c.id); const lv = c.tag === "calm" ? "low" : c.tag === "build" ? "mid" : "peak";
    for (const st of Object.values(STYLES)) if (st.mode === "levels" && st.pools[lv] && !st.pools[lv].includes(c.id)) st.pools[lv].push(c.id); }
  function render(id, S, out) {
    if (out) COL = out;
    COL.fill(0);
    const fx = FX[FXI[id]];
    if (!fx) throw new Error(`Unknown effect: ${id}`);
    fx.run(S);
    return COL;
  }
  const list = FX.map(f => ({ id: f.id, name: f.name, tag: f.tag, ...(f.custom ? { custom: true } : {}) }));
  return { render, list, pools: POOLS, styles: STYLES, impact: IMPACT, lum: LUM, palettes: { auto: PAL, ...Object.fromEntries(Object.entries(PALSETS).map(([k, v]) => [k, v.map(hex)])) } };
}
