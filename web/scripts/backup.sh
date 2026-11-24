#!/usr/bin/env bash
# Keeps a fresh copy of the live database on this Mac during the event.
# Dumps the database every INTERVAL seconds (default 30) into ./backup/, keeps the newest 60 dumps.
#
#   SOURCE_URL='<neon connection string>' ./scripts/backup.sh
#   SOURCE_SSH=ubuntu@<oracle vm ip> ./scripts/backup.sh        (database on an Oracle VM: dumps over SSH)
#
# Leave it running in a terminal from 30 min before the event until the end. Each line it prints is one good dump.
# pg_dump must be the same major version as the database or newer (Neon's version is on its dashboard;
# `brew install postgresql@17` and put it first on PATH if Neon runs 17).
set -u
[ -n "${SOURCE_URL:-}${SOURCE_SSH:-}" ] || { echo "set SOURCE_URL (Neon) or SOURCE_SSH (Oracle VM)"; exit 1; }
INTERVAL="${INTERVAL:-30}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/backup"
mkdir -p "$DIR"
echo "backing up every ${INTERVAL}s into $DIR (Ctrl-C to stop)"
while true; do
  ts=$(date +%Y%m%d-%H%M%S)
  tmp="$DIR/.partial-$ts.dump"
  if [ -n "${SOURCE_SSH:-}" ]; then
    ssh -o ConnectTimeout=5 -o BatchMode=yes "$SOURCE_SSH" "pg_dump --format=custom --no-owner --no-privileges vardhan" >"$tmp" 2>"$DIR/.last-error" && [ -s "$tmp" ]
  else
    pg_dump --format=custom --no-owner --no-privileges --dbname="$SOURCE_URL" --file="$tmp" 2>"$DIR/.last-error"
  fi
  if [ $? -eq 0 ]; then
    mv "$tmp" "$DIR/game-$ts.dump"
    ln -sf "game-$ts.dump" "$DIR/latest.dump"
    echo "$(date +%T) ok  game-$ts.dump ($(du -h "$DIR/game-$ts.dump" | cut -f1))"
  else
    rm -f "$tmp"
    echo "$(date +%T) FAILED: $(head -c 200 "$DIR/.last-error")"
  fi
  ls -1t "$DIR"/game-*.dump 2>/dev/null | tail -n +61 | while read -r f; do rm -f "$f"; done
  sleep "$INTERVAL"
done
