#!/usr/bin/env bash
# backfill_stem_m4as.sh — encode m4a versions of every existing stem WAV.
#
# New songs get their stem m4as as part of stem.sh's pipeline. This script
# converts the 200-odd already-stemmed songs to the new format in one batch
# without re-running Demucs.
#
# Walks every STEMS/<base>/ folder and, for each of the 6 stems that has a
# WAV but no matching m4a, runs ffmpeg -c:a aac -b:a 256k. Skips folders
# where m4as are already present.
#
# Usage:
#   ./backfill_stem_m4as.sh                # default: keep WAVs
#   DELETE_STEM_WAVS=1 ./backfill_stem_m4as.sh
#                                           # delete WAVs after encoding
#                                           # (saves ~80% of stems disk;
#                                           # WAVs needed only if you plan
#                                           # to re-run loop_detect.py)

set -uo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$BASE_DIR/lib-common.sh" 2>/dev/null || true
DATA_ROOT="$({ command -v data_root >/dev/null 2>&1 && data_root; } || echo "$HOME/ClaudeDrive/simpleStem")"
STEMS_DIR="$DATA_ROOT/STEMS"

if [[ ! -d "$STEMS_DIR" ]]; then
  echo "STEMS dir not found at $STEMS_DIR" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg not found on PATH" >&2
  exit 1
fi

echo "Scanning $STEMS_DIR"
echo

total_folders=0
folders_touched=0
encoded=0
skipped=0
deleted_wavs=0

for folder in "$STEMS_DIR"/*/; do
  [[ -d "$folder" ]] || continue
  total_folders=$((total_folders+1))
  base="$(basename "$folder")"
  touched_this=0
  for stem in vocals drums bass other piano guitar; do
    wav="$folder/${stem}.wav"
    m4a="$folder/${stem}.m4a"
    if [[ ! -f "$wav" ]]; then
      continue
    fi
    if [[ -f "$m4a" ]]; then
      skipped=$((skipped+1))
      continue
    fi
    if (( touched_this == 0 )); then
      echo "[$base]"
      touched_this=1
    fi
    echo "  encoding ${stem}.m4a"
    if ffmpeg -y -loglevel error -i "$wav" -c:a aac -b:a 256k "$m4a"; then
      encoded=$((encoded+1))
    else
      echo "  ! ffmpeg failed for ${stem}.wav" >&2
    fi
  done
  if (( touched_this == 1 )); then
    folders_touched=$((folders_touched+1))
  fi

  if [[ "${DELETE_STEM_WAVS:-0}" == "1" ]]; then
    for stem in vocals drums bass other piano guitar; do
      wav="$folder/${stem}.wav"
      m4a="$folder/${stem}.m4a"
      if [[ -f "$wav" && -f "$m4a" ]]; then
        rm -f "$wav" && deleted_wavs=$((deleted_wavs+1))
      fi
    done
  fi
done

echo
echo "Done."
echo "  folders examined:         $total_folders"
echo "  folders with new m4as:    $folders_touched"
echo "  stem files encoded:       $encoded"
echo "  stem files already m4a:   $skipped"
if [[ "${DELETE_STEM_WAVS:-0}" == "1" ]]; then
  echo "  stem WAVs deleted:        $deleted_wavs"
else
  echo "  WAVs retained (set DELETE_STEM_WAVS=1 to delete)"
fi
