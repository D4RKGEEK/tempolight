// The Claude show designer (optional, off by default): with the user's own Anthropic API key, a remembered song that
// plays and has no design yet gets one request to Claude (engine/src/designer.js builds it: the song's title and
// artist, a compact summary of its analysis, the effects and palettes; never audio). The answer is validated strictly
// and kept with the song (entry.design); any error or a timeout (10 s) leaves the song on its automatic look, quietly.
// A song is asked about once (entry.designAsked): never again unless the user asks ("Redesign with Claude"). A daily
// cap (30 requests by default) and the token estimate keep the cost visible.
//
// The key: settings.designer.apiKey, stored like the MQTT password (in the settings file), never sent back by the API
// (/api/state shows hasKey), left out of backups, never logged. Requests go to api.anthropic.com only (the address is
// not a setting; tests pass their own).
//
// Applying a design: runtime.js asks rt.designFor(entry) each frame; it answers the compiled design (show blocks,
// colour blocks, cues and brightness keys, the energy arc) that the director plays instead of the automatic look, or
// null (designer off, no design, an older design version, a show edited by hand, the timeline editor previewing).
//
// Node and the browser demo alike would work, but app.js starts it on the server only (a key in a browser tab is a key
// anyone with that tab has).
import { HttpError } from "./core.js";
import { memoryAnalysis, songSummary, effectCatalog, paletteCatalog, designRequest, parseDesign, compileDesign, designSections, DESIGN_VERSION } from "../../engine/src/index.js";

export const DESIGNER_DEFAULTS = { enabled: false, apiKey: "", model: "claude-sonnet-5-5", dailyCap: 30 };
/** Models offered in Settings (any other id can be typed), with list prices in USD per million tokens (input, output). */
export const DESIGNER_MODELS = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", price: [2, 10] },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", price: [0.1, 0.5] },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", price: [4, 20] },
];
const API = "https://api.anthropic.com", VERSION = "2023-06-01";
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{2,63}$/;
// the effort setting exists on the 5.x models (and Opus 4.6+); older ids are sent without it
const effortFor = m => /-(5|5-\d|4-[6-9])$/.test(m) || /^claude-(fable|mythos)/.test(m) ? "low" : null;
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

/**
 * @param {{core:object, store:object, runtime:object, fetch?:typeof fetch, baseUrl?:string, timeoutMs?:number, tick?:number, now?:()=>number}} o
 */
