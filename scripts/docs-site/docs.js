// The docs site's one script (scripts/build-docs-site.js): theme, phone menu, sidebar groups, "On this page" scroll-spy,
// copy buttons, tabs, the search modal (⌘K / Ctrl+K / "/"), Mermaid diagrams and the API reference's Try it panel.
const ICONS = __ICONS__;
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const root = document.documentElement;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
$$("[data-mod]").forEach(el => { el.textContent = isMac ? "⌘" : "Ctrl"; });

// ---------------------------------------------------------------- theme
$$("[data-theme-toggle]").forEach(b => b.addEventListener("click", () => {
  const t = root.dataset.theme === "light" ? "dark" : "light"; root.dataset.theme = t; store.set("tl-docs-theme", t); drawMermaid();
}));
// a Mermaid diagram full size, in an overlay
function zoom(pre) {
  const svg = pre.querySelector("svg"); if (!svg) return;
  const o = document.createElement("div"); o.className = "mzoom"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "Diagram");
  o.innerHTML = `<button class="icon-btn mzoom-close" type="button" aria-label="Close">${ICONS.x}</button><div class="mzoom-inner"></div>`;
  const c = svg.cloneNode(true); c.style.maxWidth = "none"; c.style.width = parseFloat(svg.style.maxWidth) + "px"; c.removeAttribute("height"); o.querySelector(".mzoom-inner").appendChild(c);
  const close = () => { o.remove(); document.removeEventListener("keydown", esc, true); document.body.style.overflow = ""; }, esc = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  o.addEventListener("click", e => { if (e.target === o || e.target.closest(".mzoom-close")) close(); }); document.addEventListener("keydown", esc, true);
  document.body.appendChild(o); document.body.style.overflow = "hidden";
}

// ---------------------------------------------------------------- phone menu (full screen)
const menuBtn = $("[data-menu]"), scrim = $("[data-scrim]");
function menu(open) { if (open && !document.body.classList.contains("menu-open")) { const sb = $(".sidebar"); if (sb) sb.scrollTop = 0; } document.body.classList.toggle("menu-open", open); if (scrim) scrim.hidden = true; menuBtn?.setAttribute("aria-expanded", String(open)); menuBtn?.setAttribute("aria-label", open ? "Close the menu" : "Open the menu"); }
matchMedia("(min-width: 961px)").addEventListener?.("change", e => { if (e.matches) menu(false); });
menuBtn?.addEventListener("click", () => menu(!document.body.classList.contains("menu-open")));
scrim?.addEventListener("click", () => menu(false));
$$(".sidebar a").forEach(a => a.addEventListener("click", () => menu(false)));

// ---------------------------------------------------------------- sidebar: collapsible groups, the current page in view
$$(".nav-group-title").forEach(b => b.addEventListener("click", () => {
  const open = b.getAttribute("aria-expanded") !== "true"; b.setAttribute("aria-expanded", String(open)); document.getElementById(b.getAttribute("aria-controls")).hidden = !open;
}));
const active = $(".sidebar .nav-item.active");
if (active && matchMedia("(min-width: 961px)").matches) { const sb = $(".sidebar"), r = active.getBoundingClientRect(), s = sb.getBoundingClientRect(); if (r.bottom > s.bottom - 40 || r.top < s.top) sb.scrollTop += r.top - s.top - s.height / 3; }

// ---------------------------------------------------------------- "On this page"
const tocLinks = $$(".toc a[data-id]");
if (tocLinks.length) {
  const heads = tocLinks.map(a => document.getElementById(a.dataset.id)).filter(Boolean);
  let raf = 0;
  const spy = () => { raf = 0; const y = ($(".top")?.getBoundingClientRect().bottom || 110) + 40; let cur = heads[0];
    for (const h of heads) { if (h.getBoundingClientRect().top - y <= 0) cur = h; else break; }
    if (innerHeight + scrollY >= document.body.scrollHeight - 4) cur = heads[heads.length - 1];
    tocLinks.forEach(a => a.classList.toggle("active", a.dataset.id === cur?.id)); };
  addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(spy); }, { passive: true }); spy();
}

// ---------------------------------------------------------------- copy buttons
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); } catch {} t.remove(); }
  btn.classList.add("done"); setTimeout(() => btn.classList.remove("done"), 1400);
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-copy], [data-copy-text]"); if (!b) return;
  if (b.dataset.copyText !== undefined) return copy(b.dataset.copyText, b);
  const box = b.closest(".code"), pre = box && ([...box.querySelectorAll("pre")].find(p => !p.hidden) || box.querySelector("pre")); if (pre) copy(pre.innerText.replace(/\n$/, ""), b);
});

