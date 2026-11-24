#!/usr/bin/env bash
# EMERGENCY: vardhan-1 (primary) is dead. Turn vardhan-2 (live copy, streaming replica) into the server.
#   ./deploy/oracle/failover.sh
# Then in the Azure portal move the public IP (keeps the same link for players):
#   1. <primary-public-ip> → Dissociate → Yes.
#   2. Virtual machines → Vardhan-2 → Networking → network interface (<standby-nic>) → IP configurations → ipconfig1
#      → Public IP address: Associate → choose <primary-public-ip> → Save.
#   Phones reconnect by themselves within a few seconds; nobody has to log in again.
# Until the IP moves, the standby is reachable at https://<standby-ip>.sslip.io
set -euo pipefail
ssh -o ConnectTimeout=10 vardhan2 'set -e
sudo systemctl stop pg-tunnel || true
if [ "$(sudo -u postgres psql -tAc "select pg_is_in_recovery()")" = "t" ]; then sudo -u postgres psql -qc "select pg_promote(true, 30)"; fi
sleep 2; echo "still a replica? $(sudo -u postgres psql -tAc "select pg_is_in_recovery()")  (f = good, writable now)"
sudo systemctl enable --now vardhan; sudo systemctl restart vardhan; sleep 3
curl -fsS localhost:3000/api/state | head -c 100; echo
crontab -l 2>/dev/null | grep -q backup.sh || echo "(set up backups: see README)"
echo "vardhan-2 is serving. Now move the public IP in the Azure portal (steps at the top of this script)."'
