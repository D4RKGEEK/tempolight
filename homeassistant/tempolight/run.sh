#!/bin/sh
# Home Assistant add-on entry point: ha-start.js reads /data/options.json, asks the Supervisor for the Mosquitto
# broker, turns both into Tempolight's environment variables and starts the server in the same process.
set -eu
exec node /ha-start.js
