import { randomInt } from "node:crypto";
import { q, tx, markStateChanged } from "@/lib/db";
import { normaliseEmail } from "@/lib/parse";
import { checkPost, json } from "@/lib/http";
import { requireAdmin, log } from "@/lib/admin";
import { load } from "@/lib/game";
import { ensureSnapshot } from "@/lib/ranking";
import { loadMystery, newJoinCode, parseKey, standings, Refuse, type Stage } from "@/lib/mystery";

export const dynamic = "force-dynamic";

const emailPattern = () => (process.env.EMAIL_PATTERN ? new RegExp(process.env.EMAIL_PATTERN, "i") : undefined);
const cleanName = (raw: unknown) => String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();

// Organisers' full view of round 2: settings, roster, teams, exhibits, submissions, answer key, standings.
export async function GET(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const m = await loadMystery();
  const roster = await q<{ email: string; name: string | null; joined: boolean; team: string | null }>(
    `SELECT r.email, coalesce(p.name, a.name) AS name, p.id IS NOT NULL AS joined, t.name AS team
       FROM roster r LEFT JOIN players p ON p.email = r.email LEFT JOIN allowlist a ON a.email = r.email
       LEFT JOIN team_members tm ON tm.player_id = p.id LEFT JOIN teams t ON t.id = tm.team_id ORDER BY r.email`,
  );
  const teamRows = await q<{ id: number; name: string; captain_id: number | null; join_code: string | null }>(`SELECT id, name, captain_id, join_code FROM teams ORDER BY id`);
  const members = await q<{ team_id: number; id: number; name: string | null; email: string }>(
    `SELECT m.team_id, p.id, p.name, p.email FROM team_members m JOIN players p ON p.id = m.player_id ORDER BY m.joined_at, p.id`,
  );
  const unlocks = await q<{ team_id: number; clue_n: number; at: string; by: string | null }>(
    `SELECT u.team_id, u.clue_n, u.at, coalesce(p.name, split_part(p.email, '@', 1)) AS by FROM unlocks u LEFT JOIN players p ON p.id = u.player_id ORDER BY u.at`,
  );
  const answered = new Map((await q<{ id: number; team_id: number; submitted_at: string }>(`SELECT id, team_id, submitted_at FROM submissions`)).map((r) => [r.team_id, r]));
  const teams = teamRows.map((t) => ({
    id: t.id, name: t.name, leadId: t.captain_id, joinCode: t.join_code, submitted: answered.has(t.id),
    submissionId: answered.get(t.id)?.id ?? null, answeredAt: answered.get(t.id)?.submitted_at ?? null,
    members: members.filter((x) => x.team_id === t.id).map((x) => ({ id: x.id, email: x.email, name: x.name ?? x.email.split("@")[0] })),
    opened: unlocks.filter((u) => u.team_id === t.id).map((u) => ({ n: u.clue_n, at: u.at, by: u.by })),
  }));
  const unassigned = await q<{ id: number; email: string; name: string | null }>(`SELECT p.id, p.email, p.name FROM players p WHERE ${FREE} ORDER BY p.email LIMIT 300`);
  const [{ n: unassignedCount }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM players p WHERE ${FREE}`);
  const clues = await q<{ n: number; title: string; code: string; teams: number }>(
    `SELECT c.n, c.title, c.code, (SELECT count(*)::int FROM unlocks u WHERE u.clue_n = c.n) AS teams FROM clues c ORDER BY c.n`,
  );
  const submissions = await q(
    `SELECT s.id, s.team_id AS "teamId", t.name AS team, s.answers, (s.player_id IS NULL AND s.answers = '{}'::jsonb) AS "inPerson", s.submitted_at AS "submittedAt", s.verdict, s.claims, s.note,
            s.opened, s.opened_list AS "openedList", s.judged_by AS "judgedBy", coalesce(p.name, split_part(p.email, '@', 1)) AS by
       FROM submissions s JOIN teams t ON t.id = s.team_id LEFT JOIN players p ON p.id = s.player_id
      ORDER BY s.submitted_at, s.id`,
  );
  const [key] = await q<{ body: string }>(`SELECT body FROM mystery_docs WHERE key = 'key'`);
  const [{ now }] = await q<{ now: string }>(`SELECT now() AS now`);
  return json(req, {
    ok: true, mystery: m, roster, teams, unassigned, unassignedCount, clues, submissions,
    key: parseKey(key?.body ?? ""), standings: await standings(), serverNow: new Date(now).getTime(),
  });
}

type Body = {
  action?: string; confirm?: string;
  stage?: Stage; open?: boolean; maxTeamSize?: number; unlockMode?: string; openBy?: string; answersOnline?: boolean; maxTeams?: number;
  emails?: string; email?: string; teamId?: number; playerId?: number; name?: string; lead?: string; n?: number; count?: number;
  text?: string; size?: number; teams?: number;
  id?: number; verdict?: "correct" | "wrong" | null; claims?: number[]; note?: string;
};

/** Logged-in players who may play Round 2 and aren't in a team (SQL condition on players p). */
const FREE = `NOT p.disqualified AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.player_id = p.id)
  AND (NOT EXISTS (SELECT 1 FROM roster) OR EXISTS (SELECT 1 FROM roster r WHERE r.email = p.email))`;

/** Find a logged-in player by BITS ID or email. */
async function playerByLogin(raw: string, qq = q) {
  const email = normaliseEmail(raw, emailPattern());
  if (!email) throw new Refuse(`"${raw}" isn't a BITS ID or email`);
  const [p] = await qq<{ id: number; email: string }>(`SELECT id, email FROM players WHERE email = $1`, [email]);
  if (!p) throw new Refuse(`${email.split("@")[0]} hasn't logged in yet. Ask them to log in once first.`);
  return p;
}

