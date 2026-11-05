// Integrations (dashboard v2, #/integrations2): "What else can drive or show my lights?"
// A gallery of cards (icon, name, what it does, a Connected / Off pill) in groups: Smart home, Streaming and creators,
// DJ and music gear, Games, Developers. A card opens a sheet with that integration's setup, the same forms and API
// calls as the v1 pages (integrations.js for Stream Deck, OBS, CS2, Dota 2, Twitch, Discord and the docs site;
// homekit.js for Apple Home; Settings for Home Assistant (MQTT), WLED audio sync, OSC, Pro DJ Link and Ableton Link).
// Spotify opens the Songs screen's Spotify sheet; MIDI clock and controllers live on the Live pads page (Web MIDI).
// Admin only for anything holding passwords or tokens: with a PIN lock, guests see the cards but not the settings.
import { app, api, act, toast, esc, $, $$, opt, unlocked, refreshState, DEMO, route } from "/app.js";
import { openSheet, toggle, bindToggle, pill, icon, ensureCss } from "/v2/shell.js";

const DOCS = "https://github.com/D4RKGEEK/tempolight/blob/main/docs/";
const ago = t => { if (!t) return "never"; const s = Math.round((Date.now() - t) / 1000); return s < 2 ? "just now" : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true" class="ui-ic">${d}</svg>`;
const IC = {
  ha: svg('<path d="M4 11l8-7 8 7v9H4z"/><circle cx="12" cy="12.5" r="1.6"/><path d="M12 14.1V20M12 12.5l-3-2.5M12 12.5l3 3"/>'),
  homekit: svg('<path d="M4 11l8-7 8 7v9H4z"/><path d="M10.5 17h3M12 9.5a2.6 2.6 0 0 0-1.6 4.6c.3.3.5.6.5 1h2.2c0-.4.2-.7.5-1A2.6 2.6 0 0 0 12 9.5z"/>'),
  wled: svg('<rect x="2.5" y="9" width="19" height="6" rx="3"/><path d="M6 5.5c1.2-1 2.6-1.5 4-1.5M18 5.5A6 6 0 0 0 14 4M6 18.5c1.2 1 2.6 1.5 4 1.5M18 18.5a6 6 0 0 1-4 1.5"/>'),
  obs: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/>'),
  twitch: svg('<path d="M5 4h15v10l-4 4h-4l-3 3v-3H5z"/><path d="M11 8v4M15.5 8v4"/>'),
  discord: svg('<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 4v-4h0a2 2 0 0 1-2-2z"/><path d="M8.5 10h7M8.5 13h4"/>'),
  deck: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><rect x="6.5" y="8.5" width="3" height="3" rx=".8"/><rect x="10.5" y="8.5" width="3" height="3" rx=".8"/><rect x="14.5" y="8.5" width="3" height="3" rx=".8"/><rect x="6.5" y="12.5" width="3" height="3" rx=".8"/><rect x="10.5" y="12.5" width="3" height="3" rx=".8"/><rect x="14.5" y="12.5" width="3" height="3" rx=".8"/>'),
  spotify: svg('<circle cx="12" cy="12" r="9"/><path d="M7.5 9.5c3-1 6.5-.7 9 .8M8 12.6c2.5-.7 5.3-.4 7.4.8M8.6 15.5c2-.5 4-.3 5.6.6"/>'),
  djlink: svg('<circle cx="10" cy="12" r="7.5"/><circle cx="10" cy="12" r="2"/><path d="M19.5 4v11.5l-2.5 3"/>'),
  link: svg('<circle cx="8.5" cy="12" r="5"/><circle cx="15.5" cy="12" r="5"/>'),
  midi: svg('<circle cx="12" cy="12" r="9"/><circle cx="7.5" cy="12" r=".9"/><circle cx="16.5" cy="12" r=".9"/><circle cx="9" cy="8.5" r=".9"/><circle cx="15" cy="8.5" r=".9"/><circle cx="12" cy="7.2" r=".9"/><path d="M10.5 17.5h3"/>'),
  osc: svg('<path d="M3 12h3l2-6 4 12 3-9 2 3h4"/>'),
  cs2: svg('<circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/><circle cx="12" cy="12" r="1"/>'),
  dota: svg('<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6z"/><path d="M9 9l6 6M15 9l-1.8 1.8"/>'),
  api: svg('<path d="M8.5 7L4 12l4.5 5M15.5 7L20 12l-4.5 5M13.5 5l-3 14"/>'),
  docs: svg('<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 7.5h6"/>'),
};
const GROUPS = [["home", "Smart home"], ["stream", "Streaming and creators"], ["dj", "DJ and music gear"], ["games", "Games"], ["dev", "Developers"]];

export function render(el) {
  ensureCss("/v2/integrations.css");
  const admin = unlocked();
  let I = null, HK = null, timer = null, gone = false, cur = null; // GET /api/integrations, GET /api/homekit, the open sheet {id, r, fill, update}
  const st = () => app.state, set = () => st().settings, m = () => app.status || {};
  const scenes = () => st().scenes, effects = () => st().effects;
  const targets = (v, withOff = true) => [["all", "The whole room"], ...(st().room.zones || []).map(z => ["zone:" + z.id, "Zone: " + z.name]), ...st().devices.map(d => ["dev:" + d.id, "Only " + d.name]), ...(withOff ? [["off", "Nowhere (off)"]] : [])]
    .map(([k, n]) => opt(k, n, k === v)).join("") + (v && !/^(all|off)$/.test(v) && ![...(st().room.zones || []).map(z => "zone:" + z.id), ...st().devices.map(d => "dev:" + d.id)].includes(v) ? opt(v, v + " (gone)", true) : "");
  const sceneSel = (v, none = "Nothing") => opt("", none, !v) + scenes().map(s => opt(s.id, s.name, s.id === v)).join("");
  const setS = (b, ok = "Saved") => act(() => api("PATCH", "/api/settings", b), ok).then(refreshState).then(() => { if (!gone) { paintPills(); cur?.fill(); } }).catch(() => {});
  const needI = id => ["obs", "twitch", "discord", "cs2", "dota2", "deck", "docs"].includes(id);

  // ---------------------------------------------------------------- what each card says now: [text, state]
  const STATE = {
    ha: () => { const q = m().mqtt; if (!set().mqtt?.enabled) return ["Off"]; return !q || q.state === "connecting" ? ["Connecting", "warn"] : q.state === "connected" ? ["Connected", "ok"] : q.state === "error" ? ["Problem", "bad"] : ["Off"]; },
    homekit: () => DEMO ? ["Needs your server"] : !admin ? ["Locked"] : !HK ? ["Off"] : !HK.enabled ? ["Off"] : HK.state === "error" ? ["Problem", "bad"] : HK.state !== "ready" ? ["Starting", "warn"] : HK.paired ? ["Paired", "ok"] : ["Ready to pair", "accent"],
    wled: () => set().audioSync ? ["On", "ok"] : ["Off"],
    deck: () => ["Plugin"],
    obs: () => { if (!I) return lockText(); const o = I.obs; return !o.enabled ? ["Off"] : o.status?.connected ? [o.status.streaming ? "Live" : o.status.recording ? "Recording" : "Connected", "ok"] : ["Connecting", "warn"]; },
    twitch: () => { if (!I) return lockText(); const t = I.twitch; if (!t.chat.enabled && !t.auth) return ["Off"]; return t.status?.joined || t.eventsub?.connected ? ["Connected", "ok"] : t.status?.error ? ["Problem", "bad"] : ["Connecting", "warn"]; },
    discord: () => { if (!I) return lockText(); const d = I.discord; return !d.hasWebhook ? ["Off"] : d.status?.error ? ["Problem", "bad"] : ["Ready", "ok"]; },
    spotify: () => { const s = m().spotify; return s?.connected ? ["Connected", "ok"] : s?.on ? ["On", "accent"] : ["Off"]; },
    djlink: () => DEMO ? ["Needs your server"] : !set().djlink?.enabled ? ["Off"] : m().djlink ? [`Following ${m().djlink.name}`, "ok"] : ["Listening", "accent"],
    link: () => DEMO ? ["Needs your server"] : !set().link?.enabled ? ["Off"] : m().source === "link" ? ["Following", "ok"] : ["Listening", "accent"],
    midi: () => m().midiClock?.running ? ["Following", "ok"] : m().midiClock ? ["Waiting", "warn"] : ["Off"],
    osc: () => set().osc?.enabled ? [`Port ${set().osc.port}`, "ok"] : ["Off"],
    cs2: () => game("cs2"), dota2: () => game("dota2"),
    api: () => ["Always on", "ok"],
    docs: () => !I ? lockText() : I.docs?.tryIt ? ["On", "warn"] : ["Off"],
  };
  const lockText = () => DEMO ? ["Needs your server"] : ["Locked"];
  const game = g => { if (!I) return lockText(); const c = I.games[g], s = c.status || {}; return !c.enabled ? ["Off"] : s.live ? ["In game", "ok"] : ["Waiting for the game", "accent"]; };

  const CARDS = [
    { id: "ha", g: "home", ic: "ha", name: "Home Assistant", what: "A light, a scene picker and song sensors in Home Assistant, through MQTT." },
    { id: "homekit", g: "home", ic: "homekit", name: "Apple Home", what: "Siri and the Home app: power, brightness, colour and a switch per scene." },
    { id: "wled", g: "home", ic: "wled", name: "WLED sound sync", what: "Sends the music to WLED so its own sound effects react too." },
    { id: "obs", g: "stream", ic: "obs", name: "OBS Studio", what: "Scenes follow OBS, a tally light while live, and a browser source for your stream." },
    { id: "twitch", g: "stream", ic: "twitch", name: "Twitch", what: "Chat commands like !scene, and lights for follows, subs, raids and cheers." },
    { id: "discord", g: "stream", ic: "discord", name: "Discord", what: "Posts what's playing and scene changes to a channel." },
    { id: "deck", g: "stream", ic: "deck", name: "Stream Deck", what: "Scenes, effects and live pads on keys, brightness on a dial." },
    { id: "spotify", g: "dj", ic: "spotify", name: "Spotify", what: "Knows the song and its parts before they play, for exact drops." },
    { id: "djlink", g: "dj", ic: "djlink", name: "Pro DJ Link", what: "Takes the beat from Pioneer CDJs and XDJs on this network." },
    { id: "link", g: "dj", ic: "link", name: "Ableton Link", what: "Follows the tempo of Live, Traktor, Bitwig and phone apps." },
    { id: "midi", g: "dj", ic: "midi", name: "MIDI clock and controllers", what: "Follow a MIDI clock, and play the pads from a controller." },
    { id: "cs2", g: "games", ic: "cs2", name: "Counter-Strike 2", what: "Health, flashbangs, the bomb, kills and rounds on top of the music." },
    { id: "dota2", g: "games", ic: "dota", name: "Dota 2", what: "Health and mana colours, kills, Roshan, day and night." },
    { id: "api", g: "dev", ic: "api", name: "HTTP API", what: "Every button here is a JSON call: scripts, Shortcuts, Node-RED." },
    { id: "osc", g: "dev", ic: "osc", name: "OSC", what: "Control from TouchOSC, QLab or a lighting desk over UDP." },
    { id: "docs", g: "dev", ic: "docs", name: "Docs site Try it", what: "Lets the online API reference send calls to this Tempolight." },
  ];

  // ---------------------------------------------------------------- the gallery
  el.innerHTML = `<div class="ui-screen ig2">
    <p class="ig2-lede" id="ig2-sum">Connect Tempolight to your home, your stream, your DJ gear and your games.</p>
    ${GROUPS.map(([g, t]) => `<section class="ig2-group" aria-labelledby="ig2-h-${g}"><h2 class="ig2-gh" id="ig2-h-${g}">${t}</h2>
      <div class="ig2-grid">${CARDS.filter(c => c.g === g).map(c => `<button class="ui-card ig2-card" type="button" data-ig="${c.id}" aria-haspopup="dialog">
        <span class="ig2-ic">${IC[c.ic]}</span><span class="ig2-pill" data-pill="${c.id}"></span>
        <b>${esc(c.name)}</b><small>${esc(c.what)}</small></button>`).join("")}</div></section>`).join("")}
    ${DEMO ? `<p class="ig2-note">${icon("info")}In the online demo these connect to nothing: they work with Tempolight running on your computer or Raspberry Pi.</p>` : !admin ? `<p class="ig2-note">${icon("info")}Integrations hold passwords and tokens, so only someone with the PIN can change them. <a href="#/settings">Unlock in Settings</a></p>` : ""}
  </div>`;
  function paintPills() {
    let on = 0;
    for (const c of CARDS) { const [t, s = ""] = STATE[c.id](), e = el.querySelector(`[data-pill="${c.id}"]`); if (!e) continue;
      const h = pill(t, s); if (e.innerHTML !== h) e.innerHTML = h; e.closest(".ig2-card").classList.toggle("on", s === "ok" || s === "accent"); if (s === "ok" && c.id !== "api") on++; }
    const sum = $("#ig2-sum"); if (sum) sum.textContent = on ? `${on} connected. Connect Tempolight to your home, your stream, your DJ gear and your games.` : "Connect Tempolight to your home, your stream, your DJ gear and your games.";
  }
  el.addEventListener("click", e => { const b = e.target.closest("[data-ig]"); if (b) open(b.dataset.ig); });

  const load = async () => { if (DEMO || !admin) return; I = await api("GET", "/api/integrations").catch(() => null); HK = await api("GET", "/api/homekit").catch(() => null); if (!gone) paintPills(); };
  const reload = () => load().then(() => cur?.fill());
  paintPills(); load();
  const poll = async () => { if (gone) return; if (!DEMO && admin) { try { const n = await api("GET", "/api/integrations"); if (gone) return;
      const relist = JSON.stringify(n.obs.status?.scenes || []) !== JSON.stringify(I?.obs.status?.scenes || []); I = n; paintPills(); cur?.update?.();
      if (relist && $("#obs-scenes")) $("#obs-scenes").innerHTML = (I.obs.status?.scenes || []).map(x => `<option value="${esc(x)}">`).join(""); } catch {} }
    timer = setTimeout(poll, 2500); };
  timer = setTimeout(poll, 2500);

  // ---------------------------------------------------------------- the sheets
  function open(id) {
    const c = CARDS.find(x => x.id === id); if (!c) return;
    if (id === "spotify") { location.hash = "#/songs/spotify"; return; }
    const SH = SHEETS[id]; let fill, update;
    const sh = openSheet({ title: c.name, wide: ["obs", "twitch", "cs2", "dota2"].includes(id), onClose: () => { if (cur?.id === id) cur = null; } }), r = sh.body; r.classList.add("ig2-sh");
    const head = () => `<div class="ig2-shh"><span class="ig2-ic">${IC[c.ic]}</span><p>${esc(c.what)}</p><span id="ig2-shpill">${pill(...STATE[id]())}</span></div>`;
    if (needI(id) && !I) fill = () => { r.innerHTML = head() + lockedBody(id); };
    else fill = () => { r.innerHTML = head() + SH.html(); SH.bind?.(r); SH.update?.(); };
    update = () => { const p = r.querySelector("#ig2-shpill"); if (p) p.innerHTML = pill(...STATE[id]()); SH.update?.(); };
    cur = { id, r, fill, update }; fill();
  }
  function lockedBody(id) {
    const what = { obs: "integrations.md#obs-studio", twitch: "integrations.md#twitch", discord: "integrations.md#discord", cs2: "integrations.md#games", dota2: "integrations.md#games", deck: "streamdeck.md", docs: "api.md" }[id] || "integrations.md";
    return DEMO ? `<p>This connects to Tempolight running on your computer or Raspberry Pi, so it isn't in the online demo.</p><div class="ig2-row"><a class="btn" href="${DOCS}${what}" target="_blank" rel="noopener">Read how it works</a></div>`
      : `<p>This holds passwords and tokens, so only someone with the PIN can see or change it.</p><div class="ig2-row"><a class="btn primary" href="#/settings">Unlock in Settings</a></div>`;
  }
  const settingsLocked = () => admin ? "" : `<p class="ig2-warn">${icon("info")}Settings are locked. <a href="#/settings">Unlock in Settings</a> to change this.</p>`;

  const SHEETS = {
    // ------------------------------------------------ Home Assistant (Settings → Home Assistant, v1)
    ha: { html: () => { const q = set().mqtt || {}; return `${settingsLocked()}
      <div class="ig2-box">${toggle("ha-on", "Connect to Home Assistant", !!q.enabled, { hint: "Through MQTT: Home Assistant finds Tempolight by itself" })}</div>
      <div class="ig2-f"><div class="field"><label for="m-url">MQTT broker</label><input id="m-url" placeholder="mqtt://192.168.1.10:1883" value="${esc(q.url || "")}" spellcheck="false"></div>
        <div class="ig2-f2"><div class="field"><label for="m-user">User name</label><input id="m-user" autocomplete="off" value="${esc(q.username || "")}"></div>
        <div class="field"><label for="m-pass">Password</label><input id="m-pass" type="password" autocomplete="new-password" placeholder="${q.hasPassword ? "(saved)" : ""}"></div></div></div>
      <div class="ig2-row"><button class="btn primary" id="m-save" type="button">Save and connect</button><span class="ig2-st" id="m-state"></span></div>
      <ol class="ig2-steps"><li>In Home Assistant, add the Mosquitto broker add-on and the MQTT integration.</li><li>Use the same broker here.</li><li>Tempolight appears as a light with effects, a scene picker, tempo and song-part sensors, and Flash, Drop and Next buttons.</li></ol>`; },
      bind(r) { if (!admin) { r.querySelectorAll("input,button.switch,#m-save").forEach(x => x.disabled = true); return; }
        const go = () => { const b = { enabled: $("#ha-on").getAttribute("aria-checked") === "true", url: $("#m-url").value.trim(), username: $("#m-user").value.trim() }; if ($("#m-pass").value) b.password = $("#m-pass").value; return setS({ mqtt: b }); };
        bindToggle(r, "ha-on", go); $("#m-save").onclick = () => { $("#ha-on").setAttribute("aria-checked", "true"); go(); }; },
      update() { const e = $("#m-state"), q = m().mqtt; if (e) e.textContent = !q || q.state === "off" ? "" : q.state === "connected" ? "Connected" : q.state === "error" ? `Problem: ${q.error}` : "Connecting…"; } },

    // ------------------------------------------------ Apple Home (homekit.js, v1)
    homekit: { html: () => DEMO ? `<p>Apple Home talks to Tempolight on your own network, so it isn't in the online demo.</p>` : !admin ? lockedBody("homekit") : `
      <div class="ig2-box">${toggle("hk-on", "Show Tempolight in the Home app", !!HK?.enabled, { hint: "Your iPhone must be on the same network" })}</div>
      <p>Tempolight appears in Apple's Home app as a light (power, brightness, colour), a <b>Music reactive</b> switch and one switch per scene, so "Hey Siri, turn on Party mode" works.</p>
      <div class="ig2-pair" id="hk-pair" hidden><div class="ig2-qr" id="hk-qr" aria-live="polite"></div><div class="ig2-pair-t">
        <span class="ui-eyebrow">Setup code</span><b class="ig2-code" id="hk-code"></b>
        <p class="ui-meta">In the Home app: <b>+</b>, <b>Add Accessory</b>, then scan the code, or choose <b>More options</b> and pick <b id="hk-name"></b>. The Home app warns that it isn't certified: that's expected, choose <b>Add Anyway</b>.</p></div></div>
      <div id="hk-paired" hidden><span class="ui-eyebrow">Paired with</span><div class="ui-list ig2-list" id="hk-list"></div>
        <p class="ui-meta">To add more people, share your home in the Home app. To move Tempolight to another home, remove it from the Home app, then reset the pairing here.</p></div>
      <p class="ig2-warn" id="hk-err" hidden></p>
      <div class="ig2-row"><button class="btn danger" id="hk-reset" type="button">Reset the pairing</button></div>`,
      bind(r) { if (DEMO || !admin) return;
        bindToggle(r, "hk-on", v => act(() => api("PATCH", "/api/homekit", { enabled: v }), v ? "Apple Home is on" : "Apple Home is off").then(x => { HK = x; paintPills(); SHEETS.homekit.update(); }).catch(() => load()));
        $("#hk-reset").onclick = () => { if (!confirm("Reset the Apple Home pairing? Tempolight gets a new setup code and the Home app loses it: remove the old Tempolight there and add it again.")) return;
          act(() => api("POST", "/api/homekit/reset"), "Pairing reset").then(x => { HK = x; SHEETS.homekit.update(); }).catch(() => {}); }; },
      async update() { const v = HK; if (!v || !$("#hk-pair")) return;
        const showPair = v.enabled && v.state === "ready" && !v.paired; $("#hk-pair").hidden = !showPair;
        $("#hk-code").textContent = v.setupCode; $("#hk-name").textContent = v.name; $("#hk-paired").hidden = !v.paired;
        $("#hk-list").innerHTML = (v.pairings || []).map(p => `<div class="ui-row"><div class="ui-row-main"><b class="mono">${esc(p.id)}</b><small>${p.admin ? "Owner" : "Shared"}</small></div></div>`).join("");
        const err = v.error || (v.enabled && v.mdnsError ? `iPhones may not find Tempolight: ${v.mdnsError}` : ""); $("#hk-err").hidden = !err; $("#hk-err").textContent = err;
        if (showPair) { const { qrSvg } = await import("/qr.js"), box = $("#hk-qr"); if (box && box.dataset.uri !== v.setupUri) { box.dataset.uri = v.setupUri; box.innerHTML = qrSvg(v.setupUri, { px: 4 }); } } } },

    // ------------------------------------------------ WLED audio sync (Settings → Integrations, v1)
    wled: { html: () => `${settingsLocked()}<div class="ig2-box">${toggle("wl-on", "Send WLED audio sync", !!set().audioSync, { hint: "WLED's own sound-reactive effects get the music from Tempolight" })}</div>
      <p class="ui-meta">Useful when a WLED controller runs one of its own sound effects instead of Tempolight's show. Tempolight sends the levels and the beat on the network in WLED's audio sync format; turn on "Receive" in the controller's Usermods, Audio Reactive settings.</p>
      <div class="ig2-box">${toggle("wl-disc", "Look for WLED controllers on first start", !!set().autoDiscover)}</div>`,
      bind(r) { if (!admin) { r.querySelectorAll("button.switch").forEach(x => x.disabled = true); return; }
        bindToggle(r, "wl-on", v => setS({ audioSync: v })); bindToggle(r, "wl-disc", v => setS({ autoDiscover: v })); } },

    // ------------------------------------------------ Stream Deck (integrations.js, v1)
    deck: { html: () => { const sd = I.streamdeck; return `
      <ol class="ig2-steps"><li>Stream Deck 6.4 or later, on Windows or a Mac.</li><li>Open the downloaded <span class="mono">.streamDeckPlugin</span> file: Stream Deck installs it.</li><li>Drag Tempolight's actions onto keys (the Tempolight group).</li>
        <li>In a key's settings, enter this address: <span class="mono">${esc(location.host)}</span>${st().locked ? ", and the PIN (Tempolight is locked)" : ""}. All Tempolight keys share it.</li></ol>
      <p class="ui-meta">The keys show what the lights are doing: the active scene lit, the effect playing, strobe on. ${sd.available ? "" : "This Tempolight was installed without the plugin's files: the button opens the releases page."}</p>
      <div class="ig2-row"><a class="btn primary" id="sd-dl" href="${esc(sd.available ? sd.download : sd.releases)}" ${sd.available ? "download" : 'target="_blank" rel="noopener"'}>Download the plugin</a><a class="btn" href="${DOCS}streamdeck.md" target="_blank" rel="noopener">Read about the plugin</a></div>`; } },

    // ------------------------------------------------ OBS Studio (integrations.js, v1)
    obs: { html: () => { const o = I.obs; return `
      <p class="ui-meta">OBS 28 or later has the WebSocket server built in: in OBS, Tools, WebSocket Server Settings, Enable, and Show Connect Info for the password.</p>
      <div class="ig2-sec"><h3>Connection</h3>
        <div class="ig2-box">${toggle("obs-on", "Connect to OBS", o.enabled)}</div>
        <div class="ig2-f2"><div class="field"><label for="obs-url">OBS WebSocket address</label><input id="obs-url" value="${esc(o.url)}" spellcheck="false"></div>
          <div class="field"><label for="obs-pw">Password</label><input id="obs-pw" type="password" autocomplete="new-password" placeholder="${o.hasPassword ? "saved (type to change)" : "none"}"></div></div>
        <div class="ig2-row"><span class="ig2-st" id="obs-st"></span>${o.hasPassword ? `<button class="btn sm" id="obs-clr" type="button">Forget the password</button>` : ""}</div></div>
      <div class="ig2-sec"><h3>When OBS switches scene</h3>
        <div class="ig2-map" id="obs-map"></div><datalist id="obs-scenes">${(o.status?.scenes || []).map(n => `<option value="${esc(n)}">`).join("")}</datalist>
        <div class="ig2-row"><button class="btn sm" id="obs-add" type="button">${icon("plus")}Add a scene</button></div>
        <div class="ig2-f3"><div class="field"><label for="obs-ss">When the stream starts</label><select id="obs-ss">${sceneSel(o.onStreamStart)}</select></div>
          <div class="field"><label for="obs-se">When the stream stops</label><select id="obs-se">${sceneSel(o.onStreamStop)}</select></div>
          <div class="field"><label for="obs-rs">When recording starts</label><select id="obs-rs">${sceneSel(o.onRecordStart)}</select></div></div></div>
      <div class="ig2-sec"><h3>Tally light</h3>
        <div class="ig2-box">${toggle("tl-on", "A light that shows you're on air", o.tally.enabled)}</div>
        <div class="ig2-f3"><div class="field"><label for="tl-when">On while</label><select id="tl-when">${opt("recording", "Recording", o.tally.when === "recording")}${opt("streaming", "Streaming (live)", o.tally.when === "streaming")}${opt("either", "Recording or streaming", o.tally.when === "either")}</select></div>
          <div class="field"><label for="tl-zone">Where</label><select id="tl-zone">${targets(o.tally.target, false)}</select></div>
          <div class="field"><label for="tl-col">Colour</label><input type="color" id="tl-col" value="${esc(o.tally.color)}"></div></div>
        <span class="ui-meta">Make a zone for the light behind you in the room editor.</span></div>
      <div class="ui-bar ig2-sbar"><span class="ui-meta">Connection, scenes and tally</span><button class="btn primary" id="obs-save" type="button">Save the OBS settings</button></div>
      <div class="ig2-sec"><h3>Browser source</h3><p class="ui-meta">Shows the lights and what's playing in your stream. In OBS: Sources, +, Browser, paste the address, 1920 × 1080. The background is transparent.</p>
        <div class="ig2-row"><label class="check"><input type="checkbox" id="bs-pv" checked> Lights</label><label class="check"><input type="checkbox" id="bs-np" checked> Now playing</label>
          <select id="bs-c" style="width:auto" aria-label="Corner">${opt("bl", "Bottom left", true)}${opt("br", "Bottom right")}${opt("tl", "Top left")}${opt("tr", "Top right")}</select><label class="check"><input type="checkbox" id="bs-bg"> Dark background</label></div>
        <code class="ig2-url" id="bs-url"></code>
        <div class="ig2-row"><button class="btn sm" id="bs-copy" type="button">Copy the address</button><a class="btn sm" id="bs-open" target="_blank" rel="noopener">Open it</a></div></div>`; },
      bind(r) {
        const map = () => $("#obs-map"), row = x => `<div class="ig2-mrow"><input list="obs-scenes" data-k="obs" value="${esc(x.obs || "")}" placeholder="OBS scene name" aria-label="OBS scene"><span aria-hidden="true">${icon("chevron")}</span><select data-k="scene" aria-label="Tempolight scene">${sceneSel(x.scene, "Pick a scene")}</select><button class="ui-icbtn" type="button" data-del aria-label="Remove">${icon("close")}</button></div>`;
        map().innerHTML = [...I.obs.sceneMap, ...(I.obs.sceneMap.length ? [] : [{}])].map(row).join("");
        map().onclick = e => { const d = e.target.closest("[data-del]"); if (d) d.closest(".ig2-mrow").remove(); };
        $("#obs-add").onclick = () => map().insertAdjacentHTML("beforeend", row({}));
        bindToggle(r, "obs-on"); bindToggle(r, "tl-on");
        const on = id => $("#" + id).getAttribute("aria-checked") === "true";
        const body = () => ({ enabled: on("obs-on"), url: $("#obs-url").value.trim(), ...($("#obs-pw").value ? { password: $("#obs-pw").value } : {}),
          sceneMap: $$("#obs-map .ig2-mrow").map(x => ({ obs: x.querySelector("[data-k=obs]").value.trim(), scene: x.querySelector("[data-k=scene]").value })).filter(x => x.obs && x.scene),
          onStreamStart: $("#obs-ss").value, onStreamStop: $("#obs-se").value, onRecordStart: $("#obs-rs").value,
          tally: { enabled: on("tl-on"), when: $("#tl-when").value, target: $("#tl-zone").value, color: $("#tl-col").value } });
        $("#obs-save").onclick = () => act(() => api("PATCH", "/api/integrations/obs", body()), "OBS settings saved").then(reload).catch(() => {});
        if ($("#obs-clr")) $("#obs-clr").onclick = () => act(() => api("PATCH", "/api/integrations/obs", { clearPassword: true }), "Password forgotten").then(reload).catch(() => {});
        const bsUrl = () => { const p = new URLSearchParams(); if (!$("#bs-pv").checked) p.set("preview", "0"); if (!$("#bs-np").checked) p.set("np", "0"); if ($("#bs-c").value !== "bl") p.set("corner", $("#bs-c").value); if ($("#bs-bg").checked) p.set("bg", "1");
          const u = `${location.origin}/obs${p.toString() ? "?" + p : ""}`; $("#bs-url").textContent = u; $("#bs-open").href = u; return u; };
        for (const id of ["#bs-pv", "#bs-np", "#bs-c", "#bs-bg"]) $(id).onchange = bsUrl; bsUrl();
        $("#bs-copy").onclick = () => navigator.clipboard?.writeText(bsUrl()).then(() => toast("Copied"), () => toast("Select the address and copy it", true)); },
      update() { const os = $("#obs-st"), o = I?.obs; if (!os || !o) return;
        os.innerHTML = !o.enabled ? "" : o.status?.connected ? pill(`Connected · ${o.status.scene || "?"}${o.status.streaming ? " · live" : ""}${o.status.recording ? " · recording" : ""}`, "ok") : pill(o.status?.error || "Connecting…", "warn"); } },

    // ------------------------------------------------ Twitch (integrations.js, v1)
    twitch: { html: () => { const tw = I.twitch; return `
      <div class="ig2-sec"><h3>Chat commands</h3>
        <div class="ig2-box">${toggle("tw-on", "Let chat change the lights", tw.chat.enabled, { hint: "Read-only and anonymous: no account needed" })}</div>
        <div class="ig2-f3"><div class="field"><label for="tw-ch">Channel</label><input id="tw-ch" value="${esc(tw.chat.channel)}" placeholder="yourchannel" spellcheck="false"></div>
          <div class="field"><label for="tw-who">Who may use them</label><select id="tw-who">${[["everyone", "Everyone"], ["subscriber", "Subscribers, VIPs and mods"], ["vip", "VIPs and mods"], ["mod", "Mods only"]].map(([k, n]) => opt(k, n, tw.chat.who === k)).join("")}</select></div>
          <div class="field"><label for="tw-cd">Cooldown, seconds (anyone / same person)</label><div class="ig2-f2"><input id="tw-cd" type="number" min="0" max="3600" value="${tw.chat.cooldownSec}" aria-label="Cooldown for anyone"><input id="tw-ucd" type="number" min="0" max="3600" value="${tw.chat.userCooldownSec}" aria-label="Cooldown for the same person"></div></div></div>
        <div class="field"><span class="lbl">Commands</span><div class="ig2-chips">${tw.commands.map(c => `<label class="ig2-cchip"><input type="checkbox" data-cmd="${c}" ${tw.chat.commands[c] ? "checked" : ""}><span class="mono">${esc(tw.chat.prefix)}${c}${{ scene: " party", effect: " laser", flash: " red", color: " blue", strobe: "", drop: "" }[c]}</span></label>`).join("")}</div>
          <span class="help">The streamer is never held back by cooldowns; mods skip the per-person one. ${set().safe ? "Photosensitive-safe mode is on, so !strobe is refused." : ""}</span></div>
        <div class="field"><span class="lbl">Scenes chat may pick (none ticked: all)</span><div class="ig2-chips">${scenes().map(s => `<label class="ig2-cchip"><input type="checkbox" data-tsc="${esc(s.id)}" ${tw.chat.scenes.includes(s.id) ? "checked" : ""}><span>${esc(s.name)}</span></label>`).join("") || '<span class="ui-meta">No scenes yet</span>'}</div></div>
        <div class="ig2-row"><button class="btn primary" id="tw-save" type="button">Save the chat settings</button><span class="ig2-st" id="tw-st"></span><span class="ig2-st" id="tw-last"></span></div></div>
      <div class="ig2-sec"><h3>Follows, subs, raids and cheers</h3>
        <p class="ui-meta">Needs a sign-in with a Twitch application of your own: on <a href="https://dev.twitch.tv/console/apps" target="_blank" rel="noopener">dev.twitch.tv/console</a>, Register Your Application, Client Type <b>Public</b>, any OAuth redirect (for example http://localhost), then paste its Client ID here. <a href="${DOCS}integrations.md#twitch" target="_blank" rel="noopener">Step by step</a></p>
        <div class="ig2-f3"><div class="field"><label for="tw-cid">Client ID</label><input id="tw-cid" value="${esc(tw.clientId)}" spellcheck="false" autocomplete="off"></div>
          <div class="field"><label for="tw-zone">Colours show</label><select id="tw-zone">${targets(tw.target, false)}</select></div>
          <div class="field"><span class="lbl">Twitch account</span><div class="ig2-row" id="tw-auth"></div></div></div>
        <div class="ig2-box">${toggle("tw-evon", "React to channel events", tw.eventsOn)}</div>
        <div class="ig2-evs" id="tw-ev"></div>
        <div class="ig2-row"><button class="btn primary" id="tw-esave" type="button">Save the event settings</button><span class="ig2-st" id="tw-elast"></span></div></div>`; },
      bind(r) {
        bindToggle(r, "tw-on"); bindToggle(r, "tw-evon"); const on = id => $("#" + id).getAttribute("aria-checked") === "true";
        const chatBody = () => ({ chat: { enabled: on("tw-on"), channel: $("#tw-ch").value.trim(), who: $("#tw-who").value, cooldownSec: Number($("#tw-cd").value), userCooldownSec: Number($("#tw-ucd").value),
          commands: Object.fromEntries($$("[data-cmd]").map(i => [i.dataset.cmd, i.checked])), scenes: $$("[data-tsc]").filter(i => i.checked).map(i => i.dataset.tsc) } });
        $("#tw-save").onclick = () => act(() => api("PATCH", "/api/integrations/twitch", chatBody()), "Twitch chat settings saved").then(reload).catch(() => {});
        const KINDS = [["follow", "Follow"], ["subscribe", "New sub"], ["resub", "Resub"], ["gift", "Gifted subs"], ["raid", "Raid"], ["cheer", "Cheer (bits)"]];
        const evRow = ([k, n]) => { const x = I.twitch.events[k] || { type: "none" };
          return `<div class="ig2-ev" data-ev="${k}"><b>${n}</b><select data-k="type" aria-label="${n}: lights">${[["none", "Nothing"], ["flash", "Flash"], ["color", "Colour for a while"], ["strobe", "Strobe"], ["scene", "Scene"], ["effect", "Effect"], ["drop", "Drop"]].map(([v, l]) => opt(v, l, x.type === v)).join("")}</select>
            <input type="color" data-k="color" value="${esc(x.color || "#ffffff")}" aria-label="${n}: colour">
            <span class="ig2-ev-x"><select data-k="scene" ${x.type === "scene" ? "" : "hidden"} aria-label="${n}: scene">${sceneSel(x.scene, "Pick a scene")}</select><select data-k="effect" ${x.type === "effect" ? "" : "hidden"} aria-label="${n}: effect">${effects().map(e => opt(e.id, e.name, e.id === x.effect)).join("")}</select>${k === "cheer" ? `<input type="number" data-k="minBits" min="1" value="${x.minBits || 1}" title="Bits at least" aria-label="Bits at least">` : ""}</span>
            <input type="number" data-k="seconds" min="1" max="60" value="${x.seconds || (x.type === "strobe" ? 3 : 6)}" aria-label="${n}: seconds" title="Seconds"><button class="btn sm" type="button" data-evtry="${k}">Try it</button></div>`; };
        $("#tw-ev").innerHTML = `<div class="ig2-ev ig2-ev-h" aria-hidden="true"><span>Event</span><span>Lights</span><span>Colour</span><span>Scene or effect</span><span>Seconds</span><span></span></div>` + KINDS.map(evRow).join("");
        $("#tw-ev").onchange = e => { if (e.target.dataset.k === "type") { const tr = e.target.closest("[data-ev]"); tr.querySelector("[data-k=scene]").hidden = e.target.value !== "scene"; tr.querySelector("[data-k=effect]").hidden = e.target.value !== "effect"; } };
        const evBody = () => ({ clientId: $("#tw-cid").value.trim(), target: $("#tw-zone").value, eventsOn: on("tw-evon"),
          events: Object.fromEntries($$("#tw-ev [data-ev]").map(tr => { const v = k => tr.querySelector(`[data-k=${k}]`)?.value, type = v("type"), o = { type };
            if (type === "flash" || type === "color") o.color = v("color"); if (type === "color" || type === "strobe") o.seconds = Number(v("seconds")); if (type === "scene") o.scene = v("scene"); if (type === "effect") o.effect = v("effect"); if (tr.dataset.ev === "cheer") o.minBits = Number(v("minBits")) || 1;
            return [tr.dataset.ev, o]; })) });
        $("#tw-esave").onclick = () => act(() => api("PATCH", "/api/integrations/twitch", evBody()), "Twitch event settings saved").then(reload).catch(() => {});
        $("#tw-ev").onclick = e => { const k = e.target.dataset.evtry; if (k) act(() => api("PATCH", "/api/integrations/twitch", evBody()).then(() => api("POST", "/api/integrations/twitch/test", { kind: k }))).catch(() => {}); }; },
      update() { const tw = I?.twitch; if (!tw || !$("#tw-st")) return;
        const c = tw.status; $("#tw-st").innerHTML = !tw.chat.enabled ? pill("Chat off") : c?.joined ? pill(`Reading #${c.channel}`, "ok") : pill(c?.error || "Connecting…", "warn");
        const tl = $("#tw-last"); if (tl && tw.last) tl.textContent = `Last: ${tw.last.user} used !${tw.last.cmd}${tw.last.ok ? "" : ` (refused: ${{ off: "turned off", role: "not allowed", cooldown: "cooldown", "user-cooldown": "their cooldown", unknown: "not found", missing: "nothing after it", safe: "safe mode" }[tw.last.why] || tw.last.why})`} ${ago(tw.last.at)}`;
        const ta = $("#tw-auth"); if (ta && !ta.contains(document.activeElement)) {
          ta.innerHTML = tw.auth ? `${pill(`Signed in as ${tw.auth.login}${tw.eventsub ? tw.eventsub.connected ? ` · ${tw.eventsub.subscribed.length} events` : " · connecting" : ""}`, tw.eventsub?.connected ? "ok" : "warn")}<button class="btn sm" id="tw-out" type="button">Sign out</button>`
            : tw.login ? `<span>Go to <a href="${esc(tw.login.uri)}" target="_blank" rel="noopener">${esc(tw.login.uri.replace(/^https?:\/\/(www\.)?/, ""))}</a> and enter</span> <b class="ig2-code">${esc(tw.login.userCode)}</b>${tw.login.error ? pill(tw.login.error, "bad") : ""}<button class="btn sm" id="tw-out" type="button">Cancel</button>`
            : `<button class="btn sm primary" id="tw-in" type="button">Connect Twitch</button>`;
          if ($("#tw-in")) $("#tw-in").onclick = () => act(() => api("POST", "/api/integrations/twitch/login", { clientId: $("#tw-cid").value.trim() })).then(reload).catch(() => {});
          if ($("#tw-out")) $("#tw-out").onclick = () => act(() => api("DELETE", "/api/integrations/twitch/login"), "Signed out of Twitch").then(reload).catch(() => {}); }
        const te = $("#tw-elast"); if (te) te.textContent = [tw.eventsub?.failed?.length ? `Not allowed: ${tw.eventsub.failed.join("; ")}` : "", tw.lastEvent ? `Last: ${tw.lastEvent.text} ${ago(tw.lastEvent.at)}` : ""].filter(Boolean).join(" · "); } },

    // ------------------------------------------------ Discord (integrations.js, v1)
    discord: { html: () => { const dc = I.discord; return `
      <p class="ui-meta">Posts to a channel through a webhook: in Discord, Server Settings, Integrations, Webhooks, New Webhook, Copy Webhook URL.</p>
      <div class="field"><label for="dc-url">Webhook address</label><input id="dc-url" type="password" autocomplete="off" placeholder="${dc.hasWebhook ? esc(dc.webhook) + " (saved; paste to change)" : "https://discord.com/api/webhooks/…"}"></div>
      <div class="field"><label for="dc-name">Posts as</label><input id="dc-name" value="${esc(dc.username)}"></div>
      <div class="ig2-box">${toggle("dc-np", "Now playing", dc.nowPlaying)}${toggle("dc-sc", "Scene changes", dc.scenes)}${toggle("dc-tw", "Twitch follows, subs and raids", dc.twitch)}</div>
      <div class="ig2-row"><button class="btn primary" id="dc-save" type="button">Save</button><button class="btn" id="dc-test" type="button" ${dc.hasWebhook ? "" : "disabled"}>Send a test message</button>${dc.hasWebhook ? `<button class="btn danger" id="dc-clr" type="button">Remove the webhook</button>` : ""}<span class="ig2-st" id="dc-st"></span></div>
      <p class="ui-meta">Commands from Discord (a bot) aren't there yet: see <a href="${DOCS}integrations.md#discord" target="_blank" rel="noopener">the plan</a>.</p>`; },
      bind(r) { for (const id of ["dc-np", "dc-sc", "dc-tw"]) bindToggle(r, id); const on = id => $("#" + id).getAttribute("aria-checked") === "true";
        $("#dc-save").onclick = () => act(() => api("PATCH", "/api/integrations/discord", { ...($("#dc-url").value.trim() ? { webhook: $("#dc-url").value.trim() } : {}), username: $("#dc-name").value, nowPlaying: on("dc-np"), scenes: on("dc-sc"), twitch: on("dc-tw") }), "Discord settings saved").then(reload).catch(() => {});
        $("#dc-test").onclick = () => act(() => api("POST", "/api/integrations/discord/test"), "Sent: look in your Discord channel").catch(() => {});
        if ($("#dc-clr")) $("#dc-clr").onclick = () => act(() => api("PATCH", "/api/integrations/discord", { webhook: "" }), "Webhook removed").then(reload).catch(() => {}); },
      update() { const ds = $("#dc-st"), d = I?.discord; if (!ds || !d) return; const s = d.status || {};
        ds.innerHTML = !d.hasWebhook ? "" : s.error ? pill(s.error, "warn") : pill(s.sent ? `${s.sent} posted · last ${ago(s.lastAt)}` : "Ready", "ok"); } },

    // ------------------------------------------------ Pro DJ Link, Ableton Link, OSC (Settings → Integrations, v1)
    djlink: { html: () => DEMO ? `<p>Pro DJ Link listens on your network, so it isn't in the online demo.</p>` : `${settingsLocked()}<div class="ig2-box">${toggle("dj-on", "Take the beat from CDJs and XDJs", !!set().djlink?.enabled, { hint: "Listens only: it never sends anything to the players" })}</div>
      <p class="ui-meta">Connect the players and this computer to the same network switch or router. Tempolight follows the master player's tempo and beat, and the bar from its beat grid.</p><p class="ig2-st" id="dj-st"></p>`,
      bind(r) { if (DEMO) return; if (!admin) { $("#dj-on").disabled = true; return; } bindToggle(r, "dj-on", v => setS({ djlink: { enabled: v } })); },
      update() { const e = $("#dj-st"), d = m().djlink; if (e) e.textContent = d ? `Following ${d.name}: ${d.bpm.toFixed(1)} BPM, beat ${d.beatInBar}` : set().djlink?.enabled ? "Listening: no player is sending beats yet." : ""; } },
    link: { html: () => DEMO ? `<p>Ableton Link works on your own network, so it isn't in the online demo.</p>` : `${settingsLocked()}<div class="ig2-box">${toggle("lk-on", "Follow a Link session", !!set().link?.enabled, { hint: "Listens only: it never changes the session's tempo" })}</div>
      <p class="ui-meta">Live, Traktor, Bitwig, Serato and many phone apps join a Link session on the same network. Tempolight takes its tempo and beat, and keeps hearing the music for the song's parts.</p><p class="ig2-st" id="lk-st"></p>`,
      bind(r) { if (DEMO) return; if (!admin) { $("#lk-on").disabled = true; return; } bindToggle(r, "lk-on", v => setS({ link: { enabled: v } })); },
      update() { const e = $("#lk-st"); if (e) e.textContent = m().source === "link" ? `Following: ${m().sourceLabel || "a Link session"}` : set().link?.enabled ? "Listening for a Link session." : ""; } },
    osc: { html: () => { const o = set().osc || {}; return `${settingsLocked()}<div class="ig2-box">${toggle("osc-on", "OSC control", !!o.enabled, { hint: "Listens on a UDP port of this computer" })}</div>
      <div class="field"><label for="osc-port">UDP port</label><input type="number" id="osc-port" value="${o.port}" style="max-width:140px"></div>
      <div class="ig2-code-b"><code>/tempolight/effect laser</code><code>/tempolight/scene Party</code><code>/tempolight/flash</code><code>/tempolight/blackout 1</code><code>/tempolight/brightness 0.5</code></div>
      <div class="ig2-row"><a class="btn" href="${DOCS}api.md" target="_blank" rel="noopener">Read the OSC addresses</a></div>`; },
      bind(r) { if (!admin) { r.querySelectorAll("input,button.switch").forEach(x => x.disabled = true); return; }
        bindToggle(r, "osc-on", v => setS({ osc: { enabled: v } })); $("#osc-port").onchange = e => setS({ osc: { port: Number(e.target.value) } }); } },

    // ------------------------------------------------ MIDI (the Live pads page, v1: Web MIDI runs in the browser)
    midi: { html: () => `<p>MIDI runs in this browser (Chrome or Edge on a computer): plug the controller or interface into this computer.</p>
      <ol class="ig2-steps"><li>Open Live pads and MIDI and connect the controller.</li><li><b>Follow MIDI clock</b>: pick the input. Tempolight takes the tempo and the bar from Start and Song Position.</li><li><b>Learn</b>: tap a pad, then hit a key on the controller to map it.</li></ol>
      <p class="ig2-st" id="mc-st2"></p>
      <div class="ig2-row"><a class="btn primary" href="#/live">Open Live pads and MIDI</a></div>`,
      update() { const e = $("#mc-st2"), c = m().midiClock; if (e) e.textContent = c ? (c.running ? `Following ${c.input}: ${c.bpm} BPM` : c.stopped ? "Stopped: waiting for Start or Continue" : "Waiting for clock…") : ""; } },

    // ------------------------------------------------ games (integrations.js gameBox, v1)
    cs2: { html: () => gameHtml("cs2"), bind: r => gameBind(r, "cs2"), update: () => gameUpdate("cs2") },
    dota2: { html: () => gameHtml("dota2"), bind: r => gameBind(r, "dota2"), update: () => gameUpdate("dota2") },

    // ------------------------------------------------ developers
    api: { html: () => `<p>Home Assistant, Stream Deck, Shortcuts and your own scripts can call the JSON API at <span class="mono">${esc(location.origin)}/api/</span>.${st().locked ? " Tempolight is locked: send the PIN's token as described in the docs." : ""}</p>
      <div class="ig2-code-b"><code>POST /api/scenes/&lt;id&gt;/apply</code><code>POST /api/action {"type": "flash"}</code><code>PATCH /api/show {"effect": "laser"}</code><code>POST /api/sleep {"minutes": 30}</code><code>GET /api/state</code></div>
      <div class="ig2-row"><a class="btn primary" href="https://tempolight.pages.dev/docs/api-reference/" target="_blank" rel="noopener">Open the API reference</a><a class="btn" href="${DOCS}api.md" target="_blank" rel="noopener">Read docs/api.md</a></div>` },
    docs: { html: () => `<div class="ig2-box">${toggle("docs-try", "Let the docs site try API calls", !!I.docs?.tryIt)}</div>
      <p class="ui-meta">Browsers may not call Tempolight from other websites. Turn this on to send requests from the <a href="https://tempolight.pages.dev/docs/api-reference/" target="_blank" rel="noopener">API reference</a> (${(I.docs?.origins || []).map(esc).join(", ")}) to this Tempolight; the PIN lock still applies. Turn it off again when you're done.</p>`,
      bind(r) { bindToggle(r, "docs-try", v => act(() => api("PATCH", "/api/integrations/docs", { tryIt: v }), v ? "The docs site may try API calls" : "The docs site can no longer try API calls").then(reload).catch(() => {})); } },
  };

  function gameHtml(g) {
    const c = I.games[g], dota = g === "dota2";
    const evs = dota ? [["kills", "Kills"], ["roshan", "Roshan and Aegis"], ["rounds", "Win or loss"], ["daynight", "Day and night"]] : [["kills", "Kills"], ["flashbang", "Flashbangs"], ["bomb", "The bomb"], ["rounds", "Rounds won and lost"]];
    const tries = dota ? [["kill", "Kill"], ["low", "Low health"], ["roshan", "Roshan"], ["night", "Night"], ["day", "Day"], ["win", "Win"]] : [["kill", "Kill"], ["flash", "Flashbang"], ["bomb", "Bomb"], ["low", "Low health"], ["win", "Round won"], ["lose", "Round lost"]];
    return `<p class="ui-meta">The game sends its state to Tempolight while you play (Valve Game State Integration); the lights show it on top of the music.${set().safe ? " Photosensitive-safe mode is on: game flashes are gentler and pulses slower." : ""}</p>
      <div class="ig2-box">${toggle("g-on", `React to ${c.name}`, c.enabled)}</div>
      <div class="ig2-sec"><h3>Set it up</h3><ol class="ig2-steps"><li>Download the config file.</li><li>Put <span class="mono">${esc(c.file)}</span> in <span class="mono">Steam/steamapps/common/${dota ? "dota 2 beta" : "Counter-Strike Global Offensive"}/${esc(c.folder)}/</span>${dota ? ", and add <span class=\"mono\">-gamestateintegration</span> to Dota 2's launch options" : ""}.</li><li>Restart the game. It must reach <span class="mono">${esc(location.origin)}</span>.</li></ol>
        <div class="ig2-row"><button class="btn primary" type="button" id="g-cfg">Download the config file</button><button class="btn" type="button" id="g-tok">Make a new token</button><span class="ig2-st" id="g-st"></span></div></div>
      <div class="ig2-sec"><h3>How it shows</h3>
        <div class="ig2-f3"><div class="field"><label>Strength <output>${Math.round(c.intensity * 100)}%</output></label><input type="range" data-g="intensity" min="0" max="1" step="0.05" value="${c.intensity}"></div>
          <div class="field"><label>Over the music</label><select data-g="mode">${opt("blend", "Blend in", c.mode === "blend")}${opt("takeover", "Take over", c.mode === "takeover")}</select></div>
          <div class="field"><label>Health colour</label><select data-g="healthTarget">${targets(c.healthTarget)}</select></div>
          ${dota ? `<div class="field"><label>Mana (blue)</label><select data-g="manaTarget">${targets(c.manaTarget)}</select></div><div class="field"><label>Day and night</label><select data-g="ambientTarget">${targets(c.ambientTarget)}</select></div>` : ""}
          <div class="field"><label>Flashes and events</label><select data-g="effectsTarget">${targets(c.effectsTarget)}</select></div></div>
        <div class="ig2-chips">${evs.map(([k, n]) => `<label class="ig2-cchip"><input type="checkbox" data-g="${k}" ${c[k] !== false ? "checked" : ""}><span>${n}</span></label>`).join("")}</div></div>
      <div class="ig2-sec"><h3>Try it</h3><div class="ig2-row">${tries.map(([k, n]) => `<button class="btn sm" type="button" data-try="${k}" ${c.enabled ? "" : "disabled"}>${n}</button>`).join("")}</div></div>`;
  }
  function gameBind(r, g) {
    const patch = (b, ok) => act(() => api("PATCH", `/api/integrations/games/${g}`, b), ok).then(x => { I.games[g] = x; paintPills(); return x; }).catch(() => load().catch(() => {}));
    bindToggle(r, "g-on", v => patch({ enabled: v }, `${I.games[g].name}: ${v ? "on" : "off"}`).then(() => cur?.fill()));
    for (const inp of r.querySelectorAll("[data-g]")) { const k = inp.dataset.g;
      if (inp.type === "range") inp.oninput = () => { inp.previousElementSibling.querySelector("output").textContent = Math.round(inp.value * 100) + "%"; };
      inp.onchange = () => patch({ [k]: inp.type === "checkbox" ? inp.checked : inp.type === "range" ? Number(inp.value) : inp.value }); }
    $("#g-cfg").onclick = async () => { const x = await act(() => api("GET", `/api/integrations/games/${g}/cfg?url=${encodeURIComponent(location.origin)}`)).catch(() => null); if (!x) return;
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([x.content], { type: "text/plain" })); a.download = x.filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(`Saved ${x.filename}: put it in …/${x.folder}/`); load().catch(() => {}); };
    $("#g-tok").onclick = () => { if (confirm("Make a new token? The config file you installed stops working until you download it again.")) act(() => api("POST", `/api/integrations/games/${g}/token`), "New token made: download the config file again").then(reload).catch(() => {}); };
    r.querySelectorAll("[data-try]").forEach(b => b.onclick = () => act(() => api("POST", `/api/integrations/games/${g}/test`, { what: b.dataset.try })).catch(() => {}));
  }
  function gameUpdate(g) { const e = $("#g-st"), c = I?.games[g]; if (!e || !c) return; const s = c.status || {};
    e.innerHTML = !c.enabled ? "" : s.live ? pill(`${s.map || "In game"}${s.health != null ? ` · ${s.health} HP` : ""}${s.bomb ? " · bomb planted" : ""}`, "ok") : pill(s.lastAt ? `Last heard ${ago(s.lastAt)}` : "Waiting for the game", s.lastAt ? "warn" : ""); }

  return {
    destroy() { gone = true; clearTimeout(timer); },
    onStatus() { paintPills(); if (cur && ["ha", "djlink", "link", "midi"].includes(cur.id)) cur.update(); },
    onChanged(w) { if (w.has("lock")) { route(); return; } if (w.has("homekit")) load(); paintPills(); },
  };
}
