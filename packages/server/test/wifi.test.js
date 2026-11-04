import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { splitTerse, parseWifiList, parseDeviceStatus, createNm, createSetup, wifiClient, HOTSPOT } from "../src/wifi.js";
import { createPortal, createControl } from "../src/wifi-setup.js";

test("wifi: nmcli terse output with escaped colons and backslashes", () => {
  assert.deepEqual(splitTerse("a\\:b:c\\\\d:"), ["a:b", "c\\d", ""]);
  const list = parseWifiList([
    "Home\\:Net:72:WPA2",
    "Home\\:Net:40:WPA2",       // same network seen on another access point: keep the strongest
    ":90:WPA2",                  // hidden network: no name
    "Cafe:55:--",
    `${HOTSPOT}:100:`,           // ourselves
    "Office 5G:88:WPA2 WPA3",
  ].join("\n"));
  assert.deepEqual(list.map(n => n.ssid), ["Office 5G", "Home:Net", "Cafe"]);
  assert.equal(list[1].signal, 72);
  assert.equal(list[2].open, true);
  assert.equal(list[0].security, "WPA2 WPA3");
});

test("wifi: device status tells online, hotspot and connecting apart", () => {
  const s = parseDeviceStatus("wlan0:wifi:connected:Home\nlo:loopback:connected (externally):lo\neth0:ethernet:unavailable:\np2p-dev-wlan0:wifi-p2p:disconnected:\n");
  assert.deepEqual(s, { wifiDevice: "wlan0", hotspot: false, online: true, connecting: false, ssid: "Home", ethernet: false });
  const h = parseDeviceStatus(`wlan0:wifi:connected:${HOTSPOT}\neth0:ethernet:unavailable:\n`);
  assert.equal(h.hotspot, true); assert.equal(h.online, false); assert.equal(h.ssid, null);
  const c = parseDeviceStatus("wlan0:wifi:connecting (getting IP configuration):Home\n");
  assert.equal(c.connecting, true); assert.equal(c.online, false);
  const e = parseDeviceStatus("eth0:ethernet:connected:Wired connection 1\nwlan0:wifi:disconnected:\n");
  assert.equal(e.online, true); assert.equal(e.ethernet, true);
  assert.equal(parseDeviceStatus("eth0:ethernet:connected:Wired\n").wifiDevice, null);
});

// a pretend NetworkManager: answers nmcli like the real one and records what was asked
function fakeNmcli({ devices = "wlan0:wifi:disconnected:\n", scan = "Home:80:WPA2\nCafe:30:--\n", saved = "", connectOk = true } = {}) {
  const calls = [], net = { devices, saved };
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== "nmcli") return { code: 0, stdout: "", stderr: "" };
    const a = args.join(" ");
    if (a.includes("device status")) return { code: 0, stdout: net.devices, stderr: "" };
    if (a.includes("connection show")) return { code: 0, stdout: net.saved, stderr: "" };
    if (a.includes("wifi list")) return { code: 0, stdout: scan, stderr: "" };
    if (a.startsWith("connection up id " + HOTSPOT)) { net.devices = `wlan0:wifi:connected:${HOTSPOT}\n`; return { code: 0, stdout: "", stderr: "" }; }
    if (a.startsWith("connection down id " + HOTSPOT)) { net.devices = "wlan0:wifi:disconnected:\n"; return { code: 0, stdout: "", stderr: "" }; }
    if (a.includes("wifi connect")) {
      if (!connectOk) return { code: 4, stdout: "", stderr: "Error: Connection activation failed: Secrets were required, but not provided.\n" };
      const ssid = args[args.indexOf("connect") + 1]; net.devices = `wlan0:wifi:connected:${ssid}\n`; net.saved += `${ssid}:802-11-wireless\n`;
      return { code: 0, stdout: "Device 'wlan0' successfully activated", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, net };
}
const noSleep = async () => {};

