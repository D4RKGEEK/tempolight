// Game events on the lights: Valve's Game State Integration (GSI) for Counter-Strike 2 and Dota 2. The game posts its
// state as JSON to POST /api/gsi/<game> (see index.js) a few times a second while something changes; this file turns
// those posts into events (a kill, a flashbang, the bomb planted, a round won) and, every frame, into layers that are
// drawn on top of the music show: a colour that a zone takes on (health from green to red), or a short flash.
//
// No Node.js modules here: everything is plain data in, plain data out, with the clock passed in, so it's easy to test.
// Layers: {target, color:[r,g,b] 0..1, mix} replaces the show's colour by `mix`; {target, color, add} adds a flash.
// target is "all", "zone:<id>", "dev:<id>" (as in Home & sleep) or "off".

export const GAMES = {
  cs2: { name: "Counter-Strike 2", appid: 730, file: "gamestate_integration_tempolight.cfg", folder: "game/csgo/cfg" },
  dota2: { name: "Dota 2", appid: 570, file: "gamestate_integration_tempolight.cfg", folder: "game/dota/cfg/gamestate_integration" },
};
export const TEAM = { CT: [0.36, 0.47, 0.68], T: [0.87, 0.61, 0.21], radiant: [0.18, 0.75, 0.3], dire: [0.86, 0.2, 0.12] };
const WHITE = [1, 1, 1], RED = [1, 0, 0];
export const BOMB_SECONDS = 40; // CS2's C4 timer

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
/** 0 (dead) .. 1 (full): red through orange and yellow to green. */
export function healthColor(f) { const h = clamp(f) * 120 / 60, x = 1 - Math.abs((h % 2) - 1); return h < 1 ? [1, x, 0] : [x, 1, 0]; }
/** The C4 beeps, in seconds after it was planted: about one a second at first, faster and faster towards the end. */
export function bombBeeps(total = BOMB_SECONDS) { const out = []; for (let t = 0; t < total;) { out.push(t); t += 0.12 + 0.88 * Math.pow((total - t) / total, 1.3); } return out; }
const BEEPS = bombBeeps();
const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c || "")); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

export const GAME_DEFAULTS = () => ({
  cs2: { enabled: false, token: "", intensity: 0.8, mode: "blend", healthTarget: "all", effectsTarget: "all", kills: true, flashbang: true, bomb: true, rounds: true },
  dota2: { enabled: false, token: "", intensity: 0.8, mode: "blend", healthTarget: "all", manaTarget: "off", ambientTarget: "off", effectsTarget: "all", kills: true, roshan: true, daynight: true },
});

/**
 * @param {{now?:()=>number}} [o] now: milliseconds (Date.now by default)
 */
