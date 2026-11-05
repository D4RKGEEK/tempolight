// Home & sleep page: the sunrise alarm (wake-up), the sleep timer (wind-down) and the ambient plan for the day.
// The small strip on the Home page is in homestrip.js, so the Home page doesn't need to load this page.
import { app, api, act, toast, esc, panel, opt, $, $$, unlocked, guestOk, DEMO, guestUrl } from "/app.js";
import { hm, when, mins, nowText } from "/homestrip.js";
export { homeStrip, bindHomeStrip, updateHomeStrip } from "/homestrip.js"; // the strip on the Home page lives on its own (loaded with the Home page)

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first on screen; stored Sunday first, like Date.getDay()
const DOCS = "https://github.com/D4RKGEEK/tempolight/blob/main/docs/wake-up.md";

let styled = false;
function style() { if (styled) return; styled = true; const s = document.createElement("style"); s.textContent = `
.hs-now { display: grid; gap: 14px; }
.hs-line { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 15px; }
.hs-line b { font-weight: 600; }
.hs-sun { width: 40px; height: 40px; border-radius: 50%; flex: none; background: var(--sunk); box-shadow: var(--ring); transition: background 1s linear, box-shadow 1s linear; }
.hs-bar { height: 8px; border-radius: var(--r-pill); background: var(--sunk); box-shadow: var(--ring); overflow: hidden; flex: 1 1 120px; min-width: 80px; }
.hs-bar i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #5a0600, #ff4a10, #ffb060, #ffe6c8); }
.hs-days { display: grid; grid-template-columns: repeat(auto-fill, minmax(124px, 1fr)); gap: 8px; }
.hs-days label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-2); min-width: 0; }
.hs-days input { padding: 6px 8px !important; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.hs-col { width: 44px; height: 34px; padding: 3px; border: 0; border-radius: var(--r-field); flex: none; background: var(--sunk); box-shadow: var(--ring); }
.hs-seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 13px; background: var(--sunk); box-shadow: var(--ring); }
.hs-seg button { border: 0; background: none; color: var(--text-2); padding: 6px 14px; border-radius: 10px; font-size: 13.5px; font-weight: 500; cursor: pointer; transition: background var(--t-out) var(--ease), color var(--t-out) var(--ease); }
.hs-seg button:hover { color: var(--text); }
.hs-seg button[aria-pressed="true"] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-card); }
.hs-url { font: 12.5px var(--mono); word-break: break-all; background: var(--sunk); box-shadow: var(--ring); border-radius: var(--r-field); padding: 8px 12px; }
.hs-plan td { white-space: nowrap; } .hs-plan td input[type=time], .hs-plan td input[data-k=from], .hs-plan td input[data-k=to] { width: 124px; font-family: var(--mono); } .hs-plan td input[type=range] { width: 90px; vertical-align: middle; }
@media (max-width: 820px) { .hs-days { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (prefers-reduced-motion: reduce) { .hs-sun, .hs-seg button { transition: none; } }`; document.head.appendChild(s); }

function sunCss(p) { // the dot shows the sunrise's colour at progress p
  const c = p < 0.25 ? "#5a0600" : p < 0.5 ? "#ff3a08" : p < 0.75 ? "#ff8c30" : p < 0.95 ? "#ffbf70" : "#ffe2c0"; return `background:${c};box-shadow:0 0 ${Math.round(4 + p * 18)}px ${c}`; }

