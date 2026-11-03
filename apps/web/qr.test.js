import test from "node:test";
import assert from "node:assert/strict";
import { qrMatrix, qrSvg } from "./qr.js";

// decoding was checked with OpenCV's QR reader; these guard the structure
test("QR codes have the right size, finder patterns and timing", () => {
  for (const [text, version] of [["hi", 1], ["http://192.168.1.20:8080/phone", 3], ["a".repeat(200), 10]]) {
    const M = qrMatrix(text), n = M.length; assert.equal(n, version * 4 + 17, text.slice(0, 20));
    for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) { assert.ok(M[y][x] && M[y + 3][x + 3] && !M[y + 1][x + 1], "finder"); }
    for (let i = 8; i < n - 8; i++) assert.equal(M[6][i], i % 2 === 0, "timing row");
    assert.equal(M[n - 8][8], true, "dark module");
  }
  assert.match(qrSvg("hello"), /^<svg[^>]+viewBox="0 0 29 29"/);
  assert.throws(() => qrMatrix("x".repeat(1000)));
});