export function createGames({ now = () => Date.now() } = {}) {
  const S = { cs2: freshCs(), dota2: freshDota() };
  function freshCs() { return { at: 0, inGame: false, own: true, team: null, health: 100, flashed: 0, flashSmooth: 0, burning: false, bomb: null, kills: null, hs: null, roundKey: null, hold: null, flashes: [], lastEvents: [], map: null, phase: null }; }
  function freshDota() { return { at: 0, inGame: false, hp: 100, mana: 100, alive: true, day: true, kills: null, deaths: null, hold: null, flashes: [], seenEvents: new Set(), roshan: null, win: null, lastEvents: [], map: null, team: null }; }
  const flash = (st, color, amount, t, kind = "kills") => { st.flashes.push({ t, color, amount, kind }); if (st.flashes.length > 12) st.flashes.shift(); };

  /** One GSI post. Returns the events it brought ([{type, ...}]); unknown games throw. */
  function ingest(game, p) {
    if (!S[game]) throw new Error(`Unknown game "${game}"`);
    return game === "cs2" ? ingestCs(p || {}) : ingestDota(p || {});
  }

  function ingestCs(p) {
    const st = S.cs2, t = now(), ev = [];
    st.at = t; const pl = p.player || {}, map = p.map || null, round = p.round || {};
    st.inGame = !!map && pl.activity !== "menu"; st.map = map ? map.name : null; st.phase = map ? map.phase : null;
    if (!st.inGame) { const keep = st.at; Object.assign(st, freshCs(), { at: keep }); return ev; }
    // GSI follows whoever you are watching: when that isn't you (you are dead, or spectating), your own numbers aren't there
    const mine = !p.provider?.steamid || !pl.steamid || pl.steamid === p.provider.steamid; st.own = mine;
    if (mine && pl.team) st.team = pl.team;
    const ps = pl.state || {};
    if (mine) {
      if (ps.health != null) st.health = clamp(Number(ps.health) / 100);
      st.flashed = clamp(Number(ps.flashed || 0) / 255); st.burning = Number(ps.burning || 0) > 0;
      const k = Number(ps.round_kills ?? NaN), h = Number(ps.round_killhs ?? NaN);
      if (Number.isFinite(k)) { if (st.kills != null && k > st.kills) { const head = Number.isFinite(h) && st.hs != null && h > st.hs; ev.push({ type: "kill", headshot: head, n: k - st.kills }); flash(st, head ? [1, 0.25, 0.2] : WHITE, 0.9, t); } st.kills = k; }
      if (Number.isFinite(h)) st.hs = h;
      if (st.flashed > 0.05 && !(p.previously?.player?.state?.flashed > 0)) ev.push({ type: "flashbang", amount: st.flashed });
    } else { st.health = 0; st.flashed = 0; st.burning = false; }
    // the bomb: planted, then defused or exploded
    const b = round.bomb;
    if (b === "planted" && !st.bomb) { st.bomb = { at: t }; ev.push({ type: "bomb_planted" }); }
    else if (b === "defused" && st.bomb) { st.bomb = null; ev.push({ type: "bomb_defused" }); flash(st, TEAM.CT, 1.2, t, "bomb"); }
    else if (b === "exploded" && st.bomb) { st.bomb = null; ev.push({ type: "bomb_exploded" }); flash(st, [1, 0.45, 0.05], 2, t, "bomb"); }
    else if (b !== "planted") st.bomb = null;
    if (st.bomb && t - st.bomb.at > (BOMB_SECONDS + 3) * 1000) st.bomb = null;
    // the round's end: the winning team's colour for a few seconds
    if (round.phase === "over" && round.win_team) {
      const key = `${map.round}:${round.win_team}`;
      if (st.roundKey !== key) { st.roundKey = key; st.bomb = null; const won = st.team ? st.team === round.win_team : null;
        st.hold = { color: TEAM[round.win_team] || WHITE, at: t, until: t + 3500, kind: "rounds" }; ev.push({ type: won === null ? "round_over" : won ? "round_won" : "round_lost", team: round.win_team }); }
    } else if (round.phase && round.phase !== "over") st.roundKey = null;
    st.lastEvents = [...st.lastEvents, ...ev.map(e => ({ ...e, at: t }))].slice(-8);
    return ev;
  }

  function ingestDota(p) {
    const st = S.dota2, t = now(), ev = [];
    st.at = t; const map = p.map || null, hero = p.hero || {}, pl = p.player || {};
    const state = map ? String(map.game_state || "") : "";
    st.inGame = !!map && !!p.hero && !/DISCONNECT|INIT|WAIT_FOR_PLAYERS/.test(state); st.map = map ? map.name : null;
    if (!st.inGame) { const keep = st.at; Object.assign(st, freshDota(), { at: keep }); return ev; }
    if (pl.team_name) st.team = pl.team_name;
    if (hero.health_percent != null) st.hp = clamp(Number(hero.health_percent) / 100);
    if (hero.mana_percent != null) st.mana = clamp(Number(hero.mana_percent) / 100);
    if (hero.alive != null) { const was = st.alive; st.alive = !!hero.alive; if (was && !st.alive) ev.push({ type: "death" }); else if (!was && st.alive) ev.push({ type: "respawn" }); }
    const day = !(map.daytime === false || map.nightstalker_night === true); if (day !== st.day) { st.day = day; ev.push({ type: day ? "day" : "night" }); }
    const k = Number(pl.kills ?? NaN); if (Number.isFinite(k)) { if (st.kills != null && k > st.kills) { ev.push({ type: "kill", n: k - st.kills }); flash(st, [1, 0.85, 0.4], 0.9, t); } st.kills = k; }
    // Roshan: the "events" list (newer clients), or the Roshan state in the map block
    for (const e of Array.isArray(p.events) ? p.events : []) { const id = `${e.event_type}:${e.game_time}:${e.player_id ?? ""}`; if (st.seenEvents.has(id)) continue; st.seenEvents.add(id);
      if (st.seenEvents.size > 200) st.seenEvents = new Set([...st.seenEvents].slice(-100));
      if (e.event_type === "roshan_killed") { ev.push({ type: "roshan_killed", team: e.team || null }); st.hold = { color: [0.65, 0.2, 1], at: t, until: t + 3000, pulse: true, kind: "roshan" }; }
      else if (e.event_type === "aegis_picked_up") { ev.push({ type: "aegis" }); flash(st, [1, 0.8, 0.2], 1.2, t, "roshan"); } }
    const rs = map.roshan_state; if (rs && st.roshan === "alive" && rs !== "alive" && !ev.some(e => e.type === "roshan_killed")) { ev.push({ type: "roshan_killed", team: null }); st.hold = { color: [0.65, 0.2, 1], at: t, until: t + 3000, pulse: true, kind: "roshan" }; }
    if (rs) st.roshan = rs;
    const win = map.win_team && map.win_team !== "none" ? map.win_team : null;
    if (win && st.win !== win) { st.win = win; ev.push({ type: st.team ? (st.team === win ? "match_won" : "match_lost") : "match_over", team: win }); st.hold = { color: TEAM[win] || WHITE, at: t, until: t + 8000, kind: "rounds" }; }
    st.lastEvents = [...st.lastEvents, ...ev.map(e => ({ ...e, at: t }))].slice(-8);
    return ev;
  }

  /** Pretend events, for the "Try it" buttons: flash, bomb, kill, win, lose, roshan, night, day, low (health). */
  function test(game, what) {
    const st = S[game]; if (!st) throw new Error(`Unknown game "${game}"`); const t = now();
    st.at = t; st.inGame = true; st.test = t;
    if (what === "flash") { st.flashed = 1; st.testFlash = t; } else if (what === "kill") flash(st, WHITE, 0.9, t);
    else if (what === "bomb") st.bomb = { at: t };
    else if (what === "win" || what === "lose") { const my = game === "cs2" ? st.team || "CT" : st.team || "radiant", other = game === "cs2" ? (my === "CT" ? "T" : "CT") : (my === "radiant" ? "dire" : "radiant"); st.hold = { color: TEAM[what === "win" ? my : other], at: t, until: t + 3500, kind: "rounds" }; }
    else if (what === "roshan") st.hold = { color: [0.65, 0.2, 1], at: t, until: t + 3000, pulse: true, kind: "roshan" };
    else if (what === "night" || what === "day") st.day = what === "day";
    else if (what === "low") { if (game === "cs2") st.health = 0.15; else st.hp = 0.15; }
    else throw new Error("Try flash, bomb, kill, win, lose, roshan, night, day or low");
    return { ok: true };
  }

  /**
   * What to draw now, for the games that are on, on top of the show.
   * @param {object} cfg the games' settings (GAME_DEFAULTS' shape) @param {{safe?:boolean}} [o] safe: photosensitive-safe
   */
  function layers(cfg, { safe = false } = {}) {
    const t = now(), out = [];
    for (const game of ["cs2", "dota2"]) {
      const c = cfg[game], st = S[game]; if (!c || !c.enabled || !st.inGame) continue;
      const age = t - st.at; if (age > 35000) continue; // the game stopped posting (closed, or crashed): the show comes back
      const fade = age > 30000 ? 1 - (age - 30000) / 5000 : 1, I = clamp(Number(c.intensity ?? 0.8)) * fade, base = (c.mode === "takeover" ? 1 : 0.55) * I;
      if (st.testFlash && t - st.testFlash > 2500) { st.flashed = 0; st.testFlash = 0; }
      if (st.test && t - st.test > 8000 && t - st.at > 8000) { st.inGame = false; st.test = 0; continue; } // a "Try it" with no game running: back to the show
      // health: the zone's colour, and a heartbeat when it's low
      const hp = game === "cs2" ? st.health : st.hp, alive = game === "cs2" ? st.own || st.health > 0 : st.alive;
      if (c.healthTarget && c.healthTarget !== "off") {
        if (!alive || hp <= 0) out.push({ target: c.healthTarget, color: [0.18, 0, 0], mix: base });
        else { let k = 1; if (hp < 0.3) { const f = safe ? 0.5 : 1.2; k = 0.6 + 0.4 * (0.5 + 0.5 * Math.cos(2 * Math.PI * f * t / 1000)); }
          const col = healthColor(hp).map(v => v * k); if (game === "cs2" && st.burning && !safe) { const fl = 0.75 + 0.25 * Math.sin(t / 37) * Math.sin(t / 53); col[0] = Math.max(col[0], fl); col[1] *= 0.6; col[2] = 0; }
          out.push({ target: c.healthTarget, color: col, mix: base }); }
      }
      if (game === "dota2") {
        if (c.manaTarget && c.manaTarget !== "off") out.push({ target: c.manaTarget, color: [0.08 * st.mana, 0.3 * st.mana, 1 * Math.max(0.15, st.mana)], mix: base });
        if (c.daynight !== false && c.ambientTarget && c.ambientTarget !== "off") out.push({ target: c.ambientTarget, color: st.day ? [1, 0.78, 0.4] : [0.1, 0.14, 0.5], mix: base * 0.6 });
      }
      const fxT = c.effectsTarget || "all"; if (fxT === "off") continue;
      // the bomb: dark red, a pulse on every beep (safe mode: a slow, smooth pulse instead)
      if (game === "cs2" && st.bomb && c.bomb !== false) { const e = (t - st.bomb.at) / 1000;
        if (e < BOMB_SECONDS) { let lv;
          if (safe) lv = 0.35 + 0.35 * (0.5 + 0.5 * Math.cos(2 * Math.PI * 0.75 * e));
          else { let last = 0; for (const b of BEEPS) { if (b > e) break; last = b; } lv = 0.3 + 0.7 * Math.exp(-(e - last) / 0.09); }
          out.push({ target: fxT, color: RED.map(v => v * lv), mix: Math.max(base, 0.85 * I) }); } }
      // a result: the team's colour for a few seconds, fading out at the end
      if (st.hold && c[st.hold.kind || "rounds"] !== false) {
        if (t >= st.hold.until) st.hold = null;
        else { const left = (st.hold.until - t) / 1000, k = Math.min(1, left / 0.6), pulse = st.hold.pulse ? 0.65 + 0.35 * Math.cos(2 * Math.PI * (safe ? 0.5 : 1.5) * (t - st.hold.at) / 1000) : 1;
          out.push({ target: fxT, color: st.hold.color.map(v => v * pulse), mix: 0.9 * I * k }); } }
      // flashbang: white, as blinded as you are (safe mode: at most half, and it fades in rather than jumping)
      if (game === "cs2" && c.flashbang !== false) { const want = st.flashed * (safe ? 0.5 : 1);
        st.flashSmooth = safe ? st.flashSmooth + clamp(want - st.flashSmooth, -0.05, 0.03) : want;
        if (st.flashSmooth > 0.01) out.push({ target: fxT, color: WHITE, mix: clamp(st.flashSmooth) * I }); }
      // kills and other quick flashes (safe mode: gentler and slower to fade, so they don't strobe)
      { const tau = safe ? 0.45 : 0.14, amp = safe ? 0.35 : 1;
        st.flashes = st.flashes.filter(f => t - f.t < 1500);
        for (const f of st.flashes) { if (c[f.kind] === false) continue; const d = (t - f.t) / 1000; const a = f.amount * amp * I * Math.exp(-d / tau) * (safe ? Math.min(1, d / 0.15) : 1); if (a > 0.01) out.push({ target: fxT, color: f.color, add: a }); } }
    }
    return out;
  }

  /** A short summary for the settings page. */
  function status(game) {
    const st = S[game], t = now(); if (!st) return null;
    const live = st.inGame && st.at && t - st.at < 35000;
    if (game === "cs2") return { live, lastAt: st.at || null, map: st.map, phase: st.phase, health: live ? Math.round(st.health * 100) : null, team: st.team, bomb: !!st.bomb, own: st.own, events: st.lastEvents };
    return { live, lastAt: st.at || null, map: st.map, health: live ? Math.round(st.hp * 100) : null, mana: live ? Math.round(st.mana * 100) : null, alive: st.alive, day: st.day, team: st.team, events: st.lastEvents };
  }
  return { ingest, layers, status, test, state: S, reset(game) { if (game === "cs2") S.cs2 = freshCs(); else if (game === "dota2") S.dota2 = freshDota(); } };
}

