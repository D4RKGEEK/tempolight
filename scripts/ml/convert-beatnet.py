#!/usr/bin/env python3
"""Convert a BeatNet CRNN checkpoint (CC BY 4.0, github.com/mjhydri/BeatNet) to Tempolight's compact weight file.

Needs only numpy (no torch, no madmom install). The log filterbank is built with madmom's own filters.py (BSD), read
from a clone of github.com/CPJKU/madmom, so the JavaScript front end uses exactly the filters BeatNet was trained on.

  git clone --depth 1 https://github.com/mjhydri/BeatNet /tmp/BeatNet
  git clone --depth 1 https://github.com/CPJKU/madmom /tmp/madmom
  python3 -I scripts/ml/convert-beatnet.py /tmp/BeatNet/src/BeatNet/models/model_1_weights.pt /tmp/madmom \
      packages/engine/src/ml/weights/beatnet-1.tlw [--f32]

The file format (.tlw, "Tempolight weights"), read by packages/engine/src/ml/weights.js:
  bytes 0-3   "TLW1"
  bytes 4-7   header length H (uint32, little-endian)
  bytes 8..   H bytes of UTF-8 JSON: {"meta": {...}, "tensors": [{"name", "shape", "dtype", "offset"}]}
  then        the tensor data, each tensor 4-byte aligned, offsets counted from the end of the header
              (dtype "f16": IEEE half floats; "f32": floats; "u16": unsigned 16-bit integers)
"""
import importlib.util
import json
import os
import struct
import sys
import types

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import torchzip  # noqa: E402


def madmom_filters(madmom_dir):
    """madmom.audio.filters, loaded on its own (a stub for madmom.processors, which needs compiled code)."""
    pkg = types.ModuleType("madmom"); pkg.__path__ = []
    audio = types.ModuleType("madmom.audio"); audio.__path__ = []
    proc = types.ModuleType("madmom.processors")

    class Processor:  # noqa: D401 - a stand-in
        pass
    proc.Processor = Processor
    sys.modules.update({"madmom": pkg, "madmom.audio": audio, "madmom.processors": proc})
    spec = importlib.util.spec_from_file_location("madmom.audio.filters", os.path.join(madmom_dir, "madmom/audio/filters.py"))
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 3:
        print(__doc__); sys.exit(2)
    ckpt, madmom_dir, out = args
    f16 = "--f32" not in sys.argv
    sd = torchzip.load(ckpt)

    # BeatNet's front end (log_spect.py / BeatNet.py): 22,050 Hz, 64 ms Hann frames (1411 samples), 20 ms hop (441),
    # madmom LogarithmicFilterbank 24 bands per octave 30 Hz-17 kHz, normalised, unique; log10(1 + x); positive
    # first-order difference (diff_ratio 0.5 gives 1 frame for this window and hop); [spec, diff] stacked.
    sr, win, hop = 22050, int(64 * 0.001 * 22050), int(20 * 0.001 * 22050)
    F = madmom_filters(madmom_dir)
    nbins = win >> 1
    binf = np.fft.fftfreq(nbins * 2, 1. / sr)[:nbins]  # madmom.audio.stft.fft_frequencies
    fb = np.asarray(F.LogarithmicFilterbank(binf, num_bands=24, fmin=30, fmax=17000, norm_filters=True, unique_filters=True))
    window = np.hanning(win)
    sample = int(np.argmax(window > 0.5 * window.max())); diff_frames = int(max(1, round((len(window) / 2 - sample) / hop)))
    nbands = fb.shape[1]
    assert 2 * nbands == 272, f"filterbank has {nbands} bands, the model wants 136"
    # the filterbank is sparse (triangles): store each band as [first bin, length] and its weights
    starts, lens, vals = [], [], []
    for b in range(nbands):
        nz = np.nonzero(fb[:, b])[0]; lo, hi = int(nz[0]), int(nz[-1]) + 1
        starts.append(lo); lens.append(hi - lo); vals.append(fb[lo:hi, b])
    tensors = [("fb.start", np.array(starts, np.uint16)), ("fb.len", np.array(lens, np.uint16)), ("fb.w", np.concatenate(vals).astype(np.float32))]
    for k in ["conv1.weight", "conv1.bias", "linear0.weight", "linear0.bias",
              "lstm.weight_ih_l0", "lstm.weight_hh_l0", "lstm.bias_ih_l0", "lstm.bias_hh_l0",
              "lstm.weight_ih_l1", "lstm.weight_hh_l1", "lstm.bias_ih_l1", "lstm.bias_hh_l1",
              "linear.weight", "linear.bias"]:
        tensors.append((k, np.asarray(sd[k], np.float32)))

    meta = {"model": "BeatNet CRNN (BDA)", "source": "https://github.com/mjhydri/BeatNet", "checkpoint": os.path.basename(ckpt),
            "license": "CC-BY-4.0", "attribution": "BeatNet by Mojtaba Heydari, Frank Cwitkowitz and Zhiyao Duan (ISMIR 2021), https://github.com/mjhydri/BeatNet",
            "sr": sr, "win": win, "hop": hop, "fftBins": nbins, "bands": nbands, "diffFrames": diff_frames, "hidden": int(sd["lstm.weight_hh_l0"].shape[1]),
            "outputs": ["beat", "downbeat", "none"]}
    header, blobs, off = {"meta": meta, "tensors": []}, [], 0
    for name, a in tensors:
        if a.dtype == np.float32 and f16 and not name.startswith("fb."):
            raw, dt = a.astype("<f2").tobytes(), "f16"
        elif a.dtype == np.float32:
            raw, dt = a.astype("<f4").tobytes(), "f32"
        else:
            raw, dt = a.astype("<u2").tobytes(), "u16"
        pad = (-len(raw)) % 4
        header["tensors"].append({"name": name, "shape": list(a.shape), "dtype": dt, "offset": off})
        blobs.append(raw + b"\0" * pad); off += len(raw) + pad
    hj = json.dumps(header, separators=(",", ":")).encode()
    hj += b" " * ((-len(hj)) % 4)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "wb") as f:
        f.write(b"TLW1" + struct.pack("<I", len(hj)) + hj + b"".join(blobs))
    n = sum(int(np.prod(a.shape)) for k, a in tensors if not k.startswith("fb."))
    print(f"{out}: {n} parameters, {os.path.getsize(out)} bytes ({'f16' if f16 else 'f32'}), {nbands} bands, diff {diff_frames} frame(s)")

    # a reference for the JavaScript port: features and activations of a test signal, in numpy (float64)
    if os.environ.get("TLW_REF"):
        ref = reference(sd, fb, window, hop, diff_frames, sr)
        with open(os.environ["TLW_REF"], "w") as f:
            json.dump(ref, f)
        print("reference written:", os.environ["TLW_REF"])


