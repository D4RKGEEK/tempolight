// Now playing: which song the music apps on this computer are playing, and where in it they are, with no accounts
// or passwords. macOS asks Spotify and Music through osascript (JavaScript for Automation), Linux asks every MPRIS
// player (playerctl, or dbus-send when playerctl isn't installed), and Windows asks the media sessions it shows in its
// volume flyout (PowerShell and Windows.Media.Control). Optionally, the Spotify Web API (your own Client ID, PKCE: no
// secret) covers Spotify playing on another device, such as a phone or a smart speaker.
//
// It is read about once a second, and the position is carried forward smoothly between readings. When the track is
// a song Tempolight remembers (same title, and the same length within 3 seconds), the runtime follows its stored beat
// map and show at the player's position, exactly as if the song were played in the app. Otherwise the track is only
// shown ("Now playing"), and live audio, if there is any, drives the lights as usual.
//
// Node only: the online demo (apps/web/demo.js) never loads this file.
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { memoryAnalysis } from "../../engine/src/index.js";
import { HttpError } from "./core.js";

// ---------------------------------------------------------------- running commands (replaced in tests)
/** Runs commands for real. Tests pass their own runner with the same two calls. */
export const nodeRunner = {
  /** One command; resolves {code, stdout, stderr, missing} (missing: the program isn't installed). */
  run(cmd, args, { timeout = 4000 } = {}) {
    return new Promise(resolve => {
      try {
        execFile(cmd, args, { timeout, maxBuffer: 1 << 20, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) =>
          resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), missing: err?.code === "ENOENT" }));
      } catch (e) { resolve({ code: 1, stdout: "", stderr: e.message, missing: e.code === "ENOENT" }); }
    });
  },
  /** A long-running command: onLine for each line it prints, onExit(reason) once when it ends. */
  stream(cmd, args, onLine, onExit) {
    let done = false, buf = "", err = ""; const end = r => { if (!done) { done = true; onExit(r); } };
    let p; try { p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); } catch (e) { end(e.code === "ENOENT" ? "missing" : e.message); return { stop() {} }; }
    p.stdout.setEncoding("utf8"); p.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); } });
    p.stderr.setEncoding("utf8"); p.stderr.on("data", d => { err = (err + d).slice(-2000); });
    p.on("error", e => end(e.code === "ENOENT" ? "missing" : e.message));
    p.on("exit", code => end(code ? `stopped (exit ${code}) ${err.trim().split("\n").pop() || ""}`.trim() : "ended"));
    return { stop() { done = true; try { p.kill(); } catch {} } };
  },
};

const num = v => { const x = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v); return Number.isFinite(x) ? x : 0; };
const clean = s => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
/** A Spotify track ID (22 base-62 characters) from "spotify:track:ID", "/com/spotify/track/ID" or an open.spotify.com link; null otherwise. */
export function spotifyIdOf(s) { const m = /(?:spotify[:/]track[:/]|open\.spotify\.com\/track\/)([0-9A-Za-z]{22})\b/.exec(String(s ?? "")); return m ? m[1] : null; }
const withId = (t, raw) => { const id = spotifyIdOf(raw); return id ? { ...t, spotifyId: id } : t; };

// ---------------------------------------------------------------- macOS: Spotify and Music
// JavaScript for Automation rather than AppleScript: it prints JSON (no locale decimal commas), and an app that
// isn't running (or isn't installed) is skipped without being started. The first time, macOS asks whether the app
// running Tempolight (Terminal, node) may control Spotify / Music.
export const MAC_SCRIPT = `ObjC.import("AppKit");
const running = new Set(), ra = $.NSWorkspace.sharedWorkspace.runningApplications;
for (let i = 0; i < ra.count; i++) { const b = ObjC.unwrap(ra.objectAtIndex(i).bundleIdentifier); if (b) running.add(b); }
const out = [];
for (const [name, id] of [["Spotify", "com.spotify.client"], ["Music", "com.apple.Music"]]) {
  if (!running.has(id)) continue;
  try { const a = Application(id), st = a.playerState(); if (st === "stopped") continue; const t = a.currentTrack();
    out.push({ app: name, state: st, title: t.name(), artist: t.artist(), album: t.album(), duration: t.duration(), position: a.playerPosition(), id: name === "Spotify" ? String(t.id() || "") : "" }); }
  catch (e) { out.push({ app: name, error: String(e.message || e) }); }
}
JSON.stringify(out);`;

