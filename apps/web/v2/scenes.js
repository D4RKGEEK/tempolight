// Schedules and scenes (dashboard v2, #/schedules): "When do the lights change by themselves?"
// Saved looks are made and browsed on the Looks screen; this screen is about when. At the top, the day as a 24-hour
// strip: each schedule is a mark at its time and the block after it shows what the room is set to until the next one
// (a scene in its colours, lights off, lights on, a brightness), with night mode as a band and a line for now. Under
// it the schedules as rows (time, days, what happens, next run, an on/off switch); a row opens the edit sheet (name,
// a time or sunrise/sunset with minutes before or after, days, what to apply). Last, the scenes as a compact list with
// Apply, Rename (with "Use the current look") and Delete. Everything the v1 page (app.js scenesPage) did is here.
import { app, api, act, toast, esc, $, $$, refreshState, guestOk, unlocked } from "/app.js";
import { ensureCss, icon, openSheet, segmented, bindSegmented, bigSlider, bindBigSlider, emptyState } from "/v2/shell.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// the engine's palette colours (packages/engine/src/effects.js PALSETS), for the strip's scene blocks
const PAL = { neon: ["#ff2bd6", "#16e0ff"], sunset: ["#ff5e3a", "#ffb648"], ocean: ["#0a6cff", "#00e5d0"], fire: ["#ff3d00", "#ffc400"], ice: ["#7cc8ff", "#e8f6ff"],
  forest: ["#19c37d", "#c6ff3d"], mono: ["#ffe2b8", "#fff4e6"], mood: ["#ff8a1f", "#7b2fff"], auto: ["#ff8a1f", "#ff4f8b"] };
