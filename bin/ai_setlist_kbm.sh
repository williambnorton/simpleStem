#!/usr/bin/env bash
# ai_setlist_kbm.sh — bridge between simpleStem and one or more chatbot
# windows driven by Keyboard Maestro macros.
#
# Usage (called by server.js when the operator clicks Generate):
#   ai_setlist_kbm.sh <job_dir> <bots_csv>
#
# Where <job_dir> is something like
#   ~/ClaudeDrive/simpleStem/AI_SETLIST/20260616_193045_a7c4/
# and contains:
#   prompt.txt        -- full prompt (same prompt sent to every bot)
#   library.json      -- the band's song library (for reference)
#   meta.json         -- { job_id, description, library_size, bots, status }
#   <bot>/             -- one subdirectory per selected bot, e.g.
#     claude/prompt.txt        (copy of the prompt for convenience)
#     claude/response.txt      (macro writes the reply here)
#     chatgpt/...
#
# And <bots_csv> is a comma-separated list of bot IDs the operator
# picked, e.g. "claude,chatgpt,gemini".
#
# This script's only job is to TRIGGER each bot's Keyboard Maestro
# macro. One macro per bot, all named on the pattern:
#
#   simpleStem AI Setlist Bridge - <BotName>
#
# Where <BotName> is one of: Claude, ChatGPT, Gemini, DeepSeek,
# Perplexity, Grok. (See bin/AI_SETLIST_KBM_README.md for the macro
# contract.)
#
# Each macro receives the PER-BOT subdirectory as %TriggerValue% so it
# can read prompt.txt from that subdir and write response.txt into it
# when the chat reply is ready.
#
# Server-side poll: /api/setlist/ai-generate/poll/:job_id checks each
# bot's response.txt as it appears, parses the JSON, and returns the
# setlist to the browser per-bot. Each bot's card flips from "Waiting"
# to "Ready" independently.

set -euo pipefail

JOB_DIR="${1:-}"
BOTS_CSV="${2:-}"
if [ -z "$JOB_DIR" ] || [ ! -d "$JOB_DIR" ]; then
  echo "[ai-setlist-kbm] missing or invalid job_dir argument: '$JOB_DIR'" >&2
  exit 64
fi
if [ -z "$BOTS_CSV" ]; then
  echo "[ai-setlist-kbm] missing bots_csv argument (e.g. 'claude,chatgpt')" >&2
  exit 64
fi

# Map of bot id -> KBM macro suffix. Keep in sync with AI_SETLIST_BOTS
# in server.js. If a bot ID isn't recognized here, we skip it and log
# a warning; the operator can still paste the reply by hand from the
# portal's per-bot manual-paste fallback.
bot_macro_name() {
  case "$1" in
    claude)     echo "Claude"     ;;
    chatgpt)    echo "ChatGPT"    ;;
    gemini)     echo "Gemini"     ;;
    deepseek)   echo "DeepSeek"   ;;
    perplexity) echo "Perplexity" ;;
    grok)       echo "Grok"       ;;
    *)          echo ""           ;;
  esac
}

urlencode() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"
  else
    echo "$1"
  fi
}

IFS=',' read -r -a BOT_LIST <<< "$BOTS_CSV"
for BOT_ID in "${BOT_LIST[@]}"; do
  BOT_ID="$(echo "$BOT_ID" | tr -d '[:space:]')"
  [ -z "$BOT_ID" ] && continue
  BOT_DIR="$JOB_DIR/$BOT_ID"
  if [ ! -d "$BOT_DIR" ]; then
    echo "[ai-setlist-kbm] WARN: bot dir missing for $BOT_ID at $BOT_DIR — skipping" >&2
    continue
  fi
  SUFFIX="$(bot_macro_name "$BOT_ID")"
  if [ -z "$SUFFIX" ]; then
    echo "[ai-setlist-kbm] WARN: no KBM macro suffix mapped for $BOT_ID — operator can paste reply manually from the portal" >&2
    continue
  fi
  MACRO_NAME="simpleStem AI Setlist Bridge - $SUFFIX"
  MACRO_NAME_ENC="$(urlencode "$MACRO_NAME")"
  TRIGGER_VALUE_ENC="$(urlencode "$BOT_DIR")"
  URL="kmtrigger://macro=${MACRO_NAME_ENC}&value=${TRIGGER_VALUE_ENC}"
  echo "[ai-setlist-kbm] firing $BOT_ID → $URL"
  open "$URL"
done

echo "[ai-setlist-kbm] job_dir=$JOB_DIR bots=$BOTS_CSV"
echo "[ai-setlist-kbm] each bot writes <job_dir>/<bot>/response.txt; portal polls and renders per-bot"
