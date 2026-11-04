// Home Assistant add-on start: options + the Supervisor's MQTT service -> Tempolight's environment, then start the
// server in this process (signals from the Supervisor reach it directly). Zero dependencies, like Tempolight.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The Supervisor's GET /services/mqtt data -> {url, username, password}, or null if Tempolight can't use it. */
export function mqttFromService(svc) {
  if (!svc || !svc.host) return null;
  if (svc.ssl) return null; // Tempolight's MQTT client speaks plain TCP; Mosquitto's add-on also listens on 1883 without TLS
  return { url: `mqtt://${svc.host}:${Number(svc.port) || 1883}`, username: svc.username || "", password: svc.password || "" };
}

/** Add-on options (+ the MQTT service, if any) -> env vars for Tempolight. */
export function haEnv(options = {}, svc = null) {
  const port = Number(options.port), env = { TEMPOLIGHT_DATA: "/data/tempolight", PORT: String(Number.isInteger(port) && port > 0 && port < 65536 ? port : 8080) };
  if (options.discover === false) env.TEMPOLIGHT_NO_DISCOVER = "1";
  const manual = options.mqtt_url ? { url: options.mqtt_url, username: options.mqtt_username || "", password: options.mqtt_password || "" } : null;
  const m = manual || (options.mqtt_auto !== false ? mqttFromService(svc) : null);
  if (m) Object.assign(env, { TEMPOLIGHT_MQTT_URL: m.url, TEMPOLIGHT_MQTT_USER: m.username, TEMPOLIGHT_MQTT_PASS: m.password });
  return env;
}

async function supervisorMqtt() {
  const token = process.env.SUPERVISOR_TOKEN; if (!token) return null;
  try {
    const r = await fetch(`${process.env.SUPERVISOR_URL || "http://supervisor"}/services/mqtt`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) { console.log(`[tempolight] No MQTT service from the Supervisor (${r.status}): is the Mosquitto broker add-on installed?`); return null; }
    return (await r.json()).data || null;
  } catch (e) { console.log(`[tempolight] Couldn't ask the Supervisor for MQTT: ${e.message}`); return null; }
}

async function main() {
  let options = {};
  try { options = JSON.parse(readFileSync(process.env.HA_OPTIONS || "/data/options.json", "utf8")); } catch { console.log("[tempolight] No /data/options.json, using defaults"); }
  const svc = options.mqtt_url || options.mqtt_auto === false ? null : await supervisorMqtt();
  const env = haEnv(options, svc);
  if (process.env.HA_OPTIONS && process.env.TEMPOLIGHT_DATA) env.TEMPOLIGHT_DATA = process.env.TEMPOLIGHT_DATA; // trying it outside Home Assistant
  if (env.TEMPOLIGHT_MQTT_URL) console.log(`[tempolight] MQTT: ${env.TEMPOLIGHT_MQTT_URL}${options.mqtt_url ? "" : " (found the Mosquitto add-on)"}`);
  Object.assign(process.env, env);
  const root = process.env.TEMPOLIGHT_ROOT || "/opt/tempolight", entry = path.join(root, "packages/server/src/index.js");
  process.argv = [process.argv[0], entry, "--port", env.PORT];
  await import(pathToFileURL(entry).href);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
