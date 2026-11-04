// "Now playing" from the music apps on the computer Tempolight runs on (Spotify, Music, any MPRIS player, Windows
// media controls) and, optionally, Spotify on other devices. Server only: app.js loads this file when not in the demo.
import { api, act, panel, $, fmtTime, unlocked, refreshState } from "/app.js";

let view = null; // GET /api/nowplaying
const who = t => `“${t.title}”${t.artist ? ` by ${t.artist}` : ""}`;
const where = t => t.source === "spotify" ? `Spotify${t.device ? ` on ${t.device}` : ""}` : `${t.app} on this computer`;

/** Which source drives the lights, in words. */
export function explain(m) {
  const t = m.nowPlaying, v = view;
  if (!v) return "";
  if (!v.enabled) return "Off. Turn it on to see what Spotify, Music or other players on this computer are playing.";
  if (!t) return v.state === "unavailable" || v.state === "error" ? v.message : `Nothing is playing in ${v.platform === "darwin" ? "Spotify or Music" : v.platform === "win32" ? "an app that shows in the Windows media controls" : "a music player (MPRIS)"} on this computer${v.spotify.connected ? " or in your Spotify account" : ""}.`;
  if (m.source === "song") return `A song played on this page comes first; ${who(t)} in ${where(t)} is only shown.`;
  if (t.following) return `The lights follow the beat map and show Tempolight saved for “${t.remembered.name}”, at ${t.app}'s position, as if it played here. Nothing needs to be heard.`;
  if (t.remembered && !t.playing) return `Paused. When it plays, the lights follow the beat map saved for “${t.remembered.name}”.`;
  if (t.remembered && !t.posKnown) return `${t.app} doesn't say where in the song it is, so Tempolight can't follow its saved beat map. Listening live works instead.`;
  const live = ["browser", "capture"].includes(m.source) || /\(quiet\)$/.test(m.sourceLabel || "");
  if (live) return `This song isn't remembered yet, so the lights react to what Tempolight hears (${m.sourceLabel}). Play the song's file once on this page and next time they follow its beat map.`;
  return `This song isn't remembered and Tempolight hears nothing, so the lights can't follow it. Set up How should Tempolight hear your music? (top of this page), or play the song's file once on this page so it's remembered.`;
}

/** For the Home page's "Now playing" card when no song plays in the app: {song, meta} or null. */
export function homeText(m) {
  const t = m.nowPlaying; if (!t || m.song) return null;
  return { song: `${t.title}${t.artist ? ` · ${t.artist}` : ""}`, meta: `${where(t)}${t.playing ? "" : " (paused)"} · ${t.following ? "following its saved beat map" : t.remembered ? "remembered" : ["browser", "capture"].includes(m.source) ? "lights follow the live audio" : "not remembered yet"}` };
}