/** osascript's output: a JSON list of {app, state, title, artist, album, duration, position}. */
export function parseMac(stdout) {
  const s = String(stdout).trim(); if (!s) return { tracks: [], error: null };
  let list; try { list = JSON.parse(s); } catch { return { tracks: [], error: "Unexpected answer from osascript" }; }
  const errors = list.filter(x => x && x.error).map(x => `${x.app}: ${x.error}`), tracks = [];
  for (const x of list) { if (!x || x.error || !x.title) continue;
    let dur = num(x.duration); if (x.app === "Spotify" || dur > 36000) dur /= 1000; // Spotify gives milliseconds, Music seconds
    tracks.push(withId({ app: x.app, title: clean(x.title), artist: clean(x.artist), album: clean(x.album), dur, pos: num(x.position), playing: x.state === "playing", posOk: true }, x.id)); }
  return { tracks, error: errors.length && !tracks.length ? errors.join("; ") : null };
}
const macHint = e => /-1743|not authori[sz]ed|not allowed/i.test(e) ? "macOS hasn't allowed Tempolight to ask Spotify / Music what's playing. Allow it in System Settings → Privacy & Security → Automation (for Terminal or node), then restart Tempolight." : e;

// ---------------------------------------------------------------- Linux: MPRIS
const SEP = "\u001f";
export const PLAYERCTL_FORMAT = ["{{playerName}}", "{{status}}", "{{xesam:title}}", "{{xesam:artist}}", "{{xesam:album}}", "{{mpris:length}}", "{{position}}", "{{mpris:trackid}}"].join(SEP);
const PLAYER_NAMES = { spotify: "Spotify", vlc: "VLC", rhythmbox: "Rhythmbox", firefox: "Firefox", chromium: "Chromium", chrome: "Chrome", brave: "Brave", mpv: "mpv", strawberry: "Strawberry", elisa: "Elisa", audacious: "Audacious", clementine: "Clementine", lollypop: "Lollypop", cmus: "cmus", kdeconnect: "KDE Connect", plasma: "Plasma browser", tauon: "Tauon", amarok: "Amarok", deadbeef: "DeaDBeeF", quodlibet: "Quod Libet", cider: "Cider", youtube: "YouTube Music" };
const playerName = n => { const k = String(n).replace(/^org\.mpris\.MediaPlayer2\./, "").split(".")[0].toLowerCase(); return PLAYER_NAMES[k] || (k ? k[0].toUpperCase() + k.slice(1) : "A music player"); };

/** `playerctl -a metadata --format PLAYERCTL_FORMAT`: one line per player; lengths and positions in microseconds. */
export function parsePlayerctl(stdout) {
  const tracks = [];
  for (const line of String(stdout).split("\n")) { const f = line.split(SEP); if (f.length < 7 || !f[2].trim()) continue;
    tracks.push(withId({ app: playerName(f[0]), title: clean(f[2]), artist: clean(f[3]), album: clean(f[4]), dur: num(f[5]) / 1e6, pos: num(f[6]) / 1e6, playing: f[1].trim() === "Playing", posOk: true }, f[7])); }
  return tracks;
}

