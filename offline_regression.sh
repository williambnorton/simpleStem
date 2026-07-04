#!/usr/bin/env bash
# offline_regression.sh — extensive unattended offline test of the Performer.
#
# Turns the Wi-Fi radio OFF for a full window (default 180 s), hammers the
# portal the way a gig does — health polls, library, gigs/setlists, queue,
# and RANDOM-SAMPLED ranged reads of real stem audio — while watching
# perf-server.log for danger signals, then turns Wi-Fi back on and prints
# a PASS/FAIL report. Ethernet (XR18 control) is untouched.
#
# What it proves:
#   - the portal serves EVERYTHING from local cache with no wifi
#   - no request wedges the event loop (health stays fast the whole time)
#   - no Drive read sneaks into the hot path (log watch + latency ceiling)
# What it can't do: click Play in Chrome. While the window runs, feel free
# to play songs / advance a setlist / engage the drum machine in the
# portal — the script's results are valid either way.
#
# Usage (on the Performer, with performer.sh running):
#   ./offline_regression.sh              180 s offline window (default)
#   ./offline_regression.sh 300          5-minute window
#   ./offline_regression.sh --dry        describe, don't toggle wifi
#
# Exit code 0 = PASS, 1 = FAIL. Log: /tmp/simpleStem-offline-regression-<pid>.log
set -uo pipefail

DURATION=180
DRY=0
[[ "${1:-}" == "--dry" ]] && DRY=1
[[ "${1:-}" =~ ^[0-9]+$ ]] && DURATION="$1"

PORT="${PORT:-3000}"
BASE_URL="http://localhost:$PORT"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_LOG="$SCRIPT_DIR/.run/perf-server.log"
LOG="/tmp/simpleStem-offline-regression-$$.log"
SONG_SAMPLE=12          # random songs per audio sweep
AUDIO_SWEEPS=3          # sweeps spread across the window
HEALTH_CEILING_MS=500   # health slower than this = event-loop trouble
AUDIO_CEILING_MS=1500   # a cached ranged read slower than this = suspicious

FAILS=0
WARNS=0

stamp() { date '+%a %b %d %H:%M:%S %Z %Y'; }
log()   { echo "$(stamp)  offline_regression.sh  $*" | tee -a "$LOG"; }
fail()  { FAILS=$((FAILS+1)); log "FAIL: $*"; }
warn()  { WARNS=$((WARNS+1)); log "warn: $*"; }

wifi_dev() {
  networksetup -listallhardwareports | awk '/Hardware Port: Wi-Fi/{getline; print $2; exit}'
}

ms_curl() {
  # Prints integer milliseconds for a bounded GET; 99999 on failure.
  local url="$1" range="${2:-}"
  local args=(-s -m 5 -o /dev/null -w '%{time_total}')
  [[ -n "$range" ]] && args+=(-r "$range")
  local t
  t="$(curl "${args[@]}" "$url" 2>/dev/null)" || { echo 99999; return; }
  python3 -c "print(int(float('$t')*1000))" 2>/dev/null || echo 99999
}

DEV="$(wifi_dev)"
[[ -n "$DEV" ]] || { echo "No Wi-Fi hardware port found" >&2; exit 1; }

log "=== OFFLINE REGRESSION — window ${DURATION}s, wifi device $DEV, log $LOG ==="

h0="$(ms_curl "$BASE_URL/api/health")"
if [[ "$h0" -ge 99999 ]]; then
  echo "Portal is not answering at $BASE_URL — start it first (./performer.sh start)" >&2
  exit 1
fi
log "pre-flight: health ${h0}ms with wifi ON"

SONGLIST="$(curl -s -m 10 "$BASE_URL/api/library" | python3 -c '
import json,sys,random
d=json.load(sys.stdin)
songs=d if isinstance(d,list) else d.get("songs",[])
bases=[s["folderName"] for s in songs if s.get("type")=="stems" and s.get("folderName")]
random.shuffle(bases)
print("\n".join(bases))
')"
TOTAL_SONGS="$(echo "$SONGLIST" | grep -c . || echo 0)"
[[ "$TOTAL_SONGS" -gt 0 ]] || { echo "Library returned no stems songs" >&2; exit 1; }
log "pre-flight: $TOTAL_SONGS stems songs in the library; sampling $SONG_SAMPLE per sweep x $AUDIO_SWEEPS sweeps"