// ---------------------------------------------------------------- the page
export function homeSleepPage(el) {
  style();
  const admin = unlocked(), canUse = guestOk("brightness"), st = app.state;
  let H = null; // GET /api/home
  el.innerHTML = `<div class="callout span-12 faint" id="hs-wait">Loading…</div>`;
  const load = async () => { H = await api("GET", "/api/home"); render(); };
  const save = (body, ok) => act(() => api("PUT", "/api/home", body), ok).then(r => { H = r; }).catch(() => load().catch(() => {}));
  const dis = admin ? "" : " disabled";

  function render() {
    const w = H.wake, p = H.plan, zones = st.room.zones || [], targets = [["all", "The whole room"], ...zones.map(z => ["zone:" + z.id, "Zone: " + z.name]), ...st.devices.map(d => ["dev:" + d.id, "Only " + d.name])];
    const looks = [["white", "Soft white"], ["night", "Night mode"], ...st.effects.filter(e => e.tag === "calm" || e.tag === "home").map(e => [e.id, e.name])];
    const pals = st.palettes.map(x => [x, x === "auto" ? "Automatic" : x[0].toUpperCase() + x.slice(1)]);
    const kel = [["", "Effect's own"], ["2200", "2200 K candle"], ["2400", "2400 K"], ["2700", "2700 K warm"], ["3000", "3000 K"], ["4000", "4000 K neutral"], ["5000", "5000 K cool"], ["6500", "6500 K daylight"]];
    const sel = (list, v, attrs) => `<select ${attrs}${dis}>${list.map(([k, n]) => opt(k, n, String(k) === String(v ?? ""))).join("")}${list.some(([k]) => String(k) === String(v ?? "")) ? "" : (v ? opt(v, attrs.includes("kelvin") ? v + " K" : v, true) : "")}</select>`;
    el.innerHTML = `
    ${panel("Right now", "", "", `<div class="pb hs-now">
      <div class="hs-line"><span class="hs-sun" id="hs-dot"></span><span id="hs-now">–</span><span class="hs-bar" id="hs-barw" hidden><i id="hs-bar" style="width:0"></i></span></div>
      <div class="row">
        <div class="hs-seg" role="group" aria-label="Sleep timer length">${[15, 30, 45, 60].map(n => `<button type="button" data-min="${n}" aria-pressed="${n === H.sleep.minutes}">${n}</button>`).join("")}</div>
        <button class="btn primary" id="hs-go" type="button"${canUse ? "" : " disabled"}>Sleep in ${H.sleep.minutes} min</button>
        <button class="btn" id="hs-cancel" type="button" hidden>Cancel sleep timer</button>
        <button class="btn" id="hs-wnow" type="button"${canUse && w.enabled ? "" : " disabled"} title="${w.enabled ? "A sunrise of the length set below, from now" : "Turn wake-up on below first"}">Sunrise now</button>
        <button class="btn" id="hs-snooze" type="button" hidden>Snooze ${w.snoozeMin} min</button><button class="btn" id="hs-stop" type="button" hidden>Stop sunrise</button>
        <button class="btn" id="hs-skip" type="button" hidden>Skip next wake-up</button>
      </div>
      <p class="faint" style="margin:0">The sleep timer slowly dims the lights, warmer and warmer, and turns them off at the end. Touching the brightness or the power switch cancels it.</p>
    </div>`, "span-12")}
    ${panel("Wake-up sunrise", w.enabled ? "On" : "Off", `<label class="check"><input type="checkbox" id="w-on" ${w.enabled ? "checked" : ""}${dis}> On</label>`, `<div class="pb stack">
      <div class="row"><div class="hs-seg" role="group" aria-label="When to wake up"><button type="button" data-src="times" aria-pressed="${w.source === "times"}"${dis}>Set times</button><button type="button" data-src="phone" aria-pressed="${w.source === "phone"}"${dis}>Linked to my phone</button></div>
        <span class="faint">${w.source === "times" ? "The sunrise is at full light at these times. Leave a day empty for no alarm." : "Your phone's alarm starts the sunrise, through a Shortcut or Home Assistant (below)."}</span></div>
      ${w.source === "times" ? `<div class="hs-days">${ORDER.map(d => `<label>${DAYS[d].slice(0, 3)}<input type="time" data-day="${d}" value="${esc(w.days[d] || "")}"${dis}></label>`).join("")}</div>` : ""}
      <div class="controls">
        <div class="field"><label for="w-dur">Sunrise takes <output id="w-dur-o">${w.duration} min</output></label><input type="range" id="w-dur" min="10" max="40" step="5" value="${w.duration}"${dis}></div>
        <div class="field"><label for="w-tg">Lights</label>${sel(targets, w.target, 'id="w-tg"')}</div>
        <div class="field"><label for="w-col">End colour</label><div class="row" style="flex-wrap:nowrap"><input type="color" class="hs-col" id="w-col" value="${esc(w.endColor)}"${dis} aria-label="End colour">
          <button class="chip" type="button" data-col="#ffd2a1"${dis}>Warm white</button><button class="chip" type="button" data-col="#fff1e0"${dis}>Daylight</button></div></div>
        <div class="field"><label for="w-bri">End brightness <output id="w-bri-o">${Math.round(w.endBrightness * 100)}%</output></label><input type="range" id="w-bri" min="0.1" max="1" step="0.05" value="${w.endBrightness}"${dis}></div>
        <div class="field"><label for="w-hold">Stay on after <output id="w-hold-o">${w.holdMin} min</output></label><input type="range" id="w-hold" min="0" max="120" step="5" value="${w.holdMin}"${dis}><span class="help">Then back to the usual lights.</span></div>
        <div class="field"><label for="w-snz">Snooze <output id="w-snz-o">${w.snoozeMin} min</output></label><input type="range" id="w-snz" min="1" max="30" step="1" value="${w.snoozeMin}"${dis}></div>
      </div>
      <p class="faint" style="margin:0">It turns the lights on if they're off and covers whatever is playing, even in night mode; live pads (blackout) still work. Times are this server's clock (${new Date().toTimeString().slice(9, 17)}).</p>
    </div>`, "span-7")}
    ${panel("Link to your phone's alarm", "", "", `<div class="pb stack">
      ${DEMO ? `<p class="callout">In the online demo there's no server for a phone to call. On your own Tempolight it works like this:</p>` : ""}
      <p style="margin:0">Start the sunrise from an iPhone Shortcut or an Android automation. <a href="${DOCS}" target="_blank" rel="noopener">Step-by-step guide</a></p>
      <div class="field"><span class="lbl">Start a sunrise (alarm in 30 min)</span><div class="hs-url" id="u-wake">…</div></div>
      <div class="field"><span class="lbl">Snooze · Stop</span><div class="hs-url" id="u-snooze">…</div><div class="hs-url" id="u-stop">…</div></div>
      <span class="help">Method POST. Body (optional, JSON): <span class="mono">{"inMinutes": 30}</span> or <span class="mono">{"at": "07:00"}</span>, plus <span class="mono">"duration": 20</span>. ${admin ? `The <span class="mono">key</span> lets these calls through when Tempolight is locked with a PIN, and opens nothing else.` : "Unlock to see the link key."}</span>
      ${admin ? `<div class="row"><button class="btn sm" id="u-copy" type="button">Copy start link</button><button class="btn sm" id="u-new" type="button">New key</button></div>` : ""}
    </div>`, "span-5")}
    ${panel("Ambient plan", p.enabled ? "On" : "Off", `<label class="check"><input type="checkbox" id="p-on" ${p.enabled ? "checked" : ""}${dis}> On</label>`, `<div class="pb stack">
      <p class="faint" style="margin:0">What the room shows when no music plays, through the day. Changes crossfade over <input type="number" id="p-fade" min="5" max="900" step="5" value="${p.fade}" style="width:72px;display:inline-block"${dis}> seconds. A <b>Night mode</b> row turns night mode on (dim, warm, no strobes); night mode's own hours in Settings win over the plan. Hours not in the table use the usual ambient effect.</p>
      <div class="tablewrap"><table class="hs-plan"><thead><tr><th>Name</th><th>From</th><th>Until</th><th>Look</th><th>Colours</th><th>Colour temperature</th><th>Brightness</th><th></th></tr></thead><tbody id="p-rows">
      ${p.rows.map((r, i) => `<tr data-i="${i}"><td><input data-k="name" value="${esc(r.name)}" style="width:110px"${dis}></td>
        <td><input data-k="from" value="${esc(r.from)}" ${/^\d/.test(r.from) ? 'type="time"' : ""}${dis}></td><td><input data-k="to" value="${esc(r.to)}" ${/^\d/.test(r.to) ? 'type="time"' : ""}${dis}></td>
        <td>${sel(looks, r.look, 'data-k="look"')}</td><td>${sel(pals, r.palette, 'data-k="palette"')}</td><td>${sel(kel, r.kelvin ?? "", 'data-k="kelvin"')}</td>
        <td><input type="range" data-k="brightness" min="0" max="1" step="0.05" value="${r.brightness}"${dis}> <output class="mono">${Math.round(r.brightness * 100)}%</output></td>
        <td><button class="btn sm danger" data-del="${i}" type="button"${dis}>Remove</button></td></tr>`).join("") || '<tr><td colspan="8" class="faint">No rows: the usual ambient effect all day.</td></tr>'}
      </tbody></table></div>
      <div class="row"><button class="btn primary" id="p-save" type="button"${dis}>Save plan</button><button class="btn" id="p-add" type="button"${dis}>Add row</button><button class="btn" id="p-reset" type="button"${dis}>Back to the suggested plan</button><span class="faint" id="p-msg"></span></div>
    </div>`, "span-12")}
    ${admin ? "" : `<p class="callout span-12">Settings on this page are locked. Unlock in Settings to change them; the sleep timer and the sunrise buttons work if guests may change brightness.</p>`}`;
    bind(); links(); if (app.status) onStatus(app.status);
  }
  async function links() {
    const base = DEMO ? "http://tempolight.local:8080" : await guestUrl(""), k = H.wake.key ? `?key=${H.wake.key}` : "";
    const set = (id, path) => { const e = $(id); if (e) e.textContent = `POST ${base}${path}${k}`; };
    set("#u-wake", "/api/wake"); set("#u-snooze", "/api/wake/snooze"); set("#u-stop", "/api/wake/stop");
    if ($("#u-copy")) $("#u-copy").onclick = () => navigator.clipboard?.writeText(`${base}/api/wake${k}`).then(() => toast("Copied"), () => toast("Couldn't copy: select the text instead", true));
  }
  function bind() {
    const W = b => save({ wake: b }), w = H.wake;
    $$("[data-min]").forEach(b => b.onclick = () => save({ sleep: { minutes: Number(b.dataset.min) } }).then(render));
    $("#hs-go").onclick = () => act(() => api("POST", "/api/sleep", { minutes: H.sleep.minutes }), `The lights fade out over ${H.sleep.minutes} minutes`).catch(() => {});
    $("#hs-cancel").onclick = () => act(() => api("DELETE", "/api/sleep"), "Sleep timer cancelled").catch(() => {});
    $("#hs-wnow").onclick = () => act(() => api("POST", "/api/wake", {}), "Sunrise started").catch(() => {});
    $("#hs-snooze").onclick = () => act(() => api("POST", "/api/wake/snooze", {}), "Snoozed").catch(() => {});
    $("#hs-stop").onclick = () => act(() => api("POST", "/api/wake/stop", {}), "Sunrise stopped").catch(() => {});
    $("#hs-skip").onclick = () => act(() => api("DELETE", "/api/wake"), "Next wake-up skipped").catch(() => {});
    if (!admin) return;
    $("#w-on").onchange = e => W({ enabled: e.target.checked }).then(render);
    $$("[data-src]").forEach(b => b.onclick = () => W({ source: b.dataset.src }).then(render));
    $$("[data-day]").forEach(i => i.onchange = () => { const days = w.days.slice(); days[Number(i.dataset.day)] = i.value || ""; W({ days }); });
    const range = (id, key, fmt, k = 1) => { const e = $(id); e.oninput = () => $(id + "-o").textContent = fmt(Number(e.value)); e.onchange = () => W({ [key]: Number(e.value) * k }); };
    range("#w-dur", "duration", v => `${v} min`); range("#w-bri", "endBrightness", v => `${Math.round(v * 100)}%`); range("#w-hold", "holdMin", v => `${v} min`); range("#w-snz", "snoozeMin", v => `${v} min`);
    $("#w-tg").onchange = e => W({ target: e.target.value });
    $("#w-col").onchange = e => W({ endColor: e.target.value });
    $$("[data-col]").forEach(b => b.onclick = () => { $("#w-col").value = b.dataset.col; W({ endColor: b.dataset.col }); });
    if ($("#u-new")) $("#u-new").onclick = async () => { if (!confirm("Make a new key? Phone automations with the old one stop working until you update them.")) return; const r = await act(() => api("POST", "/api/wake/key", {})).catch(() => null); if (r) { H.wake.key = r.key; links(); toast("New key made"); } };
    // the plan table
    $("#p-on").onchange = e => save({ plan: { enabled: e.target.checked } }, e.target.checked ? "Ambient plan on" : "Ambient plan off").then(render);
    $("#p-fade").onchange = e => save({ plan: { fade: Number(e.target.value) } });
    $$('#p-rows input[type=range]').forEach(r => r.oninput = () => r.nextElementSibling.textContent = Math.round(r.value * 100) + "%");
    const rows = () => $$("#p-rows tr[data-i]").map(tr => { const g = k => tr.querySelector(`[data-k="${k}"]`).value;
      return { name: g("name"), from: g("from"), to: g("to"), look: g("look"), palette: g("palette"), kelvin: g("kelvin") ? Number(g("kelvin")) : null, brightness: Number(g("brightness")) }; });
    $("#p-save").onclick = () => save({ plan: { rows: rows() } }, "Plan saved").then(render);
    $("#p-add").onclick = () => { const r = rows(), last = r.at(-1); H.plan.rows = [...r, { name: "New", from: last ? last.to : "12:00", to: last ? last.from : "13:00", look: "white", palette: "auto", kelvin: 3000, brightness: 0.5 }]; render(); $("#p-msg").textContent = "Not saved yet"; };
    $$("[data-del]").forEach(b => b.onclick = () => { const r = rows(); r.splice(Number(b.dataset.del), 1); H.plan.rows = r; render(); $("#p-msg").textContent = "Not saved yet"; });
    $("#p-reset").onclick = () => { if (confirm("Replace the table with the suggested plan?")) save({ plan: { reset: true } }, "Suggested plan").then(render); };
    $$("#p-rows input, #p-rows select").forEach(e => e.addEventListener("change", () => { $("#p-msg").textContent = "Not saved yet"; }));
  }
  function onStatus(m) {
    const h = m.home; if (!H || !h || !$("#hs-now")) return; const w = h.wake, running = w && w.phase !== "pending" && w.phase !== "ending";
    $("#hs-now").innerHTML = esc(nowText(h) || (h.plan ? `Ambient plan: ${h.plan.name}${h.plan.fading ? " (changing)" : ""}` : "Nothing planned")) + (h.plan && (w || h.sleep || h.nextWake) ? ` <span class="faint">· Ambient: ${esc(h.plan.name)}</span>` : "");
    $("#hs-dot").style.cssText = w && w.phase !== "pending" ? sunCss(w.progress) : h.sleep ? `background:#3a1a08;box-shadow:0 0 10px #ff7a30` : "";
    $("#hs-barw").hidden = !(w && w.phase !== "pending") && !h.sleep; $("#hs-bar").style.width = `${Math.round((w && w.phase !== "pending" ? w.progress : h.sleep ? 1 - h.sleep.progress : 0) * 100)}%`;
    $("#hs-cancel").hidden = !h.sleep; $("#hs-go").hidden = !!h.sleep;
    $("#hs-snooze").hidden = !running || !canUse; $("#hs-stop").hidden = !running || !canUse; $("#hs-skip").hidden = !h.nextWake || !canUse;
  }
  load().catch(e => { el.innerHTML = `<div class="callout err span-12">Couldn't load: ${esc(e.message)}</div>`; });
  return { onStatus, onChanged(w) { if (w.has("home") && !el.contains(document.activeElement)) load().catch(() => {}); else if (w.has("home")) api("GET", "/api/home").then(r => { H = r; }).catch(() => {}); if (w.has("lock")) load().catch(() => {}); } };
}
