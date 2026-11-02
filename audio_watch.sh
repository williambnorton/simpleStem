#!/usr/bin/env bash
# audio_watch.sh — Watch INCOMING_AUDIO for dropped audio files (m4a, mp3,
# wav, aiff, flac, ogg, opus) and ingest each one into the library.
#
# Runs on the LIBRARIAN (daemonized by librarian.sh as the `audiowatch`
# service). This is the local-file sibling of webloc_watch.sh: where that
# script turns YouTube URLs into renders, this one turns files Bill already
# has into renders, and additionally keeps a stereo fast-start m4a of each
# on Drive so Easy Performer on the iPad can import it.
#
# Per file:
#   1. Wait for the file's size to go stable (Drive may still be syncing it).
#   2. Read title/artist from the audio tags (ffprobe); fall back to an
#      "Artist - Title" filename split; fall back to the bare filename.
#   3. base = song_base(title, artist)  — the same canonical key stem.sh uses.
#   4. Skip if STEMS/<base>/source.wav already exists (already ingested).
#   5. ffmpeg → 48 kHz stereo source.wav, staged into STEMS/<base>/ so
#      stem.sh skips its own download entirely.
#   6. ffmpeg → AUDIO_SOURCES/<base>.m4a (AAC 256k, moov-first per the m4a
#      mandate) — the iPad / Easy Performer copy, also what the Librarian
#      view plays for a listen-check.
#   7. metadata.py (BPM/key via the demucs venv) writes metadata.json; if
#      that venv is unavailable the ingest still proceeds with minimal
#      metadata (BPM/key empty — a null-BPM song stays visible by mandate).
#   8. The metadata json is moved into STEM_QUEUE/<base>.json — from there
#      the Performer's queue_runner renders the six stems exactly as it
#      does for a YouTube job.
#   9. The original dropped file moves to INCOMING_AUDIO/_ingested/ (kept,
#      purgeable later); failures rename to <name>.failed in place.
#
# Usage:
#   ./audio_watch.sh            # watch forever (fswatch)
#   ./audio_watch.sh --once     # process what's already there, then exit
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/lib-common.sh"
BASE="$(data_root)"
INCOMING="$BASE/INCOMING_AUDIO"
SOURCES="$BASE/AUDIO_SOURCES"
QUEUE="$BASE/STEM_QUEUE"
STEMS="$BASE/STEMS"
META_SCRIPT="$SCRIPT_DIR/metadata.py"

mkdir -p "$INCOMING" "$INCOMING/_ingested" "$SOURCES" "$QUEUE" "$STEMS"

command -v ffmpeg  >/dev/null 2>&1 || { echo "Missing ffmpeg" >&2; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo "Missing ffprobe" >&2; exit 1; }

