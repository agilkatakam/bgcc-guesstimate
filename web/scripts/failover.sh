#!/usr/bin/env bash
# Emergency: run the game from this Mac when the live site (Vercel) or its database (Neon) is down.
# Restores the newest dump from ./backup/ into a local database and serves the same build on port 3000.
#
#   ./scripts/failover.sh            restore latest dump, build if needed, start the server
#   then, in another terminal:       tailscale funnel --bg --https=8443 3000      (prints the public https URL for players)
#   If logins fail with "bad origin" behind the funnel, rerun with ALLOWED_ORIGINS=https://<funnel host>.
#   Players must log in again on the new URL (same email and PIN: they are in the restored database).
#
# Answers saved after the newest dump are lost (at most INTERVAL seconds' worth with backup.sh running).
set -eu
cd "$(dirname "$0")/.."
DB="${BACKUP_DB:-vardhan_backup}"
DUMP="${1:-backup/latest.dump}"
[ -e "$DUMP" ] || { echo "no dump at $DUMP: is backup.sh running?"; exit 1; }
echo "restoring $(readlink "$DUMP" 2>/dev/null || echo "$DUMP") into $DB"
dropdb --if-exists "$DB"
createdb "$DB"
pg_restore --no-owner --no-privileges --dbname="$DB" "$DUMP"
export DATABASE_URL="postgres://localhost/$DB" DATABASE_DRIVER=pg
# the public funnel address must be an allowed origin, or logins fail with "bad origin"
TS_HOST=$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://$TS_HOST:8443}"
echo "players' address will be: https://$TS_HOST:8443/play"
[ -d .next ] && [ -f .next/BUILD_ID ] || npm run build
echo "starting on http://localhost:3000; now run: tailscale funnel --bg --https=8443 3000"
exec npx next start -p 3000
