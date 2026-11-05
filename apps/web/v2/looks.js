// Looks (dashboard v2, design/dashboard-v2.md): "What can the lights look like?". Saved looks (scenes) at the top, a
// gallery of every effect with a live thumbnail each (fxthumbs.js), grouped by what automatic mode picks them for
// (AUTO in engine/ratings.js), then all effects with search and filters. Tap a card to play it now; a sticky bar says
// what is playing and holds how automatic mode chooses (variety, colours, music style). Each card's "Adjust" sheet holds
// that effect's settings (speed, intensity, colour shift, saturation, mirror), as v1's Effects page did.
import { app, api, act, toast, esc, $, $$, guestOk } from "/app.js";
import { openSheet, segmented, bigSlider, bindBigSlider, toggle, bindToggle, ensureCss } from "/v2/shell.js";
import { createThumbs } from "/v2/fxthumbs.js";

ensureCss("/v2/looks.css");
const ratingsP = import("/engine/ratings.js").catch(() => null);

const TAG = { calm: "Calm", build: "Build-up", drop: "Drop", home: "Everyday", any: "Any part", "LedFx-like": "Classic", mine: "Mine" };
const VARIETY = [["one", "One look"], ["parts", "Song parts"], ["show", "Show"]];
const VARIETY_HELP = { one: "One effect for the whole song, picked to fit it", parts: "One each for calm parts, build-ups and drops", show: "Effects change with the song" };
const FILTERS = [["all", "All"], ["drop", "Drops"], ["build", "Build-ups"], ["calm", "Calm"], ["home", "Everyday"], ["LedFx-like", "Classic"], ["mine", "Mine"], ["liked", "Liked"], ["hidden", "Hidden"]];
const P = [["speed", "Speed", 0.25, 3, 0.05, 1, v => v.toFixed(2).replace(/\.?0+$/, "") + "×"], ["intensity", "Intensity", 0.1, 2.5, 0.05, 1, v => Math.round(v * 100) + "%"],
  ["hue", "Colour shift", -180, 180, 5, 0, v => (v > 0 ? "+" : "") + v + "°"], ["saturation", "Saturation", 0, 2, 0.05, 1, v => Math.round(v * 100) + "%"]];
const I = { // 24px stroke icons
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  ban: '<circle cx="12" cy="12" r="8"/><path d="M6.4 6.4l11.2 11.2"/>',
  adjust: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>', sync: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>', search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>', dots: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>', back: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
};
const icon = n => `<svg viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`;
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

