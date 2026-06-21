#!/usr/bin/env bash
# trim_clip.sh -- crop a raw_*.m4a (or any m4a) to start/end seconds, named.
#
# Mirrors the in-App trim editor's save action: stream-copy (no re-encode)
# from start_sec to end_sec into a named final file in CUSTOM_LOOPS/. The
# source file is left intact -- delete it manually when you're done sampling.
#
# Usage:
#   ./trim_clip.sh <source.m4a> --start <sec> --end <sec> --name <basename> \
#                  [--root <simpleStem dir>] [--delete-source]
#
# Example:
#   ./trim_clip.sh CUSTOM_LOOPS/raw_Oy0zq8YzY9w_t0_dall.m4a \
#                  --start 4.2 --end 8.6 --name fake_quote_bowie
#
# Output: $ROOT/CUSTOM_LOOPS/<name>.m4a

set -euo pipefail

SRC=""
START=""
END=""
NAME=""
ROOT="${HOME}/ClaudeDrive/simpleStem"
DELETE_SOURCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --start)         START="$2"; shift 2 ;;
    --end)           END="$2";   shift 2 ;;
    --name)          NAME="$2";  shift 2 ;;
    --root)          ROOT="$2";  shift 2 ;;
    --delete-source) DELETE_SOURCE=1; shift ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0 ;;
    -*)
      echo "Unknown arg: $1" >&2
      exit 64 ;;
    *)
      if [ -z "$SRC" ]; then SRC="$1"; shift
      else echo "Multiple source files? Only one." >&2; exit 64; fi ;;
  esac
done

[ -z "$SRC"   ] && { echo "Need a source m4a path as the first argument." >&2; exit 64; }
[ -z "$START" ] && { echo "Need --start <sec>" >&2; exit 64; }
[ -z "$END"   ] && { echo "Need --end <sec>"   >&2; exit 64; }
[ -z "$NAME"  ] && { echo "Need --name <basename>" >&2; exit 64; }
[ -f "$SRC"   ] || { echo "Source not found: $SRC" >&2; exit 65; }
command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not on PATH" >&2; exit 65; }

# Sanitize the name into a slug. Drop any extension the user typed in.
SLUG="$(printf '%s\n' "$NAME" | sed -E 's/\.m4a$//I; s/[^A-Za-z0-9_-]+/_/g; s/^_+|_+$//g' | cut -c1-40)"
[ -z "$SLUG" ] && SLUG="clip"

OUTDIR="${ROOT}/CUSTOM_LOOPS"
mkdir -p "$OUTDIR"
OUT="${OUTDIR}/${SLUG}.m4a"

if [ -e "$OUT" ]; then
  echo "'$OUT' exists. Refusing to overwrite -- pick a different --name." >&2
  exit 66
fi

DUR=$(awk "BEGIN{printf \"%.2f\", $END - $START}")
echo ">> ${SRC} -> ${OUT}"
echo "   start=${START}s  end=${END}s  dur=${DUR}s"

ffmpeg -y -ss "$START" -to "$END" -i "$SRC" -c copy -movflags +faststart "$OUT" \
       </dev/null >/dev/null 2>&1

if [ ! -f "$OUT" ]; then
  echo "ffmpeg produced no output" >&2
  exit 1
fi
ls -lh "$OUT"

if [ "$DELETE_SOURCE" -eq 1 ]; then
  rm -f "$SRC"
  echo "Removed $SRC"
fi
echo "OK: $OUT"
