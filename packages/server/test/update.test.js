import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUpdater, supervised } from "../src/update.js";

const hasGit = (() => { try { execFileSync("git", ["--version"]); return true; } catch { return false; } })();
test("one-click update: finds new commits, pulls them and restarts", { skip: !hasGit && "git is not installed" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-upd-")), g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();
  try {
    const origin = path.join(dir, "origin.git"), dev = path.join(dir, "dev"), inst = path.join(dir, "install");
    g(dir, "init", "-q", "--bare", "-b", "main", origin); g(dir, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
    writeFileSync(path.join(dev, "a.txt"), "1"); g(dev, "add", "."); g(dev, "commit", "-qm", "first"); g(dev, "push", "-q", "origin", "main");
    g(dir, "clone", "-q", origin, inst);
    let restarted = 0; const u = createUpdater(inst, { restart: () => restarted++ });
    assert.equal(u.method(), "git");
    let c = await u.check(); assert.equal(c.behind, 0); assert.equal(c.canUpdate, false); assert.match(c.message, /up to date/);
    writeFileSync(path.join(dev, "a.txt"), "2"); g(dev, "commit", "-qam", "New effects"); g(dev, "push", "-q", "origin", "main");
    c = await u.check(); assert.equal(c.behind, 1); assert.deepEqual(c.changes, ["New effects"]); assert.equal(c.canUpdate, true);
    writeFileSync(path.join(inst, "a.txt"), "local edit"); assert.equal((await u.check()).canUpdate, false, "local changes block the update");
    g(inst, "checkout", "-q", "a.txt");
    const r = await u.apply(); assert.equal(r.ok, true); assert.equal(readFileSync(path.join(inst, "a.txt"), "utf8"), "2");
    await new Promise(res => setTimeout(res, 700)); assert.equal(restarted, 1);
    await assert.rejects(u.apply(), /up to date/);
    assert.equal(createUpdater(dir).method(), process.platform === "linux" && require_docker() ? "docker" : "manual");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
function require_docker() { try { readFileSync("/.dockerenv"); return true; } catch { return false; } }

test("one-click update: no upstream, detached, diverged, busy, and git missing all say why instead of breaking", { skip: !hasGit && "git is not installed" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tl-upd-")), env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"], env }).toString().trim();
  try {
    const origin = path.join(dir, "origin.git"), dev = path.join(dir, "dev"), inst = path.join(dir, "install");
    g(dir, "init", "-q", "--bare", "-b", "main", origin); g(dir, "clone", "-q", origin, dev); g(dev, "checkout", "-q", "-b", "main");
    writeFileSync(path.join(dev, "a.txt"), "1"); g(dev, "add", "."); g(dev, "commit", "-qm", "first"); g(dev, "push", "-q", "origin", "main");
    g(dir, "clone", "-q", origin, inst);
    let restarted = 0; const u = createUpdater(inst, { restart: () => restarted++ });
    writeFileSync(path.join(dev, "a.txt"), "2"); g(dev, "commit", "-qam", "Second"); g(dev, "push", "-q", "origin", "main");
    // two tabs press Update at once: one update, one restart
    const both = await Promise.allSettled([u.apply(), u.apply()]);
    assert.equal(both.filter(r => r.status === "fulfilled").length, 1); assert.equal(both.find(r => r.status === "rejected").reason.code, 409);
    await new Promise(res => setTimeout(res, 700)); assert.equal(restarted, 1);
    // local commits GitHub doesn't have: no update (a fast-forward is impossible), but no crash either
    writeFileSync(path.join(dev, "a.txt"), "3"); g(dev, "commit", "-qam", "Third"); g(dev, "push", "-q", "origin", "main");
    writeFileSync(path.join(inst, "b.txt"), "mine"); g(inst, "add", "."); g(inst, "commit", "-qm", "local");
    let c = await u.check(); assert.equal(c.behind, 1); assert.equal(c.ahead, 1); assert.equal(c.canUpdate, false); assert.match(c.message, /commits of its own/);
    g(inst, "reset", "-q", "--hard", "origin/main~1");
    // a local branch with no upstream, and a detached checkout
    g(inst, "checkout", "-q", "-b", "mine"); c = await u.check(); assert.equal(c.canUpdate, false); assert.match(c.message, /isn't on a branch that follows GitHub/);
    g(inst, "checkout", "-q", "--detach", "main"); c = await u.check(); assert.equal(c.canUpdate, false); assert.match(c.message, /isn't on a branch that follows GitHub/);
    await assert.rejects(u.apply(), /isn't on a branch/);
    // GitHub can't be reached
    g(inst, "checkout", "-q", "main"); g(inst, "remote", "set-url", "origin", path.join(dir, "gone.git"));
    c = await u.check(); assert.equal(c.canUpdate, false); assert.match(c.message, /Couldn't (reach GitHub|check for updates)/);
    // git isn't installed: a fresh copy of the module that sees no git on the PATH
    const PATH = process.env.PATH; process.env.PATH = path.join(dir, "no-such-dir");
    let fresh; try { fresh = await import("../src/update.js?nogit"); } finally { process.env.PATH = PATH; }
    c = await fresh.createUpdater(inst, { restart() {} }).check(); assert.equal(c.canUpdate, false); assert.match(c.message, /git isn't installed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("one-click update: restarts through systemd only when systemd really started us", () => {
  assert.equal(supervised({ TEMPOLIGHT_SUPERVISED: "1" }, 4242), true, "our installer's service says so");
  assert.equal(supervised({ INVOCATION_ID: "abc" }, 1), true, "a system service: systemd is the parent");
  assert.equal(supervised({}, 1), false, "not under systemd");
  assert.equal(supervised({ INVOCATION_ID: "abc" }, 999999999), false, "a terminal that inherited INVOCATION_ID: start a copy instead");
});
