// Integrations page: Stream Deck, OBS Studio, game events (CS2, Dota 2), Twitch and Discord (the server side is in
// packages/server/src/integrations). Admin-only: with a PIN lock, guests never see these settings, and passwords,
// tokens and the Discord webhook never come back from the server (it only says whether one is saved).
import { app, api, act, toast, esc, panel, opt, $, $$, unlocked, DEMO, route } from "/app.js";

const DOCS = "https://github.com/D4RKGEEK/tempolight/blob/main/docs/";
let styled = false;
function style() { if (styled) return; styled = true; const s = document.createElement("style"); s.textContent = `
.ig-st { font-size: 12.5px; color: var(--muted); }
.ig-steps { margin: 0; padding-left: 20px; display: grid; gap: 4px; font-size: 13px; }
.ig-url { font: 12px var(--mono); word-break: break-all; background: var(--panel-2); border: 1px solid var(--line-2); border-radius: 6px; padding: 6px 8px; }
.ig-code { font: 600 22px var(--mono); letter-spacing: .12em; }
.ig-map td { padding: 4px 6px 4px 0; } .ig-map input, .ig-map select { width: 100%; min-width: 120px; }
.ig-map input.ig-col, .ig-col { width: 44px; min-width: 0; height: 32px; padding: 0; border: 1px solid var(--line); border-radius: 6px; background: none; flex: none; }
.ig-ev { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.ig-game { display: grid; gap: 12px; }
@media (max-width: 820px) { .ig-map input, .ig-map select { min-width: 90px; } }`; document.head.appendChild(s); }