def reference(sd, fb, window, hop, diff_frames, sr):
    """The same front end and CRNN in numpy, on a fixed test signal (clicks and a tone), for checking the JS port."""
    rng = np.random.default_rng(1)
    n = sr * 3; t = np.arange(n) / sr
    x = 0.2 * np.sin(2 * np.pi * 220 * t) + 0.01 * rng.standard_normal(n)
    for k in range(6):  # a kick-like blip every 0.5 s
        i = int((0.25 + 0.5 * k) * sr); m = min(n - i, 4000); tt = np.arange(m) / sr
        x[i:i + m] += np.sin(2 * np.pi * (50 + 80 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 8)
    x = x.astype(np.float32)
    win = len(window); frames = []
    for end in range(win, n + 1, hop):  # causal frames: the newest `win` samples every hop
        fr = x[end - win:end] * window
        mag = np.abs(np.fft.fft(fr, win))[:win >> 1]
        frames.append(np.log10(1 + mag @ fb))
    S = np.array(frames); D = np.zeros_like(S); D[diff_frames:] = np.maximum(0, S[diff_frames:] - S[:-diff_frames])
    feats = np.hstack([S, D])
    W = {k: np.asarray(v, np.float64) for k, v in sd.items()}
    sig = lambda v: 1 / (1 + np.exp(-v))
    H = W["lstm.weight_hh_l0"].shape[1]; h = [np.zeros(H), np.zeros(H)]; c = [np.zeros(H), np.zeros(H)]; out = []
    for f in feats:
        conv = np.array([np.convolve(f, W["conv1.weight"][o, 0][::-1], "valid") + W["conv1.bias"][o] for o in range(2)])
        conv = np.maximum(conv, 0); L = conv.shape[1] // 2
        pooled = conv[:, :2 * L].reshape(2, L, 2).max(axis=2).reshape(-1)
        z = W["linear0.weight"] @ pooled + W["linear0.bias"]
        for l in range(2):
            g = W[f"lstm.weight_ih_l{l}"] @ z + W[f"lstm.bias_ih_l{l}"] + W[f"lstm.weight_hh_l{l}"] @ h[l] + W[f"lstm.bias_hh_l{l}"]
            i_, f_, g_, o_ = g[:H], g[H:2 * H], g[2 * H:3 * H], g[3 * H:]
            c[l] = sig(f_) * c[l] + sig(i_) * np.tanh(g_); h[l] = sig(o_) * np.tanh(c[l]); z = h[l]
        y = W["linear.weight"] @ z + W["linear.bias"]; e = np.exp(y - y.max()); out.append((e / e.sum()).tolist())
    return {"sr": sr, "x": x.tolist(), "feats": feats[::25].tolist(), "featEvery": 25, "act": out}


if __name__ == "__main__":
    main()
