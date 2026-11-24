import { q } from "@/lib/db";
import { json, preflight, playerFrom } from "@/lib/http";
import { gate, teamOf } from "@/lib/mystery";

export const dynamic = "force-dynamic";

// Full exhibit text, only for a team that has unlocked it.
export async function GET(req: Request) {
  const g = await gate(await playerFrom(req));
  if (!g.ok) return json(req, { ok: false, error: g.error }, g.status);
  if (g.m.stage !== "play" && g.m.stage !== "ended") return json(req, { ok: false, error: "Not open yet." }, 409);
  const teamId = await teamOf(g.player.id);
  const n = Number(new URL(req.url).searchParams.get("n"));
  if (!teamId || !Number.isInteger(n)) return json(req, { ok: false, error: "not found" }, 404);
  const [c] = await q<{ n: number; title: string; description: string; body: string }>(
    `SELECT c.n, c.title, c.description, c.body FROM clues c JOIN unlocks u ON u.clue_n = c.n AND u.team_id = $1 WHERE c.n = $2`,
    [teamId, n],
  );
  if (!c) return json(req, { ok: false, error: "Your team hasn't opened this exhibit." }, 403);
  return json(req, { ok: true, clue: c });
}

export const OPTIONS = preflight;
