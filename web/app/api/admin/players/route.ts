import { q } from "@/lib/db";
import { checkPost, json, hashSecret } from "@/lib/http";
import { cleanName } from "@/lib/parse";
import { requireAdmin, log } from "@/lib/admin";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const term = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const rows = await q(
    `SELECT p.id, p.email, p.name, p.disqualified, p.created_at,
            (SELECT count(*)::int FROM sessions s WHERE s.player_id = p.id) AS sessions,
            (SELECT count(*)::int FROM answers a WHERE a.player_id = p.id) AS answers
       FROM players p WHERE p.email LIKE $1 OR lower(coalesce(p.name, '')) LIKE $1
      ORDER BY p.email LIMIT 30`,
    [`%${term}%`],
  );
  return json(req, { ok: true, rows });
}

// Actions: resetPin (admin sets a new PIN after checking the ID card), rename, disqualify, reinstate, logout.
export async function POST(req: Request) {
  const bad = checkPost(req);
  if (bad) return json(req, { ok: false, error: bad }, 400);
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const b = (await req.json().catch(() => ({}))) as { id?: number; action?: string; pin?: string; name?: string };
  const id = Number(b.id);
  switch (b.action) {
    case "resetPin":
      if (!/^\d{4}$/.test(String(b.pin))) return json(req, { ok: false, error: "PIN must be 4 digits" }, 400);
      await q(`UPDATE players SET pin_hash = $2, failed_pins = 0, locked_until = NULL WHERE id = $1`, [id, await hashSecret(String(b.pin))]);
      await q(`DELETE FROM sessions WHERE player_id = $1`, [id]);
      break;
    case "disqualify":
    case "reinstate":
      await q(`UPDATE players SET disqualified = $2 WHERE id = $1`, [id, b.action === "disqualify"]);
      await q(`UPDATE game SET ranges_version = ranges_version + 1 WHERE id = 1`); // force a fresh ranking
      break;
    case "rename": {
      const name = cleanName(String(b.name ?? "").slice(0, 200));
      if (!name) return json(req, { ok: false, error: "Name: 2 to 40 letters (spaces, . ' - are fine)" }, 400);
      await q(`UPDATE players SET name = $2 WHERE id = $1`, [id, name]);
      await q(`UPDATE game SET ranges_version = ranges_version + 1 WHERE id = 1`); // leaderboard shows the new name
      break;
    }
    case "logout":
      await q(`DELETE FROM sessions WHERE player_id = $1`, [id]);
      break;
    default:
      return json(req, { ok: false, error: "unknown action" }, 400);
  }
  await log(admin, `player-${b.action}`, { id });
  return json(req, { ok: true });
}
