#!/bin/bash
# webloc_drop.sh — drop a YouTube URL into the simpleStem ingest pipeline.
#
# Same end result as pasting the URL into the portal's "Add from YouTube"
# box: a .webloc lands in INCOMING_WEBLOC/, webloc_watch.sh picks it up,
# and the song flows through STEM_QUEUE → queue_runner → stem.sh.
#
# Used by:
#   - the Chrome Quick Action "Send to simpleStem" (install_chrome_quick_action.sh)
#   - any other automation that wants to queue a URL without the portal
#
# Naming pattern mirrors bt-construction-kit/server.js POST /api/enqueue
# exactly, except the prefix is "chrome_" instead of "portal_" so log scans
# can tell Quick Action drops from portal drops at a glance.
#
# Usage:
#   webloc_drop.sh <youtube-url>
# Prints the path of the dropped file on stdout (handy for automation).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-common.sh
. "$DIR/lib-common.sh"

URL="${1:-}"
# Trim leading + trailing whitespace (paste from Chrome can sneak in
# trailing newlines depending on the selection). Bash pattern-substitution
# style — no python/awk dependency.
URL="${URL#"${URL%%[![:space:]]*}"}"
URL="${URL%"${URL##*[![:space:]]}"}"

if [[ -z "$URL" ]]; then
  echo "webloc_drop: empty URL" >&2
  exit 1
fi

# Match the portal's URL-shape gate. Loose intentionally: the watcher
# itself handles single videos, playlists, and chaptered "full album"
# videos — we just need to keep obvious non-YouTube selections out.
if ! [[ "$URL" =~ ^https?://(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)/ ]]; then
  echo "webloc_drop: not a YouTube URL: $URL" >&2
  exit 2
fi

ROOT="$(data_root)"
INBOX="$ROOT/INCOMING_WEBLOC"
mkdir -p "$INBOX"

# Pull the 11-char video id when present. Falls back to "link" so playlist-
# only URLs (?list=...) still get a useful suffix in the filename.
VID="$(video_id "$URL" || true)"
if [[ -z "$VID" ]]; then
  # Mirror the portal's secondary regex: list= for playlist-only URLs.
  if [[ "$URL" =~ [\?\&]list=([A-Za-z0-9_-]+) ]]; then
    VID="${BASH_REMATCH[1]:0:20}"
  fi
fi
TAG="${VID:-link}"

# ISO-8601 UTC stamp, : and . replaced by - so it's filesystem-safe.
# Portal uses Date.prototype.toISOString().replace(/[:.]/g, '-') which
# produces e.g. 2026-06-27T15-32-08-471Z. We match the same shape.
STAMP="$(date -u +%Y-%m-%dT%H-%M-%S-000Z)"

FILE="$INBOX/chrome_${STAMP}_${TAG}.webloc"

# XML escape the URL body. & < > are the only chars that matter inside a
# plist <string>; quotes and apostrophes do not need escaping here.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
ESC_URL="$(xml_escape "$URL")"

cat >"$FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>URL</key>
	<string>$ESC_URL</string>
</dict>
</plist>
EOF

echo "$FILE"
