// One worker of the music library's pool (library.js): decodes and analyses song files and sends back their song
// memory entries. The pool may hand it the next file while one is being analysed: that file is decoded meanwhile
// (ffmpeg is a process of its own, so it uses another core), and the analyses still run one at a time.
// On Linux the worker lowers its own thread's priority (a thread's "nice" is its own there), so the analysis only
// gets CPU time nothing else wants; elsewhere that call would slow the whole app down, so it isn't made.
import { parentPort, workerData } from "node:worker_threads";
import os from "node:os";
import { decodeFile, analyseDecoded } from "./audiofile.js";

if (process.platform === "linux" && workerData?.background !== false) { try { os.setPriority(0, 19); } catch {} } // (0: this thread)
const queue = []; let busy = false;
const fail = (job, e) => parentPort.postMessage({ job: job.job, ok: false, error: String(e?.message || e), needs: e?.needs || null, skip: !!e?.skip });
async function next() {
  if (busy || !queue.length) return; busy = true;
  const { job, dec } = queue.shift();
  try { const d = await dec; parentPort.postMessage({ job: job.job, ok: true, ...await analyseDecoded(d, job) }); }
  catch (e) { fail(job, e); }
  busy = false; next();
}
parentPort.on("message", job => {
  const dec = decodeFile(job.file, job); dec.catch(() => {}); // decoding starts now, also for a file waiting its turn
  queue.push({ job, dec }); next();
});
let nice = null; try { nice = os.getPriority(0); } catch {}
parentPort.postMessage({ ready: true, nice }); // (this thread's priority, for the tests)