/** dbus-send --print-reply output to plain values: arrays, objects (arrays of dict entries), strings, numbers. */
export function parseDbusReply(text) {
  const toks = [];
  for (const raw of String(text).split("\n")) { let l = raw.trim(); if (!l || /^(method return|signal|error|method call)\b/.test(l)) continue;
    while (l) { let m;
      if (l.startsWith("variant")) { l = l.slice(7).trim(); continue; }
      if ((m = /^(array \[|struct \{)/.exec(l))) { toks.push("["); l = l.slice(m[0].length).trim(); continue; }
      if (l[0] === "]" || l[0] === "}") { toks.push("]"); l = l.slice(1).trim(); continue; }
      if ((m = /^dict entry\(/.exec(l))) { toks.push("("); l = l.slice(m[0].length).trim(); continue; }
      if (l[0] === ")") { toks.push(")"); l = l.slice(1).trim(); continue; }
      if ((m = /^(string|object path|signature) "/.exec(l))) { const s = l.slice(m[0].length); toks.push({ v: s.endsWith('"') ? s.slice(0, -1) : s }); l = ""; continue; } // strings run to the end of the line (dbus-send doesn't escape quotes)
      if ((m = /^(u?int16|u?int32|u?int64|byte|double) (\S+)/.exec(l))) { toks.push({ v: Number(m[2]) }); l = l.slice(m[0].length).trim(); continue; }
      if ((m = /^boolean (true|false)/.exec(l))) { toks.push({ v: m[1] === "true" }); l = l.slice(m[0].length).trim(); continue; }
      l = ""; } }
  let i = 0;
  function value() { const t = toks[i++];
    if (t === "[") { const items = []; while (i < toks.length && toks[i] !== "]") items.push(value()); i++;
      return items.length && items.every(x => x && x.__entry) ? Object.fromEntries(items.map(x => [x.k, x.v])) : items; }
    if (t === "(") { const k = value(), v = value(); while (i < toks.length && toks[i] !== ")") value(); i++; return { __entry: true, k, v }; }
    return t && typeof t === "object" ? t.v : undefined; }
  const out = []; while (i < toks.length) out.push(value());
  return out.length === 1 ? out[0] : out;
}
/** org.freedesktop.DBus.Properties.GetAll of org.mpris.MediaPlayer2.Player, parsed, to a track. */
export function mprisTrack(name, props) {
  const md = props && props.Metadata; if (!md || !md["xesam:title"]) return null;
  const artist = Array.isArray(md["xesam:artist"]) ? md["xesam:artist"].join(", ") : md["xesam:artist"];
  return withId({ app: playerName(name), title: clean(md["xesam:title"]), artist: clean(artist), album: clean(md["xesam:album"]), dur: num(md["mpris:length"]) / 1e6, pos: num(props.Position) / 1e6, playing: props.PlaybackStatus === "Playing", posOk: true }, /spotify/i.test(name) ? md["mpris:trackid"] || md["xesam:url"] : md["xesam:url"]);
}

// ---------------------------------------------------------------- Windows: media sessions (Windows 10 1809 and later)
// One PowerShell process that keeps running and prints a JSON line a second (starting PowerShell every second would
// cost far more than the reading). Windows PowerShell 5.1 (powershell.exe), which can use Windows Runtime types.
export const WINDOWS_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + String.raw`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
while ($true) {
  $list = @()
  try {
    foreach ($s in $mgr.GetSessions()) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $tl = $s.GetTimelineProperties(); $pb = $s.GetPlaybackInfo()
      $list += [pscustomobject]@{ app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; status = [string]$pb.PlaybackStatus; position = $tl.Position.TotalSeconds; start = $tl.StartTime.TotalSeconds; end = $tl.EndTime.TotalSeconds; updated = $tl.LastUpdatedTime.ToUnixTimeMilliseconds() }
    }
  } catch { $list = @([pscustomobject]@{ error = $_.Exception.Message }) }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 3 -InputObject @{ now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); sessions = @($list) }))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}`;
const WIN_APPS = [[/spotify/i, "Spotify"], [/zunemusic|mediaplayer/i, "Media Player"], [/itunes|applemusic/i, "Apple Music"], [/chrome/i, "Chrome"], [/msedge|edge/i, "Edge"], [/firefox|308046B0AF4A39CB/i, "Firefox"], [/vlc/i, "VLC"], [/tidal/i, "TIDAL"], [/deezer/i, "Deezer"], [/amazon/i, "Amazon Music"], [/foobar/i, "foobar2000"], [/musicbee/i, "MusicBee"], [/aimp/i, "AIMP"]];
const winApp = id => (WIN_APPS.find(([re]) => re.test(id || "")) || [null, String(id || "A music app").replace(/\.exe$/i, "").replace(/^.*[!\\]/, "")])[1];
/** One line of the PowerShell loop: {now, sessions: [{app, title, artist, album, status, position, start, end, updated}]}. */
export function parseWindows(line) {
  let j; try { j = JSON.parse(line); } catch { return { tracks: [], error: null }; }
  let list = j.sessions; if (!Array.isArray(list)) list = list ? [list] : [];
  const err = list.find(x => x && x.error), tracks = [];
  for (const x of list) { if (!x || x.error || !x.title) continue;
    const dur = Math.max(0, num(x.end) - num(x.start)), playing = x.status === "Playing";
    let pos = num(x.position) - num(x.start); if (playing && num(x.updated) > 0 && num(j.now) > 0) pos += Math.max(0, (num(j.now) - num(x.updated)) / 1000); // the app reports its position now and then; it has played on since
    tracks.push({ app: winApp(x.app), title: clean(x.title), artist: clean(x.artist), album: clean(x.album), dur, pos: dur ? Math.min(pos, dur) : pos, playing, posOk: dur > 0 && num(x.updated) > 0 }); } // browsers often have no timeline
  return { tracks, error: err && !tracks.length ? err.error : null };
}

// ---------------------------------------------------------------- matching remembered songs
const VERSION_WORDS = /\b(feat|ft|featuring|with|remaster(ed)?|official|video|audio|lyrics?|explicit|clean|hd|hq|4k|visuali[sz]er|mono|stereo|single version|album version|original mix)\b/;
/** A song title (or file name) reduced to its words: lower case, no accents, no "(feat. …)" / "- Remastered 2011". */
export function normTitle(s) {
  return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/_/g, " ")
    .replace(/\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|aiff?|wma|webm)$/, "")
    .replace(/[([{][^)\]}]*[)\]}]/g, m => VERSION_WORDS.test(m) ? " " : m)
    .replace(/\s(feat|ft|featuring)\.?\s.*$/, " ").replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