export function render(el) {
  const st = () => app.state, show = () => app.state.show, prefs = () => app.state.settings.effectPrefs || {};
  const canFx = guestOk("effects"), canScenes = guestOk("scenes");
  let filter = "all", q = "", AUTO = null, adjust = null, customs = [], alive = true, lastFx = null, lastMode = null;
  const live = {}; // effect settings being dragged in the Adjust sheet, before the server has them
  const effects = () => st().effects, byId = id => effects().find(e => e.id === id);
  const tagOf = id => { const e = byId(id); return e?.custom ? (e.tag || "drop") : e?.tag || "any"; };
  const thumbs = createThumbs({ palette: () => show().palette || "auto", params: id => live[id] || (show().params || {})[id] || null, tagOf });
  const topPick = id => !!AUTO && (AUTO.drop.includes(id) || AUTO.build.includes(id) || AUTO.calm.includes(id));

  el.innerHTML = `<div class="lk">
    <section class="lk-sec" aria-labelledby="lk-saved-h">
      <header class="lk-head"><div><h2 id="lk-saved-h">Saved looks</h2><p>An effect or automatic mode, with its colours, style and brightness</p></div>
        <button class="btn" id="lk-save" type="button"${canScenes ? "" : " disabled"}>${icon("plus")}Save this look</button></header>
      <div class="lk-scenes" id="lk-scenes"></div>
    </section>
    <section class="lk-sec" data-role="drop" aria-labelledby="lk-drop-h"><header class="lk-head"><div><h2 id="lk-drop-h">Best for drops</h2><p>Automatic mode opens a drop with one of these, best first</p></div></header><div class="lk-grid" id="lk-g-drop"></div></section>
    <section class="lk-sec" data-role="build" aria-labelledby="lk-build-h"><header class="lk-head"><div><h2 id="lk-build-h">Build-ups</h2><p>For the bars that lead into a drop</p></div></header><div class="lk-grid" id="lk-g-build"></div></section>
    <section class="lk-sec" data-role="calm" aria-labelledby="lk-calm-h"><header class="lk-head"><div><h2 id="lk-calm-h">Calm</h2><p>For intros, breaks and quiet songs</p></div></header><div class="lk-grid" id="lk-g-calm"></div></section>
    <section class="lk-sec" aria-labelledby="lk-all-h">
      <header class="lk-head"><div><h2 id="lk-all-h">All effects <span class="lk-count" id="lk-count"></span></h2><p>Every effect works on any layout. A heart makes automatic mode pick it more often; hidden ones it never picks.</p></div></header>
      <div class="lk-tools-row"><label class="lk-search">${icon("search")}<input id="lk-q" type="search" placeholder="Search effects" aria-label="Search effects" autocomplete="off"></label>
        <div class="lk-chips" id="lk-filters" role="group" aria-label="Filter effects"></div></div>
      <div class="lk-grid" id="lk-g-all"></div>
      <div class="lk-empty" id="lk-none" hidden><p>No effects match.</p><button class="btn" id="lk-clear" type="button">Show all effects</button></div>
    </section>
    <div class="lk-dock" id="lk-dock" role="region" aria-label="How it chooses"></div>
  </div>`;
  const root = el.querySelector(".lk");

  // ---------------------------------------------------------------- effect cards
  function card(e, { badge = false } = {}) {
    const pr = prefs()[e.id] || 0, tuned = !!(show().params || {})[e.id], name = esc(e.name);
    return `<article class="ui-gcard lk-card${pr === -1 ? " is-hidden" : ""}" data-fx="${esc(e.id)}">
      <button class="lk-play" type="button" data-play="${esc(e.id)}" aria-label="Play ${name} now"${canFx ? "" : " disabled"}>
        <span class="ui-thumb lk-thumb" data-thumb="${esc(e.id)}"><span class="lk-badges">${badge && topPick(e.id) ? '<span class="lk-badge">Top pick</span>' : ""}<span class="lk-badge is-on">Playing</span></span></span>
        <span class="lk-name"><b>${name}</b><span>${esc(e.custom ? "Mine" : TAG[e.tag] || e.tag)}${tuned ? " · adjusted" : ""}${pr === -1 ? " · hidden" : ""}</span></span>
      </button>
      <div class="lk-ctl">
        <button class="lk-ib" type="button" data-like="${esc(e.id)}" aria-pressed="${pr === 1}" aria-label="Like ${name}" title="Like: automatic mode picks it more often"${canFx ? "" : " disabled"}>${icon("heart")}</button>
        <button class="lk-ib" type="button" data-ban="${esc(e.id)}" aria-pressed="${pr === -1}" aria-label="Hide ${name}" title="Hide: automatic mode never picks it"${canFx ? "" : " disabled"}>${icon("ban")}</button>
        <button class="lk-ib" type="button" data-adjust="${esc(e.id)}" aria-label="Adjust ${name}" title="Adjust speed, intensity and colours">${icon("adjust")}</button>
      </div></article>`;
  }
  function fillGrid(g, list, opts) {
    thumbs.clear(g); g.innerHTML = list.map(e => card(e, opts)).join("");
    for (const t of g.querySelectorAll("[data-thumb]")) thumbs.attach(t, t.dataset.thumb);
    markPlaying();
  }
  function sections() {
    const pick = ids => ids.map(byId).filter(Boolean);
    const roles = AUTO || { drop: effects().filter(e => e.tag === "drop").slice(0, 12).map(e => e.id), build: effects().filter(e => e.tag === "build").map(e => e.id), calm: effects().filter(e => e.tag === "calm").slice(0, 8).map(e => e.id) };
    for (const r of ["drop", "build", "calm"]) fillGrid($(`#lk-g-${r}`, root), pick(roles[r]));
  }
  function allGrid() {
    const pr = prefs(), mine = effects().some(e => e.custom);
    $("#lk-filters", root).innerHTML = FILTERS.filter(([k]) => k !== "mine" || mine).map(([k, v]) => `<button class="chip" type="button" data-filter="${k}" aria-pressed="${k === filter}">${v}</button>`).join("");
    const list = effects().filter(e => (filter === "all" || (filter === "mine" ? e.custom : filter === "liked" ? pr[e.id] === 1 : filter === "hidden" ? pr[e.id] === -1 : e.tag === filter))
      && (!q || e.name.toLowerCase().includes(q) || (TAG[e.tag] || "").toLowerCase().includes(q)));
    fillGrid($("#lk-g-all", root), list, { badge: true });
    $("#lk-count", root).textContent = list.length === effects().length ? effects().length : `${list.length} of ${effects().length}`;
    $("#lk-none", root).hidden = list.length > 0;
  }
  function markPlaying() {
    const manual = show().mode === "manual", on = app.status?.effect || show().effect;
    for (const c of root.querySelectorAll(".lk-card")) { const p = c.dataset.fx === on; c.classList.toggle("is-playing", p); c.classList.toggle("is-picked", p && manual); }
  }
  // likes and hides change in place (no new thumbnails)
  function markPrefs() {
    const pr = prefs();
    for (const c of root.querySelectorAll(".lk-card")) { const v = pr[c.dataset.fx] || 0; c.classList.toggle("is-hidden", v === -1);
      c.querySelector("[data-like]")?.setAttribute("aria-pressed", v === 1); c.querySelector("[data-ban]")?.setAttribute("aria-pressed", v === -1);
      const m = c.querySelector(".lk-name span"), e = byId(c.dataset.fx); if (m && e) m.textContent = `${e.custom ? "Mine" : TAG[e.tag] || e.tag}${(show().params || {})[e.id] ? " · adjusted" : ""}${v === -1 ? " · hidden" : ""}`; }
  }

  const play = id => act(() => api("PATCH", "/api/show", { mode: "manual", effect: id })).then(r => { if (r) app.state.show = r; dock(); markPlaying(); }).catch(() => {});
  const setShow = b => act(() => api("PATCH", "/api/show", b)).then(r => { if (r) app.state.show = r; dock(); markPlaying(); thumbs.refresh(); }).catch(() => {});
  const setPref = (id, v) => { const cur = prefs()[id] || 0, nx = cur === v ? 0 : v;
    return act(() => api("PATCH", `/api/effects/${id}`, { pref: nx })).then(() => { const p = app.state.settings.effectPrefs ||= {}; if (nx) p[id] = nx; else delete p[id]; markPrefs(); if (adjust?.id === id) adjust.sync();
      if (filter === "liked" || filter === "hidden") allGrid(); toast(nx === 1 ? "Liked: automatic mode picks it more often" : nx === -1 ? "Hidden: automatic mode won't pick it" : "Back to normal"); }).catch(() => {}); };

  root.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b || !root.contains(b)) return;
    if (b.dataset.play) play(b.dataset.play);
    else if (b.dataset.like) setPref(b.dataset.like, 1);
    else if (b.dataset.ban) setPref(b.dataset.ban, -1);
    else if (b.dataset.adjust) openAdjust(b.dataset.adjust, b);
    else if (b.dataset.filter) { filter = b.dataset.filter; allGrid(); }
    else if (b.id === "lk-clear") { filter = "all"; q = ""; $("#lk-q", root).value = ""; allGrid(); }
  });
  root.addEventListener("pointerover", e => { const c = e.target.closest?.(".lk-card"); thumbs.hover(c ? c.querySelector("[data-thumb]") : null); });
  root.addEventListener("pointerleave", () => thumbs.hover(null));
  let qt = 0; $("#lk-q", root).oninput = e => { clearTimeout(qt); qt = setTimeout(() => { q = e.target.value.trim().toLowerCase(); allGrid(); }, 120); };

  // ---------------------------------------------------------------- saved looks (scenes)
  const showName = sc => sc.show?.mode === "manual" ? (byId(sc.show.effect)?.name || sc.show.effect || "One effect") : `Automatic${sc.show?.style && sc.show.style !== "auto" ? ", " + String(st().styles[sc.show.style] || sc.show.style).split(" / ")[0] : ""}`;
  const swatch = name => { const c = thumbs.paletteHex(name || "auto"); if (!c) return "linear-gradient(110deg, var(--accent), var(--drop))";
    return c.length > 2 ? `linear-gradient(110deg, ${c.join(", ")})` : `linear-gradient(110deg, ${c[0]}, ${c[1]})`; };
  const isOn = sc => { const a = sc.show || {}, b = show(); return a.mode === b.mode && (a.mode !== "manual" || a.effect === b.effect) && (a.style ?? "auto") === (b.style ?? "auto") && (a.palette ?? "auto") === (b.palette ?? "auto"); };
  function scenes() {
    const list = st().scenes || [];
    $("#lk-scenes", root).innerHTML = list.map(sc => `<article class="lk-scene${isOn(sc) ? " is-on" : ""}">
        <button class="lk-scene-main" type="button" data-apply="${esc(sc.id)}" aria-label="Apply ${esc(sc.name)}"${canScenes ? "" : " disabled"}>
          <span class="lk-swatch" style="background:${swatch(sc.show?.palette)}"></span>
          <span class="lk-scene-txt"><b>${esc(sc.name)}</b><span>${esc(showName(sc))} · ${Math.round((sc.brightness ?? 1) * 100)}%</span></span>
          <span class="lk-badge is-on">On now</span></button>
        <div class="lk-scene-ctl"><button class="lk-ib" type="button" data-menu="${esc(sc.id)}" aria-label="More for ${esc(sc.name)}: rename, update, delete" title="Rename, update or delete"${canScenes ? "" : " disabled"}>${icon("dots")}</button></div></article>`).join("") || `<div class="lk-empty"><p>No saved looks yet. Save the one playing now to come back to it in one tap.</p></div>`;
  }
  const reScenes = () => api("GET", "/api/scenes").then(l => { app.state.scenes = l; scenes(); }).catch(() => {});
  $("#lk-scenes", root).addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return; const sc = (st().scenes || []).find(s => s.id === (b.dataset.apply || b.dataset.menu)); if (!sc) return;
    if (b.dataset.menu) sceneMenu(sc, b);
    else if (b.dataset.apply) { const r = await act(() => api("POST", `/api/scenes/${sc.id}/apply`), `${sc.name} is on`).catch(() => null); if (r) { app.state.show = r; scenes(); dock(); markPlaying(); thumbs.refresh(); } }
  });
  function sceneMenu(sc, from) {
    const body = document.createElement("div"); body.className = "lk-menu";
    body.innerHTML = `<button type="button" data-m="apply">${icon("play")}<span>Apply it now<small>${esc(showName(sc))} · ${Math.round((sc.brightness ?? 1) * 100)}% brightness</small></span></button>
      <button type="button" data-m="ren">${icon("pencil")}<span>Rename</span></button>
      <button type="button" data-m="upd">${icon("sync")}<span>Update to the current look<small>Saves what is playing now under this name</small></span></button>
      <button type="button" data-m="del" class="is-bad">${icon("trash")}<span>Delete</span></button>`;
    const s = sheet({ title: sc.name, body });
    body.addEventListener("click", async e => { const b = e.target.closest("button[data-m]"); if (!b) return; const m = b.dataset.m; s.close();
      if (m === "apply") from.closest(".lk-scene")?.querySelector("[data-apply]")?.click();
      else if (m === "ren") askName({ title: "Rename this look", value: sc.name, button: "Save the name" }, name => act(() => api("PUT", `/api/scenes/${sc.id}`, { name })).then(reScenes));
      else if (m === "upd") { const sh = show(); await act(() => api("PUT", `/api/scenes/${sc.id}`, { show: { mode: sh.mode, effect: sh.effect, style: sh.style, palette: sh.palette, everyBeats: sh.everyBeats, variety: sh.variety, speed: sh.speed, params: JSON.parse(JSON.stringify(sh.params || {})), layer: sh.layer || null }, brightness: app.state.settings.brightness }), `${sc.name} updated`).catch(() => {}); reScenes(); }
      else if (m === "del") { if (confirm(`Delete the saved look "${sc.name}"?`)) { await act(() => api("DELETE", `/api/scenes/${sc.id}`), "Deleted").catch(() => {}); reScenes(); } } });
  }
  $("#lk-save", root).onclick = () => { const sh = show(), base = sh.mode === "manual" ? byId(sh.effect)?.name || "My look" : `Automatic ${st().styles[sh.style] || ""}`.trim();
    askName({ title: "Save this look", value: base, button: "Save the look", help: "Saves the effect (or automatic mode), the colours, the music style and the brightness." }, name => act(() => api("POST", "/api/scenes", { name }), "Look saved").then(reScenes)); };

  // ---------------------------------------------------------------- the sticky "How it chooses" bar
  function dock() {
    const sh = show(), manual = sh.mode === "manual", cur = app.status?.effect || sh.effect, nm = byId(manual ? sh.effect : cur)?.name || app.status?.effectName || "";
    const opts = `<div class="lk-field"><span class="lk-lbl">Variety</span>${segmented("variety", VARIETY.map(([value, label]) => ({ value, label })), sh.variety || "one", { label: "Variety" })}</div>
      <label class="lk-field"><span class="lk-lbl">Colours</span><select data-set="palette"${canFx ? "" : " disabled"}>${st().palettes.map(p => `<option value="${esc(p)}"${p === sh.palette ? " selected" : ""}>${p === "auto" ? "Automatic" : esc(cap(p))}</option>`).join("")}</select></label>
      <label class="lk-field"><span class="lk-lbl">Music style</span><select data-set="style"${canFx ? "" : " disabled"}>${Object.entries({ auto: "Automatic", ...st().styles }).map(([k, v]) => `<option value="${esc(k)}"${k === sh.style ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`;
    const d = $("#lk-dock", root); d.classList.toggle("is-manual", manual);
    d.innerHTML = `<div class="lk-dock-in">
      <div class="lk-mode">${segmented("mode", [{ value: "auto", label: "Automatic" }, { value: "manual", label: "One effect" }], manual ? "manual" : "auto", { label: "How it chooses" })}</div>
      <div class="lk-now" aria-live="polite"><span class="lk-dot"></span><span>${manual ? `Playing <b>${esc(nm)}</b>` : nm ? `Showing <b>${esc(nm)}</b>` : "Picks a look for each song"}</span></div>
      ${manual ? `<button class="btn primary sm lk-back" type="button" data-mode="auto"${canFx ? "" : " disabled"}>${icon("back")}Back to automatic</button>` : ""}
      <div class="lk-opts${manual ? " is-manual" : ""}">${opts}</div>
      <button class="btn sm lk-more" type="button" data-more="1" aria-label="How it chooses: variety, colours and music style">${icon("adjust")}<span>Options</span></button>
    </div>`;
    segTidy(d);
  }
  // the shell's segmented controls: tooltips for Variety, disabled when locked
  function segTidy(r) { for (const b of r.querySelectorAll('[data-seg="variety"] [data-v]')) b.title = VARIETY_HELP[b.dataset.v]; if (!canFx) for (const b of r.querySelectorAll("[data-seg] [data-v]")) b.disabled = true; }
  const segPick = b => { const g = b.closest("[data-seg]")?.dataset.seg, v = b.dataset.v; if (b.getAttribute("aria-checked") === "true") return null;
    if (g === "mode") return v === "auto" ? setShow({ mode: "auto" }) : setShow({ mode: "manual", effect: app.status?.effect || show().effect });
    if (g === "variety") return setShow({ variety: v }); return null; };
  $("#lk-dock", root).addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return;
    if (b.closest("[data-seg]") && b.dataset.v) segPick(b);
    else if (b.dataset.mode === "auto") setShow({ mode: "auto" });
    else if (b.dataset.more) openOptions(); });
  $("#lk-dock", root).addEventListener("change", e => { const s = e.target.closest("select[data-set]"); if (s) setShow({ [s.dataset.set]: s.value }); });
  function openOptions() { // phone: the bar's options in a sheet
    const body = document.createElement("div"); body.className = "lk-sheet-opts"; const paint = () => { const manual = show().mode === "manual";
      body.innerHTML = `<div class="lk-field is-block"><span class="lk-lbl">Mode</span>${segmented("mode", [{ value: "auto", label: "Automatic" }, { value: "manual", label: "One effect" }], manual ? "manual" : "auto", { label: "How it chooses" })}</div>` + ($("#lk-dock .lk-opts", root)?.innerHTML || ""); body.querySelectorAll(".lk-field").forEach(f => f.classList.add("is-block")); body.querySelectorAll(".ui-seg").forEach(g => g.classList.add("full")); segTidy(body); };
    paint();
    body.addEventListener("click", e => { const b = e.target.closest("[data-seg] [data-v]"); if (b) Promise.resolve(segPick(b)).then(paint); });
    body.addEventListener("change", e => { const s = e.target.closest("select[data-set]"); if (s) setShow({ [s.dataset.set]: s.value }).then(paint); });
    sheet({ title: "How it chooses", body });
  }

  // ---------------------------------------------------------------- Adjust: one effect's settings in a side sheet
  function openAdjust(id, from) {
    const e = byId(id); if (!e) return; adjust?.close();
    const body = document.createElement("div"); body.className = "lk-adj";
    const cur = () => ({ ...{ speed: 1, intensity: 1, hue: 0, saturation: 1, mirror: false }, ...((show().params || {})[id] || {}), ...(live[id] || {}) });
    const c = cur();
    body.innerHTML = `<div class="lk-adj-stage"><span class="ui-thumb lk-thumb" data-thumb="${esc(id)}"></span></div>
      <div class="lk-adj-acts"><button class="btn primary" type="button" data-a="play"${canFx ? "" : " disabled"}>Play ${esc(e.name)} now</button>
        <button class="lk-ib lk-ib-lg" type="button" data-a="like" aria-label="Like ${esc(e.name)}" title="Like: automatic mode picks it more often"${canFx ? "" : " disabled"}>${icon("heart")}</button>
        <button class="lk-ib lk-ib-lg" type="button" data-a="ban" aria-label="Hide ${esc(e.name)}" title="Hide: automatic mode never picks it"${canFx ? "" : " disabled"}>${icon("ban")}</button></div>
      <p class="lk-adj-meta">${esc(e.custom ? "Your own effect" : TAG[e.tag] || e.tag)}${topPick(id) ? " · a top pick in automatic mode" : ""}</p>
      <div class="lk-sliders">${P.map(([k, label, min, max, step, , format]) => bigSlider(`lk-p-${k}`, label, c[k], { min, max, step, format })).join("")}</div>
      ${toggle("lk-p-mirror", "Mirror left and right", !!c.mirror, { hint: "The right side copies the left" })}
      <p class="lk-help">Settings are kept for this effect and saved with your looks.</p>
      <button class="btn" type="button" data-a="reset"${canFx ? "" : " disabled"}>Reset to default</button>`;
    const t = body.querySelector("[data-thumb]"); let pt = 0;
    const send = () => { clearTimeout(pt); pt = setTimeout(() => { const b = cur();
      api("PATCH", `/api/effects/${id}`, { params: b }).then(r => { const ps = app.state.show.params ||= {}; if (r.params) ps[id] = r.params; else delete ps[id]; delete live[id]; markPrefs(); }).catch(err => toast(err.message, true)); }, 140); };
    const sliders = Object.fromEntries(P.map(([k]) => [k, bindBigSlider(body, `lk-p-${k}`, { onInput: v => { live[id] = { ...cur(), [k]: v }; thumbs.refresh(); send(); } })]));
    const mirrorT = bindToggle(body, "lk-p-mirror", v => { live[id] = { ...cur(), mirror: v }; thumbs.refresh(); send(); });
    if (!canFx) body.querySelectorAll("input, .switch").forEach(x => x.disabled = true);
    body.addEventListener("click", ev => { const b = ev.target.closest("button"); if (!b) return;
      if (b.dataset.a === "play") play(id);
      else if (b.dataset.a === "like") setPref(id, 1);
      else if (b.dataset.a === "ban") setPref(id, -1);
      else if (b.dataset.a === "reset") { delete live[id]; act(() => api("PATCH", `/api/effects/${id}`, { params: null }), "Back to the default settings").then(() => { if (app.state.show.params) delete app.state.show.params[id];
        const d = cur(); for (const [k] of P) sliders[k].set(d[k]); mirrorT.set(!!d.mirror); thumbs.refresh(); markPrefs(); }).catch(() => {}); } });
    const sync = () => { const v = prefs()[id] || 0; body.querySelector('[data-a="like"]').setAttribute("aria-pressed", v === 1); body.querySelector('[data-a="ban"]').setAttribute("aria-pressed", v === -1); };
    sync();
    const s = sheet({ title: e.name, body, onClose: () => { thumbs.detach(t); if (adjust?.id === id) adjust = null; from?.focus?.(); } });
    thumbs.attach(t, id); thumbs.hover(t);
    adjust = { id, sync, close: () => s.close() };
  }

  // ---------------------------------------------------------------- small sheets
  function askName({ title, value, button, help }, done) {
    const body = document.createElement("form"); body.className = "lk-name-form";
    body.innerHTML = `<label class="lk-field is-block"><span class="lk-lbl">Name</span><input name="n" maxlength="60" required autocomplete="off" value="${esc(value)}"></label>${help ? `<p class="lk-help">${esc(help)}</p>` : ""}<button class="btn primary" type="submit">${esc(button)}</button>`;
    const s = sheet({ title, body });
    body.onsubmit = ev => { ev.preventDefault(); const n = body.n.value.trim(); if (!n) return; s.close(); Promise.resolve(done(n)).catch(() => {}); };
    setTimeout(() => { body.n.focus(); body.n.select(); }, 60);
  }

  // ---------------------------------------------------------------- start
  dock(); scenes(); sections(); allGrid();
  ratingsP.then(m => { if (m?.AUTO && alive) { AUTO = m.AUTO; sections(); allGrid(); } });
  thumbs.ready.then(() => { if (alive) scenes(); }).catch(() => {});
  if (effects().some(e => e.custom)) api("GET", "/api/custom-effects").then(l => { customs = l; thumbs.setCustom(customs); }).catch(() => {});
  return {
    destroy() { alive = false; adjust?.close(); thumbs.destroy(); },
    onStatus(m) { if (m.effect !== lastFx || show().mode !== lastMode) { lastFx = m.effect; lastMode = show().mode; markPlaying(); dock(); } },
    onChanged(w) { if (!alive) return;
      if (w.has("scenes") || w.has("all")) scenes();
      if (w.has("show") || w.has("settings") || w.has("all")) { dock(); markPrefs(); markPlaying(); scenes(); thumbs.refresh(); }
      if (w.has("effects") || w.has("all")) { api("GET", "/api/custom-effects").then(l => { customs = l; thumbs.setCustom(customs); }).catch(() => {}); sections(); allGrid(); } },
  };
}

const sheet = o => openSheet(o);
