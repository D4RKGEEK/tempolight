// The director decides what the room shows each frame: which effect fits the song right now (by style and song
// part), crossfades between effects, keeps quiet music from going dark, plays the ambient effect when nothing is
// playing, and applies live overlays (flash, strobe, blackout, colour hold) and the photosensitivity limiter.
import { showAt, chooseStep, swapBars, varyBars } from "./show.js";
import { buildSignals, kickHit } from "./signals.js";
import { rangeAt, brightAt, cuesAt, createCueFirer, blockPalette } from "./timeline.js";
import { moodPalette } from "./tonal.js";
import { pickLook, characterOf, phraseStep, rating } from "./looks.js";
import { createChordColours, sectionKey } from "./colour.js";
import { createSpatial } from "./spatial.js";

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
    identify: null, styleName: "party", fxLum: {}, fxCorr: {}, fxKick: {}, tgt: null,
  };
  /** Settings the app can change at any time. */
  const settings = { mode: "auto", effect: "shock", style: "auto", palette: "auto", ambient: "northern", everyBeats: 8, safe: false, dropFlash: true, speed: 1,
    prefs: {},    // effect id -> 1 (liked: shows up more in automatic mode) or -1 (banned: never chosen automatically)
    params: {},   // effect id -> {speed, intensity, hue, saturation, mirror}
    zones: [],    // [{id, mode: "follow"|"effect"|"ambient"|"off", effect, brightness}]; shapes join a zone with shape.zone
    layer: null,  // {effect, amount}: an accent effect added on top of whatever is showing
    // plan: the song's effect blocks (show.js); timeline: its {colors, cues, bright} (timeline.js), both on the song's clock
    moodColours: true, // palette "auto": colours from the music's mood when it is known (palette "mood": always, for every effect)
    // the feel (frame-level, on top of any effect): punch 0..1 = how hard the kick pumps the room in drops;
    // dynamics 0..1 = how much brightness follows the song part (and evens effects out, automatic mode only);
    // variations: drops change look every 2 bars (colour flip and mirror) between effect changes;
    // night: night mode (a gentler pump; the runtime also turns the drop flash off and safe mode on)
    punch: 0.7, dynamics: 0.8, variations: true, night: false,
    // variety (automatic mode): "show" = effects change with the song parts and on phrase lines (from the rated pools);
    // "one" = one look for the whole song (look.drop only at drops, when the look has one); "parts" = the look's
    // effect for calm parts, build-ups and drops. look: the song's look (looks.js pickLook), null = the director
    // picks one itself from what it hears (live listening). nudge: effect id -> -1..1, a soft preference for looks
    variety: "show", look: null, nudge: {}, lookExclude: [],
    // chordColours: with the automatic palette, colours step with the chords (colour.js); stereo: "off" | "subtle" |
    // "strong", the side of the room the hit came from brightens on hits (spatial.js; stereo sources only)
    chordColours: true, stereo: "subtle",
  };
  const cueFirer = createCueFirer();
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
  // a look's own settings for its effects (looks.js: speed follows the tempo for effects that don't need the beat, a
  // little more intensity for energetic songs), on top of the effect's settings
  function paramsOf(id) {
    const p = settings.params[id], L = lookOn() ? activeLook() : null, lp = L && L.params && (id === L.main || id === L.drop || id === L.build || id === L.calm) ? L.params : null;
    if (!lp) return p;
    const sp = lp.speed && !(rating(id) || {}).needsBeat ? lp.speed : 1, k = lp.intensity || 1;
    if (sp === 1 && k === 1) return p;
    return { ...(p || {}), speed: (p?.speed ?? 1) * sp, intensity: (p?.intensity ?? 1) * k };
  }
  function renderFx(id, S, out) {
    const p = paramsOf(id);
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
  const basePalette = () => settings.palette === "auto" || settings.palette === "mood" ? fx.palettes.auto[palN() % fx.palettes.auto.length] : (fx.palettes[settings.palette] || fx.palettes.neon);
  // chord colours: the palette steps with the chords; a song's sections pick the palette's variant (not each effect
  // change), so a repeated section gets the same colours
  const chords = createChordColours(), chordsOn = () => settings.chordColours !== false && settings.palette === "auto";
  const palN = () => chordsOn() && st.secKey != null ? st.secKey : st.palIdx;
  const palette = () => st.chordPal || rawPalette();
  const rawPalette = () => st.lookPal || (st.moodPal && (settings.palette === "mood" || (settings.palette === "auto" && settings.moodColours !== false)) ? st.moodPal : basePalette());
  // ---- looks (looks.js): one effect for the song, its palette stepping on phrase lines
  const lookOn = () => settings.mode === "auto" && (settings.variety === "one" || settings.variety === "parts") && !!activeLook();
  const activeLook = () => settings.look || st.liveLook || null;
  const VAR = new Map();
  function variantPal(base, k) { // step 0: the palette; 1, 2: turned 40° round the colour wheel either way; 3: its colours swapped
    const key = base.join() + k; let v = VAR.get(key); if (v) return v;
    if (k === 3) v = [base[1].slice(), base[0].slice()];
    else if (k === 0) v = base.map(c => c.slice());
    else { const M = colourMatrix(k === 1 ? 40 : -40, 1); v = base.map(([r, g, b]) => [M[0] * r + M[1] * g + M[2] * b, M[3] * r + M[4] * g + M[5] * b, M[6] * r + M[7] * g + M[8] * b].map(x => Math.max(0, Math.min(1, x)))); }
    if (VAR.size > 64) VAR.clear(); VAR.set(key, v); return v;
  }
  function updateLookPal(V, wall) {
    const L = activeLook(), base = L && fx.palettes[L.palette];
    if (!V || !lookOn() || settings.palette !== "auto" || !base) { st.lookPal = null; st.lookPalWall = wall; return; }
    const step = ((phraseStep(V) % 4) + 4) % 4, target = variantPal(base, step), dt = Math.max(0, Math.min(0.5, wall - (st.lookPalWall ?? wall))); st.lookPalWall = wall;
    if (!st.lookPal || st.lookPalBase !== base) { st.lookPal = target.map(c => c.slice()); st.lookPalBase = base; return; }
    const k = 1 - Math.exp(-dt / 0.3); for (let c = 0; c < 2; c++) for (let i = 0; i < 3; i++) st.lookPal[c][i] += (target[c][i] - st.lookPal[c][i]) * k; // a quick step, not a flicker
  }
  // live listening with no look from the song: a look of its own from what it hears, kept for the song. A first one
  // after 2 s of music (from the tempo and the kicks so far), the one to keep at the first drop or after 20 s of music
  // (the first one wins a close call, so it rarely changes), and a new one for a new song (4 s of silence, or nothing
  // playing for 3 s). settings.lookExclude: effects turned down for this song ("Not this one").
  function liveLook(V, wall) {
    if (settings.look || settings.mode !== "auto" || (settings.variety !== "one" && settings.variety !== "parts")) return;
    const ll = st.ll, dt = ll ? Math.max(0, Math.min(0.1, wall - ll.wall)) : 0;
    if (!V) { if (ll) { ll.idle += dt; ll.wall = wall; if (ll.idle > 3) resetLook(); } return; }
    if (V.state === "silent") { if (ll) { ll.wall = wall; if ((V.quietFor ?? 0) > 4) resetLook(); } return; }
    const L = ll || (st.ll = { wall, idle: 0, music: 0, bpm: [], ks: [], hits: 0, bars: 0, drumBars: 0, drumBeats: 0, beats: 0, lastKick: V.kick, lastBeat: V.g && V.g.idx, beatT: null, drops: 0, dropT: V.dropT, voc: 0, n: 0, final: false });
    L.wall = wall; L.idle = 0; L.music += dt; L.n++;
    if (V.bpm > 0 && L.n % 15 === 0) L.bpm.push(V.bpm);
    // the kick where the drums play (as songCharacter() counts it): beats with a kick, in bars with kicks on 2 beats or more
    if (V.kick !== L.lastKick && V.kick > -9) { L.lastKick = V.kick; L.ks.push(V.kick); if (L.ks.length > 16) L.ks.shift(); }
    if (V.g && V.g.has && V.g.idx !== L.lastBeat) {
      if (L.beatT != null) { L.beats++; if (L.ks.some(k => Math.abs(k - L.beatT) < 0.08)) L.hits++; }
      if (V.g.beatInBar === 0) { L.bars++; if (L.hits >= 2) { L.drumBars++; L.drumBeats += Math.min(4, L.hits); } L.hits = 0; }
      L.lastBeat = V.g.idx; L.beatT = V.g.beatT; }
    if (V.state === "drop" && V.dropT > -9 && V.dropT !== L.dropT) { L.dropT = V.dropT; L.drops++; }
    L.voc += ((V.vocal ?? 0) - L.voc) * 0.01;
    if (L.music < 2 || L.final || (st.liveLook && !(L.drops >= 1 || L.music >= 20))) return;
    const bpms = L.bpm.length ? [...L.bpm].sort((a, b) => a - b) : [V.bpm || 120], bpm = bpms[bpms.length >> 1], f = V.features || {};
    // (a drop heard live is a loud stretch with kicks: at the first one, the kick counts as steady even before its bars are in)
    let kickFrac = L.drumBars ? L.drumBeats / (4 * L.drumBars) * Math.min(1, 0.4 + L.drumBars / Math.max(1, L.bars)) : L.bars >= 2 ? 0 : 0.5;
    if (L.drops >= 1) kickFrac = Math.max(kickFrac, 0.7);
    // the style: a drop with kicks at 110 BPM or more is party (as the analyser decides, a little sooner); else the
    // analyser's once it is sure, and before that a guess from the kicks
    const style = L.drops >= 1 && bpm >= 110 ? "party" : V.styleSure ? V.style : kickFrac > 0.6 ? (bpm >= 110 ? "party" : "hiphop") : kickFrac < 0.2 ? "chill" : "poprock";
    const c = characterOf({ bpm, style, kickFrac, drumless: L.bars >= 3 && !L.drumBars, drops: L.drops, dyn: f.dyn, vocal: L.voc, mood: V.mood, mode: V.mode });
    const was = st.liveLook, nudge = was ? { ...settings.nudge, [was.main]: Math.min(1, (settings.nudge[was.main] || 0) + 0.6) } : settings.nudge;
    const look = pickLook(c, { prefs: settings.prefs, nudge, exclude: settings.lookExclude, available: ids, seed: `${Math.round(bpm / 2)}:${style}` });
    if (look) { look.provisional = true; st.liveLook = look; } L.final = !!was;
  }
  function resetLook() { st.ll = null; st.liveLook = null; if (settings.lookExclude.length) settings.lookExclude = []; }
  // mood colours: the music's valence and energy pick two colours (warm for happy, deep blue for sad, red and magenta
  // for tense, soft teal for calm and major); they ease over ~2.5 s, so a change of mood (or effect) crossfades
  function updateMood(V, wall) {
    const want = settings.palette === "mood" || (settings.palette === "auto" && settings.moodColours !== false);
    if (V && V.mood) { st.mood = V.mood; st.moodSeen = wall; } else if (st.mood && !(wall - st.moodSeen < 5)) st.mood = null; // gone for 5 s: back to the usual colours
    const m = st.mood || (settings.palette === "mood" ? { valence: 0.5, energy: 0.5 } : null);
    if (!want || !m) { st.moodPal = null; st.moodWall = wall; return; }
    const target = moodPalette(m.valence, m.energy, palN()), dt = Math.max(0, Math.min(0.5, wall - (st.moodWall ?? wall))); st.moodWall = wall;
    if (!st.moodPal) st.moodPal = basePalette().map(c => c.slice()); // start from what is showing
    const k = 1 - Math.exp(-dt / 2.5); for (let c = 0; c < 2; c++) for (let i = 0; i < 3; i++) st.moodPal[c][i] += (target[c][i] - st.moodPal[c][i]) * k;
  }

  // the bar the music is in, as a beat number (2 s bars when there is no beat grid), for phrase lines and variations
  const barOf = (g, t) => { if (g && g.has) return g.idx - g.beatInBar; const b = Math.floor(t / 0.5); return b - (((b % 4) + 4) % 4); };
  function choose(t, V) {
    const g = V.g;
    // the music's clock jumped back (a seek, a recognised song's position replacing the live clock, the next song):
    // a crossfade or bar count from the old clock would run backwards (or wait minutes), so start them afresh
    if (t < st.xfadeT) st.xfadeT = t - 99;
    if (g.has && g.idx < st.lastSwitchBeat) st.lastSwitchBeat = g.idx;
    if (settings.mode !== "auto") { const want = ids.has(settings.effect) ? settings.effect : "shock"; if (st.cur !== want) { st.prev = st.cur; st.cur = want; st.xfadeT = t; } st.hot = false; return; }
    // a show timeline for this song: play it (an effect banned since the show was made is skipped)
    if (settings.plan && settings.plan.length) { const b = showAt(settings.plan, t);
      if (b && ids.has(b.effect) && settings.prefs[b.effect] !== -1) {
        const lk = lookOn(); st.hot = lk ? V.state === "drop" : b.part === "drop"; // (a look's block can span the whole song)
        if (lk && V.state === "drop" && V.dropT > -9 && V.dropT !== st.dropT && t - V.dropT >= -0.05) { st.dropT = V.dropT; st.switchBar = barOf(g, t); } // a drop restarts its variations
        if (st.cur !== b.effect) { const P = g.has ? g.P : 0.5, hard = b.part === "drop" && V.dropT > -9 && t - V.dropT >= -0.05 && t - V.dropT < 2 * P;
          st.prev = st.cur; st.cur = b.effect; st.xfadeT = hard ? -99 : t; st.palIdx++; st.switchBar = barOf(g, t); }
        return; } }
    // a look, but none yet (live listening, the first seconds of a song): the effect showing stays until there is one
    if ((settings.variety === "one" || settings.variety === "parts") && !activeLook()) return;
    // the automatic choice (show.js, the same as a show's): song part → pool, drops cut at once, the rest on phrase lines
    const was = st.cur, d = chooseStep(st, fx, style(V), { prefs: settings.prefs, everyBeats: settings.everyBeats, variety: settings.variety, look: lookOn() ? activeLook() : null }, t, V);
    if (d) { st.prev = was; st.xfadeT = d.hard ? -99 : t; st.palIdx++; }
  }

  // ---- the feel: a frame-level layer on top of whatever effect is showing (the effects themselves are unchanged)
  // spatial accent: the kick pumps the floor and the middle of the room a little more than the ceiling and the edges
  const KW = (() => { const { PX, PY } = layout, w = new Float32Array(N); if (!PX || !PY || !N) return w.fill(1);
    let x0 = 1e9, x1 = -1e9; for (let i = 0; i < N; i++) { x0 = Math.min(x0, PX[i]); x1 = Math.max(x1, PX[i]); }
    let s = 0; for (let i = 0; i < N; i++) { const u = x1 > x0 ? (PX[i] - x0) / (x1 - x0) : 0.5, low = 1 - Math.max(0, Math.min(1, PY[i])), cen = 1 - Math.abs(2 * u - 1); w[i] = 0.6 + 0.5 * low + 0.3 * cen; s += w[i]; }
    s /= N; for (let i = 0; i < N; i++) w[i] = Math.max(0.5, Math.min(1.5, w[i] / s)); return w; })();
  const STRIDE = N * 3 > 3000 ? 7 : 1;
  const spatial = createSpatial(layout);
  /** How bright a frame looks (mean after the LED roll-off), from every LED or a sample of them. */
  function seen(buf) { let m = 0, n = 0; for (let i = 0; i < buf.length; i += STRIDE) { const v = buf[i]; if (v > 0) m += 1 - Math.exp(-1.28 * v); n++; } return n ? m / n : 0; }
  const clamp01 = (v, d) => { const x = typeof v === "number" && Number.isFinite(v) ? v : d; return Math.max(0, Math.min(1, x)); };
  // energy contour: the brightness each song part aims for (calm low, a build-up rising, a drop full)
  function contour(V) {
    if (V.state === "drop") return 0.34;
    if (V.state === "build") return 0.12 + 0.2 * Math.max(0, Math.min(1, V.buildP || 0));
    if (style(V).mode !== "levels") return 0.08;
    const lv = st.lvl || V.level; return lv === "peak" ? 0.2 : lv === "mid" ? 0.13 : 0.085; // loud parts of a song without drops
  }
  /** The brightness an effect should land on: its usual brightness (learnt, starting from fx.lum) brought toward the
   *  song part's target, all the way at e = 1. */
  const fxL = id => Math.max(0.02, st.fxLum[id] ?? (fx.lum && fx.lum[id]) ?? 0.15);
  const aimOf = (id, e) => { const L = fxL(id); return L * Math.exp(e * Math.log(Math.max(0.2, Math.min(3, st.tgt / L)))); };
  /** Gain for one effect: aim / usual brightness, corrected by what the LED roll-off does to this effect (learnt). */
  function gainOf(id, e) {
    if (!(e > 0) || st.tgt == null) return 1;
    return Math.max(0.1, Math.min(3, aimOf(id, e) / fxL(id) * (st.fxCorr[id] ?? 1)));
  }
  const lin = m => -Math.log(1 - Math.min(0.98, Math.max(1e-4, m))) / 1.28; // the light level that rolls off to m
  /** Kick pump: the whole frame dips between kicks and comes back on each one. 1 = no change. */
  function pumpDepth(V, ST) {
    const hot = V.state === "drop" ? 1 : ST.mode === "levels" && settings.mode === "auto" && st.lvl === "peak" ? 0.6 : 0;
    let d = 0.8 * clamp01(settings.punch, 0.7) * (ST.pump ?? 1) * hot;
    if (settings.night) d *= 0.4;
    if (settings.safe) d = Math.min(d, 0.1); // photosensitive-safe: a gentle sway, not a flicker
    return d;
  }

  // ---- the build toward a drop: in the last 8 bars before a drop that is known (whole-song analysis, a remembered
  // song, a show's cue: dropConf 1) or predicted live (drops.js, from dropConf 0.5), the room gets brighter and its
  // effect faster, the last bar pulses tighter (effects with the energy for it), then the dip and the drop flash.
  // It runs while the music builds up (a build-up part, or a live prediction), or over the last 2 bars before any
  // known drop. One effect throughout: the energy comes from brightness and speed, never from switching effect.
  /** The drop ahead if it is sure enough to act on: {at, conf}, else null. */
  function dropAhead(V, t) { const at = V.nextDrop; if (at == null || !(at >= t)) return null; const c = V.dropConf ?? 1; return c >= 0.5 ? { at, conf: c } : null; }
  function rampOf(V, t, P, wall) {
    const d = dropAhead(V, t), bar = 4 * P, R = st.ramp;
    const on = d && V.state !== "drop" && V.state !== "silent" && d.at - t <= 16 * bar && (V.state === "build" || V.dropSource === "predicted" || d.at - t <= 2 * bar);
    // (off: at the drop at once; otherwise eased out over half a second, so a prediction missing for a moment is no flicker)
    if (!on) { if (R && (V.state === "drop" || !(wall - R.seen < 0.5))) st.ramp = null; else if (R) R.r += (0 - R.r) * 0.1; return st.ramp ? st.ramp.r : 0; }
    // the same drop (a prediction may move by a phrase): keep where the ramp began; a new one, or the clock went back: begin now
    // (k0: the brightness it starts from, what showed the frame before; a known drop: it eases lower first, over a beat, for more to rise)
    if (!R || Math.abs(R.at - d.at) > 8 * bar + 0.1 || t < R.t0) st.ramp = { at: d.at, t0: t, seen: wall, r: 0, conf: d.conf, k0: st.lastK ?? 1, known: V.dropSource !== "predicted" };
    const r = st.ramp; r.at = d.at; r.seen = wall; r.conf = d.conf;
    const t0 = Math.max(r.t0, d.at - 8 * bar), want = Math.max(0, Math.min(1, (t - t0) / Math.max(0.5, d.at - t0)));
    r.r += (want - r.r) * (want < r.r ? 0.05 : 0.5); // (a prediction moved later: ease back, don't drop)
    return r.r;
  }
  // the speed-up: free-running animation runs up to 1.7x as fast; hits (kick, snare, hat, the beat) stay where they are
  function speedUp(S, dt, r, id) {
    if (r > 0 && dt > 0 && !(rating(id) || {}).needsBeat) st.tShift = (st.tShift || 0) + dt * 0.7 * r * r;
    const d = st.tShift || 0; if (!d) return S;
    return { ...S, t: S.t + d, pulseT: S.pulseT + d, snare: S.snare + d, hat: S.hat + d, pulses: S.pulses.map(x => x + d), snares: S.snares.map(x => x + d), g: S.g && { ...S.g, beatT: S.g.beatT + d } };
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
    st.secKey = sectionKey(V); updateMood(V, wall); liveLook(V, wall); updateLookPal(V, wall); st.lastV = V;
    st.chordPal = chords.update(V, t, wall, rawPalette(), chordsOn()); st.chords = chords.state;
    if (!V) {
      if (settings.mode !== "auto" && ids.has(settings.effect)) { renderFx(settings.effect, Object.assign(idleSignals(t * settings.speed, palette(), settings.palette !== "auto"), { text: extra.text || "", screen: extra.screen || null }), COL); st.cur = settings.effect; st.showing = st.cur; }
      else { renderAmbient(t, COL); st.showing = settings.ambient; }
      st.lastState = "idle"; applyLayer(null, t); applyZones(null, t);
    } else {
      // a hand-made timeline: build-up and drop cues change what the music "is doing", colour blocks the palette
      const TL = settings.timeline, P = (V.g && V.g.P) || 0.5, cs = TL ? cuesAt(TL.cues, t, P) : null, cpal = TL ? blockPalette(rangeAt(TL.colors, t), fx.palettes) : null;
      if (cs && cs.build) V = { ...V, state: "build", buildP: Math.min(1, (t - cs.build.t0) / (cs.build.t1 - cs.build.t0)), nextDrop: cs.build.t1, dropConf: 1, dropSource: "memory" };
      if (cs && cs.drop != null) V = { ...V, state: "drop", dropT: cs.drop, level: "peak" };
      const ST = style(V); st.styleName = settings.style !== "auto" ? settings.style : V.style || "party";
      choose(t, V);
      let S = buildSignals(st.styleName === V.style ? V : { ...V, style: st.styleName }, t, { pal: cpal || palette(), fixed: !!cpal || settings.palette !== "auto", ...extra });
      S.text = extra.text || ""; S.screen = extra.screen || null;
      const g = V.g || {}, auto = settings.mode === "auto", dt = Math.max(0, Math.min(0.1, t - (st.frameT ?? t))); st.frameT = t;
      // variation: in a drop, every other 2-bar line flips the colours and mirrors the room instead of a new effect
      const vb = auto && settings.variations !== false ? varyBars(swapBars(settings.everyBeats, ST, st.hot), st.hot) : 0;
      const vary = vb > 0 && st.switchBar != null && Math.floor((barOf(g, t) - st.switchBar) / 4 / vb) % 2 === 1;
      st.vary = vary;
      // (the speed-up ends at the drop: its hard cut and flash hide the jump back)
      const rp = rampOf(V, t, P, wall), S0 = S; if (V.state === "drop") st.tShift = 0; S = speedUp(S, dt, rp, st.cur);
      if (vary) { renderFx(st.cur, { ...S, pal: [S.pal[1], S.pal[0]] }, COL); const m = mirrorMap(); ZTMP.set(COL); for (let i = 0; i < N; i++) { const j = m[i] * 3; COL[i * 3] = ZTMP[j]; COL[i * 3 + 1] = ZTMP[j + 1]; COL[i * 3 + 2] = ZTMP[j + 2]; } }
      else renderFx(st.cur, S, COL);
      // energy contour and evening out (automatic mode): each effect is brought toward the song part's brightness
      const e = auto ? clamp01(settings.dynamics, 0.8) * (ST.dyn ?? 1) : 0, fading = st.prev && t - st.xfadeT < ST.xfade; let gain = 1;
      if (e > 0) {
        const want = V.state === "silent" ? (st.tgt ?? contour(V)) : contour(V), justDropped = V.state === "drop" && t - V.dropT >= 0 && t - V.dropT < 0.1;
        st.tgt = st.tgt == null || justDropped ? want : st.tgt + (want - st.tgt) * (1 - Math.exp(-dt / (want > st.tgt ? 0.6 : 0.4)));
        const p = paramsOf(st.cur), raw = seen(COL) / ((p && p.intensity) || 1);
        if (!fading && V.state !== "silent" && dt > 0) { const L0 = st.fxLum[st.cur] ?? (fx.lum && fx.lum[st.cur]) ?? raw; st.fxLum[st.cur] = L0 + (raw - L0) * (1 - Math.exp(-dt / 6)); }
        const k = gain = gainOf(st.cur, e); if (k !== 1) for (let i = 0; i < COL.length; i++) COL[i] *= k;
        if (!fading && V.state !== "silent" && dt > 0 && raw > 0.003) { // learn how far the roll-off keeps this effect from its aim
          const post = seen(COL), c = st.fxCorr[st.cur] ?? 1, r = lin(aimOf(st.cur, e)) / lin(post);
          st.fxCorr[st.cur] = Math.max(0.3, Math.min(3, c * Math.exp(Math.log(Math.max(0.5, Math.min(2, r))) * (1 - Math.exp(-dt / 2))))); }
      }
      // the build toward a drop: brighter as it nears (as much as Drama and the style's moment say; gentler at night).
      // Without a drop ahead, a look's build-up still rises from inside (one effect plays through the song)
      const mo = ST.moment ?? 1, drama = Math.min(1, clamp01(settings.dynamics, 0.8) * 1.25);
      // (from where it was to 1.9x, all the way at Drama 80% and up; a known drop first eases down)
      let k = 1;
      if (rp > 0 && st.ramp) { const amt = 0.9 * drama * mo * (settings.night ? 0.5 : 1), R = st.ramp, k0 = R.known ? R.k0 + (Math.min(R.k0, 1 - 0.5 * amt) - R.k0) * Math.min(1, (t - R.t0) / P) : R.k0; k = k0 + (1 + amt - k0) * rp * rp; }
      else if (lookOn() && V.state === "build") k = 0.8 + 0.45 * Math.max(0, Math.min(1, V.buildP || 0));
      st.lastK = k; if (rp > 0) st.peakK = Math.max(st.peakK || 1, k); if (k !== 1) for (let i = 0; i < COL.length; i++) COL[i] *= k;
      if (fading) {
        const k = Math.max(0, (t - st.xfadeT) / ST.xfade), gp = gainOf(st.prev, e); PREV.set(COL); renderFx(st.prev, S0, COL);
        for (let i = 0; i < COL.length; i++) COL[i] = PREV[i] * k + COL[i] * gp * (1 - k);
      }
      // kick pump in drops: dips between kicks and comes back on each one (as hard as the kick was played)
      // kicks that sit on the beat grid pump on the grid's beat: a detected kick can land a frame or three late
      const onGrid = g.has && V.kick > -9 && t - V.kick < 2 * P && Math.abs(V.kick - (g.beatT - Math.round((g.beatT - V.kick) / P) * P)) < 0.07;
      let depth = pumpDepth(V, ST); const ka = t - (onGrid ? g.beatT : V.kick);
      if (depth > 0.001 && ka >= -0.02 && ka < 3 * P) {
        // an effect that doesn't light up on the kick by itself (a wave that peaks between kicks) gets a deeper pump:
        // learn how bright it is just after kicks against just before the next one
        if (!fading && dt > 0 && ka < P) { const r = seen(COL), kp = st.fxKick[st.cur] || (st.fxKick[st.cur] = { n: r, l: r }), a = 1 - Math.exp(-dt / 1.5);
          if (ka < 0.1) kp.n += (r - kp.n) * a; else if (ka > 0.6 * P) kp.l += (r - kp.l) * a; }
        const kp = st.fxKick[st.cur], kr = kp && kp.l > 0.005 ? kp.n / kp.l : 1.3;
        depth = Math.min(Math.max(depth, 0.85 * Math.min(1, depth / 0.4)), depth * (1 + 0.8 * Math.max(0, Math.min(1, (1.3 - kr) / 0.7))));
        const tau = Math.max(0.08, Math.min(0.16, 0.27 * P)), hit = kickHit(V), q = depth * (1 - hit * Math.exp(-Math.max(0, ka) / tau)) * Math.max(0, Math.min(1, (3 * P - ka) / P));
        if (q > 0.001) for (let i = 0; i < N; i++) { const s = Math.max(0, 1 - q * KW[i]); COL[i * 3] *= s; COL[i * 3 + 1] *= s; COL[i * 3 + 2] *= s; }
      }
      // never let the room go dark: quiet parts fade to the ambient effect; only the planned pause before a drop is a blackout
      const ahead = dropAhead(V, t), preDrop = !!ahead && ahead.at - t < 1.4;
      const quietFor = V.quietFor != null ? V.quietFor : 99;
      if (V.state === "silent" && (preDrop || quietFor < 1.5)) { for (let i = 0; i < COL.length; i++) COL[i] *= 0.12; }
      else if (V.state === "silent") { renderAmbient(t, AMB); for (let i = 0; i < COL.length; i++) COL[i] = COL[i] * 0.2 + AMB[i] * 0.8; }
      else keepAlive(t, ST.floor * Math.min(1, gain) * Math.max(0, Math.min(1, 1.3 - (V.loud || 0) * 1.6))); // dimmed on purpose: a lower floor
      // moments, in every style (as big as the style's "moment"): the last beat before a known drop dims (no silence
      // needed), then the drop flashes
      // the last bar before the drop pulses on eighths, then sixteenths (an effect with the energy for it; never in
      // photosensitive-safe or night mode), as hard as Punch says
      const dIn = ahead ? ahead.at - t : 99;
      if (rp > 0 && dIn > P && dIn <= 4 * P && !settings.safe && !settings.night && (rating(st.cur) || {}).energy !== "low") {
        const sub = dIn > 2 * P ? 2 : 4, x = (((ahead.at - t) / P * sub) % 1 + 1) % 1, ph = 1 - x; // ph: 0 on each subdivision
        const L = P / sub, depth = 0.45 * clamp01(settings.punch, 0.7) * mo, avg = 1 - 0.06 / L * (1 - Math.exp(-L / 0.06)); // (as bright on average)
        const f = (1 - depth * (1 - Math.exp(-ph * L / 0.06))) / (1 - depth * avg); for (let i = 0; i < COL.length; i++) COL[i] *= f; }
      if (dIn > 0 && dIn <= P && V.state !== "silent") { const k = Math.min(1, (P - dIn) / 0.05) * (0.75 + 0.15 * rp) * mo * drama; // (deeper after a ramp)
        if (k > 0) for (let i = 0; i < COL.length; i++) COL[i] *= 1 - k; }
      spatial.apply(COL, V, t, settings.stereo); st.spatial = spatial.state;
      // (after a build ramp the flash peaks as much higher as the room got brighter, so it still stands out; the extra
      // part is short, gone by the next kick)
      const df = t - V.dropT; if (settings.dropFlash && df >= 0 && df < 0.7) { const pk = st.peakK || 1, f = (Math.exp(-df / 0.17) + (pk - 1) * Math.exp(-df * pk / 0.17)) * 2.3 * mo * (settings.safe ? 0.6 : 1); for (let i = 0; i < COL.length; i++) COL[i] += f; }
      else if (st.peakK && !(rp > 0) && (df >= 0.7 || V.state !== "drop")) st.peakK = 1;
      st.lastState = V.state; st.showing = st.cur;
      applyLayer(S, t); applyZones(S, t);
      if (TL) { // flashes fire once as the clock passes them; strobe (sixteenth notes), blackout and brightness follow the clock
        cueFirer.step(TL.cues, t, (c, late) => { st.overlay.flashT = wall - late; st.overlay.flashColor = c.color ? [1, 3, 5].map(k => parseInt(c.color.slice(k, k + 2), 16) / 255) : [1, 0.97, 0.94]; st.lastCue = { type: c.type, t: c.t, at: wall }; st.cuesFired = (st.cuesFired || 0) + 1; });
        if (cs.strobe) { const on = Math.floor((t - cs.strobe.t) / (P / 4)) % 2 === 0; for (let i = 0; i < COL.length; i++) COL[i] = on ? COL[i] * 0.3 + 1.6 : 0; }
        if (cs.blackout) COL.fill(0);
        const b = brightAt(TL.bright, t); if (b != null && b !== 1) for (let i = 0; i < COL.length; i++) COL[i] *= b;
      }
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
    /** The build toward the next drop: {at, conf, r (0..1 how far along), building}, or null. */
    get ramp() { const r = st.ramp; return r ? { at: r.at, conf: r.conf, r: r.r, building: r.r > 0.02 } : null; },
    /** The look playing (the song's, or the one picked live; provisional: true), or null (variety "show", manual mode). */
    get look() { return lookOn() ? activeLook() : null; },
    /** Forget the look picked live (a new song). */
    resetLook,
    /** "Not this one" for the look picked live: the next best, without `id` (and what settings.lookExclude has). */
    nextLiveLook(id) { if (!st.ll) return null; if (id && !settings.lookExclude.includes(id)) settings.lookExclude = [...settings.lookExclude, id]; st.liveLook = null; st.ll.final = false; st.ll.music = Math.max(st.ll.music, 20); if (st.lastV) liveLook(st.lastV, st.ll.wall); return st.liveLook; },
    flash(t, color) { st.overlay.flashT = t; st.overlay.flashColor = color || [1, 0.97, 0.94]; },
    /** Light up some shapes (indexes) so people can see which is which; null = all. */
    identify(t, shapes) { st.identify = { t, shapes: shapes == null ? null : new Set([].concat(shapes)) }; },
    next(t) { const ST = style(null), pool = ST.pools.drop || ST.pools.peak; st.poolIdx.drop = (st.poolIdx.drop || 0) + 1; st.prev = st.cur; st.cur = pool[st.poolIdx.drop % pool.length]; st.xfadeT = t; st.palIdx++; },
  };
}