const STYLE_PAL = { party: ["#ff2bd6", "#ff8a1f"], chill: ["#5b8cff", "#20ffa8"] };
const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true" class="ui-ic">${d}</svg>`;
const I = { sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'), trash: svg('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>'), play: icon("play") };

const isSun = t => /^sun(rise|set)/.test(t || "");
const sunParts = t => { const m = /^(sunrise|sunset)([+-]\d+)?$/.exec(t || ""); return m ? { kind: m[1], off: Number(m[2] || 0) } : null; };
const offWords = o => !o ? "" : o > 0 ? `${o} min after` : `${-o} min before`;
const timeText = t => { const p = sunParts(t); if (!p) return t; const n = p.kind === "sunrise" ? "Sunrise" : "Sunset"; return p.off ? `${n} ${p.off > 0 ? "+" : "−"}${Math.abs(p.off)} min` : n; };
const daysText = d => { const s = [...d].sort().join(""); return s === "0123456" ? "Every day" : s === "12345" ? "Weekdays" : s === "06" ? "Weekends" : [...d].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(x => DAYS[x]).join(" "); };
const hm = m => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;

export function render(el) {
  ensureCss("/v2/scenes.css");
  el.innerHTML = `<div class="ui-screen sc2 span-12" id="sc2"></div>`;
  const root = $("#sc2", el), today = new Date().getDay();
  let day = today, gone = false, tick = null;
  const st = () => app.state, admin = () => unlocked(), canScenes = () => guestOk("scenes");
  const sceneOf = id => st().scenes.find(s => s.id === id);
  const actName = a => a.type === "scene" ? (sceneOf(a.scene)?.name || "A deleted scene") : a.type === "on" ? "Lights on" : a.type === "off" ? "Lights off" : `Brightness ${Math.round(a.value * 100)}%`;
  const showName = sc => sc.show?.mode === "manual" ? (st().effects.find(e => e.id === sc.show.effect)?.name || sc.show.effect) : `Automatic${sc.show?.style && sc.show.style !== "auto" ? ", " + (st().styles[sc.show.style] || sc.show.style) : ""}`;
  const colsOf = sc => !sc ? ["#5a534b", "#3a342e"] : (sc.show?.palette && sc.show.palette !== "auto" && PAL[sc.show.palette]) || STYLE_PAL[sc.show?.style] || PAL.auto;

  // minutes after midnight a schedule runs (sunrise/sunset: from its next run, as this browser's clock shows it)
  function minuteOf(s) {
    if (!isSun(s.time)) { const [h, m] = s.time.split(":").map(Number); return h * 60 + m; }
    if (!s.next) return null; const d = new Date(s.next); return d.getHours() * 60 + d.getMinutes();
  }
  // what each block of the chosen day shows: [{from, to, action, s}] plus the events (marks)
  function dayPlan(d) {
    const on = st().schedules.filter(s => s.enabled !== false).map(s => ({ s, m: minuteOf(s) })).filter(x => x.m != null);
    const ev = on.filter(x => x.s.days.includes(d)).sort((a, b) => a.m - b.m);
    let carry = null; // the last thing that ran before this day began (looking back up to a week)
    for (let k = 1; k <= 7 && !carry; k++) { const pd = (d - k + 7) % 7, list = on.filter(x => x.s.days.includes(pd)).sort((a, b) => b.m - a.m); if (list.length) carry = list[0].s; }
    const blocks = []; let at = 0, cur = carry;
    for (const x of ev) { if (x.m > at) blocks.push({ from: at, to: x.m, s: cur }); at = x.m; cur = x.s; }
    blocks.push({ from: at, to: 1440, s: cur });
    return { blocks: blocks.filter(b => b.to > b.from), ev };
  }
  function blockStyle(s) {
    if (!s) return { cls: "none", style: "" };
    const a = s.action;
    if (a.type === "off") return { cls: "off", style: "" };
    if (a.type === "on") return { cls: "on", style: "" };
    if (a.type === "brightness") return { cls: "bri", style: `--a:${Math.max(0.12, a.value)}` };
    const [c1, c2] = colsOf(sceneOf(a.scene)); return { cls: "scene", style: `--c1:${c1};--c2:${c2}` };
  }
  const nightBand = () => { const n = st().settings.night; if (!n?.enabled) return null; const p = t => /^\d\d:\d\d$/.test(t) ? t.split(":").map(Number).reduce((h, m) => h * 60 + m) : null;
    const a = p(n.from), b = p(n.to); if (a == null || b == null) return { label: `Night mode, ${n.from} to ${n.to}`, parts: [] };
    return { label: `Night mode ${n.from} to ${n.to}`, parts: a < b ? [[a, b]] : [[a, 1440], [0, b]] }; };

  // ---------------------------------------------------------------- the page
  function build() {
    const S = st().schedules, locked = !admin();
    root.innerHTML = `
      <section class="ui-card sc-day" aria-labelledby="sc-day-h">
        <header class="sc-day-head"><div><h2 id="sc-day-h">${day === today ? "Today" : DAY_LONG[day]}</h2><p class="ui-meta" id="sc-day-sub"></p></div>
          <div class="sc-day-tools">${segmented("sc-dayseg", [1, 2, 3, 4, 5, 6, 0].map(i => ({ value: i, label: DAYS[i] })), day, { label: "Day" })}
          <button class="btn primary" id="sc-add" type="button"${locked ? " disabled" : ""}>${icon("plus")}Add a schedule</button></div></header>
        <div class="sc-strip-wrap"><div class="sc-strip" id="sc-strip" role="img"></div><div class="sc-hours" aria-hidden="true">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => `<span style="left:${h / 24 * 100}%">${String(h % 24).padStart(2, "0")}:00</span>`).join("")}</div></div>
        <div class="sc-legend" id="sc-legend"></div>
      </section>
      <section class="sc-sec" aria-labelledby="sc-h-sched">
        <header class="sc-sec-h"><div><h2 class="ui-h2" id="sc-h-sched">Schedules</h2><p class="ui-meta">Times are this server's local time (${esc(new Date().toTimeString().slice(9, 17))}).${locked ? ' Locked: <a href="#/settings2/pin">unlock in Settings</a> to change them.' : ""}</p></div></header>
        <div id="sc-list"></div>
      </section>
      <section class="sc-sec" aria-labelledby="sc-h-scenes">
        <header class="sc-sec-h"><div><h2 class="ui-h2" id="sc-h-scenes">Scenes</h2><p class="ui-meta">A scene remembers the effect, style, colours and brightness. Browse and make them on <a href="#/looks">Looks</a>.</p></div>
          <button class="btn" id="sc-save" type="button"${canScenes() ? "" : " disabled"}>${icon("plus")}Save this look</button></header>
        <div id="sc-scenes"></div>
      </section>`;
    bindSegmented(root, "sc-dayseg", v => { day = Number(v); strip(); $("#sc-day-h", root).textContent = day === today ? "Today" : DAY_LONG[day]; });
    $("#sc-add", root).onclick = () => edit(null);
    $("#sc-save", root).onclick = saveScene;
    strip(); list(); scenes();
  }

  function strip() {
    const box = $("#sc-strip", root); if (!box) return;
    const { blocks, ev } = dayPlan(day), nb = nightBand(), now = new Date(), nowM = now.getHours() * 60 + now.getMinutes();
    const P = m => `${(m / 1440) * 100}%`;
    const gap = 1440 * 110 / Math.max(240, box.clientWidth || 1000); // minutes that ~110px of label need
    let lastTop = -1e9, lastLow = -1e9; for (const x of ev) { x.low = x.m - lastTop < gap; if (!x.low) lastTop = x.m; else lastLow = x.m;
      x.edge = x.m < gap / 2 ? " l" : x.m > 1440 - gap / 2 ? " r" : ""; } // close marks: the label goes under the strip
    box.parentElement.classList.toggle("has-low", ev.some(x => x.low));
    box.innerHTML = `<div class="sc-blocks">${blocks.map(b => { const k = blockStyle(b.s); return `<i class="sc-b ${k.cls}" style="left:${P(b.from)};width:${P(b.to - b.from)};${k.style}" title="${esc(b.s ? `${hm(b.from)} to ${hm(b.to)}: ${actName(b.s.action)}` : "No schedule")}"></i>`; }).join("")}</div>
      ${nb ? nb.parts.map(([a, b]) => `<i class="sc-night" style="left:${P(a)};width:${P(b - a)}" title="${esc(nb.label)}"></i>`).join("") : ""}
      ${ev.map(x => `<button class="sc-mark${x.low ? " low" : ""}${x.edge}" type="button" data-edit="${esc(x.s.id)}" style="left:${P(x.m)}" aria-label="${esc(`${timeText(x.s.time)}: ${x.s.name}`)}"><span><b>${esc(isSun(x.s.time) ? timeText(x.s.time).replace(" min", "") : x.s.time)}</b>${esc(x.s.name)}</span></button>`).join("")}
      ${day === today ? `<i class="sc-now" style="left:${P(nowM)}"><span>Now</span></i>` : ""}
      ${ev.length ? "" : `<p class="sc-strip-empty">${st().schedules.length ? `Nothing runs on ${DAY_LONG[day]}.` : "No schedules yet. Add one, for example a chill scene at 19:00 or lights off at 01:00."}</p>`}`;
    box.setAttribute("aria-label", ev.length ? `${DAY_LONG[day]}: ${ev.map(x => `${timeText(x.s.time)} ${actName(x.s.action)}`).join(", ")}` : `Nothing scheduled on ${DAY_LONG[day]}`);
    $$("[data-edit]", box).forEach(b => b.onclick = () => edit(st().schedules.find(s => s.id === b.dataset.edit)));
    const cur = blocks.find(b => nowM >= b.from && nowM < b.to);
    $("#sc-day-sub", root).textContent = ev.length ? `${ev.length} change${ev.length > 1 ? "s" : ""}${day === today && cur?.s ? `. Now: ${actName(cur.s.action)}` : ""}` : "Nothing changes by itself";
    // the legend: what the colours mean on this day
    const used = new Map(); for (const b of blocks) if (b.s) used.set(b.s.action.type === "scene" ? "s:" + b.s.action.scene : b.s.action.type, b.s);
    $("#sc-legend", root).innerHTML = [...used.values()].map(s => { const k = blockStyle(s); return `<span><i class="sc-sw ${k.cls}" style="${k.style}"></i>${esc(actName(s.action))}</span>`; }).join("")
      + (nb ? `<span><i class="sc-sw night"></i>${esc(nb.label)}</span>` : "");
  }

  function list() {
    const box = $("#sc-list", root); if (!box) return; const S = st().schedules, locked = !admin();
    if (!S.length) { box.innerHTML = `<div class="ui-card">${emptyState({ title: "No schedules yet", text: "Let the lights change by themselves: a chill scene every evening, lights off at night, a sunrise alarm.", action: locked ? "" : '<button class="btn primary" type="button" id="sc-add2">Add a schedule</button>' })}</div>`;
      const a = $("#sc-add2", box); if (a) a.onclick = () => edit(null); return; }
    const sorted = [...S].sort((a, b) => (minuteOf(a) ?? 9999) - (minuteOf(b) ?? 9999));
    box.innerHTML = `<div class="ui-list">${sorted.map(s => { const k = blockStyle(s), nx = s.next ? new Date(s.next).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
      return `<div class="ui-row sc-row${s.enabled === false ? " off" : ""}" data-id="${esc(s.id)}">
        <span class="sc-time"><b class="mono">${isSun(s.time) ? I.sun : ""}${esc(isSun(s.time) ? timeText(s.time) : s.time)}</b><small>${esc(daysText(s.days))}</small></span>
        <button class="sc-open" type="button" data-open="${esc(s.id)}"${locked ? " disabled" : ""}><i class="sc-sw ${k.cls}" style="${k.style}"></i><span class="ui-row-main"><b>${esc(s.name)}</b><small>${esc(actName(s.action))}${s.enabled !== false && nx ? ` · next ${esc(nx)}` : s.enabled === false ? " · off" : ""}</small></span></button>
        <span class="ui-row-act"><button class="btn sm" type="button" data-run="${esc(s.id)}"${locked ? " disabled" : ""}>${I.play}Run now</button>
          <button class="switch" type="button" role="switch" data-en="${esc(s.id)}" aria-checked="${s.enabled !== false}" aria-label="${esc(s.name)} on"${locked ? " disabled" : ""}></button></span></div>`; }).join("")}</div>`;
    $$("[data-open]", box).forEach(b => b.onclick = () => edit(st().schedules.find(s => s.id === b.dataset.open)));
    $$("[data-run]", box).forEach(b => b.onclick = () => act(() => api("POST", `/api/schedules/${b.dataset.run}/run`), "Done").catch(() => {}));
    $$("[data-en]", box).forEach(b => b.onclick = async () => { const v = b.getAttribute("aria-checked") !== "true"; b.setAttribute("aria-checked", v);
      await act(() => api("PUT", `/api/schedules/${b.dataset.en}`, { enabled: v }), v ? "Schedule on" : "Schedule off").catch(() => b.setAttribute("aria-checked", !v)); await refreshState(); strip(); list(); });
  }

  function scenes() {
    const box = $("#sc-scenes", root); if (!box) return; const L = st().scenes, ok = canScenes(), dis = ok ? "" : " disabled";
    if (!L.length) { box.innerHTML = `<div class="ui-card">${emptyState({ title: "No scenes yet", text: "Save the look the lights have now, then schedule it." })}</div>`; return; }
    box.innerHTML = `<div class="ui-list">${L.map(sc => { const [c1, c2] = colsOf(sc); return `<div class="ui-row sc-scene">
      <i class="sc-sw scene big" style="--c1:${c1};--c2:${c2}"></i>
      <span class="ui-row-main"><b>${esc(sc.name)}</b><small>${esc(showName(sc))} · ${esc(sc.show?.palette && sc.show.palette !== "auto" ? sc.show.palette : "automatic colours")} · ${Math.round((sc.brightness ?? 1) * 100)}%</small></span>
      <span class="ui-row-act"><button class="btn sm" type="button" data-apply="${esc(sc.id)}"${dis}>Apply</button><button class="btn sm" type="button" data-ren="${esc(sc.id)}"${dis}>Rename</button>
        <button class="ui-icbtn" type="button" data-del="${esc(sc.id)}" aria-label="Delete ${esc(sc.name)}"${dis}>${I.trash}</button></span></div>`; }).join("")}</div>`;
    $$("[data-apply]", box).forEach(b => b.onclick = () => act(() => api("POST", `/api/scenes/${b.dataset.apply}/apply`), `${sceneOf(b.dataset.apply)?.name || "Scene"} applied`).catch(() => {}));
    $$("[data-ren]", box).forEach(b => b.onclick = () => renameScene(sceneOf(b.dataset.ren)));
    $$("[data-del]", box).forEach(b => b.onclick = async () => { const sc = sceneOf(b.dataset.del); const used = st().schedules.filter(s => s.action.type === "scene" && s.action.scene === sc.id).length;
      if (!confirm(`Delete ${sc.name}?${used ? ` ${used} schedule${used > 1 ? "s use" : " uses"} it and will do nothing.` : ""}`)) return;
      await act(() => api("DELETE", `/api/scenes/${sc.id}`), "Scene deleted").catch(() => {}); await refreshState(); build(); });
  }

  // ---------------------------------------------------------------- sheets
  function saveScene() {
    const sh = openSheet({ title: "Save this look", body: `<label class="sc-field"><span>Name</span><input id="sc-sname" value="My scene" maxlength="60"></label>
      <p class="ui-meta">Keeps the effect, style, colours and brightness the lights have now.</p><div class="sc-sheet-act"><button class="btn primary" id="sc-sgo" type="button">Save the scene</button></div>` });
    const i = $("#sc-sname", sh.el); setTimeout(() => i.select(), 40);
    const go = async () => { const name = i.value.trim(); if (!name) return i.focus(); const r = await act(() => api("POST", "/api/scenes", { name }), "Scene saved").catch(() => null); if (r) { sh.close(); await refreshState(); build(); } };
    $("#sc-sgo", sh.el).onclick = go; i.onkeydown = e => { if (e.key === "Enter") go(); };
  }
  function renameScene(sc) {
    if (!sc) return;
    const sh = openSheet({ title: "Rename the scene", body: `<label class="sc-field"><span>Name</span><input id="sc-rname" value="${esc(sc.name)}" maxlength="60"></label>
      <div class="sc-sheet-act"><button class="btn primary" id="sc-rgo" type="button">Save the name</button></div>
      <div class="sc-sheet-more"><b>Use the current look</b><p class="ui-meta">Replace what ${esc(sc.name)} shows with the effect, colours and brightness the lights have now.</p><button class="btn" id="sc-rupd" type="button">Update to the current look</button></div>` });
    const i = $("#sc-rname", sh.el);
    const go = async () => { const name = i.value.trim(); if (!name) return i.focus(); await act(() => api("PUT", `/api/scenes/${sc.id}`, { name }), "Renamed").catch(() => {}); sh.close(); await refreshState(); build(); };
    $("#sc-rgo", sh.el).onclick = go; i.onkeydown = e => { if (e.key === "Enter") go(); };
    $("#sc-rupd", sh.el).onclick = async () => { const s = app.state.show;
      await act(() => api("PUT", `/api/scenes/${sc.id}`, { show: { mode: s.mode, effect: s.effect, style: s.style, palette: s.palette, everyBeats: s.everyBeats, variety: s.variety, speed: s.speed, params: JSON.parse(JSON.stringify(s.params || {})), layer: s.layer || null }, brightness: app.state.settings.brightness }), "Scene updated").catch(() => {});
      sh.close(); await refreshState(); build(); };
  }

  function edit(s) {
    if (!admin()) return toast("Schedules are locked. Unlock in Settings to change them.", true);
    const isNew = !s, sp = s ? sunParts(s.time) : null, S = st();
    let kind = sp ? sp.kind : "time", off = sp ? sp.off : 0, days = new Set(s ? s.days : [0, 1, 2, 3, 4, 5, 6]);
    let what = s ? (s.action.type === "scene" ? "scene" : s.action.type) : (S.scenes.length ? "scene" : "on");
    const bri = s?.action.type === "brightness" ? Math.round(s.action.value * 100) : 50;
    const noLoc = !S.settings.location;
    const body = `
      <label class="sc-field"><span>Name</span><input id="se-name" maxlength="60" value="${esc(s?.name || "")}" placeholder="Evening"></label>
      <div class="sc-field"><span>When</span>${segmented("se-kind", [{ value: "time", label: "At a time" }, { value: "sunrise", label: "Sunrise" }, { value: "sunset", label: "Sunset" }], kind, { label: "When" })}
        <input type="time" id="se-time" class="sc-bigtime" value="${s && !sp ? esc(s.time) : "19:00"}" aria-label="Time"${kind === "time" ? "" : " hidden"}>
        <div id="se-sun"${kind === "time" ? " hidden" : ""}>${bigSlider("se-off", "Offset", off, { min: -180, max: 180, step: 5, format: v => v === 0 ? "At the moment" : offWords(v) })}
          ${noLoc ? '<p class="sc-warn">Set your location first, so Tempolight knows when the sun rises and sets. <a href="#/settings2/location">Set the location</a></p>' : ""}</div></div>
      <div class="sc-field"><span>Days</span><div class="sc-days" id="se-days">${[1, 2, 3, 4, 5, 6, 0].map(i => `<button type="button" data-d="${i}" aria-pressed="${days.has(i)}" aria-label="${DAY_LONG[i]}">${DAYS[i].slice(0, 2)}</button>`).join("")}</div>
        <div class="sc-quick"><button type="button" class="btn sm" data-q="0123456">Every day</button><button type="button" class="btn sm" data-q="12345">Weekdays</button><button type="button" class="btn sm" data-q="06">Weekends</button></div></div>
      <div class="sc-field"><span>What happens</span><div class="sc-what" role="radiogroup" aria-label="What happens">
        ${[["scene", "Apply a scene", S.scenes.length ? "" : "Save a scene on Looks first"], ["on", "Lights on", ""], ["off", "Lights off", ""], ["brightness", "Set the brightness", ""]].map(([v, l, h]) =>
          `<button type="button" role="radio" class="sc-whatb" data-w="${v}" aria-checked="${what === v}"${v === "scene" && !S.scenes.length ? " disabled" : ""}><b>${l}</b>${h ? `<small>${h}</small>` : ""}</button>`).join("")}</div>
        <select id="se-scene" aria-label="Scene"${what === "scene" ? "" : " hidden"}>${S.scenes.map(x => `<option value="${esc(x.id)}"${s?.action.scene === x.id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
        <div id="se-bri"${what === "brightness" ? "" : " hidden"}>${bigSlider("se-briv", "Brightness", bri, { min: 5, max: 100, step: 5, format: v => v + "%" })}</div></div>
      <div class="sc-sheet-act"><button class="btn primary" id="se-save" type="button">${isNew ? "Add the schedule" : "Save the schedule"}</button>${isNew ? "" : '<button class="btn" id="se-run" type="button">Run it now</button><button class="btn danger" id="se-del" type="button">Delete</button>'}</div>`;
    const sh = openSheet({ title: isNew ? "Add a schedule" : s.name, body }), E = sh.el, q = id => E.querySelector("#" + id);
    bindSegmented(E, "se-kind", v => { kind = v; q("se-time").hidden = v !== "time"; q("se-sun").hidden = v === "time"; });
    bindBigSlider(E, "se-off", { onInput: v => { off = v; } }); bindBigSlider(E, "se-briv", {});
    const paintDays = () => $$("[data-d]", E).forEach(b => b.setAttribute("aria-pressed", days.has(Number(b.dataset.d))));
    $$("[data-d]", E).forEach(b => b.onclick = () => { const d = Number(b.dataset.d); days.has(d) ? days.delete(d) : days.add(d); paintDays(); });
    $$("[data-q]", E).forEach(b => b.onclick = () => { days = new Set([...b.dataset.q].map(Number)); paintDays(); });
    $$("[data-w]", E).forEach(b => b.onclick = () => { what = b.dataset.w; $$("[data-w]", E).forEach(x => x.setAttribute("aria-checked", x === b)); q("se-scene").hidden = what !== "scene"; q("se-bri").hidden = what !== "brightness"; });
    q("se-save").onclick = async () => {
      if (!days.size) return toast("Pick at least one day", true);
      const action = what === "scene" ? { type: "scene", scene: q("se-scene").value } : what === "brightness" ? { type: "brightness", value: Number(q("se-briv").value) / 100 } : { type: what };
      const time = kind === "time" ? q("se-time").value : kind + (off ? (off > 0 ? "+" : "") + off : "");
      const body = { name: q("se-name").value.trim() || (kind === "time" ? `${actName(action)} at ${time}` : `${actName(action)} at ${kind}`), time, days: [...days].sort(), action };
      const r = await act(() => isNew ? api("POST", "/api/schedules", body) : api("PUT", `/api/schedules/${s.id}`, body), isNew ? "Schedule added" : "Schedule saved").catch(() => null);
      if (!r) return; sh.close(); await refreshState(); strip(); list();
    };
    if (!isNew) {
      q("se-run").onclick = () => act(() => api("POST", `/api/schedules/${s.id}/run`), "Done").catch(() => {});
      q("se-del").onclick = async () => { if (!confirm(`Delete the schedule ${s.name}?`)) return; await act(() => api("DELETE", `/api/schedules/${s.id}`), "Schedule deleted").catch(() => {}); sh.close(); await refreshState(); strip(); list(); };
    }
  }

  build();
  tick = setInterval(() => { if (!gone && day === today && !document.hidden) strip(); }, 60000);
  return {
    destroy() { gone = true; clearInterval(tick); },
    onChanged(w) { if (gone) return; if (w.has("scenes") || w.has("lock") || w.has("all")) build(); else if (w.has("schedules") || w.has("settings")) { strip(); list(); } },
  };
}
