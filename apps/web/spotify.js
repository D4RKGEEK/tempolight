// "Sync with Spotify" on the Music page: the lights follow the Spotify track with its beat map (learned by listening,
// shared by other installs, or Spotify's own analysis). The server does the work (packages/server/src/spotify.js);
// this panel shows what it does, its settings, and takes 2-3 colours from the album cover when cover colours are on.
// In the online demo there is no server, so it only explains.
import { api, act, panel, $, esc, fmtTime, unlocked, toast } from "/app.js";

const GUIDE = "https://github.com/D4RKGEEK/tempolight/blob/main/docs/spotify.md";
let view = null, lastArt = null, lastLoad = 0;

const BADGE = { exact: "live", shared: "live", analysis: "live", learning: "warn", live: "", paused: "", idle: "", off: "" };
function why(i, v) {
  const t = i.track, lr = i.learn;
  if (!i.on) return "Off. Turn it on and the lights follow the Spotify track that's playing, with its whole beat map.";
  if (!t) return i.connected ? "Nothing is playing in your Spotify account." : v && v.local.supported ? "Play something in Spotify on this computer, or connect your Spotify account (set-up below) to follow Spotify on your phone or a speaker." : "Connect your Spotify account (set-up below).";
  if (i.mode === "paused") return "Paused: the lights rest on the ambient look until it plays again.";
  if (i.mode === "exact") return `Following the beat map learned for this song${i.map && i.map.cover < 100 ? ` (${i.map.cover}% of it so far)` : ""}, at Spotify's position. Nothing needs to be heard${i.locked ? "; the kicks Tempolight hears keep it locked to the beat" : ""}.`;
  if (i.mode === "shared") return "Following a beat map other Tempolight installs learned and agree on. Nothing needs to be heard.";
  if (i.mode === "analysis") return "Following Spotify's own analysis of this track (beats, bars and sections). Nothing needs to be heard.";
  if (i.mode === "learning") return `Learning this song… ${lr?.pct ?? 0}%. Tempolight listens while it plays and saves its beat map; next time it follows it exactly, without listening.`;
  if (lr?.state === "analysing") return "Learning this song… working out its beats and drops.";
  if (i.map && i.map.cover < 100) return `Part of this song is learned (${i.map.cover}%). Where it isn't, the lights react to what Tempolight hears, and it learns the rest.`;
  return v?.settings.learn === false ? "Not learned yet, and learning is off: the lights react to what Tempolight hears, if it listens." : "Not learned yet. Tempolight learns it while it plays if it can hear it: see How should Tempolight hear your music? at the top of this page. Next time the lights follow its beat map exactly.";
}
const srcName = { learned: "learned", shared: "shared map", "spotify-analysis": "Spotify analysis", file: "played here" };

