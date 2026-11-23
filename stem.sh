#!/usr/bin/env bash
# stem.sh — Fetch a song and queue it for Logic Pro stemming.
#
# Usage:
#   ./stem.sh "Song Title" "Artist Name"                       # smart search
#   ./stem.sh "Song Title" "Artist Name" <video-id-or-URL>     # explicit pick
#   ./stem.sh --source PATH "Song Title" "Artist Name"         # local audio
#
# Source selection (in order of precedence):
#   1. --source PATH given → skip YouTube; ffmpeg-convert PATH to source.wav.
#      Works with any format ffmpeg can decode (mp3, flac, m4a, wav, ...).
#   2. URL or video ID given as 3rd positional → fetch that explicit pick.
#   3. Otherwise: smart search ytsearch5:"<artist> <title> official audio"
#      and skip any result whose title contains
#      live | concert | cover | tribute | karaoke (case-insensitive).
#
# Output:
#   ~/ClaudeDrive/simpleStem/STEMS/${Title}_${Artist}/
#     ${Title}_${Artist}_SOURCE.m4a     (stereo original, AAC 256k)
#     metadata.json  source.info.json   (BPM, key, source URL, …)
#   ~/ClaudeDrive/simpleStem/LOGIC_QUEUE/${Title}_${Artist}.json
#
# The six stems, the six kit pieces and the MPL files are written later by
# the Logic Pro Stem Splitter run (the "Logic stemming queue" panel in the
# Performer), not by this script.
#
# Prereqs (macOS):
#   brew install ffmpeg yt-dlp
#   a python3 with librosa + soundfile (metadata.py: BPM and key)

set -euo pipefail

usage() {
  cat >&2 <<EOF
Usage:
  $0 [--source PATH] "Song Title" "Artist Name" [<video-id-or-URL>]

Source selection (highest precedence first):
  --source PATH    use a local audio file (any format ffmpeg can decode);
                   no YouTube fetch is performed.
  <video-id-or-URL>  3rd positional arg pins an explicit YouTube source.
  (neither)        smart search: ytsearch5:<Artist> <Title> official audio,
                   filtering live|concert|cover|tribute|karaoke titles.

Outputs (under ~/ClaudeDrive/simpleStem/):
  STEMS/<Title>_<Artist>/<Title>_<Artist>_SOURCE.m4a   stereo original, 256k AAC
  STEMS/<Title>_<Artist>/metadata.json                 BPM/key/version/…
  LOGIC_QUEUE/<Title>_<Artist>.json                    queued for Logic Pro stemming
EOF
}

LOCAL_SOURCE=""
positional=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      [[ $# -ge 2 ]] || { echo "--source requires a path" >&2; usage; exit 1; }
      LOCAL_SOURCE="$2"; shift 2 ;;
    --source=*) LOCAL_SOURCE="${1#--source=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; while [[ $# -gt 0 ]]; do positional+=("$1"); shift; done ;;
    -*) echo "Unknown flag: $1" >&2; usage; exit 1 ;;
    *)  positional+=("$1"); shift ;;
  esac
done
set -- "${positional[@]}"

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 1
fi

if [[ -n "$LOCAL_SOURCE" && ! -f "$LOCAL_SOURCE" ]]; then
  echo "--source: file not found: $LOCAL_SOURCE" >&2
  exit 1
