// Tempolight Lite: a compact port of Tempolight's live listening (packages/engine/src/live.js) for an ESP32 running
// WLED. It does not touch audio itself: it reads the 16 GEQ channels and the smoothed volume that WLED's
// AudioReactive usermod already computes (about 43 frames a second at 22,050 Hz) and turns them into
//   - kick and snare onsets,
//   - a tempo estimate and a beat grid (phase, beat in bar),
//   - the song part: silent, calm, build-up or drop.
// It also holds the Tempolight Lite effects, drawn into a PixelSink so the same code runs inside WLED and in the host
// test (firmware/test). Plain C++17, no Arduino or WLED headers, no heap allocation after construction.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace tempolight {

constexpr int kBands = 16;  // WLED AudioReactive GEQ channels (fftResult)

enum class Section : uint8_t { Silent = 0, Calm = 1, Build = 2, Drop = 3 };
const char* sectionName(Section s);

/// What the analyser knows about the music after the last frame. Times are in milliseconds (the caller's clock).
struct LiteState {
  float bpm = 0;              // 0 until there is a tempo
  bool locked = false;        // tempo and phase are usable
  uint32_t beatCount = 0;     // beats since start (counts up once per beat while locked)
  uint8_t beatInBar = 0;      // 0..3, beat 0 = the drop's downbeat once a drop was heard
  bool beat = false;          // a beat happened in the last frame
  bool kick = false;          // a kick was detected in the last frame
  bool snare = false;         // a snare / clap was detected in the last frame
  uint32_t lastKickMs = 0, lastSnareMs = 0;
  uint32_t lastBeatMs = 0;    // when the last beat fell on the grid (not when the frame noticed it)
  uint32_t kicksTotal = 0, snaresTotal = 0;
  float loud = 0;             // 0..1, loudness against the recent maximum
  float bass = 0, mid = 0, high = 0;  // 0..1, band levels against their recent maximum
  Section section = Section::Silent;
  uint32_t sectionSinceMs = 0;
  uint32_t buildStartMs = 0;
  float buildProgress = 0;    // 0..1 while in a build-up (reaches 1 after about 4 bars)
  uint32_t dropMs = 0;        // when the last drop started (0 = none yet)
  uint32_t drops = 0;         // number of drops heard
  uint32_t nowMs = 0;         // time of the last frame
};

/// Live analysis on WLED GEQ frames. Call update() once per new AudioReactive frame (20-25 ms apart).
class LiteAnalyser {
 public:
  LiteAnalyser() { reset(); }
  void reset();
  /// fft: WLED fftResult[16] (0..255). volume: WLED volumeSmth (0..255). nowMs: a millisecond clock.
  void update(const uint8_t fft[kBands], float volume, uint32_t nowMs);
  const LiteState& state() const { return s_; }

  /// Position inside the current beat at time ms (0..1), extrapolated from the grid so effects stay smooth at the
  /// LED frame rate. 0 when there is no tempo.
  float beatPhaseAt(uint32_t ms) const;
  /// Beats counted since the start at time ms, as a float (the integer part follows state().beatCount). 0 without tempo.
  float beatsAt(uint32_t ms) const;
  /// Position inside the bar (0..1), beat 0 of the bar at 0.
  float barPhaseAt(uint32_t ms) const;
  /// Bar number at time ms (bars start on the drop's downbeat once a drop was heard).
  uint32_t barAt(uint32_t ms) const;
  /// 1 at a kick, decaying to 0 over about 300 ms.
  float kickEnvAt(uint32_t ms) const;
  /// Sensitivity 0..255 (128 = default): lowers or raises the onset thresholds.
  void setSensitivity(uint8_t s) { sens_ = s; }
  /// AudioReactive's "FFT scaling" setting (0 none, 1 logarithmic, 2 linear, 3 square root = WLED's default), so the
  /// analyser can undo it when it compares bands.
  void setScaling(uint8_t mode) { scaling_ = mode > 3 ? 3 : mode; }
  /// How late a frame arrives after the sound in it (AudioReactive: a 512-sample block at 22,050 Hz is 23 ms, so ~20).
  /// The beat grid is shifted back by this much. Add the LED/Wi-Fi delay here to land lights earlier still.
  void setLatencyMs(float ms) { latencyMs_ = ms < 0 ? 0 : ms > 200 ? 200 : ms; }

 private:
  struct Ring {  // fixed ring of floats with running mean / sd
    static constexpr int N = 48;
    float v[N];
    int n, pos;
    void clear() { n = 0; pos = 0; }
    void push(float x) { v[pos] = x; pos = (pos + 1) % N; if (n < N) n++; }
    void stats(float& mean, float& sd) const;
  };
  static constexpr int kOnsets = 40;   // onset times kept for the tempo estimate (about 10 s of kicks at 128 BPM)
  static constexpr int kVotes = 48;    // section candidates kept for the vote (about 1.1 s)
  static constexpr int kDomHist = 120; // bass-dominance history at 4 Hz (30 s)

