// Wi-Fi setup for the Raspberry Pi image (Linux with NetworkManager only): the nmcli layer, the "should we open the
// setup hotspot?" logic, and the small client Tempolight's server uses to talk to the setup service (wifi-setup.js).
// The command runner is passed in, so tests feed it fake nmcli output and nothing here touches the real network.
import { execFile } from "node:child_process";

export const HOTSPOT = "Tempolight-Setup";
export const HOTSPOT_IP = "10.42.0.1";

// run(cmd, args, {timeout}) -> {code, stdout, stderr}; never throws (a missing binary is code 127)
export function execRunner(cmd, args, { timeout = 30000 } = {}) {
  return new Promise(res => execFile(cmd, args, { timeout, env: { ...process.env, LC_ALL: "C" } }, (e, stdout, stderr) =>
    res({ code: e ? (e.code === "ENOENT" ? 127 : typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || e?.message || "") })));
}

// nmcli -t output: fields split by ":", with ":" and "\" in values escaped as "\:" and "\\"
export function splitTerse(line) {
  const out = []; let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) { cur += line[++i]; continue; }
    if (c === ":") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur); return out;
}
const lines = s => String(s || "").split("\n").map(l => l.replace(/\r$/, "")).filter(Boolean);

// nmcli -t -f SSID,SIGNAL,SECURITY device wifi list  ->  one entry per name, strongest first; hidden networks dropped
export function parseWifiList(text) {
  const best = new Map();
  for (const l of lines(text)) {
    const [ssid, signal, security = ""] = splitTerse(l);
    if (!ssid || ssid === HOTSPOT) continue;
    const e = { ssid, signal: Math.max(0, Math.min(100, Number(signal) || 0)), security: security === "--" ? "" : security.trim(), open: !security || security === "--" };
    const old = best.get(ssid); if (!old || e.signal > old.signal) best.set(ssid, e);
  }
  return [...best.values()].sort((a, b) => b.signal - a.signal || a.ssid.localeCompare(b.ssid));
}

// nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status
export function parseDeviceStatus(text) {
  const devs = lines(text).map(l => { const [device, type, state, connection = ""] = splitTerse(l); return { device, type, state, connection }; });
  const real = devs.filter(d => d.type === "wifi" || d.type === "ethernet");
  const up = d => /^connected/.test(d.state) && !/externally/.test(d.state);
  const wifi = real.find(d => d.type === "wifi") || null;
  return {
    wifiDevice: wifi ? wifi.device : null,
    hotspot: real.some(d => d.type === "wifi" && up(d) && d.connection === HOTSPOT),
    online: real.some(d => up(d) && d.connection !== HOTSPOT),
    connecting: real.some(d => /^connecting/.test(d.state)),
    ssid: real.find(d => d.type === "wifi" && up(d) && d.connection !== HOTSPOT)?.connection || null,
    ethernet: real.some(d => d.type === "ethernet" && up(d)),
  };
}

// nmcli -t -f NAME,TYPE connection show
export function parseConnections(text) {
  return lines(text).map(l => { const [name, type] = splitTerse(l); return { name, type }; });
}

const COUNTRY = /^[A-Z]{2}$/;
const fail = (r, what) => { const msg = (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).pop() || `exit code ${r.code}`; return new Error(`${what}: ${msg.replace(/^Error:\s*/, "")}`); };

