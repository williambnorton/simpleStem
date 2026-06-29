#!/usr/bin/env bash
# purge_retired.sh — remove every STEMS/<song>/.retired/ directory.
#
# These hold the OLD loop files (drums_loop*_*bars.m4a, bass_loop*,
# drumsbass_loop*, piano_loop*, guitar_loop*, bass+drums.wav) that
# `retire_legacy_files.sh` moved aside on 2026-06-27 when client-side
# six-stem mixing replaced pre-baked loops. They're dead. Nothing
# reads them. They cost Drive sync bandwidth and confuse audits
# (e.g. the dry run of faststart_m4a.sh lists them as needing rewrite).
#
# Usage:
#   ./purge_retired.sh             # dry run, lists what would be deleted
#   ./purge_retired.sh --go        # actually delete

set -euo pipefail

ROOT="${SIMPLE_STEM_ROOT:-$HOME/ClaudeDrive/simpleStem}"
STEMS="$ROOT/STEMS"
[[ -d "$STEMS" ]] || { echo "STEMS not found at $STEMS" >&2; exit 1; }

DRY=1
[[ "${1:-}" == "--go" ]] && DRY=0

count=0
files=0
bytes=0
while IFS= read -r d; do
  count=$((count+1))
  n=$(find "$d" -type f 2>/dev/null | wc -l | tr -d ' ')
  b=$(du -sk "$d" 2>/dev/null | awk '{print $1*1024}')
  files=$((files+n))
  bytes=$((bytes+b))
  if [[ $DRY -eq 0 ]]; then
    rm -rf "$d"
    printf '  removed: %s (%d files)\n' "${d#$ROOT/}" "$n"
  else
    printf '  would remove: %s (%d files)\n' "${d#$ROOT/}" "$n"
  fi
done < <(find "$STEMS" -type d -name '.retired' -print)

echo
echo "=== summary ==="
echo "  .retired folders:  $count"
echo "  files inside:      $files"
echo "  total size:        $(numfmt --to=iec "$bytes" 2>/dev/null || echo "$bytes bytes")"
if [[ $DRY -eq 1 ]]; then
  echo "  (dry run — re-run with --go to actually delete)"
fi
