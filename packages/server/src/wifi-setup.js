#!/usr/bin/env node
// Wi-Fi setup service for the Tempolight Raspberry Pi image (runs as root, as its own systemd unit: tempolight-wifi).
// If the Pi has no network ~30 s after boot (or loses a working one for 10 minutes), it opens an open Wi-Fi hotspot
// "Tempolight-Setup" with a small page on port 80: pick your Wi-Fi, type the password, done. NetworkManager's shared
// mode hands out addresses with dnsmasq, and /etc/NetworkManager/dnsmasq-shared.d/tempolight-captive.conf answers
// every DNS name with 10.42.0.1, so phones show the page by themselves ("Sign in to network").
// When the setup page isn't up, port 80 just redirects to Tempolight on :8080, so http://tempolight.local works.
// Tempolight's Settings page asks for setup over http://127.0.0.1:8099 (localhost only).
//   env: TEMPOLIGHT_PORT (8080), TEMPOLIGHT_WIFI_PORTAL_PORT (80), TEMPOLIGHT_WIFI_CONTROL_PORT (8099),
//        TEMPOLIGHT_HOTSPOT_PASSWORD (empty = open hotspot; 8+ characters = WPA2)
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createNm, createSetup, HOTSPOT, HOTSPOT_IP } from "./wifi.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const COUNTRIES = "AR Argentina,AT Austria,AU Australia,BE Belgium,BR Brazil,CA Canada,CH Switzerland,CL Chile,CN China,CZ Czechia,DE Germany,DK Denmark,ES Spain,FI Finland,FR France,GB United Kingdom,GR Greece,HU Hungary,IE Ireland,IL Israel,IN India,IT Italy,JP Japan,KR South Korea,MX Mexico,NL Netherlands,NO Norway,NZ New Zealand,PL Poland,PT Portugal,RO Romania,SE Sweden,SG Singapore,TR Turkey,UA Ukraine,US United States,ZA South Africa"
  .split(",").map(x => [x.slice(0, 2), x.slice(3)]);