# Same demucs-venv python resolution webloc_watch.sh uses; empty is
# tolerated (minimal-metadata fallback below).
DEMUCS_BIN="$(command -v demucs || true)"
VENV_PY=""
if [[ -n "$DEMUCS_BIN" ]]; then
  _target="$DEMUCS_BIN"
  while [[ -L "$_target" ]]; do
    _link="$(readlink "$_target")"
    case "$_link" in
      /*) _target="$_link" ;;
      *)  _target="$(dirname "$_target")/$_link" ;;
    esac
  done
  _venv_bin="$(dirname "$_target")"
  [[ -x "$_venv_bin/python3" ]] && VENV_PY="$_venv_bin/python3"
fi

is_audio() {
  case "$(printf '%s' "${1##*.}" | tr '[:upper:]' '[:lower:]')" in
    m4a|mp3|wav|aif|aiff|flac|ogg|opus) return 0 ;;
    *) return 1 ;;
  esac
}

# Wait until the file stops growing (Drive sync / a slow copy). Two equal
# sizes 3s apart = stable. Gives up after 5 minutes and proceeds anyway.
wait_stable() {
  local f="$1" prev=-1 cur i
  for i in $(seq 1 100); do
    cur="$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f" 2>/dev/null || echo 0)"
    [[ "$cur" == "$prev" && "$cur" != "0" ]] && return 0
    prev="$cur"; sleep 3
  done
  return 0
}

# Print "title<TAB>artist" for a file: tags first, filename fallback.
probe_title_artist() {
  local f="$1" t="" a=""
  t="$(ffprobe -v quiet -show_entries format_tags=title  -of default=nw=1:nk=1 "$f" | head -1)"
  a="$(ffprobe -v quiet -show_entries format_tags=artist -of default=nw=1:nk=1 "$f" | head -1)"
  if [[ -z "$t" ]]; then
    local stem; stem="$(basename "$f")"; stem="${stem%.*}"
    if [[ "$stem" == *" - "* ]]; then
      a="${stem%% - *}"; t="${stem#* - }"
    else
      t="$stem"
    fi
  fi
  [[ -n "$a" ]] || a="Unknown"
  printf '%s\t%s' "$t" "$a"
}

ingest_one() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  is_audio "$f" || return 0
  local name; name="$(basename "$f")"
  echo "== ingesting: $name"
  wait_stable "$f"

  local ti t a
  ti="$(probe_title_artist "$f")"
  t="${ti%%$'\t'*}"; a="${ti##*$'\t'}"
  local base; base="$(song_base "$t" "$a")"
  [[ -n "$base" ]] || { echo "!! [$name] could not derive a song base" >&2; mv "$f" "$f.failed"; return 1; }

  if [[ -f "$STEMS/$base/source.wav" ]]; then
    echo "== [$name] already ingested as $base — moving to _ingested/"
    mv "$f" "$INCOMING/_ingested/$name"
    return 0
  fi

  local dur
  dur="$(ffprobe -v quiet -show_entries format=duration -of default=nw=1:nk=1 "$f" | head -1)"

  local work; work="$(mktemp -d)"
  if ! ffmpeg -y -loglevel error -i "$f" -ac 2 -c:a pcm_s16le -ar 48000 "$work/source.wav" </dev/null; then
    echo "!! [$name] ffmpeg could not read the file" >&2
    rm -rf "$work"; mv "$f" "$f.failed"; return 1
  fi
  if ! ffmpeg -y -loglevel error -i "$work/source.wav" -c:a aac -b:a 256k \
       -movflags +faststart "$work/$base.m4a" </dev/null; then
    echo "!! [$name] ffmpeg could not encode the stereo m4a" >&2
    rm -rf "$work"; mv "$f" "$f.failed"; return 1
  fi

  local meta_ok=0
  if [[ -n "$VENV_PY" && -f "$META_SCRIPT" ]]; then
    if "$VENV_PY" "$META_SCRIPT" --dir "$work" --title "$t" --artist "$a" \
         --url "" ${dur:+--duration "$dur"} --force >/dev/null 2>&1 \
       && [[ -f "$work/metadata.json" ]]; then
      meta_ok=1
    fi
  fi
  if [[ $meta_ok -eq 0 ]]; then
    echo ">> [$name] BPM/key analysis unavailable — writing minimal metadata (song still renders and stays visible)"
    T="$t" A="$a" D="${dur:-}" N="$name" python3 - "$work/metadata.json" <<'PY'
import json, os, sys
d = os.environ
meta = {
  "title": d["T"], "artist": d["A"], "source_url": "",
  "duration_sec": float(d["D"]) if d.get("D") else None,
  "version": "studio",
  "processing": {"download": "local file import (audio_watch.sh)",
                 "separation": "demucs htdemucs_6s planned"},
}
json.dump(meta, open(sys.argv[1], "w"), indent=2)
PY
  fi
  python3 - "$work/metadata.json" "$name" <<'PY'
import json, sys
p, orig = sys.argv[1], sys.argv[2]
m = json.load(open(p))
m["ingest"] = "audio_file"
m["source_file"] = orig
json.dump(m, open(p, "w"), indent=2)
PY

  mkdir -p "$STEMS/$base"
  cp "$work/source.wav" "$STEMS/$base/source.wav"
  cp "$work/metadata.json" "$STEMS/$base/metadata.json"
  mv "$work/$base.m4a" "$SOURCES/$base.m4a"
  local dest="$QUEUE/$base.json"
  [[ -e "$dest" ]] && dest="$QUEUE/${base}_$(date +%s).json"
  mv "$work/metadata.json" "$dest"
  rm -rf "$work"
  mv "$f" "$INCOMING/_ingested/$name"
  echo ">> [$name] → AUDIO_SOURCES/$base.m4a + queued $(basename "$dest") ($t / $a)"
}

drain() {
  local f
  for f in "$INCOMING"/*; do
    [[ -f "$f" ]] || continue
    case "$f" in *.failed) continue ;; esac
    ingest_one "$f" || true
  done
}

if [[ "${1:-}" == "--once" ]]; then
  drain
  exit 0
fi

command -v fswatch >/dev/null 2>&1 || { echo "Missing fswatch (brew install fswatch)" >&2; exit 1; }
echo ">> audio_watch watching $INCOMING (drop m4a/mp3/wav/aiff/flac/ogg/opus; Ctrl-C to stop)"
drain
fswatch -0 --event Created --event Renamed --event MovedTo "$INCOMING" 2>/dev/null \
| while IFS= read -r -d '' _f; do
    drain
  done
