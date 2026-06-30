#!/usr/bin/env bash
# offline_test.sh — automated wifi-cycle test of the simpleStem Performer.
#
# Toggles wifi off, exercises the portal as much as the script can, captures
# evidence, toggles wifi back on. Run while the Performer portal is open at
# http://localhost:3000/ — the script doesn't drive Chrome (it would need
# osascript + accessibility permissions, which is fragile). What it DOES
# is run the toggle, watch the server log for the danger signals, and
# verify the audio HTTP path remains responsive throughout.
#
# Usage:
#   ./offline_test.sh                  # 30-second offline window (default)
#   ./offline_test.sh 60               # 60-second offline window
#   ./offline_test.sh --dry            # describe what it would do, don't toggle
#
# Output: /tmp/simpleStem-offline-NNN.log with the audit trail.

set -euo pipefail

DURATION="${1:-30}"
[[ "${1:-}" == "--dry" ]] && { DRY=1; DURATION=30; } || DRY=0
LOG="/tmp/simpleStem-offline-$$.log"
ROOT="${SIMPLE_STEM_ROOT:-$HOME/ClaudeDrive/simpleStem}"
SERVER_LOG="$ROOT/.run/perf-server.log"

stamp() { date '+%a %b %d %H:%M:%S %Z %Y'; }

log() { echo "$(stamp)  offline_test.sh  $*" | tee -a "$LOG"; }

probe_audio() {
  local label="$1" url
  url="http://localhost:3000/api/audio/drum-machine/110%40129.m4a"
  local ms
  ms=$( { time curl -s -m 5 -o /dev/null -r 0-65535 "$url"; } 2>&1 | awk '/real/ {print $2}')
  log "audio probe ($label) ${ms}"
}

probe_health() {
  local label="$1"
  local resp
  resp=$(curl -s -m 3 http://localhost:3000/api/health 2>&1 || echo FAIL)
  log "health probe ($label): $resp"
}

if [[ $DRY -eq 1 ]]; then
  log "DRY RUN — would toggle wifi off for ${DURATION}s, probe, then toggle on."
  log "real run: ./offline_test.sh ${DURATION}"
  exit 0
fi

if [[ ! -d "$ROOT" ]]; then
  log "FATAL: simpleStem root not found at $ROOT"
  exit 1
fi
if [[ ! -f "$SERVER_LOG" ]]; then
  log "FATAL: performer log not found at $SERVER_LOG (is the server running?)"
  exit 1
fi

WIFI_IF="$(networksetup -listallhardwareports | awk '/Wi-?Fi/{getline; print $2}' | head -1)"
if [[ -z "$WIFI_IF" ]]; then
  log "FATAL: could not find wifi interface name via networksetup"
  exit 1
fi
log "wifi interface: $WIFI_IF"

SRV_LOG_START_LINE=$(wc -l < "$SERVER_LOG")

log "=== baseline (wifi on) ==="
probe_health "baseline"
probe_audio "baseline"

log "=== turning wifi OFF (sudo may prompt) ==="
sudo networksetup -setairportpower "$WIFI_IF" off
sleep 2
log "wifi state after off: $(networksetup -getairportpower "$WIFI_IF" | awk -F: '{print $2}' | tr -d ' ')"

log "=== offline window: ${DURATION}s — probing every 5s ==="
END=$(($(date +%s) + DURATION))
i=0
while [[ $(date +%s) -lt $END ]]; do
  i=$((i + 1))
  probe_health "offline-$i"
  probe_audio "offline-$i"
  sleep 5
done

log "=== turning wifi ON ==="
sudo networksetup -setairportpower "$WIFI_IF" on
sleep 5
log "wifi state after on: $(networksetup -getairportpower "$WIFI_IF" | awk -F: '{print $2}' | tr -d ' ')"

log "=== post-restore probes ==="
probe_health "post-restore"
probe_audio "post-restore"

log "=== server log lines since baseline (audio errors / drive stalls only) ==="
tail -n "+$SRV_LOG_START_LINE" "$SERVER_LOG" | grep -E 'audio sendFile err|drive-stall|drive stalled|ECONN|EPIPE|503' | tee -a "$LOG" || log "  (no danger signals in server log — clean run)"

log "=== summary ==="
log "  baseline + ${DURATION}s offline + restore tested"
log "  full log: $LOG"
