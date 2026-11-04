// The setup wizard: five big, picture-first steps that get a new user from nothing to lights moving with music.
//   1 find the lights   2 pick a room   3 how Tempolight hears your music (not in the online demo)   4 fix the timing
//   5 play a test song   6 done (and an optional PIN)
// It opens by itself on a first start with no lights, and again from Settings ("Run setup again"). Finishing or
// skipping it sets settings.setupDone, so it doesn't come back by itself. Works in the online demo too.
import { app, api, act, toast, ws, refreshState, loadLayout, createPreview, unlocked, route, esc, DEMO } from "/app.js";
import { buildPreset } from "/engine/presets.js";
import { buildLayout } from "/engine/layout.js";
import { createRenderer } from "/preview.js";
import "/latency.js"; // loads the stylesheet the wizard shares with the latency meter

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const I = { // icons, 24 x 24 strokes
  lights: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z",
  room: "M3 5h18v14H3zM3 10h18M9 10v9", timing: "M12 8v5l3 2M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM9 2h6",
  music: "M9 18V6l11-2v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", done: "M5 12.5l4.5 4.5L19 7",
  wifi: "M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01", plus: "M12 5v14M5 12h14",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", play: "M7 4l13 8-13 8z", stop: "M6 6h12v12H6z",
  lock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11", mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM5 11a7 7 0 0 0 14 0M12 18v3",
  ear: "M6 9a6 6 0 0 1 12 0c0 3-2 4-3 5.5S14 18 12 19.5a2.5 2.5 0 0 1-4-1M9 9a3 3 0 0 1 6 0c0 1.5-1.5 2-1.5 3.5",
  x: "M6 6l12 12M18 6L6 18", back: "M15 5l-7 7 7 7", next: "M9 5l7 7-7 7", search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8",
};
const ic = (n, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${I[n]}"/></svg>`;
const STEPS = [
  { id: "lights", icon: "lights", title: "Find your lights" },
  { id: "room", icon: "room", title: "Pick your room" },
  { id: "hear", icon: "ear", title: "How should Tempolight hear your music?" },
  { id: "timing", icon: "timing", title: "Fix the timing" },
  { id: "song", icon: "music", title: "Play a test song" },
  { id: "done", icon: "done", title: "All set" },
].filter(s => !(DEMO && s.id === "hear")); // the demo can't record this computer's sound: the Music page explains

let W = null; // the open wizard

/** Should the wizard open by itself? A first start (or every light removed) that hasn't finished or skipped setup. */
export const wantsWizard = st => !!st && !st.settings.setupDone && !st.devices.length && (!st.locked || !!app.token);

export function openWizard(at = 0) {
  if (W) return W; if (!unlocked()) { toast("Unlock in Settings first", true); return null; }
  const root = document.createElement("div"); root.className = "wz"; root.id = "wizard";
  root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-labelledby", "wz-title");
  root.innerHTML = `<div class="wz-top"><span class="wz-brand"><span class="lamp"></span>Tempolight</span>
      <ol class="wz-dots" aria-label="Progress">${STEPS.map((s, i) => `<li data-dot="${i}" title="${esc(s.title)}"><span class="sr">${esc(s.title)}</span></li>`).join("")}</ol>
      <button class="wz-x" id="wz-close" type="button" aria-label="Skip setup" title="Skip setup">${ic("x")}<span>Skip setup</span></button></div>
    <div class="wz-body" id="wz-body"></div>
    <div class="wz-foot"><button class="wz-btn ghost" id="wz-back" type="button">${ic("back")}<span>Back</span></button>
      <button class="wz-btn ghost" id="wz-skip" type="button"><span>Skip</span></button>
      <button class="wz-btn primary" id="wz-next" type="button"><span>Next</span>${ic("next")}</button></div>`;
  document.body.appendChild(root); document.body.classList.add("wz-open");
  W = { root, i: -1, cleanup: [], step: null };
  $("#wz-close").onclick = () => finish(false);
  $("#wz-back").onclick = () => show(W.i - 1);
  $("#wz-skip").onclick = () => show(W.i + 1);
  $("#wz-next").onclick = () => W.i === STEPS.length - 1 ? finish(true) : show(W.i + 1);
  root.addEventListener("keydown", e => { if (e.key === "Escape") finish(false); });
  show(at);
  return W;
}
export function closeWizard() {
  if (!W) return; for (const f of W.cleanup) { try { f(); } catch {} }
  W.root.remove(); document.body.classList.remove("wz-open"); W = null;
  if (!app.page?.preview) ws.send({ type: "preview", on: false });
}
async function finish(completed) {
  try { await api("PATCH", "/api/settings", { setupDone: true }); await refreshState(); } catch {}
  closeWizard(); if (completed) { toast("You're all set"); location.hash = "#/home"; } route();
}
/** Status updates from app.js, four times a second. */
export function wizardStatus(m) { W?.step?.onStatus?.(m); }

function show(i) {
  if (!W) return; i = Math.max(0, Math.min(STEPS.length - 1, i));
  for (const f of W.cleanup) { try { f(); } catch {} } W.cleanup = [];
  W.i = i; const s = STEPS[i], body = $("#wz-body");
  $$(".wz-dots li", W.root).forEach((d, k) => { d.className = k < i ? "done" : k === i ? "on" : ""; d.toggleAttribute("aria-current", k === i); });
  body.innerHTML = `<div class="wz-step" data-step="${s.id}"><div class="wz-hero">${ic(s.icon, "big")}</div><h2 id="wz-title" tabindex="-1">${esc(s.title)}</h2><div class="wz-content" id="wz-content"></div></div>`;
  $("#wz-back").style.visibility = i === 0 ? "hidden" : "";
  $("#wz-skip").hidden = i === STEPS.length - 1;
  $("#wz-next").querySelector("span").textContent = i === STEPS.length - 1 ? "Start the show" : "Next";
  W.step = ({ lights: stepLights, room: stepRoom, hear: stepHear, timing: stepTiming, song: stepSong, done: stepDone })[s.id]($("#wz-content")) || {};
  body.scrollTop = 0; $("#wz-title").focus?.();
}
const setNext = (on, label) => { const b = $("#wz-next"); if (!b) return; b.disabled = !on; if (label) b.querySelector("span").textContent = label; };

// ---------------------------------------------------------------- 1. lights
function stepLights(el) {
  el.innerHTML = `<div class="wz-scan" id="wz-scan"><span class="wz-pulse">${ic("search")}</span><span id="wz-scanmsg">Looking for lights…</span></div>
    <div class="wz-tiles" id="wz-found"></div>
    <div class="wz-tiles">
      <button class="wz-tile" id="wz-virtual" type="button">${ic("eye")}<b>Try without lights</b><small>A pretend room on screen</small></button>
      <button class="wz-tile" id="wz-manual" type="button">${ic("plus")}<b>Type an address</b><small>From the WLED app</small></button>
    </div>
    <div class="wz-ip" id="wz-ipbox" hidden><input id="wz-ip" inputmode="decimal" autocomplete="off" placeholder="192.168.1.42" aria-label="IP address"><button class="wz-btn primary" id="wz-ipadd" type="button">Add</button></div>
    <p class="wz-have" id="wz-have"></p>`;
  const have = () => { const d = app.state.devices; $("#wz-have").innerHTML = d.length ? `${ic("done", "ok")} ${d.length} light${d.length > 1 ? "s" : ""} ready: ${d.map(x => esc(x.name)).join(", ")}` : ""; setNext(d.length > 0); };
  const added = async () => { await refreshState(); await loadLayout(); have(); };
  let found = [];
  const SMART = { lifx: "LIFX", wiz: "WiZ", kasa: "TP-Link Kasa", yeelight: "Yeelight", twinkly: "Twinkly" }; // smart lights from the scan
  const body = f => f.kind === "govee" || SMART[f.kind] ? { host: f.host, name: f.name, kind: f.kind } : f.kind === "openrgb" ? { host: f.host, name: f.name, kind: "openrgb", index: f.index, leds: f.leds } : { host: f.host, name: f.name, leds: f.leds, force: true };
  const kindName = f => f.kind === "govee" ? "Govee" : SMART[f.kind] ? SMART[f.kind] : f.kind === "openrgb" ? "PC lighting" : `WLED · ${f.leds ?? "?"} LEDs`;
  function tiles() {
    $("#wz-found").innerHTML = found.map((f, i) => `<button class="wz-tile found${f.added ? " sel" : ""}" type="button" data-wzf="${i}" aria-pressed="${!!f.added}">${ic(f.added ? "done" : "lights")}<b>${esc(f.name || "WLED")}</b><small>${esc(kindName(f))}</small></button>`).join("");
    $$("[data-wzf]").forEach(b => b.onclick = async () => { const f = found[Number(b.dataset.wzf)]; if (f.added) return; b.disabled = true;
      try { await act(() => api("POST", "/api/devices", body(f))); f.added = true; await added(); } catch {} tiles(); });
  }
  async function scan() {
    $("#wz-scan").classList.add("busy"); $("#wz-scanmsg").textContent = "Looking for lights…";
    try { found = await api("POST", "/api/discover", { scan: true }); } catch (e) { found = []; $("#wz-scanmsg").textContent = e.message; }
    if (!W || W.step !== me) return;
    $("#wz-scan").classList.remove("busy");
    const fresh = found.filter(f => !f.added).length;
    $("#wz-scanmsg").innerHTML = found.length ? `Found ${found.length}. Tap to add${fresh > 1 ? ` <button class="wz-link" id="wz-all" type="button">add all</button>` : ""}` : `None found <button class="wz-link" id="wz-again" type="button">look again</button>`;
    if ($("#wz-again")) $("#wz-again").onclick = scan;
    if ($("#wz-all")) $("#wz-all").onclick = async () => { for (const f of found.filter(x => !x.added)) { try { await api("POST", "/api/devices", body(f)); f.added = true; } catch {} } await added(); tiles(); };
    tiles();
  }
  $("#wz-virtual").onclick = async () => { $("#wz-virtual").disabled = true;
    try { if (!app.state.devices.some(d => d.virtual)) await act(() => api("POST", "/api/devices", { virtual: true, name: "Virtual room" })); await added(); show(1); } catch {} finally { if ($("#wz-virtual")) $("#wz-virtual").disabled = false; } };
  $("#wz-manual").onclick = () => { $("#wz-ipbox").hidden = false; $("#wz-ip").focus(); };
  const addIp = async () => { const host = $("#wz-ip").value.trim(); if (!host) return $("#wz-ip").focus();
    try { await act(() => api("POST", "/api/devices", { host }), "Light added"); $("#wz-ip").value = ""; await added(); }
    catch (e) { if (/add it anyway/.test(e.message) && confirm(e.message + "\n\nAdd it anyway?")) { await act(() => api("POST", "/api/devices", { host, force: true }), "Light added").catch(() => {}); await added(); } } };
  $("#wz-ipadd").onclick = addIp; $("#wz-ip").onkeydown = e => { if (e.key === "Enter") addIp(); };
  const me = {}; W.step = me; have(); scan();
  return me;
}

// ---------------------------------------------------------------- 2. room
function stepRoom(el) {
  const st = app.state, devs = st.devices.filter(d => d.enabled !== false);
  if (!devs.length) { el.innerHTML = `<p class="wz-say">Add a light first, or try without lights.</p><button class="wz-btn primary big" id="wz-goback" type="button">${ic("back")}<span>Find lights</span></button>`; $("#wz-goback").onclick = () => show(0); setNext(true); return {}; }
  el.innerHTML = `<div class="wz-presets" id="wz-presets">${st.presets.map(p => `<button class="wz-preset" type="button" data-wzp="${esc(p.id)}" aria-pressed="false" title="${esc(p.desc)}"><canvas width="320" height="180" aria-hidden="true"></canvas><b>${esc(p.name)}</b></button>`).join("")}</div>`;
  $$("[data-wzp]").forEach(b => { thumb(b.querySelector("canvas"), b.dataset.wzp, devs);
    b.onclick = async () => { $$("[data-wzp]").forEach(x => x.setAttribute("aria-pressed", "false")); b.setAttribute("aria-pressed", "true"); b.classList.add("busy");
      try { await act(() => api("POST", "/api/room/preset", { id: b.dataset.wzp })); await refreshState(); await loadLayout(); setNext(true); } catch { b.setAttribute("aria-pressed", "false"); } finally { b.classList.remove("busy"); } }; });
  setNext(true);
  return {};
}
/** A small picture of a preset, built with the user's own controllers and lit with a rainbow. */
function thumb(cv, id, devs) {
  try {
    const shapes = buildPreset(id, devs.map(d => ({ id: d.id, name: d.name, leds: d.leds || 120 }))), L0 = buildLayout(shapes.map(s => ({ ...s })));
    const L = { N: L0.N, x: L0.LX, y: L0.LY, shape: L0.LF, shapes }, f = new Uint8Array(L.N * 3);
    for (let i = 0; i < L.N; i++) { const h = (L.x[i] / 16 + L.shape[i] * 0.17) % 1, [r, g, b] = hsv(h, 0.85, 1); f[i * 3] = r; f[i * 3 + 1] = g; f[i * 3 + 2] = b; }
    createRenderer(cv).draw(L, f, 1);
  } catch {}
}
function hsv(h, s, v) { const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]; return [r * 230, g * 230, b * 230].map(Math.round); }