export function startDesigner({ core, store, runtime, fetch = globalThis.fetch, baseUrl = API, timeoutMs = 10000, tick: tickMs = 1000, now = Date.now }) {
  const rt = runtime.rt, data = () => store.data;
  const fxNow = () => runtime.effects; // (the effects are made again when you add your own)
  const set = () => { const s = data().settings; if (!s.designer || typeof s.designer !== "object") s.designer = { ...DESIGNER_DEFAULTS }; const d = s.designer;
    for (const [k, v] of Object.entries(DESIGNER_DEFAULTS)) if (d[k] === undefined) d[k] = v; return d; };
  const st = { busy: new Set(), last: null, error: null }; // last: {song, at, ok, ms, error?}
  const hide = s => { const k = set().apiKey; let m = String(s || ""); if (k && k.length > 8) m = m.split(k).join("[key]"); return m.replace(/sk-ant-[\w-]+/g, "[key]").slice(0, 200); };
  const usage = () => { const d = set(); if (!d.usage || d.usage.day !== day(now())) d.usage = { day: day(now()), n: 0, input: 0, output: 0 }; return d.usage; };
  const ready = () => { const d = set(); return !!(d.enabled && d.apiKey); };
  const note = (m, lvl) => runtime.note(`Claude show designer: ${m}`, lvl);
  const err = (code, msg) => new HttpError(code, msg);

  /** What is known about a song besides its analysis: the music app's title, artist and album when it plays this one. */
  function metaFor(e) {
    const sp = rt.spotify?.info?.(), tr = sp && sp.map && sp.map.id === e.id ? sp.track : null; if (tr) return { title: tr.title, artist: tr.artist, album: tr.album };
    const np = rt.nowPlaying?.info?.(); if (np && np.remembered?.id === e.id) return { title: np.title, artist: np.artist, album: np.album };
    const m = /^(.+?)\s+[–—-]\s+(.+)$/.exec(e.name || ""); return m ? { artist: m[1], title: m[2] } : { title: e.name };
  }
  /** The request for a song, and what it is made from. */
  function requestFor(e) {
    const pre = memoryAnalysis(e), summary = songSummary(pre, metaFor(e)); if (!summary) return null;
    const effects = effectCatalog(fxNow().list, data().settings.effectPrefs || {}), palettes = paletteCatalog(fxNow().palettes), model = set().model;
    return { pre, summary, effects, palettes, ...designRequest({ summary, effects, palettes, model, effort: effortFor(model) }) };
  }
  function cost(est, model = set().model) { const m = DESIGNER_MODELS.find(x => x.id === model); return m ? Math.round((est.input * m.price[0] + est.output * m.price[1]) / 1e6 * 10000) / 10000 : null; }

  async function call(body) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(baseUrl + "/v1/messages", { method: "POST", signal: ac.signal, headers: { "content-type": "application/json", "x-api-key": set().apiKey, "anthropic-version": VERSION }, body: JSON.stringify(body) });
      const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
      if (!r.ok) throw Object.assign(new Error(r.status === 401 ? "the API key was turned down" : r.status === 429 ? "Anthropic asked to slow down (rate limit or credit)" : `Anthropic said ${r.status}${j?.error?.message ? `: ${hide(j.error.message)}` : ""}`), { status: r.status });
      if (!j) throw new Error("the answer wasn't JSON");
      return j;
    } catch (e) { if (e.name === "AbortError") throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`); throw new Error(hide(e.message)); }
    finally { clearTimeout(timer); }
  }

  /** Ask Claude for a song's design (once; again only when the user asks: force). Resolves to the design or null. */
  async function ask(e, { force = false } = {}) {
    if (!ready() || !e || st.busy.has(e.id)) return null;
    if (!force && (e.design || e.designAsked)) return null;
    const u = usage(); if (u.n >= Math.max(0, Number(set().dailyCap) || 0)) { st.error = `daily limit of ${set().dailyCap} reached`; if (force) throw err(429, `The daily limit of ${set().dailyCap} designs is reached. Raise it in Settings → Claude, or try tomorrow.`); return null; }
    const req = requestFor(e); if (!req) return null;
    st.busy.add(e.id); u.n++; e.designAsked = now(); runtime.saveSong(e); store.save(); // (counted before it goes: a failure counts too)
    const t0 = now();
    try {
      const ans = await call(req.body), d = parseDesign(ans, { summary: req.summary, effects: req.effects.rows.map(r => r[0]), palettes: Object.keys(req.palettes) });
      const used = { input: ans.usage?.input_tokens ?? req.estimate.input, output: ans.usage?.output_tokens ?? req.estimate.output };
      u.input += used.input; u.output += used.output;
      e.design = { v: DESIGN_VERSION, at: now(), model: set().model, ...d, usage: used };
      runtime.saveSong(e); store.save(); st.error = null; st.last = { song: e.id, at: now(), ok: true, ms: now() - t0 };
      note(`designed “${e.name}”: ${d.why}`); core.broadcast({ type: "changed", what: "songs" });
      return e.design;
    } catch (x) {
      st.error = hide(x.message); st.last = { song: e.id, at: now(), ok: false, ms: now() - t0, error: st.error };
      note(`couldn't design “${e.name}” (${st.error}); it keeps its automatic look`, "warn"); store.save();
      if (force) throw err(502, `Claude couldn't design this song: ${st.error}. It keeps its automatic look.`);
      return null;
    } finally { st.busy.delete(e.id); }
  }

  // the song playing now: a design if it has none and was never asked about
  function tick() { if (!ready()) return; const e = runtime.playingEntry?.(); if (e && !e.design && !e.designAsked && !st.busy.has(e.id)) ask(e).catch(() => {}); }
  const timer = tickMs > 0 ? setInterval(tick, tickMs) : null; timer?.unref?.();

  // ---------------------------------------------------------------- applying a design (runtime.js asks every frame)
  const compiled = new WeakMap(); // design -> {key, out}
  const playable = d => !!d && d.v === DESIGN_VERSION;
  rt.designFor = (e, pe) => {
    if (!e || !playable(e.design) || !set().enabled || data().settings.shows === false || e.showEdited || (pe && pe.until)) return null; // (pe.until: the timeline editor's preview)
    const s = data().settings, safe = !!(s.safe || rt.night), c = compiled.get(e.design), key = `${safe}`;
    if (c && c.key === key) return c.out;
    const out = compileDesign(e.design, memoryAnalysis(e), { safe, effects: new Set(fxNow().list.map(f => f.id)) }); compiled.set(e.design, { key, out }); return out;
  };
  rt.designStatus = e => {
    if (!set().enabled && !(e && e.design)) return null;
    return { enabled: !!set().enabled, song: e ? e.id : null, busy: !!(e && st.busy.has(e.id)), has: !!(e && e.design), active: !!(e && rt.designFor(e)),
      why: e && e.design ? e.design.why : null, model: e && e.design ? e.design.model : null, error: st.error };
  };

  // ---------------------------------------------------------------- API
  const sample = () => { const e = runtime.playingEntry?.() || data().songs.at(-1); const r = e ? requestFor(e) : null; return r ? { song: e.name, ...r.estimate } : { song: null, input: 4200, output: 520 }; };
  function view() {
    const d = set(), u = usage(), est = sample();
    return { enabled: !!d.enabled, hasKey: !!d.apiKey, model: d.model, dailyCap: d.dailyCap, models: DESIGNER_MODELS.map(({ id, name, price }) => ({ id, name, price })),
      today: { requests: u.n, input: u.input, output: u.output, left: Math.max(0, d.dailyCap - u.n) }, estimate: { ...est, usd: cost(est) }, busy: st.busy.size > 0, last: st.last, error: st.error };
  }
  core.route("GET", "/api/designer", "admin", () => view());
  core.route("PATCH", "/api/designer", "admin", ctx => {
    const b = ctx.body || {}, d = set();
    if (b.enabled !== undefined) d.enabled = !!b.enabled;
    if (b.apiKey !== undefined && b.apiKey !== "") { const k = String(b.apiKey).trim(); if (!/^[\x21-\x7e]{20,300}$/.test(k)) throw err(400, "That doesn't look like an Anthropic API key (it starts with sk-ant-)"); d.apiKey = k; }
    if (b.clearKey) d.apiKey = "";
    if (b.model !== undefined) { const m = String(b.model).trim(); if (!MODEL_RE.test(m)) throw err(400, "A model id looks like claude-sonnet-5-5"); d.model = m; }
    if (b.dailyCap !== undefined) { const n = Math.round(Number(b.dailyCap)); if (!(n >= 0 && n <= 500)) throw err(400, "The daily limit is 0 to 500 requests"); d.dailyCap = n; }
    if (b.enabled !== undefined) note(d.enabled ? "on" : "off");
    store.save(); core.broadcast({ type: "changed", what: "settings" }); return view();
  });
  // a tiny request, to check the key and the model (it doesn't count against the daily limit)
  core.route("POST", "/api/designer/test", "admin", async () => {
    if (!set().apiKey) throw err(400, "Paste your Anthropic API key first");
    const m = set().model, t0 = now();
    try { const j = await call({ model: m, max_tokens: 16, messages: [{ role: "user", content: "Reply with OK." }] }); return { ok: true, model: j.model || m, ms: now() - t0 }; }
    catch (x) { return { ok: false, model: m, error: hide(x.message) }; }
  });
  const songOf = id => { const e = runtime.songById(id); if (!e) throw err(404, "That song isn't remembered"); return e; };
  const designView = e => { const d = e.design, r = requestFor(e);
    return { id: e.id, name: e.name, enabled: !!set().enabled, asked: e.designAsked || null, busy: st.busy.has(e.id), active: !!rt.designFor(e),
      design: d ? { why: d.why, model: d.model, at: d.at, v: d.v, main: d.main, drop: d.drop, usage: d.usage || null, sections: designSections(d), moments: d.moments || [] } : null,
      estimate: r ? { ...r.estimate, usd: cost(r.estimate) } : null }; };
  core.route("GET", "/api/songs/:id/design", null, (ctx, p) => designView(songOf(p.id)));
  // "Redesign with Claude": a new request now, whatever happened before (it counts against the daily limit)
  core.route("POST", "/api/songs/:id/design", "admin", async (ctx, p) => {
    const e = songOf(p.id); if (!set().enabled) throw err(400, "Turn on the Claude show designer in Settings first"); if (!set().apiKey) throw err(400, "Add your Anthropic API key in Settings → Claude first");
    if (st.busy.has(e.id)) throw err(409, "Claude is designing this song already");
    await ask(e, { force: true }); return designView(e);
  });
  // "Use the automatic look": the design goes, and the song isn't asked about again by itself
  core.route("DELETE", "/api/songs/:id/design", "admin", (ctx, p) => { const e = songOf(p.id); delete e.design; e.designAsked ||= now(); runtime.saveSong(e); store.save(); core.broadcast({ type: "changed", what: "songs" }); return designView(e); });

  return { ask, tick, view, requestFor, state: st, close() { if (timer) clearInterval(timer); delete rt.designFor; delete rt.designStatus; } };
}
