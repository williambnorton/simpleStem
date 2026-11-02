#!/usr/bin/env bash
# backfill_source_m4a.sh — give every song its stereo original as
# STEMS/<folder>/<folder>_SOURCE.m4a and keep no WAVs (Bill 2026-11-01;
# CONTRACTS F-1, F-9).
#
# Where each song's original comes from, first match wins:
#   1. AUDIO_SOURCES/<folder>.m4a   copied as-is (already the right m4a)
#   2. source.wav that is ON THIS DISK   encoded (exact match to the stems)
#   3. metadata.json source_url   re-fetched from YouTube, audio only
# A source.wav that lives only in the cloud (Google Drive streaming) is NOT
# downloaded — at ~50 MB each that is ~19 GB; YouTube audio is ~4 MB.
#
# YouTube pacing, to stay clear of its anti-bot blocking:
#   - one fetch at a time, a random 60–180 s pause between fetches
#     (FETCH_GAP_MIN / FETCH_GAP_MAX, seconds)
#   - audio-only m4a stream (one request, no video, no merging), yt-dlp's
#     own --sleep-requests, a modest --limit-rate, a few retries
#   - each video id fetched once per run, even if two folders share it
#   - on a bot check / HTTP 429: stop fetching, wait 30 min, then 60, 120
#     (BOT_BACKOFF_MIN), retry the same song; after 4 blocks in a row it
#     exits — re-run later, it resumes where it stopped
#   - COOKIES_FROM=chrome sends your Chrome YouTube login with each fetch
#     (the strongest anti-block step; macOS asks once for Keychain access)
#
# WAV prune (PRUNE_WAV=1, the default) — only in a folder that HAS its
# _SOURCE.m4a: deletes source.wav and its Drive duplicates ("source (1).wav",
# "source 2.wav"), any stem WAV whose .m4a twin exists, and the retired
# bass+drums.wav / *_loop*_*bars.wav files. Any other WAV is listed and
# kept. Deletes on Google Drive go to Drive's trash (kept 30 days).
#
# Usage (Performer — the Drive files must be reachable):
#   DRY_RUN=1 ./backfill_source_m4a.sh   # plan only: counts, nothing written
#   ./backfill_source_m4a.sh             # do it (hours: one fetch per 1–3 min)
# Safe to stop (Ctrl-C) and re-run: finished songs are skipped, and every
# file is written to a .tmp name and renamed only when complete.

set -uo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$BASE_DIR/lib-common.sh" 2>/dev/null || true
DATA_ROOT="$({ command -v data_root >/dev/null 2>&1 && data_root; } || echo "$HOME/ClaudeDrive/simpleStem")"
STEMS_DIR="$DATA_ROOT/STEMS"
SOURCES_DIR="$DATA_ROOT/AUDIO_SOURCES"
ME="$(basename "$0")"

GAP_MIN="${FETCH_GAP_MIN:-60}"
GAP_MAX="${FETCH_GAP_MAX:-180}"
BACKOFF_MIN="${BOT_BACKOFF_MIN:-30}"
MAX_BLOCKS="${MAX_BOT_BLOCKS:-4}"
PRUNE="${PRUNE_WAV:-1}"
COOKIES="${COOKIES_FROM:-}"

[[ -d "$STEMS_DIR" ]] || { echo "STEMS dir not found at $STEMS_DIR" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found on PATH — brew install ffmpeg" >&2; exit 1; }
YTDLP="$(command -v yt-dlp || ls /opt/homebrew/bin/yt-dlp /usr/local/bin/yt-dlp 2>/dev/null | head -1)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/srcfetch.XXXXXX")"
mkdir -p "$WORK/ids"
trap 'rm -rf "$WORK"' EXIT

ts()  { date '+%a %b %d %H:%M:%S %Z %Y'; }
log() { echo "$(ts)  $ME  $*"; }

# A Drive-streamed file that isn't on this disk is "dataless" on macOS.
cloud_only() { [[ "$(uname)" == Darwin ]] && ls -lO "$1" 2>/dev/null | grep -q dataless; }
size_of()    { ls -ln "$1" 2>/dev/null | awk '{print $5+0}'; }

encode_to() {
  local in="$1" out="$2" tmp="${2%.m4a}.tmp.m4a"
  if ffmpeg -y -loglevel error -i "$in" -vn -ac 2 -c:a aac -b:a 256k \
            -movflags +faststart -brand mp42 "$tmp" </dev/null; then
    mv -f "$tmp" "$out"
  else
    rm -f "$tmp"; return 1
  fi
}

