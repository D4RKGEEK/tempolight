// Tempolight Lite: Tempolight-style music reactivity on a WLED controller with a microphone, no computer needed.
//
// Needs the AudioReactive usermod (the microphone, its FFT and AGC): this usermod reads AudioReactive's GEQ channels
// and smoothed volume through getUMData(), runs Tempolight's live analysis on them (kicks, tempo and beat grid, song
// part: calm / build-up / drop; firmware/core/tempolight_lite.cpp) and adds Tempolight effects ("TL ...") that use it,
// including "TL Auto", which picks one by song part.
//
// JSON API (/json/state and /json/info): "tempolight": {...}; send {"tempolight":{"on":false}} to switch the
// analysis off, {"tempolight":{"auto":true}} to put the selected segments on TL Auto.
//
// Written for WLED 16 (library usermods: add `tempolight` to custom_usermods next to `audioreactive`).
#pragma once

#include "wled.h"
#include "tempolight_lite.h"

#include <math.h>

#ifndef USERMOD_ID_TEMPOLIGHT
#define USERMOD_ID_TEMPOLIGHT 199  // not in WLED's const.h; only used by getUMData() lookups
#endif
#define TEMPOLIGHT_LITE_VERSION "0.1.0"


// Effect metadata (https://kno.wled.ge/interfaces/json-api/#effect-metadata): sliders, colours, palette, flags
// ("1" = 1D, "f" = frequency reactive: listed with the other audio effects), defaults.
static const char _data_TL_SHOCKWAVE[] PROGMEM = "TL Kick Shockwave@Speed,Ring width;;!;1f;sx=150,ix=96";
static const char _data_TL_CHASE[] PROGMEM = "TL Beat Chase@Speed (no tempo),Tail;;!;1f;ix=128";
static const char _data_TL_BUILD[] PROGMEM = "TL Build Fill;;!;1f";
static const char _data_TL_STROBE[] PROGMEM = "TL Drop Strobe@,,,,,No flashes;;!;1f;o1=0";
static const char _data_TL_AURORA[] PROGMEM = "TL Aurora@Drift,Brightness;;!;1f;sx=60,ix=128";
static const char _data_TL_RAIN[] PROGMEM = "TL Bass Rain@Fall speed,Fade;;!;1f;sx=128,ix=128";
static const char _data_TL_PULSE[] PROGMEM = "TL Bar Pulse@,Bass gain;;!;1f;ix=128";
static const char _data_TL_WAVE[] PROGMEM = "TL Tempo Wave@,Waves;;!;1f;ix=64";
static const char _data_TL_AUTO[] PROGMEM = "TL Auto@Speed,Intensity,,,,No flashes;;!;1f;sx=128,ix=128,o1=0";

class TempolightLiteUsermod : public Usermod {
 public:
  // --- used by the effect functions
  static TempolightLiteUsermod* instance;  // the one instance (set in setup())
  bool active() const { return enabled_ && audio_; }
  const tempolight::LiteAnalyser& analyser() const { return enabled_ && audio_ ? lite_ : idle_; }
  bool strobe() const { return strobe_; }
  uint8_t maxFlashes() const { return maxFlashes_; }
  tempolight::FlashWindow* flashWindow() { return &flashes_; }

  TempolightLiteUsermod() { memset(fxId_, 255, sizeof(fxId_)); }

  void setup() override {
    instance = this;
    lite_.setSensitivity(sensitivity_); lite_.setScaling(fftScale_); lite_.setLatencyMs(latency_);
    registerEffects();
    initDone_ = true;
  }

  void loop() override {
    if (!enabled_) return;
    const uint32_t now = millis();
    if (now - lastPoll_ < 5) return;  // AudioReactive makes a new frame every ~21-23 ms
    lastPoll_ = now;
    um_data_t* um = nullptr;
    if (!UsermodManager::getUMData(&um, USERMOD_ID_AUDIOREACTIVE) || !um || um->u_size < 3) {
      if (audio_) { audio_ = false; lite_.reset(); }
      return;
    }
    audio_ = true;
    const uint8_t* fft = static_cast<const uint8_t*>(um->u_data[2]);
    const float volume = *static_cast<const float*>(um->u_data[0]);
    // a new GEQ frame (they change every frame unless it is quiet), or at the latest every 2 frame times
    if (memcmp(fft, last_, sizeof(last_)) != 0 || now - lastFrame_ >= 46) {
      memcpy(last_, fft, sizeof(last_)); lastFrame_ = now;
      lite_.update(last_, volume, now);
    }
  }

