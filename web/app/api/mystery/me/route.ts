import { q } from "@/lib/db";
import { json, preflight, playerFrom, displayName } from "@/lib/http";
import { loadMystery, onRoster, teamOf, teamView, standings } from "@/lib/mystery";

export const dynamic = "force-dynamic";

// Everything one player's screen needs, in one call. Never includes exhibit text or exhibit codes.
export async function GET(req: Request) {
  const player = await playerFrom(req);
  if (!player) return json(req, { ok: false, error: "login" }, 401);
  const m = await loadMystery();
  const [{ now }] = await q<{ now: string }>(`SELECT now() AS now`);
  const base = { ok: true, stage: m.stage, answersOnline: m.answers_online, name: displayName(player), email: player.email, serverNow: new Date(now).getTime() };
  if (m.stage === "closed") return json(req, base);
  if (player.disqualified || !(await onRoster(player.email))) return json(req, { ...base, allowed: false });

  const teamId = await teamOf(player.id);
  const team = teamId ? await teamView(teamId) : null;
  // While teams form with a team limit, players see how many slots are left (so nobody tries to create a 9th of 8).
  const teamsMade = m.stage === "teams" && m.max_teams > 0 ? (await q<{ n: number }>(`SELECT count(*)::int AS n FROM teams`))[0].n : null;
  const catalogue = await q<{ n: number; title: string; description: string }>(`SELECT n, title, description FROM clues ORDER BY n`);

  let opened: { n: number; at: string; by: string | null }[] = [];
  let submission: { answers: Record<string, string>; submittedAt: string; by: string | null; opened: number | null } | null = null;
  if (teamId) {
    opened = await q(
      `SELECT u.clue_n AS n, u.at, coalesce(p.name, split_part(p.email, '@', 1)) AS by
         FROM unlocks u LEFT JOIN players p ON p.id = u.player_id WHERE u.team_id = $1 ORDER BY u.at, u.clue_n`,
      [teamId],
    );
    const [s] = await q<{ answers: Record<string, string>; submitted_at: string; by: string | null; opened: number | null }>(
      `SELECT s.answers, s.submitted_at, s.opened, coalesce(p.name, split_part(p.email, '@', 1)) AS by
         FROM submissions s LEFT JOIN players p ON p.id = s.player_id WHERE s.team_id = $1`,
      [teamId],
    );
    if (s) submission = { answers: s.answers, submittedAt: s.submitted_at, by: s.by, opened: s.opened };
  }

  let results: { rank: number; name: string; opened: number; at: string; correct: boolean; mine: boolean }[] | null = null;
  if (m.results_public) {
    const st = await standings();
    results = st.rows.map((r) => ({ rank: r.rank, name: r.name, opened: r.opened, at: r.submittedAt, correct: r.verdict === "correct", mine: r.teamId === teamId }));
  }

  return json(req, {
    ...base,
    allowed: true,
    playerId: player.id,
    maxTeamSize: m.max_team_size,
    maxTeams: m.max_teams,
    teamsMade,
    unlockMode: m.unlock_mode,
    openBy: m.open_by,
    submissionsOpen: m.submissions_open && m.stage === "play",
    team,
    catalogue,
    opened,
    submission,
    results,
  });
}

export const OPTIONS = preflight;
