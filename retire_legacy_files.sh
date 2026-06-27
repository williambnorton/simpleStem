#!/bin/bash
# retire_legacy_files.sh — move the now-unused mixdown + loop artefacts
# aside so the live system stops paying Drive sync cost for dead files.
#
# What gets moved (NOT deleted — reversible escape hatch):
#   ~/ClaudeDrive/simpleStem/M4A/                 → M4A.retired-YYYYMMDD-HHMM/
#   STEMS/<song>/bass+drums.wav                   → STEMS/<song>/.retired/
#   STEMS/<song>/*_loop*_*bars.{wav,m4a}          → STEMS/<song>/.retired/
#   STEMS/<song>/loops/ (whole folder)            → STEMS/<song>/.retired/loops/
#
# After verifying nothing broke (a few song loads + a render), purge with:
#   rm -rf ~/ClaudeDrive/simpleStem/M4A.retired-*
#   find ~/ClaudeDrive/simpleStem/STEMS -name .retired -prune -exec rm -rf {} +
#
# Run from EITHER ~/simpleStem-code or ~/ClaudeDrive/simpleStem.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Allow lib-common.sh to live next to this script OR one up (when invoked
# from the Drive mirror). Either path is fine — both resolve to the same
# data_root() output.
if [[ -f "$DIR/lib-common.sh" ]]; then
  . "$DIR/lib-common.sh"
else
  echo "Missing lib-common.sh next to retire_legacy_files.sh" >&2
  exit 1
fi

ROOT="$(data_root)"
STAMP="$(date +%Y%m%d-%H%M)"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi

note() {
  if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] $*"; else echo "$*"; fi
}

mv_aside() {
  local src="$1" dst="$2"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] mv  $src  $dst"
  else
    mkdir -p "$(dirname "$dst")"
    mv -n "$src" "$dst"
  fi
}

# 1. M4A directory → M4A.retired-STAMP/
M4A_SRC="$ROOT/M4A"
M4A_DST="$ROOT/M4A.retired-$STAMP"
if [[ -d "$M4A_SRC" ]]; then
  note "Found $M4A_SRC — retiring to $(basename "$M4A_DST")"
  if [[ $DRY_RUN -eq 0 ]]; then
    mv "$M4A_SRC" "$M4A_DST"
  fi
else
  note "No M4A/ to retire (already gone)."
fi

# 2. Per-song loop artefacts inside every STEMS/<song>/ folder.
STEMS_DIR="$ROOT/STEMS"
if [[ -d "$STEMS_DIR" ]]; then
  shopt -s nullglob
  moved_songs=0
  for song_dir in "$STEMS_DIR"/*/; do
    song_dir="${song_dir%/}"
    [[ -d "$song_dir" ]] || continue
    bn="$(basename "$song_dir")"

    # Collect matches first so we can move them as a batch.
    targets=()
    [[ -e "$song_dir/bass+drums.wav" ]] && targets+=("$song_dir/bass+drums.wav")
    for f in "$song_dir"/*_loop*_*bars.wav "$song_dir"/*_loop*_*bars.m4a; do
      [[ -e "$f" ]] && targets+=("$f")
    done
    [[ -d "$song_dir/loops" ]] && targets+=("$song_dir/loops")

    if (( ${#targets[@]} == 0 )); then continue ; fi

    retired_dir="$song_dir/.retired"
    note "Retiring ${#targets[@]} artefact(s) in $bn"
    for t in "${targets[@]}"; do
      mv_aside "$t" "$retired_dir/$(basename "$t")"
    done
    ((moved_songs++)) || true
  done
  shopt -u nullglob
  note "Songs touched: $moved_songs"
else
  note "No STEMS/ directory at $STEMS_DIR — nothing to sweep."
fi

note ""
note "Done. Reversible — everything moved aside, nothing deleted."
note "After verifying playback + a render look healthy, purge with:"
note "  rm -rf $ROOT/M4A.retired-*"
note "  find $ROOT/STEMS -name .retired -prune -exec rm -rf {} +"
