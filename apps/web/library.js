// "Your own music" on the Music page: folders on the computer Tempolight runs on whose songs are analysed ahead, so
// they are followed exactly from the first play. Server only: in the online demo the panel only explains (a web page
// can't read a folder on your disk).
import { api, act, panel, $, $$, esc, unlocked } from "/app.js";

let view = null, timer = null;
const secs = ms => ms >= 10000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;

export function mount(box, { demo = false } = {}) {
  if (!box) return;
  if (demo) {
    box.outerHTML = panel("Your own music", "Analysed ahead, followed from the first play", "", `<div class="pb stack" id="lib-demo">
      <p class="muted">Installed on your computer or Raspberry Pi, Tempolight can analyse a whole music folder ahead of time. Every song is then followed exactly from its first play: when a music player says which file it plays, and after a few seconds of listening otherwise.</p>
      <p class="faint" style="font-size:13px">The online demo runs in your browser and can't read folders on your disk. Install Tempolight to use your own music.</p></div>`, "span-12");
    return;
  }
  box.outerHTML = panel("Your own music", `<span id="lib-sub"></span>`, `<button class="btn sm" id="lib-scan" type="button">Look for new songs</button><button class="btn sm" id="lib-pause" type="button">Pause</button>`, `<div class="pb stack" id="lib">
    <p class="muted">Add a music folder and Tempolight analyses every song in it ahead of time. Then each song is followed exactly from its first play: straight away when your music player says which file it plays, and after a few seconds of listening otherwise.</p>
    <div class="callout warn" id="lib-ff" hidden></div>
    <div class="field"><label for="lib-path">Add a folder</label><div class="row" style="flex-wrap:nowrap"><input id="lib-path" class="mono" autocomplete="off" spellcheck="false" placeholder="/home/you/Music, C:\\Users\\you\\Music or ~/Music" style="flex:1;min-width:0"><button class="btn primary" id="lib-add" type="button">Add</button></div>
      <span class="help">Type the folder's full path on the computer Tempolight runs on. A web page can't open a folder picker on that computer, so it has to be typed. With Docker, use the folder the music is mounted at (for example /music).</span></div>
    <div id="lib-folders" class="stack"></div>
    <label class="check"><input type="checkbox" id="lib-watch"> Notice new songs in these folders by itself</label>
    <div id="lib-progress" hidden><div class="progress" style="cursor:default"><div class="fill" id="lib-fill"></div></div><p class="faint" id="lib-ptext" style="font-size:13px;margin-top:6px" aria-live="polite"></p></div>
    <div class="tablewrap"><table><thead><tr><th>Song</th><th class="num">Tempo</th><th>Key</th><th>Look</th><th></th></tr></thead><tbody id="lib-songs"><tr><td class="faint" colspan="5">Loading…</td></tr></tbody></table></div>
    <details id="lib-errbox" hidden><summary id="lib-errsum"></summary><ul id="lib-errs" class="faint" style="font-size:13px;margin:8px 0 0;padding-left:18px"></ul></details></div>`, "span-12");
  $("#lib-add").onclick = add; $("#lib-path").onkeydown = e => { if (e.key === "Enter") add(); };
  $("#lib-watch").onchange = e => patch({ watch: e.target.checked }, e.target.checked ? "New songs are noticed by themselves" : "Only when you press Look for new songs");
  $("#lib-scan").onclick = () => act(() => api("POST", "/api/library/scan"), "Looking for new songs…").then(v => { view = { ...view, ...v }; fill(); poll(); }).catch(() => {});
  $("#lib-pause").onclick = () => act(() => api("POST", `/api/library/${view?.paused ? "resume" : "pause"}`), view?.paused ? "Analysing again" : "Paused").then(v => { view = { ...view, ...v }; fill(); poll(); }).catch(() => {});
  load();
  return { load };
}
async function add() {
  const p = $("#lib-path").value.trim(); if (!p) return $("#lib-path").focus();
  const v = await act(() => api("PATCH", "/api/library", { folders: [...(view?.folders || []).map(f => f.path), p] }), "Folder added: analysing its songs").catch(() => null);
  if (v) { $("#lib-path").value = ""; view = { ...view, ...v }; fill(); poll(); }
}
function patch(b, ok) { return act(() => api("PATCH", "/api/library", b), ok).then(v => { view = { ...view, ...v }; fill(); poll(); }).catch(() => load()); }
async function load(songs = true) {
  if (!$("#lib")) return;
  if (!unlocked()) { view = null; fill(); return; }
  const v = await api("GET", `/api/library${songs ? "" : "?songs=0"}`).catch(() => null); if (!v) return;
  view = songs ? v : { ...v, songs: view?.songs || [] }; fill();
}
// while songs are being analysed: the progress every 2 s, the list every 10 s and at the end
let lastSongs = 0;
function poll() {
  clearTimeout(timer); if (!$("#lib")) return;
  timer = setTimeout(async () => { const busy = view && ["scanning", "analysing", "waiting"].includes(view.progress.state), full = Date.now() - lastSongs > 10000;
    await load(full || !busy); if (full || !busy) lastSongs = Date.now(); if (view && ["scanning", "analysing", "waiting"].includes(view.progress.state)) poll(); else if (busy) load(true); }, 2000);
}
export function changed() { load(); poll(); }