const page = (title, body, refresh = 0) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1b1b1b;--card:#fff;--line:#d9d9d4;--acc:#e0a100;--muted:#666}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--card:#1e1e1e;--line:#333;--muted:#aaa}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:440px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}
form,.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:16px}
label{display:block;font-weight:600;margin:12px 0 4px}select,input{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
button{margin-top:16px;width:100%;font:inherit;font-weight:600;padding:12px;border:0;border-radius:8px;background:var(--acc);color:#111}
.err{border-color:#c33;color:#c33}.big{font-size:20px;font-weight:700;word-break:break-all}a{color:inherit}
</style></head><body><main>${body}</main></body></html>`;

/** HTTP handler for port 80. setup: createSetup(); schedule(fn, ms) runs fn later (after the answer reached the phone). */
export function createPortal({ setup, appPort = 8080, schedule = (fn, ms) => setTimeout(fn, ms), hostname = "tempolight" }) {
  const ours = h => !h || h === HOTSPOT_IP || h === `${hostname}.local` || h === hostname || h === "localhost";
  const send = (res, code, html, headers = {}) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers }); res.end(html); };
  const redirect = (res, to) => { res.writeHead(302, { location: to, "cache-control": "no-store" }); res.end(); };
  function form(st) {
    const r = st.lastResult, nets = st.networks || [];
    const opts = nets.map(n => `<option value="${esc(n.ssid)}">${esc(n.ssid)} · ${n.signal}%${n.open ? " · open" : ""}</option>`).join("");
    return page("Tempolight Wi-Fi setup", `<h1>Connect Tempolight to Wi-Fi</h1>
<p class="muted">Pick your home Wi-Fi. Tempolight joins it, and this setup network goes away.</p>
${r && !r.ok ? `<div class="card err"><b>That didn't work.</b> ${esc(r.error)}</div>` : ""}
<form method="post" action="/connect">
<label for="ssid">Network</label><select id="ssid" name="ssid">${opts}<option value="">Another network (hidden or not listed)…</option></select>
<label for="other">Network name, if not in the list</label><input id="other" name="other" autocomplete="off" autocapitalize="none" maxlength="32">
<label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" maxlength="64">
<label for="cc">Country (sets the allowed Wi-Fi channels)</label><select id="cc" name="country"><option value="">Keep the current setting</option>${COUNTRIES.map(([c, n]) => `<option value="${c}">${esc(n)}</option>`).join("")}</select>
<button type="submit">Connect</button></form>
<p class="muted" style="margin-top:16px"><a href="/rescan">Look for networks again</a> · ${nets.length} found</p>`);
  }
  return async function handle(req, res) {
    const st = setup.state, url = new URL(req.url, "http://x"), host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    if (st.mode !== "hotspot" && st.mode !== "connecting") return redirect(res, `http://${/^[\w.-]+$/.test(host) ? host : `${hostname}.local`}:${appPort}${url.pathname}${url.search}`); // http://tempolight.local -> :8080
    setup.hit();
    if (!ours(host)) return redirect(res, `http://${HOTSPOT_IP}/`); // captive-portal checks (generate_204, hotspot-detect.html, …) land here
    if (st.mode === "connecting") return send(res, 200, page("Connecting…", `<h1>Connecting…</h1><p>Tempolight is joining your Wi-Fi. This page stops answering when it's done.</p>`, 10));
    if (req.method === "GET" && url.pathname === "/rescan") { await setup.rescan(); return redirect(res, "/"); }
    if (req.method === "POST" && url.pathname === "/connect") {
      let body = ""; for await (const c of req) { body += c; if (body.length > 4096) return send(res, 413, page("Too long", "<p>Too much data.</p>")); }
      const f = new URLSearchParams(body), ssid = (f.get("other") || "").trim() || f.get("ssid") || "", password = f.get("password") || "", country = (f.get("country") || "").toUpperCase();
      if (!ssid) return send(res, 400, form({ ...st, lastResult: { ok: false, error: "Pick a network or type its name." } }));
      if (password && (password.length < 8 || password.length > 64)) return send(res, 400, form({ ...st, lastResult: { ok: false, error: "Wi-Fi passwords are 8 to 63 characters." } }));
      const hidden = !(st.networks || []).some(n => n.ssid === ssid);
      schedule(() => setup.connect({ ssid, password, country, hidden }).catch(() => {}), 1500);
      return send(res, 200, page("Connecting", `<h1>Joining ${esc(ssid)}…</h1>
<div class="card"><p>In a few seconds this setup network disappears. Put your phone back on <b>${esc(ssid)}</b>, then open:</p>
<p class="big"><a href="http://${esc(hostname)}.local">http://${esc(hostname)}.local</a></p>
<p class="muted">On Android phones that don't open .local addresses, look for "${esc(hostname)}" in your router's device list and open its address.</p></div>
<div class="card"><p class="muted">If the password was wrong, <b>${esc(HOTSPOT)}</b> comes back within a minute: join it again to see what went wrong.</p></div>`));
    }
    return send(res, 200, form(st));
  };
}

/** HTTP handler for the localhost control port (Tempolight's Settings page). */
export function createControl({ setup, schedule = (fn, ms) => setTimeout(fn, ms) }) {
  return async function handle(req, res) {
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/status") return json(200, setup.status());
    if (req.method === "POST" && url.pathname === "/setup") {
      if (!setup.status().wifi) return json(400, { error: "This device has no Wi-Fi" });
      schedule(() => setup.enterHotspot("requested"), 1500); // answer first: the page asking is probably on this Wi-Fi
      return json(200, { ok: true, hotspot: HOTSPOT, message: `Starting the ${HOTSPOT} hotspot. Join it from your phone to pick a new network.` });
    }
    return json(404, { error: "Not found" });
  };
}

async function main() {
  if (process.platform !== "linux") { console.error("Wi-Fi setup only runs on Linux with NetworkManager."); process.exit(0); }
  const env = process.env, nm = createNm({ hotspotPassword: env.TEMPOLIGHT_HOTSPOT_PASSWORD || "" });
  try { await nm.status(); } catch (e) { console.error(`NetworkManager isn't available (${e.message}); Wi-Fi setup is off.`); process.exit(0); }
  const setup = createSetup({ nm, log: m => console.log(m) });
  const os = await import("node:os");
  const portal = http.createServer(createPortal({ setup, appPort: Number(env.TEMPOLIGHT_PORT || 8080), hostname: os.hostname().split(".")[0] }));
  portal.on("error", e => console.error(`Port ${env.TEMPOLIGHT_WIFI_PORTAL_PORT || 80}: ${e.message}`));
  portal.listen(Number(env.TEMPOLIGHT_WIFI_PORTAL_PORT || 80), "0.0.0.0");
  http.createServer(createControl({ setup })).listen(Number(env.TEMPOLIGHT_WIFI_CONTROL_PORT || 8099), "127.0.0.1");
  console.log("Wi-Fi setup: watching the network");
  let running = false;
  const loop = async () => { if (running) return; running = true; try { await setup.tick(); } catch (e) { console.error(e.message); } finally { running = false; } };
  setInterval(loop, 5000); loop();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { if (setup.state.mode === "hotspot") await nm.hotspotDown().catch(() => {}); process.exit(0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
