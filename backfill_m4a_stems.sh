#!/usr/bin/env bash
# backfill_m4a_stems.sh — One-time pass. For every song in STEMS/, encode each
# WAV stem (vocals.wav, drums.wav, bass.wav, other.wav, bass+drums.wav) into
# an m4a sibling next to it. Idempotent: skips files whose .m4a already exists.
# After this completes, the portal can cache the small m4a stems instead of
# the 6x-larger WAVs.
#
# Why this exists: stem.sh started emitting m4a stems some time after most of
# the library was rendered, so the 176 existing songs are WAV-only. The
# Performer's ~/.bt-cache policy is "m4a only" — without m4a stems on Drive,
# the cache stays empty and playback streams 30 MB WAVs from Drive every
# time. This backfill brings the existing library in line with the design.
#
# Skipped:
#   source.wav   — full mix, not a stem channel (mixdowns serve that role)
#   *_loop*.wav  — separate pipeline; loop_regenerate.py owns those
#
# Usage:
#   ./backfill_m4a_stems.sh                  dry-run report (no work)
#   ./backfill_m4a_stems.sh --go             actually encode
#   ./backfill_m4a_stems.sh --go --force     re-encode even if outputs exist
#   ./backfill_m4a_stems.sh --go --jobs 4    parallel encode (default: 2)
#
# Encoder: ffmpeg AAC 192k 44.1 kHz. Matches what stem.sh produces for new
# songs so the library stays homogeneous.

set -uo pipefail

ROOT="${SIMPLE_STEM_ROOT:-$HOME/ClaudeDrive/simpleStem}"
STEMS_DIR="$ROOT/STEMS"
GO=0
FORCE=0
JOBS=2

while [[ $# -gt 0 ]]; do
  case "$1" in
    --go)    GO=1 ;;
    --force) FORCE=1 ;;
    --jobs)  shift; JOBS="${1:-2}" ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v ffmpeg >/dev/null || { echo "ERROR: ffmpeg required" >&2; exit 1; }
[[ -d "$STEMS_DIR" ]] || { echo "ERROR: STEMS_DIR not found: $STEMS_DIR" >&2; exit 1; }

encode_one() {
  local wav="$1"
  local m4a="${wav%.wav}.m4a"
  if (( !FORCE )) && [[ -f "$m4a" ]]; then
    return 0
  fi
  ffmpeg -nostdin -loglevel error -y \
    -i "$wav" \
    -c:a aac -b:a 192k -ar 44100 \
    "$m4a" 2>/dev/null
}
export -f encode_one
export FORCE

readarray -t WAVS < <(
  find "$STEMS_DIR" -mindepth 2 -maxdepth 2 -type f -name '*.wav' \
    -not -name 'source.wav' -not -name '*_loop*' 2>/dev/null
)
total=${#WAVS[@]}
needed=0
already=0
for w in "${WAVS[@]}"; do
  m="${w%.wav}.m4a"
  if (( FORCE )) || [[ ! -f "$m" ]]; then
    needed=$((needed + 1))
  else
    already=$((already + 1))
  fi
done

echo "STEMS_DIR: $STEMS_DIR"
echo "Total stem WAVs found (excluding source + loops): $total"
echo "Already have m4a sibling: $already"
echo "Need encoding: $needed"
echo

if (( !GO )); then
  echo "Dry run. Re-run with --go to encode (jobs: $JOBS)."
  exit 0
fi

if (( needed == 0 )); then
  echo "Nothing to do."
  exit 0
fi

echo "Encoding with $JOBS parallel jobs..."
printf '%s\n' "${WAVS[@]}" | xargs -n1 -P"$JOBS" -I{} bash -c 'encode_one "$@"' _ {}

echo
echo "Done."
echo "Verify with:"
echo "  find \"$STEMS_DIR\" -mindepth 2 -maxdepth 2 -name 'vocals.m4a' | wc -l"
