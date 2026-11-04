// Host-test helpers: a C++ port of the EDM test song in packages/engine/test/synth.js (kicks only in the drop, a
// snare-roll build-up, hats throughout) and an emulation of WLED AudioReactive's GEQ output (512-sample FFT at
// 22,050 Hz, the 16-channel bin mapping, pink-noise correction, the rise/fall limiter and square-root scaling), so the
// analyser sees frames shaped like the ones it gets on the ESP32.
#pragma once
#include <math.h>
#include <stdint.h>

#include <array>
#include <complex>
#include <vector>

namespace synth {

struct Rng {  // same LCG as synth.js rng()
  uint32_t s;
  explicit Rng(uint32_t seed = 7) : s(seed) {}
  double operator()() { s = s * 1664525u + 1013904223u; return (s / 4294967296.0) * 2 - 1; }
};

struct Song {
  std::vector<float> x;
  int sr;
  double bpm, dropStart, buildStart, bar, end;
};

/// edm(): 4 bars intro (chords, hats), 4 bars build-up (snare roll 1/2/4/8 per beat), 8 bars drop (kick on every beat,
/// snare on 2 and 4, saw bass), 2 bars outro, then 1 s of silence. bpm defaults to 128 like synth.js.
inline Song edm(double bpm = 128, int sr = 22050, uint32_t seed = 7) {
  const double beat = 60 / bpm, bar = 4 * beat; const int bars = 18;
  const size_t n = (size_t)((bars * bar + 1) * sr);
  Song s{std::vector<float>(n, 0.f), sr, bpm, 8 * bar, 4 * bar, bar, bars * bar};
  Rng r(seed);
  auto put = [&](double t, auto fn, double dur) { const size_t i0 = (size_t)(t * sr); for (size_t k = 0; k < dur * sr && i0 + k < n; k++) s.x[i0 + k] += (float)fn(k / (double)sr); };
  const double chords[4][3] = {{220, 261.6, 329.6}, {174.6, 220, 261.6}, {130.8, 164.8, 196}, {196, 246.9, 293.7}};
  for (int b = 0; b < bars; b++) {
    const double t0 = b * bar; const double* ch = chords[b % 4];
    const int part = b < 4 ? 0 : b < 8 ? 1 : b < 16 ? 2 : 3;  // intro, build, drop, outro
    put(t0, [&](double t) { return (sin(2 * M_PI * ch[0] * t) + sin(2 * M_PI * ch[1] * t) + sin(2 * M_PI * ch[2] * t)) * 0.05 * fmin(1, t / 0.3); }, bar);
    for (int q = 0; q < 4; q++) { double hp = 0; put(t0 + q * beat + beat / 2, [&](double t) { const double w = r(), y = w - hp; hp = w; return y * 0.35 * exp(-t * 70); }, 0.06); }
    if (part == 1) {
      const int div = (int[]){1, 2, 4, 8}[b - 4], steps = b == 7 ? 3 * div : 4 * div;
      for (int st = 0; st < steps; st++) { const double g = 0.3 + 0.7 * ((b - 4) * 4 + st / (double)div) / 16;
        put(t0 + st * beat / div, [&](double t) { return (r() * 0.6 + sin(2 * M_PI * 190 * t) * 0.4) * exp(-t * 18) * g; }, 0.2); }
    }
    if (part == 2) for (int q = 0; q < 4; q++) {
      double ph = 0; bool first = true;
      put(t0 + q * beat, [&](double t) { ph = first ? 0 : ph + 2 * M_PI * (45 + 90 * exp(-t * 28)) / sr; first = false; return sin(ph) * exp(-t * 7); }, 0.4);
      if (q % 2) put(t0 + q * beat, [&](double t) { return (r() * 0.6 + sin(2 * M_PI * 190 * t) * 0.4) * exp(-t * 18) * 0.8; }, 0.2);
      double lp = 0; put(t0 + q * beat + 0.02, [&](double t) { const double saw = 2 * fmod(ch[0] / 4 * t, 1.0) - 1; lp += (saw - lp) * 0.05; return lp * 0.5; }, beat * 0.9);
    }
  }
  float m = 0; for (float v : s.x) m = fmaxf(m, fabsf(v)); for (float& v : s.x) v /= m;
  return s;
}

/// pads(): drumless chords (a ballad-like intro that never drops).
inline Song pads(double seconds = 20, int sr = 22050) {
  const size_t n = (size_t)(seconds * sr); Song s{std::vector<float>(n, 0.f), sr, 0, 0, 0, 0, seconds};
  const double ch[3] = {220, 277.2, 329.6};
  for (size_t i = 0; i < n; i++) { const double t = i / (double)sr, g = 0.6 + 0.4 * sin(2 * M_PI * t / 8);
    s.x[i] = (float)((sin(2 * M_PI * ch[0] * t) + sin(2 * M_PI * ch[1] * t) + 0.5 * sin(2 * M_PI * ch[2] * t)) * 0.25 * g * fmin(1, t)); }
  return s;
}

/// WLED AudioReactive GEQ emulation: frames of 512 fresh samples (23.2 ms), like the FFT task does at 22,050 Hz.
class Geq {
 public:
  static constexpr int N = 512;
  struct Frame { uint8_t fft[16]; float volume; double t; };

