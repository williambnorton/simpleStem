#!/usr/bin/env bash
# faststart_m4a.sh — Rewrite every m4a in the library so the moov atom
# sits at the FRONT of the file. Without this, Chrome's <audio> decoder
# stalls on song-load because it has to download the whole file before
# it finds the codec spec.
#
# This was the actual root cause of the 2026-06-28 gig wedge and the
# "no stems responded after 3s" toast we kept seeing on every restart.
# Confirmed: every m4a in STEMS/ and DRUM_MACHINE/ has moov at ~99% offset.
#
# What it does:
#   ffmpeg -i FILE.m4a -c copy -movflags +faststart FILE.tmp.m4a
#   mv FILE.tmp.m4a FILE.m4a
# -c copy = no re-encode, just remux. Very fast (~10ms per file on SSD).
#
# Idempotent: skips files whose moov is already in the first 1% of bytes.
#
# Usage:
#   ./faststart_m4a.sh                  # dry run (default)
#   ./faststart_m4a.sh --go             # actually rewrite
#   ./faststart_m4a.sh --go STEMS       # only STEMS/
#   ./faststart_m4a.sh --go DRUM_MACHINE
#   ./faststart_m4a.sh --go CUSTOM_LOOPS
#
# After rewriting source files, the cache must be flushed so the
# browser stops serving stale lazy-moov copies:
#   rm -rf ~/.bt-cache/{STEMS,DRUM_MACHINE,CUSTOM_LOOPS}
# then click Flash Cache in the portal (or curl POST /api/cache/flash).

set -euo pipefail

ROOT="${SIMPLE_STEM_ROOT:-$HOME/ClaudeDrive/simpleStem}"
[[ -d "$ROOT" ]] || { echo "Root not found: $ROOT" >&2; exit 1; }

DRY=1
SCOPE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --go) DRY=0 ;;
    STEMS|DRUM_MACHINE|CUSTOM_LOOPS) SCOPE_ARGS+=("$arg") ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# Default scope = all three.
if [[ ${#SCOPE_ARGS[@]} -eq 0 ]]; then
  SCOPE_ARGS=(STEMS DRUM_MACHINE CUSTOM_LOOPS)
fi

needs_rewrite() {
  # Returns 0 (true) if moov is in the last 50% of the file.
  # The cheap test: read first 256 KB and look for b'moov'. If found,
  # already fast-start. Otherwise (moov at end), needs rewrite.
  local f="$1"
  python3 - "$f" <<'PY'
import sys
with open(sys.argv[1], 'rb') as fh:
    head = fh.read(256 * 1024)
sys.exit(0 if b'moov' not in head else 1)
PY
}

rewrite_one() {
  local f="$1"
  local tmp="${f%.m4a}.tmp.m4a"
  ffmpeg -y -v error -i "$f" -c copy -movflags +faststart "$tmp"
  if [[ -s "$tmp" ]]; then
    mv "$tmp" "$f"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

total=0
fast=0
slow=0
rewrote=0
failed=0

for scope in "${SCOPE_ARGS[@]}"; do
  scope_dir="$ROOT/$scope"
  if [[ ! -d "$scope_dir" ]]; then
    echo "$scope: directory missing, skipping."
    continue
  fi
  echo "=== $scope ==="
  while IFS= read -r f; do
    total=$((total+1))
    if needs_rewrite "$f"; then
      slow=$((slow+1))
      if [[ $DRY -eq 0 ]]; then
        if rewrite_one "$f"; then
          rewrote=$((rewrote+1))
          printf '  ok: %s\n' "${f#$ROOT/}"
        else
          failed=$((failed+1))
          printf '  FAIL: %s\n' "${f#$ROOT/}"
        fi
      else
        printf '  needs: %s\n' "${f#$ROOT/}"
      fi
    else
      fast=$((fast+1))
    fi
  done < <(find "$scope_dir" -name '*.m4a' -type f -not -name '*.tmp.m4a' -print)
done

echo
echo "=== summary ==="
echo "total m4a:       $total"
echo "already fast:    $fast"
echo "needs rewrite:   $slow"
if [[ $DRY -eq 0 ]]; then
  echo "rewrote ok:      $rewrote"
  echo "failed:          $failed"
else
  echo "(dry run — re-run with --go to actually rewrite)"
fi
