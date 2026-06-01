#!/usr/bin/env bash
# performer.sh — the MacBook Pro's switch (the Performer role).
#
# The laptop has the RAM (36 GB), so it does the heavy Demucs work and serves
# the portal for rehearsal/live use. It streams Drive and pins only the jobs it's
# actively rendering. See ARCHITECTURE.md.
#
# Long-running services:
#   runner   queue_runner.sh — drains STEM_QUEUE; reuses the Librarian's cached
#                              source.wav and runs Demucs (the slow part)
#   server   bt-construction-kit portal (http://localhost:3000)
#
# Usage:
#   ./performer.sh start|stop|restart|status|logs [runner|server]
#
# Mirrors studio.sh's process model (pidfiles + logs in .run/, tree-kill, and
# clears the runner lock on stop).
set -uo pipefail

BASE="$(cd "$(dirname "$0")" && pwd)"
RUN="$BASE/.run"
QUEUE="$BASE/STEM_QUEUE"
STEMS="$BASE/STEMS"
PORT="${PORT:-3000}"            # portal port (server.js reads $PORT too)
SERVICES="runner server"
mkdir -p "$RUN"

# Version = newest mtime across the code files, formatted YYMMDD.HHMM (local).
# Matches server.js's readDiskVersion() so CLI and portal agree. No manual bump.
version_str() {
  local files=(
    "$BASE/bt-construction-kit/server.js"
    "$BASE/bt-construction-kit/public/app.js"
    "$BASE/bt-construction-kit/public/index.html"
    "$BASE/bt-construction-kit/public/styles.css"
    "$BASE/performer.sh" "$BASE/queue_runner.sh" "$BASE/stem.sh"
  )
  local newest="" f mt
  for f in "${files[@]}"; do
    [[ -f "$f" ]] || continue
    mt="$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)"
    [[ -n "$mt" && ( -z "$newest" || mt -gt newest ) ]] && newest="$mt"
  done
  [[ -n "$newest" ]] && date -r "$newest" +%y%m%d.%H%M 2>/dev/null || echo "unknown"
}

pidfile() { echo "$RUN/perf-$1.pid"; }
logfile() { echo "$RUN/perf-$1.log"; }

# Resolve an absolute path to node. A backgrounded/non-login shell may not have
# the interactive PATH (nvm, Homebrew), so `node` bare can fail to launch. Try
# PATH first, then the usual install locations, then nvm's newest version.
find_node() {
  local n
  n="$(command -v node 2>/dev/null)" && [[ -x "$n" ]] && { echo "$n"; return; }
  for n in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
    [[ -x "$n" ]] && { echo "$n"; return; }
  done
  # nvm: pick the highest installed version
  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    n="$(ls -d "$HOME/.nvm/versions/node"/*/bin/node 2>/dev/null | sort -V | tail -n1)"
    [[ -x "$n" ]] && { echo "$n"; return; }
  fi
  echo ""   # not found
}
NODE_BIN="$(find_node)"

start_cmd() {
  case "$1" in
    runner) echo "exec '$BASE/queue_runner.sh'" ;;
    server) echo "cd '$BASE/bt-construction-kit' && exec '${NODE_BIN:-node}' server.js" ;;
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
  [[ -n "$NODE_BIN" ]] && echo "  node: $NODE_BIN" \
    || echo "  ! node not found in PATH or common locations — install Node for the portal" >&2
  command -v demucs >/dev/null 2>&1 || echo "  ! demucs not found — 'pipx install demucs' (the laptop does the rendering)" >&2
  command -v yt-dlp >/dev/null 2>&1 || echo "  ! yt-dlp not found — needed when a song isn't cached yet" >&2
  command -v ffmpeg >/dev/null 2>&1 || echo "  ! ffmpeg not found — 'brew install ffmpeg'" >&2
  [[ -d "$BASE/bt-construction-kit/node_modules/express" ]] || \
    echo "  ! express not installed — (cd bt-construction-kit && npm install)" >&2
}

start_one() {
  local name="$1"
  if is_running "$name"; then
    echo "  $name already running (pid $(cat "$(pidfile "$name")"))"; return
  fi
  # nohup + setsid-style detach so the service SURVIVES closing the terminal
  # (without nohup, a plain & job gets SIGHUP and dies on terminal close).
  nohup bash -c "$(start_cmd "$name")" >"$(logfile "$name")" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$(pidfile "$name")"
  sleep 0.4
  if kill -0 "$pid" 2>/dev/null; then
    echo "  started $name (pid $pid) → log: .run/perf-$name.log"
  else
    echo "  ! $name exited immediately — see .run/perf-$name.log" >&2
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
  if [[ "$name" == "runner" ]]; then
    rmdir "$QUEUE/.runner.lock" 2>/dev/null || true
    rm -f "$QUEUE/.current"
  fi
}