function fill() {
  if (!$("#lib")) return;
  const admin = unlocked();
  for (const id of ["lib-add", "lib-path", "lib-watch", "lib-scan", "lib-pause"]) $("#" + id).disabled = !admin;
  if (!admin) { $("#lib-sub").textContent = "Locked"; $("#lib-songs").innerHTML = '<tr><td class="faint" colspan="5">Unlock with the PIN in Settings to see and change the music library.</td></tr>'; return; }
  const v = view; if (!v) return;
  const P = v.progress, c = v.counts;
  $("#lib-sub").textContent = c.analysed ? `${c.analysed} song${c.analysed === 1 ? "" : "s"} ready` : v.folders.length ? "" : "No folder yet";
  $("#lib-watch").checked = v.watch; $("#lib-pause").textContent = v.paused ? "Resume" : "Pause"; $("#lib-pause").hidden = !v.folders.length; $("#lib-scan").hidden = !v.folders.length;
  const ff = $("#lib-ff"); ff.hidden = !v.message; ff.textContent = v.message ? `${v.message}${c.needsFfmpeg ? ` ${c.needsFfmpeg} song${c.needsFfmpeg === 1 ? " is" : "s are"} waiting for it.` : ""}` : "";
  $("#lib-folders").innerHTML = v.folders.map((f, i) => `<div class="row" style="justify-content:space-between;flex-wrap:nowrap;gap:8px"><span class="mono" style="font-size:13px;word-break:break-all">${esc(f.path)}${f.exists ? "" : ' <span class="badge err">not found</span>'}</span><span class="row" style="flex-wrap:nowrap;gap:8px"><span class="faint" style="font-size:13px;white-space:nowrap">${f.songs} song${f.songs === 1 ? "" : "s"}</span><button class="btn sm" type="button" data-libdrop="${i}">Remove</button></span></div>`).join("");
  $$("[data-libdrop]").forEach(b => b.onclick = () => { const f = v.folders[Number(b.dataset.libdrop)]; if (!confirm(`Stop using ${f.path}? Its songs are taken out of the library (the files stay).`)) return;
    patch({ folders: v.folders.filter((_, k) => k !== Number(b.dataset.libdrop)).map(x => x.path) }, "Folder removed"); });
  // progress: "Analysing 34 of 210 · 1.2 s each"
  const busy = ["scanning", "analysing", "waiting", "paused"].includes(P.state) && (P.state !== "paused" || c.queued > 0);
  $("#lib-progress").hidden = !busy;
  if (busy) { $("#lib-fill").style.width = `${P.total ? Math.min(100, P.done / P.total * 100) : 0}%`;
    $("#lib-ptext").textContent = P.state === "scanning" ? "Looking through the folders…" : P.state === "paused" ? `Paused · ${c.queued} song${c.queued === 1 ? "" : "s"} still to analyse` : P.state === "waiting" ? `Waiting: ${P.waiting} · ${P.done} of ${P.total} analysed`
      : `Analysing ${Math.min(P.total, P.done + 1)} of ${P.total}${P.perSongMs ? ` · ${secs(P.perSongMs)} each` : ""}${P.current?.length ? ` · ${P.current[0]}` : ""}`; }
  if (v.cap?.full) $("#lib-ptext").textContent = `The library is full (${v.cap.songs} songs). Remove songs or folders to add others.`;
  if (v.songs) {
    const tb = $("#lib-songs"), list = v.songs;
    tb.innerHTML = list.length ? list.slice(0, 500).map(s => `<tr><td>${esc(s.name)}<br><span class="faint mono" style="font-size:12.5px;word-break:break-all">${esc(s.file)}</span></td><td class="num faint">${s.bpm ? Math.round(s.bpm) : "–"}</td><td class="faint">${esc(s.key || "–")}</td><td class="faint">${esc(s.look?.name || "–")}</td><td style="white-space:nowrap"><a class="btn sm" href="#/timeline/${esc(s.id)}">Show</a> <button class="btn sm" type="button" data-librm="${esc(s.id)}" title="Take this song out of the library (the file stays)">Remove</button></td></tr>`).join("")
      + (list.length > 500 ? `<tr><td class="faint" colspan="5">and ${list.length - 500} more</td></tr>` : "")
      : `<tr><td class="faint" colspan="5">${v.folders.length ? (busy ? "The first songs are on their way…" : "No songs found in these folders yet.") : "Add a folder above to start."}</td></tr>`;
    $$("[data-librm]").forEach(b => b.onclick = () => act(() => api("DELETE", `/api/library/songs/${b.dataset.librm}`), "Removed from the library").then(() => load()).catch(() => {}));
  }
  const errs = v.errors || [], eb = $("#lib-errbox"); eb.hidden = !errs.length;
  if (errs.length) { $("#lib-errsum").textContent = `${errs.length} file${errs.length === 1 ? "" : "s"} not analysed`;
    $("#lib-errs").innerHTML = errs.map(e => `<li><span class="mono">${esc(e.file)}</span>: ${esc(e.state === "needs" ? "needs ffmpeg" : e.error)}</li>`).join(""); }
  if (busy) poll();
}
