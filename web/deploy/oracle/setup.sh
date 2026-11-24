#!/usr/bin/env bash
# One-time setup of a fresh Oracle Cloud Ubuntu VM (22.04 or 24.04, Ampere A1 / arm64 or x86).
# Run ON THE VM as the default `ubuntu` user:   DOMAIN=<name>.duckdns.org bash setup.sh
# Installs Node 22, PostgreSQL, Caddy (automatic HTTPS), opens ports 80/443, creates the database
# and a systemd service that restarts the app if it ever crashes and starts it on boot.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
: "${DOMAIN:?set DOMAIN, e.g. DOMAIN=vardhancase.duckdns.org}"
APP=/opt/vardhan
DB=vardhan

echo "== packages"
sudo -E apt-get update -y
sudo -E apt-get install -y ca-certificates curl gnupg rsync postgresql postgresql-contrib debian-keyring debian-archive-keyring apt-transport-https netfilter-persistent iptables-persistent
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo -E apt-get install -y nodejs
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo -E apt-get update -y && sudo -E apt-get install -y caddy

echo "== firewall: allow web traffic (Oracle images block it; Azure ones already allow it)"
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -m state --state NEW -p tcp --dport $p -j ACCEPT
done
sudo netfilter-persistent save

echo "== database"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='ubuntu'" | grep -q 1 || sudo -u postgres createuser --superuser ubuntu
psql -lqt -d postgres | cut -d'|' -f1 | grep -qw $DB || createdb $DB
# more connections and memory for ~500 phones
sudo -u postgres psql -c "ALTER SYSTEM SET max_connections = 200;" -c "ALTER SYSTEM SET shared_buffers = '1GB';" >/dev/null
sudo systemctl restart postgresql

echo "== app folder and settings"
sudo mkdir -p $APP /opt/game && sudo chown ubuntu:ubuntu $APP /opt/game
sudo tee /etc/vardhan.env >/dev/null <<ENV
DATABASE_URL=postgres:///$DB?host=/var/run/postgresql
DATABASE_DRIVER=pg
NODE_ENV=production
PORT=3000
ALLOWED_ORIGINS=$(echo "$DOMAIN" | tr -d " " | sed "s#\([^,]*\)#https://\1#g")
ENV

sudo tee /etc/systemd/system/vardhan.service >/dev/null <<UNIT
[Unit]
Description=Vardhan Case event site
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=ubuntu
WorkingDirectory=$APP
EnvironmentFile=/etc/vardhan.env
ExecStart=/usr/bin/node $APP/node_modules/next/dist/bin/next start -p 3000 -H 127.0.0.1
Restart=always
RestartSec=1
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable vardhan

# DOMAIN may list several names, comma-separated (e.g. the DuckDNS name and <ip>.sslip.io).
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$(echo "$DOMAIN" | sed "s/,/, /g") {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
CADDY
sudo systemctl restart caddy

echo
echo "Done. Next, from the Mac: ./deploy/oracle/push.sh ubuntu@<vm ip>   (copies the app, builds, starts it)"
