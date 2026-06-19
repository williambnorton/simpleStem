#!/usr/bin/env bash
# stem.sh — Fetch a song from YouTube and stem-split it with Demucs.
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
# Output (all WAVs are 48 kHz):
#   ~/ClaudeDrive/simpleStem/STEMS/${Title}_${Artist}/
#     source.wav                        (downloaded audio, 48 kHz)
#     vocals.wav  drums.wav  bass.wav  other.wav  piano.wav  guitar.wav
#                                       (htdemucs_6s 6-stem split, resampled to 48 kHz)
#     bass+drums.wav                    (full-length rhythm-section mix)
#     drums_loop{1..4}_<N>bars.wav      (tiled, song-length jam loops)
#     bass_loop{1..4}_<N>bars.wav
#     drumsbass_loop{1..4}_<N>bars.wav  (combined rhythm-section loops)
#     piano_loop{1..4}_<N>bars.wav
#     guitar_loop{1..4}_<N>bars.wav
#   ~/ClaudeDrive/simpleStem/M4A/
#     ${Title}_${Artist}_DO.m4a         (drums only)
#     ${Title}_${Artist}_-V-G.m4a       (source minus vocals, guitar)
#     ${Title}_${Artist}_-V-G-B.m4a     (source minus vocals, guitar, bass)
#
# Prereqs (macOS):
#   brew install ffmpeg yt-dlp pipx
#   pipx ensurepath
#   echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
#   export PATH="$HOME/.local/bin:$PATH"
#   pipx install demucs
#   pipx inject demucs torchcodec librosa soundfile

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

Stems are placed in (all WAVs are 48 kHz):
  ~/ClaudeDrive/simpleStem/STEMS/\${Title}_\${Artist}/
    source.wav                        downloaded/imported audio (48 kHz)
    vocals.wav  drums.wav  bass.wav  other.wav  piano.wav  guitar.wav
                                      htdemucs_6s 6-stem split (48 kHz)
    bass+drums.wav                    full-length rhythm-section mix
    drums_loop{1..4}_<N>bars.wav      tiled, song-length jam loops
    bass_loop{1..4}_<N>bars.wav
    drumsbass_loop{1..4}_<N>bars.wav  combined rhythm-section loops
    piano_loop{1..4}_<N>bars.wav
    guitar_loop{1..4}_<N>bars.wav
M4A mixes are placed in:
  ~/ClaudeDrive/simpleStem/M4A/
    \${Title}_\${Artist}_DO.m4a         drums only
    \${Title}_\${Artist}_-V-G.m4a       source minus vocals, guitar
    \${Title}_\${Artist}_-V-G-B.m4a     source minus vocals, guitar, bass
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
# Required because:
#   - yt-dlp preserves YouTube's native rate (usually 48 kHz, sometimes not).
#   - Demucs's output rate varies by version (htdemucs is a 44.1 kHz model;
#     some versions resample stems back to input rate, others don't).
# Applying this defensively after download and after Demucs makes the
# whole pipeline produce uniform 48 kHz output regardless of versions.
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
for cmd in ffmpeg yt-dlp demucs; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing: $cmd" >&2
    missing=1
  fi
done
if [[ $missing -eq 1 ]]; then
  cat >&2 <<'EOF'
Install with:
  brew install ffmpeg yt-dlp pipx
  pipx ensurepath
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
  export PATH="$HOME/.local/bin:$PATH"
  pipx install demucs
  pipx inject demucs torchcodec librosa soundfile
EOF
  exit 1
fi

