// mintlify/openapi.json describes every API route, is up to date, and is a well-formed OpenAPI 3.1 document.
// There is no OpenAPI validator among the dependencies (there are none), so validate() below checks what matters
// for the docs site by hand: required fields, $refs, path parameters, operation ids, tags, security, and that every
// example fits its schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectRoutes } from "./gen-api-routes.js";
import { build, check, missing, keyOf } from "./gen-openapi.js";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
const SCHEMA_KEYS = new Set(["$ref", "type", "properties", "required", "items", "enum", "const", "anyOf", "allOf", "oneOf", "description", "example", "examples", "default",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "additionalProperties", "title"]);

function resolve(doc, ref) {
  if (!ref.startsWith("#/")) return undefined;
  return ref.slice(2).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((o, k) => o?.[k], doc);
}
const typeOf = v => v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;

/** Does `value` fit `schema`? The JSON Schema keywords used in schemas.js; returns the problems. */
export function fits(doc, value, schema, at = "") {
  if (schema.$ref) return fits(doc, value, resolve(doc, schema.$ref), at);
  const out = [];
  if (schema.allOf) for (const s of schema.allOf) out.push(...fits(doc, value, s, at));
  if (schema.anyOf && !schema.anyOf.some(s => !fits(doc, value, s, at).length)) out.push(`${at}: fits none of anyOf`);
  if (schema.oneOf && schema.oneOf.filter(s => !fits(doc, value, s, at).length).length !== 1) out.push(`${at}: doesn't fit exactly one of oneOf`);
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) out.push(`${at}: is not ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) out.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  if (schema.type) { const t = typeOf(value), want = [].concat(schema.type);
    if (!want.includes(t) && !(t === "integer" && want.includes("number"))) { out.push(`${at}: is ${t}, not ${want.join(" or ")}`); return out; } }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${at}: doesn't match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => out.push(...fits(doc, v, schema.items, `${at}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    for (const k of schema.required || []) if (!(k in value)) out.push(`${at}: misses ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) out.push(...fits(doc, v, schema.properties[k], `${at}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${at}: ${k} isn't allowed`);
      else if (typeof schema.additionalProperties === "object") out.push(...fits(doc, v, schema.additionalProperties, `${at}.${k}`));
    }
  }
  return out;
}

