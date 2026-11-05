// Room editor (#/room): a full-screen editor for the shapes your LEDs form. The room fills the screen in the dark
// stage frame; a floating toolbar on the left adds shapes (strip, ring, matrix, points and more), picks the select or
// zone tool, undoes and zooms; the panel on the right holds the selected shape's properties, every shape (layers),
// the zones, the controllers and the ready-made layouts. Phone: the room on top, the panel as a sheet under it.
// The live colours show while the layout is saved; while editing, each shape gets a colour (or its zone's colour).
import { buildLayout, segmentRanges, STAGE_W, STAGE_H } from "/engine/layout.js";
import { buildPreset } from "/engine/presets.js";
import { createRenderer } from "/preview.js";
import { app, api, act, toast, esc, opt, createPreview, $, $$, route, loadLayout, refreshState } from "/app.js";
import { icon } from "/v2/shell.js";
import { enterEditor, edTop, EI } from "/v2/editor.js";

const TYPES = { line: "Straight strip", pole: "Pole (vertical)", free: "Bent strip", circle: "Ring", rect: "Rectangle / frame", hex: "Hexagon", tri: "Triangle", matrix: "Matrix panel" };
const TYPE_OF = { ...TYPES, points: "Points" };
const MORE = ["pole", "free", "rect", "hex", "tri"];
const ZC = ["#5b8cff", "#3ecf7a", "#f5b83d", "#ff4f8b", "#2ec5d3", "#ff8a1f"]; // zone colours
const clone = o => JSON.parse(JSON.stringify(o));
const hsl = h => { const f = n => { const k = (n + h * 12) % 12; return 255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1))); }; return [f(0), f(8), f(4)]; };
const hueOf = si => (si * 0.137) % 1;
const hex = c => "#" + c.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
const shapeColor = si => hex(hsl(hueOf(si)));
const ledsOf = s => s.type === "matrix" ? s.cols * s.rows : s.count;