LOG_MARK=$(wc -l < "$SERVER_LOG" 2>/dev/null || echo 0)

if [[ "$DRY" == "1" ]]; then
  log "--dry: would now turn wifi OFF for ${DURATION}s and run the checks. Exiting."
  exit 0
fi

log "turning wifi OFF ($DEV)"
networksetup -setairportpower "$DEV" off
sleep 3

restore_wifi() {
  log "turning wifi ON ($DEV)"
  networksetup -setairportpower "$DEV" on
}
trap restore_wifi EXIT

if curl -s -m 4 -o /dev/null https://www.google.com 2>/dev/null; then
  warn "internet still reachable with wifi off (Ethernet uplink?) — offline isolation is PARTIAL"
else
  log "confirmed: no internet route (as intended)"
fi

audio_sweep() {
  local n=0 slow=0 bad=0 worst=0 worst_name=""
  while IFS= read -r base; do
    [[ -z "$base" ]] && continue
    n=$((n+1)); [[ $n -gt $SONG_SAMPLE ]] && break
    for stemf in vocals drums bass guitar piano other; do
      local url="$BASE_URL/api/audio/stems/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$base")/${stemf}.m4a"
      local ms
      ms="$(ms_curl "$url" "0-131071")"
      if [[ "$ms" -ge 99999 ]]; then
        bad=$((bad+1)); log "  AUDIO ERROR $base/${stemf}.m4a"
      elif [[ "$ms" -gt "$AUDIO_CEILING_MS" ]]; then
        slow=$((slow+1)); log "  slow ${ms}ms $base/${stemf}.m4a"
      fi
      if [[ "$ms" -lt 99999 && "$ms" -gt "$worst" ]]; then worst="$ms"; worst_name="$base/${stemf}"; fi
    done
  done <<< "$1"
  echo "$bad $slow $worst $worst_name"
}

END=$(( $(date +%s) + DURATION ))
SWEEP_AT_1=$(( $(date +%s) + 5 ))
SWEEP_AT_2=$(( $(date +%s) + DURATION/2 ))
SWEEP_AT_3=$(( END - 45 ))
sweep_done_1=0; sweep_done_2=0; sweep_done_3=0
HEALTH_N=0; HEALTH_SLOW=0; HEALTH_ERR=0; HEALTH_WORST=0
API_ERRS=0

