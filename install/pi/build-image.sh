#!/usr/bin/env bash
# Builds the Tempolight Raspberry Pi image: the official Raspberry Pi OS Lite (64-bit), plus Node.js, Tempolight in
# /opt/tempolight, its services, Wi-Fi setup and avahi. Runs on Linux as root (loop devices and chroot); on an x86
# machine it needs qemu-user-static (binfmt) to run the arm64 chroot, on an arm64 machine nothing extra.
#   sudo install/pi/build-image.sh <version> [out-dir]
# env: RPIOS_URL (default: the latest Raspberry Pi OS Lite arm64), WITH_FFMPEG=1, GROW_MB=1536, NODE_MAJOR=22,
#      TEMPOLIGHT_GIT_URL (what one-click updates pull from), RELEASE_URL (where the .img.xz will be downloaded from)
# Output in out-dir: tempolight-<version>-pi-arm64.img.xz, .sha256 and tempolight-imager.json (Raspberry Pi Imager).
set -euo pipefail

VERSION="${1:?usage: build-image.sh <version> [out-dir]}"
OUT="$(mkdir -p "${2:-dist}" && cd "${2:-dist}" && pwd)"
RPIOS_URL="${RPIOS_URL:-https://downloads.raspberrypi.com/raspios_lite_arm64_latest}"
GROW_MB="${GROW_MB:-1536}"
GIT_URL="${TEMPOLIGHT_GIT_URL:-https://github.com/D4RKGEEK/tempolight.git}"
NAME="tempolight-${VERSION}-pi-arm64"
RELEASE_URL="${RELEASE_URL:-https://github.com/D4RKGEEK/tempolight/releases/download/v${VERSION}/${NAME}.img.xz}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo): it uses loop devices and chroot" >&2; exit 1; }
for t in curl xz parted losetup e2fsck resize2fs chroot sha256sum git; do command -v "$t" >/dev/null || { echo "Missing: $t" >&2; exit 1; }; done
if [ "$(uname -m)" != aarch64 ] && [ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
  echo "This isn't an arm64 machine: install qemu-user-static (with binfmt) to run the image's programs" >&2; exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tl-pi.XXXXXX")"
MNT="$WORK/root"; LOOP=""
cleanup() {
  set +e
  for m in dev/pts dev proc sys boot/firmware; do mountpoint -q "$MNT/$m" && umount -l "$MNT/$m"; done
  mountpoint -q "$MNT" && umount -l "$MNT"
  [ -n "$LOOP" ] && losetup -d "$LOOP"
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---- 1. the official image, checked against its published sha256
URL="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RPIOS_URL")"
echo "Base image: $URL"
curl -fL --retry 3 -o "$WORK/base.img.xz" "$URL"
if curl -fsSL "$URL.sha256" -o "$WORK/base.sha256"; then
  echo "$(awk '{print $1}' "$WORK/base.sha256")  $WORK/base.img.xz" | sha256sum -c -
else
  echo "warning: no .sha256 published next to the image; not verified" >&2
fi
xz -dc "$WORK/base.img.xz" > "$WORK/$NAME.img"; rm "$WORK/base.img.xz"

# ---- 2. room for Node.js and ffmpeg (Raspberry Pi OS grows the root partition to the whole card on first boot)
truncate -s "+${GROW_MB}M" "$WORK/$NAME.img"
parted -s "$WORK/$NAME.img" resizepart 2 100%
LOOP="$(losetup -fP --show "$WORK/$NAME.img")"
udevadm settle 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -b "${LOOP}p2" ] && break; sleep 1; done
e2fsck -fy "${LOOP}p2" || [ $? -le 1 ]
resize2fs "${LOOP}p2"

mkdir -p "$MNT"
mount "${LOOP}p2" "$MNT"
mkdir -p "$MNT/boot/firmware"
mount "${LOOP}p1" "$MNT/boot/firmware"
for m in dev dev/pts proc sys; do mount --bind "/$m" "$MNT/$m"; done
# DNS inside the chroot: the build machine's (the image's own resolv.conf is put back afterwards)
if [ -e "$MNT/etc/resolv.conf" ] || [ -L "$MNT/etc/resolv.conf" ]; then cp -a "$MNT/etc/resolv.conf" "$WORK/resolv.conf.orig"; fi
rm -f "$MNT/etc/resolv.conf"; cp -L /etc/resolv.conf "$MNT/etc/resolv.conf"

