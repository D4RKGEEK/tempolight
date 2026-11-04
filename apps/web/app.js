// Tempolight web UI: no framework, no build step. Each page is a function that fills #page and can react to the
// live status the server sends 4 times a second.
import { createAudio } from "/audio.js";
import { roomPage } from "/room.js";
import { mapPage } from "/mapper.js";
import { createRenderer } from "/preview.js";

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = { get(k) { try { return localStorage.getItem("tl." + k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem("tl." + k) : localStorage.setItem("tl." + k, v); } catch {} } };

export const app = { state: null, status: null, layout: null, frame: null, token: store.get("token"), log: [], page: null, audio: null };
// demo mode: the online demo (and ?demo) runs the core in this page with pretend WLED controllers
export const DEMO = !!document.querySelector('meta[name="tempolight-demo"]') || new URLSearchParams(location.search).has("demo");
let demo = null;

// ---------------------------------------------------------------- server access
export async function api(method, path, body) {
  if (demo) return demo.api(method, path, body, app.token);
  const r = await fetch(path, { method, headers: { "content-type": "application/json", ...(app.token ? { "x-tempolight-token": app.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j?.error || `${r.status} ${r.statusText}`); e.status = r.status; throw e; }
  return j;
}
export async function act(fn, ok) { try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, true); if (e.status === 403) { app.token = null; store.set("token", null); refreshState(); } throw e; } }
let toastTimer; export function toast(msg, err) { const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : ""); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = "toast", err ? 4500 : 2200); }

const ws = { sock: null, id: null, open: false, queue: [],
  send(o) { if (this.open) this.sock.send(JSON.stringify(o)); },
  sendBinary(b) { if (this.open && this.sock.bufferedAmount < 1 << 20) this.sock.send(b); } };
export { ws };
function connect() {
  const WS = demo ? demo.FakeSocket : WebSocket;
  const s = new WS(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${app.token ? "?token=" + app.token : ""}`);
  s.binaryType = "arraybuffer"; ws.sock = s;
  s.onopen = () => { ws.open = true; setConn("Connected", "ok"); if (app.page?.preview) ws.send({ type: "preview", on: true }); if (app.audio?.state.mode) resendAudio(); };
  s.onclose = () => { ws.open = false; setConn("Reconnecting…", "err"); setTimeout(connect, 1500); };
  s.onmessage = e => {
    if (typeof e.data !== "string") { const b = new Uint8Array(e.data); if (b[0] === 1) app.frame = b.subarray(1); return; }
    const m = JSON.parse(e.data);
    if (m.type === "hello") { ws.id = m.id; onStatus(m); }
    else if (m.type === "status") onStatus(m);
    else if (m.type === "log") { app.log.push(m); if (app.log.length > 200) app.log.shift(); app.page?.onLog?.(m); }
    else if (m.type === "changed") scheduleRefresh(m.what);
  };
}
function resendAudio() { const a = app.audio.state; ws.send({ type: "audio-start", rate: 22050, label: a.mode === "song" ? `Song: ${a.label}` : a.label }); }
function setConn(t, cls) { $("#conn").textContent = t; $("#conn-dot").className = "dot " + cls; }

let refreshTimer = null, refreshWhat = new Set();
function scheduleRefresh(what) { refreshWhat.add(what); clearTimeout(refreshTimer); refreshTimer = setTimeout(async () => { const w = refreshWhat; refreshWhat = new Set(); await refreshState(); if (w.has("room") || w.has("devices") || w.has("all")) await loadLayout(); app.page?.onChanged?.(w); }, 120); }
export async function refreshState() { app.state = await api("GET", "/api/state"); chrome(); return app.state; }
export async function loadLayout() { app.layout = await api("GET", "/api/layout"); return app.layout; }
export const unlocked = () => !app.state?.locked || !!app.token;
export const guestOk = area => !app.state?.locked || !!app.token || !!app.state.settings.guest[area];

function onStatus(m) {
  app.status = m;
  $("#sb-source").textContent = m.sourceLabel; $("#sb-effect").textContent = m.effectName || m.effect;
  $("#sb-bpm").textContent = m.bpm ? `${m.bpm} BPM` : "–"; $("#sb-fps").textContent = m.fps; $("#sb-leds").textContent = m.leds;
  $("#power").setAttribute("aria-checked", m.power);
  const bri = $("#bri"); if (document.activeElement !== bri) { bri.value = Math.round(m.brightness * 100); $("#bri-out").textContent = bri.value + "%"; }
  const off = m.devices.filter(d => d.online === false).length; const cd = $("#c-devices"); cd.textContent = off ? `${off} offline` : (m.devices.length || ""); cd.className = "count" + (off ? " warn" : "");
  app.page?.onStatus?.(m);
}
function chrome() {
  const st = app.state; $("#ver").textContent = "v" + st.version; $("#c-effects").textContent = st.effects.length;
  $("#c-lock").textContent = st.locked ? (app.token ? "unlocked" : "locked") : "";
  $("#host-name").textContent = DEMO ? "Online demo" : location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "This computer" : location.hostname;
  $("#host-addr").textContent = DEMO ? "runs in your browser" : location.host;
}

// ---------------------------------------------------------------- preview canvas: what the LEDs are showing right now
export function createPreview(stage, { outlines = false, selected = () => -1, layout = () => app.layout, colors = null } = {}) {
  const cv = document.createElement("canvas"); stage.appendChild(cv); const R = createRenderer(cv);
  let raf = 0, alive = true, last = [];
  function draw() {
    if (!alive) return; raf = requestAnimationFrame(draw);
    const r = stage.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1), L = layout(), f = colors ? colors() : app.frame, sel = outlines ? selected() : -1;
    if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); last = []; }
    if (last[0] === L && last[1] === f && last[2] === sel) return; // only redraw when a new frame arrives (30 a second)
    last = [L, f, sel]; R.draw(L, f, dpr, { selected: sel });
  }
  draw(); ws.send({ type: "preview", on: true });
  return { canvas: cv, destroy() { alive = false; cancelAnimationFrame(raf); } };
}

// ---------------------------------------------------------------- small UI helpers
export const fmtTime = s => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
export const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
export const panel = (title, sub, act, body, cls = "span-12") => `<section class="panel ${cls}"><header><h2>${title}</h2>${sub ? `<span class="sub">${sub}</span>` : ""}${act ? `<div class="act">${act}</div>` : ""}</header>${body}</section>`;
export const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(label)}</option>`;
const STYLE_NAMES = () => ({ auto: "Automatic (from the music)", ...app.state.styles });
const tagName = { calm: "Calm", build: "Build-up", drop: "Drop", home: "Everyday", any: "Any", "LedFx-like": "Classic" };
function logRow(e) { const d = new Date(e.t); return `<div><time>${d.toTimeString().slice(0, 8)}</time><span class="${e.level}">${e.level === "info" ? "info" : e.level}</span><span>${esc(e.msg)}</span></div>`; }
function lockScreen(el, why = "This page") {
  el.innerHTML = panel("Locked", "", "", `<div class="lockbox pb"><p>${esc(why)} is locked with a PIN. Enter it to make changes.</p><input id="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" aria-label="PIN"><button class="btn primary" id="unlock" type="button">Unlock</button></div>`);
  const go = async () => { const r = await act(() => api("POST", "/api/unlock", { pin: $("#pin").value })); app.token = r.token; store.set("token", r.token); ws.sock?.close(); await refreshState(); route(); };
  $("#unlock").onclick = () => go().catch(() => {}); $("#pin").onkeydown = e => { if (e.key === "Enter") go().catch(() => {}); }; $("#pin").focus();
}

// ---------------------------------------------------------------- clip recording: 15 s of the preview with the music, to share
async function recordClip(canvas, btn, seconds = 15) {
  const tracks = [...canvas.captureStream(30).getVideoTracks()], audio = app.audio?.captureStream(); if (audio) tracks.push(...audio.getAudioTracks());
  const types = ["video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"], type = types.find(t => MediaRecorder.isTypeSupported(t)) || "";
  const rec = new MediaRecorder(new MediaStream(tracks), type ? { mimeType: type, videoBitsPerSecond: 6e6 } : undefined), chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => rec.onstop = r); rec.start(500); btn.disabled = true;
  for (let k = seconds; k > 0; k--) { btn.textContent = `Recording… ${k}`; await new Promise(r => setTimeout(r, 1000)); }
  rec.stop(); await done; btn.textContent = "Record clip"; btn.disabled = false;
  const ext = (rec.mimeType || type).includes("mp4") ? "mp4" : "webm", file = new File(chunks, `tempolight-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`, { type: rec.mimeType || type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: "Tempolight" }); return; } catch {} }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); toast("Clip saved");
}

