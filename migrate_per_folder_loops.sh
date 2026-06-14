#!/usr/bin/env bash
# migrate_per_folder_loops.sh — One-time migration. Walk every STEMS/<song>/
# folder and move legacy per-song loop files into the flat LOOPS/ folder
# under the canonical name the modern pipeline expects.
#
# Why this exists:
#   - stem.sh in earlier revisions wrote loops INSIDE each STEMS/<song>/
#     folder (e.g. drums_loop1_27bars.m4a). The current pipeline writes
#     them to a flat LOOPS/ folder with the name
#     <inst>_<bpm>_<songSlug>_<bars>bars.m4a so a single index can be
#     served instead of walking 300+ song folders on every load.
#   - The portal still picks up per-folder loops via the fallback in
#     scanStems() (server.js:343), but that's an inconsistency: half the
#     loops live in one place, half in another. This script consolidates.
#
# Inputs: STEMS/<song>/<inst>_loop<N>_<bars>bars.m4a   (legacy)
# Output: LOOPS/<inst>_<bpm>_<songSlug>_<bars>bars.m4a (canonical)
#
# Derivation:
#   inst       — taken from the legacy filename
#   bpm        — read from STEMS/<song>/metadata.json (rounded to integer)
#   songSlug   — songSlugForLoops(title): lowercase, non-alphanum → _,
#                trim leading/trailing _
#   bars       — taken from the legacy filename
#
# Idempotent: if the canonical LOOPS/ file already exists, the legacy file
# is only removed if --force is set. .wav legacy loops are ignored
# (modern pipeline is m4a-only; if you have wav-only loops, run
# loop_regenerate.py to produce m4a versions first).
#
# Usage:
#   ./migrate_per_folder_loops.sh                  dry-run report
#   ./migrate_per_folder_loops.sh --go             actually move
#   ./migrate_per_folder_loops.sh --go --force     overwrite existing
#                                                  LOOPS/ files

set -uo pipefail

ROOT="${SIMPLE_STEM_ROOT:-$HOME/ClaudeDrive/simpleStem}"
STEMS_DIR="$ROOT/STEMS"
LOOPS_DIR="$ROOT/LOOPS"
GO=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --go)    GO=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ -d "$STEMS_DIR" ]] || { echo "ERROR: STEMS_DIR not found: $STEMS_DIR" >&2; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: python3 required" >&2; exit 1; }

mkdir -p "$LOOPS_DIR"

# songSlugForLoops in JS:
#   text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
slug() {
  python3 -c "
import re,sys
s=sys.argv[1].lower()
s=re.sub(r'[^a-z0-9]+','_',s)
s=re.sub(r'^_+|_+\$','',s)
print(s)
" "$1"
}

# Round bpm to integer from metadata.json. Empty if missing.
bpm_of() {
  python3 -c "
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    b=d.get('bpm')
    if isinstance(b,(int,float)) and b>0:
        print(int(round(b)))
except Exception:
    pass
" "$1"
}

# Title for slug (falls back to folder name with _ → space).
title_of() {
  local meta="$1" folder="$2"
  python3 -c "
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    t=d.get('title')
    if isinstance(t,str) and t.strip():
        print(t.strip()); raise SystemExit
except Exception:
    pass
print(sys.argv[2].replace('_',' '))
" "$meta" "$folder"
}

LEGACY_RE='^([a-z+]+)_loop([0-9]+)_([0-9]+)bars\.m4a$'

planned=0
skipped=0
missing_bpm=0
already_canonical=0
collisions=0

while IFS= read -r -d '' song_dir; do
  base="$(basename "$song_dir")"
  meta="$song_dir/metadata.json"
  bpm=""
  if [[ -f "$meta" ]]; then bpm="$(bpm_of "$meta")"; fi
  for f in "$song_dir"/*_loop*_*bars.m4a; do
    [[ -e "$f" ]] || continue   # nullglob substitute
    fname="$(basename "$f")"
    if [[ ! $fname =~ $LEGACY_RE ]]; then
      continue
    fi
    inst="${BASH_REMATCH[1]}"
    bars="${BASH_REMATCH[3]}"
    if [[ -z "$bpm" ]]; then
      echo "   ! $base/$fname — no bpm in metadata, skipping" >&2
      missing_bpm=$((missing_bpm+1))
      continue
    fi
    title="$(title_of "$meta" "$base")"
    songslug="$(slug "$title")"
    canonical="${inst}_${bpm}_${songslug}_${bars}bars.m4a"
    dst="$LOOPS_DIR/$canonical"
    if [[ -e "$dst" ]] && [[ $FORCE -eq 0 ]]; then
      already_canonical=$((already_canonical+1))
      if [[ $GO -eq 0 ]]; then
        echo "     $base/$fname  -- LOOPS/$canonical already exists (skip; use --force to overwrite)"
      fi
      continue
    fi
    planned=$((planned+1))
    if [[ $GO -eq 0 ]]; then
      printf "     %-60s -> %s\n" "$base/$fname" "LOOPS/$canonical"
    else
      mv -f "$f" "$dst" && echo "  + moved $base/$fname -> LOOPS/$canonical"
    fi
  done
done < <(find "$STEMS_DIR" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)

echo ""
if [[ $GO -eq 0 ]]; then
  echo "== DRY RUN: $planned legacy loops would move, $already_canonical already canonical, $missing_bpm missing bpm."
  echo "== Re-run with --go to actually move them."
else
  echo "== DONE: $planned legacy loops migrated, $already_canonical already canonical, $missing_bpm skipped (missing bpm)."
fi
