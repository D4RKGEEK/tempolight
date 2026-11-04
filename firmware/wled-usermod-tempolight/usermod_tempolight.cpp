// Tempolight Lite usermod: registration (WLED 16 library usermods). See usermod_tempolight.h and readme.md.
#include "usermod_tempolight.h"

const char TempolightLiteUsermod::_name[] PROGMEM = "tempolight";
TempolightLiteUsermod* TempolightLiteUsermod::instance = nullptr;

static TempolightLiteUsermod tempolight_lite;
REGISTER_USERMOD(tempolight_lite);
