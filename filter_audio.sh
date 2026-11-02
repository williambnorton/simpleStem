#!/usr/bin/env bash
# filter_audio.sh — fast keyboard triage of a directory of music files.
#
# Plays the first 10 seconds of each audio file through the system output
# and watches the keyboard:
#
#   D  delete the file      (moved to <dir>/.deleted/ during the session;
#                            you get ONE confirm at the end to purge them
#                            all — speed while triaging, one deliberate
#                            destruction step when you're done)
#   A  archive the file     (moved to <dir>/Archive/)
#   K, space, enter  keep   (advance to the next file)
#   R  replay the same file from the top
#   Q  quit                 (remaining files untouched)
#
# Usage:
#   ./filter_audio.sh <directory> [seconds]     seconds defaults to 10
#
# Runs on any Mac (afplay is built into macOS). Set PLAYER_CMD to override
# the player, e.g. for a machine without afplay:
#   PLAYER_CMD="ffplay -nodisp -autoexit -t {SECS} {FILE}" ./filter_audio.sh ~/Music/triage
set -uo pipefail

DIR="${1:-}"
SECS="${2:-10}"
[[ -d "$DIR" ]] || { echo "usage: $0 <directory> [seconds]" >&2; exit 1; }
DIR="$(cd "$DIR" && pwd)"
ARCHIVE="$DIR/Archive"
TRASH="$DIR/.deleted"

is_audio() {
  case "$(printf '%s' "${1##*.}" | tr '[:upper:]' '[:lower:]')" in
    m4a|mp3|wav|aif|aiff|flac|ogg|opus) return 0 ;;
    *) return 1 ;;
  esac
}

play_start() {
  local f="$1"
  if [[ -n "${PLAYER_CMD:-}" ]]; then
    local cmd="${PLAYER_CMD//\{SECS\}/$SECS}"
    cmd="${cmd//\{FILE\}/\"$f\"}"
    bash -c "$cmd" >/dev/null 2>&1 &
  else
    afplay -t "$SECS" "$f" >/dev/null 2>&1 &
  fi
  PLAYER_PID=$!
}

play_stop() {
  [[ -n "${PLAYER_PID:-}" ]] && kill "$PLAYER_PID" 2>/dev/null
  wait "$PLAYER_PID" 2>/dev/null
  PLAYER_PID=""
}

files=()
while IFS= read -r f; do
  is_audio "$f" && files+=("$f")
done < <(find "$DIR" -maxdepth 1 -type f | sort)

total=${#files[@]}
(( total > 0 )) || { echo "No audio files in $DIR"; exit 0; }
if [[ -z "${PLAYER_CMD:-}" ]] && ! command -v afplay >/dev/null 2>&1; then
  echo "afplay not found (this tool expects macOS). Set PLAYER_CMD to override." >&2
  exit 1
fi

finish_trash() {
  local n
  n="$(find "$TRASH" -type f 2>/dev/null | wc -l | tr -d ' ')"
  (( n > 0 )) || return 0
  echo
  printf '%s file(s) marked for deletion sit in %s\nPurge them now? Type yes to destroy, anything else keeps them there: ' "$n" "$TRASH"
  local ans; read -r ans
  if [[ "$ans" == "yes" ]]; then
    rm -rf "$TRASH"
    echo "purged."
  else
    echo "kept in $TRASH (delete or restore by hand later)."
  fi
}

echo "filter_audio: $total file(s) in $DIR (${SECS}s previews)"
echo "keys: D delete   A archive   K/space/enter keep   R replay   Q quit"
echo

kept=0; deleted=0; archived=0; i=0
for f in "${files[@]}"; do
  i=$(( i + 1 ))
  name="$(basename "$f")"
  while true; do
    printf '[%d/%d] %s  ' "$i" "$total" "$name"
    play_start "$f"
    key=""
    while kill -0 "$PLAYER_PID" 2>/dev/null; do
      if read -rsn1 -t 0.25 key 2>/dev/null; then break; fi
      key=""
    done
    if [[ -z "$key" ]]; then
      read -rsn1 -t 30 key 2>/dev/null || key="k"
    fi
    play_stop
    case "$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" in
      d) mkdir -p "$TRASH"; mv "$f" "$TRASH/$name"; deleted=$(( deleted + 1 ))
         echo "DELETED"; break ;;
      a) mkdir -p "$ARCHIVE"; mv "$f" "$ARCHIVE/$name"; archived=$(( archived + 1 ))
         echo "archived"; break ;;
      r) echo "(replay)"; continue ;;
      q) echo "quit"
         echo
         echo "kept $kept · archived $archived · deleted $deleted (of $total, $(( total - i )) unseen)"
         finish_trash; exit 0 ;;
      *) kept=$(( kept + 1 )); echo "kept"; break ;;
    esac
  done
done

echo
echo "done: kept $kept · archived $archived · deleted $deleted (of $total)"
finish_trash
