// Stage (design/dashboard-v2.md): "What are my lights doing right now, and how do I change it?"
// The live room is the hero; the now-playing bar sits on its bottom edge (song, source, sync, beat, song map, next
// drop); below it three cards: Look, Feel, Pads. A drop countdown shows over the stage. Nothing playing: the bar
// becomes three ways to start music.
import { app, api, act, toast, esc, $, $$, ws, createPreview, refreshState, route, guestOk, unlocked, DEMO } from "/app.js";
import { mountSongMap, syncView } from "/songmap.js";
import { trackOf } from "/hearline.js";
import { ensureCss, icon, segmented, bindSegmented, bigSlider, bindBigSlider, toggle, bindToggle, emptyState } from "/v2/shell.js";

const PADS = [
  { id: "flash", name: "Flash", desc: "White hit", key: "Space" },
  { id: "strobe", name: "Strobe", desc: "While held", key: "S", hold: true },
  { id: "blackout", name: "Blackout", desc: "On or off", key: "B", toggle: true },
  { id: "build", name: "Build", desc: "Then a drop", key: "U" },
  { id: "drop", name: "Drop", desc: "Full energy", key: "D" },
  { id: "freeze", name: "Freeze", desc: "Hold the frame", key: "F", toggle: true },
];
const KEYS = { " ": "flash", s: "strobe", b: "blackout", u: "build", d: "drop", f: "freeze" };
const VARIETY = [{ value: "one", label: "One look" }, { value: "parts", label: "Song parts" }, { value: "show", label: "Show" }];
const PART = { calm: "Calm", build: "Build-up", drop: "Drop", silent: "Quiet" };
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : "";
const pctf = v => `${Math.round(v * 100)}%`;

