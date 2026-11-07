// Settings (dashboard v2, #/settings2): everything the v1 Settings page (app.js settingsPage) offers, plus the few
// settings that lived on the v1 Music page (song memory, shows, beat prediction, mood colours, the metronome), grouped
// in nine sections. Desktop: the sections as a list on the left, one section on the right. Phone: the list, then the
// section pushed over it (with a back button). Each section is a few card groups of rows: label, one line of help, the
// control on the right. Rarely used rows sit under "More options".
// Deep links: #/settings2/<section> opens a section, #/settings2/<anchor> (punch, drama, chords, stereo, countdown,
// about, lock, backup...) opens the section that holds it, scrolls to the row and makes it glow once.
import { app, api, act, toast, esc, $, $$, ws, opt, refreshState, loadLayout, route, unlocked, DEMO } from "/app.js";
import { ensureCss, icon, routeSub, segmented, bindSegmented } from "/v2/shell.js";

const store = { set(k, v) { try { v == null ? localStorage.removeItem("tl." + k) : localStorage.setItem("tl." + k, v); } catch {} } };
const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true" class="ui-ic">${d}</svg>`;
const IC = {
  general: icon("gear"), lighting: icon("lights"), music: icon("music"),
  safety: svg('<path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><path d="M9 12l2 2 4-4"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  performance: svg('<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/><circle cx="12" cy="16" r="1.4"/>'),
  network: svg('<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0"/><circle cx="12" cy="19.5" r=".9"/>'),
  backup: svg('<path d="M4 7h16v13H4zM3 4h18v3H3z"/><path d="M12 10v6M9.5 13.5L12 16l2.5-2.5"/>'),
  about: icon("info"),
};
const SECTIONS = [
  ["general", "General", "When nothing plays, night mode and your location"],
  ["lighting", "Lighting", "How the room moves with the music"],
  ["music", "Music and memory", "What it remembers and how it follows the beat"],
  ["safety", "Safety", "Flashes, lasers and fog"],
  ["lock", "Lock and guests", "A PIN, and what guests can still do"],
  ["performance", "Performance", "Frame rate and low power mode"],
  ["network", "Network and updates", "Wi-Fi, Home Assistant, Apple Home and other connections"],
  ["backup", "Backup", "Move to a new computer, or start over"],
  ["about", "About", "Version, updates, help and the licence"],
];
// deep links: #/settings2/<anchor> → [section, element id]; the v1 anchors (#/settings/punch...) keep their names
const ANCHORS = { punch: ["lighting", "st-punch"], drama: ["lighting", "st-dyn"], chords: ["lighting", "st-chordc"], stereo: ["lighting", "st-stereo"],
  countdown: ["lighting", "st-dropcd"], about: ["about", "st-a-upd"], update: ["about", "st-a-upd"], night: ["general", "st-n-on"], location: ["general", "st-lat"],
  ambient: ["general", "st-amb"], safe: ["safety", "st-safe"], pin: ["lock", "st-lockbox"], guests: ["lock", "st-g-effects"], fps: ["performance", "st-fps"],
  memory: ["music", "st-mem"], wifi: ["network", "st-wifi"], mqtt: ["network", "st-m-on"], homekit: ["network", "st-hk"], claude: ["about", "st-claude"],
  restore: ["backup", "st-b-file"], text: ["general", "st-x-src"] };
const DOCS = "https://tempolight.pages.dev/docs/";
const pct = v => `${Math.round(v * 100)}%`;
const wide = () => matchMedia("(min-width: 761px)").matches;
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- row builders (HTML strings)
const row = (label, help, ctl, { id = "", cls = "", forId = "" } = {}) =>
  `<div class="st-row${cls ? " " + cls : ""}"${id ? ` id="${id}-row"` : ""}><div class="st-row-t">${forId ? `<label for="${forId}">${esc(label)}</label>` : `<b>${esc(label)}</b>`}${help ? `<small>${help}</small>` : ""}</div><div class="st-row-c">${ctl}</div></div>`;
const tg = (id, label, help, on) => `<div class="st-row" id="${id}-row"><div class="st-row-t"><b id="${id}-l">${esc(label)}</b>${help ? `<small>${help}</small>` : ""}</div><div class="st-row-c"><button class="switch" id="${id}" type="button" role="switch" aria-checked="${!!on}" aria-labelledby="${id}-l"></button></div></div>`;
const rg = (id, label, help, v, min, max, step, fmt) => row(label, help, `<div class="st-range"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}" aria-label="${esc(label)}"><output for="${id}" id="${id}-o">${esc(fmt(Number(v)))}</output></div>`, { id, cls: "st-row-range" });
const sel = (id, label, help, opts) => row(label, help, `<select id="${id}">${opts}</select>`, { id, forId: id });
const sg = (id, label, help, options, v) => row(label, help, segmented(id, options, v, { label }), { id, cls: "st-row-seg" });
const group = (title, rows, { more = "", sub = "" } = {}) => `<section class="st-group">${title ? `<header class="st-group-h"><h3>${esc(title)}</h3>${sub ? `<span>${sub}</span>` : ""}</header>` : ""}
  <div class="st-card">${rows}${more ? `<details class="st-more"><summary><span>More options</span></summary><div class="st-more-b">${more}</div></details>` : ""}</div></section>`;

// ---------------------------------------------------------------- the screen
export function render(el) {
  ensureCss("/v2/settings.css");
  el.innerHTML = `<div class="st2 span-12" id="st2"></div>`;
  const root = $("#st2", el);
  let gone = false, cur = null, hk = null, hkLoad = null, upd = null, timers = [];
  const sub = routeSub(), anchor = ANCHORS[sub], fromSub = SECTIONS.some(x => x[0] === sub) ? sub : anchor?.[0] || null;
  cur = fromSub || (wide() ? "general" : null);

  function shell() {
    root.innerHTML = `<nav class="st-nav" aria-label="Settings sections"><ul>${SECTIONS.map(([k, t, d]) => `<li><a href="#/settings2/${k}" data-sec="${k}"${k === cur ? ' aria-current="page"' : ""}>
        <span class="st-nav-ic">${IC[k]}</span><span class="st-nav-t"><b>${esc(t)}</b><small>${esc(d)}</small></span><span class="st-nav-go">${icon("chevron")}</span></a></li>`).join("")}</ul></nav>
      <div class="st-detail" id="st-detail" tabindex="-1"></div>`;
    root.classList.toggle("has-sec", !!cur);
    root.querySelector(".st-nav").addEventListener("click", e => { const a = e.target.closest("[data-sec]"); if (!a) return; e.preventDefault(); open(a.dataset.sec, true); });
  }
  function open(k, push = false) {
    cur = k; root.classList.toggle("has-sec", !!k);
    $$(".st-nav [data-sec]", root).forEach(a => a.toggleAttribute("aria-current", a.dataset.sec === k));
    if (push) history.pushState(null, "", k ? `#/settings2/${k}` : "#/settings2");
    paint();
    if (push) { if (!wide()) scrollTo({ top: 0 }); else $("#st-detail", root)?.scrollIntoView({ block: "nearest" }); $("#st-detail", root)?.focus({ preventScroll: true }); }
  }

  // ---------------------------------------------------------------- the sections
  function sectionHtml(k) {
    const st = app.state, s = st.settings;
    switch (k) {
      case "general": {
        const amb = `${opt("off", "Off, dark when nothing plays", s.ambient === "off")}${st.effects.filter(e => e.tag === "calm").map(e => opt(e.id, e.name, e.id === s.ambient)).join("")}`;
        return group("When nothing plays", sel("st-amb", "Ambient light", "Also a soft floor, so quiet songs never turn the room dark.", amb)
            + rg("st-idleb", "Brightness when idle", "", s.idleBrightness, 0, 1, 0.05, pct)
            + rg("st-idlea", "Go idle after", "Seconds of silence before the ambient light takes over.", s.idleAfterSec, 2, 60, 1, v => `${v} s`))
          + group("Night mode", tg("st-n-on", "Calmer light at night", "A brightness cap, warm colours, and no strobes or drop flashes.", s.night.enabled)
            + row("From", "A time like 23:00, or sunset.", `<input id="st-n-from" class="st-short" value="${esc(s.night.from)}" placeholder="23:00">`, { id: "st-n-from", forId: "st-n-from" })
            + row("Until", "A time like 07:00, or sunrise.", `<input id="st-n-to" class="st-short" value="${esc(s.night.to)}" placeholder="07:00">`, { id: "st-n-to", forId: "st-n-to" })
            + rg("st-n-max", "Brightness at night", "", s.night.maxBrightness, 0.05, 1, 0.05, pct)
            + tg("st-n-warm", "Warm colours only", "", s.night.warm), { sub: s.night.enabled ? "On" : "Off" })
          + group("Your location", row("Latitude and longitude", `<span id="st-l-help">${s.location ? `Sunrise and sunset are worked out for ${esc(s.location.lat)}, ${esc(s.location.lon)}.` : "Needed for schedules and night mode that start at sunset or sunrise."}</span>`,
              `<div class="st-inline"><input id="st-lat" type="number" step="0.0001" placeholder="Latitude" aria-label="Latitude" value="${s.location?.lat ?? ""}"><input id="st-lon" type="number" step="0.0001" placeholder="Longitude" aria-label="Longitude" value="${s.location?.lon ?? ""}"></div>`, { id: "st-lat", cls: "st-row-stack" })
            + `<div class="st-actions"><button class="btn sm" id="st-l-geo" type="button">Use my location</button><button class="btn sm primary" id="st-l-save" type="button">Save the location</button></div>`)
          + group("Matrix text and setup", sel("st-x-src", "What the Text Scroller shows", "On LED matrix panels.", `${opt("song", "What's playing", s.text.source === "song")}${opt("bpm", "The tempo", s.text.source === "bpm")}${opt("clock", "The time", s.text.source === "clock")}${opt("custom", "My own text", s.text.source === "custom")}`)
            + row("My own text", "Up to 80 characters.", `<input id="st-x-custom" maxlength="80" value="${esc(s.text.custom)}">`, { id: "st-x-custom", forId: "st-x-custom" }), {
            more: row("Setup", "The first-start guide: find lights, pick how it hears music, set the timing.", `<button class="btn sm" id="st-wizard" type="button">Run setup again</button>`) });
      }
      case "lighting":
        return group("Feel", rg("st-punch", "Punch", "How hard the whole room pumps on each kick in a drop.", s.punch ?? 0.7, 0, 1, 0.05, pct)
            + rg("st-dyn", "Drama", "How much brighter drops are than calm parts, with a dip just before each drop.", s.dynamics ?? 0.8, 0, 1, 0.05, pct)
            + sg("st-stereo", "Stereo", "With a stereo source, the side of the room a hit came from lights up more.", [{ value: "off", label: "Off" }, { value: "subtle", label: "Subtle" }, { value: "strong", label: "Strong" }], s.stereo || "subtle"))
          + group("Colour", tg("st-moodc", "Mood colours", "With automatic colours, the palette follows the music's key, brightness and energy.", s.moodColours !== false)
            + tg("st-chordc", "Chord colours", "Colours step with the song's chords, on the bar line.", s.chordColours !== false))
          + group("Drops", tg("st-vary", "Vary long drops", "A colour flip or a mirror every 2 bars, so long drops stay fresh.", s.variations !== false)
            + tg("st-dropf", "Flash on drops", "A white hit the moment a drop lands.", s.dropFlash)
            + tg("st-dropcd", "Count down to drops", "\"Drop in 4 · 3 · 2 · 1\" on the stage and the pads, before a known or predicted drop.", s.dropCountdown !== false));
      case "music":
        return group("Memory", tg("st-mem", "Remember songs", "Analysed songs are kept, and recognised when they play again while listening live.", s.songMemory !== false)
            + tg("st-shows", "Play remembered shows", "A remembered song plays its show (made for it, and editable) in automatic mode.", s.shows !== false)
            + (DEMO ? "" : tg("st-np", "Read what music apps play", "The song name from Spotify, Apple Music and other apps on this computer.", s.nowPlaying?.enabled !== false)))
          + group("Beat", tg("st-pred", "Predict beats", "When listening live, lights land on the beat instead of just after it.", !!s.predict), {
              more: tg("st-met", "Metronome when nothing plays", "A steady pretend beat, for testing lights without music.", s.metronome?.enabled)
                + row("Metronome tempo", "Beats a minute, 40 to 220.", `<input type="number" id="st-bpm" class="st-num" min="40" max="220" value="${s.metronome?.bpm ?? 120}">`, { id: "st-bpm", forId: "st-bpm" }) })
          + group("Guests", tg("st-req", "Song requests", "Guests can ask for songs from their phones. The list is on the Songs screen.", !!s.requests))
          + `<p class="st-note">Your music folder, light timing and how Tempolight hears music are on the <a href="#/songs">Songs</a> and <a href="#/lights">Lights</a> screens.</p>`;
      case "safety": {
        const x = s.dmx || {}, hasDmx = st.devices.some(d => d.kind === "dmx");
        return group("Flashes", tg("st-safe", "Photosensitive-safe mode", "At most 3 flashes a second, gentler strobes and game effects.", !!s.safe)
            + tg("st-dropf2", "Flash on drops", "A white hit the moment a drop lands.", s.dropFlash))
          + group("Lasers and fog", tg("st-las", "Lasers", "Only during drops, never in safe mode, night mode or a blackout. Use only lasers made for audiences, aimed above head height.", !!x.lasers)
            + tg("st-fog", "Fog machine", "Bursts before or at a drop, within the limits set for your DMX fixtures.", !!x.fog), {
              sub: hasDmx ? "" : "For DMX fixtures", more: row("Fog timing and limits", "Burst length, cool-down and the most fog in 5 minutes.", `<a class="btn sm" href="#/devices">Open the DMX settings</a>`) });
      }
      case "lock":
        return `<div id="st-lockbox">${st.locked ? group("PIN lock", row("Locked with a PIN", app.token ? "You are unlocked on this device." : "", `<span class="ui-pill ok"><i></i>Locked</span>`)
              + `<div class="st-actions">${app.token ? '<button class="btn sm" id="st-relock" type="button">Lock now on this device</button>' : ""}<button class="btn sm danger" id="st-unlockset" type="button">Remove the PIN</button></div>`)
            : group("PIN lock", row("Not locked", "A PIN stops guests at a party from changing lights, the room, schedules and settings.", `<span class="ui-pill"><i></i>Off</span>`)
              + `<div class="st-actions st-pinrow"><input id="st-pin" type="password" inputmode="numeric" autocomplete="new-password" placeholder="New PIN, 4 to 8 digits" aria-label="New PIN"><button class="btn sm primary" id="st-lock" type="button">Lock the settings</button></div>`)}</div>`
          + group("What guests can still do", [["effects", "Pick effects", "Change the look and the variety."], ["scenes", "Use scenes", "Apply saved looks."], ["pads", "Use the pads", "Flash, strobe, blackout, build and drop."], ["brightness", "Brightness and power", "The slider and the lights switch at the top."]]
            .map(([k, l, h]) => tg("st-g-" + k, l, h, s.guest[k])).join(""), { sub: "With the PIN lock on" });
      case "performance":
        return group("Speed", sg("st-perf", "Performance", "Low power: at most 30 fps, a lighter preview and fewer updates. Automatic picks it on a Raspberry Pi Zero or Pi 3, or when this computer can't keep up.",
              [{ value: "auto", label: "Automatic" }, { value: "full", label: "Full" }, { value: "lite", label: "Low power" }], s.performance || "auto")
            + row("Right now", "", `<span class="st-live mono" id="st-perf-st">Measuring</span>`)
            + rg("st-fps", "Frame rate", "Lower it on a Raspberry Pi Zero or busy Wi-Fi.", s.fps, 20, 90, 5, v => `${v} fps`));
      case "network":
        return (DEMO ? "" : `<div id="st-wifi" hidden>${group("Wi-Fi", row("Network", "", `<span class="st-live" id="st-wifistate">Checking</span>`)
              + row("Move to another network", "This Pi leaves the current Wi-Fi and opens the Tempolight-Setup hotspot. Join it from your phone and pick the new network.", `<button class="btn sm" id="st-wifigo" type="button">Set up Wi-Fi again</button>`))}</div>`)
          + group("Home Assistant", tg("st-m-on", "Connect through MQTT", "Home Assistant finds Tempolight by itself: a light with effects, a scene picker, tempo and song-part sensors, and Flash, Drop and Next buttons.", s.mqtt?.enabled)
            + `<div id="st-m-fields"${s.mqtt?.enabled ? "" : " hidden"}>` + row("Broker", "", `<input id="st-m-url" placeholder="mqtt://192.168.1.10:1883" value="${esc(s.mqtt?.url || "")}">`, { id: "st-m-url", forId: "st-m-url" })
            + row("User name", "", `<input id="st-m-user" autocomplete="off" value="${esc(s.mqtt?.username || "")}">`, { id: "st-m-user", forId: "st-m-user" })
            + row("Password", "", `<input id="st-m-pass" type="password" autocomplete="new-password" placeholder="${s.mqtt?.hasPassword ? "Saved" : ""}">`, { id: "st-m-pass", forId: "st-m-pass" })
            + `<div class="st-actions"><span class="st-live" id="st-m-state">${s.mqtt?.enabled ? "Connecting" : "Off"}</span><button class="btn sm primary" id="st-m-save" type="button">Save the broker</button></div></div>`, {
              more: row("How to set it up", "In Home Assistant, add the Mosquitto broker add-on and the MQTT integration, then use the same broker here.", "") })
          + (DEMO ? "" : group("Apple Home", `<div id="st-hk">${tg("st-hk-on", "Show Tempolight in the Home app", "A light, a Music reactive switch and one switch per scene, so Siri can turn on Party mode. Your iPhone must be on the same network.", false)}<div id="st-hk-b"></div></div>`, { sub: `<span id="st-hk-sub"></span>` }))
          + group("Lights and other apps", tg("st-disc", "Look for WLED controllers on first start", "", s.autoDiscover), {
              more: tg("st-sync", "Send WLED audio sync", "Lets WLED's own sound effects react too.", s.audioSync)
                + tg("st-osc", "OSC control", "/tempolight/effect laser, /scene Party, /flash, /blackout 1, /brightness 0.5 and more.", s.osc.enabled)
                + row("OSC port", "UDP.", `<input type="number" id="st-oscport" class="st-num" value="${s.osc.port}">`, { id: "st-oscport", forId: "st-oscport" })
                + tg("st-dj", "Pioneer Pro DJ Link", "Take the beat from CDJs and XDJs on this network. Listens only.", s.djlink?.enabled)
                + tg("st-link", "Ableton Link", "Follow the tempo and beat of a Link session: Live, Traktor, Bitwig, phone apps. Listens only.", s.link?.enabled)
                + row("HTTP API", `Home Assistant, Stream Deck and scripts can call the JSON API, for example <span class="mono">POST /api/scenes/&lt;id&gt;/apply</span>.`, `<a class="btn sm" href="${DOCS}api/" target="_blank" rel="noopener">Read the API guide</a>`)
                + row("Stream Deck, OBS, games, Twitch, Discord", "", `<a class="btn sm" href="#/integrations">Open the integrations</a>`) })
          + group("Updates", updHtml("st-n"));
      case "backup":
        return group("Backup", row("Download a backup", "Lights, the room, zones, scenes, schedules and settings in one file. Use it to move to a new computer or Raspberry Pi.", `<button class="btn sm primary" id="st-b-down" type="button">Download the backup</button>`)
            + row("Restore from a file", "Replaces what is here now. Your current PIN stays.", `<label class="btn sm" for="st-b-file">Choose a backup file</label><input type="file" id="st-b-file" accept="application/json,.json" hidden>`), {
              more: row("Reset everything", "Removes all lights, the room, scenes, schedules and settings. Download a backup first.", `<button class="btn sm danger" id="st-reset" type="button">Reset everything</button>`) });
      case "about":
        return `<div class="st-hero ui-card"><span class="st-lamp" aria-hidden="true"></span><div><h3>Tempolight ${esc(st.version || "")}</h3><p>Music-reactive light for any room. Open source, MIT licence${DEMO ? ". This is the online demo." : "."}</p></div></div>`
          + group("Updates", updHtml("st-a"))
          + group("Help", row("Set up with Claude", "A ready prompt that lets Claude install and set up Tempolight with you.", `<button class="btn sm" id="st-claude" type="button">${icon("sparkle")}Set up with Claude</button>`)
            + row("Help and docs", "Guides for every light, sound setup and the HTTP API.", `<a class="btn sm" href="${DOCS}" target="_blank" rel="noopener">Open the docs</a>`)
            + row("Source code", "github.com/D4RKGEEK/tempolight", `<a class="btn sm" href="https://github.com/D4RKGEEK/tempolight" target="_blank" rel="noopener">View the source</a>`), {
              more: row("Setup", "The first-start guide.", `<button class="btn sm" id="st-wizard2" type="button">Run setup again</button>`)
                + row("Playground", "The old single-page playground.", `<a class="btn sm" href="/playground">Open the playground</a>`)
                + row("Classic settings page", "The previous layout of this page.", `<a class="btn sm" href="#/settings">Open the classic page</a>`)
                + (st.canQuit ? row("Quit Tempolight", "The lights stop until you open the app again.", `<button class="btn sm danger" id="st-quit" type="button">Quit Tempolight</button>`) : "") })
          + `<p class="st-note">MIT licence. Free to use, change and share.</p>`;
    }
    return "";
  }
  const updHtml = p => row(DEMO ? "Always up to date" : "This version", `<span id="${p}-msg" aria-live="polite">Tempolight ${esc(app.state.version || "")}</span>`,
    `<div class="st-inline"><button class="btn sm" id="${p}-upd" type="button"${DEMO ? " disabled" : ""}>Check for updates</button><button class="btn sm primary" id="${p}-go" type="button" hidden>Update now</button></div>`, { id: p + "-upd", cls: "st-row-stack-phone" });

  function paint() {
    const d = $("#st-detail", root); if (!d) return;
    if (!cur) { d.innerHTML = ""; return; }
    const [k, t, desc] = SECTIONS.find(x => x[0] === cur), admin = unlocked();
    d.innerHTML = `<header class="st-dh"><a class="st-back iconbtn" href="#/settings2" aria-label="All settings">${icon("back")}</a><div><h2>${esc(t)}</h2><p>${esc(desc)}</p></div></header>
      ${admin ? "" : `<div class="st-unlock ui-card"><div><b>Settings are locked</b><small>Type the PIN to change them on this device.</small></div><div class="st-inline"><input id="st-u-pin" type="password" inputmode="numeric" placeholder="PIN" aria-label="PIN"><button class="btn primary" id="st-u-go" type="button">Unlock</button></div></div>`}
      <div class="st-body${admin ? "" : " locked"}">${sectionHtml(k)}</div>`;
    d.querySelector(".st-back").onclick = e => { e.preventDefault(); open(null, true); };
    if (!admin) {
      $$(".st-body input, .st-body select, .st-body button, .st-body .ui-seg button", d).forEach(x => x.disabled = true);
      $$(".st-body a.btn, .st-body label.btn", d).forEach(x => x.setAttribute("aria-disabled", "true"));
      const go = async () => { const r = await act(() => api("POST", "/api/unlock", { pin: $("#st-u-pin").value })); app.token = r.token; store.set("token", r.token); ws.sock?.close(); await refreshState(); paint(); };
      $("#st-u-go").onclick = () => go().catch(() => {}); $("#st-u-pin").onkeydown = e => { if (e.key === "Enter") go().catch(() => {}); };
      return;
    }
    wire(k, d);
  }

  // ---------------------------------------------------------------- wiring
  const setS = (b, msg = "Saved") => act(() => api("PATCH", "/api/settings", b), msg).then(refreshState).catch(() => {});
  function wire(k, d) {
    const q = id => d.querySelector("#" + id);
    const onTg = (id, fn) => { const b = q(id); if (b) b.onclick = () => { const v = b.getAttribute("aria-checked") !== "true"; if (fn(v, b) === false) return; b.setAttribute("aria-checked", v); }; };
    const onRg = (id, key, fmt, conv = Number) => { const r = q(id); if (!r) return; const o = q(id + "-o"); const paintR = () => { r.style.setProperty("--p", `${((r.value - r.min) / (r.max - r.min)) * 100}%`); o.textContent = fmt(Number(r.value)); };
      paintR(); r.oninput = paintR; r.onchange = () => setS(typeof key === "function" ? key(conv(r.value)) : { [key]: conv(r.value) }); };
    const onSel = (id, key) => { const x = q(id); if (x) x.onchange = () => setS({ [key]: x.value }); };
    const onSeg = (id, fn) => bindSegmented(d, id, fn);
    const wiz = () => import("/wizard.js").then(m => m.openWizard()).catch(() => toast("The setup guide isn't available here", true));
    if (k === "general") {
      onSel("st-amb", "ambient"); onRg("st-idleb", "idleBrightness", pct); onRg("st-idlea", "idleAfterSec", v => `${v} s`);
      const night = () => setS({ night: { enabled: q("st-n-on").getAttribute("aria-checked") === "true", from: q("st-n-from").value.trim(), to: q("st-n-to").value.trim(), maxBrightness: Number(q("st-n-max").value), warm: q("st-n-warm").getAttribute("aria-checked") === "true" } });
      onTg("st-n-on", () => setTimeout(night)); onTg("st-n-warm", () => setTimeout(night)); q("st-n-from").onchange = night; q("st-n-to").onchange = night;
      onRg("st-n-max", v => ({ night: { maxBrightness: v } }), pct);
      q("st-l-save").onclick = () => setS({ location: q("st-lat").value === "" ? null : { lat: Number(q("st-lat").value), lon: Number(q("st-lon").value) } }, "Location saved");
      q("st-l-geo").onclick = () => { if (!navigator.geolocation) return toast("This browser can't share its location", true);
        q("st-l-help").textContent = "Asking the browser"; navigator.geolocation.getCurrentPosition(p => { q("st-lat").value = p.coords.latitude.toFixed(4); q("st-lon").value = p.coords.longitude.toFixed(4); q("st-l-save").click(); },
          e => { q("st-l-help").textContent = `Couldn't get the location: ${e.message}. Type the latitude and longitude instead (search the city name online).`; }, { timeout: 10000 }); };
      q("st-x-src").onchange = e => setS({ text: { source: e.target.value } }); q("st-x-custom").onchange = e => setS({ text: { custom: e.target.value } });
      q("st-wizard").onclick = wiz;
    }
    if (k === "lighting") {
      onRg("st-punch", "punch", pct); onRg("st-dyn", "dynamics", pct); onSeg("st-stereo", v => setS({ stereo: v }));
      onTg("st-moodc", v => { setS({ moodColours: v }); }); onTg("st-chordc", v => { setS({ chordColours: v }); });
      onTg("st-vary", v => { setS({ variations: v }); }); onTg("st-dropf", v => { setS({ dropFlash: v }); }); onTg("st-dropcd", v => { setS({ dropCountdown: v }); });
    }
    if (k === "music") {
      onTg("st-mem", v => { setS({ songMemory: v }, v ? "Song memory on" : "Song memory off"); }); onTg("st-shows", v => { setS({ shows: v }); });
      onTg("st-np", v => { setS({ nowPlaying: { enabled: v } }); }); onTg("st-pred", v => { setS({ predict: v }); });
      onTg("st-met", v => { setS({ metronome: { enabled: v } }); }); q("st-bpm").onchange = e => setS({ metronome: { bpm: Math.max(40, Math.min(220, Number(e.target.value) || 120)) } });
      onTg("st-req", v => { setS({ requests: v }, v ? "Requests on" : "Requests off"); });
    }
    if (k === "safety") {
      onTg("st-safe", v => { setS({ safe: v }); }); onTg("st-dropf2", v => { setS({ dropFlash: v }); });
      onTg("st-las", v => { if (v && !confirm("Turn lasers on?\n\nUse only lasers made for audiences, aimed above head height. Tempolight runs them only during drops, never in photosensitive-safe or night mode.")) return false; setS({ dmx: { lasers: v } }); });
      onTg("st-fog", v => { setS({ dmx: { fog: v } }); });
    }
    if (k === "lock") {
      for (const g of ["effects", "scenes", "pads", "brightness"]) onTg("st-g-" + g, v => { setS({ guest: { [g]: v } }); });
      const lk = q("st-lock"); if (lk) { const go = async () => { const r = await act(() => api("POST", "/api/lock", { pin: q("st-pin").value }), "Locked. You stay unlocked on this device.").catch(() => null); if (r) { app.token = r.token; store.set("token", r.token); await refreshState(); paint(); } };
        lk.onclick = go; q("st-pin").onkeydown = e => { if (e.key === "Enter") go(); }; }
      const un = q("st-unlockset"); if (un) un.onclick = async () => { if (!confirm("Remove the PIN? Anyone on this network can then change everything.")) return; await act(() => api("DELETE", "/api/lock"), "PIN removed").catch(() => {}); await refreshState(); paint(); };
      const rl = q("st-relock"); if (rl) rl.onclick = () => { app.token = null; store.set("token", null); ws.sock?.close(); refreshState().then(paint); };
    }
    if (k === "performance") { onSeg("st-perf", v => setS({ performance: v })); onRg("st-fps", "fps", v => `${v} fps`); if (app.status) status(app.status); }
    if (k === "network") {
      const mqtt = () => { const b = { enabled: q("st-m-on").getAttribute("aria-checked") === "true", url: q("st-m-url").value.trim(), username: q("st-m-user").value.trim() }; if (q("st-m-pass").value) b.password = q("st-m-pass").value; return setS({ mqtt: b }); };
      onTg("st-m-on", v => { q("st-m-fields").hidden = !v; setTimeout(mqtt); }); q("st-m-save").onclick = mqtt;
      onTg("st-disc", v => { setS({ autoDiscover: v }); }); onTg("st-sync", v => { setS({ audioSync: v }); });
      onTg("st-osc", v => { setS({ osc: { enabled: v } }); }); q("st-oscport").onchange = e => setS({ osc: { port: Number(e.target.value) } });
      onTg("st-dj", v => { setS({ djlink: { enabled: v } }); }); onTg("st-link", v => { setS({ link: { enabled: v } }); });
      if (DEMO) { q("st-dj").disabled = q("st-link").disabled = true; }
      if (q("st-wifi")) api("GET", "/api/wifi").then(w => { if (gone || !w?.available || !q("st-wifi")) return; q("st-wifi").hidden = false;
        q("st-wifistate").textContent = w.mode === "hotspot" ? `The setup hotspot ${w.hotspot} is open.` : w.ssid ? `Connected to ${w.ssid}.` : "Not on Wi-Fi (Ethernet, or not connected)."; }).catch(() => {});
      if (q("st-wifigo")) q("st-wifigo").onclick = async () => { if (!confirm("Leave the current Wi-Fi and open the Tempolight-Setup hotspot? This page stops answering until the Pi is on a network again.")) return;
        const r = await act(() => api("POST", "/api/wifi/setup")).catch(() => null); if (r) q("st-wifistate").textContent = r.message; };
      if (q("st-hk")) homekit(d);
      wireUpd(d, "st-n"); if (app.status) status(app.status);
    }
    if (k === "backup") {
      q("st-b-down").onclick = async () => { const b = await act(() => api("GET", "/api/backup")).catch(() => null); if (!b) return;
        const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: "application/json" })); a.download = `tempolight-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
      q("st-b-file").onchange = async e => { const f = e.target.files[0]; if (!f) return; let j; try { j = JSON.parse(await f.text()); } catch { return toast("That file isn't a backup", true); }
        if (!confirm("Replace your lights, room, scenes, schedules and settings with this backup?")) return;
        await act(() => api("POST", "/api/restore", j), "Backup restored").catch(() => {}); await refreshState(); await loadLayout(); paint(); };
      q("st-reset").onclick = async () => { if (!confirm("Reset all lights, the room, scenes, schedules and settings?")) return; await act(() => api("POST", "/api/reset"), "Reset").catch(() => {}); await refreshState(); await loadLayout(); route(); };
    }
    if (k === "about") {
      wireUpd(d, "st-a"); q("st-wizard2").onclick = wiz;
      q("st-claude").onclick = () => import("/claude-setup.js").then(m => m.openClaudeSetup()).catch(() => toast("Setting up with Claude isn't available in this version", true));
      const qt = q("st-quit"); if (qt) qt.onclick = () => { if (confirm("Quit Tempolight? The lights stop until you open the app again.")) act(() => api("POST", "/api/quit"), "Tempolight is quitting. Open the app again to start it.").catch(() => {}); };
    }
  }

  // update check and apply (in About and in Network and updates); the last answer is kept while this screen is open
  function wireUpd(d, p) {
    const m = d.querySelector(`#${p}-msg`), b = d.querySelector(`#${p}-upd`), go = d.querySelector(`#${p}-go`); if (!b) return;
    const show = r => { m.innerHTML = esc(r.message) + (r.changes?.length ? `<ul class="st-changes">${r.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""); go.hidden = !r.canUpdate; };
    if (upd) show(upd);
    b.onclick = async () => { m.textContent = "Checking"; const r = await act(() => api("GET", "/api/update")).catch(() => null); if (!r) { m.textContent = ""; return; } upd = r; show(r); };
    go.onclick = async () => { const r = await act(() => api("POST", "/api/update")).catch(() => null); if (!r) return; m.textContent = r.message; go.hidden = true; upd = null;
      const t0 = Date.now(), wait = async () => { await new Promise(x => setTimeout(x, 1500)); try { await api("GET", "/api/health"); if (Date.now() - t0 > 4000) return location.reload(); } catch {} if (Date.now() - t0 < 90000) wait(); }; wait(); };
  }

  // Apple Home (server only): GET/PATCH /api/homekit, the setup code and QR while not paired, the paired devices, reset
  function homekit(d) {
    const q = id => d.querySelector("#" + id), sw = q("st-hk-on");
    const fill = async () => { if (gone || !q("st-hk-b") || !d.isConnected) return; const v = hk;
      if (!v) { q("st-hk").closest(".st-group").hidden = true; return; }
      sw.setAttribute("aria-checked", !!v.enabled);
      q("st-hk-sub").textContent = !v.enabled ? "Off" : v.state === "error" ? "Problem" : v.state !== "ready" ? "Starting" : v.paired ? "Paired" : "Ready to pair";
      const pair = v.enabled && v.state === "ready" && !v.paired, err = v.error || (v.enabled && v.mdnsError ? `iPhones may not find Tempolight: ${v.mdnsError}` : "");
      q("st-hk-b").innerHTML = (pair ? `<div class="st-row st-hk-pair"><div class="st-qr" id="st-hk-qr"></div><div class="st-row-t"><b>Setup code</b><span class="mono st-code">${esc(v.setupCode)}</span>
          <small>In the Home app: + then Add Accessory, and scan the code. Or choose More options and pick ${esc(v.name)}. The Home app warns that it isn't certified: choose Add Anyway.</small></div></div>` : "")
        + (v.paired ? row("Paired with", v.pairings.map(p => `<span class="mono">${esc(p.id)}</span>${p.admin ? " (owner)" : ""}`).join("<br>"), "") : "")
        + (err ? row("Problem", esc(err), "") : "")
        + `<details class="st-more"><summary><span>More options</span></summary><div class="st-more-b">${row("Reset the pairing", "Tempolight gets a new setup code. Remove the old Tempolight in the Home app, then add it again.", `<button class="btn sm danger" id="st-hk-reset" type="button">Reset the pairing</button>`)}</div></details>`;
      if (pair) { const { qrSvg } = await import("/qr.js"); const box = q("st-hk-qr"); if (box) box.innerHTML = qrSvg(v.setupUri, { px: 4 }); }
      const rs = q("st-hk-reset"); if (rs) rs.onclick = () => { if (!confirm("Reset the Apple Home pairing? Tempolight gets a new setup code and the Home app loses it: remove the old Tempolight there and add it again.")) return;
        act(() => api("POST", "/api/homekit/reset"), "Pairing reset").then(x => { hk = x; fill(); }).catch(() => {}); };
    };
    const load = async () => { hk = await api("GET", "/api/homekit").catch(() => null); fill(); };
    sw.onclick = () => { const on = sw.getAttribute("aria-checked") !== "true"; sw.setAttribute("aria-checked", on);
      act(() => api("PATCH", "/api/homekit", { enabled: on }), on ? "Apple Home is on" : "Apple Home is off").then(v => { hk = v; fill(); }).catch(load); };
    load(); hkLoad = load;
  }

  const mqttLabel = m => !m || m.state === "off" ? "Off" : m.state === "connected" ? "Connected" : m.state === "error" ? `Problem: ${m.error}` : "Connecting";
  const perfLabel = p => p ? `${p.mode === "lite" ? "Low power" : "Full"}${p.why && p.why !== "auto" ? ` (${p.why.replace(/^auto: /, "")})` : ""}${p.fps ? ` · ${p.fps} fps, ${p.frameMs} ms a frame` : ""}${p.cpu != null ? ` · CPU ${p.cpu}%` : ""}` : "Measuring";
  function status(m) {
    const e = $("#st-m-state", root); if (e && m.mqtt) { e.textContent = mqttLabel(m.mqtt); e.dataset.state = m.mqtt.state; }
    const pf = $("#st-perf-st", root); if (pf && m.perf) pf.textContent = perfLabel(m.perf);
  }

  // a deep link's row: scroll to it, open its "More options", glow once
  function spot(id, tries = 20) {
    const x = $("#" + id, root); if (!x) { if (tries > 0) timers.push(setTimeout(() => spot(id, tries - 1), 100)); return; }
    const det = x.closest("details"); if (det) det.open = true;
    const box = x.closest(".st-row, .st-group") || x;
    box.scrollIntoView({ block: "center", behavior: reduce() ? "auto" : "smooth" });
    box.classList.remove("spot"); void box.offsetWidth; box.classList.add("spot"); timers.push(setTimeout(() => box.classList.remove("spot"), 2000));
  }

  shell(); paint();
  if (anchor) spot(anchor[1]);
  // phone ↔ desktop: a desktop always shows a section
  const mq = matchMedia("(min-width: 761px)"), onMq = () => { if (mq.matches && !cur) open("general"); };
  mq.addEventListener?.("change", onMq);

  return {
    destroy() { gone = true; timers.forEach(clearTimeout); mq.removeEventListener?.("change", onMq); },
    onStatus: status,
    onChanged(w) {
      if (gone) return;
      if (w.has("homekit") || w.has("scenes")) hkLoad?.();
      if (!(w.has("lock") || w.has("settings") || w.has("all") || w.has("devices"))) return;
      // repaint the open section, unless someone is typing in it; keep focus and scroll
      const a = document.activeElement, d = $("#st-detail", root);
      if (d?.contains(a) && a.matches("input:not([type=range]), textarea")) return;
      const focusId = d?.contains(a) ? a.id : null, opened = $$("details.st-more[open]", d || root).map(x => [...$$("details.st-more", d)].indexOf(x)), y = scrollY;
      paint();
      const dd = $("#st-detail", root); opened.forEach(i => { const x = $$("details.st-more", dd)[i]; if (x) x.open = true; });
      if (focusId) $("#" + focusId, root)?.focus({ preventScroll: true }); scrollTo({ top: y });
    },
  };
}
