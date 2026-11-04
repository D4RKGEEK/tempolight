// setInterval at 60 fps, as runtime.js does, with ~work ms of render per frame and a little garbage
const work = Number(process.argv[2] || 0), mode = process.argv[3] || "interval";
const ts = []; let junk = [];
function tick() { const t = performance.now(); ts.push(t); const e = t + work; while (performance.now() < e) junk.push({ a: Math.random() }); if (junk.length > 2e5) junk = []; }
if (mode === "interval") { const h = setInterval(tick, 1000 / 60); setTimeout(() => { clearInterval(h); report(); }, 5000); }
else { // deadline scheduler: aim at absolute frame times, sleep to 2 ms before, then spin
  const t0 = performance.now(), P = 1000 / 60; let n = 1;
  const loop = () => { const target = t0 + n * P; let now = performance.now(); if (target - now > 2) return setTimeout(loop, target - now - 2); while (performance.now() < target); tick(); n++; if (performance.now() - t0 < 5000) setImmediate(loop); else report(); };
  loop(); }
function report() { const d = ts.slice(1).map((t, i) => t - ts[i]), P = 1000 / 60; d.sort((a, b) => a - b);
  // phase error vs an ideal 60 fps grid anchored at the first frame
  const ph = ts.map((t, i) => t - ts[0] - i * P); const drift = ph.at(-1);
  console.log(`${mode} work=${work}ms frames=${ts.length} interval p50=${d[d.length >> 1].toFixed(2)} p99=${d[Math.floor(d.length * .99)].toFixed(2)} max=${d.at(-1).toFixed(2)} | drift after 5s=${drift.toFixed(1)}ms`); }
