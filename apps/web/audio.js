// Browser audio for Tempolight: play songs (analysed ahead of time so lights can anticipate drops), or listen to
// this computer's sound or a microphone. Samples go to the server over the WebSocket; the server does the lighting.

export function createAudio({ ws, api, onChange }) {
  let ctx = null, tap = null, tapReady = null;
  const S = { mode: null, label: "", queue: [], index: -1, song: null, analysing: 0, error: null, stream: null };
  const emit = () => onChange && onChange(S);

  async function ensureCtx() {
    if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" }); }
    if (ctx.state === "suspended") await ctx.resume();
    if (!tapReady) tapReady = ctx.audioWorklet.addModule("/pcm-worklet.js").then(() => {
      // the tap has one silent output to the speakers: browsers only run nodes that lead to the destination
      tap = new AudioWorkletNode(ctx, "pcm-tap", { numberOfInputs: 1, numberOfOutputs: 1 });
      const mute = ctx.createGain(); mute.gain.value = 0; tap.connect(mute).connect(ctx.destination);
      tap.port.onmessage = e => ws.sendBinary(e.data);
    });
    await tapReady; return ctx;
  }
  // the latency meter: how long a sound takes from here to the server (input buffer, our 512-sample chunks, half the round trip)
  let rttMs = 0;
  const latencyMs = () => Math.round(((ctx?.baseLatency || 0) * 1000) + (S.mode === "mic" || S.mode === "system" ? 10 : 0) + 512 / 22050 * 1000 + rttMs / 2);
  async function measureRtt() { const t = []; for (let k = 0; k < 3; k++) { const t0 = performance.now(); try { await api("GET", "/api/health"); } catch { return; } t.push(performance.now() - t0); } rttMs = Math.min(...t); }
  function startStream(label) { ws.send({ type: "audio-start", rate: 22050, label, latencyMs: latencyMs() });
    measureRtt().then(() => { if (S.mode && S.label === label.replace(/^Song: /, "")) ws.send({ type: "audio-start", rate: 22050, label, latencyMs: latencyMs() }); }); }
  function stopStream() { ws.send({ type: "audio-stop" }); }

  // ---------------------------------------------------------------- songs
  async function analyse(buf, onProgress) {
    const ch = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const dec = buf.sampleRate > 32000 ? 2 : 1, n = Math.floor(ch.length / dec), x = new Float32Array(n), div = dec * (ch1 ? 2 : 1);
    for (let i = 0; i < n; i++) { let v = 0; for (let k = 0; k < dec; k++) { v += ch[i * dec + k]; if (ch1) v += ch1[i * dec + k]; } x[i] = v / div; }
    const { preAnalyseCore } = await import("/engine/analysis.js"); // (loaded with the first song, not with the page)
    return preAnalyseCore(x, buf.sampleRate / dec, onProgress);
  }
  const plain = a => ({ ...a, env: Array.from(a.env, v => Math.round(v * 1000) / 1000), features: a.features });

  async function addFiles(files) {
    for (const f of files) S.queue.push({ name: f.name.replace(/\.[^.]+$/, ""), file: f, url: null, buffer: null, analysis: null });
    emit();
    if (S.index < 0 && S.queue.length) await playIndex(0);
  }
  async function addUrl(url, name) { S.queue.push({ name, url, buffer: null, analysis: null }); emit(); if (S.index < 0) await playIndex(S.queue.length - 1); }

  async function load(item) {
    const c = await ensureCtx();
    if (!item.buffer) {
      const ab = item.file ? await item.file.arrayBuffer() : await (await fetch(item.url)).arrayBuffer();
      item.buffer = await c.decodeAudioData(ab);
    }
    if (!item.analysis) {
      S.analysing = 0.01; emit();
      item.analysis = await analyse(item.buffer, p => { S.analysing = Math.max(0.01, p); emit(); });
      S.analysing = 0; emit();
    }
  }

  async function playIndex(i) {
    if (i < 0 || i >= S.queue.length) return;
    stopLive(); stopSong(false);
    S.index = i; S.error = null; const item = S.queue[i]; emit();
    try { await load(item); } catch (e) { S.error = `Couldn't open ${item.name}: ${e.message || e}`; S.analysing = 0; emit(); return; }
    const c = await ensureCtx();
    await api("POST", "/api/song", { name: item.name, analysis: plain(item.analysis), clientId: ws.id });
    S.song = { item, src: null, startedAt: 0, offset: 0, playing: false, gain: c.createGain() };
    S.song.gain.connect(c.destination); S.song.gain.connect(tap);
    S.mode = "song"; S.label = item.name; startStream(`Song: ${item.name}`);
    play(0);
  }
  function play(from) {
    const s = S.song; if (!s) return; const c = ctx;
    if (s.src) { s.src.onended = null; try { s.src.stop(); } catch {} }
    const src = c.createBufferSource(); src.buffer = s.item.buffer; src.connect(s.gain);
    s.offset = Math.max(0, Math.min(from, s.item.buffer.duration - 0.05)); s.startedAt = c.currentTime; src.start(0, s.offset);
    src.onended = () => { if (S.song === s && s.playing) next(); };
    s.src = src; s.playing = true; clock(); emit();
  }
  function pos() { const s = S.song; if (!s) return 0; return s.playing ? s.offset + (ctx.currentTime - s.startedAt) : s.offset; }
  function pause() { const s = S.song; if (!s || !s.playing) return; s.offset = pos(); s.playing = false; s.src.onended = null; try { s.src.stop(); } catch {} clock(); emit(); }
  function toggle() { const s = S.song; if (!s) return; if (s.playing) pause(); else play(s.offset); }
  function seek(t) { const s = S.song; if (!s) return; if (s.playing) play(t); else { s.offset = t; clock(); emit(); } }
  function next() { if (S.index + 1 < S.queue.length) playIndex(S.index + 1); else { pause(); seek(0); } }
  function prev() { if (pos() > 3) seek(0); else if (S.index > 0) playIndex(S.index - 1); }
  // the server needs to know where we are in the song; output latency is what the speakers add after we hand them audio
  function clock() { const s = S.song; if (!s) return; const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    ws.send({ type: "clock", pos: Math.max(0, pos() - lat), playing: s.playing, rate: 1 }); }
  setInterval(() => { if (S.song && S.song.playing) clock(); }, 500);
  function stopSong(tell = true) {
    const s = S.song; if (!s) return; s.playing = false; if (s.src) { s.src.onended = null; try { s.src.stop(); } catch {} }
    try { s.gain.disconnect(); } catch {} S.song = null;
    if (tell) { api("DELETE", "/api/song").catch(() => {}); stopStream(); S.mode = null; S.index = -1; emit(); }
  }
  function remove(i) { if (i === S.index) { stopSong(); } S.queue.splice(i, 1); if (S.index > i) S.index--; emit(); }

  // ---------------------------------------------------------------- live listening
  let meter = null; // analyser on whatever we're listening to, for the level meter
  /** Microphones and line inputs this browser can use (names appear after permission is given once). */
  async function listInputs() { try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput"); } catch { return []; } }
  function level() { if (!meter) return 0; const a = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(a); let s = 0; for (const v of a) s += v * v; return Math.min(1, Math.sqrt(s / a.length) * 4); }
  async function calibrate(deviceId, onProgress) { const { measure } = await import("/calibrate.js"); const c = await ensureCtx(); return measure(c, deviceId, onProgress); }
  async function listen(kind, deviceId) {
    S.error = null;
    if (!navigator.mediaDevices) { S.error = "This browser blocks audio capture on plain http. Open Tempolight as http://localhost on the computer that plays the music, or use server capture on the Music page."; emit(); return; }
    let stream;
    try {
      if (kind === "system") {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, systemAudio: "include", preferCurrentTab: false });
        stream.getVideoTracks().forEach(t => t.stop());
        if (!stream.getAudioTracks().length) { S.error = "No sound was shared. When the browser asks, pick a screen or tab and turn on “Share audio”."; emit(); return; }
      } else stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) { S.error = e.name === "NotAllowedError" ? "Permission was refused, so Tempolight can't hear anything." : `Couldn't start listening: ${e.message}`; emit(); return; }
    stopSong(); stopLive();
    const c = await ensureCtx(), src = c.createMediaStreamSource(stream); src.connect(tap);
    meter = c.createAnalyser(); meter.fftSize = 1024; src.connect(meter);
    S.stream = { stream, src }; S.mode = kind; S.label = kind === "system" ? "This computer's sound" : (stream.getAudioTracks()[0]?.label || "Microphone");
    stream.getAudioTracks()[0].addEventListener("ended", () => { if (S.stream && S.stream.stream === stream) stopLive(); });
    startStream(S.label); emit();
  }
  function stopLive() { if (!S.stream) return; meter = null; try { S.stream.src.disconnect(); } catch {} S.stream.stream.getTracks().forEach(t => t.stop()); S.stream = null; if (S.mode !== "song") { S.mode = null; stopStream(); } emit(); }

  // for recording a clip: the song or live sound as a MediaStream
  let recDest = null;
  function captureStream() {
    if (!ctx) return null; if (!recDest) recDest = ctx.createMediaStreamDestination();
    try { if (S.song) S.song.gain.connect(recDest); if (S.stream) S.stream.src.connect(recDest); } catch {}
    return recDest.stream;
  }
  return { captureStream, state: S, addFiles, addUrl, playIndex, toggle, seek, next, prev, pos, remove, listen, stopLive, stopSong, listInputs, level, calibrate, latencyMs,
    get duration() { return S.song ? S.song.item.buffer.duration : 0; } };
}