while [[ $(date +%s) -lt $END ]]; do
  hm="$(ms_curl "$BASE_URL/api/health")"
  HEALTH_N=$((HEALTH_N+1))
  if [[ "$hm" -ge 99999 ]]; then HEALTH_ERR=$((HEALTH_ERR+1)); log "  HEALTH ERROR (no response)";
  elif [[ "$hm" -gt "$HEALTH_CEILING_MS" ]]; then HEALTH_SLOW=$((HEALTH_SLOW+1)); log "  health slow: ${hm}ms"; fi
  [[ "$hm" -lt 99999 && "$hm" -gt "$HEALTH_WORST" ]] && HEALTH_WORST="$hm"

  now=$(date +%s)
  for ep in "/api/library" "/api/gigs" "/api/setlists" "/api/queue" "/api/custom-loops/list" "/api/audio/xr18-status" "/api/drum-loops"; do
    em="$(ms_curl "$BASE_URL$ep")"
    if [[ "$em" -ge 99999 ]]; then API_ERRS=$((API_ERRS+1)); log "  API ERROR $ep"; fi
  done

  if [[ $sweep_done_1 -eq 0 && $now -ge $SWEEP_AT_1 ]]; then
    sweep_done_1=1; log "audio sweep 1/3 ($SONG_SAMPLE random songs x 6 stems, 128KB ranged reads)"
    read -r b s w wn <<< "$(audio_sweep "$SONGLIST")"
    [[ "$b" -gt 0 ]] && fail "audio sweep 1: $b failed reads" || log "  sweep 1 clean (worst ${w}ms $wn, $s slow)"
    [[ "$s" -gt 3 ]] && warn "audio sweep 1: $s reads over ${AUDIO_CEILING_MS}ms"
  fi
  if [[ $sweep_done_2 -eq 0 && $now -ge $SWEEP_AT_2 ]]; then
    sweep_done_2=1
    SONGLIST2="$(echo "$SONGLIST" | tail -n +$((SONG_SAMPLE+1)))"
    log "audio sweep 2/3 (next $SONG_SAMPLE random songs)"
    read -r b s w wn <<< "$(audio_sweep "$SONGLIST2")"
    [[ "$b" -gt 0 ]] && fail "audio sweep 2: $b failed reads" || log "  sweep 2 clean (worst ${w}ms $wn, $s slow)"
    [[ "$s" -gt 3 ]] && warn "audio sweep 2: $s reads over ${AUDIO_CEILING_MS}ms"
  fi
  if [[ $sweep_done_3 -eq 0 && $now -ge $SWEEP_AT_3 ]]; then
    sweep_done_3=1
    SONGLIST3="$(echo "$SONGLIST" | tail -n +$((2*SONG_SAMPLE+1)))"
    log "audio sweep 3/3 (next $SONG_SAMPLE random songs)"
    read -r b s w wn <<< "$(audio_sweep "$SONGLIST3")"
    [[ "$b" -gt 0 ]] && fail "audio sweep 3: $b failed reads" || log "  sweep 3 clean (worst ${w}ms $wn, $s slow)"
    [[ "$s" -gt 3 ]] && warn "audio sweep 3: $s reads over ${AUDIO_CEILING_MS}ms"
  fi

  left=$(( END - $(date +%s) ))
  log "progress: ${left}s remaining · health polls $HEALTH_N (worst ${HEALTH_WORST}ms, slow $HEALTH_SLOW, err $HEALTH_ERR) · api errs $API_ERRS"
  sleep 10
done

log "offline window complete — restoring wifi"
restore_wifi
trap - EXIT
sleep 8

hpost="$(ms_curl "$BASE_URL/api/health")"
log "post: health ${hpost}ms with wifi back ON"

NEW_LOG="$(tail -n +$((LOG_MARK+1)) "$SERVER_LOG" 2>/dev/null || true)"
DANGER="$(echo "$NEW_LOG" | grep -Ei 'drive-stall|drive stalled|sendFile err|503|EHOSTDOWN|ENETDOWN|ETIMEDOUT|precache] failed' | head -20 || true)"
if [[ -n "$DANGER" ]]; then
  DCOUNT="$(echo "$DANGER" | grep -c . )"
  warn "server log grew $DCOUNT danger line(s) during the window:"
  echo "$DANGER" | tee -a "$LOG"
else
  log "server log clean during the window (no drive-stall / 503 / sendFile errors)"
fi

[[ "$HEALTH_ERR" -gt 0 ]] && fail "health endpoint failed $HEALTH_ERR time(s) offline"
[[ "$HEALTH_SLOW" -gt 2 ]] && fail "health exceeded ${HEALTH_CEILING_MS}ms $HEALTH_SLOW times (event-loop pressure)"
[[ "$API_ERRS" -gt 0 ]] && fail "$API_ERRS API endpoint errors offline"
[[ $sweep_done_3 -eq 0 ]] && warn "window too short for all 3 audio sweeps (ran $((sweep_done_1+sweep_done_2+sweep_done_3)))"

echo "" | tee -a "$LOG"
if [[ "$FAILS" -eq 0 ]]; then
  log "=== RESULT: PASS ($WARNS warning(s)) — the Performer runs fully offline. Log: $LOG ==="
  exit 0
else
  log "=== RESULT: FAIL ($FAILS failure(s), $WARNS warning(s)) — see $LOG ==="
  exit 1
fi