// ---------------------------------------------------------------- Home
function homePage(el) {
  const st = app.state, noDevices = !st.devices.length;
  el.innerHTML = `
    ${noDevices ? panel("Welcome to Tempolight", "Let's light up your room", "", `<div class="pb stack"><p class="muted">Tempolight streams music-reactive effects to WLED controllers on your network. Pick how to start:</p>
      <div class="setup">
        <div class="opt"><h3>Find my WLED lights</h3><p>Looks for WLED controllers on your Wi-Fi and adds them, each as a strip in the room.</p><button class="btn primary" id="s-scan" type="button">Scan the network</button></div>
        <div class="opt"><h3>Add by IP address</h3><p>Type the address shown in the WLED app (for example 192.168.1.42).</p><div class="row" style="width:100%"><input id="s-ip" placeholder="192.168.1.42" style="flex:1"><button class="btn" id="s-add" type="button">Add</button></div></div>
        <div class="opt"><h3>Try it without lights</h3><p>Adds a virtual living room so you can see every effect and play music right here.</p><button class="btn" id="s-virtual" type="button">Add a virtual room</button></div>
      </div><p class="faint" id="s-msg"></p></div>`) : ""}
    ${panel("Live preview", `<span id="h-fx"></span>`, `<span class="badge" id="h-leds"></span><button class="btn" id="h-rec" type="button" title="Record 15 seconds of the preview with the music">Record clip</button><a class="btn" href="#/room">Edit room</a>`, `<div class="stage" id="h-stage">${noDevices ? '<div class="empty">No lights yet</div>' : ""}</div>`, "span-8")}
    ${panel("Now playing", `<span id="h-src"></span>`, `<span class="badge acc" id="h-style"></span>`, `<div class="pb np stack">
      <div><div class="song" id="h-song">Nothing playing</div><div class="meta" id="h-meta">Play a song or listen to your computer on the Music page.</div></div>
      <div class="kv"><div><span>Tempo</span><b id="h-bpm">–</b></div><div><span>Part</span><b id="h-part">–</b></div><div><span>Level</span><b id="h-level">–</b></div></div>
      <div class="row" style="justify-content:space-between"><div class="beat" id="h-beat"><i></i><i></i><i></i><i></i></div><a class="btn" href="#/music">Music</a></div>
      <div class="meter"><i id="h-meter"></i></div>
      <div id="h-transport" hidden class="stack"><div class="progress" id="h-prog"><div class="fill" id="h-fill"></div></div><div class="times"><span id="h-pos">0:00</span><span id="h-dur">0:00</span></div>
        <div class="row"><button class="btn" id="h-prev" type="button">Previous</button><button class="btn primary" id="h-play" type="button">Pause</button><button class="btn" id="h-next" type="button">Next</button></div></div>
    </div>`, "span-4")}
    ${panel("Controls", "Applies to the whole room", `<button class="btn" id="h-save" type="button">Save as scene</button><button class="btn" id="h-black" type="button" aria-pressed="false">Blackout</button>`, `<div class="pb controls">
      <div class="field"><label for="h-mode">Effect choice</label><select id="h-mode">${opt("auto", "Automatic (follows the song)", st.show.mode === "auto")}${opt("manual", "Fixed effect", st.show.mode === "manual")}</select></div>
      <div class="field"><label for="h-effect">Effect</label><select id="h-effect">${st.effects.map(e => opt(e.id, e.name, e.id === st.show.effect)).join("")}</select></div>
      <div class="field"><label for="h-styl">Music style</label><select id="h-styl">${Object.entries(STYLE_NAMES()).map(([k, v]) => opt(k, v, k === st.show.style)).join("")}</select></div>
      <div class="field"><label for="h-pal">Colours</label><select id="h-pal">${st.palettes.map(p => opt(p, p === "auto" ? "Automatic (changes with the song)" : p[0].toUpperCase() + p.slice(1), p === st.show.palette)).join("")}</select></div>
    </div>`, "span-8")}
    ${panel("Scenes", "", `<a class="btn" href="#/scenes">Manage</a>`, `<div class="pb chips" id="h-scenes">${st.scenes.map(s => `<button class="chip" data-scene="${s.id}" type="button">${esc(s.name)}</button>`).join("") || '<span class="faint">No scenes yet</span>'}</div>`, "span-4")}
    ${panel("Devices", `${st.devices.length} controller${st.devices.length === 1 ? "" : "s"}`, `<a class="btn" href="#/devices">Manage</a>`, `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Address</th><th class="num">LEDs</th><th>Status</th></tr></thead><tbody id="h-devs"></tbody></table></div>`, "span-6")}
    ${panel("Activity", "", `<button class="btn sm" id="h-clear" type="button">Clear</button>`, `<div class="log" id="h-log"></div>`, "span-6")}`;

  let prev = null;
  if (!noDevices) prev = createPreview($("#h-stage"));
  if (noDevices) {
    const msg = t => $("#s-msg").textContent = t;
    $("#s-scan").onclick = async () => { msg("Scanning… this takes a few seconds."); const found = await act(() => api("POST", "/api/discover", { scan: true }));
      const fresh = found.filter(f => !f.added); if (!fresh.length) return msg("No WLED controllers found. Check they're on the same Wi-Fi, or add one by IP address.");
      for (const f of fresh) await act(() => api("POST", "/api/devices", { host: f.host, name: f.name, leds: f.leds, force: true })); toast(`Added ${fresh.length} controller${fresh.length > 1 ? "s" : ""}`); };
    $("#s-add").onclick = () => act(() => api("POST", "/api/devices", { host: $("#s-ip").value }), "Controller added").catch(() => {});
    $("#s-virtual").onclick = () => act(() => api("POST", "/api/devices", { virtual: true, name: "Virtual room" }), "Virtual room added").catch(() => {});
  }
  const show = b => act(() => api("PATCH", "/api/show", b)).catch(() => {});
  $("#h-mode").onchange = e => show({ mode: e.target.value });
  $("#h-effect").onchange = e => show({ effect: e.target.value, mode: "manual" });
  $("#h-styl").onchange = e => show({ style: e.target.value });
  $("#h-pal").onchange = e => show({ palette: e.target.value });
  $("#h-black").onclick = () => act(() => api("POST", "/api/action", { type: "blackout" })).catch(() => {});
  if (prev && typeof MediaRecorder !== "undefined" && prev.canvas.captureStream) $("#h-rec").onclick = () => recordClip(prev.canvas, $("#h-rec")); else $("#h-rec").hidden = true;
  $("#h-save").onclick = async () => { const name = prompt("Name for this scene:", "My scene"); if (name) await act(() => api("POST", "/api/scenes", { name }), "Scene saved").catch(() => {}); };
  $$("#h-scenes [data-scene]").forEach(b => b.onclick = () => act(() => api("POST", `/api/scenes/${b.dataset.scene}/apply`), `Scene: ${b.textContent}`).catch(() => {}));
  $("#h-clear").onclick = () => { app.log = []; $("#h-log").innerHTML = ""; };
  $("#h-log").innerHTML = app.log.slice(-60).reverse().map(logRow).join("");
  const A = app.audio;
  $("#h-play").onclick = () => A.toggle(); $("#h-next").onclick = () => A.next(); $("#h-prev").onclick = () => A.prev();
  $("#h-prog").onclick = e => { const r = e.currentTarget.getBoundingClientRect(); A.seek((e.clientX - r.left) / r.width * A.duration); };
  const partName = { calm: "Calm", build: "Build-up", drop: "Drop", silent: "Quiet", idle: "Idle" };
  return {
    preview: true,
    onStatus(m) {
      $("#h-fx").textContent = `${m.effectName}${app.state.show.mode === "auto" ? ", automatic" : ""}`; $("#h-leds").textContent = `${m.leds} LEDs`;
      $("#h-src").textContent = m.sourceLabel; $("#h-style").textContent = m.source === "idle" ? "Ambient" : m.styleName;
      $("#h-bpm").textContent = m.bpm ? Math.round(m.bpm) : "–"; $("#h-part").textContent = partName[m.part] || m.part; $("#h-level").textContent = Math.round(m.level * 100) + "%";
      $$("#h-beat i").forEach((x, i) => x.classList.toggle("on", m.beat === i)); $("#h-meter").style.width = Math.round(m.level * 100) + "%";
      const a = A.state;
      $("#h-song").textContent = m.song ? m.song.name : m.source === "idle" ? "Nothing playing" : m.sourceLabel;
      $("#h-meta").textContent = m.song ? `${Math.round(m.song.bpm)} BPM · ${app.state.styles[m.song.style] || m.song.style}${m.song.drops?.length ? ` · ${m.song.drops.length} drop${m.song.drops.length > 1 ? "s" : ""}` : ""}` : m.source === "idle" ? "Play a song or listen to your computer on the Music page." : "Listening live";
      $("#h-transport").hidden = !(a.mode === "song" && a.song);
      if (a.song) { const d = A.duration, p = A.pos(); $("#h-fill").style.width = (p / d * 100) + "%"; $("#h-pos").textContent = fmtTime(p); $("#h-dur").textContent = fmtTime(d); $("#h-play").textContent = a.song.playing ? "Pause" : "Play"; }
      $("#h-black").setAttribute("aria-pressed", m.overlay.blackout);
      $("#h-devs").innerHTML = app.state.devices.map(d => { const h = m.devices.find(x => x.id === d.id) || {};
        return `<tr><td>${esc(d.name)}</td><td class="mono">${esc(d.virtual ? "virtual" : d.host)}</td><td class="num">${d.leds || "?"}</td><td>${!d.enabled ? '<span class="badge">Off</span>' : h.online ? '<span class="badge live"><i></i>Online</span>' : h.online === false ? '<span class="badge err"><i></i>Offline</span>' : '<span class="badge">Checking</span>'}</td></tr>`; }).join("") || '<tr><td colspan="4" class="faint">No devices</td></tr>';
    },
    onLog(e) { const l = $("#h-log"); if (l) l.insertAdjacentHTML("afterbegin", logRow(e)); },
    onChanged(w) {
      if (w.has("devices") || w.has("scenes") || w.has("room") || w.has("all")) return route();
      if (w.has("show")) { const sh = app.state.show; // update the controls in place, so the preview doesn't blink
        for (const [id, v] of [["#h-mode", sh.mode], ["#h-effect", sh.effect], ["#h-styl", sh.style], ["#h-pal", sh.palette]]) { const e = $(id); if (e && document.activeElement !== e) e.value = v; } }
    },
    destroy() { prev && prev.destroy(); },
  };
}

