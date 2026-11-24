import "server-only";
import { q } from "./db";
import { closeness, compareRows, lowerWins, type Row } from "./scoring";
import type { Loaded } from "./game";
import { revealedThrough, pointsFor } from "./game";
import { displayName } from "./http";

// rangesVersion is bumped whenever ranges, the rubric or a disqualification change, so rankings recompute.
export const snapshotKey = (L: Loaded) => `${revealedThrough(L)}-${L.rangesVersion}`;

/** Scored items whose range is public. */
export const scoredRevealed = (L: Loaded) => {
  const through = revealedThrough(L);
  return L.questions.filter((x) => x.kind === "q" && !x.practice && x.idx <= through);
};

/**
 * Make sure the ranking for the current key exists. Exactly one caller claims
 * and computes it; others return immediately. A claim older than 15 s with no
 * result is treated as abandoned and can be reclaimed.
 */
export async function ensureSnapshot(L: Loaded): Promise<{ key: string; done: boolean }> {
  const key = snapshotKey(L);
  const claimed = await q(
    `INSERT INTO rank_snapshot (key, through_idx) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET started_at = now()
       WHERE rank_snapshot.done = false AND rank_snapshot.started_at < now() - interval '15 seconds'
     RETURNING key`,
    [key, revealedThrough(L)],
  );
  if (!claimed.length) {
    const [r] = await q<{ done: boolean }>(`SELECT done FROM rank_snapshot WHERE key = $1`, [key]);
    return { key, done: !!r?.done };
  }
  await compute(L, key);
  return { key, done: true };
}

async function compute(L: Loaded, key: string) {
  const items = scoredRevealed(L);
  const players = await q<{ id: number; email: string; name: string | null; disqualified: boolean; created_at: string; listed: boolean }>(
    `SELECT p.id, p.email, p.name, p.disqualified, p.created_at,
            (NOT EXISTS (SELECT 1 FROM allowlist) OR EXISTS (SELECT 1 FROM allowlist a WHERE a.email = p.email)) AS listed
       FROM players p`,
  );
  const answers = await q<{ player_id: number; idx: number; value: number; elapsed_ms: number }>(
    `SELECT player_id, idx, value, elapsed_ms FROM answers WHERE idx = ANY($1::int[])`,
    [items.map((x) => x.idx)],
  );
  const byPlayer = new Map<number, Map<number, { value: number; elapsed_ms: number }>>();
  for (const a of answers) {
    if (!byPlayer.has(a.player_id)) byPlayer.set(a.player_id, new Map());
    byPlayer.get(a.player_id)!.set(a.idx, { value: Number(a.value), elapsed_ms: a.elapsed_ms });
  }
  // totals are rounded to 2 decimals so float noise never decides a tie
  const rows: (Row & { name: string; eligible: boolean })[] = players.map((p) => {
    const mine = byPlayer.get(p.id) ?? new Map();
    let total = 0, blanks = 0, cl = 0, el = 0;
    for (const x of items) {
      const a = mine.get(x.idx);
      total += pointsFor(x, a?.value ?? null, L.scoring);
      if (!a) blanks++;
      cl += closeness(a?.value ?? null, x.low!, x.high!);
      el += a?.elapsed_ms ?? (x.seconds * 1000);
    }
    total = Math.round(total * 100) / 100;
    return {
      playerId: p.id, total, blanks, closenessSum: cl, elapsedMs: el,
      createdAt: new Date(p.created_at).getTime(),
      name: displayName(p), eligible: p.listed && !p.disqualified,
    };
  });
  const lower = lowerWins(L.scoring);
  rows.sort((a, b) => compareRows(a, b, lower));
  // rank among everyone; eligible_rank decides qualification
  const cols = 8;
  const values: unknown[] = [];
  let er = 0;
  rows.forEach((r, i) => values.push(key, r.playerId, i + 1, r.name, r.total, r.blanks, r.eligible, r.eligible ? ++er : null));
  await q(`DELETE FROM rank_rows WHERE key = $1`, [key]);
  for (let i = 0; i < rows.length; i += 400) {
    const n = Math.min(400, rows.length - i);
    const ph = Array.from({ length: n }, (_, j) => `(${Array.from({ length: cols }, (_, c) => `$${j * cols + c + 1}`).join(",")})`);
    await q(
      `INSERT INTO rank_rows (key, player_id, rank, name, total, blanks, eligible, eligible_rank) VALUES ${ph.join(",")}`,
      values.slice(i * cols, (i + n) * cols),
    );
  }
  await q(`UPDATE rank_snapshot SET done = true, player_count = $2 WHERE key = $1`, [key, rows.length]);
}
