#!/usr/bin/env bash
# entrypoint.sh — dispatch the simpleStem container to the right tool
# based on its first argument. The compose file sets `command: ["batch"]`
# so `docker compose run simplestem` defaults to a full batch run.

set -e

case "${1:-batch}" in
  stem)
    shift
    exec /app/stem.sh "$@"
    ;;
  batch)
    shift || true
    exec /app/mpbbatch.bash "$@"
    ;;
  balance|pp|post-process)
    shift
    exec /app/post_process.py "$@"
    ;;
  shell|bash)
    exec /bin/bash
    ;;
  -h|--help|help)
    cat <<EOF
simpleStem in Docker. Subcommands:

  stem "Title" "Artist" [video-id-or-url]
        Run the per-song pipeline (download -> demucs -> loops).

  batch
        Run mpbbatch.bash — pulls the Google Sheet and processes every
        row serially. (Default if no subcommand is given.)

  balance --dir /data/ClaudeDrive/simpleStem/STEMS/<song>
        Manually invoke post_process.py to gain-match stems to source.

  shell
        Drop into bash inside the container for debugging.

All output is written under /data/ClaudeDrive/simpleStem/STEMS/, which
the compose file binds to your host's ~/ClaudeDrive/simpleStem/STEMS/.
EOF
    ;;
  *)
    # Anything else: execute as-is (lets you do `docker run ... ls /app`)
    exec "$@"
    ;;
esac
