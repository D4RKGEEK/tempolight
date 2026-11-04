// One-click updates for installs made with git (the installer and `git clone` both use it): check GitHub for new
// commits, pull them, and restart. Docker installs update by pulling the new image instead.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// git never asks for a password or a host key here (there's nobody to answer): it fails, and the message says why
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes", LC_ALL: "C" };
const git = (root, args, timeout = 30000) => new Promise((res, rej) => execFile("git", ["-C", root, ...args], { timeout, env: GIT_ENV, windowsHide: true }, (e, out, err) => {
  if (!e) return res(out.trim());
  if (e.code === "ENOENT") return rej(new Error("git isn't installed (or isn't on the PATH)"));
  if (e.killed) return rej(new Error(`git ${args[0]} took too long (no connection to GitHub?)`));
  rej(new Error((String(err || "").trim() || e.message).split("\n").filter(Boolean).pop()));
}));
// what a failed git command means, in plain words
function explain(msg) {
  if (/no upstream|does not point to a branch|HEAD detached|no such branch/i.test(msg)) return "This copy isn't on a branch that follows GitHub (a detached checkout or a local branch), so it can't update by itself. Run git pull in its folder.";
  if (/could not resolve host|unable to access|could not read from remote|connection|timed out|took too long/i.test(msg)) return `Couldn't reach GitHub: ${msg}`;
  return `Couldn't check for updates: ${msg}`;
}

export function createUpdater(root, { exit = code => process.exit(code), restart = defaultRestart } = {}) {
  const method = () => existsSync(path.join(root, ".git")) ? "git" : existsSync("/.dockerenv") ? "docker" : "manual";
  let checking = null, applying = false;
  function check() { return checking ||= doCheck().finally(() => { checking = null; }); } // one fetch at a time, however many tabs ask
  async function doCheck() {
    const m = method();
    if (m === "docker") return { method: m, canUpdate: false, message: "Running in Docker: update with  docker compose pull && docker compose up -d  (or rebuild the image)." };
    if (m === "manual") return { method: m, canUpdate: false, message: "This copy wasn't installed with git. Run the installer again to update it." };
    try {
      const current = await git(root, ["rev-parse", "--short", "HEAD"]);
      await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]); // fails with no upstream / detached HEAD
      await git(root, ["fetch", "--quiet"]);
      const [ahead, behind] = (await git(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])).split(/\s+/).map(Number);
      const changes = behind ? (await git(root, ["log", "--format=%s", "-n", "8", "HEAD..@{u}"])).split("\n").filter(Boolean) : [];
      const dirty = (await git(root, ["status", "--porcelain", "--untracked-files=no"])).length > 0;
      const message = behind === 0 ? "Tempolight is up to date." : dirty ? "There are local changes to Tempolight's files, so it can't update by itself. Run git pull in its folder."
        : ahead ? "This copy has commits of its own that GitHub doesn't have, so it can't update by itself. Run git pull in its folder." : `${behind} update${behind > 1 ? "s" : ""} available.`;
      return { method: m, current, behind, ahead, changes, dirty, canUpdate: behind > 0 && !dirty && !ahead, message };
    } catch (e) { return { method: m, canUpdate: false, message: explain(e.message) }; }
  }
  async function apply() {
    if (applying) throw Object.assign(new Error("An update is already running"), { code: 409 });
    applying = true;
    try {
      const c = await check(); if (!c.canUpdate) throw Object.assign(new Error(c.message), { code: 400 });
      try { await git(root, ["merge", "--ff-only", "--quiet", "@{u}"], 120000); } // the commits the check just fetched, nothing newer and no second fetch
      catch (e) { throw Object.assign(new Error(`The update didn't apply (${e.message}). Run git pull in Tempolight's folder.`), { code: 400 }); }
    } catch (e) { applying = false; throw e; }
    setTimeout(() => { applying = false; restart(exit); }, 500); // let the answer reach the browser first
    return { ok: true, message: "Updated. Tempolight is restarting; this page reconnects by itself." };
  }
  return { method, check, apply };
}

// Started by systemd (our installer's service, or one set up by hand)? Then exit with code 3 and let it start the new
// version: both Restart=always and Restart=on-failure restart on a non-zero exit. INVOCATION_ID alone isn't enough
// (terminals started from a systemd user service inherit it), so the parent must be systemd too.
export function supervised(env = process.env, ppid = process.ppid) {
  if (env.TEMPOLIGHT_SUPERVISED === "1") return true;
  if (!env.INVOCATION_ID) return false;
  if (ppid === 1) return true;
  try { return readFileSync(`/proc/${ppid}/comm`, "utf8").trim() === "systemd"; } catch { return false; }
}
// otherwise start a copy of ourselves once this one has let go of its ports, then exit
function defaultRestart(exit) {
  if (supervised()) return exit(3);
  const args = [...process.execArgv, ...process.argv.slice(1).filter(a => a !== "--open")];
  // on Windows a detached child gets a console window of its own; a plain child already outlives its parent there
  exit(0, () => spawn(process.execPath, args, { detached: process.platform !== "win32", stdio: "inherit", windowsHide: true, env: { ...process.env, TEMPOLIGHT_RESTART_WAIT: "1" } }).unref());
}
