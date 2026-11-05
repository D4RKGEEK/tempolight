// Settings → Apple Home: turn the HomeKit bridge on or off, show its setup code and QR code for the Home app, list the
// paired iPhones, iPads and home hubs, and reset the pairing. Server only (homekit/index.js): app.js loads this file
// when not in the demo.
import { api, act, panel, $, esc } from "/app.js";

let view = null; // GET /api/homekit

export function mount(el) {
  if (!el) return null;
  el.outerHTML = panel("Apple Home", `<span id="hk-sub">…</span>`, `<label class="check"><input type="checkbox" id="hk-on"> On</label>`, `<div class="pb stack" id="hk">
    <p class="muted" style="margin:0">Tempolight appears in Apple's Home app as a light (power, brightness, colour), a <b>Music reactive</b> switch and one switch per scene, so <i>“Hey Siri, turn on Party mode”</i> works. Your iPhone must be on the same network.</p>
    <div class="pb phones" id="hk-pair" hidden style="padding:0"><div class="qr" id="hk-qr" aria-live="polite"></div><div class="stack">
      <div><span class="lbl">Setup code</span><div class="mono" id="hk-code" style="font-size:24px;letter-spacing:2px"></div></div>
      <p class="faint" style="font-size:13px;margin:0">In the Home app: <b>+</b> → <b>Add Accessory</b>, then scan the code, or choose <b>More options…</b> and pick <b id="hk-name"></b>. The Home app warns that it isn't certified: that's expected, choose <b>Add Anyway</b>.</p>
    </div></div>
    <div id="hk-paired" hidden><span class="lbl">Paired with</span><ul id="hk-list" style="margin:4px 0 0 18px;padding:0"></ul>
      <p class="faint" style="font-size:13px;margin:6px 0 0">To add more people, share your home in the Home app. To move Tempolight to another home, remove it from the Home app, then reset the pairing here.</p></div>
    <p class="faint" id="hk-err" style="font-size:13px;margin:0" hidden></p>
    <div class="row"><button class="btn sm danger" id="hk-reset" type="button">Reset pairing</button></div>
  </div>`, "span-6");
  const fill = async () => {
    if (!view || !$("#hk-on")) return;
    $("#hk-on").checked = view.enabled;
    $("#hk-sub").textContent = !view.enabled ? "Off" : view.state === "error" ? "Problem" : view.state !== "ready" ? "Starting…" : view.paired ? "Paired" : "Ready to pair";
    const showPair = view.enabled && view.state === "ready" && !view.paired; $("#hk-pair").hidden = !showPair;
    $("#hk-code").textContent = view.setupCode; $("#hk-name").textContent = view.name;
    $("#hk-paired").hidden = !view.paired;
    $("#hk-list").innerHTML = view.pairings.map(p => `<li><span class="mono" style="font-size:13px">${esc(p.id)}</span>${p.admin ? " (owner)" : ""}</li>`).join("");
    const err = view.error || (view.enabled && view.mdnsError ? `iPhones may not find Tempolight: ${view.mdnsError}` : ""); $("#hk-err").hidden = !err; $("#hk-err").textContent = err;
    if (showPair) { const { qrSvg } = await import("/qr.js"), box = $("#hk-qr"); if (box && box.dataset.uri !== view.setupUri) { box.dataset.uri = view.setupUri; box.innerHTML = qrSvg(view.setupUri, { px: 4 }); } }
  };
  const load = async () => { view = await api("GET", "/api/homekit").catch(() => null); fill(); };
  $("#hk-on").onchange = e => act(() => api("PATCH", "/api/homekit", { enabled: e.target.checked }), e.target.checked ? "Apple Home is on" : "Apple Home is off").then(v => { view = v; fill(); }).catch(() => load());
  $("#hk-reset").onclick = () => { if (!confirm("Reset the Apple Home pairing? Tempolight gets a new setup code and the Home app loses it: remove the old Tempolight there and add it again.")) return;
    act(() => api("POST", "/api/homekit/reset"), "Pairing reset").then(v => { view = v; fill(); }).catch(() => {}); };
  load();
  return { load };
}
