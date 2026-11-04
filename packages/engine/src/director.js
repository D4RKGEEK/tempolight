// The director decides what the room shows each frame: which effect fits the song right now (by style and song
// part), crossfades between effects, keeps quiet music from going dark, plays the ambient effect when nothing is
// playing, and applies live overlays (flash, strobe, blackout, colour hold) and the photosensitivity limiter.
import { showAt } from "./show.js";
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
  const settings = { mode: "auto", effect: "shock", style: "auto", palette: "auto", ambient: "northern", everyBeats: 8, safe: false, dropFlash: true, speed: 1,
    prefs: {},    // effect id -> 1 (liked: shows up more in automatic mode) or -1 (banned: never chosen automatically)
    params: {},   // effect id -> {speed, intensity, hue, saturation, mirror}
    zones: [],    // [{id, mode: "follow"|"effect"|"ambient"|"off", effect, brightness}]; shapes join a zone with shape.zone
    layer: null,  // {effect, amount}: an accent effect added on top of whatever is showing
  };
  const ZBUF = new Float32Array(N * 3);
  const fixedPal = () => settings.palette !== "auto";

  // ---- per-effect settings, applied to any effect after it renders
  let MIRROR = null;
  function mirrorMap() { // for each LED, the LED closest to its left-right mirror image in the room
    if (MIRROR) return MIRROR; const { PX, PY } = layout; let x0 = 1e9, x1 = -1e9; for (let i = 0; i < N; i++) { x0 = Math.min(x0, PX[i]); x1 = Math.max(x1, PX[i]); }
    MIRROR = new Int32Array(N); for (let i = 0; i < N; i++) { const mx = x0 + x1 - PX[i], my = PY[i]; let bi = i, bd = 1e9;
      for (let j = 0; j < N; j++) { const dx = PX[j] - mx; if (dx > bd || -dx > bd) continue; const d = dx * dx + (PY[j] - my) ** 2; if (d < bd) { bd = d; bi = j; } } MIRROR[i] = bi; }
    return MIRROR;
  }
  function colourMatrix(hueDeg, sat) { // CSS hue-rotate then saturate, as one 3x3 matrix
    const a = hueDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const H = [.213 + c * .787 - s * .213, .715 - c * .715 - s * .715, .072 - c * .072 + s * .928, .213 - c * .213 + s * .143, .715 + c * .285 + s * .140, .072 - c * .072 - s * .283, .213 - c * .213 - s * .787, .715 - c * .715 + s * .715, .072 + c * .928 + s * .072];
    const S = [.213 + .787 * sat, .715 - .715 * sat, .072 - .072 * sat, .213 - .213 * sat, .715 + .285 * sat, .072 - .072 * sat, .213 - .213 * sat, .715 - .715 * sat, .072 + .928 * sat];
    const M = new Array(9); for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) M[r * 3 + k] = S[r * 3] * H[k] + S[r * 3 + 1] * H[3 + k] + S[r * 3 + 2] * H[6 + k]; return M;
  }
  function renderFx(id, S, out) {
    const p = settings.params[id];
    if (!p) { fx.render(id, S, out); return out; }
    fx.render(id, p.speed && p.speed !== 1 ? { ...S, t: S.t * p.speed } : S, out);
    const gain = p.intensity ?? 1, hue = p.hue || 0, sat = p.saturation ?? 1;
    if (hue || sat !== 1) { const M = colourMatrix(hue, sat);
      for (let i = 0; i < out.length; i += 3) { const r = out[i], g = out[i + 1], b = out[i + 2];
        out[i] = Math.max(0, M[0] * r + M[1] * g + M[2] * b); out[i + 1] = Math.max(0, M[3] * r + M[4] * g + M[5] * b); out[i + 2] = Math.max(0, M[6] * r + M[7] * g + M[8] * b); } }
    if (gain !== 1) for (let i = 0; i < out.length; i++) out[i] *= gain;
    if (p.mirror) { const m = mirrorMap(); ZTMP.set(out); for (let i = 0; i < N; i++) { const j = m[i] * 3; out[i * 3] = ZTMP[j]; out[i * 3 + 1] = ZTMP[j + 1]; out[i * 3 + 2] = ZTMP[j + 2]; } }
    return out;
  }
  const ZTMP = new Float32Array(N * 3);
  const withPrefs = list => { const out = []; for (const id of list) { const p = settings.prefs[id]; if (p === -1) continue; out.push(id); if (p === 1) out.push(id); }
    // liked effects come round twice as often; if everything in a list is banned, fall back to the list
    return out.length ? out : list; };

  // ---- zones: parts of the room with their own effect, the ambient effect, their own brightness, or off
  const zoneIdx = new Map(); layout.LF && layout.shapes && (() => { for (let i = 0; i < N; i++) { const z = layout.shapes[layout.LF[i]]?.zone; if (!z) continue; if (!zoneIdx.has(z)) zoneIdx.set(z, []); zoneIdx.get(z).push(i); } })();
  function applyZones(S, t) {
    for (const z of settings.zones) {
      const idx = zoneIdx.get(z.id); if (!idx) continue; const b = z.brightness ?? 1;
      if (z.mode === "off") { for (const i of idx) { COL[i * 3] = COL[i * 3 + 1] = COL[i * 3 + 2] = 0; } continue; }
      if (z.mode === "effect" || z.mode === "ambient") {
        const id = z.mode === "ambient" ? settings.ambient : z.effect; if (!ids.has(id)) continue;
        renderFx(id, z.mode === "ambient" || !S ? idleSignals(t * settings.speed, palette(), fixedPal()) : S, ZBUF);
        for (const i of idx) { COL[i * 3] = ZBUF[i * 3] * b; COL[i * 3 + 1] = ZBUF[i * 3 + 1] * b; COL[i * 3 + 2] = ZBUF[i * 3 + 2] * b; } continue;
      }
      if (b !== 1) for (const i of idx) { COL[i * 3] *= b; COL[i * 3 + 1] *= b; COL[i * 3 + 2] *= b; }
    }
  }
  function applyLayer(S, t) {
    const L = settings.layer; if (!L || !ids.has(L.effect) || !(L.amount > 0)) return;
    renderFx(L.effect, S || idleSignals(t * settings.speed, palette(), fixedPal()), ZBUF); for (let i = 0; i < COL.length; i++) COL[i] += ZBUF[i] * L.amount;
  }

  const style = V => fx.styles[settings.style !== "auto" ? settings.style : (V && V.style) || "party"] || fx.styles.party;
  const palette = () => settings.palette === "auto" ? fx.palettes.auto[st.palIdx % fx.palettes.auto.length] : (fx.palettes[settings.palette] || fx.palettes.neon);

  function choose(t, V) {
    const g = V.g;
    // the music's clock jumped back (a seek, a recognised song's position replacing the live clock, the next song):
    // a crossfade or bar count from the old clock would run backwards (or wait minutes), so start them afresh
    if (t < st.xfadeT) st.xfadeT = t - 99;
    if (g.has && g.idx < st.lastSwitchBeat) st.lastSwitchBeat = g.idx;
    if (settings.mode !== "auto") { const want = ids.has(settings.effect) ? settings.effect : "shock"; if (st.cur !== want) { st.prev = st.cur; st.cur = want; st.xfadeT = t; } return; }
    // a show timeline for this song: play it (an effect banned since the show was made is skipped)
    if (settings.plan && settings.plan.length) { const b = showAt(settings.plan, t);
      if (b && ids.has(b.effect) && settings.prefs[b.effect] !== -1) { if (st.cur !== b.effect) { st.prev = st.cur; st.cur = b.effect; st.xfadeT = t; st.palIdx++; } return; } }
    const ST = style(V);
    if (g.has && g.idx < st.lastSwitchBeat) st.lastSwitchBeat = g.idx; // the beat count restarted (another music source): count from here
    const sec = ST.mode === "sections" ? (V.state === "silent" ? "calm" : V.state) : V.level, pool = withPrefs(ST.pools[sec] || ST.pools.calm || ST.pools.low);
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
    if (settings.ambientHook && settings.ambientHook(t, out)) return true; // the ambient plan for this hour (Home & sleep)
    if (settings.ambient === "off" || !ids.has(settings.ambient)) { out.fill(0); return false; }
    renderFx(settings.ambient, idleSignals(t * settings.speed, palette(), settings.palette !== "auto"), out); return true;
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
      if (settings.mode !== "auto" && ids.has(settings.effect)) { renderFx(settings.effect, Object.assign(idleSignals(t * settings.speed, palette(), settings.palette !== "auto"), { text: extra.text || "", screen: extra.screen || null }), COL); st.cur = settings.effect; st.showing = st.cur; }
      else { renderAmbient(t, COL); st.showing = settings.ambient; }
      st.lastState = "idle"; applyLayer(null, t); applyZones(null, t);
    } else {
      const ST = style(V); st.styleName = settings.style !== "auto" ? settings.style : V.style || "party";
      choose(t, V);
      const S = buildSignals(st.styleName === V.style ? V : { ...V, style: st.styleName }, t, { pal: palette(), fixed: settings.palette !== "auto", ...extra });
      S.text = extra.text || ""; S.screen = extra.screen || null;
      renderFx(st.cur, S, COL);
      if (st.prev && t - st.xfadeT < ST.xfade) {
        const k = Math.max(0, (t - st.xfadeT) / ST.xfade); PREV.set(COL); renderFx(st.prev, S, COL);
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
      applyLayer(S, t); applyZones(S, t);
    }
    if (settings.post) settings.post(COL, wall); // sunrise alarm and sleep timer (Home & sleep): on top of the show, under the pads
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
