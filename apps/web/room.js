// Room page: lay out the shapes your LEDs form, say which controller and which LED numbers each one uses, and
// drag shapes into place. The live colours show while the layout is saved; while editing, each shape gets a colour.
import { buildLayout, segmentRanges, STAGE_W, STAGE_H } from "/engine/layout.js";
import { app, api, act, toast, esc, panel, opt, createPreview, $, $$, route, loadLayout, refreshState } from "/app.js";

const TYPES = { line: "Straight strip", pole: "Pole (vertical)", free: "Bent strip", circle: "Ring", rect: "Rectangle / frame", hex: "Hexagon", tri: "Triangle", matrix: "Matrix panel" };
const clone = o => JSON.parse(JSON.stringify(o));

export function roomPage(el) {
  const st = app.state, devs = st.devices;
  let draft = clone(st.room.shapes), dirty = false, sel = draft.length ? 0 : -1, L = null, colors = null;
  el.innerHTML = `
    ${panel("Room", `<span id="r-sum"></span>`, `<button class="btn" id="r-discard" type="button" disabled>Discard</button><button class="btn primary" id="r-save" type="button" disabled>Save room</button>`,
      `<div class="stage" id="r-stage">${devs.length ? "" : '<div class="empty">Add a WLED controller on the Devices page first.</div>'}</div>`, "span-8")}
    ${panel("Start from a layout", "", "", `<div class="pb stack"><div class="field"><label for="r-preset">Preset</label><select id="r-preset">${st.presets.map(p => opt(p.id, p.name)).join("")}</select><span class="help" id="r-pdesc"></span></div>
      <button class="btn" id="r-use" type="button"${devs.length ? "" : " disabled"}>Use this layout</button><p class="faint" style="font-size:12.5px">Replaces the shapes below. LED counts are fitted to your controllers; you can change every number afterwards.</p></div>`, "span-4")}
    ${panel("Shapes", "Drag a shape in the picture to move it. LED numbers start at 0, like in WLED.", `<select id="r-newtype" style="width:auto">${Object.entries(TYPES).map(([k, v]) => opt(k, v)).join("")}</select><button class="btn" id="r-add" type="button"${devs.length ? "" : " disabled"}>Add shape</button>`,
      `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Type</th><th>Controller</th><th class="num">First LED</th><th class="num">LEDs</th><th>Uses LEDs</th><th>Reverse</th><th></th></tr></thead><tbody id="r-rows"></tbody></table></div>
       <div class="pb" id="r-geo" style="border-top:1px solid var(--line-2)"></div>`, "span-12")}
    ${panel("Controllers", "Which LEDs each controller drives", "", `<div class="tablewrap"><table><thead><tr><th>Controller</th><th class="num">LEDs</th><th>Used by shapes</th><th>Check</th><th></th></tr></thead><tbody id="r-devs"></tbody></table></div>`, "span-12")}`;

  const preview = devs.length ? createPreview($("#r-stage"), { outlines: true, selected: () => sel, layout: () => dirty ? L : app.layout, colors: () => dirty ? colors : app.frame }) : null;
  $("#r-pdesc").textContent = st.presets[0]?.desc || "";
  $("#r-preset").onchange = e => $("#r-pdesc").textContent = st.presets.find(p => p.id === e.target.value)?.desc || "";

  function relayout() {
    try { L = buildLayout(clone(draft)); } catch { L = { N: 0 }; }
    // while editing: every shape in its own colour, the selected one bright
    colors = new Uint8Array(L.N * 3);
    for (let i = 0; i < L.N; i++) { const si = L.LF[i], h = (si * 0.137) % 1, k = si === sel ? 1 : 0.45, c = hsl(h);
      colors[i * 3] = c[0] * k; colors[i * 3 + 1] = c[1] * k; colors[i * 3 + 2] = c[2] * k; }
    if (L.N) L = { ...L, x: L.LX, y: L.LY, shape: L.LF };
  }
  const hsl = h => { const f = n => { const k = (n + h * 12) % 12; return 255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1))); }; return [f(0), f(8), f(4)]; };
  function touch() { dirty = true; $("#r-save").disabled = false; $("#r-discard").disabled = false; relayout(); render(); }

  function render() {
    const ranges = segmentRanges(draft), total = draft.reduce((a, s) => a + (s.type === "matrix" ? s.cols * s.rows : s.count), 0);
    $("#r-sum").textContent = `${draft.length} shape${draft.length === 1 ? "" : "s"}, ${total} LEDs${dirty ? " · not saved" : ""}`;
    $("#r-rows").innerHTML = draft.map((s, i) => { const r = ranges[i];
      return `<tr class="${i === sel ? "sel" : ""}" data-row="${i}"><td><input value="${esc(s.name)}" data-k="name" data-i="${i}" style="width:150px"></td>
        <td><select data-k="type" data-i="${i}">${Object.entries(TYPES).map(([k, v]) => opt(k, v, k === s.type)).join("")}</select></td>
        <td><select data-k="dev" data-i="${i}">${devs.map(d => opt(d.id, d.name, d.id === s.dev)).join("")}</select></td>
        <td class="num"><input type="number" min="0" placeholder="auto" value="${s.from ?? ""}" data-k="from" data-i="${i}"></td>
        <td class="num">${s.type === "matrix" ? `${s.cols}×${s.rows}` : `<input type="number" min="1" max="8192" value="${s.count}" data-k="count" data-i="${i}">`}</td>
        <td class="mono">${r.start}–${r.end}</td>
        <td><input type="checkbox" data-k="rev" data-i="${i}" ${s.rev ? "checked" : ""} aria-label="Reverse direction"></td>
        <td><button class="btn sm" data-ident="${i}" type="button"${dirty ? ' disabled title="Save first"' : ""}>Identify</button> <button class="btn sm" data-dup="${i}" type="button">Copy</button> <button class="btn sm danger" data-rm="${i}" type="button">Delete</button></td></tr>`; }).join("")
      || '<tr><td colspan="8" class="faint">No shapes. Pick a layout above, or add a shape.</td></tr>';
    $$("#r-rows [data-k]").forEach(x => x.onchange = () => { const s = draft[Number(x.dataset.i)], k = x.dataset.k;
      if (k === "rev") s.rev = x.checked; else if (k === "count") s.count = Math.max(1, Math.round(Number(x.value) || 1)); else if (k === "from") s.from = x.value === "" ? null : Math.max(0, Math.round(Number(x.value)));
      else if (k === "type") Object.assign(s, convert(s, x.value)); else s[k] = x.value; touch(); });
    $$("#r-rows [data-row]").forEach(tr => tr.onclick = e => { if (e.target.closest("input,select,button")) return; sel = Number(tr.dataset.row); relayout(); render(); });
    $$("#r-rows [data-ident]").forEach(b => b.onclick = () => api("POST", "/api/room/identify", { shape: Number(b.dataset.ident) }).then(() => toast("Lighting it up: the blinking end is LED 0 of this shape")));
    $$("#r-rows [data-dup]").forEach(b => b.onclick = () => { const s = clone(draft[Number(b.dataset.dup)]); s.name += " copy"; s.from = null; move(s, 0.4, 0.4); draft.push(s); sel = draft.length - 1; touch(); });
    $$("#r-rows [data-rm]").forEach(b => b.onclick = () => { draft.splice(Number(b.dataset.rm), 1); sel = Math.min(sel, draft.length - 1); touch(); });
    geometry(); devices(ranges);
  }

  function geometry() {
    const s = draft[sel], g = $("#r-geo"); if (!s) { g.innerHTML = '<span class="faint">Select a shape to change its size and position.</span>'; return; }
    const c = center(s), f = (k, label, v, step = 0.1) => `<div class="field"><label>${label}</label><input type="number" step="${step}" value="${Math.round(v * 100) / 100}" data-g="${k}"></div>`;
    g.innerHTML = `<div class="row" style="margin-bottom:8px"><b>${esc(s.name)}</b><span class="faint">position on the 16 × 9 wall view</span></div><div class="controls" style="grid-template-columns:repeat(6,minmax(0,1fr))">
      ${f("x", "Centre X (0–16)", c[0])}${f("y", "Centre Y (0–9, 0 = top)", c[1])}
      ${s.type === "rect" || s.type === "matrix" ? f("w", "Width", s.w) + f("h", "Height", s.h) : ["circle", "hex", "tri"].includes(s.type) ? f("size", "Radius", s.size) : f("len", "Length", length(s))}
      ${s.type === "matrix" ? f("cols", "Columns", s.cols, 1) + f("rows", "Rows", s.rows, 1) : f("rot", "Rotate (°)", s.rot || 0, 5)}
      ${["circle", "rect", "hex", "tri"].includes(s.type) ? f("start", "LED 0 position (0–1 around)", s.start || 0, 0.05) : ""}
    </div>`;
    $$("#r-geo [data-g]").forEach(x => x.onchange = () => { const v = Number(x.value), k = x.dataset.g; if (!Number.isFinite(v)) return;
      if (k === "x" || k === "y") { const cc = center(s); move(s, k === "x" ? v - cc[0] : 0, k === "y" ? v - cc[1] : 0); }
      else if (k === "len") scaleLine(s, v / Math.max(0.01, length(s)));
      else if (k === "rot" && s.pts) { rotatePts(s, v - (s.rot || 0)); s.rot = v; }
      else if (k === "cols" || k === "rows") { s[k] = Math.max(1, Math.round(v)); s.count = s.cols * s.rows; }
      else s[k] = v;
      touch(); });
  }

  function devices(ranges) {
    $("#r-devs").innerHTML = devs.map(d => {
      const mine = draft.map((s, i) => ({ s, r: ranges[i] })).filter(x => x.s.dev === d.id).sort((a, b) => a.r.start - b.r.start);
      const used = mine.reduce((m, x) => Math.max(m, x.r.end + 1), 0), probs = [];
      for (let k = 1; k < mine.length; k++) if (mine[k].r.start <= mine[k - 1].r.end) probs.push(`“${mine[k].s.name}” overlaps “${mine[k - 1].s.name}”`);
      if (d.leds && used > d.leds) probs.push(`uses ${used} LEDs but the controller has ${d.leds}`);
      return `<tr><td>${esc(d.name)}</td><td class="num">${d.leds || "?"}</td><td class="mono">${mine.map(x => `${esc(x.s.name)} ${x.r.start}–${x.r.end}`).join(", ") || '<span class="faint">nothing</span>'}</td>
        <td>${probs.length ? `<span class="badge warn">${esc(probs.join("; "))}</span>` : mine.length ? '<span class="badge live">OK</span>' : ""}</td>
        <td>${d.virtual ? "" : `<button class="btn sm" data-seg="${d.id}" type="button"${dirty || !mine.length ? " disabled" : ""} title="Write these ranges as segments in WLED">Send segments to WLED</button>`}</td></tr>`; }).join("");
    $$("#r-devs [data-seg]").forEach(b => b.onclick = () => act(() => api("POST", `/api/devices/${b.dataset.seg}/segments`), "Segments sent to WLED").catch(() => {}));
  }

  // ---- geometry helpers (stage units: 16 wide, 9 high)
  const pts = s => s.pts || null;
  function center(s) { if (pts(s)) { const p = s.pts; return [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length]; } return [s.cx ?? 8, s.cy ?? 4.5]; }
  function move(s, dx, dy) { if (pts(s)) s.pts = s.pts.map(([x, y]) => [clamp(x + dx, 0, STAGE_W), clamp(y + dy, 0, STAGE_H)]); else { s.cx = clamp((s.cx ?? 8) + dx, 0, STAGE_W); s.cy = clamp((s.cy ?? 4.5) + dy, 0, STAGE_H); } }
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
    const d = devs[0], base = { type, name: TYPES[type], count: 60, dev: d.id, rot: 0, start: 0, rev: false, from: null };
    return Object.assign(base, convert({ cx: 8, cy: 4.5 }, type));
  }

  // ---- dragging shapes on the stage
  const stageEl = $("#r-stage"); let drag = null;
  if (preview) {
    stageEl.onpointerdown = e => {
      const r = stageEl.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * STAGE_W, y = (e.clientY - r.top) / r.height * STAGE_H;
      const Lx = dirty ? L : app.layout; if (!Lx || !Lx.N) return;
      let best = -1, bd = 0.5; for (let i = 0; i < Lx.N; i++) { const d = Math.hypot(Lx.x[i] - x, Lx.y[i] - y); if (d < bd) { bd = d; best = i; } }
      if (best < 0) return; sel = Lx.shape[best]; drag = { x, y, moved: false }; stageEl.setPointerCapture(e.pointerId);
      if (!dirty) relayout(); render();
    };
    stageEl.onpointermove = e => { if (!drag) return; const r = stageEl.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * STAGE_W, y = (e.clientY - r.top) / r.height * STAGE_H;
      move(draft[sel], x - drag.x, y - drag.y); drag.x = x; drag.y = y; drag.moved = true; dirty = true; relayout(); };
    stageEl.onpointerup = () => { if (drag && drag.moved) touch(); drag = null; };
  }

  $("#r-add").onclick = () => { draft.push(newShape($("#r-newtype").value)); sel = draft.length - 1; touch(); };
  $("#r-use").onclick = async () => { if (draft.length && !confirm("Replace the current shapes with this layout?")) return;
    await act(() => api("POST", "/api/room/preset", { id: $("#r-preset").value }), "Layout applied").catch(() => {}); await refreshState(); await loadLayout(); route(); };
  $("#r-save").onclick = async () => { await act(() => api("PUT", "/api/room", { shapes: draft }), "Room saved").catch(() => null); await refreshState(); await loadLayout(); dirty = false; route(); };
  $("#r-discard").onclick = () => route();
  relayout(); render();
  return { preview: true, destroy() { preview && preview.destroy(); }, onChanged(w) { if (!dirty && (w.has("room") || w.has("devices"))) route(); } };
}
