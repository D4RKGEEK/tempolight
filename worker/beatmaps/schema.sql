-- Tempolight shared beat maps (Cloudflare D1). No personal data: no names, no accounts, no titles; install IDs and IP
-- addresses only as salted SHA-256 hashes (for "two different installs agree" and rate limits).

-- what each install sent for a track (one per install and track; sending again replaces it)
CREATE TABLE IF NOT EXISTS submissions (
  spotify_id TEXT NOT NULL,
  install    TEXT NOT NULL,   -- hash of the anonymous install ID
  ip         TEXT NOT NULL,   -- hash of the sender's IP address (abuse handling only)
  created    INTEGER NOT NULL,-- ms since 1970
  bpm        REAL NOT NULL,
  cover      REAL NOT NULL,   -- seconds of the track the map covers
  body       TEXT NOT NULL,   -- the map, as checked JSON (at most 32 KB)
  PRIMARY KEY (spotify_id, install)
);
CREATE INDEX IF NOT EXISTS submissions_track ON submissions (spotify_id, created);

-- the confirmed map per track: at least two installs agree (tempo within 1%, beats within 30 ms, drops roughly)
CREATE TABLE IF NOT EXISTS maps (
  spotify_id TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  installs   INTEGER NOT NULL,
  updated    INTEGER NOT NULL
);

-- rate limits: k is "post-install:<hash>:<day>", "post-ip:<hash>:<day>" or "get-ip:<hash>:<hour>"
CREATE TABLE IF NOT EXISTS rate (
  k     TEXT PRIMARY KEY,
  n     INTEGER NOT NULL,
  reset INTEGER NOT NULL
);
