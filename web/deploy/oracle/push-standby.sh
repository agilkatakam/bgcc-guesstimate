#!/usr/bin/env bash
# Copy and build the app on the standby WITHOUT starting it or touching its (read-only replica) database.
#   ./deploy/oracle/push-standby.sh vardhan2
set -euo pipefail
HOST="${1:-vardhan2}"
cd "$(dirname "$0")/../.."
rsync -az --delete --exclude node_modules --exclude '.next*' --exclude backup --exclude '.env*' --exclude '*.tsbuildinfo' ./ "$HOST:/opt/vardhan/"
rsync -az --delete ../game/ "$HOST:/opt/game/"
ssh "$HOST" 'set -e; cd /opt/vardhan && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null && echo "standby built (not started; it starts only on failover)"'
