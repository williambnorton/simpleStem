#!/usr/bin/env bash
# purge_failed_renders.sh — clear STEM_QUEUE/_failed/ and INCOMING_WEBLOC/*.failed.
#
# Use when the "37 render(s) failed" badge in the library header is mostly
# historical noise and you just want a clean slate. New failures will
# accrue going forward and can be triaged via the new /api/failed-renders
# endpoint + the UI page (separate work).
#
# Usage:
#   ./purge_failed_renders.sh           # dry run, lists what would be deleted
#   ./purge_failed_renders.sh --go      # actually delete

set -euo pipefail

ROOT="${SIMPLE_STEM_ROOT:-$HOME/ClaudeDrive/simpleStem}"
[[ -d "$ROOT" ]] || { echo "Root not found: $ROOT" >&2; exit 1; }

DRY=1
[[ "${1:-}" == "--go" ]] && DRY=0

count_failed_renders=0
count_failed_weblocs=0

if [[ -d "$ROOT/STEM_QUEUE/_failed" ]]; then
  count_failed_renders=$(find "$ROOT/STEM_QUEUE/_failed" -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' ')
fi
if [[ -d "$ROOT/INCOMING_WEBLOC" ]]; then
  count_failed_weblocs=$(find "$ROOT/INCOMING_WEBLOC" -name '*.failed' -type f 2>/dev/null | wc -l | tr -d ' ')
fi

echo "STEM_QUEUE/_failed/*.json     count: $count_failed_renders"
echo "INCOMING_WEBLOC/*.failed      count: $count_failed_weblocs"
echo

if [[ $DRY -eq 1 ]]; then
  echo "(dry run — re-run with --go to actually delete)"
  exit 0
fi

if [[ -d "$ROOT/STEM_QUEUE/_failed" ]]; then
  find "$ROOT/STEM_QUEUE/_failed" -name '*.json' -type f -delete 2>/dev/null
fi
if [[ -d "$ROOT/INCOMING_WEBLOC" ]]; then
  find "$ROOT/INCOMING_WEBLOC" -name '*.failed' -type f -delete 2>/dev/null
fi

echo "Purged. Library badge should now read 0/0 once the next status poll fires."
