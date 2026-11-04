// TLV8, the type-length-value format of HomeKit pairing messages (HAP specification, "TLV8 Encoding"): one byte of
// type, one byte of length, then up to 255 bytes of value. A longer value is split into items of the same type that
// follow each other, and joined again when read. A list of entries (pairings) puts a Separator (0xFF, empty) between
// them, so the same type can repeat without being joined.

export const T = { Method: 0, Identifier: 1, Salt: 2, PublicKey: 3, Proof: 4, EncryptedData: 5, State: 6, Error: 7, RetryDelay: 8,
  Certificate: 9, Signature: 10, Permissions: 11, FragmentData: 12, FragmentLast: 13, Flags: 19, Separator: 0xff };
export const ERR = { Unknown: 1, Authentication: 2, Backoff: 3, MaxPeers: 4, MaxTries: 5, Unavailable: 6, Busy: 7 };
export const METHOD = { PairSetup: 0, PairSetupWithAuth: 1, PairVerify: 2, AddPairing: 3, RemovePairing: 4, ListPairings: 5 };

const asBuf = v => Buffer.isBuffer(v) ? v : typeof v === "number" ? Buffer.from([v]) : typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v);

/** [[type, value], …] (value: Buffer, string or a small number) to bytes. */
export function encode(items) {
  const out = [];
  for (const [type, v] of items) {
    const b = asBuf(v);
    if (!b.length) { out.push(Buffer.from([type, 0])); continue; }
    for (let i = 0; i < b.length; i += 255) { const part = b.subarray(i, i + 255); out.push(Buffer.from([type, part.length]), part); }
  }
  return Buffer.concat(out);
}

/** Bytes to a list of [type, Buffer], with split values joined. */
export function decodeList(buf) {
  const out = []; let last = -1;
  for (let i = 0; i < buf.length;) {
    if (i + 2 > buf.length) throw new Error("TLV8 item is cut short");
    const type = buf[i], len = buf[i + 1], v = buf.subarray(i + 2, i + 2 + len);
    if (v.length !== len) throw new Error("TLV8 value is cut short");
    if (type === last && type !== T.Separator && out.length) out[out.length - 1][1] = Buffer.concat([out[out.length - 1][1], v]); // the next part of a long value
    else out.push([type, Buffer.from(v)]);
    last = type; i += 2 + len;
  }
  return out;
}

/** Bytes to {type: Buffer} (the first of each type). */
export function decode(buf) { const o = {}; for (const [t, v] of decodeList(buf)) if (!(t in o)) o[t] = v; return o; }
