#!/usr/bin/env bash
# Host tests for Tempolight Lite (no ESP32, no Arduino): the analysis and effects in firmware/core against synthetic
# songs run through an emulation of WLED AudioReactive's GEQ. With WLED_DIR set to a WLED checkout, it also compiles
# the usermod against a small WLED stub (using WLED's bundled ArduinoJson) and runs a smoke test of it.
#   npm run test:firmware            or   firmware/test/run.sh
#   WLED_DIR=../WLED npm run test:firmware
# Needs a C++17 compiler (g++ or clang++; set CXX to choose).
set -euo pipefail
[ -n "${WLED_DIR:-}" ] && WLED_DIR="$(cd "$WLED_DIR" && pwd)"   # relative to where it was run, before the cd below
cd "$(dirname "${BASH_SOURCE[0]}")/.."
CXX="${CXX:-$(command -v g++ || command -v clang++ || true)}"
if [ -z "$CXX" ] || ! command -v "$CXX" >/dev/null; then echo "firmware tests: no C++ compiler found (install g++ or clang++, or set CXX)" >&2; exit 1; fi
out="${TMPDIR:-/tmp}/tempolight-firmware-test"; mkdir -p "$out"
flags=(-std=c++17 -O1 -g -Wall -Wextra)
# sanitizers where the toolchain has them (they catch out-of-bounds writes in effect memory)
if echo 'int main(){}' | "$CXX" -x c++ -fsanitize=address,undefined -o "$out/san" - 2>/dev/null; then flags+=(-fsanitize=address,undefined); fi

echo "== core: analysis + effects ($CXX)"
"$CXX" "${flags[@]}" core/tempolight_lite.cpp test/test_lite.cpp -o "$out/test_lite"
"$out/test_lite"

if [ -n "${WLED_DIR:-}" ]; then
  json="$WLED_DIR/wled00/src/dependencies/json/ArduinoJson-v6.h"
  [ -f "$json" ] || { echo "WLED_DIR=$WLED_DIR has no wled00/src/dependencies/json/ArduinoJson-v6.h" >&2; exit 1; }
  echo "== usermod against the WLED stub"
  "$CXX" "${flags[@]}" -Wno-unused-parameter -I test/wled_stub -I "$WLED_DIR/wled00" -I core \
    core/tempolight_lite.cpp wled-usermod-tempolight/usermod_tempolight.cpp test/wled_stub/test_usermod.cpp -o "$out/test_usermod"
  "$out/test_usermod"
else
  echo "(set WLED_DIR to a WLED checkout to also smoke-test the usermod against a WLED stub)"
fi
