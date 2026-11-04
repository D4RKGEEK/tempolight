// Smart lights on the server: adding LIFX, WiZ, Kasa, Yeelight and Twinkly lights (the table is in
// packages/outputs/src/lights.js), placing them in the room, their options, finding them on the network, and Philips
// Hue's fast mode (Entertainment streaming, hue-entertainment.js). Nothing here touches the network itself: that
// comes in through env (env.lights, env.discoverLights, env.huePairKey, env.hueAreas), so the online demo, which has
// none of them, just says these need Tempolight running on your network.

export const LIGHT_KIND_NAMES = ["lifx", "wiz", "kasa", "yeelight", "twinkly"];
const HINTS = { lifx: " Is LAN control on in the LIFX app?", wiz: " Is “Allow local communication” on in the WiZ app?", yeelight: " Turn on “LAN Control” for the light in the Yeelight app.",
  kasa: " Tapo lights aren't supported (they need a TP-Link account login).", twinkly: "" };

/** Fit points (x, y, y up) into a box centred on (cx, cy) about `size` wide, y flipped for the wall view. */
export function fitPoints(points, cx = 8, cy = 4.5, size = 5) {
  if (!points.length) return [];
  const xs = points.map(p => p.x), ys = points.map(p => p.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), k = size / Math.max(1e-6, x1 - x0, y1 - y0);
  return points.map(p => [Math.round((cx + (p.x - (x0 + x1) / 2) * k) * 1000) / 1000, Math.round((cy - (p.y - (y0 + y1) / 2) * k) * 1000) / 1000]);
}