const titleOnly = t => normTitle(String(t ?? "").replace(/\s[-–—]\s[^-–—]*\b(remaster(ed)?|version|mono|stereo|live|edit|mix)\b.*$/i, m => VERSION_WORDS.test(m.toLowerCase()) || /remaster/i.test(m) ? "" : m));
const artistsOf = a => { const full = normTitle(a); return new Set([full, ...String(a ?? "").split(/\s*(?:,|;|&|\/|\bfeat\.?|\bft\.?|\bx\b|\band\b)\s*/i).map(normTitle)].filter(Boolean)); };
// a remembered song's name (usually a file name: "Artist - Title", "01 Title", "01. Artist - Title") as parts; with and
// without a leading track number, since "99 Problems" starts with a number too
function nameVariants(name) {
  const s0 = String(name ?? "").replace(/\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|aiff?|wma|webm)$/i, ""), s1 = s0.replace(/^\s*(\d{1,2}[-.]?)?\d{1,3}\s*[-.)_]?\s+(?=\D)/, "");
  return [...new Set([s0, s1])].map(s => {
    let parts = s.split(/\s+[-–—]\s+|\s*_-_\s*/); if (parts.length === 1 && /\w-\w/.test(s) && !/\s/.test(s.trim())) parts = s.split("-");
    parts = parts.map(normTitle).filter(p => p && !(VERSION_WORDS.test(p) && p.split(" ").length <= 3));
    return { parts, joined: parts.join(" ") }; });
}
/**
 * The remembered song this track is, if any: the title must match and the length must be within 3 seconds (or, when
 * the player doesn't say how long the track is, the artist must match too).
 * @param {{title:string, artist?:string, dur?:number}} track
 * @param {{id:string, name:string, dur:number}[]} songs
 */
export function matchSong(track, songs) {
  const title = titleOnly(track.title); if (!title || !songs?.length) return null;
  const artists = artistsOf(track.artist), dur = num(track.dur);
  let best = null;
  for (const e of songs) for (const { parts, joined } of nameVariants(e.name)) {
    const others = parts.filter(p => p !== title);
    const artistHit = [...artists].some(a => a && (parts.includes(a) || joined === `${a} ${title}` || joined === `${title} ${a}`));
    const titleHit = parts.includes(title) || joined === title || artistHit && [...artists].some(a => joined === `${a} ${title}` || joined === `${title} ${a}`);
    if (!titleHit) continue;
    const conflict = !artistHit && artists.size > 0 && others.length > 0; // "Someone else - Title"
    const dd = dur > 0 && e.dur > 0 ? Math.abs(e.dur - dur) : null;
    if (dd === null ? !artistHit : dd > (conflict ? 1.5 : 3)) continue;
    const score = (artistHit ? 10 : 0) - (conflict ? 5 : 0) - (dd ?? 3);
    if (!best || score > best.score) best = { e, score };
  }
  return best ? best.e : null;
}

// ---------------------------------------------------------------- Spotify Web API (optional, PKCE)
const SPOTIFY_SCOPES = "user-read-playback-state user-read-currently-playing";
const b64url = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** GET https://api.spotify.com/v1/me/player's answer to a track (null: nothing, or a podcast without a length). */
export function parseSpotifyPlayer(j) {
  const it = j && j.item; if (!it || !it.name) return null;
  const artist = (it.artists || it.show && [{ name: it.show.name }] || []).map(a => a.name).join(", ");
  return { app: "Spotify", device: clean(j.device?.name), title: clean(it.name), artist: clean(artist), album: clean(it.album?.name), dur: num(it.duration_ms) / 1000, pos: num(j.progress_ms) / 1000, playing: !!j.is_playing, posOk: j.progress_ms != null };
}

