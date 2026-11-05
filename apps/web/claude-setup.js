// "Set up with Claude": a dialog with a ready-made prompt that lets Claude (Claude Code, or the Claude app with access
// to this computer) install and set up Tempolight step by step. Opened from the setup wizard's first step and, later,
// from Settings → About:  import("/claude-setup.js").then(m => m.openClaudeSetup())
// The canonical prompt lives in docs/setup-with-claude.md under "The prompt"; the docs site isn't part of the app, so
// an exact copy is kept here: change both together.

export const CLAUDE_SETUP_PROMPT = `Set up Tempolight on this computer for me. Tempolight is open-source, music-reactive lighting for WLED and other lights: https://github.com/D4RKGEEK/tempolight. Its HTTP API (docs/api.md there) runs at http://localhost:8080/api.

Work one step at a time and tell me what you do in plain words. Ask me before you install anything system-wide (Node.js, BlackHole, ffmpeg, a service), change my sound settings or open the firewall.

1. Check for Node.js 20 or newer. If it is there, run "npx tempolight --open" and keep it running. If not, ask me whether to install Node.js or to download the one-file app for this computer from the latest GitHub release.
2. Wait until GET /api/health answers.
3. Find my lights with POST /api/discover {"scan": true} and add each one with POST /api/devices. Ask me about lights it missed, such as Philips Hue, Nanoleaf or an IP address.
4. Set how Tempolight hears music. Read GET /api/hearing and explain the choices: this computer's sound (BlackHole on a Mac, the output monitor on Linux, Stereo Mix on Windows) or the microphone. Follow its checklist, then POST /api/hearing/use.
5. Ask me how my lights are placed in the room, then pick the closest layout from "presets" in GET /api/state with POST /api/room/preset.
6. Ask me to open Music and press "Play the demo track".
7. Explain the "In sync" meter on the Music page: Locked, Finding the beat, Not hearing, and the hint under it.

End with a short summary of what is set up and what I can try next.`;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = d => `<svg class="cs-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const COPY = "M9 9h11v11H9zM5 15H4V4h11v1", DONE = "M5 12.5l4.5 4.5L19 7", X = "M6 6l12 12M18 6L6 18";

function css() {
  if (typeof document === "undefined" || document.querySelector('link[href="/setup.css"]')) return;
  const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/setup.css"; document.head.appendChild(l);
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  try { const a = document.createElement("textarea"); a.value = t; a.setAttribute("readonly", ""); a.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(a); a.select(); const ok = document.execCommand("copy"); a.remove(); return ok; } catch { return false; }
}

let open = null;
/** Opens the "Set up with Claude" dialog. Returns the <dialog>; resolves nothing, closes itself on Escape or Close. */
export function openClaudeSetup() {
  css(); if (open) { open.querySelector("#cs-copy")?.focus(); return open; }
  const d = document.createElement("dialog"); d.className = "cs"; d.id = "claude-setup"; d.setAttribute("aria-labelledby", "cs-title");
  d.innerHTML = `<div class="cs-card">
      <header class="cs-head"><h2 id="cs-title">Set up with Claude</h2>
        <button class="cs-x" type="button" id="cs-close" aria-label="Close">${ic(X)}</button></header>
      <p class="cs-lede">Paste this prompt into Claude Code, or the Claude app with access to this computer. Claude installs Tempolight, finds your lights and checks the sync with you, asking before it installs anything.</p>
      <pre class="cs-prompt" id="cs-prompt" tabindex="0" aria-label="The setup prompt">${esc(CLAUDE_SETUP_PROMPT)}</pre>
      <div class="cs-foot"><span class="cs-meta" id="cs-msg" role="status"></span>
        <button class="cs-btn" type="button" id="cs-done">Close</button>
        <button class="cs-btn primary" type="button" id="cs-copy">${ic(COPY)}<span>Copy the prompt</span></button></div>
    </div>`;
  document.body.appendChild(d); open = d;
  const close = () => { if (d.open) d.close(); };
  d.addEventListener("close", () => { d.remove(); if (open === d) open = null; });
  d.addEventListener("click", e => { if (e.target === d) close(); }); // a click on the dimmed backdrop
  d.querySelector("#cs-close").onclick = close; d.querySelector("#cs-done").onclick = close;
  d.querySelector("#cs-copy").onclick = async () => {
    const b = d.querySelector("#cs-copy"), ok = await copyText(CLAUDE_SETUP_PROMPT), msg = d.querySelector("#cs-msg");
    if (ok) { b.innerHTML = `${ic(DONE)}<span>Copied</span>`; msg.textContent = "Now paste it into Claude"; setTimeout(() => { if (b.isConnected) b.innerHTML = `${ic(COPY)}<span>Copy the prompt</span>`; }, 2400); }
    else { msg.textContent = "Couldn't copy: select the text and copy it yourself"; const r = document.createRange(); r.selectNodeContents(d.querySelector("#cs-prompt")); getSelection().removeAllRanges(); getSelection().addRange(r); }
  };
  if (d.showModal) d.showModal(); else d.setAttribute("open", "");
  d.querySelector("#cs-copy").focus();
  return d;
}
