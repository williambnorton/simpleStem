#!/usr/bin/env bash
# backfill.sh — enqueue every song that's missing any artifact, so the
# Performer's queue_runner grinds the whole library to completion over days.
#
# "Complete" for a song (STEMS/<base>/) means ALL of:
#   - 6 Demucs stems (vocals drums bass other piano guitar)
#   - 4 m4a mixdowns (-V, -V-G, -V-G-B, DO)
#   - per-stem loops (sentinel: bass+drums.wav)
#   - mixdown loops (sentinel: M4A/<base>_-V_loop1_*bars.m4a)
# Anything missing → the song is re-queued. stem.sh is idempotent (it skips
# artifacts that already exist), so re-queuing a near-complete song only fills
# the gaps; it won't redo finished work.
#
# A job is just the song's metadata.json copied into STEM_QUEUE/<base>.json,
# exactly like the normal pipeline expects. Songs already in the queue are
# skipped (no duplicates). Songs whose source.wav is also missing are reported
# separately — they need re-ingest on the Librarian, not just stemming.
#
# Usage:
#   ./backfill.sh            # DRY RUN — list what would be queued
#   ./backfill.sh --go       # actually enqueue the incomplete songs
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"   # code dir (this clone)
. "$SCRIPT_DIR/lib-common.sh"                  # data_root
BASE="$(data_root)"                            # data dir (Drive)
STEMS="$BASE/STEMS"
M4A="$BASE/M4A"
QUEUE="$BASE/STEM_QUEUE"

GO=0; [[ "${1:-}" == "--go" ]] && GO=1

STEM_FILES=(vocals drums bass other piano guitar)
M4A_SUFFIXES=(-V -V-G -V-G-B DO)

# already-queued bases (avoid duplicates): any *.json under STEM_QUEUE (excl _done/_failed)
declare -A QUEUED
while IFS= read -r j; do
  b="$(basename "$j" .json)"; b="${b#[0-9][0-9]_}"   # strip NN_ setlist prefix
  QUEUED["$b"]=1
done < <(find "$QUEUE" -mindepth 1 -maxdepth 2 -name '*.json' \
           -not -path "$QUEUE/_done/*" -not -path "$QUEUE/_failed/*" 2>/dev/null)

n_total=0 n_complete=0 n_queue=0 n_already=0 n_nosrc=0
mkdir -p "$QUEUE"

for d in "$STEMS"/*/; do
  [[ -d "$d" ]] || continue
  base="$(basename "$d")"
  n_total=$((n_total+1))

  missing=0
  for s in "${STEM_FILES[@]}"; do [[ -f "$d/$s.wav" ]] || { missing=1; break; }; done
  if (( !missing )); then
    for suf in "${M4A_SUFFIXES[@]}"; do [[ -f "$M4A/${base}_${suf}.m4a" ]] || { missing=1; break; }; done
  fi
  [[ -f "$d/bass+drums.wav" ]] || missing=1               # per-stem loops sentinel
  ls "$M4A/${base}_-V_loop1_"*bars.m4a >/dev/null 2>&1 || missing=1   # mixdown loops sentinel

  if (( !missing )); then n_complete=$((n_complete+1)); continue; fi

  if [[ ! -f "$d/source.wav" ]]; then
    echo "  !! $base — incomplete AND no source.wav (re-ingest on Librarian)"; n_nosrc=$((n_nosrc+1)); continue
  fi
  if [[ -n "${QUEUED[$base]:-}" ]]; then n_already=$((n_already+1)); continue; fi
  if [[ ! -f "$d/metadata.json" ]]; then
    echo "  !! $base — incomplete AND no metadata.json (run: librarian.sh catalog)"; continue
  fi

  if (( GO )); then
    cp "$d/metadata.json" "$QUEUE/$base.json"
    echo "  + queued $base"
  else
    echo "  would queue $base"
  fi
  n_queue=$((n_queue+1))
done

echo ""
echo "== backfill summary  (mode: $([[ $GO -eq 1 ]] && echo EXECUTE || echo DRY-RUN))"
echo "   songs total:            $n_total"
echo "   already complete:       $n_complete"
echo "   $([[ $GO -eq 1 ]] && echo 'queued now' || echo 'would queue'):  $n_queue"
echo "   already in queue:       $n_already"
echo "   missing source.wav:     $n_nosrc"
(( GO )) || echo "
   DRY RUN — re-run with --go to enqueue. Then on the Performer:
   ./performer.sh start   (queue_runner will process them; days of CPU)"
