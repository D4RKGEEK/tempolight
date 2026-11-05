# Tempolight in a container. Use host networking so it can find WLED controllers (mDNS) and stream to them (UDP):
#   docker run -d --name tempolight --network host -v tempolight:/data --restart unless-stopped ghcr.io/d4rkgeek/tempolight
# or with docker compose: see docker-compose.yml
FROM node:22-alpine
# ffmpeg and alsa-utils let the server listen to a sound card, and ffmpeg reads MP3/AAC/FLAC for the music library
# (optional; remove to save ~60 MB: the library then reads WAV files only)
# Your own music: docker run ... -v /path/to/Music:/music:ro -e TEMPOLIGHT_MUSIC=/music (see docs/guides/your-music.md)
RUN apk add --no-cache ffmpeg alsa-utils
WORKDIR /app
COPY package.json LICENSE README.md ./
COPY packages ./packages
COPY apps ./apps
COPY scripts/fake-wled.js ./scripts/
ENV TEMPOLIGHT_DATA=/data PORT=8080 NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
USER node
CMD ["node", "packages/server/src/index.js"]