  std::vector<Frame> run(const std::vector<float>& x, int sr, double micLevel = 0.3, double noise = 0.0, uint32_t seed = 3) {
    // gain: calibrated once so the loudest frames reach the top of the 0..255 range, like a set-up AGC / gain
    std::vector<std::array<float, 16>> calc; std::vector<float> vol; std::vector<char> gateOpen; Rng r(seed);
    for (size_t i0 = 0; i0 + N <= x.size(); i0 += N) {
      std::vector<std::complex<double>> a(N); double sa = 0;
      for (int i = 0; i < N; i++) { const double v = (x[i0 + i] * micLevel + noise * r()) * 32767; sa += fabs(v);
        a[i] = v * (0.5 - 0.5 * cos(2 * M_PI * i / (N - 1))); }
      fft(a); double mag[N / 2]; for (int i = 0; i < N / 2; i++) mag[i] = std::abs(a[i]);
      auto av = [&](int lo, int hi) { double s = 0; for (int i = lo; i <= hi; i++) s += mag[i]; return s / (hi - lo + 1); };
      // softhack007's 22 kHz mapping (audio_reactive.cpp), no band-pass filter
      std::array<float, 16> c = {(float)av(1, 2), (float)av(2, 3), (float)av(3, 5), (float)av(5, 7), (float)av(7, 10), (float)av(10, 13),
        (float)av(13, 19), (float)av(19, 26), (float)av(26, 33), (float)av(33, 44), (float)av(44, 56), (float)av(56, 70), (float)av(70, 86),
        (float)av(86, 104), (float)(av(104, 165) * 0.88), (float)(av(165, 215) * 0.70)};
      static const float pink[16] = {1.70f, 1.71f, 1.73f, 1.78f, 1.68f, 1.56f, 1.55f, 1.63f, 1.79f, 1.62f, 1.80f, 2.06f, 2.47f, 3.35f, 6.83f, 9.55f};
      for (int i = 0; i < 16; i++) c[i] *= pink[i];
      calc.push_back(c); vol.push_back((float)(sa / N));
      gateOpen.push_back(0);
    }
    float mx = 1; for (auto& c : calc) for (float v : c) mx = fmaxf(mx, v);
    float vmx = 1; for (float v : vol) vmx = fmaxf(vmx, v);
    // the noise gate (squelch): quiet blocks don't update the channels, they decay (fftCalc *= 0.85)
    const float gate = fmaxf(0.01f * vmx, (float)(1.6 * noise * 32767 * 0.5));  // squelch set just above the room noise
    for (size_t f = 0; f < vol.size(); f++) gateOpen[f] = vol[f] > gate;
    { std::array<float, 16> last{}; for (size_t f = 0; f < calc.size(); f++) { if (gateOpen[f]) last = calc[f]; else { for (auto& v : last) v *= 0.85f; calc[f] = last; } } }
    const float gain = 640.f / mx;  // * 0.38 -> ~243 -> sqrt ~15.6 at the loudest band
    std::vector<Frame> out; float avg[16] = {0}; float vs = 0;
    for (size_t f = 0; f < calc.size(); f++) {
      Frame fr; fr.t = (f + 1) * N / (double)sr;
      for (int i = 0; i < 16; i++) {
        float v = fminf(1023.f, calc[f][i] * gain);
        avg[i] = v > avg[i] ? v * 0.75f + 0.25f * avg[i] : v * 0.17f + 0.83f * avg[i];  // limiter (default on)
        float cur = avg[i] * 0.38f - 6.f; cur = cur > 1 ? sqrtf(cur) : 0; cur *= 0.85f + i / 4.5f; cur = cur * 255.f / 16.f;
        fr.fft[i] = (uint8_t)fmaxf(0, fminf(255, cur));
      }
      vs += ((gateOpen[f] ? vol[f] / vmx * 255 : 0) - vs) * 0.3f; fr.volume = vs;
      out.push_back(fr);
    }
    return out;
  }

 private:
  static void fft(std::vector<std::complex<double>>& a) {
    const int n = (int)a.size();
    for (int i = 1, j = 0; i < n; i++) { int bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) std::swap(a[i], a[j]); }
    for (int len = 2; len <= n; len <<= 1) { const double ang = -2 * M_PI / len; const std::complex<double> wl(cos(ang), sin(ang));
      for (int i = 0; i < n; i += len) { std::complex<double> w(1); for (int k = 0; k < len / 2; k++) { auto u = a[i + k], v = a[i + k + len / 2] * w; a[i + k] = u + v; a[i + k + len / 2] = u - v; w *= wl; } } }
  }
};

}  // namespace synth
