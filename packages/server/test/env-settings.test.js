import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { settingsFromEnv } from "../src/env-settings.js";
import { createApp } from "../src/app.js";
import { haEnv, mqttFromService } from "../../../homeassistant/tempolight/ha-start.js";

test("env settings: TEMPOLIGHT_MQTT_* become MQTT settings; nothing set, nothing changed", () => {
  assert.deepEqual(settingsFromEnv({}), {});
  assert.deepEqual(settingsFromEnv({ TEMPOLIGHT_MQTT_URL: "core-mosquitto:1883", TEMPOLIGHT_MQTT_USER: "addons", TEMPOLIGHT_MQTT_PASS: "s3cret" }),
    { mqtt: { url: "mqtt://core-mosquitto:1883", enabled: true, username: "addons", password: "s3cret" } });
  const m = settingsFromEnv({ TEMPOLIGHT_MQTT_URL: "mqtt://10.0.0.2", TEMPOLIGHT_MQTT_USERNAME: "u", TEMPOLIGHT_MQTT_PASSWORD: "p", TEMPOLIGHT_MQTT_ENABLED: "0", TEMPOLIGHT_MQTT_BASE: "living" }).mqtt;
  assert.equal(m.enabled, false); assert.equal(m.username, "u"); assert.equal(m.password, "p"); assert.equal(m.base, "living"); assert.equal(m.prefix, undefined);
  assert.equal("password" in settingsFromEnv({ TEMPOLIGHT_MQTT_URL: "mqtt://x" }).mqtt, false, "no password given: keep the saved one");
});

test("env settings: applied at start, win over saved settings, password stays hidden from the API", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-env-"));
  try {
    let app = await createApp({ dataDir: dir, discover: false, logger: null });
    app.store.data.settings.mqtt.url = "mqtt://old:1883"; app.store.flush(); await app.close();
    app = await createApp({ dataDir: dir, discover: false, logger: null, envSettings: settingsFromEnv({ TEMPOLIGHT_MQTT_URL: "mqtt://127.0.0.1:1", TEMPOLIGHT_MQTT_USER: "addons", TEMPOLIGHT_MQTT_PASS: "pw" }) });
    const port = await app.listen(0, "127.0.0.1");
    try {
      const st = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
      assert.equal(st.settings.mqtt.url, "mqtt://127.0.0.1:1"); assert.equal(st.settings.mqtt.enabled, true); assert.equal(st.settings.mqtt.username, "addons");
      assert.equal(st.settings.mqtt.password, ""); assert.equal(st.settings.mqtt.hasPassword, true);
      assert.notEqual(app.runtime.rt.mqtt.state, "off", "the Home Assistant connection started");
    } finally { await app.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Wi-Fi API: hidden without the setup service, and needs the PIN to start setup", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-wifi-")); let asked = 0;
  const wifi = { status: async () => ({ available: true, mode: "watch", ssid: "Home" }), setup: async () => { asked++; return { ok: true, message: "Starting" }; } };
  const a = await createApp({ dataDir: dir, discover: false, logger: null, wifi: null }), b = await createApp({ dataDir: dir + "b", discover: false, logger: null, wifi });
  try {
    const pa = await a.listen(0, "127.0.0.1"), pb = await b.listen(0, "127.0.0.1");
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${pa}/api/wifi`)).json(), { available: false });
    assert.equal((await fetch(`http://127.0.0.1:${pa}/api/wifi/setup`, { method: "POST" })).status, 400);
    assert.equal((await (await fetch(`http://127.0.0.1:${pb}/api/wifi`)).json()).ssid, "Home");
    await fetch(`http://127.0.0.1:${pb}/api/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "1234" }) });
    assert.equal((await fetch(`http://127.0.0.1:${pb}/api/wifi/setup`, { method: "POST" })).status, 403, "locked");
    const tok = (await (await fetch(`http://127.0.0.1:${pb}/api/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "1234" }) })).json()).token;
    const r = await fetch(`http://127.0.0.1:${pb}/api/wifi/setup`, { method: "POST", headers: { "x-tempolight-token": tok } });
    assert.equal(r.status, 200); assert.equal(asked, 1);
  } finally { await a.close(); await b.close(); rmSync(dir, { recursive: true, force: true }); rmSync(dir + "b", { recursive: true, force: true }); }
});

test("Home Assistant add-on: options and the Mosquitto service become env vars", () => {
  const svc = { host: "core-mosquitto", port: 1883, ssl: false, protocol: "3.1.1", username: "addons", password: "abc" };
  assert.deepEqual(mqttFromService(svc), { url: "mqtt://core-mosquitto:1883", username: "addons", password: "abc" });
  assert.equal(mqttFromService({ ...svc, ssl: true, port: 8883 }), null, "TLS isn't supported by Tempolight's MQTT client");
  assert.equal(mqttFromService(null), null);
  const e = haEnv({ port: 8090, mqtt_auto: true, discover: false }, svc);
  assert.equal(e.TEMPOLIGHT_MQTT_URL, "mqtt://core-mosquitto:1883"); assert.equal(e.TEMPOLIGHT_MQTT_USER, "addons"); assert.equal(e.TEMPOLIGHT_MQTT_PASS, "abc");
  assert.equal(e.PORT, "8090"); assert.equal(e.TEMPOLIGHT_DATA, "/data/tempolight"); assert.equal(e.TEMPOLIGHT_NO_DISCOVER, "1");
  const off = haEnv({ mqtt_auto: false }, svc); assert.equal(off.TEMPOLIGHT_MQTT_URL, undefined); assert.equal(off.PORT, "8080");
  const manual = haEnv({ mqtt_auto: false, mqtt_url: "mqtt://10.0.0.5:1883", mqtt_username: "me", mqtt_password: "pw" }, null);
  assert.equal(manual.TEMPOLIGHT_MQTT_URL, "mqtt://10.0.0.5:1883"); assert.equal(manual.TEMPOLIGHT_MQTT_PASS, "pw");
  assert.equal(haEnv({ port: "nope" }).PORT, "8080");
});
