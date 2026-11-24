#!/usr/bin/env bash
# From the Mac: copy the app to the VM, install, build, (re)start.   ./deploy/oracle/push.sh ubuntu@<vm ip>
set -euo pipefail
HOST="${1:?usage: push.sh ubuntu@<vm ip>}"
cd "$(dirname "$0")/../.."
rsync -az --delete --exclude node_modules --exclude '.next*' --exclude backup --exclude '.env*' --exclude '*.tsbuildinfo' ./ "$HOST:/opt/vardhan/"
rsync -az --delete ../game/ "$HOST:/opt/game/"
ssh "$HOST" 'set -e; cd /opt/vardhan && npm ci --no-audit --no-fund && npm run build && set -a && . /etc/vardhan.env && set +a && node scripts/manage.ts init && sudo systemctl restart vardhan && sleep 2 && curl -fsS localhost:3000/api/time && echo && echo "app is up"'
echo "Load content on the VM, e.g.:  ssh $HOST 'cd /opt/vardhan && set -a && . /etc/vardhan.env && set +a && node scripts/manage.ts questions questions.csv'"