// ---------------------------------------------------------------- 3. hearing the music (hearing.js, also at the top of the Music page)
function stepHear(el) {
  el.innerHTML = `<p class="wz-say">For Spotify and other apps, Tempolight needs to hear the music the first time a song plays.</p><div id="wz-hear"></div>`;
  const me = { hr: null }; setNext(true);
  import("/hearing.js").then(mod => { if (!W || W.step !== me || !$("#wz-hear")) return; me.hr = mod.mountHearing($("#wz-hear"), { bare: true, onFixTiming: () => show(STEPS.findIndex(s => s.id === "timing")) }); if (app.status) me.hr?.status(app.status); }).catch(() => {});
  W.cleanup.push(() => me.hr?.destroy()); W.step = me;
  me.onStatus = m => me.hr?.status(m);
  return me;
}

// ---------------------------------------------------------------- 4. timing
function stepTiming(el) {
  const can = !!navigator.mediaDevices?.getUserMedia;
  el.innerHTML = `<p class="wz-say">${ic("music", "inline")} Turn the speakers up. ${ic("mic", "inline")} Stay quiet for 5 seconds.</p>
    <button class="wz-btn primary big" id="wz-cal" type="button" ${can ? "" : "disabled"}>${ic("play")}<span>Start</span></button>
    <div class="wz-meter" aria-hidden="true"><i id="wz-calbar"></i></div><p class="wz-result" id="wz-calmsg" aria-live="polite">${can ? "" : "This browser can't use the microphone here. Skip this; you can do it later on the Music page."}</p>`;
  setNext(true);
  $("#wz-cal").onclick = async () => {
    const b = $("#wz-cal"), msg = $("#wz-calmsg"), bar = $("#wz-calbar"); b.disabled = true; msg.textContent = "Listening…"; msg.className = "wz-result";
    try {
      const r = await app.audio.calibrate(localStorage.getItem("tl.input") || "", p => { if (bar) bar.style.width = Math.round(p * 100) + "%"; });
      if (!$("#wz-calmsg")) return;
      if (!r.ok) { msg.textContent = r.heard ? "The clicks were hard to hear. Turn it up and try again, or skip." : "Nothing heard. Turn the speakers up and try again, or skip."; msg.className = "wz-result warn"; return; }
      const { offsetFromDelay } = await import("/calibrate.js"), off = offsetFromDelay(r.delayMs, r.reportedOutputMs);
      await api("PATCH", "/api/settings", { syncOffsetMs: off }); await refreshState();
      msg.innerHTML = `${ic("done", "ok")} Done. Speakers: ${Math.round(r.delayMs)} ms. Lights set ${off > 0 ? "+" : ""}${off} ms.`; msg.className = "wz-result ok"; setNext(true);
    } catch (e) { if ($("#wz-calmsg")) { msg.textContent = e.name === "NotAllowedError" ? "The microphone was refused. You can skip this." : `Couldn't measure: ${e.message}`; msg.className = "wz-result warn"; } }
    finally { if ($("#wz-cal")) { b.disabled = false; b.querySelector("span").textContent = "Again"; } }
  };
  return {};
}