function createSpotify({ dataDir, fetch, clientId, note, wallNow }) {
  const file = dataDir ? path.join(dataDir, "spotify-token.json") : null;
  let tok = null, pending = null, error = null, backoffUntil = 0;
  try { if (file && existsSync(file)) tok = JSON.parse(readFileSync(file, "utf8")); } catch { tok = null; }
  const save = () => { if (!file) return; if (!tok) { try { rmSync(file, { force: true }); } catch {} return; } const tmp = file + ".tmp"; writeFileSync(tmp, JSON.stringify(tok), { mode: 0o600 }); renameSync(tmp, file); };
  const form = o => new URLSearchParams(o).toString();
  async function tokenCall(body) {
    const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(body) });
    const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error_description || j.error || `Spotify said ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  const keep = (j, id) => { tok = { access_token: j.access_token, refresh_token: j.refresh_token || tok?.refresh_token, expires_at: wallNow() + (num(j.expires_in) || 3600) * 1000, clientId: id }; save(); };
  async function access() {
    if (!tok) return null; if (tok.clientId !== clientId()) { tok = null; save(); return null; } // a different app: sign in again
    if (wallNow() < tok.expires_at - 60_000) return tok.access_token;
    try { keep(await tokenCall({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: tok.clientId }), tok.clientId); return tok.access_token; }
    catch (e) { if (e.status === 400 || e.status === 401) { tok = null; save(); error = "Spotify signed Tempolight out. Connect again."; note(`Spotify: ${error}`, "warn"); } else error = e.message; return null; }
  }
  return {
    get connected() { return !!tok && tok.clientId === clientId(); }, get error() { return error; },
    /** The address to send the browser to; Spotify sends it back to redirectUri with a code. */
    login(redirectUri) {
      if (!clientId()) throw Object.assign(new Error("Paste your Spotify app's Client ID first"), { code: 400 });
      const verifier = b64url(crypto.randomBytes(48)), state = b64url(crypto.randomBytes(16));
      pending = { verifier, state, redirectUri, at: wallNow(), clientId: clientId() }; error = null;
      const q = new URLSearchParams({ response_type: "code", client_id: clientId(), scope: SPOTIFY_SCOPES, redirect_uri: redirectUri, state, code_challenge_method: "S256", code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) });
      return `https://accounts.spotify.com/authorize?${q}`;
    },
    /** Spotify's redirect (or the address pasted from the browser): swap the code for tokens. */
    async finish({ code, state, error: err }) {
      if (err) throw Object.assign(new Error(err === "access_denied" ? "Spotify access was not allowed" : `Spotify said: ${err}`), { code: 400 });
      if (!pending || state !== pending.state || wallNow() - pending.at > 15 * 60_000) throw Object.assign(new Error("That sign-in link is old or wasn't started here. Press Connect Spotify again."), { code: 400 });
      const p = pending; pending = null;
      try { keep(await tokenCall({ grant_type: "authorization_code", code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier }), p.clientId); }
      catch (e) { error = e.message; throw Object.assign(new Error(`Spotify didn't accept the sign-in: ${e.message}`), { code: 400 }); }
      error = null; note("Spotify connected: Tempolight can see what plays on your other devices"); return true;
    },
    disconnect() { tok = null; pending = null; error = null; save(); },
    /** Set by spotify.js while "Sync with Spotify" polls the same endpoint: its latest answer (or null to ask here). */
    feed: null,
    /** A GET on the Web API with the user's token: {status, json, retryAfter} (status 0: not connected or no network). */
    async api(p) {
      if (wallNow() < backoffUntil) return { status: 429, json: null, retryAfter: (backoffUntil - wallNow()) / 1000 };
      const at = await access(); if (!at) return { status: 0, json: null, noAuth: true };
      let r; try { r = await fetch(`https://api.spotify.com${p}`, { headers: { authorization: `Bearer ${at}` } }); } catch (e) { error = e.message; return { status: 0, json: null, error: e.message }; }
      const retryAfter = num(r.headers.get("retry-after"));
      if (r.status === 401) tok.expires_at = 0;
      if (r.status === 429) backoffUntil = wallNow() + (retryAfter || 10) * 1000;
      if (r.ok || r.status === 204) error = null;
      return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null), retryAfter };
    },
    /** What Spotify plays anywhere, or [] (nothing / not connected); null when it couldn't ask. */
    async read() {
      if (this.feed) { const f = this.feed(); if (f) return f; }
      if (wallNow() < backoffUntil) return null;
      const at = await access(); if (!at) return [];
      let r; try { r = await fetch("https://api.spotify.com/v1/me/player", { headers: { authorization: `Bearer ${at}` } }); } catch (e) { error = e.message; return null; }
      if (r.status === 204) { error = null; return []; }
      if (r.status === 401) { tok.expires_at = 0; return null; }
      if (r.status === 429) { backoffUntil = wallNow() + (num(r.headers.get("retry-after")) || 10) * 1000; return null; }
      if (!r.ok) { error = `Spotify said ${r.status}`; return null; }
      error = null; const t = parseSpotifyPlayer(await r.json().catch(() => null)); return t ? [t] : [];
    },
  };
}

// ---------------------------------------------------------------- the reader
const VIA = { macos: "Spotify or Music on this Mac", mpris: "a music player on this computer (MPRIS)", windows: "Windows media controls", spotify: "Spotify (your account)" };

/**
 * @param {{platform?:string, runner?:typeof nodeRunner, now?:()=>number, wallNow?:()=>number, fetch?:Function, dataDir?:string|null,
 *   enabled?:()=>boolean, clientId?:()=>string, songs?:()=>any[], note?:(msg:string, level?:string)=>void}} o
 *   now: milliseconds on the runtime's clock (performance.now()), wallNow: Date.now()
 */
