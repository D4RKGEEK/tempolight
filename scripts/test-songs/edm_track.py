"""Synthesize an original 128 BPM EDM track and log every musical event."""
import numpy as np, json, wave
from scipy.signal import butter, lfilter

SR = 44100
BPM = 128
BEAT = 60 / BPM
BAR = 4 * BEAT
NBARS = 34
DUR = NBARS * BAR + 1.5
N = int(DUR * SR)
rng = np.random.default_rng(7)
mix = np.zeros(N)
events = {"kick": [], "snare": [], "hat": [], "bass": [], "pluck": []}

def lp(x, fc, order=2):
    b, a = butter(order, min(fc / (SR / 2), 0.99), "low"); return lfilter(b, a, x)
def hp(x, fc, order=2):
    b, a = butter(order, fc / (SR / 2), "high"); return lfilter(b, a, x)
def bp(x, lo, hi):
    b, a = butter(2, [lo / (SR / 2), hi / (SR / 2)], "band"); return lfilter(b, a, x)
def add(sig, t, gain=1.0):
    i = int(t * SR); j = min(N, i + len(sig)); mix[i:j] += sig[: j - i] * gain
def saw(f, n, ph=0.0):
    t = np.arange(n) / SR; return 2 * ((f * t + ph) % 1.0) - 1
def note(m): return 440 * 2 ** ((m - 69) / 12)

# --- instruments
def kick():
    n = int(0.45 * SR); t = np.arange(n) / SR
    f = 45 + 95 * np.exp(-t * 28); ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 7.5) + 0.3 * np.exp(-t * 300) * rng.standard_normal(n) * 0.2
def snare(g=1.0):
    n = int(0.25 * SR); t = np.arange(n) / SR
    nz = bp(rng.standard_normal(n), 1200, 7000) * np.exp(-t * 18)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30)
    return (0.9 * nz + 0.5 * tone) * g
def hat(open_=False):
    n = int((0.18 if open_ else 0.05) * SR); t = np.arange(n) / SR
    return hp(rng.standard_normal(n), 7000) * np.exp(-t * (18 if open_ else 80)) * 0.5
def pad(midis, dur):
    n = int(dur * SR); out = np.zeros(n); t = np.arange(n) / SR
    for m in midis:
        for d in (-0.08, 0, 0.09):
            out += saw(note(m) * 2 ** (d / 12), n, rng.random())
    out = lp(out, 1400) / (len(midis) * 3)
    env = np.minimum(1, t / 0.4) * np.minimum(1, (dur - t) / 0.3)
    return out * env
