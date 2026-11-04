// A tiny stand-in for WLED's wled.h, for compiling the usermod on a computer (firmware/test/run.sh, when WLED_DIR
// points at a WLED checkout for its bundled ArduinoJson). It declares only what usermod_tempolight.h uses, with the
// signatures copied from WLED 16 (wled00/fcn_declare.h, wled00/FX.h). It is a smoke test of our code, not of WLED:
// the real check is the PlatformIO build in .github/workflows/firmware.yml.
#pragma once
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <string>
#include <vector>

#include "src/dependencies/json/ArduinoJson-v6.h"

#define PROGMEM
#define F(x) (x)
#define FPSTR(x) (x)
typedef uint8_t byte;
using String = std::string;
#define RGBW32(r, g, b, w) (uint32_t((byte(w) << 24) | (byte(r) << 16) | (byte(g) << 8) | (byte(b))))

uint32_t millis();

struct Print { std::string out; size_t print(const char* s) { out += s; return strlen(s); } };

template <typename DestType>
bool getJsonValue(const JsonVariant& element, DestType& destination) {
  if (element.isNull()) return false;
  destination = element.as<DestType>();
  return true;
}
template <typename DestType, typename DefaultType>
bool getJsonValue(const JsonVariant& element, DestType& destination, const DefaultType defaultValue) {
  if (!getJsonValue(element, destination)) { destination = defaultValue; return false; }
  return true;
}

typedef enum UM_Data_Types { UMT_BYTE = 0, UMT_UINT16, UMT_INT16, UMT_UINT32, UMT_INT32, UMT_FLOAT, UMT_DOUBLE, UMT_BYTE_ARR } um_types_t;
typedef struct UM_Exchange_Data { size_t u_size = 0; um_types_t* u_type = nullptr; void** u_data = nullptr; } um_data_t;
#define USERMOD_ID_RESERVED 0
#define USERMOD_ID_UNSPECIFIED 1
#define USERMOD_ID_AUDIOREACTIVE 32

class Usermod {
 protected:
  um_data_t* um_data = nullptr;
 public:
  virtual ~Usermod() {}
  virtual void setup() = 0;
  virtual void loop() = 0;
  virtual bool getUMData(um_data_t** data) { if (data) *data = nullptr; return false; }
  virtual void appendConfigData(Print& settingsScript) {}
  virtual void addToJsonState(JsonObject& obj) {}
  virtual void addToJsonInfo(JsonObject& obj) {}
  virtual void readFromJsonState(JsonObject& obj) {}
  virtual void addToConfig(JsonObject& obj) {}
  virtual bool readFromConfig(JsonObject& obj) { return true; }
  virtual uint16_t getId() { return USERMOD_ID_UNSPECIFIED; }
};
namespace UsermodManager { bool getUMData(um_data_t** um_data, uint8_t mod_id = USERMOD_ID_RESERVED); }
inline std::vector<Usermod*>& usermodList() { static std::vector<Usermod*> list; return list; }
#define REGISTER_USERMOD(x) static bool um_reg_##x = (usermodList().push_back(&x), true)

typedef void (*mode_ptr)();
struct Segment {
  uint8_t speed = 128, intensity = 128, custom1 = 128;
  bool check1 = false, selected = true;
  uint16_t start = 0, stop = 60;
  uint8_t mode = 0;
  byte* data = nullptr;
  std::vector<byte> buf;
  uint32_t call = 0;
  std::vector<uint32_t> px = std::vector<uint32_t>(60);
  bool allocateData(size_t len) { if (buf.size() != len) { buf.assign(len, 0); data = buf.data(); } return true; }
  void setPixelColor(int n, uint32_t c) const;
  uint32_t color_from_palette(uint16_t i, bool mapping, bool moving, uint8_t mcol, uint8_t pbri = 255) const;
  void fill(uint32_t c) const;
  bool isSelected() const { return selected; }
  bool isActive() const { return stop > start; }
  Segment& setMode(uint8_t fx, bool loadDefaults = false) { mode = fx; call = 0; (void)loadDefaults; return *this; }
  static unsigned vLength();
};
struct WS2812FX {
  Segment* _currentSegment = nullptr;
  std::vector<Segment> _segments = std::vector<Segment>(1);
  std::vector<mode_ptr> modes;
  uint8_t addEffect(uint8_t id, mode_ptr fn, const char* name) { (void)id; (void)name; modes.push_back(fn); return (uint8_t)(186 + modes.size() - 1); }
  uint8_t getSegmentsNum() const { return (uint8_t)_segments.size(); }
  Segment& getSegment(unsigned id) { return _segments[id]; }
  Segment& getMainSegment() { return _segments[0]; }
};
extern WS2812FX strip;
#define SEGMENT (*strip._currentSegment)
#define SEGENV (*strip._currentSegment)
#define SEGLEN Segment::vLength()
#define SEGCOLOR(x) 0u
