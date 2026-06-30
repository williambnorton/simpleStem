#!/usr/bin/env bash
# offline_test_gig_switch.sh — wifi-cycle test #2.
#
# Sequence per Bill's spec 2026-06-30:
#   1. wifi OFF
#   2. operator opens the gig pulldown, presses Down arrow 3 times, ENTER
#      (selects a different gig in the list)
#   3. operator plays the first song in setlist 1, then advances to the 2nd
#   4. wifi ON
#   5. verify a song is playing (any base — proves the gig switch survived)
#
# Output: /tmp/simpleStem-offline-gig-switch.log

set -euo pipefail

LOG="/tmp/simpleStem-offline-gig-switch.log"
PORT="${PORT:-3000}"
stamp() { date '+%a %b %d %H:%M:%S %Z %Y'; }
log() { echo "$(stamp)  offline_test_gig  $*" | tee -a "$LOG"; }
prompt() { echo; echo "==>  $1"; echo "    (press ENTER when done)"; read -r _; }
playback() {
  curl -s -m 3 "http://localhost:${PORT}/api/debug/playback-state" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d["state"]; print(s.get("base"), s.get("isPlaying"), s.get("paused"))' 2>/dev/null || echo "(no state)"
}

WIFI_IF="$(networksetup -listallhardwareports | awk '/Wi-?Fi/{getline; print $2}' | head -1)"
[[ -z "$WIFI_IF" ]] && { log "FATAL: no wifi interface"; exit 1; }

log "=== baseline: snapshot current state ==="
log "baseline state: $(playback)"

log "=== turning wifi OFF ==="
sudo networksetup -setairportpower "$WIFI_IF" off
sleep 2
log "wifi after off: $(networksetup -getairportpower "$WIFI_IF" | awk -F: '{print $2}' | tr -d ' ')"

prompt "In the portal, click the gig pulldown, press DOWN arrow THREE times, then ENTER to open a new gig"
sleep 1
log "after gig switch: $(playback)"

prompt "Click the FIRST song in setlist 1; press Play"
sleep 2
FIRST=$(playback)
log "first song: $FIRST"
FIRST_BASE=$(echo "$FIRST" | awk '{print $1}')

prompt "Click NEXT song button (>>) to advance to song 2"
sleep 2
SECOND=$(playback)
log "second song: $SECOND"

log "=== turning wifi ON ==="
sudo networksetup -setairportpower "$WIFI_IF" on
sleep 8
log "wifi after on: $(networksetup -getairportpower "$WIFI_IF" | awk -F: '{print $2}' | tr -d ' ')"
FINAL=$(playback)
log "FINAL: $FINAL"

FINAL_BASE=$(echo "$FINAL" | awk '{print $1}')
IS_PLAYING=$(echo "$FINAL" | awk '{print $2}')

log "=== verdict ==="
log "  first song base: $FIRST_BASE"
log "  final base:      $FINAL_BASE  isPlaying=$IS_PLAYING"

if [[ "$IS_PLAYING" == "True" && "$FINAL_BASE" != "None" && "$FINAL_BASE" != "(no" ]]; then
  log "PASS — gig switch + 2 songs survived offline window and a song is playing"
  exit 0
else
  log "FAIL — no song playing at end of test"
  exit 2
fi
