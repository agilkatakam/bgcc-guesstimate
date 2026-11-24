import { q } from "@/lib/db";
import { load, labelFor, revealedThrough, stateOf } from "@/lib/game";
import { ensureSnapshot } from "@/lib/ranking";
import { json } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// The full guesstimate ranking, for choosing the qualifying cut-off on the spot.
export async function GET(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const L = await load();
  const snap = await ensureSnapshot(L);
  const rows = snap.done
    ? await q<{ rank: number; eligible_rank: number | null; name: string; email: string; total: number; blanks: number; eligible: boolean; on_roster: boolean }>(
        `SELECT r.rank, r.eligible_rank, r.name, p.email, r.total, r.blanks, r.eligible,
                EXISTS (SELECT 1 FROM roster x WHERE x.email = p.email) AS on_roster
           FROM rank_rows r JOIN players p ON p.id = r.player_id WHERE r.key = $1 ORDER BY r.rank`,
        [snap.key],
      )
    : [];
  const through = revealedThrough(L);
  const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM roster`);
  return json(req, {
    ok: true,
    ready: snap.done,
    through: through >= 0 ? labelFor(L.questions, through) : null,
    finished: L.game.mode === "finished" || stateOf(L).phase === "results",
    qualifyCount: L.qualifyCount,
    qualifyAnnounced: L.qualifyAnnounced,
    rosterCount: n,
    version: L.version,
    rows,
  });
}
