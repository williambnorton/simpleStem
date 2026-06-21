#!/usr/bin/env bash
# fetch_clip.sh -- download audio from a URL into CUSTOM_LOOPS/raw_<name>.m4a
#
# Mirrors the in-App URL-snip workflow now that it has been retired from the
# portal. yt-dlp does the fetch (any of its many supported sources work --
# YouTube, Vimeo, SoundCloud, Bandcamp, etc.). ffmpeg crops to the requested
# start + duration window (so you don't have to download an hour for a 60s
# snippet).
#
# Usage:
#   ./fetch_clip.sh --url "<URL>" [--start <sec>] [--duration <sec>] \
#                    [--name <basename>] [--root <simpleStem dir>]
#
# Defaults:
#   --start    : 0, or auto-parsed from ?t=, &t=, #t=, ?start= in the URL
#   --duration : (all) -- fetch from start to end of source
#   --name     : derived from the URL's video id
#   --root     : $HOME/ClaudeDrive/simpleStem
#
# Output: $ROOT/CUSTOM_LOOPS/raw_<name>_t<start>_d<dur>.m4a
# Trim with ./trim_clip.sh once you've decided your IN/OUT.

set -euo pipefail

URL=""
START=""
DURATION=""
NAME=""
ROOT="${HOME}/ClaudeDrive/simpleStem"

while [ $# -gt 0 ]; do
  case "$1" in
    --url)      URL="$2"; shift 2 ;;
    --start)    START="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --name)     NAME="$2"; shift 2 ;;
    --root)     ROOT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 64 ;;
  esac
done

if [ -z "$URL" ]; then
  echo "Need --url <video URL>" >&2
  exit 64
fi
if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "yt-dlp not on PATH. brew install yt-dlp" >&2
  exit 65
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not on PATH. brew install ffmpeg" >&2
  exit 65
fi

CUSTOM_LOOPS_DIR="${ROOT}/CUSTOM_LOOPS"
mkdir -p "$CUSTOM_LOOPS_DIR"

# Auto-parse start time from URL if not given.
if [ -z "$START" ]; then
  case "$URL" in
    *\?t=*|*\&t=*|*\#t=*)
      raw="$(printf '%s\n' "$URL" | grep -oE '[?&#]t=[0-9hms]+' | head -1 | sed 's/^[?&#]t=//')"
      if [ -n "$raw" ]; then
        if [[ "$raw" =~ ^[0-9]+$ ]]; then
          START="$raw"
        else
          h=$(printf '%s' "$raw" | grep -oE '[0-9]+h' | tr -d 'h' || true); h=${h:-0}
          m=$(printf '%s' "$raw" | grep -oE '[0-9]+m' | tr -d 'm' || true); m=${m:-0}
          s=$(printf '%s' "$raw" | grep -oE '[0-9]+s' | tr -d 's' || true); s=${s:-0}
          START=$(( h * 3600 + m * 60 + s ))
        fi
      fi
      ;;
    *\?start=*|*\&start=*)
      START="$(printf '%s\n' "$URL" | grep -oE '[?&]start=[0-9]+' | head -1 | sed 's/^[?&]start=//')"
      ;;
  esac
fi
START=${START:-0}

# Derive a videoId-ish tag for the filename when --name not given.
if [ -z "$NAME" ]; then
  case "$URL" in
    *youtube.com/watch?v=*|*youtube.com/watch?*v=*)
      NAME="$(printf '%s\n' "$URL" | grep -oE '[?&]v=[A-Za-z0-9_-]+' | head -1 | sed 's/^[?&]v=//')" ;;
    *youtu.be/*)
      NAME="$(printf '%s\n' "$URL" | sed -E 's|.*youtu\.be/([A-Za-z0-9_-]+).*|\1|')" ;;
    *twitter.com/*status/*|*x.com/*status/*)
      NAME="tw$(printf '%s\n' "$URL" | grep -oE 'status/[0-9]+' | head -1 | sed 's/^status\///')" ;;
    *vimeo.com/[0-9]*)
      NAME="vm$(printf '%s\n' "$URL" | grep -oE 'vimeo\.com/[0-9]+' | head -1 | sed 's|vimeo.com/||')" ;;
    *)
      NAME="$(printf '%s\n' "$URL" | sed -E 's|.*/||; s|[^A-Za-z0-9_-]||g' | cut -c1-24)" ;;
  esac
  [ -z "$NAME" ] && NAME="clip"
fi

# Decide the end second + filename tag.
if [ -z "$DURATION" ] || [ "$DURATION" = "0" ]; then
  DTAG="dall"
  END=""
else
  DTAG="d${DURATION}"
  END=$(( START + DURATION ))
fi
OUTNAME="raw_${NAME}_t${START}_${DTAG}.m4a"
OUTPATH="${CUSTOM_LOOPS_DIR}/${OUTNAME}"
TMP="${CUSTOM_LOOPS_DIR}/.tmp_fetch_clip_$$.m4a"
trap 'rm -f "$TMP"' EXIT

echo ">> Fetching $URL"
echo "   start=${START}s  duration=${DURATION:-(all)}  -> $OUTNAME"

# Stage 1: download the whole audio. Two-stage path avoids the YouTube 403
# we saw when --download-sections forced ffmpeg to fetch a signed URL.
yt-dlp \
  -x \
  --audio-format m4a \
  --audio-quality 0 \
  --no-cache-dir \
  --no-warnings \
  --no-playlist \
  -o "$TMP" \
  "$URL"

if [ ! -f "$TMP" ]; then
  echo "yt-dlp completed but no output file at $TMP" >&2
  exit 1
fi

# Stage 2: ffmpeg crops to [START, END]. If END is empty (DURATION=all), -to
# is skipped so the full audio from START to end-of-source is kept.
FF_ARGS=(-y -ss "$START")
[ -n "$END" ] && FF_ARGS+=(-to "$END")
FF_ARGS+=(-i "$TMP" -c copy -movflags +faststart "$OUTPATH")

ffmpeg "${FF_ARGS[@]}" </dev/null >/dev/null 2>&1
if [ ! -f "$OUTPATH" ]; then
  echo "ffmpeg produced no output" >&2
  exit 1
fi

ls -lh "$OUTPATH"
echo "OK: $OUTPATH"
echo "Next: ./trim_clip.sh \"$OUTPATH\" --start <sec> --end <sec> --name <basename>"
