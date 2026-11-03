import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUpdater } from "../src/update.js";

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
