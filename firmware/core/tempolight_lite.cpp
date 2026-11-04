// Tempolight Lite core: see tempolight_lite.h. Mirrors packages/engine/src/live.js (kick rules, tempo histogram,
// phase lock, section vote) in a form small enough for an ESP32 loop: fixed rings instead of growing arrays, a
// polynomial kernel instead of exp() in the tempo histogram, and WLED's 16 GEQ channels instead of our own FFT.
#include "tempolight_lite.h"

#include <math.h>
#include <string.h>

namespace tempolight {

namespace {
inline float clampf(float x, float lo, float hi) { return x < lo ? lo : x > hi ? hi : x; }
inline float pos(float x) { return x > 0 ? x : 0; }
inline uint8_t u8(float x) { return (uint8_t)clampf(x, 0.f, 255.f); }
inline float smoothK(float dt, float tau) { return 1.f - expf(-dt / tau); }
constexpr float kTau = 6.2831853f;

// WLED GEQ channels (22,050 Hz mapping in audio_reactive.cpp):
//   0: 43-86 Hz, 1: 86-129, 2: 129-216, 3: 216-301, 4-9: 301-1,895 (mids), 10-14: 1.9-7.1 kHz, 15: 7.1-9.3 kHz
inline float avg(const uint8_t* f, int a, int b) { float s = 0; for (int i = a; i <= b; i++) s += f[i]; return s / (b - a + 1); }
inline float avgf(const float* f, int a, int b) { float s = 0; for (int i = a; i <= b; i++) s += f[i]; return s / (b - a + 1); }

// AudioReactive's pink-noise correction (fftResultPink) and output scaling, undone so the kick rules can compare
// per-bin magnitudes across bands the way live.js does (white noise -> the same value in every band).
const float kPink[kBands] = {1.70f, 1.71f, 1.73f, 1.78f, 1.68f, 1.56f, 1.55f, 1.63f, 1.79f, 1.62f, 1.80f, 2.06f, 2.47f, 3.35f, 6.83f, 9.55f};
float linearOf(uint8_t v, int i, uint8_t mode) {
  if (!v) return 0;
  float x;
  switch (mode) {
    case 0: x = v + 4.f; break;                                                              // none
    case 1: { const float c = v / 255.f * 5.5452f / (0.85f + i / 18.f); x = (expf(c) + 8.f) / 0.42f; break; }  // log
    case 2: x = (v / (0.85f + i / 1.8f) + 4.f) / 0.30f; break;                              // linear
    default: { const float q = v * (16.f / 255.f) / (0.85f + i / 4.5f); x = (q * q + 6.f) / 0.38f; }  // square root
  }
  return x / kPink[i];
}
}  // namespace

const char* sectionName(Section s) {
  switch (s) {
    case Section::Calm: return "calm";
    case Section::Build: return "build";
    case Section::Drop: return "drop";
    default: return "silent";
  }
}

void LiteAnalyser::Ring::stats(float& mean, float& sd) const {
  if (!n) { mean = 0; sd = 0; return; }
  float m = 0; for (int i = 0; i < n; i++) m += v[i]; m /= n;
  float q = 0; for (int i = 0; i < n; i++) q += (v[i] - m) * (v[i] - m);
  mean = m; sd = sqrtf(q / n);
}

void LiteAnalyser::reset() {
  s_ = LiteState();
  hasPrev_ = false; memset(prev_, 0, sizeof(prev_)); memset(prevLin_, 0, sizeof(prevLin_)); lastMs_ = 0;
  kickH_.clear(); snareH_.clear(); hatH_.clear();
  lowN_ = lowPos_ = 0; lastK_ = lastS_ = lastH_ = 0;
  onN_ = onPos_ = 0; kickN_ = kickPos_ = 0; snareN_ = snarePos_ = 0; lastEst_ = 0;
  cand_ = 0; candN_ = 0; anchor_ = 0; phaseSet_ = false; lastBeatIdx_ = 0; barOff_ = 0; lastOnsetMs_ = 0;
  eFast_ = eSlow_ = 0; eMax_ = 2;
  bassS_ = midS_ = highS_ = subS_ = 0; lowPeak_ = 0; kickStrength_ = 0; bassMax_ = midMax_ = highMax_ = 2;
  domS_ = 0; domInit_ = false; domN_ = domPos_ = 0; domHistT_ = 0; domBase_ = 0; domBaseT_ = 0;
  voteN_ = votePos_ = 0; buildEndMs_ = 0; runStartMs_ = 0; usingKicks_ = false;
}

bool LiteAnalyser::detect(Ring& h, float val, uint32_t now, uint32_t& last, uint32_t refrMs, float k, float floor) {
  float m, sd; h.stats(m, sd); h.push(val);
  const float kk = k * (1.5f - sens_ / 255.f);  // sensitivity 128 -> about k
  if (h.n >= 8 && val > m + kk * sd && val > m * 1.4f && val > floor && (last == 0 || now - last > refrMs)) { last = now; return true; }
  return false;
}

int LiteAnalyser::countSince(const uint32_t* arr, int n, uint32_t now, uint32_t windowMs) const {
  int c = 0; for (int i = 0; i < n; i++) if (now - arr[i] < windowMs) c++;
  return c;
}

void LiteAnalyser::update(const uint8_t fft[kBands], float volume, uint32_t now) {
  s_.beat = s_.kick = s_.snare = false; s_.nowMs = now;
  if (!hasPrev_) { memcpy(prev_, fft, kBands); for (int i = 0; i < kBands; i++) prevLin_[i] = linearOf(fft[i], i, scaling_); hasPrev_ = true; lastMs_ = now; return; }
  const float dt = clampf((now - lastMs_) / 1000.f, 0.005f, 0.1f); lastMs_ = now;

  // --- onsets: flux (rises) per band group
  const float kf = (pos(fft[0] - (float)prev_[0]) + pos(fft[1] - (float)prev_[1])) * 0.5f;
  float lin[kBands]; for (int i = 0; i < kBands; i++) lin[i] = linearOf(fft[i], i, scaling_);
  // per-bin flux (linear): low (43-129 Hz), body (129-301 Hz), high (1.9-9.3 kHz)
  float lf[kBands]; for (int i = 0; i < kBands; i++) lf[i] = pos(lin[i] - prevLin_[i]);
  const float kpb = avgf(lf, 0, 1), bpb = avgf(lf, 2, 3), hpb = avgf(lf, 10, 15);
  memcpy(prevLin_, lin, sizeof(lin));
  // snare / clap: its body (129-301 Hz) and its noise (1.9-4.5 kHz), as in live.js; hats live above that
  float sn = 0; for (int b = 10; b <= 13; b++) sn += pos(fft[b] - (float)prev_[b]); sn /= 4;
  const float body = (pos(fft[2] - (float)prev_[2]) + pos(fft[3] - (float)prev_[3])) * 0.5f, sf = body * 0.6f + sn * 0.4f;
  const float hf = pos(fft[15] - (float)prev_[15]);
  const float lowNow = (lin[0] + lin[1]) * 0.5f;
  float la = 0; for (int i = 0; i < lowN_; i++) la += lowHist_[i]; la = lowN_ ? la / lowN_ : lowNow;
  lowHist_[lowPos_] = lowNow; lowPos_ = (lowPos_ + 1) % 6; if (lowN_ < 6) lowN_++;
  const float lowRise = (lowNow + 1e-3f) / (la + 1e-3f);
  const float meanAll = avg(fft, 0, 15);
  const bool loudEnough = meanAll > 2 || volume > 2;
  // kicks: the low channels' rise (kf) against its recent mean and spread, then the checks below
  const float lowB = (fft[0] + fft[1]) * 0.5f;
  lowPeak_ = fmaxf(lowPeak_ * powf(0.97f, dt), lowB);
  const bool kickRaw = detect(kickH_, kf, now, lastK_, 200, 1.6f, fmaxf(20.f, 0.12f * lowPeak_));
  // WLED's top bands clip at 255 on loud snares, which hides their rise: a low hit together with a snare must also be
  // about as strong as this song's recent kicks (a snare roll's noise reaches the low bands too)
  if (s_.kicksTotal && now - s_.lastKickMs > 10000) kickStrength_ = 0;
  const bool noisy = sn + hf > 40.f;  // a noise burst up high at the same time (a snare roll, a clap, a crash)
  const bool strongEnough = noisy && kickStrength_ > 0 ? kpb > 0.4f * kickStrength_ : true;
  // ...and a kick is loud down low: the low channels must reach a good part of the GEQ's range (and of the song's
  // loudest low hits). Sensitivity moves this floor: 0 -> 105, 128 -> 70, 255 -> 35.
  const float lowFloor = 105.f - sens_ * (70.f / 255.f);
  const bool punchy = lowB >= lowFloor && lowB >= 0.45f * lowPeak_;
  // like live.js: the low band's rise per bin must beat the highs' (snares and hats are noisy, and noise is broadband)
  // and the snare body's, and the low band must jump against the last ~140 ms (a sustained bass note doesn't)
  const bool kick = kickRaw && loudEnough && punchy && strongEnough && kpb > 4.f * hpb && kpb > 0.7f * bpb && lowRise > 1.35f;
  if (kick) kickStrength_ = kickStrength_ > 0 ? kickStrength_ * 0.8f + kpb * 0.2f : kpb;
  // (a snare needs its body: hats are noise up high only; a clap without body counts as a hat here)
  const bool snare = detect(snareH_, sf, now, lastS_, 140, 1.8f, 4.f) && loudEnough && body >= 6.f && (sn > 0 || hf > 0);
  const bool hat = detect(hatH_, hf, now, lastH_, 70, 1.4f, 4.f) && loudEnough;
  if (kick) {
    const float P = s_.bpm > 0 ? 60000.f / s_.bpm : 700.f;
    if (!s_.kicksTotal || now - s_.lastKickMs > (uint32_t)(2.5f * P)) runStartMs_ = now;  // a new run of kicks
    s_.kick = true; s_.lastKickMs = now; s_.kicksTotal++;
    kickT_[kickPos_] = now; kickPos_ = (kickPos_ + 1) % kOnsets; if (kickN_ < kOnsets) kickN_++;
  }
  if (snare) { s_.snare = true; s_.lastSnareMs = now; s_.snaresTotal++; snareT_[snarePos_] = now; snarePos_ = (snarePos_ + 1) % 16; if (snareN_ < 16) snareN_++; }
  if (kick || snare || hat) {
    onT_[onPos_] = now; onW_[onPos_] = kick ? 1.f : snare ? 0.5f : 0.25f; onPos_ = (onPos_ + 1) % kOnsets; if (onN_ < kOnsets) onN_++;
    lastOnsetMs_ = now;
  }
  memcpy(prev_, fft, kBands);

  // --- loudness and band levels (0..1 against slowly falling maxima)
  const float e = meanAll;
  eFast_ += (e - eFast_) * smoothK(dt, 0.25f); eSlow_ += (e - eSlow_) * smoothK(dt, 4.f);
  if (eSlow_ < eFast_ * 0.3f) eSlow_ = eFast_ * 0.3f + eSlow_ * 0.7f;
  const float decay = powf(0.97f, dt);
  eMax_ = fmaxf(fmaxf(eMax_ * decay, eFast_), 2.f);
  subS_ += (avg(fft, 0, 1) - subS_) * smoothK(dt, 0.4f);
  bassS_ += (avg(fft, 0, 2) - bassS_) * smoothK(dt, 0.15f); bassMax_ = fmaxf(fmaxf(bassMax_ * decay, bassS_), 2.f);
  midS_ += (avg(fft, 4, 9) - midS_) * smoothK(dt, 0.3f); midMax_ = fmaxf(fmaxf(midMax_ * decay, midS_), 2.f);
  highS_ += (avg(fft, 12, 15) - highS_) * smoothK(dt, 0.3f); highMax_ = fmaxf(fmaxf(highMax_ * decay, highS_), 2.f);
  s_.loud = clampf(eFast_ / eMax_, 0, 1); s_.bass = clampf(bassS_ / bassMax_, 0, 1); s_.mid = clampf(midS_ / midMax_, 0, 1); s_.high = clampf(highS_ / highMax_, 0, 1);

  if (lastEst_ == 0 || now - lastEst_ >= 500) { lastEst_ = now; estimateTempo(now); }

  // --- beat grid
  s_.locked = s_.bpm > 0 && phaseSet_ && now - lastOnsetMs_ < 5000;
  if (s_.bpm > 0 && phaseSet_) {
    const int32_t idx = (int32_t)floor(relBeats(now));
    if (idx > lastBeatIdx_) {
      s_.beatCount += (uint32_t)(idx - lastBeatIdx_ > 2 ? 1 : idx - lastBeatIdx_); lastBeatIdx_ = idx;
      if (s_.locked) { s_.beat = true; s_.lastBeatMs = now - (uint32_t)(beatPhaseAt(now) * 60000.f / s_.bpm); }  // the grid's beat time
    }
    s_.beatInBar = (uint8_t)(((int32_t)s_.beatCount - barOff_) & 3);
  }
  sections(now, dt);
}

void LiteAnalyser::estimateTempo(uint32_t now) {
  // the source: kicks when there are enough of them in the last 10 s, otherwise every onset (kick, snare, hat)
  uint32_t t[kOnsets]; float w[kOnsets]; int n = 0;
  const bool kicks = countSince(kickT_, kickN_, now, 10000) >= 6;
  if (kicks) {
    for (int i = 0; i < kickN_; i++) { const int j = (kickPos_ - kickN_ + i + kOnsets) % kOnsets; if (now - kickT_[j] < 10000) { t[n] = kickT_[j]; w[n] = 1; n++; } }
  } else {
    for (int i = 0; i < onN_; i++) { const int j = (onPos_ - onN_ + i + kOnsets) % kOnsets; if (now - onT_[j] < 10000) { t[n] = onT_[j]; w[n] = onW_[j]; n++; } }
  }
  if (n < 5) return;
  // histogram of inter-onset intervals (and their halves, thirds, quarters) as tempi, 60..180 BPM
  memset(hist_, 0, sizeof(hist_));
  const int first = n > 28 ? n - 28 : 0;  // the most recent 28 onsets bound the cost (~400 pairs)
  for (int i = first; i < n; i++) for (int j = i + 1; j < n; j++) {
    const float d = (t[j] - t[i]) / 1000.f; if (d < 0.28f || d > 4.f) continue;
    for (int m = 1; m <= 4; m++) {
      const float p = d / m; if (p < 0.333f || p > 1.f) continue;
      const float b = 60.f / p, wt = (w[i] + w[j]) / m, cf = (b - 60.f) * 2.f; const int c = (int)lroundf(cf);
      for (int q = c - 3; q <= c + 3; q++) { if (q < 0 || q > 240) continue;
        const float u = (q - cf) * (q - cf) / 9.f; if (u >= 1) continue; const float k = 1 - u; hist_[q] += wt * k * k * k; }
    }
  }
  float best = 0; int bi = 0;
  for (int q = 0; q <= 240; q++) { const float x = (60.f + q / 2.f - 122.f) / 45.f, v = hist_[q] * expf(-x * x); if (v > best) { best = v; bi = q; } }
  if (best <= 0) return;
  float bpm = 60.f + bi / 2.f;
  // refine: the histogram works in half-BPM steps on onsets quantised to ~23 ms frames, which biases it by a BPM or
  // so. A least-squares line through the onsets against their beat numbers (on the coarse grid) gets much closer.
  {
    const float P0 = 60000.f / bpm; double sx = 0, sy = 0, sxx = 0, sxy = 0, sw = 0; int lo = 1 << 30, hi = -(1 << 30);
    for (int i = 0; i < n; i++) {
      const float rel = (t[i] - t[0]) / P0; const int k = (int)lroundf(rel); if (fabsf(rel - k) > 0.2f) continue;  // off the grid
      const double ww = w[i]; sx += ww * k; sy += ww * (t[i] - t[0]); sxx += ww * k * k; sxy += ww * k * (double)(t[i] - t[0]); sw += ww;
      if (k < lo) lo = k;
      if (k > hi) hi = k;
    }
    const double den = sw * sxx - sx * sx;
    if (hi - lo >= 6 && den > 0) { const double P = (sw * sxy - sx * sy) / den; const float b2 = (float)(60000.0 / P); if (fabsf(b2 - bpm) < 0.04f * bpm) bpm = b2; }
  }
  // steady kicks just arrived (the drop after a drumless build-up): their tempo beats whatever the snares and hats said
  const bool switched = kicks && !usingKicks_;
  if (switched) { s_.bpm = bpm; candN_ = 0; phaseSet_ = false; }  // (and a fresh phase from the kicks, below)
  else if (!s_.bpm || fabsf(bpm - s_.bpm) < 3) { s_.bpm = s_.bpm ? s_.bpm * 0.7f + bpm * 0.3f : bpm; candN_ = 0; }
  else if (fabsf(bpm - cand_) < 3) { if (++candN_ >= 3) { s_.bpm = bpm; candN_ = 0; } }
  else { cand_ = bpm; candN_ = 1; }

  usingKicks_ = kicks;
  // phase: circular mean of the onsets' positions on the beat, recent ones weighted more
  const double P = 60000.0 / s_.bpm, ref = phaseSet_ ? anchor_ : (double)t[n - 1];
  float sx = 0, sy = 0;
  for (int i = 0; i < n; i++) {
    if (now - t[i] > 6000) continue;
    double x = ((double)t[i] - ref) / P; x -= floor(x);
    const float a = kTau * (float)x, r = w[i] * expf(-(float)(now - t[i]) / 3000.f);
    sx += cosf(a) * r; sy += sinf(a) * r;
  }
  if (sx == 0 && sy == 0) return;
  const double cand = ref + atan2f(sy, sx) / kTau * P;
  if (!phaseSet_) { anchor_ = cand; phaseSet_ = true; lastBeatIdx_ = (int32_t)floor(relBeats(now)); }
  else { double d = cand - anchor_; d -= floor(d / P + 0.5) * P; anchor_ += d * 0.35; }
  // keep the anchor near now (and the beat index with it)
  const int32_t k = (int32_t)floor(((double)now - anchor_) / P) - 1;  // (one beat of margin behind now)
  if (k > 0) { anchor_ += k * P; lastBeatIdx_ -= k; }
  // the drop was confirmed on the old (snare / hat) grid: place its downbeat again on the kicks' grid
  if (switched && s_.dropMs && now - s_.dropMs < 8000) setDownbeat(now);
}

void LiteAnalyser::setDownbeat(uint32_t now) {
  const uint32_t from = runStartMs_ && now - runStartMs_ < 10000 ? runStartMs_ : now;
  const int32_t downbeat = (int32_t)floorf(beatsAt(from) + 0.5f);
  barOff_ = downbeat - 4 * (int32_t)(s_.beatCount / 4 + 2);
}

double LiteAnalyser::relBeats(uint32_t ms) const {
  if (s_.bpm <= 0 || !phaseSet_) return 0;
  // onsets are timed when their frame arrives, about one FFT block after the sound: shift the grid back by that
  return ((double)ms - anchor_ + latencyMs_) / (60000.0 / s_.bpm);
}
float LiteAnalyser::beatsAt(uint32_t ms) const {
  if (s_.bpm <= 0 || !phaseSet_) return 0;
  return (float)((double)s_.beatCount + (relBeats(ms) - lastBeatIdx_));
}
float LiteAnalyser::beatPhaseAt(uint32_t ms) const { const double b = relBeats(ms); return (float)(b - floor(b)); }
float LiteAnalyser::barPhaseAt(uint32_t ms) const {
  if (s_.bpm <= 0 || !phaseSet_) return 0;
  const float b = beatsAt(ms) - barOff_, q = b / 4.f;
  return q - floorf(q);
}
uint32_t LiteAnalyser::barAt(uint32_t ms) const {
  const float b = beatsAt(ms) - barOff_;
  return b > 0 ? (uint32_t)(b / 4.f) : 0;
}
float LiteAnalyser::kickEnvAt(uint32_t ms) const {
  if (!s_.kicksTotal) return 0;
  const float age = (ms - s_.lastKickMs) / 1000.f; if (age > 0.6f) return 0;
  return expf(-age / 0.1f);
}

void LiteAnalyser::sections(uint32_t now, float dt) {
  const float loud = s_.loud;
  // kick windows: ~2 beats (at least 0.9 / 1.2 s like live.js), a little longer once in a drop so one missed kick
  // doesn't end it
  const float P = s_.bpm > 0 ? 60000.f / s_.bpm : 500.f; const bool inDrop = s_.section == Section::Drop;
  const bool kickRecent = s_.kicksTotal && now - s_.lastKickMs < (uint32_t)fmaxf(900.f, P * (inDrop ? 2.6f : 1.6f));
  // how much the bass outweighs the mids, against this song's usual (a drop is bass-heavy)
  const float dom = log10f(fmaxf(1.f, subS_) / fmaxf(1.f, midS_));
  domS_ = domInit_ ? domS_ + (dom - domS_) * smoothK(dt, 0.4f) : dom; domInit_ = true;
  if (now - domHistT_ >= 250 && loud > 0.06f) { domHistT_ = now; domHist_[domPos_] = domS_; domPos_ = (domPos_ + 1) % kDomHist; if (domN_ < kDomHist) domN_++; }
  if (now - domBaseT_ >= 1000 && domN_) {  // 30th percentile, once a second
    domBaseT_ = now; float tmp[kDomHist]; memcpy(tmp, domHist_, sizeof(float) * domN_);
    for (int i = 1; i < domN_; i++) { const float v = tmp[i]; int j = i - 1; while (j >= 0 && tmp[j] > v) { tmp[j + 1] = tmp[j]; j--; } tmp[j + 1] = v; }
    domBase_ = tmp[(int)(0.3f * (domN_ - 1))];
  }
  const bool bass = domN_ > 12 && domS_ - domBase_ > 0.18f;
  const float snareRate = countSince(snareT_, snareN_, now, 2000) / 2.f;
  const int kicks2 = countSince(kickT_, kickN_, now, (uint32_t)fmaxf(1200.f, P * (inDrop ? 3.2f : 2.2f)));
  Section c;
  if (loud < 0.06f || eFast_ < 1.5f) c = Section::Silent;
  else if (bass && kickRecent && loud > 0.45f && kicks2 >= 2) c = Section::Drop;
  else if ((!bass || kicks2 < 2) && ((snareRate >= 2.5f && loud > 0.4f) || (domN_ > 20 && eFast_ > eSlow_ * 1.2f && s_.high > 0.6f))) c = Section::Build;
  else c = Section::Calm;
  // vote over the recent past: drops and silence switch fast, the rest after ~0.6 s
  votes_[votePos_] = c; votePos_ = (votePos_ + 1) % kVotes; if (voteN_ < kVotes) voteN_++;
  const float need = c == Section::Drop ? 0.12f : c == Section::Silent ? 0.2f : 0.6f;
  int nWin = (int)lroundf(need / dt); if (nWin < 1) nWin = 1; if (nWin > kVotes) nWin = kVotes;
  int same = 0; for (int i = 0; i < nWin && i < voteN_; i++) if (votes_[(votePos_ - 1 - i + kVotes) % kVotes] == c) same++;
  if (c != s_.section && voteN_ >= nWin && same >= 0.7f * nWin) {
    // a drop counts after a build-up (or one that ended moments ago: the bar before a drop is often a gap), after
    // silence, or after 4 s of something else
    const bool afterBuild = s_.section == Section::Build || (buildEndMs_ && now - buildEndMs_ < 2500);
    if (c == Section::Drop && (afterBuild || s_.section == Section::Silent || now - s_.sectionSinceMs > 4000)) {
      s_.dropMs = now; s_.drops++;
      // a drop lands on a downbeat: the beat nearest to the first kick of this run of kicks becomes beat 0 of a bar
      // (the vote confirms the drop a beat or two later). barOff_ only matters mod 4; it is kept below beatCount so
      // bar numbers stay positive.
      if (s_.bpm > 0 && phaseSet_) setDownbeat(now);
    }
    if (c == Section::Build) s_.buildStartMs = now;
    if (s_.section == Section::Build) buildEndMs_ = now;
    s_.section = c; s_.sectionSinceMs = now;
  }
  if (s_.section == Section::Build) {
    const float len = s_.bpm > 0 ? 16 * 60000.f / s_.bpm : 7000.f;  // ~4 bars
    s_.buildProgress = clampf((now - s_.buildStartMs) / len, 0, 1);
  } else s_.buildProgress = 0;
  if (s_.bpm > 0 && phaseSet_) s_.beatInBar = (uint8_t)(((int32_t)s_.beatCount - barOff_) & 3);
}

bool FlashWindow::allow(uint32_t now, uint8_t max) {
  if (max > 3) max = 3;
  if (!max) return false;
  if (n > 3) n = 0;  // garbage guard
  if (n && now - t[n - 1] < 30) return true;  // same flash (another segment this frame)
  int k = 0; for (int i = 0; i < n; i++) if (now - t[i] < 1000) t[k++] = t[i];
  n = (uint8_t)k;
  if (n >= max) return false;
  t[n++] = now;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Effects

const char* fxName(Fx fx) {
  switch (fx) {
    case Fx::KickShockwave: return "TL Kick Shockwave";
    case Fx::BeatChase: return "TL Beat Chase";
    case Fx::BuildFill: return "TL Build Fill";
    case Fx::DropStrobe: return "TL Drop Strobe";
    case Fx::AuroraCalm: return "TL Aurora";
    case Fx::BassRain: return "TL Bass Rain";
    case Fx::BarPulse: return "TL Bar Pulse";
    case Fx::TempoWave: return "TL Tempo Wave";
    case Fx::Auto: return "TL Auto";
    default: return "?";
  }
}

namespace {
struct ShockMem { uint32_t lastKick; uint8_t n, hue, pad[2]; uint32_t born[6]; uint8_t ringHue[6], pad2[2]; };
struct StrobeMem { FlashWindow win; uint8_t pad[3]; uint32_t lastKick, lastDrop, flashAt; };
struct RainDrop { float pos, vel; uint8_t len, pal, live, pad; };
struct RainMem { uint32_t lastKick, lastNow; RainDrop drops[8]; uint8_t next, pad[3]; };  // then heat[len], pal[len]
struct AutoMem { uint8_t cur, init, pad[6]; };  // then the current effect's memory
constexpr size_t kAutoHdr = 8;
size_t align8(size_t n) { return (n + 7) & ~(size_t)7; }

uint8_t barHue(const LiteAnalyser& a, uint32_t now) { return (uint8_t)(a.barAt(now) * 40); }

void shockwave(const LiteAnalyser& a, uint32_t now, int len, const FxParams& p, uint8_t* mem, PixelSink& out) {
  ShockMem& m = *reinterpret_cast<ShockMem*>(mem); const LiteState& s = a.state();
  if (s.kicksTotal && s.lastKickMs != m.lastKick) {
    m.lastKick = s.lastKickMs; m.hue += 24; int k;
    if (m.n < 6) k = m.n++; else { k = 0; for (int i = 1; i < 6; i++) if (m.born[i] < m.born[k]) k = i; }  // replace the oldest
    m.born[k] = now; m.ringHue[k] = m.hue;
  }
  const float half = len / 2.f, travelMs = 900.f - p.speed * 2.6f;  // centre to end in 230-900 ms
  const float width = 1.f + p.intensity / 40.f, glow = 6 + 30 * s.loud;
  for (int i = 0; i < len; i++) {
    const float d = fabsf(i + 0.5f - half); float best = 0; uint8_t pal = (uint8_t)(m.hue + i);
    for (int r = 0; r < m.n; r++) {
      const float age = (float)(now - m.born[r]); if (age > travelMs * 1.3f) continue;
      const float rad = age / travelMs * half, x = fabsf(d - rad) / width; if (x >= 1) continue;
      const float b = (1 - x) * (1 - x) * (1.f - 0.6f * age / (travelMs * 1.3f));
      if (b > best) { best = b; pal = (uint8_t)(m.ringHue[r] + d * 2); }
    }
    out.set(i, pal, u8(glow + best * (255 - glow)));
  }
}

void beatChase(const LiteAnalyser& a, uint32_t now, int len, const FxParams& p, uint8_t* mem, PixelSink& out) {
  (void)mem; const LiteState& s = a.state();
  float head;
  if (s.bpm > 0) {
    const float bar = a.barPhaseAt(now) * 4.f, fb = floorf(bar), fr = bar - fb; const float jump = clampf(fr * 4.f, 0, 1);
    const float ease = 1 - (1 - jump) * (1 - jump);  // jump to the next quarter in the first quarter of the beat
    const int q = (int)fb & 3;
    head = (q + ease) / 4.f * len;
  } else head = fmodf(now * (0.02f + p.speed / 4000.f), (float)len);
  const float tail = 2 + len / 2.f * (p.intensity / 255.f), kick = a.kickEnvAt(now);
  for (int i = 0; i < len; i++) {
    float d = head - i; if (d < 0) d += len;  // behind the head, wrapping
    const float b = d < tail ? (1 - d / tail) : 0;
    out.set(i, (uint8_t)(s.beatCount * 64 + i * 2), u8(10 + b * b * (200 + 45 * kick)));
  }
}

void buildFill(const LiteAnalyser& a, uint32_t now, int len, const FxParams& p, uint8_t* mem, PixelSink& out) {
  (void)mem; (void)p; const LiteState& s = a.state();
  const float sinceDrop = s.dropMs ? (now - s.dropMs) / 1000.f : 99;
  if (s.section == Section::Build) {
    const float prog = s.buildProgress, fill = (0.08f + 0.92f * prog) * len / 2.f;
    const float rate = powf(2.f, 1.f + 3.f * prog);  // flicker 2 -> 16 times a beat
    const float ph = s.bpm > 0 ? a.beatPhaseAt(now) * rate : now / 1000.f * rate * 2.f;
    const bool on = ph - floorf(ph) < 0.5f;
    for (int i = 0; i < len; i++) {
      const float edge = i < len / 2 ? i + 0.5f : len - i - 0.5f;
      const float b = edge < fill ? (on ? 255.f : 120.f + 100.f * prog) : 6.f;
      out.set(i, (uint8_t)(edge * 255 / (len / 2.f) * 0.5f + prog * 128), u8(b));
    }
  } else if (sinceDrop < 1.5f) {
    const float b = 255 * (1 - sinceDrop / 1.5f);
    for (int i = 0; i < len; i++) out.set(i, (uint8_t)(i * 255 / len), u8(b));
  } else {
    const float ph = s.bpm > 0 ? a.beatPhaseAt(now) : 0.5f, b = 20 + 70 * (1 - ph) * (1 - ph) * s.loud;
    for (int i = 0; i < len; i++) out.set(i, (uint8_t)(i * 255 / len), u8(b));
  }
}

void dropStrobe(const LiteAnalyser& a, uint32_t now, int len, const FxParams& p, uint8_t* mem, PixelSink& out) {
  StrobeMem& m = *reinterpret_cast<StrobeMem*>(mem); const LiteState& s = a.state();
  bool trigger = false;
  if (s.dropMs && s.dropMs != m.lastDrop) { m.lastDrop = s.dropMs; trigger = true; }
  if (s.kicksTotal && s.lastKickMs != m.lastKick) { m.lastKick = s.lastKickMs; if (s.section == Section::Drop) trigger = true; }
  if (trigger && p.strobe) {
    FlashWindow& w = p.shared ? *p.shared : m.win;
    if (w.allow(now, p.maxFlashes)) m.flashAt = now;
  }
  const bool flash = m.flashAt && now - m.flashAt < 50;
  const float ph = s.bpm > 0 ? a.beatPhaseAt(now) : 0.5f, pulse = (1 - ph) * (1 - ph) * (1 - ph);
  const float b = s.section == Section::Drop ? 30 + 225 * pulse * (0.4f + 0.6f * s.loud) : 10 + 60 * a.kickEnvAt(now);
  for (int i = 0; i < len; i++) { if (flash) out.white(i, 255); else out.set(i, (uint8_t)(barHue(a, now) + i * 3), u8(b)); }
}

void aurora(const LiteAnalyser& a, uint32_t now, int len, const FxParams& p, uint8_t* mem, PixelSink& out) {
  (void)mem; const LiteState& s = a.state();
  const float t = now / 1000.f * (0.1f + p.speed / 255.f * 0.6f), kick = 0.15f * a.kickEnvAt(now);
  const float base = 25 + 150 * s.loud * (0.5f + p.intensity / 510.f);
  for (int i = 0; i < len; i++) {
    const float x = (float)i / (len > 1 ? len - 1 : 1);
    const float v = sinf(x * 7.1f + t * 1.3f) + sinf(x * 3.3f - t * 0.9f) * 0.8f + sinf(x * 12.7f + t * 0.4f) * 0.3f;
    const float n = (v + 2.1f) / 4.2f;  // ~0..1
    out.set(i, (uint8_t)(x * 96 + n * 64 + t * 12), u8(base * (0.2f + 0.8f * n * n) * (1 + kick)));
  }
}

void bassRain(const LiteAnalyser& a, uint32_t now, int len, const FxParams& p, uint8_t* mem, PixelSink& out) {
  RainMem& m = *reinterpret_cast<RainMem*>(mem); const LiteState& s = a.state();
  uint8_t* heat = mem + align8(sizeof(RainMem)); uint8_t* pal = heat + len;
  const float dt = m.lastNow ? clampf((now - m.lastNow) / 1000.f, 0, 0.1f) : 0; m.lastNow = now;
  if (s.kicksTotal && s.lastKickMs != m.lastKick) {
    m.lastKick = s.lastKickMs; RainDrop& d = m.drops[m.next]; m.next = (m.next + 1) % 8;
    const float beatS = s.bpm > 0 ? 60.f / s.bpm : 0.5f;
    d.pos = (float)(len - 1); d.vel = len / (beatS * (3.5f - p.speed / 100.f)); d.len = (uint8_t)clampf(2 + s.bass * len / 12.f, 2, 40);
    d.pal = (uint8_t)(s.kicksTotal * 37); d.live = 1;
  }
  const uint8_t fade = (uint8_t)clampf(dt * (300 + p.intensity * 2), 0, 255);
  for (int i = 0; i < len; i++) heat[i] = heat[i] > fade ? heat[i] - fade : 0;
  for (auto& d : m.drops) {
    if (!d.live) continue;
    d.pos -= d.vel * dt; d.vel *= 1 + dt * 0.8f;  // a little gravity
    if (d.pos + d.len < 0) { d.live = 0; continue; }
    for (int k = 0; k < d.len; k++) { const int i = (int)d.pos + k; if (i < 0 || i >= len) continue;
      const uint8_t h = (uint8_t)(255 - k * 200 / d.len); if (h > heat[i]) { heat[i] = h; pal[i] = d.pal; } }
  }
  for (int i = 0; i < len; i++) out.set(i, pal[i], heat[i] < 3 ? 3 : heat[i]);
}

void barPulse(const LiteAnalyser& a, uint32_t now, int len, const FxParams& p, uint8_t* mem, PixelSink& out) {
  (void)mem; const LiteState& s = a.state();
  const float level = fmaxf(s.bass * (0.5f + p.intensity / 510.f), a.kickEnvAt(now) * 0.9f), half = len / 2.f, w = level * half;
  const uint8_t hue = barHue(a, now);
  for (int i = 0; i < len; i++) {
    const float d = fabsf(i + 0.5f - half);
    const float b = d < w ? 255 * (1 - 0.5f * d / (w + 1e-3f)) : 6;
    out.set(i, (uint8_t)(hue + d * 3), u8(b));
  }
}

void tempoWave(const LiteAnalyser& a, uint32_t now, int len, const FxParams& p, uint8_t* mem, PixelSink& out) {
  (void)mem; const LiteState& s = a.state();
  const float bp = s.bpm > 0 ? a.barPhaseAt(now) : fmodf(now / 2000.f, 1.f), waves = 1 + p.intensity / 64;
  const float lift = 0.35f + 0.65f * fmaxf(a.kickEnvAt(now), s.loud * 0.7f); const uint8_t hue = barHue(a, now);
  for (int i = 0; i < len; i++) {
    const float x = (float)i / len, v = 0.5f + 0.5f * cosf(kTau * (x * waves - bp));
    out.set(i, (uint8_t)(hue + x * 128), u8(10 + 245 * v * v * lift));
  }
}

size_t fxMemoryOne(Fx fx, int len) {
  switch (fx) {
    case Fx::KickShockwave: return sizeof(ShockMem);
    case Fx::DropStrobe: return sizeof(StrobeMem);
    case Fx::BassRain: return align8(sizeof(RainMem)) + 2 * (size_t)len;
    default: return 8;
  }
}
}  // namespace

size_t fxMemory(Fx fx, int len) {
  if (fx != Fx::Auto) return align8(fxMemoryOne(fx, len));
  size_t m = 0; for (int i = 0; i < kFxCount; i++) if ((Fx)i != Fx::Auto) { const size_t k = fxMemoryOne((Fx)i, len); if (k > m) m = k; }
  return kAutoHdr + align8(m);
}

Fx autoChoice(const LiteState& s, uint32_t barIndex) {
  switch (s.section) {
    case Section::Build: return Fx::BuildFill;
    case Section::Drop: {
      const float barMs = s.bpm > 0 ? 4 * 60000.f / s.bpm : 2000.f;
      const uint32_t since = s.dropMs ? (uint32_t)((s.nowMs - s.dropMs) / barMs) : barIndex;  // bars into the drop
      if (s.dropMs && since < 8) return Fx::DropStrobe;  // the first 8 bars of a drop
      static const Fx pool[] = {Fx::KickShockwave, Fx::BassRain, Fx::BeatChase, Fx::BarPulse};
      return pool[(since / 8 + 3) % 4];  // then a new look every 8 bars, Kick Shockwave first
    }
    case Section::Calm: return s.locked && (barIndex / 8) % 2 ? Fx::TempoWave : Fx::AuroraCalm;
    default: return Fx::AuroraCalm;
  }
}

void renderFx(Fx fx, const LiteAnalyser& a, uint32_t now, int len, const FxParams& p, uint8_t* mem, PixelSink& out) {
  if (len <= 0) return;
  switch (fx) {
    case Fx::KickShockwave: shockwave(a, now, len, p, mem, out); break;
    case Fx::BeatChase: beatChase(a, now, len, p, mem, out); break;
    case Fx::BuildFill: buildFill(a, now, len, p, mem, out); break;
    case Fx::DropStrobe: dropStrobe(a, now, len, p, mem, out); break;
    case Fx::AuroraCalm: aurora(a, now, len, p, mem, out); break;
    case Fx::BassRain: bassRain(a, now, len, p, mem, out); break;
    case Fx::BarPulse: barPulse(a, now, len, p, mem, out); break;
    case Fx::TempoWave: tempoWave(a, now, len, p, mem, out); break;
    case Fx::Auto: {
      AutoMem& h = *reinterpret_cast<AutoMem*>(mem);
      const Fx want = autoChoice(a.state(), a.barAt(now));
      if (!h.init || h.cur != (uint8_t)want) { h.init = 1; h.cur = (uint8_t)want; memset(mem + kAutoHdr, 0, fxMemory(Fx::Auto, len) - kAutoHdr); }
      renderFx(want, a, now, len, p, mem + kAutoHdr, out);
      break;
    }
    default: break;
  }
}

}  // namespace tempolight