  // --- JSON API
  void addToJsonInfo(JsonObject& root) override {
    JsonObject user = root["u"];
    if (user.isNull()) user = root.createNestedObject("u");
    JsonArray arr = user.createNestedArray(FPSTR(_name));
    String btn = F("<button class=\"btn btn-xs\" onclick=\"requestJson({tempolight:{on:");
    btn += enabled_ ? F("false") : F("true");
    btn += F("}});\"><i class=\"icons"); btn += enabled_ ? F(" on") : F(" off"); btn += F("\">&#xe08f;</i></button>");
    arr.add(btn);
    const tempolight::LiteState& s = lite_.state();
    if (!enabled_) arr.add(F(" off"));
    else if (!audio_) arr.add(F(" no audio (enable AudioReactive)"));
    else {
      char buf[40];
      if (s.bpm > 0) snprintf(buf, sizeof(buf), " %d BPM, %s", (int)lroundf(s.bpm), tempolight::sectionName(s.section));
      else snprintf(buf, sizeof(buf), " listening, %s", tempolight::sectionName(s.section));
      arr.add(buf);
    }
    // machine-readable, for the Tempolight app to list this controller as a Lite device
    JsonObject tl = root.createNestedObject(F("tempolight"));
    tl[F("lite")] = TEMPOLIGHT_LITE_VERSION;
    tl[F("on")] = enabled_;
    tl[F("audio")] = audio_;
    JsonObject ids = tl.createNestedObject(F("fx"));
    for (int i = 0; i < tempolight::kFxCount; i++) if (fxId_[i] != 255) ids[fxKey(i)] = fxId_[i];
  }

  void addToJsonState(JsonObject& root) override {
    if (!initDone_) return;
    JsonObject tl = root[FPSTR(_name)];
    if (tl.isNull()) tl = root.createNestedObject(FPSTR(_name));
    tl[F("on")] = enabled_;
    const tempolight::LiteState& s = lite_.state();
    if (active()) {
      tl[F("bpm")] = roundf(s.bpm * 10) / 10;
      tl[F("locked")] = s.locked;
      tl[F("section")] = tempolight::sectionName(s.section);
      tl[F("beat")] = s.beatInBar;
      tl[F("drops")] = s.drops;
      tl[F("build")] = roundf(s.buildProgress * 100) / 100;
    }
  }

  void readFromJsonState(JsonObject& root) override {
    if (!initDone_) return;
    JsonObject tl = root[FPSTR(_name)];
    if (tl.isNull()) return;
    if (tl[F("on")].is<bool>()) setEnabled(tl[F("on")].as<bool>());
    else if (tl[F("on")].is<const char*>() && tl[F("on")].as<const char*>()[0] == 't') setEnabled(!enabled_);  // "t" toggles
    if (tl[F("auto")].is<bool>() && tl[F("auto")].as<bool>()) {  // put the selected segments (or the main one) on TL Auto
      const uint8_t id = fxId_[(int)tempolight::Fx::Auto];
      if (id != 255) {
        bool any = false;
        for (unsigned i = 0; i < strip.getSegmentsNum(); i++) { Segment& seg = strip.getSegment(i); if (seg.isActive() && seg.isSelected()) { seg.setMode(id, true); any = true; } }
        if (!any) strip.getMainSegment().setMode(id, true);
      }
    }
  }

  // --- settings (cfg.json / Usermods settings page)
  void addToConfig(JsonObject& root) override {
    JsonObject top = root.createNestedObject(FPSTR(_name));
    top[F("enabled")] = enabled_;
    top[F("sensitivity")] = sensitivity_;
    top[F("fftScale")] = fftScale_;
    top[F("latencyMs")] = latency_;
    top[F("strobe")] = strobe_;
    top[F("maxFlashes")] = maxFlashes_;
  }

  bool readFromConfig(JsonObject& root) override {
    JsonObject top = root[FPSTR(_name)];
    bool complete = !top.isNull();
    complete &= getJsonValue(top[F("enabled")], enabled_, true);
    complete &= getJsonValue(top[F("sensitivity")], sensitivity_, (uint8_t)128);
    complete &= getJsonValue(top[F("fftScale")], fftScale_, (uint8_t)3);
    complete &= getJsonValue(top[F("latencyMs")], latency_, (uint8_t)20);
    complete &= getJsonValue(top[F("strobe")], strobe_, true);
    complete &= getJsonValue(top[F("maxFlashes")], maxFlashes_, (uint8_t)3);
    if (maxFlashes_ > 3) maxFlashes_ = 3;  // photosensitivity limit, not configurable upwards
    if (fftScale_ > 3) fftScale_ = 3;
    lite_.setSensitivity(sensitivity_); lite_.setScaling(fftScale_); lite_.setLatencyMs(latency_);
    return complete;
  }