async function createTeam(qq: typeof q, name: string, leadId: number | null) {
  if (name.length < 2 || name.length > 30) throw new Refuse(`Team name "${name}": 2 to 30 characters`);
  if ((await qq(`SELECT 1 FROM teams WHERE lower(name) = lower($1)`, [name])).length) throw new Refuse(`Team name "${name}" is taken`);
  for (let i = 0; i < 8; i++) {
    const [t] = await qq<{ id: number }>(`INSERT INTO teams (name, captain_id, join_code) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`, [name, leadId, newJoinCode()]);
    if (t) return t.id;
  }
  throw new Refuse(`Couldn't create "${name}"`);
}

/** Put a player into a team (moving them out of any other). Fixes the lead of the team they left. */
async function placePlayer(qq: typeof q, playerId: number, teamId: number) {
  const [old] = await qq<{ team_id: number }>(`SELECT team_id FROM team_members WHERE player_id = $1`, [playerId]);
  await qq(`INSERT INTO team_members (player_id, team_id) VALUES ($1, $2) ON CONFLICT (player_id) DO UPDATE SET team_id = excluded.team_id, joined_at = now()`, [playerId, teamId]);
  await qq(`UPDATE teams SET captain_id = $2 WHERE id = $1 AND captain_id IS NULL`, [teamId, playerId]);
  if (old && old.team_id !== teamId) await fixLead(qq, old.team_id);
}

/** A team whose lead left gets its earliest member as lead; an empty team keeps no lead. */
async function fixLead(qq: typeof q, teamId: number) {
  await qq(
    `UPDATE teams t SET captain_id = (SELECT player_id FROM team_members m WHERE m.team_id = t.id ORDER BY joined_at, player_id LIMIT 1)
      WHERE t.id = $1 AND (captain_id IS NULL OR NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.player_id = t.captain_id))`,
    [teamId],
  );
}

