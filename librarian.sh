#!/usr/bin/env bash
# librarian.sh — the Mac mini's switch (the Librarian role).
#
# The mini is always-on, mirrors the full library to its external disk, and does
# the light, I/O-bound work. It does NOT run Demucs (that's the laptop —
# performer.sh). See ARCHITECTURE.md.
#
# Long-running services:
#   watcher    webloc_watch.sh — dropped URLs → cached source.wav + metadata
#                                 + a tiny job in STEM_QUEUE/
#   cataloger  rebuilds CATALOG.json once a day, filling metadata gaps and
#              flagging drift (runs catalog.py on a 24h loop)
#
# One-shot:
#   ./librarian.sh catalog     run the consistency pass once, now
#
# Usage:
#   ./librarian.sh start|stop|restart|status|logs [watcher|cataloger]
#   ./librarian.sh catalog
#
# Mirrors studio.sh's process model (pidfiles + logs in .run/, tree-kill).
set -uo pipefail

BASE="$(cd "$(dirname "$0")" && pwd)"      # where the code lives (this clone)
. "$BASE/lib-common.sh"
DATA="$(data_root)"                         # where the audio/data lives (Drive)
export SIMPLE_STEM_ROOT="$DATA"             # so child scripts inherit the same root
RUN="$BASE/.run"                            # runtime state stays with the code
QUEUE="$DATA/STEM_QUEUE"
INCOMING="$DATA/INCOMING_WEBLOC"
STEMS="$DATA/STEMS"
CATALOG_INTERVAL="${CATALOG_INTERVAL:-3600}"   # seconds between catalog passes (hourly)
MPB_SYNC_INTERVAL="${MPB_SYNC_INTERVAL:-86400}" # seconds between MPB Sheet syncs (daily)
SERVICES="watcher cataloger catalogwatch mpbsync portal"
mkdir -p "$RUN"

pidfile() { echo "$RUN/lib-$1.pid"; }
logfile() { echo "$RUN/lib-$1.log"; }

