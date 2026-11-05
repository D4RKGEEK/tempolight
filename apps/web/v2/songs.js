// Songs (dashboard v2, design/dashboard-v2.md): "Which music does it know and how does it hear music?"
// Top: How Tempolight hears music, four big choice cards (this computer's sound, a microphone, Spotify, songs played
// here) with the active one's live level; picking one opens its set-up in a sheet (the v1 panels: hearing.js,
// spotify.js, nowplaying.js and the browser player in audio.js). Then Your songs: one list of everything it knows
// (remembered songs GET /api/songs, the music folder GET /api/library, songs added in this browser), with a detail
// sheet per song (its map, sections, look, the show editor, Forget). Spotify and guest requests sit under More options.
import { app, api, act, toast, esc, $, $$, unlocked, guestOk, guestUrl, fmtTime, refreshState, DEMO } from "/app.js";
import { hearLine } from "/hearline.js";
import { PART_NAME } from "/songmap.js";
import { openSheet } from "/v2/shell.js";

// ---------------------------------------------------------------- the stylesheet, inserted once
function loadCss() {
  if (document.getElementById("v2-songs-css")) return;
  const l = document.createElement("link"); l.id = "v2-songs-css"; l.rel = "stylesheet"; l.href = "/v2/songs.css"; document.head.appendChild(l);
}

// ---------------------------------------------------------------- the sheet (apps/web/v2/shell.js), one at a time
let openOne = null;
/** {el (the sheet), body (our content), close()} */
function sheet({ title, html, onClose, wide = false }) {
  openOne?.close(); let closed = false, s = null;
  const done = () => { if (closed) return; closed = true; if (openOne === s) openOne = null; onClose?.(); };
  const r = openSheet({ title, wide, body: `<div class="sg-sheet">${html}</div>`, onClose: done });
  s = { el: r.el, body: r.el.querySelector(".sg-sheet") || r.body, close: () => { r.close(); done(); } };
  openOne = s; return s;
}

