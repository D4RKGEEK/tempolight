// Home and sleep (dashboard v2, #/sleep2): "What do the lights do around my day and my sleep?"
// A dark hero split in two, Tonight (the sleep timer: Sleep in N min with presets, the countdown while it runs, night
// mode's hours) and Tomorrow morning (the next wake-up time big over a sunrise sky that rises with the real sunrise,
// Snooze / Stop / Skip). Then the ambient plan as a 24-hour strip (a block per hour in that hour's light, the plan's
// parts named above it, a now marker), and cards for night mode and the phone alarm link. Every edit is in a sheet:
// the wake-up (weekly times or the phone, length, lights, end colour and brightness, stay on, snooze), the plan rows,
// night mode with the location, and the phone links with their key. Same API as the v1 page (homesleep.js):
// GET/PUT /api/home, POST/DELETE /api/sleep, POST /api/wake(/snooze|/stop|/key), DELETE /api/wake, PATCH /api/settings.
import { app, api, act, toast, esc, $, $$, opt, unlocked, guestOk, refreshState, DEMO, guestUrl } from "/app.js";
import { openSheet, segmented, bindSegmented, bigSlider, bindBigSlider, toggle, bindToggle, pill, icon, ensureCss, routeSub } from "/v2/shell.js";
import { hm, mins } from "/homestrip.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first on screen; stored Sunday first, like Date.getDay()
const DOCS = "https://github.com/D4RKGEEK/tempolight/blob/main/docs/wake-up.md";
const PRESETS = [15, 30, 45, 60];
// the engine's palettes (packages/engine/src/effects.js PALSETS), for the strip's colours
const PALS = { neon: ["#ff2bd6", "#16e0ff"], sunset: ["#ff5e3a", "#ffb648"], ocean: ["#0a6cff", "#00e5d0"], fire: ["#ff3d00", "#ffc400"],
  ice: ["#7cc8ff", "#e8f6ff"], forest: ["#19c37d", "#c6ff3d"], mono: ["#ffe2b8", "#fff4e6"], mood: ["#ff8a1f", "#7b2fff"] };
