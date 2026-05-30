#!/usr/bin/env bash
# studio.sh — one switch for the whole backing-track stack.
#
# Manages three long-running processes:
#   server   bt-construction-kit Express UI (http://localhost:3000)
#   watcher  webloc_watch.sh  — dropped YouTube URLs → metadata jobs
#   runner   queue_runner.sh  — jobs → STEMS/ + M4A/ (the slow demucs work)
#
# PIDs and logs live in .run/. Stopping kills each process *and its children*
# (fswatch, node, demucs) and clears the runner lock.
#
# Usage:
#   ./studio.sh start          # start any that aren't running
#   ./studio.sh stop           # stop all
#   ./studio.sh restart        # stop then start
#   ./studio.sh status         # what's up + queue + current render
#   ./studio.sh logs [name]    # tail logs (all, or server|watcher|runner)
set -uo pipefail

BASE="$(cd "$(dirname "$0")" && pwd)"
RUN="$BASE/.run"
QUEUE="$BASE/STEM_QUEUE"
INCOMING="$BASE/INCOMING_WEBLOC"
SERVICES="server watcher runner"
mkdir -p "$RUN"

pidfile() { echo "$RUN/$1.pid"; }
logfile() { echo "$RUN/$1.log"; }

# Command line for each service (run via bash -c; `exec` so the pidfile points
# at the real process, not a wrapper shell).
start_cmd() {
  case "$1" in
    server)  echo "cd '$BASE/bt-construction-kit' && exec node server.js" ;;
    watcher) echo "exec '$BASE/webloc_watch.sh'" ;;
    runner)  echo "exec '$BASE/queue_runner.sh'" ;;
  esac
}

is_running() {
  local p; p="$(cat "$(pidfile "$1")" 2>/dev/null)" || return 1
  [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null
}

# Recursively kill a process and its descendants (macOS has no setsid; walk the
# tree with pgrep). Children first so nothing gets reparented and survives.
kill_tree() {
  local pid="$1" sig="$2" c
  for c in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$c" "$sig"; done
  kill -"$sig" "$pid" 2>/dev/null || true
}

preflight() {
  command -v node    >/dev/null 2>&1 || echo "  ! node not found — install Node to run the server" >&2
  command -v fswatch >/dev/null 2>&1 || echo "  ! fswatch not found — 'brew install fswatch' for the watcher" >&2
  [[ -d "$BASE/bt-construction-kit/node_modules/express" ]] || \
    echo "  ! express not installed — run: (cd bt-construction-kit && npm install)" >&2
}

start_one() {
  local name="$1"
  if is_running "$name"; then
    echo "  $name already running (pid $(cat "$(pidfile "$name")"))"; return
  fi
  bash -c "$(start_cmd "$name")" >"$(logfile "$name")" 2>&1 &
  local pid=$!
  echo "$pid" > "$(pidfile "$name")"
  # brief sanity check: still alive a moment later?
  sleep 0.4
  if kill -0 "$pid" 2>/dev/null; then
    echo "  started $name (pid $pid) → log: .run/$name.log"
  else
    echo "  ! $name exited immediately — see .run/$name.log" >&2
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

print_queue() {
  local nin=0 nq=0
  [[ -d "$INCOMING" ]] && nin="$(ls "$INCOMING"/*.webloc 2>/dev/null | wc -l | tr -d ' ')"
  [[ -d "$QUEUE" ]] && nq="$(find "$QUEUE" -mindepth 1 -maxdepth 2 -name '*.json' \
        -not -path "$QUEUE/_done/*" -not -path "$QUEUE/_failed/*" 2>/dev/null | wc -l | tr -d ' ')"
  echo "  queue: $nin awaiting metadata · $nq awaiting render"
  if [[ -f "$QUEUE/.current" ]]; then
    python3 - "$QUEUE/.current" 2>/dev/null <<'PY' || true
import json, sys
d = json.load(open(sys.argv[1]))
phase = d.get('phase', '')
since = d.get('phase_since', '')
tail = (' — %s%s' % (phase, ' since %s' % since if since else '')) if phase else ''
print('  now rendering: %s%s' % (d.get('song', '?'), tail))
PY
  fi
}

case "${1:-}" in
  start)
    echo "Starting stack…"; preflight
    for s in $SERVICES; do start_one "$s"; done
    echo; print_queue
    echo; echo "Portal: http://localhost:3000"
    ;;
  stop)
    echo "Stopping stack…"
    for s in $SERVICES; do stop_one "$s"; done
    ;;
  restart)
    echo "Restarting stack…"
    for s in $SERVICES; do stop_one "$s"; done
    sleep 1
    preflight
    for s in $SERVICES; do start_one "$s"; done
    echo; print_queue
    ;;
  status)
    echo "Stack:"
    for s in $SERVICES; do status_one "$s"; done
    echo; print_queue
    ;;
  logs)
    name="${2:-}"
    if [[ -n "$name" ]]; then tail -n 60 -f "$(logfile "$name")"
    else tail -n 30 -f "$RUN"/*.log; fi
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs [server|watcher|runner]}" >&2
    exit 1
    ;;
esac
