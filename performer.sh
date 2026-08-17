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

BASE="$(cd "$(dirname "$0")" && pwd)"      # where the code lives (this clone)
# Guard (2026-08-16): running this script from the Drive-synced copy
# spawns a SECOND performer stack that fights the real one for :3000 and
# :5555 (found as a sidecar bind-crash loop in the Drive-side .run logs,
# with the traceback pointing into CloudStorage). The canonical clone is
# ~/simpleStem-code; the Drive copy is data-only.
case "$BASE" in
  *CloudStorage*|*ClaudeDrive*)
    echo "REFUSING to run from the Drive-synced copy ($BASE)." >&2
    echo "Run the git clone instead:  cd ~/simpleStem-code && ./performer.sh ${1:-start}" >&2
    exit 1 ;;
esac
. "$BASE/lib-common.sh"
DATA="$(data_root)"                         # where the audio/data lives (Drive)
export SIMPLE_STEM_ROOT="$DATA"             # so queue_runner + server inherit it
RUN="$BASE/.run"                            # runtime state stays with the code
QUEUE="$DATA/STEM_QUEUE"
STEMS="$DATA/STEMS"
PORT="${PORT:-3000}"            # portal port (server.js reads $PORT too)
SERVICES="runner midi server caffeinate midiwatch"
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

# Pick a Python that has `mido` installed. The MIDI sidecar imports mido +
# python-rtmidi, and Homebrew's Python rejects system-wide installs (PEP 668).
# Prefer the demucs pipx venv (where librosa etc. live) — that's where the
# user would inject mido via `pipx inject demucs mido python-rtmidi`. Fall
# back to other reasonable candidates.
find_python_with_mido() {
  local candidates=(
    "$HOME/.local/pipx/venvs/demucs/bin/python3"
    "$HOME/.local/pipx/venvs/demucs/bin/python"
    "/opt/homebrew/bin/python3"
    "/usr/local/bin/python3"
    "python3"
  )
  local p
  for p in "${candidates[@]}"; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import mido' 2>/dev/null; then
      command -v "$p"
      return
    fi
  done
  echo ""
}
PYTHON_MIDI="$(find_python_with_mido)"

start_cmd() {
  case "$1" in
    runner) echo "exec '$BASE/queue_runner.sh'" ;;
    midi)   echo "exec env MIDI_HELIX_PORT='U2MIDI Pro' '${PYTHON_MIDI:-python3}' '$BASE/midi_sidecar.py'" ;;
    midiwatch)
            # Sidecar watchdog (Bill 2026-07-29, third sidecar death):
            # probes :5555/health every 20s; two consecutive failures
            # trigger `performer.sh restart-midi`. Heals CoreMIDI resets
            # (e.g. Logic's "Reset All MIDI Drivers"), crashes, and
            # post-sleep wedges within ~50s, hands-free.
            echo "exec '$BASE/midi_watchdog.sh'" ;;
    server) echo "cd '$BASE/bt-construction-kit' && exec '${NODE_BIN:-node}' server.js" ;;
    caffeinate)
            # Gig insurance (Bill 2026-07-04): while the Performer rig runs,
            # the Mac must not idle-sleep, display-sleep, or system-sleep.
            # AUTOMATIC by design -- a forgotten button press is exactly the
            # failure that kills a gig (sleep/wake is the top coreaudiod-
            # wedge trigger; see docs/10_AUDIO_WEDGE_DEEP_DIVE.md). The
            # hot-corner screensaver still works: caffeinate blocks SLEEP,
            # not a manually invoked screen saver.
            echo "exec caffeinate -dis" ;;
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
  if [[ -n "$PYTHON_MIDI" ]]; then
    echo "  midi python: $PYTHON_MIDI"
  else
    echo "  ! no Python with 'mido' found — run:  pipx inject demucs mido python-rtmidi" >&2
  fi
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
  # Belt-and-suspenders for the server: kill anything bound to $PORT before
  # starting a fresh node. .run/perf-server.pid only tracks what we started;
  # a stale process from a previous boot (or a manual `node server.js`) can
  # still own the port silently — our new server then fails to bind, and the
  # "restart" becomes a no-op while the old code keeps serving. Hit by Bill
  # 2026-06-26 when a Sunday-old node was squatting :3000 for 5 days. Only
  # runs for the server service — the others (runner, midi) don't bind a port.
  if [[ "$name" == "server" ]]; then
    local squatters
    squatters=$(lsof -nP -iTCP:"${PORT:-3000}" -sTCP:LISTEN -t 2>/dev/null || true)
    if [[ -n "$squatters" ]]; then
      echo "  killing port-${PORT:-3000} squatter(s): $squatters"
      kill -9 $squatters 2>/dev/null || true
      sleep 1
    fi
  fi
  # nohup + setsid-style detach so the service SURVIVES closing the terminal
  # (without nohup, a plain & job gets SIGHUP and dies on terminal close).
  # APPEND with a boot marker (2026-08-16): the old > truncation erased the
  # previous run's log on every restart, which destroyed the gig-window
  # evidence during the postmortem. Cap growth by trimming to the last
  # 2000 lines before each start.
  local lf; lf="$(logfile "$name")"
  if [[ -f "$lf" ]]; then
    tail -n 2000 "$lf" > "$lf.tmp" 2>/dev/null && mv "$lf.tmp" "$lf"
  fi
  echo "===== $(date) performer.sh start_one $name =====" >> "$lf"
  nohup bash -c "$(start_cmd "$name")" >>"$lf" 2>&1 &
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

