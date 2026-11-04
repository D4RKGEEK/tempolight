// "How should Tempolight hear your music?": the guided panel at the top of the Music page and a step of the setup
// wizard. Three ways: this computer's sound (BlackHole on a Mac, the output's monitor on Linux, Stereo Mix on
// Windows; recorded by the server, so no browser tab or microphone is needed), a browser's microphone (remembered
// here and on the server, and started by itself when Spotify plays a song Tempolight hasn't learned), or a Raspberry
// Pi / Linux box with a sound input (automatic). The server side is packages/server/src/hearing.js.
import { app, api, act, $, $$, esc, unlocked, refreshState, toast, DEMO } from "/app.js";
import { hearLine } from "/hearline.js";

export const GUIDE = "https://github.com/D4RKGEEK/tempolight/blob/main/docs/hearing-music.md";
const KEY = "tl.hear"; // "mic" when this browser should listen with its microphone
export function savedMethod() { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } }
function remember(m) { try { if (m) localStorage.setItem(KEY, m); else localStorage.removeItem(KEY); } catch {} }
const savedInput = () => { try { return localStorage.getItem("tl.input") || ""; } catch { return ""; } };

const MARK = { ok: "✓", no: "✗", maybe: "?", todo: "○" };
const code = s => `<code class="mono">${esc(s)}</code>`;
export const MIDI_STEPS = [
  "Open <b>Audio MIDI Setup</b> (press ⌘ Space and type Audio MIDI Setup).",
  "Click <b>+</b> at the bottom left and choose <b>Create Multi-Output Device</b>.",
  "Tick your speakers (or your <b>Bluetooth speaker</b>) and <b>BlackHole 2ch</b>.",
  "Set <b>Primary Device</b> (older macOS: Master Device) to your speaker.",
  "Tick <b>Drift Correction</b> for BlackHole 2ch, not for the speaker.",
  "Right-click the Multi-Output Device and choose <b>Use This Device For Sound Output</b> (or pick it in System Settings → Sound → Output).",
  "The volume keys don't change a Multi-Output Device: set the volume on the speaker itself (or per device in Audio MIDI Setup), and keep Spotify's volume up.",
];
const midiHelp = open => `<details class="hear-midi"${open ? " open" : ""}><summary>Make the Multi-Output Device (once, 2 minutes)</summary><ol>${MIDI_STEPS.map(s => `<li>${s}</li>`).join("")}</ol>
  <p class="faint">After a Bluetooth speaker reconnects, macOS may switch the output back to the speaker alone: pick the Multi-Output Device again.</p></details>`;

/**
 * @param {HTMLElement} el replaced by the panel
 * @param {{bare?:boolean, onFixTiming?:()=>void}} o bare: no panel frame (the wizard); onFixTiming: the Bluetooth prompt's button
 */
