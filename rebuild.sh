#!/usr/bin/env bash
# rebuild.sh — full rebuild of the library, the SAFE way.
#
# "Full rebuild" = regenerate every song's stems + m4a from scratch for a clean,
# uniform library. The catch: you already have 117 rendered songs and their
# cached source.wav files. So the fast, lossless rebuild is:
#
#   1. ARCHIVE (move, never delete) the generated OUTPUTS — the 6 stems, the
#      loops, bass+drums.wav, and the M4A/ mixdowns — into ARCHIVE_<ts>/.
#   2. KEEP each song's source.wav + source.info.json + metadata.json in place;
#      these ARE the cache, so nothing needs re-downloading.
#   3. Rebuild STEM_QUEUE from the kept metadata.json files (setlist grouping,
#      clip windows and source URLs preserved).
#   4. Then run the laptop: ./performer.sh start — queue_runner re-stems each
#      song, reusing the cached source.wav (no re-download).
#
# Nothing is hard-deleted; everything removed is moved under ARCHIVE_<ts>/ so a
# rebuild is fully reversible. Re-stemming 100+ songs is many hours of Demucs on
# the laptop — that's expected.
#
# Flags:
#   (none)      DRY RUN — show exactly what would be archived/re-queued, do nothing.
#   --go        actually perform the rebuild.
#   --refetch   also archive source.wav so songs are re-DOWNLOADED fresh (slower;
#               only if you truly want new source audio, not just new stems).
#
# Usage:
#   ./rebuild.sh                 # preview
#   ./rebuild.sh --go            # re-stem from cached audio
#   ./rebuild.sh --go --refetch  # re-download AND re-stem everything
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # code dir (this clone)
. "$SCRIPT_DIR/lib-common.sh"                  # slugify / data_root
BASE="$(data_root)"                            # data dir (Drive)
STEMS="$BASE/STEMS"
M4A="$BASE/M4A"
QUEUE="$BASE/STEM_QUEUE"

GO=0; REFETCH=0
for a in "$@"; do
  case "$a" in
    --go) GO=1 ;;
    --refetch) REFETCH=1 ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done

TS="$(date +%Y%m%d%H%M%S)"
ARCHIVE="$BASE/ARCHIVE_$TS"

# Outputs to archive out of each STEMS/<base>/ (everything Demucs/loops/mix made).
# Kept: source.wav, source.info.json, metadata.json (the cache + the record).
KEEP_RE='^(source\.wav|source\.info\.json|metadata\.json)$'

say() { printf '%s\n' "$*"; }
run() { if (( GO )); then "$@"; else say "   would: $*"; fi; }

[[ -d "$STEMS" ]] || { echo "no STEMS/ under $BASE" >&2; exit 1; }

# Count + preview
nstems=0; nsrc=0
while IFS= read -r d; do
  nstems=$((nstems+1))
  [[ -f "$d/source.wav" ]] && nsrc=$((nsrc+1))
done < <(find "$STEMS" -mindepth 1 -maxdepth 1 -type d)
nm4a=0; [[ -d "$M4A" ]] && nm4a="$(ls "$M4A"/*.m4a 2>/dev/null | wc -l | tr -d ' ')"

say "== rebuild plan  (mode: $([[ $GO -eq 1 ]] && echo EXECUTE || echo DRY-RUN)$([[ $REFETCH -eq 1 ]] && echo ' +refetch'))"
say "   songs:           $nstems  (with cached source.wav: $nsrc)"
say "   m4a mixdowns:     $nm4a"
say "   archive target:   ARCHIVE_$TS/"
if (( REFETCH )); then
  say "   source.wav:       WILL be archived → re-download at render"
else
  say "   source.wav:       kept in place → reused at render (no download)"
fi
say ""

(( GO )) && mkdir -p "$ARCHIVE/STEMS"

