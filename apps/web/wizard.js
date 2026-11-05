// The setup wizard (dashboard v2 onboarding): full screen, one question per step, big choice cards, and a live room on
// the right (on top on a phone) that comes alive as the steps are done:
//   1 find the lights → the lights appear   2 pick a room → the room draws itself   3 how Tempolight hears your music
//   (not in the online demo)   4 fix the timing → the room pulses on the beat   5 play a test song → the room plays
//   6 done (and an optional PIN), then the Stage with three short tips (once).
// It opens by itself on a first start with no lights, and again from Settings ("Run setup again"). Finishing or
// skipping it sets settings.setupDone, so it doesn't come back by itself. Works in the online demo too.
import { app, api, act, toast, ws, refreshState, loadLayout, unlocked, route, esc, DEMO } from "/app.js";
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
  chat: "M4 5h16v11H9l-5 4zM8 9.5h8M8 12.5h5", speaker: "M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12",
  hush: "M4 9h4l5-4v14l-5-4H4zM16 9.5l5 5M21 9.5l-5 5",
};
const ic = (n, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${I[n]}"/></svg>`;
const STEPS = [
  { id: "lights", title: "Find your lights", say: "Tempolight looks for WLED and smart lights on your network. Tap a light to add it." },
  { id: "room", title: "Pick your room", say: "Choose the shape closest to where your lights hang. You can draw it exactly later, on the Lights screen." },
  { id: "hear", title: "Choose how Tempolight hears your music", say: "For Spotify and other apps, Tempolight needs to hear the music the first time a song plays." },
  { id: "timing", title: "Fix the timing", say: "Tempolight plays a few clicks and listens with the microphone, so every flash lands on the beat." },
  { id: "song", title: "Play a test song", say: "Watch the room follow the beat, the build-up and the drop." },
  { id: "done", title: "All set", say: "Your lights now follow the music. Play anything and the room follows it." },
].filter(s => !(DEMO && s.id === "hear")); // the demo can't record this computer's sound: the Songs screen explains

let W = null; // the open wizard

/** Should the wizard open by itself? A first start (or every light removed) that hasn't finished or skipped setup. */
export const wantsWizard = st => !!st && !st.settings.setupDone && !st.devices.length && (!st.locked || !!app.token);

export function openWizard(at = 0) {
  if (W) return W; if (!unlocked()) { toast("Unlock in Settings first", true); return null; }
  const root = document.createElement("div"); root.className = "wz"; root.id = "wizard";
  root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-labelledby", "wz-title");
  // one dot per question; the last step (done) keeps an invisible one so the progress always has a current step
  root.innerHTML = `<div class="wz-top"><span class="wz-brand"><span class="lamp"></span>Tempolight</span>
      <ol class="wz-dots" aria-label="Progress">${STEPS.map((s, i) => `<li data-dot="${i}"${s.id === "done" ? ' class="end"' : ""} title="${esc(s.title)}"><span class="sr">${esc(s.title)}</span></li>`).join("")}</ol>
      <button class="wz-x" id="wz-close" type="button" aria-label="Skip setup" title="Skip setup">${ic("x")}<span>Skip setup</span></button></div>
    <div class="wz-main">
      <aside class="wz-side" aria-label="Your room, live">
        <div class="wz-room" id="wz-stage"><div class="wz-cv"><canvas id="wz-cv" aria-hidden="true"></canvas></div>
          <ol class="wz-trail" id="wz-trail" aria-label="Done so far">${["Lights", "Room", "Timing", "Test song"].map((t, k) => `<li data-trail="${["lights", "room", "timing", "song"][k]}">${ic("done")}<span>${t}</span></li>`).join("")}</ol>
          <div class="wz-np" aria-live="polite"><div class="wz-np-t"><b id="wz-cap">Your room</b><span id="wz-capsub">No lights yet</span></div><span class="wz-chip" id="wz-chip" hidden></span></div>
        </div>
      </aside>
      <div class="wz-pane">
        <div class="wz-body" id="wz-body"></div>
        <div class="wz-foot"><button class="wz-btn ghost" id="wz-back" type="button">${ic("back")}<span>Back</span></button>
          <button class="wz-btn ghost" id="wz-skip" type="button"><span>Skip</span></button>
          <button class="wz-btn primary" id="wz-next" type="button"><span>Next</span>${ic("next")}</button></div>
      </div>
    </div>`;
  document.body.appendChild(root); document.body.classList.add("wz-open");
  W = { root, i: -1, cleanup: [], step: null, done: { lights: false, room: false, timing: false, song: false }, room: null };
  $("#wz-close").onclick = () => finish(false);
  $("#wz-back").onclick = () => show(W.i - 1);
  $("#wz-skip").onclick = () => show(W.i + 1);
  $("#wz-next").onclick = () => W.i === STEPS.length - 1 ? finish(true) : show(W.i + 1);
  root.addEventListener("keydown", e => { if (e.key === "Escape") finish(false); });
  W.room = mountRoom($("#wz-cv"));
  loadLayout().catch(() => {}).then(() => { if (W) { W.done.lights = app.state.devices.length > 0; if (W.done.lights) W.room.lit(true); trail(); } });
  show(at);
  return W;
}
export function closeWizard() {
  if (!W) return; for (const f of W.cleanup) { try { f(); } catch {} }
  W.room?.destroy(); W.root.remove(); document.body.classList.remove("wz-open"); W = null;
  if (!app.page?.preview) ws.send({ type: "preview", on: false });
}
async function finish(completed) {
  try { await api("PATCH", "/api/settings", { setupDone: true }); await refreshState(); } catch {}
  closeWizard(); if (completed) { toast("You're all set"); location.hash = "#/stage"; } route();
  if (completed) coach();
}
/** Status updates from app.js, four times a second. */
export function wizardStatus(m) { W?.step?.onStatus?.(m); W?.room?.status(m); }

function show(i) {
  if (!W) return; i = Math.max(0, Math.min(STEPS.length - 1, i));
  for (const f of W.cleanup) { try { f(); } catch {} } W.cleanup = [];
  W.i = i; const s = STEPS[i], body = $("#wz-body");
  $$(".wz-dots li", W.root).forEach((d, k) => { d.classList.toggle("done", k < i); d.classList.toggle("on", k === i); d.toggleAttribute("aria-current", k === i); });
  W.root.dataset.step = s.id;
  body.innerHTML = `<div class="wz-step" data-step="${s.id}"><h2 id="wz-title" tabindex="-1">${esc(s.title)}</h2><p class="wz-say">${esc(s.say)}</p><div class="wz-content" id="wz-content"></div></div>`;
  $("#wz-back").style.visibility = i === 0 ? "hidden" : "";
  $("#wz-skip").hidden = i === STEPS.length - 1;
  $("#wz-next").querySelector("span").textContent = i === STEPS.length - 1 ? "Start the show" : "Next";
  W.step = ({ lights: stepLights, room: stepRoom, hear: stepHear, timing: stepTiming, song: stepSong, done: stepDone })[s.id]($("#wz-content")) || {};
  W.room.mode(s.id);
  body.scrollTop = 0; $("#wz-title").focus?.({ preventScroll: true });
}
const setNext = (on, label) => { const b = $("#wz-next"); if (!b) return; b.disabled = !on; if (label) b.querySelector("span").textContent = label; };
function trail() { if (!W) return; for (const [k, v] of Object.entries(W.done)) $(`[data-trail="${k}"]`, W.root)?.classList.toggle("ok", !!v); }
const mark = k => { if (!W || W.done[k]) return; W.done[k] = true; trail(); };

// ---------------------------------------------------------------- the live room (left on a phone: on top)
// Before the test song it is a simulation drawn with the real room layout: dark tape with no lights, warm light when
// lights are added, a sweep along every strip when a room is picked, a pulse on the beat while fixing the timing.
// From the test song on, it shows the real frames the lights get.
function mountRoom(cv) {
  const R = createRenderer(cv), ghost = ghostLayout();
  let raf = 0, alive = true, mode = "lights", litAt = 0, drawAt = 0, t0 = performance.now(), last = 0, buf = null, beatMs = 500, m = null;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const A = [255, 94, 58], B = [255, 182, 72], C = [255, 61, 120];
  const mix = (a, b, f) => a.map((v, k) => v + (b[k] - v) * f);
  function frameFor(L, now) {
    if (!buf || buf.length !== L.N * 3) buf = new Uint8Array(L.N * 3);
    const t = (now - t0) / 1000, appear = reduce ? 1 : Math.min(1, (now - litAt) / 900), sweep = reduce || !drawAt ? 1 : Math.min(1, (now - drawAt) / 1500);
    const ph = ((now - t0) % beatMs) / beatMs, pulse = Math.exp(-ph * 4.2), pulsing = mode === "timing" || (mode === "hear" && W?.done.timing);
    for (let i = 0; i < L.N; i++) {
      const u = L.N > 1 ? i / (L.N - 1) : 0, x = (L.x[i] / 16 + t * 0.025) % 1, w = x < .5 ? x * 2 : (1 - x) * 2;
      let c = w < .6 ? mix(A, B, w / .6) : mix(B, C, (w - .6) / .4), v = .62 + .12 * Math.sin(t * 1.4 + i * .045);
      if (pulsing && !reduce) v = .16 + .84 * pulse;
      if (sweep < 1) { const d = sweep * 1.08 - u; if (d < 0) v = 0; else if (d < .06) { const h = 1 - d / .06; c = mix(c, [255, 240, 220], h * .8); v = Math.max(v, .6 + .4 * h); } }
      v *= appear; buf[i * 3] = c[0] * v; buf[i * 3 + 1] = c[1] * v; buf[i * 3 + 2] = c[2] * v;
    }
    return buf;
  }
  function tick(now) {
    if (!alive) return; raf = requestAnimationFrame(tick);
    if (now - last < 32) return; last = now;
    const box = cv.parentElement.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(Math.min(box.width, box.height * 16 / 9))), h = Math.round(w * 9 / 16); // the room is 16 x 9
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + "px"; cv.style.height = h + "px"; }
    const live = (mode === "song" || mode === "done") && app.layout?.N && app.frame?.length === app.layout.N * 3;
    if (live) { R.draw(app.layout, app.frame, dpr); return; }
    const L = app.state.devices.length && app.layout?.N ? app.layout : ghost;
    R.draw(L, L === ghost ? null : frameFor(L, now), dpr);
  }
  raf = requestAnimationFrame(tick);
  const cap = (t, sub, chip) => { if (!W) return; $("#wz-cap").textContent = t; $("#wz-capsub").textContent = sub || ""; const c = $("#wz-chip"); c.hidden = !chip; if (chip) c.innerHTML = `<i></i>${esc(chip)}`; };
  function caption() {
    if (!W) return; const d = app.state.devices, room = app.state.presets?.find(p => p.id === W.roomId);
    if (!d.length) return cap("Your room", "No lights yet");
    const lights = `${d.length} light${d.length > 1 ? "s" : ""}${app.layout?.N ? ` · ${app.layout.N} LEDs` : ""}`;
    if ((mode === "song" || mode === "done") && m?.source === "song" && m.song) return cap(m.song.name || "Test song", [m.bpm ? `${Math.round(m.bpm)} BPM` : "", m.effectName].filter(Boolean).join(" · "), "Playing");
    if (mode === "timing" || W.done.timing) return cap(room ? room.name : "Your room", lights, W.done.timing ? "On the beat" : "Pulsing at 120 BPM");
    return cap(room ? room.name : "Your room", lights, W.done.lights ? "Lights ready" : "");
  }
  return {
    lit(fresh) { if (fresh) litAt = performance.now(); caption(); },
    drawIn() { drawAt = performance.now(); caption(); },
    mode(id) { mode = id; if (id === "song" || id === "done") ws.send({ type: "preview", on: true }); caption(); },
    status(s) { m = s; if (W && W.i >= 0) caption(); },
    caption, destroy() { alive = false; cancelAnimationFrame(raf); },
  };
}
/** The empty room before any light is added: the TV-wall shape, drawn as dark tape. */
function ghostLayout() {
  try { const shapes = buildPreset("tv", [{ id: "g", name: "", leds: 300 }]), L0 = buildLayout(shapes.map(s => ({ ...s }))); return { N: L0.N, x: L0.LX, y: L0.LY, shape: L0.LF, shapes }; }
  catch { return { N: 0, x: [], y: [], shape: [], shapes: [] }; }
}

