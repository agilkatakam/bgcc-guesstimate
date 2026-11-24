# Vardhan Case event site: setup and runbook

Two rounds on one site: the guesstimate qualifier (~500 players) and the mystery round (the qualifiers, in teams).

Design and failure analysis: [ARCHITECTURE.md](ARCHITECTURE.md). What to do when something breaks on the day: [RUNBOOK.md](RUNBOOK.md).

## Pages
- `/play`: players (phones)
- `/screen`: projector
- `/admin`: organisers (any phone or laptop)

## Hosting: Azure for Students (chosen; free with the $100 student credit)
Two Ubuntu 24.04 VMs in Central India (or the nearest allowed region): **vardhan-1** (primary: app + its own Postgres) and **vardhan-2** (standby, same setup). A free DuckDNS name points at the primary. Size **B2als v2** (2 vCPU, 4 GiB) or **B2s**. Admin username **`ubuntu`** (the scripts assume it), SSH key `~/.ssh/vardhan_oracle.pub`, inbound ports 22, 80, 443. Each VM costs about $1/day while running: press **Stop** in the portal when not testing.
1. duckdns.org: create a name (e.g. `vardhancase.duckdns.org`) pointing at vardhan-1's IP.
2. On each VM: copy `deploy/oracle/setup.sh` up and run `DOMAIN=<name>.duckdns.org bash setup.sh`. (The scripts live in `deploy/oracle/` but are plain Ubuntu; nothing Oracle-specific.)
3. From the Mac: `./deploy/oracle/push.sh ubuntu@<ip>` for each VM (copies, builds, starts, checks).
4. Content on the primary (run on the VM after `cd /opt/vardhan; set -a; . /etc/vardhan.env; set +a`):
   ```
   node scripts/manage.ts questions questions.csv        # the 15 guesstimates (Easy / Medium / Hard); see "questions.csv columns"
   node scripts/manage.ts admin <name> '<10+ char password>'   # 2–3 organisers
   node scripts/manage.ts mystery --new-codes             # exhibits, case file, answer key from ../game; prints the codes for the slips
   ```
   Optional: `node scripts/manage.ts scoring rubric.json` (the built-in rubric is already the one below), `node scripts/manage.ts allowlist students.csv` (`email,name`: only these IDs can log in, with these names).
5. During the event the Mac runs `SOURCE_SSH=ubuntu@<primary ip> ./scripts/backup.sh`. If the primary dies: `./deploy/oracle/restore.sh ubuntu@<standby ip>`, then point the DuckDNS name at the standby's IP.
6. Logo: replace `public/logo.svg` (square) with the real BGCC logo and push again.

## One-time setup on Vercel + Neon (alternative, not used)
1. **Neon:** create a free project in **AWS Singapore**. Copy the connection string.
2. Same `manage.ts` commands as above with `DATABASE_URL='<neon connection string>'`.
3. **Vercel:** import this folder as a project (Hobby). Environment variable: `DATABASE_URL`. Deploy.

