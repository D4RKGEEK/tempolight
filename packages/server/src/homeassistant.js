// Home Assistant over MQTT: Tempolight announces itself with MQTT discovery, so it appears in Home Assistant by itself
// as a light (on/off, brightness, effect), a scene picker, a few sensors (tempo, song part, source) and buttons
// (flash, drop). Automations and voice assistants connected to Home Assistant can then control it.
// Each Tempolight scene is also its own Home Assistant `scene` entity, so "Hey Google, activate Party mode" works
// through Home Assistant's Google Assistant and Alexa integrations (see docs/voice.md).
import { mqttConnect } from "./mqtt.js";

const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function startHomeAssistant({ core, store, runtime, version }) {
  const data = () => store.data, rt = runtime.rt;
  let client = null, cfgKey = "", lastState = "", lastStatus = "", timer = null, sceneIds = new Set();
  rt.mqtt = { state: "off" };
  const base = () => data().settings.mqtt.base || "tempolight", prefix = () => data().settings.mqtt.prefix || "homeassistant";
  const T = k => `${base()}/${k}`;
  const effectName = id => runtime.effects.list.find(e => e.id === id)?.name || id;

  function announce() {
    const dev = { identifiers: [`tempolight-${base()}`], name: "Tempolight", manufacturer: "Tempolight", model: "Music-reactive lighting", sw_version: version };
    const avail = { availability_topic: T("availability") }, cfg = (kind, id, o) => client.publish(`${prefix()}/${kind}/${base()}/${id}/config`, { ...o, ...avail, unique_id: `${base()}_${id}`, device: dev }, { retain: true });
    cfg("light", "light", { name: "Lights", schema: "json", command_topic: T("light/set"), state_topic: T("light/state"), brightness: true, effect: true,
      effect_list: ["Automatic", ...runtime.effects.list.map(e => e.name)] });
    cfg("select", "scene", { name: "Scene", command_topic: T("scene/set"), state_topic: T("scene/state"), options: data().scenes.map(s => s.name), icon: "mdi:palette" });
    cfg("sensor", "bpm", { name: "Tempo", state_topic: T("status"), value_template: "{{ value_json.bpm | default(0) }}", unit_of_measurement: "BPM", icon: "mdi:metronome" });
    cfg("sensor", "part", { name: "Song part", state_topic: T("status"), value_template: "{{ value_json.part }}", icon: "mdi:music-note" });
    cfg("sensor", "source", { name: "Music source", state_topic: T("status"), value_template: "{{ value_json.source }}", icon: "mdi:speaker" });
    for (const [id, name, icon] of [["flash", "Flash", "mdi:flash"], ["drop", "Drop now", "mdi:arrow-collapse-down"], ["next", "Next effect", "mdi:skip-next"],
      ["sleep", "Sleep timer", "mdi:power-sleep"], ["wake_snooze", "Snooze wake-up", "mdi:alarm-snooze"], ["wake_stop", "Stop wake-up", "mdi:alarm-off"]]) // Home & sleep
      cfg("button", id, { name, command_topic: T("action/set"), payload_press: id, icon });
    announceScenes();
    client.publish(T("availability"), "online", { retain: true }); lastState = ""; publishState();
  }
  // one `scene` entity per scene, plus "Tempolight off". They have no device on purpose: Home Assistant would put the
  // device name in front ("Tempolight Party mode"), and voice assistants use that name
  const sceneTopic = id => `${prefix()}/scene/${base()}/${id}/config`, sceneKey = sc => "scene_" + String(sc.id).replace(/[^\w-]/g, "_");
  function announceScenes() {
    const now = new Set(), pub = (id, o) => { now.add(id); client.publish(sceneTopic(id), { ...o, availability_topic: T("availability"), unique_id: `${base()}_${id}` }, { retain: true }); };
    for (const sc of data().scenes) pub(sceneKey(sc), { name: sc.name, command_topic: T("scene/set"), payload_on: sc.id, icon: "mdi:palette" });
    pub("tempolight_off", { name: "Tempolight off", command_topic: T("light/set"), payload_on: JSON.stringify({ state: "OFF" }), icon: "mdi:lightbulb-off" });
    for (const id of sceneIds) if (!now.has(id)) client.publish(sceneTopic(id), "", { retain: true }); // a deleted scene leaves Home Assistant too
    sceneIds = now;
  }
  function publishState() {
    if (!client || !client.connected) return;
    const sh = data().show, st = { state: sh.power ? "ON" : "OFF", brightness: Math.round(data().settings.brightness * 255), effect: sh.mode === "auto" ? "Automatic" : effectName(sh.effect) };
    const j = JSON.stringify(st); if (j !== lastState) { lastState = j; client.publish(T("light/state"), j, { retain: true }); }
    const s = runtime.status(), status = JSON.stringify({ bpm: s.bpm ? Math.round(s.bpm) : 0, part: s.part, source: s.sourceLabel, effect: s.effectName });
    if (status !== lastStatus) { lastStatus = status; client.publish(T("status"), status, { retain: true }); }
  }
  function onMessage(topic, payload) {
    const text = payload.toString("utf8");
    const sm = new RegExp(`^${reEsc(prefix())}/scene/${reEsc(base())}/([^/]+)/config$`).exec(topic); // retained scene configs from an earlier run
    if (sm) { if (text && !sceneIds.has(sm[1])) client.publish(topic, "", { retain: true }); return; }
    if (topic === T("light/set")) {
      let c; try { c = JSON.parse(text); } catch { c = { state: text }; }
      if (c.state) runtime.setPower(c.state === "ON").then(() => publishState());
      if (c.brightness !== undefined) core.applySettings({ brightness: Number(c.brightness) / 255 });
      if (c.effect) { if (c.effect === "Automatic") core.applyShow({ mode: "auto" }); else { const e = runtime.effects.list.find(x => x.name === c.effect || x.id === c.effect); if (e) core.applyShow({ effect: e.id, mode: "manual" }); } }
    } else if (topic === T("scene/set")) { const sc = data().scenes.find(s => s.name === text || s.id === text); if (sc) { core.applyScene(sc); client.publish(T("scene/state"), sc.name, { retain: true }); } }
    else if (topic === T("action/set")) { try { if (!/^(sleep|wake_)/.test(text) || !core.home) runtime.action({ type: text }); else core.home.command(text); } catch {} }
    publishState();
  }
  function restart() {
    const m = data().settings.mqtt, key = JSON.stringify(m);
    if (key === cfgKey) return; cfgKey = key;
    if (client) { try { client.publish(T("availability"), "offline", { retain: true }); } catch {} client.close(); client = null; }
    clearInterval(timer); rt.mqtt = { state: "off" };
    if (!m.enabled || !m.url) return;
    client = mqttConnect(m.url, { username: m.username, password: m.password, clientId: `tempolight-${base()}`, will: { topic: T("availability"), payload: "offline", retain: true },
      onMessage, onState: (state, error) => { rt.mqtt = { state, error: error || null }; if (state === "connected") { ["light/set", "scene/set", "action/set"].forEach(t => client.subscribe(T(t))); announce(); client.subscribe(`${prefix()}/scene/${base()}/+/config`); runtime.note("Home Assistant: connected to MQTT"); }
        else if (state === "error") runtime.note(`Home Assistant: ${error}`, "warn"); } });
    timer = setInterval(publishState, 2000);
  }
  core.onChange(what => { if (what === "settings" || what === "all") restart(); if (client && client.connected && (what === "scenes" || what === "all")) announce(); publishState(); });
  restart();
  return { close() { clearInterval(timer); if (client) { try { client.publish(T("availability"), "offline", { retain: true }); } catch {} client.close(); } }, restart };
}
