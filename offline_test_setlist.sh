#!/usr/bin/env bash
# offline_test_setlist.sh — wifi-cycle test #1.
#
# Operator script:
#   1. Open http://localhost:3000/  and pick a gig.
#   2. Click the first song in setlist 1; press Play.
#   3. Run this script.
# The script then:
#   - records the currently-playing song base (call it A)
#   - turns wifi OFF
#   - prompts you to click the "next song" button (>>)
#   - waits 15 seconds
#   - prompts you to click "next song" again
#   - turns wifi ON
#   - verifies the SECOND song (B) is now the playing one
#   - prints PASS or FAIL with evidence
#
# Output: /tmp/simpleStem-offline-setlist.log

set -euo pipefail

LOG="/tmp/simpleStem-offline-setlist.log"
PORT="${PORT:-3000}"
stamp() { date '+%a %b %d %H:%M:%S %Z %Y'; }
log() { echo "$(stamp)  offline_test_setlist  $*" | tee -a "$LOG"; }

WIFI_IF="$(networksetup -listallhardwareports | awk '/Wi-?Fi/{getline; print $2}' | head -1)"
[[ -z "$WIFI_IF" ]] && { log "FATAL: no wifi interface"; exit 1; }

playback_state() {
  curl -s -m 3 "http://localhost:${PORT}/api/debug/playback-state" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d["state"]; print(s.get("base"), s.get("isPlaying"), s.get("paused"))' 2>/dev/null || echo "(no state)"
}

prompt() {
  echo
  echo "==>  $1"
  echo "    (press ENTER when done, or Ctrl-C to abort)"
  read -r _
}

log "=== baseline: capture starting song ==="
echo "(make sure the first setlist song is loaded and PLAYING in the portal)"
prompt "Press Play if not already playing, then ENTER here"
START_STATE=$(playback_state)
log "baseline state: $START_STATE"
START_BASE=$(echo "$START_STATE" | awk '{print $1}')
[[ "$START_BASE" == "(no" || "$START_BASE" == "None" ]] && { log "FATAL: nothing playing — start a song first"; exit 1; }

log "=== turning wifi OFF (sudo may prompt) ==="
sudo networksetup -setairportpower "$WIFI_IF" off
sleep 2
log "wifi after off: $(networksetup -getairportpower "$WIFI_IF" | awk -F: '{print $2}' | tr -d ' ')"

prompt "Click the NEXT song button (>>) in the portal"
sleep 2
SECOND_STATE=$(playback_state)
log "after first 'next': $SECOND_STATE"
SECOND_BASE=$(echo "$SECOND_STATE" | awk '{print $1}')

log "=== waiting 15 seconds (per Bill's spec) ==="
sleep 15

prompt "Click NEXT song button again (>>)"
sleep 2
THIRD_STATE=$(playback_state)
log "after second 'next': $THIRD_STATE"
THIRD_BASE=$(echo "$THIRD_STATE" | awk '{print $1}')

log "=== turning wifi ON ==="
sudo networksetup -setairportpower "$WIFI_IF" on
sleep 8
log "wifi after on: $(networksetup -getairportpower "$WIFI_IF" | awk -F: '{print $2}' | tr -d ' ')"

FINAL_STATE=$(playback_state)
log "FINAL state: $FINAL_STATE"
FINAL_BASE=$(echo "$FINAL_STATE" | awk '{print $1}')
IS_PLAYING=$(echo "$FINAL_STATE" | awk '{print $2}')

log "=== verdict ==="
log "  start song:    $START_BASE"
log "  after next×2:  $FINAL_BASE  isPlaying=$IS_PLAYING"

if [[ "$FINAL_BASE" != "$START_BASE" && "$IS_PLAYING" == "True" ]]; then
  log "PASS — playback advanced through offline window and song is producing audio"
  exit 0
else
  log "FAIL — final state did not match expected"
  exit 2
fi