# 1) Archive M4A wholesale.
if [[ -d "$M4A" && "$nm4a" -gt 0 ]]; then
  say ">> archiving M4A/ ($nm4a files)"
  run mv "$M4A" "$ARCHIVE/M4A"
  run mkdir -p "$M4A"
fi
# CATALOG.json is rebuilt by catalog.py later.
[[ -f "$BASE/CATALOG.json" ]] && run mv "$BASE/CATALOG.json" "$ARCHIVE/CATALOG.json"

# 2) Per song: move generated outputs to archive, keep the cache.
say ">> archiving generated stems/loops per song (keeping source.wav + metadata)"
while IFS= read -r d; do
  base="$(basename "$d")"
  # Skip dirs with no metadata.json — they can't be re-queued (we'd have nothing
  # to rebuild a job from), so don't strip their stems. Leave them intact and
  # flag them; fix with `librarian.sh catalog` (drift report) first if you care.
  if [[ ! -f "$d/metadata.json" ]]; then
    say "   $base: SKIPPED (no metadata.json — left intact, not re-queued)"
    continue
  fi
  adir="$ARCHIVE/STEMS/$base"
  moved=0
  while IFS= read -r f; do
    fn="$(basename "$f")"
    [[ "$fn" =~ $KEEP_RE ]] && continue
    if (( REFETCH )) || [[ "$fn" != "source.wav" ]]; then
      if (( GO )); then mkdir -p "$adir"; mv "$f" "$adir/"; fi
      moved=$((moved+1))
    fi
  done < <(find "$d" -mindepth 1 -maxdepth 1 -type f)
  (( moved > 0 )) && say "   $base: archived $moved file(s)"
done < <(find "$STEMS" -mindepth 1 -maxdepth 1 -type d | sort)

# 3) Rebuild STEM_QUEUE from each kept metadata.json (preserve setlists + clips).
say ""
say ">> rebuilding STEM_QUEUE from metadata.json files"
if (( GO )); then
  # stash any existing queue jobs out of the way (reversible)
  if find "$QUEUE" -mindepth 1 -maxdepth 2 -name '*.json' \
       -not -path "$QUEUE/_done/*" -not -path "$QUEUE/_failed/*" 2>/dev/null | grep -q .; then
    mkdir -p "$ARCHIVE/STEM_QUEUE_prev"
    find "$QUEUE" -mindepth 1 -maxdepth 1 -not -name '.*' -exec mv {} "$ARCHIVE/STEM_QUEUE_prev/" \; 2>/dev/null || true
  fi
  mkdir -p "$QUEUE"
fi

nqueued=0
while IFS= read -r meta; do
  d="$(dirname "$meta")"; base="$(basename "$d")"
  # Read grouping fields (one per line; empty for missing).
  mapfile -t F < <(python3 - "$meta" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
def g(k):
    v=d.get(k); return '' if v is None else str(v)
print(g('playlist_title')); print(g('sequence_number')); print(g('title')); print(g('artist'))
PY
)
  ptitle="${F[0]:-}"; seq="${F[1]:-}"
  if [[ -n "$ptitle" ]]; then
    sub="$QUEUE/$(slugify "$ptitle")"
    if [[ -n "$seq" ]]; then name="$(printf '%02d_%s.json' "$seq" "$base")"; else name="$base.json"; fi
    if (( GO )); then mkdir -p "$sub"; cp "$meta" "$sub/$name"; fi
  else
    if (( GO )); then cp "$meta" "$QUEUE/$base.json"; fi
  fi
  nqueued=$((nqueued+1))
done < <(find "$STEMS" -mindepth 2 -maxdepth 2 -name metadata.json | sort)
say "   re-queued $nqueued job(s)"

say ""
if (( GO )); then
  say "== rebuild staged. Next, on the LAPTOP:  ./performer.sh start"
  say "   (re-stems $nqueued songs$([[ $REFETCH -eq 1 ]] && echo ', re-downloading first'); archive at ARCHIVE_$TS/)"
else
  say "== DRY RUN only — nothing changed. Re-run with --go to execute."
fi