status_one() {
  if is_running "$1"; then
    printf "  %-8s ● running   pid %s\n" "$1" "$(cat "$(pidfile "$1")")"
  else
    printf "  %-8s ○ stopped\n" "$1"
  fi
}

# Wait until the portal is actually accepting connections on $PORT (up to ~15s).
# Returns 0 once it responds, 1 on timeout. Uses curl, falls back to nc.
wait_for_port() {
  local i
  for i in $(seq 1 30); do
    if command -v curl >/dev/null 2>&1; then
      curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null && return 0
    elif command -v nc >/dev/null 2>&1; then
      nc -z localhost "$PORT" 2>/dev/null && return 0
    fi
    sleep 0.5
  done
  return 1
}

# Open the portal in Chrome (macOS). Falls back to the default browser.
open_portal() {
  local url="http://localhost:$PORT/"
  if open -a "Google Chrome" "$url" 2>/dev/null; then
    echo "  opened $url in Chrome"
  else
    open "$url" 2>/dev/null && echo "  opened $url" \
      || echo "  ! couldn't auto-open a browser — visit $url"
  fi
}

print_queue() {
  local nq=0
  [[ -d "$QUEUE" ]] && nq="$(find "$QUEUE" -mindepth 1 -maxdepth 2 -name '*.json' \
        -not -path "$QUEUE/_done/*" -not -path "$QUEUE/_failed/*" 2>/dev/null | wc -l | tr -d ' ')"
  local pausemsg=""; [[ -f "$QUEUE/.paused" ]] && pausemsg="  ⏸ PAUSED (./performer.sh resume)"
  echo "  queue: $nq awaiting render$pausemsg"
  if [[ -f "$QUEUE/.current" ]]; then
    python3 - "$QUEUE/.current" 2>/dev/null <<'PY' || true
import json, sys
d = json.load(open(sys.argv[1]))
phase = d.get('phase', ''); since = d.get('phase_since', '')
tail = (' — %s%s' % (phase, ' since %s' % since if since else '')) if phase else ''
print('  now rendering: %s%s' % (d.get('song', '?'), tail))
PY
  fi
}

case "${1:-}" in
  start)
    echo "Starting Performer…"; preflight
    # Runner: a live Demucs render is 10-25 min of work — never kill it. Start it
    # only if it isn't already running.
    if is_running runner; then
      echo "  runner already running (pid $(cat "$(pidfile runner)")) — leaving the active render alone"
    else
      start_one runner
    fi
    # Server: stateless, so always restart it fresh for a clean port.
    stop_one server
    start_one server
    echo
    if wait_for_port; then
      echo "Portal up on http://localhost:$PORT"
      open_portal
    else
      echo "  ! server didn't answer on :$PORT within 15s — see .run/perf-server.log" >&2
      tail -n 5 "$(logfile server)" 2>/dev/null | sed 's/^/    /'
    fi
    echo; print_queue ;;
  stop)
    echo "Stopping Performer…"
    for s in $SERVICES; do stop_one "$s"; done ;;
  restart)
    echo "Restarting Performer… (full restart — stops the runner too)"
    for s in $SERVICES; do stop_one "$s"; done
    sleep 1; preflight
    for s in $SERVICES; do start_one "$s"; done
    echo
    if wait_for_port; then echo "Portal up on http://localhost:$PORT"; open_portal; fi
    echo; print_queue ;;
  open)
    open_portal ;;
  status)
    echo "Performer (version $(version_str)):"
    for s in $SERVICES; do status_one "$s"; done
    echo; print_queue ;;
  version)
    echo "$(version_str)" ;;
  pause)
    touch "$QUEUE/.paused"
    echo "rendering paused — runner will idle after the current song finishes."
    echo "(playback/portal unaffected; resume with: ./performer.sh resume)" ;;
  resume)
    rm -f "$QUEUE/.paused"
    echo "rendering resumed — runner will pick up the queue again." ;;
  backfill)
    shift; "$BASE/backfill.sh" "$@" ;;
  logs)
    name="${2:-}"
    if [[ -n "$name" ]]; then tail -n 60 -f "$(logfile "$name")"
    else tail -n 30 -f "$RUN"/perf-*.log; fi ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs [runner|server]|open|version|pause|resume|backfill [--go]}" >&2
    exit 1 ;;
esac
