#!/usr/bin/env node
// The API as an OpenAPI 3.1 document, for the docs site's interactive API reference (mintlify/openapi.json).
//   node scripts/gen-openapi.js            write mintlify/openapi.json
//   node scripts/gen-openapi.js --check    fail when it is out of date, or a route in the code has no description
//   node scripts/gen-openapi.js --stdout   print it
// Every route comes from the server's code (scripts/gen-api-routes.js reads them); what each one does, takes and
// answers is written by hand in scripts/openapi/operations.js, with shared shapes in scripts/openapi/schemas.js.
// The WebSocket can't be described in OpenAPI: info.description points to its own page.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectRoutes } from "./gen-api-routes.js";
import { operations, tags } from "./openapi/operations.js";
import { schemas } from "./openapi/schemas.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = path.join(ROOT, "mintlify/openapi.json");
export const WS_PAGE = "/websocket"; // the docs site's WebSocket page
const ERRORS = {
  400: ["BadRequest", "The body isn't valid JSON, or a value is wrong.", "Unknown effect \"x\""],
  403: ["Forbidden", "Locked, or not allowed.", "Settings are locked. Unlock with the PIN in Settings."],
  404: ["NotFound", "No such id.", "No such device"],
  409: ["Conflict", "Can't do that now.", "Wake-up is turned off (Home & sleep page)"],
  429: ["TooManyRequests", "Too many calls; wait a little.", "Lots of requests right now. Try again in a minute."],
  502: ["BadGateway", "A service Tempolight relies on failed.", "Discord answered 500"],
};
const LOCKED = {
  admin: "Settings are locked. Unlock with the PIN in Settings.",
  guest: "Settings are locked. Unlock with the PIN in Settings.",
  "brightness or link key": "Locked: add ?key=<your wake-up link key> (Home & sleep page) or unlock with the PIN",
};