export function createNowPlaying(o = {}) {
  const platform = o.platform || process.platform, runner = o.runner || nodeRunner, now = o.now || (() => performance.now()), wallNow = o.wallNow || Date.now;
  const enabled = o.enabled || (() => true), songs = o.songs || (() => []), note = o.note || (() => {});
  const spotify = createSpotify({ dataDir: o.dataDir, fetch: o.fetch || globalThis.fetch, clientId: o.clientId || (() => ""), note, wallNow });
  const st = { state: "starting", message: "", method: null }; // state: ok | unavailable | error | off
  let cur = null, webTracks = [], webAt = -1e9, webBusy = false, linuxMode = null, win = null, winLatest = null, nextProbe = 0, busy = false, matchKey = "", matched = null, pre = null;

  // reads every player this computer has; each track also gets its time `t` (on the now() clock)
  async function readLocal() {
    if (platform === "darwin") {
      st.method = "osascript"; const t0 = now(), r = await runner.run("osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT]), t = now() - (now() - t0) * 0.2; // the answer is made near the end of the call
      if (r.missing) return unavailable("osascript isn't available");
      if (r.code !== 0) return fail(macHint(r.stderr.trim().split("\n").pop() || `osascript exit ${r.code}`));
      const p = parseMac(r.stdout); if (p.error) return fail(macHint(p.error));
      ok(); return p.tracks.map(x => ({ ...x, t, source: "macos" }));
    }
    if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
      if (linuxMode !== "dbus") {
        const t0 = now(), r = await runner.run("playerctl", ["-a", "metadata", "--format", PLAYERCTL_FORMAT]), t = now() - (now() - t0) * 0.3;
        if (!r.missing) { linuxMode = "playerctl"; st.method = "playerctl";
          if (r.code === 0) { ok(); return parsePlayerctl(r.stdout).map(x => ({ ...x, t, source: "mpris" })); }
          if (/no players/i.test(r.stderr + r.stdout)) { ok(); return []; }
          if (!/unknown option|unrecognized|--format/i.test(r.stderr)) return fail(r.stderr.trim().split("\n").pop() || `playerctl exit ${r.code}`);
        } // not installed, or too old for --format: ask D-Bus directly
        linuxMode = "dbus";
      }
      st.method = "dbus-send";
      const names = await runner.run("dbus-send", ["--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"]);
      if (names.missing) return unavailable("Install playerctl (or dbus-send) to see what's playing");
      if (names.code !== 0) return unavailable(/autolaunch|DBUS_SESSION_BUS_ADDRESS|Unable to autolaunch|No such file/i.test(names.stderr) ? "No desktop session here (no D-Bus session bus): Tempolight needs to run as the user who plays the music" : names.stderr.trim().split("\n").pop() || "dbus-send failed");
      const players = [].concat(parseDbusReply(names.stdout) || []).filter(n => typeof n === "string" && n.startsWith("org.mpris.MediaPlayer2."));
      const out = [];
      for (const n of players.slice(0, 8)) { const t0 = now(), r = await runner.run("dbus-send", ["--session", "--print-reply", `--dest=${n}`, "/org/mpris/MediaPlayer2", "org.freedesktop.DBus.Properties.GetAll", "string:org.mpris.MediaPlayer2.Player"]), t = now() - (now() - t0) * 0.3;
        if (r.code !== 0) continue; const x = mprisTrack(n, parseDbusReply(r.stdout)); if (x) out.push({ ...x, t, source: "mpris" }); }
      ok(); return out;
    }
    if (platform === "win32") {
      st.method = "powershell";
      if (!win) { if (now() < nextProbe) return []; winLatest = null; st.state = st.state === "error" ? "error" : "starting";
        win = runner.stream("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64")],
          line => { const p = parseWindows(line); winLatest = { ...p, t: now() }; },
          why => { win = null; nextProbe = now() + 15000; if (why === "missing") unavailable("Windows PowerShell isn't available"); else fail(`Windows media controls: ${why}. Needs Windows 10 (version 1809) or later.`); }); }
      if (!winLatest) return [];
      if (now() - winLatest.t > 5000) { return fail("Windows media controls stopped answering"); }
      if (winLatest.error) return fail(winLatest.error);
      ok(); return winLatest.tracks.map(x => ({ ...x, t: winLatest.t, source: "windows" }));
    }
    return unavailable(`Not supported on ${platform}`);
  }
  function ok() { st.state = "ok"; st.message = ""; }
  function fail(m) { st.state = "error"; st.message = String(m).slice(0, 300); return []; }
  function unavailable(m) { linuxMode = null; st.state = "unavailable"; st.message = m; nextProbe = now() + 30000; return []; }

  function pick(list) {
    if (!list.length) return null;
    const key = x => `${x.source}|${x.app}|${x.title}|${x.artist}`, list2 = list.filter(x => x.playing).length ? list.filter(x => x.playing) : list;
    return list2.find(x => cur && key(x) === cur.key && matchSong(x, songs())) || list2.find(x => matchSong(x, songs())) || list2.find(x => cur && key(x) === cur.key) || list2[0];
  }
  function take(r) {
    if (!r) { cur = null; return; }
    const key = `${r.source}|${r.app}|${r.title}|${r.artist}`, t = r.t;
    if (cur && cur.key === key) { const pred = cur.pos + (cur.playing ? (t - cur.at) / 1000 : 0), d = r.pos - pred;
      cur.pos = r.playing && cur.playing && Math.abs(d) < 0.75 ? pred + d * 0.3 : r.pos; // small differences are timing noise between readings; a big one is a seek
      cur.zero = r.playing && r.pos === 0 && cur.playing ? cur.zero + 1 : 0; Object.assign(cur, { playing: r.playing, dur: r.dur || cur.dur, at: t, seen: t, posOk: r.posOk && cur.zero < 2, album: r.album, device: r.device, spotifyId: r.spotifyId || null }); }
    else cur = { key, source: r.source, app: r.app, title: r.title, artist: r.artist, album: r.album, device: r.device, dur: r.dur, pos: r.pos, playing: r.playing, at: t, seen: t, zero: 0, posOk: r.posOk, spotifyId: r.spotifyId || null };
  }

  /** Ask the players once (about once a second from start()). */
  async function poll() {
    if (busy) return; busy = true;
    try {
      if (!enabled()) { st.state = "off"; st.message = ""; cur = null; stopWin(); return; }
      if (st.state === "unavailable" && now() < nextProbe) { await webPart([]); return; }
      let local = []; try { local = await readLocal(); } catch (e) { fail(e.message); }
      await webPart(local);
    } finally { busy = false; }
  }
  async function webPart(local) {
    let list = local;
    if (!local.some(x => x.playing) && spotify.connected) { // only when nothing plays here: this computer's own players answer faster
      if (now() - webAt >= 2000 && !webBusy) { webBusy = true; webAt = now(); try { const t0 = now(), w = await spotify.read(), t = (t0 + now()) / 2; if (w) webTracks = w.map(x => ({ ...x, t, source: "spotify" })); } finally { webBusy = false; } }
      if (now() - webAt < 6000) list = [...webTracks.map(x => ({ ...x, pos: x.pos + (x.playing ? (now() - x.t) / 1000 : 0), t: now() })), ...local];
    } else webTracks = [];
    take(pick(list));
  }
  function stopWin() { if (win) { win.stop(); win = null; } }

  let timer = null;
  /** The track now, with its position at time `at` (now() clock); null when nothing is playing or paused. */
  function track(at = now()) {
    if (!cur || at - cur.seen > 6000) return null;
    let pos = cur.pos + (cur.playing ? (at - cur.at) / 1000 : 0); if (cur.dur > 0) pos = Math.min(pos, cur.dur); pos = Math.max(0, pos);
    return { source: cur.source, via: VIA[cur.source], app: cur.app, device: cur.device || null, title: cur.title, artist: cur.artist, album: cur.album, dur: cur.dur, pos, playing: cur.playing, posKnown: cur.posOk, ...(cur.spotifyId ? { spotifyId: cur.spotifyId } : {}) };
  }
  /** The remembered song this track is (cached until the track or the song list changes). */
  function match() {
    if (!cur) return null; const list = songs(), k = `${cur.key}|${cur.dur.toFixed(0)}|${list.length}|${list[list.length - 1]?.id}`;
    if (k !== matchKey) { matchKey = k; const e = matchSong(cur, list); if (e !== matched) { matched = e; pre = null;
      if (e) note(`Now playing: “${cur.title}”${cur.artist ? ` by ${cur.artist}` : ""} in ${cur.app} is the remembered song “${e.name}”: following its beat map`); } }
    if (matched && !list.includes(matched)) { matched = null; pre = null; } return matched;
  }
  return {
    poll, track, match, spotify, platform,
    get supported() { return ["darwin", "linux", "freebsd", "openbsd", "win32"].includes(platform); },
    /** For the runtime: the remembered song's analysis and the position to show, while it plays and its position is known. */
    follow(at = now()) {
      const tr = track(at); if (!tr || !tr.playing || !tr.posKnown) return null;
      const e = match(); if (!e) return null; if (!pre) pre = memoryAnalysis(e);
      return { id: e.id, name: e.name, app: tr.app, pre, pos: tr.pos };
    },
    status() { return { state: enabled() ? st.state : "off", message: st.message, method: st.method }; },
    start(ms = 1000) { clearInterval(timer); timer = setInterval(() => poll().catch(() => {}), ms); poll().catch(() => {}); },
    stop() { clearInterval(timer); timer = null; stopWin(); },
  };
}

