// The shared beat-map Worker under Node, with an in-memory D1 (fake-d1.js) built from schema.sql: checking maps,
// "confirmed" only when two different installs agree, rate limits, and no personal data in the tables.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../src/index.js";
import { checkMap, agree, consensus } from "../src/map.js";
import { fakeD1 } from "./fake-d1.js";
import { toShared, fromShared } from "../../../packages/server/src/beatmap-cloud.js";
import { memoryEntry, preAnalyseCore } from "../../../packages/engine/src/index.js";
import { edm } from "../../../packages/engine/test/synth.js";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const ID = "4uLU6hMCjMI75M1A2tKUQC", INST = ["a", "b", "c", "d", "e"].map(c => c.repeat(32));
const song = edm(22050), entry = memoryEntry("Synth anthem", await preAnalyseCore(song.x, song.sr), "m1");
const base = toShared(entry);
const shift = (m, d) => ({ ...m, off: ((m.off + d) % m.P + m.P) % m.P, kicks: m.kicks.map(t => +(t + d).toFixed(3)), snares: m.snares.map(t => +(t + d).toFixed(3)), hats: m.hats.map(t => +(t + d).toFixed(3)) });

function env(vars = {}) { return { DB: fakeD1(schema), SALT: "test-salt", ...vars }; }
async function call(e, method, path, { body, install, ip = "203.0.113.7", raw } = {}) {
  const headers = { "cf-connecting-ip": ip }; if (install) headers["x-install-id"] = install; if (body !== undefined || raw) headers["content-type"] = "application/json";
  const r = await handle(new Request(`https://maps.example${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), e);
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}

test("beat maps: Tempolight's maps pass the Worker's checks, and come back as the same beat map", () => {
  const c = checkMap(base); assert.equal(c.ok, true, c.error);
  assert.ok(JSON.stringify({ map: base }).length < 32 * 1024);
  const back = fromShared(c.map); assert.ok(back); assert.ok(Math.abs(back.pre.bpm - entry.bpm) < 0.01); assert.deepEqual(back.pre.drops, entry.drops);
  assert.equal(back.pre.kicks.length, entry.kicks.length); assert.equal(back.pre.bars.length, entry.bars.length); assert.deepEqual(back.cov, [[0, entry.dur]]);
  for (const [why, m] of [["tempo", { ...base, bpm: 400 }], ["P vs bpm", { ...base, P: 0.3 }], ["unsorted kicks", { ...base, kicks: [5, 3] }], ["kick after the end", { ...base, kicks: [...base.kicks, 9999] }],
    ["bar state", { ...base, bars: [[0, 1, "x", 0.5]] }], ["not base64", { ...base, env: "%%%" }], ["no coverage", { ...base, cov: [] }], ["format", { ...base, v: 2 }], ["a string for a number", { ...base, dur: "34" }]])
    assert.equal(checkMap(m).ok, false, why);
});

test("beat maps: agreement needs tempo within 1%, beats within 30 ms and the same drops", () => {
  assert.equal(agree(base, shift(base, 0.012)), true, "12 ms apart");
  assert.equal(agree(base, shift(base, base.P + 0.01)), true, "a whole beat apart is the same grid");
  assert.equal(agree(base, shift(base, 0.08)), false, "80 ms apart");
  const P2 = base.P / 1.03; assert.equal(agree(base, { ...base, bpm: base.bpm * 1.03, P: P2 }), false, "3% faster");
  assert.equal(agree(base, { ...base, drops: [base.drops[0] + 8] }), false, "the drop somewhere else");
  assert.equal(agree(base, { ...base, cov: [[0, 10]] }), false, "less than 20 s in common");
  assert.equal(consensus([{ install: "x", map: base }, { install: "x", map: base }]), null, "one install twice is not two");
  const c = consensus([{ install: "x", map: base }, { install: "y", map: shift(base, 0.08) }, { install: "z", map: { ...shift(base, 0.01), cov: [[0, 30]] } }]);
  assert.equal(c.installs, 2); assert.equal(c.map, base, "the one that covers most of the track is served");
});

test("beat maps: a map is served once two different installs agree", async () => {
  const e = env();
  assert.equal((await call(e, "GET", `/v1/maps/${ID}`)).status, 404);
  let r = await call(e, "POST", `/v1/maps/${ID}`, { body: { map: base }, install: INST[0] }); assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, confirmed: false, installs: 1 });
  r = await call(e, "POST", `/v1/maps/${ID}`, { body: { map: base }, install: INST[0] }); assert.equal(r.body.confirmed, false, "the same install again doesn't confirm it");
  assert.equal(e.DB.tables.get("submissions").rows.length, 1, "sending again replaces");
  r = await call(e, "POST", `/v1/maps/${ID}`, { body: { map: shift(base, 0.09) }, install: INST[1] }); assert.equal(r.body.confirmed, false, "a map 90 ms off doesn't confirm it");
  assert.equal((await call(e, "GET", `/v1/maps/${ID}`)).status, 404);
  r = await call(e, "POST", `/v1/maps/${ID}`, { body: { map: shift(base, 0.015) }, install: INST[2], ip: "198.51.100.2" }); assert.deepEqual(r.body, { ok: true, confirmed: true, installs: 2 });
  const g = await call(e, "GET", `/v1/maps/${ID}`); assert.equal(g.status, 200); assert.equal(g.body.installs, 2); assert.equal(g.headers.get("access-control-allow-origin"), "*");
  assert.equal(checkMap(g.body.map).ok, true); assert.ok(Math.abs(g.body.map.bpm - base.bpm) < 0.01);
  // nothing personal in the database: no install IDs, no IP addresses, no names
  const dump = JSON.stringify([...e.DB.tables.values()].map(t => t.rows));
  for (const s of [...INST, "203.0.113.7", "198.51.100.2", "Synth anthem"]) assert.ok(!dump.includes(s), `${s} is stored`);
});

test("beat maps: sizes, IDs and rate limits", async () => {
  const e = env({ MAX_POSTS_PER_INSTALL_DAY: "3", MAX_POSTS_PER_IP_DAY: "5", MAX_GETS_PER_IP_HOUR: "4" });
  assert.equal((await call(e, "POST", `/v1/maps/${ID}`, { raw: JSON.stringify({ map: base, pad: "x".repeat(33000) }), install: INST[0] })).status, 413);
  assert.equal((await call(e, "POST", `/v1/maps/not-an-id`, { body: { map: base }, install: INST[0] })).status, 400);
  assert.equal((await call(e, "POST", `/v1/maps/${ID}`, { body: { map: base }, install: "me" })).status, 400, "install ID");
  assert.equal((await call(e, "POST", `/v1/maps/${ID}`, { raw: "{nope", install: INST[0] })).status, 400);
  assert.equal((await call(e, "POST", `/v1/maps/${ID}`, { body: { map: { ...base, bpm: 999 } }, install: INST[0] })).status, 400);
  // per install: 3 a day (the bad ones above counted too)
  const e2 = env({ MAX_POSTS_PER_INSTALL_DAY: "3", MAX_POSTS_PER_IP_DAY: "6" }), codes = [];
  for (let i = 0; i < 4; i++) codes.push((await call(e2, "POST", `/v1/maps/${ID}`, { body: { map: base }, install: INST[0] })).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
  // per IP: 6 a day, whichever install (the refused one above counted)
  for (let i = 1; i <= 2; i++) assert.equal((await call(e2, "POST", `/v1/maps/${ID}`, { body: { map: base }, install: INST[i] })).status, 200);
  assert.equal((await call(e2, "POST", `/v1/maps/${ID}`, { body: { map: base }, install: INST[3] })).status, 429, "this IP sent 6 today");
  assert.equal((await call(e2, "POST", `/v1/maps/${ID}`, { body: { map: base }, install: INST[3], ip: "192.0.2.9" })).status, 200, "another IP may");
  const gets = []; for (let i = 0; i < 5; i++) gets.push((await call(e, "GET", `/v1/maps/${ID}`)).status);
  assert.deepEqual(gets, [404, 404, 404, 404, 429]);
  assert.equal((await call(e, "OPTIONS", `/v1/maps/${ID}`)).status, 204);
});
