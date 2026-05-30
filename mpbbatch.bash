#!/usr/bin/env bash
# mpbbatch.bash — Pull (Song, Artist[, videoid]) rows from a public Google
# Sheet and run ./stem.sh on each one serially.
#
# Usage:
#   ./mpbbatch.bash                # foreground, sequential
#   nohup ./mpbbatch.bash &        # detach (survives terminal close)
#
# Configuration:
#   SHEET_ID, GID    — Google Sheet to pull from (must be publicly viewable)
#
# Behavior:
#   - Parses CSV by column name (looks for "Song", "Artist", and "videoid").
#   - Skips rows where Song or Artist is empty.
#   - Skips songs whose folder already has vocals/drums/bass/other.wav
#     (fully stemmed by a prior run).
#   - For each remaining song:
#       * If "videoid" column has a value, passes it to stem.sh as the
#         explicit YouTube ID (bypasses search).
#       * Otherwise stem.sh does its smart search ("official audio" +
#         skip live/concert/cover/etc.).
#   - Runs songs SEQUENTIALLY: waits for each stem.sh to finish before
#     starting the next. One demucs at a time — Mac stays usable.

set -euo pipefail

# Prepend an ISO timestamp to each progress line. Stderr error messages
# are left untouched.
log() { printf '%s %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"; }

# Integer MB used by a directory (base-2), or 0 if it doesn't exist.
dir_mb() {
  local d="$1"
  if [[ -d "$d" ]]; then
    du -sm "$d" 2>/dev/null | awk '{print $1}'
  else
    echo 0
  fi
}

SHEET_ID="1e3DewMjHOmf_OlexPo6E1F_2i69YTYGMemJIZyRQIJA"
GID="47278603"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STEM_SH="$SCRIPT_DIR/stem.sh"
OUT_BASE="$HOME/ClaudeDrive/simpleStem/STEMS"

if [[ ! -x "$STEM_SH" ]]; then
  echo "Missing or non-executable: $STEM_SH" >&2
  exit 1
fi

# Slugify — must match stem.sh exactly so existence checks line up.
slugify() {
  LC_ALL=C printf '%s' "$1" \
    | tr -c 'A-Za-z0-9_-' '_' \
    | tr -s '_' \
    | sed 's/^_//; s/_$//'
}

# Fetch CSV from the public export endpoint
CSV="$(mktemp)"
trap 'rm -f "$CSV"' EXIT
URL="https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}"
START_TS=$(date +%s)
M4A_BASE_DIR="$HOME/ClaudeDrive/simpleStem/M4A"
PRE_STEMS_MB=$(dir_mb "$OUT_BASE")
PRE_M4A_MB=$(dir_mb "$M4A_BASE_DIR")
log ">> Fetching sheet…"
curl -fsSL "$URL" -o "$CSV"
if head -1 "$CSV" | grep -q '<html'; then
  echo "Sheet is not publicly accessible (got HTML, not CSV)." >&2
  echo "Share it as 'Anyone with the link can view' and retry." >&2
  exit 1
fi

# Extract Song<TAB>Artist<TAB>videoid (videoid may be empty)
mapfile -t ROWS < <(python3 - "$CSV" <<'PY'
import csv, sys
with open(sys.argv[1], newline='') as f:
    rows = list(csv.reader(f))
header_idx = None
for i, r in enumerate(rows[:5]):
    cols = [c.strip() for c in r]
    if 'Song' in cols and 'Artist' in cols:
        header_idx = i
        break
if header_idx is None:
    sys.exit("Could not find a header row containing both 'Song' and 'Artist'.")
header = [c.strip() for c in rows[header_idx]]
si = header.index('Song')
ai = header.index('Artist')
vi = header.index('videoid') if 'videoid' in header else None
for row in rows[header_idx + 1:]:
    if len(row) <= max(si, ai):
        continue
    s = row[si].strip()
    a = row[ai].strip()
    v = row[vi].strip() if (vi is not None and len(row) > vi) else ''
    if s and a:
        print(f"{s}\t{a}\t{v}")
PY
)

total=${#ROWS[@]}
log ">> ${total} candidate songs"

count=0
done_count=0
skipped_done=0
skipped_slug=0
failed=0
for row in "${ROWS[@]}"; do
  count=$((count + 1))
  IFS=$'\t' read -r TITLE ARTIST VID <<<"$row"

  ST="$(slugify "$TITLE")"
  SA="$(slugify "$ARTIST")"
  if [[ -z "$ST" || -z "$SA" ]]; then
    log "[$count/$total] SKIP empty slug: '$TITLE' / '$ARTIST'"
    skipped_slug=$((skipped_slug + 1))
    continue
  fi

  DIR="$OUT_BASE/${ST}_${SA}"
  if [[ -f "$DIR/vocals.wav" && -f "$DIR/drums.wav" \
      && -f "$DIR/bass.wav"   && -f "$DIR/other.wav" ]]; then
    log "[$count/$total] DONE   $TITLE / $ARTIST"
    skipped_done=$((skipped_done + 1))
    continue
  fi

  mkdir -p "$DIR"
  LOG="$DIR/run.log"
  if [[ -n "$VID" ]]; then
    log "[$count/$total] RUN    $TITLE / $ARTIST  (videoid=$VID)"
    set +e
    "$STEM_SH" "$TITLE" "$ARTIST" "$VID" > "$LOG" 2>&1
    rc=$?
    set -e
  else
    log "[$count/$total] RUN    $TITLE / $ARTIST  (smart search)"
    set +e
    "$STEM_SH" "$TITLE" "$ARTIST" > "$LOG" 2>&1
    rc=$?
    set -e
  fi
  if [[ $rc -eq 0 ]]; then
    log "         OK   log=$LOG"
    done_count=$((done_count + 1))
  else
    log "         FAIL rc=$rc  log=$LOG"
    failed=$((failed + 1))
  fi
done

echo
log ">> Completed: $done_count.  Already done: $skipped_done.  Failed: $failed.  Empty slugs: $skipped_slug."
log ">> Logs: $OUT_BASE/*/run.log"

# Elapsed wall time + bytes added by this run (post - pre, base-2 MB).
END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
ELAPSED_STR="$((ELAPSED / 3600))h $(((ELAPSED % 3600) / 60))m $((ELAPSED % 60))s"
POST_STEMS_MB=$(dir_mb "$OUT_BASE")
POST_M4A_MB=$(dir_mb "$M4A_BASE_DIR")
DELTA_STEMS_MB=$((POST_STEMS_MB - PRE_STEMS_MB))
DELTA_M4A_MB=$((POST_M4A_MB - PRE_M4A_MB))
log ">> Elapsed: $ELAPSED_STR.  Added this run: STEMS +${DELTA_STEMS_MB} MB, M4A +${DELTA_M4A_MB} MB."