# Gig readiness test (Bill 2026-08-10): "I do not want these bugs to
# occur at a practice anymore." Checks the prerequisites for a clean run
# (services up, portal answering, sidecar alive, XR18 healthy, disk and
# power sane) and then a regression pass over the invariants that have
# each broken a practice or gig before: event-loop latency, the offline
# cache contract, faststart m4a, stem serving speed, and pending cache
# evictions. Prints PASS/WARN/FAIL lines and a verdict; exit 1 unless
# gig ready.
gig_test_checks() {
  local s
  for s in server midi caffeinate midiwatch; do
    if is_running "$s"; then echo "PASS service $s running (pid $(cat "$(pidfile "$s")"))"
    else echo "FAIL service $s not running: ./performer.sh start"; fi
  done
  if is_running runner; then echo "PASS service runner running"
  else echo "WARN service runner stopped (fine at a gig, nothing new renders)"; fi
  PORT="$PORT" python3 - <<'PY'
import json, os, random, subprocess, sys, time, urllib.parse, urllib.request

BASE = 'http://localhost:%s' % os.environ.get('PORT', '3000')
def pj(u, t=5):
    with urllib.request.urlopen(BASE + u, timeout=t) as r:
        return json.load(r)
def report(kind, msg):
    print('%s %s' % (kind, msg))

try:
    times = []
    for _ in range(20):
        t0 = time.time(); pj('/api/health', 3); times.append((time.time() - t0) * 1000)
    mx = max(times)
    report('PASS' if mx < 100 else 'FAIL',
           'event loop: /api/health max %.0f ms over 20 calls (budget 100 ms)' % mx)
except Exception as e:
    report('FAIL', 'portal unreachable: %s' % e)
    sys.exit(0)

try:
    lib = pj('/api/library', 30)
    songs = lib.get('songs') or []
    stats = lib.get('stats') or {}
    report('PASS' if songs else 'FAIL', 'library: %d songs' % len(songs))
    unc = stats.get('uncachedSongs')
    report('PASS' if unc == 0 else 'FAIL', 'server cache accounting: %s uncached songs' % unc)
    cache = os.path.expanduser('~/.bt-cache/STEMS')
    names = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
    bases = [s.get('folderName') or s.get('base') or s.get('slug') for s in songs]
    bases = [b for b in bases if b]
    sample = random.sample(bases, min(12, len(bases)))
    miss = []
    for b in sample:
        for n in names:
            p = os.path.join(cache, b, n + '.m4a')
            if not (os.path.isfile(p) and os.path.getsize(p) > 0):
                miss.append('%s/%s' % (b, n))
    if miss:
        report('FAIL', 'offline contract: stems missing from ~/.bt-cache: ' + ', '.join(miss[:6]))
    else:
        report('PASS', 'offline contract: all 6 stems on local disk for %d sampled songs' % len(sample))
    bad = []
    for b in random.sample(sample, min(3, len(sample))):
        p = os.path.join(cache, b, 'vocals.m4a')
        try:
            with open(p, 'rb') as f:
                head = f.read(65536)
            mo, md = head.find(b'moov'), head.find(b'mdat')
            if mo == -1 or (md != -1 and md < mo):
                bad.append(b)
        except Exception:
            bad.append(b)
    if bad:
        report('FAIL', 'faststart: moov not at front: ' + ', '.join(bad))
    else:
        report('PASS', 'faststart: moov at front of sampled stems')
    b = sample[0]
    t0 = time.time()
    with urllib.request.urlopen(BASE + '/api/audio/stems/%s/vocals.m4a' % urllib.parse.quote(b), timeout=10) as r:
        data = r.read(262144)
    ms = (time.time() - t0) * 1000
    report('PASS' if ms < 3000 and data else 'FAIL', 'stem serving: first 256 KB in %.0f ms' % ms)
except Exception as e:
    report('FAIL', 'library/cache regression pass blew up: %s' % e)

try:
    x = pj('/api/audio/xr18-status', 10)
    if x.get('present') and (x.get('channels') or 0) > 0:
        report('PASS', 'XR18: present, %s audio channels' % x.get('channels'))
        if not x.get('isDefaultOutput'):
            report('WARN', 'XR18 is not the default output (click the XR18 button before the downbeat)')
    elif x.get('present'):
        report('FAIL', 'XR18: on USB but 0 audio channels. Its audio engine crashed: POWER-CYCLE the XR18 (Mac reboot does not help)')
    else:
        report('FAIL', 'XR18: not on the USB bus: check cable and mixer power')
except Exception as e:
    report('WARN', 'XR18 status unavailable: %s' % e)

try:
    with urllib.request.urlopen('http://localhost:5555/health', timeout=4) as r:
        m = json.load(r)
    ports = m.get('ports') or []
    report('PASS' if m.get('ok') else 'FAIL', 'MIDI sidecar: ports: %s' % (', '.join(ports) or 'none'))
    if not any('XR18' in p for p in ports):
        report('WARN', 'XR18 MIDI port missing from the sidecar')
    if not any('U2MIDI' in p for p in ports):
        report('WARN', 'U2MIDI Pro missing: the Helix loop is dead until that cable is re-seated')
except Exception as e:
    report('FAIL', 'MIDI sidecar unreachable on :5555 (%s)' % e)

try:
    p = pj('/api/cache/prune-pending', 5)
    if p.get('pending'):
        report('WARN', 'cache: an eviction plan is ARMED, the 30s dialog will pop. Resolve it before the gig')
    else:
        report('PASS', 'cache: no eviction pending')
except Exception:
    pass

try:
    df = subprocess.run(['df', '-k', '/System/Volumes/Data'], capture_output=True, text=True).stdout.splitlines()
    free_gb = int(df[1].split()[3]) / 1048576.0
    kind = 'PASS' if free_gb >= 20 else ('WARN' if free_gb >= 10 else 'FAIL')
    report(kind, 'disk: %.1f GB truly free (df, not Finder purgeable)' % free_gb)
except Exception as e:
    report('WARN', 'disk check failed: %s' % e)

try:
    batt = subprocess.run(['pmset', '-g', 'batt'], capture_output=True, text=True).stdout
    if 'AC Power' in batt:
        report('PASS', 'power: on AC')
    else:
        report('FAIL', 'power: ON BATTERY. Two gigs have now failed unplugged (2026-08-08 stutter, 2026-08-16 full gig on battery, 100%% to 32%%). Plug in before the downbeat')
except Exception:
    pass
PY
}