export function createLights({ store, runtime, env, HttpError, changed }) {
  const data = () => store.data, K = env.lights || null;
  const label = kind => K?.[kind]?.label || kind;
  /** a shape for a new light: bulbs are single points in a row along the top, strips a line, mapped lights their real layout */
  function place(dev, layout) {
    const shapes = data().room.shapes, k = shapes.length, base = { name: dev.name, dev: dev.id, rot: 0, start: 0, rev: false, from: null };
    if (layout && layout.points) { const pts = fitPoints(layout.points, 8 + ((k % 3) - 1) * 4.5, 4.5, 4); shapes.push({ type: "points", ...base, count: pts.length, pts }); return; }
    if (layout === "point") { const n = shapes.filter(s => s.type === "points" && s.count === 1).length; // spread out, so they don't sit on top of each other
      shapes.push({ type: "points", ...base, count: 1, pts: [[Math.round((1.5 + (n % 8) * 1.85) * 100) / 100, Math.round((0.8 + Math.floor(n / 8) % 6 * 1.3) * 100) / 100]] }); return; }
    const y = 1 + (k % 7) * 1.1; shapes.push({ type: "line", ...base, count: dev.leds || 1, pts: [[1.5, y], [14.5, y]] });
  }
  async function add(kind, b, host) {
    if (!K?.[kind]) throw new HttpError(400, `${label(kind)} lights need Tempolight running on your network`);
    const dup = data().devices.find(d => d.kind === kind && d.host === host); if (dup) return dup;
    let p; try { p = await K[kind].probe(host); }
    catch (e) { if (!b.force) throw new HttpError(400, `Couldn't reach a ${label(kind)} light at ${host} (${e.message}).${HINTS[kind] || ""}`); p = { name: "", leds: 1, light: {}, layout: "point" }; }
    const dev = { id: env.newId("d"), name: String(b.name || p.name || `${label(kind)} light`).slice(0, 60), host, kind, light: p.light || {}, leds: Math.max(1, Math.min(8192, Number(p.leds) || 1)), ddpPort: K[kind].port, enabled: true };
    data().devices.push(dev); place(dev, p.layout);
    runtime.rebuild(); runtime.checkDevice(dev); runtime.note(`Added ${dev.name} (${label(kind)}, ${dev.leds} ${dev.leds === 1 ? "light" : "LEDs"})`); changed("devices"); return dev;
  }
  /** PATCH {light: {...}}: the kind's own options; {hueFast, hueArea}: Hue's fast mode */
  async function patch(d, b) {
    if (b.light !== undefined) {
      const k = K?.[d.kind]; if (!k) throw new HttpError(400, "This device has no light options");
      if (!b.light || typeof b.light !== "object" || !k.options) throw new HttpError(400, `${label(d.kind)} has no options to change`);
      let o; try { o = k.options(d, b.light); } catch (e) { throw new HttpError(400, e.message); }
      const { leds, ...rest } = o; d.light = { ...(d.light || {}), ...rest };
      if (rest.perZone === false) d.leds = 1;
      if (leds || rest.perZone === false) { if (leds) d.leds = leds; for (const s of data().room.shapes) if (s.dev === d.id && s.type !== "points") s.count = d.leds; }
    }
    if (b.hueFast !== undefined || b.hueArea !== undefined) await hueFast(d, b);
  }
  async function hueFast(d, b) {
    if (d.kind !== "hue") throw new HttpError(400, "Fast mode is for Hue bridges");
    if (b.hueFast === false) { if (d.hue.ent) d.hue.ent = { ...d.hue.ent, on: false }; runtime.note(`${d.name}: basic mode`); return; }
    if (!env.hueAreas || !env.huePairKey) throw new HttpError(400, "Fast mode needs Tempolight running on your network");
    if (b.clipPort !== undefined) d.hue.clipPort = Math.round(Number(b.clipPort)) || undefined; // a bridge behind port forwarding (and tests)
    if (b.streamPort !== undefined) d.hue.streamPort = Math.round(Number(b.streamPort)) || undefined;
    if (!d.hue.clientkey) { // paired before fast mode existed: pair again, asking for the streaming key
      let k; try { k = await env.huePairKey(d.host); } catch (e) { throw new HttpError(400, e.code === "pair" ? "Fast mode needs Tempolight to pair with the bridge again: press the round link button on the Hue bridge, then turn on fast mode within 30 seconds." : `Couldn't reach the Hue bridge (${e.message})`); }
      if (!k.clientkey) throw new HttpError(400, "This Hue bridge didn't give a streaming key: update its software in the Hue app (Entertainment needs a bridge v2)");
      d.hue.user = k.user; d.hue.clientkey = k.clientkey; store.save();
    }
    let areas; try { areas = await env.hueAreas(d.host, d.hue.user, { clipPort: d.hue.clipPort }); } catch (e) { throw new HttpError(400, `Couldn't read the bridge's entertainment areas (${e.message})`); }
    d.hue.areas = areas.map(a => ({ id: a.id, name: a.name }));
    if (!areas.length) throw new HttpError(400, "This bridge has no entertainment area yet: make one in the Hue app (Settings, Entertainment areas), then try again");
    const a = b.hueArea ? areas.find(x => x.id === b.hueArea) : areas[0]; if (!a) throw new HttpError(400, "No such entertainment area on this bridge");
    const lights = d.hue.lights || [], n = Math.max(1, lights.length);
    d.hue.ent = { on: true, id: a.id, name: a.name, channels: a.channels.map((c, i) => ({ id: c.id, led: lights.indexOf(c.light) >= 0 ? lights.indexOf(c.light) : i % n })) };
    const out = lights.filter((l, i) => !d.hue.ent.channels.some(c => c.led === i));
    runtime.note(`${d.name}: fast mode with “${a.name}” (${a.channels.length} channel${a.channels.length === 1 ? "" : "s"})${out.length ? `; ${out.length} light${out.length === 1 ? " isn't" : "s aren't"} in that area and stay as they are` : ""}`);
  }
  async function discover(timeoutMs = 2500) {
    if (!env.discoverLights) return [];
    const found = await env.discoverLights({ timeoutMs }).catch(() => []), known = new Set(data().devices.map(d => `${d.kind}|${env.ipOf(d.host)}`));
    return found.map(f => ({ ...f, ip: env.ipOf(f.host), leds: f.leds ?? f.zones ?? 1, added: known.has(`${f.kind}|${env.ipOf(f.host)}`) }));
  }
  return { kinds: K ? Object.keys(K) : LIGHT_KIND_NAMES, add, patch, discover };
}
