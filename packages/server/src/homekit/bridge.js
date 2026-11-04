// What Tempolight looks like in Apple's Home app: a bridge with
//   "Tempolight"       a Lightbulb: On (power), Brightness, Hue and Saturation (picking a colour holds that colour,
//                      see runtime.action "hold"; turning Music reactive on lets the music choose colours again)
//   "Music reactive"   a Switch: on = automatic mode (effects follow the music), off = keep the current effect
//   one Switch per scene ("Party mode", "Chill mode", …): on applies the scene and reads on while the show still
//                      matches it; turning the active scene's switch off turns the lights off
// so "Hey Siri, turn on Party mode" works. Accessory ids (aid) of scenes are remembered, so renaming or adding scenes
// keeps the rooms and automations people made in the Home app.

// short forms of Apple's UUIDs (0000XXXX-0000-1000-8000-0026BB765291)
export const S = { AccessoryInformation: "3E", ProtocolInformation: "A2", Lightbulb: "43", Switch: "49" };
export const C = { Identify: "14", Manufacturer: "20", Model: "21", Name: "23", SerialNumber: "30", FirmwareRevision: "52", Version: "37",
  On: "25", Brightness: "8", Hue: "13", Saturation: "2F" };

/** HomeKit names: letters, digits, spaces and apostrophes, starting and ending with a letter or digit. */
export function hkName(s, fallback = "Tempolight") {
  const n = String(s || "").normalize("NFC").replace(/[^\p{L}\p{N} ']/gu, " ").replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").slice(0, 64).trim();
  return n || fallback;
}
const str = (iid, type, value) => ({ iid, type, perms: ["pr"], format: "string", value });
function info(name, serial, version, model, identify) {
  return { iid: 1, type: S.AccessoryInformation, characteristics: [
    { iid: 2, type: C.Identify, perms: ["pw"], format: "bool", set: identify },
    str(3, C.Manufacturer, "Tempolight"), str(4, C.Model, model), str(5, C.Name, name), str(6, C.SerialNumber, serial),
    str(7, C.FirmwareRevision, /^\d+\.\d+\.\d+$/.test(version) ? version : "1.0.0")] };
}
const onChar = (get, set) => ({ iid: 9, type: C.On, perms: ["pr", "pw", "ev"], format: "bool", get, set });
const sw = (aid, name, serial, version, identify, get, set) => ({ aid, services: [info(name, serial, version, "Tempolight switch", identify),
  { iid: 8, type: S.Switch, primary: true, characteristics: [onChar(get, set), str(10, C.Name, name)] }] });

/** HSV (h 0-360, s 0-100, full value) as #rrggbb. */
export function hsvHex(h, s) {
  const f = n => { const k = (n + h / 60) % 6, v = 1 - (s / 100) * Math.max(0, Math.min(k, 4 - k, 1)); return Math.round(v * 255).toString(16).padStart(2, "0"); };
  return "#" + f(5) + f(3) + f(1);
}

/** Does the show still look like this scene? */
export function sceneActive(sc, data) {
  if (!data.show.power) return false;
  for (const [k, v] of Object.entries(sc.show || {})) if (JSON.stringify(data.show[k]) !== JSON.stringify(v)) return false;
  return sc.brightness == null || Math.abs(data.settings.brightness - Number(sc.brightness)) < 0.006;
}

/**
 * The accessory database for the HAP server. t: {data(), version, deviceId, aidOf(sceneId), applyScene(sc), setPower(on),
 * setBrightness(0-1), setAuto(on), hold(hex|null), identify(), held()}
 */
export function bridgeAccessories(t) {
  const d = t.data(), serial = t.deviceId.replace(/:/g, ""), v = t.version, hs = t.hs;
  let pending = null; // hue and saturation come in one write: apply the colour once
  const colour = () => { if (pending) return; pending = setTimeout(() => { pending = null; t.hold(hsvHex(hs.h, hs.s)); }, 0); };
  const list = [
    { aid: 1, services: [info("Tempolight", serial, v, "Tempolight bridge", t.identify), { iid: 8, type: S.ProtocolInformation, characteristics: [str(9, C.Version, "1.1.0")] }] },
    { aid: 2, services: [info("Tempolight", serial + "-L", v, "Music-reactive lights", t.identify), { iid: 8, type: S.Lightbulb, primary: true, characteristics: [
      onChar(() => !!t.data().show.power, on => t.setPower(on)),
      { iid: 10, type: C.Brightness, perms: ["pr", "pw", "ev"], format: "int", unit: "percentage", minValue: 0, maxValue: 100, minStep: 1,
        get: () => Math.round(t.data().settings.brightness * 100), set: b => t.setBrightness(b / 100) },
      { iid: 11, type: C.Hue, perms: ["pr", "pw", "ev"], format: "float", unit: "arcdegrees", minValue: 0, maxValue: 360, minStep: 1, get: () => hs.h, set: h => { hs.h = h; colour(); } },
      { iid: 12, type: C.Saturation, perms: ["pr", "pw", "ev"], format: "float", unit: "percentage", minValue: 0, maxValue: 100, minStep: 1, get: () => hs.s, set: s => { hs.s = s; colour(); } },
      str(13, C.Name, "Tempolight")] }] },
    sw(3, "Music reactive", serial + "-A", v, t.identify, () => t.data().show.mode === "auto" && !t.held(), on => t.setAuto(on)),
  ];
  for (const sc of d.scenes) {
    const name = hkName(sc.name, "Scene");
    list.push(sw(t.aidOf(sc.id), name, `${serial}-${t.aidOf(sc.id)}`, v, t.identify, () => { const x = t.data(), s = x.scenes.find(y => y.id === sc.id); return !!s && sceneActive(s, x); },
      on => { const x = t.data(), s = x.scenes.find(y => y.id === sc.id); if (!s) return; if (on) t.applyScene(s); else if (sceneActive(s, x)) return t.setPower(false); }));
  }
  return list;
}

/** What changes the accessories' structure (and so the config number c#): ids and names, not values. */
export const structureKey = list => JSON.stringify(list.map(a => [a.aid, a.services.map(s => [s.iid, s.type, s.characteristics.map(c => [c.iid, c.type, c.get ? null : c.value])])]));
