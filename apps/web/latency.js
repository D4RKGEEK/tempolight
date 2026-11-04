// The live latency meter in the web app: per device, the delay from a sound to its light (GET /api/status
// devices[].latencyMs, worked out on the server in packages/server/src/latency.js) and what may be wrong.
// Shown as a column and a panel on the Devices page, and as a badge on Home.
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICONS = { offline: svg("M6 6l12 12M18 6L6 18"), wifi: svg("M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01"),
  power: svg("M13 2L4 14h7l-1 8 9-12h-7z"), other: svg("M12 3l10 18H2zM12 10v5M12 18h.01") };
const icon = kind => ICONS[kind] || ICONS.other;

// the setup wizard and the meter share one small stylesheet
if (typeof document !== "undefined" && !document.querySelector('link[href="/setup.css"]')) {
  const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/setup.css"; document.head.appendChild(l);
}

export const fmtMs = ms => ms == null ? "–" : `${ms < 0 ? "−" : ""}${Math.abs(ms)} ms`;
/** What the delay is made of, for a tooltip. */
export function breakdown(h) {
  const p = h.latency; if (!p) return "";
  const parts = [p.audioMs ? `sound in ${p.audioMs}` : "", p.analysisMs ? `listening ${p.analysisMs}` : "", p.networkMs != null ? `network ${p.networkMs}` : "network ?", `frame ${p.frameMs}`, p.offsetMs ? `timing ${p.offsetMs > 0 ? "−" : "+"}${Math.abs(p.offsetMs)}` : ""].filter(Boolean);
  return parts.join(" + ").replace(/\+ timing −/, "− timing ") + " ms";
}
/** A small coloured delay chip for a table cell. */
export function latencyChip(h) {
  if (!h || h.latencyMs == null) return '<span class="lat none">–</span>';
  return `<span class="lat ${h.latencyLevel}" title="${esc(breakdown(h))}">${fmtMs(h.latencyMs)}</span>`;
}
/** Warning icons for a status cell (the text is in the title and the panel). */
export function warnIcons(h) {
  return (h?.warnings || []).filter(w => w.kind !== "offline").map(w => `<span class="latwarn" title="${esc(w.text)}" aria-label="${esc(w.text)}">${icon(w.kind)}</span>`).join("");
}
/** The slowest working device and how many warnings there are: for the Home badge. */
export function summary(status, devices) {
  const on = new Set(devices.filter(d => d.enabled !== false).map(d => d.id)), list = (status?.devices || []).filter(h => on.has(h.id));
  const worst = list.filter(h => h.latencyMs != null).sort((a, b) => Math.abs(b.latencyMs) - Math.abs(a.latencyMs))[0] || null;
  return { worst, warnings: list.reduce((n, h) => n + (h.warnings?.length || 0), 0) };
}
export function homeBadge(status, devices) {
  const { worst, warnings } = summary(status, devices);
  if (!worst && !warnings) return "";
  const cls = warnings ? "warn" : worst.latencyLevel === "good" ? "live" : worst.latencyLevel === "ok" ? "warn" : "err";
  return `<a class="badge ${cls}" href="#/devices" id="h-latb" title="${esc(worst ? `Sound to light: ${breakdown(worst)}` : "")}"><i></i>${worst ? `Delay ${fmtMs(worst.latencyMs)}` : ""}${warnings ? `${worst ? " · " : ""}${warnings} warning${warnings > 1 ? "s" : ""}` : ""}</a>`;
}
/** The "Sound to light" panel body on the Devices page. */
export function latencyPanel(status, devices) {
  const byId = new Map((status?.devices || []).map(h => [h.id, h]));
  if (!devices.length) return '<p class="faint">Add a light to see its delay.</p>';
  const scale = 150; // ms at the end of the bar
  return `<div class="latlist">${devices.map(d => { const h = byId.get(d.id) || {}, ms = h.latencyMs, w = ms == null ? 0 : Math.min(100, Math.abs(ms) / scale * 100);
    return `<div class="latrow" data-lat="${esc(d.id)}"><div class="latname"><b>${esc(d.name)}</b>${d.enabled === false ? ' <span class="faint">off</span>' : ""}</div>
      <div class="latbar ${h.latencyLevel || "none"}" title="${esc(breakdown(h))}"><i style="width:${w}%"></i></div><div class="latms ${h.latencyLevel || "none"}">${fmtMs(ms)}</div>
      ${h.latency ? `<div class="latparts faint">${esc(breakdown(h))}${ms != null && ms < 0 ? " (light comes a little early)" : ""}</div>` : ""}
      ${(h.warnings || []).map(x => `<div class="latw ${x.kind === "offline" ? "err" : "warn"}">${icon(x.kind)}${esc(x.text)}</div>`).join("")}</div>`; }).join("")}</div>
    <p class="faint latnote">Green is under 40 ms, which nobody notices. Speakers add their own delay (Bluetooth a lot): <a href="#/music">fix the timing</a> once and it's taken care of.</p>`;
}
