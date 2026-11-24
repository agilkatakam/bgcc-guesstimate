# Event-day runbook: what to do when something breaks

Print this. One organiser owns it on the day. Design and research: [ARCHITECTURE.md](ARCHITECTURE.md). Setup: [README.md](README.md).

## Before doors open (T − 30 min)
1. On the Mac: `SOURCE_SSH=ubuntu@<primary ip> ./scripts/backup.sh` in its own terminal. It copies the live database every 30 s. Leave it running until the end. Each line should say `ok`.
2. `node scripts/manage.ts warm`.
3. Open `/admin` on two phones (two different admins), `/screen` on the projector laptop.
4. Phone checks on the venue wifi, Jio, Airtel and Vi: open both URLs, log in, see the lobby.
5. Have the QR sheet with **both** URLs, and the "switch to mobile data" card, ready to show on the projector.

## If something breaks

| What you see | What it means | Do this |
|---|---|---|
| One player: red "Not saved" | Their connection (often the campus wifi login page expired) | Tell them: mobile data on, or log in to wifi again. The phone keeps retrying; nothing typed is lost. |
| One player can't log in: "Wrong PIN" | Forgot their PIN | Check their BITS ID card → Admin → Players → Reset PIN. |
| One player: "Open in Chrome or Safari" | They opened the link inside WhatsApp or Instagram | Open it in Chrome or Safari. |
| Many players on **campus wifi** stuck, mobile-data players fine | Campus wifi or the host blocking the shared campus address | Projector: "Switch to mobile data". **Pause** (Admin) until most are back, then Resume. |
| Many players on **one carrier** (e.g. Jio) stuck | Carrier route to the host is slow/blocked | Projector: the second URL, or wifi. Pause if it's more than a handful. |
| Everyone stuck, the site doesn't load anywhere (wifi and mobile data) | The primary VM is down | 1. Pause if Admin still loads. 2. Mac: `./deploy/oracle/restore.sh ubuntu@<standby ip>` (loads the last backup, ≤ 30 s old). 3. duckdns.org: set the name's IP to the standby's IP (phones follow within a minute or two; meanwhile show the standby's own address as a QR). 4. Players log in again (same email and PIN). 5. Admin → Resume / open the right question; extend the current one (+30 s) for answers lost since the backup. |
| A question closed while people were cut off | They lost that question's answer | Before its range shows: Admin → Pause. You can't reopen a question once its range is public. Otherwise accept it and move on; it's the same for everyone on that network. |
| Admin pressed something wrong | | Pause first. Jump forward / extend are safe. Every admin action is in the admin log with the old value. |
| Projector frozen | Its laptop or wifi | Reload `/screen`, or open it on any other laptop. The game doesn't depend on it. |
| Your laptop dies or the organisers' wifi goes | | Nothing to do: the game runs on its own schedule on the server. Use an admin phone on mobile data. (Backups stop until the Mac is back.) |
| Wrong range typed for a question | | Admin → Questions → edit the range. Everyone is rescored automatically. |
| A late tie at the qualifying cut-off | | Tie-breaks are automatic (fewer blanks, closeness, speed). Results CSV: Admin → Download. |

## Round 2
| What you see | Do this |
|---|---|
| A player isn't in a team after teams lock | Admin → Round 2 → Teams → *Add* on their team (BITS ID). |
| The lead's phone died / lead left | Admin → Teams → *Make lead* on another member. They can now open and submit. |
| A team says it opened something by mistake | It counts (that's the rule). Only revoke (tap the yellow number) if it was the site's fault. |
| Code mode: a team lost its slip | Give the code again (Round 2 tab → Exhibits table), or tap the exhibit number on their team to grant it. |
| Non-qualifiers getting in | Qualifiers tab → *Send top N to Round 2* **before** Team forming. |
| A team submitted the wrong thing | Judging → *Delete* on their submission; the lead submits again (their time is the new one). |
| Someone claims their account was taken (wrong PIN on first try) | Check their BITS ID card → Players → Reset PIN. That logs out every other device on that account. |

## After each reveal
Admin → Download results CSV (a second copy besides the Mac backups).
