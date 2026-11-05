// The Music page's sync meter ("how locked am I") and song map: the playing song's loudness as a strip with its
// sections (A, B, A, C... coloured by part), its drops, a moving playhead and the next drop. The map comes from
// GET /api/song/map (known ahead for songs played here, remembered or recognised; made as it is heard live); the meter
// from /api/status `sync`. Drawn on a canvas at most 10 times a second. The plain functions at the top are tested in
// Node (songmap.test.js).

export const SYNC_LABEL = { locked: "Locked", finding: "Finding the beat", none: "Not hearing" };
export const PART_NAME = { calm: "calm", build: "build-up", drop: "drop", silent: "quiet" };
const PART_COLOR = { calm: "#4a6fa5", build: "#c58a1d", drop: "#c8366e" }; // (as the show timeline's blocks)

/** The meter's text for a status message: {state, label, score, hint, title}. */
export function syncView(m) {
  const s = m && m.sync ? m.sync : { score: 0, state: "none", hint: null, source: null };
  const state = SYNC_LABEL[s.state] ? s.state : "none", label = SYNC_LABEL[state];
  return { state, label, score: Math.max(0, Math.min(100, Math.round(s.score || 0))), hint: s.hint || null,
    title: `${label}${state === "none" ? "" : ` (${Math.round(s.score || 0)} of 100)`}${s.hint ? `: ${s.hint}` : ""}` };
}
/** Seconds to the next drop: the status's prediction when there is one (m.drop.next), else the map's next drop. */
export function nextDrop(map, pos, m) {
  const d = m && m.drop;
  if (d && Number.isFinite(d.next) && d.next >= 0) return { in: d.next, at: pos != null ? pos + d.next : null, predicted: d.source === "predicted", building: !!d.building };
  if (!map || pos == null) return null;
  const t = (map.drops || []).find(x => x > pos + 0.05); return t == null ? null : { in: t - pos, at: t, predicted: false, building: false };
}
/** The section playing at pos, or null. */
export const sectionAt = (map, pos) => { if (!map || pos == null) return null; const l = map.sections || [], last = l[l.length - 1];
  return l.find(s => pos >= s.t0 && pos < s.t1) || (last && pos >= last.t1 && pos - last.t1 < 1 ? last : null); }; // (a live map's newest part ends where it is now)
