#!/usr/bin/env bash
# webloc_watch.sh — Watch INCOMING_WEBLOC for YouTube .webloc files and build
# one metadata.json per song into STEM_QUEUE, then delete the .webloc.
#
# A .webloc holds a single YouTube URL. Three cases:
#   - Single video       → one metadata file written straight to STEM_QUEUE.
#   - Playlist (list=)    → a setlist: one file per entry (sequence_number +
#                           playlist_title), staged in /tmp/PENDING/<setlist>/
#                           and moved into STEM_QUEUE only once complete.
#   - Chaptered "album"   → treated as a setlist too: one file per chapter,
#     single video          each with a clip window (clip_start/clip_end) so the
#                           pipeline can slice that song out of the full video.
# A URL is a playlist whenever yt-dlp expands it to >1 entry (it carries a
# `list=` param); a single video is a setlist only if it has chapter markers.
#
# BPM, key, key signature, version (live/studio/official/cover/karaoke),
# release year, and lyric/chord search URLs all come from the existing
# metadata.py (librosa analysis of the downloaded audio). This script does
# not duplicate that logic — it downloads audio, calls metadata.py, and for
# playlists injects the two extra fields.
#
# Requires: fswatch, yt-dlp, ffmpeg, and the demucs venv python (librosa +
# soundfile), exactly like stem.sh.
#
# Usage:
#   ./webloc_watch.sh            # watch forever (event-driven via fswatch)
#   ./webloc_watch.sh --once     # process whatever is already in the folder, exit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # code dir (this clone)
. "$SCRIPT_DIR/lib-common.sh"    # slugify / song_base / data_root
BASE="$(data_root)"              # data dir (Drive) — honors $SIMPLE_STEM_ROOT
INCOMING="$BASE/INCOMING_WEBLOC"
QUEUE="$BASE/STEM_QUEUE"
STEMS="$BASE/STEMS"              # cache: STEMS/<base>/source.wav (fetched once)
PENDING="/tmp/PENDING"           # playlists/albums staged here until complete
META_SCRIPT="$SCRIPT_DIR/metadata.py"

mkdir -p "$INCOMING" "$QUEUE" "$STEMS" "$PENDING"

# ── Prereqs ──────────────────────────────────────────────────────────────
missing=0
for cmd in fswatch yt-dlp ffmpeg; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing: $cmd" >&2; missing=1; }
done
[[ -f "$META_SCRIPT" ]] || { echo "Missing $META_SCRIPT (keep it next to this script)." >&2; missing=1; }
if [[ $missing -eq 1 ]]; then
  cat >&2 <<'EOF'
Install with:
  brew install fswatch ffmpeg yt-dlp pipx
  pipx install demucs
  pipx inject demucs librosa soundfile
EOF
  exit 1
fi

