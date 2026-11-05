// Camera mapping page: point a phone (or laptop) camera at the lights; Tempolight lights the LEDs one at a time,
// finds each in the picture and builds the room shape from where they really are.
import { app, api, act, toast, esc, panel, opt, $, ws, loadLayout, refreshState } from "/app.js";
import { toGray, scan, sampleIndices, fillPositions, toStage } from "/mapping.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function mapPage(el) {
  // devices that can light single LEDs: not pretend ones, not switched off, not a Govee light that only takes one colour
  const st = app.state, devs = st.devices.filter(d => !d.virtual && d.enabled !== false && d.leds > 1 && !(d.kind === "govee" && d.goveeMode !== "segments"));
  el.innerHTML = `${panel("Map with the camera", "Find out where every LED really is", `<a class="btn" href="#/room">Back to the room</a>`, `<div class="pb stack">
      <div class="mapview"><video id="mp-video" playsinline muted></video><canvas id="mp-dots" aria-hidden="true"></canvas><div class="empty" id="mp-hint">Press “Start camera” and point it at the lights.</div></div>
      <div class="row"><button class="btn" id="mp-cam" type="button">Start camera</button>
        <select id="mp-dev" aria-label="Controller" style="width:auto">${devs.map(d => opt(d.id, `${d.name} (${d.leds} LEDs)`)).join("")}</select>
        <select id="mp-n" aria-label="How many LEDs to look for" style="width:auto">${opt("40", "Quick (40 points)")}${opt("80", "Normal (80 points)", true)}${opt("200", "Detailed (200 points)")}</select>
        <button class="btn primary" id="mp-go" type="button" disabled>Map</button><button class="btn" id="mp-use" type="button" hidden>Use this layout</button></div>
      <div class="meter" aria-hidden="true"><i id="mp-prog" style="width:0%"></i></div><p id="mp-msg" class="muted" role="status"></p>
      <p class="faint" style="font-size:13px">Darken the room, hold the camera still (lean it on something) so all the lights you want are in the picture, and keep people out of view. Each LED lights up in turn for a moment; the strip between the points found is filled in. Works best with WLED, Govee and OpenRGB devices that show single LEDs.</p></div>`, "span-12")}`;
  if (!devs.length) { $("#mp-msg").textContent = "Add a controller with LEDs on the Devices page first (Govee lights need “segments” mode)."; $("#mp-cam").disabled = true; return {}; }
  const video = $("#mp-video"), dots = $("#mp-dots"), cv = document.createElement("canvas"), g = cv.getContext("2d", { willReadFrequently: true });
  let stream = null, running = false, result = null, gone = false, lock = null;
  const W = 160; let H = 120;
  const grab = () => { g.drawImage(video, 0, 0, W, H); return toGray(g.getImageData(0, 0, W, H).data); };
  const msg = t => { if (!gone) $("#mp-msg").textContent = t; };
  function draw(points) { if (gone) return; const r = video.getBoundingClientRect(); dots.width = r.width; dots.height = r.height; const c = dots.getContext("2d"); c.clearRect(0, 0, r.width, r.height);
    c.fillStyle = "#ff3d7f"; for (const p of points) if (p) { c.beginPath(); c.arc(p[0] * r.width, p[1] * r.height, 4, 0, 7); c.fill(); } }
  // hold the camera's exposure, white balance and focus still while it looks (where the camera allows it), and let go afterwards
  async function hold(on) { const t = stream?.getVideoTracks()[0], c = t?.getCapabilities?.() || {}, a = {};
    for (const k of ["exposureMode", "whiteBalanceMode", "focusMode"]) if (c[k]?.includes(on ? "manual" : "continuous")) a[k] = on ? "manual" : "continuous";
    if (Object.keys(a).length) await t.applyConstraints({ advanced: [a] }).catch(() => {}); lock = on; }
  $("#mp-cam").onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { msg(window.isSecureContext === false
      ? `The browser only allows the camera on a secure page, and ${location.host} isn't one. On a phone, open Tempolight over https (for example through a tunnel or a reverse proxy with a certificate), or use a laptop camera with Tempolight opened as http://localhost.`
      : "This browser has no camera access. Try Chrome or Safari."); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false }); }
    catch (e) { msg(e.name === "NotAllowedError" ? "Camera permission was refused. Allow the camera for this page in the browser's site settings and try again." : e.name === "NotFoundError" ? "No camera was found." : e.name === "NotReadableError" ? "The camera is busy in another app. Close it and try again." : `Couldn't start the camera: ${e.message}`); return; }
    if (gone) { stream.getTracks().forEach(t => t.stop()); return; }
    video.srcObject = stream; await video.play().catch(() => {}); $("#mp-hint").hidden = true; $("#mp-go").disabled = false; $("#mp-cam").hidden = true;
    H = Math.round(W * (video.videoHeight || 3) / (video.videoWidth || 4)); cv.width = W; cv.height = H; $(".mapview").style.aspectRatio = `${W} / ${H}`;
  };
  $("#mp-go").onclick = async () => {
    if (running) { running = false; return; }
    const dev = st.devices.find(d => d.id === $("#mp-dev").value), idx = sampleIndices(dev.leds, Number($("#mp-n").value));
    running = true; result = null; $("#mp-use").hidden = true; $("#mp-go").textContent = "Stop"; msg("Measuring how quickly the lights and the camera respond…");
    let samples = [], lost = false;
    try {
      ({ samples } = await scan({ idx, w: W, h: H, grab, sleep, now: () => performance.now(), settled: () => hold(true),
        light: led => ws.send({ type: "map", device: dev.id, led }), stopped: () => { if (!ws.open) lost = true; return !running || gone || lost; },
        onSample: (s, k) => { draw(s.map(x => x.p)); if (gone) return; $("#mp-prog").style.width = `${Math.round((k + 1) / idx.length * 100)}%`; msg(`LED ${idx[k] + 1} of ${dev.leds}: ${s.filter(x => x.p).length} found`); } }));
    } finally { ws.send({ type: "map", end: true }); running = false; if (lock) await hold(false); if (!gone) $("#mp-go").textContent = "Map again"; }
    if (gone) return;
    if (lost) { msg("The connection to Tempolight dropped, so the scan stopped. Wait until it says Connected, then press Map again."); return; }
    const found = samples.filter(s => s.p).length, pts = fillPositions(samples, Math.min(dev.leds, 8192));
    if (!pts) { msg("Hardly any LEDs were seen. Make the room darker, move the camera so the lights are in view, and try again."); return; }
    result = { dev, pts: toStage(pts, W / H) }; draw(pts); $("#mp-use").hidden = false;
    msg(`Found ${found} of ${samples.length} points${found < samples.length * 0.6 ? ". Some were missed, so parts are filled in as straight lines" : ""}. Press “Use this layout” to replace ${dev.name}'s shapes with it.`);
  };
  $("#mp-use").onclick = async () => {
    if (!result) return; const room = app.state.room, old = room.shapes.filter(s => s.dev === result.dev.id), shapes = room.shapes.filter(s => s.dev !== result.dev.id);
    const zone = old.length && old.every(s => s.zone === old[0].zone) ? old[0].zone || null : null; // the shapes it replaces were all in one zone: stay in it
    shapes.push({ type: "points", name: `${result.dev.name} (mapped)`, count: result.pts.length, dev: result.dev.id, rot: 0, start: 0, rev: false, from: 0, zone, pts: result.pts });
    const r = await act(() => api("PUT", "/api/room", { ...room, shapes }), "Room updated from the camera").catch(() => null);
    if (r) { await refreshState(); await loadLayout(); location.hash = "#/room"; }
  };
  return { destroy() { gone = true; running = false; ws.send({ type: "map", end: true }); if (stream) stream.getTracks().forEach(t => t.stop()); } };
}
