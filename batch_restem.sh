#!/usr/bin/env bash
# batch_restem.sh — drive the simpleStem KBM macro across many songs in a row.
#
# Reads song bases (one per line) from stdin or a file. For each:
#   1. POST /api/song/<base>/logic-restem to fire the macro
#   2. Poll the KBM Engine variable `simpleStem_Running` until it clears
#   3. Verify the four expected m4a bounces appear in M4A/ with mtime
#      newer than the trigger time and a sane minimum size
#   4. Log success / skip / failure and move to the next base
#
# Pure shell — no Claude / computer-use needed. KBM owns Logic Pro; this
# script owns the outer loop, the timeout, and the verification.
#
# Usage:
#   ./batch_restem.sh songs.txt
#   ./batch_restem.sh < songs.txt
#   printf '%s\n' Harvest_Moon_Neil_Young American_Girl_Tom_Petty | ./batch_restem.sh
#
# Output formats accepted:
#   one slug per line; lines starting with '#' and blank lines ignored
#
# Tunables (env or top of file):
#   PORTAL=http://localhost:3000      where /api/* lives
#   POLL_INTERVAL=30                  seconds between lock-state polls
#   MAX_PER_SONG=480                  hard timeout per song (sec); 8 min is
#                                     generous for a ~3-min macro
#   MIN_BOUNCE_BYTES=50000            below this size, the m4a is probably empty
#   UNLOCK_ON_TIMEOUT=1               POST /api/logic-restem/unlock when a song
#                                     times out so the next one isn't blocked
#   INGEST_TIMEOUT=900                seconds to wait for the Librarian to
#                                     download a missing source.wav

set -uo pipefail

PORTAL="${PORTAL:-http://localhost:3000}"
POLL_INTERVAL="${POLL_INTERVAL:-30}"
MAX_PER_SONG="${MAX_PER_SONG:-480}"
MIN_BOUNCE_BYTES="${MIN_BOUNCE_BYTES:-50000}"
UNLOCK_ON_TIMEOUT="${UNLOCK_ON_TIMEOUT:-1}"
INGEST_TIMEOUT="${INGEST_TIMEOUT:-900}"

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$BASE_DIR/lib-common.sh" 2>/dev/null || true
DATA_ROOT="$({ command -v data_root >/dev/null 2>&1 && data_root; } || echo "$HOME/ClaudeDrive/simpleStem")"
STEMS_DIR="$DATA_ROOT/STEMS"
M4A_DIR="$DATA_ROOT/M4A"
INCOMING_DIR="$DATA_ROOT/INCOMING_WEBLOC"

VARIANTS=( "-V" "-V-G" "-V-G-B" "DO" )

log() { printf '%s %s\n' "[$(date +%H:%M:%S)]" "$*"; }

trap 'log "interrupted — exiting; in-flight macro may still finish in KBM"; exit 130' INT TERM

read_lock() {
  osascript -e 'tell application "Keyboard Maestro Engine" to getvariable "simpleStem_Running"' 2>/dev/null
}

unlock() {
  curl -fsS -X POST "$PORTAL/api/logic-restem/unlock" >/dev/null || true
}

ms_now() { date +%s; }

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s' "$s"
}

extract_source_url() {
  local meta="$1"
  [[ -f "$meta" ]] || return 1
  awk -F'"' '/"source_url"[[:space:]]*:/ {for (i=1;i<=NF;i++) if ($i=="source_url") { print $(i+2); exit }}' "$meta"
}

ensure_source_wav() {
  local base="$1"
  local song_dir="$STEMS_DIR/$base"
  local source_wav="$song_dir/source.wav"
  local meta="$song_dir/metadata.json"

  if [[ -f "$source_wav" ]]; then
    return 0
  fi

  if [[ ! -f "$meta" ]]; then
    log "  no metadata.json at $meta — can't determine source URL; skipping"
    return 1
  fi

  local url
  url="$(extract_source_url "$meta")"
  if [[ -z "$url" || "$url" == "null" ]]; then
    log "  metadata.json has no source_url; can't auto-fetch; skipping"
    return 1
  fi

  log "  source.wav missing; queueing Librarian ingest from $url"
  mkdir -p "$INCOMING_DIR"
  local stamp
  stamp="$(date +%Y%m%dT%H%M%S)"
  local webloc="$INCOMING_DIR/restem_${base}_${stamp}.webloc"
  local esc_url
  esc_url="$(xml_escape "$url")"
  cat > "$webloc" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>URL</key>
	<string>$esc_url</string>
</dict>
</plist>
EOF
  log "  dropped $(basename "$webloc")"

  local waited=0
  while [[ ! -f "$source_wav" ]]; do
    if (( waited >= INGEST_TIMEOUT )); then
      log "  ingest timeout (${INGEST_TIMEOUT}s); source.wav still missing"
      return 1
    fi
    sleep "$POLL_INTERVAL"
    waited=$(( waited + POLL_INTERVAL ))
    log "  waiting for Librarian to download (${waited}s)"
  done
  log "  source.wav appeared after ${waited}s"
  return 0
}

