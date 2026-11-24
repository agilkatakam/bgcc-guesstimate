import { tx } from "@/lib/db";
import { checkPost, json, preflight, playerFrom } from "@/lib/http";
import { gate, Refuse, ANSWER_KEYS, MAX_ANSWER, IN_PERSON } from "@/lib/mystery";

export const dynamic = "force-dynamic";

// The team lead submits the team's one answer (only when answers are online). Records what the team had opened at that moment.
export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return json(req, { ok: false, error: bad }, 400);
  const g = await gate(await playerFrom(req));
  if (!g.ok) return json(req, { ok: false, error: g.error }, g.status);
  if (!g.m.answers_online) return json(req, { ok: false, error: IN_PERSON }, 409);
  if (g.m.stage !== "play" || !g.m.submissions_open) return json(req, { ok: false, error: "Submissions aren't open right now." }, 409);
  const b = (await req.json().catch(() => ({}))) as { answers?: Record<string, unknown> };
  const answers: Record<string, string> = {};
  for (const k of ANSWER_KEYS) {
    const v = String(b.answers?.[k] ?? "").trim();
    if (!v) return json(req, { ok: false, error: "Answer all three questions." }, 400);
    if (v.length > MAX_ANSWER) return json(req, { ok: false, error: `Keep each answer under ${MAX_ANSWER} characters.` }, 400);
    answers[k] = v;
  }
  try {
    const r = await tx(async (qq) => {
      const [t] = await qq<{ id: number; captain_id: number | null }>(
        `SELECT t.id, t.captain_id FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.player_id = $1 FOR UPDATE OF t`,
        [g.player.id],
      );
      if (!t) throw new Refuse("Join a team first.", 409);
      if (t.captain_id !== g.player.id) throw new Refuse("Only your team lead can submit.", 403);
      const list = (await qq<{ n: number }>(`SELECT clue_n AS n FROM unlocks WHERE team_id = $1 ORDER BY clue_n`, [t.id])).map((x) => x.n);
      const [s] = await qq<{ id: number; submitted_at: string }>(
        `INSERT INTO submissions (team_id, player_id, answers, opened, opened_list) VALUES ($1, $2, $3::jsonb, $4, $5::jsonb)
         ON CONFLICT (team_id) DO NOTHING RETURNING id, submitted_at`,
        [t.id, g.player.id, JSON.stringify(answers), list.length, JSON.stringify(list)],
      );
      if (!s) throw new Refuse("Your team has already submitted.", 409);
      await qq(`UPDATE teams SET draft = $2::jsonb, draft_at = now(), draft_by = $3 WHERE id = $1`, [t.id, JSON.stringify(answers), g.player.id]);
      return { ...s, opened: list.length };
    });
    return json(req, { ok: true, id: r.id, submittedAt: r.submitted_at, opened: r.opened });
  } catch (e) {
    if (e instanceof Refuse) return json(req, { ok: false, error: e.message }, e.status);
    throw e;
  }
}

export const OPTIONS = preflight;
