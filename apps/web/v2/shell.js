// Dashboard v2 shell (design/dashboard-v2.md): the rail (desktop) / bottom tab bar (phone), the global top bar's
// Hearing chip, and the shared components every v2 screen uses. Styles: /v2/ui.css (loaded once by index.html).
//
// ---------------------------------------------------------------- the contract for screen modules
//   A screen is /v2/<name>.js exporting  render(el) → { destroy(), onStatus?(m), onFrame?(f), onChanged?(what:Set), onAudio?() }
//   (registered in app.js PAGES as lazyPage(() => import("/v2/<name>.js"), "render")). Sub-routes: #/<name>/<sub>;
//   read it with routeSub() below (e.g. #/songs/hear: the Hearing chip links there, Songs opens its "How it hears" sheet).
//   Helpers from "/app.js": app, api, act, toast, esc, $, $$, ws, panel, opt, createPreview, refreshState, loadLayout,
//   fmtTime, guestOk, unlocked, DEMO.  Screen CSS: ensureCss("/v2/<name>.css") once, at the top of render().
//
// ---------------------------------------------------------------- exports (all return HTML strings unless noted)
//   openSheet({ title, body, onClose, wide }) → { el, body, close }
//       A side sheet (from the right, desktop) / bottom sheet (phone ≤ 760px). body: an HTML string or a Node. el is the
//       sheet <section>, body its scrolling content. Esc, the scrim and the close button close it; focus is trapped
//       inside and goes back where it was. close() is safe to call twice; onClose runs once.
//   segmented(name, options:[{value,label}], value, { label }) → html          a segmented control (role radiogroup)
//   bindSegmented(root, name, onChange(value)) → { set(value), get() }         clicks + arrow keys; onChange only on user picks
//   bigSlider(id, label, value, { min=0, max=100, step=1, format=v=>v }) → html   a big touch slider (label and value inside)
//   bindBigSlider(root, id, { onInput(v), onChange(v) }) → { set(v), get() }    set() leaves it alone while it's dragged
//   toggle(id, label, checked, { hint }) → html                                a compact switch row (button role=switch)
//   bindToggle(root, id, onChange(checked)) → { set(checked) }
//   pill(text, state?) → html        state: "ok" | "warn" | "bad" | "accent" | "" (a status pill with a dot)
//   emptyState({ title, text, action }) → html    action: HTML for one primary button (or a few)
//   skeleton(lines = 3) → html       a loading placeholder
//   icon(name) → svg html            names: stage songs looks lights more close back play pause mic computer music heart
//                                    hide plus search check chevron folder bolt sparkle sliders clock home plug gear help info
//   ensureCss(href)                  adds <link rel=stylesheet> once
//   routeSub() → string | ""         the part after #/<screen>/ ("hear" for #/songs/hear)
//
// Shared CSS classes (ui.css): .ui-screen (a screen's column), .ui-card (+ .ui-card-h header, .ui-eyebrow), .ui-grid-3,
// .ui-stage (dark stage frame) .ui-np (now-playing bar), .ui-choice (big choice card, [aria-pressed=true] = picked),
// .ui-gallery + .ui-gcard (gallery card with .ui-thumb), .ui-list + .ui-row (list row with .ui-row-act), .ui-seg,
// .ui-bigs, .ui-toggle, .ui-pads + .ui-pad, .ui-pill, .ui-bar (sticky action bar), .ui-empty, .ui-skel, .ui-h2 (section title),
// .ui-meta (13px secondary text), .ui-swatches. Buttons are the app's .btn / .btn.primary / .btn.sm.
import { app, esc, $, $$ } from "/app.js";
import { hearLine } from "/hearline.js";

// ---------------------------------------------------------------- icons (24px, stroke)
const P = {
  stage: '<path d="M3 5h18v11H3z"/><path d="M8 20h8M12 16v4"/><circle cx="8" cy="10.5" r="1.4"/><circle cx="12" cy="10.5" r="1.4"/><circle cx="16" cy="10.5" r="1.4"/>',
  songs: '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  looks: '<path d="M12 3l2.4 5.6L20 11l-5.6 2.4L12 19l-2.4-5.6L4 11l5.6-2.4z"/>',
  lights: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>', back: '<path d="M15 5l-7 7 7 7"/>', chevron: '<path d="M9 5l7 7-7 7"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>', pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  computer: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  music: '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  hide: '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-3 3.4M6.6 6.6A16 16 0 0 0 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  bolt: '<path d="M13 3L5 13.5h6L10 21l9-11h-6z"/>', sparkle: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>', home: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
  plug: '<path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>', claude: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>',
};
export const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" class="ui-ic">${P[name] || ""}</svg>`;

