import { tx } from "@/lib/db";
import { checkPost, json, preflight, playerFrom } from "@/lib/http";
import { gate, teamOf, normaliseCode, Refuse } from "@/lib/mystery";
import { openExhibit } from "@/lib/opening";

export const dynamic = "force-dynamic";

// Wrong codes per PLAYER per minute. Codes are 8 characters from 31 symbols, so guessing is hopeless anyway;
// the limit just stops scripts, and being per player means one person can't lock out their whole team.
const WRONG_LIMIT = 20;

// Open an exhibit with a code an organiser gave the team (unlock_mode 'code', or a lost-slip fallback).
export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return json(req, { ok: false, error: bad }, 400);
  const g = await gate(await playerFrom(req));
  if (!g.ok) return json(req, { ok: false, error: g.error }, g.status);
  if (g.m.stage !== "play") return json(req, { ok: false, error: g.m.stage === "ended" ? "The game is over." : "Exhibits open when the game starts." }, 409);
  const teamId = await teamOf(g.player.id);
  if (!teamId) return json(req, { ok: false, error: "Join a team first." }, 409);
  const b = (await req.json().catch(() => ({}))) as { code?: string };
  const code = normaliseCode(String(b.code ?? ""));
  if (code.length < 4 || code.length > 20) return json(req, { ok: false, error: "Type the code exactly as given." }, 400);

  // Check the limit and record the attempt in one transaction with the player's row locked,
  // so firing many codes at once can't slip past the limit.
  const clue = await tx(async (qq) => {
    await qq(`SELECT id FROM players WHERE id = $1 FOR UPDATE`, [g.player.id]);
    const [{ n: wrong }] = await qq<{ n: number }>(
      `SELECT count(*)::int AS n FROM code_attempts WHERE player_id = $1 AND NOT ok AND at > now() - interval '60 seconds'`,
      [g.player.id],
    );
    if (wrong >= WRONG_LIMIT) return "limit" as const;
    const [c] = await qq<{ n: number }>(`SELECT n FROM clues WHERE code = $1`, [code]);
    await qq(`INSERT INTO code_attempts (team_id, player_id, ok) VALUES ($1, $2, $3)`, [teamId, g.player.id, !!c]);
    return c ?? null;
  });
  if (clue === "limit") return json(req, { ok: false, error: "Too many wrong codes. Wait a minute and try again." }, 429);
  if (!clue) return json(req, { ok: false, error: "No exhibit has that code. Check it and try again." }, 400);
  try {
    const r = await openExhibit(g.m, g.player, clue.n, true);
    return json(req, { ok: true, n: r.n, title: r.title, already: r.already, count: r.count });
  } catch (e) {
    if (e instanceof Refuse) return json(req, { ok: false, error: e.message }, e.status);
    throw e;
  }
}

export const OPTIONS = preflight;