## Round 1: the guesstimate (solo)
- **Before the event:** share the `/play` link hours early. Players log in with their **BITS ID, name and a 4-digit PIN** they choose (the name only the first time; later the ID + PIN is enough, on any phone). They stay logged in for 7 days on that phone, at most 2 phones per person. The lobby shows your **lobby message** (Admin → Guesstimate → Lobby message, e.g. "Starts around 5:10 to 5:15 PM") above a live clock, plus how the game and the scoring work.
- **Start:** Admin → Start (type START). Every phone and the projector show **"Starting in 10"**, then question 1 opens everywhere at once.
- **Questions** (`questions.csv`): 1 practice (campus acres, 45 s, not scored), then 6 Easy (1:30 each, 1× points), 5 Medium (2 min, 2×), 4 Hard (3 min, 3×), with a 20-second break card before Medium and Hard. Each reveal shows the answer for 15 s (Admin can add +30 s) with a one-line method where we had one. ≈ 36 minutes in all.
- **Scoring** (points, highest total wins; Admin → Guesstimate → Scoring rubric, or `manage.ts scoring <json>`; changing it rescores everyone):

  | Your answer is within … of the correct answer | Points |
  |---|---|
  | 1.1× (e.g. 909 to 1,100 if it's 1,000) | 10 |
  | 1.25× (800 to 1,250) | 7 |
  | 1.5× (667 to 1,500) | 5 |
  | 2× (500 to 2,000) | 3 |
  | 3× (333 to 3,000) | 1 |
  | further off, or no answer | 0 |

  Then × the question's weight (Easy 1, Medium 2, Hard 3). Max 280. Ties: fewer blanks, then closer overall (log distance), then faster answers. "Times" is a ratio, so being 2× too high and 2× too low cost the same, whatever the size of the number.
- Answers and weights can be changed mid-game (Admin → Guesstimate → tap the answer); everyone is rescored.
- **Ranks are secret until the end:** during the game phones show only their own points; the projector shows only the answer. After the last question: full leaderboard on phones, top 10 on the projector.
- Leaderboard shows the names players typed. Admin → Players → Rename fixes a bad one; Disqualify removes someone from the ranking.
- **Choosing who qualifies, on the spot:** Admin → Qualifiers shows the full ranking (live, only for organisers). Type N; it shows the cut line and warns about a tie at the cut. **Set top N as qualifiers** fills the Round 2 roster privately; **Announce** then flips the top N phones to "You're through" and shows the cut line everywhere. Until then players see "Results are in".
- **Marketing:** `https://<site>/poster` is a printable A4 poster with a QR code to `/play`. The projector lobby shows the same QR.
- Round 1 doesn't have to come first: Round 2 is independent. With an empty roster anyone logged in can play Round 2.

## Round 2: the Vardhan Case (teams)
Rules: no auction. Teams open any exhibits they want; every different exhibit a team opens counts; of the correct answers, the fewest opened wins; a tie goes to the team that answered first.
Admin → Round 2:
1. **Team forming.** Players open the same `/play` link; it switches by itself. Leads tap *Create (lead)* and read out the 5-letter team code; teammates tap *Join a team* and type it. Max team size 10. *Max teams* (0 = no limit) caps how many teams players can create. Organisers can also press **Random teams: N teams**, which splits everyone without a team into N teams whose sizes differ by at most 1 (first person = lead), or paste teams, and add/move/remove people and change the lead.
2. **Game on.** Everyone sees the case file and the 12 exhibit titles. A team asks an organiser for exhibit N and gets the **paper slip** with its code (`node scripts/manage.ts codes` prints them); any member types it and the whole team sees the clue within ~5 s.
3. **Answers are given in person.** When a team tells you its answer, press **Answer given** for it in the live table: that stamps the time (breaks ties) and freezes its clue count (it can't open more). Undo removes it. Mark Correct / Not correct; the standings order themselves (correct first, fewest clues, earliest).
4. **Ended** stops all opening. Announce the winner live; standings never appear on phones or the projector.
5. Dry runs: Admin → Round 2 → Reset Round 2.

## questions.csv columns
`kind` (q or break), `practice` (yes/blank), `section` (Easy/Medium/Hard: shown on the question), `text`, `unit`, `answer`, `low`, `high` (optional: a band that scores full points instead of the exact answer), `weight` (points multiplier), `seconds`, `reveal_seconds`, `note` (**shown to players and on the projector** at the reveal; leave blank unless it's an explanation).
Order of rows = order of play. Loading questions is only allowed while the game is in the lobby.

## Event day
1. 30 min before: start `SOURCE_SSH=ubuntu@<primary ip> ./scripts/backup.sh` on the Mac (copies every 30 s); open `/admin` on 2 phones; open `/screen` on the projector (its lobby shows the address to type).
2. Players open `/play` (most will already be logged in from earlier), log in with their BITS ID (`f20260123`), their name and a 4-digit PIN they choose.
3. Admin presses **Start** (type START). 10-second countdown on every screen, then it runs by itself.
4. Admin can Pause/Resume, +15 s / +30 s on an open question, +30 s on a reveal, or open a later question.
5. Download the CSV after each reveal (Admin → Download results CSV).
6. A player forgot their PIN: check their BITS ID card → Admin → Players → Reset PIN.

## Tests
- Unit: `npm test`
- Mystery end-to-end (local server with exhibits loaded; resets the mystery):
  `BASE=http://localhost:3100 ADMIN=akhil ADMIN_PASS=devpassword123 node scripts/e2e-mystery.ts`
- End-to-end against a local server (fresh lobby, short questions):
  ```
  createdb vardhan_quiz
  export DATABASE_URL=postgres://localhost/vardhan_quiz
  node scripts/manage.ts init && node scripts/manage.ts questions scripts/e2e-questions.csv
  node scripts/manage.ts admin akhil devpassword123
  npm run build && DATABASE_DRIVER=pg npx next start -p 3100 &
  BASE=http://localhost:3100 ADMIN=akhil ADMIN_PASS=devpassword123 node scripts/e2e.ts
  ```
- Load test (N simulated phones play a whole game; checks every saved answer): steps at the top of `scripts/load.ts`. Run it against the local build only. Against the deployed site, at most `N=100` (≈ 3.5k requests) as a smoke test (Hobby limits; see ARCHITECTURE.md §8).

## Backup host
- `scripts/backup.sh` dumps the live database into `backup/` every 30 s (keep it running during the event). `pg_dump` must match or exceed Neon's Postgres version (`brew install postgresql@17` if Neon runs 17).
- `scripts/failover.sh` restores the newest dump into a local database and serves the same build on port 3000; then `tailscale funnel --bg --https=8443 3000` gives players a public https URL. Funnel must be enabled once in the Tailscale admin console (HTTPS certificates + the funnel attribute). Players log in again there with the same email and PIN.
