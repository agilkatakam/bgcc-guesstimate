#!/usr/bin/env bash
# Network probe: run on the Mac while it is connected to the network you want to test (campus wifi, a hotspot).
#
#   ./scripts/netprobe.sh                       basic checks only
#   ./scripts/netprobe.sh https://<your-site>   also latency + a gentle burst test against YOUR deployed site
#
# It answers:
#   1. Is there a captive portal (wifi login page) right now?
#   2. Can this network reach Vercel, Neon and Tailscale, and how slow is it? Any stalls over 3 s?
#   3. Does this network or the host throttle many requests from one address? (300 requests in ~30 s to your site)
#   4. Can phones on this wifi reach this Mac directly? (needed to host the game on the Mac over local wifi)
set -u
SITE="${1:-}"
line() { printf '\n== %s ==\n' "$1"; }

line "This connection"
IF=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
IP=$(ipconfig getifaddr "$IF" 2>/dev/null)
echo "interface $IF, address ${IP:-none}, gateway $(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')"
curl -s -m 6 https://ipinfo.io/json | python3 -c "import sys,json;d=json.load(sys.stdin);print('public:', d.get('ip'), '|', d.get('org'), '|', d.get('city'))" 2>/dev/null || echo "public: unknown"

line "Captive portal"
code=$(curl -s -m 6 -o /tmp/np_cap.html -w "%{http_code}" http://captive.apple.com/hotspot-detect.html)
if [ "$code" = "200" ] && grep -q Success /tmp/np_cap.html; then echo "none (internet is open)"; else echo "PORTAL OR BLOCK: http $code; log in to the wifi page, then rerun"; fi

line "Reachability (5 tries each; >3 s counts as a stall)"
probe() {
  local url=$1 stalls=0 fails=0 times=""
  for i in 1 2 3 4 5; do
    t=$(curl -s -o /dev/null -m 10 -w "%{time_total}" "$url") || { fails=$((fails+1)); continue; }
    times="$times $t"
    awk "BEGIN{exit !($t>3)}" && stalls=$((stalls+1))
  done
  printf '%-45s times:%s  stalls:%d  failures:%d\n' "$url" "$times" "$stalls" "$fails"
}
probe https://vercel.com/
probe https://nextjs.org/favicon.ico
probe https://console.neon.tech/
probe https://login.tailscale.com/
[ -n "$SITE" ] && probe "$SITE/api/time"

if [ -n "$SITE" ]; then
  line "Burst: 300 requests to $SITE/api/time over ~30 s from this one address"
  ok=0; other=0; codes=""
  for i in $(seq 1 300); do
    c=$(curl -s -o /tmp/np_b.json -m 6 -w "%{http_code}" "$SITE/api/time")
    if [ "$c" = "200" ] && grep -q serverNow /tmp/np_b.json; then ok=$((ok+1)); else other=$((other+1)); codes="$codes $c"; fi
    sleep 0.1
  done
  echo "good JSON: $ok, other: $other ${codes:+(codes:$codes)}"
  [ "$other" -gt 0 ] && echo "Non-JSON or 403/429 answers mean something is blocking or challenging repeated requests."
fi

line "Can phones on this wifi reach this Mac? (needed only to host the game on the Mac)"
PORT=8787
echo "On a phone connected to THIS SAME wifi (mobile data off), open:  http://${IP}:${PORT}"
echo "Waiting up to 120 s…"
python3 - "$PORT" "$IP" <<'PY'
import http.server, socketserver, sys, threading
port = int(sys.argv[1]); SELF = {"127.0.0.1", sys.argv[2]}; hit = threading.Event()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.client_address[0] in SELF:
            self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers()
            self.wfile.write(b"<h1 style='font:40px system-ui'>This is the Mac itself. Open this link on your PHONE.</h1>"); return
        self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers()
        self.wfile.write(b"<h1 style='font:40px system-ui'>Reached the Mac. Local hosting is possible on this wifi.</h1>")
        print(f"REACHED from {self.client_address[0]}: phones on this wifi CAN reach the Mac", flush=True); hit.set()
    def log_message(self, *a): pass
socketserver.ThreadingTCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(("0.0.0.0", port), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
if not hit.wait(120): print("NO PHONE REACHED THE MAC in 120 s: this wifi likely isolates devices from each other (or the phone wasn't on the same wifi). Local hosting over this wifi won't work.")
srv.shutdown()
PY
