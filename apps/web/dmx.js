// Devices page: DMX fixtures over Art-Net / sACN. Add a universe (a DMX device), add fixtures to it (profile, address,
// name), turn lasers and fog on with their safety limits, and watch every channel's value live.
import { app, api, act, toast, esc, panel, opt, $, $$ } from "/app.js";

const KIND = { par: "Par", dimmer: "Dimmer", strobe: "Strobe", head: "Moving head", laser: "Laser", fog: "Fog" };
const MOVES = [["circle", "Circle"], ["figure8", "Figure 8"], ["sweep", "Sweep"], ["point", "Point at a place"], ["still", "Still"]];

/** The panel's HTML (filled in by mountDmx). */
export function dmxPanels() {
  const s = { lasers: false, fog: false, enabled: true, fogWhen: "before", fogLead: 4, fogBurst: 3, fogCooldown: 60, fogMaxDuty: 0.1, ...(app.state.settings.dmx || {}) };
  const num = (id, label, v, min, max, step, help = "") => `<div class="field"><label for="${id}">${label}</label><input type="number" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}" style="width:100px">${help ? `<span class="help">${help}</span>` : ""}</div>`;
  return panel("DMX fixtures", `<span id="x-st">Pars, moving heads, strobes, lasers and fog over Art-Net or sACN</span>`, `<label class="check"><input type="checkbox" id="x-on" ${s.enabled ? "checked" : ""}> DMX output on</label>`, `<div class="pb stack">
    <div class="row"><input id="x-host" placeholder="DMX node address, e.g. 192.168.1.60" style="max-width:260px" aria-label="DMX node address"><select id="x-proto" aria-label="DMX protocol" style="max-width:150px">${opt("artnet", "Art-Net", true)}${opt("e131", "sACN (E1.31)")}</select>
      <input id="x-univ" type="number" min="0" max="63999" placeholder="Universe" style="width:110px" aria-label="Universe"><input id="x-name" placeholder="Name (optional)" style="max-width:180px" aria-label="Name"><button class="btn primary" id="x-add" type="button">Add universe</button></div>
    <p class="faint" style="font-size:12.5px">Each DMX device is one universe on an Art-Net or sACN node (Art-Net counts universes from 0, sACN from 1). Every fixture is a point in the room, so the effects colour pars and moving heads like LEDs: drag the points on the Room page. Moving heads move on the beat and brighten on drops. Set your DMX node to <b>blackout when the signal is lost</b> (not “hold last look”), so nothing stays on if Tempolight stops.</p>
    <div class="controls">
      <label class="check"><input type="checkbox" id="x-las" ${s.lasers ? "checked" : ""}> Lasers (only during drops)</label>
      <label class="check"><input type="checkbox" id="x-fog" ${s.fog ? "checked" : ""}> Fog machine</label>
      <div class="field"><label for="x-when">Fog burst</label><select id="x-when">${opt("before", "Before a known drop (or at the drop)", s.fogWhen === "before")}${opt("drop", "At the drop", s.fogWhen === "drop")}</select></div>
      ${num("x-lead", "Seconds before the drop", s.fogLead, 0.5, 30, 0.5)}${num("x-burst", "Burst length (s)", s.fogBurst, 0.5, 10, 0.5)}
      ${num("x-cool", "Cool-down between bursts (s)", s.fogCooldown, 10, 900, 5)}${num("x-duty", "Most fog in 5 minutes (%)", Math.round(s.fogMaxDuty * 100), 1, 50, 1)}
      <div class="field"><span class="lbl">Manual fog</span><button class="btn" id="x-fogbtn" type="button" title="Fog while held (at most 10 s)">Hold for fog</button></div>
    </div>
    <p class="callout warn"><b>Lasers can damage eyes.</b> Use only lasers made for audiences, aimed above head height, and follow your local laser-safety rules. Tempolight turns them on only during drops, and never in photosensitive-safe mode, night mode, a blackout or with the lights off. Lasers and fog are off until you turn them on here.</p>
    <p class="callout warn"><b>Fog can set off smoke alarms</b> and makes floors slippery. Keep the duty-cycle limit low in small rooms and keep the room ventilated.</p>
    <div id="x-devs" class="stack"></div></div>`, "span-12");
}