fi
if [[ -n "$LOCAL_SOURCE" && $# -eq 3 ]]; then
  echo "--source is mutually exclusive with the <video-id-or-URL> arg." >&2
  exit 1
fi

TITLE="$1"
ARTIST="$2"
URL_OVERRIDE="${3:-}"

# Filesystem-safe slug: ASCII alnum + underscore/hyphen only.
# Everything else (spaces, parens, quotes, punctuation, unicode bytes) -> '_',
# then collapsed and trimmed.
slugify() {
  LC_ALL=C printf '%s' "$1" \
    | tr -c 'A-Za-z0-9_-' '_' \
    | tr -s '_' \
    | sed 's/^_//; s/_$//'
}
# Ensure a WAV file is at 48 kHz. No-op if already 48 kHz; otherwise
# resamples in place via ffmpeg (writes to a tmp file then renames).
# Required because yt-dlp preserves YouTube's native rate (usually 48 kHz,
# sometimes not).
ensure_48k() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  local rate
  rate="$(ffprobe -v error -select_streams a:0 \
            -show_entries stream=sample_rate \
            -of default=nw=1:nk=1 "$f" 2>/dev/null || echo unknown)"
  if [[ "$rate" != "48000" ]]; then
    echo ">> Resampling $(basename "$f") from ${rate} Hz to 48000 Hz"
    local tmp="${f%.wav}.48k.wav"
    ffmpeg -y -loglevel error -i "$f" -ar 48000 "$tmp"
    mv "$tmp" "$f"
  fi
}

SLUG_TITLE="$(slugify "$TITLE")"
SLUG_ARTIST="$(slugify "$ARTIST")"
if [[ -z "$SLUG_TITLE" || -z "$SLUG_ARTIST" ]]; then
  echo "Title/Artist produced an empty slug after sanitizing." >&2
  exit 1
fi

# Data root: honor $SIMPLE_STEM_ROOT (exported by performer/queue_runner), else
# ~/ClaudeDrive/simpleStem, else the Google Drive CloudStorage path. Code may
# live elsewhere (a git clone) but data lives here.
if [[ -n "${SIMPLE_STEM_ROOT:-}" ]]; then
  DATA_ROOT="$SIMPLE_STEM_ROOT"
elif [[ -d "$HOME/ClaudeDrive/simpleStem" ]]; then
  DATA_ROOT="$HOME/ClaudeDrive/simpleStem"
else
  DATA_ROOT="$HOME/ClaudeDrive/simpleStem"
  for gd in "$HOME/Library/CloudStorage"/GoogleDrive-*/My\ Drive/ClaudeDrive/simpleStem; do
    [[ -d "$gd" ]] && DATA_ROOT="$gd" && break
  done
fi

OUT_DIR="$DATA_ROOT/STEMS/${SLUG_TITLE}_${SLUG_ARTIST}"
mkdir -p "$OUT_DIR"

# Prereq check
missing=0
for cmd in ffmpeg yt-dlp; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing: $cmd" >&2
    missing=1
  fi
done
if [[ $missing -eq 1 ]]; then
  cat >&2 <<'EOF'
Install with:
  brew install ffmpeg yt-dlp
EOF
  exit 1
fi

# Python with librosa + soundfile, for metadata.py (BPM and key). These
# libraries live in a pipx environment on the Performer (same candidates as
# performer.sh); python3 on PATH is the fallback.
VENV_PY=""
for _py in "$HOME/.local/pipx/venvs/demucs/bin/python3" \
           "$HOME/.local/pipx/venvs/demucs/bin/python" \
           "$(command -v python3 || true)"; do
  [[ -n "$_py" && -x "$_py" ]] || continue
  if "$_py" -c 'import librosa, soundfile' 2>/dev/null; then VENV_PY="$_py"; break; fi
done
if [[ -z "$VENV_PY" ]]; then
  echo "No python with librosa + soundfile found (needed for BPM and key)." >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SRC="${OUT_DIR}/source.wav"
# Songs keep only the m4a original at rest (2026-11-01, CONTRACTS F-1/F-9);
# source.wav is a working file, rebuilt from it on a re-stem and deleted at
# the end of this script.
SOURCE_M4A="$OUT_DIR/$(basename "$OUT_DIR")_SOURCE.m4a"

# 1) Get source.wav. Three branches:
#    (a) source.wav already present → skip entirely (idempotent re-runs)
#    (b) --source PATH given → ffmpeg-convert the local file to source.wav
#    (c) URL_OVERRIDE given → yt-dlp that explicit YouTube URL/ID
#    (d) otherwise → yt-dlp smart search
# Drive-sync race guard (2026-07-02): the Librarian downloads source.wav
# BEFORE writing the queue job, but the tiny job JSON syncs to the Performer
# ahead of the ~50 MB wav. If we start downloading immediately we end up with
# our own copy AND the Librarian's — Drive keeps both as "source (1).wav".
# When a URL job arrives and source.wav isn't here yet, poll briefly for the
# Librarian's copy to land before falling back to our own download.
# Tune/disable: SIMPLE_STEM_SOURCE_WAIT=0 (seconds; default 90).
SOURCE_WAIT="${SIMPLE_STEM_SOURCE_WAIT:-90}"
if [[ ! -f "$SRC" && ! -f "$SOURCE_M4A" && -z "$LOCAL_SOURCE" && -n "$URL_OVERRIDE" && "$SOURCE_WAIT" -gt 0 ]]; then
  _waited=0
  while [[ ! -f "$SRC" && $_waited -lt $SOURCE_WAIT ]]; do
    (( _waited == 0 )) && echo ">> source.wav not synced yet — waiting up to ${SOURCE_WAIT}s for the Librarian's copy…"
    sleep 5; _waited=$(( _waited + 5 ))
  done
  if [[ -f "$SRC" ]]; then
    echo ">> source.wav appeared after ${_waited}s — using the Librarian's copy."
    # Give the sync a beat to finish writing companions (info.json).
    sleep 2
  else
    echo ">> source.wav still absent after ${SOURCE_WAIT}s — downloading our own copy."
  fi
fi

if [[ -f "$SRC" ]]; then
  echo ">> source.wav already present, skipping import/download."
elif [[ -f "$SOURCE_M4A" ]]; then
  echo ">> Rebuilding working source.wav from $(basename "$SOURCE_M4A") (no download)."
  ffmpeg -y -loglevel error -i "$SOURCE_M4A" -ac 2 -c:a pcm_s16le "$SRC" </dev/null
  if [[ ! -f "$SRC" ]]; then
    echo "ffmpeg failed to decode $SOURCE_M4A" >&2
    exit 1
  fi
elif [[ -n "$LOCAL_SOURCE" ]]; then
  echo ">> Importing local source: $LOCAL_SOURCE"
  # ffmpeg handles any input format → PCM 16-bit stereo WAV.
  # ensure_48k later normalizes the sample rate, so we don't force -ar here.
  ffmpeg -y -loglevel error -i "$LOCAL_SOURCE" -ac 2 -c:a pcm_s16le "$SRC"
  if [[ ! -f "$SRC" ]]; then
    echo "ffmpeg failed to produce $SRC" >&2
    exit 1
  fi
elif [[ -n "$URL_OVERRIDE" ]]; then
  case "$URL_OVERRIDE" in
    http*)   TARGET="$URL_OVERRIDE" ;;
    *)       TARGET="https://www.youtube.com/watch?v=$URL_OVERRIDE" ;;
  esac
  echo ">> Downloading explicit pick: $TARGET"
  yt-dlp \
    --no-playlist \
    --extract-audio --audio-format wav --audio-quality 0 \
    --write-info-json \
    -o "${OUT_DIR}/source.%(ext)s" \
    "$TARGET"
  if [[ ! -f "$SRC" ]]; then
    echo "Download failed: $SRC not found" >&2
    exit 1
  fi
