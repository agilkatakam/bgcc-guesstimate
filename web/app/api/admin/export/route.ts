import { q } from "@/lib/db";
import { load, pointsFor } from "@/lib/game";
import { ensureSnapshot, scoredRevealed } from "@/lib/ranking";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// CSV: one row per player, in rank order, with every revealed scored answer.
export async function GET(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;
  const L = await load();
  const snap = await ensureSnapshot(L);
  const items = scoredRevealed(L);
  const ranks = await q<{ player_id: number; rank: number; eligible_rank: number | null; total: number; blanks: number; eligible: boolean }>(
    `SELECT player_id, rank, eligible_rank, total, blanks, eligible FROM rank_rows WHERE key = $1 ORDER BY rank`, [snap.key]);
  const players = new Map((await q<{ id: number; email: string; name: string | null; disqualified: boolean }>(
    `SELECT id, email, name, disqualified FROM players`)).map((p) => [p.id, p]));
  const answers = await q<{ player_id: number; idx: number; value: number }>(`SELECT player_id, idx, value FROM answers`);
  const av = new Map(answers.map((a) => [`${a.player_id}:${a.idx}`, Number(a.value)]));
  const head = ["rank", "eligible_rank", "qualifies", "email", "name", "total", "blanks", "eligible", "disqualified",
    ...items.flatMap((x) => [`item${x.idx}_answer`, `item${x.idx}_points`])];
  const lines = [head.join(",")];
  for (const r of ranks) {
    const p = players.get(r.player_id)!;
    const per = items.flatMap((x) => {
      const v = av.get(`${r.player_id}:${x.idx}`) ?? null;
      return [v ?? "", pointsFor(x, v, L.scoring)];
    });
    lines.push([r.rank, r.eligible_rank ?? "", L.qualifyCount === 0 ? "undecided" : r.eligible_rank !== null && r.eligible_rank <= L.qualifyCount ? "yes" : "no",
      p.email, p.name ?? "", r.total, r.blanks, r.eligible, p.disqualified, ...per].map(cell).join(","));
  }
  const stamp = new Date(L.now + 5.5 * 3600e3).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/csv", "cache-control": "no-store", "content-disposition": `attachment; filename="results-IST-${stamp}.csv"` },
  });
}
