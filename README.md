# BGCC Guesstimate

Web app and game material for a two-round live event run by BGCC on 24 Nov 2026 (280 players).

- **Round 1, guesstimate (solo):** 15 timed estimation questions, opened on every phone and the projector at the same moment.
- **Round 2, the Vardhan Case (teams):** a mystery with 12 exhibits that teams unlock with codes. Of the correct answers, the team that opened the fewest exhibits wins.

Three pages: `/play` (phones), `/screen` (projector), `/admin` (organisers).

## Stack
- Next.js 16 (App Router), React 19, TypeScript
- PostgreSQL 16 (`pg` driver; the Neon serverless driver is also supported)
- Caddy (TLS, reverse proxy) in front of a systemd service on `127.0.0.1:3000`
- Two Ubuntu 24.04 VMs on Azure (Central India)

## Deployment
```
clients ── https ──▶ Caddy ──▶ Next.js (systemd) ──▶ Postgres 16      vm-1 (primary)
                                                         │
                                                         │ streaming replication over an SSH tunnel
                                                         ▼
                                                     Postgres 16      vm-2 (hot standby, app disabled)
```
- **Deploy:** `deploy/oracle/push.sh` copies the source, builds on the VM and restarts the service. `push-standby.sh` does the same for the standby. The scripts are plain Ubuntu despite the folder name.
- **Failover:** `failover.sh` promotes the replica (`pg_promote`) and starts the app on vm-2. The public IP is then moved to vm-2's network interface, so the URL doesn't change and client sessions stay valid.
- **Backups:** `pg_dump` every minute by cron on the primary (last 240 kept), plus a second copy pulled to a laptop every 30 s (`scripts/backup.sh`).

## Design
- **Timing is computed, not scheduled.** The current phase (open → closing → reveal) is a pure function of one `game` row, the question list and Postgres `now()` (`lib/schedule.ts`).
  - Nothing runs on a timer, so the game continues with no organiser connected.
  - Pause and resume shift an anchor timestamp.
- **Polling, no WebSockets.** Clients poll `/api/state` with the state key they expect next. A matching key gets a short cache lifetime; any change is a cache miss. The response includes server time, so phone clocks don't matter.
- **Answer writes:**
  - Saving is idempotent: an upsert keyed by (player, question) that applies only if the client's sequence number is higher than the stored one (`app/api/answer/route.ts`).
  - Answers are accepted until 2 s after close. The answer range is only sent after a 3 s gap.
  - Clients save 1.2 s after typing stops, keep unsent answers in `localStorage` and resend on reconnect or page hide.
  - A save counts as confirmed only on a JSON `{ok, seq}` response, so a Wi-Fi login page can't show a false "Saved".
- **Admin writes** are single conditional `UPDATE`s on a version column, so two concurrent admin actions can't both apply.
- **Scoring** is ratio-based (within 1.1× = 10, 1.25× = 7, 1.5× = 5, 2× = 3, 3× = 1, else 0) × question weight.
  - It's computed at read time, so editing an answer rescores everyone.
  - Ties go to fewer blanks, then log distance, then answer time.
  - Ranks are snapshotted into `rank_rows` (`lib/scoring.ts`, `lib/ranking.ts`).
- **Round 2:**
  - Exhibit text and the answer key are only sent by authenticated routes, never in the client bundle.
  - A code unlocks an exhibit for the whole team.
  - The team-forming stage handles create/join by code, size limits and random assignment.
- **Auth:** BITS ID + 4-digit PIN set on first login (scrypt hash), at most 2 sessions per player. Admins have their own password hashes and are rate-limited.

## Testing
- Unit tests: `npm test` (schedule, scoring, parsing).
- End-to-end: `scripts/e2e.ts` (Round 1) and `scripts/e2e-mystery.ts` (Round 2).
- Load (`scripts/load.ts`), against a local production build:
  - 600 simulated clients over a full game: 0 errors, and every confirmed answer matched the database.
  - 1,000 clients with the server killed for 9 s mid-question: the schedule held and all 3,664 confirmed answers were intact.

## Layout
```
web/
  app/              pages and API routes
  lib/              schedule, scoring, ranking, mystery logic
  db/schema.sql     data model
  scripts/          manage.ts (questions, admins, exhibits), tests, backup
  deploy/oracle/    VM setup, deploy, standby, failover, restore
  ARCHITECTURE.md   original design notes (written for a Vercel + Neon setup)
  RUNBOOK.md        event-day procedures
game/               case file, rules, cards, answer key
handouts/           printable case file and exhibits
tools/              Python scripts that build the PDFs
```

## Running locally
```bash
cd web && npm install
createdb vardhan_quiz && export DATABASE_URL=postgres://localhost/vardhan_quiz
node scripts/manage.ts init
node scripts/manage.ts questions questions.csv
node scripts/manage.ts admin <name> '<10+ char password>'
npm run build && DATABASE_DRIVER=pg npx next start -p 3000
```
See `web/README.md` for the full setup.