# Shared gig-test runner (Bill 2026-08-16: "make performer start and
# restart do a performer test first"). The checks need the portal up, so
# start/restart run it as their FINAL step and print the verdict; the
# standalone `test` subcommand additionally exits 1 on any FAIL.
run_gig_test() {
  local strict="${1:-}"
  echo
  echo "Performer gig test (version $(version_str)), $(date)"
  local tmp; tmp="$(mktemp)"
  gig_test_checks | tee "$tmp" | sed 's/^/  /'
  local np nw nf
  np="$(grep -c '^PASS' "$tmp" 2>/dev/null || true)"
  nw="$(grep -c '^WARN' "$tmp" 2>/dev/null || true)"
  nf="$(grep -c '^FAIL' "$tmp" 2>/dev/null || true)"
  rm -f "$tmp"
  echo
  echo "$(date)  performer.sh test  summary: ${np:-0} pass, ${nw:-0} warn, ${nf:-0} fail"
  if [[ "${nf:-0}" -gt 0 ]]; then
    echo "VERDICT: NOT GIG READY. Fix the FAIL lines above and re-run ./performer.sh test"
    [[ "$strict" == "strict" ]] && exit 1
    return 1
  elif [[ "${nw:-0}" -gt 0 ]]; then
    echo "VERDICT: GIG READY, with warnings worth a look."
  else
    echo "VERDICT: GIG READY."
  fi
  return 0
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
    # MIDI sidecar: small Python daemon on :5555 that fires MIDI messages to
    # the Helix / XR18 / Logic during song-timeline automation. Safe to restart
    # — opens devices lazily on first send.
    stop_one midi
    start_one midi
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
    echo; print_queue
    sleep 1
    run_gig_test || true ;;
  stop)
    echo "Stopping Performer…"
    for s in $SERVICES; do stop_one "$s"; done ;;
  restart-midi)
    stop_one midi
    start_one midi ;;
  restart)
    echo "Restarting Performer… (full restart — stops the runner too)"
    for s in $SERVICES; do stop_one "$s"; done
    sleep 1; preflight
    for s in $SERVICES; do start_one "$s"; done
    echo
    if wait_for_port; then echo "Portal up on http://localhost:$PORT"; open_portal; fi
    echo; print_queue
    sleep 1
    run_gig_test || true ;;
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
  test)
    run_gig_test strict ;;
  *)
    echo "usage: $0 {start|stop|restart|status|test|logs [runner|server]|open|version|pause|resume|backfill [--go]}" >&2
    exit 1 ;;
esac