// ---------------------------------------------------------------- 1. lights
function stepLights(el) {
  el.innerHTML = `<div class="wz-scan" id="wz-scan"><span class="wz-pulse">${ic("search")}</span><span id="wz-scanmsg">Looking for lights…</span></div>
    <div class="wz-tiles" id="wz-found"></div>
    <div class="wz-tiles">
      <button class="wz-tile" id="wz-virtual" type="button"><span class="wz-tic">${ic("eye")}</span><b>Try without lights</b><small>A pretend room on screen</small></button>
      <button class="wz-tile" id="wz-manual" type="button"><span class="wz-tic">${ic("plus")}</span><b>Type an address</b><small>From the WLED app</small></button>
    </div>
    <div class="wz-ip" id="wz-ipbox" hidden><input id="wz-ip" inputmode="decimal" autocomplete="off" placeholder="192.168.1.42" aria-label="IP address"><button class="wz-btn primary" id="wz-ipadd" type="button">Add</button></div>
    <p class="wz-have" id="wz-have"></p>
    <button class="wz-claude" id="wz-claude" type="button"><span class="wz-cmark">${ic("chat")}</span><span><b>Let Claude set it up</b><small>Copy a prompt for Claude Code or the Claude app, and it walks through every step with you</small></span>${ic("next")}</button>`;
  const have = () => { const d = app.state.devices; $("#wz-have").innerHTML = d.length ? `${ic("done", "ok")} ${d.length} light${d.length > 1 ? "s" : ""} ready: ${d.map(x => esc(x.name)).join(", ")}` : ""; setNext(d.length > 0); };
  const added = async () => { const was = W.done.lights; await refreshState(); await loadLayout(); have(); if (app.state.devices.length) { mark("lights"); W.room.lit(!was); } };
  let found = [];
  const SMART = { lifx: "LIFX", wiz: "WiZ", kasa: "TP-Link Kasa", yeelight: "Yeelight", twinkly: "Twinkly" }; // smart lights from the scan
  const body = f => f.kind === "govee" || SMART[f.kind] ? { host: f.host, name: f.name, kind: f.kind } : f.kind === "openrgb" ? { host: f.host, name: f.name, kind: "openrgb", index: f.index, leds: f.leds } : { host: f.host, name: f.name, leds: f.leds, force: true };
  const kindName = f => f.kind === "govee" ? "Govee" : SMART[f.kind] ? SMART[f.kind] : f.kind === "openrgb" ? "PC lighting" : `WLED · ${f.leds ?? "?"} LEDs`;
  function tiles() {
    $("#wz-found").innerHTML = found.map((f, i) => `<button class="wz-tile found${f.added ? " sel" : ""}" type="button" data-wzf="${i}" aria-pressed="${!!f.added}"><span class="wz-tic">${ic(f.added ? "done" : "lights")}</span><b>${esc(f.name || "WLED")}</b><small>${esc(kindName(f))}${f.added ? " · added" : ""}</small></button>`).join("");
    $$("[data-wzf]").forEach(b => b.onclick = async () => { const f = found[Number(b.dataset.wzf)]; if (f.added) return; b.disabled = true;
      try { await act(() => api("POST", "/api/devices", body(f))); f.added = true; await added(); } catch {} tiles(); });
  }
  async function scan() {
    $("#wz-scan").classList.add("busy"); $("#wz-scanmsg").textContent = "Looking for lights…";
    try { found = await api("POST", "/api/discover", { scan: true }); } catch (e) { found = []; $("#wz-scanmsg").textContent = e.message; }
    if (!W || W.step !== me) return;
    $("#wz-scan").classList.remove("busy");
    const fresh = found.filter(f => !f.added).length;
    $("#wz-scanmsg").innerHTML = found.length ? `Found ${found.length}. Tap to add${fresh > 1 ? ` <button class="wz-link" id="wz-all" type="button">Add all</button>` : ""}` : `None found on this network <button class="wz-link" id="wz-again" type="button">Look again</button>`;
    if ($("#wz-again")) $("#wz-again").onclick = scan;
    if ($("#wz-all")) $("#wz-all").onclick = async () => { for (const f of found.filter(x => !x.added)) { try { await api("POST", "/api/devices", body(f)); f.added = true; } catch {} } await added(); tiles(); };
    tiles();
  }
  $("#wz-virtual").onclick = async () => { $("#wz-virtual").disabled = true;
    try { if (!app.state.devices.some(d => d.virtual)) await act(() => api("POST", "/api/devices", { virtual: true, name: "Virtual room" })); await added(); show(1); } catch {} finally { if ($("#wz-virtual")) $("#wz-virtual").disabled = false; } };
  $("#wz-claude").onclick = () => import("/claude-setup.js").then(m => m.openClaudeSetup()).catch(e => toast(e.message, true));
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
  if (!devs.length) { el.innerHTML = `<div class="wz-empty"><p>Add a light first, or try without lights.</p><button class="wz-btn primary big" id="wz-goback" type="button">${ic("back")}<span>Find lights</span></button></div>`; $("#wz-goback").onclick = () => show(0); setNext(true); return {}; }
  el.innerHTML = `<div class="wz-presets" id="wz-presets">${st.presets.map(p => `<button class="wz-preset" type="button" data-wzp="${esc(p.id)}" aria-pressed="${W.roomId === p.id}" title="${esc(p.desc)}"><canvas width="320" height="180" aria-hidden="true"></canvas><b>${esc(p.name)}</b></button>`).join("")}</div>`;
  $$("[data-wzp]").forEach(b => { thumb(b.querySelector("canvas"), b.dataset.wzp, devs);
    b.onclick = async () => { $$("[data-wzp]").forEach(x => x.setAttribute("aria-pressed", "false")); b.setAttribute("aria-pressed", "true"); b.classList.add("busy");
      try { await act(() => api("POST", "/api/room/preset", { id: b.dataset.wzp })); await refreshState(); await loadLayout(); W.roomId = b.dataset.wzp; mark("room"); W.room.drawIn(); setNext(true); }
      catch { b.setAttribute("aria-pressed", "false"); } finally { b.classList.remove("busy"); } }; });
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

// ---------------------------------------------------------------- 3. hearing the music (hearing.js, also on the Songs screen)
function stepHear(el) {
  el.innerHTML = `<div id="wz-hear"></div>`;
  const me = { hr: null }; setNext(true);
  import("/hearing.js").then(mod => { if (!W || W.step !== me || !$("#wz-hear")) return; me.hr = mod.mountHearing($("#wz-hear"), { bare: true, onFixTiming: () => show(STEPS.findIndex(s => s.id === "timing")) }); if (app.status) me.hr?.status(app.status); }).catch(() => {});
  W.cleanup.push(() => me.hr?.destroy()); W.step = me;
  me.onStatus = m => me.hr?.status(m);
  return me;
}

// ---------------------------------------------------------------- 4. timing
function stepTiming(el) {
  const can = !!navigator.mediaDevices?.getUserMedia;
  el.innerHTML = `<div class="wz-howto">
      <div class="wz-how"><span class="wz-tic">${ic("speaker")}</span><b>Turn the speakers up</b><small>To about the level you listen at</small></div>
      <div class="wz-how"><span class="wz-tic">${ic("hush")}</span><b>Stay quiet for 5 seconds</b><small>The microphone listens for the clicks</small></div>
    </div>
    <div class="wz-act"><button class="wz-btn primary big" id="wz-cal" type="button" ${can ? "" : "disabled"}>${ic("play")}<span>Start the clicks</span></button>
      <div class="wz-meter" aria-hidden="true"><i id="wz-calbar"></i></div></div>
    <p class="wz-result" id="wz-calmsg" aria-live="polite">${can ? "" : "This browser can't use the microphone here. Skip this; you can do it later on the Lights screen."}</p>`;
  setNext(true);
  $("#wz-cal").onclick = async () => {
    const b = $("#wz-cal"), msg = $("#wz-calmsg"), bar = $("#wz-calbar"); b.disabled = true; msg.textContent = "Listening…"; msg.className = "wz-result";
    try {
      const r = await app.audio.calibrate(localStorage.getItem("tl.input") || "", p => { if (bar) bar.style.width = Math.round(p * 100) + "%"; });
      if (!$("#wz-calmsg")) return;
      if (!r.ok) { msg.textContent = r.heard ? "The clicks were hard to hear. Turn it up and try again, or skip." : "Nothing heard. Turn the speakers up and try again, or skip."; msg.className = "wz-result warn"; return; }
      const { offsetFromDelay } = await import("/calibrate.js"), off = offsetFromDelay(r.delayMs, r.reportedOutputMs);
      await api("PATCH", "/api/settings", { syncOffsetMs: off }); await refreshState();
      msg.innerHTML = `${ic("done", "ok")} Done. Speakers: ${Math.round(r.delayMs)} ms. Lights set ${off > 0 ? "+" : ""}${off} ms.`; msg.className = "wz-result ok"; mark("timing"); W.room.caption(); setNext(true);
    } catch (e) { if ($("#wz-calmsg")) { msg.textContent = e.name === "NotAllowedError" ? "The microphone was refused. You can skip this." : `Couldn't measure: ${e.message}`; msg.className = "wz-result warn"; } }
    finally { if ($("#wz-cal")) { b.disabled = false; b.querySelector("span").textContent = "Play the clicks again"; } }
  };
  return {};
}

// ---------------------------------------------------------------- 5. test song
function stepSong(el) {
  const A = app.audio;
  el.innerHTML = `${app.state.devices.length ? "" : '<p class="wz-result warn">No lights yet: the song plays, but the room stays dark.</p>'}
    <div class="wz-player">
      <button class="wz-big" id="wz-play" type="button" aria-pressed="false" aria-label="Play the test song">${ic("play")}</button>
      <div class="wz-now"><b id="wz-song">Tempolight demo track</b><span id="wz-songmeta">Watch the lights move</span><div class="wz-meter" aria-hidden="true"><i id="wz-level"></i></div></div>
    </div>`;
  let tick = 0;
  const playing = () => A.state.mode === "song" && A.state.song?.item?.url === "/demo.mp3";
  const paint = () => { const b = $("#wz-play"); if (!b) return; const on = playing() || (A.state.analysing && A.state.queue[A.state.index]?.url === "/demo.mp3");
    b.innerHTML = on ? ic("stop") : ic("play"); b.setAttribute("aria-pressed", String(!!on)); b.setAttribute("aria-label", on ? "Stop the test song" : "Play the test song"); b.classList.toggle("on", !!on); };
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
      else if (playing() && m.source === "song") { $("#wz-song").textContent = m.song?.name || "Test song"; meta.textContent = `${m.bpm ? Math.round(m.bpm) + " BPM · " : ""}${m.effectName || ""}`; mark("song"); }
      else if (!playing()) meta.textContent = "Watch the lights move";
      const lv = $("#wz-level"); if (lv) lv.style.width = Math.round((m.level || 0) * 100) + "%";
      paint();
    },
  };
}