/** Problems with an OpenAPI 3.1 document (the parts the docs site relies on). */
export function validate(doc) {
  const p = [], ids = new Set();
  if (!/^3\.1\.\d+$/.test(doc.openapi || "")) p.push("openapi is not 3.1.x");
  if (!doc.info?.title || !doc.info?.version) p.push("info needs title and version");
  for (const s of doc.servers || []) {
    if (!s.url) p.push("a server without url");
    for (const [, v] of s.url.matchAll(/\{(\w+)\}/g)) if (s.variables?.[v]?.default === undefined) p.push(`server ${s.url}: variable ${v} has no default`);
  }
  const tagNames = (doc.tags || []).map(t => t.name);
  if (new Set(tagNames).size !== tagNames.length) p.push("a tag is defined twice");
  const used = new Set();

  // every $ref points at something
  (function walk(o, at) {
    if (!o || typeof o !== "object") return;
    if (typeof o.$ref === "string" && resolve(doc, o.$ref) === undefined) p.push(`${at}: $ref ${o.$ref} points at nothing`);
    for (const [k, v] of Object.entries(o)) walk(v, `${at}/${k}`);
  })(doc, "#");

  // schemas use known keywords and types, and list their required fields
  const checkSchema = (s, at) => {
    if (!s || typeof s !== "object") { p.push(`${at}: not a schema`); return; }
    for (const k of Object.keys(s)) if (!SCHEMA_KEYS.has(k)) p.push(`${at}: unknown schema keyword ${k}`);
    for (const t of [].concat(s.type ?? [])) if (!TYPES.includes(t)) p.push(`${at}: unknown type ${t}`);
    if (s.required && s.properties && !s.allOf) for (const r of s.required) if (!(r in s.properties)) p.push(`${at}: requires ${r}, which isn't a property`);
    for (const [k, v] of Object.entries(s.properties || {})) checkSchema(v, `${at}.${k}`);
    if (s.items) checkSchema(s.items, `${at}[]`);
    if (typeof s.additionalProperties === "object") checkSchema(s.additionalProperties, `${at}{}`);
    for (const k of ["allOf", "anyOf", "oneOf"]) (s[k] || []).forEach((x, i) => checkSchema(x, `${at}.${k}[${i}]`));
    if (s.example !== undefined) for (const e of fits(doc, s.example, s, "example")) p.push(`${at}: ${e}`);
  };
  for (const [k, s] of Object.entries(doc.components?.schemas || {})) checkSchema(s, `schema ${k}`);
  const media = (content, at) => {
    if (!content || !Object.keys(content).length) { p.push(`${at}: no content`); return; }
    for (const [type, m] of Object.entries(content)) {
      if (!m.schema) { p.push(`${at} ${type}: no schema`); continue; }
      checkSchema(m.schema, `${at} ${type}`);
      if (m.example !== undefined) for (const e of fits(doc, m.example, m.schema, "example")) p.push(`${at} ${type}: ${e}`);
    }
  };
  for (const [name, r] of Object.entries(doc.components?.responses || {})) { if (!r.description) p.push(`response ${name}: no description`); if (r.content) media(r.content, `response ${name}`); }
  const schemes = doc.components?.securitySchemes || {};
  for (const [name, s] of Object.entries(schemes)) if (s.type === "apiKey" && (!s.name || !["header", "query", "cookie"].includes(s.in))) p.push(`security scheme ${name}: apiKey needs name and in`);

  const seenShapes = new Set();
  for (const [path, item] of Object.entries(doc.paths || {})) {
    if (!path.startsWith("/")) p.push(`${path}: doesn't start with /`);
    const shape = path.replace(/\{\w+\}/g, "{}"); if (seenShapes.has(shape)) p.push(`${path}: the same path as another one with different parameter names`); seenShapes.add(shape);
    const inPath = [...path.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    for (const [method, op] of Object.entries(item)) {
      const at = `${method.toUpperCase()} ${path}`;
      if (!METHODS.includes(method)) { p.push(`${at}: not an HTTP method`); continue; }
      if (!op.summary) p.push(`${at}: no summary`);
      if (!op.description) p.push(`${at}: no description`);
      if (!op.operationId) p.push(`${at}: no operationId`); else if (ids.has(op.operationId)) p.push(`${at}: operationId ${op.operationId} is used twice`); else ids.add(op.operationId);
      if (!op.tags?.length) p.push(`${at}: no tag`);
      for (const t of op.tags || []) { used.add(t); if (!tagNames.includes(t)) p.push(`${at}: tag "${t}" isn't defined`); }
      const params = op.parameters || [], declared = params.filter(x => x.in === "path").map(x => x.name);
      if (new Set(params.map(x => `${x.in}:${x.name}`)).size !== params.length) p.push(`${at}: a parameter is listed twice`);
      for (const n of inPath) if (!declared.includes(n)) p.push(`${at}: path parameter ${n} isn't declared`);
      for (const x of params) {
        if (!x.name || !["path", "query", "header", "cookie"].includes(x.in)) p.push(`${at}: a parameter needs name and in`);
        if (x.in === "path" && (!inPath.includes(x.name) || x.required !== true)) p.push(`${at}: path parameter ${x.name} must be in the path and required`);
        if (!x.schema && !x.content) p.push(`${at}: parameter ${x.name} has no schema`); else if (x.schema) checkSchema(x.schema, `${at} parameter ${x.name}`);
      }
      if (op.requestBody) media(op.requestBody.content, `${at} body`);
      if (!op.responses || !Object.keys(op.responses).length) p.push(`${at}: no responses`);
      for (const [code, r] of Object.entries(op.responses || {})) {
        if (!/^([1-5]\d\d|[1-5]XX|default)$/.test(code)) p.push(`${at}: response ${code} isn't a status`);
        if (r.$ref) continue;
        if (!r.description) p.push(`${at} ${code}: no description`);
        if (r.content) media(r.content, `${at} ${code}`);
      }
      if (!Object.keys(op.responses || {}).some(c => c.startsWith("2"))) p.push(`${at}: no success response`);
      for (const req of op.security || []) for (const n of Object.keys(req)) if (!schemes[n]) p.push(`${at}: security scheme ${n} isn't defined`);
    }
  }
  for (const t of tagNames) if (!used.has(t)) p.push(`tag "${t}" has no operations`);
  return p;
}

test("every route in the code has an operation, and mintlify/openapi.json is up to date", () => {
  assert.deepEqual(check(), [], "run: node scripts/gen-openapi.js (and describe new routes in scripts/openapi/operations.js)");
});

test("the document is a well-formed OpenAPI 3.1 document", () => {
  const routes = collectRoutes(), doc = build(routes);
  assert.deepEqual(validate(doc), []);
  const ops = Object.values(doc.paths).flatMap(i => Object.values(i));
  assert.equal(ops.length, routes.length);
  // the security matches each route's area
  for (const r of routes) {
    const op = doc.paths[keyOf(r).split(" ")[1]][r.method.toLowerCase()], sec = JSON.stringify(op.security);
    if (r.area === "admin") assert.equal(sec, '[{"token":[]}]', keyOf(r));
    else if (r.area.startsWith("guest: ")) assert.equal(sec, '[{},{"token":[]}]', keyOf(r));
    else if (r.area === "open") assert.equal(sec, "[]", keyOf(r));
  }
  assert.match(doc.info.description, /WebSocket/);
});

test("the checks notice a route without an operation, and a broken document", () => {
  const routes = collectRoutes(), fake = [...routes, { method: "GET", path: "/api/not-described", area: "open", file: "packages/server/src/core.js", line: 1, kind: "api" }];
  assert.ok(missing(fake).some(m => m.includes("/api/not-described")));
  assert.ok(check(fake).some(m => m.includes("/api/not-described")));
  assert.throws(() => build(fake), /not-described/);
  const doc = build(routes), bad = structuredClone(doc);
  bad.paths["/api/scenes/{id}/apply"].post.parameters = [];
  bad.paths["/api/power"].post.tags = ["Nope"];
  bad.paths["/api/power"].post.requestBody.content["application/json"].example = { on: "yes" };
  bad.paths["/api/state"].get.responses[200].content["application/json"].schema = { $ref: "#/components/schemas/Missing" };
  bad.paths["/api/health"].get.operationId = bad.paths["/api/state"].get.operationId;
  const p = validate(bad).join("\n");
  for (const m of ["path parameter id isn't declared", 'tag "Nope"', "is string, not boolean", "points at nothing", "used twice"]) assert.ok(p.includes(m), m);
});
