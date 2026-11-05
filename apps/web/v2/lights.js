// Lights (dashboard v2, #/lights): "Which lights do I have, where are they, are they on time?"
// The room preview large at the top (the shapes of the light under the pointer are picked out), the lights as cards
// (status, timing, identify, edit in a side sheet, remove), Find lights / Add a light, the room editor and camera
// mapping, and a Timing card (each light's own delay, the trim slider, the one-tap timing fix, per-speaker timings).
// The device form in the edit sheet is the v1 Devices table row (app.js devicesPage) laid out as fields.
import { app, api, act, toast, esc, $, $$, opt, createPreview, refreshState, unlocked, DEMO } from "/app.js";
import { breakdown, fmtMs } from "/latency.js";

if (!document.querySelector('link[href="/v2/lights.css"]')) {
  const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/v2/lights.css"; document.head.appendChild(l);
}
const fmtOff = v => `${v > 0 ? "+" : ""}${v} ms`;

// ---------------------------------------------------------------- kinds of light (as in app.js devicesPage)
const SMART = { lifx: "LIFX", wiz: "WiZ", kasa: "TP-Link Kasa", yeelight: "Yeelight", twinkly: "Twinkly" };
const KIND_GROUPS = [["LED controllers", [["wled", "WLED"], ["openrgb", "OpenRGB (PC lighting)"]]], ["Panels and strings", [["nanoleaf", "Nanoleaf panels"], ["twinkly", "Twinkly"]]],
  ["Smart bulbs and strips", [["hue", "Philips Hue bridge"], ["lifx", "LIFX"], ["wiz", "WiZ"], ["kasa", "TP-Link Kasa"], ["yeelight", "Yeelight"], ["govee", "Govee (LAN, beta)"]]]];
const KIND_NAME = { wled: "WLED", openrgb: "OpenRGB", nanoleaf: "Nanoleaf", twinkly: "Twinkly", hue: "Philips Hue", lifx: "LIFX", wiz: "WiZ", kasa: "TP-Link Kasa", yeelight: "Yeelight", govee: "Govee", dmx: "DMX", virtual: "Virtual" };
const kindOf = d => d.virtual ? "virtual" : d.kind || "wled";
const KIND_GROUP = { wled: "LED strips", openrgb: "PC lighting", nanoleaf: "Panels and strings", twinkly: "Panels and strings", hue: "Smart lights", lifx: "Smart lights", wiz: "Smart lights", kasa: "Smart lights", yeelight: "Smart lights", govee: "Smart lights", dmx: "DMX fixtures", virtual: "Virtual" };
const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  strip: svg('<rect x="2.5" y="8.5" width="19" height="7" rx="3.5"/><circle cx="7" cy="12" r=".9"/><circle cx="12" cy="12" r=".9"/><circle cx="17" cy="12" r=".9"/>'),
  bulb: svg('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>'),
  panels: svg('<path d="M12 3l4 7H8zM8 10l4 7H4zM16 10l4 7h-8z"/>'),
  string: svg('<path d="M3 6c3 4 6 4 9 0s6-4 9 0"/><path d="M6 8.5v2M12 6v2M18 8.5v2"/>'),
  pc: svg('<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="9" r="2.5"/><path d="M9 16h6"/>'),
  spot: svg('<path d="M8 4h8l-1 6H9z"/><path d="M9 10l-3 10M15 10l3 10M12 10v10"/>'),
  screen: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
};
const KIND_ICON = { wled: "strip", openrgb: "pc", nanoleaf: "panels", twinkly: "string", hue: "bulb", lifx: "bulb", wiz: "bulb", kasa: "bulb", yeelight: "bulb", govee: "bulb", dmx: "spot", virtual: "screen" };
const I = {
  search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'), plus: svg('<path d="M12 5v14M5 12h14"/>'),
  room: svg('<path d="M4 20V8l8-4 8 4v12"/><path d="M4 20h16M9 20v-6h6v6"/>'), camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  flash: svg('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'), edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'), trash: svg('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'),
  ok: svg('<path d="M5 12.5l4.5 4.5L19 7"/>'), clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'), mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
};

/** Hue: basic or fast (Entertainment), offered when the bridge has an entertainment area */
function hueMode(d, h) {
  const fast = !!d.hue?.fast; if (!fast && !(h.hueAreas?.length || d.hue?.areas?.length)) return `<p class="lt-static">Hue basic, about 10 updates a second. Make an entertainment area in the Hue app for fast mode.</p>`;
  return `<select id="lt-f-hmode" aria-label="Hue mode">${opt("basic", "Hue: basic (10 a second)", !fast)}${opt("fast", "Hue: fast (Entertainment)", fast)}</select>`;
}
function smartMode(d) {
  const L = d.light || {};
  if (d.kind === "yeelight") return `<select id="lt-f-lopt" data-key="music" aria-label="Yeelight mode">${opt("1", "Music mode (20 a second)", L.music !== false)}${opt("0", "Normal (1 a second)", L.music === false)}</select>`;
  if (d.kind === "kasa" && L.strip) return `<select id="lt-f-lopt" data-key="perZone" aria-label="Kasa strip mode">${opt("0", "Whole strip", !L.perZone)}${opt("1", `${L.zones || "?"} zones (beta)`, !!L.perZone)}</select>`;
  if (d.kind === "lifx") return `<p class="lt-static">${L.extended && L.zones > 1 ? `LIFX, ${L.zones} zones` : "LIFX"}</p>`;
  return `<p class="lt-static">${esc(SMART[d.kind])}</p>`;
}

