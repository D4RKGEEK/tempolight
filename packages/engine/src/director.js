// The director decides what the room shows each frame: which effect fits the song right now (by style and song
// part), crossfades between effects, keeps quiet music from going dark, plays the ambient effect when nothing is
// playing, and applies live overlays (flash, strobe, blackout, colour hold) and the photosensitivity limiter.
import { buildSignals } from "./signals.js";

const G = (x, w) => Math.exp(-(x / w) * (x / w));

/** Signals for "nothing is playing": a slow made-up beat so ambient effects still move. */
export function idleSignals(t, pal, fixed) {
  const P = 1.2, x = t / P, idx = Math.floor(x), ph = x - idx;
  return { t, g: { has: true, P, phase: ph, idx, beatInBar: idx % 4, env: Math.exp(-ph * P / 0.3), barPhase: (idx % 4 + ph) / 4, beatT: idx * P },
    pal, fixed, punch: 0.2, loud: 0.35, wave: null, hat: -9, snare: -9, snares: [], pulseT: -9, pulses: [], pulseN: idx,
    pulse: 0, kickE: 0, snareE: 0, hatE: 0, bassL: 0, bands: new Float32Array(24), buildP: 0, dropIn: 99, sinceDrop: 99 };
}

/**
 * @param {ReturnType<import("./layout.js").buildLayout>} layout
 * @param {ReturnType<import("./effects.js").createEffects>} fx
 */
