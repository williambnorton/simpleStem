#!/usr/bin/env bash
# queue_runner.sh — render queued metadata jobs into the library.
#
# This is the worker that closes the loop: webloc_watch.sh turns dropped
# .webloc URLs into metadata jobs in STEM_QUEUE/ (single .json files and
# <setlist>/ folders); this script picks them up one at a time and runs the
# existing stem.sh pipeline, so finished songs land in STEMS/ + M4A/ where the
# bt-construction-kit portal can see them.
#
# Per job it reads metadata.json for title/artist/source_url and, for songs
# carved out of a chaptered album, the clip window (clip_start_sec/clip_end_sec)
# — those are downloaded whole then sliced before stemming.
#
# Status for the portal: while a job renders, its name is written to
# STEM_QUEUE/.current (read by GET /api/queue). Finished jobs move to
# STEM_QUEUE/_done/, failures to STEM_QUEUE/_failed/ (so they don't loop).
#
# Requires: stem.sh (next to this script) + its deps (yt-dlp, ffmpeg, demucs),
# and python3. Single worker — a lock prevents concurrent runners.
#
# Usage:
#   ./queue_runner.sh           # watch forever, render jobs as they arrive
#   ./queue_runner.sh --once    # drain the current queue, then exit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # code dir (this clone)
. "$SCRIPT_DIR/lib-common.sh"   # song_base, data_root
BASE="$(data_root)"             # data dir (Drive) — honors $SIMPLE_STEM_ROOT
QUEUE="$BASE/STEM_QUEUE"
STEMS="$BASE/STEMS"
STEM_SCRIPT="$SCRIPT_DIR/stem.sh"
CURRENT="$QUEUE/.current"
LOCK="$QUEUE/.runner.lock"
POLL="${POLL:-5}"

[[ -x "$STEM_SCRIPT" || -f "$STEM_SCRIPT" ]] || { echo "Missing $STEM_SCRIPT" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "Missing python3" >&2; exit 1; }
mkdir -p "$QUEUE" "$STEMS" "$QUEUE/_done" "$QUEUE/_failed"

# Read title/artist/source_url/clip_start/clip_end from a job json (one per line,
# empty for nulls). Used to drive stem.sh.
read_fields() {
  python3 - "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
def g(k):
    v = d.get(k)
    return '' if v is None else str(v)
for k in ('title', 'artist', 'source_url', 'clip_start_sec', 'clip_end_sec'):
    print(g(k))
PY
}

# Update the live phase shown in the portal (merged into STEM_QUEUE/.current).
set_phase() {
  echo "   · $1"
  python3 - "$CURRENT" "$1" <<'PY' 2>/dev/null || true
import json, sys, time
f, phase = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(f))
except Exception:
    d = {}
d['phase'] = phase
d['phase_since'] = time.strftime('%H:%M:%S')
json.dump(d, open(f, 'w'))
PY
}

# Run stem.sh, translating its progress chatter into coarse phases for the
# portal so you can see where a (slow) render is. Returns stem.sh's exit code.
run_stem() {
  local rc
  set +e
  "$STEM_SCRIPT" "$@" 2>&1 | while IFS= read -r line; do
    printf '%s\n' "$line"
    case "$line" in
      *Downloading*|*"Importing local"*)        set_phase "downloading source" ;;
      *"Detecting BPM"*|*"Building metadata"*)   set_phase "analyzing (BPM/key)" ;;
      *"Running Demucs"*|*Demucs*)               set_phase "separating stems · demucs (~10-25 min)" ;;
      *Encoding*)                                set_phase "mixing m4a tracks" ;;
    esac
  done
  rc=${PIPESTATUS[0]}
  set -e
  return $rc
}

# Render one song. Clip window set → download whole video, slice, stem the slice.
# Otherwise hand the URL straight to stem.sh.
render() {
  local title="$1" artist="$2" url="$3" cstart="$4" cend="$5" rc=0
  # Cache fast-path: the Librarian (webloc_watch.sh) already fetched source.wav
  # for this song — album chapters are cached already-sliced. Hand it to stem.sh,
  # which reuses STEMS/<base>/source.wav and skips both download and slicing.
  # The clip/url branches below remain as a fallback when there is no cache
  # (e.g. right after a wipe/rebuild before re-ingest).
  local cbase; cbase="$(song_base "$title" "$artist")"
  if [[ -f "$STEMS/$cbase/source.wav" ]]; then
    set_phase "using cached source.wav"
    run_stem "$title" "$artist"
    return $?
  fi
  if [[ -n "$cstart" && -n "$cend" ]]; then
    local work; work="$(mktemp -d)"
    set_phase "downloading full video for clip ${cstart}-${cend}s"
    if yt-dlp -x --audio-format wav --audio-quality 0 \
         -o "$work/full.%(ext)s" "$url" >/dev/null 2>&1 && [[ -f "$work/full.wav" ]]; then
      local dur; dur="$(python3 -c "print(max(0.0, float('$cend') - float('$cstart')))")"
      set_phase "slicing clip"
      ffmpeg -y -loglevel error -ss "$cstart" -t "$dur" -i "$work/full.wav" \
             "$work/seg.wav" </dev/null
      run_stem --source "$work/seg.wav" "$title" "$artist" || rc=$?
    else
      echo "   !! download failed: $url" >&2; rc=1
    fi
    rm -rf "$work"
    return $rc
  fi
  if [[ -n "$url" ]]; then
    run_stem "$title" "$artist" "$url"
  else
    run_stem "$title" "$artist"
  fi
}

