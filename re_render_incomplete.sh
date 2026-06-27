#!/bin/bash
# re_render_incomplete.sh — find every STEMS/<slug>/ that's missing one
# or more of the six stems, read its source_url from metadata.json, and
# drop a fresh .webloc into INCOMING_WEBLOC/ so the normal watcher → queue
# → stem.sh pipeline re-renders it.
#
# Idempotent. Songs that already have all six stems are skipped. Songs
# whose metadata.json has no source_url are listed for manual triage —
# the pipeline can't re-render without a URL.
#
# Re-rendering is ~10-25 min/song on CPU (Demucs htdemucs_6s) — a full
# 8-song batch takes about two hours. Run from either machine; the queue
# is shared via Drive.
#
# Usage:
#   ./re_render_incomplete.sh             # do it
#   ./re_render_incomplete.sh --dry-run   # show what WOULD be queued
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-common.sh
. "$DIR/lib-common.sh"

ROOT="$(data_root)"
STEMS_DIR="$ROOT/STEMS"
DROP="$DIR/webloc_drop.sh"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi

EXPECTED=(vocals drums bass guitar piano other)

if [[ ! -x "$DROP" ]]; then
  echo "webloc_drop.sh missing or not executable at $DROP" >&2
  exit 1
fi
if [[ ! -d "$STEMS_DIR" ]]; then
  echo "STEMS dir not found at $STEMS_DIR" >&2
  exit 1
fi

incomplete_rows=()
no_url_rows=()
ok_count=0

for song_dir in "$STEMS_DIR"/*/; do
  song_dir="${song_dir%/}"
  [[ -d "$song_dir" ]] || continue
  base="$(basename "$song_dir")"

  # Count present m4a stems.
  present=0
  for stem in "${EXPECTED[@]}"; do
    [[ -f "$song_dir/$stem.m4a" ]] && ((present++))
  done

  if (( present == 6 )); then
    ((ok_count++)) || true
    continue
  fi

  meta="$song_dir/metadata.json"
  if [[ ! -f "$meta" ]]; then
    no_url_rows+=("$base (no metadata.json — $present/6 stems)")
    continue
  fi

  # Read source_url from metadata.json. Python here because bash + JSON
  # is unpleasant and python3 is already required elsewhere in the repo.
  url="$(python3 -c "
import json, sys
try:
    d = json.load(open('$meta'))
    print(d.get('source_url') or '')
except Exception as e:
    print('', file=sys.stderr)
" 2>/dev/null || true)"

  if [[ -z "$url" ]]; then
    no_url_rows+=("$base (no source_url in metadata.json — $present/6 stems)")
    continue
  fi

  incomplete_rows+=("$base: $present/6 stems → $url")
done

echo "== Catalog scan =="
echo "complete (6 stems):  $ok_count songs"
echo "incomplete:          ${#incomplete_rows[@]} songs (have source_url, can re-queue)"
echo "no source_url:       ${#no_url_rows[@]} songs (need manual attention)"
echo

if (( ${#no_url_rows[@]} > 0 )); then
  echo "-- Skipped (no source_url) --"
  printf '  %s\n' "${no_url_rows[@]}"
  echo
fi

if (( ${#incomplete_rows[@]} == 0 )); then
  echo "Nothing to re-queue."
  exit 0
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo "-- Would re-queue (dry-run) --"
  printf '  %s\n' "${incomplete_rows[@]}"
  echo
  echo "Run without --dry-run to execute."
  exit 0
fi

echo "-- Re-queueing --"
queued=0
failed=0
for row in "${incomplete_rows[@]}"; do
  base="${row%%:*}"
  url="${row##*→ }"
  if dropped="$("$DROP" "$url" 2>&1)"; then
    echo "  ✓ $base   ($(basename "$dropped"))"
    ((queued++)) || true
  else
    echo "  ✗ $base   FAILED: $dropped" >&2
    ((failed++)) || true
  fi
done

echo
echo "Done. Re-queued $queued, failed $failed."
echo "Watch progress with:  watch -n 5 ./performer.sh status"
