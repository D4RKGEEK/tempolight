// Discord: posts "now playing" and "scene changed" to a channel through a webhook (Server Settings → Integrations →
// Webhooks → New Webhook → Copy Webhook URL). Outgoing only: no bot, no account. Posts are spaced out (at most one
// every 3 seconds, a short queue, Discord's own rate limit respected) so a busy evening can't get the webhook blocked.

const WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/api\/(?:v\d+\/)?webhooks\/\d{5,30}\/[\w-]{20,200}$/;
export const isWebhook = u => WEBHOOK.test(String(u || "").trim());
/** For the settings page: the address without most of its secret part. */
export const maskWebhook = u => { const m = /^(https:\/\/[^/]+\/api\/(?:v\d+\/)?webhooks\/\d+\/)(.*)$/.exec(String(u || "")); return m ? m[1] + "…" + m[2].slice(-4) : ""; };
export const DISCORD_DEFAULTS = () => ({ webhook: "", nowPlaying: true, scenes: true, games: false, twitch: false, username: "Tempolight" });

/**
 * @param {{webhook:()=>string, username?:()=>string, fetch?:Function, gapMs?:number, onChange?:Function}} o
 */
export function createDiscord({ webhook, username = () => "Tempolight", fetch = globalThis.fetch, gapMs = 3000, onChange = () => {} }) {
  const st = { sent: 0, error: null, lastAt: null, last: null };
  const q = []; let busy = false, nextAt = 0, timer = null, closed = false;
  const tell = () => { try { onChange({ ...st }); } catch {} };
  function post(content) {
    if (!isWebhook(webhook()) || closed) return false;
    const text = String(content).slice(0, 1900); if (q.includes(text) || st.last === text && Date.now() - (st.lastAt || 0) < 10000) return true; // the same twice: once
    q.push(text); while (q.length > 8) q.shift(); pump(); return true;
  }
  async function pump() {
    if (busy || !q.length || closed) return; const wait = nextAt - Date.now();
    if (wait > 0) { clearTimeout(timer); timer = setTimeout(pump, wait); timer.unref?.(); return; }
    busy = true; const text = q.shift();
    try {
      const r = await fetch(webhook(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text, username: username() || "Tempolight", allowed_mentions: { parse: [] } }) });
      if (r.status === 429) { let j = {}; try { j = await r.json(); } catch {} q.unshift(text); nextAt = Date.now() + Math.min(60000, (Number(j.retry_after) || 2) * 1000); st.error = "Discord asked to slow down"; }
      else if (!r.ok) { st.error = r.status === 404 || r.status === 401 ? "Discord doesn't know this webhook (deleted?): paste a new one" : `Discord answered ${r.status}`; nextAt = Date.now() + gapMs; }
      else { st.sent++; st.error = null; st.lastAt = Date.now(); st.last = text; nextAt = Date.now() + gapMs; }
    } catch (e) { st.error = `Couldn't reach Discord (${e.message})`; nextAt = Date.now() + gapMs; }
    busy = false; tell(); if (q.length) pump();
  }
  /** Sends one message now and says how it went (the Test button). */
  async function test(text) {
    if (!isWebhook(webhook())) throw Object.assign(new Error("Paste a Discord webhook address first"), { code: 400 });
    const r = await fetch(webhook(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text, username: username() || "Tempolight", allowed_mentions: { parse: [] } }) });
    if (!r.ok) throw Object.assign(new Error(r.status === 404 || r.status === 401 ? "Discord doesn't know this webhook" : `Discord answered ${r.status}`), { code: 502 });
    st.sent++; st.error = null; st.lastAt = Date.now(); st.last = text; tell(); return { ok: true };
  }
  return { post, test, status: () => ({ ...st, queued: q.length }), close() { closed = true; clearTimeout(timer); q.length = 0; } };
}