const KELVINS = [["", "The effect's own"], ["2200", "2200 K candle"], ["2400", "2400 K"], ["2700", "2700 K warm"], ["3000", "3000 K"], ["4000", "4000 K neutral"], ["5000", "5000 K cool"], ["6500", "6500 K daylight"]];
const pctf = v => `${Math.round(v * 100)}%`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- colour and time helpers
/** A colour temperature as a hex colour (the server's kelvinRGB, home.js). */
function kelvinHex(k) {
  const t = clamp(Number(k) || 2700, 1000, 10000) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = [r, g, b].map(v => clamp(v, 0, 255)), m = Math.max(...c) || 1;
  return "#" + c.map(v => Math.round(v / m * 255).toString(16).padStart(2, "0")).join("");
}
/** The two colours a plan row shows. */
function rowColours(r) {
  if (r.look === "night") return [kelvinHex(r.kelvin || 2200), "#5a1c06"];
  if (r.kelvin) { const k = kelvinHex(r.kelvin); return [k, k]; }
  if (r.look === "white") return [kelvinHex(3000), kelvinHex(3000)];
  return PALS[r.palette] || ["#ffb648", "#ff8a1f"];
}
/** The sunrise's colour at progress p (the server's sunriseColor), as CSS. */
function sunColour(p, end = "#ffd2a1") {
  const n = parseInt(end.slice(1), 16), E = [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  const S = [[0, [0.5, 0.02, 0]], [0.25, [1, 0.1, 0]], [0.5, [1, 0.35, 0.04]], [0.75, [1, 0.6, 0.25]], [1, E]];
  p = clamp(p, 0, 1); let c = E;
  for (let i = 1; i < S.length; i++) if (p <= S[i][0]) { const k = (p - S[i - 1][0]) / (S[i][0] - S[i - 1][0]); c = S[i - 1][1].map((a, j) => a + (S[i][1][j] - a) * k); break; }
  return `rgb(${c.map(v => Math.round(v * 255)).join(" ")})`;
}
// sunrise and sunset for a place (packages/server/src/sun.js), so plan rows "sunset" or "sunrise+30" draw at the right hour
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function sunTimes(date, lat, lon) {
  const d0 = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12) / 86400000 + 2440587.5;
  const n = Math.round(d0 - 2451545.0 - 0.0009 + lon / 360 * -1), Js = 2451545.0 + 0.0009 - lon / 360 + n;
  const M = (357.5291 + 0.98560028 * (Js - 2451545)) % 360, C = 1.9148 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 0.0003 * Math.sin(rad(3 * M));
  const L = (M + C + 180 + 102.9372) % 360, Jt = Js + 0.0053 * Math.sin(rad(M)) - 0.0069 * Math.sin(rad(2 * L)), decl = Math.asin(Math.sin(rad(L)) * Math.sin(rad(23.44)));
  const cosH = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * Math.sin(decl)) / (Math.cos(rad(lat)) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) return null;
  const H = deg(Math.acos(cosH)), toDate = j => new Date((j - 2440587.5) * 86400000);
  return { sunrise: toDate(Jt - H / 360), sunset: toDate(Jt + H / 360) };
}
/** "18:30" → 1110 minutes; "sunset+30" → that day's sunset + 30 (06:30 / 18:30 when no location is set); null if not a time. */
function toMin(t, loc) {
  const s = String(t || "").trim(), m = /^(\d{1,2}):(\d{2})$/.exec(s); if (m) return Number(m[1]) * 60 + Number(m[2]);
  const x = /^(sunrise|sunset)([+-]\d{1,3})?$/.exec(s); if (!x) return null;
  let base = x[1] === "sunrise" ? 390 : 1110; const st = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon) ? sunTimes(new Date(), loc.lat, loc.lon) : null;
  if (st) { const d = st[x[1]]; base = d.getHours() * 60 + d.getMinutes(); }
  return ((base + (Number(x[2]) || 0)) % 1440 + 1440) % 1440;
}
const inWin = (a, b, t) => a == null || b == null ? false : a <= b ? t >= a && t < b : t >= a || t < b;
const planAt = (rows, t, loc) => rows.findIndex(r => inWin(toMin(r.from, loc), toMin(r.to, loc), t, loc));
const fmtMin = t => `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const prettyTime = t => /^sun/.test(t) ? t.replace(/^sunrise/, "Sunrise").replace(/^sunset/, "Sunset").replace(/([+-])(\d+)/, " $1$2 min") : t;

/** "Tomorrow morning", "This morning", "Saturday morning" for a Date. */
function morningOf(d) {
  const today = new Date(), tm = new Date(); tm.setDate(tm.getDate() + 1);
  const part = d.getHours() < 12 ? "morning" : d.getHours() < 18 ? "afternoon" : "evening";
  if (d.toDateString() === today.toDateString()) return part === "morning" ? "This morning" : `This ${part}`;
  if (d.toDateString() === tm.toDateString()) return `Tomorrow ${part}`;
  return `${d.toLocaleDateString([], { weekday: "long" })} ${part}`;
}
/** The next weekly alarm from the saved times (before the first status message says so). */
function nextFromDays(w) {
  if (!w.enabled || w.source !== "times") return null; const now = new Date();
  for (let k = 0; k < 8; k++) { const d = new Date(now); d.setDate(now.getDate() + k); const t = w.days[d.getDay()]; if (!t) continue;
    const [h, m] = t.split(":").map(Number); d.setHours(h, m, 0, 0); if (d > now) return d; }
  return null;
}

// ---------------------------------------------------------------- the screen
export function render(el) {
  ensureCss("/v2/sleep.css");
  const admin = unlocked(), canUse = guestOk("brightness"), dis = admin ? "" : " disabled";
  let H = null, S = null, gone = false, tick = null; // GET /api/home; the last status's home part
  const st = () => app.state, night = () => st().settings.night || {};
  el.innerHTML = `<div class="ui-screen sl"><div class="sl-hero sl-skel" aria-hidden="true"></div></div>`;

  const load = async () => { H = await api("GET", "/api/home"); if (!gone) paint(); };
  const save = (body, ok) => act(() => api("PUT", "/api/home", body), ok).then(r => { H = r; repaint(); return r; }).catch(() => load().catch(() => {}));
  const setS = (b, ok = "Saved") => act(() => api("PATCH", "/api/settings", b), ok).then(refreshState).then(() => { if (!gone) repaint(); }).catch(() => {});

  function paint() {
    const w = H.wake, p = H.plan;
    el.innerHTML = `<div class="ui-screen sl">
      <section class="sl-hero" aria-label="Tonight and tomorrow morning">
        <div class="sl-night" id="sl-tonight">
          <div class="sl-hh"><span class="sl-eyebrow">${icon("moon")}Tonight</span><span id="sl-nightpill"></span></div>
          <div class="sl-sleep" id="sl-sleep-idle">
            <button class="sl-go" id="sl-go" type="button"${canUse ? "" : " disabled"}><span class="sl-go-t">Sleep in <b id="sl-go-n">${H.sleep.minutes}</b> min</span><small>The lights fade warmer and dimmer, then off</small></button>
            <div class="sl-presets">${segmented("sl-min", PRESETS.map(n => ({ value: n, label: `${n} min` })), PRESETS.includes(H.sleep.minutes) ? H.sleep.minutes : 30, { label: "Sleep timer length" })}</div>
          </div>
          <div class="sl-sleep" id="sl-sleep-run" hidden>
            <span class="sl-big"><b id="sl-left">–</b><small id="sl-left-u">until the lights are off</small></span>
            <span class="sl-bar" aria-hidden="true"><i id="sl-bar"></i></span>
            <div class="sl-acts"><button class="btn" id="sl-cancel" type="button"${canUse ? "" : " disabled"}>Cancel the sleep timer</button></div>
          </div>
          <p class="sl-note" id="sl-tnote"></p>
        </div>
        <div class="sl-morning" id="sl-morning" style="--sun:0">
          <div class="sl-sky" aria-hidden="true"><i class="sl-sun" id="sl-sun"></i><i class="sl-horizon"></i></div>
          <div class="sl-hh"><span class="sl-eyebrow" id="sl-mlabel">Tomorrow morning</span><span id="sl-wpill"></span></div>
          <div class="sl-wake"><b class="sl-time" id="sl-time">–</b><span class="sl-wsub" id="sl-wsub"></span></div>
          <div class="sl-acts" id="sl-wacts">
            <button class="btn" id="sl-snooze" type="button" hidden>Snooze ${w.snoozeMin} min</button>
            <button class="btn" id="sl-stop" type="button" hidden>Stop the sunrise</button>
            <button class="btn primary" id="sl-wedit" type="button">${icon("clock")}<span id="sl-wedit-t">Edit the wake-up</span></button>
            <button class="btn" id="sl-skip" type="button" hidden>Skip the next one</button>
            <button class="btn" id="sl-wnow" type="button"${canUse && w.enabled ? "" : " hidden"}>Sunrise now</button>
          </div>
        </div>
      </section>

      <section class="ui-card sl-plan" aria-labelledby="sl-plan-h">
        <div class="ui-card-h"><h2 id="sl-plan-h">Through the day</h2>${pill(p.enabled ? "On" : "Off", p.enabled ? "ok" : "")}
          ${toggle("sl-plan-on", "Ambient plan", p.enabled)}
          <button class="btn sm" id="sl-plan-edit" type="button">${icon("sliders")}Edit the plan</button></div>
        <p class="ui-meta sl-plan-sub">What the room shows when no music plays. ${p.enabled ? `Changes crossfade over ${p.fade} s.` : "Off: the usual ambient effect all day."}</p>
        <div class="sl-strip-wrap${p.enabled ? "" : " off"}" id="sl-strip">${stripHtml(p.rows)}</div>
      </section>

      <div class="sl-cards">
        <section class="ui-card sl-nm" aria-labelledby="sl-nm-h">
          <div class="ui-card-h"><span class="sl-ic">${icon("moon")}</span><h2 id="sl-nm-h">Night mode</h2><span id="sl-nm-pill"></span></div>
          <div class="sl-nm-body" id="sl-nm-body"></div>
          <div class="sl-card-a">${toggle("sl-nm-on", "Calmer light at night", !!night().enabled, { hint: "A brightness cap, warm colours, no strobes or drop flashes" })}</div>
          <div class="sl-card-a"><button class="btn sm" id="sl-nm-edit" type="button"${dis}>Change the hours</button></div>
        </section>
        <section class="ui-card sl-ph" aria-labelledby="sl-ph-h">
          <div class="ui-card-h"><span class="sl-ic">${icon("plug")}</span><h2 id="sl-ph-h">Your phone's alarm</h2>${pill(w.source === "phone" ? "Linked" : "Not linked", w.source === "phone" ? "ok" : "")}</div>
          <p class="sl-ph-t">Let an iPhone Shortcut or an Android automation start the sunrise when your alarm is set, so you never set the time twice.</p>
          <div class="sl-card-a"><button class="btn sm" id="sl-ph-open" type="button">Show the phone links</button><a class="btn sm" href="${DOCS}" target="_blank" rel="noopener">Read the step-by-step guide</a></div>
        </section>
      </div>
      ${admin ? "" : `<p class="sl-locked">${icon("info")}These settings are locked. Unlock in Settings to change them; the sleep timer and the sunrise buttons work if guests may change brightness.</p>`}
    </div>`;
    bind(); repaint(); if (app.status) onStatus(app.status);
    const sub = routeSub(); if (sub === "wake") wakeSheet(); else if (sub === "plan") planSheet(); else if (sub === "night") nightSheet();
  }

  // the parts that change with the saved settings (not the live status)
  function repaint() {
    if (!H || !$("#sl-time")) return; const n = night();
    $("#sl-go-n").textContent = H.sleep.minutes;
    const strip = $("#sl-strip"); if (strip) { strip.innerHTML = stripHtml(H.plan.rows); strip.classList.toggle("off", !H.plan.enabled); bindStrip(strip); }
    $("#sl-nm-body").innerHTML = `<div class="sl-hours"><b>${esc(prettyTime(n.from || "23:00"))}</b><span aria-hidden="true">${icon("chevron")}</span><b>${esc(prettyTime(n.to || "07:00"))}</b></div>
      <p class="ui-meta">At most ${pctf(n.maxBrightness ?? 0.3)} brightness${n.warm ? ", warm colours only" : ""}.${/sun/.test((n.from || "") + (n.to || "")) && !st().settings.location ? " Set your location so sunrise and sunset are right." : ""}</p>`;
    $("#sl-nm-on").setAttribute("aria-checked", !!n.enabled); if (!admin) $("#sl-nm-on").disabled = true;
    paintNightPill(app.status);
    paintMorning(S);
  }

  // ---------------------------------------------------------------- the 24-hour strip
  function stripHtml(rows, { mini = false } = {}) {
    const loc = st().settings.location, hours = [...Array(24).keys()].map(h => planAt(rows, h * 60 + 30, loc));
    const bands = []; hours.forEach((i, h) => { const b = bands.at(-1); if (b && b.i === i) b.n++; else bands.push({ i, h, n: 1 }); });
    const cell = (i, h) => { if (i < 0) return `<i class="sl-h none" style="grid-column:${h + 1}"></i>`; const r = rows[i], [a, b] = rowColours(r), k = 0.28 + 0.72 * clamp(r.brightness ?? 0.5, 0, 1);
      return `<i class="sl-h" style="grid-column:${h + 1};--a:${a};--b:${b};--k:${k.toFixed(2)}"></i>`; };
    return `<div class="sl-strip${mini ? " mini" : ""}">
      <div class="sl-bands">${bands.map(b => { const r = rows[b.i];
        return `<button class="sl-band${b.i < 0 ? " none" : ""}" type="button" data-row="${b.i}" style="grid-column:${b.h + 1} / span ${b.n}" title="${b.i < 0 ? "The usual ambient effect" : esc(`${r.name}: ${prettyTime(r.from)} to ${prettyTime(r.to)}`)}">
          <span class="sl-band-n">${b.i < 0 ? "Usual" : esc(r.name)}</span>${mini || b.n < 3 ? "" : `<small>${b.i < 0 ? "ambient" : esc(lookName(r))}</small>`}</button>`; }).join("")}</div>
      <div class="sl-hours24" aria-hidden="true">${hours.map(cell).join("")}<span class="sl-now" id="${mini ? "" : "sl-now"}" style="left:${(nowMin() / 1440 * 100).toFixed(2)}%"></span></div>
      <div class="sl-ticks" aria-hidden="true">${[0, 3, 6, 9, 12, 15, 18, 21].map(h => `<span style="grid-column:${h + 1}">${String(h).padStart(2, "0")}</span>`).join("")}</div>
    </div>`;
  }
  function lookName(r) {
    if (r.look === "white") return r.kelvin ? `Soft white, ${r.kelvin} K` : "Soft white"; if (r.look === "night") return "Night mode";
    return st().effects.find(e => e.id === r.look)?.name || r.look;
  }
  function bindStrip(root) { root.querySelectorAll("[data-row]").forEach(b => b.onclick = () => planSheet(Number(b.dataset.row))); }

  // ---------------------------------------------------------------- live: the sleep timer and the sunrise
  function paintMorning(h) {
    if (!H || !$("#sl-time")) return; const w = H.wake, W = h?.wake, phase = W?.phase;
    let label = "Tomorrow morning", big = "Off", sub = "No sunrise planned. Set a time and the room wakes you with light.", p = 0, pillTxt = w.enabled ? "On" : "Off", pillSt = w.enabled ? "ok" : "";
    const running = W && phase !== "pending" && phase !== "ending";
    if (W && phase === "pending") { const d = new Date(W.end); label = morningOf(d); big = hm(W.end); sub = `The sunrise starts at ${hm(W.start)} and is at full light at ${hm(W.end)}.`; }
    else if (W && phase === "snoozed") { label = "Snoozed"; big = hm(W.snoozeUntil); sub = "The sunrise comes back then."; p = W.progress ?? 0.6; pillTxt = "Snoozed"; pillSt = "warn"; }
    else if (W && phase === "holding") { label = "Good morning"; big = hm(W.end); sub = `Full light. Back to the usual lights after ${w.holdMin} min.`; p = 1; pillTxt = "Full light"; pillSt = "accent"; }
    else if (W && phase === "ending") { label = "Good morning"; big = hm(W.end); sub = "The sunrise is ending."; p = 1; }
    else if (running) { label = "Sunrise now"; big = `${Math.round((W.progress || 0) * 100)}%`; sub = `Full light at ${hm(W.end)}.`; p = W.progress || 0; pillTxt = "Rising"; pillSt = "accent"; }
    else { const nx = h?.nextWake ? new Date(h.nextWake) : nextFromDays(w);
      if (nx) { label = morningOf(nx); big = hm(nx.toISOString()); sub = `The sunrise starts ${w.duration} min before, in ${lightsName(w.target)}.`; }
      else if (w.enabled && w.source === "phone") { big = "Phone"; sub = "Your phone's alarm starts the sunrise, through a Shortcut or Home Assistant."; }
      else if (w.enabled) { sub = "No times are set for the coming week."; big = "None"; } }
    $("#sl-mlabel").textContent = label; const tm = /^(.*\d)\s*([^\d\s].*)$/.exec(big); $("#sl-time").innerHTML = tm && /\d:\d/.test(big) ? `${esc(tm[1])}<small>${esc(tm[2])}</small>` : esc(big); $("#sl-wsub").textContent = sub;
    $("#sl-time").classList.toggle("dim", big === "Off" || big === "None");
    $("#sl-wpill").innerHTML = pill(pillTxt, pillSt);
    const m = $("#sl-morning"); m.style.setProperty("--sun", (W || w.enabled ? Math.max(p, 0.22) : 0).toFixed(3)); m.style.setProperty("--sunc", sunColour(Math.max(p, 0.55), w.endColor)); m.style.setProperty("--end", w.endColor);
    m.classList.toggle("live", !!running || phase === "holding");
    $("#sl-snooze").hidden = !running || !canUse; $("#sl-stop").hidden = !(running || phase === "holding") || !canUse;
    $("#sl-skip").hidden = !h?.nextWake || !canUse || !!running;
    $("#sl-wnow").hidden = !canUse || !w.enabled || !!W;
    $("#sl-wedit").classList.toggle("primary", !running && phase !== "holding"); $("#sl-wedit-t").textContent = w.enabled ? "Edit the wake-up" : "Set a wake-up";
  }
  const lightsName = t => t === "all" ? "the whole room" : t.startsWith("zone:") ? `zone ${(st().room.zones || []).find(z => "zone:" + z.id === t)?.name || "?"}` : (st().devices.find(d => "dev:" + d.id === t)?.name || "the chosen light");
  function paintTonight(h) {
    const sl = h?.sleep, n = night();
    $("#sl-sleep-idle").hidden = !!sl; $("#sl-sleep-run").hidden = !sl;
    if (sl) { $("#sl-left").textContent = mins(sl.left); $("#sl-bar").style.width = `${Math.round((1 - sl.progress) * 100)}%`; }
    const plan = h?.plan ? `Ambient now: ${h.plan.name}${h.plan.fading ? " (changing)" : ""}.` : "";
    $("#sl-tnote").textContent = sl ? "Touching the brightness or the power switch cancels it." : n.enabled ? `Night mode from ${prettyTime(n.from)} to ${prettyTime(n.to)}. ${plan}` : plan || "Touching the brightness or the power switch cancels the timer.";
  }
  function paintNightPill(m) {
    const on = !!m?.night, n = night(), p = on ? pill("On now", "accent") : pill(n.enabled ? "On" : "Off", n.enabled ? "ok" : "");
    if ($("#sl-nm-pill")) $("#sl-nm-pill").innerHTML = p;
    if ($("#sl-nightpill")) $("#sl-nightpill").innerHTML = on ? pill("Night mode on", "accent") : "";
  }
  function onStatus(m) { if (!H || !$("#sl-time")) return; S = m.home || null; paintTonight(S); paintMorning(S); paintNightPill(m); }

  // ---------------------------------------------------------------- events on the screen
  function bind() {
    bindSegmented(el, "sl-min", v => save({ sleep: { minutes: Number(v) } }));
    $("#sl-go").onclick = () => act(() => api("POST", "/api/sleep", { minutes: H.sleep.minutes }), `The lights fade out over ${H.sleep.minutes} minutes`).catch(() => {});
    $("#sl-cancel").onclick = () => act(() => api("DELETE", "/api/sleep"), "Sleep timer cancelled").catch(() => {});
    $("#sl-wnow").onclick = () => act(() => api("POST", "/api/wake", {}), "Sunrise started").catch(() => {});
    $("#sl-snooze").onclick = () => act(() => api("POST", "/api/wake/snooze", {}), "Snoozed").catch(() => {});
    $("#sl-stop").onclick = () => act(() => api("POST", "/api/wake/stop", {}), "Sunrise stopped").catch(() => {});
    $("#sl-skip").onclick = () => act(() => api("DELETE", "/api/wake"), "Next wake-up skipped").catch(() => {});
    $("#sl-wedit").onclick = () => wakeSheet();
    $("#sl-plan-edit").onclick = () => planSheet();
    $("#sl-nm-edit").onclick = () => nightSheet();
    $("#sl-ph-open").onclick = () => phoneSheet();
    const pt = bindToggle(el, "sl-plan-on", v => save({ plan: { enabled: v } }, v ? "Ambient plan on" : "Ambient plan off").then(() => paint()));
    if (!admin) { $("#sl-plan-on").disabled = true; pt.set(H.plan.enabled); }
    bindToggle(el, "sl-nm-on", v => setS({ night: { ...night(), enabled: v } }, v ? "Night mode on" : "Night mode off"));
  }

  // ---------------------------------------------------------------- sheet: the wake-up
  function wakeSheet() {
    const w = H.wake, zones = st().room.zones || [];
    const targets = [["all", "The whole room"], ...zones.map(z => ["zone:" + z.id, "Zone: " + z.name]), ...st().devices.map(d => ["dev:" + d.id, "Only " + d.name])];
    const body = `<div class="sl-sh">
      ${admin ? "" : `<p class="sl-locked">${icon("info")}Locked: unlock in Settings to change the wake-up.</p>`}
      <div class="sl-sh-card">${toggle("sw-on", "Wake up with a sunrise", w.enabled, { hint: "The lights rise from deep red to warm white before your alarm" })}</div>
      <div class="sl-sh-sec"><span class="ui-eyebrow">When</span>
        ${segmented("sw-src", [{ value: "times", label: "Set times" }, { value: "phone", label: "Linked to my phone" }], w.source, { label: "When to wake up" })}
        <div id="sw-days"></div></div>
      <div class="sl-sh-sec"><span class="ui-eyebrow">The sunrise</span>
        ${bigSlider("sw-dur", "Sunrise takes", w.duration, { min: 10, max: 40, step: 5, format: v => `${v} min` })}
        ${bigSlider("sw-bri", "End brightness", w.endBrightness, { min: 0.1, max: 1, step: 0.05, format: pctf })}
        <div class="sl-f1">
          <div class="field"><label for="sw-tg">Lights</label><select id="sw-tg"${dis}>${targets.map(([k, n]) => opt(k, n, k === w.target)).join("")}${targets.some(([k]) => k === w.target) ? "" : opt(w.target, w.target, true)}</select></div>
          <div class="field"><label for="sw-col">End colour</label><div class="sl-cols"><input type="color" id="sw-col" value="${esc(w.endColor)}" aria-label="End colour"${dis}>
            <button class="sl-chip" type="button" data-col="#ffd2a1"${dis}><i style="background:#ffd2a1"></i>Warm white</button><button class="sl-chip" type="button" data-col="#fff1e0"${dis}><i style="background:#fff1e0"></i>Daylight</button></div></div>
        </div>
        <div class="sl-prev" id="sw-prev" aria-hidden="true"></div></div>
      <div class="sl-sh-sec"><span class="ui-eyebrow">After the alarm</span>
        ${bigSlider("sw-hold", "Stay on for", w.holdMin, { min: 0, max: 120, step: 5, format: v => v ? `${v} min` : "No" })}
        ${bigSlider("sw-snz", "Snooze", w.snoozeMin, { min: 1, max: 30, step: 1, format: v => `${v} min` })}</div>
      <p class="ui-meta">It turns the lights on if they're off and covers whatever is playing, even in night mode; live pads (blackout) still work. Times are this server's clock (${esc(new Date().toTimeString().slice(9, 17))}).</p>
    </div>`;
    const sh = openSheet({ title: "Wake-up", body, onClose: () => paintMorning(S) }), r = sh.body;
    const W = b => save({ wake: b });
    const days = () => { const v = H.wake;
      r.querySelector("#sw-days").innerHTML = v.source === "times"
        ? `<div class="sl-days">${ORDER.map(d => `<label class="sl-day${v.days[d] ? " on" : ""}"><span>${DAYS[d].slice(0, 3)}</span><input type="time" data-day="${d}" value="${esc(v.days[d] || "")}" aria-label="${DAYS[d]}"${dis}></label>`).join("")}</div>
           <div class="sl-row"><span class="ui-meta">Full light at these times. Leave a day empty for no alarm.</span>${admin ? `<button class="btn sm" id="sw-copy" type="button">Same as Monday on weekdays</button>` : ""}</div>`
        : `<p class="ui-meta">Your phone's alarm starts the sunrise, through a Shortcut or Home Assistant. <button class="sl-link" id="sw-links" type="button">Show the phone links</button></p>`;
      r.querySelectorAll("[data-day]").forEach(i => i.onchange = () => { const d = H.wake.days.slice(); d[Number(i.dataset.day)] = i.value || ""; i.closest(".sl-day").classList.toggle("on", !!i.value); W({ days: d }); });
      const c = r.querySelector("#sw-copy"); if (c) c.onclick = () => { const t = H.wake.days[1]; if (!t) return toast("Set Monday's time first", true); const d = H.wake.days.slice(); for (const k of [2, 3, 4, 5]) d[k] = t; W({ days: d }).then(days); };
      const l = r.querySelector("#sw-links"); if (l) l.onclick = () => phoneSheet(); };
    const prev = () => { const v = H.wake, e = r.querySelector("#sw-prev");
      e.style.background = `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((p, i) => `${sunColour(p, v.endColor)} ${i * 25}%`).join(", ")})`;
      e.innerHTML = `<span>${v.duration} min before</span><span>Full light, ${pctf(v.endBrightness)}</span>`; };
    days(); prev();
    if (!admin) { r.querySelectorAll("button.switch, .ui-seg button, .ui-bigs input").forEach(x => x.disabled = true); return; }
    bindToggle(r, "sw-on", v => W({ enabled: v }));
    bindSegmented(r, "sw-src", v => W({ source: v }).then(days));
    bindBigSlider(r, "sw-dur", { onChange: v => W({ duration: v }).then(prev) });
    bindBigSlider(r, "sw-bri", { onChange: v => W({ endBrightness: v }).then(prev) });
    bindBigSlider(r, "sw-hold", { onChange: v => W({ holdMin: v }) });
    bindBigSlider(r, "sw-snz", { onChange: v => W({ snoozeMin: v }).then(() => { const s = $("#sl-snooze"); if (s) s.textContent = `Snooze ${v} min`; }) });
    r.querySelector("#sw-tg").onchange = e => W({ target: e.target.value });
    r.querySelector("#sw-col").onchange = e => W({ endColor: e.target.value }).then(prev);
    r.querySelectorAll("[data-col]").forEach(b => b.onclick = () => { r.querySelector("#sw-col").value = b.dataset.col; W({ endColor: b.dataset.col }).then(prev); });
  }

  // ---------------------------------------------------------------- sheet: the ambient plan
  function planSheet(focus = -1) {
    let rows = H.plan.rows.map(x => ({ ...x })), dirty = false;
    const looks = [["white", "Soft white"], ["night", "Night mode"], ...st().effects.filter(e => e.tag === "calm" || e.tag === "home").map(e => [e.id, e.name])];
    const pals = st().palettes.map(x => [x, x === "auto" ? "Automatic" : x[0].toUpperCase() + x.slice(1)]);
    const sel = (list, v, k, i) => `<select data-k="${k}" data-i="${i}"${dis} aria-label="${k}">${list.map(([a, n]) => opt(a, n, String(a) === String(v ?? ""))).join("")}${list.some(([a]) => String(a) === String(v ?? "")) ? "" : v ? opt(v, k === "kelvin" ? v + " K" : v, true) : ""}</select>`;
    const sh = openSheet({ title: "Through the day", wide: true, body: `<div class="sl-sh">
      ${admin ? "" : `<p class="sl-locked">${icon("info")}Locked: unlock in Settings to change the plan.</p>`}
      <p class="ui-meta">What the room shows when no music plays. A Night mode part turns night mode on (dim, warm, no strobes); night mode's own hours win over the plan. Hours not in the plan use the usual ambient effect.</p>
      <div id="sp-strip"></div>
      <div class="sl-prows" id="sp-rows"></div>
      <div class="sl-row"><button class="btn sm" id="sp-add" type="button"${dis}>${icon("plus")}Add a part</button><button class="btn sm" id="sp-reset" type="button"${dis}>Back to the suggested plan</button>
        <label class="sl-fade">Crossfade <input type="number" id="sp-fade" min="5" max="900" step="5" value="${H.plan.fade}"${dis}> s</label></div>
      <div class="ui-bar sl-sbar"><span id="sp-msg" class="ui-meta">${H.plan.enabled ? "The plan is on" : "The plan is off: turn it on to use it"}</span><button class="btn primary" id="sp-save" type="button"${dis}>Save the plan</button></div>
    </div>`, onClose: () => { if (dirty) toast("Plan changes not saved", true); } }), r = sh.body;
    const strip = () => { r.querySelector("#sp-strip").innerHTML = stripHtml(rows, { mini: true }); r.querySelectorAll("#sp-strip [data-row]").forEach(b => b.onclick = () => { const c = r.querySelector(`.sl-prow[data-i="${b.dataset.row}"]`); c?.scrollIntoView({ block: "nearest", behavior: "smooth" }); c?.querySelector("input")?.focus({ preventScroll: true }); }); };
    const mark = () => { dirty = true; r.querySelector("#sp-msg").textContent = "Not saved yet"; strip(); };
    const list = () => {
      r.querySelector("#sp-rows").innerHTML = rows.map((x, i) => { const [a, b] = rowColours(x);
        return `<div class="sl-prow" data-i="${i}" style="--a:${a};--b:${b}">
          <div class="sl-prow-h"><i class="sl-prow-sw" aria-hidden="true"></i><input data-k="name" data-i="${i}" value="${esc(x.name)}" aria-label="Name"${dis}><button class="ui-icbtn" type="button" data-del="${i}" aria-label="Remove ${esc(x.name)}"${dis}>${icon("close")}</button></div>
          <div class="sl-prow-g">
            <div class="field"><label>From</label><input data-k="from" data-i="${i}" value="${esc(x.from)}" ${/^\d/.test(x.from) ? 'type="time"' : ""}${dis}></div>
            <div class="field"><label>Until</label><input data-k="to" data-i="${i}" value="${esc(x.to)}" ${/^\d/.test(x.to) ? 'type="time"' : ""}${dis}></div>
            <div class="field"><label>Look</label>${sel(looks, x.look, "look", i)}</div>
            <div class="field"><label>Colours</label>${sel(pals, x.palette, "palette", i)}</div>
            <div class="field"><label>Colour temperature</label>${sel(KELVINS, x.kelvin ?? "", "kelvin", i)}</div>
            <div class="field"><label>Brightness <output>${pctf(x.brightness)}</output></label><input type="range" data-k="brightness" data-i="${i}" min="0" max="1" step="0.05" value="${x.brightness}"${dis}></div>
          </div></div>`; }).join("") || `<div class="ui-empty"><h3>No parts</h3><p>The usual ambient effect all day.</p></div>`;
      if (focus >= 0) { const c = r.querySelector(`.sl-prow[data-i="${focus}"]`); if (c) { c.classList.add("focus"); setTimeout(() => c.scrollIntoView({ block: "center" }), 60); } focus = -1; }
    };
    strip(); list();
    if (!admin) return;
    r.querySelector("#sp-rows").addEventListener("input", e => { const t = e.target, i = Number(t.dataset.i), k = t.dataset.k; if (!k) return;
      if (k === "brightness") { rows[i].brightness = Number(t.value); t.previousElementSibling.querySelector("output").textContent = pctf(t.value); }
      else rows[i][k] = k === "kelvin" ? (t.value ? Number(t.value) : null) : t.value;
      const c = t.closest(".sl-prow"), [a, b] = rowColours(rows[i]); c.style.setProperty("--a", a); c.style.setProperty("--b", b); mark(); });
    r.querySelector("#sp-rows").addEventListener("change", e => e.target.dispatchEvent(new Event("input", { bubbles: true })));
    r.querySelector("#sp-rows").addEventListener("click", e => { const d = e.target.closest("[data-del]"); if (!d) return; rows.splice(Number(d.dataset.del), 1); list(); mark(); });
    r.querySelector("#sp-add").onclick = () => { const last = rows.at(-1); rows.push({ name: "New part", from: last ? last.to : "12:00", to: last ? last.from : "13:00", look: "white", palette: "auto", kelvin: 3000, brightness: 0.5 }); focus = rows.length - 1; list(); mark(); };
    r.querySelector("#sp-reset").onclick = () => { if (!confirm("Replace the plan with the suggested one?")) return; save({ plan: { reset: true } }, "Suggested plan").then(() => { dirty = false; rows = H.plan.rows.map(x => ({ ...x })); list(); strip(); r.querySelector("#sp-msg").textContent = "Suggested plan saved"; }); };
    r.querySelector("#sp-fade").onchange = e => save({ plan: { fade: Number(e.target.value) } }).then(() => paint());
    r.querySelector("#sp-save").onclick = () => save({ plan: { rows } }, "Plan saved").then(res => { if (!res) return; dirty = false; r.querySelector("#sp-msg").textContent = "Saved"; paint(); });
  }

  // ---------------------------------------------------------------- sheet: night mode
  function nightSheet() {
    const n = night(), loc = st().settings.location;
    const sh = openSheet({ title: "Night mode", body: `<div class="sl-sh">
      ${admin ? "" : `<p class="sl-locked">${icon("info")}Locked: unlock in Settings to change night mode.</p>`}
      <div class="sl-sh-card">${toggle("sn-on", "Calmer light at night", !!n.enabled, { hint: "A brightness cap, warm colours, no strobes or drop flashes" })}</div>
      <div class="sl-f2">
        <div class="field"><label for="sn-from">From</label><input id="sn-from" value="${esc(n.from || "")}" placeholder="23:00 or sunset"${dis}></div>
        <div class="field"><label for="sn-to">Until</label><input id="sn-to" value="${esc(n.to || "")}" placeholder="07:00 or sunrise"${dis}></div>
      </div>
      <p class="ui-meta">A time like 23:00, or sunset, sunrise, sunset+30, sunrise-15.</p>
      ${bigSlider("sn-max", "Brightness at night", n.maxBrightness ?? 0.3, { min: 0.05, max: 1, step: 0.05, format: pctf })}
      ${toggle("sn-warm", "Warm colours only", !!n.warm)}
      <div class="sl-sh-sec"><span class="ui-eyebrow">Location, for sunrise and sunset</span>
        <div class="sl-f2"><div class="field"><label for="sn-lat">Latitude</label><input id="sn-lat" type="number" step="0.0001" value="${loc?.lat ?? ""}"${dis}></div>
          <div class="field"><label for="sn-lon">Longitude</label><input id="sn-lon" type="number" step="0.0001" value="${loc?.lon ?? ""}"${dis}></div></div>
        <div class="sl-row"><button class="btn sm" id="sn-geo" type="button"${dis}>Use my location</button><button class="btn sm" id="sn-lsave" type="button"${dis}>Save the location</button></div>
        <span class="ui-meta" id="sn-help">${loc ? `Sunrise and sunset are worked out for ${esc(loc.lat)}, ${esc(loc.lon)}.` : "Needed for night mode and plan parts that start at sunset or sunrise."}</span></div>
    </div>` }), r = sh.body;
    if (!admin) { r.querySelectorAll("button.switch, .ui-bigs input").forEach(x => x.disabled = true); return; }
    const put = () => setS({ night: { enabled: r.querySelector("#sn-on").getAttribute("aria-checked") === "true", from: r.querySelector("#sn-from").value.trim(), to: r.querySelector("#sn-to").value.trim(), maxBrightness: Number(r.querySelector("#sn-max").value), warm: r.querySelector("#sn-warm").getAttribute("aria-checked") === "true" } });
    bindToggle(r, "sn-on", put); bindToggle(r, "sn-warm", put); bindBigSlider(r, "sn-max", { onChange: put });
    r.querySelector("#sn-from").onchange = put; r.querySelector("#sn-to").onchange = put;
    const lsave = () => setS({ location: r.querySelector("#sn-lat").value === "" ? null : { lat: Number(r.querySelector("#sn-lat").value), lon: Number(r.querySelector("#sn-lon").value) } }, "Location saved");
    r.querySelector("#sn-lsave").onclick = lsave;
    r.querySelector("#sn-geo").onclick = () => { const help = r.querySelector("#sn-help"); if (!navigator.geolocation) return toast("This browser can't share its location", true);
      help.textContent = "Asking the browser…";
      navigator.geolocation.getCurrentPosition(p => { r.querySelector("#sn-lat").value = p.coords.latitude.toFixed(4); r.querySelector("#sn-lon").value = p.coords.longitude.toFixed(4); lsave(); help.textContent = "Location saved."; },
        e => { help.textContent = `Couldn't get the location: ${e.message}. Type latitude and longitude instead (search the city name online).`; }, { timeout: 10000 }); };
  }

  // ---------------------------------------------------------------- sheet: the phone links
  function phoneSheet() {
    const sh = openSheet({ title: "Your phone's alarm", body: `<div class="sl-sh">
      ${DEMO ? `<p class="sl-locked">${icon("info")}In the online demo there's no server for a phone to call. On your own Tempolight it works like this.</p>` : ""}
      <p>Start the sunrise from an iPhone Shortcut or an Android automation (Tasker, Automate), or from Home Assistant. Set the wake-up to <b>Linked to my phone</b> so the weekly times don't start one too.</p>
      <div class="sl-url-g"><span class="ui-eyebrow">Start a sunrise</span><code class="sl-url" id="sp-u-wake">…</code></div>
      <div class="sl-url-g"><span class="ui-eyebrow">Snooze</span><code class="sl-url" id="sp-u-snooze">…</code></div>
      <div class="sl-url-g"><span class="ui-eyebrow">Stop</span><code class="sl-url" id="sp-u-stop">…</code></div>
      <p class="ui-meta">Method POST. Body (optional, JSON): <code>{"inMinutes": 30}</code> or <code>{"at": "07:00"}</code>, plus <code>"duration": 20</code>. ${admin ? "The key lets these calls through when Tempolight is locked with a PIN, and opens nothing else." : "Unlock to see the link key."}</p>
      <div class="sl-row">${admin ? `<button class="btn primary" id="sp-copy" type="button">Copy the start link</button><button class="btn" id="sp-new" type="button">Make a new key</button>` : ""}<a class="btn" href="${DOCS}" target="_blank" rel="noopener">Read the step-by-step guide</a></div>
    </div>` }), r = sh.body;
    const links = async () => { const base = DEMO ? "http://tempolight.local:8080" : await guestUrl(""), k = H.wake.key ? `?key=${H.wake.key}` : "";
      for (const [id, p] of [["#sp-u-wake", "/api/wake"], ["#sp-u-snooze", "/api/wake/snooze"], ["#sp-u-stop", "/api/wake/stop"]]) { const e = r.querySelector(id); if (e) e.textContent = `POST ${base}${p}${k}`; }
      const c = r.querySelector("#sp-copy"); if (c) c.onclick = () => navigator.clipboard?.writeText(`${base}/api/wake${k}`).then(() => toast("Copied"), () => toast("Couldn't copy: select the text instead", true)); };
    links();
    const n = r.querySelector("#sp-new"); if (n) n.onclick = async () => { if (!confirm("Make a new key? Phone automations with the old one stop working until you update them.")) return;
      const x = await act(() => api("POST", "/api/wake/key", {})).catch(() => null); if (x) { H.wake.key = x.key; links(); toast("New key made"); } };
  }

  load().catch(e => { el.innerHTML = `<div class="ui-screen sl"><div class="ui-card">${`<div class="ui-empty"><h3>Couldn't load Home and sleep</h3><p>${esc(e.message)}</p></div>`}</div></div>`; });
  tick = setInterval(() => { const n = $("#sl-now"); if (n) n.style.left = `${(nowMin() / 1440 * 100).toFixed(2)}%`; }, 30000);
  return {
    onStatus,
    onChanged(w) { if (gone) return; if (w.has("lock")) { load().catch(() => {}); return; }
      if (w.has("home")) api("GET", "/api/home").then(r => { H = r; if (!document.querySelector(".ui-sheet-wrap")) paint(); else repaint(); }).catch(() => {}); else repaint(); },
    destroy() { gone = true; clearInterval(tick); },
  };
}
