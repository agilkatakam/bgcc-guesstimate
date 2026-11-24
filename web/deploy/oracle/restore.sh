#!/usr/bin/env bash
# Emergency: load the newest backup onto the STANDBY Oracle VM and start the game there.
#   ./deploy/oracle/restore.sh ubuntu@<standby ip> [backup/latest.dump]
# Then point the DuckDNS name at the standby's IP (duckdns.org → your domain → current ip), or show the
# standby's own name as a QR. Players log in again with the same email and PIN.
set -euo pipefail
HOST="${1:?usage: restore.sh ubuntu@<standby ip> [dump]}"
cd "$(dirname "$0")/../.."
DUMP="${2:-backup/latest.dump}"
[ -e "$DUMP" ] || { echo "no dump at $DUMP"; exit 1; }
scp -q "$DUMP" "$HOST:/tmp/restore.dump"
ssh "$HOST" 'set -e; sudo systemctl stop vardhan; dropdb --if-exists vardhan; createdb vardhan; pg_restore --no-owner --no-privileges -d vardhan /tmp/restore.dump; sudo systemctl start vardhan; sleep 2; curl -fsS localhost:3000/api/state | head -c 120; echo; echo "standby is serving the restored game"'
