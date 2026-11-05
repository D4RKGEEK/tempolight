// Tempolight web UI: no framework, no build step. Each page is a function that fills #page and can react to the
// live status the server sends 4 times a second.
import { createAudio } from "/audio.js";
import { createRenderer } from "/preview.js";
import { homeStrip, bindHomeStrip, updateHomeStrip } from "/homestrip.js";
import { latencyChip, warnIcons, homeBadge, latencyPanel } from "/latency.js";
import { hearLine, wantsAutoMic } from "/hearline.js";
import { syncHtml, mountSongMap, syncView } from "/songmap.js";
import { navHtml, shellRoute, shellStatus, isV2 } from "/v2/shell.js"; // the v2 rail, tabs and top bar (design/dashboard-v2.md)
// Loaded the first time they are needed, so the first visit downloads only what the Home page uses: the Room, Camera
// mapping, Show editor and Home & sleep pages, the DMX panels, the MIDI clock and the setup wizard (see lazyPage below;
// sw.js keeps them all for offline use).
let wizardMod = null;
const openWizard = async (...a) => (wizardMod ||= await import("/wizard.js")).openWizard(...a);
const wizardStatus = m => wizardMod?.wizardStatus(m);
const wantsWizard = st => !!st && !st.settings.setupDone && !st.devices.length && (!st.locked || !!app.token); // (as in wizard.js)

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = { get(k) { try { return localStorage.getItem("tl." + k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem("tl." + k) : localStorage.setItem("tl." + k, v); } catch {} } };

export const app = { state: null, status: null, layout: null, frame: null, token: store.get("token"), log: [], page: null, audio: null };
// demo mode: the online demo (and ?demo) runs the core in this page with pretend WLED controllers
export const DEMO = !!document.querySelector('meta[name="tempolight-demo"]') || new URLSearchParams(location.search).has("demo");
let demo = null;
let NP = null; // "now playing" from music apps on the server's computer (nowplaying.js; not in the demo)
let SP = null; // the "Sync with Spotify" panel (spotify.js; in the demo it only explains)
let HR = null; // the "How should Tempolight hear your music?" panel on the Music page (hearing.js)
let LB = null; // the "Your own music" panel on the Music page (library.js; in the demo it only explains)

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
    if (typeof e.data !== "string") { const b = new Uint8Array(e.data); if (b[0] === 1) { app.frame = b.subarray(1); app.page?.onFrame?.(app.frame); } return; }
    const m = JSON.parse(e.data);
    if (m.type === "hello") { ws.id = m.id; onStatus(m); }
    else if (m.type === "status") onStatus(m);
    else if (m.type === "log") { app.log.push(m); if (app.log.length > 200) app.log.shift(); app.page?.onLog?.(m); }
    else if (m.type === "changed") scheduleRefresh(m.what);
    else if (m.type === "screen-refused") app.screen?.stop(m.error); // locked, or another browser already shares
  };
}
function resendAudio() { const a = app.audio.state; ws.send({ type: "audio-start", rate: 22050, label: a.mode === "song" ? `Song: ${a.label}` : a.label, latencyMs: app.audio.latencyMs?.(), channels: app.audio.channels?.() || 1 }); }
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
  shellStatus(m);
  app.page?.onStatus?.(m); wizardStatus(m); autoMic(m);
}
// The microphone, when it was chosen as the way to hear music (hearing.js): started by itself when Spotify (or another
// player) plays a song Tempolight hasn't learned and nothing else sends its sound; stopped a minute after the music stops.
const mic = { lastTry: 0, auto: false, playedAt: 0 };
function autoMic(m) {
  const A = app.audio; if (!A) return; const now = Date.now(), method = store.get("hear") === "mic" ? "mic" : app.state?.settings.hearing?.method || "";
  const playing = !!(m.spotify?.track?.playing || m.nowPlaying?.playing); if (playing) mic.playedAt = now;
  if (wantsAutoMic(m, { method, mode: A.state.mode, now, lastTry: mic.lastTry })) {
    mic.lastTry = now; A.listen("mic", store.get("input") || "").then(() => { if (A.state.mode === "mic") { mic.auto = true; toast("Listening with the microphone: keep this tab open"); } }).catch(() => {});
  } else if (mic.auto && A.state.mode === "mic" && !playing && now - mic.playedAt > 60000) { mic.auto = false; A.stopLive(); }
  if (A.state.mode !== "mic") mic.auto = false;
}
/** The status line ("Hearing Spotify ✓ · song · learning 42%", or "Can't hear anything → Fix") into `el`. */
export function paintHearLine(el, m, { dot = false } = {}) {
  if (!el) return; const l = hearLine(m), v = dot ? syncView(m) : null; // dot: the sync meter as a tiny dot (Home)
  el.className = `hearline ${l.ok === true ? "ok" : l.ok === false ? "bad" : ""}`; el.title = l.why || "";
  el.innerHTML = `${v ? `<a class="syncdot" href="#/music" data-state="${v.state}" title="${esc(v.title)}" aria-label="Sync: ${esc(v.title)}"></a>` : ""}<span>${esc(l.text)}</span>${l.fix ? ` <a href="#/music/hear" class="hear-fix">${l.ok === false ? "Fix" : "Set up"} →</a>` : ""}`;
}
function chrome() {
  const st = app.state; $("#ver").textContent = "v" + st.version;
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
const tagName = { calm: "Calm", build: "Build-up", drop: "Drop", home: "Everyday", any: "Any", "LedFx-like": "Classic", mine: "Mine" };
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
  rec.stop(); await done; btn.textContent = "Record a clip"; btn.disabled = false;
  const ext = (rec.mimeType || type).includes("mp4") ? "mp4" : "webm", file = new File(chunks, `tempolight-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`, { type: rec.mimeType || type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: "Tempolight" }); return; } catch {} }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); toast("Clip saved");
}