else
  QUERY="ytsearch5:${ARTIST} ${TITLE} official audio"
  echo ">> Smart search: $QUERY (filtering live/concert/cover/tribute/karaoke)"
  # yt-dlp exits 101 when --max-downloads is reached, even on success.
  # Tolerate that specific rc here; the source.wav existence check below
  # is the real success gate.
  set +e
  yt-dlp \
    --no-playlist \
    --extract-audio --audio-format wav --audio-quality 0 \
    --match-filter "title!~=(?i)\\b(live|concert|cover|tribute|karaoke)\\b" \
    --max-downloads 1 \
    --write-info-json \
    -o "${OUT_DIR}/source.%(ext)s" \
    "$QUERY"
  rc=$?
  set -e
  if [[ $rc -ne 0 && $rc -ne 101 ]]; then
    echo "yt-dlp failed with rc=$rc" >&2
    exit $rc
  fi
  if [[ ! -f "$SRC" ]]; then
    echo "Download failed: $SRC not found" >&2
    exit 1
  fi
fi

# Normalize source.wav to 48 kHz in all three branches above (new download,
# explicit pick, and skip-because-already-present). This also catches old
# 44.1 kHz source.wav files left over from before the 48 kHz switch.
ensure_48k "$SRC"

# 1b) Write metadata.json (BPM, key, version, lyrics+chords search URLs,
#     yt-dlp's true title/uploader/upload date). Idempotent —
#     metadata.py skips if metadata.json already exists.
META_SCRIPT="$SCRIPT_DIR/metadata.py"
if [[ -f "$META_SCRIPT" ]]; then
  YT_INFO="$OUT_DIR/source.info.json"
  META_ARGS=( --dir "$OUT_DIR" --title "$TITLE" --artist "$ARTIST" )
  [[ -f "$YT_INFO" ]] && META_ARGS+=( --info-json "$YT_INFO" )
  [[ -n "$URL_OVERRIDE" ]] && META_ARGS+=( --url "$URL_OVERRIDE" )
  echo ">> Building metadata.json…"
  "$VENV_PY" "$META_SCRIPT" "${META_ARGS[@]}" || \
    echo "   metadata.py failed (continuing)" >&2
