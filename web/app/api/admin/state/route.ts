import { q } from "@/lib/db";
import { load, stateOf, labelFor } from "@/lib/game";
import { revealedUpTo } from "@/lib/schedule";
import { json } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// Uncached full view for the admin panel.
export async function GET(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const L = await load();
  const s = stateOf(L);
  const [counts] = await q<{ players: number; sessions: number; multi: number }>(
    `SELECT (SELECT count(*)::int FROM players) AS players,
            (SELECT count(*)::int FROM sessions) AS sessions,
            (SELECT count(*)::int FROM (SELECT player_id FROM sessions GROUP BY player_id HAVING count(*) > 1) t) AS multi`,
  );
  const answered = s.index !== null
    ? (await q<{ n: number }>(`SELECT count(*)::int AS n FROM answers WHERE idx = $1`, [s.index]))[0].n
    : 0;
  const recent = await q(`SELECT at, admin, action, detail FROM admin_log ORDER BY id DESC LIMIT 15`);
  return json(req, {
    ok: true,
    admin,
    state: s,
    label: s.index !== null ? labelFor(L.questions, s.index) : null,
    version: L.version,
    game: L.game,
    revealedUpTo: revealedUpTo(L.game, L.items, L.now),
    qualifyCount: L.qualifyCount,
    lobbyNote: L.lobbyNote,
    qualifyAnnounced: L.qualifyAnnounced,
    scoring: L.scoring,
    questions: L.questions.map((x) => ({ ...x, label: labelFor(L.questions, x.idx) })),
    counts: { ...counts, answered },
    recent,
    serverNow: L.now,
  });
}
