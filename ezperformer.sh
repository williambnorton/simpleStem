#!/usr/bin/env bash
# ezperformer.sh — bundle every _-V-G m4a into an iPad-friendly folder.
#
# Walks $DATA_ROOT/M4A/ for *_-V-G.m4a files, reads each song's metadata.json
# from $DATA_ROOT/STEMS/<base>/ to get a clean "Title - Artist.m4a" filename,
# and copies the file into the EZPerformer folder for AirDrop / Files-app
# import to an iPad.
#
# Idempotent: skips destinations that already exist with the same size, so
# you can re-run after stem.sh has produced new -V-G files and it picks up
# only what's new.
#
# Usage:
#   ./ezperformer.sh                       # defaults to $DATA_ROOT/EZPerformer
#   ./ezperformer.sh /path/to/destination  # custom destination
#
# Naming rules:
#   - If metadata.json exists and has title + artist, the destination filename
#     is "<title> - <artist>.m4a" with characters filesystem-unsafe on iPadOS
#     stripped (/ \ : * ? " < > |).
#   - If metadata is missing or empty, falls back to the slug with underscores
#     converted to spaces (e.g. "Harvest Moon Neil Young.m4a") — readable but
#     less ideal.

set -uo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$BASE_DIR/lib-common.sh" 2>/dev/null || true
DATA_ROOT="$({ command -v data_root >/dev/null 2>&1 && data_root; } || echo "$HOME/ClaudeDrive/simpleStem")"
M4A_DIR="$DATA_ROOT/M4A"
STEMS_DIR="$DATA_ROOT/STEMS"
DEST="${1:-$DATA_ROOT/EZPerformer}"

if [[ ! -d "$M4A_DIR" ]]; then
  echo "Can't find M4A dir at $M4A_DIR" >&2
  exit 1
fi

mkdir -p "$DEST"

extract_meta_field() {
  local meta="$1" key="$2"
  [[ -f "$meta" ]] || return 1
  awk -v key="$key" -F'"' '
    $0 ~ "\"" key "\"[[:space:]]*:" {
      for (i = 1; i <= NF; i++) if ($i == key) { print $(i + 2); exit }
    }' "$meta"
}

shopt -s nullglob
mapfile -t files < <(find "$M4A_DIR" -maxdepth 1 -type f -name '*_-V-G.m4a' | sort)
total=${#files[@]}

if (( total == 0 )); then
  echo "No *_-V-G.m4a files found in $M4A_DIR"
  exit 0
fi

echo "Found $total -V-G m4a files in $M4A_DIR"
echo "Copying to $DEST"
echo

copied=0
skipped=0
fallback=0

for f in "${files[@]}"; do
  fname="$(basename "$f")"
  base="${fname%_-V-G.m4a}"

  meta="$STEMS_DIR/$base/metadata.json"
  title="$(extract_meta_field "$meta" title 2>/dev/null)"
  artist="$(extract_meta_field "$meta" artist 2>/dev/null)"

  if [[ -n "$title" && "$title" != "null" && -n "$artist" && "$artist" != "null" ]]; then
    title_safe="$(printf '%s' "$title" | tr -d '/\\:*?"<>|')"
    artist_safe="$(printf '%s' "$artist" | tr -d '/\\:*?"<>|')"
    clean="${title_safe} - ${artist_safe}.m4a"
  else
    clean="${base//_/ }.m4a"
    fallback=$((fallback+1))
  fi

  dst="$DEST/$clean"

  if [[ -f "$dst" ]]; then
    src_sz=$(stat -f '%z' "$f" 2>/dev/null || stat -c '%s' "$f" 2>/dev/null || echo 0)
    dst_sz=$(stat -f '%z' "$dst" 2>/dev/null || stat -c '%s' "$dst" 2>/dev/null || echo 0)
    if [[ "$src_sz" == "$dst_sz" ]]; then
      skipped=$((skipped+1))
      continue
    fi
  fi

  if cp "$f" "$dst"; then
    copied=$((copied+1))
  else
    echo "  ! copy failed: $fname -> $clean" >&2
  fi
done
shopt -u nullglob

echo
echo "Done."
echo "  copied:                  $copied"
echo "  skipped (already there): $skipped"
echo "  used slug fallback:      $fallback"
echo "  total examined:          $total"
echo "  destination:             $DEST"
