#!/bin/sh
BASE="$(cd "$(dirname "$0")" && pwd)"
FAILS=0
echo "$(date) midi_watchdog: up — probing sidecar :5555 every 20s (2 strikes = restart)"
while true; do
  sleep 20
  if curl -sf -m 4 http://localhost:5555/health >/dev/null 2>&1; then
    if [ "$FAILS" -gt 0 ]; then echo "$(date) midi_watchdog: sidecar recovered"; fi
    FAILS=0
  else
    FAILS=$((FAILS+1))
    echo "$(date) midi_watchdog: sidecar probe failed ($FAILS/2)"
    if [ "$FAILS" -ge 2 ]; then
      echo "$(date) midi_watchdog: RESTARTING the sidecar"
      "$BASE/performer.sh" restart-midi
      FAILS=0
      sleep 10
    fi
  fi
done