// ---------------------------------------------------------------- Music
function musicPage(el) {
  const st = app.state, A = app.audio, s = st.settings;
  el.innerHTML = `
    ${panel("Play songs", "Best timing: songs are analysed first, so the lights know where the drops are", `<label class="btn primary" for="m-files">Add songs…</label><input type="file" id="m-files" accept="audio/*" multiple hidden><button class="btn" id="m-demo" type="button">Play the demo track</button>`,
      `<div class="pb stack"><div id="m-now"></div><div class="tablewrap"><table><thead><tr><th>#</th><th>Song</th><th class="num">Tempo</th><th>Style</th><th class="num">Drops</th><th></th></tr></thead><tbody id="m-queue"></tbody></table></div></div>`, "span-8")}
    ${panel("Listen live", "For music you play anywhere else: Spotify, YouTube, a DJ app", "", `<div class="pb stack">
      <button class="btn" id="m-system" type="button">Listen to this computer's sound</button>
      <div class="row" style="flex-wrap:nowrap"><button class="btn" id="m-mic" type="button" style="flex:1">Listen with a microphone</button></div>
      <div class="field"><label for="m-input">Microphone or line-in</label><select id="m-input"><option value="">Default</option></select></div>
      <div class="field"><span class="lbl">Input level <output id="m-lvl-o"></output></span><div class="meter"><i id="m-lvl"></i></div></div>
      <button class="btn danger" id="m-stop" type="button" hidden>Stop listening</button>
      <p class="faint" style="font-size:12.5px">Your browser will ask what to share. For computer sound in Chrome or Edge, choose the screen or tab and turn on “Share audio”. Audio stays on your network.</p>
      <div class="callout err" id="m-err" hidden></div></div>`, "span-4")}
    ${panel("What Tempolight hears", `<span id="m-src"></span>`, "", `<div class="pb stack"><div class="spectrum" id="m-spec">${"<i></i>".repeat(24)}</div>
      <div class="kv"><div><span>Tempo</span><b id="m-bpm">–</b></div><div><span>Part</span><b id="m-part">–</b></div><div><span>Style</span><b id="m-style">–</b></div><div><span>Singing</span><b id="m-voc" title="An estimate from the sound: a clear tone whose pitch moves like a voice">–</b></div></div>
      <div class="row"><button class="btn" id="m-tap" type="button">Tap the beat</button><span class="faint" style="font-size:12.5px">Tap 4 times on the beat to fix the tempo and line up the beat.</span></div></div>`, "span-6")}
    ${panel("Timing", "", "", `<div class="pb stack">
      <div class="field"><label for="m-off">Light timing <output id="m-off-o">${s.syncOffsetMs} ms</output></label><input type="range" id="m-off" min="-300" max="300" step="5" value="${s.syncOffsetMs}">
        <span class="help">If the lights come after the beat, move this to the right; if they come before it, move it left. Bluetooth speakers often need +150 to +250.</span></div>
      <div class="row"><button class="btn" id="m-cal" type="button">Fix the timing automatically</button><span class="faint" id="m-cal-msg" style="font-size:12.5px">Plays a few clicks and listens with the microphone, so turn the speakers up and keep quiet for 5 seconds.</span></div>
      <label class="check"><input type="checkbox" id="m-pred" ${s.predict ? "checked" : ""}> Predict beats when listening live (lights land on the beat instead of just after it)</label>
      <div class="field"><label>Metronome when nothing plays</label><div class="row"><label class="check"><input type="checkbox" id="m-met" ${s.metronome.enabled ? "checked" : ""}> On</label><input type="number" id="m-bpmset" min="40" max="220" value="${s.metronome.bpm}" style="width:90px"> <span class="faint">BPM</span></div></div>
    </div>`, "span-6")}
    ${panel("Guest requests", `<span id="m-reqn"></span>`, `<label class="check"><input type="checkbox" id="m-reqon" ${s.requests ? "checked" : ""}> On</label><button class="btn sm" id="m-reqclear" type="button">Clear</button>`, `<div class="pb phones"><div class="qr" id="m-reqqr"></div><div class="stack">
      <p class="muted">Guests scan the code to ask for songs and vote; the most wanted are on top.</p>
      <div class="tablewrap"><table><tbody id="m-reqs"></tbody></table></div><p class="faint" style="font-size:12.5px" id="m-requrl"></p></div></div>`, "span-6")}
    ${panel("Song memory", `<span id="m-memn"></span>`, `<label class="check"><input type="checkbox" id="m-mem" ${s.songMemory ? "checked" : ""}> On</label>`, `<div class="pb stack">
      <p class="muted">Songs you play here are remembered. When one plays again from anywhere else (Spotify, a DJ, the radio) while Tempolight listens live, it is recognised after about 15 seconds and the lights follow its full beat map: build-ups and drops are known ahead.</p>
      <div class="tablewrap"><table><tbody id="m-songs"><tr><td class="faint">Loading…</td></tr></tbody></table></div></div>`, "span-6")}
    ${panel("Screen sync", `<span id="m-scrst">${app.screen?.state.active ? "Sharing" : "Off"}</span>`, `<button class="btn" id="m-scr" type="button">${app.screen?.state.active ? "Stop sharing" : "Share a screen…"}</button>`, `<div class="pb stack">
      <p class="muted">Share a film, a game or a music video and the room takes its colours, like a big ambilight. Turns on the Screen Sync effect; pick another effect to go back.</p>
      <span class="help" id="m-scrhelp">${navigator.mediaDevices?.getDisplayMedia ? "Works in Chrome, Edge and Firefox on a computer. Keep the shared tab or window visible." : "This browser can't share its screen. Use a computer."}</span></div>`, "span-6")}
    ${DEMO ? "" : panel("Listen on the server", "For a Raspberry Pi or PC next to the speakers, with no browser open", `<button class="btn" id="m-cap" type="button"></button>`, `<div class="pb stack">
      <div class="field"><label for="m-capsrc">Sound input</label><select id="m-capsrc">${opt("auto", "Automatic", s.capture.source === "auto")}${st.captureSources.map(c => opt(c.id, c.label, c.id === s.capture.source)).join("")}</select>
      ${st.captureSources.length ? "" : '<span class="help">No capture tool found on the server. Install ffmpeg (or PulseAudio/ALSA tools on Linux), or enter a command below.</span>'}</div>
      <div class="field"><label for="m-capcmd">Custom command (optional)</label><input id="m-capcmd" class="mono" placeholder='ffmpeg -f pulse -i default -ac 1 -ar 22050 -f s16le -' value="${esc(s.capture.command)}"><span class="help">Any command that writes 16-bit mono 22,050 Hz audio to its output.</span></div>
      <div id="m-capst" class="faint"></div></div>`, "span-12")}`;
  const canShare = !!navigator.mediaDevices?.getDisplayMedia;
  const fmtT = v => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
  async function songs() { const list = await api("GET", "/api/songs").catch(() => []), tb = $("#m-songs"); if (!tb) return;
    $("#m-memn").textContent = list.length ? `${list.length} song${list.length > 1 ? "s" : ""} remembered` : "";
    tb.innerHTML = list.length ? list.slice().reverse().map(e => `<tr><td>${esc(e.name)}</td><td class="num faint">${Math.round(e.bpm)} BPM</td><td class="num faint">${fmtT(e.dur)}</td><td class="num faint">${e.drops} drop${e.drops === 1 ? "" : "s"}</td><td>${lockedOut ? "" : `<button class="btn sm" data-forget="${e.id}" type="button">Forget</button>`}</td></tr>`).join("")
      : '<tr><td class="faint">Nothing yet. Play a song on this page and it will be remembered.</td></tr>';
    $$("[data-forget]").forEach(b => b.onclick = () => act(() => api("DELETE", `/api/songs/${b.dataset.forget}`), "Forgotten").then(songs).catch(() => {})); }
  async function requests() { const r = await api("GET", "/api/requests").catch(() => ({ requests: [] })), tb = $("#m-reqs"); if (!tb) return;
    $("#m-reqn").textContent = r.requests.length ? `${r.requests.length} waiting` : "";
    tb.innerHTML = r.requests.length ? r.requests.map(q => `<tr><td>${esc(q.title)}${q.by ? `<br><span class="faint" style="font-size:12px">from ${esc(q.by)}</span>` : ""}</td><td class="num">▲ ${q.votes}</td><td>${lockedOut ? "" : `<button class="btn sm" data-rdone="${q.id}" type="button">Played</button>`}</td></tr>`).join("")
      : '<tr><td class="faint">No requests yet.</td></tr>';
    $$("[data-rdone]").forEach(b => b.onclick = () => act(() => api("PATCH", `/api/requests/${b.dataset.rdone}`, { done: true })).then(requests).catch(() => {})); }
  $("#m-reqon").onchange = e => act(() => api("PATCH", "/api/settings", { requests: e.target.checked }), e.target.checked ? "Requests on" : "Requests off").then(refreshState).catch(() => {});
  $("#m-reqclear").onclick = () => { if (confirm("Clear all song requests?")) act(() => api("DELETE", "/api/requests"), "Cleared").then(requests).catch(() => {}); };
  if (!unlocked()) { $("#m-reqon").disabled = true; $("#m-reqclear").disabled = true; }
  guestUrl("/request").then(async url => { const { qrSvg } = await import("/qr.js"), box = $("#m-reqqr"); if (!box) return; box.innerHTML = qrSvg(url, { px: 4 }); $("#m-requrl").innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`; });
  $("#m-mem").onchange = e => act(() => api("PATCH", "/api/settings", { songMemory: e.target.checked }), e.target.checked ? "Song memory on" : "Song memory off").then(refreshState).catch(() => {});
  if (!canShare) $("#m-scr").disabled = true;
  $("#m-scr").onclick = async () => { if (!app.screen) { const { createScreenShare } = await import("/screen.js"); app.screen = createScreenShare({ ws, onChange: sc => { if (sc.error) toast(sc.error, true); const b = $("#m-scr"), t = $("#m-scrst"); if (b) b.textContent = sc.active ? "Stop sharing" : "Share a screen…"; if (t) t.textContent = sc.active ? `Sharing ${sc.label}` : "Off"; } }); }
    if (app.screen.state.active) { app.screen.stop(); return; }
    if (await app.screen.start()) act(() => api("PATCH", "/api/show", { effect: "screen" }), "Screen Sync is on").catch(() => {}); };
  if (!canShare) $("#m-system").hidden = true; // phones can't share system sound: use songs or the microphone

  const lockedOut = !unlocked();
  $("#m-files").onchange = e => { A.addFiles([...e.target.files]); e.target.value = ""; };
  $("#m-demo").onclick = () => A.addUrl("/demo.mp3", "Tempolight demo track");
  const inputKey = "tl.input"; const savedInput = (() => { try { return localStorage.getItem(inputKey) || ""; } catch { return ""; } })();
  async function fillInputs() { const list = await A.listInputs(), selEl = $("#m-input"); if (!selEl) return;
    selEl.innerHTML = '<option value="">Default</option>' + list.map((d, i) => opt(d.deviceId, d.label || `Input ${i + 1}`, d.deviceId === savedInput)).join(""); }
  fillInputs(); navigator.mediaDevices?.addEventListener?.("devicechange", fillInputs);
  $("#m-input").onchange = e => { try { localStorage.setItem(inputKey, e.target.value); } catch {} if (A.state.mode === "mic") A.listen("mic", e.target.value); };
  $("#m-system").onclick = () => A.listen("system"); $("#m-mic").onclick = () => A.listen("mic", $("#m-input").value).then(fillInputs); $("#m-stop").onclick = () => A.stopLive();
  if (!navigator.mediaDevices?.getUserMedia) { $("#m-cal").disabled = true; $("#m-cal-msg").textContent = "Needs microphone access, which this browser only allows on localhost or HTTPS."; }
  $("#m-cal").onclick = async () => {
    const b = $("#m-cal"), msg = $("#m-cal-msg"); b.disabled = true; msg.textContent = "Listening… keep quiet";
    try {
      const r = await A.calibrate($("#m-input").value, p => { msg.textContent = `Listening… ${Math.round(p * 100)}%`; });
      if (!r.ok) { msg.textContent = r.heard ? `The clicks were hard to hear (${r.heard} of ${r.sent}). Turn the speakers up, move the phone or computer closer, and try again.` : "The microphone didn't hear the clicks. Turn the speakers up and try again."; return; }
      const { offsetFromDelay } = await import("/calibrate.js"), off = offsetFromDelay(r.delayMs, r.reportedOutputMs);
      await api("PATCH", "/api/settings", { syncOffsetMs: off }); await refreshState();
      $("#m-off").value = off; $("#m-off-o").textContent = off + " ms";
      msg.textContent = `Speakers to microphone: ${Math.round(r.delayMs)} ms. Light timing set to ${off > 0 ? "+" : ""}${off} ms.`;
    } catch (e) { msg.textContent = e.name === "NotAllowedError" ? "Microphone permission was refused." : `Couldn't measure: ${e.message}`; }
    finally { b.disabled = !unlocked(); }
  };
  $("#m-tap").onclick = () => api("POST", "/api/action", { type: "tap" }).catch(e => toast(e.message, true));
  const setS = b => act(() => api("PATCH", "/api/settings", b)).then(refreshState).catch(() => {});
  $("#m-off").oninput = e => $("#m-off-o").textContent = e.target.value + " ms"; $("#m-off").onchange = e => setS({ syncOffsetMs: Number(e.target.value) });
  $("#m-pred").onchange = e => setS({ predict: e.target.checked });
  $("#m-met").onchange = e => setS({ metronome: { enabled: e.target.checked } }); $("#m-bpmset").onchange = e => setS({ metronome: { bpm: Number(e.target.value) } });
  if (!DEMO) {
    $("#m-capsrc").onchange = e => setS({ capture: { source: e.target.value } }); $("#m-capcmd").onchange = e => setS({ capture: { command: e.target.value.trim() } });
    $("#m-cap").onclick = () => setS({ capture: { enabled: !app.state.settings.capture.enabled } });
  }
  for (const id of ["m-off", "m-pred", "m-met", "m-bpmset", "m-capsrc", "m-capcmd", "m-cap", "m-cal"]) if (lockedOut && $("#" + id)) $("#" + id).disabled = true;
  if (lockedOut && $("#m-capst")) $("#m-capst").textContent = "Timing and server settings are locked. Unlock in Settings to change them.";

  function renderQueue() {
    const a = A.state;
    $("#m-queue").innerHTML = a.queue.map((q, i) => `<tr class="${i === a.index ? "sel" : ""}"><td class="num">${i + 1}</td><td>${esc(q.name)}</td><td class="num">${q.analysis ? Math.round(q.analysis.bpm) : "–"}</td><td>${q.analysis ? esc(st.styles[q.analysis.style]) : '<span class="faint">not analysed yet</span>'}</td><td class="num">${q.analysis ? q.analysis.drops.length : "–"}</td>
      <td><button class="btn sm" data-play="${i}" type="button">Play</button> <button class="btn sm" data-del="${i}" type="button" aria-label="Remove">✕</button></td></tr>`).join("") || '<tr><td colspan="6" class="faint">Add songs from this computer (MP3, M4A, WAV, OGG, FLAC). Nothing is uploaded: songs play here, and only their beat map goes to the lights.</td></tr>';
    $$("#m-queue [data-play]").forEach(b => b.onclick = () => A.playIndex(Number(b.dataset.play)));
    $$("#m-queue [data-del]").forEach(b => b.onclick = () => A.remove(Number(b.dataset.del)));
    const now = $("#m-now");
    if (a.analysing) now.innerHTML = `<div class="callout">Analysing ${esc(a.queue[a.index]?.name)}… ${Math.round(a.analysing * 100)}%<div class="meter" style="margin-top:6px"><i style="width:${Math.round(a.analysing * 100)}%"></i></div></div>`;
    else if (a.song) { const q = a.song.item, d = A.duration;
      now.innerHTML = `<div class="stack"><div class="row" style="justify-content:space-between"><b>${esc(q.name)}</b><span class="faint mono">${Math.round(q.analysis.bpm)} BPM</span></div>
        <div class="progress" id="m-prog"><div class="fill" id="m-fill"></div>${q.analysis.drops.map(t => `<div class="drop" style="left:${t / d * 100}%" title="Drop at ${fmtTime(t)}"></div>`).join("")}</div>
        <div class="times"><span id="m-pos">0:00</span><span>${fmtTime(d)}</span></div>
        <div class="showline" id="m-show" aria-label="The show: effects on a timeline"></div><div id="m-showed" class="row" hidden></div>
        <div class="row"><button class="btn" id="m-prev" type="button">Previous</button><button class="btn primary" id="m-play" type="button">${a.song.playing ? "Pause" : "Play"}</button><button class="btn" id="m-next" type="button">Next</button><button class="btn" id="m-stopsong" type="button">Stop</button></div></div>`;
      $("#m-prog").onclick = e => { const r = e.currentTarget.getBoundingClientRect(); A.seek((e.clientX - r.left) / r.width * d); };
      showLine();
      $("#m-play").onclick = () => A.toggle(); $("#m-next").onclick = () => A.next(); $("#m-prev").onclick = () => A.prev(); $("#m-stopsong").onclick = () => A.stopSong(); }
    else now.innerHTML = "";
    $("#m-err").hidden = !a.error; $("#m-err").textContent = a.error || "";
    $("#m-stop").hidden = !(a.mode === "system" || a.mode === "mic");
    $("#m-system").setAttribute("aria-pressed", a.mode === "system"); $("#m-mic").setAttribute("aria-pressed", a.mode === "mic");
  }
  // the show: an auto-generated timeline of effects for the song playing, one block per section; tap a block to change it
  let showFor = null, showData = null;
  async function showLine(force) {
    const box = $("#m-show"); if (!box) return; const memId = app.status?.song?.memId; if (!memId) { box.innerHTML = '<span class="faint" style="font-size:12.5px">The show appears here once the song is remembered.</span>'; showFor = null; return; }
    if (force || showFor !== memId || !showData) { showData = await api("GET", `/api/songs/${memId}/show`).catch(() => null); showFor = memId; }
    if (!showData) return; const d = showData.dur || 1, names = Object.fromEntries(st.effects.map(e => [e.id, e.name]));
    box.innerHTML = showData.show.map((b, i) => `<button class="blk ${esc(b.part)}" type="button" data-blk="${i}" style="left:${b.t0 / d * 100}%;width:${(b.t1 - b.t0) / d * 100}%" title="${fmtTime(b.t0)}–${fmtTime(b.t1)}: ${esc(names[b.effect] || b.effect)}"><span>${esc(names[b.effect] || b.effect)}</span></button>`).join("");
    $$("#m-show [data-blk]").forEach(b => b.onclick = () => { const i = Number(b.dataset.blk), blk = showData.show[i], ed = $("#m-showed"); ed.hidden = false;
      ed.innerHTML = `<span class="faint">${fmtTime(blk.t0)}–${fmtTime(blk.t1)}</span><select id="m-blkfx" aria-label="Effect for this part" style="width:auto;max-width:240px">${st.effects.map(e => opt(e.id, e.name, e.id === blk.effect)).join("")}</select><button class="btn sm" id="m-shownew" type="button">New show</button>${showData.edited ? '<span class="faint" style="font-size:12px">edited by hand</span>' : ""}`;
      $("#m-blkfx").onchange = async e => { const next = showData.show.map((x, k) => k === i ? { ...x, effect: e.target.value } : x); const r = await act(() => api("PUT", `/api/songs/${memId}/show`, { show: next }), "Show updated").catch(() => null); if (r) { showData.show = r.show; showData.edited = true; showLine(); } };
      $("#m-shownew").onclick = async () => { const r = await act(() => api("DELETE", `/api/songs/${memId}/show`), "A new show for this song").catch(() => null); if (r) { showData = null; ed.hidden = true; showLine(true); } }; });
  }
  renderQueue(); songs(); requests();
  const partName = { calm: "Calm", build: "Build-up", drop: "Drop", silent: "Quiet", idle: "–" };
  return {
    onAudio: renderQueue, onLog(e) { if (/^Remembered|^Song memory/.test(e.msg)) songs(); }, onChanged(w) { if (w.has("requests")) requests(); },
    onStatus(m) {
      $("#m-src").textContent = m.sourceLabel; $("#m-bpm").textContent = m.bpm ? m.bpm.toFixed(0) : "–"; $("#m-part").textContent = partName[m.part] || m.part; $("#m-style").textContent = m.source === "idle" ? "–" : m.styleName; $("#m-voc").textContent = m.vocal == null ? "–" : m.vocal > 0.35 ? "Yes" : m.vocal > 0.15 ? "A little" : "No";
      const bars = $$("#m-spec i"); bars.forEach((b, i) => b.style.height = (m.bands ? Math.max(2, m.bands[i] * 100) : 2) + "%");
      const lv = A.level(); $("#m-lvl").style.width = Math.round(lv * 100) + "%"; $("#m-lvl-o").textContent = A.state.stream ? (lv < 0.02 ? "very quiet: turn it up or move closer" : Math.round(lv * 100) + "%") : "not listening";
      if (m.song?.memId && m.song.memId !== showFor) showLine();
      if (A.state.song && $("#m-fill")) { const p = A.pos(); $("#m-fill").style.width = (p / A.duration * 100) + "%"; $("#m-pos").textContent = fmtTime(p); }
      if (DEMO) return;
      const c = app.state.settings.capture; $("#m-cap").textContent = c.enabled ? "Stop listening on the server" : "Start listening on the server";
      if (!lockedOut) $("#m-capst").innerHTML = m.capture ? (m.capture.error ? `<span class="badge err">${esc(m.capture.error)}</span>` : m.capture.running ? `<span class="badge live"><i></i>Listening: ${esc(m.capture.label)}</span>` : "Starting…") : "Not listening on the server.";
    },
  };
}

