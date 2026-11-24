# Vardhan Case Web App: Architecture v2

Status: reviewed (two independent reviews: platform/India network, app logic/India devices). Event: BITS Goa pre-induction, ~500 players.

## 1. What the app does

| Phase | Who | What happens |
|---|---|---|
| Login | all ~500 | BITS email + 4-digit PIN chosen on first login. Email is the account. |
| Lobby | all | Rules, marking scheme, "N players joined". |
| Practice | all | 2 unscored questions, then a 60 s "Get ready" break. |
| Qualifier | all | ~15 guesstimate questions released to everyone at once, each with its own time limit. Golf scoring: lowest total wins. |
| Results | all | Leaderboard; top N eligible players qualify. |
| Mystery (phase 2) | ~40 qualifiers | Auction and trading offline. Teams type card codes to view clues; submit answers. |

## 2. Hard requirements

1. Survives organiser failure (laptop, wifi, all admins offline).
2. Survives player failure (crash, refresh, app switch, captive portal, device switch).
3. Server-decided timing; phone clocks don't matter.
4. No early leaks of questions or ranges.
5. Free tier by default; one optional paid month as insurance (§8).
6. No code changes on event day.

## 3. Stack

| Layer | Choice | Notes |
|---|---|---|
| Hosting | Vercel Hobby, Next.js App Router, TypeScript | Free student event = non-commercial. Ask Vercel support if a company sponsors. |
| Function region | **`sin1` (Singapore)** | Next to the database. Cached responses still come from the Indian edge. Default would be `iad1` (US): must be set. |
| Database | Neon Postgres free, Singapore, `@neondatabase/serverless` HTTP driver | No Mumbai region. Autosuspend after 5 min (fixed): warm-up ping before start. 6 h instant restore. |
| Clock | **Postgres `now()`** for state, answers and admin writes | Never mix function and DB clocks. |
| Realtime | None. Phase-keyed, CDN-cached polling | WebSockets exist in beta; polling is simpler and cheaper. |
| Backup host | Oracle Always Free VM (Mumbai/Hyderabad) if capacity is available; else the Mac via Tailscale Funnel (version pinned) | Backup runs the same build against a local Postgres restored from the latest `pg_dump`, so it also covers a Neon outage. |

## 4. Core design: lazy schedule

The current phase is a pure function of the `game` row, the item list and DB time (`lib/schedule.ts`, unit-tested). Per item:

```
open [opensAt, closesAt) → closing [closesAt, revealAt = closesAt + 3 s) → reveal [revealAt, revealEndsAt)
```

- Answers accepted while open, and up to 2 s into "closing". The range is only ever shown from `revealAt`, so it is never public while answers are accepted.
- `game`: `mode`, `anchor_at`, `anchor_index`, `paused_at`, `extensions` (per item answer ms), `reveal_extensions`, `max_revealed_index`, `version`.
- Admin transitions (all record `max_revealed_index` first): start (lobby only), pause (no-op if paused), resume (`anchor_at += now − paused_at`), jump to item k (refused if k ≤ max revealed; clears pause), extend (open item only), extend reveal, finish.
- Answers for any item ≤ `max_revealed_index` are rejected forever.
- SQL guards: every admin write is one `UPDATE ... WHERE version = $v` with the new row computed from the old; pause adds `AND paused_at IS NULL`. Old row stored in `admin_log` for manual restore.

## 5. Endpoints