export function ensureCss(href) {
  if ([...document.styleSheets].some(s => s.href && new URL(s.href).pathname === new URL(href, location.href).pathname) || document.querySelector(`link[data-ui="${href}"]`)) return;
  const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; l.dataset.ui = href; document.head.appendChild(l);
}
export const routeSub = () => (location.hash.match(/^#\/\w+\/([\w-]+)/) || [])[1] || "";

// ---------------------------------------------------------------- side / bottom sheet
const sheets = [];
export function openSheet({ title = "", body = "", onClose, wide = false } = {}) {
  const back = document.activeElement, id = "sh-" + Math.random().toString(36).slice(2, 8);
  const wrap = document.createElement("div"); wrap.className = "ui-sheet-wrap";
  wrap.innerHTML = `<div class="ui-scrim" data-close></div><section class="ui-sheet${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="${id}" tabindex="-1">
    <i class="ui-grab" aria-hidden="true"></i><header class="ui-sheet-h"><h2 id="${id}">${esc(title)}</h2><button class="iconbtn" type="button" data-close aria-label="Close">${icon("close")}</button></header>
    <div class="ui-sheet-b"></div></section>`;
  const el = wrap.querySelector(".ui-sheet"), b = wrap.querySelector(".ui-sheet-b");
  if (typeof body === "string") b.innerHTML = body; else if (body) b.appendChild(body);
  document.body.appendChild(wrap); document.documentElement.classList.add("ui-sheet-open");
  requestAnimationFrame(() => wrap.classList.add("in"));
  let closed = false;
  const focusables = () => [...el.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(x => x.offsetParent !== null);
  const key = e => {
    if (sheets[sheets.length - 1] !== api) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "Tab") { const f = focusables(); if (!f.length) { e.preventDefault(); el.focus(); return; }
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); } }
  };
  document.addEventListener("keydown", key, true);
  wrap.addEventListener("click", e => { if (e.target.closest("[data-close]")) close(); });
  function close() {
    if (closed) return; closed = true; document.removeEventListener("keydown", key, true);
    const k = sheets.indexOf(api); if (k >= 0) sheets.splice(k, 1); if (!sheets.length) document.documentElement.classList.remove("ui-sheet-open");
    wrap.classList.remove("in"); wrap.classList.add("out");
    const rm = () => wrap.remove(); if (matchMedia("(prefers-reduced-motion: reduce)").matches) rm(); else setTimeout(rm, 220);
    try { back?.focus?.({ preventScroll: true }); } catch {}
    onClose?.();
  }
  const api = { el, body: b, close }; sheets.push(api);
  setTimeout(() => { const f = focusables().find(x => !x.matches("[data-close]")); (f || el).focus({ preventScroll: true }); }, 30);
  return api;
}
/** Closes every open sheet (the router does this when the screen changes). */
export const closeSheets = () => [...sheets].reverse().forEach(s => s.close());

// ---------------------------------------------------------------- segmented control
export const segmented = (name, options, value, { label = "" } = {}) =>
  `<div class="ui-seg" role="radiogroup" data-seg="${esc(name)}"${label ? ` aria-label="${esc(label)}"` : ""}>${options.map(o =>
    `<button type="button" role="radio" data-v="${esc(o.value)}" aria-checked="${String(o.value) === String(value)}" tabindex="${String(o.value) === String(value) ? 0 : -1}">${esc(o.label)}</button>`).join("")}</div>`;
export function setSegmented(root, name, value) {
  const g = root.querySelector(`[data-seg="${name}"]`); if (!g) return;
  for (const b of g.querySelectorAll("[data-v]")) { const on = b.dataset.v === String(value); b.setAttribute("aria-checked", on); b.tabIndex = on ? 0 : -1; }
}
export function bindSegmented(root, name, onChange) {
  const g = root.querySelector(`[data-seg="${name}"]`), get = () => g?.querySelector('[aria-checked="true"]')?.dataset.v ?? null;
  if (!g) return { set() {}, get };
  const pick = b => { if (!b || b.disabled) return; const was = get(); setSegmented(root, name, b.dataset.v); b.focus(); if (b.dataset.v !== was) onChange?.(b.dataset.v); };
  g.addEventListener("click", e => pick(e.target.closest("[data-v]")));
  g.addEventListener("keydown", e => { const bs = [...g.querySelectorAll("[data-v]")], i = bs.indexOf(document.activeElement); if (i < 0) return;
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return; e.preventDefault(); pick(bs[(i + d + bs.length) % bs.length]); });
  return { set: v => setSegmented(root, name, v), get };
}