export function render(el) {
  ensureCss("/v2/stage.css");
  const st = app.state, s = st.settings, A = app.audio, noLights = !st.devices.length;
  const canShare = !!navigator.mediaDevices?.getDisplayMedia, padsOk = guestOk("pads"), lookOk = guestOk("effects"), setOk = unlocked();
  el.innerHTML = `<div class="ui-screen st">
    <section class="ui-stage st-stage" id="st-stage" aria-label="Your room, live">
      <div class="st-room" id="st-room"></div>
      ${noLights ? `<div class="st-nolights">${emptyState({ title: "No lights yet", text: "Add your WLED or other lights, or try everything with a virtual room first.",
        action: `<button class="btn primary" id="st-virtual" type="button">Try a virtual room</button><a class="btn" href="#/lights">Add your lights</a>` })}</div>` : ""}
      <div class="st-drop" id="st-drop" role="timer" aria-live="off" hidden><span id="st-drop-l">Drop in</span><b id="st-drop-n">4</b></div>
      <div class="ui-np st-np" id="st-np">
        <div class="st-np-row">
          <div class="st-song"><b id="st-song">Nothing playing</b><span id="st-src"></span></div>
          <div class="st-transport" id="st-transport" hidden>
            <button class="st-tbtn" id="st-play" type="button" aria-label="Pause">${icon("pause")}</button>
            <button class="st-tbtn sm" id="st-next" type="button" aria-label="Next song">${icon("chevron")}</button></div>
          <div class="sm-meter st-sync" id="sm-meter" data-state="none">
            <div class="sm-state"><i class="sm-dot" aria-hidden="true"></i><b id="sm-label">Not hearing</b></div>
            <span class="st-bpm"><b id="sm-bpm">–</b> BPM</span>
            <div class="sm-beat" id="sm-beat" aria-hidden="true"><i>1</i><i></i><i></i><i></i></div>
            <div class="st-hide"><div class="sm-score" id="sm-score"><i id="sm-fill"></i></div><span id="sm-num"></span><p id="sm-hint"></p></div>
          </div>
        </div>
        <div class="st-map">
          <div class="sm-map st-strip" id="sm-map"><canvas id="sm-cv" role="img" aria-label="The song's map: its parts, drops and where it is now"></canvas><p class="sm-empty" id="sm-empty"></p></div>
          <div class="sm-foot st-foot"><span id="sm-pos"></span><span id="sm-part"></span><span id="sm-next"></span></div>
        </div>
        <div class="st-start" id="st-start" hidden>
          <div class="st-start-t"><span id="st-start-s">The lights follow whatever plays: a song here, or the sound of this computer.</span></div>
          <div class="st-start-a">
            <button class="btn primary" id="st-demo" type="button">${icon("play")}Play the demo track</button>
            ${canShare ? `<button class="btn" id="st-listen" type="button">${icon("computer")}Listen to this computer</button>` : `<button class="btn" id="st-mic" type="button">${icon("mic")}Listen with the microphone</button>`}
            <a class="btn" href="#/songs">${icon("music")}Choose music</a>
          </div>
        </div>
      </div>
    </section>

    <div class="ui-grid-3 st-cards">
      <section class="ui-card st-look" aria-labelledby="st-look-h">
        <div class="ui-card-h"><h2 id="st-look-h">Look</h2><span class="ui-pill" id="st-look-tag" hidden></span></div>
        <div class="st-look-main"><b id="st-look-name">–</b><span id="st-look-sub"></span></div>
        <div class="ui-swatches" id="st-sw" aria-label="The colours in the room now">${"<i hidden></i>".repeat(5)}</div>
        <p class="st-why" id="st-why"></p>
        <div class="st-design" id="st-design" hidden><p><b>Designed by Claude:</b> <span id="st-design-why"></span></p>
          <div class="st-look-a"><button class="btn sm" id="st-redesign" type="button">Redesign</button><button class="btn sm" id="st-design-off" type="button">Use the automatic look</button></div></div>
        <div class="st-look-a" id="st-look-a">
          <button class="btn" id="st-next-look" type="button">Try another look</button>
          <button class="btn" id="st-keep" type="button" aria-pressed="false">Keep this look</button>
          <button class="btn" id="st-auto" type="button" hidden>Back to automatic</button>
        </div>
        <div class="st-var"><span class="ui-eyebrow">Variety</span>${segmented("variety", VARIETY, st.show.variety || "one", { label: "Variety" })}</div>
      </section>

      <section class="ui-card st-feel" aria-labelledby="st-feel-h">
        <div class="ui-card-h"><h2 id="st-feel-h">Feel</h2><a class="ui-meta st-link" href="#/settings/lighting">More options</a></div>
        ${bigSlider("st-punch", "Punch", s.punch ?? 0.7, { min: 0, max: 1, step: 0.05, format: pctf })}
        ${bigSlider("st-drama", "Drama", s.dynamics ?? 0.8, { min: 0, max: 1, step: 0.05, format: pctf })}
        <div class="st-toggles">
          ${toggle("st-chords", "Chord colours", s.chordColours !== false, { hint: "Colours step with the chords" })}
          ${toggle("st-stereo", "Stereo", (s.stereo || "subtle") !== "off", { hint: "Hits light up their side of the room" })}
          ${toggle("st-cd", "Drop countdown", s.dropCountdown !== false, { hint: "A big 4, 3, 2, 1 over the stage" })}
        </div>
      </section>

      <section class="ui-card st-padcard" aria-labelledby="st-pads-h">
        <div class="ui-card-h"><h2 id="st-pads-h">Pads</h2><a class="ui-meta st-link" href="#/live">All pads and MIDI</a></div>
        <div class="ui-pads" id="st-pads">${PADS.map(p => `<button class="ui-pad" type="button" data-pad="${p.id}"${p.toggle ? ' aria-pressed="false"' : ""}><kbd>${p.key}</kbd><b>${p.name}</b><span>${p.desc}</span></button>`).join("")}</div>
      </section>
    </div>
  </div>`;

  // ---------------------------------------------------------------- the room, live
  const prev = noLights ? null : createPreview($("#st-room"));
  if (noLights) $("#st-virtual").onclick = () => act(() => api("POST", "/api/devices", { virtual: true, name: "Virtual room" }), "Virtual room added").catch(() => {});

  // ---------------------------------------------------------------- now playing
  const SM = mountSongMap($("#st-np"), { api });
  $("#st-demo").onclick = () => { A.addUrl("/demo.mp3", "Tempolight demo track"); $("#st-start-s").textContent = "Getting the demo track ready…"; };
  if ($("#st-listen")) $("#st-listen").onclick = () => A.listen("system").catch(() => {});
  if ($("#st-mic")) $("#st-mic").onclick = () => A.listen("mic").catch(() => {});
  $("#st-play").onclick = () => A.toggle(); $("#st-next").onclick = () => A.next();

  // ---------------------------------------------------------------- look
  const show = b => act(() => api("PATCH", "/api/show", b)).catch(() => {});
  $("#st-next-look").onclick = () => act(() => api("POST", "/api/song/look/next", {})).then(r => toast(`Look: ${r.mainName || r.label}`)).catch(() => {});
  $("#st-keep").onclick = () => { const kept = $("#st-keep").getAttribute("aria-pressed") === "true";
    act(() => api("POST", "/api/song/look/keep", { keep: !kept }), kept ? "The look can change again" : "Look kept for this song").catch(() => {}); };
  $("#st-auto").onclick = () => show({ mode: "auto" });
  // the Claude show designer (server/src/designer.js): status.design is the song playing now
  let designSong = null;
  $("#st-redesign").onclick = () => { if (!designSong) return; $("#st-redesign").disabled = true; act(() => api("POST", `/api/songs/${encodeURIComponent(designSong)}/design`), "Designed by Claude").catch(() => {}).finally(() => { $("#st-redesign").disabled = false; }); };
  $("#st-design-off").onclick = () => designSong && act(() => api("DELETE", `/api/songs/${encodeURIComponent(designSong)}/design`), "The automatic look plays").catch(() => {});
  const VAR = bindSegmented(el, "variety", v => show({ variety: v }));
  if (!lookOk) $$("#st-look-a button, [data-seg=variety] button").forEach(b => b.disabled = true);

  // ---------------------------------------------------------------- feel
  const setS = b => act(() => api("PATCH", "/api/settings", b)).then(refreshState).catch(() => {});
  const PUNCH = bindBigSlider(el, "st-punch", { onChange: v => setS({ punch: v }) });
  const DRAMA = bindBigSlider(el, "st-drama", { onChange: v => setS({ dynamics: v }) });
  const CHORDS = bindToggle(el, "st-chords", v => setS({ chordColours: v }));
  const CDT = bindToggle(el, "st-cd", v => setS({ dropCountdown: v }));
  const STEREO = bindToggle(el, "st-stereo", v => setS({ stereo: v ? (app.state.settings.stereoWas || "subtle") : "off" }));
  if (!setOk) $$(".st-feel input, .st-feel .switch").forEach(b => b.disabled = true);

  // ---------------------------------------------------------------- pads (as v1 Live pads: hold where it held)
  const send = a => { if (ws.open) ws.send({ type: "action", action: a }); else api("POST", "/api/action", a).catch(e => toast(e.message, true)); };
  const press = (id, down) => { const p = PADS.find(x => x.id === id); if (!p) return; $(`[data-pad="${id}"]`)?.classList.toggle("down", down);
    if (p.hold) { if (id === "strobe") send({ type: "strobe", on: down }); return; }
    if (down) send(id === "flash" ? { type: "flash", color: "#ffffff" } : { type: id }); };
  $$("#st-pads .ui-pad").forEach(b => {
    b.disabled = !padsOk;
    b.onpointerdown = e => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); press(b.dataset.pad, true); };
    b.onpointerup = b.onpointercancel = () => press(b.dataset.pad, false);
    b.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); if (!e.repeat) press(b.dataset.pad, true); } };
    b.onkeyup = e => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); press(b.dataset.pad, false); } };
  });
  const busy = e => e.target.closest("input,select,textarea,button,a,[contenteditable]") || e.metaKey || e.ctrlKey || e.altKey || document.documentElement.classList.contains("ui-sheet-open");
  const kd = e => { if (!padsOk || busy(e)) return; const id = KEYS[e.key.toLowerCase()]; if (!id) return; e.preventDefault(); if (!e.repeat) press(id, true); };
  const ku = e => { if (!padsOk) return; const id = KEYS[e.key.toLowerCase()]; if (id) press(id, false); };
  addEventListener("keydown", kd); addEventListener("keyup", ku);

  // ---------------------------------------------------------------- the drop countdown, over the stage (as v1 Live pads)
  const cd = { at: null, timer: null };
  const cdShow = () => { const box = $("#st-drop"); if (!box) return; const left = cd.at == null ? null : (cd.at - performance.now()) / 1000;
    if (left == null || left > 8 || left < -0.6) { box.hidden = true; return; }
    const n = Math.max(0, Math.ceil(left)); box.hidden = false; box.classList.toggle("now", n === 0);
    $("#st-drop-l").textContent = n === 0 ? "" : "Drop in"; const nb = $("#st-drop-n"), t = n === 0 ? "Drop" : String(n);
    if (nb.textContent !== t) { nb.textContent = t; nb.classList.remove("tick"); void nb.offsetWidth; nb.classList.add("tick"); } };
  const cdStatus = m => { const d = m.drop, on = app.state?.settings?.dropCountdown !== false, now = performance.now();
    cd.at = on && d && d.next != null && d.conf >= 0.5 && d.next <= 8 ? now + d.next * 1000 : (cd.at != null && now - cd.at < 600 && now >= cd.at ? cd.at : null);
    if (cd.at != null && !cd.timer) cd.timer = setInterval(() => { cdShow(); if (cd.at == null || performance.now() - cd.at > 600) { clearInterval(cd.timer); cd.timer = null; cdShow(); } }, 100);
    cdShow(); };

  // ---------------------------------------------------------------- the colours in the room now (from the live frame)
  let swAt = 0;
  function swatches() {
    const f = app.frame, now = performance.now(); if (!f || now - swAt < 500) return; swAt = now;
    const bins = new Array(12).fill(null).map(() => ({ w: 0, r: 0, g: 0, b: 0 })), n = f.length / 3, step = Math.max(1, Math.floor(n / 400));
    for (let i = 0; i < n; i += step) { const r = f[i * 3], g = f[i * 3 + 1], b = f[i * 3 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx < 40) continue;
      const sat = (mx - mn) / mx; let h = 0; if (mx !== mn) { h = mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn); h = (h * 60 + 360) % 360; }
      const k = sat < 0.18 ? 0 : 1 + Math.floor(h / 360 * 11) % 11, w = mx / 255 * (0.3 + sat), B = bins[k]; B.w += w; B.r += r * w; B.g += g * w; B.b += b * w; }
    if (!bins.some(B => B.w > 0)) return; // a dark moment (the dip before a drop): keep the last colours
    const top = bins.filter(B => B.w > 0).sort((a, b) => b.w - a.w).slice(0, 5);
    const cols = top.map(B => { const r = B.r / B.w, g = B.g / B.w, b = B.b / B.w, k = 255 / Math.max(r, g, b, 1); return `rgb(${Math.round(r * k)} ${Math.round(g * k)} ${Math.round(b * k)})`; });
    $$("#st-sw i").forEach((x, i) => { x.style.setProperty("--c", cols[i] || "transparent"); x.hidden = !cols[i]; });
  }

  // ---------------------------------------------------------------- live status, 4 times a second
  function paint(m) {
    const a = A.state, idle = m.source === "idle" && !a.mode && !a.analysing, tr = trackOf(m);
    // the song
    const name = m.song?.name || m.recognised?.name || (tr && tr.title) || (m.source === "idle" ? "Nothing playing" : m.sourceLabel);
    $("#st-song").textContent = name;
    const bits = [m.source === "song" ? "Played here" : m.sourceLabel, m.song?.bpm ? `${Math.round(m.song.bpm)} BPM` : m.bpm ? `${Math.round(m.bpm)} BPM` : "", PART[m.part] || ""].filter(Boolean);
    $("#st-src").textContent = m.source === "idle" ? `Ambient: ${m.effectName}` : bits.join(" · ");
    $("#st-np").classList.toggle("idle", idle);
    $("#st-start").hidden = !idle && !a.analysing;
    if (a.analysing) $("#st-start-s").textContent = `Getting ${a.queue[a.index]?.name || "the song"} ready… ${Math.round(a.analysing * 100)}%`;
    else if (idle) $("#st-start-s").textContent = "The lights follow whatever plays: a song here, or the sound of this computer.";
    $("#st-transport").hidden = !(a.mode === "song" && a.song);
    if (a.song) { const pl = a.song.playing, b = $("#st-play"); if (b.dataset.on !== String(pl)) { b.dataset.on = String(pl); b.innerHTML = icon(pl ? "pause" : "play"); b.setAttribute("aria-label", pl ? "Pause" : "Play"); } }
    // the look
    const lk = m.look, manual = app.state.show.mode === "manual", variety = app.state.show.variety || "one";
    const tag = $("#st-look-tag");
    if (lk && !manual) {
      $("#st-look-name").textContent = lk.mainName || m.effectName;
      $("#st-look-sub").textContent = lk.palette ? `${cap(lk.palette)} colours` : "Colours from the music";
      $("#st-why").textContent = lk.why?.length ? `Picked for its ${lk.why.slice(0, 3).join(", ")}` : lk.provisional ? "Picked from what it hears so far" : "";
      tag.hidden = !(lk.locked || lk.provisional); tag.textContent = lk.locked ? "Kept" : "For now"; tag.className = "ui-pill" + (lk.locked ? " accent" : "");
    } else {
      $("#st-look-name").textContent = m.effectName || "–"; tag.hidden = true;
      $("#st-look-sub").textContent = manual ? "Picked by hand" : m.source === "idle" ? "Ambient, while nothing plays" : variety === "show" ? "Changes with the song" : "Automatic";
      $("#st-why").textContent = manual ? "Automatic picks a look for each song." : m.source === "idle" ? "When music starts, a look is picked for the song." : "";
    }
    const k = $("#st-keep"); k.setAttribute("aria-pressed", String(!!lk?.locked)); k.innerHTML = lk?.locked ? `${icon("check")}Kept` : "Keep this look";
    $("#st-next-look").hidden = k.hidden = manual; $("#st-auto").hidden = !manual;
    $("#st-next-look").disabled = k.disabled = !lk || !lookOk;
    const dz = m.design, dbox = $("#st-design"), dOn = !!(dz && !manual && (dz.active || dz.busy));
    dbox.hidden = !dOn; designSong = dz?.song || null;
    if (dOn) { $("#st-design-why").textContent = dz.busy && !dz.has ? "designing this song…" : dz.why || ""; $("#st-redesign").hidden = $("#st-design-off").hidden = !setOk || !dz.has; if (dz.active) $("#st-why").textContent = ""; }
    VAR.set(variety);
    // pads
    const o = m.overlay || {};
    $('[data-pad="blackout"]').setAttribute("aria-pressed", String(!!o.blackout)); $('[data-pad="freeze"]').setAttribute("aria-pressed", String(!!o.freeze));
    $('[data-pad="build"]').classList.toggle("hot", o.forced === "build"); $('[data-pad="drop"]').classList.toggle("hot", o.forced === "drop");
    $("#st-stage").dataset.sync = syncView(m).state;
    swatches();
  }
  function settings() { const s2 = app.state.settings; PUNCH.set(s2.punch ?? 0.7); DRAMA.set(s2.dynamics ?? 0.8); CHORDS.set(s2.chordColours !== false); STEREO.set((s2.stereo || "subtle") !== "off"); CDT.set(s2.dropCountdown !== false);
    if (s2.stereo && s2.stereo !== "off") s2.stereoWas = s2.stereo; }
  if (s.stereo && s.stereo !== "off") s.stereoWas = s.stereo;

  return {
    preview: true,
    onStatus(m) { SM.status(m); paint(m); cdStatus(m); },
    onAudio() { if (app.status) paint(app.status); },
    onChanged(w) {
      if ((w.has("devices") || w.has("all")) && !app.state.devices.length !== noLights) return route();
      if (w.has("settings") || w.has("all")) settings();
      if (w.has("show") && app.status) paint(app.status);
    },
    destroy() { prev?.destroy(); SM.destroy(); clearInterval(cd.timer); removeEventListener("keydown", kd); removeEventListener("keyup", ku); },
  };
}