export function mount(el, { demo = false } = {}) {
  if (!el) return null;
  if (demo) { el.outerHTML = panel("Sync with Spotify", "Not in the online demo", "", `<div class="pb stack" id="sp-panel"><p class="muted" id="sp-demo">With Tempolight running on your computer or a Raspberry Pi, the lights follow the Spotify track that's playing, on this computer or on your phone or speakers, with its beats, build-ups and drops. Songs are learned the first time they play while Tempolight listens. The online demo runs in your browser and can't reach Spotify: <a href="https://github.com/D4RKGEEK/tempolight#install" target="_blank" rel="noopener">install Tempolight</a> to try it.</p></div>`, "span-12"); return null; }
  el.outerHTML = panel("Sync with Spotify", `<span id="sp-sub"></span>`, `<label class="check"><input type="checkbox" id="sp-on"> Sync with Spotify</label>`, `<div class="pb stack" id="sp-panel">
    <div class="row" style="flex-wrap:nowrap;gap:12px;align-items:center"><img id="sp-art" alt="" width="56" height="56" style="border-radius:12px;flex:none;object-fit:cover;box-shadow:var(--ring)" hidden>
      <div style="flex:1;min-width:0"><b id="sp-title" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Nothing playing</b><span class="faint" id="sp-where" style="font-size:13px"></span></div>
      <span class="badge" id="sp-mode">–</span></div>
    <div class="progress" style="cursor:default" id="sp-prog" hidden><div class="fill" id="sp-fill"></div></div><div class="times" id="sp-times" hidden><span id="sp-pos">0:00</span><span id="sp-dur">0:00</span></div>
    <p class="muted" id="sp-why" aria-live="polite"></p>
    <div class="row" style="gap:6px 16px">
      <label class="check"><input type="checkbox" id="sp-learn"> Learn songs while they play</label>
      <label class="check"><input type="checkbox" id="sp-ana"> Use Spotify's analysis when available <span class="faint" id="sp-anast"></span></label>
      <label class="check"><input type="checkbox" id="sp-pause"> Fade to ambient on pause</label>
      <label class="check"><input type="checkbox" id="sp-mute"> Dim when muted</label>
      <label class="check" title="The browser takes 2 or 3 colours from the album cover; they're used while the palette is Automatic"><input type="checkbox" id="sp-cover"> Album cover colours <span id="sp-sw"></span></label>
    </div>
    <details id="sp-cloudbox"><summary>Shared beat maps (optional)</summary><div class="stack" style="margin-top:8px">
      <p class="faint" style="font-size:13px">A small service (a Cloudflare Worker you deploy, free) where Tempolight installs share the beat maps they learned: a song someone else learned plays with its full map the first time here. Maps hold only the Spotify track ID, beats, drums, song parts and loudness; installs are anonymous. A map is used once two installs agree on it.</p>
      <div class="field"><label for="sp-url">Service address</label><div class="row" style="flex-wrap:nowrap"><input id="sp-url" class="mono" placeholder="https://tempolight-beatmaps.example.workers.dev" autocomplete="off"><button class="btn sm" id="sp-urlsave" type="button">Save</button></div></div>
      <label class="check"><input type="checkbox" id="sp-use"> Use shared beat maps</label>
      <label class="check"><input type="checkbox" id="sp-share"> Share the songs I learn</label>
      <span class="faint" id="sp-cloudst" style="font-size:13px"></span>
    </div></details>
    <details id="sp-help"><summary>Set up Spotify</summary><ol class="faint" style="font-size:13px;margin:8px 0 0 18px;line-height:1.6">
      <li>Spotify on <b>this computer</b> works with no set-up (the app must be open; macOS asks once to allow it).</li>
      <li>For Spotify on your phone or speakers: open <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>, create an app (Web API), and add this redirect URI: <span class="mono" id="sp-redir" style="word-break:break-all"></span></li>
      <li>Paste the app's Client ID in <b>Now playing on this computer → Spotify on other devices</b> below, then press Connect Spotify. <button class="btn sm" id="sp-goconnect" type="button">Go to Connect Spotify</button></li>
      <li>Spotify gives apps made after 27 November 2024 no audio analysis, so Tempolight learns each song the first time it plays while it listens (set that up in <b>How should Tempolight hear your music?</b> at the top of this page: on a Mac, BlackHole). <a href="${GUIDE}" target="_blank" rel="noopener">More in the guide</a>.</li></ol></details>
  </div>`, "span-12");
  const admin = unlocked();
  const fill = () => { if (!view || !$("#sp-on")) return; const s = view.settings;
    $("#sp-on").checked = s.sync; $("#sp-learn").checked = s.learn; $("#sp-ana").checked = s.analysis; $("#sp-pause").checked = s.pauseFade; $("#sp-mute").checked = s.muteDim; $("#sp-cover").checked = s.coverColours;
    $("#sp-use").checked = s.cloud.use; $("#sp-share").checked = s.cloud.share; if (document.activeElement !== $("#sp-url")) $("#sp-url").value = s.cloud.url;
    $("#sp-anast").textContent = view.analysis === "blocked" ? "(not available to your Spotify app)" : "";
    $("#sp-redir").textContent = view.account.redirectUri;
    const l = view.cloud.last; $("#sp-cloudst").textContent = !s.cloud.url ? "Not set up." : !l ? "" : l.what === "error" ? `Last try: ${l.error}` : l.what === "got" ? `Got a shared map (${l.installs} installs agree).` : l.what === "sent" ? (l.confirmed ? `Shared a map; confirmed by ${l.installs} installs.` : "Shared a map; waiting for another install to agree.") : "No shared map for the last song yet.";
    for (const id of ["sp-on", "sp-learn", "sp-ana", "sp-pause", "sp-mute", "sp-cover", "sp-use", "sp-share", "sp-url", "sp-urlsave"]) $("#" + id).disabled = !admin; };
  const load = async () => { view = await api("GET", "/api/spotify").catch(() => null); lastLoad = Date.now(); fill(); };
  const patch = b => act(() => api("PATCH", "/api/spotify", b), "Saved").then(v => { view = v; fill(); }).catch(() => load());
  const bind = (id, k) => { $("#" + id).onchange = e => patch({ [k]: e.target.checked }); };
  bind("sp-on", "sync"); bind("sp-learn", "learn"); bind("sp-ana", "analysis"); bind("sp-pause", "pauseFade"); bind("sp-mute", "muteDim"); bind("sp-cover", "coverColours");
  $("#sp-use").onchange = e => patch({ cloud: { use: e.target.checked } }); $("#sp-share").onchange = e => patch({ cloud: { share: e.target.checked } });
  $("#sp-urlsave").onclick = () => patch({ cloud: { url: $("#sp-url").value.trim() } });
  $("#sp-goconnect").onclick = () => { const d = $("#np details"), cid = $("#np-cid"); if (!d || !cid) return; d.open = true; cid.scrollIntoView({ block: "center", behavior: "smooth" }); cid.focus({ preventScroll: true }); };
  load();
  return { load };
}