export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return json(req, { ok: false, error: bad }, 400);
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const b = (await req.json().catch(() => ({}))) as Body;
  const fail = (error: string, status = 400) => json(req, { ok: false, error }, status);
  let extra: Record<string, unknown> = {};

  try {
    switch (b.action) {
      case "stage": {
        if (!["closed", "teams", "play", "ended"].includes(String(b.stage))) return fail("bad stage");
        if (b.stage === "ended" && b.confirm !== "END") return fail("Type END to confirm");
        await q(`UPDATE mystery SET stage = $1, submissions_open = CASE WHEN $1 = 'play' THEN submissions_open ELSE false END WHERE id = 1`, [b.stage]);
        break;
      }
      case "submissions":
        await q(`UPDATE mystery SET submissions_open = $1 WHERE id = 1 AND ($1 = false OR stage = 'play')`, [!!b.open]);
        break;
      case "results":
        await q(`UPDATE mystery SET results_public = $1 WHERE id = 1`, [!!b.open]);
        break;
      case "settings": {
        // Any field left out keeps its current value.
        const cur = await loadMystery();
        const size = b.maxTeamSize === undefined ? cur.max_team_size : Math.trunc(Number(b.maxTeamSize));
        if (!(size >= 1 && size <= 30)) return fail("Team size 1–30");
        const unlockMode = b.unlockMode ?? cur.unlock_mode, openBy = b.openBy ?? cur.open_by;
        if (!["tap", "code"].includes(String(unlockMode)) || !["lead", "anyone"].includes(String(openBy))) return fail("bad setting");
        if (b.answersOnline !== undefined && typeof b.answersOnline !== "boolean") return fail("bad setting");
        const answersOnline = b.answersOnline ?? cur.answers_online;
        const maxTeams = b.maxTeams === undefined ? cur.max_teams : Number(b.maxTeams);
        if (!(Number.isInteger(maxTeams) && maxTeams >= 0 && maxTeams <= 500)) return fail("Max teams 0–500 (0 = no limit)");
        await q(`UPDATE mystery SET max_team_size = $1, unlock_mode = $2, open_by = $3, answers_online = $4, max_teams = $5 WHERE id = 1`, [size, unlockMode, openBy, answersOnline, maxTeams]);
        break;
      }

      // ---- who may play round 2 ----
      case "rosterTop": {
        // Replace the roster with the top N of the guesstimate (eligible players only) and record N as the cut-off.
        const n = Math.trunc(Number(b.count));
        if (!(n >= 1 && n <= 5000)) return fail("Pick how many qualify (1 or more)");
        if (b.confirm !== String(n)) return fail(`Type ${n} to confirm`);
        const L = await load();
        const snap = await ensureSnapshot(L);
        if (!snap.done) return fail("The ranking is still being computed. Try again in a few seconds.", 409);
        const added = await tx(async (qq) => {
          await qq(`DELETE FROM roster`);
          const r = await qq<{ email: string }>(
            `INSERT INTO roster (email) SELECT p.email FROM rank_rows rr JOIN players p ON p.id = rr.player_id
              WHERE rr.key = $1 AND rr.eligible_rank IS NOT NULL AND rr.eligible_rank <= $2 ON CONFLICT DO NOTHING RETURNING email`,
            [snap.key, n],
          );
          // a new cut is private again until the organisers press Announce
          await qq(`UPDATE game SET qualify_count = $1, qualify_announced = false, version = version + 1 WHERE id = 1`, [n]);
          return r.length;
        });
        extra = { added };
        break;
      }
      case "rosterAdd": {
        const emails = String(b.emails ?? "").split(/[\s,;]+/).filter(Boolean).map((e) => normaliseEmail(e, emailPattern())).filter((e): e is string => !!e);
        if (!emails.length) return fail("No valid BITS IDs or emails found");
        for (const e of emails) await q(`INSERT INTO roster (email) VALUES ($1) ON CONFLICT DO NOTHING`, [e]);
        extra = { added: emails.length };
        break;
      }
      case "rosterRemove":
        await q(`DELETE FROM roster WHERE email = $1`, [String(b.email ?? "").toLowerCase()]);
        break;
      case "rosterClear":
        if (b.confirm !== "CLEAR") return fail("Type CLEAR to confirm");
        await q(`DELETE FROM roster`);
        break;

      // ---- teams ----
      case "teamCreate": {
        const name = cleanName(b.name);
        await tx(async (qq) => {
          const lead = b.lead?.trim() ? await playerByLogin(b.lead, qq) : null;
          const id = await createTeam(qq, name, lead?.id ?? null);
          if (lead) await placePlayer(qq, lead.id, id);
          if (lead) await qq(`UPDATE teams SET captain_id = $2 WHERE id = $1`, [id, lead.id]);
        });
        break;
      }
      case "teamsPaste": {
        // One team per line:  Team name: f20260001, f20260002, ...   (the first ID is the lead)
        const lines = String(b.text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
        if (!lines.length) return fail("Paste one team per line: Team name: ID, ID, ID (first is the lead)");
        const made = await tx(async (qq) => {
          let count = 0;
          for (const line of lines) {
            const m = line.match(/^([^:]+):(.*)$/);
            if (!m) throw new Refuse(`Line "${line.slice(0, 40)}" needs a colon after the team name`);
            const ids = m[2].split(/[\s,;]+/).filter(Boolean);
            if (!ids.length) throw new Refuse(`"${m[1].trim()}" has no members`);
            const people = [];
            for (const id of ids) people.push(await playerByLogin(id, qq));
            const name = cleanName(m[1]);
            const [existing] = await qq<{ id: number }>(`SELECT id FROM teams WHERE lower(name) = lower($1)`, [name]);
            const teamId = existing?.id ?? (await createTeam(qq, name, null));
            for (const p of people) await placePlayer(qq, p.id, teamId);
            await qq(`UPDATE teams SET captain_id = $2 WHERE id = $1`, [teamId, people[0].id]);
            count++;
          }
          return count;
        });
        extra = { added: made };
        break;
      }
      case "teamsAuto": {
        // Everyone on the roster who has logged in and isn't in a team, shuffled into random teams.
        // {teams: N}: exactly N teams, sizes differ by at most 1. {size}: teams of about that size.
        const byCount = b.teams !== undefined;
        const want = Math.trunc(Number(byCount ? b.teams : b.size));
        if (byCount ? !(want >= 1) : !(want >= 2 && want <= 30)) return fail(byCount ? "Number of teams: 1 or more" : "Team size 2–30");
        const made = await tx(async (qq) => {
          // Lock the free players so a player can't be placed twice by two clicks at once.
          const free = await qq<{ id: number }>(`SELECT p.id FROM players p WHERE ${FREE} ORDER BY p.id FOR UPDATE OF p`);
          if (!free.length) throw new Refuse("Nobody is waiting for a team");
          const [{ max_team_size: cap }] = await qq<{ max_team_size: number }>(`SELECT max_team_size FROM mystery WHERE id = 1`);
          const k = byCount ? want : Math.max(1, Math.ceil(free.length / Math.min(want, cap)));
          if (Math.ceil(free.length / k) > cap) throw new Refuse(`${free.length} people in ${k} teams makes teams of ${Math.ceil(free.length / k)}, over the max team size of ${cap}. Use at least ${Math.ceil(free.length / cap)} teams, or raise the max size in Settings.`);
          if (k > free.length) throw new Refuse(`Only ${free.length} ${free.length === 1 ? "person is" : "people are"} without a team: that's at most ${free.length} team${free.length === 1 ? "" : "s"}`);
          for (let i = free.length - 1; i > 0; i--) { const j = randomInt(i + 1); [free[i], free[j]] = [free[j], free[i]]; }
          const taken = new Set((await qq<{ name: string }>(`SELECT lower(name) AS name FROM teams`)).map((r) => r.name));
          let num = 0, count = 0;
          for (let i = 0; i < k; i++) {
            const group = free.filter((_, j) => j % k === i);
            do num++; while (taken.has(`team ${num}`));
            const id = await createTeam(qq, `Team ${num}`, null);
            // A player who joined a team themselves a moment ago stays there. clock_timestamp keeps the shuffled order
            // (lead first) in member lists; now() is the same for the whole transaction.
            const placed: number[] = [];
            for (const p of group) {
              const r = await qq<{ player_id: number }>(`INSERT INTO team_members (player_id, team_id, joined_at) VALUES ($1, $2, clock_timestamp()) ON CONFLICT DO NOTHING RETURNING player_id`, [p.id, id]);
              if (r.length) placed.push(p.id);
            }
            if (!placed.length) { await qq(`DELETE FROM teams WHERE id = $1`, [id]); num--; continue; }
            await qq(`UPDATE teams SET captain_id = $2 WHERE id = $1`, [id, placed[0]]);
            count++;
          }
          if (!count) throw new Refuse("Nobody is waiting for a team");
          return { count, people: free.length };
        });
        extra = { added: made.count, people: made.people };
        break;
      }
      case "teamAddMember": {
        await tx(async (qq) => {
          const p = await playerByLogin(String(b.email ?? ""), qq);
          if (!(await qq(`SELECT 1 FROM teams WHERE id = $1`, [Number(b.teamId)])).length) throw new Refuse("No such team");
          await placePlayer(qq, p.id, Number(b.teamId));
        });
        break;
      }
      case "teamRemoveMember":
        await tx(async (qq) => {
          const [m] = await qq<{ team_id: number }>(`DELETE FROM team_members WHERE player_id = $1 RETURNING team_id`, [Number(b.playerId)]);
          if (m) await fixLead(qq, m.team_id);
        });
        break;
      case "teamLead": {
        const r = await q(`UPDATE teams SET captain_id = $2 WHERE id = $1 AND EXISTS (SELECT 1 FROM team_members WHERE team_id = $1 AND player_id = $2) RETURNING id`, [Number(b.teamId), Number(b.playerId)]);
        if (!r.length) return fail("That person isn't in this team");
        break;
      }
      case "teamRename": {
        const name = cleanName(b.name);
        if (name.length < 2 || name.length > 30) return fail("Team name: 2 to 30 characters");
        const r = await q(`UPDATE teams SET name = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM teams WHERE lower(name) = lower($2) AND id <> $1) RETURNING id`, [Number(b.teamId), name]);
        if (!r.length) return fail("Name taken");
        break;
      }
      case "teamDelete":
        if (b.confirm !== "DELETE") return fail("Type DELETE to confirm");
        await q(`DELETE FROM teams WHERE id = $1`, [Number(b.teamId)]);
        break;

      // ---- exhibits ----
      case "unlockGrant": {
        // Counts toward the team's total, like any open. For a team that lost a code slip, or a phone that died mid-open.
        const r = await q(
          `INSERT INTO unlocks (team_id, clue_n) SELECT $1, n FROM clues WHERE n = $2 AND NOT EXISTS (SELECT 1 FROM submissions WHERE team_id = $1)
           ON CONFLICT DO NOTHING RETURNING clue_n`,
          [Number(b.teamId), Number(b.n)],
        );
        if (!r.length) return fail("Already open, no such exhibit, or the team has submitted");
        break;
      }
      case "unlockRevoke":
        await q(`DELETE FROM unlocks WHERE team_id = $1 AND clue_n = $2 AND NOT EXISTS (SELECT 1 FROM submissions WHERE team_id = $1)`, [Number(b.teamId), Number(b.n)]);
        break;

      // ---- judging ----
      case "judge": {
        const v = b.verdict === "correct" || b.verdict === "wrong" ? b.verdict : null;
        const claims = Array.isArray(b.claims) ? [...new Set(b.claims.map(Number).filter((x) => Number.isInteger(x) && x > 0 && x < 100))] : [];
        const r = await q(
          `UPDATE submissions SET verdict = $2, claims = $3::jsonb, note = $4, judged_by = $5, judged_at = now() WHERE id = $1 RETURNING id`,
          [Number(b.id), v, JSON.stringify(claims), String(b.note ?? "").slice(0, 500) || null, v ? admin : null],
        );
        if (!r.length) return fail("No such submission");
        break;
      }
      case "answerGiven": {
        // A team told the organisers its answer in person. Records that moment (it breaks ties) and what the team had
        // opened; the team can't open more. Team row locked like an open, so the count is exact. Undo: deleteSubmission.
        const teamId = Number(b.teamId);
        const r = await tx(async (qq) => {
          const st = await loadMystery();
          if (st.stage !== "play" && st.stage !== "ended") throw new Refuse("Answers are recorded once the game is on", 409);
          const [tm] = await qq<{ id: number; name: string }>(`SELECT id, name FROM teams WHERE id = $1 FOR UPDATE`, [teamId]);
          if (!tm) throw new Refuse("No such team", 404);
          const list = (await qq<{ n: number }>(`SELECT clue_n AS n FROM unlocks WHERE team_id = $1 ORDER BY clue_n`, [tm.id])).map((x) => x.n);
          const [s] = await qq<{ id: number; submitted_at: string }>(
            `INSERT INTO submissions (team_id, player_id, answers, opened, opened_list) VALUES ($1, NULL, '{}'::jsonb, $2, $3::jsonb)
             ON CONFLICT (team_id) DO NOTHING RETURNING id, submitted_at`,
            [tm.id, list.length, JSON.stringify(list)],
          );
          if (!s) throw new Refuse(`${tm.name} has already answered`, 409);
          return { id: s.id, submittedAt: s.submitted_at, opened: list.length };
        });
        extra = { ...r, added: r.opened };
        break;
      }
      case "deleteSubmission":
        if (b.confirm !== "DELETE") return fail("Type DELETE to confirm");
        await q(`DELETE FROM submissions WHERE id = $1`, [Number(b.id)]);
        break;
      case "reset":
        if (b.confirm !== "RESET MYSTERY") return fail("Type RESET MYSTERY to confirm");
        await tx(async (qq) => {
          for (const t of ["submissions", "unlocks", "code_attempts", "join_attempts", "team_invites", "team_members", "teams"]) await qq(`DELETE FROM ${t}`);
          await qq(`UPDATE mystery SET stage = 'closed', submissions_open = false, results_public = false WHERE id = 1`);
        });
        break;
      default:
        return fail("unknown action");
    }
  } catch (e) {
    if (e instanceof Refuse) return fail(e.message, e.status);
    throw e;
  }
  await q(`UPDATE mystery SET version = version + 1 WHERE id = 1`);
  await log(admin, `mystery.${b.action}`, { ...b, confirm: undefined, emails: undefined, text: undefined });
  markStateChanged(); // the stage rides along on /api/state
  return json(req, { ok: true, ...extra });
}