// ---------------------------------------------------------------- Effects
function effectsPage(el) {
  const st = app.state; let tag = "all", q = "", sel = null;
  const prefs = () => app.state.settings.effectPrefs || {}, params = () => app.state.show.params || {};
  el.innerHTML = `${panel("Effects", `${st.effects.length} effects, all of them work on any layout`, `<button class="btn" id="e-auto" type="button">Back to automatic</button>`, `<div class="pb stack">
      <div class="row"><input id="e-q" placeholder="Search effects" style="max-width:240px"><div class="chips" id="e-tags">${["all", "calm", "build", "drop", "home", "LedFx-like", "liked", "banned"].map(t => `<button class="chip" data-tag="${t}" aria-pressed="${t === "all"}" type="button">${t === "all" ? "All" : t === "liked" ? "♥ Liked" : t === "banned" ? "Banned" : tagName[t]}</button>`).join("")}</div></div>
      <p class="faint" style="font-size:12.5px">Tap an effect to show it. ♥ makes automatic mode pick it more often; ⊘ means automatic mode never picks it.</p>
      <div class="grid-fx" id="e-grid"></div></div>`, "span-8")}
    ${panel("Preview", `<span id="e-now"></span>`, "", `<div class="stage" id="e-stage"></div>`, "span-4")}
    ${panel("Effect settings", `<span id="e-selname"></span>`, `<button class="btn sm" id="e-reset" type="button">Reset</button>`, `<div class="pb stack" id="e-params">
      <div class="field"><label for="e-sel">Effect</label><select id="e-sel">${st.effects.map(e => opt(e.id, e.name)).join("")}</select><span class="help">Settings are kept per effect and saved in scenes.</span></div>
      <div class="field"><label for="p-speed">Speed <output id="p-speed-o"></output></label><input type="range" id="p-speed" min="0.25" max="3" step="0.05"></div>
      <div class="field"><label for="p-int">Intensity <output id="p-int-o"></output></label><input type="range" id="p-int" min="0.1" max="2.5" step="0.05"></div>
      <div class="field"><label for="p-hue">Colour shift <output id="p-hue-o"></output></label><input type="range" id="p-hue" min="-180" max="180" step="5"></div>
      <div class="field"><label for="p-sat">Saturation <output id="p-sat-o"></output></label><input type="range" id="p-sat" min="0" max="2" step="0.05"></div>
      <label class="check"><input type="checkbox" id="p-mirror"> Mirror left and right</label></div>`, "span-4")}
    ${panel("How effects are chosen", "", "", `<div class="pb controls">
      <div class="field"><label for="e-style">Music style</label><select id="e-style">${Object.entries(STYLE_NAMES()).map(([k, v]) => opt(k, v, k === st.show.style)).join("")}</select><span class="help">Each style has its own effect lists for calm parts, build-ups and drops.</span></div>
      <div class="field"><label for="e-pal">Colours</label><select id="e-pal">${st.palettes.map(p => opt(p, p === "auto" ? "Automatic" : p[0].toUpperCase() + p.slice(1), p === st.show.palette)).join("")}</select></div>
      <div class="field"><label for="e-every">Change effect every <output id="e-every-o">${st.show.everyBeats} beats</output></label><input type="range" id="e-every" min="4" max="64" step="4" value="${st.show.everyBeats}"><span class="help">In automatic mode. Song changes (build-up, drop) always switch straight away.</span></div>
      <div class="field"><label for="e-speed">Ambient speed <output id="e-speed-o">${st.show.speed}×</output></label><input type="range" id="e-speed" min="0.25" max="3" step="0.25" value="${st.show.speed}"></div>
      <div class="field"><label for="e-layer">Accent layer</label><select id="e-layer">${opt("", "None", !st.show.layer)}${st.effects.map(e => opt(e.id, e.name, st.show.layer?.effect === e.id)).join("")}</select><span class="help">An extra effect added on top, for example Hi-hat Starfield over a calm background.</span></div>
      <div class="field"><label for="e-lamt">Accent amount <output id="e-lamt-o">${Math.round((st.show.layer?.amount ?? 0.6) * 100)}%</output></label><input type="range" id="e-lamt" min="0.1" max="1.5" step="0.05" value="${st.show.layer?.amount ?? 0.6}"></div>
    </div>`, "span-8")}`;
  const prev = createPreview($("#e-stage"));
  const can = guestOk("effects");
  function grid() {
    const showing = app.status?.effect, pr = prefs();
    $("#e-grid").innerHTML = st.effects.filter(e => (tag === "all" || e.tag === tag || (tag === "liked" && pr[e.id] === 1) || (tag === "banned" && pr[e.id] === -1)) && (!q || e.name.toLowerCase().includes(q))).map(e =>
      `<div class="fx ${e.id === showing ? "showing" : ""} ${pr[e.id] === -1 ? "banned" : ""}" aria-pressed="${app.state.show.mode === "manual" && app.state.show.effect === e.id}">
        <button class="fx-main" data-fx="${e.id}" type="button"${can ? "" : " disabled"}><b>${esc(e.name)}</b><span>${tagName[e.tag] || e.tag}${params()[e.id] ? " · tuned" : ""}</span></button>
        <div class="fx-tools"><button class="fx-pref" data-like="${e.id}" aria-pressed="${pr[e.id] === 1}" title="Like: automatic mode picks it more" aria-label="Like ${esc(e.name)}" type="button"${can ? "" : " disabled"}>♥</button><button class="fx-pref" data-ban="${e.id}" aria-pressed="${pr[e.id] === -1}" title="Ban: automatic mode never picks it" aria-label="Ban ${esc(e.name)}" type="button"${can ? "" : " disabled"}>⊘</button></div></div>`).join("");
    $$("#e-grid [data-fx]").forEach(b => b.onclick = () => { selectFx(b.dataset.fx); act(() => api("PATCH", "/api/show", { effect: b.dataset.fx, mode: "manual" })).catch(() => {}); });
    const setPref = (id, v) => act(() => api("PATCH", `/api/effects/${id}`, { pref: prefs()[id] === v ? 0 : v })).then(() => refreshState()).then(grid).catch(() => {});
    $$("#e-grid [data-like]").forEach(b => b.onclick = () => setPref(b.dataset.like, 1));
    $$("#e-grid [data-ban]").forEach(b => b.onclick = () => setPref(b.dataset.ban, -1));
  }
  // effect settings: shown for the chosen effect (the one playing, until you pick another)
  const P = [["p-speed", "speed", 1, v => v + "×"], ["p-int", "intensity", 1, v => Math.round(v * 100) + "%"], ["p-hue", "hue", 0, v => (v > 0 ? "+" : "") + v + "°"], ["p-sat", "saturation", 1, v => Math.round(v * 100) + "%"]];
  function selectFx(id) {
    sel = id; $("#e-sel").value = id; $("#e-selname").textContent = st.effects.find(e => e.id === id)?.name || id; const cur = params()[id] || {};
    for (const [eid, key, def, fmt] of P) { const v = cur[key] ?? def; $("#" + eid).value = v; $(`#${eid}-o`).textContent = fmt(v); }
    $("#p-mirror").checked = !!cur.mirror;
  }
  let pt = null;
  const sendParams = () => { clearTimeout(pt); pt = setTimeout(() => { const id = sel, body = { mirror: $("#p-mirror").checked }; for (const [eid, key] of P) body[key] = Number($("#" + eid).value);
    api("PATCH", `/api/effects/${id}`, { params: body }).then(r => { app.state.show.params = app.state.show.params || {}; if (r.params) app.state.show.params[id] = r.params; else delete app.state.show.params[id]; }).catch(e => toast(e.message, true)); }, 120); };
  for (const [eid, , , fmt] of P) $("#" + eid).oninput = e => { $(`#${eid}-o`).textContent = fmt(Number(e.target.value)); sendParams(); };
  $("#p-mirror").onchange = sendParams;
  $("#e-sel").onchange = e => selectFx(e.target.value);
  $("#e-reset").onclick = () => act(() => api("PATCH", `/api/effects/${sel}`, { params: null })).then(() => refreshState()).then(() => selectFx(sel)).catch(() => {});
  if (!can) $$("#e-params input, #e-reset").forEach(x => x.disabled = true);
  grid(); selectFx(app.status?.effect || st.show.effect);
  $("#e-q").oninput = e => { q = e.target.value.toLowerCase(); grid(); };
  $$("#e-tags [data-tag]").forEach(b => b.onclick = () => { tag = b.dataset.tag; $$("#e-tags .chip").forEach(c => c.setAttribute("aria-pressed", c === b)); grid(); });
  const show = b => act(() => api("PATCH", "/api/show", b)).catch(() => {});
  $("#e-auto").onclick = () => show({ mode: "auto" });
  $("#e-style").onchange = e => show({ style: e.target.value }); $("#e-pal").onchange = e => show({ palette: e.target.value });
  $("#e-every").oninput = e => $("#e-every-o").textContent = e.target.value + " beats"; $("#e-every").onchange = e => show({ everyBeats: Number(e.target.value) });
  $("#e-speed").oninput = e => $("#e-speed-o").textContent = e.target.value + "×"; $("#e-speed").onchange = e => show({ speed: Number(e.target.value) });
  const layer = () => show({ layer: $("#e-layer").value ? { effect: $("#e-layer").value, amount: Number($("#e-lamt").value) } : null });
  $("#e-layer").onchange = layer; $("#e-lamt").oninput = e => $("#e-lamt-o").textContent = Math.round(e.target.value * 100) + "%"; $("#e-lamt").onchange = layer;
  if (!can) $$("#e-style, #e-pal, #e-every, #e-speed, #e-auto, #e-layer, #e-lamt").forEach(x => x.disabled = true);
  let lastFx = null, followed = true;
  $("#e-sel").addEventListener("change", () => { followed = false; });
  return { preview: true,
    onStatus(m) { $("#e-now").textContent = `${m.effectName}${app.state.show.mode === "auto" ? " (automatic)" : ""}`;
      if (m.effect !== lastFx) { lastFx = m.effect; grid(); if (followed && !el.contains(document.activeElement)) selectFx(m.effect); } },
    onChanged(w) { if (w.has("show")) { Object.assign(st, app.state); grid(); } },
    destroy() { prev.destroy(); } };
}