// ---------------------------------------------------------------- timing words
/** What a light's timing looks like now: {text, lvl: good|ok|slow|off|bad|none} */
function timingOf(d, h = {}) {
  if (d.enabled === false) return { text: "Turned off", lvl: "off" };
  if (h.online === false) return { text: "Offline", lvl: "bad" };
  if (h.latencyMs == null) return { text: "Checking", lvl: "none" };
  const ms = h.timing ? h.timing.shownMs : h.latencyMs, lvl = h.timing ? h.timing.level : h.latencyLevel;
  if (lvl === "good") return { text: "Lands on the beat", lvl, ms };
  return { text: ms < 0 ? `${Math.abs(ms)} ms early` : `${ms} ms late`, lvl, ms };
}
const stOf = (id, m = app.status) => (m?.devices || []).find(x => x.id === id) || {};

// ---------------------------------------------------------------- the side sheet: the shell's, or a small one of our own
let shellP = null;
const shell = () => shellP ||= import("/v2/shell.js").catch(() => null);
async function sheet({ title, body, onClose, wide }) {
  const s = await shell();
  if (s?.openSheet) { const r = s.openSheet({ title, body, onClose, wide }); r.body.classList.add("lt-sheetbody"); return { el: r.body, close: r.close }; }
  return ownSheet({ title, body, onClose });
}
function ownSheet({ title, body, onClose }) {
  const back = document.createElement("div"); back.className = "lt-sheet-back";
  const el = document.createElement("aside"); el.className = "lt-sheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", title);
  el.innerHTML = `<header class="lt-sheet-head"><h2>${esc(title)}</h2><button class="iconbtn" type="button" data-close aria-label="Close">${svg('<path d="M6 6l12 12M18 6L6 18"/>')}</button></header><div class="lt-sheet-main lt-sheetbody"></div>`;
  const main = el.querySelector(".lt-sheet-main"); if (typeof body === "string") main.innerHTML = body; else if (body) main.appendChild(body);
  const was = document.activeElement; document.body.append(back, el);
  requestAnimationFrame(() => { back.classList.add("open"); el.classList.add("open"); });
  let closed = false;
  const close = () => { if (closed) return; closed = true; removeEventListener("keydown", key, true); back.classList.remove("open"); el.classList.remove("open");
    setTimeout(() => { back.remove(); el.remove(); }, 220); was?.focus?.(); onClose?.(); };
  const key = e => { if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "Tab") { const f = $$('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])', el).filter(x => !x.disabled && x.offsetParent);
      if (!f.length) return; const a = f[0], z = f[f.length - 1]; if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); } } };
  addEventListener("keydown", key, true); back.onclick = close; el.querySelector("[data-close]").onclick = close;
  setTimeout(() => (el.querySelector("input, select, button:not([data-close])") || el.querySelector("[data-close]"))?.focus(), 30);
  return { el: main, close };
}

