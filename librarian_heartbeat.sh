#!/usr/bin/env bash
# librarian_heartbeat.sh — one heartbeat pass for the Librarian daemons.
#
# Writes $DATA/.run-status/librarian.json describing every librarian.sh
# service (pid, alive, hostname, timestamp). Because the file lives on
# Drive, BOTH machines' dashboards can show truthful green/red state with
# real PIDs — the old panel checked local pid files and always showed
# "stopped" when viewed from the other machine (Bill 2026-07-04).
#
# Run by the librarian.sh `heartbeat` service every ~20s. Atomic write
# (tmp + mv) so readers never see a half-written file.
set -uo pipefail

BASE="$(cd "$(dirname "$0")" && pwd)"
. "$BASE/lib-common.sh"
DATA="$(data_root)"
RUN="$BASE/.run"
OUT_DIR="$DATA/.run-status"
mkdir -p "$OUT_DIR"

SERVICES="watcher cataloger catalogwatch mpbsync portal autoupdate heartbeat"

TMP="$(mktemp "${TMPDIR:-/tmp}/librarian_hb.XXXXXX")"
{
  printf '{\n'
  printf '  "hostname": "%s",\n' "$(hostname)"
  printf '  "updatedAt": "%s",\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '  "epoch": %s,\n' "$(date '+%s')"
  printf '  "services": {\n'
  first=1
  for name in $SERVICES; do
    pid="$(cat "$RUN/lib-$name.pid" 2>/dev/null || true)"
    alive=false
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then alive=true; fi
    [[ $first -eq 1 ]] || printf ',\n'
    first=0
    printf '    "lib-%s": { "pid": %s, "alive": %s }' "$name" "${pid:-null}" "$alive"
  done
  printf '\n  }\n}\n'
} > "$TMP"
mv -f "$TMP" "$OUT_DIR/librarian.json"
