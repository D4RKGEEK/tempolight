// DMX fixtures following the music. No Node.js modules here (it runs in the browser demo too).
//
// Every fixture is one point in the room (a "points" shape of its device), so the effects colour it like an LED.
// What each kind does with that colour and with the music:
//   par, dimmer   the colour (or its brightness) of its point in the room
//   moving head   moves on the beat (circle, figure-8, sweep, or points at a place in the room), takes its colour from
//                 its point, gets brighter on drops, changes gobo during drops
//   strobe        only on the strobe pad and the first two seconds of a drop; never in photosensitive-safe or night mode
//   laser         only during a drop (the first `laserMaxSec` seconds of it); never in safe or night mode; off by default
//   fog           a burst `fogLead` seconds before a drop the song analysis knows about (or at the drop, for live
//                 audio), with a cool-down between bursts and a maximum duty cycle; off by default; a manual pad
// The runtime calls begin() once a frame, then render() for each DMX device.
import { buildSignals } from "../../engine/src/signals.js";
import { fixtureProfile, writeFixture, DMX_CHANNELS } from "../../outputs/src/dmx.js";

export const DMX_DEFAULTS = { enabled: true, lasers: false, fog: false, fogWhen: "before", fogLead: 4, fogBurst: 3, fogCooldown: 60, fogMaxDuty: 0.1, fogLevel: 1, laserMaxSec: 60 };
export const FOG_WINDOW = 300; // seconds: the duty cycle is measured over the last 5 minutes
export const FOG_MANUAL_MAX = 10; // seconds the manual fog pad can be held
const TAU = Math.PI * 2;

/**
 * Pan and tilt (0-1 of the fixture's range, 0.5 = straight ahead) to point a head hanging at `from` at `to`, both on
 * the room's 16 x 9 wall view. An approximation: the beam is assumed to travel `depth` units into the room.
 */
export function aim(from, to, panRange = 540, tiltRange = 270, depth = 4) {
  const pan = Math.atan2(to[0] - from[0], depth) * 180 / Math.PI, tilt = Math.atan2(to[1] - from[1], depth) * 180 / Math.PI;
  return [0.5 + pan / panRange, 0.5 + tilt / tiltRange];
}

