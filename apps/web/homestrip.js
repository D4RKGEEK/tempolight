// The small strip on the Home page: "Sleep in 30 min", and Snooze / Stop while a sunrise runs. Kept apart from the
// Home & sleep page (homesleep.js), which is only loaded when that page is opened.
import { api, act, $ } from "/app.js";

export const hm = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
export const when = iso => { if (!iso) return ""; const d = new Date(iso), today = new Date(), tm = new Date(); tm.setDate(tm.getDate() + 1);
  const day = d.toDateString() === today.toDateString() ? "today" : d.toDateString() === tm.toDateString() ? "tomorrow" : d.toLocaleDateString([], { weekday: "long" }); return `${day} ${hm(iso)}`; };
export const mins = s => s >= 60 ? `${Math.floor(s / 60)} min` : `${s} s`;

let styled = false;
function style() { if (styled) return; styled = true; const s = document.createElement("style"); s.textContent = `
.hs-strip { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line-2); font-size: 12.5px; }
.hs-strip .faint { flex: 1 1 100%; }`; document.head.appendChild(s); }

/** One line about what is going on, for the page and the Home strip. */
export function nowText(h) {
  if (!h) return "";
  const w = h.wake, sl = h.sleep, out = [];
  if (w) out.push(w.phase === "pending" ? `Sunrise from ${hm(w.start)}, full light at ${hm(w.end)}` : w.phase === "snoozed" ? `Sunrise snoozed until ${hm(w.snoozeUntil)}` : w.phase === "holding" ? "Sunrise: full light" : w.phase === "ending" ? "Sunrise ending" : `Sunrise ${Math.round(w.progress * 100)}%, full at ${hm(w.end)}`);
  if (sl) out.push(`Sleep timer: off in ${mins(sl.left)}`);
  if (!w && h.nextWake) out.push(`Next wake-up ${when(h.nextWake)}`);
  return out.join(" · ");
}

// ---------------------------------------------------------------- the strip on the Home page
export function homeStrip() { style(); return `<div class="hs-strip" id="hs-strip"><span class="faint" id="hs-strip-t"></span>
  <button class="btn sm" id="hs-sleep" type="button">Sleep in 30 min</button><button class="btn sm" id="hs-sleepx" type="button" hidden>Cancel sleep timer</button>
  <button class="btn sm" id="hs-snooze" type="button" hidden>Snooze</button><button class="btn sm" id="hs-stop" type="button" hidden>Stop sunrise</button><a class="btn sm" href="#/sleep">Home &amp; sleep</a></div>`; }
export function bindHomeStrip() {
  if (!$("#hs-strip")) return;
  $("#hs-sleep").onclick = () => act(() => api("POST", "/api/sleep", { minutes: 30 }), "The lights fade out over 30 minutes").catch(() => {});
  $("#hs-sleepx").onclick = () => act(() => api("DELETE", "/api/sleep"), "Sleep timer cancelled").catch(() => {});
  $("#hs-snooze").onclick = () => act(() => api("POST", "/api/wake/snooze", {}), "Snoozed").catch(() => {});
  $("#hs-stop").onclick = () => act(() => api("POST", "/api/wake/stop", {}), "Sunrise stopped").catch(() => {});
}
export function updateHomeStrip(m) {
  const h = m.home; if (!h || !$("#hs-strip")) return; const w = h.wake, running = w && w.phase !== "pending" && w.phase !== "ending";
  $("#hs-strip-t").textContent = nowText(h); $("#hs-sleep").hidden = !!h.sleep; $("#hs-sleepx").hidden = !h.sleep;
  $("#hs-snooze").hidden = !running; $("#hs-stop").hidden = !running;
}

