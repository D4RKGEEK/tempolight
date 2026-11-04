// docs/api.md documents every API route the server registers (scripts/gen-api-routes.js reads them from the code).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectRoutes, check, table } from "./gen-api-routes.js";

test("the route reader finds the core's, the plug-ins' and the plain HTTP routes, each once", () => {
  const routes = collectRoutes(), has = k => routes.some(r => `${r.method} ${r.path}` === k);
  for (const k of ["GET /api/state", "POST /api/devices/:id/fixtures", "POST /api/wake", "GET /api/spotify", "GET /api/homekit", "POST /api/gsi/:game", "GET /api/nowplaying/spotify/callback", "GET /api/integrations/streamdeck/plugin"]) assert.ok(has(k), k);
  assert.equal(new Set(routes.map(r => `${r.method} ${r.path}`)).size, routes.length);
  assert.equal(routes.find(r => r.path === "/api/action").area, "guest: pads");
  assert.equal(routes.find(r => r.path === "/api/sleep" && r.method === "POST").area, "brightness or link key");
  assert.ok(table(routes).startsWith(`${routes.length} routes.`));
});

test("docs/api.md describes every route and has an up-to-date route table", () => {
  const problems = check(readFileSync(new URL("../docs/api.md", import.meta.url), "utf8"));
  assert.deepEqual(problems, [], "run: node scripts/gen-api-routes.js --write docs/api.md, then describe the new routes");
});

test("the check notices a route that isn't described", () => {
  const routes = collectRoutes(), doc = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8");
  const fake = [...routes, { method: "GET", path: "/api/not-documented", area: "open", file: "packages/server/src/core.js", line: 1, kind: "api" }];
  const problems = check(doc, fake);
  assert.ok(problems.some(p => p.includes("out of date")) && problems.some(p => p.includes("/api/not-documented")));
});
