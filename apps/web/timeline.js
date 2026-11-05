// Show editor ("a mini lighting desk") for one remembered song, at #/timeline/<song id>. Lanes on the song's own
// clock: loudness with the song's parts and drops, effect blocks, colour blocks, one-shot cues and brightness
// keyframes, on the song's beat grid. Plays along with the song in this browser (or a recognised song), previews
// unsaved changes on the lights, and saves with PUT /api/songs/:id/show.
import { app, api, act, toast, esc, panel, opt, createPreview, $, $$, guestOk } from "/app.js";

const LANES = [["ruler", 22, ""], ["song", 58, "Song"], ["fx", 46, "Effects"], ["col", 30, "Colours"], ["cue", 34, "Cues"], ["bri", 46, "Brightness"]];
const TOP = {}, HT = {}; let H = 0; for (const [k, h] of LANES) { TOP[k] = H; HT[k] = h; H += h; }
const PART = { calm: "#5b8cff", silent: "#5b8cff", build: "#f5b83d", drop: "#ff4f8b" }; // fallbacks for the --calm, --build and --drop tokens
const CUES = { flash: ["F", "Flash"], strobe: ["S", "Strobe"], blackout: ["B", "Blackout"], build: ["↑", "Build-up"], drop: ["↓", "Drop"] };
const CUE_BEATS = { flash: 0, strobe: 4, blackout: 2, build: 16, drop: 16 };
const MIN = 0.05, r3 = v => Math.round(v * 1000) / 1000, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clone = o => JSON.parse(JSON.stringify(o));
const fmt = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), x = s - m * 60; return `${m}:${x.toFixed(3).padStart(6, "0")}`; };
const fmtS = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function loadCss() { if (!document.querySelector('link[href="/timeline.css"]')) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/timeline.css"; document.head.appendChild(l); } }

export function timelinePage(el) {
  loadCss();
  const id = decodeURIComponent((location.hash.match(/^#\/timeline\/([^/?]+)/) || [])[1] || ""), hash = location.hash, A = app.audio, st = app.state;
  const fxName = Object.fromEntries(st.effects.map(e => [e.id, e.name])), fxTag = Object.fromEntries(st.effects.map(e => [e.id, e.tag]));
  let src = null, doc = null, saved = "", undo = [], redo = [], sel = null, pps = 20, cursor = 0, snap = "beat", follow = true, live = true;
  let alive = true, raf = 0, dirtyDraw = true, gesture = null, draftTimer = 0, draftSent = false, lastUser = 0, prev = null, envB = null;

  el.innerHTML = `<div class="callout span-12" id="tl-msg">Loading the show…</div>`;
  if (!id) { el.innerHTML = `<div class="callout span-12">Pick a song to edit on the <a href="#/music">Music page</a>.</div>`; return {}; }

  api("GET", `/api/songs/${encodeURIComponent(id)}/show`).then(r => { if (!alive) return; src = r; doc = { show: r.show, colors: r.colors || [], cues: r.cues || [], bright: r.bright || [] }; saved = JSON.stringify(doc);
    try { envB = Uint8Array.from(atob(r.env || ""), c => c.charCodeAt(0)); } catch { envB = new Uint8Array(0); } build(); })
    .catch(e => { if (alive) el.innerHTML = `<div class="callout err span-12">${e.status === 404 ? "That song isn't remembered any more." : esc(e.message)} <a href="#/music">Back to Music</a></div>`; });

  // ---------------------------------------------------------------- grid and snapping
  const dur = () => src.dur || 1;
  const beatT = k => src.off + k * src.P;
  function snapT(t, ev) {
    if (snap === "off" || ev?.shiftKey || !(src.P > 0)) return r3(clamp(t, 0, dur()));
    const b = (t - src.off) / src.P; let k = Math.round(b);
    if (snap === "bar") k = Math.round((b - src.barOff) / 4) * 4 + src.barOff;
    let s = beatT(k); if (Math.abs(t) < Math.abs(t - s)) s = 0; // the very start is always a grid point
    return r3(clamp(s, 0, dur()));
  }
  const step = big => snap === "off" || !(src.P > 0) ? (big ? 0.1 : 0.01) : snap === "bar" || big ? src.P * 4 : src.P;

  // ---------------------------------------------------------------- page
  function build() {
    const canEdit = guestOk("effects");
    el.innerHTML = `
      ${panel(`Show: ${esc(src.name)}`, `<span id="tl-state"></span>`, `<a class="btn" href="#/music">Music</a><button class="btn" id="tl-reset" type="button">Reset to automatic</button><button class="btn primary" id="tl-save" type="button" disabled>Save</button>`, `
        <div class="tl-bar">
          <div class="grp"><button class="btn primary" id="tl-play" type="button" aria-label="Play or pause (space)">Play</button><span class="tl-time" id="tl-time">0:00.000</span><span class="faint" id="tl-src" style="font-size:13px"></span></div>
          <div class="sep"></div>
          <div class="grp"><button class="btn sm" id="tl-undo" type="button" title="Undo (Ctrl+Z)" disabled>Undo</button><button class="btn sm" id="tl-redo" type="button" title="Redo (Ctrl+Shift+Z)" disabled>Redo</button></div>
          <div class="sep"></div>
          <div class="grp"><label class="faint" for="tl-snap" style="font-size:13px">Snap</label><select id="tl-snap">${opt("off", "Off", snap === "off")}${opt("beat", "Beats", snap === "beat")}${opt("bar", "Bars", snap === "bar")}</select>
            <button class="btn sm" id="tl-zout" type="button" aria-label="Zoom out">−</button><button class="btn sm" id="tl-zin" type="button" aria-label="Zoom in">+</button><button class="btn sm" id="tl-zfit" type="button">Fit</button>
            <label class="check" style="font-size:13px"><input type="checkbox" id="tl-follow" checked> Follow</label></div>
          <div class="sep"></div>
          <div class="grp"><button class="btn sm" id="tl-split" type="button" title="Split the block at the playhead">Split</button><button class="btn sm" id="tl-dup" type="button">Duplicate</button><button class="btn sm" id="tl-del" type="button">Delete</button></div>
          <div class="sep"></div>
          <div class="grp"><span class="faint" style="font-size:13px">Add at playhead:</span>${Object.entries(CUES).map(([k, [, n]]) => `<button class="btn sm" data-add="${k}" type="button">${n}</button>`).join("")}<button class="btn sm" data-add="color" type="button">Colour</button><button class="btn sm" data-add="key" type="button">Brightness</button></div>
        </div>
        <div class="tl-wrap"><div class="tl-labels">${LANES.map(([k, h, n]) => `<div style="height:${h}px">${n}</div>`).join("")}</div>
          <div class="tl-scroll" id="tl-sc" tabindex="0" aria-label="Show timeline"><div class="tl-inner" id="tl-in"><canvas id="tl-cv"></canvas><div class="tl-lanes" id="tl-lanes">${LANES.map(([k, h]) => `<div class="tl-lane" data-lane="${k}" style="top:${TOP[k]}px;height:${h}px"></div>`).join("")}</div></div></div></div>
        <div class="tl-help"><kbd>Space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> nudge (Shift: a bar) · <kbd>Del</kbd> delete · <kbd>Ctrl</kbd>+wheel or pinch to zoom · double-click a lane to add · drag block edges to resize · Shift while dragging: no snap</div>`, "span-12")}
      ${panel("Selected", `<span id="tl-selname">Nothing</span>`, "", `<div class="pb" id="tl-insp"></div>`, "span-8")}
      ${panel("Live preview", "", `<label class="check" style="font-size:13px"><input type="checkbox" id="tl-live" checked> Preview changes on the lights</label>`, `<div class="stage" id="tl-stage"></div><p class="faint pb" style="font-size:13px;padding-top:8px">While the song plays, the lights play your unsaved version; it is kept only when you save.</p>`, "span-4")}
      ${canEdit ? "" : `<div class="callout err span-12">Tempolight is locked: guests can't change shows. Unlock it in Settings to save.</div>`}`;
    prev = createPreview($("#tl-stage"));
    const sc = $("#tl-sc");
    pps = Math.max(2, (sc.clientWidth - 8) / dur()); if (pps < 12) pps = Math.min(12, pps * 3); // start a little zoomed in on long songs
    wire(); layout(); render(); insp(); state(); loop();
    addEventListener("keydown", onKey); addEventListener("beforeunload", onUnload); addEventListener("resize", layout);
  }

  // ---------------------------------------------------------------- history and saving
  const isDirty = () => doc && JSON.stringify(doc) !== saved;
  function begin() { undo.push(JSON.stringify(doc)); if (undo.length > 200) undo.shift(); redo = []; }
  function changed() { render(); insp(); state(); scheduleDraft(); }
  function restore(json) { doc = JSON.parse(json); sel = null; changed(); }
  function doUndo() { if (!undo.length) return; redo.push(JSON.stringify(doc)); restore(undo.pop()); }
  function doRedo() { if (!redo.length) return; undo.push(JSON.stringify(doc)); restore(redo.pop()); }
  function state() {
    const d = isDirty(); $("#tl-save").disabled = !d; $("#tl-undo").disabled = !undo.length; $("#tl-redo").disabled = !redo.length;
    $("#tl-state").innerHTML = d ? '<span class="tl-dirty">Unsaved changes</span>' : src.edited || JSON.parse(saved).cues.length ? "Edited by hand" : "Automatic";
  }
  const body = () => ({ show: doc.show, colors: doc.colors, cues: doc.cues, bright: doc.bright });
  async function save() {
    if (!doc.show.length) { toast("A show needs at least one effect block", true); return; }
    const r = await act(() => api("PUT", `/api/songs/${encodeURIComponent(id)}/show`, body()), "Show saved").catch(() => null); if (!r) return;
    doc = { show: r.show, colors: r.colors, cues: r.cues, bright: r.bright }; saved = JSON.stringify(doc); src.edited = true; draftSent = false; sel = null; changed();
  }
  async function reset() {
    if (!confirm("Throw away your changes and make a new automatic show for this song?")) return;
    const r = await act(() => api("DELETE", `/api/songs/${encodeURIComponent(id)}/show`), "A new automatic show").catch(() => null); if (!r) return;
    undo.push(JSON.stringify(doc)); doc = { show: r.show, colors: [], cues: [], bright: [] }; saved = JSON.stringify(doc); src.edited = false; draftSent = false; sel = null; changed();
  }
  // unsaved edits play on the lights while the song plays (the server keeps the draft for 2 minutes; sent again while open)
  function scheduleDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(sendDraft, 250); }
  function sendDraft() {
    if (!alive) return;
    if (live && isDirty() && doc.show.length) { draftSent = true; api("PUT", `/api/songs/${encodeURIComponent(id)}/show/draft`, body()).catch(() => {}); }
    else if (draftSent) { draftSent = false; api("DELETE", `/api/songs/${encodeURIComponent(id)}/show/draft`).catch(() => {}); }
  }
  const keepDraft = setInterval(() => { if (draftSent) sendDraft(); }, 60000);
  function onUnload(e) { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } }

  // ---------------------------------------------------------------- the song playing here (or recognised)
  const mine = () => A.state.song && A.state.song.item.name === src.name;
  const queued = () => A.state.queue.findIndex(q => q.name === src.name);
  function playhead() { if (mine()) return A.pos(); const rec = app.status?.recognised; if (rec && rec.id === id) return rec.pos; return cursor; }
  const playing = () => (mine() && A.state.song.playing) || app.status?.recognised?.id === id;
  async function togglePlay() {
    if (mine()) { if (A.state.song.playing) A.toggle(); else { A.seek(cursor); if (!A.state.song.playing) A.toggle(); } return; }
    let i = queued();
    if (i < 0 && src.name === "Tempolight demo track") { A.state.queue.push({ name: src.name, url: "/demo.mp3", buffer: null, analysis: null }); i = A.state.queue.length - 1; }
    if (i < 0) { pickFile(); return; }
    $("#tl-src").textContent = "Loading the song…"; await A.playIndex(i); if (mine()) A.seek(cursor);
  }
  function pickFile() {
    const f = document.createElement("input"); f.type = "file"; f.accept = "audio/*";
    f.onchange = async () => { const file = f.files[0]; if (!file) return; await A.addFiles([file]); const i = A.state.queue.length - 1; A.state.queue[i].name = src.name; if (!mine()) await A.playIndex(i); if (mine()) A.seek(cursor); };
    toast("Pick this song's audio file to hear it while you edit"); f.click();
  }
  function seekTo(t) { cursor = r3(clamp(t, 0, dur())); if (mine()) A.seek(cursor); dirtyDraw = true; }

  // ---------------------------------------------------------------- drawing
  function layout() { const sc = $("#tl-sc"); if (!sc) return; const W = Math.max(Math.ceil(dur() * pps) + 24, sc.clientWidth), cv = $("#tl-cv"), dpr = Math.min(2, devicePixelRatio || 1);
    $("#tl-in").style.width = W + "px"; $("#tl-in").style.height = H + "px"; $("#tl-lanes").style.width = W + "px"; $$("#tl-lanes .tl-lane").forEach(l => l.style.width = W + "px");
    cv.style.width = sc.clientWidth + "px"; cv.style.height = H + "px"; cv.width = Math.round(sc.clientWidth * dpr); cv.height = Math.round(H * dpr); dirtyDraw = true; }
  function draw() {
    const sc = $("#tl-sc"), cv = $("#tl-cv"); if (!sc || !cv) return; const c = cv.getContext("2d"), dpr = cv.width / Math.max(1, sc.clientWidth), w = sc.clientWidth;
    const css = getComputedStyle(document.documentElement), V0 = k => css.getPropertyValue(k).trim(), TOK = { "--panel-2": "--sunk", "--panel": "--surface", "--line": "--hair", "--line-2": "--hair", "--muted": "--text-2", "--faint": "--text-3" }, V = k => (TOK[k] && V0(TOK[k])) || V0(k), PT = st => V0("--" + (st === "silent" ? "calm" : st)) || PART[st] || PART.calm, x0 = sc.scrollLeft, X = t => t * pps - x0, t0 = x0 / pps, t1 = (x0 + w) / pps;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, H);
    c.fillStyle = V("--panel-2"); c.fillRect(0, 0, w, H);
    for (const k of ["fx", "cue"]) { c.fillStyle = V("--panel"); c.fillRect(0, TOP[k], w, HT[k]); }
    c.fillStyle = V("--line-2"); for (const [k] of LANES) c.fillRect(0, TOP[k] + HT[k] - 1, w, 1);
    // song parts under the loudness
    for (const b of src.bars || []) { if (b.t1 < t0 || b.t0 > t1) continue; c.fillStyle = PT(b.state); c.globalAlpha = 0.24; c.fillRect(X(b.t0), TOP.song, (b.t1 - b.t0) * pps, HT.song - 1); }
    c.globalAlpha = 1;
    if (envB && envB.length) { const mid = TOP.song + HT.song / 2, amp = HT.song / 2 - 3; c.fillStyle = V("--muted"); c.beginPath(); c.moveTo(X(t0), mid);
      const dt = Math.max(0.1, 1 / pps); for (let t = Math.floor(t0 * 10) / 10; t <= t1 + dt; t += dt) { const i = Math.round(t * 10); let v = 0; for (let j = i; j < i + Math.max(1, Math.round(dt * 10)); j++) v = Math.max(v, envB[j] || 0); c.lineTo(X(t), mid - (v / 255) * amp); }
      for (let t = t1 + dt; t >= Math.floor(t0 * 10) / 10 - dt; t -= dt) { const i = Math.round(t * 10); let v = 0; for (let j = i; j < i + Math.max(1, Math.round(dt * 10)); j++) v = Math.max(v, envB[j] || 0); c.lineTo(X(t), mid + (v / 255) * amp); }
      c.closePath(); c.globalAlpha = 0.75; c.fill(); c.globalAlpha = 1; }
    // beat and bar lines
    if (src.P > 0) { const kb = Math.floor((t0 - src.off) / src.P) - 1, ke = Math.ceil((t1 - src.off) / src.P) + 1, showBeats = src.P * pps >= 7, showBars = src.P * 4 * pps >= 10;
      for (let k = kb; k <= ke; k++) { const bar = (((k - src.barOff) % 4) + 4) % 4 === 0; if (!(bar ? showBars : showBeats)) continue; const x = Math.round(X(beatT(k))) + 0.5;
        c.fillStyle = V(bar ? "--line" : "--line-2"); c.globalAlpha = bar ? 1 : 0.9; c.fillRect(x, TOP.song, 1, H - TOP.song);
        if (bar && src.P * 16 * pps >= 60 && ((k - src.barOff) / 4) % (src.P * 4 * pps < 40 ? 4 : 1) === 0) { c.fillStyle = V("--faint"); c.font = "10px " + V("--mono"); c.fillText(String((k - src.barOff) / 4 + 1), x + 3, TOP.song + 10); } }
      c.globalAlpha = 1; }
    // ruler
    c.fillStyle = V("--panel"); c.fillRect(0, 0, w, HT.ruler - 1); const stp = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find(s => s * pps >= 64) || 120;
    c.fillStyle = V("--faint"); c.font = "10.5px " + V("--mono");
    for (let t = Math.floor(t0 / stp) * stp; t <= t1; t += stp) { const x = Math.round(X(t)) + 0.5; c.fillRect(x, 12, 1, HT.ruler - 13); c.fillText(stp < 1 ? `${fmtS(t)}.${String(Math.round((t % 1) * 100)).padStart(2, "0")}` : fmtS(t), x + 3, 11); }
    // drops
    c.fillStyle = PT("drop"); for (const d of src.drops || []) { if (d < t0 - 1 || d > t1 + 1) continue; const x = X(d); c.fillRect(Math.round(x) - 1, TOP.song, 2, HT.song); c.beginPath(); c.moveTo(x - 5, TOP.song); c.lineTo(x + 5, TOP.song); c.lineTo(x, TOP.song + 7); c.fill(); }
    // brightness curve
    const by = v => TOP.bri + 5 + (1 - v) * (HT.bri - 11), keys = doc.bright; c.strokeStyle = V("--accent"); c.lineWidth = 1.5; c.setLineDash(keys.length ? [] : [4, 4]); c.beginPath();
    if (!keys.length) { c.moveTo(0, by(1)); c.lineTo(w, by(1)); } else { c.moveTo(0, by(keys[0].v)); for (const k of keys) c.lineTo(X(k.t), by(k.v)); c.lineTo(w, by(keys.at(-1).v)); }
    c.stroke(); c.setLineDash([]); if (keys.length) { c.lineTo(w, TOP.bri + HT.bri - 1); c.lineTo(0, TOP.bri + HT.bri - 1); c.closePath(); c.globalAlpha = 0.12; c.fillStyle = V("--accent"); c.fill(); c.globalAlpha = 1; }
    // playhead
    const ph = playhead(), px = Math.round(X(ph)) + 0.5; c.fillStyle = V("--text"); c.fillRect(px - 0.5, 0, 2, H); c.beginPath(); c.moveTo(px - 6, 0); c.lineTo(px + 6, 0); c.lineTo(px, 8); c.fill();
  }
  function loop() {
    if (!alive) return; raf = requestAnimationFrame(loop); if (!src || !$("#tl-sc")) return;
    const p = playing(); if (p) { cursor = r3(playhead()); dirtyDraw = true;
      const sc = $("#tl-sc"), x = cursor * pps; if (follow && !gesture && performance.now() - lastUser > 1500 && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth * 0.85)) sc.scrollLeft = x - sc.clientWidth * 0.2; }
    const tm = $("#tl-time"); tm.textContent = fmt(cursor);
    const pb = $("#tl-play"), want = mine() && A.state.song.playing ? "Pause" : "Play"; if (pb.textContent !== want) pb.textContent = want;
    const sl = mine() ? "" : app.status?.recognised?.id === id ? "Following the song live" : queued() >= 0 || src.name === "Tempolight demo track" ? "" : "Not loaded here: Play asks for the file", se = $("#tl-src");
    if (se.textContent !== sl && !(sl === "" && se.textContent === "Loading the song…" && !mine())) se.textContent = sl;
    if (dirtyDraw) { dirtyDraw = false; draw(); }
  }

  // ---------------------------------------------------------------- items
  function render() {
    const lane = k => $(`#tl-lanes [data-lane="${k}"]`); if (!lane("fx")) return;
    const P = src.P > 0 ? src.P : 0.5, S = it => it === sel?.item ? " sel" : "";
    lane("fx").innerHTML = doc.show.map((b, i) => `<div class="tl-it tl-blk ${esc(b.part)}${S(b)}" data-i="${i}" style="left:${b.t0 * pps}px;width:${Math.max(3, (b.t1 - b.t0) * pps)}px" title="${esc(fxName[b.effect] || b.effect)} · ${fmt(b.t0)}–${fmt(b.t1)}"><span class="h l" data-edge="l"></span>${(b.t1 - b.t0) * pps > 28 ? `${esc(fxName[b.effect] || b.effect)}<small>${esc(b.part)}</small>` : ""}<span class="h r" data-edge="r"></span></div>`).join("");
    lane("col").innerHTML = doc.colors.map((b, i) => { const [a, z] = b.colors || src.palettes[b.palette] || ["#888888", "#888888"];
      return `<div class="tl-it tl-col${S(b)}" data-i="${i}" style="left:${b.t0 * pps}px;width:${Math.max(3, (b.t1 - b.t0) * pps)}px;background:linear-gradient(90deg,${a},${z})" title="${esc(b.palette || "Custom colours")} · ${fmt(b.t0)}–${fmt(b.t1)}"><span class="h l" data-edge="l"></span>${(b.t1 - b.t0) * pps > 40 ? esc(b.palette || "custom") : ""}<span class="h r" data-edge="r"></span></div>`; }).join("");
    lane("cue").innerHTML = doc.cues.map((c, i) => { const len = (c.beats ?? CUE_BEATS[c.type]) * P * pps;
      return `<div class="tl-it tl-cue ${c.type}${S(c)}" data-i="${i}" style="left:${c.t * pps}px;width:${Math.max(10, len)}px" title="${CUES[c.type][1]} at ${fmt(c.t)}${c.type !== "flash" ? ` for ${c.beats ?? CUE_BEATS[c.type]} beats` : ""}">${len ? `<b style="width:${len}px"></b>` : ""}<i${c.color ? ` style="background:${c.color}"` : ""}>${CUES[c.type][0]}</i></div>`; }).join("");
    lane("bri").innerHTML = doc.bright.map((k, i) => `<div class="tl-it tl-key${S(k)}" data-i="${i}" style="left:${k.t * pps}px;top:${5 + (1 - k.v) * (HT.bri - 11)}px" title="${Math.round(k.v * 100)}% at ${fmt(k.t)}"></div>`).join("");
    dirtyDraw = true;
  }
  const listOf = lane => lane === "fx" ? doc.show : lane === "col" ? doc.colors : lane === "cue" ? doc.cues : doc.bright;
  const sortLane = lane => listOf(lane).sort((a, b) => (a.t0 ?? a.t) - (b.t0 ?? b.t));
  function select(lane, item) { sel = item ? { lane, item } : null; render(); insp(); }

  // effect and colour blocks never overlap; a neighbour that touches a block moves its edge with it
  function rangeGesture(lane, item, kind) {
    const list = listOf(lane), i = list.indexOf(item), p = list[i - 1], n = list[i + 1];
    const g = { lane, item, kind, o: { t0: item.t0, t1: item.t1 }, p, n, pg: p && Math.abs(p.t1 - item.t0) < 1e-3, ng: n && Math.abs(n.t0 - item.t1) < 1e-3, po: p && { t0: p.t0, t1: p.t1 }, no: n && { t0: n.t0, t1: n.t1 } };
    g.apply = (dt, ev, raw) => { const it = g.item, len = g.o.t1 - g.o.t0, lo = p ? (g.pg ? g.po.t0 + MIN : g.po.t1) : 0, hi = n ? (g.ng ? g.no.t1 - MIN : g.no.t0) : dur();
      const sn = v => raw ? r3(v) : snapT(v, ev);
      if (kind === "move") { const a = clamp(sn(g.o.t0 + dt), lo, Math.max(lo, hi - len)); it.t0 = r3(a); it.t1 = r3(a + len); }
      else if (kind === "l") it.t0 = r3(clamp(sn(g.o.t0 + dt), lo, it.t1 - MIN));
      else it.t1 = r3(clamp(sn(g.o.t1 + dt), it.t0 + MIN, hi));
      if (g.pg) p.t1 = it.t0; else if (p) p.t1 = Math.min(g.po.t1, it.t0);
      if (g.ng) n.t0 = it.t1; else if (n) n.t0 = Math.max(g.no.t0, it.t1); };
    return g;
  }
  function pointGesture(lane, item) {
    const g = { lane, item, kind: "move", o: { t: item.t, v: item.v } };
    g.apply = (dt, ev, raw, y) => { item.t = raw ? r3(clamp(g.o.t + dt, 0, dur())) : snapT(g.o.t + dt, ev); if (lane === "bri" && y != null) item.v = Math.round(clamp(1 - (y - TOP.bri - 5) / (HT.bri - 11), 0, 1) * 100) / 100; sortLane(lane); };
    return g;
  }
  const gestureFor = (lane, item, kind) => lane === "fx" || lane === "col" ? rangeGesture(lane, item, kind || "move") : pointGesture(lane, item);

  function carve(list, item) { // put a block in, trimming or splitting whatever it covers
    const out = []; for (const x of list) { if (x.t1 <= item.t0 + 1e-6 || x.t0 >= item.t1 - 1e-6) { out.push(x); continue; }
      if (x.t0 < item.t0 - MIN) out.push({ ...x, t1: item.t0 }); if (x.t1 > item.t1 + MIN) out.push({ ...x, t0: item.t1 }); }
    out.push(item); out.sort((a, b) => a.t0 - b.t0); list.splice(0, list.length, ...out);
  }
  function addAt(kind, t, y) {
    if (!doc) return; t = snapT(t); const P = src.P > 0 ? src.P : 0.5; begin(); let lane, item;
    if (CUES[kind]) { lane = "cue"; item = { t, type: kind }; if (kind === "flash") item.color = "#ffffff"; else item.beats = CUE_BEATS[kind]; doc.cues.push(item); sortLane("cue"); }
    else if (kind === "key") { lane = "bri"; item = { t, v: y == null ? 1 : Math.round(clamp(1 - (y - TOP.bri - 5) / (HT.bri - 11), 0, 1) * 100) / 100 };
      if (!doc.bright.length && item.v !== 1 && t > 0) doc.bright.push({ t: 0, v: 1 }); doc.bright.push(item); sortLane("bri"); }
    else if (kind === "color") { lane = "col"; const nx = doc.colors.find(b => b.t0 > t), t1 = r3(Math.min(dur(), t + P * 16, nx ? nx.t0 : 1e9)); if (t1 - t < MIN) { undo.pop(); toast("No room for a colour block here", true); return; }
      item = { t0: t, t1, palette: Object.keys(src.palettes)[0] }; carve(doc.colors, item); }
    else if (kind === "fx") { lane = "fx"; const pv = [...doc.show].reverse().find(b => b.t1 <= t + 1e-3), nx = doc.show.find(b => b.t0 >= t - 1e-3); // fill the gap
      const a = pv ? pv.t1 : 0, z = nx ? nx.t0 : dur(); if (z - a < MIN) { undo.pop(); return; }
      item = { t0: r3(a), t1: r3(z), part: pv?.part || nx?.part || "calm", effect: pv?.effect || nx?.effect || st.effects[0].id }; carve(doc.show, item); }
    sel = { lane, item }; changed();
  }
  function selRange() { if (sel && (sel.lane === "fx" || sel.lane === "col")) return sel; const b = doc.show.find(x => x.t0 < cursor && x.t1 > cursor); return b ? { lane: "fx", item: b } : null; }
  function split() {
    const s = selRange(); const t = snapT(cursor); if (!s || !(t > s.item.t0 + MIN && t < s.item.t1 - MIN)) { toast("Put the playhead inside a block to split it", true); return; }
    begin(); const list = listOf(s.lane), i = list.indexOf(s.item), b = { ...s.item, t0: t }; s.item.t1 = t; list.splice(i + 1, 0, b); sel = { lane: s.lane, item: b }; changed();
  }
  function duplicate() {
    if (!sel) { toast("Select something to duplicate", true); return; } const P = src.P > 0 ? src.P : 0.5; const it = sel.item; begin();
    if (sel.lane === "fx" || sel.lane === "col") { const len = it.t1 - it.t0, b = { ...it, t0: it.t1, t1: r3(Math.min(dur(), it.t1 + len)) }; if (b.t1 - b.t0 < MIN) { undo.pop(); return; } carve(listOf(sel.lane), b); sel = { lane: sel.lane, item: b }; }
    else { const c = { ...it, t: r3(Math.min(dur(), it.t + (snap === "bar" ? P * 4 : P))) }; listOf(sel.lane).push(c); sortLane(sel.lane); sel = { lane: sel.lane, item: c }; }
    changed();
  }
  function remove() {
    if (!sel) return; const list = listOf(sel.lane), i = list.indexOf(sel.item); if (i < 0) return;
    if (sel.lane === "fx") { if (list.length === 1) { toast("A show needs at least one effect block", true); return; }
      begin(); const p = list[i - 1], n = list[i + 1]; if (p && Math.abs(p.t1 - sel.item.t0) < 1e-3) p.t1 = sel.item.t1; else if (n && Math.abs(n.t0 - sel.item.t1) < 1e-3) n.t0 = sel.item.t0; } // its neighbour takes its place
    else begin();
    list.splice(i, 1); sel = null; changed();
  }
  function nudge(dir, big) {
    if (!sel) { seekTo(cursor + dir * step(big)); return; } begin(); const g = gestureFor(sel.lane, sel.item, "move"); g.apply(dir * step(big), null, true); changed();
  }

  // ---------------------------------------------------------------- inspector for what's selected
  function insp() {
    const box = $("#tl-insp"); if (!box) return; const P = src.P > 0 ? src.P : 0.5;
    if (!sel) { $("#tl-selname").textContent = "Nothing"; box.innerHTML = `<p class="muted">Tap a block, cue or keyframe to change it. Drag blocks to move them, drag their edges to resize. Double-click (or double-tap) an empty spot in a lane to add something there.</p>
      <p class="faint" style="font-size:13px;margin-top:8px">${doc.show.length} effect blocks · ${doc.colors.length} colour blocks · ${doc.cues.length} cues · ${doc.bright.length} brightness keyframes · ${Math.round(src.bpm)} BPM</p>`; return; }
    const it = sel.item, num = (k, label, v, stp = 0.001, extra = "") => `<div class="field"><label for="ti-${k}">${label}</label><input type="number" id="ti-${k}" data-k="${k}" step="${stp}" value="${v}" ${extra}></div>`;
    if (sel.lane === "fx") {
      $("#tl-selname").textContent = `Effect block · ${fxName[it.effect] || it.effect}`;
      box.innerHTML = `<div class="tl-insp">${num("t0", "Starts (s)", it.t0)}${num("t1", "Ends (s)", it.t1)}<div class="field"><label for="ti-part">Song part</label><select id="ti-part">${["calm", "build", "drop"].map(p => opt(p, { calm: "Calm", build: "Build-up", drop: "Drop" }[p], p === it.part)).join("")}</select></div>
        <div class="field wide"><label for="ti-q">Effect</label><input type="text" id="ti-q" placeholder="Search effects…" autocomplete="off"></div><div class="tl-fxlist wide" id="ti-fx"></div></div>`;
      const list = () => { const q = $("#ti-q").value.trim().toLowerCase(); $("#ti-fx").innerHTML = st.effects.filter(e => !q || e.name.toLowerCase().includes(q) || e.id.includes(q) || (e.tag || "").includes(q)).sort((a, b) => (a.tag === it.part ? 0 : 1) - (b.tag === it.part ? 0 : 1))
        .map(e => `<button type="button" data-fx="${esc(e.id)}" aria-pressed="${e.id === it.effect}">${esc(e.name)}<small>${esc(e.tag || "")}</small></button>`).join("") || '<span class="faint">No effect matches</span>';
        $$("#ti-fx [data-fx]").forEach(b => b.onclick = () => { begin(); it.effect = b.dataset.fx; changed(); }); };
      list(); $("#ti-q").oninput = list;
      $("#ti-part").onchange = e => { begin(); it.part = e.target.value; changed(); };
    } else if (sel.lane === "col") {
      $("#tl-selname").textContent = "Colour block"; const custom = !!it.colors, cs = it.colors || src.palettes[it.palette] || ["#ffffff", "#ffffff"];
      box.innerHTML = `<div class="tl-insp">${num("t0", "Starts (s)", it.t0)}${num("t1", "Ends (s)", it.t1)}<div class="field"><label for="ti-mode">Colours</label><select id="ti-mode">${opt("pal", "A palette", !custom)}${opt("custom", "My own colours", custom)}</select></div>
        ${custom ? `<div class="field"><label for="ti-c0">Colour 1</label><input type="color" id="ti-c0" value="${cs[0]}"></div><div class="field"><label for="ti-c1">Colour 2</label><input type="color" id="ti-c1" value="${cs[1]}"></div>`
          : `<div class="field wide"><label>Palette</label><div class="chips">${Object.entries(src.palettes).map(([k, [a, z]]) => `<button class="chip" type="button" data-pal="${esc(k)}" aria-pressed="${k === it.palette}"><span class="tl-sw" style="background:linear-gradient(90deg,${a},${z})"></span>${esc(k)}</button>`).join("")}</div></div>`}</div>`;
      $("#ti-mode").onchange = e => { begin(); if (e.target.value === "custom") { it.colors = [...cs]; delete it.palette; } else { delete it.colors; it.palette = Object.keys(src.palettes)[0]; } changed(); };
      $$("#tl-insp [data-pal]").forEach(b => b.onclick = () => { begin(); it.palette = b.dataset.pal; changed(); });
      for (const k of [0, 1]) { const inp = $(`#ti-c${k}`); if (inp) inp.onchange = e => { begin(); it.colors[k] = e.target.value; changed(); }; }
    } else if (sel.lane === "cue") {
      $("#tl-selname").textContent = `Cue · ${CUES[it.type][1]}`;
      box.innerHTML = `<div class="tl-insp"><div class="field"><label for="ti-type">Cue</label><select id="ti-type">${Object.entries(CUES).map(([k, [, n]]) => opt(k, n, k === it.type)).join("")}</select></div>${num("t", "At (s)", it.t)}
        ${it.type === "flash" ? `<div class="field"><label for="ti-col">Flash colour</label><input type="color" id="ti-col" value="${it.color || "#ffffff"}"></div>` : num("beats", `Lasts (beats, ${(P * (it.beats ?? CUE_BEATS[it.type])).toFixed(2)} s)`, it.beats ?? CUE_BEATS[it.type], 0.25, 'min="0.25" max="128"')}</div>
        <p class="faint" style="font-size:13px;margin-top:8px">${{ flash: "A single flash of colour on top of everything, exactly at this time.", strobe: "The whole room strobes in sixteenth notes.", blackout: "Everything goes dark.", build: "The music is treated as a build-up: build effects and rising energy until it ends.", drop: "The drop hits here: a flash and the drop's energy." }[it.type]}</p>`;
      $("#ti-type").onchange = e => { begin(); it.type = e.target.value; if (it.type === "flash") { delete it.beats; it.color = it.color || "#ffffff"; } else { delete it.color; it.beats = CUE_BEATS[it.type]; } changed(); };
      const col = $("#ti-col"); if (col) col.onchange = e => { begin(); it.color = e.target.value; changed(); };
    } else {
      $("#tl-selname").textContent = "Brightness keyframe";
      box.innerHTML = `<div class="tl-insp">${num("t", "At (s)", it.t)}<div class="field"><label for="ti-v">Brightness <output id="ti-vo">${Math.round(it.v * 100)}%</output></label><input type="range" id="ti-v" min="0" max="100" value="${Math.round(it.v * 100)}"></div></div>`;
      $("#ti-v").oninput = e => { $("#ti-vo").textContent = e.target.value + "%"; }; $("#ti-v").onchange = e => { begin(); it.v = Number(e.target.value) / 100; changed(); };
    }
    $$("#tl-insp input[type=number][data-k]").forEach(inp => inp.onchange = () => { const k = inp.dataset.k, v = Number(inp.value); if (!Number.isFinite(v)) { insp(); return; }
      begin(); if (k === "beats") it.beats = clamp(Math.round(v * 4) / 4, 0.25, 128);
      else if (k === "t") { it.t = r3(clamp(v, 0, dur())); sortLane(sel.lane); }
      else { const g = rangeGesture(sel.lane, it, k === "t0" ? "l" : "r"); g.apply(v - (k === "t0" ? it.t0 : it.t1), null, true); }
      changed(); });
  }

  // ---------------------------------------------------------------- input: pointer, touch pinch, wheel, keys
  function wire() {
    const sc = $("#tl-sc"), inner = $("#tl-in"), tAt = x => (x - inner.getBoundingClientRect().left) / pps, yAt = y => y - inner.getBoundingClientRect().top;
    $("#tl-save").onclick = save; $("#tl-reset").onclick = reset; $("#tl-undo").onclick = doUndo; $("#tl-redo").onclick = doRedo; $("#tl-play").onclick = togglePlay;
    $("#tl-snap").onchange = e => { snap = e.target.value; }; $("#tl-follow").onchange = e => { follow = e.target.checked; };
    $("#tl-live").onchange = e => { live = e.target.checked; sendDraft(); };
    $("#tl-zin").onclick = () => zoom(1.6, sc.clientWidth / 2); $("#tl-zout").onclick = () => zoom(1 / 1.6, sc.clientWidth / 2);
    $("#tl-zfit").onclick = () => { pps = Math.max(1, (sc.clientWidth - 8) / dur()); layout(); render(); sc.scrollLeft = 0; };
    $("#tl-split").onclick = split; $("#tl-dup").onclick = duplicate; $("#tl-del").onclick = remove;
    $$("[data-add]").forEach(b => b.onclick = () => addAt(b.dataset.add, cursor));
    sc.addEventListener("scroll", () => { dirtyDraw = true; lastUser = performance.now(); }, { passive: true });
    function zoom(f, x) { const t = (sc.scrollLeft + x) / pps; pps = clamp(pps * f, Math.max(0.5, (sc.clientWidth - 8) / dur() * 0.9), 600); layout(); render(); sc.scrollLeft = t * pps - x; dirtyDraw = true; }
    sc.addEventListener("wheel", e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoom(Math.exp(-e.deltaY * 0.0025), e.clientX - sc.getBoundingClientRect().left); }, { passive: false });
    let pinch = null; // two fingers: zoom around their middle
    sc.addEventListener("touchstart", e => { if (e.touches.length === 2) { const [a, b] = e.touches; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), p: pps }; gesture = null; } }, { passive: true });
    sc.addEventListener("touchmove", e => { if (!pinch || e.touches.length !== 2) return; e.preventDefault(); const [a, b] = e.touches, d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      zoom(pinch.p * d / Math.max(10, pinch.d) / pps, (a.clientX + b.clientX) / 2 - sc.getBoundingClientRect().left); }, { passive: false });
    sc.addEventListener("touchend", e => { if (e.touches.length < 2) pinch = null; }, { passive: true });
    for (const ev of ["gesturestart", "gesturechange"]) sc.addEventListener(ev, e => e.preventDefault(), { passive: false }); // Safari's own pinch

    let down = null;
    sc.addEventListener("pointerdown", e => {
      if (pinch || (e.pointerType === "mouse" && e.button !== 0)) return; sc.focus({ preventScroll: true });
      const laneEl = e.target.closest(".tl-lane"); if (!laneEl) return; const lane = laneEl.dataset.lane, itEl = e.target.closest(".tl-it"), t = tAt(e.clientX);
      down = { x: e.clientX, y: e.clientY, t, lane, id: e.pointerId, touch: e.pointerType !== "mouse", moved: false };
      if (lane === "ruler" || lane === "song") { if (!down.touch) { seekTo(t); down.scrub = true; sc.setPointerCapture(e.pointerId); } return; }
      if (!itEl) { if (!down.touch) { select(null); seekTo(snapT(t, e)); } return; }
      const item = listOf(lane)[Number(itEl.dataset.i)]; if (!item) return;
      if (down.touch && sel?.item !== item) { down.tapSelect = { lane, item }; return; } // a finger: tap to select first, so a swipe still scrolls
      if (sel?.item !== item) select(lane, item);
      gesture = gestureFor(lane, item, e.target.dataset.edge); gesture.t = t; gesture.started = false; sc.setPointerCapture(e.pointerId); e.preventDefault();
    });
    sc.addEventListener("pointermove", e => {
      if (!down || e.pointerId !== down.id) return; if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 5) down.moved = true;
      if (down.scrub) { seekTo(tAt(e.clientX)); return; }
      if (!gesture || !down.moved) return; if (!gesture.started) { begin(); gesture.started = true; }
      gesture.apply(tAt(e.clientX) - gesture.t, e, false, yAt(e.clientY)); render();
    });
    const up = e => { if (!down || e.pointerId !== down.id) return; const d = down; down = null;
      if (e.type === "pointerup" && d.touch && !d.moved) { if (d.tapSelect) select(d.tapSelect.lane, d.tapSelect.item); else if (d.lane === "ruler" || d.lane === "song") seekTo(d.t); else if (!gesture) { select(null); seekTo(snapT(d.t)); } }
      if (gesture) { const g = gesture; gesture = null; if (g.started) { sortLane(g.lane); changed(); } }
      lastUser = performance.now(); };
    sc.addEventListener("pointerup", up); sc.addEventListener("pointercancel", up);
    let lastTap = { t: 0, x: 0 }; // double-tap on a phone, like a double-click
    const dbl = (x, y, target) => { const laneEl = target.closest(".tl-lane"); if (!laneEl || target.closest(".tl-it")) return; const lane = laneEl.dataset.lane;
      const kind = { fx: "fx", col: "color", cue: "flash", bri: "key" }[lane]; if (kind) addAt(kind, tAt(x), yAt(y)); };
    sc.addEventListener("dblclick", e => dbl(e.clientX, e.clientY, e.target));
    sc.addEventListener("pointerup", e => { if (e.pointerType === "mouse") return; const now = performance.now(); if (now - lastTap.t < 350 && Math.abs(e.clientX - lastTap.x) < 24) { dbl(e.clientX, e.clientY, e.target); lastTap = { t: 0, x: 0 }; } else lastTap = { t: now, x: e.clientX }; });
  }
  function onKey(e) {
    if (!doc || !$("#tl-sc")) return; const tag = e.target.tagName, typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.target.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); return; }
    if (e.key === " ") { e.preventDefault(); if (tag === "BUTTON") e.target.blur(); togglePlay(); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); nudge(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(); }
    else if (e.key === "Escape") select(null);
    else if (e.key === "Home") seekTo(0); else if (e.key === "End") seekTo(dur());
  }

  return {
    preview: true, hash,
    canLeave() { return !isDirty() || confirm("Leave the show editor without saving your changes?"); },
    onChanged(w) { if (w.has("songs") && src && !isDirty()) api("GET", `/api/songs/${encodeURIComponent(id)}/show`).then(r => { if (!alive || isDirty()) return; src = { ...src, ...r }; doc = { show: r.show, colors: r.colors, cues: r.cues, bright: r.bright }; saved = JSON.stringify(doc); sel = null; changed(); }).catch(() => {}); },
    onAudio() { dirtyDraw = true; },
    destroy() { alive = false; cancelAnimationFrame(raf); clearTimeout(draftTimer); clearInterval(keepDraft); prev?.destroy(); removeEventListener("keydown", onKey); removeEventListener("beforeunload", onUnload); removeEventListener("resize", layout);
      if (draftSent) api("DELETE", `/api/songs/${encodeURIComponent(id)}/show/draft`).catch(() => {}); },
  };
}
