#!/usr/bin/env bash
# Puts the Tempolight Lite usermod into a WLED source tree and adds a PlatformIO environment for it.
#   firmware/scripts/add-to-wled.sh path/to/WLED [env-name]
# Then, in the WLED folder:  npm ci && pio run -e esp32dev_tempolight
# The usermod lands in usermods/tempolight/ (usermod + the shared core from firmware/core). WLED 16 or newer.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wled="${1:?usage: add-to-wled.sh path/to/WLED [env-name]}"
env="${2:-esp32dev_tempolight}"
[ -f "$wled/platformio.ini" ] && [ -d "$wled/usermods/audioreactive" ] || { echo "$wled doesn't look like a WLED checkout (no platformio.ini / usermods/audioreactive)" >&2; exit 1; }
grep -q '^\[env:esp32dev\]' "$wled/platformio.ini" || { echo "no [env:esp32dev] in $wled/platformio.ini" >&2; exit 1; }

dest="$wled/usermods/tempolight"
rm -rf "$dest"; mkdir -p "$dest"
cp "$here/wled-usermod-tempolight/"{library.json,usermod_tempolight.h,usermod_tempolight.cpp,readme.md} "$dest/"
cp "$here/core/tempolight_lite.h" "$here/core/tempolight_lite.cpp" "$dest/"

ovr="$wled/platformio_override.ini"
if [ -f "$ovr" ] && ! grep -q "Tempolight Lite" "$ovr"; then
  echo "$ovr exists and isn't ours: add the environment from firmware/README.md to it by hand" >&2; exit 1
fi
cat > "$ovr" <<INI
; Tempolight Lite (written by tempolight/firmware/scripts/add-to-wled.sh)
[platformio]
default_envs = $env

[env:$env]
extends = env:esp32dev
custom_usermods = audioreactive tempolight
; AudioReactive on from the first boot, with a generic I2S microphone (INMP441) on its default pins:
; SD -> GPIO32, WS -> GPIO15, SCK -> GPIO14 (all can be changed later in Config > Usermods)
build_flags = \${common.build_flags} \${esp32_idf_V4.build_flags}
  -D WLED_RELEASE_NAME=\\"ESP32_Tempolight_Lite\\"
  -DARDUINO_USB_CDC_ON_BOOT=0
  -D UM_AUDIOREACTIVE_ENABLE
  -D SR_DMTYPE=1 -D I2S_SDPIN=32 -D I2S_WSPIN=15 -D I2S_CKPIN=14
INI
echo "added usermods/tempolight and [env:$env] to $wled"
