#!/usr/bin/env bash
# delete_quoted_titles.sh — bulk-remove songs whose TITLE contains a quotation
# mark. Reads titles from each STEMS/<slug>/metadata.json (never from the
# folder name, since slugs strip special chars). Dry-run by default; --go
# actually deletes. Reversible only via git or Time Machine — no soft-move
# trash bin (unlike gig-prune's _pruned/), because these are audio bytes and
# a "quarantine" would just move the disk usage around.
#
# Usage:
#   ./delete_quoted_titles.sh              # dry-run: list what WOULD be deleted
#   ./delete_quoted_titles.sh --go         # actually delete
#   ./delete_quoted_titles.sh --pattern "'" --go   # delete titles containing '
#
# Removes for each match:
#   ~/ClaudeDrive/simpleStem/STEMS/<slug>/       (source + stems + metadata)
#   ~/.bt-cache/STEMS/<slug>/                    (the offline playback mirror)
# Leaves alone:
#   CATALOG.json                                  (will re-emit on next catalog.py)
#   GIGS/*.json                                   (the setlist entries just show
#                                                  as missing; Bill decides)
set -euo pipefail

STAMP() { date '+%a %b %d %H:%M:%S %Z %Y'; }
SELF=delete_quoted_titles.sh
log() { printf '%s  %s  %s\n' "$(STAMP)" "$SELF" "$*"; }

STEMS_DIR="${SIMPLESTEM_STEMS_DIR:-$HOME/ClaudeDrive/simpleStem/STEMS}"
CACHE_DIR="${SIMPLESTEM_CACHE_DIR:-$HOME/.bt-cache/STEMS}"

PATTERN='"'
GO=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --go)      GO=1; shift ;;
    --pattern) PATTERN="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -d "$STEMS_DIR" ]]; then
  log "STEMS dir not found: $STEMS_DIR"
  exit 1
fi

log "scanning $STEMS_DIR for titles containing: $PATTERN"

matches=()
scanned=0
for d in "$STEMS_DIR"/*/; do
  [[ -d "$d" ]] || continue
  scanned=$((scanned + 1))
  meta="$d/metadata.json"
  [[ -f "$meta" ]] || continue
  # Pull the title with python for safe JSON parsing (jq isn't guaranteed).
  title="$(python3 -c "
import json, sys
try:
  with open('$meta') as f: m = json.load(f)
  print(m.get('title', ''))
except Exception:
  pass
" 2>/dev/null || echo '')"
  if [[ "$title" == *"$PATTERN"* ]]; then
    slug="$(basename "$d")"
    matches+=("$slug|$title")
  fi
done

if [[ ${#matches[@]} -eq 0 ]]; then
  log "scanned $scanned folders, no titles contain '$PATTERN' — nothing to do"
  exit 0
fi

log "scanned $scanned folders, ${#matches[@]} match:"
printf '  %s\n' "${matches[@]}"

if [[ "$GO" != "1" ]]; then
  echo
  log "DRY RUN — pass --go to actually delete. Cache mirror at $CACHE_DIR will be cleaned too."
  exit 0
fi

log "DELETING ${#matches[@]} songs (STEMS/ + ~/.bt-cache/STEMS/) …"
removed=0
failed=0
for line in "${matches[@]}"; do
  slug="${line%%|*}"
  src="$STEMS_DIR/$slug"
  cache="$CACHE_DIR/$slug"
  if rm -rf -- "$src"; then
    removed=$((removed + 1))
    log "  removed $src"
  else
    failed=$((failed + 1))
    log "  FAILED $src"
    continue
  fi
  if [[ -d "$cache" ]]; then
    rm -rf -- "$cache" 2>/dev/null && log "  removed $cache"
  fi
done

log "done: removed=$removed failed=$failed"
log "next: rerun catalog.py so CATALOG.json drops the entries"
log "  ./librarian.sh catalog     # on the Librarian"