# Locate the demucs venv's python (we'll reuse it for loop detection,
# since pipx injects librosa/soundfile alongside demucs).
# `command -v demucs` is a pipx symlink in ~/.local/bin — follow it
# into the actual venv. macOS readlink has no -f, so loop manually.
DEMUCS_BIN="$(command -v demucs)"
while [[ -L "$DEMUCS_BIN" ]]; do
  target="$(readlink "$DEMUCS_BIN")"
  case "$target" in
    /*) DEMUCS_BIN="$target" ;;
    *)  DEMUCS_BIN="$(cd -- "$(dirname -- "$DEMUCS_BIN")" && pwd)/$target" ;;
  esac
done
VENV_PY="$(dirname "$DEMUCS_BIN")/python3"
[[ -x "$VENV_PY" ]] || VENV_PY="$(dirname "$DEMUCS_BIN")/python"
# Fallback for pip-installed demucs (not pipx): python lives elsewhere
# in PATH. In the Docker image (pip install) demucs is at /usr/local/bin
# next to python3, so the first branch hits; this branch only fires for
# bare `pip install --user demucs` setups.
if [[ ! -x "$VENV_PY" ]]; then
  VENV_PY="$(command -v python3 || true)"
fi
if [[ ! -x "$VENV_PY" ]]; then
  echo "Could not locate a python interpreter to run loop_detect.py." >&2
  exit 1
fi
if ! "$VENV_PY" -c 'import librosa, soundfile' 2>/dev/null; then
  echo ">> librosa/soundfile missing in demucs env; injecting…" >&2
  pipx inject demucs librosa soundfile
  if ! "$VENV_PY" -c 'import librosa, soundfile' 2>/dev/null; then
    echo "Auto-inject failed. Run manually: pipx inject demucs librosa soundfile" >&2
    exit 1
  fi
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOOP_SCRIPT="$SCRIPT_DIR/loop_detect.py"
if [[ ! -f "$LOOP_SCRIPT" ]]; then
  echo "Missing $LOOP_SCRIPT — keep it next to stem.sh." >&2
  exit 1
fi

SRC="${OUT_DIR}/source.wav"

# 1) Get source.wav. Three branches:
#    (a) source.wav already present → skip entirely (idempotent re-runs)
#    (b) --source PATH given → ffmpeg-convert the local file to source.wav
#    (c) URL_OVERRIDE given → yt-dlp that explicit YouTube URL/ID
#    (d) otherwise → yt-dlp smart search
if [[ -f "$SRC" ]]; then
  echo ">> source.wav already present, skipping import/download."
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
#     MusicBrainz release date, yt-dlp's true title/uploader/upload date).
#     Runs before Demucs so the metadata is captured even if separation
#     fails. Idempotent — metadata.py skips if metadata.json already exists.
META_SCRIPT="$SCRIPT_DIR/metadata.py"
if [[ -f "$META_SCRIPT" ]]; then
  YT_INFO="$OUT_DIR/source.info.json"
  META_ARGS=( --dir "$OUT_DIR" --title "$TITLE" --artist "$ARTIST" )
  [[ -f "$YT_INFO" ]] && META_ARGS+=( --info-json "$YT_INFO" )
  [[ -n "$URL_OVERRIDE" ]] && META_ARGS+=( --url "$URL_OVERRIDE" )
  echo ">> Building metadata.json…"
  "$VENV_PY" "$META_SCRIPT" "${META_ARGS[@]}" || \
    echo "   metadata.py failed (continuing; demucs still runs)" >&2
fi

# 2) Stem-split with Demucs htdemucs_6s (skip if all 6 stems already exist)
if [[ -f "$OUT_DIR/vocals.wav" && -f "$OUT_DIR/drums.wav" \
   && -f "$OUT_DIR/bass.wav"   && -f "$OUT_DIR/other.wav" \
   && -f "$OUT_DIR/piano.wav"  && -f "$OUT_DIR/guitar.wav" ]]; then
  echo ">> Stems already present, skipping Demucs."
else
  echo ">> Running Demucs htdemucs_6s (6-stem; ~10–25 min on CPU)…"
  demucs -n htdemucs_6s --out "$OUT_DIR" "$SRC"
  mv "$OUT_DIR/htdemucs_6s/source/"*.wav "$OUT_DIR/"
  rmdir "$OUT_DIR/htdemucs_6s/source" "$OUT_DIR/htdemucs_6s"
fi

# Ensure every stem is 48 kHz before downstream loop_detect runs.
# Demucs's output rate varies by version; this normalizes it.
for stem in vocals drums bass other piano guitar; do
  ensure_48k "$OUT_DIR/${stem}.wav"
done

# 2c) Build M4A "minus" mixes in ~/ClaudeDrive/simpleStem/M4A/.
#     - ${Title}_${Artist}_DO.m4a       : drums only
#     - ${Title}_${Artist}_-V-G.m4a     : source - vocals - guitar
#     - ${Title}_${Artist}_-V-G-B.m4a   : source - vocals - guitar - bass
#     "Minus" mixes phase-invert the unwanted stems (volume=-1) and sum them
#     onto the source via amix=normalize=0 — cleaner than summing the
#     remaining stems, and preserves whatever residue Demucs left behind.
M4A_DIR="$DATA_ROOT/M4A"
mkdir -p "$M4A_DIR"
M4A_BASE="${SLUG_TITLE}_${SLUG_ARTIST}"
M4A_DO="$M4A_DIR/${M4A_BASE}_DO.m4a"
M4A_V="$M4A_DIR/${M4A_BASE}_-V.m4a"
M4A_VG="$M4A_DIR/${M4A_BASE}_-V-G.m4a"
M4A_VGB="$M4A_DIR/${M4A_BASE}_-V-G-B.m4a"

if [[ -f "$M4A_DO" ]]; then
  echo ">> $(basename "$M4A_DO") exists, skipping."
else
  echo ">> Encoding $(basename "$M4A_DO") (drums only)"
  ffmpeg -y -loglevel error -i "$OUT_DIR/drums.wav" \
    -c:a aac -b:a 256k "$M4A_DO"
fi

# -V : source minus vocals (the most common "sing over the band" track).
if [[ -f "$M4A_V" ]]; then
  echo ">> $(basename "$M4A_V") exists, skipping."
else
  echo ">> Encoding $(basename "$M4A_V") (source - vocals)"
  ffmpeg -y -loglevel error \
    -i "$OUT_DIR/source.wav" \
    -i "$OUT_DIR/vocals.wav" \
    -filter_complex "[1:a]volume=-1[v];[0:a][v]amix=inputs=2:normalize=0[out]" \
    -map "[out]" -c:a aac -b:a 256k "$M4A_V"
fi

if [[ -f "$M4A_VG" ]]; then
  echo ">> $(basename "$M4A_VG") exists, skipping."
else
  echo ">> Encoding $(basename "$M4A_VG") (source - vocals - guitar)"
  ffmpeg -y -loglevel error \
    -i "$OUT_DIR/source.wav" \
    -i "$OUT_DIR/vocals.wav" \
    -i "$OUT_DIR/guitar.wav" \
    -filter_complex "[1:a]volume=-1[v];[2:a]volume=-1[g];[0:a][v][g]amix=inputs=3:normalize=0[out]" \
    -map "[out]" -c:a aac -b:a 256k "$M4A_VG"
fi

if [[ -f "$M4A_VGB" ]]; then
  echo ">> $(basename "$M4A_VGB") exists, skipping."
else
  echo ">> Encoding $(basename "$M4A_VGB") (source - vocals - guitar - bass)"
  ffmpeg -y -loglevel error \
    -i "$OUT_DIR/source.wav" \
    -i "$OUT_DIR/vocals.wav" \
    -i "$OUT_DIR/guitar.wav" \
    -i "$OUT_DIR/bass.wav" \
    -filter_complex "[1:a]volume=-1[v];[2:a]volume=-1[g];[3:a]volume=-1[b];[0:a][v][g][b]amix=inputs=4:normalize=0[out]" \
    -map "[out]" -c:a aac -b:a 256k "$M4A_VGB"
fi

# 3) Detect recurring sections in source.wav and tile aligned loops
#    out of drums.wav and bass.wav (max 4 loops per stem). bass+drums.wav
#    is the sentinel: if it exists, assume loops have already been built.
#
# Note: post_process.py (LSQ gain match) is NOT run automatically.
# Invoke it manually if you want stem rebalancing:
#     ./post_process.py --dir "$OUT_DIR" --dry-run   # preview
#     ./post_process.py --dir "$OUT_DIR"             # apply
if [[ -f "$OUT_DIR/bass+drums.wav" ]]; then
  echo ">> Loops already present, skipping loop_detect."
else
  echo ">> Detecting jam loops in drums + bass + piano + guitar (aligned via source)…"
  "$VENV_PY" "$LOOP_SCRIPT" \
    --ref "$OUT_DIR/source.wav" \
    --target "$OUT_DIR/drums.wav" "$OUT_DIR/bass.wav" \
             "$OUT_DIR/piano.wav" "$OUT_DIR/guitar.wav" \
    --out "$OUT_DIR" \
    --max-loops 4
fi

# 3b) Encode each stem to m4a so the browser-side mixer can stream them
#     directly (a stem WAV is ~30-50 MB; the same content at 256k AAC is
#     ~5-8 MB — major cache + Drive sync win).
#
#     Per CLAUDE.md "File format policy: m4a only" — we now DELETE the
#     stem .wav files after the m4a transcode completes by default.
#     If you need the wavs for a post-processing pass (post_process.py /
#     re-running loop_detect.py), set KEEP_STEM_WAVS=1 in the env.
for stem in vocals drums bass other piano guitar; do
  stem_wav="$OUT_DIR/${stem}.wav"
  stem_m4a="$OUT_DIR/${stem}.m4a"
  [[ -f "$stem_wav" ]] || continue
  if [[ -f "$stem_m4a" ]]; then
    echo ">> ${stem}.m4a present, skipping."
    continue
  fi
  echo ">> Encoding ${stem}.m4a (AAC 256k from ${stem}.wav)"
  ffmpeg -y -loglevel error -i "$stem_wav" -c:a aac -b:a 256k "$stem_m4a"
done

# Default: delete stem .wav files after m4a transcode. Opt-out via
# KEEP_STEM_WAVS=1 for post-process / re-loop workflows.
if [[ "${KEEP_STEM_WAVS:-0}" != "1" ]]; then
  for stem in vocals drums bass other piano guitar; do
    if [[ -f "$OUT_DIR/${stem}.m4a" && -f "$OUT_DIR/${stem}.wav" ]]; then
      rm -f "$OUT_DIR/${stem}.wav"
    fi
  done
  echo ">> Deleted stem WAVs (m4a-only policy; set KEEP_STEM_WAVS=1 to keep)."
fi
# bass+drums.wav was an intermediate for loop_detect; clean it up unless
# the operator has asked to keep the wavs around.
if [[ "${KEEP_STEM_WAVS:-0}" != "1" && -f "$OUT_DIR/bass+drums.wav" ]]; then
  rm -f "$OUT_DIR/bass+drums.wav"
  echo ">> Deleted bass+drums.wav (loop intermediate)."
fi
# Any stray non-source loop wavs that earlier loop_detect builds left
# behind (drums_loop*_Nbars.wav, bass_loop*_Nbars.wav, etc). The newer
# loop_detect.py writes m4a directly so these usually aren't here on a
# fresh render, but they accumulated on older songs.
if [[ "${KEEP_STEM_WAVS:-0}" != "1" ]]; then
  rm -f "$OUT_DIR"/*_loop*_*bars.wav 2>/dev/null
fi

# 4) Mixdown loops: detect the most-repeated sections (from source.wav) and tile
#    them out of EACH m4a mixdown (-V, -V-G, -V-G-B, DO), up to 4 per mixdown.
#    Output: M4A/<base>_<variant>_loop<i>_<bars>bars.m4a
#    Section names are loop1..loop4 (recurrence-ranked); intro/verse/chorus
#    labels are NOT inferred — that detection is unreliable on live/extended cuts.
#    Sentinel: M4A/<base>_-V_loop1_*bars.m4a — skip if mixdown loops already made.
shopt -s nullglob
_mixloop_done=("$M4A_DIR/${M4A_BASE}_-V_loop1_"*bars.m4a)
shopt -u nullglob
if (( ${#_mixloop_done[@]} > 0 )); then
  echo ">> Mixdown loops already present, skipping."
else
  echo ">> Building mixdown loops for -V / -V-G / -V-G-B / DO…"
  for pair in "-V:$M4A_V" "-V-G:$M4A_VG" "-V-G-B:$M4A_VGB" "DO:$M4A_DO"; do
    variant="${pair%%:*}"; m4a="${pair#*:}"
    [[ -f "$m4a" ]] || { echo "   (skip $variant — m4a missing)"; continue; }
    tmp="$(mktemp -d)"
    # decode mixdown → wav so loop_detect can tile from it
    ffmpeg -y -loglevel error -i "$m4a" -ar 48000 "$tmp/mix.wav" </dev/null || { rm -rf "$tmp"; continue; }
    "$VENV_PY" "$LOOP_SCRIPT" \
      --ref "$OUT_DIR/source.wav" \
      --target "$tmp/mix.wav" \
      --out "$tmp" \
      --max-loops 4 || { rm -rf "$tmp"; continue; }
    # loop_detect.py now writes .m4a directly — just move each into M4A/ named
    # <base>_<variant>_loopN_Mbars.m4a (no re-encode needed).
    shopt -s nullglob
    for lw in "$tmp"/mix_loop*bars.m4a; do
      suffix="${lw##*/mix_}"        # e.g. loop2_27bars.m4a
      suffix="${suffix%.m4a}"       # loop2_27bars
      out="$M4A_DIR/${M4A_BASE}_${variant}_${suffix}.m4a"
      mv -f "$lw" "$out" && echo "   + $(basename "$out")"
    done
    shopt -u nullglob
    rm -rf "$tmp"
  done
fi

# Section-boundary detection — runs the multi-stem novelty function over
# the freshly-rendered stems and writes a `sectionCandidates` array into
# metadata.json. The portal uses these to snap user-placed section
# boundaries to actual moments where many stems change together (verse
# entries, chorus boosts, bridges). ~3 sec on CPU; best-effort: a failure
# here doesn't fail the stem render.
SECTION_SCRIPT="$SCRIPT_DIR/section_detect.py"
if [[ -f "$SECTION_SCRIPT" ]]; then
  echo ">> Detecting section candidates (multi-stem novelty)..."
  if [[ -n "${PYTHON_BIN:-}" ]]; then
    "$PYTHON_BIN" "$SECTION_SCRIPT" "$OUT_DIR" || echo "  WARN: section_detect failed (non-fatal)"
  else
    python3 "$SECTION_SCRIPT" "$OUT_DIR" || echo "  WARN: section_detect failed (non-fatal)"
  fi
fi

echo ">> Done. Files:"
ls -1 "$OUT_DIR/"
echo ">> Folder: $OUT_DIR"