// ---------------------------------------------------------------- tabs (components and code groups; the choice is remembered and shared)
function selectTab(group, k) {
  const tabs = $$(":scope > .tab-list > [role=tab], :scope > .code-head > [role=tab]", group), panels = $$(":scope > [role=tabpanel]", group);
  tabs.forEach((t, i) => t.setAttribute("aria-selected", String(i === k))); panels.forEach((p, i) => { p.hidden = i !== k; });
}
document.addEventListener("click", e => {
  const t = e.target.closest("[data-tabs] [role=tab]"); if (!t) return;
  const group = t.closest("[data-tabs]"), list = [...t.parentElement.children], k = list.indexOf(t), label = t.textContent.trim();
  selectTab(group, k);
  if (group.classList.contains("code-group")) { store.set("tl-docs-lang", label); $$(".code-group[data-tabs]").forEach(g => { if (g === group) return; const i = $$(":scope > .code-head > [role=tab]", g).findIndex(x => x.textContent.trim() === label); if (i >= 0) selectTab(g, i); }); }
});
{ const pref = store.get("tl-docs-lang"); if (pref) $$(".code-group[data-tabs]").forEach(g => { const i = $$(":scope > .code-head > [role=tab]", g).findIndex(x => x.textContent.trim() === pref); if (i > 0) selectTab(g, i); }); }

// ---------------------------------------------------------------- was this page helpful?
$$("[data-feedback]").forEach(f => f.addEventListener("click", e => {
  const b = e.target.closest("[data-fb]"); if (!b) return;
  $$("button", f).forEach(x => { x.hidden = true; }); f.firstElementChild.hidden = true;
  (b.dataset.fb === "yes" ? $(".feedback-thanks", f) : $(".feedback-issue", f)).hidden = false;
}));