source_url_of() {
  [[ -f "$1/metadata.json" ]] || return 0
  python3 - "$1/metadata.json" <<'PYU' 2>/dev/null
import json, sys
try:
    print((json.load(open(sys.argv[1])).get("source_url") or "").strip())
except Exception:
    pass
PYU
}

vid_of() {
  if command -v video_id >/dev/null 2>&1; then video_id "$1"; else printf ''; fi
}

# fetch URL → $WORK/got.<ext>. Returns 0 ok, 2 blocked by YouTube, 1 other.
fetch_audio() {
  local url="$1" id="$2" err="$WORK/err.txt" f
  rm -f "$WORK"/dl.* "$WORK"/got.*
  if [[ -n "$id" ]]; then
    f="$(ls "$WORK/ids/$id".* 2>/dev/null | head -1)"
    if [[ -n "$f" ]]; then cp "$f" "$WORK/got.${f##*.}"; return 0; fi
  fi
  local args=(--no-warnings --no-playlist --no-progress -q
              -f 'bestaudio[ext=m4a]/bestaudio'
              --sleep-requests 2 --retries 3 --limit-rate 4M
              -o "$WORK/dl.%(ext)s")
  [[ -n "$COOKIES" ]] && args+=(--cookies-from-browser "$COOKIES")
  "$YTDLP" "${args[@]}" "$url" </dev/null 2>"$err"
  f="$(ls "$WORK"/dl.* 2>/dev/null | grep -v '\.part$' | head -1)"
  if [[ -n "$f" ]]; then
    [[ -n "$id" ]] && cp "$f" "$WORK/ids/$id.${f##*.}"
    mv "$f" "$WORK/got.${f##*.}"
    return 0
  fi
  if grep -qiE "not a bot|sign in to confirm|HTTP Error 429|too many requests|rate.?limit" "$err"; then
    return 2
  fi
  return 1
}

