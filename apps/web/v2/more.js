// More (design/dashboard-v2.md): everything that isn't on the four screens, as a grid of cards that open the pages
// that hold it (the v1 renderers at their routes), plus Set up with Claude, the docs and About.
import { app, esc, DEMO } from "/app.js";
import { icon } from "/v2/shell.js";

const CARDS = [
  { href: "#/sleep", ic: "moon", t: "Home and sleep", d: "Everyday light through the day, a sunrise alarm and night mode." },
  { href: "#/integrations", ic: "plug", t: "Integrations", d: "Stream Deck, OBS, games, Twitch, Discord, Home Assistant and Apple Home." },
  { href: "#/scenes", ic: "clock", t: "Scenes and schedules", d: "Saved looks, and when they switch on by themselves." },
  { href: "#/settings", ic: "gear", t: "Settings", d: "Lighting defaults, performance, safety, the PIN lock and backups." },
  { id: "mo-claude", ic: "sparkle", t: "Set up with Claude", d: "A ready prompt that lets Claude install and set up Tempolight with you." },
  { href: "/docs/", ic: "help", t: "Help and docs", d: "Guides for every light, sound setup and the HTTP API.", ext: true },
];

export function render(el) {
  const v = app.state?.version || "";
  el.innerHTML = `<div class="ui-screen mo">
    <div class="mo-grid">${CARDS.map(c => {
      const inner = `<span class="mo-ic">${icon(c.ic)}</span><b>${esc(c.t)}</b><small>${esc(c.d)}</small><span class="mo-go">${icon("chevron")}</span>`;
      return c.id ? `<button class="ui-card mo-card" id="${c.id}" type="button">${inner}</button>`
        : `<a class="ui-card mo-card" href="${c.href}"${c.ext ? ' target="_blank" rel="noopener"' : ""}>${inner}</a>`; }).join("")}
    </div>
    <section class="mo-classic" aria-labelledby="mo-classic-h">
      <h2 class="ui-eyebrow" id="mo-classic-h">The classic pages</h2>
      <div class="mo-links">${[["#/home", "Home"], ["#/music", "Music"], ["#/effects", "Effects"], ["#/live", "Live pads and MIDI"], ["#/room", "Room"], ["#/devices", "Devices"], ["#/map", "Camera mapping"]]
        .map(([h, t]) => `<a href="${h}">${t}</a>`).join("")}</div>
    </section>
    <footer class="mo-about"><span>Tempolight ${esc(v ? "v" + v : "")}${DEMO ? ", the online demo" : ""}. Open source, MIT licence.</span><a href="#/settings/about">${DEMO ? "About this version" : "Check for updates"}</a></footer>
  </div>`;
  el.querySelector("#mo-claude").onclick = () => import("/claude-setup.js").then(m => m.openClaudeSetup()).catch(() => {});
  return {};
}

// (no stylesheet of its own: a few rules, kept here so More needs one request)
if (!document.getElementById("mo-css")) { const s = document.createElement("style"); s.id = "mo-css"; s.textContent = `
.mo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 20px; }
.mo-card { position: relative; display: grid; grid-template-columns: 48px minmax(0, 1fr) 20px; grid-template-rows: auto auto; column-gap: 16px; row-gap: 4px; align-items: center; padding: 22px 20px 22px 22px; border: 0; text-align: left; color: var(--text); font: inherit; cursor: pointer; min-height: 120px; }
.mo-ic { grid-row: 1 / 3; width: 48px; height: 48px; display: grid; place-items: center; border-radius: 14px; background: var(--sunk); box-shadow: inset 0 0 0 1px var(--hair); color: var(--label); }
.mo-ic .ui-ic { width: 22px; height: 22px; }
.mo-card b { font-size: 17px; font-weight: 600; letter-spacing: -0.02em; align-self: end; }
.mo-card small { grid-column: 2; font-size: 14px; color: var(--text-2); line-height: 1.45; align-self: start; }
.mo-go { grid-column: 3; grid-row: 1 / 3; color: var(--text-3); transition: transform var(--t-out) var(--ease); }
.mo-card:hover .mo-go { transform: translateX(2px); color: var(--text); }
.mo-about { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; padding: 0 4px; font-size: 13.5px; color: var(--text-3); }
.mo-classic { display: flex; flex-direction: column; gap: 10px; padding: 8px 4px 0; }
.mo-links { display: flex; flex-wrap: wrap; gap: 8px; }
.mo-links a { display: inline-flex; align-items: center; min-height: 36px; padding: 0 14px; border-radius: var(--r-pill); background: var(--sunk); box-shadow: inset 0 0 0 1px var(--hair); color: var(--text-2); text-decoration: none; font-size: 14px; font-weight: 500; }
.mo-links a:hover { color: var(--text); background: var(--surface); }
@media (max-width: 760px) { .mo-grid { grid-template-columns: minmax(0, 1fr); gap: 12px; } .mo-card { min-height: 0; padding: 18px 16px; } }`; document.head.appendChild(s); }