// ---------------------------------------------------------------- search
const modal = $("[data-search-modal]"), input = $("[data-search-input]"), results = $("[data-search-results]");
let index = null, hits = [], sel = 0, lastFocus = null;
async function loadIndex() {
  if (index) return index;
  const r = await fetch("/docs/search.json"); const pages = await r.json(); index = [];
  for (const p of pages) {
    const page = { title: p.t, url: p.u, crumb: p.g, text: p.d || "", kind: p.m ? "api" : "page", method: p.m, path: p.p, page: p.t }; index.push(page);
    for (const [h, id, text] of p.s || []) if (h) index.push({ title: h, url: p.u + "#" + id, crumb: `${p.g} · ${p.t}`, text, kind: "hash", page: p.t });
      else if (text) page.text = text.startsWith(page.text.slice(0, 60)) ? text : `${page.text} ${text}`.trim(); // the description is often the intro itself
  }
  for (const e of index) { e.ref = e.url.startsWith("/docs/api-reference/"); e.lt = e.title.toLowerCase(); e.lx = e.text.toLowerCase(); e.lp = `${e.method || ""} ${e.path || ""}`.toLowerCase(); e.lc = e.crumb.toLowerCase(); }
  return index;
}
// a term scores by where it is found: the title (best at the start of a word), the path, the breadcrumb, the text;
// a title that only matches as a subsequence ("spfy" -> "Spotify") scores a little
function fuzzy(t, s) { let i = 0; for (const c of s) { if (c === t[i]) i++; if (i === t.length) return true; } return false; }
function score(e, terms) {
  let total = 0;
  for (const t of terms) {
    let s = 0; const ti = e.lt.indexOf(t);
    if (ti === 0) s = 12; else if (ti > 0) s = /[\s\-/(]/.test(e.lt[ti - 1]) ? 9 : 6;
    else if (e.lp.includes(t)) s = 7; else if (e.lc.includes(t)) s = 3; else if (e.lx.includes(t)) s = 2 + Math.min(2, (e.lx.split(t).length - 1) * .5);
    else if (t.length > 2 && fuzzy(t, e.lt)) s = 1.5; else return 0;
    total += s;
  }
  if (e.kind === "page" || e.kind === "api") total += 4; // a whole page before one of its sections if (e.lt === terms.join(" ")) total += 3;
  return e.ref ? total * 0.65 : total; // guides before the API reference when both match
}
function mark(text, terms) {
  let out = escHtml(text); for (const t of terms) { if (t.length < 2) continue; out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![^<]*>)`, "gi"), "<mark>$1</mark>"); } return out;
}
function snippet(text, terms) {
  if (!text) return ""; const lx = text.toLowerCase(); let at = -1; for (const t of terms) { at = lx.indexOf(t); if (at >= 0) break; }
  if (at < 60) return text.slice(0, 160); return "…" + text.slice(Math.max(0, at - 50), at + 110);
}
async function runSearch() {
  const q = input.value.trim().toLowerCase(), terms = q.split(/\s+/).filter(Boolean);
  if (!terms.length) { results.innerHTML = `<div class="search-empty">Search guides, the API and how Tempolight works inside.</div>`; hits = []; return; }
  await loadIndex();
  hits = index.map(e => ({ e, s: score(e, terms) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 40).map(x => x.e);
  { const groups = new Map(); for (const e of hits) { const g = e.ref ? "API reference" : e.crumb.split(" · ")[0]; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(e); } hits = [...groups.values()].flat(); } // one heading per section, the best first
  if (!hits.length) { results.innerHTML = `<div class="search-empty">No results for “${escHtml(input.value.trim())}”.</div>`; return; }
  sel = 0; let group = "";
  results.innerHTML = hits.map((e, k) => { const g = e.ref ? "API reference" : e.crumb.split(" · ")[0]; const head = g !== group ? `<div class="search-group">${escHtml((group = g))}</div>` : "";
    return `${head}<a class="search-hit" role="option" id="hit-${k}" href="${e.url}" aria-selected="${k === 0}"><span class="hit-icon">${e.kind === "api" ? ICONS.api : e.kind === "hash" ? ICONS.hash : ICONS.file}</span><span class="hit-text"><span class="hit-title">${e.method ? `<span class="method method-${e.method.toLowerCase()} sm">${e.method === "DELETE" ? "DEL" : e.method}</span>` : ""}<span>${mark(e.title, terms)}</span></span><span class="hit-crumb">${escHtml(e.kind === "api" ? e.path : e.crumb)}</span>${e.text ? `<span class="hit-snip">${mark(snippet(e.text, terms), terms)}</span>` : ""}</span><span class="hit-enter">${ICONS.enter}</span></a>`; }).join("");
}
function move(d) { if (!hits.length) return; sel = (sel + d + hits.length) % hits.length; $$(".search-hit", results).forEach((h, k) => h.setAttribute("aria-selected", String(k === sel))); $(`#hit-${sel}`)?.scrollIntoView({ block: "nearest" }); }
function openSearch() { if (!modal) return; lastFocus = document.activeElement; modal.hidden = false; document.body.style.overflow = "hidden"; input.select(); input.focus(); runSearch(); loadIndex().catch(() => {}); }
function closeSearch() { modal.hidden = true; document.body.style.overflow = ""; lastFocus?.focus?.(); }
$$("[data-search]").forEach(b => b.addEventListener("click", openSearch));
modal?.addEventListener("click", e => { if (e.target === modal) closeSearch(); });
input?.addEventListener("input", runSearch);
input?.addEventListener("keydown", e => {
  if (e.key === "ArrowDown") { e.preventDefault(); move(1); } else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (e.key === "Enter") { const h = hits[sel]; if (h) { e.preventDefault(); closeSearch(); location.href = h.url; } }
});
results?.addEventListener("click", e => { if (e.target.closest(".search-hit")) closeSearch(); });
document.addEventListener("keydown", e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); modal.hidden ? openSearch() : closeSearch(); }
  else if (e.key === "/" && !typing && modal.hidden) { e.preventDefault(); openSearch(); }
  else if (e.key === "Escape") { if (!modal.hidden) closeSearch(); else if (tryEl && !tryEl.hidden) closeTry(); else menu(false); }
});