pruned=0; pruned_bytes=0; kept_other=0
prune_wavs() {
  local d="$1" f b sz
  [[ "$PRUNE" == "1" ]] || return 0
  for f in "$d"/*.wav "$d"/*.WAV; do
    [[ -f "$f" ]] || continue
    b="$(basename "$f")"
    case "$b" in
      source.wav|source\ *.wav) ;;
      vocals.wav|drums.wav|bass.wav|guitar.wav|piano.wav|other.wav)
        if [[ ! -f "$d/${b%.wav}.m4a" ]]; then
          echo "   keep (no ${b%.wav}.m4a yet): $(basename "$d")/$b"; kept_other=$(( kept_other + 1 )); continue
        fi ;;
      bass+drums.wav|*_loop*_*bars.wav) ;;
      *) echo "   keep (not a simpleStem file): $(basename "$d")/$b"; kept_other=$(( kept_other + 1 )); continue ;;
    esac
    sz="$(size_of "$f")"
    if [[ -n "${DRY_RUN:-}" ]] || rm -f -- "$f"; then
      pruned=$(( pruned + 1 )); pruned_bytes=$(( pruned_bytes + ${sz:-0} ))
    fi
  done
}

# ── Plan ──────────────────────────────────────────────────────────────
folders=()
while IFS= read -r -d '' d; do folders+=("$d"); done \
  < <(find "$STEMS_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print0 | sort -z)
total=${#folders[@]}

n_have=0; n_copy=0; n_encode=0; n_fetch=0; n_none=0
plan=()
for d in "${folders[@]}"; do
  base="$(basename "$d")"
  if   [[ -f "$d/${base}_SOURCE.m4a" ]];  then plan+=(have);   n_have=$(( n_have + 1 ))
  elif [[ -f "$SOURCES_DIR/$base.m4a" ]]; then plan+=(copy);   n_copy=$(( n_copy + 1 ))
  elif [[ -f "$d/source.wav" ]] && ! cloud_only "$d/source.wav"; then plan+=(encode); n_encode=$(( n_encode + 1 ))
  elif [[ -n "$(source_url_of "$d")" ]];  then plan+=(fetch);  n_fetch=$(( n_fetch + 1 ))
  else plan+=(none); n_none=$(( n_none + 1 ))
  fi
done
log "plan: $total folders — $n_have already have _SOURCE.m4a, $n_copy copy from AUDIO_SOURCES, $n_encode encode local source.wav, $n_fetch fetch from YouTube, $n_none no source (skipped)"
if (( n_fetch > 0 )); then
  [[ -n "$YTDLP" ]] || { echo "yt-dlp not found — brew install yt-dlp" >&2; exit 1; }
  avg=$(( (GAP_MIN + GAP_MAX) / 2 + 15 ))
  log "YouTube pacing: one fetch every ${GAP_MIN}–${GAP_MAX} s → about $(( n_fetch * avg / 3600 ))h $(( n_fetch * avg % 3600 / 60 ))m for $n_fetch fetches${COOKIES:+ (with $COOKIES cookies)}"
fi

# ── Work ──────────────────────────────────────────────────────────────
ok=0; failed=0; fetched=0; blocks=0; last_fetch=0; t0=$(date +%s); fetch_t0=0
for i in "${!folders[@]}"; do
  d="${folders[$i]}"; base="$(basename "$d")"; out="$d/${base}_SOURCE.m4a"
  case "${plan[$i]}" in
    have) ;;
    none) ;;
    copy)
      if [[ -z "${DRY_RUN:-}" ]]; then
        if cp "$SOURCES_DIR/$base.m4a" "${out%.m4a}.tmp.m4a" && mv -f "${out%.m4a}.tmp.m4a" "$out"; then
          ok=$(( ok + 1 )); log "copied   $base"
        else
          rm -f "${out%.m4a}.tmp.m4a"; failed=$(( failed + 1 )); log "!! copy failed: $base"
        fi
      fi ;;
    encode)
      if [[ -z "${DRY_RUN:-}" ]]; then
        if encode_to "$d/source.wav" "$out"; then ok=$(( ok + 1 )); log "encoded  $base"
        else failed=$(( failed + 1 )); log "!! encode failed: $base"; fi
      fi ;;
    fetch)
      url="$(source_url_of "$d")"; id="$(vid_of "$url")"
      while [[ -z "${DRY_RUN:-}" ]]; do
        reuse=""; [[ -n "$id" ]] && ls "$WORK/ids/$id".* >/dev/null 2>&1 && reuse=1
        if [[ -z "$reuse" && $last_fetch -gt 0 ]]; then
          gap=$(( GAP_MIN + RANDOM % (GAP_MAX - GAP_MIN + 1) ))
          wait_s=$(( last_fetch + gap - $(date +%s) ))
          (( wait_s > 0 )) && sleep "$wait_s"
        fi
        (( fetch_t0 == 0 )) && fetch_t0=$(date +%s)
        fetch_audio "$url" "$id"; rc=$?
        [[ -z "$reuse" ]] && last_fetch=$(date +%s)
        if (( rc == 0 )); then
          blocks=0
          if encode_to "$(ls "$WORK"/got.* | head -1)" "$out"; then
            fetched=$(( fetched + 1 )); ok=$(( ok + 1 ))
            left=$(( n_fetch - fetched ))
            per=$(( ($(date +%s) - fetch_t0) / fetched ))
            log "fetched  $base ($fetched/$n_fetch) — ETA ~$(( left * per / 3600 ))h $(( left * per % 3600 / 60 ))m remaining"
          else
            failed=$(( failed + 1 )); log "!! encode failed after fetch: $base"
          fi
          break
        elif (( rc == 2 )); then
          blocks=$(( blocks + 1 ))
          if (( blocks >= MAX_BLOCKS )); then
            log "!! YouTube blocked $blocks times in a row — stopping. Re-run later (it resumes); COOKIES_FROM=chrome helps."
            log "summary: $ok made ($fetched fetched), $failed failed, $pruned WAVs pruned ($(( pruned_bytes / 1000000 )) MB)"
            exit 3
          fi
          pause=$(( BACKOFF_MIN * (1 << (blocks - 1)) ))
          log "!! YouTube bot check on $base — pausing ${pause} min (block $blocks of $MAX_BLOCKS), then retrying"
          sleep $(( pause * 60 ))
        else
          failed=$(( failed + 1 ))
          log "!! fetch failed: $base ($url): $(grep -m1 -i 'error' "$WORK/err.txt" | cut -c1-160)"
          break
        fi
      done ;;
  esac
  [[ -f "$out" || ( -n "${DRY_RUN:-}" && "${plan[$i]}" != none ) ]] && prune_wavs "$d"
done

log "done${DRY_RUN:+ (dry run — nothing written or deleted)}: $ok made ($fetched fetched from YouTube), $failed failed, $n_none without any source"
log "WAVs ${DRY_RUN:+that would be }pruned: $pruned ($(( pruned_bytes / 1000000 )) MB); other WAVs kept: $kept_other"
