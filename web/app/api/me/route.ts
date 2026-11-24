import { q } from "@/lib/db";
import { loadShared, labelFor, revealedThrough, pointsFor, publicQualify, ranksPublic } from "@/lib/game";
import { ensureSnapshot } from "@/lib/ranking";
import { json, preflight, playerFrom, displayName } from "@/lib/http";

export const dynamic = "force-dynamic";

// The player's own answers. Penalties only for items whose range is public.
export async function GET(req: Request) {
  const player = await playerFrom(req);
  if (!player) return json(req, { ok: false, error: "login" }, 401);
  const L = await loadShared();
  const through = revealedThrough(L);
  const rows = await q<{ idx: number; value: number; seq: string }>(
    `SELECT idx, value, seq FROM answers WHERE player_id = $1 ORDER BY idx`,
    [player.id],
  );
  const mine = new Map(rows.map((r) => [r.idx, r]));
  const items = L.questions
    .filter((x) => x.kind === "q")
    .map((x) => {
      const a = mine.get(x.idx);
      const revealed = x.idx <= through;
      return {
        idx: x.idx,
        label: labelFor(L.questions, x.idx),
        practice: x.practice,
        value: a ? Number(a.value) : null,
        seq: a ? Number(a.seq) : 0,
        revealed,
        penalty: revealed ? pointsFor(x, a ? Number(a.value) : null, L.scoring) : null,
        weight: x.weight,
        section: x.section,
        range: revealed ? { low: x.low, high: x.high, answer: x.answer } : null,
      };
    });
  const total = Math.round(items.filter((i) => i.revealed && !i.practice).reduce((s, i) => s + (i.penalty ?? 0), 0) * 100) / 100;
  // Ranks only once the guesstimate is over; during the game a player sees just their own points.
  const snap = ranksPublic(L) ? await ensureSnapshot(L) : { key: "", done: false };
  // ranks are public but another request is still computing them: the phone asks again shortly
  const pending = ranksPublic(L) && !snap.done;
  const [r] = snap.done
    ? await q<{ rank: number; eligible_rank: number | null; n: number }>(
        `SELECT r.rank, r.eligible_rank, s.player_count AS n FROM rank_rows r JOIN rank_snapshot s ON s.key = r.key WHERE r.key = $1 AND r.player_id = $2`,
        [snap.key, player.id],
      )
    : [];
  return json(req, {
    ok: true,
    playerId: player.id,
    name: displayName(player),
    disqualified: player.disqualified,
    items,
    total,
    rank: r?.rank ?? null,
    eligibleRank: r?.eligible_rank ?? null,
    players: r?.n ?? null,
    pending,
    qualifyCount: publicQualify(L),
    scoring: L.scoring,
    // The shape of the game for the lobby: one entry per run of questions with the same section.
    plan: L.questions.filter((x) => x.kind === "q" && !x.practice).reduce<{ section: string; count: number; seconds: number; weight: number }[]>((acc, x) => {
      const last = acc[acc.length - 1];
      if (last && last.section === x.section && last.seconds === x.seconds && last.weight === x.weight) last.count++;
      else acc.push({ section: x.section, count: 1, seconds: x.seconds, weight: x.weight });
      return acc;
    }, []),
    serverNow: L.now,
  });
}

export const OPTIONS = preflight;