function fixtureRow(d, f) {
  return `<tr><td><input value="${esc(f.name)}" data-xname="${d.id}:${f.id}" style="width:140px" aria-label="Fixture name"></td><td>${esc(KIND[f.kind] || f.kind)}<br><span class="faint mono" style="font-size:11px">${esc(f.profile)}</span></td>
    <td class="num"><input type="number" min="1" max="512" value="${f.address}" data-xaddr="${d.id}:${f.id}" style="width:70px" aria-label="DMX address"></td>
    <td>${f.kind === "head" ? `<select data-xmove="${d.id}:${f.id}" aria-label="Movement">${MOVES.map(([v, l]) => opt(v, l, (f.pattern || "circle") === v)).join("")}</select>${f.pattern === "point" ? ` <input placeholder="x, y" value="${f.target ? f.target.join(", ") : ""}" data-xtgt="${d.id}:${f.id}" style="width:70px" title="Where in the room (16 × 9, y = 0 at the top)" aria-label="Target">` : ""}` : '<span class="faint">–</span>'}</td>
    <td class="mono" style="font-size:11.5px" data-xlive="${d.id}:${f.id}">${liveCells(f)}</td><td><button class="btn sm danger" data-xdel="${d.id}:${f.id}" type="button">Remove</button></td></tr>`;
}
const liveCells = f => (f.live || []).map(c => `<span title="${esc(c.type)}" style="display:inline-block;min-width:66px">${c.n} ${esc(c.type)} <b>${c.value}</b></span>`).join(" ");

