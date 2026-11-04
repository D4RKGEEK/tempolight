# Tempolight as a Home Assistant add-on. Home Assistant builds this on the device and passes BUILD_VERSION (the add-on's
# version from config.yaml); we download that Tempolight release. Plain Node on Alpine: Tempolight needs nothing else.
# Build by hand:  docker build --build-arg BUILD_VERSION=0.3.0 -t tempolight-addon homeassistant/tempolight
#   (or --build-arg TEMPOLIGHT_REF=main to try the latest code)
FROM node:22-alpine
ARG BUILD_VERSION=0.3.0
ARG TEMPOLIGHT_REF=v${BUILD_VERSION}
# ffmpeg + alsa-utils: listen to a sound card; alsa-plugins-pulse: reach it through Home Assistant's audio (PulseAudio)
RUN apk add --no-cache ffmpeg alsa-utils alsa-plugins-pulse \
 && mkdir -p /opt/tempolight \
 && wget -qO- "https://codeload.github.com/D4RKGEEK/tempolight/tar.gz/${TEMPOLIGHT_REF}" | tar -xz -C /opt/tempolight --strip-components=1 \
 && test -f /opt/tempolight/packages/server/src/index.js \
 && printf 'pcm.!default { type pulse }\nctl.!default { type pulse }\n' > /etc/asound.conf
COPY ha-start.js run.sh /
RUN chmod +x /run.sh
ENV NODE_ENV=production TEMPOLIGHT_ROOT=/opt/tempolight
LABEL io.hass.type="addon" io.hass.version="${BUILD_VERSION}"
CMD ["/run.sh"]