export function mountHearing(el, { bare = false, onFixTiming = null } = {}) {
  if (!el) return null;
  const inner = `<div class="hearline big" id="hr-line" aria-live="polite"></div>
    <div class="callout warn" id="hr-bt" hidden><b>Bluetooth speakers play late — fix the timing.</b> <span id="hr-btname"></span> <button class="btn sm primary" id="hr-btfix" type="button">Fix the timing</button></div>
    <div class="hear-choices" role="radiogroup" aria-label="How Tempolight hears your music">
      <button class="hear-choice" type="button" role="radio" data-hc="computer"><b>This computer's sound</b><small id="hr-csub">Records what this computer plays. After set-up, just play Spotify: no browser tab, no microphone.</small><span class="badge acc" data-rec="computer" hidden>Recommended</span></button>
      <button class="hear-choice" type="button" role="radio" data-hc="mic"><b>Microphone</b><small>Listens in this browser tab, which must stay open. Starts by itself when Spotify plays a song Tempolight hasn't learned.</small><span class="badge acc" data-rec="mic" hidden>Recommended</span></button>
      <button class="hear-choice" type="button" role="radio" data-hc="pi"><b>Raspberry Pi / Linux: automatic</b><small>A Pi or Linux box next to the speakers, with a USB sound card or microphone. Starts at every boot.</small><span class="badge acc" data-rec="pi" hidden>Recommended</span></button>
    </div>
    <div id="hr-detail" class="stack"></div>
    <p class="faint" style="font-size:12.5px">Step-by-step for Mac, Windows, Linux and Raspberry Pi: <a href="${GUIDE}" target="_blank" rel="noopener">How Tempolight hears your music</a>.</p>`;
  const t = document.createElement("template");
  t.innerHTML = bare ? `<div class="hear stack" id="hear">${inner}</div>` : `<section class="panel span-12 hear" id="hear"><header><h2>How should Tempolight hear your music?</h2><span class="sub" id="hr-sub"></span></header><div class="pb stack">${inner}</div></section>`;
  const root = t.content.firstElementChild; if (bare) { el.innerHTML = ""; el.appendChild(root); } else el.replaceWith(root);
  const q = s => root.querySelector(s), admin = unlocked();
  let view = null, sel = null, alive = true, timer = null, lastM = null;

  const method = () => savedMethod() === "mic" ? "mic" : view?.method || app.state?.settings.hearing?.method || "";
  async function load(force) {
    if (DEMO) { view = null; paint(); return; }
    try { view = await api(force ? "POST" : "GET", force ? "/api/hearing/check" : "/api/hearing"); } catch { view = null; }
    if (alive) paint();
  }
  function choose(c) { sel = c; paint(); }
  root.querySelectorAll("[data-hc]").forEach(b => b.onclick = () => choose(b.dataset.hc));

  async function use(choice) {
    if (choice === "mic") remember("mic"); else remember(null);
    if (DEMO) { await act(() => api("PATCH", "/api/settings", { hearing: { method: choice } })).catch(() => {}); await refreshState(); paint(); return true; }
    const r = await act(() => api("POST", "/api/hearing/use", { choice }), choice === "mic" ? "The microphone it is" : "Listening on this computer").catch(() => null);
    if (r) { view = r; await refreshState(); } paint(); return !!r;
  }
  function stepsHtml(steps) {
    return `<ol class="hear-steps" id="hr-steps">${steps.map(s => `<li class="${s.state}" data-step="${esc(s.id)}"><span class="mk" aria-hidden="true">${MARK[s.state] || "○"}</span><div><b>${esc(s.label)}</b>${s.detail ? `<small>${esc(s.detail)}</small>` : ""}${help(s)}${s.id === "hears" ? `<div class="meter" style="margin-top:6px"><i id="hr-lvl" style="width:${Math.round((s.level || 0) * 100)}%"></i></div>` : ""}</div><span class="sr">${esc(s.state)}</span></li>`).join("")}</ol>`;
  }
  function help(s) {
    if (s.state === "ok") return "";
    if (s.id === "blackhole") return `<small>Install it: ${code("brew install blackhole-2ch")} in Terminal, or download it from <a href="https://existential.audio/blackhole" target="_blank" rel="noopener">existential.audio/blackhole</a>. Then press Check again.</small>`;
    if (s.id === "ffmpeg") return `<small>Install it: ${code(view?.platform === "win32" ? "winget install ffmpeg" : "brew install ffmpeg")}, then restart Tempolight.</small>`;
    if (s.id === "output" && view?.platform === "darwin") return midiHelp(s.state === "no");
    if (s.id === "loopback") return `<small>Sound settings → More sound settings → Recording → right-click → Show disabled devices → enable Stereo Mix. No Stereo Mix? Install VB-CABLE, or use the microphone.</small>`;
    if (s.id === "pulse") return `<small>Install ${code("sudo apt install pulseaudio-utils")} (PipeWire includes pipewire-pulse).</small>`;
    return "";
  }
  function detail() {
    const box = q("#hr-detail"); if (!box) return;
    const c = sel; let h = "";
    if (c === "computer") {
      if (DEMO || !view) h = `<p class="muted">${DEMO ? "The online demo runs in your browser, so it can't record this computer's sound. Install Tempolight on the computer that plays Spotify (on a Mac it uses BlackHole), or share this tab's sound:" : "Couldn't ask the server."}</p>${DEMO && navigator.mediaDevices?.getDisplayMedia ? `<button class="btn" id="hr-share" type="button">Share a tab's sound</button>` : ""}`;
      else { const v = view.computer, on = v.on;
        h = `${stepsHtml(v.steps)}
          <div class="row">${on ? `<span class="badge live"><i></i>Listening to ${esc(v.device || "this computer")} on the server</span><button class="btn sm" id="hr-off" type="button">Stop</button>` : `<button class="btn primary" id="hr-use" type="button" ${v.source && admin ? "" : "disabled"}>${view.platform === "linux" ? "Listen to this computer" : "Turn on listening"}</button>`}
            <button class="btn" id="hr-check" type="button">Check again</button></div>
          ${v.why && !on ? `<p class="callout warn">${esc(v.why)}</p>` : ""}
          ${on ? `<p class="faint" style="font-size:12.5px">Remembered: it starts by itself when Tempolight starts. Now just play Spotify.</p>` : `<p class="faint" style="font-size:12.5px">${view.platform === "darwin" ? "macOS asks once whether Terminal (or Tempolight) may use the microphone: allow it, that's how Tempolight reads BlackHole. " : ""}Once it's on, just play your music: no browser tab and no microphone needed.</p>`}
          ${view.platform === "win32" && !v.source ? `<button class="btn" id="hr-tomic" type="button">Use the microphone instead</button>` : ""}`; }
    } else if (c === "mic") {
      const on = method() === "mic", mode = app.audio?.state.mode;
      h = `<p class="muted">Tempolight listens with this browser's microphone, so <b>keep this tab open</b> (it can be in the background). Put the computer or phone near the speakers.</p>
        <div class="field"><label for="hr-input">Microphone</label><select id="hr-input"><option value="">Default</option></select></div>
        <div class="row">${on ? `<span class="badge live"><i></i>Chosen: starts by itself when Spotify plays a song it doesn't know</span>` : ""}<button class="btn ${on ? "" : "primary"}" id="hr-mic" type="button">${mode === "mic" ? "Listening…" : on ? "Start now" : "Use the microphone"}</button>${on ? `<button class="btn sm" id="hr-micoff" type="button">Don't use it</button>` : ""}</div>
        <div class="meter"><i id="hr-miclvl"></i></div>`;
    } else if (c === "pi") {
      if (DEMO || !view) h = `<p class="muted">Install Tempolight on a Raspberry Pi (see the guide) with a USB sound card or microphone: it listens by itself at every boot.</p>`;
      else if (!view.pi.available) h = `<p class="muted">${view.platform === "linux" ? "No sound input found: plug in a USB sound card (line-in) or microphone, then Check again." : "This is for a Raspberry Pi or another Linux computer. Here, use This computer's sound or the Microphone."}</p><button class="btn" id="hr-check" type="button">Check again</button>`;
      else h = `<p class="muted">Uses <b>${esc(view.pi.label)}</b> and starts by itself at every boot. With a desktop (PulseAudio / PipeWire), This computer's sound records what the Pi plays instead.</p>
        <div class="row">${view.pi.on ? `<span class="badge live"><i></i>On</span><button class="btn sm" id="hr-off" type="button">Stop</button>` : `<button class="btn primary" id="hr-pi" type="button" ${admin ? "" : "disabled"}>Use it</button>`}</div>`;
    }
    box.innerHTML = h;
    const on = (id, f) => { const b = box.querySelector("#" + id); if (b) b.onclick = f; };
    on("hr-use", () => use("computer")); on("hr-pi", () => use("pi")); on("hr-check", () => load(true)); on("hr-tomic", () => choose("mic"));
    on("hr-off", () => use(""));
    on("hr-share", () => app.audio?.listen("system"));
    on("hr-mic", async () => { if (method() !== "mic") await use("mic"); await app.audio?.listen("mic", q("#hr-input")?.value || savedInput()); paint(); });
    on("hr-micoff", async () => { remember(null); if (app.audio?.state.mode === "mic") app.audio.stopLive(); if (!DEMO) await act(() => api("POST", "/api/hearing/use", { choice: "" })).catch(() => {}); else await api("PATCH", "/api/settings", { hearing: { method: "" } }).catch(() => {}); await refreshState(); load(); });
    const inp = q("#hr-input");
    if (inp) { app.audio?.listInputs().then(list => { inp.innerHTML = '<option value="">Default</option>' + list.map((d, i) => `<option value="${esc(d.deviceId)}"${d.deviceId === savedInput() ? " selected" : ""}>${esc(d.label || `Input ${i + 1}`)}</option>`).join(""); });
      inp.onchange = e => { try { localStorage.setItem("tl.input", e.target.value); } catch {} }; }
  }
  let painted = "";
  function paint() {
    if (!alive || !root.isConnected) return;
    const rec = view?.recommended || (DEMO ? "mic" : "computer");
    if (!sel) sel = method() || rec;
    root.querySelectorAll("[data-hc]").forEach(b => { b.setAttribute("aria-checked", String(b.dataset.hc === sel)); b.classList.toggle("chosen", b.dataset.hc === method()); });
    root.querySelectorAll("[data-rec]").forEach(b => { b.hidden = b.dataset.rec !== rec; });
    const sub = q("#hr-csub"); if (sub && view) sub.textContent = view.platform === "darwin" ? "On a Mac: BlackHole sends what the Mac plays to Tempolight. After set-up, just play Spotify: no browser tab, no microphone." : view.platform === "win32" ? "On Windows: Stereo Mix or another loopback input. No browser tab, no microphone." : "On Linux: the monitor of the output, one click. No browser tab, no microphone.";
    const v = view && { st: view.computer.steps.map(x => [x.id, x.state, x.label, x.detail]), on: view.computer.on, why: view.computer.why, src: view.computer.source, pi: view.pi, p: view.platform };
    const key = JSON.stringify([sel, v, method(), app.audio?.state.mode, admin]);
    if (key !== painted) { painted = key; const open = q(".hear-midi")?.open; detail(); const d = q(".hear-midi"); if (d && open !== undefined) d.open = open; } // only when something changed, keeping an open help
    if (lastM) status(lastM);
  }
  function status(m) {
    lastM = m; if (!q("#hr-line")) return;
    const l = hearLine(m), line = q("#hr-line");
    line.className = `hearline big ${l.ok === true ? "ok" : l.ok === false ? "bad" : ""}`;
    line.innerHTML = `<span>${esc(l.text)}</span>${l.why && l.ok === false ? `<small>${esc(l.why)}</small>` : ""}`;
    const sub = q("#hr-sub"); if (sub) sub.textContent = l.ok === true ? "Working" : "";
    const o = m.hearing?.output, bt = q("#hr-bt");
    if (bt) { bt.hidden = !(o && o.bluetooth && !o.own); if (!bt.hidden) q("#hr-btname").textContent = `${o.name}${o.guess ? " (looks like a Bluetooth speaker)" : ""}: Tempolight measures the delay with the microphone and keeps the timing for this speaker.`; }
    const lv = q("#hr-lvl"); if (lv) lv.style.width = Math.round((m.hearing?.capture?.level || 0) * 100) + "%";
    const ml = q("#hr-miclvl"); if (ml) ml.style.width = Math.round((app.audio?.level() || 0) * 100) + "%";
  }
  q("#hr-btfix").onclick = () => { if (onFixTiming) return onFixTiming(); const b = $("#m-cal"); if (b) { b.scrollIntoView({ block: "center", behavior: "smooth" }); b.click(); } };
  load(); timer = setInterval(() => { if (document.visibilityState !== "hidden") load(); }, 2500);
  if (app.status) status(app.status);
  return { status, load, choose, destroy() { alive = false; clearInterval(timer); } };
}
