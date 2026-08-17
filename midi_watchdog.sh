#!/bin/sh
BASE="$(cd "$(dirname "$0")" && pwd)"
FAILS=0
STALE=0
echo "$(date) midi_watchdog: up — probing sidecar :5555 every 20s (2 strikes = restart; stale-port check every cycle)"
while true; do
  sleep 20
  HEALTH="$(curl -sf -m 4 http://localhost:5555/health 2>/dev/null)"
  if [ -n "$HEALTH" ]; then
    if [ "$FAILS" -gt 0 ]; then echo "$(date) midi_watchdog: sidecar recovered"; fi
    FAILS=0
    STALEHIT=0
    for DEV in XR18 U2MIDI; do
      if ioreg -p IOUSB -l 2>/dev/null | grep -q "$DEV"; then
        case "$HEALTH" in
          *"$DEV"*) : ;;
          *) STALEHIT=1
             echo "$(date) midi_watchdog: $DEV is on USB but MISSING from the sidecar port list (stale CoreMIDI enumeration after hot-plug)" ;;
        esac
      fi
    done
    if [ "$STALEHIT" -eq 1 ]; then
      STALE=$((STALE+1))
      if [ "$STALE" -ge 2 ]; then
        echo "$(date) midi_watchdog: RESTARTING the sidecar to re-enumerate hot-plugged MIDI devices"
        "$BASE/performer.sh" restart-midi
        STALE=0
        sleep 10
      fi
    else
      STALE=0
    fi
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
