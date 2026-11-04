#!/usr/bin/env bash
# Wraps the one-file macOS executable in Tempolight.app and puts it in a disk image (.dmg) with an Applications link,
# so people can drag it to Applications like any Mac app. Runs on macOS (uses sips, iconutil, codesign, hdiutil).
#   scripts/make-macos-dmg.sh dist/tempolight-macos-arm64 out/Tempolight-0.3.0-macos-arm64.dmg 0.3.0
# Opening the app starts Tempolight and opens it in the browser; opening it again while it runs just shows it again.
# It has no window or Dock icon: quit it from Settings → About → Quit Tempolight.
set -euo pipefail
bin="$1"; dmg="$2"; ver="${3:-0.0.0}"
root="$(cd "$(dirname "$0")/.." && pwd)"; work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
app="$work/dmg/Tempolight.app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/tempolight"; chmod +x "$app/Contents/MacOS/tempolight"

# the icon, at every size macOS asks for
set_dir="$work/Tempolight.iconset"; mkdir -p "$set_dir"; src="$root/apps/web/icons/icon-512.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$src" --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d "$src" --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null || cp "$src" "$set_dir/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$set_dir" -o "$app/Contents/Resources/Tempolight.icns"

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Tempolight</string>
  <key>CFBundleDisplayName</key><string>Tempolight</string>
  <key>CFBundleIdentifier</key><string>io.github.d4rkgeek.tempolight</string>
  <key>CFBundleVersion</key><string>$ver</string>
  <key>CFBundleShortVersionString</key><string>$ver</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>tempolight</string>
  <key>CFBundleIconFile</key><string>Tempolight</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Tempolight listens to the music to light your room.</string>
  <key>NSLocalNetworkUsageDescription</key><string>Tempolight finds and controls the lights on your network.</string>
  <key>NSAppleEventsUsageDescription</key><string>Tempolight reads what Spotify or Music is playing.</string>
</dict></plist>
EOF

codesign --force --deep --sign - "$app"   # ad-hoc: needed on Apple silicon; Gatekeeper still asks once (right-click → Open)
ln -s /Applications "$work/dmg/Applications"
mkdir -p "$(dirname "$dmg")"
hdiutil create -volname "Tempolight $ver" -srcfolder "$work/dmg" -ov -format UDZO "$dmg" >/dev/null
echo "Made $dmg ($(du -h "$dmg" | cut -f1))"