| Endpoint | Cache | Notes |
|---|---|---|
| `GET /api/state?k=<version>-<item>-<phase>` | `s-maxage=1, stale-while-revalidate=1` when `k` matches the live key; **`no-store` when it doesn't** | No cookies read, no middleware, never a cacheable error. Returns phase, item, `opens_at`, `closes_at`, `reveal_at`, `next_change_at`, `key`; question text only if open/closing; range only if in reveal. Clients always request with the key they expect next, so each change is a cache miss. |
| `POST /api/login` | none | `{email, pin}`. Email must match `^f\d{8}@goa\.bits-pilani\.ac\.in$`; if an allowlist is loaded, must be on it. First login sets the PIN (bcrypt-equivalent hash). Later logins need the PIN. Returns the session token in JSON **and** an HttpOnly cookie (token lets retries go to a second hostname). Up to 2 live sessions per player. |
| `POST /api/answer` | none | `{item, value, seq}`. Auth by cookie or `Authorization` header. JSON content type + Origin check. Value: ≤ 15 significant digits, ≤ 1e15, stored as `double precision`; invalid → non-retryable 400. Upsert `WHERE excluded.seq > answers.seq`. `elapsed_ms` from the schedule clock, updated only when the value changes. Response `{ok, seq, value, closes_at, version, paused, server_now}` (uncached, used for clock offset). Never returns a penalty. |
| `GET /api/me` | private, no-store | Answers, penalties for revealed items only, total, rank from the latest snapshot ("as of Q7"), `server_now`. Clients add 0–3 s jitter after a reveal. |
| `GET /api/leaderboard` | `s-maxage=5` | Top 20 by display name, player count, cut-off. From `rank_snapshot`. |
| `/play`, `/screen`, `/admin` | static | Admin API checks an admin session (per-admin password hashes in the DB, constant-time compare, rate-limited). Admin reads are uncached. |

Rank snapshot: computed once per (revealed item, ranges version) into `rank_snapshot`, never in function memory.

### Client sync rules
- Clock offset from uncached responses only (answer POST, `/api/me`), lowest round-trip sample.
- Sleep until `next_change_at` + 0–1.5 s jitter; if the response is older than the expected change, retry after 400 ms. Fallback poll every **10 s** (keeps one campus IP at ~50 req/s, not ~500).
- Refetch on `visibilitychange`, `pageshow`, `focus`, `online` and cold load. Countdown is recomputed from the offset each frame, never by counting ticks.
- The input is never locked on the phone; the server decides.
- Every fetch has a 3 s timeout and immediate retry; after two failures, retry against the second hostname with the bearer token.
- A save counts as confirmed only on a JSON `{ok:true, seq}`. HTML, redirects or TLS errors = offline (captive portal) → red "Not saved: Wi-Fi login expired? Try mobile data".

## 6. Player-side resilience

- Autosave 1.2 s after the last keystroke and on blur; immediate save on `visibilitychange→hidden` / `pagehide` with `keepalive`.
- Under the box: the number in words ("2.5 lakh", "25 crore"). Status: green "Saved ✓ 25,00,000" or red "Not saved".
- Offline queue in `localStorage` (try/catch), keyed by player and item, with `seq`; replays until confirmed or rejected as closed.
- At close: "Your final answer: X".
- In-app browsers (Instagram, Facebook, WhatsApp, LinkedIn user agents): show "Open in Chrome/Safari" before login.
- `inputmode="decimal"` text input; Indian digit grouping.
- Login shows "You are <name>" when the allowlist has names, to catch typos.

## 7. Scoring (`lib/scoring.ts`, unit-tested)

- Inside `[low, high]` → 0; within 2× → 50; 5× → 100; 10× → 150; beyond or ≤ 0 → 200; blank → 250. Comparisons without division.
- Computed at read time from current ranges; range edits rescore everyone.
- Ranking: total → fewer blanks → summed log-closeness to the range centre (blank = large) → total `elapsed_ms` → sign-up time → id.
- Only eligible players (on allowlist if loaded, not disqualified) count for the cut-off.

## 8. Network and platform risks (India)