# A python with librosa + soundfile (catalog.py's gap-fill needs it). Prefer a
# demucs venv if one happens to be here; otherwise any python3 that imports them.
find_py() {
  local b p
  b="$(command -v demucs || true)"
  if [[ -n "$b" ]]; then
    while [[ -L "$b" ]]; do
      local t; t="$(readlink "$b")"
      case "$t" in /*) b="$t" ;; *) b="$(cd -- "$(dirname -- "$b")" && pwd)/$t" ;; esac
    done
    p="$(dirname "$b")/python3"; [[ -x "$p" ]] || p="$(dirname "$b")/python"
    [[ -x "$p" ]] && "$p" -c 'import librosa,soundfile' 2>/dev/null && { echo "$p"; return; }
  fi
  p="$(command -v python3 || true)"
  [[ -n "$p" ]] && "$p" -c 'import librosa,soundfile' 2>/dev/null && { echo "$p"; return; }
  echo ""   # none found
}

start_cmd() {
  case "$1" in
    watcher)   echo "exec '$BASE/webloc_watch.sh'" ;;
    cataloger) local py; py="$(find_py)"; [[ -n "$py" ]] || py="python3"
               # Hourly pass: sync registered playlists → SetLists FIRST (this may
               # drop weblocs the watcher then ingests), then rebuild the catalog.
               # The Performer's portal reads CATALOG.json instead of walking
               # the directories, so this rebuild is the one that keeps the
               # library view fresh on every Performer.
               echo "while true; do '$py' '$BASE/setlist_sync.py'; '$py' '$BASE/catalog.py'; sleep $CATALOG_INTERVAL; done" ;;
    catalogwatch)
               # Push-driven trigger: fswatch STEMS/ + M4A/ for file
               # additions/deletions and rebuild the catalog immediately so
               # the Performer sees newly-stemmed songs without waiting for
               # the hourly cron. Coalesced 5s so a single ingest doesn't
               # fire 20 rebuilds.
               local py; py="$(find_py)"; [[ -n "$py" ]] || py="python3"
               echo "exec fswatch -r --latency 5 --event Created --event Renamed --event Removed '$STEMS' '$DATA/M4A' | xargs -n1 -I{} '$py' '$BASE/catalog.py'" ;;
    mpbsync)   # Pull the Mitchell Park Band Songlist Google Sheet once a day,
               # write singer/drum_pattern/band_required/readiness fields onto
               # each matched STEMS/<slug>/metadata.json, and (re)write
               # GIGS/<slug>.json from the gig tabs. Idempotent; safe to re-run.
               local py; py="$(find_py)"; [[ -n "$py" ]] || py="python3"
               echo "while true; do '$py' '$BASE/mpb_sync.py' || true; sleep $MPB_SYNC_INTERVAL; done" ;;
    portal)    # bt-construction-kit Express server. Same server.js the
               # Performer uses; the hostname-based identity detection
               # (server.js) will see "librarian" in the host and serve
               # librarian.html as the default page. Audio-serving routes
               # work too — both machines read the same Drive folder —
               # but the Librarian is curatorial, not the live App.
               echo "exec node '$BASE/bt-construction-kit/server.js'" ;;
  esac
}

is_running() {
  local p; p="$(cat "$(pidfile "$1")" 2>/dev/null)" || return 1
  [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null
}

kill_tree() {
  local pid="$1" sig="$2" c
  for c in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$c" "$sig"; done
  kill -"$sig" "$pid" 2>/dev/null || true
}

preflight() {
  command -v fswatch >/dev/null 2>&1 || echo "  ! fswatch not found — 'brew install fswatch'" >&2
  command -v yt-dlp  >/dev/null 2>&1 || echo "  ! yt-dlp not found — 'brew install yt-dlp'" >&2
  command -v ffmpeg  >/dev/null 2>&1 || echo "  ! ffmpeg not found — 'brew install ffmpeg'" >&2
  command -v node    >/dev/null 2>&1 || echo "  ! node not found — needed for the librarian portal · 'brew install node'" >&2
  if [[ -f "$BASE/bt-construction-kit/server.js" && ! -d "$BASE/bt-construction-kit/node_modules" ]]; then
    echo "  ! bt-construction-kit/node_modules missing — run: (cd $BASE/bt-construction-kit && npm install)" >&2
  fi
  [[ -n "$(find_py)" ]] || echo "  ! no python with librosa+soundfile — 'pip3 install librosa soundfile'" >&2
}

start_one() {
  local name="$1"
  if is_running "$name"; then
    echo "  $name already running (pid $(cat "$(pidfile "$name")"))"; return
  fi
  # Port-3000 squatter sweep for the portal service. If a previous node
  # process is still bound (stale, orphaned, or started outside our
  # pidfile), node will fail to bind silently. Same defensive sweep
  # performer.sh uses. Mirrors the 2026-06-26 "stale node" bug.
  if [[ "$name" == "portal" ]]; then
    local squatters
    squatters=$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null || true)
    if [[ -n "$squatters" ]]; then
      echo "  killing port-3000 squatter(s): $squatters"
      kill -9 $squatters 2>/dev/null || true
      sleep 1
    fi
  fi
  bash -c "$(start_cmd "$name")" >"$(logfile "$name")" 2>&1 &
  local pid=$!
  echo "$pid" > "$(pidfile "$name")"
  sleep 0.4
  if kill -0 "$pid" 2>/dev/null; then
    echo "  started $name (pid $pid) → log: .run/lib-$name.log"
  else
    echo "  ! $name exited immediately — see .run/lib-$name.log" >&2
    rm -f "$(pidfile "$name")"
  fi
}

stop_one() {
  local name="$1" p; p="$(cat "$(pidfile "$1")" 2>/dev/null)"
  if [[ -z "$p" ]] || ! kill -0 "$p" 2>/dev/null; then
    echo "  $name not running"; rm -f "$(pidfile "$name")"
  else
    kill_tree "$p" TERM
    local i
    for i in $(seq 1 12); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$p" 2>/dev/null && kill_tree "$p" KILL
    rm -f "$(pidfile "$name")"
    echo "  stopped $name (pid $p)"
  fi
}

status_one() {
  if is_running "$1"; then
    printf "  %-10s ● running   pid %s\n" "$1" "$(cat "$(pidfile "$1")")"
  else
    printf "  %-10s ○ stopped\n" "$1"
  fi
}

print_state() {
  local nin=0 nq=0 nstems=0 ncat="—"
  [[ -d "$INCOMING" ]] && nin="$(ls "$INCOMING"/*.webloc 2>/dev/null | wc -l | tr -d ' ')"
  [[ -d "$QUEUE" ]] && nq="$(find "$QUEUE" -mindepth 1 -maxdepth 2 -name '*.json' \
        -not -path "$QUEUE/_done/*" -not -path "$QUEUE/_failed/*" 2>/dev/null | wc -l | tr -d ' ')"
  [[ -d "$STEMS" ]] && nstems="$(find "$STEMS" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  [[ -f "$BASE/CATALOG.json" ]] && ncat="$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
n=d.get("count")
if n is None:
    try: n=len(d["data"]["songs"])
    except Exception: n="?"
print(n)' "$BASE/CATALOG.json" 2>/dev/null || echo '?')"
  echo "  incoming: $nin webloc · queue: $nq awaiting render · cached songs: $nstems · catalog: $ncat"
}

run_catalog_once() {
  local py; py="$(find_py)"; [[ -n "$py" ]] || { echo "no python with librosa+soundfile" >&2; exit 1; }
  "$py" "$BASE/catalog.py" "$@"
}

case "${1:-}" in
  start)
    echo "Starting Librarian…"; preflight
    for s in $SERVICES; do start_one "$s"; done
    echo; print_state ;;
  stop)
    echo "Stopping Librarian…"
    for s in $SERVICES; do stop_one "$s"; done ;;
  restart)
    echo "Restarting Librarian…"
    for s in $SERVICES; do stop_one "$s"; done
    sleep 1; preflight
    for s in $SERVICES; do start_one "$s"; done
    echo; print_state ;;
  status)
    echo "Librarian:"
    for s in $SERVICES; do status_one "$s"; done
    echo; print_state ;;
  catalog)
    shift; run_catalog_once "$@" ;;
  setlists)
    # Manage/sync the YouTube-playlist-backed SetLists. Passes args straight
    # through to setlist_sync.py, e.g.:
    #   ./librarian.sh setlists --add "https://youtube.com/playlist?list=..." --name "Friday Set"
    #   ./librarian.sh setlists --list
    #   ./librarian.sh setlists                 # sync all now
    #   ./librarian.sh setlists --new-manual "My Hand-Picked Set"
    shift
    py="$(find_py)"; [[ -n "$py" ]] || py="python3"
    "$py" "$BASE/setlist_sync.py" "$@" ;;
  sheet)
    # Sync the Mitchell Park Band Songlist Google Sheet → simpleStem.
    # Reads mpb_sync_config.json, fetches each tab as CSV via the gviz endpoint,
    # writes singer/drum_pattern/band_required/readiness fields into matched
    # STEMS/<slug>/metadata.json files, and writes GIGS/<slug>.json for each
    # gig tab. Unmatched rows go to LOGS/mpb_sync_report.json; no new renders
    # are kicked off. Examples:
    #   ./librarian.sh sheet                # full sync (master + gigs)
    #   ./librarian.sh sheet --dry-run      # preview without writing
    #   ./librarian.sh sheet --master-only  # skip the gig tabs
    shift
    py="$(find_py)"; [[ -n "$py" ]] || py="python3"
    "$py" "$BASE/mpb_sync.py" "$@" ;;
  logs)
    name="${2:-}"
    if [[ -n "$name" ]]; then tail -n 60 -f "$(logfile "$name")"
    else tail -n 30 -f "$RUN"/lib-*.log; fi ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs [watcher|cataloger|mpbsync]|catalog|setlists [...]|sheet [...]}" >&2
    exit 1 ;;
esac
