#!/bin/bash
# librarian_boot.sh — LaunchAgent entry point for the Mac mini.
#
# The mini rebooted on 2026-07-10 and every Librarian daemon stayed down
# for five days because librarian.sh start is manual. This script runs at
# login (via com.simplestem.librarian.plist), WAITS for Google Drive to
# mount the data folder (Drive mounts a while after login), then starts
# the Librarian services. Idempotent: librarian.sh start skips services
# already running.
#
# Install (on the Librarian):
#   cp ~/simpleStem-code/com.simplestem.librarian.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.simplestem.librarian.plist
# Logs: /tmp/simplestem-librarian-boot.log

DATA="$HOME/ClaudeDrive/simpleStem"
LOG="/tmp/simplestem-librarian-boot.log"

{
  echo "$(date) librarian_boot: waiting for Drive at $DATA"
  for i in $(seq 1 60); do
    if [ -x "$DATA/librarian.sh" ]; then
      echo "$(date) librarian_boot: Drive up after ${i}0s — starting services"
      cd "$DATA" && ./librarian.sh start
      echo "$(date) librarian_boot: done"
      exit 0
    fi
    sleep 10
  done
  echo "$(date) librarian_boot: Drive never mounted after 10 min — giving up"
  exit 1
} >> "$LOG" 2>&1