/** Fill the panel and keep its channel values live. Returns {destroy}. */
export function mountDmx(el) {
  let profiles = [], timer = null, gone = false;
  const set = b => act(() => api("PATCH", "/api/settings", { dmx: b }), "Saved").catch(() => {});
  async function load() {
    const [P, D] = await Promise.all([profiles.length ? null : api("GET", "/api/dmx/profiles"), api("GET", "/api/dmx")]); if (gone) return;
    if (P) profiles = P.profiles;
    $("#x-devs", el).innerHTML = D.devices.map(d => `<div class="stack" data-xdev="${d.id}"><div class="row"><b>${esc(d.name)}</b><span class="faint mono">${esc(d.host)} · ${d.protocol === "e131" ? "sACN" : "Art-Net"} universe ${d.universe}</span>${d.warnings.map(w => `<span class="badge warn">${esc(w)}</span>`).join("")}</div>
      <div class="row"><select data-xprof="${d.id}" aria-label="Fixture profile" style="max-width:240px">${profiles.map(p => opt(p.id, p.name, p.id === "rgb")).join("")}</select>
        <input type="number" min="1" max="512" placeholder="Address" data-xnaddr="${d.id}" style="width:90px" aria-label="DMX address" value="${nextAddr(d)}"><input placeholder="Name (optional)" data-xnname="${d.id}" style="max-width:160px" aria-label="Fixture name">
        <input placeholder="Channels, e.g. dimmer, red, green, blue, fixed:0" data-xch="${d.id}" style="max-width:320px;display:none" aria-label="Custom channels"><button class="btn primary" data-xadd="${d.id}" type="button">Add fixture</button></div>
      <div class="tablewrap"><table><thead><tr><th>Name</th><th>Kind</th><th class="num">Address</th><th>Movement</th><th>Channels now</th><th></th></tr></thead><tbody>${d.fixtures.map(f => fixtureRow(d, f)).join("") || '<tr><td colspan="6" class="faint">No fixtures yet</td></tr>'}</tbody></table></div></div>`).join("")
      || '<p class="faint">No DMX universes yet. Add one with the address of your Art-Net or sACN node.</p>';
    wire(); status(D);
  }
  const nextAddr = d => d.fixtures.reduce((a, f) => Math.max(a, f.address + f.live.length), 1);
  const ids = s => s.split(":");
  const patchF = (key, b) => { const [d, f] = ids(key); return act(() => api("PATCH", `/api/devices/${d}/fixtures/${f}`, b), "Saved").then(r => { r?.warnings?.forEach(w => toast(w, true)); }).catch(() => {}); };
  function wire() {
    $$("[data-xprof]", el).forEach(x => x.onchange = () => { $(`[data-xch="${x.dataset.xprof}"]`, el).style.display = x.value === "custom" ? "" : "none"; });
    $$("[data-xadd]", el).forEach(x => x.onclick = () => { const id = x.dataset.xadd, profile = $(`[data-xprof="${id}"]`, el).value;
      const body = { profile, address: Number($(`[data-xnaddr="${id}"]`, el).value) || 1, name: $(`[data-xnname="${id}"]`, el).value || undefined };
      if (profile === "custom") body.channels = $(`[data-xch="${id}"]`, el).value.split(/[,\s]+/).filter(Boolean);
      act(() => api("POST", `/api/devices/${id}/fixtures`, body), "Fixture added").then(r => r?.warnings?.forEach(w => toast(w, true))).catch(() => {}); });
    $$("[data-xname]", el).forEach(x => x.onchange = () => patchF(x.dataset.xname, { name: x.value }));
    $$("[data-xaddr]", el).forEach(x => x.onchange = () => patchF(x.dataset.xaddr, { address: Number(x.value) }));
    $$("[data-xmove]", el).forEach(x => x.onchange = () => patchF(x.dataset.xmove, x.value === "point" ? { pattern: "point", target: [8, 7] } : { pattern: x.value }));
    $$("[data-xtgt]", el).forEach(x => x.onchange = () => { const [a, b] = x.value.split(/[,\s]+/).map(Number); patchF(x.dataset.xtgt, { target: [a || 0, b || 0] }); });
    $$("[data-xdel]", el).forEach(x => x.onclick = () => { const [d, f] = ids(x.dataset.xdel); act(() => api("DELETE", `/api/devices/${d}/fixtures/${f}`), "Removed").catch(() => {}); });
  }
  function status(D) {
    const st = D.status, parts = [`Lasers: ${st.lasers.on ? "ON" : st.lasers.why || "off"}`, `Fog: ${st.fog.on ? "ON" : st.fog.why} (${Math.round(st.fog.duty * 100)}% of ${Math.round(st.fog.maxDuty * 100)}%)`];
    const t = $("#x-st", el); if (t && D.devices.length) t.textContent = parts.join(" · ");
    for (const d of D.devices) for (const f of d.fixtures) { const c = $(`[data-xlive="${d.id}:${f.id}"]`, el); if (c) c.innerHTML = liveCells(f); }
  }
  async function poll() { if (gone) return; try { const D = await api("GET", "/api/dmx"); if (!gone) status(D); } catch {} timer = setTimeout(poll, 300); }

  $("#x-add", el).onclick = () => act(() => api("POST", "/api/devices", { kind: "dmx", host: $("#x-host", el).value, protocol: $("#x-proto", el).value, universe: $("#x-univ", el).value === "" ? undefined : Number($("#x-univ", el).value), name: $("#x-name", el).value || undefined }), "DMX universe added").catch(() => {});
  $("#x-on", el).onchange = e => set({ enabled: e.target.checked });
  $("#x-las", el).onchange = e => { if (e.target.checked && !confirm("Turn lasers on?\n\nUse only lasers made for audiences, aimed above head height. Tempolight runs them only during drops, never in photosensitive-safe or night mode.")) { e.target.checked = false; return; } set({ lasers: e.target.checked }); };
  $("#x-fog", el).onchange = e => set({ fog: e.target.checked });
  $("#x-when", el).onchange = e => set({ fogWhen: e.target.value });
  for (const [id, k, f] of [["x-lead", "fogLead", Number], ["x-burst", "fogBurst", Number], ["x-cool", "fogCooldown", Number], ["x-duty", "fogMaxDuty", v => Number(v) / 100]]) $("#" + id, el).onchange = e => set({ [k]: f(e.target.value) });
  const fog = on => api("POST", "/api/action", { type: "fog", on }).catch(e => toast(e.message, true)), fb = $("#x-fogbtn", el);
  fb.onpointerdown = e => { e.preventDefault(); fb.setPointerCapture?.(e.pointerId); fb.classList.add("down"); fog(true); };
  fb.onpointerup = fb.onpointercancel = () => { if (fb.classList.contains("down")) { fb.classList.remove("down"); fog(false); } };
  load().then(poll).catch(e => { if (!gone) $("#x-devs", el).innerHTML = `<p class="faint">${esc(e.message)}</p>`; });
  return { destroy() { gone = true; clearTimeout(timer); } };
}