  void appendConfigData(Print& ui) override {
    ui.print(F("addInfo('tempolight:sensitivity',1,'0-255, higher finds quieter kicks');"));
    ui.print(F("dd=addDropdown('tempolight','fftScale');"));
    ui.print(F("addOption(dd,'None',0);addOption(dd,'Logarithmic',1);addOption(dd,'Linear',2);addOption(dd,'Square root (default)',3);"));
    ui.print(F("addInfo('tempolight:fftScale',1,'must match AudioReactive FFT scaling');"));
    ui.print(F("addInfo('tempolight:latencyMs',1,'ms the beat grid is moved earlier');"));
    ui.print(F("addInfo('tempolight:maxFlashes',1,'per second, at most 3 (photosensitivity)');"));
  }

  uint16_t getId() override { return USERMOD_ID_TEMPOLIGHT; }

 private:
  static const char _name[];

  void setEnabled(bool on) {
    if (on == enabled_) return;
    enabled_ = on; lite_.reset(); flashes_ = tempolight::FlashWindow{};
  }

  static const char* fxKey(int i) {
    static const char* const keys[] = {"shockwave", "chase", "build", "strobe", "aurora", "rain", "pulse", "wave", "auto"};
    return keys[i];
  }

  void registerEffects();

  bool enabled_ = true, audio_ = false, strobe_ = true, initDone_ = false;
  uint8_t sensitivity_ = 128, fftScale_ = 3, latency_ = 20, maxFlashes_ = 3;
  uint8_t fxId_[tempolight::kFxCount];
  uint8_t last_[tempolight::kBands] = {0};
  uint32_t lastPoll_ = 0, lastFrame_ = 0;
  tempolight::LiteAnalyser lite_, idle_;  // idle_ never gets frames: effects show their quiet look when Lite is off
  tempolight::FlashWindow flashes_{};     // one flash budget for every segment
};

// --- effect functions: one per Tempolight effect, drawing through the segment's palette

namespace tl_wled {
struct SegmentSink : tempolight::PixelSink {
  void set(int i, uint8_t pal, uint8_t bri) override { SEGMENT.setPixelColor(i, SEGMENT.color_from_palette(pal, false, true, 0, bri)); }
  void white(int i, uint8_t bri) override { SEGMENT.setPixelColor(i, RGBW32(bri, bri, bri, 0)); }
};

template <tempolight::Fx FX>
void mode() {
  TempolightLiteUsermod* um = TempolightLiteUsermod::instance;
  const int len = SEGLEN;
  const size_t need = tempolight::fxMemory(FX, len);
  if (!um || len < 1 || !SEGENV.allocateData(need)) { SEGMENT.fill(SEGCOLOR(0)); return; }
  if (SEGENV.call == 0) memset(SEGENV.data, 0, need);
  tempolight::FxParams p;
  p.speed = SEGMENT.speed; p.intensity = SEGMENT.intensity; p.custom1 = SEGMENT.custom1;
  p.strobe = um->strobe() && !SEGMENT.check1;  // "No flashes" checkbox
  p.maxFlashes = um->maxFlashes(); p.shared = um->flashWindow();
  SegmentSink sink;
  tempolight::renderFx(FX, um->analyser(), millis(), len, p, SEGENV.data, sink);
}
}  // namespace tl_wled

inline void TempolightLiteUsermod::registerEffects() {
  using tempolight::Fx;
  fxId_[(int)Fx::KickShockwave] = strip.addEffect(255, &tl_wled::mode<Fx::KickShockwave>, _data_TL_SHOCKWAVE);
  fxId_[(int)Fx::BeatChase] = strip.addEffect(255, &tl_wled::mode<Fx::BeatChase>, _data_TL_CHASE);
  fxId_[(int)Fx::BuildFill] = strip.addEffect(255, &tl_wled::mode<Fx::BuildFill>, _data_TL_BUILD);
  fxId_[(int)Fx::DropStrobe] = strip.addEffect(255, &tl_wled::mode<Fx::DropStrobe>, _data_TL_STROBE);
  fxId_[(int)Fx::AuroraCalm] = strip.addEffect(255, &tl_wled::mode<Fx::AuroraCalm>, _data_TL_AURORA);
  fxId_[(int)Fx::BassRain] = strip.addEffect(255, &tl_wled::mode<Fx::BassRain>, _data_TL_RAIN);
  fxId_[(int)Fx::BarPulse] = strip.addEffect(255, &tl_wled::mode<Fx::BarPulse>, _data_TL_PULSE);
  fxId_[(int)Fx::TempoWave] = strip.addEffect(255, &tl_wled::mode<Fx::TempoWave>, _data_TL_WAVE);
  fxId_[(int)Fx::Auto] = strip.addEffect(255, &tl_wled::mode<Fx::Auto>, _data_TL_AUTO);
}
