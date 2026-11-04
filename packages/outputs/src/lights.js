// The smart-light kinds that work the same way: add by address (or from a scan), a sender per device, a health
// check. The server (packages/server/src/lights.js) and the runtime use this table, so a new kind is one entry here.
// Each entry:
//   label, port (the default), frameMs (how often the light updates, for the latency meter)
//   probe(host)        -> {name, leds, light, layout?: "point"|"line"|{points}} what to store on the device (`light`)
//   sender(dev, o)     -> {send(rgb), power(on), close(), sent}
//   check(dev)         -> {version, leds} for the health check (throws when the light doesn't answer)
//   discover({timeoutMs}) -> [{host, name, leds?, ...}]
//   options(dev, body) -> changes to dev.light from PATCH /api/devices/:id {light: {...}} (throws Error with a message)
import { LifxSender, lifxInfo, discoverLifx, LIFX_PORT } from "./lifx.js";
import { WizSender, wizInfo, discoverWiz, WIZ_PORT } from "./wiz.js";
import { KasaSender, kasaInfo, discoverKasa, KASA_PORT } from "./kasa.js";
import { YeelightSender, yeelightInfo, discoverYeelight, YEELIGHT_PORT } from "./yeelight.js";
import { TwinklySender, twinklyInfo, twinklyLogin, twinklyLayout, discoverTwinkly, TWINKLY_PORT } from "./twinkly.js";

const bool = (v, what) => { if (typeof v !== "boolean") throw new Error(`${what} is true or false`); return v; };

export const LIGHT_KINDS = {
  lifx: {
    label: "LIFX", port: LIFX_PORT, frameMs: 50,
    async probe(host) { const i = await lifxInfo(host);
      return { name: i.name, leds: i.extended ? i.zones : 1, light: { mac: i.mac, product: i.product, zones: i.zones, extended: i.extended }, layout: i.extended && i.zones > 1 ? "line" : "point" }; },
    sender: d => new LifxSender(d.host, { mac: d.light?.mac, zones: d.light?.zones, extended: d.light?.extended }),
    async check(d) { const i = await lifxInfo(d.host); return { version: `LIFX${i.product ? ` #${i.product}` : ""}${i.extended ? `, ${i.zones} zones` : ""}`, leds: i.extended ? i.zones : 1 }; },
    discover: o => discoverLifx(o),
  },
  wiz: {
    label: "WiZ", port: WIZ_PORT, frameMs: 100,
    async probe(host) { const i = await wizInfo(host); return { name: i.name, leds: 1, light: { mac: i.mac, module: i.module }, layout: "point" }; },
    sender: d => new WizSender(d.host),
    async check(d) { const i = await wizInfo(d.host); return { version: `WiZ ${i.module} ${i.version}`.trim(), leds: 1 }; },
    discover: o => discoverWiz(o),
  },
  kasa: {
    label: "TP-Link Kasa", port: KASA_PORT, frameMs: 100,
    async probe(host) { const i = await kasaInfo(host);
      return { name: i.name, leds: 1, light: { model: i.model, mac: i.mac, strip: i.strip, zones: i.zones, color: i.color, perZone: false }, layout: i.strip ? "line" : "point" }; },
    sender: d => new KasaSender(d.host, { strip: d.light?.strip, zones: d.light?.zones, perZone: d.light?.perZone, color: d.light?.color }),
    async check(d) { const i = await kasaInfo(d.host); return { version: `Kasa ${i.model} ${i.version}`.trim(), leds: d.light?.perZone ? i.zones : 1 }; },
    discover: o => discoverKasa(o),
    options(d, b) { const o = {}; if (b.perZone !== undefined) { if (!d.light?.strip) throw new Error("Only Kasa light strips have zones"); o.perZone = bool(b.perZone, "perZone"); if (o.perZone) o.leds = d.light.zones; } return o; },
  },
  yeelight: {
    label: "Yeelight", port: YEELIGHT_PORT, frameMs: 50,
    async probe(host) { const i = await yeelightInfo(host); return { name: i.name || "Yeelight", leds: 1, light: { music: true }, layout: "point" }; },
    sender: d => new YeelightSender(d.host, { music: d.light?.music !== false }),
    async check(d) { const i = await yeelightInfo(d.host); return { version: `Yeelight${i.music ? " (music mode)" : ""}`, leds: 1 }; },
    discover: o => discoverYeelight(o),
    options(d, b) { return b.music !== undefined ? { music: bool(b.music, "music") } : {}; },
  },
  twinkly: {
    label: "Twinkly", port: TWINKLY_PORT, frameMs: 40,
    async probe(host) {
      const i = await twinklyInfo(host); let layout = "line";
      try { const { token } = await twinklyLogin(host), l = await twinklyLayout(host, token); if (l.source !== "linear" && l.points.length === i.leds) layout = { points: l.points }; } catch {} // no mapping: a line
      return { name: i.name, leds: i.leds, light: { rgbw: i.rgbw, protocol: i.protocol, product: i.product }, layout };
    },
    sender: d => new TwinklySender(d.host, { leds: d.leds, rgbw: d.light?.rgbw, protocol: d.light?.protocol, rtPort: d.light?.rtPort }),
    async check(d) { const i = await twinklyInfo(d.host); return { version: `Twinkly ${i.product} ${i.version}`.trim(), leds: i.leds }; },
    discover: o => discoverTwinkly(o),
    options(d, b) { const o = {}; if (b.rtPort !== undefined) { const p = Math.round(Number(b.rtPort)); if (!(p > 0 && p < 65536)) throw new Error("rtPort is a UDP port"); o.rtPort = p; } return o; },
  },
};

/** Look for every kind at once; each found light has its `kind`. */
export async function discoverLights({ timeoutMs = 2000, kinds = Object.keys(LIGHT_KINDS) } = {}) {
  const all = await Promise.all(kinds.map(k => LIGHT_KINDS[k].discover({ timeoutMs }).then(l => l.map(x => ({ ...x, kind: k })), () => [])));
  return all.flat();
}