def bass(m, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    s = saw(note(m), n) + 0.5 * np.sin(2 * np.pi * note(m - 12) * t)
    return lp(s, 380) * np.minimum(1, (dur - t) / 0.02) * np.minimum(1, t / 0.005)
def pluck(m):
    n = int(0.35 * SR); t = np.arange(n) / SR
    s = saw(note(m), n) + saw(note(m) * 1.005, n)
    return lp(s * np.exp(-t * 9), 3200) * 0.35

# Am - F - C - G (A minor)
chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
roots = [45, 41, 36, 43]
arp = [[69, 72, 76, 72], [65, 69, 72, 69], [64, 67, 72, 67], [67, 71, 74, 71]]

sections = [("intro", 0, 4), ("build", 4, 8), ("drop", 8, 16), ("break", 16, 20), ("build", 20, 24), ("drop", 24, 32), ("outro", 32, 34)]
sec_of = {}; sec_start = {}
for name, a, b in sections:
    for k in range(a, b): sec_of[k] = name; sec_start[k] = a

for bar in range(NBARS):
    t0 = bar * BAR; ci = bar % 4; sec = sec_of[bar]
    pg = {"intro": 0.55, "build": 0.5, "drop": 0.38, "break": 0.6, "outro": 0.6}[sec]
    rb = bar - sec_start[bar]
    if not (sec == "build" and rb == 3):
        add(pad(chords[ci], BAR), t0, pg)
    else:
        add(pad(chords[ci], BAR * 0.75), t0, pg)
    if sec == "intro":
        for b in range(4):
            add(hat(), t0 + b * BEAT + BEAT / 2, 0.6); events["hat"].append(t0 + b * BEAT + BEAT / 2)
        if bar >= 2:
            for b in range(4):
                add(pluck(arp[ci][b] - 12), t0 + b * BEAT, 0.5); events["pluck"].append(t0 + b * BEAT)
    if sec == "build":
        div = {0: 1, 1: 2, 2: 4, 3: 8}[rb]
        steps = 4 * div if rb < 3 else int(3 * div)
        for s in range(steps):
            g = 0.35 + 0.65 * (rb * 4 * BEAT + s * BEAT / div) / (4 * BAR)
            add(snare(g), t0 + s * BEAT / div, 0.7); events["snare"].append(t0 + s * BEAT / div)
        for b in range(4):
            add(hat(), t0 + b * BEAT + BEAT / 2, 0.5); events["hat"].append(t0 + b * BEAT + BEAT / 2)
    if sec == "drop":
        for b in range(4):
            tb = t0 + b * BEAT
            add(kick(), tb, 1.0); events["kick"].append(tb)
            add(hat(open_=True), tb + BEAT / 2, 0.45); events["hat"].append(tb + BEAT / 2)
            if b in (1, 3): add(snare(), tb, 0.8); events["snare"].append(tb)
            for h in range(2):
                add(bass(roots[ci], BEAT / 2 * 0.9), tb + h * BEAT / 2 + 0.02, 0.55)
            events["bass"].append(tb + BEAT / 2)
            for s in range(2):
                m = arp[ci][(b * 2 + s) % 4] + (12 if rb >= 4 else 0)
                add(pluck(m), tb + s * BEAT / 2, 0.55); events["pluck"].append(tb + s * BEAT / 2)
    if sec in ("break", "outro"):
        for b in range(0, 4, 2):
            add(pluck(arp[ci][b]), t0 + b * BEAT, 0.4); events["pluck"].append(t0 + b * BEAT)

for bs in (4, 20):
    a, b = int(bs * BAR * SR), int((bs + 3.75) * BAR * SR)
    n = b - a; t = np.arange(n) / SR; prog = t / t[-1]
    nz = rng.standard_normal(n); out = np.zeros(n); blk = 2048
    for i in range(0, n, blk):
        fc = 400 + 7000 * prog[i] ** 2
        out[i:i + blk] = bp(nz[i:i + blk], fc * 0.7, min(fc * 1.3, 20000))
    mix[a:b] += out * prog ** 1.5 * 0.35
    imp = lp(rng.standard_normal(int(1.2 * SR)), 900) * np.exp(-np.arange(int(1.2 * SR)) / SR * 3) * 0.7
    add(imp, (bs + 4) * BAR, 1.0)

# sidechain pump in the drop
env = np.ones(N)
for k in events["kick"]:
    i = int(k * SR); L = int(0.3 * SR); j = min(N, i + L)
    env[i:j] = np.minimum(env[i:j], 0.35 + 0.65 * (np.arange(j - i) / L) ** 0.6)
kick_layer = np.zeros(N)
for k in events["kick"]:
    s = kick(); i = int(k * SR); j = min(N, i + len(s)); kick_layer[i:j] += s[: j - i]
mix = mix * env  # pump everything...
mix += kick_layer * 0  # kick already in mix (pumped slightly) — fine
# master: gentle fade at end, normalise, soft clip
tt = np.arange(N) / SR
mix *= np.clip((DUR - tt) / 2.0, 0, 1)
mix = np.tanh(mix / np.max(np.abs(mix)) * 1.6) * 0.9
st = np.stack([mix, lp(mix, 16000)], 1)
with wave.open("track2.wav", "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((st * 32767).astype(np.int16).tobytes())
meta = {"bpm": BPM, "beat": BEAT, "bar": BAR, "nbars": NBARS, "dur": DUR,
        "sections": sections, "chords_root": roots, "events": events}
json.dump(meta, open("track2.json", "w"))
print("dur", DUR, {k: len(v) for k, v in events.items()})
