// Camera mapping page: point a phone (or laptop) camera at the lights; Tempolight lights the LEDs one at a time,
// finds each in the picture and builds the room shape from where they really are.
import { app, api, act, toast, esc, panel, opt, $, ws, loadLayout, refreshState } from "/app.js";
import { toGray, detectSpot, sampleIndices, fillPositions, toStage } from "/mapping.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function mapPage(el) {
  const st = app.state, devs = st.devices.filter(d => !d.virtual && d.leds > 0);
  el.innerHTML = `${panel("Map with the camera", "Find out where every LED really is", `<a class="btn" href="#/room">Back to the room</a>`, `<div class="pb stack">
      <div class="mapview"><video id="mp-video" playsinline muted></video><canvas id="mp-dots" aria-hidden="true"></canvas><div class="empty" id="mp-hint">Press “Start camera” and point it at the lights.</div></div>
      <div class="row"><button class="btn" id="mp-cam" type="button">Start camera</button>
        <select id="mp-dev" aria-label="Controller" style="width:auto">${devs.map(d => opt(d.id, `${d.name} (${d.leds} LEDs)`)).join("")}</select>
        <select id="mp-n" aria-label="How many LEDs to look for" style="width:auto">${opt("40", "Quick (40 points)")}${opt("80", "Normal (80 points)", true)}${opt("200", "Detailed (200 points)")}</select>
        <button class="btn primary" id="mp-go" type="button" disabled>Map</button><button class="btn" id="mp-use" type="button" hidden>Use this layout</button></div>
      <div class="meter" aria-hidden="true"><i id="mp-prog" style="width:0%"></i></div><p id="mp-msg" class="muted" role="status"></p>
      <p class="faint" style="font-size:12.5px">Darken the room, hold the camera still (lean it on something) so all the lights you want are in the picture, and keep people out of view. Each LED lights up in turn for a moment; the strip between the points found is filled in. Works best with WLED, Govee and OpenRGB devices that show single LEDs.</p></div>`, "span-12")}`;
  if (!devs.length) { $("#mp-msg").textContent = "Add a controller with LEDs on the Devices page first."; $("#mp-cam").disabled = true; return {}; }
  const video = $("#mp-video"), dots = $("#mp-dots"), cv = document.createElement("canvas"), g = cv.getContext("2d", { willReadFrequently: true });
  let stream = null, running = false, result = null;
  const W = 160; let H = 120;
  const grab = () => { g.drawImage(video, 0, 0, W, H); return toGray(g.getImageData(0, 0, W, H).data); };
  const avg = async k => { let acc = null; for (let i = 0; i < k; i++) { const f = grab(); if (!acc) acc = f; else for (let j = 0; j < f.length; j++) acc[j] += f[j]; await sleep(40); } for (let j = 0; j < acc.length; j++) acc[j] /= k; return acc; };
  const light = (device, led) => ws.send({ type: "map", device, led });
  function draw(points) { const r = video.getBoundingClientRect(); dots.width = r.width; dots.height = r.height; const c = dots.getContext("2d"); c.clearRect(0, 0, r.width, r.height);
    c.fillStyle = "#ff3d7f"; for (const p of points) if (p) { c.beginPath(); c.arc(p[0] * r.width, p[1] * r.height, 4, 0, 7); c.fill(); } }
  $("#mp-cam").onclick = async () => {
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false }); }
    catch (e) { $("#mp-msg").textContent = e.name === "NotAllowedError" ? "Camera permission was refused." : `Couldn't start the camera: ${e.message}. On a phone, open Tempolight from its https or localhost address.`; return; }
    video.srcObject = stream; await video.play().catch(() => {}); $("#mp-hint").hidden = true; $("#mp-go").disabled = false; $("#mp-cam").hidden = true;
    H = Math.round(W * (video.videoHeight || 3) / (video.videoWidth || 4)); cv.width = W; cv.height = H; $(".mapview").style.aspectRatio = `${W} / ${H}`;
  };
  $("#mp-go").onclick = async () => {
    if (running) { running = false; return; }
    const dev = st.devices.find(d => d.id === $("#mp-dev").value), idx = sampleIndices(dev.leds, Number($("#mp-n").value)), samples = [];
    running = true; result = null; $("#mp-use").hidden = true; $("#mp-go").textContent = "Stop";
    try {
      light(dev.id, -1); await sleep(600); const dark = await avg(4);
      for (let k = 0; k < idx.length && running; k++) {
        light(dev.id, idx[k]); await sleep(220); const f = await avg(2), p = detectSpot(f, dark, W, H);
        samples.push({ i: idx[k], p: p ? [p.x, p.y] : null }); draw(samples.map(s => s.p));
        $("#mp-prog").style.width = `${Math.round((k + 1) / idx.length * 100)}%`; $("#mp-msg").textContent = `LED ${idx[k] + 1} of ${dev.leds}: ${samples.filter(s => s.p).length} found`;
      }
    } finally { ws.send({ type: "map", end: true }); running = false; $("#mp-go").textContent = "Map again"; }
    const found = samples.filter(s => s.p).length, pts = fillPositions(samples, dev.leds);
    if (!pts) { $("#mp-msg").textContent = "Hardly any LEDs were seen. Make the room darker, move the camera so the lights are in view, and try again."; return; }
    result = { dev, pts: toStage(pts, W / H) }; draw(pts); $("#mp-use").hidden = false;
    $("#mp-msg").textContent = `Found ${found} of ${samples.length} points${found < samples.length * 0.6 ? ". Some were missed, so parts are filled in as straight lines" : ""}. Press “Use this layout” to replace ${dev.name}'s shapes with it.`;
  };
  $("#mp-use").onclick = async () => {
    if (!result) return; const shapes = st.room.shapes.filter(s => s.dev !== result.dev.id);
    shapes.push({ type: "points", name: `${result.dev.name} (mapped)`, count: result.pts.length, dev: result.dev.id, rot: 0, start: 0, rev: false, from: 0, pts: result.pts });
    const r = await act(() => api("PUT", "/api/room", { ...st.room, shapes }), "Room updated from the camera").catch(() => null);
    if (r) { await refreshState(); await loadLayout(); location.hash = "#/room"; }
  };
  return { destroy() { running = false; ws.send({ type: "map", end: true }); if (stream) stream.getTracks().forEach(t => t.stop()); } };
}