// ---------------------------------------------------------------- Mermaid (the official build, loaded only on pages with a diagram)
const mermaidCfg = $("#mermaid-src") ? JSON.parse($("#mermaid-src").textContent) : null;
let mermaidLib = null, drawn = 0;
async function drawMermaid() {
  const blocks = $$("pre.mermaid"); if (!blocks.length || !mermaidCfg) return;
  try { mermaidLib ||= (await import(mermaidCfg.url)).default; } catch (e) { console.warn("Mermaid could not be loaded", e); return; }
  const dark = root.dataset.theme !== "light", css = getComputedStyle(root), v = n => css.getPropertyValue(n).trim();
  mermaidLib.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", fontFamily: v("--sans") || "system-ui, sans-serif",
    flowchart: { curve: "basis", padding: 12, nodeSpacing: 28, rankSpacing: 38, htmlLabels: true }, sequence: { useMaxWidth: true },
    // warm neutrals from design/tokens.md: nodes on the sunk ground with a hairline, the accent only on the lines' ends
    themeVariables: { darkMode: dark, fontSize: "14px", background: "transparent", primaryColor: dark ? "#1e1a14" : "#f3eee7", primaryBorderColor: dark ? "#3a332a" : "#e2d8cb", primaryTextColor: v("--text"),
      secondaryColor: dark ? "#17140f" : "#fffaf6", tertiaryColor: dark ? "#0b0a08" : "#ffffff", lineColor: dark ? "#6e6458" : "#b3a594", textColor: v("--text"),
      clusterBkg: dark ? "#0b0a08" : "#fbf8f3", clusterBorder: dark ? "#2a251e" : "#ebe3d8", edgeLabelBackground: dark ? "#17140f" : "#ffffff",
      nodeTextColor: v("--text"), actorBkg: dark ? "#1e1a14" : "#f3eee7", actorBorder: dark ? "#3a332a" : "#e2d8cb", noteBkgColor: dark ? "#2a2014" : "#fff1e4", noteTextColor: v("--text") } });
  const gen = ++drawn;
  for (const [k, pre] of blocks.entries()) {
    try { const { svg } = await mermaidLib.render(`mmd-${gen}-${k}`, pre.dataset.src); if (gen !== drawn) return; pre.innerHTML = svg; pre.dataset.done = "1";
      // a wide diagram shrunk to the column gets small: it fits the page, and opens full size in an overlay
      const el = pre.querySelector("svg"), natural = parseFloat(el?.style.maxWidth || ""), wrap = pre.parentElement;
      if (el && natural > pre.clientWidth * 1.2 && !wrap.querySelector(".mermaid-zoom")) { wrap.classList.add("zoomable");
        const b = document.createElement("button"); b.type = "button"; b.className = "mermaid-zoom"; b.innerHTML = ICONS.expand + "<span>Full size</span>"; b.setAttribute("aria-label", "Show the diagram full size"); wrap.appendChild(b);
        b.addEventListener("click", () => zoom(pre)); pre.addEventListener("click", () => zoom(pre)); } }
    catch (e) { console.warn("Mermaid diagram failed", e); pre.textContent = pre.dataset.src; }
  }
}
drawMermaid();