// ---------------------------------------------------------------- 5. test song
function stepSong(el) {
  const A = app.audio;
  el.innerHTML = `<div class="stage wz-stage" id="wz-stage">${app.state.devices.length ? "" : '<div class="empty">No lights yet</div>'}</div>
    <div class="wz-play"><button class="wz-btn primary big" id="wz-play" type="button">${ic("play")}<span>Play</span></button>
      <div class="wz-now"><b id="wz-song">Test song</b><span class="faint" id="wz-songmeta">Watch the lights move</span></div></div>
    <div class="wz-meter" aria-hidden="true"><i id="wz-level"></i></div>`;
  const prev = app.state.devices.length ? createPreview($("#wz-stage")) : null; W.cleanup.push(() => prev?.destroy());
  let tick = 0;
  const playing = () => A.state.mode === "song" && A.state.song?.item?.url === "/demo.mp3";
  const paint = () => { const b = $("#wz-play"); if (!b) return; const on = playing() || (A.state.analysing && A.state.queue[A.state.index]?.url === "/demo.mp3");
    b.innerHTML = on ? `${ic("stop")}<span>Stop</span>` : `${ic("play")}<span>Play</span>`; b.setAttribute("aria-pressed", String(!!on)); };
  $("#wz-play").onclick = async () => {
    if (playing()) { A.stopSong(); paint(); return; }
    const i = A.state.queue.findIndex(q => q.url === "/demo.mp3");
    $("#wz-songmeta").textContent = "Getting it ready…";
    try { if (i >= 0) await A.playIndex(i); else { A.state.queue.push({ name: "Tempolight demo track", url: "/demo.mp3", buffer: null, analysis: null }); await A.playIndex(A.state.queue.length - 1); } } catch (e) { toast(e.message, true); }
    paint();
  };
  paint(); setNext(true);
  return {
    onStatus(m) {
      if (++tick % 8 === 0) ws.send({ type: "preview", on: true }); // a page change underneath may have turned the preview off
      const a = A.state, meta = $("#wz-songmeta"); if (!meta) return;
      if (a.analysing && a.queue[a.index]?.url === "/demo.mp3") meta.textContent = `Listening to it first… ${Math.round(a.analysing * 100)}%`;
      else if (playing() && m.source === "song") { $("#wz-song").textContent = m.song?.name || "Test song"; meta.textContent = `${m.bpm ? Math.round(m.bpm) + " BPM · " : ""}${m.effectName || ""}`; }
      else if (!playing()) meta.textContent = "Watch the lights move";
      const lv = $("#wz-level"); if (lv) lv.style.width = Math.round((m.level || 0) * 100) + "%";
      paint();
    },
  };
}

