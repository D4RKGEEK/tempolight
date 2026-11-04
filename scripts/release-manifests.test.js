// The package manager manifests in packaging/ fill in completely from a release's checksums.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSums, writeManifests } from "./release-manifests.js";

export const ASSETS = ["tempolight-windows-x64.exe", "tempolight-macos-arm64.zip", "tempolight-macos-x64.zip", "tempolight-linux-x64.tar.gz", "tempolight-linux-arm64.tar.gz"];

test("manifests: every placeholder is filled from SHA256SUMS.txt", () => {
  const sums = parseSums(ASSETS.map((a, i) => `${String(i + 1).repeat(64)}  ${a}`).join("\n") + "\n");
  assert.equal(Object.keys(sums).length, ASSETS.length);
  const out = mkdtempSync(path.join(os.tmpdir(), "tl-manifests-"));
  try {
    const files = writeManifests({ version: "1.2.3", date: "2026-01-02", sums, out });
    assert.equal(files.length, 5);
    for (const f of files) {
      const s = readFileSync(path.join(out, f), "utf8");
      assert.doesNotMatch(s, /\{\{|^#~/m, f);
      assert.match(s, /1\.2\.3/, f);
    }
    const scoop = JSON.parse(readFileSync(path.join(out, "homebrew-tempolight/bucket/tempolight.json"), "utf8"));
    assert.equal(scoop.architecture["64bit"].hash, "1".repeat(64));
    assert.equal(scoop["##"], undefined);
    const inst = readFileSync(path.join(out, "winget/manifests/d/D4RKGEEK/Tempolight/1.2.3/D4RKGEEK.Tempolight.installer.yaml"), "utf8");
    assert.match(inst, /InstallerSha256: 1{64}/);
    assert.match(inst, /ReleaseDate: 2026-01-02/);
    const rb = readFileSync(path.join(out, "homebrew-tempolight/Formula/tempolight.rb"), "utf8");
    for (const a of ASSETS.filter(a => !a.endsWith(".exe"))) assert.match(rb, new RegExp(`v1\\.2\\.3/${a.replace(/\./g, "\\.")}"`));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("manifests: a missing checksum is an error, not a broken manifest", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "tl-manifests-"));
  try { assert.throws(() => writeManifests({ version: "1.2.3", sums: {}, out }), /no checksum for tempolight-/); }
  finally { rmSync(out, { recursive: true, force: true }); }
});
