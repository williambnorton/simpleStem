#!/usr/bin/env bash
# lib-common.sh — shared helpers sourced by the pipeline scripts.
#
# The important one is the slug convention. Until now two scripts disagreed:
# stem.sh slugified title and artist SEPARATELY (case preserved) to build the
# STEMS/<dir>, while webloc_watch.sh slugified the combined lowercased string to
# name the queue job. That mismatch is why a job file (magic_man_heart.json) and
# its render dir (Magic_Man_Heart) had different names — harmless before, but
# fatal for a cache that depends on both sides computing the SAME path.
#
# Canonical rule (matches the 117 existing STEMS dirs, i.e. stem.sh's slugify):
#   slugify:   ASCII alnum + _ - only; everything else -> _; collapse; trim.
#   song_base: "<slugify title>_<slugify artist>"  — the per-song key used for
#              STEMS/<base>/, the M4A/<base>_<suffix>.m4a prefix, and the
#              CATALOG.json key.
#
# Source this file: . "$(dirname "$0")/lib-common.sh"

slugify() {
  LC_ALL=C printf '%s' "$1" \
    | tr -c 'A-Za-z0-9_-' '_' \
    | tr -s '_' \
    | sed 's/^_//; s/_$//'
}

# song_base TITLE ARTIST  → canonical per-song key
song_base() { printf '%s_%s' "$(slugify "$1")" "$(slugify "$2")"; }

# video_id URL_OR_ID → the bare YouTube 11-char video id, or '' if none.
# source_url is stored inconsistently across the library (sometimes a full
# watch?v= URL, sometimes a bare id, sometimes a youtu.be link). Setlist sync
# matches songs to playlist entries by this stable id, so both producer and
# consumer must derive it the same way. Pure bash/sed — no python needed.
video_id() {
  local s="$1"
  case "$s" in
    *v=*)        s="${s#*v=}"; s="${s%%&*}" ;;          # watch?v=ID&...
    *youtu.be/*) s="${s#*youtu.be/}"; s="${s%%\?*}"; s="${s%%&*}" ;;
    *embed/*)    s="${s#*embed/}"; s="${s%%\?*}"; s="${s%%&*}" ;;
    *shorts/*)   s="${s#*shorts/}"; s="${s%%\?*}"; s="${s%%&*}" ;;
  esac
  # a bare id is 11 chars of [A-Za-z0-9_-]; reject anything else.
  if [[ "$s" =~ ^[A-Za-z0-9_-]{11}$ ]]; then printf '%s' "$s"; else printf ''; fi
}
