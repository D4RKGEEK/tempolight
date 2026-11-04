// API for DMX fixtures, Ableton Link and MIDI clock, plugged into the core (core.js). No Node.js modules here, so it
// runs in the browser demo too; the Link network code comes in as env.startLink (ableton-link.js) on a PC or Pi.
import { DMX_PROFILES, CHANNEL_TYPES, fixtureProfile, channelCount, normChannel, overlaps } from "../../outputs/src/dmx.js";
import { DMX_DEFAULTS } from "./fixtures.js";

const PATTERNS = ["circle", "figure8", "sweep", "point", "still"];
const now = () => performance.now();

/** route(method, pattern, area, fn) registers an API call (see core.js); changed(what) saves and tells the browsers. */
export function createPro({ store, runtime, env, route, HttpError, changed }) {
  const data = () => store.data;
  const num = (v, lo, hi, name) => { const n = Number(v); if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`); return Math.max(lo, Math.min(hi, n)); };
  const dmxDev = id => { const d = data().devices.find(x => x.id === id); if (!d) throw new HttpError(404, "No such device"); if (d.kind !== "dmx") throw new HttpError(400, `${d.name} is not a DMX device`); if (!Array.isArray(d.fixtures)) d.fixtures = []; return d; };
  const univ = d => d.universe ?? (d.protocol === "e131" ? 1 : 0);

  // ---------------------------------------------------------------- DMX devices and fixtures
  /** POST /api/devices {kind: "dmx", host, name?, protocol?: "artnet"|"e131", universe?}: one universe on a DMX node. */
  function addDmx(b, host) {
    const protocol = b.protocol === "e131" ? "e131" : "artnet", universe = b.universe === undefined || b.universe === "" ? (protocol === "e131" ? 1 : 0) : Math.round(num(b.universe, protocol === "e131" ? 1 : 0, protocol === "e131" ? 63999 : 32767, "Universe"));
    if (data().devices.some(d => d.kind === "dmx" && d.host === host && (d.protocol || "artnet") === protocol && univ(d) === universe)) throw new HttpError(400, `Universe ${universe} on ${host} is already added`);
    const dev = { id: env.newId("d"), name: String(b.name || `DMX ${host} u${universe}`).slice(0, 60), host, kind: "dmx", protocol, universe, fixtures: [], leds: 0, enabled: true };
    data().devices.push(dev); runtime.rebuild(); runtime.checkDevice(dev);
    runtime.note(`Added ${dev.name} (DMX over ${protocol === "e131" ? "sACN" : "Art-Net"}, universe ${universe}). Add its fixtures on the Devices page.`); changed("devices"); return dev;
  }
  const defaultPoint = i => [1.5 + (i % 7) * 2.1, 0.8 + Math.floor(i / 7) % 8 * 1];
  /** The device's "points" shape: one point (an LED for the effects) per fixture, in fixture order. */
  function syncShape(d) {
    const room = data().room, n = d.fixtures.length; let sp = room.shapes.find(s => s.dev === d.id && s.type === "points");
    if (!n) room.shapes = room.shapes.filter(s => s !== sp);
    else { if (!sp) { sp = { type: "points", name: d.name, count: n, dev: d.id, rot: 0, start: 0, rev: false, from: 0, zone: null, pts: [] }; room.shapes.push(sp); }
      while (sp.pts.length < n) sp.pts.push(defaultPoint(sp.pts.length)); sp.pts.length = n; sp.count = n; }
    d.leds = n; return sp;
  }
  function cleanFixture(b, old = null) {
    const f = old ? { ...old } : { id: env.newId("f") };
    if (b.profile !== undefined || !old) { const p = b.profile ?? "rgb"; if (!DMX_PROFILES[p]) throw new HttpError(400, `Profile is one of: ${Object.keys(DMX_PROFILES).join(", ")}`); f.profile = p; }
    if (b.name !== undefined || !old) f.name = String(b.name || DMX_PROFILES[f.profile].name).slice(0, 60);
    if (b.channels !== undefined) { if (!Array.isArray(b.channels) || b.channels.length > 64) throw new HttpError(400, "channels is a list of up to 64 channel types");
      f.channels = b.channels.map(normChannel); const bad = f.channels.find(c => !CHANNEL_TYPES.includes(c.type)); if (bad) throw new HttpError(400, `Unknown channel type "${bad.type}" (one of: ${CHANNEL_TYPES.join(", ")})`); }
    if (f.profile === "custom") { if (!(f.channels || []).length) throw new HttpError(400, "A custom fixture needs its channel list, for example red, green, blue, dimmer"); } else delete f.channels;
    if (b.address !== undefined || !old) f.address = Math.round(Number(b.address ?? 1));
    if (!(f.address >= 1 && f.address <= 512)) throw new HttpError(400, "The DMX address is 1 to 512");
    const n = channelCount(f); if (f.address + n - 1 > 512) throw new HttpError(400, `${f.name} has ${n} channels: starting at ${f.address} it would go past channel 512`);
    if (b.pattern !== undefined) { if (!PATTERNS.includes(b.pattern)) throw new HttpError(400, `Movement is one of: ${PATTERNS.join(", ")}`); f.pattern = b.pattern; }
    if (b.target !== undefined) f.target = b.target ? [num(b.target[0], 0, 16, "Target x"), num(b.target[1], 0, 9, "Target y")] : undefined;
    if (b.home !== undefined) f.home = b.home ? [num(b.home[0], 0, 1, "Home pan"), num(b.home[1], 0, 1, "Home tilt")] : undefined;
    for (const [k, lo, hi] of [["cycle", 1, 64], ["size", 0, 0.5], ["phase", 0, 1], ["panRange", 90, 720], ["tiltRange", 90, 360]]) if (b[k] !== undefined) f[k] = b[k] === null ? undefined : num(b[k], lo, hi, k);
    if (b.wheel !== undefined) f.wheel = Array.isArray(b.wheel) && b.wheel.length ? b.wheel.slice(0, 32).map(w => ({ value: Math.round(num(w.value, 0, 255, "Wheel value")), color: [0, 1, 2].map(i => Math.round(num(w.color?.[i] ?? 0, 0, 255, "Wheel colour"))) })) : undefined;
    for (const k of ["gobos", "patterns"]) if (b[k] !== undefined) f[k] = Array.isArray(b[k]) && b[k].length ? b[k].slice(0, 32).map(v => Math.round(num(v, 0, 255, k))) : undefined;
    if (b.shutter !== undefined) f.shutter = b.shutter ? { open: Math.round(num(b.shutter.open ?? 255, 0, 255, "Shutter open")), closed: Math.round(num(b.shutter.closed ?? 0, 0, 255, "Shutter closed")), strobe: [0, 1].map(i => Math.round(num(b.shutter.strobe?.[i] ?? [64, 95][i], 0, 255, "Shutter strobe"))) } : undefined;
    for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
    return f;
  }
  const warningsFor = d => overlaps(d.fixtures).map(([a, b]) => `${a} and ${b} share DMX channels`);
  const kindNote = f => { const k = fixtureProfile(f).kind; return k === "laser" ? " Lasers only run during drops, and only when lasers are turned on in the DMX settings." : k === "fog" ? " Fog only runs when fog is turned on in the DMX settings." : ""; };

  route("GET", "/api/dmx/profiles", null, () => ({ profiles: Object.entries(DMX_PROFILES).map(([id, p]) => ({ id, name: p.name, kind: p.kind, channels: p.channels })), channelTypes: CHANNEL_TYPES, patterns: PATTERNS }));
  route("GET", "/api/dmx", null, () => {
    const devs = data().devices.filter(d => d.kind === "dmx");
    return { settings: { ...DMX_DEFAULTS, ...(data().settings.dmx || {}) }, status: runtime.fixtures.status(now() / 1000),
      devices: devs.map(d => { const v = runtime.fixtures.frame(d.id), fx = d.fixtures || [];
        return { id: d.id, name: d.name, host: d.host, protocol: d.protocol || "artnet", universe: univ(d), enabled: d.enabled, values: v ? Array.from(v) : new Array(512).fill(0), warnings: warningsFor({ fixtures: fx }),
          fixtures: fx.map(f => { const p = fixtureProfile(f); return { ...f, kind: p.kind, live: p.channels.map((c, i) => ({ n: f.address + i, type: c.type, value: v ? v[f.address - 1 + i] ?? 0 : 0 })) }; }) }; }) };
  });
  route("POST", "/api/devices/:id/fixtures", "admin", async (ctx, p) => {
    const d = dmxDev(p.id), b = ctx.body, f = cleanFixture(b); if (d.fixtures.length >= 128) throw new HttpError(400, "At most 128 fixtures per universe");
    d.fixtures.push(f); const sp = syncShape(d); if (b.x !== undefined && b.y !== undefined) sp.pts[d.fixtures.length - 1] = [num(b.x, 0, 16, "x"), num(b.y, 0, 9, "y")];
    runtime.rebuild(); runtime.note(`Added ${f.name} to ${d.name} at DMX ${f.address}.${kindNote(f)}`); changed("devices"); changed("room");
    return { fixture: f, warnings: warningsFor(d) };
  });
  route("PATCH", "/api/devices/:id/fixtures/:fid", "admin", async (ctx, p) => {
    const d = dmxDev(p.id), i = d.fixtures.findIndex(f => f.id === p.fid); if (i < 0) throw new HttpError(404, "No such fixture");
    const b = ctx.body; d.fixtures[i] = cleanFixture(b, d.fixtures[i]); const sp = syncShape(d);
    if (b.x !== undefined && b.y !== undefined) sp.pts[i] = [num(b.x, 0, 16, "x"), num(b.y, 0, 9, "y")];
    runtime.rebuild(); changed("devices"); changed("room"); return { fixture: d.fixtures[i], warnings: warningsFor(d) };
  });
  route("DELETE", "/api/devices/:id/fixtures/:fid", "admin", async (ctx, p) => {
    const d = dmxDev(p.id), i = d.fixtures.findIndex(f => f.id === p.fid); if (i < 0) throw new HttpError(404, "No such fixture");
    const [f] = d.fixtures.splice(i, 1), sp = data().room.shapes.find(s => s.dev === d.id && s.type === "points"); if (sp) sp.pts.splice(i, 1);
    syncShape(d); runtime.rebuild(); runtime.note(`Removed ${f.name} from ${d.name}`); changed("devices"); changed("room"); return { ok: true };
  });

  // ---------------------------------------------------------------- Ableton Link
  let link = null;
  function restartLink() {
    if (link) { link.close(); link = null; } runtime.beats.setLink(null);
    const o = data().settings.link; if (!o || !o.enabled || !env.startLink) return;
    let told = null;
    link = env.startLink({ port: o.port || 20808, onState: st => { runtime.beats.setLink(st); if (st.error && st.error !== told) { told = st.error; runtime.note(`Ableton Link: ${st.error}`, "warn"); } }, onError: m => runtime.note(`Ableton Link can't listen: ${m}`, "warn") });
    runtime.note(`Ableton Link: following a Link session on this network (listening only, UDP ${o.port || 20808})`);
  }

  /** PATCH /api/settings: {dmx: {...}} and {link: {enabled, port}}. */
  function applySettings(b) {
    const s = data().settings;
    if (b.dmx) { const x = b.dmx, d = s.dmx = { ...DMX_DEFAULTS, ...(s.dmx || {}) }, was = { lasers: d.lasers, fog: d.fog };
      for (const k of ["enabled", "lasers", "fog"]) if (x[k] !== undefined) d[k] = x[k] === true;
      if (x.fogWhen !== undefined) { if (!["before", "drop"].includes(x.fogWhen)) throw new HttpError(400, "fogWhen is before or drop"); d.fogWhen = x.fogWhen; }
      for (const [k, lo, hi] of [["fogLead", 0.5, 30], ["fogBurst", 0.5, 10], ["fogCooldown", 10, 900], ["fogMaxDuty", 0.01, 0.5], ["fogLevel", 0.1, 1], ["laserMaxSec", 5, 300]]) if (x[k] !== undefined) d[k] = num(x[k], lo, hi, k);
      if (d.lasers && !was.lasers) runtime.note("DMX lasers are on: they run only during drops, never in photosensitive-safe mode or night mode. Use only lasers made for audiences, aimed above head height.", "warn");
      if (d.fog && !was.fog) runtime.note(`DMX fog is on: a ${d.fogBurst} s burst ${d.fogWhen === "before" ? `${d.fogLead} s before` : "at"} drops, at most every ${d.fogCooldown} s and ${Math.round(d.fogMaxDuty * 100)}% of the time. Check smoke detectors and ventilation.`, "warn");
    }
    if (b.link) { const o = s.link = { enabled: false, port: 20808, ...(s.link || {}) }, before = JSON.stringify(o);
      if (b.link.enabled !== undefined) o.enabled = b.link.enabled === true;
      if (b.link.port !== undefined) o.port = Math.round(num(b.link.port, 1024, 65535, "Link port"));
      if (JSON.stringify(o) !== before) restartLink(); }
  }

  // ---------------------------------------------------------------- MIDI clock from a browser
  /** WebSocket {type: "midi-clock", events: [[code, at, value?]], now, label}; c is the browser's connection. */
  function wsMessage(m, c) {
    if (m.type !== "midi-clock") return false;
    if (!c.data.auth("pads")) return true;
    const before = runtime.beats.midi.owner;
    if (runtime.beats.midiMessage(m, c.data.id, now()) && before !== c.data.id) runtime.note(`Following MIDI clock from ${runtime.beats.midi.label}`);
    if (m.end) runtime.beats.midiStop(c.data.id);
    return true;
  }
  restartLink();
  return { addDmx, applySettings, wsMessage, restartLink, clientClosed: id => runtime.beats.midiStop(id), close() { if (link) link.close(); link = null; } };
}