// ---------------------------------------------------------------- 6. done
function stepDone(el) {
  const locked = app.state.locked;
  el.innerHTML = `<div class="wz-pin"><span class="wz-tic">${ic("lock")}</span><div><b>Lock the settings</b><small>Optional. Guests can still pick looks and use the pads.</small></div></div>
    ${locked ? `<p class="wz-result ok">${ic("done", "ok")} Locked with a PIN</p>` : `<div class="wz-ip"><input id="wz-pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="8" placeholder="PIN, 4 to 8 digits" aria-label="PIN, optional"><button class="wz-btn" id="wz-lock" type="button">Lock</button></div><p class="wz-result" id="wz-pinmsg"></p>`}`;
  setNext(true, "Start the show");
  if ($("#wz-lock")) $("#wz-lock").onclick = async () => {
    const pin = $("#wz-pin").value.trim(); if (!/^\d{4,8}$/.test(pin)) { $("#wz-pinmsg").textContent = "4 to 8 digits"; $("#wz-pinmsg").className = "wz-result warn"; return; }
    const r = await act(() => api("POST", "/api/lock", { pin }), "Locked. This device stays unlocked.").catch(() => null);
    if (r) { app.token = r.token; try { localStorage.setItem("tl.token", r.token); } catch {} ws.open = false; ws.sock?.close(); /* reconnect with the token */ await refreshState(); stepDone(el); }
  };
  return {};
}