/** Called with every status message (4 a second). */
export function status(m) {
  if (!$("#sp-panel") || !$("#sp-title")) return;
  if (Date.now() - lastLoad > 5000) { lastLoad = Date.now(); api("GET", "/api/spotify").then(v => { view = v; }).catch(() => {}); }
  const i = m.spotify; if (!i) return; const t = i.track;
  $("#sp-title").textContent = t ? `${t.title}${t.artist ? ` · ${t.artist}` : ""}` : "Nothing playing";
  $("#sp-where").textContent = t ? `${i.via === "local" ? "Spotify on this computer" : `Spotify${t.device ? ` on ${t.device}` : ""}`}${t.playing ? "" : " · paused"}${t.volume === 0 ? " · muted" : ""}` : i.connected ? "Your Spotify account is connected" : "";
  const mode = $("#sp-mode"), learned = i.learn?.state === "learned" && (i.mode === "exact" || i.mode === "live");
  mode.textContent = i.mode === "learning" ? `Learning this song… ${i.learn?.pct ?? 0}%` : i.learn?.state === "analysing" ? "Learning this song…" : learned ? "Learned ✓" : i.modeName; mode.className = `badge ${learned ? "live" : BADGE[i.mode] || ""}`;
  $("#sp-sub").textContent = !i.on ? "Off" : i.error ? i.error : i.map ? `${i.modeName} · ${srcName[i.map.src] || i.map.src}` : i.modeName;
  const art = $("#sp-art"); if (t && t.art) { if (art.getAttribute("src") !== t.art) art.src = t.art; art.hidden = false; } else art.hidden = true;
  const showPos = !!(t && t.dur > 0 && t.pos != null); $("#sp-prog").hidden = !showPos; $("#sp-times").hidden = !showPos;
  if (showPos) { $("#sp-fill").style.width = `${Math.min(100, t.pos / t.dur * 100)}%`; $("#sp-pos").textContent = fmtTime(t.pos); $("#sp-dur").textContent = fmtTime(t.dur); }
  $("#sp-why").textContent = why(i, view);
  if (view && view.settings.coverColours && t && t.art && t.art !== lastArt && unlocked()) { lastArt = t.art; coverColours(t.art).then(cs => { if (!cs) return;
    const sw = $("#sp-sw"); if (sw) sw.innerHTML = cs.map(c => `<i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${esc(c)};margin-left:2px"></i>`).join("");
    return api("POST", "/api/spotify/colors", { art: t.art, colors: cs }); }).catch(e => toast(`Cover colours: ${e.message}`, true)); }
}

/**
 * 2 or 3 dominant colours of an image (the album cover), by hue: the pixels are drawn small on a canvas, grouped in 12
 * hues weighted by how colourful and bright they are, and the strongest groups' average colours win (grey covers give
 * their brightest colours). Spotify's image server allows this (CORS); nothing is decoded on the Tempolight server.
 */
export async function coverColours(url) {
  const img = new Image(); img.crossOrigin = "anonymous"; img.decoding = "async";
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("couldn't load the cover")); img.src = url; });
  const N = 32, cv = document.createElement("canvas"); cv.width = N; cv.height = N; const g = cv.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0, N, N);
  const px = g.getImageData(0, 0, N, N).data, bins = Array.from({ length: 13 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < px.length; i += 4) { const r = px[i] / 255, gg = px[i + 1] / 255, b = px[i + 2] / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), sat = mx ? (mx - mn) / mx : 0;
    let h = 0; if (mx > mn) h = mx === r ? ((gg - b) / (mx - mn) + 6) % 6 : mx === gg ? (b - r) / (mx - mn) + 2 : (r - gg) / (mx - mn) + 4;
    const k = sat < 0.18 ? 12 : Math.floor(h * 2) % 12, w = sat < 0.18 ? 0.15 * mx : sat * mx * mx; const B = bins[k]; B.w += w; B.r += px[i] * w; B.g += px[i + 1] * w; B.b += px[i + 2] * w; }
  const top = bins.filter(b => b.w > 0.5).sort((a, b) => b.w - a.w).slice(0, 3);
  if (top.length < 2) return null;
  const hex = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return top.map(b => { let r = b.r / b.w, gg = b.g / b.w, bb = b.b / b.w; const mx = Math.max(r, gg, bb) || 1, k = 255 / mx; r *= k; gg *= k; bb *= k; return `#${hex(r)}${hex(gg)}${hex(bb)}`; }); // full brightness: the LEDs set their own
}