export function createDirector(layout, fx) {
  const N = layout.N, { LS, LF, LL, chainStart } = layout;
  const COL = new Float32Array(N * 3), PREV = new Float32Array(N * 3), AMB = new Float32Array(N * 3);
  const ids = new Set(fx.list.map(e => e.id));
  const st = {
    cur: "aurora", prev: null, xfadeT: -9, lastSwitchBeat: -99, poolIdx: {}, palIdx: 0, lastState: "silent",
    flashes: [], lastLum: 0, overlay: { flashT: -9, flashColor: [1, 1, 1], strobe: false, blackout: false, hold: null, boost: 1, freeze: false },
    identify: null, styleName: "party",
  };
  /** Settings the app can change at any time. */
  const settings = { mode: "auto", effect: "shock", style: "auto", palette: "auto", ambient: "northern", everyBeats: 8, safe: false, dropFlash: true, speed: 1 };

  const style = V => fx.styles[settings.style !== "auto" ? settings.style : (V && V.style) || "party"] || fx.styles.party;
  const palette = () => settings.palette === "auto" ? fx.palettes.auto[st.palIdx % fx.palettes.auto.length] : (fx.palettes[settings.palette] || fx.palettes.neon);

  function choose(t, V) {
    const g = V.g;
    if (settings.mode !== "auto") { const want = ids.has(settings.effect) ? settings.effect : "shock"; if (st.cur !== want) { st.prev = st.cur; st.cur = want; st.xfadeT = t; } return; }
    const ST = style(V);
    const sec = ST.mode === "sections" ? (V.state === "silent" ? "calm" : V.state) : V.level, pool = ST.pools[sec] || ST.pools.calm || ST.pools.low;
    const wrongPool = !pool.includes(st.cur), hot = sec === "drop" || sec === "peak";
    const barReady = g.has && g.beatInBar === 0 && g.idx - st.lastSwitchBeat >= settings.everyBeats * ST.every * (hot ? 1 : 2);
    if (!st.poolIdx[sec]) st.poolIdx[sec] = 0;
    if (V.state === "silent" && !wrongPool) return;
    if (wrongPool || barReady) {
      if (sec === "build" && wrongPool) st.poolIdx.build = 0;
      const next = pool[st.poolIdx[sec] % pool.length]; st.poolIdx[sec]++;
      if (next !== st.cur) { st.prev = st.cur; st.cur = next; st.xfadeT = t; st.palIdx++; }
      st.lastSwitchBeat = g.has ? g.idx : st.lastSwitchBeat;
    }
  }

  function renderAmbient(t, out) {
    if (settings.ambient === "off" || !ids.has(settings.ambient)) { out.fill(0); return false; }
    fx.render(settings.ambient, idleSignals(t * settings.speed, palette(), settings.palette !== "auto"), out); return true;
  }
  function keepAlive(t, floor) {
    if (settings.ambient === "off" || st.cur === settings.ambient || floor <= 0.001) return;
    let m = 0; for (let i = 0; i < N; i++) m += Math.max(COL[i * 3], COL[i * 3 + 1], COL[i * 3 + 2]); m /= Math.max(1, N);
    if (m >= floor) return; const w = (floor - m) / floor;
    if (renderAmbient(t, AMB)) for (let i = 0; i < COL.length; i++) COL[i] += AMB[i] * w * 0.9;
  }

  function overlays(t) {
    const o = st.overlay;
    if (o.hold) { for (let i = 0; i < N; i++) { COL[i * 3] = o.hold[0]; COL[i * 3 + 1] = o.hold[1]; COL[i * 3 + 2] = o.hold[2]; } }
    const fd = t - o.flashT; if (fd >= 0 && fd < 0.6) { const e = Math.exp(-fd / 0.12) * 2.2; for (let i = 0; i < N; i++) { COL[i * 3] += o.flashColor[0] * e; COL[i * 3 + 1] += o.flashColor[1] * e; COL[i * 3 + 2] += o.flashColor[2] * e; } }
    if (o.strobe) { const on = Math.floor(t * 12) % 2 === 0; for (let i = 0; i < COL.length; i++) COL[i] = on ? COL[i] * 0.3 + 1.6 : 0; }
    if (o.boost !== 1) for (let i = 0; i < COL.length; i++) COL[i] *= o.boost;
    if (o.blackout) COL.fill(0);
    if (st.identify) { // light one shape in white with a chase so people can see which strip is which, dim the rest
      const id = st.identify, dt = t - id.t; if (dt > 4) st.identify = null; else {
        for (let i = 0; i < N; i++) { const mine = id.shapes ? id.shapes.has(LF[i]) : true;
          if (!mine) { COL[i * 3] *= 0.08; COL[i * 3 + 1] *= 0.08; COL[i * 3 + 2] *= 0.08; continue; }
          const first = LS[i] === 0 || (LL[i] && i === chainStart[LF[i]]), blink = first ? (Math.floor(dt * 4) % 2 ? 0 : 2.5) : 0, head = G(LS[i] - (dt / 2.4) % 1, 0.03) * 1.5;
          COL[i * 3] = 0.06 + head; COL[i * 3 + 1] = 0.06 + head + blink; COL[i * 3 + 2] = 0.08 + head; } }
    }
  }

  // photosensitivity: no more than 3 big brightness jumps per second (WCAG 2.3.1); extra jumps are held back
  function limiter(t) {
    let m = 0; for (let i = 0; i < COL.length; i++) m += COL[i]; m /= Math.max(1, COL.length);
    st.flashes = st.flashes.filter(x => t - x < 1);
    if (m > st.lastLum * 1.8 + 0.12) {
      if (st.flashes.length >= 3) { const k = (st.lastLum * 1.2 + 0.05) / Math.max(1e-6, m); for (let i = 0; i < COL.length; i++) COL[i] *= k; m *= k; }
      else st.flashes.push(t);
    }
    st.lastLum = st.lastLum + (m - st.lastLum) * 0.5;
  }

  /**
   * Render one frame.
   * @param {object|null} V a view of the music (songView / LiveAnalyser.view), or null when nothing is playing
   * @param {number} t time in seconds on the music's clock (or any clock when V is null)
   * @param {{bands?:Float32Array, wave?:Float32Array, bassL?:number}} [extra]
   * @param {number} [wall] a steady clock in seconds for overlays (flash, strobe, identify); defaults to t
   * @returns {Float32Array} linear RGB, N*3
   */
  function frame(V, t, extra = {}, wall = t) {
    COL.fill(0);
    if (st.overlay.freeze) { COL.set(PREV); overlays(wall); return COL; }
    if (!V) {
      if (settings.mode !== "auto" && ids.has(settings.effect)) { fx.render(settings.effect, idleSignals(t * settings.speed, palette(), settings.palette !== "auto"), COL); st.cur = settings.effect; st.showing = st.cur; }
      else { renderAmbient(t, COL); st.showing = settings.ambient; }
      st.lastState = "idle";
    } else {
      const ST = style(V); st.styleName = settings.style !== "auto" ? settings.style : V.style || "party";
      choose(t, V);
      const S = buildSignals(st.styleName === V.style ? V : { ...V, style: st.styleName }, t, { pal: palette(), fixed: settings.palette !== "auto", ...extra });
      fx.render(st.cur, S, COL);
      if (st.prev && t - st.xfadeT < ST.xfade) {
        const k = (t - st.xfadeT) / ST.xfade; PREV.set(COL); fx.render(st.prev, S, COL);
        for (let i = 0; i < COL.length; i++) COL[i] = PREV[i] * k + COL[i] * (1 - k);
      }
      // never let the room go dark: quiet parts fade to the ambient effect; only the planned pause before a drop is a blackout
      const preDrop = ST.mode === "sections" && V.nextDrop != null && V.nextDrop >= t && V.nextDrop - t < 1.4;
      const quietFor = V.quietFor != null ? V.quietFor : 99;
      if (V.state === "silent" && (preDrop || quietFor < 1.5)) { for (let i = 0; i < COL.length; i++) COL[i] *= 0.12; }
      else if (V.state === "silent") { renderAmbient(t, AMB); for (let i = 0; i < COL.length; i++) COL[i] = COL[i] * 0.2 + AMB[i] * 0.8; }
      else keepAlive(t, ST.floor * Math.max(0, Math.min(1, 1.3 - (V.loud || 0) * 1.6)));
      const df = t - V.dropT; if (settings.dropFlash && ST.mode === "sections" && df >= 0 && df < 0.7) { const e = Math.exp(-df / 0.17) * 2.3; for (let i = 0; i < COL.length; i++) COL[i] += e; }
      st.lastState = V.state; st.showing = st.cur;
    }
    overlays(wall);
    if (settings.safe) limiter(wall);
    for (let i = 0; i < COL.length; i++) { const v = COL[i]; COL[i] = v === v ? Math.max(0, v) : 0; }
    if (!st.overlay.freeze) PREV.set(COL);
    return COL;
  }

  return {
    frame, settings, state: st,
    get current() { return st.cur; }, get showing() { return st.showing || st.cur; }, get style() { return st.styleName; },
    flash(t, color) { st.overlay.flashT = t; st.overlay.flashColor = color || [1, 0.97, 0.94]; },
    /** Light up some shapes (indexes) so people can see which is which; null = all. */
    identify(t, shapes) { st.identify = { t, shapes: shapes == null ? null : new Set([].concat(shapes)) }; },
    next(t) { const ST = style(null), pool = ST.pools.drop || ST.pools.peak; st.poolIdx.drop = (st.poolIdx.drop || 0) + 1; st.prev = st.cur; st.cur = pool[st.poolIdx.drop % pool.length]; st.xfadeT = t; st.palIdx++; },
  };
}