fi

# 2) Queue for Logic Pro stemming. The song folder gets its stereo original
#    as <folder>_SOURCE.m4a and an entry in LOGIC_QUEUE/<folder>.json. Claude
#    runs Logic Pro's Stem Splitter over the queued folders once Bill hands
#    the Mac over from the Performer (the "Logic stemming queue" panel). The
#    six stems, the kit pieces and the MPL files are written by that run.
if [[ -f "$SOURCE_M4A" ]]; then
  echo ">> $(basename "$SOURCE_M4A") present, skipping."
else
  echo ">> Encoding $(basename "$SOURCE_M4A") (stereo original, AAC 256k + faststart + brand mp42)"
  if ffmpeg -y -loglevel error -i "$SRC" -vn -ac 2 -c:a aac -b:a 256k \
            -movflags +faststart -brand mp42 "${SOURCE_M4A%.m4a}.tmp.m4a" </dev/null; then
    mv -f "${SOURCE_M4A%.m4a}.tmp.m4a" "$SOURCE_M4A"
  else
    rm -f "${SOURCE_M4A%.m4a}.tmp.m4a"
    echo "!! could not encode $(basename "$SOURCE_M4A") — not queued for Logic stemming" >&2
    exit 1
  fi
fi
LOGIC_QUEUE_DIR="$DATA_ROOT/LOGIC_QUEUE"
LQ_FOLDER="$(basename "$OUT_DIR")"
mkdir -p "$LOGIC_QUEUE_DIR"
python3 - "$LOGIC_QUEUE_DIR/$LQ_FOLDER.json" "$LQ_FOLDER" "$OUT_DIR/metadata.json" <<'PYQ'
import json, sys, time
out, folder, meta = sys.argv[1:4]
m = {}
try:
  m = json.load(open(meta))
except Exception:
  pass
json.dump({'folder': folder, 'title': m.get('title'), 'artist': m.get('artist'), 'source_url': m.get('source_url'),
         'queued_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'queued_by': 'stem.sh'}, open(out, 'w'), indent=1)
PYQ
if [[ "${KEEP_SOURCE_WAV:-0}" != "1" ]]; then
  rm -f "$SRC" "$OUT_DIR"/source\ *.wav 2>/dev/null || true
fi
echo ">> Queued for Logic Pro stemming: LOGIC_QUEUE/$LQ_FOLDER.json"
echo ">> Folder: $OUT_DIR"