// ---------------------------------------------------------------- 6. done
function stepDone(el) {
  const locked = app.state.locked;
  el.innerHTML = `<p class="wz-say">Your lights now follow the music.</p>
    <div class="wz-pin">${ic("lock")}<div><b>Lock the settings?</b><small>Guests can still pick effects</small></div></div>
    ${locked ? `<p class="wz-result ok">${ic("done", "ok")} Locked with a PIN</p>` : `<div class="wz-ip"><input id="wz-pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" placeholder="PIN (4–8 digits)" aria-label="PIN, optional"><button class="wz-btn" id="wz-lock" type="button">Lock</button></div><p class="wz-result" id="wz-pinmsg"></p>`}`;
  setNext(true, "Start the show");
  if ($("#wz-lock")) $("#wz-lock").onclick = async () => {
    const pin = $("#wz-pin").value.trim(); if (!/^\d{4,8}$/.test(pin)) { $("#wz-pinmsg").textContent = "4 to 8 digits"; $("#wz-pinmsg").className = "wz-result warn"; return; }
    const r = await act(() => api("POST", "/api/lock", { pin }), "Locked. This device stays unlocked.").catch(() => null);
    if (r) { app.token = r.token; try { localStorage.setItem("tl.token", r.token); } catch {} ws.open = false; ws.sock?.close(); /* reconnect with the token */ await refreshState(); stepDone(el); }
  };
  return {};
}