// ---------------------------------------------------------------- small pieces
const ICON = {
  computer: '<path d="M3.5 5.5h17v11h-17z"/><path d="M8 20h8M12 16.5V20"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  spotify: '<circle cx="12" cy="12" r="9"/><path d="M7.5 9.5c3-1 6.5-.7 9 .8M8 12.6c2.5-.7 5.3-.4 7.4.8M8.6 15.5c2-.5 4-.3 5.6.6"/>',
  files: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>', pause: '<path d="M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>', folder: '<path d="M3.5 6.5h6l2 2h9v10h-17z"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
};
const ico = (n, cls = "") => `<svg class="sg-i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : "";
const fxName = id => app.state?.effects.find(e => e.id === id)?.name || id;
const lookLabel = l => !l ? "" : l.label || `${l.name || fxName(l.main)}${l.palette && l.palette !== "auto" ? ` · ${cap(l.palette)}` : ""}`;
const LEARNED = new Set(["learned", "shared", "spotify-analysis"]);
const SRC_TEXT = { learned: "Learned from Spotify", shared: "Shared beat map", "spotify-analysis": "Spotify's analysis" };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const CARDS = [
  { id: "computer", name: "This computer's sound", sub: "Hears whatever this computer plays. No microphone, no tab to keep open." },
  { id: "mic", name: "Microphone", sub: "Listens to the room through this browser. Keep the tab open." },
  { id: "spotify", name: "Spotify", sub: "Follows the track playing in Spotify, with its beats and drops." },
  { id: "files", name: "Play files here", sub: "Songs from this device, analysed first for the tightest timing." },
];
const FILTERS = [["all", "All"], ["folder", "Your folder"], ["learned", "Learned"], ["here", "Played here"]];
const store = { get(k) { try { return localStorage.getItem("tl." + k); } catch { return null; } }, set(k, v) { try { localStorage.setItem("tl." + k, v); } catch {} } };

// ---------------------------------------------------------------- the screen
export function render(el) {
  loadCss();
  const A = app.audio, admin = unlocked();
  let mem = [], lib = null, filter = store.get("songs.filter") || "all", q = "", alive = true, libTimer = 0, last = null;
  let HR = null, SP = null, NP = null, detail = null, filesSheet = null, folderSheet = null, sheetKind = null;
  if (!FILTERS.some(f => f[0] === filter)) filter = "all";

  el.innerHTML = `<div class="sg" id="songs">
    <section class="sg-sec" aria-labelledby="sg-hear-h">
      <div class="sg-head"><div><h2 id="sg-hear-h">How Tempolight hears music</h2><p class="sg-line" id="sg-line" aria-live="polite"></p></div></div>
      <div class="sg-cards" role="list">${CARDS.map(c => `<button class="sg-card" type="button" role="listitem" data-card="${c.id}" aria-describedby="sg-st-${c.id}">
        <span class="sg-card-top"><span class="sg-card-ico">${ico(c.id)}</span><span class="sg-pill" id="sg-st-${c.id}"></span></span>
        <b>${esc(c.name)}</b><small>${esc(c.sub)}</small>
        <span class="sg-level" aria-hidden="true">${"<i></i>".repeat(16)}</span>
        <span class="sg-card-go">Set up ${ico("chevron")}</span></button>`).join("")}</div>
    </section>
    <section class="sg-sec" aria-labelledby="sg-list-h">
      <div class="sg-head"><div><h2 id="sg-list-h">Your songs</h2><p class="sg-line" id="sg-count"></p></div>
        <div class="sg-acts"><button class="btn" id="sg-addfolder" type="button">${ico("folder")}Add a music folder</button><button class="btn primary" id="sg-addsongs" type="button">${ico("plus")}Add songs</button>
          <input type="file" id="sg-files" accept="audio/*" multiple hidden></div></div>
      <div class="sg-prog" id="sg-prog" hidden><div class="sg-prog-row"><span id="sg-prog-t" aria-live="polite"></span><button class="sg-link" id="sg-prog-pause" type="button">Pause</button></div><div class="sg-bar"><i id="sg-prog-f"></i></div></div>
      <div class="sg-tools"><div class="sg-seg" role="tablist" aria-label="Show songs">${FILTERS.map(([k, t]) => `<button type="button" role="tab" data-f="${k}" aria-selected="${k === filter}">${t}<span class="sg-n" data-n="${k}"></span></button>`).join("")}</div>
        <label class="sg-search">${ico("search")}<input type="search" id="sg-q" placeholder="Search songs" aria-label="Search songs" autocomplete="off"></label></div>
      <div class="sg-list" id="sg-list" role="list"><div class="sg-skel"></div><div class="sg-skel"></div><div class="sg-skel"></div></div>
    </section>
    <details class="sg-more" id="sg-more"><summary><span>More options</span><small>Spotify account, guest song requests, song memory</small>${ico("chevron")}</summary>
      <div class="sg-more-body">
        <div class="sg-opt"><div><b>Spotify connection</b><small id="sg-sp-sub">Follow Spotify on this computer, your phone or a speaker.</small></div><button class="btn" id="sg-sp-open" type="button">Set up Spotify</button></div>
        <div class="sg-opt"><div><b>Song memory</b><small>Remembers songs played here, and recognises them when they play again from anywhere.</small></div><input type="checkbox" id="sg-mem" aria-label="Song memory"></div>
        <div class="sg-opt"><div><b>Notice new songs in the music folder</b><small>Looks for new files by itself.</small></div><input type="checkbox" id="sg-watch" aria-label="Notice new songs by itself"></div>
        <div class="sg-opt sg-req"><div class="sg-req-top"><div><b>Guest song requests</b><small>Guests scan the code to ask for songs and vote; the most wanted are on top.</small></div><input type="checkbox" id="sg-reqon" aria-label="Guest song requests"></div>
          <div class="sg-req-body"><div class="sg-qr" id="sg-qr"></div><div class="sg-req-list"><ul id="sg-reqs"></ul><p class="sg-url" id="sg-requrl"></p><button class="sg-link" id="sg-reqclear" type="button">Clear all requests</button></div></div></div>
      </div></details>
  </div>`;
  const root = $("#songs", el);

  // ---------------------------------------------------------------- how it hears
  const audioMode = () => A?.state.mode || null;
  /** The card that's driving the lights now (or was chosen): files > spotify > mic > computer. */
  function activeCard(m) {
    if (audioMode() === "song" || (m?.source === "song" && m.song)) return "files";
    const sp = m?.spotify; if (sp && sp.on !== false && sp.track?.playing && ["exact", "shared", "analysis", "learning"].includes(sp.mode)) return "spotify";
    if (m?.source === "nowplaying") return "spotify";
    if (audioMode() === "mic") return "mic";
    if (audioMode() === "system") return "computer";
    const h = m?.hearing || {};
    if (h.capture?.running || h.method === "computer" || h.method === "pi") return "computer";
    if (store.get("hear") === "mic" || h.method === "mic") return "mic";
    if (sp && sp.on !== false && sp.track) return "spotify";
    return null;
  }
  function cardState(id, m, act) {
    const h = m?.hearing || {}, sp = m?.spotify, mode = audioMode();
    if (id === "computer") return mode === "system" ? ["live", "Listening"] : h.capture?.running ? ["live", h.sound === false ? "On · quiet" : "Listening"] : h.method === "computer" ? ["warn", "Starting"] : ["", "Not set up"];
    if (id === "mic") return mode === "mic" ? ["live", "Listening"] : act === "mic" ? ["on", "Chosen"] : ["", "Off"];
    if (id === "spotify") { if (DEMO) return ["", "Not in the demo"]; if (!sp || sp.on === false) return ["", "Off"];
      if (sp.track) return [sp.track.playing ? "live" : "on", sp.track.playing ? (sp.mode === "learning" ? `Learning ${sp.learn?.pct ?? 0}%` : "Following") : "Paused"];
      return ["on", sp.connected ? "Connected" : "Ready"]; }
    if (id === "files") { const n = A?.state.queue.length || 0; return mode === "song" ? ["live", A.state.song?.playing ? "Playing" : "Paused"] : A?.state.analysing ? ["warn", "Analysing"] : n ? ["on", plural(n, "song")] : ["", "Nothing added"]; }
    return ["", ""];
  }
  const bars = $$(".sg-card", root).map(c => [...c.querySelectorAll(".sg-level i")]);
  function paintCards(m) {
    const act = activeCard(m);
    $$(".sg-card", root).forEach((c, k) => {
      const id = c.dataset.card, [cls, text] = cardState(id, m, act), on = id === act;
      c.classList.toggle("active", on); c.setAttribute("aria-pressed", String(on));
      const p = c.querySelector(".sg-pill"); p.className = `sg-pill ${cls}`; p.textContent = text;
      c.querySelector(".sg-card-go").firstChild.textContent = on ? "Settings " : id === "files" ? "Open the player " : "Set up ";
      // the live level: the server's bands when it hears something, the browser's level for its own input, else still
      if (!on) return; const b = m?.bands, lv = id === "mic" || (id === "computer" && audioMode() === "system") ? A.level() : m?.level || 0;
      bars[k].forEach((x, i) => { const v = b ? Math.max(b[Math.floor(i * b.length / 16)] || 0, 0) : lv * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + performance.now() / 260))); x.style.transform = `scaleY(${Math.max(0.08, Math.min(1, v * 1.15)).toFixed(3)})`; });
    });
    const l = hearLine(m), line = $("#sg-line", root);
    line.className = `sg-line ${l.ok === true ? "ok" : l.ok === false ? "bad" : ""}`;
    line.innerHTML = `<i class="sg-dot"></i>${esc((l.text || "Not listening").replace(/ ✓/g, ""))}${l.ok === false && l.why ? ` <span class="sg-why">${esc(l.why)}</span>` : ""}`;
  }
  $$(".sg-card", root).forEach(c => c.onclick = () => openCard(c.dataset.card));

  function openCard(id) {
    if (id === "computer" || id === "mic") return openHearing(id);
    if (id === "spotify") return openSpotify();
    return openFiles();
  }
  function openHearing(id) {
    sheetKind = id;
    const s = sheet({ title: id === "mic" ? "Microphone" : "This computer's sound", onClose: () => { HR?.destroy(); HR = null; sheetKind = null; },
      html: `<div id="sg-hr"></div>
        ${id === "computer" ? `<div class="sg-other"><p class="sg-h3">Other ways</p>
          ${navigator.mediaDevices?.getDisplayMedia ? `<div class="sg-opt"><div><b>Share the sound from this browser</b><small>Chrome and Edge: pick a screen or tab and turn on Share audio. Keep this tab open.</small></div><button class="btn" id="sg-share" type="button">Share the sound</button></div>` : ""}
          ${DEMO ? "" : `<div class="sg-opt"><div><b>A Raspberry Pi or Linux box</b><small>With a USB sound card or microphone next to the speakers. Starts at every boot.</small></div><button class="btn" id="sg-pi" type="button">Use its sound input</button></div>`}</div>` : ""}
        <div class="sg-opt" id="sg-stoprow" hidden><div><b>Listening in this browser</b><small id="sg-stopwhat"></small></div><button class="btn danger" id="sg-stop" type="button">Stop listening</button></div>
        <p class="sg-err" id="sg-err" hidden></p>` });
    import("/hearing.js").then(mod => { if (!s.body.isConnected) return;
      HR = mod.mountHearing(s.body.querySelector("#sg-hr"), { bare: true, onFixTiming: () => { s.close(); location.hash = "#/lights"; } });
      HR?.choose(id); if (app.status) HR?.status(app.status); }).catch(() => {});
    const on = (sel, f) => { const b = s.body.querySelector(sel); if (b) b.onclick = f; };
    on("#sg-share", () => A.listen("system"));
    on("#sg-pi", () => HR?.choose("pi"));
    on("#sg-stop", () => A.stopLive());
    paintStop();
  }
  function paintStop() {
    const row = $("#sg-stoprow"); if (!row) return; const mode = audioMode(), live = mode === "mic" || mode === "system";
    row.hidden = !live; if (live) $("#sg-stopwhat").textContent = A.state.label || "";
    const e = $("#sg-err"); if (e) { e.hidden = !A.state.error; e.textContent = A.state.error || ""; }
  }
  function openSpotify() {
    sheetKind = "spotify";
    sheet({ title: "Spotify", wide: true, onClose: () => { SP = null; NP = null; sheetKind = null; },
      html: `<p class="sg-lede">The lights follow the Spotify track that's playing, with its beats, build-ups and drops. Songs are learned the first time they play while Tempolight hears them.</p><div id="sg-spbox"></div>${DEMO ? "" : '<div id="sg-npbox"></div>'}` });
    import("/spotify.js").then(mod => { if (!$("#sg-spbox")) return; mod.mount($("#sg-spbox"), { demo: DEMO }); SP = mod; if (app.status) mod.status(app.status); }).catch(() => {});
    if (!DEMO) import("/nowplaying.js").then(mod => { if (!$("#sg-npbox")) return; mod.mount($("#sg-npbox")); NP = mod; if (app.status) mod.status(app.status); }).catch(() => {});
  }

  // ---------------------------------------------------------------- the browser player ("Play files here")
  function openFiles() {
    sheetKind = "files";
    filesSheet = sheet({ title: "Play files here", onClose: () => { filesSheet = null; sheetKind = null; },
      html: `<p class="sg-lede">Songs play in this browser and are analysed first, so the lights know where the drops are. Nothing is uploaded: only the beat map goes to the lights.</p>
        <div id="sg-now"></div><ol class="sg-queue" id="sg-queue"></ol>
        <div class="sg-row"><button class="btn primary" id="sg-f-add" type="button">${ico("plus")}Add songs</button><button class="btn" id="sg-f-demo" type="button">Play the demo track</button></div>
        <p class="sg-err" id="sg-f-err" hidden></p>` });
    filesSheet.body.querySelector("#sg-f-add").onclick = pickFiles;
    filesSheet.body.querySelector("#sg-f-demo").onclick = () => A.addUrl("/demo.mp3", "Tempolight demo track");
    paintFiles();
  }
  function paintFiles() {
    const b = filesSheet?.body; if (!b || !b.isConnected) return; const a = A.state;
    const now = b.querySelector("#sg-now");
    if (a.analysing) now.innerHTML = `<div class="sg-nowcard"><b>${esc(a.queue[a.index]?.name || "")}</b><span class="sg-meta">Analysing ${Math.round(a.analysing * 100)}%</span><div class="sg-bar"><i style="width:${Math.round(a.analysing * 100)}%"></i></div></div>`;
    else if (a.song) { const it = a.song.item, d = A.duration;
      now.innerHTML = `<div class="sg-nowcard"><div class="sg-nowtop"><b>${esc(it.name)}</b><span class="sg-meta mono">${Math.round(it.analysis.bpm)} BPM</span></div>
        <div class="sg-bar sg-seek" id="sg-seek"><i id="sg-pos-f"></i>${it.analysis.drops.map(t => `<em style="left:${t / d * 100}%" title="Drop at ${fmtTime(t)}"></em>`).join("")}</div>
        <div class="sg-times"><span id="sg-pos">0:00</span><span>${fmtTime(d)}</span></div>
        <div class="sg-transport"><button class="btn" id="sg-prev" type="button">Previous</button><button class="btn primary sg-big" id="sg-toggle" type="button">${a.song.playing ? ico("pause") + "Pause" : ico("play") + "Play"}</button><button class="btn" id="sg-next" type="button">Next</button><button class="btn" id="sg-stopsong" type="button">Stop</button></div></div>`;
      b.querySelector("#sg-seek").onclick = e => { const r = e.currentTarget.getBoundingClientRect(); A.seek((e.clientX - r.left) / r.width * d); };
      b.querySelector("#sg-toggle").onclick = () => A.toggle(); b.querySelector("#sg-prev").onclick = () => A.prev(); b.querySelector("#sg-next").onclick = () => A.next(); b.querySelector("#sg-stopsong").onclick = () => A.stopSong(); }
    else now.innerHTML = "";
    const ql = b.querySelector("#sg-queue");
    ql.innerHTML = a.queue.map((it, i) => `<li class="${i === a.index ? "now" : ""}"><button class="sg-play" type="button" data-qp="${i}" aria-label="Play ${esc(it.name)}">${ico("play")}</button><span class="sg-qn">${esc(it.name)}</span><span class="sg-meta mono">${it.analysis ? `${Math.round(it.analysis.bpm)} BPM` : "not analysed yet"}</span><button class="sg-link" type="button" data-qr="${i}">Remove</button></li>`).join("")
      || `<li class="sg-qempty">No songs yet. Add MP3, M4A, WAV, OGG or FLAC files from this device.</li>`;
    $$("[data-qp]", ql).forEach(x => x.onclick = () => A.playIndex(Number(x.dataset.qp)));
    $$("[data-qr]", ql).forEach(x => x.onclick = () => A.remove(Number(x.dataset.qr)));
    const e = b.querySelector("#sg-f-err"); e.hidden = !a.error; e.textContent = a.error || "";
  }
  const fileIn = $("#sg-files", root);
  function pickFiles() { fileIn.click(); }
  fileIn.onchange = e => { const f = [...e.target.files]; e.target.value = ""; if (f.length) { A.addFiles(f); toast(f.length === 1 ? `Analysing ${f[0].name}` : `Adding ${f.length} songs`); } };
  $("#sg-addsongs", root).onclick = pickFiles;

  // ---------------------------------------------------------------- the music folder
  $("#sg-addfolder", root).onclick = openFolder;
  function openFolder() {
    sheetKind = "folder";
    if (DEMO) { sheet({ title: "Add a music folder", onClose: () => { sheetKind = null; }, html: `<p class="sg-lede">Installed on your computer or a Raspberry Pi, Tempolight analyses a whole music folder ahead of time, so every song is followed exactly from its first play.</p><p class="sg-lede">The online demo runs in your browser and can't read folders on your disk. Use Add songs to try it with a file.</p>` }); return; }
    if (!admin) { sheet({ title: "Add a music folder", onClose: () => { sheetKind = null; }, html: `<p class="sg-lede">The music library is locked with a PIN. Unlock it in Settings to add a folder.</p>` }); return; }
    folderSheet = sheet({ title: "Add a music folder", onClose: () => { folderSheet = null; sheetKind = null; },
      html: `<p class="sg-lede">Tempolight analyses every song in the folder ahead of time. Each one is then followed exactly from its first play, in any music player.</p>
        <div class="sg-field"><label for="sg-path">Folder on ${esc(location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "this computer" : "the computer Tempolight runs on")}</label>
          <div class="sg-pathrow"><input id="sg-path" class="mono" autocomplete="off" spellcheck="false" placeholder="~/Music"><button class="btn primary" id="sg-path-add" type="button">Add this folder</button></div>
          <small>Type its full path, for example ~/Music, /home/you/Music or C:\\Users\\you\\Music. With Docker, the folder the music is mounted at.</small></div>
        <p class="sg-err" id="sg-ff" hidden></p>
        <div id="sg-folders"></div>` });
    const inp = folderSheet.body.querySelector("#sg-path");
    folderSheet.body.querySelector("#sg-path-add").onclick = addFolder; inp.onkeydown = e => { if (e.key === "Enter") addFolder(); };
    setTimeout(() => inp.focus(), 60);
    paintFolders();
  }
  async function addFolder() {
    const inp = $("#sg-path"); const p = inp?.value.trim(); if (!p) return inp?.focus();
    const v = await act(() => api("PATCH", "/api/library", { folders: [...(lib?.folders || []).map(f => f.path), p] }), "Folder added: analysing its songs").catch(() => null);
    if (v) { inp.value = ""; lib = { ...lib, ...v }; paintFolders(); paintProgress(); pollLib(); }
  }
  function paintFolders() {
    const box = $("#sg-folders"); if (!box || !lib) return;
    const ff = $("#sg-ff"); ff.hidden = !lib.message; ff.textContent = lib.message || "";
    box.innerHTML = lib.folders.length ? `<p class="sg-h3">Your folders</p><ul class="sg-folders">${lib.folders.map((f, i) => `<li><span class="mono">${esc(f.path)}</span><span class="sg-meta">${f.exists ? plural(f.songs, "song") : "Not found"}</span><button class="sg-link" type="button" data-fdrop="${i}">Remove</button></li>`).join("")}</ul>
      <div class="sg-row"><button class="btn" id="sg-scan" type="button">Look for new songs</button></div>` : "";
    $$("[data-fdrop]", box).forEach(b => b.onclick = () => { const f = lib.folders[Number(b.dataset.fdrop)]; if (!confirm(`Stop using ${f.path}? Its songs leave the list (the files stay).`)) return;
      act(() => api("PATCH", "/api/library", { folders: lib.folders.filter(x => x !== f).map(x => x.path) }), "Folder removed").then(v => { lib = { ...lib, ...v }; paintFolders(); loadLib(); }).catch(() => {}); });
    const sc = $("#sg-scan"); if (sc) sc.onclick = () => act(() => api("POST", "/api/library/scan"), "Looking for new songs").then(v => { lib = { ...lib, ...v }; paintProgress(); pollLib(); }).catch(() => {});
  }
  async function loadLib(songs = true) {
    if (DEMO || !admin) { lib = null; return; }
    const v = await api("GET", `/api/library${songs ? "" : "?songs=0"}`).catch(() => null); if (!alive || !v) return;
    lib = songs ? v : { ...v, songs: lib?.songs || [] };
  }
  const busy = () => lib && (["scanning", "analysing", "waiting"].includes(lib.progress.state) || (lib.progress.state === "paused" && lib.counts.queued > 0));
  function paintProgress() {
    const box = $("#sg-prog", root); if (!box) return; const on = !!busy(); box.hidden = !on;
    const w = $("#sg-watch", root); if (w) { w.disabled = !lib; w.checked = !!lib?.watch; }
    if (!on) return; const P = lib.progress, c = lib.counts;
    $("#sg-prog-f", root).style.width = `${P.total ? Math.min(100, P.done / P.total * 100) : 0}%`;
    $("#sg-prog-t", root).textContent = P.state === "scanning" ? "Looking through your folders" : P.state === "paused" ? `Paused · ${plural(c.queued, "song")} still to analyse` : P.state === "waiting" ? `Waiting: ${P.waiting} · ${P.done} of ${P.total} analysed` : `Analysing ${Math.min(P.total, P.done + 1)} of ${P.total}`;
    $("#sg-prog-pause", root).textContent = lib.paused ? "Resume" : "Pause";
  }
  $("#sg-prog-pause", root).onclick = () => act(() => api("POST", `/api/library/${lib?.paused ? "resume" : "pause"}`)).then(v => { lib = { ...lib, ...v }; paintProgress(); pollLib(); }).catch(() => {});
  // while songs are analysed: progress every 2 s, the list every 10 s and at the end
  let libListAt = 0;
  function pollLib() {
    clearTimeout(libTimer); if (!alive || !lib) return;
    libTimer = setTimeout(async () => { const was = busy(), full = Date.now() - libListAt > 10000 || !was;
      await loadLib(full); if (full) { libListAt = Date.now(); paintList(); } paintProgress(); paintFolders();
      if (busy()) pollLib(); else if (was) { await loadLib(true); paintList(); } }, 2000);
  }

  // ---------------------------------------------------------------- your songs: one list
  async function loadMem() { mem = await api("GET", "/api/songs").catch(() => mem); }
  /** Everything known, as one list: {key, kind: "mem"|"lib"|"queue", id, name, bpm, key, look, dur, src, qi, file}. */
  function items() {
    const out = [], byName = new Map(), Q = A?.state.queue || [];
    for (const e of mem.slice().reverse()) { const it = { key: "m:" + e.id, kind: "mem", id: e.id, name: e.name, bpm: e.bpm, songKey: null, look: e.look || null, dur: e.dur, src: e.src || null, drops: e.drops, cover: e.cover };
      out.push(it); if (!byName.has(e.name)) byName.set(e.name, it); }
    for (const s of lib?.songs || []) out.push({ key: "l:" + s.id, kind: "lib", id: s.id, name: s.name, bpm: s.bpm, songKey: s.key, look: s.look, dur: s.dur, src: "folder", file: s.file });
    Q.forEach((it, i) => { const m = byName.get(it.name); if (m) { m.qi = i; return; }
      out.push({ key: "q:" + i, kind: "queue", id: null, name: it.name, bpm: it.analysis?.bpm || null, songKey: null, look: null, dur: it.buffer?.duration || it.analysis?.dur || null, src: "here", qi: i }); });
    return out;
  }
  const cat = it => it.kind === "lib" ? "folder" : it.kind === "queue" || !LEARNED.has(it.src) ? "here" : "learned";
  const srcText = it => it.kind === "lib" ? "Your folder" : it.kind === "queue" ? "Added here" : SRC_TEXT[it.src] ? `${SRC_TEXT[it.src]}${it.cover != null && it.cover < 100 ? ` · ${it.cover}%` : ""}` : "Played here";
  const nowName = () => { const m = app.status; return m?.song?.name || m?.recognised?.name || (A?.state.mode === "song" ? A.state.label : null); };
  function paintList() {
    const list = $("#sg-list", root); if (!list) return;
    const all = items(), n = { all: all.length, folder: 0, learned: 0, here: 0 }; for (const it of all) n[cat(it)]++;
    $$("[data-n]", root).forEach(x => x.textContent = n[x.dataset.n] ? ` ${n[x.dataset.n]}` : "");
    $("#sg-count", root).textContent = all.length ? `${plural(all.length, "song")} known${lib?.folders?.length ? ` · ${plural(lib.folders.length, "folder")}` : ""}` : "";
    const ql = q.toLowerCase(), shown = all.filter(it => (filter === "all" || cat(it) === filter) && (!ql || it.name.toLowerCase().includes(ql) || (it.file || "").toLowerCase().includes(ql)));
    if (!all.length) { list.innerHTML = empty("No songs yet", "Add songs from this device and they're analysed, played and remembered. Or add your music folder and every song in it is analysed ahead.", "Add songs", "sg-e-add", `<button class="sg-link" id="sg-e-demo" type="button">Play the demo track</button>`);
      list.querySelector("#sg-e-add").onclick = pickFiles; list.querySelector("#sg-e-demo").onclick = () => A.addUrl("/demo.mp3", "Tempolight demo track"); return; }
    if (!shown.length) { const E = q ? ["Nothing matches", `No song has “${q}” in its name.`, "Clear the search", "sg-e-clear"]
        : filter === "folder" ? ["No songs from a folder", lib?.folders?.length ? (busy() ? "The first songs are on their way." : "No songs found in your folders yet.") : "Add your music folder and every song in it is analysed ahead of time.", "Add a music folder", "sg-e-folder"]
        : filter === "learned" ? ["Nothing learned yet", "Songs Tempolight learns from Spotify while it hears them show up here.", "Set up Spotify", "sg-e-sp"]
        : ["Nothing played here yet", "Songs you add in this browser are analysed, played and remembered.", "Add songs", "sg-e-add"];
      list.innerHTML = empty(...E);
      const go = { "sg-e-clear": () => { q = ""; $("#sg-q", root).value = ""; paintList(); }, "sg-e-folder": openFolder, "sg-e-sp": openSpotify, "sg-e-add": pickFiles }[E[3]];
      list.querySelector("#" + E[3]).onclick = go; return; }
    const playing = nowName();
    list.innerHTML = `<div class="sg-rowhead" aria-hidden="true"><span></span><span>Song</span><span>Tempo</span><span>Key</span><span>Look</span><span>Length</span><span></span></div>`
      + shown.slice(0, 400).map(it => `<div class="sg-item${it.name === playing ? " now" : ""}" role="listitem" data-key="${esc(it.key)}">
        <button class="sg-play" type="button" data-act="play" aria-label="Play ${esc(it.name)}">${it.name === playing && A?.state.song?.playing ? '<span class="sg-eq"><i></i><i></i><i></i></span>' : ico("play")}</button>
        <button class="sg-name" type="button" data-act="open"><b>${esc(it.name)}</b><small>${esc(srcText(it))}<span class="sg-mmeta">${[it.bpm ? `${Math.round(it.bpm)} BPM` : "", it.songKey || "", it.dur ? fmtTime(it.dur) : ""].filter(Boolean).map(esc).join(" · ")}</span></small></button>
        <span class="sg-c mono">${it.bpm ? Math.round(it.bpm) : "–"}</span><span class="sg-c">${esc(it.songKey || "–")}</span><span class="sg-c sg-look">${esc(lookLabel(it.look) || "–")}${it.look?.locked ? ' <span class="sg-kept">Kept</span>' : ""}</span><span class="sg-c mono">${it.dur ? fmtTime(it.dur) : "–"}</span>
        <span class="sg-rowacts">${it.id ? `<button class="btn sm" type="button" data-act="show">Edit show</button>` : ""}${it.id && admin ? `<button class="btn sm sg-ghost" type="button" data-act="forget">Forget</button>` : ""}</span></div>`).join("")
      + (shown.length > 400 ? `<p class="sg-more-n">and ${shown.length - 400} more: search to find them</p>` : "");
  }
  const empty = (t, p, b, id, extra = "") => `<div class="sg-empty"><span class="sg-empty-ico">${ico("files")}</span><b>${esc(t)}</b><p>${esc(p)}</p><button class="btn primary" id="${id}" type="button">${esc(b)}</button>${extra}</div>`;
  const byKey = k => items().find(it => it.key === k);
  $("#sg-list", root).onclick = e => {
    const b = e.target.closest("[data-act]"), row = e.target.closest(".sg-item"); if (!row) return; const it = byKey(row.dataset.key); if (!it) return;
    const a = b?.dataset.act || "open";
    if (a === "play") play(it); else if (a === "show") editShow(it); else if (a === "forget") forget(it); else openDetail(it);
  };
  function play(it) {
    if (it.qi != null) { if (A.state.index === it.qi && A.state.song) A.toggle(); else A.playIndex(it.qi); return; }
    toast(`Choose the file of “${it.name}” to play it here. In your music player, it's followed as soon as it plays.`); pickFiles();
  }
  const editShow = it => { openOne?.close(); location.hash = `#/timeline/${encodeURIComponent(it.id)}`; };
  async function forget(it) {
    if (!confirm(it.kind === "lib" ? `Take “${it.name}” out of the list? The file stays in your folder.` : `Forget “${it.name}”? Its beat map and show are deleted.`)) return false;
    const ok = await act(() => api("DELETE", it.kind === "lib" ? `/api/library/songs/${it.id}` : `/api/songs/${it.id}`), "Forgotten").then(() => true).catch(() => false);
    if (!ok) return false; if (it.kind === "lib") await loadLib(); else await loadMem(); paintList(); return true;
  }
  $$("[data-f]", root).forEach(b => b.onclick = () => { filter = b.dataset.f; store.set("songs.filter", filter); $$("[data-f]", root).forEach(x => x.setAttribute("aria-selected", String(x === b))); paintList(); });
  $("#sg-q", root).oninput = e => { q = e.target.value.trim(); paintList(); };

  // ---------------------------------------------------------------- a song's detail
  function openDetail(it) {
    sheetKind = "detail";
    const s = sheet({ title: it.name, onClose: () => { detail = null; sheetKind = null; },
      html: `<p class="sg-dmeta">${[srcText(it), it.bpm ? `${Math.round(it.bpm)} BPM` : "", it.songKey, it.dur ? fmtTime(it.dur) : "", it.drops != null ? plural(it.drops, "drop") : ""].filter(Boolean).map(esc).join(" · ")}</p>
        ${it.file ? `<p class="sg-file mono">${esc(it.file)}</p>` : ""}
        <div class="sg-map" id="sg-map"><canvas aria-label="The song's map: its parts and drops" role="img"></canvas><p class="sg-mapnote" id="sg-mapnote">${it.id ? "Loading the map" : "The map appears once the song has been played and remembered."}</p></div>
        <div class="sg-parts" id="sg-parts"></div>
        <div class="sg-lookcard"><p class="sg-h3">Look</p><b id="sg-lk">${esc(lookLabel(it.look) || (it.id ? "Picked when it plays" : "Picked when it plays"))}</b><small id="sg-lkwhy"></small>
          <div class="sg-row"><button class="btn" id="sg-lknext" type="button">Try another look</button><button class="btn" id="sg-lkkeep" type="button" aria-pressed="${!!it.look?.locked}">${it.look?.locked ? "Kept" : "Keep this look"}</button></div></div>
        <div class="sg-dacts"><button class="btn primary" id="sg-d-show" type="button">Edit the show</button><button class="btn" id="sg-d-play" type="button">${ico("play")}Play</button>${it.id && admin ? `<button class="btn danger sg-ghost" id="sg-d-forget" type="button">Forget this song</button>` : ""}</div>` });
    detail = { it, s };
    const B = s.body, lookOk = guestOk("effects") && !!it.id;
    B.querySelector("#sg-d-show").disabled = !it.id; B.querySelector("#sg-d-show").onclick = () => editShow(it);
    B.querySelector("#sg-d-play").onclick = () => play(it);
    const fb = B.querySelector("#sg-d-forget"); if (fb) fb.onclick = async () => { if (await forget(it)) s.close(); };
    const nx = B.querySelector("#sg-lknext"), kp = B.querySelector("#sg-lkkeep"); nx.disabled = kp.disabled = !lookOk;
    const showLook = r => { it.look = { ...it.look, main: r.main, palette: r.palette, locked: !!r.locked, label: r.label };
      const lm = String(r.label || "").match(/^(.*?) \((.*)\)$/); // "Kick Shockwave · Fire (fast four-on-the-floor)": the reason goes below
      B.querySelector("#sg-lk").textContent = lm ? lm[1] : r.label || lookLabel(it.look); kp.setAttribute("aria-pressed", String(!!r.locked)); kp.textContent = r.locked ? "Kept" : "Keep this look";
      const why = Array.isArray(r.why) ? r.why.filter(x => typeof x === "string") : []; B.querySelector("#sg-lkwhy").textContent = lm ? cap(lm[2]) : why.join(" · "); };
    nx.onclick = () => act(() => api("POST", "/api/song/look/next", { id: it.id })).then(r => { showLook(r); toast(`Look: ${r.label}`); refreshLater(); }).catch(() => {});
    kp.onclick = () => { const kept = kp.getAttribute("aria-pressed") === "true"; act(() => api("POST", "/api/song/look/keep", { id: it.id, keep: !kept }), kept ? "The look can change again" : "Look kept for this song").then(r => { showLook(r); refreshLater(); }).catch(() => {}); };
    if (it.id) loadMap(it, B);
  }
  let refreshT = 0; const refreshLater = () => { clearTimeout(refreshT); refreshT = setTimeout(async () => { await Promise.all([loadMem(), loadLib()]); paintList(); }, 300); };
  async function loadMap(it, B) {
    let map = await api("GET", `/api/songs/${encodeURIComponent(it.id)}/map`).catch(() => null);
    if (!map || !(map.dur > 0)) { // (a music-folder song: built from its show data, the same beat map)
      const sh = await api("GET", `/api/songs/${encodeURIComponent(it.id)}/show`).catch(() => null);
      if (sh && sh.dur > 0) { let env = []; try { env = Array.from(atob(sh.env || ""), c => c.charCodeAt(0) / 255); } catch {}
        const sections = [], L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"; for (const b of sh.bars || []) { const t1 = b.t1 ?? b.t0, last = sections[sections.length - 1];
          if (last && last.state === b.state) last.t1 = t1; else sections.push({ t0: b.t0, t1, state: b.state, label: "" }); }
        sections.forEach((x, i) => { x.label = L[i % 26]; if (i === 0) x.t0 = 0; }); if (sections.length) sections[sections.length - 1].t1 = sh.dur;
        map = { dur: sh.dur, env, envStep: 0.1, drops: sh.drops || [], sections }; }
    }
    if (!B.isConnected) return; const note = B.querySelector("#sg-mapnote");
    if (!map || !(map.dur > 0)) { note.textContent = "No map for this song yet."; return; }
    note.hidden = true; drawMap(B.querySelector("#sg-map canvas"), map);
    const parts = B.querySelector("#sg-parts");
    parts.innerHTML = map.sections.map(x => `<span class="sg-part ${esc(x.state)}"><b>${esc(x.label)}</b>${esc(cap(PART_NAME[x.state] || x.state))}<span class="mono">${fmtTime(x.t0)}</span></span>`).join("");
    detail && (detail.map = map);
  }

  // ---------------------------------------------------------------- more options
  const memBox = $("#sg-mem", root), reqOn = $("#sg-reqon", root);
  memBox.checked = app.state.settings.songMemory !== false; reqOn.checked = !!app.state.settings.requests;
  memBox.disabled = reqOn.disabled = !admin; $("#sg-reqclear", root).disabled = !admin;
  memBox.onchange = e => act(() => api("PATCH", "/api/settings", { songMemory: e.target.checked }), e.target.checked ? "Song memory on" : "Song memory off").then(refreshState).catch(() => {});
  reqOn.onchange = e => act(() => api("PATCH", "/api/settings", { requests: e.target.checked }), e.target.checked ? "Requests on" : "Requests off").then(refreshState).then(paintReq).catch(() => {});
  $("#sg-watch", root).onchange = e => act(() => api("PATCH", "/api/library", { watch: e.target.checked }), e.target.checked ? "New songs are noticed by themselves" : "Only when you look for new songs").then(v => { lib = { ...lib, ...v }; }).catch(() => {});
  $("#sg-sp-open", root).onclick = openSpotify;
  $("#sg-reqclear", root).onclick = () => { if (confirm("Clear all song requests?")) act(() => api("DELETE", "/api/requests"), "Cleared").then(requests).catch(() => {}); };
  let qrDone = false;
  $("#sg-more", root).addEventListener("toggle", () => { if ($("#sg-more", root).open) { requests(); if (!qrDone) { qrDone = true; guestUrl("/request").then(async url => { const { qrSvg } = await import("/qr.js"), box = $("#sg-qr", root); if (!box) return; box.innerHTML = qrSvg(url, { px: 4 }); $("#sg-requrl", root).innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`; }).catch(() => {}); } } });
  function paintReq() { root.querySelector(".sg-req")?.classList.toggle("off", !app.state.settings.requests); }
  async function requests() { const r = await api("GET", "/api/requests").catch(() => ({ requests: [] })), ul = $("#sg-reqs", root); if (!ul) return; paintReq();
    ul.innerHTML = r.requests.length ? r.requests.map(x => `<li><span><b>${esc(x.title)}</b>${x.by ? `<small>from ${esc(x.by)}</small>` : ""}</span><span class="sg-votes mono">${x.votes} vote${x.votes === 1 ? "" : "s"}</span>${admin ? `<button class="sg-link" type="button" data-rdone="${esc(x.id)}">Played</button>` : ""}</li>`).join("") : '<li class="sg-qempty">No requests yet.</li>';
    $$("[data-rdone]", ul).forEach(b => b.onclick = () => act(() => api("PATCH", `/api/requests/${b.dataset.rdone}`, { done: true })).then(requests).catch(() => {})); }
  if (DEMO || !admin) $("#sg-watch", root).closest(".sg-opt").hidden = true;

  // ---------------------------------------------------------------- start
  (async () => { await Promise.all([loadMem(), loadLib()]); if (!alive) return; paintList(); paintProgress(); if (busy()) pollLib(); })();
  if (app.status) paintCards(app.status);
  // the level meter moves between status messages (4 a second) for the browser's own input
  let raf = 0; const tick = () => { if (!alive) return; raf = requestAnimationFrame(tick); if (!reduced() && (audioMode() === "mic" || audioMode() === "system") && app.status) paintCards(app.status); };
  raf = requestAnimationFrame(tick);
  // #/songs/hear (the top bar's Hearing chip): open the active way's set-up
  const sub = (location.hash.match(/^#\/\w+\/(\w+)/) || [])[1]; // (also #/music/hear, the old address)
  if (sub === "hear") setTimeout(() => { if (alive) openCard(activeCard(app.status) || "computer"); }, 0);
  else if (sub === "folder" || sub === "library") setTimeout(() => { if (alive) openFolder(); }, 0);
  else if (sub === "spotify") setTimeout(() => { if (alive) openSpotify(); }, 0);

  let lastNow = null;
  return {
    destroy() { alive = false; clearTimeout(libTimer); clearTimeout(refreshT); cancelAnimationFrame(raf); HR?.destroy(); openOne?.close(); },
    onStatus(m) {
      last = m; paintCards(m); HR?.status(m); if (!DEMO) { SP?.status(m); NP?.status(m); }
      const nn = nowName(); if (nn !== lastNow) { lastNow = nn; paintList(); }
      if (filesSheet && A.state.song && $("#sg-pos-f")) { const p = A.pos(); $("#sg-pos-f").style.width = `${Math.min(100, p / A.duration * 100)}%`; $("#sg-pos").textContent = fmtTime(p); }
      if (sheetKind === "mic" || sheetKind === "computer") paintStop();
    },
    onAudio() { if (app.status) paintCards(app.status); paintFiles(); paintStop(); paintList(); },
    onLog(e) { if (/^Remembered|^Song memory|^Spotify: (learned|got)/.test(e.msg)) loadMem().then(paintList); },
    async onChanged(w) {
      if (w.has("songs") || w.has("all")) { await loadMem(); paintList(); }
      if (w.has("library") || w.has("lock") || w.has("all")) { await loadLib(); paintList(); paintProgress(); paintFolders(); if (busy()) pollLib(); }
      if (w.has("requests") && $("#sg-more", root)?.open) requests();
      if (w.has("settings")) { memBox.checked = app.state.settings.songMemory !== false; reqOn.checked = !!app.state.settings.requests; paintReq(); }
    },
  };
}

// ---------------------------------------------------------------- the song map, drawn once (like apps/web/songmap.js)
function drawMap(cv, map) {
  const box = cv.parentElement, r = box.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1), W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
  cv.width = W * dpr; cv.height = H * dpr; const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const cs = getComputedStyle(box), v = n => cs.getPropertyValue(n).trim();
  const C = { panel: v("--sunk"), faint: v("--text-3"), mono: v("--mono") || "ui-monospace, monospace", part: { calm: v("--calm") || "#5b8cff", build: v("--build") || "#f5b83d", drop: v("--drop") || "#ff4f8b" } };
  const span = Math.max(1, map.dur), X = t => t / span * W, top = 18, bot = H - 6;
  ctx.font = `500 11px ${C.mono}`; ctx.textBaseline = "top";
  for (const s of map.sections) { const x0 = X(s.t0), x1 = X(s.t1), col = C.part[s.state] || C.faint;
    ctx.globalAlpha = 0.13; ctx.fillStyle = col; ctx.fillRect(x0, top, x1 - x0, bot - top);
    ctx.globalAlpha = 1; ctx.fillRect(x0, bot, x1 - x0, 4);
    if (x1 - x0 > 16) { ctx.fillStyle = col; ctx.fillText(s.label, x0 + 6, 3); }
    ctx.fillStyle = C.panel; ctx.fillRect(Math.round(x0), top, 1, H - top); }
  const env = map.env || [], st = map.envStep || 0.1, bw = Math.max(1, X(st) - (X(st) > 3 ? 1 : 0)); let si = 0;
  for (let i = 0; i < env.length; i++) { const t = i * st, x = X(t); if (t >= map.dur) break;
    while (si < map.sections.length - 1 && t >= map.sections[si].t1) si++;
    const sec = map.sections[si], h = Math.max(1, env[i] * (bot - top - 3));
    ctx.fillStyle = sec && t >= sec.t0 ? C.part[sec.state] || C.faint : C.faint; ctx.globalAlpha = 0.9; ctx.fillRect(x, bot - 1 - h, bw, h); }
  ctx.globalAlpha = 1; ctx.fillStyle = C.part.drop;
  for (const t of map.drops) { const x = X(t); ctx.beginPath(); ctx.moveTo(x - 4, top - 1); ctx.lineTo(x + 4, top - 1); ctx.lineTo(x, top + 5); ctx.closePath(); ctx.fill(); }
}
