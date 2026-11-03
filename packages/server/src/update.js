// One-click updates for installs made with git (the installer and `git clone` both use it): check GitHub for new
// commits, pull them, and restart. Docker installs update by pulling the new image instead.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const git = (root, args, timeout = 30000) => new Promise((res, rej) => execFile("git", ["-C", root, ...args], { timeout }, (e, out, err) => e ? rej(new Error((err || e.message).trim().split("\n").pop())) : res(out.trim())));

export function createUpdater(root, { exit = code => process.exit(code), restart = defaultRestart } = {}) {
  const method = () => existsSync(path.join(root, ".git")) ? "git" : existsSync("/.dockerenv") ? "docker" : "manual";
  async function check() {
    const m = method();
    if (m === "docker") return { method: m, canUpdate: false, message: "Running in Docker: update with  docker compose pull && docker compose up -d  (or rebuild the image)." };
    if (m === "manual") return { method: m, canUpdate: false, message: "This copy wasn't installed with git. Run the installer again to update it." };
    try {
      await git(root, ["fetch", "--quiet", "origin"]);
      const current = await git(root, ["rev-parse", "--short", "HEAD"]), behind = Number(await git(root, ["rev-list", "--count", "HEAD..@{u}"]));
      const changes = behind ? (await git(root, ["log", "--format=%s", "-n", "8", "HEAD..@{u}"])).split("\n").filter(Boolean) : [];
      const dirty = (await git(root, ["status", "--porcelain", "--untracked-files=no"])).length > 0;
      return { method: m, current, behind, changes, dirty, canUpdate: behind > 0 && !dirty,
        message: behind === 0 ? "Tempolight is up to date." : dirty ? "There are local changes to Tempolight's files, so it can't update by itself. Run git pull in its folder." : `${behind} update${behind > 1 ? "s" : ""} available.` };
    } catch (e) { return { method: m, canUpdate: false, message: `Couldn't check for updates: ${e.message}` }; }
  }
  async function apply() {
    const c = await check(); if (!c.canUpdate) throw Object.assign(new Error(c.message), { code: 400 });
    await git(root, ["pull", "--ff-only", "--quiet"], 120000);
    setTimeout(() => restart(exit), 500); // let the answer reach the browser first
    return { ok: true, message: "Updated. Tempolight is restarting; this page reconnects by itself." };
  }
  return { method, check, apply };
}

// under systemd (or another supervisor) exit and let it start the new version; otherwise start it ourselves
function defaultRestart(exit) {
  if (process.env.INVOCATION_ID || process.env.TEMPOLIGHT_SUPERVISED) return exit(3);
  const args = process.argv.slice(1).filter(a => a !== "--open");
  spawn(process.execPath, args, { detached: true, stdio: "inherit", env: { ...process.env, TEMPOLIGHT_RESTART_WAIT: "1" } }).unref();
  exit(0);
}