# ---- 3. Tempolight as a git checkout on branch main (so the one-click update can git pull), at this commit
g() { git -c safe.directory='*' "$@"; } # we're root; the checkout belongs to the CI user
COMMIT="$(g -C "$REPO" rev-parse HEAD)"
g clone -q --no-hardlinks "$REPO" "$MNT/opt/tempolight"
g -C "$MNT/opt/tempolight" remote set-url origin "$GIT_URL"
g -C "$MNT/opt/tempolight" checkout -q -B main "$COMMIT"
g -C "$MNT/opt/tempolight" update-ref refs/remotes/origin/main "$COMMIT"
g -C "$MNT/opt/tempolight" branch -q --set-upstream-to=origin/main main
g -C "$MNT/opt/tempolight" gc -q --prune=now || true
cp -r "$HERE/files" "$MNT/tmp/tempolight-files"
cp "$HERE/customize.sh" "$MNT/tmp/tempolight-customize.sh"

# ---- 4. everything else happens inside the image
chroot "$MNT" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root TEMPOLIGHT_VERSION="$VERSION" \
  WITH_FFMPEG="${WITH_FFMPEG:-1}" NODE_MAJOR="${NODE_MAJOR:-22}" bash /tmp/tempolight-customize.sh
rm -f "$MNT/tmp/tempolight-customize.sh"

# Raspberry Pi OS Trixie configures itself with cloud-init from the boot partition: default the hostname to tempolight
# there too (Imager's settings replace these files when someone sets a hostname)
if [ -f "$MNT/boot/firmware/meta-data" ] && ! grep -q '^local-hostname:' "$MNT/boot/firmware/meta-data"; then
  printf 'local-hostname: tempolight\n' >> "$MNT/boot/firmware/meta-data"
fi
INIT_FORMAT=systemd; [ -x "$MNT/usr/bin/cloud-init" ] && INIT_FORMAT=cloudinit-rpi
# shellcheck disable=SC1091
BASE_RELEASE="$(. "$MNT/etc/os-release" && echo "$PRETTY_NAME")"

rm -f "$MNT/etc/resolv.conf"; if [ -e "$WORK/resolv.conf.orig" ] || [ -L "$WORK/resolv.conf.orig" ]; then cp -a "$WORK/resolv.conf.orig" "$MNT/etc/resolv.conf"; fi
rm -f "$MNT/root/.bash_history"
for m in dev/pts dev proc sys boot/firmware; do umount "$MNT/$m"; done
umount "$MNT"
e2fsck -fy "${LOOP}p2" || [ $? -le 1 ]
command -v zerofree >/dev/null && zerofree "${LOOP}p2" # zeroed free space compresses to nothing
losetup -d "$LOOP"; LOOP=""

# ---- 5. compress, checksums, and an entry for Raspberry Pi Imager
EXTRACT_SIZE="$(stat -c %s "$WORK/$NAME.img")"
EXTRACT_SHA="$(sha256sum "$WORK/$NAME.img" | awk '{print $1}')"
xz -T0 -6 -c "$WORK/$NAME.img" > "$OUT/$NAME.img.xz"
( cd "$OUT" && sha256sum "$NAME.img.xz" > "$NAME.img.xz.sha256" )
DL_SIZE="$(stat -c %s "$OUT/$NAME.img.xz")"
DL_SHA="$(awk '{print $1}' "$OUT/$NAME.img.xz.sha256")"
cat > "$OUT/tempolight-imager.json" <<EOF
{
  "os_list": [
    {
      "name": "Tempolight ${VERSION}",
      "description": "Music-reactive lighting for WLED, ready to go. Based on ${BASE_RELEASE} (64-bit, Lite).",
      "url": "${RELEASE_URL}",
      "icon": "https://raw.githubusercontent.com/D4RKGEEK/tempolight/main/apps/web/icons/icon-192.png",
      "website": "https://github.com/D4RKGEEK/tempolight",
      "release_date": "$(date -u +%Y-%m-%d)",
      "extract_size": ${EXTRACT_SIZE},
      "extract_sha256": "${EXTRACT_SHA}",
      "image_download_size": ${DL_SIZE},
      "image_download_sha256": "${DL_SHA}",
      "init_format": "${INIT_FORMAT}",
      "devices": ["pi5-64bit", "pi4-64bit", "pi3-64bit"]
    }
  ]
}
EOF
echo "Built $OUT/$NAME.img.xz ($DL_SIZE bytes, unpacked $EXTRACT_SIZE; Imager init_format $INIT_FORMAT)"