export function createFixtures() {
  const frames = new Map(), mem = new Map(); // device id -> last universe; fixture id -> {r, g, b, pan, tilt}
  let F = { cfg: null };
  const fog = { burst: null, manual: null, history: [], fired: [], lastEnd: -1e9, out: 0, why: "Fog is off in the DMX settings" };

  // ---------------------------------------------------------------- fog
  const used = wall => fog.history.reduce((n, h) => n + Math.max(0, h.end - Math.max(h.start, wall - FOG_WINDOW)), 0); // seconds of fog in the window (a burst running counts in full)
  function stopFog(wall) { for (const k of ["burst", "manual"]) if (fog[k]) { fog[k].end = Math.min(fog[k].end, wall); fog.lastEnd = fog[k].end; fog[k] = null; } }
  function startBurst(wall, len, cfg, kind) {
    if (fog.burst || fog.manual) return "busy";
    if (kind === "auto" && wall - fog.lastEnd < cfg.fogCooldown) return "cooldown";
    const n = Math.min(len, cfg.fogMaxDuty * FOG_WINDOW - used(wall)); if (n < 0.5) return "duty";
    const b = { start: wall, end: wall + n, kind }; fog.history.push(b); fog[kind === "manual" ? "manual" : "burst"] = b; return "ok";
  }
  function fogTick(wall, cfg, S, V, live) {
    fog.history = fog.history.filter(h => h.end > wall - FOG_WINDOW); fog.fired = fog.fired.filter(f => wall - f.wall < 120);
    for (const k of ["burst", "manual"]) if (fog[k] && wall >= fog[k].end) { fog.lastEnd = fog[k].end; fog[k] = null; }
    if (!(live && cfg.fog)) { stopFog(wall); fog.out = 0; fog.why = !cfg.enabled ? "DMX output is off" : !cfg.fog ? "Fog is off in the DMX settings" : "Lights are off"; return; }
    if (S && V) { // which drop: one the analysis knows is coming (before mode), else the one that just started
      const before = cfg.fogWhen === "before" && S.dropIn < 99 && S.dropIn <= cfg.fogLead, at = S.sinceDrop < 0.75;
      const dropAt = before ? V.nextDrop : at ? V.dropT : null;
      if (dropAt != null && !fog.fired.some(f => Math.abs(f.t - dropAt) < 1.5)) { fog.fired.push({ t: dropAt, wall }); fog.blocked = startBurst(wall, cfg.fogBurst, cfg, "auto"); }
    }
    fog.out = fog.burst || fog.manual ? cfg.fogLevel : 0;
    fog.why = fog.manual ? "Manual" : fog.burst ? "Burst for the drop" : wall - fog.lastEnd < cfg.fogCooldown ? `Cooling down (${Math.ceil(cfg.fogCooldown - (wall - fog.lastEnd))} s)`
      : used(wall) >= cfg.fogMaxDuty * FOG_WINDOW - 0.5 ? "At the duty-cycle limit" : "Waiting for a drop";
  }

  /**
   * Once a frame, before render(). V: the music view (or null), t its clock; wall: a steady clock in seconds;
   * cfg: settings.dmx; safe/night: photosensitive-safe and night mode; power; overlay: the director's pads
   * (blackout, strobe); bri: the brightness the LEDs got (moving heads and strobes use it for their dimmer).
   */
  function begin({ V = null, t = 0, wall = 0, cfg: c0 = {}, safe = false, night = false, power = true, overlay = {}, bri = 1 } = {}) {
    const cfg = { ...DMX_DEFAULTS, ...(c0 || {}) }, S = V ? buildSignals(V, t, { pal: [[1, 1, 1]] }) : null, live = !!(cfg.enabled && power);
    const laserWhy = !cfg.enabled ? "DMX output is off" : !cfg.lasers ? "Lasers are off in the DMX settings" : safe ? "Photosensitive-safe mode is on" : night ? "Night mode"
      : !power ? "Lights are off" : overlay.blackout ? "Blackout" : !(V && V.state === "drop" && S.sinceDrop < cfg.laserMaxSec) ? "Waiting for a drop" : null;
    const strobeOK = live && !overlay.blackout && !safe && !night;
    const strobe = strobeOK ? (overlay.strobe ? 0.85 : V && V.state === "drop" && S.sinceDrop < 2 ? 0.6 : 0) : 0;
    fogTick(wall, cfg, S, V, live);
    F = { cfg, S, V, t, wall, live, power, dark: !live || !!overlay.blackout, lasers: !laserWhy, laserWhy, strobe, strobePad: strobeOK && !!overlay.strobe, bri };
  }

  function headState(f, prof, hi, nh, r, g, b, pt) {
    const { S, V, live, dark } = F; let m = mem.get(f.id); if (!m) mem.set(f.id, m = { r: 255, g: 255, b: 255, pan: 0.5, tilt: 0.5 });
    if (Math.max(r, g, b) > 12) { m.r = r; m.g = g; m.b = b; } // keep the last colour through dark moments: the dimmer does the dark
    if (!live) return { r: m.r, g: m.g, b: m.b, dimmer: 0, shutter: "closed", pan: m.pan, tilt: m.tilt, gobo: 0 }; // off: hold position, beam closed
    // one cycle every `cycle` beats, stepping on each beat: fast at the start of the beat, settling before the next
    const cyc = Math.max(1, f.cycle || 8), p = (S ? (S.g.idx + 1 - (1 - S.g.phase) ** 3) / cyc : F.wall / 20) + (f.phase ?? (nh > 1 ? hi / nh : 0));
    const A = f.size ?? 0.15, home = Array.isArray(f.home) ? f.home : [0.5, 0.5];
    let pan = home[0], tilt = home[1];
    switch (f.pattern || "circle") {
      case "circle": pan += A * Math.cos(TAU * p); tilt += A * Math.sin(TAU * p); break;
      case "figure8": pan += A * Math.sin(TAU * p); tilt += A / 2 * Math.sin(2 * TAU * p); break;
      case "sweep": { const x = ((p % 1) + 1) % 1; pan += A * (x < 0.5 ? 4 * x - 1 : 3 - 4 * x); break; }
      case "point": { const a = Array.isArray(f.target) && pt ? aim(pt, f.target, prof.panRange, prof.tiltRange) : home; pan = a[0]; tilt = a[1] + (S ? 0.01 * Math.min(1, S.pulse) : 0); break; }
      default: break; // "still": stays at home
    }
    m.pan = pan; m.tilt = tilt;
    let dim = 0;
    if (!dark) {
      if (S) { dim = 0.3 + 0.45 * (S.loud || 0) + 0.25 * Math.min(1, S.pulse); if (V.state === "drop") dim = Math.max(dim, 0.85); if (S.sinceDrop < 8) dim = Math.max(dim, 1 - S.sinceDrop / 16); dim = Math.min(1, dim) * F.bri; }
      else dim = Math.max(r, g, b) / 255; // nothing playing: as bright as its point
    }
    return { r: m.r, g: m.g, b: m.b, dimmer: dim, pan, tilt, gobo: S && V.state === "drop" ? 1 + Math.floor(S.g.idx / 8) % Math.max(1, prof.gobos.length - 1) : 0,
      shutter: dim <= 0.004 ? "closed" : F.strobePad ? "strobe" : "open", strobe: F.strobePad ? 0.7 : 0 };
  }
  function stateOf(f, prof, hi, nh, r, g, b, pt) {
    switch (prof.kind) {
      case "head": return headState(f, prof, hi, nh, r, g, b, pt);
      case "strobe": return F.strobe > 0 ? { dimmer: F.bri, strobe: F.strobe, shutter: "strobe" } : { dimmer: 0, strobe: 0, shutter: "closed" };
      case "laser": return { laser: F.lasers, pattern: F.lasers && F.S ? Math.floor(F.S.g.idx / 4) : 0 };
      case "fog": return { fog: F.live ? fog.out : 0 };
      default: { const d = Math.max(r, g, b) / 255; return { r, g, b, dimmer: d, shutter: d > 0 ? "open" : "closed" }; } // par, dimmer
    }
  }

  /** The universe for a DMX device. rgb: its LEDs (one per fixture, in fixture order); pts: the fixtures' places in the room. */
  function render(d, rgb, pts = []) {
    let out = frames.get(d.id); if (!out) frames.set(d.id, out = new Uint8Array(DMX_CHANNELS)); out.fill(0);
    if (!F.cfg || !F.cfg.enabled) return out; // master off: everything at zero
    const list = d.fixtures || [], profs = list.map(fixtureProfile), heads = list.filter((f, i) => profs[i].kind === "head");
    list.forEach((f, i) => writeFixture(out, f, stateOf(f, profs[i], heads.indexOf(f), heads.length, rgb[i * 3] || 0, rgb[i * 3 + 1] || 0, rgb[i * 3 + 2] || 0, pts[i]), profs[i]));
    return out;
  }

  /** The manual fog pad: on starts fog (up to FOG_MANUAL_MAX seconds, within the duty cycle), off stops it. */
  // settings: the current DMX settings (a change made a moment ago may not have reached a frame yet)
  function manualFog(on, wall, settings = null) {
    const cfg = settings ? { ...DMX_DEFAULTS, ...settings } : F.cfg || DMX_DEFAULTS;
    if (settings && F.cfg) { F.cfg = cfg; F.live = !!(cfg.enabled && F.power !== false); }
    if (!on) { if (fog.manual) { fog.manual.end = Math.min(fog.manual.end, wall); fog.lastEnd = fog.manual.end; fog.manual = null; } return { ok: true }; }
    if (!(F.live && cfg.fog)) return { ok: false, why: !cfg.fog ? "Fog is off in the DMX settings" : "DMX output or the lights are off" };
    if (fog.manual) return { ok: true };
    const r = startBurst(wall, FOG_MANUAL_MAX, cfg, "manual");
    return r === "ok" || r === "busy" ? { ok: true } : { ok: false, why: "Fog is at its duty-cycle limit; wait a little" };
  }

  return {
    begin, render, manualFog, frame: id => frames.get(id) || null, forget(id) { frames.delete(id); },
    status(wall = F.wall || 0) { const cfg = F.cfg || DMX_DEFAULTS;
      return { lasers: { on: !!F.lasers, why: F.laserWhy || null }, fog: { on: fog.out > 0, why: fog.why, duty: Math.round(used(wall) / FOG_WINDOW * 1000) / 1000, maxDuty: cfg.fogMaxDuty,
        cooldownLeft: Math.max(0, Math.round(cfg.fogCooldown - (wall - fog.lastEnd))) } }; },
  };
}
