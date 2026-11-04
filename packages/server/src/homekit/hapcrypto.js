// The cryptography of HomeKit pairing, all from node:crypto: HKDF-SHA-512 for keys, ChaCha20-Poly1305 (RFC 8439) for
// encrypted messages and the session, Ed25519 for long-term identities and X25519 for Pair Verify. Keys travel as raw
// 32-byte values (as HomeKit sends them), so these helpers turn raw bytes into node:crypto key objects and back.
import crypto from "node:crypto";

/** HKDF-SHA-512 (RFC 5869), 32 bytes by default. */
export const hkdf = (ikm, salt, info, len = 32, hash = "sha512") => Buffer.from(crypto.hkdfSync(hash, ikm, Buffer.from(salt), Buffer.from(info), len));

/** A 96-bit nonce: four zero bytes, then 8 bytes: a label ("PS-Msg05") or a little-endian 64-bit counter. */
export function nonce(x) {
  const n = Buffer.alloc(12);
  if (typeof x === "string") Buffer.from(x, "ascii").copy(n, 4); else n.writeBigUInt64LE(BigInt(x), 4);
  return n;
}
/** ChaCha20-Poly1305: ciphertext followed by the 16-byte tag. */
export function seal(key, n, plain, aad) {
  const c = crypto.createCipheriv("chacha20-poly1305", key, n, { authTagLength: 16 });
  if (aad) c.setAAD(aad, { plaintextLength: plain.length });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
/** The reverse of seal; null when the tag is wrong (wrong key, or changed on the way). */
export function open(key, n, sealed, aad) {
  if (sealed.length < 16) return null;
  try {
    const d = crypto.createDecipheriv("chacha20-poly1305", key, n, { authTagLength: 16 });
    d.setAuthTag(sealed.subarray(sealed.length - 16)); if (aad) d.setAAD(aad, { plaintextLength: sealed.length - 16 });
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  } catch { return null; }
}

const b64u = b => Buffer.from(b).toString("base64url");
const raw = (key, part) => Buffer.from(key.export({ format: "jwk" })[part], "base64url");

/** A new Ed25519 identity: {seed, pub} as raw 32-byte buffers. */
export function edKeyPair() { const { privateKey } = crypto.generateKeyPairSync("ed25519"); return { seed: raw(privateKey, "d"), pub: raw(privateKey, "x") }; }
const edPriv = (seed, pub) => crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64u(seed), x: b64u(pub) }, format: "jwk" });
const edPub = pub => crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(pub) }, format: "jwk" });
export const edSign = (kp, msg) => crypto.sign(null, msg, edPriv(kp.seed, kp.pub));
export function edVerify(pub, msg, sig) { try { return pub.length === 32 && sig.length === 64 && crypto.verify(null, msg, edPub(pub), sig); } catch { return false; } }

/** A new X25519 key pair: {key (node:crypto private key), pub (raw 32 bytes)}. */
export function xKeyPair() { const { privateKey } = crypto.generateKeyPairSync("x25519"); return { key: privateKey, pub: raw(privateKey, "x") }; }
export const xShared = (kp, peerPub) => crypto.diffieHellman({ privateKey: kp.key, publicKey: crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64u(peerPub) }, format: "jwk" }) });

// ---------------------------------------------------------------- setup code, setup ID and the QR code's setup URI
const TRIVIAL = new Set(["00000000", "11111111", "22222222", "33333333", "44444444", "55555555", "66666666", "77777777", "88888888", "99999999", "12345678", "87654321"]);
/** A random setup code, XXX-XX-XXX. HomeKit refuses the trivial ones. */
export function newSetupCode(rand = crypto.randomInt) {
  for (;;) { const d = String(rand(0, 1e8)).padStart(8, "0"); if (!TRIVIAL.has(d)) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`; }
}
/** Four characters, 0-9 A-Z, that tie the QR code to this accessory's mDNS advertisement (the "sh" TXT record). */
export function newSetupId() { const c = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; return Array.from(crypto.randomBytes(4), b => c[b % 36]).join(""); }
/** sh: base64 of the first four bytes of SHA-512(setup ID + device ID). */
export const setupHash = (setupId, deviceId) => crypto.createHash("sha512").update(setupId + deviceId).digest().subarray(0, 4).toString("base64");
/**
 * The X-HM:// setup URI the Home app reads from a QR code: a 45-bit payload in base 36 (9 characters), then the setup ID.
 * Payload bits: 0-26 setup code, 27 NFC, 28 IP, 29 BLE, 31-38 category, 39-41 version (0).
 */
export function setupUri(code, setupId, category = 2) {
  const payload = BigInt(Number(String(code).replace(/-/g, ""))) | (1n << 28n) | (BigInt(category) << 31n);
  return "X-HM://" + payload.toString(36).toUpperCase().padStart(9, "0") + setupId;
}
/** A device ID that looks like a MAC address: AA:BB:CC:DD:EE:FF. */
export const newDeviceId = () => Array.from(crypto.randomBytes(6), b => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