/** The nmcli layer. run: (cmd, args, opts) => Promise<{code, stdout, stderr}> */
export function createNm({ run = execRunner, sleep = ms => new Promise(r => setTimeout(r, ms)), hotspotPassword = "" } = {}) {
  const nmcli = (args, timeout) => run("nmcli", args, { timeout });
  async function status() {
    const r = await nmcli(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]);
    if (r.code !== 0) throw fail(r, "nmcli device status failed");
    return parseDeviceStatus(r.stdout);
  }
  async function saved() {
    const r = await nmcli(["-t", "-f", "NAME,TYPE", "connection", "show"]);
    return r.code === 0 ? parseConnections(r.stdout).filter(c => c.type === "802-11-wireless" && c.name !== HOTSPOT).map(c => c.name) : [];
  }
  async function scan(rescan = true) {
    const r = await nmcli(["-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", rescan ? "yes" : "no"], 20000);
    if (r.code !== 0 && rescan) return scan(false); // scanning is often refused while the hotspot is up: use what NetworkManager already knows
    return r.code === 0 ? parseWifiList(r.stdout) : [];
  }
  async function hotspotUp(ifname) {
    await run("rfkill", ["unblock", "wifi"]); // Raspberry Pi OS keeps Wi-Fi blocked until a country is set
    await nmcli(["radio", "wifi", "on"]);
    await nmcli(["connection", "delete", "id", HOTSPOT]); // start from a known profile each time (fails harmlessly if it isn't there)
    const sec = hotspotPassword && hotspotPassword.length >= 8 ? ["wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", hotspotPassword] : [];
    let r = await nmcli(["connection", "add", "type", "wifi", "ifname", ifname, "con-name", HOTSPOT, "autoconnect", "no", "ssid", HOTSPOT,
      "802-11-wireless.mode", "ap", "802-11-wireless.band", "bg", "802-11-wireless.channel", "6",
      "ipv4.method", "shared", "ipv4.addresses", `${HOTSPOT_IP}/24`, "ipv6.method", "disabled", ...sec]);
    if (r.code !== 0) throw fail(r, "Couldn't create the setup hotspot");
    r = await nmcli(["connection", "up", "id", HOTSPOT], 45000);
    if (r.code !== 0) throw fail(r, "Couldn't start the setup hotspot");
  }
  async function hotspotDown() { await nmcli(["connection", "down", "id", HOTSPOT], 20000); }
  async function setCountry(cc) {
    if (!COUNTRY.test(cc || "")) return false;
    const r = await run("raspi-config", ["nonint", "do_wifi_country", cc]); // persistent on Raspberry Pi OS
    if (r.code !== 0) await run("iw", ["reg", "set", cc]); // elsewhere: until the next reboot
    return true;
  }
  async function connect({ ssid, password = "", hidden = false, ifname }) {
    if (!ssid || typeof ssid !== "string" || Buffer.byteLength(ssid) > 32) throw new Error("Pick a network (names are at most 32 bytes)");
    if (password && (password.length < 8 || password.length > 63) && password.length !== 64) throw new Error("Wi-Fi passwords are 8 to 63 characters");
    const before = new Set(await saved());
    await hotspotDown();
    await sleep(2000);
    await nmcli(["device", "wifi", "rescan", ...(ifname ? ["ifname", ifname] : [])]);
    await sleep(4000);
    const args = ["--wait", "45", "device", "wifi", "connect", ssid];
    if (password) args.push("password", password);
    if (ifname) args.push("ifname", ifname);
    if (hidden) args.push("hidden", "yes");
    const r = await nmcli(args, 60000);
    if (r.code !== 0) {
      if (!before.has(ssid)) await nmcli(["connection", "delete", "id", ssid]); // don't keep retrying a wrong password at every boot
      const msg = (r.stderr + r.stdout).trim();
      if (/secrets were required|password|802-1x|psk|auth/i.test(msg)) throw new Error(`Couldn't join ${ssid}: the password looks wrong`);
      if (/no network with ssid/i.test(msg)) throw new Error(`Couldn't find ${ssid}. Is it in range, and on 2.4 GHz or 5 GHz the Pi supports?`);
      throw fail(r, `Couldn't join ${ssid}`);
    }
    return { ok: true, ssid };
  }
  return { status, saved, scan, hotspotUp, hotspotDown, setCountry, connect };
}

export const DEFAULT_TIMING = {
  graceMs: 30000,          // after boot: no network for this long and no saved Wi-Fi -> open the hotspot
  savedGraceMs: 90000,     // ... with a saved Wi-Fi network: give it longer (first boot after Imager can be slow)
  lostMs: 10 * 60000,      // a network that worked went away for this long -> open the hotspot
  hotspotIdleMs: 10 * 60000, // hotspot up this long without anyone using the page, and Wi-Fi is saved -> try it again
  activeMs: 3 * 60000,     // the page counts as in use for this long after each request
  retryMs: 2 * 60000,      // how long to try the saved networks before opening the hotspot again
};

/**
 * The decision loop: call tick() every few seconds. Modes: watch (normal), hotspot (setup page up), connecting, retry
 * (left the hotspot to let NetworkManager try saved networks). Router reboots and short outages never open the hotspot.
 */
