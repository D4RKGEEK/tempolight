// OBS Studio through obs-websocket 5 (built into OBS 28 and later; Tools → WebSocket Server Settings). Tempolight
// connects to it (ws://127.0.0.1:4455 by default), signs in with the password (SHA-256 of password + salt, then of
// that + challenge, base64), and listens for scene changes and the stream and recording starting and stopping.
// What happens then (which Tempolight scene, the tally light) is decided in index.js.
import crypto from "node:crypto";
import { openWebSocket } from "./ws-client.js";

const sha = s => crypto.createHash("sha256").update(s).digest("base64");
/** obs-websocket's authentication string. */
export function obsAuth(password, salt, challenge) { return sha(sha(String(password) + salt) + challenge); }
// event subscriptions: General (1), Scenes (4), Outputs (64)
export const OBS_EVENTS = 1 | 4 | 64;

/**
 * @param {{url:string, password?:string, open?:(url:string)=>WebSocket, onEvent?:(type:string, data:object)=>void,
 *   onChange?:(status:object)=>void, retryMs?:number}} o
 */
export function createObsClient({ url, password = "", open = openWebSocket, onEvent = () => {}, onChange = () => {}, retryMs = 2000 }) {
  const st = { connected: false, connecting: false, error: null, scene: null, scenes: [], streaming: false, recording: false, version: null, since: null };
  let sock = null, stopped = false, timer = null, wait = retryMs, nextId = 1;
  const pending = new Map();
  const tell = () => { try { onChange({ ...st }); } catch {} };

  function connect() {
    if (stopped) return; clearTimeout(timer); st.connecting = true;
    let s; try { s = open(url); } catch (e) { st.connecting = false; st.error = e.message; tell(); return later(); }
    sock = s;
    s.onmessage = e => { if (typeof e.data !== "string") return; let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
    s.onerror = e => { st.error = e?.message || e?.error?.message || "Couldn't connect to OBS"; };
    s.onclose = e => {
      if (sock !== s) return; sock = null; const was = st.connected; Object.assign(st, { connected: false, connecting: false });
      for (const p of pending.values()) p.reject(new Error("OBS disconnected")); pending.clear();
      if (e?.code === 4009) { st.error = "OBS refused the password (Tools → WebSocket Server Settings → Show Connect Info)"; wait = 30000; }
      else if (e?.code === 4010 || e?.code === 4006) st.error = "This OBS's WebSocket server is too old: OBS 28 or later is needed";
      else if (was) st.error = "OBS closed the connection";
      else if (!st.error) st.error = `Couldn't connect to OBS at ${url}`;
      tell(); later();
    };
  }
  function later() { if (stopped) return; clearTimeout(timer); timer = setTimeout(connect, wait); timer.unref?.(); wait = Math.min(30000, wait * 2); }
  const send = o => { try { sock?.send(JSON.stringify(o)); } catch {} };
  function request(requestType, requestData) {
    if (!st.connected) return Promise.reject(new Error("Not connected to OBS"));
    const requestId = String(nextId++);
    return new Promise((resolve, reject) => { const t = setTimeout(() => { pending.delete(requestId); reject(new Error(`OBS didn't answer ${requestType}`)); }, 5000); t.unref?.();
      pending.set(requestId, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      send({ op: 6, d: { requestType, requestId, ...(requestData ? { requestData } : {}) } }); });
  }
  function handle(m) {
    const d = m.d || {};
    if (m.op === 0) { // Hello: sign in
      const id = { rpcVersion: 1, eventSubscriptions: OBS_EVENTS };
      if (d.authentication) { if (!password) { st.error = "OBS asks for a password: enter it in Tempolight's Integrations page"; tell(); } id.authentication = obsAuth(password, d.authentication.salt, d.authentication.challenge); }
      st.version = d.obsWebSocketVersion || null; send({ op: 1, d: id });
    } else if (m.op === 2) { // Identified
      Object.assign(st, { connected: true, connecting: false, error: null, since: Date.now() }); wait = retryMs; tell(); refresh();
    } else if (m.op === 5) event(d.eventType, d.eventData || {});
    else if (m.op === 7) { const p = pending.get(d.requestId); if (!p) return; pending.delete(d.requestId);
      if (d.requestStatus?.result) p.resolve(d.responseData || {}); else p.reject(new Error(d.requestStatus?.comment || `OBS: ${d.requestType} failed (${d.requestStatus?.code})`)); }
  }
  async function refresh() {
    try {
      const [sc, list, stream, rec] = await Promise.all([request("GetCurrentProgramScene"), request("GetSceneList"), request("GetStreamStatus").catch(() => ({})), request("GetRecordStatus").catch(() => ({}))]);
      st.scene = sc.currentProgramSceneName ?? sc.sceneName ?? null; st.scenes = (list.scenes || []).map(x => x.sceneName).filter(Boolean).reverse(); // OBS lists them bottom first
      st.streaming = !!stream.outputActive; st.recording = !!rec.outputActive; tell();
      onEvent("Connected", { ...st });
    } catch (e) { st.error = e.message; tell(); }
  }
  function event(type, data) {
    if (type === "CurrentProgramSceneChanged") st.scene = data.sceneName;
    else if (type === "SceneListChanged") st.scenes = (data.scenes || []).map(x => x.sceneName).filter(Boolean).reverse();
    else if (type === "SceneNameChanged") { st.scenes = st.scenes.map(n => n === data.oldSceneName ? data.sceneName : n); if (st.scene === data.oldSceneName) st.scene = data.sceneName; }
    else if (type === "StreamStateChanged") { if (data.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED") st.streaming = true; else if (data.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED") st.streaming = false; else return tell(); }
    else if (type === "RecordStateChanged") { if (data.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED" || data.outputState === "OBS_WEBSOCKET_OUTPUT_RESUMED") st.recording = true; else if (data.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED") st.recording = false; else if (data.outputState === "OBS_WEBSOCKET_OUTPUT_PAUSED") st.recording = false; else return tell(); }
    else if (type === "ExitStarted") { st.error = "OBS is closing"; }
    else return;
    tell(); try { onEvent(type, data); } catch {}
  }
  connect();
  return { status: () => ({ ...st }), request, close() { stopped = true; clearTimeout(timer); const s = sock; sock = null; try { s?.close(); } catch {} for (const p of pending.values()) p.reject(new Error("closed")); pending.clear(); } };
}
