# BGCC Guesstimate × The Vardhan Case

**280 phones. One hall. One clock. Zero room for error.**

This is the full stack behind BGCC's live event on 24 Nov 2026: a real-time guesstimate qualifier played on everyone's phone at the same moment, followed by a team murder-mystery for the 41 who made the cut. It was built from scratch and run on our own servers, and it was designed so that a dead laptop, bad hall Wi-Fi or a crashed server can't stop the game.

```
 phones ──https──▶ Caddy (auto-TLS) ──▶ Next.js 16 (systemd) ──▶ Postgres 16
 (/play)           vardhan-1  ◀────────── primary ──────────────────┘   │
 projector                                                              │ streaming replication
 (/screen)                                                              ▼ over an SSH tunnel
 organisers        vardhan-2  ── hot standby, app off, one script away from taking over
 (/admin)
                   + pg_dump every minute on the server (last 240 kept)
                   + a laptop pulling a copy every 30 s
```

---

## The event

### Round 1: The Guesstimate (solo, everyone)
- 1 practice question + **15 live questions** (6 Easy, 5 Medium, 4 Hard) on how many, how big and how much. **Every phone and the projector open the same question at the same moment.**
- Timers are set by the server. Phone clocks don't matter.
- **Ratio scoring:** within 1.1× of the answer = 10 pts, 1.25× = 7, 1.5× = 5, 2× = 3, 3× = 1, further off = 0. Then × the question's weight (Easy 1, Medium 2, Hard 3). Max 280. Being 2× too high and 2× too low cost the same.
- **Ranks stay hidden until the end.** During the game, phones show only your own points and the projector shows only the answer. After the last question: the full leaderboard, then the qualifier cut-off.
- Organisers can fix an answer mid-game and **everyone is rescored instantly**.

### Round 2: The Vardhan Case (teams, qualifiers only)
- A murder mystery set in Goa: a case file, and **12 exhibits** (post-mortem, call records, an airport lookout, an insurer's file…).
- Teams open exhibits by typing the code from a paper slip, and **the whole team sees the clue within ~5 s**.
- **Of the correct answers, the team that opened the fewest exhibits wins.** Every exhibit you open counts against you. Ties go to the team that answered first.
- The story, the rules and the answer key are in [`game/`](game/), and the printed exhibits are in [`handouts/`](handouts/). Spoilers, obviously.

---

## Engineering

### Designed to survive
| What breaks | What happens |
|---|---|
| A phone dies, refreshes or switches apps | Every keystroke is stored on the phone first and sent again until the server confirms it. Log in on any phone with your BITS ID + PIN and carry on. |
| Hall Wi-Fi drops | The answer stays queued on the phone and is sent when the connection returns. A save counts only when the server returns valid JSON, so a Wi-Fi login page can't fake a "Saved". |
| All the organisers go offline | The game runs itself. The schedule is a **pure function of the database clock**, so no admin has to press "next". |
| The primary server dies | `failover.sh` promotes the hot standby to primary, then the public IP is moved to it. Phones reconnect by themselves and nobody logs in again. |
| The database is lost | Two independent backup chains: dumps every minute on the server and every 30 s on a laptop. |

### Key decisions
- **No WebSockets.** Phones poll a tiny, cacheable state endpoint, and the cache key changes on every phase change, so a phone picks up a new question on its next poll. Simple, cheap and able to handle a full hall.
- **Lazy schedule.** No cron and no timers on the server: open → closing → reveal is computed from one `game` row plus `now()` in Postgres. A pause just shifts the anchor time. See [`web/lib/schedule.ts`](web/lib/schedule.ts).
- **Answers can't arrive after the deadline.** Every answer carries an increasing sequence number and the database keeps only the newest one, with a 2 s grace period after close. Anything later is rejected, and the answer range is only shown after the window has closed.
- **Admin writes check a version number**, so two organisers tapping at the same time can't both apply a change.
- **Secrets stay on the server.** Exhibit text and the answer key are only sent by authenticated routes and never appear in the client bundle.

### Tested hard
- **600 simulated phones**, full game: 0 errors, and every confirmed answer matched the database.
- **1,000 simulated phones with the server killed mid-question** (9 s outage): the game stayed on schedule and all 3,664 confirmed answers were intact.
- End-to-end suites for both rounds, plus unit tests for scheduling, scoring and parsing.

### Stack
**Next.js 16 · React 19 · TypeScript · PostgreSQL 16 · Caddy · systemd · Ubuntu 24.04 on two Azure VMs (Central India)**. Paid for with student credit, at about $1 per VM per day.

---

## Repo map
```
web/                 the app (players /play, projector /screen, organisers /admin)
  app/               pages + API routes
  lib/               schedule, scoring, ranking, mystery logic (unit-tested)
  db/schema.sql      the whole data model
  scripts/           manage.ts (load questions, admins, exhibits), e2e + load tests, backups
  deploy/oracle/     VM setup, deploy, hot standby, failover, restore (plain Ubuntu)
  ARCHITECTURE.md    design notes and failure analysis (written for the earlier Vercel + Neon plan)
  RUNBOOK.md         what to do on the day when something breaks
game/                the Vardhan Case: case file, rules, cards, answer key
handouts/            printable case file and exhibits
tools/               Python scripts that build the PDFs
```

## Run it yourself
```bash
cd web && npm install
createdb vardhan_quiz && export DATABASE_URL=postgres://localhost/vardhan_quiz
node scripts/manage.ts init
node scripts/manage.ts questions questions.csv
node scripts/manage.ts admin <name> '<10+ char password>'
npm run build && DATABASE_DRIVER=pg npx next start -p 3000
```
Open `/play` on your phone, `/screen` on a projector and `/admin` on yours. Full setup and the production deploy are in [`web/README.md`](web/README.md).

---

Built by the BGCC organising team for the 24 Nov 2026 event.