# Move a finished job to _done/ (or _failed/), preserving its setlist subpath,
# and tidy an emptied setlist folder.
finish() {
  local job="$1" bucket="$2" rel="${1#$QUEUE/}"
  local dest="$QUEUE/$bucket/$rel"
  mkdir -p "$(dirname "$dest")"
  if [[ -f "$job" ]]; then
    mv -f "$job" "$dest" 2>/dev/null || { rm -f "$job" 2>/dev/null || true; }
  else
    # Source job already gone (Drive sync race / placeholder). The work itself
    # completed; just leave a marker so it isn't re-picked and we don't crash.
    echo "   (job file $rel already absent — recording $bucket marker)" >&2
    : > "$dest" 2>/dev/null || true
  fi
  local srcdir; srcdir="$(dirname "$job")"
  if [[ "$srcdir" != "$QUEUE" ]] && ! ls "$srcdir"/*.json >/dev/null 2>&1; then
    rmdir "$srcdir" 2>/dev/null || true
  fi
}

process_job() {
  local job="$1" rel="${1#$QUEUE/}"
  local F=(); mapfile -t F < <(read_fields "$job")
  local title="${F[0]:-}" artist="${F[1]:-}" url="${F[2]:-}" cstart="${F[3]:-}" cend="${F[4]:-}"
  if [[ -z "$title" ]]; then
    echo "!! $rel: no title; moving to _failed" >&2; finish "$job" _failed; return
  fi
  python3 -c 'import json,sys; open(sys.argv[1],"w").write(json.dumps({"song":sys.argv[2],"job":sys.argv[3]}))' \
    "$CURRENT" "$title — $artist" "$rel"
  set_phase "starting"
  echo "== rendering: $title — $artist   ($rel)"
  # Per-job full-fidelity log. Every line of stem.sh's output is tee'd
  # into <job>.log next to the JSON so failures always leave a trace —
  # you don't have to lsof the running perf-runner.log to see why.
  # On success the .log is discarded (unless SIMPLE_STEM_KEEP_JOB_LOGS=1).
  local job_log="${job%.json}.log"
  local rc=0
  if render "$title" "$artist" "$url" "$cstart" "$cend" 2>&1 | tee "$job_log"; then
    rc=${PIPESTATUS[0]}
  else
    rc=${PIPESTATUS[0]}
  fi
  if (( rc == 0 )); then
    echo "== done: $title — $artist"
    [[ "${SIMPLE_STEM_KEEP_JOB_LOGS:-0}" == "1" ]] || rm -f "$job_log"
    finish "$job" _done
  else
    echo "!! failed: $title — $artist   (rc=$rc, see ${job_log#$QUEUE/})" >&2
    # Preserve the log alongside the JSON in _failed/ so triage is one
    # cat command. Copies to the same subpath under _failed/.
    local dest_log="$QUEUE/_failed/${rel%.json}.log"
    mkdir -p "$(dirname "$dest_log")"
    mv -f "$job_log" "$dest_log" 2>/dev/null || true
    finish "$job" _failed
  fi
  rm -f "$CURRENT"
}

# First pending job: a *.json directly in STEM_QUEUE (single) or one level deep
# (a setlist entry). Sorted so setlist NN_ prefixes render in order.
next_job() {
  find "$QUEUE" -mindepth 1 -maxdepth 2 -name '*.json' \
       -not -path "$QUEUE/_done/*" -not -path "$QUEUE/_failed/*" 2>/dev/null | sort | head -n1
}

# ── Run ────────────────────────────────────────────────────────────────────
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "queue_runner already running (remove $LOCK if stale)" >&2; exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null; rm -f "$CURRENT"' EXIT

ONCE=0; [[ "${1:-}" == "--once" ]] && ONCE=1
# Pause flag: if STEM_QUEUE/.paused exists, the runner idles between songs
# (it never interrupts a song mid-render). Set/cleared by performer.sh pause|resume
# so you can stop heavy CPU before a gig without losing the in-flight render.
PAUSE="$QUEUE/.paused"
echo ">> queue_runner watching $QUEUE (poll ${POLL}s; Ctrl-C to stop)"
while true; do
  if [[ -f "$PAUSE" ]]; then
    (( ONCE == 1 )) && { echo ">> paused (.paused present) — exiting --once"; break; }
    sleep "$POLL"; continue
  fi
  job="$(next_job)"
  if [[ -z "$job" ]]; then
    (( ONCE == 1 )) && break
    sleep "$POLL"; continue
  fi
  process_job "$job"
done