/** The time the strip's width stands for: the song, or (a map made as it is heard) a bit more than heard so far. */
export const spanOf = map => !map ? 60 : map.growing ? Math.max(60, map.dur * 1.12) : Math.max(1, map.dur);
/** Which map the status says to show: a key that changes when the song does (null: nothing playing). */
export function mapKey(m) {
  if (!m) return null;
  if (m.source === "song" && m.song) return "song:" + (m.song.memId || m.song.name);
  if (m.recognised) return "mem:" + m.recognised.id;
  if (m.source === "nowplaying") return "np:" + (m.sourceLabel || "");
  if (m.hearing?.via || m.source === "browser" || m.source === "capture") return "live"; // (made as it is heard)
  return null;
}
const fmt = s => { s = Math.max(0, s || 0); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
export const dropText = d => !d ? "" : d.in < 0.5 ? "Drop now" : `${d.predicted ? "Drop in about" : d.building ? "Drop in" : "Next drop in"} ${Math.ceil(d.in)} s`;

/** The panel's body (the page puts it in a panel and adds the look row). */
export const syncHtml = () => `<div class="sm-meter" id="sm-meter" data-state="none">
    <div class="sm-state"><i class="sm-dot" aria-hidden="true"></i><b id="sm-label">Not hearing</b></div>
    <div class="sm-score" role="meter" aria-label="How locked on the beat" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="sm-score"><i id="sm-fill"></i></div>
    <span class="sm-num" id="sm-num">0</span>
    <span class="sm-bpm"><b id="sm-bpm">–</b> BPM</span>
    <div class="sm-beat" id="sm-beat" aria-hidden="true"><i>1</i><i></i><i></i><i></i></div>
  </div>
  <p class="sm-hint" id="sm-hint" aria-live="polite"></p>
  <div class="sm-map" id="sm-map"><canvas id="sm-cv" aria-label="The song's map: its parts, drops and where it is now" role="img"></canvas><p class="sm-empty" id="sm-empty">Play a song or listen live, and its map appears here.</p></div>
  <div class="sm-foot"><span id="sm-pos"></span><span id="sm-next"></span><span id="sm-part"></span></div>`;

/**
 * Wires the meter and the map in `root` (filled with syncHtml()). api: the page's api(). Returns {status(m), destroy()}.
 */
export function mountSongMap(root, { api }) {
  const q = s => root.querySelector(s), cv = q("#sm-cv"), box = q("#sm-map"), ctx = cv.getContext("2d");
  let m = null, map = null, key = null, fetchedAt = 0, base = null, lastBeat = null, alive = true, inflight = false, colors = null, colorsAt = 0, drawn = "";
  // where the song is: {pos, at (performance.now()), playing}, from the status (4 a second) or the map
  const posNow = () => !base ? null : Math.min(map ? map.dur : Infinity, base.pos + (base.playing ? (performance.now() - base.at) / 1000 : 0));
  async function load() {
    if (inflight) return; inflight = true; const k = key;
    try { const r = await api("GET", "/api/song/map"); if (!alive || k !== key) return; map = r && r.source ? r : null; fetchedAt = performance.now();
      if (map && map.pos != null && !(m && (m.source === "song" || m.recognised))) base = { pos: map.pos, at: fetchedAt, playing: map.playing }; }
    catch { map = null; } finally { inflight = false; }
  }
  function themeColors() {
    const now = performance.now(); if (colors && now - colorsAt < 1000) return colors; colorsAt = now;
    const cs = getComputedStyle(root), v = n => cs.getPropertyValue(n).trim();
    return colors = { bg: v("--panel-2"), line: v("--line"), text: v("--text"), faint: v("--faint"), accent: v("--accent"), panel: v("--panel") };
  }
  function draw() {
    if (!alive || document.hidden) return;
    const r = box.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1), W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; drawn = ""; }
    const pos = posNow(), d = nextDrop(map, pos, m), C = themeColors();
    const sig = `${W}x${H}|${map ? map.dur + ":" + map.sections.length + ":" + fetchedAt : "-"}|${pos == null ? "-" : pos.toFixed(2)}|${d ? d.at?.toFixed(1) : "-"}|${C.bg}`;
    if (sig === drawn) return; drawn = sig;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    q("#sm-empty").hidden = !!(map && map.dur > 0);
    if (!map || !(map.dur > 0)) { if (m && mapKey(m) === "live") q("#sm-empty").textContent = "Listening… the map grows as the song plays."; else q("#sm-empty").textContent = "Play a song or listen live, and its map appears here."; return; }
    const span = spanOf(map), X = t => t / span * W, top = 16, bot = H - 6, ph = pos == null ? -1 : X(pos);
    // the parts: a tint behind, a solid band along the bottom, the label at the top left
    ctx.font = "600 10.5px system-ui, sans-serif"; ctx.textBaseline = "top";
    for (const s of map.sections) { const x0 = X(s.t0), x1 = X(s.t1), col = PART_COLOR[s.state] || C.faint;
      ctx.globalAlpha = 0.13; ctx.fillStyle = col; ctx.fillRect(x0, top, x1 - x0, bot - top);
      ctx.globalAlpha = 1; ctx.fillRect(x0, bot, x1 - x0, 4);
      if (x1 - x0 > 16) { ctx.fillStyle = col; ctx.fillText(s.label, x0 + 4, 2); }
      ctx.fillStyle = C.panel; ctx.fillRect(Math.round(x0), top, 1, H - top); }
    // the loudness: one bar per value, in its part's colour; what is still to come paler
    const env = map.env, st = map.envStep, bw = Math.max(1, X(st) - (X(st) > 3 ? 1 : 0));
    let si = 0;
    for (let i = 0; i < env.length; i++) { const t = i * st, x = X(t); if (t >= map.dur) break;
      while (si < map.sections.length - 1 && t >= map.sections[si].t1) si++;
      const sec = map.sections[si], h = Math.max(1, env[i] * (bot - top - 3));
      ctx.fillStyle = sec && t >= sec.t0 ? PART_COLOR[sec.state] || C.faint : C.faint; ctx.globalAlpha = ph >= 0 && x > ph ? 0.42 : 0.95;
      ctx.fillRect(x, bot - 1 - h, bw, h); }
    ctx.globalAlpha = 1;
    // drops: a small mark at the top
    ctx.fillStyle = PART_COLOR.drop;
    for (const t of map.drops) { const x = X(t); ctx.beginPath(); ctx.moveTo(x - 4, top - 1); ctx.lineTo(x + 4, top - 1); ctx.lineTo(x, top + 5); ctx.closePath(); ctx.fill(); }
    // the next drop: a dashed line with how long until it
    if (d && d.at != null && d.at <= span) { const x = X(d.at); ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, top); ctx.lineTo(x + 0.5, bot); ctx.stroke(); ctx.setLineDash([]); }
    // the playhead
    if (ph >= 0) { ctx.fillStyle = C.text; ctx.fillRect(Math.round(ph) - 1, top - 2, 2, bot - top + 6); ctx.beginPath(); ctx.arc(Math.round(ph), top - 2, 3.5, 0, Math.PI * 2); ctx.fill(); }
  }
  function foot() {
    const pos = posNow(), d = nextDrop(map, pos, m), s = sectionAt(map, pos);
    q("#sm-pos").textContent = map && map.dur > 0 && pos != null ? (map.growing ? `${fmt(pos)} heard` : `${fmt(pos)} / ${fmt(map.dur)}`) : "";
    const nx = q("#sm-next"); nx.textContent = dropText(d); nx.classList.toggle("soon", !!d && d.in < 10);
    q("#sm-part").textContent = s ? `Part ${s.label} · ${PART_NAME[s.state] || s.state}` : "";
  }
  const timer = setInterval(() => { draw(); foot(); }, 100); // 10 times a second at most (and only when something moved)
  return {
    status(msg) {
      m = msg; const v = syncView(msg), meter = q("#sm-meter");
      meter.dataset.state = v.state; meter.title = v.title; q("#sm-label").textContent = v.label;
      q("#sm-fill").style.width = v.score + "%"; q("#sm-score").setAttribute("aria-valuenow", String(v.score)); q("#sm-num").textContent = v.state === "none" ? "–" : String(v.score);
      q("#sm-hint").textContent = v.hint || (v.state === "locked" ? "On the beat" : v.state === "none" ? "Nothing to follow yet" : "");
      q("#sm-bpm").textContent = msg.bpm && v.state !== "none" ? Math.round(msg.bpm) : "–";
      const dots = root.querySelectorAll("#sm-beat i"), b = v.state === "none" ? null : msg.beat;
      dots.forEach((x, i) => x.classList.toggle("on", b === i));
      if (b === 0 && lastBeat !== 0) { const one = dots[0]; one.classList.remove("pulse"); void one.offsetWidth; one.classList.add("pulse"); } // beat 1
      lastBeat = b;
      // the position: from the status for a song played here or recognised (4 a second), else from the map
      const now = performance.now();
      if (msg.source === "song" && msg.song) base = { pos: msg.song.pos, at: now, playing: !!msg.song.playing };
      else if (msg.recognised) base = { pos: msg.recognised.pos, at: now, playing: true };
      const k = mapKey(msg);
      if (k !== key) { key = k; map = null; base = null; drawn = ""; if (k) load(); }
      else if (k && now - fetchedAt > (map && map.growing || k === "live" ? 2000 : 8000)) load(); // a live map grows; a known one only keeps its clock
    },
    destroy() { alive = false; clearInterval(timer); },
  };
}
