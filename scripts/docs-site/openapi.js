// The docs site's API reference, made from mintlify/openapi.json: an overview, a page per tag listing its operations,
// and a page per operation (two columns: the description, parameters, request body and responses on the left; code
// samples in curl, JavaScript and Python and the example responses on the right, plus a "Try it" panel).
import { esc } from "./highlight.js";
import { codeGroup } from "./markdown.js";

export const TAG_ICONS = {
  "State": "layout-dashboard", "Status": "activity", "Lights & show": "lightbulb", "Your own effects": "wand-sparkles", "Scenes & schedules": "calendar-clock",
  "Home & sleep": "bed-double", "Devices & room": "router", "DMX": "spotlight", "Music": "music", "Hearing": "ear", "Now playing": "disc-3", "Spotify": "audio-lines",
  "Requests": "list-music", "Settings": "settings", "Backup & updates": "archive-restore", "Wi-Fi": "wifi", "Lock": "lock", "Apple Home": "house", "Integrations": "plug", "Games": "gamepad-2",
};
export const kebab = s => String(s).toLowerCase().replace(/&/g, " ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const METHODS = ["get", "post", "put", "patch", "delete"];
export const BASE = "/docs/api-reference";

/** Every tag and operation with its URL: {tags: [{name, slug, url, description, ops}], ops: [...]} */
export function apiModel(spec) {
  const tags = (spec.tags || []).map(t => ({ name: t.name, slug: kebab(t.name), description: t.description || "", ops: [], icon: TAG_ICONS[t.name] || "braces" }));
  const byName = new Map(tags.map(t => [t.name, t]));
  for (const [p, item] of Object.entries(spec.paths)) for (const m of METHODS) {
    const op = item[m]; if (!op) continue;
    const tn = (op.tags || ["Other"])[0]; if (!byName.has(tn)) { const t = { name: tn, slug: kebab(tn), description: "", ops: [], icon: "braces" }; tags.push(t); byName.set(tn, t); }
    byName.get(tn).ops.push({ method: m.toUpperCase(), path: p, op, tag: byName.get(tn), parameters: [...(item.parameters || []), ...(op.parameters || [])] });
  }
  for (const t of tags) {
    t.url = `${BASE}/${t.slug}/`; const used = new Set();
    for (const o of t.ops) { let s = kebab(o.op.summary || `${o.method} ${o.path}`); if (used.has(s)) s += "-" + o.method.toLowerCase(); used.add(s); o.slug = s; o.url = `${t.url}${s}/`; o.title = o.op.summary || `${o.method} ${o.path}`; }
  }
  return { tags: tags.filter(t => t.ops.length), ops: tags.flatMap(t => t.ops) };
}

// ---------------------------------------------------------------- schemas
function resolver(spec) {
  const get = ref => ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], spec);
  const deref = (s, seen = new Set()) => {
    if (!s || typeof s !== "object") return s;
    if (s.$ref) { if (seen.has(s.$ref)) return { type: "object", description: "(recursive)" }; const t = get(s.$ref); return deref({ ...t, ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== "$ref")), "x-name": s.$ref.split("/").pop() }, new Set([...seen, s.$ref])); }
    if (s.allOf) { const parts = s.allOf.map(x => deref(x, seen)); const o = { ...s, type: "object", properties: {}, required: [] }; delete o.allOf;
      for (const p of parts) { Object.assign(o.properties, p.properties || {}); o.required.push(...(p.required || [])); if (!o.description && p.description) o.description = p.description; if (!o.example && p.example) o.example = p.example; } return o; }
    return s;
  };
  return deref;
}
function typeOf(s, deref) {
  s = deref(s); if (!s) return "any";
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.anyOf || s.oneOf) return [...new Set((s.anyOf || s.oneOf).map(x => typeOf(x, deref)))].join(" | ");
  let t = Array.isArray(s.type) ? s.type.join(" | ") : s.type || (s.properties ? "object" : s.enum ? "string" : "any");
  if (t === "array") t = `${typeOf(s.items || {}, deref)}[]`;
  if (t === "object" && s.additionalProperties && !s.properties) t = typeof s.additionalProperties === "object" && Object.keys(s.additionalProperties).length ? `map of ${typeOf(s.additionalProperties, deref)}` : "object";
  if (s.format && !/binary/.test(s.format)) t += ` <${s.format}>`; else if (s.format === "binary") t = "file";
  return t;
}
/** The object schema whose fields to list under a field (an object, an array of objects, a map of objects, or one of anyOf). */
function childObject(s, deref) {
  s = deref(s); if (!s) return null;
  if (s.properties && Object.keys(s.properties).length) return s;
  if (s.type === "array" && s.items) return childObject(s.items, deref);
  if (s.anyOf || s.oneOf) for (const x of s.anyOf || s.oneOf) { const c = childObject(x, deref); if (c) return c; }
  if (s.additionalProperties && typeof s.additionalProperties === "object") return childObject(s.additionalProperties, deref);
  return null;
}