test("wifi: no network 30 s after boot opens the hotspot; a good password closes it", async () => {
  const f = fakeNmcli(); let t = 0;
  const nm = createNm({ run: f.run, sleep: noSleep }), setup = createSetup({ nm, now: () => t });
  t = 10000; assert.equal(await setup.tick(), "watch");
  t = 31000; assert.equal(await setup.tick(), "hotspot");
  assert.ok(f.calls.some(c => c.join(" ").includes("802-11-wireless.mode ap")), "creates an access point profile");
  assert.ok(f.calls.some(c => c.join(" ").includes("ipv4.method shared")), "shares the connection (NetworkManager's dnsmasq)");
  assert.ok(f.calls.some(c => c[0] === "rfkill"), "unblocks Wi-Fi first");
  assert.deepEqual(setup.state.networks.map(n => n.ssid), ["Home", "Cafe"], "scanned before the hotspot took the radio");
  const r = await setup.connect({ ssid: "Home", password: "correct horse", country: "DE" });
  assert.equal(r.ok, true); assert.equal(setup.state.mode, "watch"); assert.equal(setup.status().lastResult.ok, true);
  assert.ok(f.calls.some(c => c[0] === "raspi-config" && c.includes("DE")), "sets the Wi-Fi country");
  const conn = f.calls.find(c => c.includes("connect")); assert.deepEqual(conn.slice(0, 7), ["nmcli", "--wait", "45", "device", "wifi", "connect", "Home"]);
  t = 40000; assert.equal(await setup.tick(), "watch");
});

test("wifi: a wrong password brings the hotspot back with the reason, and forgets the bad profile", async () => {
  const f = fakeNmcli({ connectOk: false }); let t = 0;
  const setup = createSetup({ nm: createNm({ run: f.run, sleep: noSleep }), now: () => t });
  t = 31000; await setup.tick(); assert.equal(setup.state.mode, "hotspot");
  const r = await setup.connect({ ssid: "Home", password: "wrongpass" });
  assert.equal(r.ok, false); assert.match(r.error, /password looks wrong/);
  assert.equal(setup.state.mode, "hotspot", "back to the hotspot");
  assert.ok(f.calls.some(c => c.join(" ") === "nmcli connection delete id Home"));
  await assert.rejects(createNm({ run: f.run, sleep: noSleep }).connect({ ssid: "Home", password: "short" }), /8 to 63/);
});

test("wifi: saved networks get longer; a short outage never opens the hotspot; a long one does", async () => {
  const f = fakeNmcli({ saved: "Home:802-11-wireless\nWired connection 1:802-3-ethernet\n" }); let t = 0;
  const setup = createSetup({ nm: createNm({ run: f.run, sleep: noSleep }), now: () => t });
  t = 45000; assert.equal(await setup.tick(), "watch", "saved Wi-Fi: wait 90 s, not 30");
  f.net.devices = "wlan0:wifi:connected:Home\n"; t = 60000; assert.equal(await setup.tick(), "watch");
  f.net.devices = "wlan0:wifi:disconnected:\n";
  t = 60000 + 5 * 60000; assert.equal(await setup.tick(), "watch", "router reboot: keep waiting");
  t = 60000 + 10 * 60000 + 1; assert.equal(await setup.tick(), "hotspot");
  assert.equal(setup.state.reason, "lost");
  // nobody uses it for 10 minutes: leave the hotspot so NetworkManager can try the saved network again
  t += 10 * 60000; assert.equal(await setup.tick(), "retry");
  f.net.devices = "wlan0:wifi:connected:Home\n"; t += 5000; assert.equal(await setup.tick(), "watch");
});

test("wifi: the hotspot stays while someone uses the page; Ethernet and no Wi-Fi never open it", async () => {
  const f = fakeNmcli({ saved: "Home:802-11-wireless\n" }); let t = 0;
  const setup = createSetup({ nm: createNm({ run: f.run, sleep: noSleep }), now: () => t });
  t = 91000; assert.equal(await setup.tick(), "hotspot");
  t += 9 * 60000; setup.hit(); t += 2 * 60000; assert.equal(await setup.tick(), "hotspot", "page in use");
  const g = fakeNmcli({ devices: "eth0:ethernet:connected:Wired\nwlan0:wifi:disconnected:\n" }); let u = 0;
  const s2 = createSetup({ nm: createNm({ run: g.run, sleep: noSleep }), now: () => u });
  u = 10 * 60000; assert.equal(await s2.tick(), "watch");
  const h = fakeNmcli({ devices: "eth0:ethernet:disconnected:\n" }); let v = 0;
  const s3 = createSetup({ nm: createNm({ run: h.run, sleep: noSleep }), now: () => v });
  v = 10 * 60000; assert.equal(await s3.tick(), "watch", "no Wi-Fi hardware");
  assert.equal(await s3.enterHotspot(), false); assert.match(s3.state.error, /no Wi-Fi/);
});