// ---------------------------------------------------------------- Live pads
const PADS = [
  { id: "flash", name: "Flash", desc: "White hit", key: "Space", hold: false },
  { id: "strobe", name: "Strobe", desc: "While held", key: "S", hold: true },
  { id: "blackout", name: "Blackout", desc: "Toggle", key: "B", toggle: true },
  { id: "freeze", name: "Freeze", desc: "Hold the picture", key: "F", toggle: true },
  { id: "build", name: "Build & drop", desc: "8 s build-up, then a drop", key: "U" },
  { id: "drop", name: "Drop now", desc: "Full energy for 8 s", key: "D" },
  { id: "next", name: "Next effect", desc: "Skip to another", key: "N" },
  { id: "boost", name: "Boost", desc: "Brighter while held", key: "X", hold: true },
  { id: "tap", name: "Tap tempo", desc: "Tap 4 times", key: "T" },
  { id: "cancel", name: "Clear all", desc: "Undo everything", key: "Esc" },
];
const COLORS = ["#ff2bd6", "#16e0ff", "#ffd23f", "#ff3d3d", "#20ffa8", "#7a3cff", "#ffffff"];
function livePage(el) {
  el.innerHTML = `${panel("Live pads", "Play the lights like an instrument. Keyboard shortcuts work on this page.", "", `<div class="pb stack"><div class="pads" id="pads">${PADS.map(p => `<button class="pad" data-pad="${p.id}" type="button"><b>${p.name}</b><span>${p.desc}</span><kbd>${p.key}</kbd></button>`).join("")}</div>
      <div class="field"><span class="lbl">Colour hold (tap again to release)</span><div class="swatches" id="holds">${COLORS.map(c => `<button class="swatch" style="background:${c}" data-c="${c}" aria-label="Hold ${c}" type="button"></button>`).join("")}</div></div>
      <div class="field"><span class="lbl">Flash colour</span><div class="swatches" id="flashc">${COLORS.map((c, i) => `<button class="swatch" style="background:${c}" data-c="${c}" aria-pressed="${i === 6}" aria-label="Flash ${c}" type="button"></button>`).join("")}</div></div></div>`, "span-7")}
    ${panel("Preview", `<span id="l-now"></span>`, "", `<div class="stage" id="l-stage"></div>`, "span-5")}
    ${panel("Scenes", "", "", `<div class="pb chips">${app.state.scenes.map(s => `<button class="chip" data-scene="${s.id}" type="button">${esc(s.name)}</button>`).join("")}</div>`, "span-5")}
    ${panel("MIDI controller", `<span id="midi-st">${navigator.requestMIDIAccess ? "Not connected" : "This browser has no MIDI (try Chrome or Edge on a computer)"}</span>`, navigator.requestMIDIAccess ? `<button class="btn" id="midi-on" type="button">Connect</button><button class="btn" id="midi-learn" type="button" aria-pressed="false">Learn</button>` : "",
      `<div class="pb"><p class="faint" style="font-size:12.5px">Pads play from notes 36 to 45 (the bottom pads on most controllers). To change one, press Learn, tap a pad here, then hit the key or pad on your controller.</p></div>`, "span-5")}
    ${panel("Phones as lights", `<span id="ph-n">No phones yet</span>`, "", `<div class="pb phones"><div class="qr" id="ph-qr" aria-live="polite"></div><div class="stack">
      <p>Guests scan this code, tap Start, and their screen becomes another light that moves with the room. Works best with a crowd holding phones up at the drop.</p>
      <p class="faint" style="font-size:12.5px" id="ph-url"></p>
      ${DEMO ? `<p class="callout">In the online demo, open the link in another tab of this browser. At home, phones on the same Wi-Fi scan the code.</p>` : `<p class="faint" style="font-size:12.5px">Phones must be on the same Wi-Fi as this Tempolight.</p>`}</div></div>`, "span-7")}`;
  const prev = createPreview($("#l-stage"));
  phoneQr();
  if (!guestOk("pads")) { $$(".pad, .swatch").forEach(b => b.disabled = true); }
  let flashColor = "#ffffff", holdColor = null;
  const send = a => { if (ws.open) ws.send({ type: "action", action: a }); else api("POST", "/api/action", a).catch(e => toast(e.message, true)); };
  const press = (id, down) => {
    const p = PADS.find(x => x.id === id); if (!p) return; const b = $(`[data-pad="${id}"]`); b && b.classList.toggle("down", down);
    if (p.hold) { if (id === "strobe") send({ type: "strobe", on: down }); if (id === "boost") send({ type: "boost", value: down ? 1.8 : 1 }); return; }
    if (!down) return;
    if (id === "flash") send({ type: "flash", color: flashColor }); else send({ type: id });
  };
  $$(".pad").forEach(b => {
    b.onpointerdown = e => { e.preventDefault(); b.setPointerCapture(e.pointerId); press(b.dataset.pad, true); };
    b.onpointerup = b.onpointercancel = () => press(b.dataset.pad, false);
    b.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); if (!e.repeat) press(b.dataset.pad, true); } };
    b.onkeyup = e => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); press(b.dataset.pad, false); } };
  });
  $$("#holds .swatch").forEach(b => b.onclick = () => { holdColor = holdColor === b.dataset.c ? null : b.dataset.c; $$("#holds .swatch").forEach(x => x.setAttribute("aria-pressed", x.dataset.c === holdColor)); send({ type: "hold", color: holdColor }); });
  $$("#flashc .swatch").forEach(b => b.onclick = () => { flashColor = b.dataset.c; $$("#flashc .swatch").forEach(x => x.setAttribute("aria-pressed", x === b)); });
  $$("[data-scene]").forEach(b => b.onclick = () => act(() => api("POST", `/api/scenes/${b.dataset.scene}/apply`), `Scene: ${b.textContent}`).catch(() => {}));
  const keymap = { " ": "flash", s: "strobe", b: "blackout", f: "freeze", u: "build", d: "drop", n: "next", x: "boost", t: "tap", escape: "cancel" };
  const kd = e => { if (e.target.closest("input,select,textarea,.pad")) return; const id = keymap[e.key.toLowerCase()]; if (!id) return; e.preventDefault(); if (!e.repeat) press(id, true); };
  const ku = e => { if (e.target.closest("input,select,textarea,.pad")) return; const id = keymap[e.key.toLowerCase()]; if (id) press(id, false); };
  addEventListener("keydown", kd); addEventListener("keyup", ku);
  // MIDI: notes trigger pads; Learn maps a note to the next pad you tap
  const midiKey = "tl.midi"; let map = {}; try { map = JSON.parse(localStorage.getItem(midiKey) || "{}"); } catch {}
  if (!Object.keys(map).length) PADS.forEach((p, i) => { map[36 + i] = p.id; });
  let learning = false, learnPad = null, midi = null;
  const saveMap = () => { try { localStorage.setItem(midiKey, JSON.stringify(map)); } catch {} };
  const onMidi = e => { const [st0, note, vel] = e.data, cmd = st0 & 0xf0; if (cmd !== 0x90 && cmd !== 0x80) return; const down = cmd === 0x90 && vel > 0;
    if (learning && learnPad && down) { for (const k of Object.keys(map)) if (map[k] === learnPad) delete map[k]; map[note] = learnPad; saveMap(); $("#midi-st").textContent = `Note ${note} → ${PADS.find(p => p.id === learnPad).name}`; learnPad = null; return; }
    const id = map[note]; if (id) press(id, down); };
  if ($("#midi-on")) {
    $("#midi-on").onclick = async () => { try { midi = await navigator.requestMIDIAccess(); const hook = () => { const ins = [...midi.inputs.values()]; ins.forEach(i => i.onmidimessage = onMidi);
        $("#midi-st").textContent = ins.length ? `Connected: ${ins.map(i => i.name).join(", ")}` : "No MIDI controller found. Plug one in."; }; hook(); midi.onstatechange = hook; }
      catch (e) { $("#midi-st").textContent = "MIDI permission was refused"; } };
    $("#midi-learn").onclick = () => { learning = !learning; $("#midi-learn").setAttribute("aria-pressed", learning); $("#midi-st").textContent = learning ? "Learn: tap a pad here, then hit a key on the controller" : "Learn off"; };
    $$(".pad").forEach(b => b.addEventListener("pointerdown", () => { if (learning) learnPad = b.dataset.pad; }, true));
  }
  return { preview: true,
    onStatus(m) { $("#l-now").textContent = m.effectName; const o = m.overlay; $("#ph-n").textContent = m.phones ? `${m.phones} phone${m.phones > 1 ? "s" : ""} joined` : "No phones yet";
      $('[data-pad="blackout"]').setAttribute("aria-pressed", o.blackout); $('[data-pad="freeze"]').setAttribute("aria-pressed", o.freeze);
      $('[data-pad="strobe"]').setAttribute("aria-pressed", o.strobe); $('[data-pad="build"]').classList.toggle("hot", o.forced === "build"); $('[data-pad="drop"]').classList.toggle("hot", o.forced === "drop"); },
    destroy() { prev.destroy(); removeEventListener("keydown", kd); removeEventListener("keyup", ku); if (midi) [...midi.inputs.values()].forEach(i => i.onmidimessage = null); } };
}