# Locate the demucs venv's python (pipx injects librosa/soundfile there),
# same resolution stem.sh uses. macOS readlink has no -f, so follow manually.
DEMUCS_BIN="$(command -v demucs || true)"
VENV_PY=""
if [[ -n "$DEMUCS_BIN" ]]; then
  while [[ -L "$DEMUCS_BIN" ]]; do
    target="$(readlink "$DEMUCS_BIN")"
    case "$target" in
      /*) DEMUCS_BIN="$target" ;;
      *)  DEMUCS_BIN="$(cd -- "$(dirname -- "$DEMUCS_BIN")" && pwd)/$target" ;;
    esac
  done
  VENV_PY="$(dirname "$DEMUCS_BIN")/python3"
  [[ -x "$VENV_PY" ]] || VENV_PY="$(dirname "$DEMUCS_BIN")/python"
fi
[[ -x "$VENV_PY" ]] || VENV_PY="$(command -v python3 || true)"
if [[ -z "$VENV_PY" ]] || ! "$VENV_PY" -c 'import librosa, soundfile' 2>/dev/null; then
  echo "No python with librosa+soundfile found. Run: pipx inject demucs librosa soundfile" >&2
  exit 1
fi

# ── Helpers ──────────────────────────────────────────────────────────────

# Extract the URL from a .webloc (binary or XML plist). plutil handles both
# on macOS; fall back to a grep for the <string> when plutil is absent.
webloc_url() {
  local f="$1" url=""
  if command -v plutil >/dev/null 2>&1; then
    url="$(plutil -extract URL raw -o - "$f" 2>/dev/null || true)"
  fi
  if [[ -z "$url" ]]; then
    url="$(grep -Eo 'https?://[^<[:space:]]+' "$f" 2>/dev/null | head -n1 || true)"
  fi
  printf '%s' "$url"
}

# Resolve "TITLE<TAB>ARTIST" from a yt-dlp .info.json.
# Trust YouTube's metadata verbatim:
#   title  = the video 'title' field, no parsing
#   artist = YouTube Music 'artist' tag if present, else 'uploader'/'channel'
# The previous heuristic split titles on " - " into artist/title, which got
# things backwards whenever the YouTube convention was "Song - Artist (Lyrics)"
# instead of "Artist - Song" — Amy Winehouse Valerie (Lyrics) ingested as
# title="Amy Winehouse (Lyrics)" / artist="Valerie", etc. User prefers a
# deterministic, verbatim title and will manually fix messy YouTube titles.
title_artist() {
  "$VENV_PY" - "$1" <<'PY'
import json, sys
info = json.load(open(sys.argv[1]))
title    = (info.get('title')  or '').strip()
artist   = (info.get('artist') or info.get('creator') or '').strip()
uploader = (info.get('uploader') or info.get('channel') or '').strip()
a = artist or uploader
print(f"{title}\t{a}")
PY
}

# Inject sequence_number + playlist_title into a metadata.json (playlists).
inject_playlist_fields() {
  "$VENV_PY" - "$1" "$2" "$3" <<'PY'
import json, sys
path, seq, ptitle = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = json.load(open(path))
out = {'playlist_title': ptitle, 'sequence_number': seq}
out.update(d)                       # keep existing keys, prepend the two
json.dump(out, open(path, 'w'), indent=2, ensure_ascii=False)
open(path, 'a').write('\n')
PY
}

# slug: lowercase, spaces→_, drop anything but [a-z0-9_-]
slug() { echo "$1" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | tr -cd 'a-z0-9_-'; }

# Decide how to analyze a video from its yt-dlp .info.json.
#   $1 info.json   $2 allow_chapters (1 for a directly-dropped single video,
#                  0 for a playlist entry — entries are one song each)
#   $3 artist (used to strip an "Artist - " prefix when deriving the album name)
# Output, line 1:
#   "CHAPTERS<TAB>album"  then one "idx<TAB>start<TAB>dur<TAB>title" line per
#                         chapter. `album` is the clean album/setlist name
#                         (yt-dlp `album` tag if present, else the title with
#                         the artist prefix and "[Full Album]"/"(Remaster)"-type
#                         qualifiers stripped). `dur` is the chapter length.
#   "SINGLE<TAB>start<TAB>exdur<TAB>fulldur"  analyze just that slice; empty
#                         start+exdur means analyze the whole file. `fulldur`
#                         is always the full video length (for duration_sec).
#                         Long videos are excerpted so a 40-min album never
#                         gets loaded whole → OOM.
analysis_plan() {
  "$VENV_PY" - "$1" "$2" "$3" <<'PY'
import json, re, sys
info   = json.load(open(sys.argv[1]))
allow  = sys.argv[2] == '1'
artist = sys.argv[3]
dur = info.get('duration') or 0
chaps = [c for c in (info.get('chapters') or [])
         if c.get('start_time') is not None and c.get('end_time') is not None
         and c['end_time'] > c['start_time']]

def clean_chapter(t):
    t = re.sub(r'^\s*\d+\s*[.):\-]\s*', '', (t or '').strip())  # drop "1." "2)" "3 -"
    return t.strip() or 'Untitled'

def album_name():
    al = (info.get('album') or '').strip()      # authoritative when present
    if al:
        return al
    t = (info.get('title') or '').strip()
    if artist:                                   # strip a leading "Artist - "
        low = t.lower()
        for sep in (' - ', ' – ', ' — ', ': ', ' | '):
            if low.startswith((artist + sep).lower()):
                t = t[len(artist) + len(sep):]; break
    # drop bracketed qualifiers like [Full Album], (Official), (Remaster 2009)
    t = re.sub(r'\s*[\[(][^\])]*(full album|official|remaster|deluxe|audio|'
               r'video|hd|hq|stereo|mono|\d{4})[^\])]*[\])]', '', t, flags=re.I)
    t = re.sub(r'\s*[\[(]\s*[\])]', '', t)       # leftover empty brackets
    return t.strip(' -–—|') or (info.get('title') or 'album')

if allow and len(chaps) >= 2:
    print('CHAPTERS\t' + album_name())
    for i, c in enumerate(chaps, 1):
        s = float(c['start_time']); e = float(c['end_time'])
        print(f"{i}\t{s:.3f}\t{e - s:.3f}\t{clean_chapter(c.get('title'))}")
elif dur and dur > 900:                 # long single video, no usable chapters
    print(f"SINGLE\t{max(0.0, dur / 2 - 90):.3f}\t180\t{int(dur)}")
else:                                   # short enough: analyze the whole file
    print(f"SINGLE\t\t\t{int(dur) if dur else ''}")
PY
}

# Fresh, empty staging dir.
prepare_stage() { rm -rf "$1"; mkdir -p "$1"; }

# Move a finished staging dir from PENDING into STEM_QUEUE (atomic per setlist).
# Fails (and removes the stage) if no song files were produced.
finalize_setlist() {
  local stage="$1" base; base="$(basename "$stage")"
  if ! ls "$stage"/*.json >/dev/null 2>&1; then
    echo "!! no songs produced for setlist \"$base\"" >&2; rm -rf "$stage"; return 1
  fi
  local dest="$QUEUE/$base"
  [[ -e "$dest" ]] && dest="${dest}_$(date +%Y%m%d%H%M%S)"   # don't clobber a prior run
  mv "$stage" "$dest"
  echo "== setlist queued: $(basename "$dest")/ ($(ls "$dest"/*.json | wc -l | tr -d ' ') songs)"
}

# Download one video's audio (for our analysis only) + its info.json.
_download() {
  local work="$1" url="$2" idtag="$3"
  echo ">> [$idtag] downloading audio…"
  if ! yt-dlp --no-playlist \
        --extract-audio --audio-format wav --audio-quality 0 \
        --write-info-json \
        -o "$work/source.%(ext)s" "$url" >/dev/null 2>&1; then
    echo "!! [$idtag] download failed" >&2; return 1
  fi
  [[ -f "$work/source.wav" && -f "$work/source.info.json" ]] || {
    echo "!! [$idtag] missing source.wav/info.json" >&2; return 1; }
}

# Run metadata.py on an analysis dir (which must contain source.wav) and move
# the result into a destination dir. Injects playlist fields when seq > 0.
#   $1 dir  $2 title  $3 artist  $4 url  $5 info.json  $6 seq  $7 playlist_title
#   $8 id-tag  $9 duration override  $10 dest dir  $11 clip_start (empty = whole)
_emit_metadata() {
  local adir="$1" title="$2" artist="$3" url="$4" info="$5" seq="$6" ptitle="$7"
  local idtag="$8" duration="${9:-}" destdir="${10:-$QUEUE}" clip="${11:-}"
  local cache_src="${12:-}"   # full-song wav to cache under STEMS/<base>/
  local dargs=()
  [[ -n "$duration" ]] && dargs+=( --duration "$duration" )
  [[ -n "$clip"     ]] && dargs+=( --clip-start "$clip" )
  "$VENV_PY" "$META_SCRIPT" --dir "$adir" --title "$title" --artist "$artist" \
      --url "$url" --info-json "$info" ${dargs[@]+"${dargs[@]}"} --force
  [[ -f "$adir/metadata.json" ]] || { echo "!! [$idtag] metadata.py produced nothing" >&2; return 1; }
  local base; base="$(slug "${title}_${artist}")"; [[ -n "$base" ]] || base="$idtag"
  local name="$base.json"
  if (( seq > 0 )); then
    inject_playlist_fields "$adir/metadata.json" "$seq" "$ptitle"
    name="$(printf '%02d_%s.json' "$seq" "$base")"
  fi
  # Cache the fetched audio + metadata under STEMS/<base>/ so the song is
  # downloaded ONCE here on the Librarian; stem.sh reuses source.wav and skips
  # its own download. Uses the canonical song_base so the path matches stem.sh.
  if [[ -n "$cache_src" && -f "$cache_src" ]]; then
    local cbase cdir; cbase="$(song_base "$title" "$artist")"
    cdir="$STEMS/$cbase"; mkdir -p "$cdir"
    [[ -f "$cdir/source.wav" ]] || cp "$cache_src" "$cdir/source.wav"
    [[ -f "$info" ]] && cp -f "$info" "$cdir/source.info.json"
    cp -f "$adir/metadata.json" "$cdir/metadata.json"
    echo ">> [$idtag] cached source.wav → STEMS/$cbase/"
  fi
  local dest="$destdir/$name"
  [[ -e "$dest" ]] && dest="$destdir/${name%.json}_$idtag.json"   # avoid clobber
  mv "$adir/metadata.json" "$dest"
  echo ">> [$idtag] queued: $(basename "$dest")"
}

# Analyze one already-downloaded video and emit a single song file. Used both
# for a standalone single and for each entry of a real playlist. The video is
# its own song → no clip window (download the whole thing downstream).
#   $1 work  $2 id  $3 url  $4 info  $5 title  $6 artist  $7 seq  $8 ptitle  $9 destdir
_emit_one_video() {
  local work="$1" id="$2" url="$3" info="$4" title="$5" artist="$6" seq="$7" ptitle="$8" destdir="$9"
  local plan header; plan="$(analysis_plan "$info" 0 "$artist")"
  header="$(printf '%s\n' "$plan" | head -n1)"
  local start exdur fulldur adir="$work"
  start="$(printf '%s' "$header" | cut -f2)"
  exdur="$(printf '%s' "$header" | cut -f3)"
  fulldur="$(printf '%s' "$header" | cut -f4)"
  if [[ -n "$start" && -n "$exdur" ]]; then
    echo ">> [$id] long video — analyzing a ${exdur}s excerpt to bound memory"
    adir="$work/seg"; mkdir -p "$adir"
    ffmpeg -y -loglevel error -ss "$start" -t "$exdur" -i "$work/source.wav" \
           "$adir/source.wav" </dev/null
  fi
  echo ">> [$id] analyzing: $title — $artist"
  # cache the FULL download ($work/source.wav), not the analysis excerpt.
  _emit_metadata "$adir" "$title" "$artist" "$url" "$info" "$seq" "$ptitle" "$id" "$fulldur" "$destdir" "" "$work/source.wav"
}

# A directly-dropped single video. If it's a chaptered "full album" it becomes
# a setlist (staged folder); otherwise one flat file in STEM_QUEUE.
process_single() {
  local id="$1" url="https://www.youtube.com/watch?v=$id"
  local work rc=0; work="$(mktemp -d)"
  _process_single_body "$id" "$url" "$work" || rc=$?
  rm -rf "$work"; return $rc
}

_process_single_body() {
  local id="$1" url="$2" work="$3"
  _download "$work" "$url" "$id" || return 1
  local info="$work/source.info.json"
  local ti; ti="$(title_artist "$info")"
  local title="${ti%%$'\t'*}" artist="${ti##*$'\t'}"
  [[ -n "$title" ]] || title="$id"

  local plan header; plan="$(analysis_plan "$info" 1 "$artist")"
  header="$(printf '%s\n' "$plan" | head -n1)"

  if [[ "$header" == CHAPTERS* ]]; then
    local album="${header#CHAPTERS$'\t'}"
    local sbase; sbase="$(slug "$album")"; [[ -n "$sbase" ]] || sbase="album_$id"
    local stage="$PENDING/$sbase"; prepare_stage "$stage"
    echo ">> [$id] chaptered album \"$album\" → staging $sbase/ (PENDING)"
    local any=0 idx start dur ctitle seg
    while IFS=$'\t' read -r idx start dur ctitle; do
      [[ "$idx" == CHAPTERS || -z "$idx" ]] && continue
      seg="$work/seg_$idx"; mkdir -p "$seg"
      ffmpeg -y -loglevel error -ss "$start" -t "$dur" -i "$work/source.wav" \
             "$seg/source.wav" </dev/null
      echo ">> [$id] #$idx: $ctitle"
      _emit_metadata "$seg" "$ctitle" "$artist" "$url" "$info" "$idx" "$album" \
                     "${id}_$idx" "$dur" "$stage" "$start" "$seg/source.wav" && any=1
      rm -rf "$seg"
    done <<< "$plan"
    if (( any == 1 )); then finalize_setlist "$stage"; else rm -rf "$stage"; return 1; fi
  else
    # standalone single → flat file straight into STEM_QUEUE
    _emit_one_video "$work" "$id" "$url" "$info" "$title" "$artist" 0 "" "$QUEUE"
  fi
}

# One entry of a real YouTube playlist → one staged song file.
process_entry() {
  local id="$1" seq="$2" ptitle="$3" stage="$4"
  local url="https://www.youtube.com/watch?v=$id"
  local work rc=0; work="$(mktemp -d)"
  if _download "$work" "$url" "$id"; then
    local info="$work/source.info.json"
    local ti; ti="$(title_artist "$info")"
    local title="${ti%%$'\t'*}" artist="${ti##*$'\t'}"
    [[ -n "$title" ]] || title="$id"
    _emit_one_video "$work" "$id" "$url" "$info" "$title" "$artist" "$seq" "$ptitle" "$stage" || rc=$?
  else
    rc=1
  fi
  rm -rf "$work"; return $rc
}

# Process one .webloc end to end, then delete it (rename to .failed on error).
process_webloc() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  sleep 1                                  # let Finder finish writing
  local url; url="$(webloc_url "$f")"
  if [[ -z "$url" ]]; then
    echo "!! no URL in $(basename "$f"); leaving as .failed" >&2
    mv -f "$f" "$f.failed"; return 0
  fi
  echo "== $(basename "$f"): $url"

  # One flat dump tells us single vs playlist and gives ids + playlist title.
  # Write to a temp file (don't interpolate JSON into the shell — titles may
  # contain $, backticks, or quotes).
  local dump; dump="$(mktemp)"
  if ! yt-dlp --flat-playlist -J "$url" >"$dump" 2>/dev/null; then
    echo "!! yt-dlp could not read $url; leaving as .failed" >&2
    rm -f "$dump"; mv -f "$f" "$f.failed"; return 0
  fi

  # Parse dump → lines of "seq<TAB>id". A leading "PLAYLIST<TAB>title" record
  # carries the playlist title; "SINGLE" means one video with seq=0.
  local parsed; parsed="$("$VENV_PY" - "$dump" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if d.get('_type') == 'playlist':
    ents = [e for e in (d.get('entries') or []) if e and e.get('id')]
    print('PLAYLIST\t' + (d.get('title') or 'playlist'))
    for i, e in enumerate(ents, 1):
        print(f"{i}\t{e['id']}")
else:
    print('SINGLE\t')
    print(f"0\t{d.get('id','')}")
PY
)"
  rm -f "$dump"

  local kind; kind="$(printf '%s\n' "$parsed" | head -n1 | cut -f1)"
  local ok=0
  if [[ "$kind" == "PLAYLIST" ]]; then
    local ptitle; ptitle="$(printf '%s\n' "$parsed" | head -n1 | cut -f2)"
    local sbase; sbase="$(slug "$ptitle")"; [[ -n "$sbase" ]] || sbase="playlist_$(date +%s)"
    local stage="$PENDING/$sbase"; prepare_stage "$stage"
    echo ">> playlist \"$ptitle\" → staging $sbase/ (PENDING)"
    local a b
    while IFS=$'\t' read -r a b; do
      [[ "$a" == "PLAYLIST" || -z "$a" || -z "$b" ]] && continue
      process_entry "$b" "$a" "$ptitle" "$stage" && ok=1
    done <<< "$parsed"
    if (( ok == 1 )); then finalize_setlist "$stage" || ok=0; else rm -rf "$stage"; fi
  else
    local id; id="$(printf '%s\n' "$parsed" | sed -n '2p' | cut -f2)"
    if [[ -n "$id" ]] && process_single "$id"; then ok=1; fi
  fi

  if (( ok == 1 )); then
    rm -f "$f"; echo "== done; removed $(basename "$f")"
  else
    echo "!! nothing queued from $(basename "$f"); leaving as .failed" >&2
    mv -f "$f" "$f.failed"
  fi
}

# ── Run ──────────────────────────────────────────────────────────────────
# Always sweep anything already sitting in the folder first.
shopt -s nullglob
for f in "$INCOMING"/*.webloc; do process_webloc "$f"; done
shopt -u nullglob

if [[ "${1:-}" == "--once" ]]; then
  exit 0
fi

echo ">> watching $INCOMING (Ctrl-C to stop)…"
# -0 → NUL-separated paths (safe for spaces). React to new/moved files only.
fswatch -0 --event Created --event MovedTo --event Renamed --event Updated "$INCOMING" \
  | while IFS= read -r -d '' path; do
      case "$path" in
        *.webloc) process_webloc "$path" ;;
      esac
    done
