#!/bin/bash
# sync_to_drive.sh — push every tracked code file from this git clone into
# ~/ClaudeDrive/simpleStem (the Drive-synced "live" copy that performer.sh
# and librarian.sh execute from). Replaces the brittle "git pull in Drive"
# step — Drive no longer touches .git, so it can't corrupt it.
#
# Run after every `git pull` on either machine. Idempotent and fast.
#
# Run from EITHER ~/simpleStem-code (canonical) OR anywhere — script
# resolves its own location.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIVE="$HOME/ClaudeDrive/simpleStem"

if [[ ! -d "$DRIVE" ]]; then
  echo "Drive copy not found at $DRIVE" >&2
  exit 1
fi

echo "Syncing code from $DIR → $DRIVE …"

cd "$DIR"
# Only tracked files — never push junk, never touch data dirs (STEMS/,
# M4A/, GIGS/, SETLISTS/, etc. are all gitignored and stay untouched).
TRACKED="$(mktemp)"
trap 'rm -f "$TRACKED"' EXIT
git ls-files > "$TRACKED"

rsync -a --files-from="$TRACKED" "$DIR/" "$DRIVE/"

# Re-assert exec bits — rsync preserves perms but only if the source side
# had them. Files newly added via Edit/Write sometimes ship without +x.
for f in webloc_watch.sh stem.sh queue_runner.sh studio.sh \
         performer.sh librarian.sh webloc_drop.sh \
         install_chrome_quick_action.sh sync_to_drive.sh \
         catalog.py metadata.py mpb_sync.py post_process.py \
         section_detect.py cleanup_stems_wav.py \
         backfill_section_detect.sh \
         build_drum_machine.py loop_regenerate.py make_stems_offline.sh \
         rename_loops_with_key.py rebuild.sh install.sh; do
  if [[ -e "$DRIVE/$f" ]]; then chmod +x "$DRIVE/$f"; fi
done

echo "done. $(wc -l < "$TRACKED" | tr -d ' ') tracked files mirrored."
