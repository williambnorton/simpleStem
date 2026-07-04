#!/usr/bin/env bash
# autoupdate_librarian.sh — one auto-update pass for the Librarian (Mac mini).
#
# The Performer edits code and pushes to GitHub; the mini should follow
# origin/main without a human at the keyboard. librarian.sh runs this script
# in a loop (the `autoupdate` service, one pass every 120s). Each pass:
#
#   1. Guard: only runs when the hostname (lowercased) contains "librarian"
#      or "mini", or SIMPLE_STEM_FORCE_AUTOUPDATE=1 is set. The same clone
#      lives on the Performer laptop, and an unattended pull+restart there
#      mid-gig would be a show-stopper.
#   2. git fetch origin main, bounded with `timeout` when available (macOS
#      ships without GNU timeout unless coreutils is installed). A failed
#      fetch (offline, GitHub down) is logged and treated as success — the
#      next pass retries.
#   3. Already up to date → keep $DATA/.code-version fresh (rewrite only
#      when the recorded hash differs; the marker lives on Drive and
#      gratuitous writes churn sync), exit 0.
#   4. Local uncommitted changes → LOUD warning, no action. This script
#      never stashes or discards anything; a human decides.
#   5. Fast-forward possible → git pull --ff-only, write the marker, and
#      spawn a DETACHED `librarian.sh restart`. Detached because the
#      restart kills the very service loop this script runs inside.
#   6. Histories diverged → LOUD log, exit 0 (human decision).
#
# Log lines follow the CLAUDE.md long-running-script shape:
#   Mon Jun 29 11:19:45 PDT 2026  autoupdate_librarian.sh  message
set -uo pipefail

BASE="$(cd "$(dirname "$0")" && pwd)"      # where the code lives (this clone)
. "$BASE/lib-common.sh"
DATA="$(data_root)"                         # where the audio/data lives (Drive)
MARKER="$DATA/.code-version"
SELF="autoupdate_librarian.sh"

log() { printf '%s  %s  %s\n' "$(date '+%a %b %d %H:%M:%S %Z %Y')" "$SELF" "$*"; }

# ---- Guard: Librarian machines only (or explicit override) ---------------
HOST_LC="$(hostname | tr '[:upper:]' '[:lower:]')"
if [[ "${SIMPLE_STEM_FORCE_AUTOUPDATE:-}" != "1" \
      && "$HOST_LC" != *librarian* && "$HOST_LC" != *mini* ]]; then
  log "refusing to run: hostname '$HOST_LC' does not look like a Librarian machine (set SIMPLE_STEM_FORCE_AUTOUPDATE=1 to override)"
  exit 0
fi

# ---- Fetch (bounded) ------------------------------------------------------
fetch_ok=0
if command -v timeout >/dev/null 2>&1; then
  timeout 60 git -C "$BASE" fetch --quiet origin main && fetch_ok=1
else
  git -C "$BASE" fetch --quiet origin main && fetch_ok=1
fi
if [[ "$fetch_ok" != "1" ]]; then
  log "fetch failed (offline or GitHub unreachable) — skipping this pass"
  exit 0
fi

LOCAL="$(git -C "$BASE" rev-parse HEAD 2>/dev/null)" \
  || { log "cannot resolve HEAD — is $BASE a git clone?"; exit 0; }
REMOTE="$(git -C "$BASE" rev-parse origin/main 2>/dev/null)" \
  || { log "cannot resolve origin/main"; exit 0; }

write_marker() {
  printf '%s %s %s\n' "$1" "$(date '+%a %b %d %H:%M:%S %Z %Y')" "$(hostname)" > "$MARKER"
}

# ---- Already up to date ---------------------------------------------------
if [[ "$LOCAL" == "$REMOTE" ]]; then
  current_hash="$(awk 'NR==1{print $1}' "$MARKER" 2>/dev/null || true)"
  if [[ "$current_hash" != "$LOCAL" ]]; then
    write_marker "$LOCAL"
    log "up to date at ${LOCAL:0:10} — marker refreshed"
  fi
  exit 0
fi

# ---- Dirty clone blocks the update ---------------------------------------
if [[ -n "$(git -C "$BASE" status --porcelain 2>/dev/null)" ]]; then
  log "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  log "!! LOCAL CHANGES BLOCK AUTO-UPDATE on $HOST_LC"
  log "!! origin/main is at ${REMOTE:0:10} but this clone has uncommitted edits."
  log "!! Nothing was stashed or discarded. To let auto-update proceed:"
  log "!!   cd $BASE && git stash        (or commit / discard the changes)"
  log "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  exit 0
fi

# ---- Fast-forward pull + detached restart ---------------------------------
if git -C "$BASE" merge-base --is-ancestor HEAD origin/main; then
  log "update available: ${LOCAL:0:10} → ${REMOTE:0:10} — pulling (ff-only)"
  if git -C "$BASE" pull --ff-only --quiet origin main; then
    write_marker "$REMOTE"
    log "pulled to ${REMOTE:0:10} — scheduling detached librarian restart in 2s"
    mkdir -p "$BASE/.run"
    nohup bash -c "sleep 2; cd '$BASE' && ./librarian.sh restart" >>"$BASE/.run/lib-autoupdate.log" 2>&1 &
    disown
    exit 0
  fi
  log "!! pull --ff-only FAILED after a clean ancestor check — leaving the clone as-is for a human"
  exit 0
fi

# ---- Diverged: human decision ---------------------------------------------
log "!! HISTORIES DIVERGED: HEAD ${LOCAL:0:10} is not an ancestor of origin/main ${REMOTE:0:10}"
log "!! Auto-update will not merge or rebase. Resolve by hand on the mini:"
log "!!   cd $BASE && git status && git log --oneline HEAD...origin/main"
exit 0