/** A link a guest's phone can open: a phone can't reach "localhost", so use this computer's network address. */
async function guestUrl(path) {
  if (!DEMO && /^(localhost|127\.|\[?::1)/.test(location.hostname)) {
    const n = await api("GET", "/api/network").catch(() => ({ addresses: [] })), a = n.addresses.find(x => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(x)) || n.addresses[0];
    if (a) return `${location.protocol}//${a}${location.port ? ":" + location.port : ""}${path}`; }
  return location.origin + path;
}
async function phoneQr() {
  const url = await guestUrl("/phone");
  const { qrSvg } = await import("/qr.js"), box = $("#ph-qr"); if (!box) return;
  box.innerHTML = qrSvg(url, { px: 5 }); $("#ph-url").innerHTML = `Or open <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
}

// ---------------------------------------------------------------- Scenes & schedules
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function scenesPage(el) {
  const st = app.state, canScenes = guestOk("scenes"), admin = unlocked();
  const actName = a => a.type === "scene" ? `Scene: ${st.scenes.find(s => s.id === a.scene)?.name || "(deleted)"}` : a.type === "on" ? "Lights on" : a.type === "off" ? "Lights off" : `Brightness ${Math.round(a.value * 100)}%`;
  const showName = sc => sc.show.mode === "manual" ? (st.effects.find(e => e.id === sc.show.effect)?.name || sc.show.effect) : `Automatic${sc.show.style && sc.show.style !== "auto" ? ", " + (st.styles[sc.show.style] || sc.show.style) : ""}`;
  el.innerHTML = `${panel("Scenes", "A scene remembers the effect, style, colours and brightness", `<button class="btn primary" id="sc-save" type="button"${canScenes ? "" : " disabled"}>Save current as scene</button>`, `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Effect</th><th>Colours</th><th class="num">Brightness</th><th></th></tr></thead><tbody>
      ${st.scenes.map(sc => `<tr><td>${esc(sc.name)}</td><td>${esc(showName(sc))}</td><td>${esc(sc.show.palette || "auto")}</td><td class="num">${Math.round((sc.brightness ?? 1) * 100)}%</td>
        <td><button class="btn sm primary" data-apply="${sc.id}" type="button"${canScenes ? "" : " disabled"}>Apply</button> <button class="btn sm" data-ren="${sc.id}" type="button"${canScenes ? "" : " disabled"}>Rename</button> <button class="btn sm" data-upd="${sc.id}" type="button"${canScenes ? "" : " disabled"}>Update to current</button> <button class="btn sm danger" data-del="${sc.id}" type="button"${canScenes ? "" : " disabled"}>Delete</button></td></tr>`).join("") || '<tr><td colspan="5" class="faint">No scenes</td></tr>'}
    </tbody></table></div>`, "span-12")}
    ${panel("Schedules", `Times are this server's local time (${new Date().toTimeString().slice(9, 17)})`, "", `<div class="tablewrap"><table><thead><tr><th>On</th><th>Name</th><th>Time</th><th>Days</th><th>Action</th><th>Next run</th><th></th></tr></thead><tbody>
      ${st.schedules.map(s => `<tr><td><input type="checkbox" data-en="${s.id}" ${s.enabled ? "checked" : ""}${admin ? "" : " disabled"} aria-label="Enabled"></td><td>${esc(s.name)}</td><td class="mono">${/^sun/.test(s.time) ? esc(s.time.replace(/^sunrise/, "Sunrise ").replace(/^sunset/, "Sunset ").replace(/([+-])(\d+)/, "$1$2 min")) : s.time}</td><td class="mono">${s.days.length === 7 ? "Every day" : s.days.map(d => DAYS[d]).join(" ")}</td><td>${esc(actName(s.action))}</td>
        <td class="mono faint">${s.next ? new Date(s.next).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "–"}</td><td><button class="btn sm" data-run="${s.id}" type="button"${admin ? "" : " disabled"}>Run now</button> <button class="btn sm danger" data-sdel="${s.id}" type="button"${admin ? "" : " disabled"}>Delete</button></td></tr>`).join("") || '<tr><td colspan="7" class="faint">No schedules yet. Add one below, for example “Chill evening at 19:00 on weekdays” or “Lights off at 01:00”.</td></tr>'}
    </tbody></table></div>
    <div class="pb" style="border-top:1px solid var(--line-2)"><div class="controls" style="grid-template-columns:repeat(5,minmax(0,1fr))">
      <div class="field"><label for="t-name">Name</label><input id="t-name" placeholder="Evening"></div>
      <div class="field"><label for="t-kind">When</label><div class="row" style="flex-wrap:nowrap"><select id="t-kind" style="width:auto">${opt("time", "At")}${opt("sunset", "Sunset")}${opt("sunrise", "Sunrise")}</select><input type="time" id="t-time" value="19:00"><input type="number" id="t-off" value="0" step="5" min="-180" max="180" title="Minutes after (+) or before (−)" aria-label="Minutes after or before" hidden style="width:80px"></div>
        <span class="help" id="t-kindhelp" hidden>Minutes after (+) or before (−). ${st.settings.location ? "" : "Set your location in Settings first."}</span></div>
      <div class="field"><span class="lbl">Days</span><div class="days" id="t-days">${DAYS.map((d, i) => `<label><input type="checkbox" value="${i}" checked><span>${d[0]}${d[1]}</span></label>`).join("")}</div></div>
      <div class="field"><label for="t-act">Action</label><select id="t-act">${st.scenes.map(s => opt("scene:" + s.id, "Scene: " + s.name)).join("")}${opt("on", "Lights on")}${opt("off", "Lights off")}${opt("b25", "Brightness 25%")}${opt("b100", "Brightness 100%")}</select></div>
      <div class="field"><span class="lbl">&nbsp;</span><button class="btn primary" id="t-add" type="button"${admin ? "" : " disabled"}>Add schedule</button></div>
    </div>${admin ? "" : '<p class="faint" style="margin-top:8px">Schedules are locked. Unlock in Settings to change them.</p>'}</div>`, "span-12")}`;
  const re = () => refreshState().then(route);
  $("#sc-save").onclick = async () => { const name = prompt("Name for this scene:", "My scene"); if (name) { await act(() => api("POST", "/api/scenes", { name }), "Scene saved").catch(() => {}); re(); } };
  $$("[data-apply]").forEach(b => b.onclick = () => act(() => api("POST", `/api/scenes/${b.dataset.apply}/apply`), "Scene applied").catch(() => {}));
  $$("[data-ren]").forEach(b => b.onclick = async () => { const sc = st.scenes.find(s => s.id === b.dataset.ren); const name = prompt("New name:", sc.name); if (name) { await act(() => api("PUT", `/api/scenes/${sc.id}`, { name })).catch(() => {}); re(); } });
  $$("[data-upd]").forEach(b => b.onclick = async () => { const sh = app.state.show; await act(() => api("PUT", `/api/scenes/${b.dataset.upd}`, { show: { mode: sh.mode, effect: sh.effect, style: sh.style, palette: sh.palette, everyBeats: sh.everyBeats, speed: sh.speed }, brightness: app.state.settings.brightness }), "Scene updated").catch(() => {}); re(); });
  $$("[data-del]").forEach(b => b.onclick = async () => { if (confirm("Delete this scene?")) { await act(() => api("DELETE", `/api/scenes/${b.dataset.del}`)).catch(() => {}); re(); } });
  $$("[data-en]").forEach(b => b.onchange = async () => { await act(() => api("PUT", `/api/schedules/${b.dataset.en}`, { enabled: b.checked })).catch(() => {}); re(); });
  $$("[data-run]").forEach(b => b.onclick = () => act(() => api("POST", `/api/schedules/${b.dataset.run}/run`), "Done").catch(() => {}));
  $$("[data-sdel]").forEach(b => b.onclick = async () => { await act(() => api("DELETE", `/api/schedules/${b.dataset.sdel}`)).catch(() => {}); re(); });
  $("#t-add").onclick = async () => {
    const v = $("#t-act").value, action = v.startsWith("scene:") ? { type: "scene", scene: v.slice(6) } : v === "b25" ? { type: "brightness", value: 0.25 } : v === "b100" ? { type: "brightness", value: 1 } : { type: v };
    const days = $$("#t-days input:checked").map(x => Number(x.value));
    const kind = $("#t-kind").value, off = Math.round(Number($("#t-off").value) || 0), time = kind === "time" ? $("#t-time").value : kind + (off ? (off > 0 ? "+" : "") + off : "");
    await act(() => api("POST", "/api/schedules", { name: $("#t-name").value || $("#t-act").selectedOptions[0].textContent, time, days, action }), "Schedule added").catch(() => {}); re();
  };
  $("#t-kind").onchange = e => { const sun = e.target.value !== "time"; $("#t-time").hidden = sun; $("#t-off").hidden = !sun; $("#t-kindhelp").hidden = !sun; };
  return { onChanged(w) { if (w.has("scenes") || w.has("schedules")) route(); } };
}

// ---------------------------------------------------------------- Devices
function devicesPage(el) {
  if (!unlocked()) return lockScreen(el, "Device setup");
  const st = app.state;
  el.innerHTML = `${panel("Devices", "WLED controllers and other lights that receive the show", `<button class="btn" id="d-scan" type="button">Scan network</button><button class="btn" id="d-virtual" type="button">Add virtual device</button>`, `<div class="tablewrap"><table><thead><tr><th>On</th><th>Name</th><th>Address</th><th class="num">LEDs</th><th class="num">Used</th><th>Protocol</th><th class="num">Port / universe</th><th class="num" title="Power supply limit in amps. Brightness is capped so the strip never draws more.">Power limit (A)</th><th class="num">Drawing now</th><th>Status</th><th>Firmware</th><th class="num">Frames sent</th><th></th></tr></thead><tbody id="d-rows"></tbody></table></div>`, "span-12")}
    ${panel("Add a controller", "", "", `<div class="pb"><div class="row"><input id="d-ip" placeholder="IP address, e.g. 192.168.1.42 (or host:port)" style="max-width:340px"><input id="d-name" placeholder="Name (optional)" style="max-width:220px"><select id="d-kind" aria-label="Kind of light" style="max-width:190px">${opt("wled", "WLED", true)}${opt("govee", "Govee (LAN, beta)")}${opt("openrgb", "OpenRGB (PC lighting)")}${opt("nanoleaf", "Nanoleaf panels")}${opt("hue", "Philips Hue bridge (calm effects)")}</select><button class="btn primary" id="d-add" type="button">Add</button></div>
      ${DEMO ? `<p class="callout" style="margin-top:8px">This demo has pretend controllers at ${Object.keys(demo.FAKE_WLED).join(", ")}. Press “Scan network” to find them.</p>` : ""}
      <p class="faint" style="margin-top:8px;font-size:12.5px">Power limit: enter your power supply's amps (for example 10 for a 5 V 10 A supply) and Tempolight keeps the strip under it, estimating about 60 mA per LED at full white. Find the address in the WLED app or your router. Tempolight sends light with DDP on UDP port 4048; in WLED, keep “Receive UDP realtime” on (Sync settings).
      OpenRGB (RAM, fans, keyboards, motherboards): start OpenRGB's SDK server, then Scan network. Nanoleaf: hold the controller's power button for 5–7 seconds until the lights flash, then add its address; the panels appear in the room where they really are. Philips Hue: press the bridge's link button, then add the bridge's address; Hue changes colour slowly, so it suits calm effects. Govee lights (beta): turn on “LAN Control” for the light in the Govee Home app. One colour works on all LAN models; segments mode uses Govee's DreamView streaming and only some models support it.</p></div>`, "span-6")}
    ${panel("Found on the network", `<span id="d-scanmsg">Press “Scan network” to look</span>`, "", `<div class="tablewrap"><table><tbody id="d-found"></tbody></table></div>`, "span-6")}`;
  function rows(m) {
    const s = m || app.status || { devices: [] };
    $("#d-rows").innerHTML = st.devices.map(d => { const h = s.devices.find(x => x.id === d.id) || {};
      const sig = h.signal != null ? `<span class="sig" title="Wi-Fi ${h.signal}%">${[25, 50, 75, 100].map((v, i) => `<i style="height:${4 + i * 3}px" class="${h.signal >= v - 12 ? "on" : ""}"></i>`).join("")}</span>` : "";
      return `<tr><td><input type="checkbox" data-en="${d.id}" ${d.enabled ? "checked" : ""} aria-label="Send to this device"></td><td><input value="${esc(d.name)}" data-name="${d.id}" style="width:150px"></td>
        <td>${d.virtual ? '<span class="faint">virtual</span>' : `<input class="mono" value="${esc(d.host)}" data-host="${d.id}" style="width:150px">`}</td>
        <td class="num"><input type="number" min="1" value="${d.leds || ""}" data-leds="${d.id}"></td><td class="num">${h.used ?? 0}</td><td>${d.virtual ? "–" : d.kind === "hue" ? "Hue (about 10 updates/s)" : d.kind === "nanoleaf" ? "Nanoleaf stream" : d.kind === "openrgb" ? `OpenRGB #${d.orgbIndex || 0}` : d.kind === "govee" ? `<select data-gmode="${d.id}" aria-label="Govee mode">${opt("color", "Govee: one colour", d.goveeMode !== "segments")}${opt("segments", "Govee: segments (beta)", d.goveeMode === "segments")}</select>` : `<select data-proto="${d.id}" aria-label="Protocol">${opt("ddp", "DDP", !d.protocol || d.protocol === "ddp")}${opt("e131", "E1.31 (sACN)", d.protocol === "e131")}${opt("artnet", "Art-Net", d.protocol === "artnet")}</select>`}</td>
        <td class="num">${d.virtual ? "–" : d.kind === "govee" ? (d.goveeMode === "segments" ? `<input type="number" min="1" max="60" title="Segments on the light" placeholder="segments" value="${d.goveeSegments || ""}" data-gseg="${d.id}" aria-label="Segments">` : "–") : (!d.protocol || d.protocol === "ddp") ? `<input type="number" min="1" max="65535" value="${d.ddpPort || 4048}" data-port="${d.id}">` : `<input type="number" min="0" max="63999" title="First universe" value="${d.universe ?? (d.protocol === "artnet" ? 0 : 1)}" data-univ="${d.id}" aria-label="First universe">`}</td>
        <td class="num"><input type="number" min="0" max="500" step="0.5" placeholder="none" value="${d.maxAmps || ""}" data-amps="${d.id}" aria-label="Power limit in amps"></td>
        <td class="num">${h.amps != null ? `${h.amps.toFixed(1)} A${h.limited ? ' <span class="badge warn" title="Brightness is being held back to stay under the limit">capped</span>' : ""}` : "–"}</td>
        <td>${!d.enabled ? '<span class="badge">Off</span>' : h.online ? `<span class="badge live"><i></i>Online</span> ${sig}` : h.online === false ? `<span class="badge err" title="${esc(h.error)}"><i></i>Offline</span>` : '<span class="badge">Checking</span>'}</td>
        <td class="mono faint">${esc(h.version || "")}</td><td class="num">${h.sent ?? 0}</td>
        <td><button class="btn sm" data-id="${d.id}" type="button">Identify</button> ${d.virtual || d.kind ? "" : `<button class="btn sm" data-seg="${d.id}" type="button" title="Write this room's segments into WLED">Send segments</button> <button class="btn sm" data-chk="${d.id}" type="button">Check</button>`} <button class="btn sm danger" data-del="${d.id}" type="button">Remove</button></td></tr>`; }).join("")
      || '<tr><td colspan="13" class="faint">No devices yet. Scan the network or add one by address.</td></tr>';
    const patch = (id, b) => act(() => api("PATCH", `/api/devices/${id}`, b), "Saved").catch(() => {});
    $$("[data-en]").forEach(x => x.onchange = () => patch(x.dataset.en, { enabled: x.checked }));
    $$("[data-name]").forEach(x => x.onchange = () => patch(x.dataset.name, { name: x.value }));
    $$("[data-host]").forEach(x => x.onchange = () => patch(x.dataset.host, { host: x.value }));
    $$("[data-leds]").forEach(x => x.onchange = () => patch(x.dataset.leds, { leds: Number(x.value) }));
    $$("[data-port]").forEach(x => x.onchange = () => patch(x.dataset.port, { ddpPort: Number(x.value) }));
    $$("[data-amps]").forEach(x => x.onchange = () => patch(x.dataset.amps, { maxAmps: Number(x.value) || 0 }));
    $$("[data-proto]").forEach(x => x.onchange = () => patch(x.dataset.proto, { protocol: x.value }));
    $$("[data-univ]").forEach(x => x.onchange = () => patch(x.dataset.univ, { universe: Number(x.value) }));
    $$("[data-gmode]").forEach(x => x.onchange = () => patch(x.dataset.gmode, { goveeMode: x.value }));
    $$("[data-gseg]").forEach(x => x.onchange = () => patch(x.dataset.gseg, { goveeSegments: Number(x.value) || null }));
    $$("[data-id]").forEach(x => x.onclick = () => api("POST", `/api/devices/${x.dataset.id}/identify`).then(() => toast("Lighting it up in white")).catch(e => toast(e.message, true)));
    $$("[data-seg]").forEach(x => x.onclick = () => act(() => api("POST", `/api/devices/${x.dataset.seg}/segments`), "Segments sent to WLED").catch(() => {}));
    $$("[data-chk]").forEach(x => x.onclick = () => act(() => api("POST", `/api/devices/${x.dataset.chk}/check`)).then(h => toast(h.online ? `Online, WLED ${h.version}, ${h.ledsReported} LEDs` : `Offline: ${h.error}`, !h.online)).catch(() => {}));
    $$("[data-del]").forEach(x => x.onclick = () => { if (confirm("Remove this device and its shapes from the room?")) act(() => api("DELETE", `/api/devices/${x.dataset.del}`), "Removed").catch(() => {}); });
  }
  rows();
  $("#d-kind").onchange = e => { if (e.target.value === "openrgb" && !$("#d-ip").value) $("#d-ip").value = "127.0.0.1"; };
  $("#d-add").onclick = () => act(() => api("POST", "/api/devices", { host: $("#d-ip").value, name: $("#d-name").value || undefined, kind: $("#d-kind").value === "wled" ? undefined : $("#d-kind").value }), "Device added").catch(e => {
    if (/add it anyway/.test(e.message) && confirm(e.message + "\n\nAdd it anyway?")) act(() => api("POST", "/api/devices", { host: $("#d-ip").value, name: $("#d-name").value || undefined, force: true }), "Device added").catch(() => {}); });
  $("#d-virtual").onclick = () => act(() => api("POST", "/api/devices", { virtual: true, name: "Virtual room" }), "Virtual device added").catch(() => {});
  $("#d-scan").onclick = async () => {
    $("#d-scanmsg").textContent = "Scanning…"; $("#d-scan").disabled = true;
    try { const found = await act(() => api("POST", "/api/discover", { scan: true }));
      $("#d-scanmsg").textContent = found.length ? `${found.length} found` : "None found. Check the controllers are on the same network.";
      $("#d-found").innerHTML = found.map((f, i) => `<tr><td>${esc(f.name || "WLED")}</td><td class="mono">${esc(f.host)}</td><td class="num">${f.kind === "govee" ? "Govee" : `${f.leds ?? "?"} LEDs`}</td><td class="faint">${f.kind === "govee" ? "LAN" : f.kind === "openrgb" ? "OpenRGB" : f.via === "mdns" ? "mDNS" : "scan"}</td><td>${f.added ? '<span class="faint">added</span>' : `<button class="btn sm primary" data-f="${i}" type="button">Add</button>`}</td></tr>`).join("");
      $$("[data-f]").forEach(b => b.onclick = () => { const f = found[Number(b.dataset.f)]; act(() => api("POST", "/api/devices", f.kind === "govee" ? { host: f.host, name: f.name, kind: "govee" } : f.kind === "openrgb" ? { host: f.host, name: f.name, kind: "openrgb", index: f.index, leds: f.leds } : { host: f.host, name: f.name, leds: f.leds, force: true }), "Device added").then(() => b.replaceWith("added")).catch(() => {}); });
    } catch {} finally { $("#d-scan").disabled = false; }
  };
  return { onStatus(m) { if (!el.contains(document.activeElement) || document.activeElement === document.body) rows(m); }, onChanged(w) { if (w.has("devices")) route(); } };
}

// ---------------------------------------------------------------- Settings
function settingsPage(el) {
  const st = app.state, s = st.settings, admin = unlocked();
  const ambOpts = `${opt("off", "Off (dark when nothing plays)", s.ambient === "off")}${st.effects.filter(e => e.tag === "calm").map(e => opt(e.id, e.name, e.id === s.ambient)).join("")}`;
  el.innerHTML = `${!admin ? panel("Settings are locked", "", "", `<div class="pb"><div class="row"><input id="u-pin" type="password" inputmode="numeric" placeholder="PIN" style="max-width:160px"><button class="btn primary" id="u-go" type="button">Unlock</button></div></div>`) : ""}
    ${panel("Lighting", "", "", `<div class="pb controls">
      <div class="field"><label for="s-amb">When nothing plays</label><select id="s-amb">${ambOpts}</select><span class="help">Also used as a soft floor so quiet songs never turn the room dark.</span></div>
      <div class="field"><label for="s-idleb">Idle brightness <output id="s-idleb-o">${Math.round(s.idleBrightness * 100)}%</output></label><input type="range" id="s-idleb" min="0" max="1" step="0.05" value="${s.idleBrightness}"></div>
      <div class="field"><label for="s-idlea">Go idle after <output id="s-idlea-o">${s.idleAfterSec} s</output> of silence</label><input type="range" id="s-idlea" min="2" max="60" step="1" value="${s.idleAfterSec}"></div>
      <div class="field"><label for="s-fps">Frame rate <output id="s-fps-o">${s.fps} fps</output></label><input type="range" id="s-fps" min="20" max="90" step="5" value="${s.fps}"><span class="help">Lower it on a Raspberry Pi Zero or busy Wi-Fi.</span></div>
      <label class="check"><input type="checkbox" id="s-safe" ${s.safe ? "checked" : ""}> Photosensitive-safe mode (at most 3 flashes a second)</label>
      <label class="check"><input type="checkbox" id="s-dropf" ${s.dropFlash ? "checked" : ""}> Flash on drops</label>
    </div>`, "span-12")}
    ${panel("Integrations", "", "", `<div class="pb controls">
      <label class="check"><input type="checkbox" id="s-sync" ${s.audioSync ? "checked" : ""}> Send WLED audio sync (lets WLED's own sound effects react too)</label>
      <div class="field"><label class="check"><input type="checkbox" id="s-osc" ${s.osc.enabled ? "checked" : ""}> OSC control on UDP port</label><input type="number" id="s-oscport" value="${s.osc.port}" style="width:110px"><span class="help">/tempolight/effect laser, /scene Party, /flash, /blackout 1, /brightness 0.5 …</span></div>
      <label class="check"><input type="checkbox" id="s-dj" ${s.djlink?.enabled ? "checked" : ""} ${DEMO ? "disabled" : ""}> Pioneer Pro DJ Link: take the beat from CDJs and XDJs on this network (listens only)</label>
      <label class="check"><input type="checkbox" id="s-disc" ${s.autoDiscover ? "checked" : ""}> Look for WLED controllers on first start</label>
      <div class="field"><span class="lbl">HTTP API</span><span class="help">Home Assistant, Stream Deck and scripts can call the JSON API, e.g. <span class="mono">POST /api/scenes/&lt;id&gt;/apply</span>. See docs/api.md.</span></div>
    </div>`, "span-12")}
    ${panel("Night mode and location", s.night.enabled ? "On" : "Off", "", `<div class="pb controls">
      <label class="check"><input type="checkbox" id="n-on" ${s.night.enabled ? "checked" : ""}> Calmer light at night: brightness cap, warm colours, no strobes or drop flashes</label>
      <div class="field"><label for="n-from">From</label><input id="n-from" value="${esc(s.night.from)}" placeholder="23:00 or sunset"></div>
      <div class="field"><label for="n-to">Until</label><input id="n-to" value="${esc(s.night.to)}" placeholder="07:00 or sunrise"></div>
      <div class="field"><label for="n-max">Brightness at night <output id="n-max-o">${Math.round(s.night.maxBrightness * 100)}%</output></label><input type="range" id="n-max" min="0.05" max="1" step="0.05" value="${s.night.maxBrightness}"></div>
      <label class="check"><input type="checkbox" id="n-warm" ${s.night.warm ? "checked" : ""}> Warm colours only</label>
      <div class="field"><label>Location (for sunrise and sunset)</label><div class="row" style="flex-wrap:nowrap"><input id="l-lat" type="number" step="0.0001" placeholder="Latitude" value="${s.location?.lat ?? ""}"><input id="l-lon" type="number" step="0.0001" placeholder="Longitude" value="${s.location?.lon ?? ""}"></div>
        <div class="row"><button class="btn sm" id="l-geo" type="button">Use my location</button><button class="btn sm" id="l-save" type="button">Save location</button></div><span class="help" id="l-help">${s.location ? `Sunrise and sunset are worked out for ${s.location.lat}, ${s.location.lon}.` : "Needed for schedules and night mode that start at sunset or sunrise."}</span></div>
    </div>`, "span-12")}
    ${panel("Text on matrix panels", "Shown by the Text Scroller effect", "", `<div class="pb controls">
      <div class="field"><label for="x-src">Show</label><select id="x-src">${opt("song", "What's playing", s.text.source === "song")}${opt("bpm", "The tempo", s.text.source === "bpm")}${opt("clock", "The time", s.text.source === "clock")}${opt("custom", "My own text", s.text.source === "custom")}</select></div>
      <div class="field"><label for="x-custom">My own text</label><input id="x-custom" maxlength="80" value="${esc(s.text.custom)}"></div>
    </div>`, "span-6")}
    ${panel("Home Assistant", `<span id="m-state">${s.mqtt?.enabled ? "Connecting…" : "Off"}</span>`, "", `<div class="pb controls">
      <label class="check"><input type="checkbox" id="m-on" ${s.mqtt?.enabled ? "checked" : ""}> Connect to Home Assistant through MQTT (it finds Tempolight by itself)</label>
      <div class="field"><label for="m-url">MQTT broker</label><input id="m-url" placeholder="mqtt://192.168.1.10:1883" value="${esc(s.mqtt?.url || "")}"></div>
      <div class="field"><label for="m-user">User name</label><input id="m-user" autocomplete="off" value="${esc(s.mqtt?.username || "")}"></div>
      <div class="field"><label for="m-pass">Password</label><input id="m-pass" type="password" autocomplete="new-password" placeholder="${s.mqtt?.hasPassword ? "(saved)" : ""}"></div>
      <span class="help">In Home Assistant, add the Mosquitto broker add-on and the MQTT integration, then use the same broker here. Tempolight appears as a light with effects, a scene picker, tempo and song-part sensors, and Flash, Drop and Next buttons.</span>
      <div class="row"><button class="btn sm" id="m-save" type="button">Save</button></div>
    </div>`, "span-6")}
    ${panel("Backup", "Devices, room, zones, scenes, schedules and settings in one file", "", `<div class="pb stack"><div class="row"><button class="btn" id="b-down" type="button">Download backup</button><label class="btn" for="b-file">Restore from a file…</label><input type="file" id="b-file" accept="application/json,.json" hidden></div>
      <p class="faint" style="font-size:12.5px">Use it to move to a new computer or Raspberry Pi. Restoring keeps your current PIN.</p></div>`, "span-6")}
    ${panel("Lock", st.locked ? "Locked with a PIN" : "Not locked", "", `<div class="pb stack">
      <p class="muted">A PIN stops guests at a party from changing devices, the room, schedules and settings. Choose what guests can still do:</p>
      <div class="row">${[["effects", "Pick effects"], ["scenes", "Use scenes"], ["pads", "Use live pads"], ["brightness", "Brightness and power"]].map(([k, l]) => `<label class="check"><input type="checkbox" data-guest="${k}" ${s.guest[k] ? "checked" : ""}> ${l}</label>`).join("")}</div>
      <div class="row">${st.locked ? `<button class="btn" id="s-unlockset" type="button">Remove PIN</button>${app.token ? '<button class="btn" id="s-relock" type="button">Lock now on this device</button>' : ""}` : `<input id="s-pin" type="password" inputmode="numeric" placeholder="New PIN (4–8 digits)" style="max-width:220px"><button class="btn primary" id="s-lock" type="button">Lock settings</button>`}</div>
    </div>`, "span-6")}
    ${panel("About", "", "", `<div class="pb stack"><p>Tempolight ${esc(st.version)}, MIT licence. <a href="https://github.com/D4RKGEEK/tempolight" target="_blank" rel="noopener">Source and docs</a>.</p>
      <p class="muted">The old single-page playground is at <a href="/playground">/playground</a>.</p>
      <div class="row"><button class="btn" id="s-upd" type="button">${DEMO ? "Always up to date" : "Check for updates"}</button><button class="btn primary" id="s-updgo" type="button" hidden>Update now</button><button class="btn danger" id="s-reset" type="button">Reset everything</button></div>
      <div id="s-updmsg" class="faint" style="font-size:13px" aria-live="polite"></div></div>`, "span-6")}`;
  if (!admin) {
    $$("#page input:not(#u-pin), #page select, #page button:not(#u-go)").forEach(x => x.disabled = true);
    const go = async () => { const r = await act(() => api("POST", "/api/unlock", { pin: $("#u-pin").value })); app.token = r.token; store.set("token", r.token); ws.sock?.close(); await refreshState(); route(); };
    $("#u-go").onclick = () => go().catch(() => {}); $("#u-pin").onkeydown = e => { if (e.key === "Enter") go().catch(() => {}); };
    return {};
  }
  const setS = b => act(() => api("PATCH", "/api/settings", b), "Saved").then(refreshState).catch(() => {});
  const range = (id, key, fmt, conv = Number) => { $("#" + id).oninput = e => $(`#${id}-o`).textContent = fmt(e.target.value); $("#" + id).onchange = e => setS({ [key]: conv(e.target.value) }); };
  $("#s-amb").onchange = e => setS({ ambient: e.target.value });
  range("s-idleb", "idleBrightness", v => Math.round(v * 100) + "%"); range("s-idlea", "idleAfterSec", v => v + " s"); range("s-fps", "fps", v => v + " fps");
  $("#s-safe").onchange = e => setS({ safe: e.target.checked }); $("#s-dropf").onchange = e => setS({ dropFlash: e.target.checked });
  $("#s-sync").onchange = e => setS({ audioSync: e.target.checked }); $("#s-disc").onchange = e => setS({ autoDiscover: e.target.checked });
  $("#s-dj").onchange = e => setS({ djlink: { enabled: e.target.checked } });
  $("#s-osc").onchange = e => setS({ osc: { enabled: e.target.checked } }); $("#s-oscport").onchange = e => setS({ osc: { port: Number(e.target.value) } });
  $$("[data-guest]").forEach(x => x.onchange = () => setS({ guest: { [x.dataset.guest]: x.checked } }));
  const night = () => setS({ night: { enabled: $("#n-on").checked, from: $("#n-from").value.trim(), to: $("#n-to").value.trim(), maxBrightness: Number($("#n-max").value), warm: $("#n-warm").checked } });
  for (const id of ["n-on", "n-from", "n-to", "n-max", "n-warm"]) $("#" + id).onchange = night;
  $("#n-max").oninput = e => $("#n-max-o").textContent = Math.round(e.target.value * 100) + "%";
  $("#l-save").onclick = () => setS({ location: $("#l-lat").value === "" ? null : { lat: Number($("#l-lat").value), lon: Number($("#l-lon").value) } });
  $("#l-geo").onclick = () => { if (!navigator.geolocation) return toast("This browser can't share its location", true);
    $("#l-help").textContent = "Asking the browser…"; navigator.geolocation.getCurrentPosition(p => { $("#l-lat").value = p.coords.latitude.toFixed(4); $("#l-lon").value = p.coords.longitude.toFixed(4); $("#l-save").click(); },
      e => { $("#l-help").textContent = "Couldn't get the location: " + e.message + ". Type latitude and longitude instead (search the city name online)."; }, { timeout: 10000 }); };
  const mqtt = () => { const b = { enabled: $("#m-on").checked, url: $("#m-url").value.trim(), username: $("#m-user").value.trim() }; if ($("#m-pass").value) b.password = $("#m-pass").value; return setS({ mqtt: b }); };
  $("#m-save").onclick = mqtt; $("#m-on").onchange = mqtt;
  const mqttLabel = m => !m || m.state === "off" ? "Off" : m.state === "connected" ? "Connected" : m.state === "error" ? `Problem: ${m.error}` : "Connecting…";
  $("#x-src").onchange = e => setS({ text: { source: e.target.value } }); $("#x-custom").onchange = e => setS({ text: { custom: e.target.value } });
  $("#b-down").onclick = async () => { const b = await act(() => api("GET", "/api/backup")).catch(() => null); if (!b) return;
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: "application/json" })); a.download = `tempolight-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
  $("#b-file").onchange = async e => { const f = e.target.files[0]; if (!f) return; let j; try { j = JSON.parse(await f.text()); } catch { return toast("That file isn't a backup", true); }
    if (!confirm("Replace your devices, room, scenes, schedules and settings with this backup?")) return;
    await act(() => api("POST", "/api/restore", j), "Backup restored").catch(() => {}); await refreshState(); await loadLayout(); route(); };
  if ($("#s-lock")) $("#s-lock").onclick = async () => { const r = await act(() => api("POST", "/api/lock", { pin: $("#s-pin").value }), "Locked. You stay unlocked on this device.").catch(() => null); if (r) { app.token = r.token; store.set("token", r.token); await refreshState(); route(); } };
  if ($("#s-unlockset")) $("#s-unlockset").onclick = async () => { await act(() => api("DELETE", "/api/lock"), "PIN removed").catch(() => {}); await refreshState(); route(); };
  if ($("#s-relock")) $("#s-relock").onclick = () => { app.token = null; store.set("token", null); ws.sock?.close(); refreshState().then(route); };
  if (DEMO) $("#s-upd").disabled = true;
  $("#s-upd").onclick = async () => { const m = $("#s-updmsg"); m.textContent = "Checking…"; const r = await act(() => api("GET", "/api/update")).catch(() => null); if (!r) { m.textContent = ""; return; }
    m.innerHTML = esc(r.message) + (r.changes?.length ? `<ul style="margin:6px 0 0 18px">${r.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""); $("#s-updgo").hidden = !r.canUpdate; };
  $("#s-updgo").onclick = async () => { const r = await act(() => api("POST", "/api/update")).catch(() => null); if (!r) return; $("#s-updmsg").textContent = r.message; $("#s-updgo").hidden = true;
    const t0 = Date.now(), wait = async () => { await new Promise(x => setTimeout(x, 1500)); try { await api("GET", "/api/health"); if (Date.now() - t0 > 4000) return location.reload(); } catch {} if (Date.now() - t0 < 90000) wait(); }; wait(); };
  $("#s-reset").onclick = async () => { if (confirm("Reset all devices, the room, scenes, schedules and settings?")) { await act(() => api("POST", "/api/reset"), "Reset").catch(() => {}); await refreshState(); await loadLayout(); route(); } };
  return { onChanged(w) { if (w.has("lock")) route(); }, onStatus(m) { const e = $("#m-state"); if (e) e.textContent = mqttLabel(m.mqtt); } };
}