export function mount(el) {
  if (!el) return;
  el.outerHTML = panel("Now playing on this computer", `<span id="np-sub"></span>`, `<label class="check"><input type="checkbox" id="np-on"> On</label>`, `<div class="pb stack" id="np">
    <div class="row" style="justify-content:space-between"><b id="np-title">–</b><span class="faint" id="np-app"></span></div>
    <div class="progress" id="np-prog" style="cursor:default" hidden><div class="fill" id="np-fill"></div></div><div class="times" id="np-times" hidden><span id="np-pos">0:00</span><span id="np-dur">0:00</span></div>
    <p class="muted" id="np-why" aria-live="polite"></p>
    <details><summary>Spotify on other devices (optional)</summary><div class="stack" style="margin-top:8px">
      <p class="faint" style="font-size:12.5px">For Spotify playing on a phone or speaker, not on this computer. Create a free app at <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> (Web API), add the redirect address below to it, and paste its Client ID here. Sign-in tokens stay on this Tempolight; they are never sent to browsers.</p>
      <div class="field"><label for="np-cid">Client ID</label><input id="np-cid" class="mono" autocomplete="off" placeholder="32 letters and digits"></div>
      <div class="field"><span class="lbl">Redirect address</span><span class="mono" id="np-redir" style="font-size:12.5px;word-break:break-all"></span></div>
      <div class="row"><button class="btn sm" id="np-cidsave" type="button">Save</button><button class="btn sm primary" id="np-login" type="button">Connect Spotify</button><button class="btn sm" id="np-logout" type="button" hidden>Disconnect</button><span id="np-sp" class="faint" style="font-size:12.5px"></span></div>
      <div class="field" id="np-pastebox" hidden><label for="np-paste">Signing in on another device? After Spotify says yes, the browser tries to open 127.0.0.1, which fails there. Copy that address from the address bar and paste it here:</label><div class="row" style="flex-wrap:nowrap"><input id="np-paste" class="mono" placeholder="http://127.0.0.1:…/callback?code=…"><button class="btn sm" id="np-pastego" type="button">Finish</button></div></div>
    </div></details></div>`, "span-12");
  const admin = unlocked();
  const fill = () => { if (!view || !$("#np-on")) return; $("#np-on").checked = view.enabled; $("#np-redir").textContent = view.spotify.redirectUri;
    if (document.activeElement !== $("#np-cid")) $("#np-cid").value = view.spotify.clientId;
    $("#np-sub").textContent = !view.supported ? "Not supported here" : !view.enabled ? "Off" : view.state === "ok" ? `Reading with ${view.method}` : view.state === "error" ? "Problem" : view.state === "unavailable" ? "Not available" : "Starting…";
    $("#np-logout").hidden = !view.spotify.connected; $("#np-login").textContent = view.spotify.connected ? "Connect again" : "Connect Spotify";
    $("#np-sp").textContent = view.spotify.connected ? "Connected" : view.spotify.error || "";
    for (const id of ["np-on", "np-cid", "np-cidsave", "np-login", "np-logout", "np-paste", "np-pastego"]) $("#" + id).disabled = !admin; };
  const load = async () => { view = await api("GET", "/api/nowplaying").catch(() => null); fill(); };
  const patch = b => act(() => api("PATCH", "/api/nowplaying", b), "Saved").then(v => { view = v; fill(); refreshState(); }).catch(() => load());
  $("#np-on").onchange = e => patch({ enabled: e.target.checked });
  $("#np-cidsave").onclick = () => patch({ spotifyClientId: $("#np-cid").value.trim() });
  $("#np-login").onclick = async () => {
    if ($("#np-cid").value.trim() !== (view?.spotify.clientId || "")) await act(() => api("PATCH", "/api/nowplaying", { spotifyClientId: $("#np-cid").value.trim() })).then(v => { view = v; }).catch(() => null);
    const r = await act(() => api("POST", "/api/nowplaying/spotify/login")).catch(() => null); if (!r) return;
    $("#np-pastebox").hidden = ["127.0.0.1", "localhost"].includes(location.hostname); window.open(r.url, "_blank", "noopener"); };
  $("#np-pastego").onclick = () => act(() => api("POST", "/api/nowplaying/spotify/code", { url: $("#np-paste").value.trim() }), "Spotify connected").then(v => { view = v; fill(); $("#np-pastebox").hidden = true; }).catch(() => {});
  $("#np-logout").onclick = () => act(() => api("DELETE", "/api/nowplaying/spotify"), "Spotify disconnected").then(v => { view = v; fill(); }).catch(() => {});
  load();
  return { load };
}

let lastLoad = 0;
export function status(m) {
  if (!$("#np")) return;
  if (Date.now() - lastLoad > 5000) { lastLoad = Date.now(); api("GET", "/api/nowplaying").then(v => { view = v; }).catch(() => {}); } // state, method and problems change slowly
  const t = m.nowPlaying;
  $("#np-title").textContent = t ? who(t) : "Nothing playing";
  $("#np-app").textContent = t ? `${where(t)}${t.playing ? "" : " · paused"}` : "";
  const showPos = !!(t && t.dur > 0 && t.posKnown); $("#np-prog").hidden = !showPos; $("#np-times").hidden = !showPos;
  if (showPos) { $("#np-fill").style.width = `${Math.min(100, t.pos / t.dur * 100)}%`; $("#np-pos").textContent = fmtTime(t.pos); $("#np-dur").textContent = fmtTime(t.dur); }
  $("#np-why").textContent = explain(m);
  if (view && $("#np-sub")) { const sub = $("#np-sub"); sub.textContent = !view.supported ? "Not supported here" : !view.enabled ? "Off" : t?.following ? "Following the saved beat map" : view.state === "ok" ? `Reading with ${view.method}` : view.state === "error" ? "Problem" : view.state === "unavailable" ? "Not available" : "Starting…"; }
}
