// Settings that come from the environment and win over the saved ones at every start. Used by the Home Assistant
// add-on (it finds the Mosquitto broker and passes it in) and by anyone who configures Tempolight with env vars.
//   TEMPOLIGHT_MQTT_URL       mqtt://host:1883 (turns the Home Assistant connection on)
//   TEMPOLIGHT_MQTT_USER      (or TEMPOLIGHT_MQTT_USERNAME)
//   TEMPOLIGHT_MQTT_PASS      (or TEMPOLIGHT_MQTT_PASSWORD)
//   TEMPOLIGHT_MQTT_PREFIX    discovery prefix (default homeassistant)
//   TEMPOLIGHT_MQTT_BASE      topic base (default tempolight)
//   TEMPOLIGHT_MQTT_ENABLED   0 to keep the connection off while still setting the address
// Values set this way are replaced at the next start, so change them where they're set (e.g. the add-on's options).

/** @returns {{mqtt?: object}} a partial settings object, empty when nothing is set */
export function settingsFromEnv(env = process.env) {
  const out = {}, v = k => (typeof env[k] === "string" ? env[k].trim() : "");
  const url = v("TEMPOLIGHT_MQTT_URL");
  if (url) {
    const m = { url: /^[a-z]+:\/\//i.test(url) ? url : `mqtt://${url}`, enabled: !/^(0|false|no|off)$/i.test(v("TEMPOLIGHT_MQTT_ENABLED")) };
    const user = v("TEMPOLIGHT_MQTT_USER") || v("TEMPOLIGHT_MQTT_USERNAME"), pass = env.TEMPOLIGHT_MQTT_PASS ?? env.TEMPOLIGHT_MQTT_PASSWORD;
    if (user || "TEMPOLIGHT_MQTT_USER" in env || "TEMPOLIGHT_MQTT_USERNAME" in env) m.username = user;
    if (pass !== undefined) m.password = String(pass);
    if (v("TEMPOLIGHT_MQTT_PREFIX")) m.prefix = v("TEMPOLIGHT_MQTT_PREFIX");
    if (v("TEMPOLIGHT_MQTT_BASE")) m.base = v("TEMPOLIGHT_MQTT_BASE");
    out.mqtt = m;
  }
  return out;
}

/** Write the env settings into the store (before anything reads them). Returns the names of what was set. */
export function applyEnvSettings(store, patch) {
  const set = [];
  if (patch && patch.mqtt) {
    const m = store.data.settings.mqtt;
    for (const [k, val] of Object.entries(patch.mqtt)) { if (m[k] !== val) { m[k] = val; } set.push(`mqtt.${k}`); }
    store.save();
  }
  return set;
}
