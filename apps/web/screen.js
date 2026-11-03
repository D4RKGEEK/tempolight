// Screen sync: share a screen or a window (a film, a game, a music video) and the room takes its colours.
// The browser shrinks the picture to a few hundred pixels and sends it 20 times a second; the Screen Sync effect maps it over the room.
export function createScreenShare({ ws, onChange }) {
  const S = { active: false, label: "", error: null };
  let stream = null, video = null, timer = null;
  const canvas = document.createElement("canvas"), g = canvas.getContext("2d", { willReadFrequently: true });
  const emit = () => onChange && onChange(S);
  async function start() {
    S.error = null;
    if (!navigator.mediaDevices?.getDisplayMedia) { S.error = "This browser can't share its screen. Use Chrome, Edge or Firefox on a computer."; emit(); return false; }
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 20 }, audio: false }); }
    catch (e) { S.error = e.name === "NotAllowedError" ? "Screen sharing was cancelled." : `Couldn't share the screen: ${e.message}`; emit(); return false; }
    const track = stream.getVideoTracks()[0]; S.label = track.label || "Shared screen";
    video = document.createElement("video"); video.muted = true; video.playsInline = true; video.srcObject = stream; await video.play().catch(() => {});
    track.addEventListener("ended", stop);
    timer = setInterval(tick, 50); S.active = true; emit(); return true;
  }
  function tick() {
    if (!video || video.readyState < 2 || !ws.open) return;
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9, w = 48, h = Math.max(4, Math.min(48, Math.round(w * vh / vw)));
    canvas.width = w; canvas.height = h; g.drawImage(video, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data; let bin = "";
    for (let i = 0; i < d.length; i += 4) bin += String.fromCharCode(d[i], d[i + 1], d[i + 2]);
    ws.send({ type: "screen", w, h, px: btoa(bin), label: S.label });
  }
  function stop() { clearInterval(timer); timer = null; if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; video = null; S.active = false; emit(); }
  return { state: S, start, stop };
}
