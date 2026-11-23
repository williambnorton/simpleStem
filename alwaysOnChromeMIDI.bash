#!/usr/bin/env bash
# alwaysOnChromeMIDI.bash — run simpleStem in a Chrome that never throttles it.
#
# Chrome slows timers in background tabs and covered windows to about once a
# second, which smears the MPL sequencer and the Performer's click/MIDI clock.
# This opens the Performer and the MIDI console as app windows in a separate
# Chrome profile (~/.simplestem-chrome) launched with throttling turned off.
# It runs alongside your normal Chrome. Run it on the Performer.
#
# Usage: ./alwaysOnChromeMIDI.bash          (PORT=3000 by default)

PORT="${PORT:-3000}"
PROFILE="$HOME/.simplestem-chrome"
FLAGS=(
  --user-data-dir="$PROFILE"
  --disable-background-timer-throttling
  --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows
)

echo "$(date '+%H:%M:%S %Z') alwaysOnChromeMIDI: opening Performer + MIDI console on port $PORT (profile $PROFILE)"
open -na "Google Chrome" --args "${FLAGS[@]}" --app="http://localhost:$PORT/"
sleep 2
open -na "Google Chrome" --args "${FLAGS[@]}" --app="http://localhost:$PORT/midi-console.html"
echo "$(date '+%H:%M:%S %Z') alwaysOnChromeMIDI: done — flags apply only while this profile's Chrome was started by this script"
