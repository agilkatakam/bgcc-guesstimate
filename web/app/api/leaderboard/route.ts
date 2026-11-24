import { q } from "@/lib/db";
import { loadShared, labelFor, revealedThrough, publicQualify, ranksPublic } from "@/lib/game";
import { ensureSnapshot } from "@/lib/ranking";
import { corsHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const L = await loadShared();
  // Hidden until the last question is over (suspense): nothing about ranks leaks during the game.
  const open = ranksPublic(L);
  const snap = open ? await ensureSnapshot(L) : { key: "", done: false };
  const top = snap.done
    ? await q<{ pid: number; rank: number; name: string; total: number; blanks: number; eligible: boolean; eligible_rank: number | null }>(
        `SELECT player_id AS pid, rank, name, total, blanks, eligible, eligible_rank FROM rank_rows WHERE key = $1 ORDER BY rank LIMIT 20`,
        [snap.key],
      )
    : [];
  const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM players`);
  const through = revealedThrough(L);
  const body = {
    ready: snap.done,
    through: through >= 0 ? labelFor(L.questions, through) : null,
    players: n,
    qualifyCount: publicQualify(L),
    top,
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": snap.done ? "public, s-maxage=5, stale-while-revalidate=5" : "no-store", ...corsHeaders(req) },
  });
}