| Risk | Handling |
|---|---|
| Vercel DDoS protection flags 500 phones behind one campus IP (Hobby can't exempt IPs) | 10 s fallback poll + jitter; dry run from campus watching the Firewall tab; client detects non-JSON 403 → "switch to mobile data". **Insurance option: one month of Vercel Pro (~$20) for "Pause System Mitigations".** Never enable Attack Mode. |
| Jio stalls (10–15 s) to Vercel edge reported Nov 2026 | 3 s timeouts, retry, second hostname, early autosave. Test on real Jio/Airtel/Vi SIMs. |
| ISP / campus DNS or SNI blocking (Supabase was blocked in India in Feb 2026; Jio custom-domain failures reported) | Two URLs (`*.vercel.app` + a second domain), both on the QR sheet; test both on campus wifi, Jio, Airtel, Vi 48 h before; ask campus IT to allowlist; "use mobile data / Private DNS dns.google" card. No IPv6 records. |
| Campus captive portal (Sophos) re-login mid-quiz | JSON-only confirmation; clear message; ask IT to extend the timeout on event day. |
| Hall wifi density | Ask IT for AP capacity; tell players to keep mobile data on. |
| Hobby monthly limits (1M edge requests; overage = 30-day pause) | Event ≈ 350k edge requests, ≈ 50k invocations. **Full load test runs against the backup/local build, never against Vercel.** On Vercel only a capped smoke test (≤ 100 users, ≤ 50k requests). Keep other projects on the account idle. Track usage daily. |
| Neon cold start / incidents | Warm-up ping; `pg_dump` after each question to the backup; status page watched. |
| Logs (Hobby keeps 1 h) | Rely on `admin_log`, `answers` and CSV exports. |

## 9. Identity and cheating

- PIN on first login; PIN needed on any new device. Admin can reset a PIN after an ID-card check.
- **Allowlist (optional but recommended):** organisers load the list of first-year IDs (and names). Without it, anyone can script fake accounts matching the email pattern.
- Admin "disqualify" flag. Qualifiers show their BITS ID card before phase 2.
- Leaderboard shows names (or masked IDs), never full emails.

## 10. Phase 2: the mystery round (built)

- Tables: `mystery` (stage, submissions_open, team size, attempts), `roster`, `teams`, `team_members` (one team per player), `team_invites`, `clues` (title, public description, body, code), `unlocks` (team × exhibit), `code_attempts`, `submissions`, `mystery_docs` (case file, answer key).
- Stages: closed → teams → play → ended. `/play` switches to the mystery UI whenever the stage isn't closed.
- Knowledge model: a code unlocks an exhibit for the entering player's whole team; any number of teams can use the same code. There is no possession or citing.
- Exhibit text and the answer key are only served by authenticated routes (`/api/mystery/clue` checks the team's unlock; the key is admin-only). Nothing about them is in the client bundle.
- Code entry: case/space/dash-insensitive, 8 characters from an unambiguous alphabet; 5 wrong codes per team per minute, then a one-minute lock.
- Submissions: one INSERT with the attempt-count check, so teammates can't double-submit; server time decides order. The winner is the earliest submission judged correct, announced only when every earlier submission has a verdict.
- Polling: players every 4–5.5 s while live (about 10 req/s for 40 players), 15 s while closed.

## 11. Test plan

1. Unit tests (`node --test lib/core.test.ts`): schedule, scoring, parser.
2. Full load test (k6, 600 users, realistic sleeps, deadline bursts, a pause) against the **local/backup build** with a Neon branch.
3. Capped smoke test on Vercel; confirm `x-vercel-cache: HIT` on `/api/state` and note `x-vercel-id` region per carrier.
4. Dry run on campus with 30–40 people: one killing wifi mid-question, one on each carrier, one switching devices, one admin pausing from a phone; watch the Vercel Firewall tab.
5. Failover drill to the backup URL.
6. 48 h before: URL checks on campus wifi, Jio, Airtel, Vi. Code freeze.

### Results so far (23 Nov 2026, local production build, local Postgres)
- Unit tests 13/13; guesstimate end-to-end and mystery end-to-end all pass.
- Load test, 600 phones, full game: 0 errors; every confirmed answer matched the database; nothing accepted after close; `/api/state` p95 97 ms uncached (no CDN locally).
- Load test, 1,000 phones with the server killed and restarted mid-question (9 s outage): the game stayed on schedule, every phone reached results, 3,664 confirmed answers all matched, nothing accepted late. Saves during the outage failed as expected (real phones queue and retry them).
- Backup and failover: `backup.sh` dumps every 30 s; `failover.sh` restored an identical copy (1,000 players, 3,912 answers) and served it; existing players logged in with their old PIN.
- Change after these reviews: the mystery stage now rides on the cached `/api/state`, so phones don't poll `/api/mystery/me` while the mystery is closed (it would have added ~33 uncached requests/s from 500 phones during the qualifier). Only players on the roster poll fast once the mystery is live.
- Not yet tested (needs real accounts and devices): Vercel + Neon in production, CDN caching, real carriers and campus wifi, Tailscale Funnel failover. See the checklist in the final report / RUNBOOK.md.