// ---------------------------------------------------------------- big slider
const fmts = new Map();
const pct = (v, min, max) => `${((v - min) / (max - min || 1)) * 100}%`;
export function bigSlider(id, label, value, { min = 0, max = 100, step = 1, format = v => String(v) } = {}) {
  fmts.set(id, format);
  return `<div class="ui-bigs" style="--p:${pct(value, min, max)}"><input type="range" id="${esc(id)}" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${esc(label)}">
    <span class="ui-bigs-l" aria-hidden="true">${esc(label)}</span><output for="${esc(id)}" class="ui-bigs-v">${esc(format(Number(value)))}</output></div>`;
}
export function bindBigSlider(root, id, { onInput, onChange } = {}) {
  const r = root.querySelector("#" + id); if (!r) return { set() {}, get: () => null };
  const box = r.closest(".ui-bigs"), out = box.querySelector("output"), f = () => fmts.get(id) || (v => String(v));
  const paint = () => { box.style.setProperty("--p", pct(Number(r.value), Number(r.min), Number(r.max))); out.textContent = f()(Number(r.value)); };
  let dragging = false;
  r.addEventListener("pointerdown", () => dragging = true); addEventListener("pointerup", () => dragging = false);
  r.addEventListener("input", () => { paint(); onInput?.(Number(r.value)); });
  r.addEventListener("change", () => { dragging = false; paint(); onChange?.(Number(r.value)); });
  return { set(v) { if (dragging || document.activeElement === r && dragging) return; if (v == null || Number(r.value) === Number(v)) return; r.value = v; paint(); }, get: () => Number(r.value) };
}

// ---------------------------------------------------------------- toggle row
export const toggle = (id, label, checked, { hint = "" } = {}) =>
  `<div class="ui-toggle"><span><b id="${esc(id)}-l">${esc(label)}</b>${hint ? `<small>${esc(hint)}</small>` : ""}</span><button class="switch" id="${esc(id)}" type="button" role="switch" aria-checked="${!!checked}" aria-labelledby="${esc(id)}-l"></button></div>`;
export function bindToggle(root, id, onChange) {
  const b = root.querySelector("#" + id); if (!b) return { set() {} };
  b.addEventListener("click", () => { const v = b.getAttribute("aria-checked") !== "true"; b.setAttribute("aria-checked", v); onChange?.(v); });
  return { set: v => b.setAttribute("aria-checked", !!v) };
}

// ---------------------------------------------------------------- small pieces
export const pill = (text, state = "") => `<span class="ui-pill${state ? " " + state : ""}"><i></i>${esc(text)}</span>`;
export const emptyState = ({ title = "", text = "", action = "" } = {}) =>
  `<div class="ui-empty">${title ? `<h3>${esc(title)}</h3>` : ""}${text ? `<p>${esc(text)}</p>` : ""}${action ? `<div class="ui-empty-a">${action}</div>` : ""}</div>`;
export const skeleton = (lines = 3) => `<div class="ui-skel" aria-hidden="true">${"<i></i>".repeat(lines)}</div>`;

// ---------------------------------------------------------------- the rail / tab bar and the top bar (used by app.js)
export const NAV = [["stage", "Stage"], ["songs", "Songs"], ["looks", "Looks"], ["lights", "Lights"], ["more", "More"]];
// which tab an older (v1) page belongs to; those pages still open at their routes, reached from the new screens or More
const NAV_OF = { home: "stage", live: "stage", music: "songs", timeline: "songs", effects: "looks", scenes: "looks",
  room: "lights", devices: "lights", map: "lights", sleep: "more", integrations: "more", settings: "more" };
export const navOf = name => NAV.some(n => n[0] === name) ? name : NAV_OF[name] || "stage";
export const isV2 = name => NAV.some(n => n[0] === name);

export function navHtml() {
  return NAV.map(([id, label]) => `<a href="#/${id}" data-page="${id}">${icon(id)}<span>${label}</span></a>`).join("");
}
/** Called by the router: marks the tab, sets the back link of an older page (it goes back to its screen). */
export function shellRoute(name) {
  const tab = navOf(name), back = $("#back");
  $$("#nav a, #tabs a").forEach(a => a.toggleAttribute("aria-current", a.dataset.page === tab));
  if (back) { back.hidden = isV2(name); if (!back.hidden) { back.href = `#/${tab}`; back.setAttribute("aria-label", `Back to ${NAV.find(n => n[0] === tab)[1]}`); } }
  document.body.dataset.screen = isV2(name) ? name : "v1";
  closeSheets();
}
/** The Hearing chip: "Hearing this computer", "Spotify · Song", "Not listening". */
export function shellStatus(m) {
  const chip = $("#hchip"); if (!chip) return; const l = hearLine(m);
  const text = (l.text || "Not listening").replace(/ ✓/g, "").replace(/^Playing /, "Playing ");
  chip.dataset.state = l.ok === true ? "ok" : l.ok === false ? "bad" : "idle";
  const t = $("#hchip-t"); if (t.textContent !== text) t.textContent = text; chip.title = l.why || text;
}