/** The game's config file, which tells it where to post its state. url: Tempolight's address as the game's PC reaches it. */
export function gsiConfig(game, { url, token }) {
  const uri = `${String(url).replace(/\/+$/, "")}/api/gsi/${game}`;
  if (game === "cs2") return `"Tempolight"
{
  "uri"       "${uri}"
  "timeout"   "1.1"
  "buffer"    "0.0"
  "throttle"  "0.1"
  "heartbeat" "10.0"
  "auth"
  {
    "token" "${token}"
  }
  "data"
  {
    "provider"           "1"
    "map"                "1"
    "round"              "1"
    "player_id"          "1"
    "player_state"       "1"
    "player_match_stats" "1"
  }
}
`;
  if (game === "dota2") return `"Tempolight"
{
  "uri"       "${uri}"
  "timeout"   "5.0"
  "buffer"    "0.1"
  "throttle"  "0.1"
  "heartbeat" "30.0"
  "data"
  {
    "provider"  "1"
    "map"       "1"
    "player"    "1"
    "hero"      "1"
    "events"    "1"
    "abilities" "0"
    "items"     "0"
    "buildings" "0"
    "draft"     "0"
    "wearables" "0"
  }
  "auth"
  {
    "token" "${token}"
  }
}
`;
  throw new Error(`Unknown game "${game}"`);
}

export { hex as hexColor };
