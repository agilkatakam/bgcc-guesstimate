#!/usr/bin/env bash
# (Re)make vardhan-2 a live copy of vardhan-1 (streaming replication over an SSH tunnel). Wipes vardhan-2's database.
#   REPL_PASSWORD=<replicator password> ./deploy/oracle/make-standby.sh
set -euo pipefail
: "${REPL_PASSWORD:?set REPL_PASSWORD}"
ssh vardhan2 "set -e
sudo systemctl disable --now vardhan || true
sudo systemctl restart pg-tunnel; sleep 3
sudo systemctl stop postgresql
sudo rm -rf /var/lib/postgresql/16/main
sudo -u postgres bash -c \"PGPASSWORD='$REPL_PASSWORD' pg_basebackup -h 127.0.0.1 -p 15432 -U replicator -D /var/lib/postgresql/16/main -R -X stream\"
sudo systemctl start postgresql; sleep 3
echo \"replica: \$(sudo -u postgres psql -tAc 'select pg_is_in_recovery()') (t = good)\"
sudo -u postgres psql -tAc 'select status from pg_stat_wal_receiver'"