verify_outputs() {
  local base="$1" trigger_epoch="$2" v size mtime missing=0
  for v in "${VARIANTS[@]}"; do
    local f="$M4A_DIR/${base}_${v}.m4a"
    if [[ ! -f "$f" ]]; then
      log "  MISSING: $(basename "$f")"
      missing=1
      continue
    fi
    size=$(stat -f '%z' "$f" 2>/dev/null || stat -c '%s' "$f")
    mtime=$(stat -f '%m' "$f" 2>/dev/null || stat -c '%Y' "$f")
    if (( size < MIN_BOUNCE_BYTES )); then
      log "  TOO SMALL ($size bytes): $(basename "$f")"
      missing=1
    elif (( mtime < trigger_epoch )); then
      log "  STALE (mtime predates trigger): $(basename "$f")"
      missing=1
    fi
  done
  return $missing
}

process_one() {
  local base="$1" t0 elapsed lock_state http_status body
  log "▶ $base"
  t0=$(ms_now)

  local fetched_source=0
  while true; do
    http_status=$(curl -sS -o /tmp/restem_resp.json -w '%{http_code}' \
      -X POST "$PORTAL/api/song/$base/logic-restem")
    body="$(cat /tmp/restem_resp.json 2>/dev/null)"
    if [[ "$http_status" == "200" ]]; then
      log "  trigger fired"
      break
    elif [[ "$http_status" == "409" ]]; then
      lock_state=$(read_lock)
      log "  lock held by '$lock_state' — waiting ${POLL_INTERVAL}s"
      sleep "$POLL_INTERVAL"
      continue
    elif [[ "$http_status" == "404" ]] && grep -q 'source.wav not found' <<<"$body"; then
      if (( fetched_source )); then
        log "  source.wav still missing after auto-fetch — giving up"
        return 5
      fi
      log "  source.wav missing on the Performer side; attempting auto-fetch"
      if ensure_source_wav "$base"; then
        fetched_source=1
        continue
      else
        return 6
      fi
    else
      log "  trigger HTTP $http_status — skipping. body: $(head -c 200 <<<"$body")"
      return 2
    fi
  done

  while true; do
    sleep "$POLL_INTERVAL"
    elapsed=$(( $(ms_now) - t0 ))
    lock_state=$(read_lock)
    if [[ -z "$lock_state" ]]; then
      log "  lock released after ${elapsed}s — verifying outputs"
      if verify_outputs "$base" "$t0"; then
        log "  ✓ $base done"
        return 0
      else
        log "  ✗ $base completed but outputs missing/stale"
        return 3
      fi
    fi
    if (( elapsed >= MAX_PER_SONG )); then
      log "  ✗ $base timeout (${elapsed}s > ${MAX_PER_SONG}s); lock still '$lock_state'"
      if [[ "$UNLOCK_ON_TIMEOUT" == "1" ]]; then
        log "  releasing lock (UNLOCK_ON_TIMEOUT=1)"
        unlock
      fi
      return 4
    fi
    log "  still running (${elapsed}s)"
  done
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    sed -n '2,30p' "$0"
    exit 0
  fi
  local input="${1:-/dev/stdin}"
  if [[ "$input" != "/dev/stdin" && ! -r "$input" ]]; then
    echo "Can't read $input" >&2
    exit 1
  fi

  if ! command -v osascript >/dev/null; then
    echo "osascript not found — this script needs macOS with KBM Engine running" >&2
    exit 1
  fi

  if ! curl -fsS -o /dev/null --max-time 5 "$PORTAL/api/version"; then
    echo "Portal not reachable at $PORTAL — start it with ./performer.sh start" >&2
    exit 1
  fi

  log "batch_restem starting"
  log "  portal:           $PORTAL"
  log "  stems dir:        $STEMS_DIR"
  log "  m4a dir:          $M4A_DIR"
  log "  incoming dir:     $INCOMING_DIR"
  log "  poll interval:    ${POLL_INTERVAL}s"
  log "  hard timeout:     ${MAX_PER_SONG}s per song"
  log "  ingest timeout:   ${INGEST_TIMEOUT}s for missing source.wav"
  log "  min bounce size:  ${MIN_BOUNCE_BYTES} bytes"
  log ""

  local total=0 ok=0 fail=0
  declare -a failed_bases=()

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line//$'\r'/}"
    line="$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -z "$line" ]] && continue
    total=$(( total + 1 ))
    if process_one "$line"; then
      ok=$(( ok + 1 ))
    else
      fail=$(( fail + 1 ))
      failed_bases+=( "$line" )
    fi
    log ""
  done < "$input"

  log "batch_restem done — $ok ok / $fail failed / $total total"
  if (( fail > 0 )); then
    log "failed bases:"
    for b in "${failed_bases[@]}"; do log "  $b"; done
    exit 1
  fi
}

main "$@"