// ---------------------------------------------------------------- router and boot
const PAGES = { home: ["Home", homePage], music: ["Music", musicPage], effects: ["Effects", effectsPage], live: ["Live pads", livePage], scenes: ["Scenes & schedules", scenesPage],
  room: ["Room", el => unlocked() ? roomPage(el) : lockScreen(el, "Room setup")], map: ["Camera mapping", el => unlocked() ? mapPage(el) : lockScreen(el, "Room setup")], devices: ["Devices", devicesPage], settings: ["Settings", settingsPage] };
export function route() {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1] || "home", [title, fn] = PAGES[name] || PAGES.home;
  if (app.page?.destroy) app.page.destroy();
  if (app.page?.preview) ws.send({ type: "preview", on: false });
  $$("#nav a").forEach(a => a.toggleAttribute("aria-current", a.dataset.page === (name === "map" ? "room" : name))); $("#title").textContent = title; document.title = `${title} · Tempolight`;
  const el = $("#page"); el.innerHTML = ""; app.page = fn(el) || {};
  if (app.status) app.page.onStatus?.(app.status);
  $("#side").classList.remove("open");
}

async function boot() {
  const th = store.get("theme"); if (th) document.documentElement.dataset.theme = th;
  $("#theme").onclick = () => { const dark = matchMedia("(prefers-color-scheme: dark)").matches, cur = document.documentElement.dataset.theme || (dark ? "dark" : "light"), nx = cur === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = nx; store.set("theme", nx); };
  $("#menu").onclick = () => $("#side").classList.toggle("open");
  $("#power").onclick = () => act(() => api("POST", "/api/power", { on: $("#power").getAttribute("aria-checked") !== "true" })).catch(() => {});
  $("#bri").oninput = e => $("#bri-out").textContent = e.target.value + "%";
  $("#bri").onchange = e => act(() => api("POST", "/api/brightness", { value: e.target.value / 100 })).catch(() => {});
  if (DEMO) { demo = await import("/demo.js"); await demo.ready; $("#demo-bar").hidden = false; document.body.classList.add("demo"); }
  if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
  try { await refreshState(); } catch (e) { if (e.status === 403) { app.token = null; store.set("token", null); await refreshState(); } else throw e; }
  if (app.token && app.state.locked) { try { await api("PATCH", "/api/settings", {}); } catch { app.token = null; store.set("token", null); chrome(); } }
  await loadLayout();
  app.audio = createAudio({ ws, api, onChange: () => app.page?.onAudio?.() });
  try { app.log = await api("GET", "/api/log"); } catch {}
  connect(); route(); addEventListener("hashchange", route);
  // the brand lamp pulses with the beat
  setInterval(() => { const m = app.status; if (!m) return; $("#lamp").style.opacity = m.beat == null ? 1 : (m.beat === 0 ? 1 : 0.55); }, 120);
}
boot().catch(e => { $("#page").innerHTML = `<div class="callout err span-12">Couldn't start: ${esc(e.message)}</div>`; });
