// Lookahead mode in the hearing sheet (Songs → How it hears → This computer's sound): Tempolight plays the music to
// the speaker itself, a few seconds late, so the lights know what comes. The server side is
// packages/server/src/lookahead-mode.js (/api/lookahead).
import { api, act, esc, unlocked } from "/app.js";

const MARK = { ok: "✓", no: "✗", maybe: "?", todo: "○" };

/** @param {HTMLElement} el filled with the lookahead box; returns {destroy} */
export function mountLookahead(el) {
  if (!el) return null;
  let v = null, alive = true, painted = "";
  async function load() { try { v = await api("GET", "/api/lookahead"); } catch { v = null; } if (alive) paint(); }
  async function put(b) { const r = await act(() => api("PUT", "/api/lookahead", b)).catch(() => null); if (r) v = r; paint(true); }
  function paint(force) {
    if (!alive || !el.isConnected) return;
    if (!v) { el.innerHTML = ""; return; }
    const key = JSON.stringify([v.on, v.running, v.playing, v.delayMs, v.output, v.outputs, v.steps, v.error, v.why]);
    const ahead = el.querySelector("#la-ahead"); if (ahead) ahead.textContent = v.aheadMs != null ? `Hearing ahead: ${(v.aheadMs / 1000).toFixed(1)} s` : v.on ? "Starting…" : "";
    if (key === painted && !force) return; painted = key;
    const admin = unlocked(), dis = admin && v.supported ? "" : "disabled", sec = Math.round(v.delayMs / 1000);
    el.innerHTML = `<details class="hear-la" ${v.on ? "open" : ""}><summary><b>Lookahead mode</b> (best sync, music starts ${sec} s later)</summary>
      <div class="stack" style="margin-top:8px">
        <p class="muted">Tempolight plays the music to your speaker itself, ${sec} s late, while it already hears it. So drops are counted down for certain and build-ups land exactly on them.</p>
        <p class="callout warn">Not for video or games: everything you hear starts ${sec} s late.</p>
        ${v.why ? `<p class="callout warn">${esc(v.why)}</p>` : `
        ${v.steps?.length ? `<ol class="hear-steps">${v.steps.map(s => `<li class="${s.state}"><span class="mk" aria-hidden="true">${MARK[s.state] || "○"}</span><div><b>${esc(s.label)}</b>${s.detail ? `<small>${esc(s.detail)}</small>` : ""}</div></li>`).join("")}</ol>` : ""}
        <label class="setrow"><span><b>Lookahead mode</b><small id="la-ahead"></small></span><input type="checkbox" id="la-on" ${v.on ? "checked" : ""} ${dis}></label>
        <div class="field"><label for="la-out">Play to</label><select id="la-out" ${dis}><option value="">Automatic${v.outputs[0] ? ` (${esc(v.outputs[0].name)})` : ""}</option>${v.outputs.map(o => `<option value="${esc(o.id)}"${v.settings.output === o.id ? " selected" : ""}>${esc(o.name)}${o.bluetooth ? " (Bluetooth)" : ""}</option>`).join("")}</select></div>
        <div class="field"><label for="la-delay">Delay: <b id="la-dv">${sec} s</b></label><input type="range" id="la-delay" min="${v.limits.minMs / 1000}" max="${v.limits.maxMs / 1000}" step="1" value="${sec}" ${dis}></div>
        <div class="field"><label for="la-vol">Tempolight's volume</label><input type="range" id="la-vol" min="0" max="1.5" step="0.05" value="${v.volume}" ${dis}></div>
        ${v.error ? `<p class="callout warn">${esc(v.error)}</p>` : ""}
        ${v.platform === "darwin" ? `<p class="faint" style="font-size:13px">On a Mac: set System Settings → Sound → Output to <b>BlackHole 2ch</b> only (not the Multi-Output Device). Tempolight plays to your speaker. Turning lookahead off? Pick your Multi-Output Device again.</p>` : ""}`}
      </div></details>`;
    const q = s => el.querySelector(s);
    if (q("#la-on")) q("#la-on").onchange = e => put({ enabled: e.target.checked });
    if (q("#la-out")) q("#la-out").onchange = e => put({ output: e.target.value });
    if (q("#la-delay")) { q("#la-delay").oninput = e => { q("#la-dv").textContent = `${e.target.value} s`; }; q("#la-delay").onchange = e => put({ delayMs: Number(e.target.value) * 1000 }); }
    if (q("#la-vol")) q("#la-vol").onchange = e => put({ volume: Number(e.target.value) });
    paint();
  }
  load(); const timer = setInterval(() => { if (document.visibilityState !== "hidden") load(); }, 2500);
  return { load, destroy() { alive = false; clearInterval(timer); } };
}