// ---------------------------------------------------------------- Home
function homePage(el) {
  const st = app.state, noDevices = !st.devices.length;
  el.innerHTML = `
    ${noDevices ? panel("Welcome to Tempolight", "Let's light up your room", `<button class="btn primary" id="s-wizard-home" type="button">Step-by-step setup</button>`, `<div class="pb stack"><p class="muted">Tempolight streams music-reactive effects to WLED controllers on your network. Pick how to start:</p>
      <div class="setup">
        <div class="opt"><h3>Find my WLED lights</h3><p>Looks for WLED controllers on your Wi-Fi and adds them, each as a strip in the room.</p><button class="btn primary" id="s-scan" type="button">Scan the network</button></div>
        <div class="opt"><h3>Add by IP address</h3><p>Type the address shown in the WLED app (for example 192.168.1.42).</p><div class="row" style="width:100%"><input id="s-ip" placeholder="192.168.1.42" style="flex:1"><button class="btn" id="s-add" type="button">Add</button></div></div>
        <div class="opt"><h3>Try it without lights</h3><p>Adds a virtual living room so you can see every effect and play music right here.</p><button class="btn" id="s-virtual" type="button">Add a virtual room</button></div>
      </div><p class="faint" id="s-msg"></p></div>`, "span-12 o0") : ""}
    <div class="col span-8">
    ${panel("Live preview", `<span id="h-fx"></span>`, `<span class="badge" id="h-leds"></span><button class="btn" id="h-rec" type="button" title="Record 15 seconds of the preview with the music">Record a clip</button><a class="btn" href="#/room">Edit the room</a>`, `<div class="stage" id="h-stage">${noDevices ? '<div class="empty">No lights yet</div>' : ""}</div>`, "span-12 o1")}
    ${panel("Controls", "Applies to the whole room", `<button class="btn" id="h-save" type="button">Save as a scene</button><button class="btn" id="h-black" type="button" aria-pressed="false">Blackout</button>`, `<div class="pb controls fit">
      <div class="field"><label for="h-mode">Effect choice</label><select id="h-mode">${opt("auto", "Automatic (follows the song)", st.show.mode === "auto")}${opt("manual", "Fixed effect", st.show.mode === "manual")}</select></div>
      <div class="field"><label for="h-effect">Effect</label><select id="h-effect">${st.effects.map(e => opt(e.id, e.name, e.id === st.show.effect)).join("")}</select></div>
      <div class="field"><label for="h-styl">Music style</label><select id="h-styl">${Object.entries(STYLE_NAMES()).map(([k, v]) => opt(k, v, k === st.show.style)).join("")}</select></div>
      <div class="field"><label for="h-pal">Colours</label><select id="h-pal">${st.palettes.map(p => opt(p, p === "auto" ? "Automatic (changes with the song)" : p[0].toUpperCase() + p.slice(1), p === st.show.palette)).join("")}</select></div>
    </div>`, "span-12 o3")}
    ${panel("What's new", "Recent features, and where to find them", "", `<div class="pb"><ul class="news two">
      <li><a href="#/music/sync"><b>In sync</b><small>How tightly the lights follow the song, its map and the next drop</small><span class="where">Music</span></a></li>
      <li><a href="#/effects/variety"><b>Variety</b><small>One look per song, one per part, or a full show</small><span class="where">Effects</span></a></li>
      <li><a href="#/settings/punch"><b>Punch and drama</b><small>How hard drops hit, and how much brighter they get</small><span class="where">Settings</span></a></li>
      <li><a href="#/settings/chords"><b>Chord colours</b><small>Colours step with the song's chords</small><span class="where">Settings</span></a></li>
      <li><a href="#/settings/stereo"><b>Stereo</b><small>The side of the room a hit came from lights up more</small><span class="where">Settings</span></a></li>
      <li><a href="#/settings/countdown"><b>Live pads countdown</b><small>Drop in 4, 3, 2, 1, big enough to read across the room</small><span class="where">Settings</span></a></li>
      <li><a href="#/music/library"><b>Your own music</b><small>A music folder analysed ahead, in sync from the first play</small><span class="where">Music</span></a></li>
    </ul></div>`, "span-12 o5")}
    </div>
    <div class="col span-4">
    ${panel("Now", `<span id="h-src"></span>`, `<span class="badge acc" id="h-style"></span>`, `<div class="pb np stack">
      <div class="hearline" id="h-hear"></div>
      <div><div class="song" id="h-song">Nothing playing</div><div class="meta" id="h-meta">Play a song or listen to your computer on the Music page.</div></div>
      <div class="kv now">
        <div><span>Sync</span><b class="txt now-st" id="h-sync" data-state="none">–</b></div>
        <div><span>Next drop</span><b id="h-drop">–</b></div>
        <div class="wide"><span>Look</span><b class="txt" id="h-look" title="The effect and colours picked for this song">–</b></div>
        <div><span>Tempo</span><b id="h-bpm">–</b></div><div><span>Part</span><b class="txt" id="h-part">–</b></div>
      </div>
      <div class="row now-beat"><div class="beat" id="h-beat" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div class="meter" title="Level"><i id="h-meter"></i></div><span class="mono faint" id="h-level">–</span></div>
      <div id="h-transport" hidden class="stack"><div class="progress" id="h-prog"><div class="fill" id="h-fill"></div></div><div class="times"><span id="h-pos">0:00</span><span id="h-dur">0:00</span></div>
        <div class="row"><button class="btn" id="h-prev" type="button">Previous</button><button class="btn primary" id="h-play" type="button">Pause</button><button class="btn" id="h-next" type="button">Next</button></div></div>
      <a class="btn" href="#/music/sync">Open the music page</a>
    </div>`, "span-12 o2")}
    ${panel("Scenes", "", `<a class="btn" href="#/scenes">Manage scenes</a>`, `<div class="pb chips" id="h-scenes">${st.scenes.map(s => `<button class="chip" data-scene="${s.id}" type="button">${esc(s.name)}</button>`).join("") || '<span class="faint">No scenes yet</span>'}</div><div class="pb" style="padding-top:0">${homeStrip()}</div>`, "span-12 o4")}
    ${panel("Devices", `${st.devices.length} controller${st.devices.length === 1 ? "" : "s"}`, `<span id="h-lat"></span><a class="btn" href="#/devices">Manage devices</a>`, `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Address</th><th class="num">LEDs</th><th>Status</th><th class="num">Delay</th></tr></thead><tbody id="h-devs"></tbody></table></div>`, "span-12 o6")}
    </div>
    ${panel("Activity", "", `<button class="btn sm" id="h-clear" type="button">Clear the log</button>`, `<div class="log" id="h-log"></div>`, "span-12 o7")}`;

  let prev = null;
  if (!noDevices) prev = createPreview($("#h-stage"));
  if (noDevices) {
    const msg = t => $("#s-msg").textContent = t;
    $("#s-scan").onclick = async () => { msg("Scanning… this takes a few seconds."); const found = await act(() => api("POST", "/api/discover", { scan: true }));
      const fresh = found.filter(f => !f.added); if (!fresh.length) return msg("No WLED controllers found. Check they're on the same Wi-Fi, or add one by IP address.");
      for (const f of fresh) await act(() => api("POST", "/api/devices", { host: f.host, name: f.name, leds: f.leds, force: true })); toast(`Added ${fresh.length} controller${fresh.length > 1 ? "s" : ""}`); };
    $("#s-add").onclick = () => act(() => api("POST", "/api/devices", { host: $("#s-ip").value }), "Controller added").catch(() => {});
    $("#s-virtual").onclick = () => act(() => api("POST", "/api/devices", { virtual: true, name: "Virtual room" }), "Virtual room added").catch(() => {});
    $("#s-wizard-home").onclick = () => openWizard();
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
  bindHomeStrip();
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
      $("#h-bpm").textContent = m.bpm ? Math.round(m.bpm) : "–"; $("#h-part").textContent = partName[m.part] || m.part; $("#h-level").textContent = String(Math.round(m.level * 100)).padStart(3, " ") + "%";
      $$("#h-beat i").forEach((x, i) => x.classList.toggle("on", m.beat === i)); $("#h-meter").style.width = Math.round(m.level * 100) + "%";
      { const v = syncView(m), sy = $("#h-sync"), d = m.drop, lk = m.look; sy.dataset.state = v.state; sy.textContent = v.state === "none" ? "–" : `${v.label} · ${v.score}`; sy.title = v.title;
        $("#h-drop").textContent = d && Number.isFinite(d.next) && d.next >= 0 && (d.conf == null || d.conf >= 0.5) ? `in ${fmtTime(d.next)}` : "–";
        $("#h-look").textContent = lk ? lk.label : m.source === "idle" ? "–" : app.state.show.variety === "show" ? "Changes with the song" : "–"; }
      const a = A.state;
      $("#h-song").textContent = m.song ? m.song.name : m.source === "idle" ? "Nothing playing" : m.sourceLabel;
      $("#h-meta").textContent = m.song ? `${Math.round(m.song.bpm)} BPM · ${app.state.styles[m.song.style] || m.song.style}${m.song.drops?.length ? ` · ${m.song.drops.length} drop${m.song.drops.length > 1 ? "s" : ""}` : ""}` : m.source === "idle" ? "Play a song or listen to your computer on the Music page." : "Listening live";
      const np = NP?.homeText(m); if (np) { $("#h-song").textContent = np.song; $("#h-meta").textContent = np.meta; }
      paintHearLine($("#h-hear"), m, { dot: true });
      $("#h-transport").hidden = !(a.mode === "song" && a.song);
      if (a.song) { const d = A.duration, p = A.pos(); $("#h-fill").style.width = (p / d * 100) + "%"; $("#h-pos").textContent = fmtTime(p); $("#h-dur").textContent = fmtTime(d); $("#h-play").textContent = a.song.playing ? "Pause" : "Play"; }
      $("#h-black").setAttribute("aria-pressed", m.overlay.blackout); updateHomeStrip(m);
      $("#h-devs").innerHTML = app.state.devices.map(d => { const h = m.devices.find(x => x.id === d.id) || {};
        return `<tr><td>${esc(d.name)}</td><td class="mono">${esc(d.virtual ? "virtual" : d.host)}</td><td class="num">${d.leds || "?"}</td><td>${!d.enabled ? '<span class="badge">Off</span>' : h.online ? '<span class="badge live"><i></i>Online</span>' : h.online === false ? '<span class="badge err"><i></i>Offline</span>' : '<span class="badge">Checking</span>'}${warnIcons(h)}</td><td class="num">${d.enabled ? latencyChip(h) : ""}</td></tr>`; }).join("") || '<tr><td colspan="5" class="faint">No devices</td></tr>';
      $("#h-lat").innerHTML = homeBadge(m, app.state.devices);
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
const namedInput = id => String(id || "").includes(":") ? opt(id, id.slice(id.indexOf(":") + 1), true) : ""; // "avf:BlackHole 2ch", chosen by the hearing panel
function musicPage(el) {
  const st = app.state, A = app.audio, s = st.settings;
  el.innerHTML = `<div id="m-hear"></div>
    ${panel("In sync", `<span id="sm-name"></span>`, "", `<div class="pb stack sm" id="m-sync">${syncHtml()}
      <div class="sm-look"><span class="lbl">Look</span><b id="m-look" title="The effect and colours picked for this song, and why">–</b>
        <div class="row" id="m-lookrow"><button class="btn sm" id="m-looknext" type="button" title="Pick the next best look for this song; this one won't come back for it">Not this one</button><button class="btn sm" id="m-lookkeep" type="button" aria-pressed="false" title="Keep this look for this song">Keep</button><span class="faint" id="m-lookhelp"></span></div></div></div>`, "span-12")}
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
    <div id="m-sp"></div>${DEMO ? "" : '<div id="m-np"></div>'}<div id="m-lib"></div>
    ${panel("What Tempolight hears", `<span id="m-src"></span>`, `<label class="check" title="With Automatic colours, the lights take colours from the music's mood"><input type="checkbox" id="m-moodc" ${s.moodColours !== false ? "checked" : ""}> Mood colours</label>`, `<div class="pb stack"><div class="spectrum" id="m-spec">${"<i></i>".repeat(24)}</div>
      <div class="kv"><div><span>Tempo</span><b id="m-bpm">–</b></div><div><span>Part</span><b id="m-part">–</b></div><div><span>Style</span><b id="m-style">–</b></div><div><span>Singing</span><b id="m-voc" title="An estimate from the sound: a clear tone whose pitch moves like a voice">–</b></div><div style="grid-column: span 2"><span>Key · mood</span><b id="m-key" title="The key from which notes sound most; the mood from major or minor, brightness, drums and tempo">–</b></div></div>
      <div class="row"><button class="btn" id="m-tap" type="button">Tap the beat</button><span class="faint" style="font-size:12.5px">Tap 4 times on the beat to fix the tempo and line up the beat.</span></div></div>`, "span-6")}
    ${panel("Timing", "", "", `<div class="pb stack">
      <div class="callout warn" id="m-btcal" hidden><b>Bluetooth speakers play late — fix the timing.</b> <span id="m-btname"></span></div>
      <div class="field"><label for="m-off">Light timing <span class="faint" id="m-offfor"></span> <output id="m-off-o">${app.status?.offsetMs ?? s.syncOffsetMs} ms</output></label><input type="range" id="m-off" min="-300" max="300" step="5" value="${app.status?.offsetMs ?? s.syncOffsetMs}">
        <span class="help">If the lights come after the beat, move this to the right; if they come before it, move it left. Bluetooth speakers play late, so they often need −150 to −250. Each speaker keeps its own timing, and it switches by itself when the Mac's (or PC's) output changes.</span></div>
      <div class="field" id="m-offs" hidden><span class="lbl">Timing per speaker</span><div class="tablewrap"><table><tbody id="m-offrows"></tbody></table></div></div>
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
    ${panel("Screen sync", `<span id="m-scrst">${app.screen?.state.active ? `Sharing ${esc(app.screen.state.label)}` : "Off"}</span>`, `<button class="btn" id="m-scr" type="button">${app.screen?.state.active ? "Stop sharing" : "Share a screen…"}</button>`, `<div class="pb stack">
      <p class="muted">Share a film, a game or a music video and the room takes its colours, like a big ambilight. Turns on the Screen Sync effect; pick another effect to go back.</p>
      <span class="help" id="m-scrhelp">${navigator.mediaDevices?.getDisplayMedia ? "Works in Chrome, Edge and Firefox on a computer. Keep the shared tab or window visible." : "This browser can't share its screen. Use a computer."}</span></div>`, "span-6")}
    ${DEMO ? "" : panel("Listen on the server", "For a Raspberry Pi or PC next to the speakers, with no browser open", `<button class="btn" id="m-cap" type="button"></button>`, `<div class="pb stack">
      <div class="field"><label for="m-capsrc">Sound input</label><select id="m-capsrc">${opt("auto", "Automatic", s.capture.source === "auto")}${st.captureSources.map(c => opt(c.id, c.label, c.id === s.capture.source)).join("")}${namedInput(s.capture.source)}</select>
      ${st.captureSources.length ? "" : '<span class="help">No capture tool found on the server. Install ffmpeg (or PulseAudio/ALSA tools on Linux), or enter a command below.</span>'}</div>
      <div class="field"><label for="m-capcmd">Custom command (optional)</label><input id="m-capcmd" class="mono" placeholder='ffmpeg -f pulse -i default -ac 1 -ar 22050 -f s16le -' value="${esc(s.capture.command)}"><span class="help">Any command that writes 16-bit mono 22,050 Hz audio to its output.</span></div>
      <div id="m-capst" class="faint"></div></div>`, "span-12")}`;
  const canShare = !!navigator.mediaDevices?.getDisplayMedia;
  import("/hearing.js").then(mod => { if (!$("#m-hear")) return; HR = mod.mountHearing($("#m-hear")); if (app.status) HR?.status(app.status);
    if (/^#\/music\/hear/.test(location.hash)) { const h = $("#hear"); h?.scrollIntoView({ block: "start" }); h?.classList.add("flash"); } }).catch(() => {});
  if (!DEMO) import("/nowplaying.js").then(mod => { NP = mod; mod.mount($("#m-np")); if (app.status) mod.status(app.status); }).catch(() => {});
  import("/spotify.js").then(mod => { SP = mod; mod.mount($("#m-sp"), { demo: DEMO }); if (app.status) mod.status(app.status); }).catch(() => {});
  import("/library.js").then(mod => { LB = mod; mod.mount($("#m-lib"), { demo: DEMO }); }).catch(() => {});
  const fmtT = v => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
  async function songs() { const list = await api("GET", "/api/songs").catch(() => []), tb = $("#m-songs"); if (!tb) return;
    $("#m-memn").textContent = list.length ? `${list.length} song${list.length > 1 ? "s" : ""} remembered` : "";
    const SRC = { learned: "learned", shared: "shared map", "spotify-analysis": "Spotify analysis" };
    tb.innerHTML = list.length ? list.slice().reverse().map(e => `<tr><td>${esc(e.name)}${e.spotifyId ? ` <span class="badge" title="Followed when it plays in Spotify${e.src ? ` (${SRC[e.src] || e.src})` : ""}">Spotify${e.src && SRC[e.src] ? ` · ${SRC[e.src]}` : ""}${e.cover != null && e.cover < 100 ? ` · ${e.cover}%` : ""}</span>` : ""}</td><td class="num faint">${Math.round(e.bpm)} BPM</td><td class="num faint">${fmtT(e.dur)}</td><td class="num faint">${e.drops} drop${e.drops === 1 ? "" : "s"}</td><td><a class="btn sm" href="#/timeline/${esc(e.id)}">Edit show</a> ${lockedOut ? "" : `<button class="btn sm" data-forget="${e.id}" type="button">Forget</button>`}</td></tr>`).join("")
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
  if (!guestOk("effects") && !app.screen?.state.active) { $("#m-scr").disabled = true; $("#m-scrhelp").textContent = "Locked with a PIN: guests can't pick effects, so they can't share a screen."; }
  $("#m-scr").onclick = async () => { if (!app.screen) { const { createScreenShare } = await import("/screen.js"); app.screen = createScreenShare({ ws, onChange: sc => { if (sc.error) toast(sc.error, true); const b = $("#m-scr"), t = $("#m-scrst"); if (b) b.textContent = sc.active ? "Stop sharing" : "Share a screen…"; if (t) t.textContent = sc.active ? `Sharing ${sc.label}` : "Off"; } }); }
    if (app.screen.state.active) { app.screen.stop(); return; }
    if (await app.screen.start()) act(() => api("PATCH", "/api/show", { effect: "screen" }), "Screen Sync is on").catch(e => { if (e.status === 403) app.screen.stop("Tempolight is locked, so the screen can't be shared."); }); };
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
      $("#m-off").value = off; $("#m-off-o").textContent = off + " ms"; offRows();
      const o = app.status?.hearing?.output;
      msg.textContent = `Speakers to microphone: ${Math.round(r.delayMs)} ms. Light timing set to ${off > 0 ? "+" : ""}${off} ms${o ? ` for ${o.name}` : ""}.`;
    } catch (e) { msg.textContent = e.name === "NotAllowedError" ? "Microphone permission was refused." : `Couldn't measure: ${e.message}`; }
    finally { b.disabled = !unlocked(); }
  };
  $("#m-tap").onclick = () => api("POST", "/api/action", { type: "tap" }).catch(e => toast(e.message, true));
  // the song's look: "Not this one" picks the next best (and remembers), "Keep" keeps it for the song
  $("#m-looknext").onclick = () => act(() => api("POST", "/api/song/look/next", {})).then(r => toast(`Look: ${r.label}`)).catch(() => {});
  $("#m-lookkeep").onclick = () => { const kept = $("#m-lookkeep").getAttribute("aria-pressed") === "true"; act(() => api("POST", "/api/song/look/keep", { keep: !kept }), kept ? "The look can change again" : "Look kept for this song").catch(() => {}); };
  const lookOk = guestOk("effects");
  const SM = mountSongMap($("#m-sync"), { api }); if (app.status) SM.status(app.status);
  const setS = b => act(() => api("PATCH", "/api/settings", b)).then(refreshState).catch(() => {});
  $("#m-off").oninput = e => $("#m-off-o").textContent = e.target.value + " ms"; $("#m-off").onchange = e => setS({ syncOffsetMs: Number(e.target.value) }).then(offRows);
  // the timing each speaker keeps (settings.syncOffsets), with the one playing now marked
  function offRows() { const list = Object.entries(app.state.settings.syncOffsets || {}), box = $("#m-offs"); if (!box) return; box.hidden = !list.length; const cur = app.status?.hearing?.output?.key;
    $("#m-offrows").innerHTML = list.map(([k, o]) => `<tr><td>${esc(o.name)}${o.bt ? ' <span class="badge">Bluetooth</span>' : ""}${k === cur ? ' <span class="badge live">playing now</span>' : ""}</td><td class="num mono">${o.ms > 0 ? "+" : ""}${o.ms} ms</td><td>${lockedOut ? "" : `<button class="btn sm" type="button" data-offdel="${esc(k)}">Forget</button>`}</td></tr>`).join("")
      + `<tr><td class="faint">Any other output</td><td class="num mono faint">${app.state.settings.syncOffsetMs > 0 ? "+" : ""}${app.state.settings.syncOffsetMs} ms</td><td></td></tr>`;
    $$("[data-offdel]").forEach(b => b.onclick = () => setS({ syncOffsets: { [b.dataset.offdel]: null } }).then(offRows)); }
  offRows();
  $("#m-pred").onchange = e => setS({ predict: e.target.checked });
  $("#m-moodc").onchange = e => setS({ moodColours: e.target.checked });
  $("#m-met").onchange = e => setS({ metronome: { enabled: e.target.checked } }); $("#m-bpmset").onchange = e => setS({ metronome: { bpm: Number(e.target.value) } });
  if (!DEMO) {
    $("#m-capsrc").onchange = e => setS({ capture: { source: e.target.value } }); $("#m-capcmd").onchange = e => setS({ capture: { command: e.target.value.trim() } });
    $("#m-cap").onclick = () => setS({ capture: { enabled: !app.state.settings.capture.enabled } });
  }
  for (const id of ["m-off", "m-pred", "m-moodc", "m-met", "m-bpmset", "m-capsrc", "m-capcmd", "m-cap", "m-cal"]) if (lockedOut && $("#" + id)) $("#" + id).disabled = true;
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
        <div class="showline" id="m-show" aria-label="The show: effects on a timeline"></div><div id="m-showed" class="row" hidden></div><a class="btn sm" id="m-editshow" hidden style="align-self:flex-start">Edit show</a>
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
    if (force || showFor !== memId || !showData) { showFor = memId; showData = await api("GET", `/api/songs/${memId}/show`).catch(() => null); }
    if (!showData) return; const eb = $("#m-editshow"); if (eb) { eb.href = `#/timeline/${memId}`; eb.hidden = false; }
    const d = showData.dur || 1, names = Object.fromEntries(st.effects.map(e => [e.id, e.name]));
    box.innerHTML = showData.show.map((b, i) => `<button class="blk ${esc(b.part)}" type="button" data-blk="${i}" style="left:${b.t0 / d * 100}%;width:${(b.t1 - b.t0) / d * 100}%" title="${fmtTime(b.t0)}–${fmtTime(b.t1)}: ${esc(names[b.effect] || b.effect)}"><span>${esc(names[b.effect] || b.effect)}</span></button>`).join("");
    $$("#m-show [data-blk]").forEach(b => b.onclick = () => { const i = Number(b.dataset.blk), blk = showData.show[i], ed = $("#m-showed"); ed.hidden = false;
      ed.innerHTML = `<span class="faint">${fmtTime(blk.t0)}–${fmtTime(blk.t1)}</span><select id="m-blkfx" aria-label="Effect for this part" style="width:auto;max-width:240px">${st.effects.map(e => opt(e.id, e.name, e.id === blk.effect)).join("")}</select><button class="btn sm" id="m-shownew" type="button">New show</button>${showData.edited ? '<span class="faint" style="font-size:12px">edited by hand</span>' : ""}`;
      $("#m-blkfx").onchange = async e => { const next = showData.show.map((x, k) => k === i ? { ...x, effect: e.target.value } : x); const r = await act(() => api("PUT", `/api/songs/${memId}/show`, { show: next }), "Show updated").catch(() => null); if (r) { showData.show = r.show; showData.edited = true; showLine(); } };
      $("#m-shownew").onclick = async () => { const r = await act(() => api("DELETE", `/api/songs/${memId}/show`), "A new show for this song").catch(() => null); if (r) { showData = null; ed.hidden = true; showLine(true); } }; });
  }
  renderQueue(); songs(); requests();
  const partName = { calm: "Calm", build: "Build-up", drop: "Drop", silent: "Quiet", idle: "–" };
  let offFor;
  return {
    destroy() { HR?.destroy(); HR = null; SM.destroy(); },
    onAudio: renderQueue, onLog(e) { if (/^Remembered|^Song memory|^Spotify: (learned|got)/.test(e.msg)) songs(); }, onChanged(w) { if (w.has("requests")) requests(); if (w.has("songs")) songs(); if (w.has("library") || w.has("lock")) LB?.changed(); if (w.has("settings") || w.has("output")) offRows(); },
    onStatus(m) {
      $("#m-src").textContent = m.sourceLabel; $("#m-bpm").textContent = m.bpm ? m.bpm.toFixed(0) : "–"; $("#m-part").textContent = partName[m.part] || m.part; $("#m-style").textContent = m.source === "idle" ? "–" : m.styleName; $("#m-voc").textContent = m.vocal == null ? "–" : m.vocal > 0.35 ? "Yes" : m.vocal > 0.15 ? "A little" : "No";
      $("#m-key").textContent = m.source === "idle" || !m.hears ? "–" : m.hears;
      const lk = m.look; $("#m-look").textContent = lk ? `${lk.label}${lk.provisional ? " · for now" : ""}` : m.source === "idle" ? "–" : app.state.show.variety === "show" ? "Changes with the song (Show)" : "–";
      $("#m-looknext").disabled = $("#m-lookkeep").disabled = !lk || !lookOk; // (always there, so the panel doesn't jump)
      { const kb = $("#m-lookkeep"); kb.setAttribute("aria-pressed", String(!!lk?.locked)); kb.textContent = lk?.locked ? "Kept ✓" : "Keep";
        $("#m-lookhelp").textContent = !lk ? "" : lk.provisional ? "Picked from what it hears; kept for the song." : lk.rejected?.length ? `${lk.rejected.length} turned down for this song` : ""; }
      SM.status(m); $("#sm-name").textContent = m.source === "idle" ? "" : m.song?.name || m.recognised?.name || m.sourceLabel;
      const bars = $$("#m-spec i"); bars.forEach((b, i) => b.style.height = (m.bands ? Math.max(2, m.bands[i] * 100) : 2) + "%");
      const lv = A.level(); $("#m-lvl").style.width = Math.round(lv * 100) + "%"; $("#m-lvl-o").textContent = A.state.stream ? (lv < 0.02 ? "very quiet: turn it up or move closer" : Math.round(lv * 100) + "%") : "not listening";
      if (m.song?.memId && m.song.memId !== showFor) showLine();
      if (A.state.song && $("#m-fill")) { const p = A.pos(); $("#m-fill").style.width = (p / A.duration * 100) + "%"; $("#m-pos").textContent = fmtTime(p); }
      HR?.status(m);
      const o = m.hearing?.output, bt = $("#m-btcal"); $("#m-offfor").textContent = o ? `for ${o.name}` : "";
      bt.hidden = !(o && o.bluetooth && !o.own); if (!bt.hidden) $("#m-btname").textContent = `${o.name}: press Fix the timing automatically below (it keeps the timing for this speaker).`;
      if (m.offsetMs != null && document.activeElement !== $("#m-off") && Number($("#m-off").value) !== m.offsetMs) { $("#m-off").value = m.offsetMs; $("#m-off-o").textContent = m.offsetMs + " ms"; }
      if (o?.key !== offFor) { offFor = o?.key; offRows(); }
      if (DEMO) return;
      NP?.status(m); SP?.status(m);
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
      <div class="row"><input id="e-q" placeholder="Search effects" style="max-width:240px"><div class="chips" id="e-tags">${["all", "calm", "build", "drop", "home", "LedFx-like", "mine", "liked", "banned"].map(t => `<button class="chip" data-tag="${t}" aria-pressed="${t === "all"}" type="button">${t === "all" ? "All" : t === "liked" ? "♥ Liked" : t === "banned" ? "Banned" : tagName[t]}</button>`).join("")}</div></div>
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
    ${panel("How effects are chosen", "In automatic mode", "", `<div class="pb controls fit">
      <div class="field"><label for="e-var">Variety</label><select id="e-var">${opt("one", "One look per song", (st.show.variety || "one") === "one")}${opt("parts", "Song parts", st.show.variety === "parts")}${opt("show", "Show (changes often)", st.show.variety === "show")}</select><span class="help">One look: one effect for the whole song, picked to fit it. Song parts: one each for calm parts, build-ups and drops. Show: effects change with the song.</span></div>
      <div class="field"><label for="e-style">Music style</label><select id="e-style">${Object.entries(STYLE_NAMES()).map(([k, v]) => opt(k, v, k === st.show.style)).join("")}</select><span class="help">Each style has its own effect lists for calm parts, build-ups and drops.</span></div>
      <div class="field"><label for="e-pal">Colours</label><select id="e-pal">${st.palettes.map(p => opt(p, p === "auto" ? "Automatic" : p[0].toUpperCase() + p.slice(1), p === st.show.palette)).join("")}</select></div>
      <div class="field"><label for="e-every">Change effect every <output id="e-every-o">${st.show.everyBeats} beats</output></label><input type="range" id="e-every" min="4" max="64" step="4" value="${st.show.everyBeats}"><span class="help">In automatic mode with the Show variety. Song changes (build-up, drop) always switch straight away.</span></div>
      <div class="field"><label for="e-speed">Ambient speed <output id="e-speed-o">${st.show.speed}×</output></label><input type="range" id="e-speed" min="0.25" max="3" step="0.25" value="${st.show.speed}"></div>
      <div class="field"><label for="e-layer">Accent layer</label><select id="e-layer">${opt("", "None", !st.show.layer)}${st.effects.map(e => opt(e.id, e.name, st.show.layer?.effect === e.id)).join("")}</select><span class="help">An extra effect added on top, for example Hi-hat Starfield over a calm background.</span></div>
      <div class="field"><label for="e-lamt">Accent amount <output id="e-lamt-o">${Math.round((st.show.layer?.amount ?? 0.6) * 100)}%</output></label><input type="range" id="e-lamt" min="0.1" max="1.5" step="0.05" value="${st.show.layer?.amount ?? 0.6}"></div>
    </div>`, "span-8")}
    ${panel("Make your own", `<span id="u-editing">New effect</span>`, "", `<div class="pb controls" id="u-form">
      <div class="field"><label for="u-name">Name</label><input id="u-name" maxlength="40" value="My effect"></div>
      <div class="field"><label for="u-pattern">Pattern</label><select id="u-pattern">${[["wave", "Waves"], ["chase", "A moving dot"], ["pulse", "Pulse from the middle"], ["sparkle", "Sparkles"], ["fill", "Level meter"], ["breathe", "Breathing"], ["gradient", "Colour gradient"]].map(([k, v]) => opt(k, v)).join("")}</select></div>
      <div class="field"><label for="u-axis">Direction</label><select id="u-axis">${[["along", "Along each strip"], ["x", "Left to right"], ["y", "Floor to ceiling"], ["around", "Around each shape"], ["centre", "Out from the middle"]].map(([k, v]) => opt(k, v)).join("")}</select></div>
      <div class="field"><label for="u-drive">Moves with</label><select id="u-drive">${[["beat", "The beat"], ["kick", "Kick drums"], ["bass", "The bass"], ["loud", "Loudness"], ["time", "Time (no music needed)"]].map(([k, v]) => opt(k, v)).join("")}</select></div>
      <div class="field"><label for="u-tag">Plays in automatic mode during</label><select id="u-tag">${[["drop", "Drops"], ["build", "Build-ups"], ["calm", "Calm parts"], ["home", "Never (pick it by hand)"]].map(([k, v]) => opt(k, v)).join("")}</select></div>
      <div class="field"><span class="lbl">Colours</span><div class="row"><label class="check"><input type="checkbox" id="u-pal" checked> From the palette</label><input type="color" id="u-c1" value="#ff2bd6" aria-label="First colour" disabled><input type="color" id="u-c2" value="#16e0ff" aria-label="Second colour" disabled></div></div>
      <div class="field"><label for="u-speed">Speed <output id="u-speed-o">1×</output></label><input type="range" id="u-speed" min="0.25" max="4" step="0.25" value="1"></div>
      <div class="field"><label for="u-width">Size <output id="u-width-o">15%</output></label><input type="range" id="u-width" min="0.02" max="0.8" step="0.01" value="0.15"></div>
      <div class="field"><label for="u-cyc">Repeats <output id="u-cyc-o">1</output></label><input type="range" id="u-cyc" min="0.5" max="6" step="0.5" value="1"></div>
      <div class="field"><label for="u-bg">Background glow <output id="u-bg-o">5%</output></label><input type="range" id="u-bg" min="0" max="0.4" step="0.01" value="0.05"></div>
      <div class="row"><button class="btn primary" id="u-save" type="button">Save and show it</button><button class="btn" id="u-new" type="button" hidden>New</button><button class="btn danger" id="u-del" type="button" hidden>Delete</button></div>
      <div class="row"><button class="btn sm" id="u-share" type="button">Copy share code</button><input id="u-code" placeholder="Paste a share code" style="max-width:260px"><button class="btn sm" id="u-import" type="button">Import</button></div>
    </div>`, "span-12")}`;
  const prev = createPreview($("#e-stage"));
  const can = guestOk("effects");
  function grid() {
    const showing = app.status?.effect, pr = prefs();
    $("#e-grid").innerHTML = st.effects.filter(e => (tag === "all" || e.tag === tag || (tag === "mine" && e.custom) || (tag === "liked" && pr[e.id] === 1) || (tag === "banned" && pr[e.id] === -1)) && (!q || e.name.toLowerCase().includes(q))).map(e =>
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
  let customSel = null; // set below: fills the Make your own form when a custom effect is chosen
  function selectFx(id) {
    sel = id; $("#e-sel").value = id; customSel && customSel(id); $("#e-selname").textContent = st.effects.find(e => e.id === id)?.name || id; const cur = params()[id] || {};
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
  grid(); selectFx(st.show.mode === "manual" ? st.show.effect : app.status?.effect || st.show.effect);
  $("#e-q").oninput = e => { q = e.target.value.toLowerCase(); grid(); };
  $$("#e-tags [data-tag]").forEach(b => b.onclick = () => { tag = b.dataset.tag; $$("#e-tags .chip").forEach(c => c.setAttribute("aria-pressed", c === b)); grid(); });
  const show = b => act(() => api("PATCH", "/api/show", b)).catch(() => {});
  $("#e-auto").onclick = () => show({ mode: "auto" });
  $("#e-style").onchange = e => show({ style: e.target.value }); $("#e-pal").onchange = e => show({ palette: e.target.value }); $("#e-var").onchange = e => show({ variety: e.target.value });
  $("#e-every").oninput = e => $("#e-every-o").textContent = e.target.value + " beats"; $("#e-every").onchange = e => show({ everyBeats: Number(e.target.value) });
  $("#e-speed").oninput = e => $("#e-speed-o").textContent = e.target.value + "×"; $("#e-speed").onchange = e => show({ speed: Number(e.target.value) });
  const layer = () => show({ layer: $("#e-layer").value ? { effect: $("#e-layer").value, amount: Number($("#e-lamt").value) } : null });
  $("#e-layer").onchange = layer; $("#e-lamt").oninput = e => $("#e-lamt-o").textContent = Math.round(e.target.value * 100) + "%"; $("#e-lamt").onchange = layer;
  if (!can) $$("#e-style, #e-pal, #e-var, #e-every, #e-speed, #e-auto, #e-layer, #e-lamt").forEach(x => x.disabled = true);
  // make your own: a form over the parts of a custom effect; editing a custom effect fills it in
  let editing = null; const U = id => $("#u-" + id);
  const outFmt = { speed: v => v + "×", width: v => Math.round(v * 100) + "%", cyc: v => String(v), bg: v => Math.round(v * 100) + "%" };
  for (const k of Object.keys(outFmt)) U(k).oninput = e => U(k + "-o").textContent = outFmt[k](Number(e.target.value));
  U("pal").onchange = e => { U("c1").disabled = U("c2").disabled = e.target.checked; };
  const readForm = () => ({ name: U("name").value, pattern: U("pattern").value, axis: U("axis").value, drive: U("drive").value, tag: U("tag").value,
    colors: U("pal").checked ? "palette" : [U("c1").value, U("c2").value], speed: Number(U("speed").value), width: Number(U("width").value), cycles: Number(U("cyc").value), bg: Number(U("bg").value) });
  function fillForm(d) { editing = d ? d.id : null; d = d || { name: "My effect", pattern: "wave", axis: "along", drive: "beat", tag: "drop", colors: "palette", speed: 1, width: 0.15, cycles: 1, bg: 0.05 };
    for (const k of ["name", "pattern", "axis", "drive", "tag"]) U(k).value = d[k]; U("pal").checked = !Array.isArray(d.colors); U("c1").disabled = U("c2").disabled = U("pal").checked;
    if (Array.isArray(d.colors)) { U("c1").value = d.colors[0]; U("c2").value = d.colors[1]; }
    for (const [k, key] of [["speed", "speed"], ["width", "width"], ["cyc", "cycles"], ["bg", "bg"]]) { U(k).value = d[key]; U(k + "-o").textContent = outFmt[k](d[key]); }
    U("editing").textContent = editing ? `Editing ${d.name}` : "New effect"; U("new").hidden = U("del").hidden = !editing; U("save").textContent = editing ? "Save changes" : "Save and show it"; }
  let customs = []; const loadCustoms = () => api("GET", "/api/custom-effects").then(l => { customs = l; }).catch(() => {});
  customSel = id => { const c = customs.find(x => x.id === id); if (c && editing !== c.id) fillForm(c); };
  loadCustoms().then(() => customSel(sel));
  U("save").onclick = async () => { const body = readForm(), r = await act(() => editing ? api("PUT", `/api/custom-effects/${editing}`, body) : api("POST", "/api/custom-effects", body), editing ? "Effect updated" : "Effect saved").catch(() => null);
    if (!r) return; await api("PATCH", "/api/show", { effect: r.id, mode: "manual" }).catch(() => {}); await refreshState(); route(); };
  U("new").onclick = () => fillForm(null);
  U("del").onclick = async () => { if (!editing || !confirm("Delete this effect?")) return; await act(() => api("DELETE", `/api/custom-effects/${editing}`), "Deleted").catch(() => {}); await refreshState(); route(); };
  U("share").onclick = async () => { const code = "TL1:" + btoa(unescape(encodeURIComponent(JSON.stringify(readForm())))); U("code").value = code; try { await navigator.clipboard.writeText(code); toast("Share code copied"); } catch { U("code").select(); toast("Copy the code from the box"); } };
  // a share code is someone else's text: take only the parts the form knows, each only if it fits
  const fromCode = (c, base) => { if (!c.startsWith("TL1:") || c.length > 4000) throw 0; const d = JSON.parse(decodeURIComponent(escape(atob(c.slice(4))))); if (!d || typeof d !== "object" || Array.isArray(d)) throw 0;
    const out = { ...base }, sel = k => [...U(k).options].some(o => o.value === d[k]);
    if (typeof d.name === "string") out.name = d.name.slice(0, 40); for (const k of ["pattern", "axis", "drive", "tag"]) if (sel(k)) out[k] = d[k];
    out.colors = Array.isArray(d.colors) && d.colors.length === 2 && d.colors.every(x => /^#[0-9a-f]{6}$/i.test(x)) ? d.colors.map(x => x.toLowerCase()) : "palette";
    for (const [k, id] of [["speed", "speed"], ["width", "width"], ["cycles", "cyc"], ["bg", "bg"]]) { const v = Number(d[k]); if (d[k] !== null && d[k] !== "" && Number.isFinite(v)) out[k] = Math.max(Number(U(id).min), Math.min(Number(U(id).max), v)); }
    if (!out.pattern || out.pattern !== d.pattern) throw 0; return out; };
  U("import").onclick = () => { const c = U("code").value.trim(); try { const d = fromCode(c, readForm()); fillForm(null); fillForm(d); editing = null; U("editing").textContent = "Imported: press Save"; U("new").hidden = U("del").hidden = true; U("save").textContent = "Save and show it"; }
    catch { toast("That isn't a Tempolight share code", true); } };
  if (!can) $$("#u-form input, #u-form select, #u-form button").forEach(x => x.disabled = true);
  let lastFx = null, followed = true;
  $("#e-sel").addEventListener("change", () => { followed = false; });
  return { preview: true,
    onStatus(m) { $("#e-now").textContent = `${m.effectName}${app.state.show.mode === "auto" ? " (automatic)" : ""}`;
      if (m.effect !== lastFx) { lastFx = m.effect; grid(); if (followed && !el.contains(document.activeElement)) selectFx(m.effect); } },
    onChanged(w) { if (w.has("show")) { Object.assign(st, app.state); grid(); } if (w.has("effects") && !el.contains(document.activeElement)) route(); },
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
  { id: "fog", name: "Fog", desc: "While held (DMX fog)", key: "G", hold: true, dmx: true },
];
const COLORS = ["#ff2bd6", "#16e0ff", "#ffd23f", "#ff3d3d", "#20ffa8", "#7a3cff", "#ffffff"];
function livePage(el) {
  el.innerHTML = `${panel("Live pads", "Play the lights like an instrument. Keyboard shortcuts work on this page.", "", `<div class="pb stack">
      <div class="dropcd" id="l-drop" role="timer" aria-label="Drop countdown" hidden><span class="dropcd-l" id="l-drop-l">Drop in</span><b id="l-drop-n">4</b><span class="dropcd-dots" aria-hidden="true">${[4, 3, 2, 1].map(n => `<i data-n="${n}">${n}</i>`).join(" · ")}</span></div>
      <div class="pads" id="pads">${PADS.filter(p => !p.dmx || app.state.devices.some(d => d.kind === "dmx")).map(p => `<button class="pad" data-pad="${p.id}" type="button"><b>${p.name}</b><span>${p.desc}</span><kbd>${p.key}</kbd></button>`).join("")}</div>
      <div class="field"><span class="lbl">Colour hold (tap again to release)</span><div class="swatches" id="holds">${COLORS.map(c => `<button class="swatch" style="background:${c}" data-c="${c}" aria-label="Hold ${c}" type="button"></button>`).join("")}</div></div>
      <div class="field"><span class="lbl">Flash colour</span><div class="swatches" id="flashc">${COLORS.map((c, i) => `<button class="swatch" style="background:${c}" data-c="${c}" aria-pressed="${i === 6}" aria-label="Flash ${c}" type="button"></button>`).join("")}</div></div></div>`, "span-7")}
    ${panel("Preview", `<span id="l-now"></span>`, "", `<div class="stage" id="l-stage"></div>`, "span-5")}
    ${panel("Scenes", "", "", `<div class="pb chips">${app.state.scenes.map(s => `<button class="chip" data-scene="${s.id}" type="button">${esc(s.name)}</button>`).join("")}</div>`, "span-5")}
    ${panel("MIDI controller", `<span id="midi-st">${navigator.requestMIDIAccess ? "Not connected" : "This browser has no MIDI (try Chrome or Edge on a computer)"}</span>`, navigator.requestMIDIAccess ? `<button class="btn" id="midi-on" type="button">Connect</button><button class="btn" id="midi-learn" type="button" aria-pressed="false">Learn</button>` : "",
      `<div class="pb stack"><p class="faint" style="font-size:12.5px">Pads play from notes 36 to 45 (the bottom pads on most controllers). To change one, press Learn, tap a pad here, then hit the key or pad on your controller.</p>
      ${navigator.requestMIDIAccess ? `<div class="row"><label class="check"><input type="checkbox" id="mc-on" disabled> Follow MIDI clock from</label><select id="mc-in" aria-label="MIDI clock input" disabled style="max-width:200px"><option>Connect first</option></select></div><p class="faint" style="font-size:12.5px" id="mc-st">The beat comes from DJ software or a drum machine sending MIDI clock (24 per beat) on that input; Start and Song Position set the bar.</p>` : ""}</div>`, "span-5")}
    ${panel("Phones as lights", `<span id="ph-n">No phones yet</span>`, "", `<div class="pb phones"><div class="qr" id="ph-qr" aria-live="polite"></div><div class="stack">
      <p>Guests scan this code, tap Start, and their screen becomes another light that moves with the room. Works best with a crowd holding phones up at the drop.</p>
      <p class="faint" style="font-size:12.5px" id="ph-url"></p>
      ${DEMO ? `<p class="callout">In the online demo, open the link in another tab of this browser. At home, phones on the same Wi-Fi scan the code.</p>` : `<p class="faint" style="font-size:12.5px">Phones must be on the same Wi-Fi as this Tempolight.</p>`}</div></div>`, "span-7")}`;
  const prev = createPreview($("#l-stage"));
  phoneQr();
  if (!guestOk("pads")) { $$(".pad, .swatch").forEach(b => b.disabled = true); }
  let flashColor = "#ffffff", holdColor = null;
  // the drop countdown: "Drop in 4 · 3 · 2 · 1" from 8 s before a drop that is known or predicted fairly surely
  // (status.drop, 4 times a second; counted down here in between), unless Settings turned it off
  const cd = { at: null, timer: null };
  const cdShow = () => { const box = $("#l-drop"); if (!box) return; const left = cd.at == null ? null : (cd.at - performance.now()) / 1000;
    if (left == null || left > 8 || left < -0.6) { box.hidden = true; return; }
    const n = Math.max(0, Math.ceil(left)); box.hidden = false; box.classList.toggle("now", n === 0);
    $("#l-drop-l").textContent = n === 0 ? "" : "Drop in"; $("#l-drop-n").textContent = n === 0 ? "Drop" : String(n);
    $$("#l-drop i").forEach(i => i.classList.toggle("on", Number(i.dataset.n) === n)); };
  const cdStatus = m => { const d = m.drop, on = app.state?.settings?.dropCountdown !== false;
    cd.at = on && d && d.next != null && d.conf >= 0.5 && d.next <= 8 ? performance.now() + d.next * 1000 : (cd.at != null && performance.now() - cd.at < 600 && performance.now() >= cd.at ? cd.at : null); // (keeps "Drop" a moment)
    if (cd.at != null && !cd.timer) cd.timer = setInterval(() => { cdShow(); if (cd.at == null || performance.now() - cd.at > 600) { clearInterval(cd.timer); cd.timer = null; cdShow(); } }, 100);
    cdShow(); };
  const send = a => { if (ws.open) ws.send({ type: "action", action: a }); else api("POST", "/api/action", a).catch(e => toast(e.message, true)); };
  const press = (id, down) => {
    const p = PADS.find(x => x.id === id); if (!p) return; const b = $(`[data-pad="${id}"]`); b && b.classList.toggle("down", down);
    if (p.hold) { if (id === "strobe") send({ type: "strobe", on: down }); if (id === "boost") send({ type: "boost", value: down ? 1.8 : 1 }); if (id === "fog") send({ type: "fog", on: down }); return; }
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
  const keymap = { " ": "flash", s: "strobe", b: "blackout", f: "freeze", u: "build", d: "drop", n: "next", x: "boost", t: "tap", escape: "cancel", g: "fog" };
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
    $("#midi-on").onclick = async () => { try { if (!clock.load) { const { createClockFollower } = await import("/midiclock.js"); clock = createClockFollower(m => ws.send(m)); clock.load = true; } midi = await navigator.requestMIDIAccess(); const hook = () => { const ins = [...midi.inputs.values()]; ins.forEach(i => i.onmidimessage = onMidi);
        $("#midi-st").textContent = ins.length ? `Connected: ${ins.map(i => i.name).join(", ")}` : "No MIDI controller found. Plug one in."; clockInputs(ins); }; hook(); midi.onstatechange = hook; }
      catch (e) { $("#midi-st").textContent = "MIDI permission was refused"; } };
    $("#midi-learn").onclick = () => { learning = !learning; $("#midi-learn").setAttribute("aria-pressed", learning); $("#midi-st").textContent = learning ? "Learn: tap a pad here, then hit a key on the controller" : "Learn off"; };
    $$(".pad").forEach(b => b.addEventListener("pointerdown", () => { if (learning) learnPad = b.dataset.pad; }, true));
  }
  // MIDI clock: the selected input's clock becomes the beat grid on the server (midiclock.js, loaded with MIDI)
  let clock = { input: null, follow() {}, stop() {} }; const clockKey = "tl.midiclock";
  function clockInputs(ins) { const sel = $("#mc-in"), on = $("#mc-on"); if (!sel) return; let want = null; try { want = localStorage.getItem(clockKey); } catch {}
    sel.innerHTML = ins.map(i => opt(i.id, i.name, i.id === (clock.input?.id || want))).join("") || "<option>No MIDI inputs</option>"; sel.disabled = on.disabled = !ins.length;
    const pick = () => ins.find(i => i.id === sel.value);
    on.onchange = () => { if (on.checked && pick()) { clock.follow(pick()); try { localStorage.setItem(clockKey, pick().id); } catch {} } else clock.stop(); };
    sel.onchange = () => { if (on.checked && pick()) clock.follow(pick()); };
    if (clock.input && !ins.some(i => i.id === clock.input.id)) { clock.stop(); on.checked = false; } }
  return { preview: true,
    onStatus(m) { $("#l-now").textContent = m.effectName; const o = m.overlay; cdStatus(m); if ($("#mc-st") && clock.input) $("#mc-st").textContent = m.midiClock ? (m.midiClock.running ? `Following ${m.midiClock.input}: ${m.midiClock.bpm} BPM${m.midiClock.barKnown ? "" : " (no Start yet: the bar is a guess)"}` : m.midiClock.stopped ? "Stopped: waiting for Start or Continue" : "Waiting for clock…") : "Waiting for clock…"; $("#ph-n").textContent = m.phones ? `${m.phones} phone${m.phones > 1 ? "s" : ""} joined` : "No phones yet";
      $('[data-pad="blackout"]').setAttribute("aria-pressed", o.blackout); $('[data-pad="freeze"]').setAttribute("aria-pressed", o.freeze);
      $('[data-pad="strobe"]').setAttribute("aria-pressed", o.strobe); $('[data-pad="build"]').classList.toggle("hot", o.forced === "build"); $('[data-pad="drop"]').classList.toggle("hot", o.forced === "drop"); },
    destroy() { prev.destroy(); clearInterval(cd.timer); removeEventListener("keydown", kd); removeEventListener("keyup", ku); if (midi) [...midi.inputs.values()].forEach(i => i.onmidimessage = null); clock.stop(); } };
}

/** A link a guest's phone can open: a phone can't reach "localhost", so use this computer's network address. */
export async function guestUrl(path) {
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
  el.innerHTML = `${panel("Scenes", "A scene remembers the effect, style, colours and brightness", `<button class="btn primary" id="sc-save" type="button"${canScenes ? "" : " disabled"}>Save current as a scene</button>`, `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Effect</th><th>Colours</th><th class="num">Brightness</th><th></th></tr></thead><tbody>
      ${st.scenes.map(sc => `<tr><td>${esc(sc.name)}</td><td>${esc(showName(sc))}</td><td>${esc(sc.show.palette || "auto")}</td><td class="num">${Math.round((sc.brightness ?? 1) * 100)}%</td>
        <td><button class="btn sm" data-apply="${sc.id}" type="button"${canScenes ? "" : " disabled"}>Apply</button> <button class="btn sm" data-ren="${sc.id}" type="button"${canScenes ? "" : " disabled"}>Rename</button> <button class="btn sm" data-upd="${sc.id}" type="button"${canScenes ? "" : " disabled"}>Update to current</button> <button class="btn sm danger" data-del="${sc.id}" type="button"${canScenes ? "" : " disabled"}>Delete</button></td></tr>`).join("") || '<tr><td colspan="5" class="faint">No scenes</td></tr>'}
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
  $$("[data-upd]").forEach(b => b.onclick = async () => { const sh = app.state.show; await act(() => api("PUT", `/api/scenes/${b.dataset.upd}`, { show: { mode: sh.mode, effect: sh.effect, style: sh.style, palette: sh.palette, everyBeats: sh.everyBeats, variety: sh.variety, speed: sh.speed }, brightness: app.state.settings.brightness }), "Scene updated").catch(() => {}); re(); });
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
const SMART = { lifx: "LIFX", wiz: "WiZ", kasa: "TP-Link Kasa", yeelight: "Yeelight", twinkly: "Twinkly" }; // smart lights (server lights.js)
const KIND_GROUPS = [["LED controllers", [["wled", "WLED"], ["openrgb", "OpenRGB (PC lighting)"]]], ["Panels and strings", [["nanoleaf", "Nanoleaf panels"], ["twinkly", "Twinkly"]]],
  ["Smart bulbs and strips", [["hue", "Philips Hue bridge"], ["lifx", "LIFX"], ["wiz", "WiZ"], ["kasa", "TP-Link Kasa"], ["yeelight", "Yeelight"], ["govee", "Govee (LAN, beta)"]]]];
/** Hue: basic or fast (Entertainment), offered when the bridge has an entertainment area */
function hueMode(d, h) {
  const fast = !!d.hue?.fast; if (!fast && !(h.hueAreas?.length || d.hue?.areas?.length)) return "Hue (about 10 updates/s)";
  return `<select data-hmode="${d.id}" aria-label="Hue mode" title="${fast ? esc(`Entertainment area: ${d.hue.area}`) : "Fast mode streams to the bridge's entertainment area"}">${opt("basic", "Hue: basic (10/s)", !fast)}${opt("fast", "Hue: fast (Entertainment)", fast)}</select>`;
}
function smartMode(d) {
  const L = d.light || {};
  if (d.kind === "yeelight") return `<select data-lopt="${d.id}" data-key="music" aria-label="Yeelight mode">${opt("1", "Yeelight: music mode (20/s)", L.music !== false)}${opt("0", "Yeelight: normal (1/s)", L.music === false)}</select>`;
  if (d.kind === "kasa" && L.strip) return `<select data-lopt="${d.id}" data-key="perZone" aria-label="Kasa strip mode">${opt("0", "Kasa: whole strip", !L.perZone)}${opt("1", `Kasa: ${L.zones || "?"} zones (beta)`, !!L.perZone)}</select>`;
  if (d.kind === "lifx") return L.extended && L.zones > 1 ? `LIFX, ${L.zones} zones` : "LIFX";
  return SMART[d.kind];
}
function devicesPage(el) {
  if (!unlocked()) return lockScreen(el, "Device setup");
  const st = app.state;
  el.innerHTML = `${panel("Devices", "WLED controllers and other lights that receive the show", `<button class="btn" id="d-scan" type="button">Scan network</button><button class="btn" id="d-virtual" type="button">Add virtual device</button>`, `<div class="tablewrap"><table><thead><tr><th>On</th><th>Name</th><th>Address</th><th class="num">LEDs</th><th class="num">Used</th><th>Protocol</th><th class="num">Port / universe</th><th class="num" title="Power supply limit in amps. Brightness is capped so the strip never draws more.">Power limit (A)</th><th class="num">Drawing now</th><th>Status</th><th>Firmware</th><th class="num">Frames sent</th><th class="num" title="From a sound to its light">Delay</th><th></th></tr></thead><tbody id="d-rows"></tbody></table></div>`, "span-12")}
    ${panel("Sound to light", "How long after a beat each light shows it", "", `<div class="pb" id="d-lat"></div>`, "span-12")}
    ${panel("Add a controller", "", "", `<div class="pb"><div class="row"><input id="d-ip" placeholder="IP address, e.g. 192.168.1.42 (or host:port)" style="max-width:340px"><input id="d-name" placeholder="Name (optional)" style="max-width:220px"><select id="d-kind" aria-label="Kind of light" style="max-width:210px">${KIND_GROUPS.map(([g, list]) => `<optgroup label="${g}">${list.map(([v, l]) => opt(v, l, v === "wled")).join("")}</optgroup>`).join("")}</select><button class="btn primary" id="d-add" type="button">Add</button></div>
      ${DEMO ? `<p class="callout" style="margin-top:8px">This demo has pretend controllers at ${Object.keys(demo.FAKE_WLED).join(", ")}. Press “Scan network” to find them.</p>` : ""}
      <p class="faint" style="margin-top:8px;font-size:12.5px">Power limit: enter your power supply's amps (for example 10 for a 5 V 10 A supply) and Tempolight keeps the strip under it, estimating about 60 mA per LED at full white. Find the address in the WLED app or your router. Tempolight sends light with DDP on UDP port 4048; in WLED, keep “Receive UDP realtime” on (Sync settings).
</p>
      <details style="margin-top:6px;font-size:12.5px" class="faint"><summary>Before adding other kinds of light</summary><ul style="margin:6px 0 0 18px;padding:0">
        <li>OpenRGB (RAM, fans, keyboards, motherboards): start OpenRGB's SDK server, then Scan network.</li>
        <li>Nanoleaf: hold the controller's power button for 5–7 seconds until the lights flash, then add its address; the panels appear in the room where they really are.</li>
        <li>Twinkly: nothing to do; lights mapped in the Twinkly app appear in the room in that shape.</li>
        <li>Philips Hue: press the bridge's link button, then add the bridge's address. Basic mode updates about 10 lights a second (calm effects); with an entertainment area made in the Hue app, choose “Fast (Entertainment)” in its row for up to 50 updates a second.</li>
        <li>LIFX: LAN control must be on (it is by default). Strips and beams get a colour per zone.</li>
        <li>WiZ: “Allow local communication” on in the WiZ app. About 10 updates a second.</li>
        <li>TP-Link Kasa: bulbs and KL light strips. Tapo lights aren't supported (they need a TP-Link account login).</li>
        <li>Yeelight: turn on “LAN Control” in the Yeelight app. Music mode (the light connects back to Tempolight) allows 20 updates a second; let Tempolight through your firewall.</li>
        <li>Govee (beta): turn on “LAN Control” in the Govee Home app. One colour works on all LAN models; segments mode uses DreamView streaming and only some models support it.</li></ul></details></div>`, "span-6")}
    ${panel("Found on the network", `<span id="d-scanmsg">Press “Scan network” to look</span>`, "", `<div class="tablewrap"><table><tbody id="d-found"></tbody></table></div>`, "span-6")}
    <template id="d-dmx"></template>`;
  let dmx = null, gone = false; // the DMX panels (dmx.js), loaded with this page
  import("/dmx.js").then(m => { const slot = $("#d-dmx"); if (gone || !slot) return; slot.insertAdjacentHTML("beforebegin", m.dmxPanels()); slot.remove(); dmx = m.mountDmx(el); }).catch(() => {});
  function rows(m) {
    const s = m || app.status || { devices: [] };
    $("#d-rows").innerHTML = st.devices.map(d => { const h = s.devices.find(x => x.id === d.id) || {};
      const sig = h.signal != null ? `<span class="sig" title="Wi-Fi ${h.signal}%">${[25, 50, 75, 100].map((v, i) => `<i style="height:${4 + i * 3}px" class="${h.signal >= v - 12 ? "on" : ""}"></i>`).join("")}</span>` : "";
      return `<tr><td><input type="checkbox" data-en="${d.id}" ${d.enabled ? "checked" : ""} aria-label="Send to this device"></td><td><input value="${esc(d.name)}" data-name="${d.id}" style="width:150px"></td>
        <td>${d.virtual ? '<span class="faint">virtual</span>' : `<input class="mono" value="${esc(d.host)}" data-host="${d.id}" style="width:150px">`}</td>
        <td class="num"><input type="number" min="1" value="${d.leds || ""}" data-leds="${d.id}"></td><td class="num">${h.used ?? 0}</td><td>${d.virtual ? "–" : d.kind === "hue" ? hueMode(d, h) : SMART[d.kind] ? smartMode(d) : d.kind === "nanoleaf" ? "Nanoleaf stream" : d.kind === "openrgb" ? `OpenRGB #${d.orgbIndex || 0}` : d.kind === "govee" ? `<select data-gmode="${d.id}" aria-label="Govee mode">${opt("color", "Govee: one colour", d.goveeMode !== "segments")}${opt("segments", "Govee: segments (beta)", d.goveeMode === "segments")}</select>` : `<select data-proto="${d.id}" aria-label="Protocol">${d.kind === "dmx" ? "" : opt("ddp", "DDP", !d.protocol || d.protocol === "ddp")}${opt("e131", "E1.31 (sACN)", d.protocol === "e131")}${opt("artnet", "Art-Net", d.protocol === "artnet")}</select>`}</td>
        <td class="num">${d.virtual || SMART[d.kind] || d.kind === "hue" ? "–" : d.kind === "govee" ? (d.goveeMode === "segments" ? `<input type="number" min="1" max="60" title="Segments on the light" placeholder="segments" value="${d.goveeSegments || ""}" data-gseg="${d.id}" aria-label="Segments">` : "–") : (!d.protocol || d.protocol === "ddp") ? `<input type="number" min="1" max="65535" value="${d.ddpPort || 4048}" data-port="${d.id}">` : `<input type="number" min="0" max="63999" title="First universe" value="${d.universe ?? (d.protocol === "artnet" ? 0 : 1)}" data-univ="${d.id}" aria-label="First universe">`}</td>
        <td class="num"><input type="number" min="0" max="500" step="0.5" placeholder="none" value="${d.maxAmps || ""}" data-amps="${d.id}" aria-label="Power limit in amps"></td>
        <td class="num">${h.amps != null ? `${h.amps.toFixed(1)} A${h.limited ? ' <span class="badge warn" title="Brightness is being held back to stay under the limit">capped</span>' : ""}` : "–"}</td>
        <td>${!d.enabled ? '<span class="badge">Off</span>' : h.online ? `<span class="badge live"><i></i>Online</span> ${sig}` : h.online === false ? `<span class="badge err" title="${esc(h.error)}"><i></i>Offline</span>` : '<span class="badge">Checking</span>'}</td>
        <td class="mono faint">${esc(h.version || "")}</td><td class="num">${h.sent ?? 0}</td><td class="num">${d.enabled ? latencyChip(h) : ""}${warnIcons(h)}</td>
        <td><button class="btn sm" data-id="${d.id}" type="button">Identify</button> ${SMART[d.kind] ? `<button class="btn sm" data-chk="${d.id}" type="button">Check</button>` : ""}${d.virtual || d.kind ? "" : `<button class="btn sm" data-seg="${d.id}" type="button" title="Write this room's segments into WLED">Send segments</button> <button class="btn sm" data-chk="${d.id}" type="button">Check</button>`} <button class="btn sm danger" data-del="${d.id}" type="button">Remove</button></td></tr>`; }).join("")
      || '<tr><td colspan="14" class="faint">No devices yet. Scan the network or add one by address.</td></tr>';
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
    $$("[data-hmode]").forEach(x => x.onchange = () => act(() => api("PATCH", `/api/devices/${x.dataset.hmode}`, { hueFast: x.value === "fast" }), x.value === "fast" ? "Fast mode on" : "Basic mode").catch(() => { x.value = "basic"; }));
    $$("[data-lopt]").forEach(x => x.onchange = () => patch(x.dataset.lopt, { light: { [x.dataset.key]: x.value === "1" } }));
    $$("[data-id]").forEach(x => x.onclick = () => api("POST", `/api/devices/${x.dataset.id}/identify`).then(() => toast("Lighting it up in white")).catch(e => toast(e.message, true)));
    $$("[data-seg]").forEach(x => x.onclick = () => act(() => api("POST", `/api/devices/${x.dataset.seg}/segments`), "Segments sent to WLED").catch(() => {}));
    $$("[data-chk]").forEach(x => x.onclick = () => act(() => api("POST", `/api/devices/${x.dataset.chk}/check`)).then(h => toast(h.online ? `Online, ${/^[A-Z]/.test(h.version || "") ? "" : "WLED "}${h.version}, ${h.ledsReported} LEDs` : `Offline: ${h.error}`, !h.online)).catch(() => {}));
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
      $("#d-found").innerHTML = found.map((f, i) => `<tr><td>${esc(f.name || "WLED")}</td><td class="mono">${esc(f.host)}</td><td class="num">${f.kind === "govee" ? "Govee" : SMART[f.kind] ? (f.leds > 1 ? `${f.leds} zones` : "") : `${f.leds ?? "?"} LEDs`}</td><td class="faint">${f.kind === "govee" ? "LAN" : f.kind === "openrgb" ? "OpenRGB" : SMART[f.kind] || (f.via === "mdns" ? "WLED (mDNS)" : "WLED")}</td><td>${f.added ? '<span class="faint">added</span>' : `<button class="btn sm" data-f="${i}" type="button">Add</button>`}</td></tr>`).join("");
      $$("[data-f]").forEach(b => b.onclick = () => { const f = found[Number(b.dataset.f)]; act(() => api("POST", "/api/devices", f.kind === "govee" || SMART[f.kind] ? { host: f.host, name: f.name, kind: f.kind } : f.kind === "openrgb" ? { host: f.host, name: f.name, kind: "openrgb", index: f.index, leds: f.leds } : { host: f.host, name: f.name, leds: f.leds, force: true }), "Device added").then(() => b.replaceWith("added")).catch(() => {}); });
    } catch {} finally { $("#d-scan").disabled = false; }
  };
  const lat = m => { const box = $("#d-lat"); if (box) box.innerHTML = latencyPanel(m || app.status, st.devices); }; lat();
  return { onStatus(m) { lat(m); if (!el.contains(document.activeElement) || document.activeElement === document.body) rows(m); }, onChanged(w) { if (w.has("devices")) route(); }, destroy() { gone = true; dmx?.destroy(); } };
}

// ---------------------------------------------------------------- Settings
function settingsPage(el) {
  const st = app.state, s = st.settings, admin = unlocked();
  const ambOpts = `${opt("off", "Off (dark when nothing plays)", s.ambient === "off")}${st.effects.filter(e => e.tag === "calm").map(e => opt(e.id, e.name, e.id === s.ambient)).join("")}`;
  el.innerHTML = `${!admin ? panel("Settings are locked", "", "", `<div class="pb"><div class="row"><input id="u-pin" type="password" inputmode="numeric" placeholder="PIN" style="max-width:160px"><button class="btn primary" id="u-go" type="button">Unlock</button></div></div>`) : ""}
    ${panel("Lighting", "How the room moves with the music", "", `<div class="pb"><div class="setlist">
      <div class="setrow wide"><span><b>Punch</b><small>How hard the whole room pumps on each kick in a drop.</small></span><div class="ctl"><div><label for="s-punch">Punch</label><output id="s-punch-o">${Math.round((s.punch ?? 0.7) * 100)}%</output></div><input type="range" id="s-punch" min="0" max="1" step="0.05" value="${s.punch ?? 0.7}"></div></div>
      <div class="setrow wide"><span><b>Drama</b><small>How much brighter drops are than calm parts, with a dip just before each drop.</small></span><div class="ctl"><div><label for="s-dyn">Drama</label><output id="s-dyn-o">${Math.round((s.dynamics ?? 0.8) * 100)}%</output></div><input type="range" id="s-dyn" min="0" max="1" step="0.05" value="${s.dynamics ?? 0.8}"></div></div>
      <div class="setrow wide"><span><b>Stereo</b><small>With a stereo source (this computer's sound, a song played here), the side of the room a hit came from lights up more. Mono sources and rooms with no width are unchanged.</small></span><div class="ctl"><select id="s-stereo" aria-label="Stereo">${opt("off", "Off", s.stereo === "off")}${opt("subtle", "Subtle", (s.stereo || "subtle") === "subtle")}${opt("strong", "Strong", s.stereo === "strong")}</select></div></div>
      <label class="setrow" title="With Automatic colours, each chord has its own shade of the palette; the colour steps on the bar line when the chord changes"><span><b>Chord colours</b><small>Colours step with the song's chords, on the bar line.</small></span><input type="checkbox" id="s-chordc" ${s.chordColours !== false ? "checked" : ""}></label>
      <label class="setrow"><span><b>Vary drops</b><small>A colour flip or a mirror every 2 bars, so long drops stay fresh.</small></span><input type="checkbox" id="s-vary" ${s.variations !== false ? "checked" : ""}></label>
      <label class="setrow"><span><b>Flash on drops</b><small>A white hit the moment a drop lands.</small></span><input type="checkbox" id="s-dropf" ${s.dropFlash ? "checked" : ""}></label>
      <label class="setrow"><span><b>Live pads countdown</b><small>"Drop in 4 · 3 · 2 · 1" on the Live pads page, before a known or predicted drop.</small></span><input type="checkbox" id="s-dropcd" ${s.dropCountdown !== false ? "checked" : ""}></label>
      <label class="setrow"><span><b>Photosensitive-safe mode</b><small>At most 3 flashes a second.</small></span><input type="checkbox" id="s-safe" ${s.safe ? "checked" : ""}></label>
    </div></div>`, "span-12")}
    ${panel("When nothing plays", "Idle light and performance", "", `<div class="pb controls">
      <div class="field"><label for="s-amb">Ambient effect</label><select id="s-amb">${ambOpts}</select><span class="help">Also used as a soft floor so quiet songs never turn the room dark.</span></div>
      <div class="field"><label for="s-idleb">Idle brightness <output id="s-idleb-o">${Math.round(s.idleBrightness * 100)}%</output></label><input type="range" id="s-idleb" min="0" max="1" step="0.05" value="${s.idleBrightness}"></div>
      <div class="field"><label for="s-idlea">Go idle after <output id="s-idlea-o">${s.idleAfterSec} s</output></label><input type="range" id="s-idlea" min="2" max="60" step="1" value="${s.idleAfterSec}"><span class="help">Of silence.</span></div>
      <div class="field"><label for="s-fps">Frame rate <output id="s-fps-o">${s.fps} fps</output></label><input type="range" id="s-fps" min="20" max="90" step="5" value="${s.fps}"><span class="help">Lower it on a Raspberry Pi Zero or busy Wi-Fi.</span></div>
      <div class="field"><label for="s-perf">Performance</label><select id="s-perf">${opt("auto", "Automatic", (s.performance || "auto") === "auto")}${opt("full", "Full", s.performance === "full")}${opt("lite", "Low power (small computers)", s.performance === "lite")}</select><span class="help">Low power: at most 30 fps, a lighter preview and fewer updates. Automatic picks it on a Raspberry Pi Zero or Pi 3, or when this computer can't keep up.</span><span class="help" id="s-perf-st"></span></div>
    </div>`, "span-12")}
    ${panel("Integrations", "", "", `<div class="pb controls">
      <label class="check"><input type="checkbox" id="s-sync" ${s.audioSync ? "checked" : ""}> Send WLED audio sync (lets WLED's own sound effects react too)</label>
      <div class="field"><label class="check"><input type="checkbox" id="s-osc" ${s.osc.enabled ? "checked" : ""}> OSC control on UDP port</label><input type="number" id="s-oscport" value="${s.osc.port}" style="width:110px"><span class="help">/tempolight/effect laser, /scene Party, /flash, /blackout 1, /brightness 0.5 …</span></div>
      <label class="check"><input type="checkbox" id="s-dj" ${s.djlink?.enabled ? "checked" : ""} ${DEMO ? "disabled" : ""}> Pioneer Pro DJ Link: take the beat from CDJs and XDJs on this network (listens only)</label>
      <label class="check"><input type="checkbox" id="s-link" ${s.link?.enabled ? "checked" : ""} ${DEMO ? "disabled" : ""}> Ableton Link: follow the tempo and beat of a Link session (Live, Traktor, Bitwig, phone apps; listens only, never changes the tempo)</label>
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
    ${DEMO || !admin ? "" : '<div id="s-hk"></div>'}
    ${DEMO || !admin ? "" : panel("Wi-Fi", "", "", `<div class="pb stack" id="s-wifi"><p class="muted" id="s-wifistate">Checking…</p>
      <p class="faint" style="font-size:12.5px">Moving to another network? Start setup: this Pi leaves the current Wi-Fi and opens the <b>Tempolight-Setup</b> hotspot. Join it from your phone and pick the new network.</p>
      <div class="row"><button class="btn" id="s-wifigo" type="button">Set up Wi-Fi again</button></div></div>`, "span-6")}
    ${panel("Backup", "Devices, room, zones, scenes, schedules and settings in one file", "", `<div class="pb stack"><div class="row"><button class="btn" id="b-down" type="button">Download backup</button><label class="btn" for="b-file">Restore from a file…</label><input type="file" id="b-file" accept="application/json,.json" hidden></div>
      <p class="faint" style="font-size:12.5px">Use it to move to a new computer or Raspberry Pi. Restoring keeps your current PIN.</p></div>`, "span-6")}
    ${panel("Lock", st.locked ? "Locked with a PIN" : "Not locked", "", `<div class="pb stack">
      <p class="muted">A PIN stops guests at a party from changing devices, the room, schedules and settings. Choose what guests can still do:</p>
      <div class="row">${[["effects", "Pick effects"], ["scenes", "Use scenes"], ["pads", "Use live pads"], ["brightness", "Brightness and power"]].map(([k, l]) => `<label class="check"><input type="checkbox" data-guest="${k}" ${s.guest[k] ? "checked" : ""}> ${l}</label>`).join("")}</div>
      <div class="row">${st.locked ? `<button class="btn" id="s-unlockset" type="button">Remove PIN</button>${app.token ? '<button class="btn" id="s-relock" type="button">Lock now on this device</button>' : ""}` : `<input id="s-pin" type="password" inputmode="numeric" placeholder="New PIN (4–8 digits)" style="max-width:220px"><button class="btn primary" id="s-lock" type="button">Lock settings</button>`}</div>
    </div>`, "span-6")}
    ${panel("About", "", "", `<div class="pb stack"><p>Tempolight ${esc(st.version)}, MIT licence. <a href="https://tempolight.pages.dev/docs/" target="_blank" rel="noopener">Documentation</a> · <a href="https://github.com/D4RKGEEK/tempolight" target="_blank" rel="noopener">Source</a>.</p>
      <p class="muted">The old single-page playground is at <a href="/playground">/playground</a>.</p>
      <div class="row"><button class="btn" id="s-upd" type="button">${DEMO ? "Always up to date" : "Check for updates"}</button><button class="btn primary" id="s-updgo" type="button" hidden>Update now</button><button class="btn" id="s-wizard" type="button">Run setup again</button><button class="btn" id="s-claude" type="button">Set up with Claude</button>${st.canQuit ? '<button class="btn" id="s-quit" type="button">Quit Tempolight</button>' : ""}<button class="btn danger" id="s-reset" type="button">Reset everything</button></div>
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
  $("#s-perf").onchange = e => setS({ performance: e.target.value });
  $("#s-safe").onchange = e => setS({ safe: e.target.checked }); $("#s-dropf").onchange = e => setS({ dropFlash: e.target.checked }); $("#s-vary").onchange = e => setS({ variations: e.target.checked }); $("#s-dropcd").onchange = e => setS({ dropCountdown: e.target.checked });
  $("#s-chordc").onchange = e => setS({ chordColours: e.target.checked }); $("#s-stereo").onchange = e => setS({ stereo: e.target.value });
  for (const [id, k] of [["s-punch", "punch"], ["s-dyn", "dynamics"]]) { const r = $(`#${id}`); r.oninput = () => { $(`#${id}-o`).textContent = `${Math.round(r.value * 100)}%`; }; r.onchange = () => setS({ [k]: Number(r.value) }); }
  $("#s-sync").onchange = e => setS({ audioSync: e.target.checked }); $("#s-disc").onchange = e => setS({ autoDiscover: e.target.checked });
  $("#s-dj").onchange = e => setS({ djlink: { enabled: e.target.checked } }); $("#s-link").onchange = e => setS({ link: { enabled: e.target.checked } });
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
  $("#s-wizard").onclick = () => openWizard();
  $("#s-claude").onclick = () => import("/claude-setup.js").then(m => m.openClaudeSetup()).catch(() => toast("Setting up with Claude isn't available in this version", true));
  if ($("#s-wifi")) { const sec = $("#s-wifi").closest("section"); sec.hidden = true; // only on the Raspberry Pi image, where the Wi-Fi setup service runs
    api("GET", "/api/wifi").then(w => { if (!w || !w.available) return; sec.hidden = false;
      $("#s-wifistate").textContent = w.mode === "hotspot" ? `The setup hotspot ${w.hotspot} is open.` : w.ssid ? `Connected to ${w.ssid}.` : "Not on Wi-Fi (Ethernet, or not connected)."; }).catch(() => {});
    $("#s-wifigo").onclick = async () => { if (!confirm("Leave the current Wi-Fi and open the Tempolight-Setup hotspot? This page stops answering until the Pi is on a network again.")) return;
      const r = await act(() => api("POST", "/api/wifi/setup")).catch(() => null); if (r) $("#s-wifistate").textContent = r.message; }; }
  $("#s-upd").onclick = async () => { const m = $("#s-updmsg"); m.textContent = "Checking…"; const r = await act(() => api("GET", "/api/update")).catch(() => null); if (!r) { m.textContent = ""; return; }
    m.innerHTML = esc(r.message) + (r.changes?.length ? `<ul style="margin:6px 0 0 18px">${r.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""); $("#s-updgo").hidden = !r.canUpdate; };
  $("#s-updgo").onclick = async () => { const r = await act(() => api("POST", "/api/update")).catch(() => null); if (!r) return; $("#s-updmsg").textContent = r.message; $("#s-updgo").hidden = true;
    const t0 = Date.now(), wait = async () => { await new Promise(x => setTimeout(x, 1500)); try { await api("GET", "/api/health"); if (Date.now() - t0 > 4000) return location.reload(); } catch {} if (Date.now() - t0 < 90000) wait(); }; wait(); };
  if ($("#s-quit")) $("#s-quit").onclick = () => { if (confirm("Quit Tempolight? The lights stop until you open the app again.")) act(() => api("POST", "/api/quit"), "Tempolight is quitting. Open the app again to start it.").catch(() => {}); };
  $("#s-reset").onclick = async () => { if (confirm("Reset all devices, the room, scenes, schedules and settings?")) { await act(() => api("POST", "/api/reset"), "Reset").catch(() => {}); await refreshState(); await loadLayout(); route(); } };
  let HK = null; if ($("#s-hk")) import("/homekit.js").then(m => { HK = m.mount($("#s-hk")); }).catch(() => {}); // Apple Home (server only)
  const perfLabel = p => p ? `Now: ${p.mode === "lite" ? "low power" : "full"}${p.why && p.why !== "auto" ? ` (${p.why.replace(/^auto: /, "")})` : ""}${p.fps ? ` · ${p.fps} fps, ${p.frameMs} ms a frame` : ""}${p.cpu != null ? ` · CPU ${p.cpu}%` : ""}` : "";
  return { onChanged(w) { if (w.has("lock")) route(); else if (w.has("homekit") || w.has("scenes")) HK?.load(); }, onStatus(m) { const e = $("#m-state"); if (e) e.textContent = mqttLabel(m.mqtt); const pf = $("#s-perf-st"); if (pf && m.perf) pf.textContent = perfLabel(m.perf); } };
}

// ---------------------------------------------------------------- router and boot
// a page in a module of its own: loaded the first time it's shown (then from the browser's cache), then made as usual
function lazyPage(load, name) {
  return el => { const wait = {}; el.innerHTML = `<div class="callout span-12 faint">Loading…</div>`;
    load().then(m => { if (app.page !== wait) return; el.innerHTML = ""; const pg = m[name](el) || {}; app.page = pg; if (app.status) pg.onStatus?.(app.status); })
      .catch(e => { if (app.page !== wait) return;
        if (/\/v2\//.test(String(load)) && navigator.onLine !== false) { el.innerHTML = `<div class="ui-card ui-empty"><h3>This screen is coming soon</h3><p>It is being rebuilt. Everything it will hold is still on the classic pages in More.</p><div class="ui-empty-a"><a class="btn primary" href="#/stage">Go to the stage</a><a class="btn" href="#/more">Open More</a></div></div>`; return; }
        el.innerHTML = `<div class="callout err span-12">Couldn't load this page (${esc(e.message)}). Check the connection and reload.</div>`; });
    return wait; };
}
const roomPage = lazyPage(() => import("/room.js"), "roomPage"), mapPage = lazyPage(() => import("/mapper.js"), "mapPage");
// v2 screens (design/dashboard-v2.md): Stage and More here, Songs, Looks and Lights in their own modules. A screen
// module that isn't there yet shows "coming soon" (lazyPage). The v1 pages below stay at their routes, reached from
// the new screens and from More; their tab is lit by shell.js navOf().
const PAGES = { stage: ["Stage", lazyPage(() => import("/v2/stage.js"), "render")], more: ["More", lazyPage(() => import("/v2/more.js"), "render")],
  songs: ["Songs", lazyPage(() => import("/v2/songs.js"), "render")],
  looks: ["Looks", lazyPage(() => import("/v2/looks.js"), "render")],
  lights: ["Lights", lazyPage(() => import("/v2/lights.js"), "render")],
  settings2: ["Settings", lazyPage(() => import("/v2/settings.js"), "render")], schedules: ["Schedules and scenes", lazyPage(() => import("/v2/scenes.js"), "render")],
  home: ["Home", homePage], music: ["Music", musicPage], effects: ["Effects", effectsPage], live: ["Live pads", livePage], scenes: ["Scenes & schedules", scenesPage], sleep: ["Home & sleep", lazyPage(() => import("/homesleep.js"), "homeSleepPage")],
  room: ["Room", el => unlocked() ? roomPage(el) : lockScreen(el, "Room setup")], map: ["Camera mapping", el => unlocked() ? mapPage(el) : lockScreen(el, "Room setup")], devices: ["Devices", devicesPage], settings: ["Settings", settingsPage], timeline: ["Show editor", lazyPage(() => import("/timeline.js"), "timelinePage")] };
PAGES.integrations = ["Integrations", lazyPage(() => import("/integrations.js"), "integrationsPage")]; // Stream Deck, OBS, games, Twitch, Discord
export function route() {
  const name0 = (location.hash.match(/^#\/(\w+)/) || [])[1] || "stage", name = PAGES[name0] ? name0 : "stage", [title, fn] = PAGES[name];
  if (app.page?.canLeave && app.page.hash !== location.hash && !app.page.canLeave()) { history.replaceState(null, "", app.page.hash); return; } // unsaved changes: stay
  if (app.page?.destroy) app.page.destroy();
  if (app.page?.preview) ws.send({ type: "preview", on: false });
  shellRoute(name); $("#title").textContent = title; document.title = `${title} · Tempolight`;
  const el = $("#page"); el.innerHTML = ""; el.toggleAttribute("data-v2", isV2(name)); app.page = fn(el) || {};
  if (app.status) app.page.onStatus?.(app.status);
  scrollTo({ top: 0 });
  const sub = (location.hash.match(/^#\/\w+\/(\w+)/) || [])[1], sel = ANCHORS[name]?.[sub]; if (sel) spotlight(sel);
}
// deep links from Home's "What's new" card: #/settings/punch scrolls to that setting and makes it glow once
const ANCHORS = { music: { sync: "#m-sync", library: "#lib, #lib-demo" }, effects: { variety: "#e-var" },
  settings: { lighting: "#s-punch", punch: "#s-punch", drama: "#s-dyn", chords: "#s-chordc", stereo: "#s-stereo", countdown: "#s-dropcd", about: "#s-upd" } };
function spotlight(sel, tries = 30) {
  const el = $(sel); if (!el) { if (tries > 0) setTimeout(() => spotlight(sel, tries - 1), 100); return; }
  const box = el.closest(".setrow, .field, .panel") || el;
  box.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  box.classList.remove("spot"); void box.offsetWidth; box.classList.add("spot"); setTimeout(() => box.classList.remove("spot"), 2000);
}

async function boot() {
  // dark unless light was chosen: Tempolight is mostly used in a dark room
  const setTheme = t => { document.documentElement.dataset.theme = t; const m = $("#theme-color"); if (m) m.content = t === "light" ? "#f8f4ee" : "#0f0d0b"; };
  setTheme(store.get("theme") === "light" ? "light" : "dark");
  $("#theme").onclick = () => { const nx = document.documentElement.dataset.theme === "light" ? "dark" : "light"; setTheme(nx); store.set("theme", nx); };
  $("#nav").innerHTML = $("#tabs").innerHTML = navHtml();
  $("#power").onclick = () => act(() => api("POST", "/api/power", { on: $("#power").getAttribute("aria-checked") !== "true" })).catch(() => {});
  $("#bri").oninput = e => $("#bri-out").textContent = e.target.value + "%";
  $("#bri").onchange = e => act(() => api("POST", "/api/brightness", { value: e.target.value / 100 })).catch(() => {});
  if (DEMO) { demo = await import("/demo.js"); await demo.ready; $("#demo-bar").hidden = false; document.body.classList.add("demo"); }
  else import("/nowplaying.js").then(m => { NP = m; }).catch(() => {});
  if ("serviceWorker" in navigator && isSecureContext) { navigator.serviceWorker.register("/sw.js").catch(() => {});
    setTimeout(() => navigator.serviceWorker.ready.then(r => r.active?.postMessage("precache")).catch(() => {}), 5000); } // the other pages, for offline use, once this one has loaded
  try { await refreshState(); } catch (e) { if (e.status === 403) { app.token = null; store.set("token", null); await refreshState(); } else throw e; }
  if (app.token && app.state.locked) { try { await api("PATCH", "/api/settings", {}); } catch { app.token = null; store.set("token", null); chrome(); } }
  await loadLayout();
  app.audio = createAudio({ ws, api, onChange: () => app.page?.onAudio?.() });
  try { app.log = await api("GET", "/api/log"); } catch {}
  connect(); route(); addEventListener("hashchange", route);
  if (wantsWizard(app.state)) openWizard(); // first start: the setup wizard (finished or skipped once, it stays away)
  // the brand lamp pulses with the beat
  setInterval(() => { const m = app.status; if (!m) return; $("#lamp").style.opacity = m.beat == null ? 1 : (m.beat === 0 ? 1 : 0.55); }, 120);
}
boot().catch(e => { $("#page").innerHTML = `<div class="callout err span-12">Couldn't start: ${esc(e.message)}</div>`; });