// ---------------------------------------------------------------- the screen
export function render(el) {
  let SH = null, gone = false; shell().then(m => { SH = m; if (!gone) timing(); });
  el.innerHTML = `<div class="lt span-12" id="lt"></div>`;
  const root = $("#lt", el);
  if (!unlocked()) {
    root.innerHTML = `<div class="lt-empty card"><div class="lt-empty-ic">${ICON.strip}</div><h2>Locked with a PIN</h2><p>Unlock Tempolight in Settings to add, edit or remove lights.</p><a class="btn primary" href="#/settings">Open the settings</a></div>`;
    return {};
  }
  let prev = null, sel = null, hover = null, open = null, ro = null, trim = null;
  const devs = () => app.state.devices;
  const hl = () => hover || sel;

  function build() {
    prev?.destroy(); prev = null; ro?.disconnect();
    const list = devs();
    if (!list.length) { root.innerHTML = emptyHtml(); wireEmpty(); return; }
    const leds = list.reduce((n, d) => n + (Number(d.leds) || 0), 0);
    root.innerHTML = `
      <section class="lt-frame" aria-label="The room">
        <div class="lt-stage stage" id="lt-stage"><canvas class="lt-hl" id="lt-hl" aria-hidden="true"></canvas></div>
        <div class="lt-over lt-over-tl"><span class="lt-chip" id="lt-sum">${list.length} light${list.length > 1 ? "s" : ""} · ${leds.toLocaleString()} LEDs</span><span class="lt-chip lt-chip-name" id="lt-hlname" hidden></span></div>
        <div class="lt-over lt-over-br"><a class="lt-chip lt-chip-btn" href="#/room">${I.room}Edit the room</a><a class="lt-chip lt-chip-btn" href="#/map">${I.camera}Map with the camera</a></div>
      </section>
      <div class="lt-cols">
        <section class="lt-lights" aria-labelledby="lt-h-lights">
          <header class="lt-head"><div><h2 id="lt-h-lights">Your lights</h2><p class="lt-sub" id="lt-online"></p></div>
            <div class="lt-acts"><button class="btn" type="button" id="lt-find">${I.search}Find lights</button><button class="btn primary" type="button" id="lt-add">${I.plus}Add a light</button></div></header>
          <div id="lt-cards"></div>
          <details class="lt-more"><summary>More options</summary><div class="lt-more-body">
            <p>DMX fixtures, protocols, power limits and every setting at once are in the full device table.</p>
            <div class="lt-row"><a class="btn sm" href="#/devices">Open the device table</a><button class="btn sm" type="button" id="lt-virtual">Add a virtual light</button></div></div></details>
        </section>
        <section class="lt-timing card" aria-labelledby="lt-h-timing" id="lt-timing"></section>
      </div>`;
    prev = createPreview($("#lt-stage"));
    cards(); timing(); paint(); overlay();
    ro = new ResizeObserver(() => overlay()); ro.observe($("#lt-stage"));
    $("#lt-find").onclick = findSheet; $("#lt-add").onclick = addSheet;
    $("#lt-virtual").onclick = addVirtual;
    // clicking a light in the room picks its card
    $("#lt-stage").onclick = e => { const id = devAt(e); if (!id) { sel = null; overlay(); markSel(); return; }
      sel = sel === id ? null : id; overlay(); markSel(); if (sel) $(`.lt-card[data-dev="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest", behavior: reduce() ? "auto" : "smooth" }); };
    $("#lt-stage").onmousemove = e => { const id = devAt(e); $("#lt-stage").style.cursor = id ? "pointer" : ""; };
  }
  const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  function emptyHtml() {
    return `<section class="lt-frame lt-frame-empty" aria-labelledby="lt-h-empty"><div class="lt-empty">
      <div class="lt-empty-ic">${ICON.bulb}</div><h2 id="lt-h-empty">No lights yet</h2>
      <p>Tempolight finds WLED, Hue, Nanoleaf, LIFX, WiZ, Govee and other lights on your network. No lights at hand? Try it with a virtual room on screen.</p>
      <div class="lt-row lt-row-c"><button class="btn primary" type="button" id="lt-find">${I.search}Find lights</button><button class="btn" type="button" id="lt-try">Try without lights</button></div>
      <button class="lt-link" type="button" id="lt-add">Add a light by its address</button></div></section>`;
  }
  function wireEmpty() { $("#lt-find").onclick = findSheet; $("#lt-try").onclick = addVirtual; $("#lt-add").onclick = addSheet; }
  const addVirtual = () => act(() => api("POST", "/api/devices", { virtual: true, name: "Virtual room" }), "Virtual light added").catch(() => {});

  // ---------------------------------------------------------------- cards
  function cardHtml(d) {
    const k = kindOf(d), h = stOf(d.id);
    return `<article class="lt-card${d.enabled === false ? " is-off" : ""}" data-dev="${esc(d.id)}" tabindex="0" aria-label="${esc(d.name)}">
      <div class="lt-card-top"><span class="lt-kind" title="${esc(KIND_NAME[k])}">${ICON[KIND_ICON[k]] || ICON.strip}</span>
        <div class="lt-card-id"><h3>${esc(d.name)}</h3><p><span class="lt-dot" data-dot></span>${esc(KIND_NAME[k])}${d.virtual ? " · on screen" : d.host ? ` · <span class="mono">${esc(d.host)}</span>` : ""}</p></div></div>
      <div class="lt-card-mid"><span class="lt-leds"><b>${d.leds ? Number(d.leds).toLocaleString() : "?"}</b> ${(SMART[d.kind] || d.kind === "hue" || d.kind === "govee") && d.leds <= 1 ? "light" : "LEDs"}</span><span class="lt-time" data-time></span></div>
      <div class="lt-card-acts"><button class="btn sm" type="button" data-identify>${I.flash}Identify</button><button class="btn sm" type="button" data-edit>${I.edit}Edit</button>
        <button class="btn sm lt-rm" type="button" data-remove aria-label="Remove ${esc(d.name)}" title="Remove">${I.trash}<span>Remove</span></button></div>
    </article>`;
  }
  function cards() {
    const list = devs(), box = $("#lt-cards"); if (!box) return;
    const groups = new Map(); if (list.length > 6) for (const d of list) { const g = KIND_GROUP[kindOf(d)] || "Other"; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d); }
    box.innerHTML = groups.size > 1 ? [...groups].map(([g, ds]) => `<div class="lt-group"><h3 class="lt-group-h">${esc(g)} <span>${ds.length}</span></h3><div class="lt-grid">${ds.map(cardHtml).join("")}</div></div>`).join("")
      : `<div class="lt-grid">${list.map(cardHtml).join("")}</div>`;
    $$(".lt-card", box).forEach(c => { const id = c.dataset.dev, d = () => devs().find(x => x.id === id);
      c.onmouseenter = () => { hover = id; overlay(); }; c.onmouseleave = () => { if (hover === id) { hover = null; overlay(); } };
      c.onfocusin = () => { hover = id; overlay(); }; c.onfocusout = e => { if (!c.contains(e.relatedTarget) && hover === id) { hover = null; overlay(); } };
      c.onclick = e => { if (e.target.closest("button")) return; sel = sel === id ? null : id; overlay(); markSel(); };
      c.onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && e.target === c) { e.preventDefault(); editSheet(id); } };
      c.querySelector("[data-identify]").onclick = () => identify(id);
      c.querySelector("[data-edit]").onclick = () => editSheet(id);
      c.querySelector("[data-remove]").onclick = () => remove(d()); });
    markSel();
  }
  const markSel = () => $$(".lt-card").forEach(c => c.classList.toggle("is-sel", c.dataset.dev === sel));
  const identify = id => api("POST", `/api/devices/${id}/identify`).then(() => toast("Lighting it up in white")).catch(e => toast(e.message, true));
  const remove = d => { if (d && confirm(`Remove ${d.name} and its shapes from the room?`)) act(() => api("DELETE", `/api/devices/${d.id}`), "Removed").then(() => open?.close()).catch(() => {}); };

  /** the live parts of the cards: online dot and timing */
  function paint(m = app.status) {
    const list = devs(); let on = 0;
    for (const d of list) { const c = $(`.lt-card[data-dev="${CSS.escape(d.id)}"]`); if (!c) continue; const h = stOf(d.id, m), t = timingOf(d, h);
      if (h.online) on++;
      const dot = c.querySelector("[data-dot]"), state = d.enabled === false ? "off" : h.online ? "ok" : h.online === false ? "bad" : "wait";
      dot.className = `lt-dot ${state}`; dot.title = { off: "Turned off", ok: "Online", bad: `Offline${h.error ? `: ${h.error}` : ""}`, wait: "Checking" }[state];
      dot.innerHTML = `<i></i><span class="lt-sr">${dot.title}</span>`;
      const tm = c.querySelector("[data-time]"), html = `${t.lvl === "good" ? I.ok : I.clock}${esc(t.text)}`;
      if (tm.dataset.k !== t.lvl + t.text) { tm.dataset.k = t.lvl + t.text; tm.className = `lt-time ${t.lvl}`; tm.innerHTML = html; tm.title = h.latency ? breakdown(h) : ""; } }
    const o = $("#lt-online"); if (o) { const late = list.filter(d => ["ok", "slow"].includes(timingOf(d, stOf(d.id, m)).lvl)).length;
      o.textContent = `${on} of ${list.length} online${late ? ` · ${late} not on the beat` : ""}`; }
  }

  // ---------------------------------------------------------------- the room highlight
  function devAt(e) {
    const L = app.layout, st = $("#lt-stage"); if (!L?.N || !st) return null;
    const r = st.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 16, y = (e.clientY - r.top) / r.height * 9;
    let best = -1, bd = 0.45 * 0.45; for (let i = 0; i < L.N; i++) { const dx = L.x[i] - x, dy = L.y[i] - y, q = dx * dx + dy * dy; if (q < bd) { bd = q; best = i; } }
    return best < 0 ? null : L.shapes?.[L.shape[best]]?.dev || null;
  }
  function overlay() {
    const cv = $("#lt-hl"), st = $("#lt-stage"); if (!cv || !st) return;
    const r = st.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1); cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const c = cv.getContext("2d"), L = app.layout, id = hl(), nm = $("#lt-hlname"); c.clearRect(0, 0, cv.width, cv.height);
    const d = id && devs().find(x => x.id === id); if (nm) { nm.hidden = !d; nm.textContent = d ? d.name : ""; }
    if (!d || !L?.N) return;
    const sx = cv.width / 16, sy = cv.height / 9, pad = 0.22, boxes = [];
    (L.shapes || []).forEach((sp, si) => { if (sp.dev !== id) return; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = 0; i < L.N; i++) if (L.shape[i] === si) { x0 = Math.min(x0, L.x[i]); y0 = Math.min(y0, L.y[i]); x1 = Math.max(x1, L.x[i]); y1 = Math.max(y1, L.y[i]); }
      if (x1 >= x0) boxes.push([(x0 - pad) * sx, (y0 - pad) * sy, (x1 - x0 + 2 * pad) * sx, (y1 - y0 + 2 * pad) * sy]); });
    if (!boxes.length) return;
    // dim the rest of the room, then ring each of this light's shapes
    c.fillStyle = "rgba(6,5,4,.55)"; c.beginPath(); c.rect(0, 0, cv.width, cv.height);
    const rr = (x, y, w, h, q) => { q = Math.min(q, w / 2, h / 2); c.moveTo(x + q, y); c.arcTo(x + w, y, x + w, y + h, q); c.arcTo(x + w, y + h, x, y + h, q); c.arcTo(x, y + h, x, y, q); c.arcTo(x, y, x + w, y, q); c.closePath(); };
    for (const b of boxes) rr(...b, 10 * dpr); c.fill("evenodd");
    const acc = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff8a1f";
    c.strokeStyle = acc; c.lineWidth = 1.6 * dpr; c.shadowColor = acc; c.shadowBlur = 14 * dpr;
    for (const b of boxes) { c.beginPath(); rr(...b, 10 * dpr); c.stroke(); }
  }

  // ---------------------------------------------------------------- timing card
  function timing() {
    const box = $("#lt-timing"); if (!box) return; const s = app.state.settings, off = app.status?.offsetMs ?? s.syncOffsetMs;
    const canCal = !!navigator.mediaDevices?.getUserMedia && !DEMO;
    box.innerHTML = `<header class="lt-head"><div><h2 id="lt-h-timing">Timing</h2><p class="lt-sub" id="lt-tmode"></p></div></header>
      <div class="lt-tlist" id="lt-tlist"></div>
      <div class="lt-trim"><span class="lt-offfor" id="lt-offfor"></span>
        ${SH?.bigSlider ? SH.bigSlider("lt-off", "Light timing", off, { min: -300, max: 300, step: 5, format: fmtOff }) : `<div class="lt-trim-h"><span></span><output id="lt-off-o">${fmtOff(off)}</output></div><input type="range" id="lt-off" min="-300" max="300" step="5" value="${off}" aria-label="Light timing">`}
        <div class="lt-trim-ends" aria-hidden="true"><span>Earlier</span><span>0</span><span>Later</span></div>
        <p class="help" id="lt-off-help">Lights after the beat: move it left. Before it: move it right. Bluetooth speakers often need −150 to −250.</p></div>
      <div class="lt-fix"><button class="btn primary" type="button" id="lt-cal"${canCal ? "" : " disabled"}>${I.mic}Fix the timing</button>
        <p class="help" id="lt-cal-msg">${canCal ? "Plays a few clicks and listens with the microphone. Turn the speakers up and keep quiet for 5 seconds." : DEMO ? "Works in the app on your computer, with a microphone." : "Needs microphone access, which this browser only allows on localhost or HTTPS."}</p></div>
      <div class="lt-spk" id="lt-spk"></div>`;
    const o = $("#lt-off"), save = v => act(() => api("PATCH", "/api/settings", { syncOffsetMs: v }), "Timing saved").then(refreshState).then(speakers).catch(() => {});
    o.setAttribute("aria-describedby", "lt-off-help");
    if (SH?.bindBigSlider) trim = SH.bindBigSlider(box, "lt-off", { onChange: save });
    else { const out = $("#lt-off-o"); o.oninput = () => { out.textContent = fmtOff(Number(o.value)); }; o.onchange = () => save(Number(o.value));
      trim = { set(v) { if (document.activeElement === o) return; o.value = v; out.textContent = fmtOff(v); } }; }
    $("#lt-cal").onclick = calibrate;
    tlist(); speakers();
  }
  function tlist(m = app.status) {
    const box = $("#lt-tlist"); if (!box) return; const list = devs().filter(d => d.enabled !== false);
    const mode = (m?.devices || []).find(h => h.timing)?.timing?.mode, tm = $("#lt-tmode");
    if (tm) tm.textContent = mode === "ahead" ? "The beat is known ahead, so slow lights are drawn early and fast ones wait." : "Each light shows the beat as soon as it can.";
    const scale = Math.max(80, ...list.map(d => { const t = stOf(d.id, m).timing; return (t?.lightMs || 0) + (t?.holdMs || 0); }));
    box.innerHTML = list.length ? list.map(d => { const h = stOf(d.id, m), t = timingOf(d, h), own = h.timing?.lightMs ?? h.latency?.lightMs, auto = h.timing ? h.timing.auto : h.latency?.lightAuto !== false, hold = h.timing?.holdMs || 0;
      return `<div class="lt-trow"><div class="lt-trow-n"><b>${esc(d.name)}</b><span class="lt-time ${t.lvl}">${esc(t.text)}</span></div>
        ${h.online === false ? `<div class="lt-trow-m">Not answering on the network</div></div>` : ""}${h.online === false ? "" : `<div class="lt-tbar" title="${esc(h.latency ? breakdown(h) : "")}"><i style="width:${own == null ? 0 : Math.min(100, own / scale * 100)}%"></i>${hold ? `<i class="hold" style="left:${Math.min(100, (own || 0) / scale * 100)}%;width:${Math.min(100, hold / scale * 100)}%"></i>` : ""}</div>
        <div class="lt-trow-m"><span class="mono">${own == null ? "–" : fmtMs(own)}</span> ${auto ? "own delay, estimated" : "own delay, set by hand"}${hold ? ` · waits <span class="mono">${hold} ms</span>` : ""}</div></div>`}`; }).join("")
      : `<p class="help">Turn a light on to see its timing.</p>`;
  }
  function speakers() {
    const box = $("#lt-spk"); if (!box) return; const s = app.state.settings, list = Object.entries(s.syncOffsets || {}), cur = app.status?.hearing?.output;
    const forf = $("#lt-offfor"); if (forf) forf.textContent = cur?.name ? `For ${cur.name}` : "";
    if (!list.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<h3 class="lt-h3">Timing per speaker</h3><div class="lt-spk-list">${list.map(([k, o]) => `<div class="lt-spk-row"><span>${esc(o.name)}${o.bt ? ' <span class="badge">Bluetooth</span>' : ""}${k === cur?.key ? ' <span class="badge live">playing now</span>' : ""}</span><span class="mono">${o.ms > 0 ? "+" : ""}${o.ms} ms</span><button class="btn sm" type="button" data-offdel="${esc(k)}">Forget</button></div>`).join("")}
      <div class="lt-spk-row faint"><span>Any other speaker</span><span class="mono">${s.syncOffsetMs > 0 ? "+" : ""}${s.syncOffsetMs} ms</span><span></span></div></div>`;
    $$("[data-offdel]", box).forEach(b => b.onclick = () => act(() => api("PATCH", "/api/settings", { syncOffsets: { [b.dataset.offdel]: null } }), "Forgotten").then(refreshState).then(speakers).catch(() => {}));
  }
  async function calibrate() {
    const b = $("#lt-cal"), msg = $("#lt-cal-msg"); if (!app.audio?.calibrate) return; b.disabled = true; msg.textContent = "Listening… keep quiet";
    try {
      const input = (() => { try { return localStorage.getItem("tl.input") || ""; } catch { return ""; } })();
      const r = await app.audio.calibrate(input, p => { if ($("#lt-cal-msg")) msg.textContent = `Listening… ${Math.round(p * 100)}%`; });
      if (!r.ok) { msg.textContent = r.heard ? `The clicks were hard to hear (${r.heard} of ${r.sent}). Turn the speakers up, move closer and try again.` : "The microphone didn't hear the clicks. Turn the speakers up and try again."; return; }
      const { offsetFromDelay } = await import("/calibrate.js"), off = offsetFromDelay(r.delayMs, r.reportedOutputMs);
      await api("PATCH", "/api/settings", { syncOffsetMs: off }); await refreshState();
      trim?.set(off); speakers();
      const out = app.status?.hearing?.output;
      msg.textContent = `Speakers to microphone: ${Math.round(r.delayMs)} ms. Light timing set to ${off > 0 ? "+" : ""}${off} ms${out ? ` for ${out.name}` : ""}.`;
    } catch (e) { msg.textContent = e.name === "NotAllowedError" ? "Microphone permission was refused." : `Couldn't measure: ${e.message}`; }
    finally { b.disabled = false; }
  }

  // ---------------------------------------------------------------- edit sheet: the v1 device row as a form
  async function editSheet(id) {
    const d0 = devs().find(x => x.id === id); if (!d0) return; open?.close();
    sel = id; overlay(); markSel();
    const s = await sheet({ title: d0.name, body: "", onClose: () => { if (open?.id === id) open = null; } });
    open = { id, close: s.close, el: s.el }; fillEdit();
  }
  function fillEdit() {
    if (!open) return; const d = devs().find(x => x.id === open.id); if (!d) { open.close(); return; }
    const h = stOf(d.id), k = kindOf(d), ddp = !d.protocol || d.protocol === "ddp", L = d.lightLatencyMs != null && d.lightLatencyMs !== "";
    const proto = d.virtual ? "" : d.kind === "hue" ? hueMode(d, h) : SMART[d.kind] ? smartMode(d) : d.kind === "nanoleaf" ? `<p class="lt-static">Nanoleaf stream</p>` : d.kind === "openrgb" ? `<p class="lt-static">OpenRGB device #${d.orgbIndex || 0}</p>`
      : d.kind === "govee" ? `<select id="lt-f-gmode" aria-label="Govee mode">${opt("color", "One colour", d.goveeMode !== "segments")}${opt("segments", "Segments (beta)", d.goveeMode === "segments")}</select>`
      : `<select id="lt-f-proto" aria-label="Protocol">${d.kind === "dmx" ? "" : opt("ddp", "DDP", ddp)}${opt("e131", "E1.31 (sACN)", d.protocol === "e131")}${opt("artnet", "Art-Net", d.protocol === "artnet")}</select>`;
    const port = d.virtual || SMART[d.kind] || d.kind === "hue" || d.kind === "nanoleaf" || d.kind === "openrgb" ? ""
      : d.kind === "govee" ? (d.goveeMode === "segments" ? `<div class="field"><label for="lt-f-gseg">Segments on the light</label><input type="number" id="lt-f-gseg" min="1" max="60" value="${d.goveeSegments || ""}"></div>` : "")
      : ddp ? `<div class="field"><label for="lt-f-port">DDP port</label><input type="number" id="lt-f-port" min="1" max="65535" value="${d.ddpPort || 4048}"></div>`
      : `<div class="field"><label for="lt-f-univ">First universe</label><input type="number" id="lt-f-univ" min="0" max="63999" value="${d.universe ?? (d.protocol === "artnet" ? 0 : 1)}"></div>`;
    open.el.innerHTML = `
      <div class="lt-ed-hero"><span class="lt-kind lg">${ICON[KIND_ICON[k]] || ICON.strip}</span><div><b>${esc(KIND_NAME[k])}</b><div class="lt-ed-st" id="lt-ed-st"></div></div>
        <label class="lt-ed-on"><span>Send light</span><input type="checkbox" id="lt-f-en" ${d.enabled !== false ? "checked" : ""} aria-label="Send the show to this light"></label></div>
      <div class="lt-ed-acts"><button class="btn" type="button" id="lt-f-id">${I.flash}Identify</button>${SMART[d.kind] || !(d.virtual || d.kind) ? `<button class="btn" type="button" id="lt-f-chk">Check the connection</button>` : ""}${d.virtual || d.kind ? "" : `<button class="btn" type="button" id="lt-f-seg" title="Write this room's segments into WLED">Send segments to WLED</button>`}</div>
      <div class="lt-form">
        <div class="field"><label for="lt-f-name">Name</label><input id="lt-f-name" value="${esc(d.name)}" autocomplete="off"></div>
        ${d.virtual ? "" : `<div class="field"><label for="lt-f-host">Address</label><input id="lt-f-host" class="mono" value="${esc(d.host)}" autocomplete="off" spellcheck="false"></div>`}
        <div class="lt-form2"><div class="field"><label for="lt-f-leds">LEDs</label><input type="number" id="lt-f-leds" min="1" value="${d.leds || ""}"><span class="help">The room uses <span class="mono">${h.used ?? 0}</span></span></div>
          <div class="field"><label for="lt-f-amps">Power limit (A)</label><input type="number" id="lt-f-amps" min="0" max="500" step="0.5" placeholder="none" value="${d.maxAmps || ""}"><span class="help" id="lt-ed-amps">${h.amps != null ? `Drawing <span class="mono">${h.amps.toFixed(1)} A</span>${h.limited ? ", held back to stay under it" : ""}` : "Your power supply's amps"}</span></div></div>
        ${proto ? `<div class="field"><label>${d.kind === "hue" || SMART[d.kind] || d.kind === "govee" ? "Mode" : "Protocol"}</label>${proto}</div>` : ""}
        ${port}
        <div class="field"><label for="lt-f-lat">This light's own delay</label>
          <div class="lt-row"><label class="check"><input type="checkbox" id="lt-f-latauto" ${L ? "" : "checked"}> Estimate it</label><input type="number" id="lt-f-lat" min="0" max="500" step="1" value="${L ? d.lightLatencyMs : h.latency?.lightMs ?? ""}" ${L ? "" : "disabled"} style="max-width:120px"> <span class="faint">ms</span></div>
          <span class="help">From the frame leaving Tempolight to the light changing. Estimated from the network and the kind of light; set it by hand if one light stays late.</span></div>
      </div>
      <dl class="lt-facts" id="lt-ed-facts"></dl>
      <div class="lt-ed-warn" id="lt-ed-warn"></div>
      <div class="lt-ed-foot"><button class="btn danger" type="button" id="lt-f-del">${I.trash}Remove this light</button></div>`;
    const patch = (b, ok = "Saved") => act(() => api("PATCH", `/api/devices/${d.id}`, b), ok);
    const reload = () => refreshState().then(() => { cards(); paint(); fillEdit(); });
    const on = (sel2, ev, fn) => { const x = $(sel2, open.el); if (x) x[ev] = fn; };
    on("#lt-f-en", "onchange", e => patch({ enabled: e.target.checked }, e.target.checked ? "Sending light" : "Turned off").catch(() => {}));
    on("#lt-f-name", "onchange", e => patch({ name: e.target.value }).catch(() => {}));
    on("#lt-f-host", "onchange", e => patch({ host: e.target.value }).catch(() => {}));
    on("#lt-f-leds", "onchange", e => patch({ leds: Number(e.target.value) }).catch(() => {}));
    on("#lt-f-amps", "onchange", e => patch({ maxAmps: Number(e.target.value) || 0 }).catch(() => {}));
    on("#lt-f-port", "onchange", e => patch({ ddpPort: Number(e.target.value) }).catch(() => {}));
    on("#lt-f-univ", "onchange", e => patch({ universe: Number(e.target.value) }).catch(() => {}));
    on("#lt-f-gseg", "onchange", e => patch({ goveeSegments: Number(e.target.value) || null }).catch(() => {}));
    on("#lt-f-proto", "onchange", e => patch({ protocol: e.target.value }).then(reload).catch(() => {}));
    on("#lt-f-gmode", "onchange", e => patch({ goveeMode: e.target.value }).then(reload).catch(() => {}));
    on("#lt-f-hmode", "onchange", e => patch({ hueFast: e.target.value === "fast" }, e.target.value === "fast" ? "Fast mode on" : "Basic mode").catch(() => { e.target.value = "basic"; }));
    on("#lt-f-lopt", "onchange", e => patch({ light: { [e.target.dataset.key]: e.target.value === "1" } }).catch(() => {}));
    on("#lt-f-latauto", "onchange", e => { const n = $("#lt-f-lat", open.el); n.disabled = e.target.checked;
      patch({ lightLatencyMs: e.target.checked ? null : Math.max(0, Math.min(500, Number(n.value) || 0)) }, e.target.checked ? "Delay estimated again" : "Delay set").catch(() => {}); });
    on("#lt-f-lat", "onchange", e => patch({ lightLatencyMs: Math.max(0, Math.min(500, Number(e.target.value) || 0)) }, "Delay set").catch(() => {}));
    on("#lt-f-id", "onclick", () => identify(d.id));
    on("#lt-f-seg", "onclick", () => act(() => api("POST", `/api/devices/${d.id}/segments`), "Segments sent to WLED").catch(() => {}));
    on("#lt-f-chk", "onclick", () => act(() => api("POST", `/api/devices/${d.id}/check`)).then(r => toast(r.online ? `Online, ${/^[A-Z]/.test(r.version || "") ? "" : "WLED "}${r.version}, ${r.ledsReported} LEDs` : `Offline: ${r.error}`, !r.online)).catch(() => {}));
    on("#lt-f-del", "onclick", () => remove(d));
    editStatus();
  }
  /** the live parts of the edit sheet */
  function editStatus(m = app.status) {
    if (!open) return; const d = devs().find(x => x.id === open.id); if (!d) return; const h = stOf(d.id, m), t = timingOf(d, h);
    const st = $("#lt-ed-st", open.el); if (st) st.innerHTML = `<span class="lt-dot ${d.enabled === false ? "off" : h.online ? "ok" : h.online === false ? "bad" : "wait"}"><i></i><span>${d.enabled === false ? "Off" : h.online ? "Online" : h.online === false ? "Offline" : "Checking"}</span></span><span class="lt-time ${t.lvl}">${esc(t.text)}</span>`;
    const f = $("#lt-ed-facts", open.el); if (f) f.innerHTML = [["Firmware", h.version], ["Wi-Fi", h.signal != null ? `${h.signal}%` : null], ["Frames sent", h.sent != null ? Number(h.sent).toLocaleString() : null],
      ["Sound to light", h.latency ? breakdown(h) : null]].filter(x => x[1]).map(([a, b]) => `<div><dt>${a}</dt><dd class="${a === "Sound to light" ? "" : "mono"}">${esc(b)}</dd></div>`).join("");
    const w = $("#lt-ed-warn", open.el); if (w) w.innerHTML = (h.warnings || []).map(x => `<p class="lt-warn ${x.kind === "offline" ? "bad" : ""}">${esc(x.text)}</p>`).join("") || (h.online === false && h.error ? `<p class="lt-warn bad">${esc(h.error)}</p>` : "");
  }

  // ---------------------------------------------------------------- add a light
  async function addSheet() {
    open?.close(); open = null;
    const s = await sheet({ title: "Add a light", body: `
      <p class="lt-lede">Enter the light's address from its app or your router. To look for lights by themselves, use Find lights.</p>
      <div class="lt-form">
        <div class="field"><label for="lt-a-kind">Kind of light</label><select id="lt-a-kind">${KIND_GROUPS.map(([g, list]) => `<optgroup label="${g}">${list.map(([v, l]) => opt(v, l, v === "wled")).join("")}</optgroup>`).join("")}</select></div>
        <div class="field"><label for="lt-a-ip">Address</label><input id="lt-a-ip" class="mono" placeholder="192.168.1.42 or host:port" autocomplete="off" spellcheck="false"></div>
        <div class="field"><label for="lt-a-name">Name <span class="faint">optional</span></label><input id="lt-a-name" placeholder="Desk strip" autocomplete="off"></div>
        <button class="btn primary lt-wide-btn" type="button" id="lt-a-go">${I.plus}Add this light</button>
      </div>
      <details class="lt-more"><summary>Before adding other kinds of light</summary><ul class="lt-tips">
        <li><b>WLED</b>: keep "Receive UDP realtime" on in Sync settings. Light is sent with DDP on UDP port 4048.</li>
        <li><b>OpenRGB</b> (RAM, fans, keyboards): start OpenRGB's SDK server, then Find lights.</li>
        <li><b>Nanoleaf</b>: hold the power button for 5 to 7 seconds until the lights flash, then add its address.</li>
        <li><b>Twinkly</b>: nothing to do; lights mapped in the Twinkly app appear in that shape.</li>
        <li><b>Philips Hue</b>: press the bridge's link button, then add its address. Make an entertainment area in the Hue app for fast mode.</li>
        <li><b>LIFX</b>: LAN control must be on (it is by default).</li>
        <li><b>WiZ</b>: turn on "Allow local communication" in the WiZ app.</li>
        <li><b>TP-Link Kasa</b>: bulbs and KL strips. Tapo lights aren't supported.</li>
        <li><b>Yeelight</b>: turn on "LAN Control" in the Yeelight app, and let Tempolight through your firewall.</li>
        <li><b>Govee</b> (beta): turn on "LAN Control" in the Govee Home app.</li>
        <li><b>DMX</b>: add fixtures in the <a href="#/devices">device table</a>.</li></ul></details>` });
    const box = s.el;
    $("#lt-a-kind", box).onchange = e => { if (e.target.value === "openrgb" && !$("#lt-a-ip", box).value) $("#lt-a-ip", box).value = "127.0.0.1"; };
    const add = force => { const kind = $("#lt-a-kind", box).value, body = { host: $("#lt-a-ip", box).value.trim(), name: $("#lt-a-name", box).value.trim() || undefined, kind: kind === "wled" ? undefined : kind };
      if (force) body.force = true;
      return act(() => api("POST", "/api/devices", body), "Light added").then(() => s.close()); };
    $("#lt-a-go", box).onclick = () => { if (!$("#lt-a-ip", box).value.trim()) { toast("Enter the light's address", true); $("#lt-a-ip", box).focus(); return; }
      add(false).catch(e => { if (/add it anyway/.test(e.message) && confirm(e.message + "\n\nAdd it anyway?")) add(true).catch(() => {}); }); };
    $("#lt-a-ip", box).onkeydown = e => { if (e.key === "Enter") $("#lt-a-go", box).click(); };
  }

  // ---------------------------------------------------------------- find lights (network scan, v1 discovery)
  async function findSheet() {
    open?.close(); open = null;
    const s = await sheet({ title: "Find lights", body: `
      <p class="lt-lede" id="lt-s-msg">Looking on your network…</p>
      <div class="lt-found" id="lt-s-list"><div class="lt-skel"></div><div class="lt-skel"></div><div class="lt-skel"></div></div>
      <div class="lt-row"><button class="btn" type="button" id="lt-s-again">${I.search}Scan again</button><button class="lt-link" type="button" id="lt-s-add">Add a light by its address</button></div>` });
    const box = s.el;
    const label = f => f.kind === "govee" ? "Govee · LAN" : f.kind === "openrgb" ? "OpenRGB" : SMART[f.kind] ? `${SMART[f.kind]}${f.leds > 1 ? ` · ${f.leds} zones` : ""}` : `${f.via === "mdns" ? "WLED (mDNS)" : "WLED"} · ${f.leds ?? "?"} LEDs`;
    const kOf = f => f.kind || "wled";
    async function scan() {
      const msg = $("#lt-s-msg", box), list = $("#lt-s-list", box), again = $("#lt-s-again", box); if (!msg) return;
      msg.textContent = "Looking on your network… this takes a few seconds."; again.disabled = true; list.innerHTML = '<div class="lt-skel"></div><div class="lt-skel"></div><div class="lt-skel"></div>';
      try { const found = await api("POST", "/api/discover", { scan: true }); if (!box.isConnected) return;
        msg.textContent = found.length ? `Found ${found.length} light${found.length > 1 ? "s" : ""}.` : "No lights found. Check they are switched on and on the same network as this computer.";
        list.innerHTML = found.map((f, i) => `<div class="lt-frow"><span class="lt-kind">${ICON[KIND_ICON[kOf(f)]] || ICON.strip}</span><div class="lt-frow-id"><b>${esc(f.name || "WLED")}</b><span><span class="mono">${esc(f.host)}</span> · ${esc(label(f))}</span></div>
          ${f.added ? '<span class="lt-added">Added</span>' : `<button class="btn sm primary" type="button" data-f="${i}">Add</button>`}</div>`).join("");
        $$("[data-f]", list).forEach(b => b.onclick = () => { const f = found[Number(b.dataset.f)];
          act(() => api("POST", "/api/devices", f.kind === "govee" || SMART[f.kind] ? { host: f.host, name: f.name, kind: f.kind } : f.kind === "openrgb" ? { host: f.host, name: f.name, kind: "openrgb", index: f.index, leds: f.leds } : { host: f.host, name: f.name, leds: f.leds, force: true }), "Light added")
            .then(() => { b.outerHTML = '<span class="lt-added">Added</span>'; }).catch(() => {}); });
      } catch (e) { if (msg.isConnected) { msg.textContent = `Couldn't scan: ${e.message}`; list.innerHTML = ""; } }
      finally { if (again.isConnected) again.disabled = false; }
    }
    $("#lt-s-again", box).onclick = scan; $("#lt-s-add", box).onclick = () => { s.close(); addSheet(); };
    scan();
  }

  build();
  return {
    preview: true,
    destroy() { gone = true; prev?.destroy(); ro?.disconnect(); open?.close(); },
    onStatus(m) { if (gone) return; paint(m); tlist(m); editStatus(m); const f = $("#lt-offfor"), cur = m.hearing?.output; if (f) f.textContent = cur?.name ? `For ${cur.name}` : ""; },
    onChanged(w) {
      if (gone || !(w.has("devices") || w.has("room") || w.has("all") || w.has("settings"))) return;
      const had = !!$("#lt-cards"), has = devs().length > 0;
      if (had !== has) { build(); return; }
      if (!has) return;
      if (w.has("devices") || w.has("room") || w.has("all")) { const sum = $("#lt-sum"), list = devs(); if (sum) sum.textContent = `${list.length} light${list.length > 1 ? "s" : ""} · ${list.reduce((n, d) => n + (Number(d.leds) || 0), 0).toLocaleString()} LEDs`;
        if (hover && !list.some(d => d.id === hover)) hover = null; if (sel && !list.some(d => d.id === sel)) sel = null;
        cards(); paint(); tlist(); overlay();
        if (open && !open.el.contains(document.activeElement)) fillEdit(); else editStatus(); }
      if (w.has("settings")) { speakers(); trim?.set(app.status?.offsetMs ?? app.state.settings.syncOffsetMs); }
    },
  };
}