export function createSetup({ nm, now = () => Date.now(), timing = {}, log = () => {} } = {}) {
  const T = { ...DEFAULT_TIMING, ...timing };
  const st = { mode: "watch", reason: null, since: now(), lastOnline: null, everOnline: false, lastHit: 0, networks: [], lastResult: null, ssid: null, ifname: null, busy: false, error: null };
  async function enterHotspot(reason) {
    if (st.busy) return false;
    st.busy = true;
    try {
      const s = await nm.status(); st.ifname = s.wifiDevice;
      if (!s.wifiDevice) { st.error = "This device has no Wi-Fi"; return false; }
      st.networks = await nm.scan(true).catch(() => st.networks);
      await nm.hotspotUp(s.wifiDevice);
      Object.assign(st, { mode: "hotspot", reason, since: now(), error: null });
      log(`Wi-Fi setup: hotspot ${HOTSPOT} is up (${reason})`);
      return true;
    } catch (e) { st.error = e.message; log(`Wi-Fi setup: ${e.message}`); return false; }
    finally { st.busy = false; }
  }
  async function tick() {
    if (st.busy || st.mode === "connecting") return st.mode;
    let s; try { s = await nm.status(); } catch (e) { st.error = e.message; return st.mode; }
    st.ifname = s.wifiDevice; st.ssid = s.ssid;
    const t = now();
    if (s.online) { st.lastOnline = t; st.everOnline = true; }
    if (st.mode === "watch") {
      if (s.online || !s.wifiDevice || s.hotspot) { if (s.hotspot) Object.assign(st, { mode: "hotspot", since: t }); return st.mode; }
      const saved = (await nm.saved().catch(() => [])).length > 0;
      const limit = st.everOnline ? T.lostMs : saved ? T.savedGraceMs : T.graceMs;
      const offlineFor = t - (st.lastOnline ?? st.since);
      if (offlineFor >= (s.connecting ? limit * 2 : limit)) await enterHotspot(st.everOnline ? "lost" : "no network");
    } else if (st.mode === "hotspot") {
      const inUse = t - st.lastHit < T.activeMs;
      if (!s.hotspot && s.online) { Object.assign(st, { mode: "watch", since: t, reason: null }); return st.mode; } // closed from outside, and we're online
      if (!s.hotspot && !inUse) { await enterHotspot(st.reason || "restart"); return st.mode; } // someone or something took it down
      if (s.ethernet && st.reason !== "requested" && !inUse) { await nm.hotspotDown(); Object.assign(st, { mode: "watch", since: t }); log("Wi-Fi setup: Ethernet is connected, closing the hotspot"); return st.mode; }
      const saved = (await nm.saved().catch(() => [])).length > 0;
      if (saved && !inUse && t - st.since >= T.hotspotIdleMs) { await nm.hotspotDown(); Object.assign(st, { mode: "retry", since: t }); log("Wi-Fi setup: nobody used the hotspot, trying the saved Wi-Fi again"); }
    } else if (st.mode === "retry") {
      if (s.online) Object.assign(st, { mode: "watch", since: t, reason: null });
      else if (t - st.since >= T.retryMs) await enterHotspot(st.reason || "lost");
    }
    return st.mode;
  }
  async function connect(req) {
    if (st.mode === "connecting") throw new Error("Already connecting");
    Object.assign(st, { mode: "connecting", since: now(), lastResult: null });
    try {
      if (req.country) await nm.setCountry(req.country);
      const r = await nm.connect({ ...req, ifname: req.ifname || st.ifname });
      Object.assign(st, { mode: "watch", since: now(), reason: null, lastOnline: now(), everOnline: true, ssid: r.ssid, lastResult: { ok: true, ssid: r.ssid, at: now() } });
      log(`Wi-Fi setup: connected to ${r.ssid}`);
      return r;
    } catch (e) {
      st.lastResult = { ok: false, ssid: req.ssid, error: e.message, at: now() }; st.mode = "watch";
      log(`Wi-Fi setup: ${e.message}`);
      await enterHotspot("retry after failure");
      return { ok: false, error: e.message };
    }
  }
  return {
    tick, connect, enterHotspot: (reason = "requested") => enterHotspot(reason),
    async leaveHotspot() { if (st.mode !== "hotspot") return false; await nm.hotspotDown(); Object.assign(st, { mode: "retry", since: now() }); return true; },
    hit() { st.lastHit = now(); },
    async rescan() { if (st.mode === "hotspot") st.networks = await nm.scan(true).catch(() => st.networks); return st.networks; },
    get state() { return st; },
    status: () => ({ mode: st.mode, reason: st.reason, ssid: st.ssid, hotspot: HOTSPOT, lastResult: st.lastResult, error: st.error, wifi: !!st.ifname }),
  };
}

/** Tempolight's server talks to the setup service over localhost (TEMPOLIGHT_WIFI_SETUP=http://127.0.0.1:8099). */
export function wifiClient(base, { fetch: f = globalThis.fetch } = {}) {
  const call = async (method, p) => {
    const r = await f(base.replace(/\/$/, "") + p, { method, signal: AbortSignal.timeout(4000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `Wi-Fi setup service answered ${r.status}`), { code: r.status });
    return j;
  };
  return {
    async status() { try { return { available: true, ...(await call("GET", "/status")) }; } catch (e) { return { available: false, error: `The Wi-Fi setup service isn't running (${e.message})` }; } },
    setup: () => call("POST", "/setup"),
  };
}
