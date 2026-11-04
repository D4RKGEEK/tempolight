// Smoke test of the usermod itself against the WLED stub (wled_stub/wled.h): registration, the loop reading fake
// AudioReactive data, effects drawing through a segment, and the JSON state / info / config. See run.sh.
#include "wled.h"
#include "../../wled-usermod-tempolight/usermod_tempolight.h"
#include "../synth.h"

WS2812FX strip;
static uint32_t g_ms = 1000;
uint32_t millis() { return g_ms; }

static uint8_t arFft[16];
static float arVolume = 0;
static bool arEnabled = true;
static um_data_t arData;
bool UsermodManager::getUMData(um_data_t** um, uint8_t id) {
  if (id != USERMOD_ID_AUDIOREACTIVE || !arEnabled) return false;
  static void* ptrs[8]; static um_types_t types[8];
  ptrs[0] = &arVolume; types[0] = UMT_FLOAT; ptrs[1] = nullptr; ptrs[2] = arFft; types[2] = UMT_BYTE_ARR;
  arData.u_size = 8; arData.u_data = ptrs; arData.u_type = types; *um = &arData; return true;
}
static int flashes = 0;
void Segment::setPixelColor(int n, uint32_t c) const {
  if (n < 0 || n >= (int)px.size()) { fprintf(stderr, "pixel %d out of range\n", n); abort(); }
  const_cast<Segment*>(this)->px[n] = c;
}
uint32_t Segment::color_from_palette(uint16_t i, bool, bool, uint8_t, uint8_t pbri) const { return RGBW32(pbri, (i * pbri) >> 8, 0, 0); }
void Segment::fill(uint32_t c) const { for (size_t i = 0; i < px.size(); i++) setPixelColor((int)i, c); }
unsigned Segment::vLength() { return (unsigned)strip._currentSegment->px.size(); }

static int failures = 0;
#define CHECK(c, ...) do { if (!(c)) { failures++; printf("  FAIL %d: ", __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

int main() {
  CHECK(usermodList().size() == 1, "registered usermods: %zu", usermodList().size());
  Usermod* um = usermodList()[0];
  { DynamicJsonDocument cfg(1024); deserializeJson(cfg, R"({"tempolight":{"enabled":true,"sensitivity":128,"fftScale":3,"latencyMs":20,"strobe":true,"maxFlashes":9}})");
    JsonObject o = cfg.as<JsonObject>(); CHECK(um->readFromConfig(o), "config incomplete");
    DynamicJsonDocument out(1024); JsonObject r = out.to<JsonObject>(); um->addToConfig(r);
    CHECK(out["tempolight"]["maxFlashes"] == 3, "maxFlashes not clamped to 3"); }
  um->setup();
  CHECK(strip.modes.size() == 9, "effects registered: %zu", strip.modes.size());
  Print ui; um->appendConfigData(ui); CHECK(ui.out.find("fftScale") != std::string::npos, "config page script");

  synth::Song song = synth::edm(128); synth::Geq geq; auto frames = geq.run(song.x, song.sr);
  Segment& seg = strip._segments[0]; strip._currentSegment = &seg;
  { DynamicJsonDocument d(512); deserializeJson(d, R"({"tempolight":{"auto":true}})"); JsonObject o = d.as<JsonObject>(); um->readFromJsonState(o); }
  const mode_ptr autoFx = strip.modes[seg.mode - 186];
  CHECK(seg.mode == 186 + 8, "auto selected mode %u", seg.mode);
  size_t fi = 0; std::string sectionInDrop, sectionInIntro; bool wasFlash = false;
  for (g_ms = 1000; fi < frames.size(); g_ms += 5) {
    if (fi < frames.size() && frames[fi].t * 1000 + 1000 <= g_ms) { memcpy(arFft, frames[fi].fft, 16); arVolume = frames[fi].volume; fi++; }
    um->loop();
    if (g_ms % 25 == 0) { autoFx(); seg.call++; const bool f = seg.px[0] == RGBW32(255, 255, 255, 0); if (f && !wasFlash) flashes++; wasFlash = f; }
    const double t = (g_ms - 1000) / 1000.0;
    if (fabs(t - 3.0) < 0.003 || fabs(t - 25.0) < 0.003) {
      DynamicJsonDocument d(1024); JsonObject st = d.to<JsonObject>(); um->addToJsonState(st);
      (t < 10 ? sectionInIntro : sectionInDrop) = st["tempolight"]["section"] | "";
      if (t > 10) { std::string s; serializeJson(d, s); printf("  state at 25 s: %s\n", s.c_str()); }
    }
  }
  CHECK(sectionInIntro == "calm", "intro section '%s'", sectionInIntro.c_str());
  CHECK(sectionInDrop == "drop", "drop section '%s'", sectionInDrop.c_str());
  CHECK(flashes >= 4 && flashes <= 3 * 16, "flashes %d", flashes);
  { DynamicJsonDocument d(2048); JsonObject info = d.to<JsonObject>(); um->addToJsonInfo(info);
    std::string s; serializeJson(d, s); printf("  info: %s\n", s.c_str());
    CHECK(d["tempolight"]["lite"] == TEMPOLIGHT_LITE_VERSION && d["tempolight"]["fx"]["auto"] == 194, "info.tempolight");
    CHECK(d["u"]["tempolight"].size() == 2, "info.u.tempolight"); }
  { DynamicJsonDocument d(512); deserializeJson(d, R"({"tempolight":{"on":false}})"); JsonObject o = d.as<JsonObject>(); um->readFromJsonState(o);
    DynamicJsonDocument d2(512); JsonObject st = d2.to<JsonObject>(); um->addToJsonState(st);
    CHECK(d2["tempolight"]["on"] == false && d2["tempolight"]["section"].isNull(), "switching off");
    autoFx(); }  // draws the quiet look without analysis
  arEnabled = false; { DynamicJsonDocument d(512); deserializeJson(d, R"({"tempolight":{"on":true}})"); JsonObject o = d.as<JsonObject>(); um->readFromJsonState(o); }
  g_ms += 10; um->loop();
  { DynamicJsonDocument d(1024); JsonObject info = d.to<JsonObject>(); um->addToJsonInfo(info); CHECK(d["tempolight"]["audio"] == false, "no AudioReactive -> audio false"); }
  printf("usermod smoke test: %s (%d flashes in the drop)\n", failures ? "FAILED" : "ok", flashes);
  return failures ? 1 : 0;
}
