// Screen sync: share a screen or a window (a film, a game, a music video) and the room takes its colours.
// The browser shrinks the picture to 48 pixels wide and sends it 20 times a second; the Screen Sync effect maps it over the room.
export function createScreenShare({ ws, onChange }) {
  const S = { active: false, label: "", error: null };
  let stream = null, video = null, timer = null, rgb = null;
  const canvas = document.createElement("canvas"), g = canvas.getContext("2d", { willReadFrequently: true });
  const emit = () => onChange && onChange(S);
  async function start() {
    S.error = null;
    if (!navigator.mediaDevices?.getDisplayMedia) { S.error = window.isSecureContext === false ? "Screen sharing needs a secure page: open Tempolight as http://localhost on this computer (or over https)." : "This browser can't share its screen. Use Chrome, Edge or Firefox on a computer."; emit(); return false; }
    if (S.active) return true;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 20 }, audio: false }); }
    catch (e) { S.error = e.name === "NotAllowedError" ? "Screen sharing was cancelled." : `Couldn't share the screen: ${e.message}`; emit(); return false; }
    const track = stream.getVideoTracks()[0]; S.label = track.label || "Shared screen";
    video = document.createElement("video"); video.muted = true; video.playsInline = true; video.srcObject = stream; await video.play().catch(() => {});
    track.addEventListener("ended", () => stop()); // "Stop sharing" in the browser's own bar
    timer = setInterval(tick, 50); S.active = true; emit(); return true;
  }
  function tick() {
    if (!video || video.readyState < 2 || !ws.open) return;
    if (ws.sock?.bufferedAmount > 32768) return; // the connection is slow: drop this picture rather than queue them up (the lights would lag behind)
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9, w = 48, h = Math.max(4, Math.min(48, Math.round(w * vh / vw)));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; rgb = new Uint8Array(w * h * 3); }
    g.imageSmoothingQuality = "high"; g.drawImage(video, 0, 0, w, h); // "high" averages a big picture down instead of picking single pixels (less flicker)
    const d = g.getImageData(0, 0, w, h).data;
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
    let bin = ""; for (let i = 0; i < rgb.length; i += 4096) bin += String.fromCharCode.apply(null, rgb.subarray(i, i + 4096));
    ws.send({ type: "screen", w, h, px: btoa(bin), label: S.label });
  }
  /** Stop sharing. `why`: a message to show (for example when the server refused the pictures). */
  function stop(why) {
    const was = S.active; clearInterval(timer); timer = null; if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; video = null; S.active = false;
    if (why) S.error = why; if (was) ws.send({ type: "screen", end: true }); // so the room lets go straight away
    if (was || why) emit();
  }
  return { state: S, start, stop };
}