// ---------------------------------------------------------------- Try it (API reference)
const tryData = $("#try-data") ? JSON.parse($("#try-data").textContent) : null;
let tryEl = null;
function closeTry() { if (tryEl) { tryEl.hidden = true; document.body.style.overflow = ""; } }
function curlFor(base, d, values, token, body) {
  const url = buildUrl(base, d, values);
  return [`curl ${d.method === "GET" ? "" : `-X ${d.method} `}'${url}'`, token ? `-H 'x-tempolight-token: ${token}'` : "", body ? `-H 'content-type: application/json'` : "", body ? `-d '${body.replace(/'/g, "'\\''").replace(/\s*\n\s*/g, " ")}'` : ""].filter(Boolean).join(" \\\n  ");
}
function buildUrl(base, d, values) {
  let p = d.path.replace(/\{(\w+)\}/g, (x, n) => encodeURIComponent(values[`path.${n}`] ?? n));
  const q = d.params.filter(x => x.in === "query" && values[`query.${x.name}`]).map(x => `${encodeURIComponent(x.name)}=${encodeURIComponent(values[`query.${x.name}`])}`).join("&");
  return base.replace(/\/+$/, "") + p + (q ? "?" + q : "");
}
function openTry() {
  const d = tryData; if (!d) return;
  if (!tryEl) {
    const base = store.get("tl-docs-base") || "http://localhost:8080"; let token = ""; try { token = sessionStorage.getItem("tl-docs-token") || ""; } catch {}
    tryEl = document.createElement("div"); tryEl.className = "try"; tryEl.setAttribute("role", "dialog"); tryEl.setAttribute("aria-modal", "true"); tryEl.setAttribute("aria-label", "Try this request");
    const params = d.params.filter(p => p.in !== "header");
    tryEl.innerHTML = `<div class="try-panel"><div class="try-head"><span class="method method-${d.method.toLowerCase()}">${d.method === "DELETE" ? "DEL" : d.method}</span><code>${escHtml(d.path)}</code><button class="icon-btn" type="button" data-try-close aria-label="Close">${ICONS.x}</button></div>
      <div class="try-body">
        <div class="try-row"><label>Tempolight's address<input data-k="base" value="${escHtml(base)}" spellcheck="false"><small>Where Tempolight runs. From this https page, browsers allow only http://localhost.</small></label>
          <label>Unlock token <input data-k="token" value="${escHtml(token)}" placeholder="${d.admin ? "Only while a PIN lock is set" : "Not needed"}" spellcheck="false"><small>Sent as x-tempolight-token (POST /api/unlock).</small></label></div>
        ${params.length ? `<div class="try-row">${params.map(p => `<label>${escHtml(p.name)} <small>${p.in}${p.required ? ", required" : ""}</small><input data-k="${p.in}.${escHtml(p.name)}" value="${escHtml(p.example || "")}" spellcheck="false"></label>`).join("")}</div>` : ""}
        ${d.body !== null && d.body !== undefined ? `<label>Body <small>JSON</small><textarea data-k="body" spellcheck="false">${escHtml(d.body)}</textarea></label>` : ""}
        <div class="try-actions"><button class="btn btn-primary" type="button" data-try-send>Send request</button><span class="try-note" data-try-note>Sends a real request to your Tempolight.</span></div>
        <div class="try-out" data-try-out hidden><div class="try-status" data-try-status></div><pre data-try-res></pre></div>
        <div class="try-help" data-try-help hidden><p><strong>The browser couldn't get an answer.</strong> Either Tempolight isn't running at that address, or it refuses requests from this website, as it does by default.</p>
          <p>To allow them, open Tempolight → <strong>Integrations</strong> → <strong>Docs site</strong> and turn on <strong>Let the docs site try API calls</strong> (admin only; turn it off again when you're done). Or run the same request in a terminal:</p>
          <div class="code"><button class="copy" type="button" aria-label="Copy code" data-copy>${ICONS.copy}${ICONS.check}</button><pre><code data-try-curl></code></pre></div></div>
      </div></div>`;
    document.body.appendChild(tryEl);
    tryEl.addEventListener("click", e => { if (e.target === tryEl || e.target.closest("[data-try-close]")) closeTry(); });
    $("[data-try-send]", tryEl).addEventListener("click", sendTry);
  }
  tryEl.hidden = false; document.body.style.overflow = "hidden"; $("input", tryEl)?.focus();
}
async function sendTry() {
  const d = tryData, val = k => $(`[data-k="${CSS.escape(k)}"]`, tryEl)?.value ?? "", values = {};
  $$("[data-k]", tryEl).forEach(el => { values[el.dataset.k] = el.value.trim(); });
  const base = val("base").trim() || "http://localhost:8080", token = val("token").trim(), bodyText = d.body !== null && d.body !== undefined ? val("body") : "";
  store.set("tl-docs-base", base); try { sessionStorage.setItem("tl-docs-token", token); } catch {}
  const out = $("[data-try-out]", tryEl), status = $("[data-try-status]", tryEl), res = $("[data-try-res]", tryEl), help = $("[data-try-help]", tryEl), note = $("[data-try-note]", tryEl);
  $("[data-try-curl]", tryEl).textContent = curlFor(base, d, values, token, bodyText);
  if (bodyText) { try { JSON.parse(bodyText); } catch (e) { note.textContent = "The body isn't valid JSON: " + e.message; return; } }
  note.textContent = "Sending…"; help.hidden = true; out.hidden = true;
  const t0 = performance.now();
  try {
    const r = await fetch(buildUrl(base, d, values), { method: d.method, headers: { ...(bodyText ? { "content-type": "application/json" } : {}), ...(token ? { "x-tempolight-token": token } : {}) }, body: bodyText || undefined, mode: "cors" });
    const text = await r.text(); let shown = text; try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    status.innerHTML = `<span class="status status-${String(r.status)[0]}">${r.status}</span><span>${escHtml(r.statusText || "")}</span><span style="margin-left:auto">${Math.round(performance.now() - t0)} ms</span>`;
    res.textContent = shown.length > 200000 ? shown.slice(0, 200000) + "\n…" : shown; out.hidden = false; note.textContent = "";
    if (r.status === 403 && /other websites/.test(text)) help.hidden = false;
  } catch (e) { note.textContent = ""; help.hidden = false; }
}
$$("[data-try]").forEach(b => b.addEventListener("click", openTry));