// ---------------------------------------------------------------- wiring into the server
/**
 * Starts the reader, gives the runtime `rt.nowPlaying`, and adds the /api/nowplaying routes.
 * @param {{core:object, store:object, runtime:object, dataDir?:string, port?:()=>number, platform?:string, runner?:object, fetch?:Function, interval?:number}} o
 */
export function startNowPlaying({ core, store, runtime, dataDir = null, port = () => 8080, interval = 1000, ...inject }) {
  const data = () => store.data, set = () => data().settings.nowPlaying || (data().settings.nowPlaying = { enabled: true, spotifyClientId: "" });
  const np = createNowPlaying({ ...inject, dataDir, enabled: () => set().enabled !== false, clientId: () => set().spotifyClientId || "", songs: () => data().songs || [], note: (m, l) => runtime.note(m, l) });
  const rt = runtime.rt;
  let following = null;
  rt.nowPlaying = {
    follow(at) { if (data().settings.songMemory === false) return (following = null); following = np.follow(at); return following; },
    get memId() { return following ? following.id : null; },
    info() { const tr = np.track(); if (!tr) return null; const e = np.match();
      return { ...tr, pos: Math.round(tr.pos * 10) / 10, remembered: e ? { id: e.id, name: e.name } : null, following: rt.source === "nowplaying" }; },
  };
  const redirectUri = () => `http://127.0.0.1:${port()}/api/nowplaying/spotify/callback`; // Spotify only allows plain http for 127.0.0.1
  const view = () => ({ enabled: set().enabled !== false, supported: np.supported, platform: np.platform, ...np.status(), track: rt.nowPlaying.info(),
    spotify: { clientId: set().spotifyClientId || "", connected: np.spotify.connected, error: np.spotify.error, redirectUri: redirectUri() } });
  const changed = () => { store.save(); core.broadcast({ type: "changed", what: "nowplaying" }); };
  const httpErr = e => new HttpError(e.code || 400, e.message);

  core.route("GET", "/api/nowplaying", null, () => view());
  core.route("PATCH", "/api/nowplaying", "admin", ctx => { const b = ctx.body || {}, s = set();
    if (b.enabled !== undefined) { s.enabled = !!b.enabled; runtime.note(s.enabled ? "Now playing: reading what music apps on this computer play" : "Now playing: off"); }
    if (b.spotifyClientId !== undefined) { const id = String(b.spotifyClientId || "").trim(); if (id && !/^[0-9a-f]{32}$/i.test(id)) throw httpErr({ code: 400, message: "A Spotify Client ID is 32 letters and digits (0-9, a-f), from developer.spotify.com/dashboard" }); if (id !== s.spotifyClientId) np.spotify.disconnect(); s.spotifyClientId = id; }
    np.poll().catch(() => {}); changed(); return view(); });
  core.route("POST", "/api/nowplaying/spotify/login", "admin", () => { try { return { url: np.spotify.login(redirectUri()), redirectUri: redirectUri() }; } catch (e) { throw httpErr(e); } });
  core.route("POST", "/api/nowplaying/spotify/code", "admin", async ctx => { // the address Spotify sent the browser to, pasted (when that browser isn't on this computer)
    const b = ctx.body || {}; let q; try { q = b.url ? new URL(String(b.url)).searchParams : new URLSearchParams({ code: b.code || "", state: b.state || "" }); } catch { throw httpErr({ code: 400, message: "Paste the whole address from the browser's address bar" }); }
    try { await np.spotify.finish({ code: q.get("code"), state: q.get("state"), error: q.get("error") }); } catch (e) { throw httpErr(e); } changed(); return view(); });
  core.route("DELETE", "/api/nowplaying/spotify", "admin", () => { np.spotify.disconnect(); runtime.note("Spotify disconnected"); changed(); return view(); });

  /** Spotify's redirect after sign-in: a small page, not JSON. Returns true when it handled the request. */
  async function handleHttp(req, res, url) {
    if (req.method !== "GET" || url.pathname !== "/api/nowplaying/spotify/callback") return false;
    let msg, okk = true; try { await np.spotify.finish({ code: url.searchParams.get("code"), state: url.searchParams.get("state"), error: url.searchParams.get("error") }); msg = "Spotify is connected. You can close this tab."; changed(); }
    catch (e) { okk = false; msg = e.message; }
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    res.writeHead(okk ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Tempolight</title><body style="font:16px system-ui;padding:32px;background:#111;color:#eee"><h1 style="font-size:20px">Tempolight</h1><p>${esc(msg)}</p><p><a style="color:#f5a524" href="/#/music">Back to Tempolight</a></p></body>`);
    return true;
  }
  if (interval > 0) np.start(interval);
  return { np, handleHttp, view, close() { np.stop(); delete rt.nowPlaying; } };
}