// ---------------------------------------------------------------- the Stage tips, once after setup
const TIPS = [
  { at: "#st-np", title: "What's playing", text: "The song, whether the lights are locked on the beat, and the song map with the next drop." },
  { at: ".st-look", title: "The look", text: "One look plays through the song. Try another look swaps it; Keep this look holds it." },
  { at: "#st-pads", title: "The pads", text: "Flash, strobe, black out or force a drop, by tap or by key. Strobe works while held." },
];
const COACH = "tl.coach";
/** Three tips over the Stage, one at a time. Shown once per browser; `force` shows them again. */
export async function coach(force = false) {
  try { if (!force && localStorage.getItem(COACH)) return; } catch {}
  for (let k = 0; k < 40 && !document.querySelector(TIPS[0].at); k++) await new Promise(r => setTimeout(r, 100));
  if (!document.querySelector(TIPS[0].at) || document.querySelector(".wz-coach")) return;
  const el = document.createElement("div"); el.className = "wz-coach"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "wz-coach-t");
  el.innerHTML = `<div class="wz-spot" aria-hidden="true"></div><div class="wz-tip"><span class="wz-tipn" id="wz-coach-n"></span><b id="wz-coach-t"></b><p id="wz-coach-p"></p>
    <div class="wz-tipa"><button class="wz-btn ghost" type="button" id="wz-coach-x">Skip the tips</button><button class="wz-btn primary" type="button" id="wz-coach-next">Next tip</button></div></div>`;
  document.body.appendChild(el);
  let k = 0, raf = 0;
  const spot = el.querySelector(".wz-spot"), tip = el.querySelector(".wz-tip");
  const done = () => { try { localStorage.setItem(COACH, "1"); } catch {} cancelAnimationFrame(raf); removeEventListener("resize", place); removeEventListener("scroll", place, true); removeEventListener("keydown", key, true); el.remove(); };
  function place() {
    const t = document.querySelector(TIPS[k].at); if (!t) return done();
    const r = t.getBoundingClientRect(), pad = 8, vw = innerWidth, vh = innerHeight;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const tw = Math.min(360, vw - 32), th = tip.offsetHeight || 180, below = vh - r.bottom > th + 28, above = r.top > th + 28;
    let top = below ? r.bottom + 18 : above ? r.top - th - 18 : Math.max(16, vh - th - 16);
    let left = Math.min(Math.max(16, r.left + Math.min(24, r.width / 2 - tw / 2)), vw - tw - 16);
    Object.assign(tip.style, { width: `${tw}px`, left: `${left}px`, top: `${top}px` });
  }
  function go(n) {
    k = n; const T = TIPS[k], t = document.querySelector(T.at); if (!t) return done();
    el.querySelector("#wz-coach-n").textContent = `${k + 1} of ${TIPS.length}`; el.querySelector("#wz-coach-t").textContent = T.title; el.querySelector("#wz-coach-p").textContent = T.text;
    el.querySelector("#wz-coach-next").textContent = k === TIPS.length - 1 ? "Start playing" : "Next tip";
    t.scrollIntoView({ block: "center", behavior: "instant" });
    { // room for the tip under the target: move the target up when both fit on the screen
      const r = t.getBoundingClientRect(), th = tip.offsetHeight || 200, need = r.height + th + 40;
      if (need < innerHeight && innerHeight - r.bottom < th + 28 && r.top < th + 28) scrollBy({ top: r.top - Math.max(16, (innerHeight - need) / 2), behavior: "instant" });
    }
    place(); requestAnimationFrame(place); el.querySelector("#wz-coach-next").focus({ preventScroll: true });
  }
  const key = e => { if (e.key === "Escape") { e.stopPropagation(); done(); } };
  el.querySelector("#wz-coach-x").onclick = done;
  el.querySelector("#wz-coach-next").onclick = () => k === TIPS.length - 1 ? done() : go(k + 1);
  addEventListener("resize", place); addEventListener("scroll", place, true); addEventListener("keydown", key, true);
  go(0);
}