const badge = (ok, text, warn) => `<span class="badge ${ok ? "live" : warn ? "warn" : ""}"><i></i>${esc(text)}</span>`;
const ago = t => { if (!t) return "never"; const s = Math.round((Date.now() - t) / 1000); return s < 2 ? "just now" : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

export function integrationsPage(el) {
  style();
  if (DEMO) { el.innerHTML = panel("Integrations", "", "", `<div class="pb stack"><p>Stream Deck, OBS Studio, game events (Counter-Strike 2, Dota 2), Twitch chat and Discord connect to Tempolight running on your computer or Raspberry Pi, so they aren't in the online demo.</p>
    <p><a href="${DOCS}integrations.md" target="_blank" rel="noopener">How they work</a> · <a href="${DOCS}streamdeck.md" target="_blank" rel="noopener">Stream Deck plugin</a></p></div>`); return {}; }
  if (!unlocked()) { el.innerHTML = panel("Locked", "", "", `<div class="pb stack"><p>Integrations hold passwords and tokens, so only someone with the PIN can see or change them.</p><p><a class="btn primary" href="#/settings">Unlock in Settings</a></p></div>`); return {}; }
  let I = null, timer = null, gone = false;
  const st = () => app.state, scenes = () => st().scenes, effects = () => st().effects;
  const targets = (v, withOff = true) => [["all", "The whole room"], ...(st().room.zones || []).map(z => ["zone:" + z.id, "Zone: " + z.name]), ...st().devices.map(d => ["dev:" + d.id, "Only " + d.name]), ...(withOff ? [["off", "Nowhere (off)"]] : [])]
    .map(([k, n]) => opt(k, n, k === v)).join("") + (v && !/^(all|off)$/.test(v) && ![...(st().room.zones || []).map(z => "zone:" + z.id), ...st().devices.map(d => "dev:" + d.id)].includes(v) ? opt(v, v + " (gone)", true) : "");
  const sceneSel = (v, none = "Nothing") => opt("", none, !v) + scenes().map(s => opt(s.id, s.name, s.id === v)).join("");
  const load = async () => { I = await api("GET", "/api/integrations"); if (!gone) render(); };
  el.innerHTML = `<div class="callout span-12 faint">Loading…</div>`;
  load().catch(e => { el.innerHTML = `<div class="callout err span-12">${esc(e.message)}</div>`; });

  function render() {
    const o = I.obs, sd = I.streamdeck, tw = I.twitch, dc = I.discord, origin = location.origin;
    el.innerHTML = `
    ${panel("Stream Deck", "Keys and dials for your lights", `<a class="btn primary" id="sd-dl" href="${esc(sd.available ? sd.download : sd.releases)}" ${sd.available ? "download" : 'target="_blank" rel="noopener"'}>Download the plugin</a>`, `<div class="pb stack">
      <p style="margin:0">Scenes, effects and live pads (flash, strobe, blackout, build-up and drop, pressed or held) on keys, the lights' power, and brightness on a Stream Deck + dial. The keys show what the lights are doing: the active scene lit, the effect playing, strobe on.</p>
      <ol class="ig-steps"><li>Stream Deck 6.4 or later, on Windows or a Mac.</li><li>Open the downloaded <span class="mono">.streamDeckPlugin</span> file: Stream Deck installs it.</li><li>Drag Tempolight's actions onto keys (the Tempolight group).</li>
      <li>In a key's settings, enter this address: <span class="mono">${esc(location.host)}</span>${st().locked ? ", and the PIN (Tempolight is locked)" : ""}. All Tempolight keys share it.</li></ol>
      <p class="faint" style="margin:0;font-size:12.5px">${sd.available ? "" : "This Tempolight was installed without the plugin's files: the button opens the releases page. "}<a href="${DOCS}streamdeck.md" target="_blank" rel="noopener">More about the plugin</a></p></div>`)}

    ${panel("OBS Studio", "", `<span id="obs-st"></span>`, `<div class="pb stack">
      <p style="margin:0" class="faint">OBS 28 or later has the WebSocket server built in: in OBS, Tools → WebSocket Server Settings → Enable, and Show Connect Info for the password.</p>
      <div class="controls">
        <label class="check"><input type="checkbox" id="obs-on" ${o.enabled ? "checked" : ""}> Connect to OBS</label>
        <div class="field"><label for="obs-url">OBS WebSocket address</label><input id="obs-url" value="${esc(o.url)}" spellcheck="false"></div>
        <div class="field"><label for="obs-pw">Password</label><input id="obs-pw" type="password" autocomplete="new-password" placeholder="${o.hasPassword ? "saved (type to change)" : "none"}"></div>
        <div class="field"><span class="lbl">&nbsp;</span><div class="row"><button class="btn primary" id="obs-save" type="button">Save</button>${o.hasPassword ? `<button class="btn sm" id="obs-clr" type="button">Forget password</button>` : ""}</div></div>
      </div>
      <div class="field"><span class="lbl">When OBS switches scene</span><div class="tablewrap"><table class="ig-map"><thead><tr><th>OBS scene</th><th>Tempolight scene</th><th></th></tr></thead><tbody id="obs-map"></tbody></table></div>
        <datalist id="obs-scenes">${(o.status?.scenes || []).map(n => `<option value="${esc(n)}">`).join("")}</datalist><div class="row"><button class="btn sm" id="obs-add" type="button">Add a row</button></div></div>
      <div class="controls">
        <div class="field"><label for="obs-ss">When the stream starts</label><select id="obs-ss">${sceneSel(o.onStreamStart)}</select></div>
        <div class="field"><label for="obs-se">When the stream stops</label><select id="obs-se">${sceneSel(o.onStreamStop)}</select></div>
        <div class="field"><label for="obs-rs">When recording starts</label><select id="obs-rs">${sceneSel(o.onRecordStart)}</select></div>
      </div>
      <div class="controls">
        <label class="check"><input type="checkbox" id="tl-on" ${o.tally.enabled ? "checked" : ""}> Tally light</label>
        <div class="field"><label for="tl-when">On while</label><select id="tl-when">${opt("recording", "Recording", o.tally.when === "recording")}${opt("streaming", "Streaming (live)", o.tally.when === "streaming")}${opt("either", "Recording or streaming", o.tally.when === "either")}</select></div>
        <div class="field"><label for="tl-zone">Where</label><select id="tl-zone">${targets(o.tally.target, false)}</select><span class="help">Make a zone for the light behind you on the Effects page.</span></div>
        <div class="field"><label for="tl-col">Colour</label><input type="color" class="ig-col" id="tl-col" value="${esc(o.tally.color)}"></div>
      </div>
      <div class="field"><span class="lbl">Browser source (shows the lights and what's playing in your stream)</span>
        <div class="row"><label class="check"><input type="checkbox" id="bs-pv" checked> Lights</label><label class="check"><input type="checkbox" id="bs-np" checked> Now playing</label>
          <select id="bs-c" style="width:auto">${opt("bl", "Bottom left", true)}${opt("br", "Bottom right")}${opt("tl", "Top left")}${opt("tr", "Top right")}</select><label class="check"><input type="checkbox" id="bs-bg"> Dark background</label></div>
        <div class="row"><span class="ig-url" id="bs-url"></span><button class="btn sm" id="bs-copy" type="button">Copy</button><a class="btn sm" id="bs-open" target="_blank" rel="noopener">Open</a></div>
        <span class="help">In OBS: Sources → + → Browser, paste the address, 1920 × 1080. The background is transparent.</span></div>
    </div>`)}

    ${panel("Games", "Valve Game State Integration", "", `<div class="pb stack"><p style="margin:0" class="faint">The game sends its state to Tempolight while you play; the lights show your health, flashbangs, the bomb, kills and rounds on top of the music. Download the game's config file, put it in the folder shown, and restart the game.${st().settings.safe ? " Photosensitive-safe mode is on: game flashes are gentler and pulses slower." : ""}</p>
      <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:16px">${["cs2", "dota2"].map(gameBox).join("")}</div></div>`)}

    ${panel("Twitch", "", `<span id="tw-st"></span>`, `<div class="pb stack">
      <div class="controls">
        <label class="check"><input type="checkbox" id="tw-on" ${tw.chat.enabled ? "checked" : ""}> Chat commands</label>
        <div class="field"><label for="tw-ch">Channel</label><input id="tw-ch" value="${esc(tw.chat.channel)}" placeholder="yourchannel" spellcheck="false"></div>
        <div class="field"><label for="tw-who">Who may use them</label><select id="tw-who">${[["everyone", "Everyone"], ["subscriber", "Subscribers, VIPs and mods"], ["vip", "VIPs and mods"], ["mod", "Mods only"]].map(([k, n]) => opt(k, n, tw.chat.who === k)).join("")}</select></div>
        <div class="field"><label for="tw-cd">Cooldown (s, any user / same user)</label><div class="row" style="flex-wrap:nowrap"><input id="tw-cd" type="number" min="0" max="3600" value="${tw.chat.cooldownSec}"><input id="tw-ucd" type="number" min="0" max="3600" value="${tw.chat.userCooldownSec}"></div></div>
      </div>
      <div class="field"><span class="lbl">Commands</span><div class="ig-ev">${tw.commands.map(c => `<label class="check"><input type="checkbox" data-cmd="${c}" ${tw.chat.commands[c] ? "checked" : ""}> <span class="mono">${esc(tw.chat.prefix)}${c}</span>${{ scene: " party", effect: " laser", flash: " red", color: " blue", strobe: "", drop: "" }[c]}</label>`).join("")}</div>
        <span class="help">Read-only and anonymous: no account needed. The streamer is never held back by cooldowns; mods skip the per-user one. ${st().settings.safe ? "Photosensitive-safe mode is on, so !strobe is refused." : ""}</span></div>
      <div class="field"><span class="lbl">Scenes chat may pick (none ticked: all)</span><div class="ig-ev">${scenes().map(s => `<label class="check"><input type="checkbox" data-tsc="${esc(s.id)}" ${tw.chat.scenes.includes(s.id) ? "checked" : ""}> ${esc(s.name)}</label>`).join("")}</div></div>
      <div class="row"><button class="btn primary" id="tw-save" type="button">Save chat settings</button><span class="ig-st" id="tw-last"></span></div>
      <hr style="border:0;border-top:1px solid var(--line-2);width:100%">
      <div class="field"><span class="lbl">Follows, subs, raids and cheers (EventSub)</span><span class="help">Needs a sign-in with a Twitch application of your own: on <a href="https://dev.twitch.tv/console/apps" target="_blank" rel="noopener">dev.twitch.tv/console</a>, Register Your Application, Client Type <b>Public</b>, any OAuth redirect (for example http://localhost), then paste its Client ID here. <a href="${DOCS}integrations.md#twitch" target="_blank" rel="noopener">Step by step</a></span></div>
      <div class="controls">
        <div class="field"><label for="tw-cid">Client ID</label><input id="tw-cid" value="${esc(tw.clientId)}" spellcheck="false" autocomplete="off"></div>
        <div class="field"><span class="lbl">Twitch account</span><div class="row" id="tw-auth"></div></div>
        <div class="field"><label for="tw-zone">Colours show</label><select id="tw-zone">${targets(tw.target, false)}</select></div>
        <label class="check"><input type="checkbox" id="tw-evon" ${tw.eventsOn ? "checked" : ""}> React to channel events</label>
      </div>
      <div class="tablewrap"><table class="ig-map"><thead><tr><th>Event</th><th>Lights</th><th>Colour</th><th>Scene / effect</th><th>Seconds</th><th></th></tr></thead><tbody id="tw-ev"></tbody></table></div>
      <div class="row"><button class="btn primary" id="tw-esave" type="button">Save event settings</button><span class="ig-st" id="tw-elast"></span></div>
    </div>`)}

    ${panel("Discord", "", `<span id="dc-st"></span>`, `<div class="pb stack">
      <p style="margin:0" class="faint">Posts to a channel through a webhook: in Discord, Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.</p>
      <div class="controls">
        <div class="field" style="grid-column:span 2"><label for="dc-url">Webhook address</label><input id="dc-url" type="password" autocomplete="off" placeholder="${dc.hasWebhook ? esc(dc.webhook) + " (saved; paste to change)" : "https://discord.com/api/webhooks/…"}"></div>
        <div class="field"><label for="dc-name">Posts as</label><input id="dc-name" value="${esc(dc.username)}"></div>
        <div class="field"><span class="lbl">Post</span><label class="check"><input type="checkbox" id="dc-np" ${dc.nowPlaying ? "checked" : ""}> Now playing</label><label class="check"><input type="checkbox" id="dc-sc" ${dc.scenes ? "checked" : ""}> Scene changes</label><label class="check"><input type="checkbox" id="dc-tw" ${dc.twitch ? "checked" : ""}> Twitch follows, subs and raids</label></div>
      </div>
      <div class="row"><button class="btn primary" id="dc-save" type="button">Save</button><button class="btn" id="dc-test" type="button" ${dc.hasWebhook ? "" : "disabled"}>Send a test message</button>${dc.hasWebhook ? `<button class="btn sm" id="dc-clr" type="button">Remove webhook</button>` : ""}</div>
      <p class="faint" style="margin:0;font-size:12.5px">Commands from Discord (a bot) aren't there yet: see <a href="${DOCS}integrations.md#discord" target="_blank" rel="noopener">the plan</a>.</p>
    </div>`)}

    ${panel("Docs site", "The API reference's Try it panel", "", `<div class="pb stack">
      <label class="check"><input type="checkbox" id="docs-try" ${I.docs?.tryIt ? "checked" : ""}> Let the docs site try API calls</label>
      <p class="faint" style="margin:0;font-size:12.5px">Browsers may not call Tempolight from other websites. Turn this on to send requests from the <a href="https://tempolight.pages.dev/docs/api-reference/" target="_blank" rel="noopener">API reference</a> (${(I.docs?.origins || []).map(esc).join(", ")}) to this Tempolight; the PIN lock still applies. Turn it off again when you're done.</p>
    </div>`)}`;
    bind(); update();
  }

  function gameBox(g) {
    const c = I.games[g], dota = g === "dota2";
    const evs = dota ? [["kills", "Kills"], ["roshan", "Roshan and Aegis"], ["rounds", "Win or loss"], ["daynight", "Day and night"]] : [["kills", "Kills"], ["flashbang", "Flashbangs"], ["bomb", "The bomb"], ["rounds", "Rounds won and lost"]];
    const tries = dota ? [["kill", "Kill"], ["low", "Low health"], ["roshan", "Roshan"], ["night", "Night"], ["day", "Day"], ["win", "Win"]] : [["kill", "Kill"], ["flash", "Flashbang"], ["bomb", "Bomb"], ["low", "Low health"], ["win", "Round won"], ["lose", "Round lost"]];
    return `<div class="ig-game" data-game="${g}"><div class="row" style="justify-content:space-between"><b>${esc(c.name)}</b><span id="g-st-${g}"></span></div>
      <div class="controls" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        <label class="check"><input type="checkbox" data-g="enabled" ${c.enabled ? "checked" : ""}> On</label>
        <div class="field"><label>Strength <output>${Math.round(c.intensity * 100)}%</output></label><input type="range" data-g="intensity" min="0" max="1" step="0.05" value="${c.intensity}"></div>
        <div class="field"><label>Over the music</label><select data-g="mode">${opt("blend", "Blend in", c.mode === "blend")}${opt("takeover", "Take over", c.mode === "takeover")}</select></div>
        <div class="field"><label>Health colour</label><select data-g="healthTarget">${targets(c.healthTarget)}</select></div>
        ${dota ? `<div class="field"><label>Mana (blue)</label><select data-g="manaTarget">${targets(c.manaTarget)}</select></div><div class="field"><label>Day and night</label><select data-g="ambientTarget">${targets(c.ambientTarget)}</select></div>` : ""}
        <div class="field"><label>Flashes and events</label><select data-g="effectsTarget">${targets(c.effectsTarget)}</select></div>
      </div>
      <div class="ig-ev">${evs.map(([k, n]) => `<label class="check"><input type="checkbox" data-g="${k}" ${c[k] !== false ? "checked" : ""}> ${n}</label>`).join("")}</div>
      <div class="row"><button class="btn sm primary" type="button" data-cfg="${g}">Download the config file</button><button class="btn sm" type="button" data-tok="${g}">New token</button></div>
      <span class="help" style="font-size:12px;color:var(--faint)">Put <span class="mono">${esc(c.file)}</span> in <span class="mono">Steam/steamapps/common/${dota ? "dota 2 beta" : "Counter-Strike Global Offensive"}/${esc(c.folder)}/</span>${dota ? ", and add <span class=\"mono\">-gamestateintegration</span> to Dota 2's launch options" : ""}. The game must reach <span class="mono">${esc(location.origin)}</span>.</span>
      <div class="row"><span class="ig-st">Try:</span>${tries.map(([k, n]) => `<button class="btn sm" type="button" data-try="${g}:${k}" ${c.enabled ? "" : "disabled"}>${n}</button>`).join("")}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- events
  function bind() {
    // Stream Deck: nothing to bind. OBS:
    const map = () => $("#obs-map"), row = r => `<tr><td><input list="obs-scenes" data-k="obs" value="${esc(r.obs || "")}" placeholder="OBS scene name"></td><td><select data-k="scene">${sceneSel(r.scene, "Pick a scene")}</select></td><td><button class="btn sm" type="button" data-del>Remove</button></td></tr>`;
    map().innerHTML = [...I.obs.sceneMap, ...(I.obs.sceneMap.length ? [] : [{}])].map(row).join("");
    map().onclick = e => { if (e.target.matches("[data-del]")) e.target.closest("tr").remove(); };
    $("#obs-add").onclick = () => map().insertAdjacentHTML("beforeend", row({}));
    const obsBody = () => ({ enabled: $("#obs-on").checked, url: $("#obs-url").value.trim(), ...($("#obs-pw").value ? { password: $("#obs-pw").value } : {}),
      sceneMap: $$("#obs-map tr").map(tr => ({ obs: tr.querySelector("[data-k=obs]").value.trim(), scene: tr.querySelector("[data-k=scene]").value })).filter(r => r.obs && r.scene),
      onStreamStart: $("#obs-ss").value, onStreamStop: $("#obs-se").value, onRecordStart: $("#obs-rs").value,
      tally: { enabled: $("#tl-on").checked, when: $("#tl-when").value, target: $("#tl-zone").value, color: $("#tl-col").value } });
    $("#obs-save").onclick = () => act(() => api("PATCH", "/api/integrations/obs", obsBody()), "OBS settings saved").then(load).catch(() => {});
    if ($("#obs-clr")) $("#obs-clr").onclick = () => act(() => api("PATCH", "/api/integrations/obs", { clearPassword: true }), "Password forgotten").then(load).catch(() => {});
    const bsUrl = () => { const p = new URLSearchParams(); if (!$("#bs-pv").checked) p.set("preview", "0"); if (!$("#bs-np").checked) p.set("np", "0"); if ($("#bs-c").value !== "bl") p.set("corner", $("#bs-c").value); if ($("#bs-bg").checked) p.set("bg", "1");
      const u = `${location.origin}/obs${p.toString() ? "?" + p : ""}`; $("#bs-url").textContent = u; $("#bs-open").href = u; return u; };
    for (const id of ["#bs-pv", "#bs-np", "#bs-c", "#bs-bg"]) $(id).onchange = bsUrl; bsUrl();
    $("#bs-copy").onclick = () => navigator.clipboard?.writeText(bsUrl()).then(() => toast("Copied"), () => toast("Select the address and copy it", true));

    // games: each change is saved at once
    for (const box of $$("[data-game]")) { const g = box.dataset.game;
      for (const inp of box.querySelectorAll("[data-g]")) { const k = inp.dataset.g;
        if (inp.type === "range") inp.oninput = () => { inp.previousElementSibling.querySelector("output").textContent = Math.round(inp.value * 100) + "%"; };
        inp.onchange = () => act(() => api("PATCH", `/api/integrations/games/${g}`, { [k]: inp.type === "checkbox" ? inp.checked : inp.type === "range" ? Number(inp.value) : inp.value }), k === "enabled" ? (inp.checked ? `${I.games[g].name}: on` : `${I.games[g].name}: off`) : null)
          .then(r => { I.games[g] = r; if (k === "enabled") render(); }).catch(() => load().catch(() => {})); } }
    for (const b of $$("[data-cfg]")) b.onclick = async () => { const g = b.dataset.cfg;
      const r = await act(() => api("GET", `/api/integrations/games/${g}/cfg?url=${encodeURIComponent(location.origin)}`)).catch(() => null); if (!r) return;
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([r.content], { type: "text/plain" })); a.download = r.filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(`Saved ${r.filename}: put it in …/${r.folder}/`); load().catch(() => {}); };
    for (const b of $$("[data-tok]")) b.onclick = () => { if (confirm("Make a new token? The config file you installed stops working until you download it again.")) act(() => api("POST", `/api/integrations/games/${b.dataset.tok}/token`), "New token made: download the config file again").then(load).catch(() => {}); };
    for (const b of $$("[data-try]")) b.onclick = () => { const [g, what] = b.dataset.try.split(":"); act(() => api("POST", `/api/integrations/games/${g}/test`, { what })).catch(() => {}); };

    // Twitch
    const chatBody = () => ({ chat: { enabled: $("#tw-on").checked, channel: $("#tw-ch").value.trim(), who: $("#tw-who").value, cooldownSec: Number($("#tw-cd").value), userCooldownSec: Number($("#tw-ucd").value),
      commands: Object.fromEntries($$("[data-cmd]").map(i => [i.dataset.cmd, i.checked])), scenes: $$("[data-tsc]").filter(i => i.checked).map(i => i.dataset.tsc) } });
    $("#tw-save").onclick = () => act(() => api("PATCH", "/api/integrations/twitch", chatBody()), "Twitch chat settings saved").then(load).catch(() => {});
    const KINDS = [["follow", "Follow"], ["subscribe", "New sub"], ["resub", "Resub"], ["gift", "Gifted subs"], ["raid", "Raid"], ["cheer", "Cheer (bits)"]];
    const evRow = ([k, n]) => { const r = I.twitch.events[k] || { type: "none" };
      return `<tr data-ev="${k}"><td>${n}</td><td><select data-k="type">${[["none", "Nothing"], ["flash", "Flash"], ["color", "Colour for a while"], ["strobe", "Strobe"], ["scene", "Scene"], ["effect", "Effect"], ["drop", "Drop"]].map(([v, l]) => opt(v, l, r.type === v)).join("")}</select></td>
        <td><input type="color" class="ig-col" data-k="color" value="${esc(r.color || "#ffffff")}"></td>
        <td><select data-k="scene" ${r.type === "scene" ? "" : "hidden"}>${sceneSel(r.scene, "Pick a scene")}</select><select data-k="effect" ${r.type === "effect" ? "" : "hidden"}>${effects().map(e => opt(e.id, e.name, e.id === r.effect)).join("")}</select>${k === "cheer" ? `<input type="number" data-k="minBits" min="1" value="${r.minBits || 1}" title="Bits at least" style="max-width:90px">` : ""}</td>
        <td><input type="number" data-k="seconds" min="1" max="60" value="${r.seconds || (r.type === "strobe" ? 3 : 6)}" style="max-width:70px"></td><td><button class="btn sm" type="button" data-evtry="${k}">Try</button></td></tr>`; };
    $("#tw-ev").innerHTML = KINDS.map(evRow).join("");
    $("#tw-ev").onchange = e => { if (e.target.dataset.k === "type") { const tr = e.target.closest("tr"); tr.querySelector("[data-k=scene]").hidden = e.target.value !== "scene"; tr.querySelector("[data-k=effect]").hidden = e.target.value !== "effect"; } };
    const evBody = () => ({ clientId: $("#tw-cid").value.trim(), target: $("#tw-zone").value, eventsOn: $("#tw-evon").checked,
      events: Object.fromEntries($$("#tw-ev tr").map(tr => { const v = k => tr.querySelector(`[data-k=${k}]`)?.value, type = v("type"), o = { type };
        if (type === "flash" || type === "color") o.color = v("color"); if (type === "color" || type === "strobe") o.seconds = Number(v("seconds")); if (type === "scene") o.scene = v("scene"); if (type === "effect") o.effect = v("effect"); if (tr.dataset.ev === "cheer") o.minBits = Number(v("minBits")) || 1;
        return [tr.dataset.ev, o]; })) });
    $("#tw-esave").onclick = () => act(() => api("PATCH", "/api/integrations/twitch", evBody()), "Twitch event settings saved").then(load).catch(() => {});
    $("#tw-ev").onclick = e => { const k = e.target.dataset.evtry; if (k) act(() => api("PATCH", "/api/integrations/twitch", evBody()).then(() => api("POST", "/api/integrations/twitch/test", { kind: k }))).catch(() => {}); };

    // Discord
    $("#dc-save").onclick = () => act(() => api("PATCH", "/api/integrations/discord", { ...($("#dc-url").value.trim() ? { webhook: $("#dc-url").value.trim() } : {}), username: $("#dc-name").value, nowPlaying: $("#dc-np").checked, scenes: $("#dc-sc").checked, twitch: $("#dc-tw").checked }), "Discord settings saved").then(load).catch(() => {});
    $("#dc-test").onclick = () => act(() => api("POST", "/api/integrations/discord/test"), "Sent: look in your Discord channel").catch(() => {});
    $("#docs-try").onchange = e => act(() => api("PATCH", "/api/integrations/docs", { tryIt: e.target.checked }), e.target.checked ? "The docs site may try API calls" : "The docs site can no longer try API calls").then(load).catch(() => {});
    if ($("#dc-clr")) $("#dc-clr").onclick = () => act(() => api("PATCH", "/api/integrations/discord", { webhook: "" }), "Webhook removed").then(load).catch(() => {});
  }

  // ---------------------------------------------------------------- live status (every 2 s while the page is open)
  function update() {
    if (!I || gone) return; const o = I.obs.status, tw = I.twitch, dc = I.discord.status;
    const os = $("#obs-st"); if (os) os.innerHTML = !I.obs.enabled ? badge(false, "Off") : o?.connected ? badge(true, `Connected · ${o.scene || "?"}${o.streaming ? " · live" : ""}${o.recording ? " · recording" : ""}`) : badge(false, o?.error || "Connecting…", true);
    for (const g of ["cs2", "dota2"]) { const e = $(`#g-st-${g}`), c = I.games[g], s = c.status; if (!e) continue;
      e.innerHTML = !c.enabled ? badge(false, "Off") : s.live ? badge(true, `${s.map || "In game"}${s.health != null ? ` · ${s.health} HP` : ""}${s.bomb ? " · bomb!" : ""}`) : badge(false, s.lastAt ? `Last heard ${ago(s.lastAt)}` : "Waiting for the game", !s.lastAt ? false : true); }
    const ts = $("#tw-st"); if (ts) { const c = tw.status; ts.innerHTML = !tw.chat.enabled ? badge(false, "Chat off") : c?.joined ? badge(true, `Reading #${c.channel}`) : badge(false, c?.error || "Connecting…", true); }
    const tl = $("#tw-last"); if (tl && tw.last) tl.textContent = `Last: ${tw.last.user} used !${tw.last.cmd}${tw.last.ok ? "" : ` (refused: ${{ off: "turned off", role: "not allowed", cooldown: "cooldown", "user-cooldown": "their cooldown", unknown: "not found", missing: "nothing after it", safe: "safe mode" }[tw.last.why] || tw.last.why})`} ${ago(tw.last.at)}`;
    const ta = $("#tw-auth"); if (ta && !ta.contains(document.activeElement)) {
      ta.innerHTML = tw.auth ? `${badge(!!tw.eventsub?.connected, `Signed in as ${tw.auth.login}${tw.eventsub ? tw.eventsub.connected ? ` · ${tw.eventsub.subscribed.length} events` : " · connecting" : ""}`, !tw.eventsub?.connected)}<button class="btn sm" id="tw-out" type="button">Sign out</button>`
        : tw.login ? `<span>Go to <a href="${esc(tw.login.uri)}" target="_blank" rel="noopener">${esc(tw.login.uri.replace(/^https?:\/\/(www\.)?/, ""))}</a> and enter</span> <span class="ig-code">${esc(tw.login.userCode)}</span>${tw.login.error ? ` <span class="badge err"><i></i>${esc(tw.login.error)}</span>` : ""}<button class="btn sm" id="tw-out" type="button">Cancel</button>`
        : `<button class="btn sm primary" id="tw-in" type="button">Connect Twitch</button>`;
      if ($("#tw-in")) $("#tw-in").onclick = () => act(() => api("POST", "/api/integrations/twitch/login", { clientId: $("#tw-cid").value.trim() })).then(load).catch(() => {});
      if ($("#tw-out")) $("#tw-out").onclick = () => act(() => api("DELETE", "/api/integrations/twitch/login"), "Signed out of Twitch").then(load).catch(() => {}); }
    const te = $("#tw-elast"); if (te) te.textContent = [tw.eventsub?.failed?.length ? `Not allowed: ${tw.eventsub.failed.join("; ")}` : "", tw.lastEvent ? `Last: ${tw.lastEvent.text} ${ago(tw.lastEvent.at)}` : ""].filter(Boolean).join(" · ");
    const ds = $("#dc-st"); if (ds) ds.innerHTML = !I.discord.hasWebhook ? badge(false, "No webhook") : dc.error ? badge(false, dc.error, true) : badge(true, dc.sent ? `${dc.sent} posted · last ${ago(dc.lastAt)}` : "Ready");
  }
  const poll = async () => { if (gone) return; try { const n = await api("GET", "/api/integrations"); if (gone) return; const relist = JSON.stringify(n.obs.status?.scenes || []) !== JSON.stringify(I.obs.status?.scenes || []); I = n; update();
    if (relist && $("#obs-scenes")) $("#obs-scenes").innerHTML = (I.obs.status?.scenes || []).map(x => `<option value="${esc(x)}">`).join(""); } catch {} timer = setTimeout(poll, 2000); };
  timer = setTimeout(poll, 2000);
  return { destroy() { gone = true; clearTimeout(timer); }, onChanged(w) { if (w.has("lock")) route(); } };
}