// tiny request/response doubles for the HTTP handlers
async function call(handler, { method = "GET", url = "/", host = "10.42.0.1", body = "" } = {}) {
  const req = Object.assign((async function* () { if (body) yield Buffer.from(body); })(), { method, url, headers: { host } });
  return new Promise(resolve => {
    const res = { code: 0, headers: {}, writeHead(c, h = {}) { this.code = c; this.headers = h; }, end(b = "") { resolve({ code: this.code, headers: this.headers, body: String(b) }); } };
    handler(req, res);
  });
}

test("wifi portal: redirects to Tempolight normally, captive checks to the page, and connects from the form", async () => {
  const f = fakeNmcli(); let t = 0; const later = [];
  const setup = createSetup({ nm: createNm({ run: f.run, sleep: noSleep }), now: () => t });
  const portal = createPortal({ setup, appPort: 8080, schedule: fn => later.push(fn) });
  let r = await call(portal, { url: "/x?y=1", host: "tempolight.local" });
  assert.equal(r.code, 302); assert.equal(r.headers.location, "http://tempolight.local:8080/x?y=1");
  t = 31000; await setup.tick();
  r = await call(portal, { url: "/generate_204", host: "connectivitycheck.gstatic.com" });
  assert.equal(r.code, 302); assert.equal(r.headers.location, "http://10.42.0.1/");
  r = await call(portal); assert.equal(r.code, 200); assert.match(r.body, /<option value="Home">Home · 80%/); assert.match(r.body, /Cafe · 30% · open/);
  r = await call(portal, { method: "POST", url: "/connect", body: "ssid=Home&password=abc" }); assert.equal(r.code, 400); assert.match(r.body, /8 to 63/);
  r = await call(portal, { method: "POST", url: "/connect", body: "ssid=Home&other=&password=correct+horse&country=gb" });
  assert.equal(r.code, 200); assert.match(r.body, /http:\/\/tempolight\.local/);
  assert.equal(later.length, 1); await later[0]();
  assert.equal(setup.state.mode, "watch"); assert.ok(f.calls.some(c => c.includes("GB")));
  assert.ok(f.calls.some(c => c.join(" ").includes("connect Home password correct horse")));
  // the page shows a failure reason after a bad attempt
  const g = fakeNmcli({ connectOk: false }); let u = 31000;
  const s2 = createSetup({ nm: createNm({ run: g.run, sleep: noSleep }), now: () => u }); await s2.tick();
  await s2.connect({ ssid: "Hidden net", password: "whatever1", hidden: true });
  r = await call(createPortal({ setup: s2 })); assert.match(r.body, /didn't work/); assert.match(r.body, /password looks wrong/);
});

test("wifi control: localhost API, and the client Tempolight's server uses", async () => {
  const f = fakeNmcli({ devices: "wlan0:wifi:connected:Home\n" }); const later = [];
  const setup = createSetup({ nm: createNm({ run: f.run, sleep: noSleep }), now: () => 1000 }); await setup.tick();
  const srv = http.createServer(createControl({ setup, schedule: fn => later.push(fn) }));
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  try {
    const c = wifiClient(`http://127.0.0.1:${srv.address().port}/`);
    const s = await c.status(); assert.equal(s.available, true); assert.equal(s.ssid, "Home"); assert.equal(s.mode, "watch");
    const r = await c.setup(); assert.equal(r.ok, true); assert.equal(later.length, 1);
    await later[0](); assert.equal(setup.state.mode, "hotspot"); assert.equal(setup.state.reason, "requested");
  } finally { srv.close(); }
  const off = await wifiClient("http://127.0.0.1:1").status(); assert.equal(off.available, false);
});