export function roomPage(el) {
  const st = app.state, devs = st.devices, leave = enterEditor(el, "room");
  let draft = clone(st.room.shapes), saved = JSON.stringify(draft), name = st.room.name || "My room", dirty = false, sel = draft.length ? 0 : -1, L = null, colors = null, zones = clone(st.room.zones || []);
  let live = false, tool = "select", paint = zones[0]?.id || null, zoom = 1, hover = -1, hist = [saved], hi = 0, alive = true;

  el.innerHTML = `<div class="ed re">
    ${edTop({ back: "#/lights", backLabel: "Back to Lights", eyebrow: "Room",
      title: `<input class="ed-name" id="r-name" value="${esc(name)}" maxlength="60" aria-label="Room name" spellcheck="false">`,
      after: `<span class="ed-sum" id="r-sum"></span>`,
      actions: `<a class="btn" href="#/map" id="r-map">${EI.camera}<span class="ed-lbl">Map with the camera</span></a>
        <button class="btn" id="r-discard" type="button" disabled>Discard</button><button class="btn primary" id="r-save" type="button" disabled>Save<span class="ed-lbl"> room</span></button>
        <button class="btn" id="r-done" type="button">Done</button>` })}
    <div class="re-body">
      <div class="re-canvas">
        <div class="re-tools" role="toolbar" aria-label="Room tools">
          <button class="re-tool" type="button" data-tool="select" aria-pressed="true" title="Select and move (V)">${EI.pointer}<span>Select</span></button>
          <button class="re-tool" type="button" data-tool="zone" aria-pressed="false" title="Put shapes in zones (Z)">${EI.zone}<span>Zone</span></button>
          <i class="re-sep"></i>
          <button class="re-tool" type="button" data-addt="line" title="Add a straight strip"${devs.length ? "" : " disabled"}>${EI.strip}<span>Strip</span></button>
          <button class="re-tool" type="button" data-addt="circle" title="Add a ring"${devs.length ? "" : " disabled"}>${EI.ring}<span>Ring</span></button>
          <button class="re-tool" type="button" data-addt="matrix" title="Add a matrix panel"${devs.length ? "" : " disabled"}>${EI.matrix}<span>Matrix</span></button>
          <button class="re-tool" type="button" data-addt="points" title="Add single points (bulbs, panels)"${devs.length ? "" : " disabled"}>${EI.points}<span>Points</span></button>
          <div class="re-more"><button class="re-tool" type="button" id="r-moreb" aria-expanded="false" title="More shapes"${devs.length ? "" : " disabled"}>${EI.shapes}<span>More</span></button>
            <div class="re-pop" id="r-pop" hidden>${MORE.map(k => `<button type="button" data-addt="${k}">${esc(TYPES[k])}</button>`).join("")}</div></div>
          <i class="re-sep"></i>
          <button class="re-tool" type="button" id="r-undo" title="Undo (Ctrl+Z)" disabled>${EI.undo}<span>Undo</span></button>
          <button class="re-tool" type="button" id="r-redo" title="Redo (Ctrl+Shift+Z)" disabled>${EI.redo}<span>Redo</span></button>
          <i class="re-sep"></i>
          <button class="re-tool" type="button" id="r-layouts" title="Start from a ready-made layout"${devs.length ? "" : " disabled"}>${EI.layouts}<span>Layouts</span></button>
        </div>
        <div class="re-zoom" role="group" aria-label="View"><button type="button" class="re-live" id="r-live" aria-pressed="false" title="Show what the lights are showing now instead of each shape in its own colour">Live colours</button><i class="re-zsep"></i><button type="button" id="r-zout" aria-label="Zoom out">${EI.minus}</button><output id="r-zval">100%</output><button type="button" id="r-zin" aria-label="Zoom in">${EI.plus}</button><button type="button" id="r-zfit" title="Fit the room">${EI.fit}</button></div>
        <div class="re-scroll" id="r-scroll"><div class="re-pad" id="r-pad"><div class="re-stage" id="r-stage">${devs.length ? "" : `<div class="re-none"><h3>Add a light first</h3><p>The room is made of the shapes your lights form. Add a light, then come back to lay them out.</p><a class="btn primary" href="#/lights">Add a light</a></div>`}<div class="re-ov" id="r-ov" aria-hidden="true"></div></div></div></div>
        <div class="re-hint" id="r-hint"></div>
        <div class="re-first" id="r-first" hidden></div>
      </div>
      <aside class="re-panel" id="r-panel" aria-label="Properties">
        <i class="re-grab" aria-hidden="true"></i>
        <section class="re-sec" id="r-props"></section>
        <section class="re-sec"><header class="re-sec-h"><h3>Layers</h3><span class="re-n" id="r-n"></span></header>
          <table class="re-layers"><tbody id="r-rows"></tbody></table></section>
        <section class="re-sec"><header class="re-sec-h"><h3>Zones</h3><button class="btn sm" id="z-add" type="button">${EI.plus}Add zone</button></header>
          <p class="re-note">Give parts of the room their own effect, the ambient light, their own brightness, or switch them off. Zone settings apply straight away.</p>
          <div class="re-zones" id="z-rows"></div></section>
        <section class="re-sec"><header class="re-sec-h"><h3>Controllers</h3></header><div class="re-devs" id="r-devs"></div></section>
        <section class="re-sec"><header class="re-sec-h"><h3>Start from a layout</h3></header>
          <div class="re-preset"><select id="r-preset" aria-label="Layout">${st.presets.map(p => opt(p.id, p.name)).join("")}</select><button class="btn" id="r-use" type="button"${devs.length ? "" : " disabled"}>Use this layout</button></div>
          <p class="re-note" id="r-pdesc"></p>
          <button class="re-link" type="button" id="r-browse"${devs.length ? "" : " disabled"}>${EI.layouts}See every layout with a picture</button></section>
      </aside>
    </div></div>`;

  const stageEl = $("#r-stage"), scroll = $("#r-scroll"), pad = $("#r-pad");
  const preview = devs.length ? createPreview(stageEl, { layout: () => dirty || !live || tool === "zone" ? L : app.layout, colors: () => dirty || !live || tool === "zone" ? colors : app.frame }) : null;
  $("#r-pdesc").textContent = st.presets[0]?.desc || "";
  $("#r-preset").onchange = e => $("#r-pdesc").textContent = st.presets.find(p => p.id === e.target.value)?.desc || "";

  // ---------------------------------------------------------------- layout, colours, history
  function relayout() {
    try { L = buildLayout(clone(draft)); } catch { L = { N: 0 }; }
    // while editing: every shape in its own colour (the zone tool: its zone's colour), the selected one bright
    colors = new Uint8Array(L.N * 3);
    for (let i = 0; i < L.N; i++) { const si = L.LF[i]; let c, k;
      if (tool === "zone") { const zi = zones.findIndex(z => z.id === draft[si]?.zone); c = zi >= 0 ? hexRgb(ZC[zi % ZC.length]) : [70, 66, 60]; k = zi >= 0 ? 1 : 0.6; }
      else { c = hsl(hueOf(si)); k = si === sel ? 1 : 0.45; }
      colors[i * 3] = c[0] * k; colors[i * 3 + 1] = c[1] * k; colors[i * 3 + 2] = c[2] * k; }
    if (L.N) L = { ...L, x: L.LX, y: L.LY, shape: L.LF };
  }
  const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const nowLayout = () => dirty || !live ? L : app.layout;
  function record() { const j = JSON.stringify(draft); if (j !== hist[hi]) { hist.splice(hi + 1); hist.push(j); hi = hist.length - 1; if (hist.length > 200) { hist.shift(); hi--; } } }
  function touch() { record(); dirty = JSON.stringify(draft) !== saved || name !== (st.room.name || "My room"); relayout(); render(); }
  function travel(d) { const k = hi + d; if (k < 0 || k >= hist.length) return; hi = k; draft = JSON.parse(hist[hi]); sel = Math.min(sel, draft.length - 1);
    dirty = hist[hi] !== saved || name !== (st.room.name || "My room"); relayout(); render(); }

  // ---------------------------------------------------------------- the panel
  function render() {
    const ranges = segmentRanges(draft), total = draft.reduce((a, s) => a + ledsOf(s), 0);
    $("#r-sum").innerHTML = `${draft.length} shape${draft.length === 1 ? "" : "s"} · ${total} LEDs${dirty ? ' <b class="ed-dirty">Not saved</b>' : ""}`;
    $("#r-save").disabled = !dirty; $("#r-discard").disabled = !dirty; $("#r-undo").disabled = hi <= 0; $("#r-redo").disabled = hi >= hist.length - 1;
    $("#r-n").textContent = draft.length || "";
    $("#r-rows").innerHTML = draft.map((s, i) => { const r = ranges[i], z = zones.find(x => x.id === s.zone);
      return `<tr class="${i === sel ? "sel" : ""}" data-row="${i}"><td class="sw"><i style="--c:${shapeColor(i)}"></i></td>
        <td class="nm"><b>${esc(s.name)}</b><small>${esc(TYPE_OF[s.type] || s.type)} · <span class="mono">${r.start}–${r.end}</span></small></td>
        <td class="ct">${s.type === "matrix" ? `<span class="mono">${s.cols}×${s.rows}</span>` : s.type === "points" ? `<span class="mono">${s.count}</span>` : `<input type="number" class="re-ghost" min="1" max="8192" value="${s.count}" data-k="count" data-i="${i}" aria-label="LEDs in ${esc(s.name)}">`}</td>
        <td class="zn"><span class="re-zsel"${z ? ` style="--zc:${ZC[zones.indexOf(z) % ZC.length]}"` : ""}><select class="re-ghost" data-k="zone" data-i="${i}" aria-label="Zone of ${esc(s.name)}">${opt("", "No zone", !s.zone)}${zones.map(zz => opt(zz.id, zz.name, zz.id === s.zone)).join("")}</select></span></td></tr>`; }).join("")
      || `<tr><td colspan="4" class="re-empty">No shapes yet. Add one with the toolbar, or start from a layout.</td></tr>`;
    $$("#r-rows [data-k]").forEach(x => x.onchange = () => { const s = draft[Number(x.dataset.i)], k = x.dataset.k;
      if (k === "zone") s.zone = x.value || null; else if (k === "count") s.count = Math.max(1, Math.round(Number(x.value) || 1)); touch(); });
    $$("#r-rows [data-row]").forEach(tr => tr.onclick = e => { if (e.target.closest("input,select,button")) return; sel = Number(tr.dataset.row); relayout(); render(); });
    props(ranges); devices(ranges); zoneRows(); overlay(); hint(); first();
  }

  function props(ranges) {
    const box = $("#r-props"), s = draft[sel];
    if (!s) { box.innerHTML = `<header class="re-sec-h"><h3>Shape</h3></header><div class="re-pick"><div class="re-pick-ic">${EI.pointer}</div><p>Select a shape in the room to change it, or add one with the toolbar.</p></div>`; return; }
    const r = ranges[sel], c = center(s), n = (k, label, v, step = 0.1, extra = "") => `<label class="re-f"><span>${label}</span><input type="number" step="${step}" value="${Math.round(v * 100) / 100}" data-g="${k}"${extra}></label>`;
    box.innerHTML = `<header class="re-sec-h"><i class="re-dot" style="--c:${shapeColor(sel)}"></i><h3>${esc(s.name)}</h3><span class="re-chip">${esc(TYPE_OF[s.type] || s.type)}</span></header>
      <div class="re-rows">
        <label class="re-r"><span>Name</span><input type="text" value="${esc(s.name)}" data-p="name" maxlength="60"></label>
        ${s.type === "points" ? "" : `<label class="re-r"><span>Shape</span><select data-p="type">${Object.entries(TYPES).map(([k, v]) => opt(k, v, k === s.type)).join("")}</select></label>`}
        <label class="re-r"><span>Controller</span><select data-p="dev">${devs.map(d => opt(d.id, d.name, d.id === s.dev)).join("")}</select></label>
        <div class="re-r2">${`<label class="re-f"><span>First LED</span><input type="number" min="0" placeholder="auto" value="${s.from ?? ""}" data-p="from"></label>`}
          ${s.type === "matrix" ? n("cols", "Columns", s.cols, 1) + "</div><div class=\"re-r2\">" + n("rows", "Rows", s.rows, 1) + `<div class="re-f"><span>LEDs</span><b class="re-ro mono">${s.cols * s.rows}</b></div>`
            : s.type === "points" ? `<div class="re-f"><span>LEDs</span><b class="re-ro mono">${s.count}</b></div>` : `<label class="re-f"><span>LEDs</span><input type="number" min="1" max="8192" value="${s.count}" data-p="count"></label>`}</div>
        <div class="re-r"><span>Uses LEDs</span><b class="re-ro mono">${r.start} to ${r.end}</b></div>
        <div class="re-r"><span id="r-revl">Reverse direction</span><button class="switch" type="button" role="switch" aria-checked="${!!s.rev}" aria-labelledby="r-revl" data-p="rev"></button></div>
        <label class="re-r"><span>Zone</span><select data-p="zone">${opt("", "No zone", !s.zone)}${zones.map(z => opt(z.id, z.name, z.id === s.zone)).join("")}</select></label>
      </div>
      <h4 class="re-sub">Position and size <small>on the 16 × 9 wall</small></h4>
      <div class="re-grid">
        ${n("x", "X", c[0])}${n("y", "Y", c[1])}
        ${s.type === "rect" || s.type === "matrix" ? n("w", "Width", s.w) + n("h", "Height", s.h) : ["circle", "hex", "tri"].includes(s.type) ? n("size", "Radius", s.size) : s.type === "points" ? "" : n("len", "Length", length(s))}
        ${s.type === "matrix" ? "" : n("rot", "Rotation °", s.rot || 0, 5)}
        ${["circle", "rect", "hex", "tri"].includes(s.type) ? n("start", "LED 0 at", s.start || 0, 0.05, ' min="0" max="1" title="Where LED 0 sits, 0 to 1 around the shape"') : ""}
      </div>
      <div class="re-acts"><button class="btn sm" data-ident="${sel}" type="button"${dirty ? ' disabled title="Save first"' : ""}>${EI.flash}Identify</button><button class="btn sm" data-dup="${sel}" type="button">${EI.copy}Duplicate</button><button class="btn sm danger" data-rm="${sel}" type="button">${EI.trash}Delete</button></div>`;
    $$("#r-props [data-p]").forEach(x => { const k = x.dataset.p;
      if (k === "rev") { x.onclick = () => { s.rev = !s.rev; touch(); }; return; }
      x.onchange = () => { if (k === "zone") s.zone = x.value || null; else if (k === "count") s.count = Math.max(1, Math.round(Number(x.value) || 1)); else if (k === "from") s.from = x.value === "" ? null : Math.max(0, Math.round(Number(x.value)));
        else if (k === "type") Object.assign(s, convert(s, x.value)); else if (k === "name") s.name = x.value.trim() || s.name; else s[k] = x.value; touch(); }; });
    $$("#r-props [data-g]").forEach(x => x.onchange = () => { const v = Number(x.value), k = x.dataset.g; if (!Number.isFinite(v)) return;
      if (k === "x" || k === "y") { const cc = center(s); move(s, k === "x" ? v - cc[0] : 0, k === "y" ? v - cc[1] : 0); }
      else if (k === "len") { scaleLine(s, v / Math.max(0.01, length(s))); move(s, 0, 0); }
      else if (k === "rot" && s.pts) { rotatePts(s, v - (s.rot || 0)); s.rot = v; move(s, 0, 0); } // move(0, 0) pushes it back inside the wall view
      else if (k === "cols" || k === "rows") { s[k] = Math.max(1, Math.round(v)); s.count = s.cols * s.rows; }
      else s[k] = v;
      touch(); });
    $$("#r-props [data-ident]").forEach(b => b.onclick = () => api("POST", "/api/room/identify", { shape: Number(b.dataset.ident) }).then(() => toast("Lighting it up: the blinking end is LED 0 of this shape")));
    $$("#r-props [data-dup]").forEach(b => b.onclick = () => duplicate());
    $$("#r-props [data-rm]").forEach(b => b.onclick = () => removeSel());
  }
  function duplicate() { if (!draft[sel]) return; const s = clone(draft[sel]); s.name += " copy"; s.from = null; move(s, 0.4, 0.4); draft.push(s); sel = draft.length - 1; touch(); }
  function removeSel() { if (!draft[sel]) return; draft.splice(sel, 1); sel = Math.min(sel, draft.length - 1); touch(); }

  // ---- zones: saved straight away (they're like a lighting setting), shapes join them with the Zone tool or field
  const MODES = { follow: "Follows the main effect", effect: "Its own effect", ambient: "The ambient light", off: "Off" };
  let zt = null;
  const saveZones = () => { clearTimeout(zt); zt = setTimeout(() => api("PUT", "/api/zones", { zones }).then(z => { zones = z; app.state.room.zones = z; }).catch(e => toast(e.message, true)), 150); };
  function zoneRows() {
    if (paint && !zones.some(z => z.id === paint)) paint = zones[0]?.id || null;
    $("#z-rows").innerHTML = zones.map((z, i) => { const n = draft.filter(sh => sh.zone === z.id).length, c = ZC[i % ZC.length];
      return `<div class="re-zone${tool === "zone" && paint === z.id ? " paint" : ""}" style="--zc:${c}">
        <div class="re-zone-h"><button class="re-zone-dot" type="button" data-zpaint="${esc(z.id)}" title="Paint shapes into this zone" aria-label="Paint shapes into ${esc(z.name)}" aria-pressed="${tool === "zone" && paint === z.id}"></button>
          <input value="${esc(z.name)}" data-zk="name" data-zi="${i}" aria-label="Zone name" class="re-ghost re-zone-name"><span class="re-zone-n">${n} shape${n === 1 ? "" : "s"}</span>
          <button class="ui-icbtn" data-zdel="${i}" type="button" aria-label="Delete ${esc(z.name)}">${EI.trash}</button></div>
        <label class="re-r"><span>Shows</span><select data-zk="mode" data-zi="${i}">${Object.entries(MODES).map(([k, v]) => opt(k, v, k === z.mode)).join("")}</select></label>
        ${z.mode === "effect" ? `<label class="re-r"><span>Effect</span><select data-zk="effect" data-zi="${i}">${st.effects.map(e => opt(e.id, e.name, e.id === z.effect)).join("")}</select></label>` : ""}
        <label class="re-r"><span>Brightness</span><span class="re-range"><input type="range" min="0" max="1" step="0.05" value="${z.brightness ?? 1}" data-zk="brightness" data-zi="${i}" aria-label="Zone brightness"><output class="mono">${Math.round((z.brightness ?? 1) * 100)}%</output></span></label></div>`; }).join("")
      || `<div class="re-zempty">No zones yet. Example: a “TV” zone that turns off during movies, or a calm “Ceiling” zone while the desk parties.</div>`;
    $$("#z-rows [data-zk]").forEach(x => { const ev = x.type === "range" ? "oninput" : "onchange"; x[ev] = () => { const z = zones[Number(x.dataset.zi)], k = x.dataset.zk;
      z[k] = k === "brightness" ? Number(x.value) : x.value; if (k === "mode" && x.value === "effect" && !z.effect) z.effect = "aurora";
      if (k === "brightness") x.nextElementSibling.textContent = Math.round(x.value * 100) + "%"; saveZones(); if (k === "mode") zoneRows(); if (k === "name") render(); }; });
    $$("#z-rows [data-zdel]").forEach(b => b.onclick = () => { const z = zones.splice(Number(b.dataset.zdel), 1)[0]; draft.forEach(sh => { if (sh.zone === z.id) sh.zone = null; }); saveZones(); touch(); });
    $$("#z-rows [data-zpaint]").forEach(b => b.onclick = () => { paint = b.dataset.zpaint; setTool("zone"); });
  }

  function devices(ranges) {
    $("#r-devs").innerHTML = devs.map(d => {
      const mine = draft.map((s, i) => ({ s, i, r: ranges[i] })).filter(x => x.s.dev === d.id).sort((a, b) => a.r.start - b.r.start);
      const used = mine.reduce((m, x) => Math.max(m, x.r.end + 1), 0), probs = [], cap = Math.max(d.leds || 0, used, 1);
      for (let k = 1; k < mine.length; k++) if (mine[k].r.start <= mine[k - 1].r.end) probs.push(`“${mine[k].s.name}” overlaps “${mine[k - 1].s.name}”`);
      if (d.leds && used > d.leds) probs.push(`uses ${used} LEDs but the controller has ${d.leds}`);
      return `<div class="re-dev"><div class="re-dev-h"><b>${esc(d.name)}</b><span class="mono">${used} of ${d.leds || "?"} LEDs</span></div>
        <div class="re-bar" aria-hidden="true">${mine.map(x => `<i style="left:${x.r.start / cap * 100}%;width:${Math.max(0.6, (x.r.end - x.r.start + 1) / cap * 100)}%;--c:${shapeColor(x.i)}" title="${esc(x.s.name)} ${x.r.start}–${x.r.end}"></i>`).join("")}</div>
        <div class="re-dev-f">${probs.length ? `<span class="ui-pill warn"><i></i>${esc(probs.join("; "))}</span>` : mine.length ? '<span class="ui-pill ok"><i></i>No overlaps</span>' : '<span class="re-note">No shapes use it yet</span>'}
        ${d.virtual ? "" : `<button class="btn sm" data-seg="${d.id}" type="button"${dirty || !mine.length ? " disabled" : ""} title="Write these ranges as segments in WLED">Send segments to WLED</button>`}</div></div>`; }).join("")
      || `<p class="re-note">No lights yet.</p>`;
    $$("#r-devs [data-seg]").forEach(b => b.onclick = () => act(() => api("POST", `/api/devices/${b.dataset.seg}/segments`), "Segments sent to WLED").catch(() => {}));
  }

  // ---------------------------------------------------------------- the overlay: selection, hover, LED 0
  function bbox(Lx, si) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, first = -1;
    for (let i = 0; i < Lx.N; i++) if (Lx.shape[i] === si) { if (first < 0) first = i; x0 = Math.min(x0, Lx.x[i]); y0 = Math.min(y0, Lx.y[i]); x1 = Math.max(x1, Lx.x[i]); y1 = Math.max(y1, Lx.y[i]); }
    return first < 0 ? null : { x0, y0, x1, y1, first }; }
  function overlay() {
    const ov = $("#r-ov"); if (!ov) return; const Lx = nowLayout(); if (!Lx || !Lx.N || !draft.length) { ov.innerHTML = ""; return; }
    const pc = (v, W) => `${v / W * 100}%`, box = (b, cls, label = "") => { const p = 0.18;
      return `<div class="${cls}" style="left:${pc(b.x0 - p, STAGE_W)};top:${pc(b.y0 - p, STAGE_H)};width:${pc(b.x1 - b.x0 + 2 * p, STAGE_W)};height:${pc(b.y1 - b.y0 + 2 * p, STAGE_H)}">${label}</div>`; };
    let h = "";
    if (hover >= 0 && hover !== sel && draft[hover]) { const b = bbox(Lx, hover); if (b) h += box(b, "re-hov"); }
    if (sel >= 0 && draft[sel] && tool === "select") { const b = bbox(Lx, sel);
      if (b) { h += box(b, "re-selbox", `<span class="re-tag">${esc(draft[sel].name)}</span><i class="re-h tl"></i><i class="re-h tr"></i><i class="re-h bl"></i><i class="re-h br"></i>`);
        h += `<div class="re-led0" style="left:${pc(Lx.x[b.first], STAGE_W)};top:${pc(Lx.y[b.first], STAGE_H)}" title="LED 0"><span>0</span></div>`; } }
    ov.innerHTML = h;
  }
  function hint() {
    $("#r-hint").textContent = !devs.length ? "" : tool === "zone"
      ? (zones.length ? `Click shapes to put them in “${zones.find(z => z.id === paint)?.name || ""}”. Click again to take them out.` : "Add a zone in the panel, then click shapes to put them in it.")
      : draft.length ? "Drag a shape to move it. Arrow keys nudge it, Delete removes it." : "";
  }

  // ---------------------------------------------------------------- first run: pick a layout from pictures
  let firstOpen = null, thumbsDone = false;
  function first(force) {
    const box = $("#r-first"); if (!devs.length) return;
    const want = force ?? (firstOpen ?? !draft.length); box.hidden = !want; if (!want) return;
    if (!box.innerHTML) {
      box.innerHTML = `<div class="re-first-in"><header><div><h2>Start from a layout</h2><p>Pick the room that looks most like yours. LED counts are fitted to your lights, and you can change every shape afterwards.</p></div>
          <button class="ui-icbtn re-first-x" type="button" id="r-fclose" aria-label="Close">${icon("close")}</button></header>
        <div class="re-thumbs">${st.presets.map(p => `<button class="re-thumb" type="button" data-preset="${esc(p.id)}"><span class="re-thumb-art"><canvas data-th="${esc(p.id)}"></canvas></span><b>${esc(p.name)}</b><small>${esc(p.desc)}</small></button>`).join("")}</div>
        <div class="re-first-f"><button class="btn" type="button" id="r-fempty">Start with an empty room</button><a class="btn" href="#/map">${EI.camera}Map with the camera</a></div></div>`;
      $("#r-fclose").onclick = $("#r-fempty").onclick = () => { firstOpen = false; first(); };
      $$("#r-first [data-preset]").forEach(b => b.onclick = () => usePreset(b.dataset.preset));
    }
    $("#r-fclose").hidden = !draft.length && firstOpen == null;
    if (!thumbsDone) { thumbsDone = true; requestAnimationFrame(() => $$("#r-first canvas[data-th]").forEach(cv => thumb(cv, cv.dataset.th))); }
  }
  function thumb(cv, id) {
    try { const shapes = buildPreset(id, devs.filter(d => d.enabled !== false).map(d => ({ id: d.id, name: d.name, leds: d.leds })));
      const Lp = buildLayout(clone(shapes)), Lv = { ...Lp, x: Lp.LX, y: Lp.LY, shape: Lp.LF, shapes }, r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
      cv.width = Math.max(64, Math.round(r.width * dpr)); cv.height = Math.max(36, Math.round(r.height * dpr));
      const f = new Uint8Array(Lv.N * 3); for (let i = 0; i < Lv.N; i++) { const c = hsl((0.05 + Lv.shape[i] * 0.09) % 1); f[i * 3] = c[0]; f[i * 3 + 1] = c[1] * 0.85; f[i * 3 + 2] = c[2]; }
      createRenderer(cv).draw(Lv, f, dpr);
    } catch {}
  }
  async function usePreset(id) {
    if (draft.length && !confirm("Replace the current shapes with this layout?")) return;
    await act(() => api("POST", "/api/room/preset", { id }), "Layout applied").catch(() => {}); await refreshState(); await loadLayout(); route();
  }

  // ---------------------------------------------------------------- geometry helpers (stage units: 16 wide, 9 high)
  const pts = s => s.pts || null;
  function center(s) { if (pts(s)) { const p = s.pts; return [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length]; } return [s.cx ?? 8, s.cy ?? 4.5]; }
  // a shape with points moves as a whole and stops at the edge (clamping each point would squash a mapped shape flat)
  function move(s, dx, dy) { if (pts(s)) { const xs = s.pts.map(p => p[0]), ys = s.pts.map(p => p[1]);
      dx = clamp(dx, -Math.min(...xs), STAGE_W - Math.max(...xs)); dy = clamp(dy, -Math.min(...ys), STAGE_H - Math.max(...ys));
      s.pts = s.pts.map(([x, y]) => [x + dx, y + dy]); } else { s.cx = clamp((s.cx ?? 8) + dx, 0, STAGE_W); s.cy = clamp((s.cy ?? 4.5) + dy, 0, STAGE_H); } }
  function length(s) { let l = 0; for (let i = 1; i < (s.pts || []).length; i++) l += Math.hypot(s.pts[i][0] - s.pts[i - 1][0], s.pts[i][1] - s.pts[i - 1][1]); return l; }
  function scaleLine(s, k) { const [cx, cy] = center(s); s.pts = s.pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]); }
  function rotatePts(s, deg) { const [cx, cy] = center(s), a = deg * Math.PI / 180, c = Math.cos(a), n = Math.sin(a); s.pts = s.pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * n, cy + (x - cx) * n + (y - cy) * c]); }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function convert(s, type) {
    const [cx, cy] = center(s), o = { type };
    if (["line", "pole", "free"].includes(type)) { o.pts = s.pts && s.pts.length >= 2 ? s.pts : type === "pole" ? [[cx, cy + 1.5], [cx, cy - 1.5]] : [[cx - 2, cy], [cx + 2, cy]]; }
    else { o.pts = undefined; o.cx = cx; o.cy = cy; o.size = s.size || 1; if (type === "rect") { o.w = s.w || 2; o.h = s.h || 1.2; } if (type === "matrix") { o.cols = s.cols || 16; o.rows = s.rows || 16; o.w = s.w || 3; o.h = s.h || 3; o.count = o.cols * o.rows; } }
    return o;
  }
  function newShape(type) {
    const d = devs[0], n = draft.filter(s => s.type === type).length, base = { type, name: TYPE_OF[type] + (n ? ` ${n + 1}` : ""), count: 60, dev: d.id, rot: 0, start: 0, rev: false, from: null };
    if (type === "points") return Object.assign(base, { name: n ? `Points ${n + 1}` : "Points", count: 8, pts: Array.from({ length: 8 }, (_, k) => [5 + k, 4.5 + (k % 2 ? 0.5 : -0.5)]) });
    if (type === "matrix") base.name = n ? `Matrix ${n + 1}` : "Matrix";
    return Object.assign(base, convert({ cx: 8, cy: 4.5 }, type));
  }
  function addShape(type) { if (!devs.length) return; draft.push(newShape(type)); sel = draft.length - 1; setTool("select", true); touch(); }

  // ---------------------------------------------------------------- tools and zoom
  function setTool(t, quiet) { tool = t; $$(".re-tools [data-tool]").forEach(b => b.setAttribute("aria-pressed", b.dataset.tool === t)); stageEl.dataset.tool = t;
    if (!quiet) { relayout(); render(); } }
  $$(".re-tools [data-tool]").forEach(b => b.onclick = () => setTool(b.dataset.tool));
  $$("[data-addt]").forEach(b => b.onclick = () => { $("#r-pop").hidden = true; $("#r-moreb").setAttribute("aria-expanded", "false"); addShape(b.dataset.addt); });
  $("#r-moreb").onclick = e => { e.stopPropagation(); const p = $("#r-pop"); p.hidden = !p.hidden; $("#r-moreb").setAttribute("aria-expanded", String(!p.hidden)); };
  const closePop = e => { if (!e.target.closest(".re-more")) { const p = $("#r-pop"); if (p && !p.hidden) { p.hidden = true; $("#r-moreb").setAttribute("aria-expanded", "false"); } } };
  document.addEventListener("pointerdown", closePop);
  $("#r-live").onclick = e => { live = !live; e.currentTarget.setAttribute("aria-pressed", live); };
  $("#r-undo").onclick = () => travel(-1); $("#r-redo").onclick = () => travel(1);
  $("#r-layouts").onclick = $("#r-browse").onclick = () => { firstOpen = true; first(true); };

  function fit() {
    if (!devs.length) return; const cs = getComputedStyle(pad), aw = scroll.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), ah = scroll.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const w0 = Math.max(160, Math.min(aw, ah * 16 / 9)), w = Math.round(w0 * zoom); stageEl.style.width = w + "px"; stageEl.style.height = Math.round(w * 9 / 16) + "px"; $("#r-zval").textContent = Math.round(zoom * 100) + "%";
  }
  function setZoom(z, cx, cy) { const old = stageEl.getBoundingClientRect(), sr = scroll.getBoundingClientRect(); cx ??= sr.left + sr.width / 2; cy ??= sr.top + sr.height / 2;
    const fx = (cx - old.left) / old.width, fy = (cy - old.top) / old.height; zoom = clamp(z, 0.5, 4); fit();
    const nw = stageEl.getBoundingClientRect(); scroll.scrollLeft += (nw.left + fx * nw.width) - cx; scroll.scrollTop += (nw.top + fy * nw.height) - cy; }
  $("#r-zin").onclick = () => setZoom(zoom * 1.25); $("#r-zout").onclick = () => setZoom(zoom / 1.25); $("#r-zfit").onclick = () => { zoom = 1; fit(); scroll.scrollLeft = scroll.scrollTop = 0; };
  scroll.addEventListener("wheel", e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom(zoom * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY); }, { passive: false });
  const ro = new ResizeObserver(() => fit()); ro.observe(scroll);

  // ---------------------------------------------------------------- pointer: pick, drag, paint zones
  const at = e => { const r = stageEl.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * STAGE_W, (e.clientY - r.top) / r.height * STAGE_H]; };
  function hit(x, y) {
    const Lx = nowLayout(); if (!Lx || !Lx.N) return -1;
    let best = -1, bd = 0.5; for (let i = 0; i < Lx.N; i++) { const d = Math.hypot(Lx.x[i] - x, Lx.y[i] - y); if (d < bd) { bd = d; best = i; } }
    if (best >= 0) return Lx.shape[best];
    let pick = -1, area = 1e9; for (let si = 0; si < draft.length; si++) { const b = bbox(Lx, si); if (!b) continue; const a = (b.x1 - b.x0) * (b.y1 - b.y0);
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && a > 0.2 && a < area) { area = a; pick = si; } }
    return pick;
  }
  let drag = null;
  if (preview) {
    stageEl.onpointerdown = e => {
      if (e.button > 0) return; const [x, y] = at(e), si = hit(x, y);
      if (tool === "zone") { if (si < 0) return; if (!paint) { toast("Add a zone first", true); return; } const s = draft[si]; s.zone = s.zone === paint ? null : paint; touch(); return; }
      if (si < 0) { if (sel >= 0) { sel = -1; relayout(); render(); } return; }
      sel = si; drag = { x, y, moved: false }; stageEl.setPointerCapture(e.pointerId); stageEl.classList.add("dragging");
      if (!dirty) relayout(); render();
    };
    stageEl.onpointermove = e => { const [x, y] = at(e);
      if (!drag) { const h = hit(x, y); if (h !== hover) { hover = h; overlay(); stageEl.classList.toggle("over", h >= 0); } return; }
      move(draft[sel], x - drag.x, y - drag.y); drag.x = x; drag.y = y; drag.moved = true; dirty = true; relayout(); overlay(); };
    stageEl.onpointerup = stageEl.onpointercancel = () => { stageEl.classList.remove("dragging"); if (drag && drag.moved) touch(); drag = null; };
    stageEl.onpointerleave = () => { if (!drag && hover >= 0) { hover = -1; overlay(); } };
  }

  function onKey(e) {
    const t = e.target.tagName, typing = t === "INPUT" || t === "SELECT" || t === "TEXTAREA" || e.target.isContentEditable, mod = e.ctrlKey || e.metaKey;
    if (document.documentElement.classList.contains("ui-sheet-open")) return;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty) save(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); travel(e.shiftKey ? 1 : -1); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); travel(1); return; }
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); return; }
    if (mod) return;
    if (e.key === "v" || e.key === "V") setTool("select"); else if (e.key === "z" || e.key === "Z") setTool("zone");
    else if (e.key === "Escape") { if (!$("#r-first").hidden && draft.length) { firstOpen = false; first(); } else if (sel >= 0) { sel = -1; relayout(); render(); } }
    else if ((e.key === "Delete" || e.key === "Backspace") && sel >= 0) { e.preventDefault(); removeSel(); }
    else if (e.key.startsWith("Arrow") && draft[sel]) { e.preventDefault(); const d = e.shiftKey ? 1 : 0.1;
      move(draft[sel], e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0, e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0); touch(); }
  }
  addEventListener("keydown", onKey);

  // ---------------------------------------------------------------- name, save, done
  $("#r-name").onchange = e => { name = e.target.value.trim().slice(0, 60) || "My room"; e.target.value = name; touch(); };
  $("#z-add").onclick = () => { const id = "z" + Date.now().toString(36); zones.push({ id, name: `Zone ${zones.length + 1}`, mode: "follow", effect: null, brightness: 1 }); paint = id;
    if (sel >= 0 && !draft[sel].zone) { draft[sel].zone = id; touch(); } saveZones(); zoneRows(); };
  $("#r-use").onclick = () => usePreset($("#r-preset").value);
  async function save() { const ok = await act(() => api("PUT", "/api/room", { name, shapes: draft }), "Room saved").then(() => true).catch(() => false); await refreshState(); await loadLayout(); dirty = false; if (alive) route(); return ok; }
  $("#r-save").onclick = save;
  $("#r-discard").onclick = () => { dirty = false; route(); };
  $("#r-done").onclick = async () => { if (dirty && !(await save())) return; location.hash = "#/lights"; };

  setTool("select", true); relayout(); render(); fit();
  return { preview: true, destroy() { alive = false; preview && preview.destroy(); ro.disconnect(); removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", closePop); leave(); },
    onChanged(w) { if (!dirty && (w.has("room") || w.has("devices"))) route(); } };
}