/** `/api/devices/:id` -> `/api/devices/{id}` */
export const oasPath = p => p.replace(/:(\w+)/g, "{$1}");
export const keyOf = r => `${r.method} ${oasPath(r.path)}`;
function operationId(method, p) {
  const words = p.replace(/^\/api\//, "").split(/[/-]/).filter(Boolean).map(w => w.startsWith("{") ? "by-" + w.slice(1, -1) : w).join("-").split("-");
  return method.toLowerCase() + words.map(w => w[0].toUpperCase() + w.slice(1)).join("");
}
const schemaOf = s => typeof s === "string" ? { $ref: `#/components/schemas/${s}` } : s;
const exampleOf = s => typeof s === "string" ? schemas[s]?.example : s?.example;
const json = (schema, example) => ({ "application/json": { schema: schemaOf(schema), ...(example !== undefined ? { example } : {}) } });

function access(area) {
  if (area === "admin") return { security: [{ token: [] }], note: "**Access:** admin. Needs an unlock token (`x-tempolight-token`) while a PIN lock is set; without a lock, anyone can call it." };
  if (area.startsWith("guest: ")) { const g = area.slice(7);
    return { security: [{}, { token: [] }], note: `**Access:** guest area \`${g}\`. Open unless a PIN lock is set and guests aren't allowed this area (\`settings.guest.${g}\`); then it needs an unlock token.` }; }
  if (area === "brightness or link key") return { security: [{}, { token: [] }, { wakeKey: [] }],
    note: "**Access:** like the `brightness` guest area, or with the wake-up link key (`x-tempolight-key` header, `?key=` or `key` in the body), which opens the wake and sleep calls only." };
  if (area === "game token") return { security: [], note: "**Access:** open, but the body must carry the game's token (`auth.token`, from its config file)." };
  return { security: [], note: "**Access:** open to everyone who can reach Tempolight." };
}

/** The OpenAPI document. Throws when a route has no entry in operations.js, or an entry has no route. */
export function build(routes = collectRoutes()) {
  const problems = missing(routes);
  if (problems.length) throw new Error(problems.join("\n"));
  const paths = {};
  for (const r of routes) {
    const k = keyOf(r), m = operations[k], p = oasPath(r.path), { security, note } = access(r.area);
    const params = [...p.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({ name, in: "path", required: true, description: m.params?.[name] || `The ${name}.`, schema: { type: "string" } }));
    for (const q of m.query || []) params.push({ name: q.name, in: "query", required: !!q.required, description: q.description, schema: q.schema || { type: "string" } });
    const responses = { 200: m.content ? { description: "OK", content: m.content } : { description: "OK", content: json(m.res || "Ok", m.example ?? exampleOf(m.res || "Ok")) } };
    const errs = { ...(m.errors || {}) };
    if (r.area !== "open" && r.area !== "game token" && !(403 in errs)) errs[403] = LOCKED[r.area.startsWith("guest") ? "guest" : r.area];
    for (const code of Object.keys(errs).sort()) {
      const msg = errs[code];
      responses[code] = msg === null ? { $ref: `#/components/responses/${ERRORS[code][0]}` } : { description: ERRORS[code][1], content: json("Error", { error: msg }) };
    }
    Object.assign(responses, m.extraResponses || {});
    const op = {
      tags: [m.tag], summary: m.summary, description: `${m.description}\n\n${note}`, operationId: operationId(r.method, p),
      ...(params.length ? { parameters: params } : {}),
      ...(m.body ? { requestBody: { required: !m.bodyOptional, content: json(m.body, m.bodyExample ?? exampleOf(m.body)) } } : {}),
      responses, security,
      "x-tempolight-area": r.area, "x-tempolight-source": r.file,
    };
    (paths[p] ||= {})[r.method.toLowerCase()] = op;
  }
  const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  return {
    openapi: "3.1.0",
    info: {
      title: "Tempolight API", version,
      description: [
        "Everything the web app does goes through this API, so anything else can do it too: scripts, Home Assistant, a Stream Deck, a lighting desk. It is plain HTTP with JSON bodies on the same port as the web app (8080 by default).",
        "**Auth.** Without a PIN lock every call works for everyone who can reach the port. With one, admin calls need an unlock token from `POST /api/unlock`, sent as the `x-tempolight-token` header (or `?token=`); guest-area calls work without one when that area is allowed in Settings.",
        "**Origin rule.** Calls that change something are refused with 403 when a browser sends them from another website. Scripts and apps send no `Origin` and aren't affected. To send requests from the Try it panel of the docs site, an admin turns on **Integrations → Docs site → Let the docs site try API calls** (`PATCH /api/integrations/docs`).",
        "**Errors** answer `{\"error\": \"<a sentence for people>\"}` with a 4xx or 5xx status.",
        `**Live data** (status 4 times a second, LED previews, browser audio, the song clock) goes over one WebSocket at \`/ws\`, which OpenAPI can't describe: see the [WebSocket](${WS_PAGE}) page.`,
      ].join("\n\n"),
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [
      { url: "http://localhost:8080", description: "Your Tempolight" },
      { url: "http://{host}:{port}", description: "Tempolight on another computer", variables: { host: { default: "tempolight.local", description: "Its name or IP address." }, port: { default: "8080" } } },
    ],
    tags,
    paths,
    components: {
      securitySchemes: {
        token: { type: "apiKey", in: "header", name: "x-tempolight-token", description: "An unlock token from `POST /api/unlock` (also accepted as `?token=`). Only needed while a PIN lock is set." },
        wakeKey: { type: "apiKey", in: "header", name: "x-tempolight-key", description: "The wake-up link key (Home & sleep page). Opens the wake and sleep calls only." },
      },
      responses: Object.fromEntries(Object.entries(ERRORS).map(([, [name, description, error]]) => [name, { description, content: json("Error", { error }) }])),
      schemas: { ...schemas },
    },
  };
}

/** Routes in the code without an entry in operations.js, and entries for routes the code doesn't have. */
export function missing(routes = collectRoutes()) {
  const keys = new Set(routes.map(keyOf)), out = [];
  for (const r of routes) if (!operations[keyOf(r)]) out.push(`no entry in scripts/openapi/operations.js for "${keyOf(r)}" (${r.file}:${r.line})`);
  for (const k of Object.keys(operations)) if (!keys.has(k)) out.push(`scripts/openapi/operations.js describes "${k}", which the code doesn't have`);
  return out;
}

export const render = (routes) => JSON.stringify(build(routes), null, 2) + "\n";

/** Problems: a route without metadata, or mintlify/openapi.json out of date. */
export function check(routes = collectRoutes()) {
  const problems = missing(routes);
  if (problems.length) return problems;
  let have = ""; try { have = readFileSync(OUT, "utf8"); } catch {}
  if (have !== render(routes)) problems.push("mintlify/openapi.json is out of date: run node scripts/gen-openapi.js");
  return problems;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  try {
    const routes = collectRoutes();
    if (args.includes("--check")) {
      const problems = check(routes);
      if (problems.length) { console.error(`mintlify/openapi.json:\n  ${problems.join("\n  ")}`); process.exit(1); }
      console.log(`mintlify/openapi.json: all ${routes.length} routes, up to date`);
    } else if (args.includes("--stdout")) process.stdout.write(render(routes));
    else { mkdirSync(path.dirname(OUT), { recursive: true }); writeFileSync(OUT, render(routes)); console.log(`mintlify/openapi.json: ${routes.length} operations`); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
