import { q } from "@/lib/db";
import { json, preflight } from "@/lib/http";
import { loadMystery, standings } from "@/lib/mystery";

export const dynamic = "force-dynamic";

// For the big screen: stage and team count. No answers, no counts, no exhibit text,
// and no standings until the organisers publish the results.
export async function GET(req: Request) {
  const m = await loadMystery();
  const [c] = await q<{ teams: number }>(`SELECT count(*)::int AS teams FROM teams`);
  let results = null;
  if (m.results_public) {
    const st = await standings();
    results = st.rows.map((r) => ({ rank: r.rank, name: r.name, opened: r.opened, at: r.submittedAt, correct: r.verdict === "correct" }));
  }
  return json(req, { ok: true, stage: m.stage, submissionsOpen: m.submissions_open, answersOnline: m.answers_online, teams: c.teams, results });
}

export const OPTIONS = preflight;
