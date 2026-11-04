#!/usr/bin/env bash
# Runs INSIDE the Raspberry Pi OS image (chroot), called by build-image.sh. Tempolight is already in /opt/tempolight
# and the files from install/pi/files are in /tmp/tempolight-files.
#   env: TEMPOLIGHT_VERSION, WITH_FFMPEG (1/0), NODE_MAJOR (22)
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
NODE_MAJOR="${NODE_MAJOR:-22}"
F=/tmp/tempolight-files

# don't start services inside the chroot
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d

apt-get update
# avahi: http://tempolight.local; dnsmasq-base: DHCP/DNS for NetworkManager's shared (hotspot) mode; rfkill/iw: Wi-Fi
apt-get install -y --no-install-recommends ca-certificates curl gnupg git alsa-utils avahi-daemon libnss-mdns \
  network-manager dnsmasq-base rfkill iw
if [ "${WITH_FFMPEG:-1}" = 1 ]; then apt-get install -y --no-install-recommends ffmpeg; fi

# Node.js from NodeSource, so `apt upgrade` keeps it current
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodesource
apt-get update
apt-get install -y nodejs
node -e "if (+process.versions.node.split('.')[0] < ${NODE_MAJOR}) { console.error('wrong Node.js ' + process.version); process.exit(1) }"

# the tempolight user: owns the app (so one-click updates can git pull) and its settings
id tempolight >/dev/null 2>&1 || useradd --system --home-dir /var/lib/tempolight --create-home --shell /usr/sbin/nologin --user-group tempolight
usermod -aG audio tempolight
install -d -o tempolight -g tempolight -m 0750 /var/lib/tempolight
chown -R tempolight:tempolight /opt/tempolight
node /opt/tempolight/packages/server/src/index.js --help >/dev/null # the code runs on this Node

# services
install -m 0644 "$F/tempolight.service" /etc/systemd/system/tempolight.service
install -m 0644 "$F/tempolight-wifi.service" /etc/systemd/system/tempolight-wifi.service
install -d /etc/NetworkManager/dnsmasq-shared.d
install -m 0644 "$F/tempolight-captive.conf" /etc/NetworkManager/dnsmasq-shared.d/tempolight-captive.conf
install -d /etc/avahi/services
install -m 0644 "$F/avahi-tempolight.service" /etc/avahi/services/tempolight.service
systemctl enable tempolight.service tempolight-wifi.service avahi-daemon.service NetworkManager.service

# hostname: tempolight (Raspberry Pi Imager's settings can change it)
echo tempolight > /etc/hostname
if grep -q '^127\.0\.1\.1' /etc/hosts; then sed -i 's/^127\.0\.1\.1.*/127.0.1.1\ttempolight/' /etc/hosts; else printf '127.0.1.1\ttempolight\n' >> /etc/hosts; fi

# SD card care: journal in RAM. (Tempolight itself writes its settings file only after changes, debounced.)
install -d /etc/systemd/journald.conf.d
install -m 0644 "$F/journald-tempolight.conf" /etc/systemd/journald.conf.d/tempolight.conf

# SSH stays off (as in Raspberry Pi OS): turn it on in Raspberry Pi Imager's settings when writing the card
systemctl disable ssh.service 2>/dev/null || true

cat > /etc/tempolight-release <<EOF
TEMPOLIGHT_VERSION=${TEMPOLIGHT_VERSION:-dev}
BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
cat > /etc/motd <<'EOF'

  Tempolight: open http://tempolight.local (or http://<this Pi's address>:8080)
  Logs: journalctl -u tempolight -f      Wi-Fi setup: journalctl -u tempolight-wifi -f

EOF

apt-get clean
rm -rf /var/lib/apt/lists/* /usr/sbin/policy-rc.d "$F"