export function createApiRenderer({ spec, md, icon }) {
  const deref = resolver(spec), model = apiModel(spec);
  const methodPill = (m, cls = "") => `<span class="method method-${m.toLowerCase()}${cls ? " " + cls : ""}">${m === "DELETE" ? "DEL" : m}</span>`;

  function fieldList(schema, depth = 0) {
    const s = deref(schema); if (!s?.properties) return "";
    const req = new Set(s.required || []);
    return `<div class="fields${depth ? " nested" : ""}">${Object.entries(s.properties).map(([name, f]) => {
      const d = deref(f), child = depth < 5 ? childObject(d, deref) : null, en = d.enum || (d.anyOf || []).flatMap(x => deref(x).enum || []);
      const facts = [
        d.default !== undefined ? `<span class="fact">Default <code>${esc(JSON.stringify(d.default))}</code></span>` : "",
        d.minimum !== undefined || d.maximum !== undefined ? `<span class="fact">${d.minimum !== undefined && d.maximum !== undefined ? `<code>${d.minimum}</code> to <code>${d.maximum}</code>` : d.minimum !== undefined ? `At least <code>${d.minimum}</code>` : `At most <code>${d.maximum}</code>`}</span>` : "",
        d.maxLength !== undefined ? `<span class="fact">Up to ${d.maxLength} characters</span>` : "",
        d.minItems !== undefined || d.maxItems !== undefined ? `<span class="fact">${d.minItems ?? 0} to ${d.maxItems ?? "any number of"} items</span>` : "",
        d.pattern ? `<span class="fact">Pattern <code>${esc(d.pattern)}</code></span>` : "",
      ].join("");
      return `<div class="field"><div class="field-head"><code class="field-name">${esc(name)}</code><span class="field-type">${esc(typeOf(d, deref))}</span>${req.has(name) ? '<span class="field-req">required</span>' : ""}</div>
        ${d.description ? `<div class="field-desc">${md(d.description)}</div>` : ""}
        ${en.length ? `<div class="field-enum">One of ${en.map(v => `<code>${esc(JSON.stringify(v))}</code>`).join(" ")}</div>` : ""}${facts ? `<div class="field-facts">${facts}</div>` : ""}
        ${child ? `<details class="expandable"><summary>${icon("chevron-right", "ic chev")}<span class="show">Show</span><span class="hide">Hide</span> child attributes</summary>${fieldList(child, depth + 1)}</details>` : ""}</div>`;
    }).join("")}</div>`;
  }
  function schemaBlock(schema) {
    const s = deref(schema); if (!s) return "";
    if (s.properties) return fieldList(s);
    const child = childObject(s, deref);
    return `<div class="fields"><div class="field"><div class="field-head"><span class="field-type">${esc(typeOf(s, deref))}</span></div>${s.description ? `<div class="field-desc">${md(s.description)}</div>` : ""}${child ? fieldList(child, 1) : ""}</div></div>`;
  }
  function exampleOf(schema, depth = 0) {
    const s = deref(schema); if (!s || depth > 6) return null;
    if (s.example !== undefined) return s.example;
    if (s.const !== undefined) return s.const;
    if (s.default !== undefined) return s.default;
    if (s.enum) return s.enum[0];
    if (s.anyOf || s.oneOf) return exampleOf((s.anyOf || s.oneOf).find(x => deref(x).type !== "null") || {}, depth + 1);
    if (s.properties) return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, exampleOf(v, depth + 1)]));
    const t = Array.isArray(s.type) ? s.type[0] : s.type;
    return t === "array" ? [exampleOf(s.items || {}, depth + 1)].filter(x => x !== null) : t === "integer" || t === "number" ? (s.minimum ?? 0) : t === "boolean" ? true : t === "string" ? (s.format === "date-time" ? "2026-11-04T12:00:00.000Z" : "string") : t === "object" ? {} : null;
  }
  function paramValue(p, o) {
    const s = deref(p.schema || {});
    if (p.example !== undefined) return String(p.example); if (s.example !== undefined) return String(s.example); if (s.enum) return String(s.enum[0]);
    const tick = /`([^`…]+)`/.exec(p.description || ""); if (tick && !/[{}<>\s]/.test(tick[1])) return tick[1];
    for (const r of Object.values(o.op.responses || {})) { const ex = r.content?.["application/json"]?.example; if (ex && typeof ex === "object" && !Array.isArray(ex) && typeof ex[p.name] === "string") return ex[p.name]; }
    const body = o.op.requestBody?.content?.["application/json"]?.example; if (body && typeof body[p.name] === "string") return body[p.name];
    return p.name;
  }
  const bodyOf = o => { const c = o.op.requestBody?.content?.["application/json"]; if (!c) return undefined; return c.example ?? exampleOf(c.schema); };
  const pyLit = (v, ind = "") => v === null ? "None" : v === true ? "True" : v === false ? "False" : Array.isArray(v) ? (v.length ? `[\n${v.map(x => ind + "    " + pyLit(x, ind + "    ")).join(",\n")}\n${ind}]` : "[]")
    : typeof v === "object" ? (Object.keys(v).length ? `{\n${Object.entries(v).map(([k, x]) => `${ind}    ${JSON.stringify(k)}: ${pyLit(x, ind + "    ")}`).join(",\n")}\n${ind}}` : "{}") : JSON.stringify(v);
  const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  function samples(o) {
    const server = "http://localhost:8080", path = o.path.replace(/\{(\w+)\}/g, (x, n) => encodeURIComponent(paramValue(o.parameters.find(p => p.name === n && p.in === "path") || { name: n }, o)));
    const q = o.parameters.filter(p => p.in === "query" && p.required).map(p => `${p.name}=${encodeURIComponent(paramValue(p, o))}`).join("&");
    const url = server + path + (q ? "?" + q : ""), body = bodyOf(o), json = body === undefined ? null : JSON.stringify(body, null, 2), m = o.method;
    const curl = [`curl ${m === "GET" ? "" : `-X ${m} `}${shq(url)}`, ...(json !== null ? [`-H 'content-type: application/json'`, `-d ${shq(json)}`] : [])].join(" \\\n  ");
    const js = `const res = await fetch("${url}"${m === "GET" && json === null ? "" : `, {\n  method: "${m}",${json !== null ? `\n  headers: { "content-type": "application/json" },\n  body: JSON.stringify(${json.replace(/\n/g, "\n  ")}),` : ""}\n}`});\nconst data = await res.json();\nconsole.log(data);`;
    const py = `import requests\n\nres = requests.${m.toLowerCase()}(\n    "${url}",${json !== null ? `\n    json=${pyLit(body, "    ")},` : ""}\n)\nprint(res.json())`;
    return { blocks: [{ title: "cURL", lang: "bash", code: curl }, { title: "JavaScript", lang: "js", code: js }, { title: "Python", lang: "python", code: py }], url, body: json };
  }
  function access(o) {
    const a = o.op["x-tempolight-area"] || "open";
    if (a === "admin") return { cls: "admin", label: "Admin", icon: "lock", text: "Needs an unlock token while a PIN lock is set." };
    if (a.startsWith("guest")) return { cls: "guest", label: `Guest area “${a.split(":")[1].trim()}”`, icon: "users", text: "Open unless a PIN lock is set and guests aren't allowed this area." };
    if (a === "open") return { cls: "open", label: "Open", icon: "globe", text: "Works for everyone who can reach Tempolight." };
    return { cls: "guest", label: a[0].toUpperCase() + a.slice(1), icon: "key-round", text: "" };
  }

  function operationPage(o) {
    const op = o.op, ac = access(o), smp = samples(o), id = "op" + kebab(o.slug).slice(0, 20);
    const desc = (op.description || "").replace(/\n*\*\*Access:\*\*[^\n]*$/, ""), accessText = /\*\*Access:\*\*\s*([^\n]*)$/.exec(op.description || "")?.[1];
    const params = ["path", "query", "header"].map(where => { const ps = o.parameters.filter(p => p.in === where); if (!ps.length) return "";
      return `<h3 id="${where}-parameters">${where[0].toUpperCase() + where.slice(1)} parameters</h3><div class="fields">${ps.map(p => `<div class="field"><div class="field-head"><code class="field-name">${esc(p.name)}</code><span class="field-type">${esc(typeOf(p.schema || {}, deref))}</span>${p.required ? '<span class="field-req">required</span>' : ""}</div>${p.description ? `<div class="field-desc">${md(p.description)}</div>` : ""}</div>`).join("")}</div>`; }).join("");
    const rb = op.requestBody, rbc = rb && Object.entries(rb.content || {})[0];
    const body = rbc ? `<h3 id="body">Request body <span class="ct">${esc(rbc[0])}</span>${rb.required ? "" : ' <span class="field-opt">optional</span>'}</h3>${rb.description ? md(rb.description) : ""}${schemaBlock(rbc[1].schema)}` : "";
    const resps = Object.entries(op.responses || {});
    const responses = `<h3 id="responses">Responses</h3><div class="responses">${resps.map(([code, r], k) => { const c = Object.entries(r.content || {})[0], sch = c?.[1]?.schema, ok = code.startsWith("2");
      return `<details class="response"${k === 0 ? " open" : ""}><summary><span class="status status-${code[0]}">${esc(code)}</span><span class="response-desc">${esc(r.description || "")}</span>${c ? `<span class="ct">${esc(c[0])}</span>` : ""}${icon("chevron-down", "ic chev")}</summary>${sch && (ok || k === 0) ? `<div class="response-body">${schemaBlock(sch)}</div>` : sch ? `<div class="response-body">${schemaBlock(sch)}</div>` : ""}</details>`; }).join("")}</div>`;
    const examples = resps.filter(([, r]) => r.content?.["application/json"]).map(([code, r]) => ({ title: code, lang: "json", code: JSON.stringify(r.content["application/json"].example ?? exampleOf(r.content["application/json"].schema), null, 2) }));
    const tryData = { method: o.method, path: o.path, params: o.parameters.map(p => ({ name: p.name, in: p.in, required: !!p.required, example: paramValue(p, o), description: (p.description || "").replace(/`/g, "") })), body: smp.body, admin: ac.cls === "admin" };
    const left = `<div class="endpoint">${methodPill(o.method)}<code class="endpoint-path">${o.path.replace(/\{(\w+)\}/g, '<span class="pp">{$1}</span>')}</code><button class="copy endpoint-copy" type="button" data-copy-text="${esc(o.path)}" aria-label="Copy the path">${icon("copy", "ic")}${icon("check", "ic ok")}</button><button class="btn btn-primary try-open" type="button" data-try>${icon("play", "ic")}Try it</button></div>
      <div class="access access-${ac.cls}">${icon(ac.icon, "ic")}<span><strong>${esc(ac.label)}.</strong> ${accessText ? md(accessText.replace(/^(admin|guest area `[^`]+`)\.\s*/, "").replace(/^open to everyone/, "Open to everyone").replace(/^./, c => c.toUpperCase())).replace(/^<p>|<\/p>$/g, "") : esc(ac.text)}</span></div>
      <div class="op-desc">${md(desc)}</div>${params}${body}${responses}`;
    const right = `<div class="op-aside"><div class="sample-label">Request</div>${codeGroup(smp.blocks, { icon }, id + "-req")}${examples.length ? `<div class="sample-label">Response</div>${codeGroup(examples, { icon }, id + "-res")}` : ""}</div>`;
    return { html: `<div class="op">${`<div class="op-main">${left}</div>${right}`}</div><script type="application/json" id="try-data">${JSON.stringify(tryData).replace(/</g, "\\u003c")}</script>`, description: desc.split("\n")[0].replace(/[`*]/g, "") };
  }
  function tagPage(t) {
    return `<div class="op-desc">${md(t.description)}</div><div class="op-list">${t.ops.map(o => `<a class="op-row" href="${o.url}">${methodPill(o.method)}<span class="op-row-text"><span class="op-row-title">${esc(o.title)}</span><code>${esc(o.path)}</code></span>${icon("chevron-right", "ic")}</a>`).join("")}</div>`;
  }
  function overviewPage() {
    const info = spec.info || {};
    return `<div class="op-desc">${md(info.description || "")}</div>
      <h2 id="base-url"><a class="anchor" href="#base-url">${icon("link", "ic")}</a>Base URL</h2><p>Every call goes to the computer running Tempolight, on the web app's port:</p>
      <div class="table-wrap"><table><thead><tr><th>Server</th><th>Address</th></tr></thead><tbody>${(spec.servers || []).map(s => `<tr><td>${esc(s.description || "")}</td><td><code>${esc(s.url)}</code></td></tr>`).join("")}</tbody></table></div>
      <h2 id="groups"><a class="anchor" href="#groups">${icon("link", "ic")}</a>Endpoints by area</h2>
      <div class="cols cols-3">${model.tags.map(t => `<a class="card" href="${t.url}"><span class="card-icon">${icon(t.icon, "ic")}</span><span class="card-text"><span class="card-title">${esc(t.name)}</span><span class="card-body"><p>${esc(t.description.split(/(?<=\.)\s/)[0])}</p><p class="card-meta">${t.ops.length} endpoint${t.ops.length === 1 ? "" : "s"}</p></span></span><span class="card-arrow">${icon("chevron-right", "ic")}</span></a>`).join("")}</div>`;
  }
  return { model, operationPage, tagPage, overviewPage, methodPill };
}