  bool detect(Ring& h, float val, uint32_t now, uint32_t& last, uint32_t refrMs, float k, float floor);
  void estimateTempo(uint32_t now);
  void sections(uint32_t now, float dt);
  double relBeats(uint32_t ms) const;  // beats since anchor_
  void setDownbeat(uint32_t now);      // the first kick of the current run of kicks starts a bar
  int countSince(const uint32_t* arr, int n, uint32_t now, uint32_t windowMs) const;

  LiteState s_;
  uint8_t sens_ = 128, scaling_ = 3;
  float prevLin_[kBands];
  bool hasPrev_ = false;
  uint8_t prev_[kBands];
  uint32_t lastMs_ = 0;
  Ring kickH_, snareH_, hatH_;
  float lowHist_[6];
  int lowN_ = 0, lowPos_ = 0;
  uint32_t lastK_ = 0, lastS_ = 0, lastH_ = 0;
  // onsets for the tempo: times and weights (kick 1, snare 0.5, hat 0.3)
  uint32_t onT_[kOnsets];
  float onW_[kOnsets];
  int onN_ = 0, onPos_ = 0;
  uint32_t kickT_[kOnsets];
  int kickN_ = 0, kickPos_ = 0;
  uint32_t snareT_[16];
  int snareN_ = 0, snarePos_ = 0;
  uint32_t lastEst_ = 0;
  // tempo
  float cand_ = 0;
  int candN_ = 0;
  double anchor_ = 0;      // a time (ms) where a beat falls, kept close to now
  float hist_[241];        // tempo histogram, 60..180 BPM in half-BPM steps
  uint32_t lastOnsetMs_ = 0;
  bool phaseSet_ = false;
  int32_t lastBeatIdx_ = 0;
  int32_t barOff_ = 0;
  // loudness and bands
  float eFast_ = 0, eSlow_ = 0, eMax_ = 1;
  float subS_ = 0, lowPeak_ = 0, kickStrength_ = 0;
  float bassS_ = 0, bassMax_ = 1, midS_ = 0, midMax_ = 1, highS_ = 0, highMax_ = 1;
  // sections
  float domS_ = 0;
  bool domInit_ = false;
  float domHist_[kDomHist];
  int domN_ = 0, domPos_ = 0;
  uint32_t domHistT_ = 0;
  float domBase_ = 0;
  uint32_t domBaseT_ = 0;
  Section votes_[kVotes];
  int voteN_ = 0, votePos_ = 0;
  uint32_t buildEndMs_ = 0, runStartMs_ = 0;
  float latencyMs_ = 20;
  bool usingKicks_ = false;
};

/// Photosensitivity guard: at most max flashes (3 at most, as in Tempolight's director) in any one-second window.
/// Plain data, safe to keep in zeroed effect memory. Calls within 30 ms of the last allowed flash count as the same
/// flash, so several segments sharing one window flash together instead of taking turns.
struct FlashWindow {
  uint32_t t[3];
  uint8_t n;
  bool allow(uint32_t nowMs, uint8_t max = 3);
};

// ---------------------------------------------------------------------------------------------------------------
// Effects

enum class Fx : uint8_t {
  KickShockwave = 0,  // rings fly out from the centre on every kick
  BeatChase,          // a comet that lands on the next quarter of the strip on every beat
  BuildFill,          // build-ups fill the strip from both ends towards the centre, faster flicker as it rises
  DropStrobe,         // white flashes on drops and kicks in a drop (photosensitive-safe: max 3 a second)
  AuroraCalm,         // slow drifting colour waves that breathe with the loudness
  BassRain,           // drops fall along the strip on kicks, their length set by the bass
  BarPulse,           // a VU bar from the centre with the bass, colour stepping every bar
  TempoWave,          // a colour wave that moves one strip length per bar, brightened by kicks
  Auto,               // picks one of the above from the song part
  Count
};
constexpr int kFxCount = static_cast<int>(Fx::Count);
const char* fxName(Fx fx);

/// Where effects draw. pal: palette index 0..255 (the WLED segment's palette), bri: 0..255.
struct PixelSink {
  virtual ~PixelSink() {}
  virtual void set(int i, uint8_t pal, uint8_t bri) = 0;
  virtual void white(int i, uint8_t bri) = 0;  // a flash (white mixed in at bri)
};

struct FxParams {
  uint8_t speed = 128, intensity = 128, custom1 = 128;
  bool strobe = true;     // allow white flashes at all
  uint8_t maxFlashes = 3; // per second, clamped to 3
  FlashWindow* shared = nullptr;  // optional: one window for every segment (the usermod passes one)
};

/// Bytes of per-segment memory an effect needs for a strip of len LEDs (WLED: SEGENV.allocateData).
size_t fxMemory(Fx fx, int len);
/// Draws one frame of fx into out. mem must hold fxMemory(fx, len) bytes and be zeroed when the effect starts.
void renderFx(Fx fx, const LiteAnalyser& a, uint32_t nowMs, int len, const FxParams& p, uint8_t* mem, PixelSink& out);
/// The effect Auto shows for the current state (changes on song-part changes and every 8 bars in a drop).
Fx autoChoice(const LiteState& s, uint32_t barIndex);

}  // namespace tempolight
